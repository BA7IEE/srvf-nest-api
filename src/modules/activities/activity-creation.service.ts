import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import appConfig from '../../config/app.config';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ActivityAccessService } from './activity-access.service';
import { ActivityControlPlaneGate } from './activity-control-plane.gate';
import { AppManagedActivitiesService } from './app-managed-activities.service';
import { ActivityFromTemplateService } from './activity-from-template.service';
import { ActivityCreationQuick } from './activity-creation-quick';
import { ActivityCreationProfessional } from './activity-creation-professional';
import { ActivityCreationEmergency } from './activity-creation-emergency';
import { ActivityAuditRecorder } from './activity-audit-recorder';
import {
  creationRequestHash,
  creationTimePolicyPointers,
  isCreationReceiptConflict,
  materializeCreationTimePolicySelection,
  type QuickCreationCommand,
  type ProfessionalCreationCommand,
  type EmergencyCreationCommand,
} from './activity-creation-command';
import { presentActivityCreation } from './activity-creation-presenter';
import { reconcileEmergencyFollowUps } from './activity-emergency-follow-up';
import type { AppActivityCreationResultDto } from './dto/app/app-managed-activity-creation.dto';
import {
  ActivityMetricSelectionAccess,
  lockMetricSelectionReference,
} from './activity-metric-selection-access';
import { ActivityMetricSelectionService } from './activity-metric-selection.service';
import { ActivityTimePolicySelectionAccess } from './activity-time-policy-selection-access';
import { ActivityTimePolicySelectionService } from './activity-time-policy-selection.service';

type ReceiptCommand =
  | { mode: 'professional'; command: ProfessionalCreationCommand }
  | { mode: 'emergency'; command: EmergencyCreationCommand };

