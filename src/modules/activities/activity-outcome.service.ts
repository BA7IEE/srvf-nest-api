import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { instanceToPlain } from 'class-transformer';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AttachmentsService } from '../attachments/attachments.service';
import { ActivityOutcomeAccessService } from './activity-outcome-access.service';
import { ActivityOutcomeAuditRecorder } from './activity-outcome-audit-recorder';
import {
  activityOutcomeRequestHash,
  parseActivityOutcomeCommand,
  parseActivityOutcomeReceipt,
  type ActivityOutcomeCommandResult,
} from './activity-outcome-command';
import { nextActivityOutcomeRevision } from './activity-outcome-policy';
import { lockMetricSelectionReference } from './activity-metric-selection-access';
import { metricDefinitionDocument } from './activity-metric-presenter';
import { fingerprintActivityOutcomeValue } from './activity-outcome-value';

@Injectable()
export class ActivityOutcomeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ActivityOutcomeAccessService,
    private readonly attachments: AttachmentsService,
    private readonly audit: ActivityOutcomeAuditRecorder,
  ) {}

  async record(
    activityId: string,
    input: object,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<ActivityOutcomeCommandResult> {
    try {
      const command = parseActivityOutcomeCommand(instanceToPlain(input));
      const requestHash = activityOutcomeRequestHash(activityId, command);
      return await this.prisma.$transaction(async (tx) => {
        let context = await this.access.authorize(tx, user, activityId, 'activity.outcome.record');
        const revalidate = async () => {
          context = await this.access.authorize(tx, user, activityId, 'activity.outcome.record');
        };
        const lockKey = JSON.stringify([
          'activity-outcome',
          user.id,
          'record_manual_outcome',
          command.operationKey,
        ]);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`;
        await revalidate();
        await tx.$queryRaw`SELECT "id" FROM "Activity" WHERE "id" = ${activityId} AND "deletedAt" IS NULL FOR UPDATE`;
        await revalidate();
        const identity = {
          actorUserId: context.actor.id,
          operationCode: 'record_manual_outcome',
          operationKey: command.operationKey,
        };
        const receipt = await tx.activityOutcomeCommandReceipt.findUnique({
          where: { actorUserId_operationCode_operationKey: identity },
        });
        if (receipt) {
          if (receipt.requestHash !== requestHash)
            throw new BizException(BizCode.ACTIVITY_OUTCOME_COMMAND_CONFLICT);
          try {
            if (receipt.activityId !== activityId) throw new TypeError('wrong receipt activity');
            return parseActivityOutcomeReceipt(
              receipt.resultJson,
              activityId,
              receipt.outcomeRevisionId,
            );
          } catch (error) {
            if (error instanceof TypeError)
              throw new BizException(BizCode.ACTIVITY_OUTCOME_RECEIPT_INVALID);
            throw error;
          }
        }
        const latest = await tx.activityOutcomeRevision.findFirst({
          where: { activityId },
          orderBy: { revision: 'desc' },
        });
        const transition = nextActivityOutcomeRevision(
          context.activity.statusCode,
          command.expectedRevision,
          latest,
        );
        if (
          context.activity.metricRequirementCode !== 'required' ||
          context.activity.selectedMetricSetVersionId !== command.metricSetVersionId ||
          context.activity.selectedMetricSetDefinitionHash !== command.metricSetDefinitionHash
        )
          throw new BizException(BizCode.ACTIVITY_OUTCOME_STALE);
        const set = await tx.activityMetricSetVersion.findFirst({
          where: { id: command.metricSetVersionId },
        });
        if (!set || set.definitionHash !== command.metricSetDefinitionHash)
          throw new BizException(BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
        await lockMetricSelectionReference(
          tx,
          {
            metricRequirementCode: 'required',
            metricSetPointer: {
              id: set.id,
              code: set.code,
              version: set.version,
              schemaVersion: 1,
              definitionHash: set.definitionHash,
            },
          },
          revalidate,
        );
        const items = await tx.activityMetricSetItem.findMany({
          where: { setVersionId: set.id },
          include: { metricDefinition: true },
          take: 101,
        });
        const byId = new Map(items.map((item) => [item.metricDefinitionId, item.metricDefinition]));
        const values = command.values.map((value) => {
          const definition = byId.get(value.metricDefinitionId);
          if (!definition || definition.kindCode === 'short_text')
            throw new BizException(BizCode.ACTIVITY_OUTCOME_INVALID);
          return {
            ...value,
            ...fingerprintActivityOutcomeValue(
              metricDefinitionDocument(definition),
              definition.definitionHash,
              value.value,
            ),
          };
        });
        const attachmentIds = [
          ...new Set(values.flatMap((value) => value.evidenceAttachmentIds)),
        ].sort();
        await this.attachments.lockOwnerReferenceStorageBoundaryTrusted(tx, {
          ownerId: activityId,
          ownerTypes: ['activity'],
          referencedAttachmentIds: attachmentIds,
        });
        await revalidate();
        if (
          !(await this.attachments.findOwnedAttachmentsTrusted(tx, {
            ownerId: activityId,
            ownerTypes: ['activity'],
            attachmentIds,
          }))
        )
          throw new BizException(BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
        const outcome = await tx.activityOutcomeRevision.create({
          data: {
            activityId,
            revision: transition.revision,
            priorRevisionId: transition.priorRevisionId,
            metricSetVersionId: set.id,
            metricSetDefinitionHash: set.definitionHash,
            statusCode: 'draft',
            createdByUserId: context.actor.id,
          },
        });
        for (const value of values) {
          const row = await tx.activityMetricValueRevision.create({
            data: {
              outcomeRevisionId: outcome.id,
              activityId,
              setVersionId: set.id,
              metricDefinitionId: value.metricDefinitionId,
              valueJson: value.valueJson,
              valueHash: value.valueHash,
              sourceCode: 'manual',
              sourceReference: 'human_manual',
              calculatedByRuleVersion: 'manual-outcome-v1',
            },
          });
          if (value.evidenceAttachmentIds.length)
            await tx.activityMetricValueEvidence.createMany({
              data: value.evidenceAttachmentIds.map((attachmentId, sortOrder) => ({
                valueRevisionId: row.id,
                outcomeRevisionId: outcome.id,
                activityId,
                setVersionId: set.id,
                attachmentId,
                sortOrder,
              })),
            });
        }
        if (transition.supersedeId) {
          const updated = await tx.activityOutcomeRevision.updateMany({
            where: { id: transition.supersedeId, activityId, statusCode: 'draft' },
            data: { statusCode: 'superseded' },
          });
          if (updated.count !== 1) throw new BizException(BizCode.ACTIVITY_OUTCOME_STALE);
        }
        const result: ActivityOutcomeCommandResult = {
          schemaVersion: 1,
          activityId,
          outcomeRevisionId: outcome.id,
          revision: outcome.revision,
          metricSetVersionId: set.id,
          metricSetDefinitionHash: set.definitionHash,
          createdStatusCode: 'draft',
          sourceCode: 'manual',
          valueCount: values.length,
          evidenceCount: values.reduce(
            (count, value) => count + value.evidenceAttachmentIds.length,
            0,
          ),
          createdAt: outcome.createdAt.toISOString(),
        };
        await tx.activityOutcomeCommandReceipt.create({
          data: {
            ...identity,
            requestHash,
            activityId,
            outcomeRevisionId: outcome.id,
            resultJson: result as unknown as Prisma.InputJsonValue,
          },
        });
        await this.audit.log(tx, context.actor, meta, result, transition.priorRevisionId);
        return result;
      });
    } catch (error) {
      if (error instanceof TypeError) throw new BizException(BizCode.ACTIVITY_OUTCOME_INVALID);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new BizException(BizCode.ACTIVITY_OUTCOME_COMMAND_CONFLICT);
      throw error;
    }
  }
}
