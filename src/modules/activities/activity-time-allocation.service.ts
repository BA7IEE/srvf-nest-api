import { Injectable } from '@nestjs/common';
import { instanceToPlain } from 'class-transformer';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AttachmentsService } from '../attachments/attachments.service';
import { ParticipationSegmentFacade } from '../attendances/participation-segment.facade';
import {
  activityTimePolicySelectionHash,
  parseActivityTimePolicySelectionDocument,
  resolveActivityTimePolicySelection,
} from './activity-time-policy-selection';
import { timePolicyVersionDocument } from './activity-time-policy-presenter';
import { ActivityTimeAllocationAccessService } from './activity-time-allocation-access.service';
import { ActivityTimeAllocationAuditRecorder } from './activity-time-allocation-audit-recorder';
import {
  ACTIVITY_TIME_ALLOCATION_OPERATION,
  ACTIVITY_TIME_ALLOCATION_SCHEMA_VERSION,
  activityTimeAllocationRequestHash,
  buildActivityTimeAllocationManifest,
  parseActivityTimeAllocationCommand,
  parseActivityTimeAllocationReceipt,
  type ActivityTimeAllocationReceiptResult,
} from './activity-time-allocation-command';
import {
  assertAllocationSlicesWithinSource,
  assertManualTimeAllocationAllowed,
  assertTimeAllocationEvidence,
  automaticTimeAllocationSlices,
  historicalAttendanceRoleFromRuleSnapshot,
  historicalTimePolicySelectionTargetsFromRuleSnapshot,
} from './activity-time-allocation-policy';

const PERMISSION = 'activity.time-allocation.recognize' as const;

function policyUnavailable(): never {
  throw new BizException(BizCode.ACTIVITY_TIME_ALLOCATION_POLICY_UNAVAILABLE);
}

function sourceUnavailable(): never {
  throw new BizException(BizCode.ACTIVITY_TIME_ALLOCATION_REFERENCE_UNAVAILABLE);
}

