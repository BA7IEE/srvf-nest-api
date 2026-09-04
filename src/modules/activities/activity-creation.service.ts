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
import { AppManagedActivitiesService } from './app-managed-activities.service';
import { ActivityFromTemplateService } from './activity-from-template.service';
import { ActivityCreationQuick } from './activity-creation-quick';
import { ActivityCreationProfessional } from './activity-creation-professional';
import { ActivityCreationEmergency } from './activity-creation-emergency';
import { ActivityAuditRecorder } from './activity-audit-recorder';
import {
  creationRequestHash,
  isCreationReceiptConflict,
  type QuickCreationCommand,
  type ProfessionalCreationCommand,
  type EmergencyCreationCommand,
} from './activity-creation-command';
import { presentActivityCreation } from './activity-creation-presenter';
import { reconcileEmergencyFollowUps } from './activity-emergency-follow-up';
import type { AppActivityCreationResultDto } from './dto/app/app-managed-activity-creation.dto';

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
  ) {}

  async createQuick(
    command: QuickCreationCommand,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppActivityCreationResultDto> {
    await this.assertAccess(user);
    const requestHash = creationRequestHash('quick', user.id, command);
    const replay = async (tx: Prisma.TransactionClient) => {
      const activity = await this.templates.findCreationReplayWithinTransaction(
        tx,
        command.template,
        user.id,
        requestHash,
      );
      return activity ? presentActivityCreation({ activity, mode: 'quick', replayed: true }) : null;
    };
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await replay(tx);
        if (existing) return existing;
        const result = await this.quick.create(tx, command, user, requestHash);
        await this.audit.logCreationCommand({
          tx,
          activityId: result.activity.id,
          organizationId: command.template.organizationId,
          actorUserId: user.id,
          actorRoleSnap: user.role,
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
    return this.runReceiptCommand({ mode: 'professional', command }, user, auditMeta);
  }

  async createEmergency(
    command: EmergencyCreationCommand,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    await this.assertAccess(user);
    await this.access.assertCanOrThrow(user, 'activity.create.emergency.record');
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
      if (input.mode === 'emergency')
        await reconcileEmergencyFollowUps(tx, receipt.activityId, user.id);
      return this.result(tx, receipt.activityId, input.mode, true);
    };
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const existing = await replay(tx);
          if (existing) return existing;
          const result =
            input.mode === 'professional'
              ? await this.professional.create(tx, input.command, user)
              : {
                  activity: await this.emergency.createDraft(tx, input.command, user),
                  placeCount: 0,
                };
          const receipt = await tx.activityCreationCommandReceipt.create({
            data: { ...identity, requestHash, activityId: result.activity.id },
          });
          const auditBase = {
            tx,
            activityId: result.activity.id,
            organizationId: input.command.activity.organizationId,
            actorUserId: user.id,
            actorRoleSnap: user.role,
            auditMeta,
            requestHash,
            commandId: receipt.id,
          };
          if (input.mode === 'emergency') {
            // Existing options implement membership + scoped cross-org authorization; never derive scope from Role.
            const options = await this.managed.organizationOptions(user, user.memberId!);
            const recipientCount = await this.emergency.queueCall(tx, {
              command: input.command,
              activityId: result.activity.id,
              receiptId: receipt.id,
              requestHash,
              user,
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
}