/** The sole B6 transaction owner: no nested service transactions and no post-commit "repairs". */
@Injectable()
export class ActivityCreationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ActivityAccessService,
    private readonly managed: AppManagedActivitiesService,
    private readonly templates: ActivityFromTemplateService,
    private readonly quick: ActivityCreationQuick,
    private readonly professional: ActivityCreationProfessional,
    private readonly emergency: ActivityCreationEmergency,
    private readonly audit: ActivityAuditRecorder,
    @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
    private readonly controlPlane: ActivityControlPlaneGate,
    private readonly metricAccess: ActivityMetricSelectionAccess,
    private readonly metricSelection: ActivityMetricSelectionService,
    private readonly timePolicyAccess: ActivityTimePolicySelectionAccess,
    private readonly timePolicySelection: ActivityTimePolicySelectionService,
  ) {}

  async createQuick(
    command: QuickCreationCommand,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppActivityCreationResultDto> {
    await this.assertAccess(user);
    this.controlPlane.assertCreationAvailable();
    const requestHash = creationRequestHash('quick', user.id, command);
    const replay = async (tx: Prisma.TransactionClient) => {
      const activity = await this.templates.findCreationReplayWithinTransaction(
        tx,
        command.template,
        user.id,
        requestHash,
        user,
      );
      return activity ? presentActivityCreation({ activity, mode: 'quick', replayed: true }) : null;
    };
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await replay(tx);
        if (existing) return existing;
        const result = await this.quick.create(tx, command, user, requestHash);
        let actor = result.actor ?? user; // V3 revalidated identity; V1/V2 preserve their old path.
        if (result.timePolicySelectionInitialization) {
          await this.timePolicySelection.initializeWithinTransaction({
            tx,
            activityId: result.activity.id,
            selection: result.timePolicySelectionInitialization.selection,
            actor,
            meta: auditMeta,
            source: {
              originCode: 'template_creation',
              templateId: result.timePolicySelectionInitialization.templateId,
              templateDefinitionHash:
                result.timePolicySelectionInitialization.templateDefinitionHash,
            },
            revalidate: async () => {
              actor = await result.timePolicySelectionInitialization!.revalidate();
              return actor;
            },
          });
        }
        await this.audit.logCreationCommand({
          tx,
          activityId: result.activity.id,
          organizationId: command.template.organizationId,
          actorUserId: actor.id,
          actorRoleSnap: actor.role,
          auditMeta,
          operation: 'create_quick',
          requestHash,
          placeCount: result.placeCount,
        });
        return presentActivityCreation({
          activity: result.activity,
          mode: 'quick',
          replayed: false,
        });
      });
    } catch (error) {
      if (!this.templates.isCreationOperationKeyConflict(error)) throw error;
      const result = await this.prisma.$transaction(replay);
      if (!result)
        throw new BizException(BizCode.ACTIVITY_CREATE_FROM_TEMPLATE_OPERATION_KEY_CONFLICT);
      return result;
    }
  }

  async createProfessional(
    command: ProfessionalCreationCommand,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    await this.assertAccess(user);
    this.controlPlane.assertCreationAvailable();
    return this.runReceiptCommand({ mode: 'professional', command }, user, auditMeta);
  }

  async createEmergency(
    command: EmergencyCreationCommand,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    await this.assertAccess(user);
    await this.access.assertCanOrThrow(user, 'activity.create.emergency.record');
    this.controlPlane.assertCreationAvailable();
    const { organizationIds, memberIds } = command;
    if (
      (organizationIds === undefined) === (memberIds === undefined) ||
      organizationIds?.length === 0 ||
      memberIds?.length === 0
    )
      throw new BizException(BizCode.BAD_REQUEST);
    return this.runReceiptCommand({ mode: 'emergency', command }, user, auditMeta);
  }

  private async assertAccess(user: CurrentUserPayload): Promise<void> {
    if (!user.memberId) throw new BizException(BizCode.FORBIDDEN);
    if (!this.config.activityResponsibilityWorkflow.enabled)
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    await this.access.assertCanOrThrow(user, 'activity.create.record');
  }

  private async runReceiptCommand(
    input: ReceiptCommand,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppActivityCreationResultDto> {
    const requestHash = creationRequestHash(input.mode, user.id, input.command);
    const identity = {
      actorUserId: user.id,
      commandCode: input.mode === 'professional' ? 'create_professional' : 'create_emergency',
      operationKey: input.command.operationKey,
    };
    const replay = async (tx: Prisma.TransactionClient) => {
      const receipt = await tx.activityCreationCommandReceipt.findUnique({
        where: { actorUserId_commandCode_operationKey: identity },
      });
      if (!receipt) return null;
      if (receipt.requestHash !== requestHash) throw new BizException(BizCode.BAD_REQUEST);
      // Receipt is the authority even after subsequent activity edits or soft deletion.
      await tx.$queryRaw`SELECT "id" FROM "Activity" WHERE "id" = ${receipt.activityId} FOR UPDATE`;
      if (input.command.metricSelection !== undefined)
        await this.revalidateMetricCreation(tx, input, user);
      if (input.command.timePolicySelection !== undefined)
        await this.revalidateTimePolicyCreation(tx, input, user);
      if (input.mode === 'emergency')
        await reconcileEmergencyFollowUps(tx, receipt.activityId, user.id);
      return this.result(tx, receipt.activityId, input.mode, true);
    };
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const existing = await replay(tx);
          if (existing) return existing;
          let actor = user;
          if (input.command.metricSelection !== undefined) {
            actor = await this.revalidateMetricCreation(tx, input, user);
          }
          if (input.command.timePolicySelection !== undefined) {
            actor = await this.revalidateTimePolicyCreation(tx, input, user);
          }
          const revalidateCreation = async () => {
            if (input.command.metricSelection !== undefined) {
              actor = await this.revalidateMetricCreation(tx, input, user);
            }
            if (input.command.timePolicySelection !== undefined) {
              actor = await this.revalidateTimePolicyCreation(tx, input, user);
            }
            return actor;
          };
          if (input.command.metricSelection !== undefined) {
            await lockMetricSelectionReference(tx, input.command.metricSelection, async () => {
              await revalidateCreation();
            });
          }
          if (input.command.timePolicySelection !== undefined) {
            await this.timePolicySelection.assertPointersAvailableWithinTransaction(
              tx,
              creationTimePolicyPointers(input.command.timePolicySelection),
              async () => {
                await revalidateCreation();
              },
            );
          }
          let result: {
            activity: Awaited<ReturnType<ActivityCreationEmergency['createDraft']>>;
            placeCount: number;
          };
          let timePolicySelection;
          if (input.mode === 'professional') {
            const professional = await this.professional.create(tx, input.command, actor);
            result = professional;
            timePolicySelection = professional.timePolicySelection;
          } else {
            result = {
              activity: await this.emergency.createDraft(tx, input.command, actor),
              placeCount: 0,
            };
            timePolicySelection =
              input.command.timePolicySelection === undefined
                ? undefined
                : materializeCreationTimePolicySelection(input.command.timePolicySelection, []);
          }
          if (input.command.metricSelection !== undefined) {
            await this.metricSelection.initializeWithinTransaction({
              tx,
              activityId: result.activity.id,
              selection: input.command.metricSelection,
              actor,
              meta: auditMeta,
              source: input.mode,
              revalidate: async () => {
                return revalidateCreation();
              },
            });
          }
          const receipt = await tx.activityCreationCommandReceipt.create({
            data: { ...identity, requestHash, activityId: result.activity.id },
          });
          if (timePolicySelection !== undefined) {
            await this.timePolicySelection.initializeWithinTransaction({
              tx,
              activityId: result.activity.id,
              selection: timePolicySelection,
              actor,
              meta: auditMeta,
              source: { originCode: 'creation_receipt', creationReceiptId: receipt.id },
              revalidate: revalidateCreation,
            });
          }
          const auditBase = {
            tx,
            activityId: result.activity.id,
            organizationId: input.command.activity.organizationId,
            actorUserId: actor.id,
            actorRoleSnap: actor.role,
            auditMeta,
            requestHash,
            commandId: receipt.id,
          };
          if (input.mode === 'emergency') {
            // Existing options implement membership + scoped cross-org authorization; never derive scope from Role.
            const options = await this.managed.organizationOptions(actor, actor.memberId!, tx);
            const recipientCount = await this.emergency.queueCall(tx, {
              command: input.command,
              activityId: result.activity.id,
              receiptId: receipt.id,
              requestHash,
              user: actor,
              authorizedOrganizationIds: options.map((option) => option.organizationId),
            });
            await this.audit.logCreationCommand({
              ...auditBase,
              operation: 'emergency_call',
              recipientCount,
            });
          }
          await this.audit.logCreationCommand({
            ...auditBase,
            operation: input.mode === 'professional' ? 'create_professional' : 'create_emergency',
            placeCount: result.placeCount,
          });
          return this.result(tx, result.activity.id, input.mode, false);
        },
        { timeout: 30_000 },
      );
    } catch (error) {
      if (!isCreationReceiptConflict(error)) throw error;
      const result = await this.prisma.$transaction(replay);
      if (!result) throw new BizException(BizCode.BAD_REQUEST);
      return result;
    }
  }

  private async result(
    tx: Prisma.TransactionClient,
    activityId: string,
    mode: 'professional' | 'emergency',
    replayed: boolean,
  ) {
    const activity = await tx.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: { id: true, createdAt: true },
    });
    const followUpItems =
      mode === 'emergency'
        ? await tx.activityEmergencyFollowUpItem.findMany({
            where: { emergencyInitiation: { activityId } },
            select: { itemCode: true, statusCode: true },
            orderBy: { itemCode: 'asc' },
          })
        : [];
    return presentActivityCreation({ activity, mode, replayed, followUpItems });
  }

  private async revalidateMetricCreation(
    tx: Prisma.TransactionClient,
    input: ReceiptCommand,
    user: CurrentUserPayload,
  ) {
    const { actor } = await this.metricAccess.authorizeCreation(
      tx,
      user,
      'app',
      input.command.activity.organizationId,
      input.command.activity.initiatorMemberId,
    );
    if (input.mode === 'emergency')
      await this.access.assertCanOrThrow(actor, 'activity.create.emergency.record', undefined, tx);
    return actor;
  }

  private async revalidateTimePolicyCreation(
    tx: Prisma.TransactionClient,
    input: ReceiptCommand,
    user: CurrentUserPayload,
  ) {
    const actor = await this.timePolicyAccess.authorizeCreation(
      tx,
      user,
      'app',
      input.command.activity.organizationId,
      input.command.activity.initiatorMemberId,
    );
    if (input.mode === 'emergency')
      await this.access.assertCanOrThrow(actor, 'activity.create.emergency.record', undefined, tx);
    return actor;
  }
}