@Injectable()
export class ActivityTimeAllocationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ActivityTimeAllocationAccessService,
    private readonly segments: ParticipationSegmentFacade,
    private readonly attachments: AttachmentsService,
    private readonly audit: ActivityTimeAllocationAuditRecorder,
  ) {}

  /**
   * Internal application command only. No controller wires this method in D3; future surfaces
   * need their own review instead of turning this trusted command into an accidental endpoint.
   */
  async recognize(
    activityId: string,
    input: unknown,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<ActivityTimeAllocationReceiptResult> {
    try {
      const command = parseActivityTimeAllocationCommand(
        instanceToPlain(input, { exposeUnsetFields: false }),
      );
      const requestHash = activityTimeAllocationRequestHash(activityId, user.id, command);
      return await this.prisma.$transaction(
        async (tx) => {
          let context = await this.access.authorize(tx, user, activityId, PERMISSION);
          const reauthorize = async () => {
            context = await this.access.authorize(tx, user, activityId, PERMISSION);
          };

          const lockKey = JSON.stringify([
            'activity-time-allocation',
            context.actor.id,
            ACTIVITY_TIME_ALLOCATION_OPERATION,
            command.operationKey,
          ]);
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`;
          await reauthorize();

          await this.segments.lockActivityForTimeAllocationWrite(tx, activityId);
          await reauthorize();

          const receiptIdentity = {
            actorUserId: context.actor.id,
            operationCode: ACTIVITY_TIME_ALLOCATION_OPERATION,
            operationKey: command.operationKey,
          };
          const receipt = await tx.participantTimeAllocationCommandReceipt.findUnique({
            where: { actorUserId_operationCode_operationKey: receiptIdentity },
            include: {
              allocationRevision: {
                select: {
                  id: true,
                  activityId: true,
                  createdByUserId: true,
                },
              },
            },
          });
          if (receipt) {
            if (receipt.requestHash !== requestHash)
              throw new BizException(BizCode.ACTIVITY_TIME_ALLOCATION_COMMAND_CONFLICT);
            try {
              if (
                receipt.activityId !== activityId ||
                receipt.allocationRevisionId !== receipt.allocationRevision.id ||
                receipt.allocationRevision.activityId !== activityId ||
                receipt.allocationRevision.createdByUserId !== context.actor.id
              ) {
                throw new TypeError('time allocation receipt anchor mismatch');
              }
              return parseActivityTimeAllocationReceipt(
                receipt.resultJson,
                activityId,
                receipt.allocationRevisionId,
              );
            } catch (error) {
              if (error instanceof TypeError)
                throw new BizException(BizCode.ACTIVITY_TIME_ALLOCATION_INVALID);
              throw error;
            }
          }

          const currentSegments = await this.segments.readActivityCurrentSegmentsTrusted(
            tx,
            activityId,
          );
          const source = currentSegments.find((segment) => segment.id === command.sourceSegmentId);
          if (
            !source ||
            source.statusCode !== 'committed' ||
            source.resultCode !== 'valid' ||
            source.checkOutAt === null ||
            source.checkOutAt <= source.checkInAt
          ) {
            return sourceUnavailable();
          }

          const snapshotCandidate = await tx.activityRuleSnapshot.findFirst({
            where: {
              activityId,
              timePolicySelectionRevisionId: { not: null },
              createdAt: { lte: source.checkInAt },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: {
              id: true,
              createdAt: true,
              timePolicySelectionRevisionId: true,
              snapshotHash: true,
              resolvedConfig: true,
            },
          });
          if (!snapshotCandidate || !snapshotCandidate.timePolicySelectionRevisionId)
            return policyUnavailable();
          const selectionRevisionId = snapshotCandidate.timePolicySelectionRevisionId;
          await tx.$queryRaw(Prisma.sql`
            SELECT "id" FROM "ActivityRuleSnapshot"
            WHERE "id" = ${snapshotCandidate.id}
              AND "activityId" = ${activityId}
              AND "timePolicySelectionRevisionId" = ${selectionRevisionId}
            FOR SHARE
          `);
          await reauthorize();
          const snapshot = await tx.activityRuleSnapshot.findFirst({
            where: { id: snapshotCandidate.id, activityId },
            select: {
              id: true,
              createdAt: true,
              timePolicySelectionRevisionId: true,
              snapshotHash: true,
              resolvedConfig: true,
            },
          });
          if (
            !snapshot ||
            snapshot.createdAt > source.checkInAt ||
            snapshot.timePolicySelectionRevisionId !== selectionRevisionId
          ) {
            return policyUnavailable();
          }

          await tx.$queryRaw(Prisma.sql`
            SELECT "id" FROM "ActivityTimePolicySelectionRevision"
            WHERE "id" = ${selectionRevisionId} AND "activityId" = ${activityId}
            FOR SHARE
          `);
          await tx.$queryRaw(Prisma.sql`
            SELECT "id" FROM "ActivityTimePolicySelectionItem"
            WHERE "selectionRevisionId" = ${selectionRevisionId} AND "activityId" = ${activityId}
            ORDER BY "id"
            FOR SHARE
          `);
          await reauthorize();
          const selection = await tx.activityTimePolicySelectionRevision.findFirst({
            where: { id: selectionRevisionId, activityId },
            select: { id: true, activityId: true, selectionHash: true, selectionJson: true },
          });
          if (!selection) return policyUnavailable();
          let pointer: { policyId: string; versionId: string; definitionHash: string } | null =
            null;
          try {
            const document = parseActivityTimePolicySelectionDocument(selection.selectionJson);
            if (activityTimePolicySelectionHash(document) !== selection.selectionHash)
              return policyUnavailable();
            const targets = historicalTimePolicySelectionTargetsFromRuleSnapshot(
              snapshot.resolvedConfig,
            );
            const resolved = resolveActivityTimePolicySelection(document, targets);
            const target = resolved.find(
              (candidate) =>
                candidate.scope.layerCode ===
                  (source.sourcePositionId === null ? 'session' : 'position') &&
                candidate.scope.sessionId === source.sessionId &&
                candidate.scope.positionId === source.sourcePositionId,
            );
            pointer = target?.pointer ?? null;
          } catch (error) {
            if (error instanceof TypeError || error instanceof BizException)
              return policyUnavailable();
            throw error;
          }
          if (!pointer) return policyUnavailable();

          await tx.$queryRaw(Prisma.sql`
            SELECT "id" FROM "TimePolicy" WHERE "id" = ${pointer.policyId} FOR SHARE
          `);
          await tx.$queryRaw(Prisma.sql`
            SELECT "id" FROM "TimePolicyVersion"
            WHERE "id" = ${pointer.versionId}
              AND "policyId" = ${pointer.policyId}
              AND "definitionHash" = ${pointer.definitionHash}
            FOR SHARE
          `);
          await reauthorize();
          const version = await tx.timePolicyVersion.findFirst({
            where: {
              id: pointer.versionId,
              policyId: pointer.policyId,
              definitionHash: pointer.definitionHash,
            },
          });
          if (
            !version ||
            (version.statusCode !== 'active' && version.statusCode !== 'retired') ||
            version.effectiveFrom > source.checkInAt ||
            (version.effectiveUntil !== null && version.effectiveUntil < source.checkOutAt)
          ) {
            return policyUnavailable();
          }
          let policy;
          try {
            policy = timePolicyVersionDocument(version);
          } catch {
            return policyUnavailable();
          }
          if (
            policy.definitionHash !== pointer.definitionHash ||
            policy.evaluatorVersion !== version.evaluatorVersion
          ) {
            return policyUnavailable();
          }

          const slices =
            command.recognitionModeCode === 'automatic'
              ? automaticTimeAllocationSlices(
                  policy.definition,
                  historicalAttendanceRoleFromRuleSnapshot(
                    snapshot.resolvedConfig,
                    source.sessionId,
                    source.sourcePositionId,
                  ),
                  source.checkInAt,
                  source.checkOutAt,
                )
              : (() => {
                  assertManualTimeAllocationAllowed(policy.definition);
                  return command.slices;
                })();
          assertAllocationSlicesWithinSource(
            slices,
            source.checkInAt,
            source.checkOutAt,
            policy.definition.allowSplit,
          );
          assertTimeAllocationEvidence(
            policy.definition,
            command.recognitionModeCode,
            command.evidenceAttachmentIds.length,
          );

          const attachmentIds = command.evidenceAttachmentIds;
          if (attachmentIds.length > 0) {
            await this.attachments.lockOwnerReferenceStorageBoundaryTrusted(tx, {
              ownerId: activityId,
              ownerTypes: ['activity'] as const,
              referencedAttachmentIds: attachmentIds,
            });
            await reauthorize();
            if (
              !(await this.attachments.findOwnedAttachmentsTrusted(tx, {
                ownerId: activityId,
                ownerTypes: ['activity'] as const,
                attachmentIds,
              }))
            ) {
              return sourceUnavailable();
            }
          }

          const latest = await tx.participantTimeAllocationRevision.findFirst({
            where: {
              participationIdentityId: source.participationIdentityId,
              segmentKey: source.segmentKey,
            },
            orderBy: { revision: 'desc' },
            select: { id: true, revision: true },
          });
          if ((latest?.revision ?? 0) !== command.expectedRevision) {
            throw new BizException(BizCode.ACTIVITY_TIME_ALLOCATION_STALE);
          }

          const { manifest, allocationHash } = buildActivityTimeAllocationManifest(slices);
          const createdAt = new Date();
          const allocation = await tx.participantTimeAllocationRevision.create({
            data: {
              activityId,
              sessionId: source.sessionId,
              memberId: source.memberId,
              participationIdentityId: source.participationIdentityId,
              segmentKey: source.segmentKey,
              revision: command.expectedRevision + 1,
              previousAllocationRevisionId: latest?.id ?? null,
              sourceSegmentId: source.id,
              sourceSegmentRevision: source.revision,
              sourcePositionId: source.sourcePositionId,
              ruleSnapshotId: snapshot.id,
              ruleSnapshotHash: snapshot.snapshotHash,
              timePolicySelectionRevisionId: selection.id,
              selectionHash: selection.selectionHash,
              policyId: pointer.policyId,
              policyVersionId: pointer.versionId,
              definitionHash: pointer.definitionHash,
              evaluatorVersion: policy.evaluatorVersion,
              recognitionModeCode: command.recognitionModeCode,
              manualReason: command.manualReason,
              allocationJson: manifest as unknown as Prisma.InputJsonValue,
              allocationHash,
              sliceCount: slices.length,
              createdAt,
              createdByUserId: context.actor.id,
            },
          });
          await tx.participantTimeAllocationSlice.createMany({
            data: slices.map((slice, ordinal) => ({
              allocationRevisionId: allocation.id,
              activityId,
              ordinal,
              categoryCode: slice.categoryCode,
              intervalKindCode: slice.intervalKindCode,
              startAt: new Date(slice.startAt),
              endAt: new Date(slice.endAt),
            })),
          });
          if (attachmentIds.length > 0) {
            await tx.participantTimeAllocationEvidence.createMany({
              data: attachmentIds.map((attachmentId, ordinal) => ({
                allocationRevisionId: allocation.id,
                activityId,
                attachmentId,
                ordinal,
              })),
            });
          }
          const result: ActivityTimeAllocationReceiptResult = {
            schemaVersion: ACTIVITY_TIME_ALLOCATION_SCHEMA_VERSION,
            activityId,
            allocationRevisionId: allocation.id,
            revision: allocation.revision,
            sourceSegmentId: source.id,
            sourceSegmentRevision: source.revision,
            recognitionModeCode: command.recognitionModeCode,
            allocationHash,
            sliceCount: slices.length,
            evidenceCount: attachmentIds.length,
            createdAt: createdAt.toISOString(),
          };
          await tx.participantTimeAllocationCommandReceipt.create({
            data: {
              ...receiptIdentity,
              requestHash,
              activityId,
              allocationRevisionId: allocation.id,
              resultJson: result as unknown as Prisma.InputJsonValue,
              createdAt,
            },
          });
          await this.audit.log(tx, context.actor, meta, result);
          return result;
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: 2000,
          timeout: 10000,
        },
      );
    } catch (error) {
      if (error instanceof TypeError)
        throw new BizException(BizCode.ACTIVITY_TIME_ALLOCATION_INVALID);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new BizException(BizCode.ACTIVITY_TIME_ALLOCATION_COMMAND_CONFLICT);
      throw error;
    }
  }
}
