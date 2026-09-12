import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { instanceToPlain } from 'class-transformer';
import { Prisma, type ActivitySettlementTimeRevision } from '@prisma/client';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ParticipationSegmentFacade } from '../attendances/participation-segment.facade';
import { fingerprintMetricEnvelope } from './activity-metric-definition';
import { ActivityTimeAllocationService } from './activity-time-allocation.service';
import {
  ActivityTimeSettlementAccessService,
  type TimeSettlementAccess,
} from './activity-time-settlement-access.service';
import { ActivityTimeSettlementAuditRecorder } from './activity-time-settlement-audit-recorder';
import {
  parseTimeSettlementAllocationCommand,
  parseTimeSettlementPrepareCommand,
  parseTimeSettlementSubmitCommand,
  parseTimeSettlementReceipt,
  timeSettlementAllocationRequestHash,
  timeSettlementPrepareRequestHash,
  timeSettlementSubmitRequestHash,
  TIME_SETTLEMENT_ALLOCATION_OPERATION,
  TIME_SETTLEMENT_PREPARE_OPERATION,
  TIME_SETTLEMENT_SUBMIT_OPERATION,
  type TimeSettlementDraftExpectation,
  type TimeSettlementReceiptResult,
} from './activity-time-settlement-command';
import type {
  TimeSettlementBucket,
  TimeSettlementDraftProof,
} from './activity-time-settlement-policy';
import {
  ActivityTimeSettlementQueryService,
  requireTimeSettlementDraft,
  timeSettlementError,
  type TimeSettlementSourceSet,
} from './activity-time-settlement-query.service';
import {
  SettlementSubmitService,
  SETTLEMENT_SUBMIT_TX_TIMEOUT_MS,
} from './settlement-submit.service';

type Tx = Prisma.TransactionClient;
type Reauthorize = () => Promise<CurrentUserPayload>;
type Operation = typeof TIME_SETTLEMENT_PREPARE_OPERATION | typeof TIME_SETTLEMENT_SUBMIT_OPERATION;

@Injectable()
export class ActivityTimeSettlementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ActivityTimeSettlementAccessService,
    private readonly queries: ActivityTimeSettlementQueryService,
    private readonly segments: ParticipationSegmentFacade,
    private readonly allocations: ActivityTimeAllocationService,
    private readonly settlements: SettlementSubmitService,
    private readonly audit: ActivityTimeSettlementAuditRecorder,
    private readonly gate: ActivityWorkflowGate,
  ) {}

  private async write<T>(
    activityId: string,
    user: CurrentUserPayload,
    access: TimeSettlementAccess,
    operationCode: string,
    operationKey: string,
    timeout: number,
    execute: (tx: Tx, reauthorize: Reauthorize) => Promise<T>,
  ): Promise<T> {
    this.gate.assertV11WriteAllowed();
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const reauthorize = async () =>
            (await this.access.authorize(tx, user, activityId, access)).actor;
          const actor = await reauthorize();
          const lockKey = JSON.stringify([
            'activity-time-settlement',
            actor.id,
            operationCode,
            operationKey,
          ]);
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`;
          await reauthorize();
          await this.segments.lockActivityForTimeAllocationWrite(tx, activityId);
          await reauthorize();
          const runs = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "AttendanceSettlementRun" WHERE "activityId" = ${activityId} FOR UPDATE
        `;
          await reauthorize();
          if (runs.length !== 1)
            throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY);
          const result = await execute(tx, reauthorize);
          await reauthorize();
          return result;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 2000, timeout },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_COMMAND_CONFLICT);
      return timeSettlementError(error);
    }
  }

  private async lockedProof(
    tx: Tx,
    activityId: string,
    expected: TimeSettlementDraftExpectation,
    reauthorize: Reauthorize,
  ): Promise<TimeSettlementDraftProof> {
    const initial = requireTimeSettlementDraft(
      activityId,
      await this.queries.readDraftContextInTx(tx, activityId),
    );
    await tx.$queryRaw`SELECT id FROM "AttendanceSettlementVersion" WHERE id = ${initial.settlementDraftVersionId} FOR SHARE`;
    await reauthorize();
    await tx.$queryRaw`SELECT id FROM "EvidenceSeal" WHERE id = ${initial.evidenceSealId} FOR SHARE`;
    await reauthorize();
    await tx.$queryRaw`SELECT id FROM "ActivityEvidenceState" WHERE "activityId" = ${activityId} FOR SHARE`;
    await reauthorize();
    const context = await this.queries.readDraftContextInTx(tx, activityId);
    const proof = requireTimeSettlementDraft(activityId, context);
    if (
      context?.draftVersion !== expected.expectedDraftVersion ||
      proof.evidenceSealId !== expected.expectedEvidenceSealId
    )
      throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_STALE);
    return proof;
  }

  private async lockedSources(
    tx: Tx,
    proof: TimeSettlementDraftProof,
    reauthorize: Reauthorize,
  ): Promise<TimeSettlementSourceSet> {
    const set = await this.queries.readSourceSetInTx(tx, proof);
    await tx.$queryRaw`SELECT id FROM "ActivityParticipationIdentity"
      WHERE "activityId" = ${proof.activityId} ORDER BY id FOR SHARE`;
    await reauthorize();
    await tx.$queryRaw`SELECT id FROM "ParticipantServiceSegmentRevision"
      WHERE id = ANY(${set.segments.map((row) => row.id)}::text[]) ORDER BY id FOR SHARE`;
    await reauthorize();
    await tx.$queryRaw`SELECT id FROM "ActivityRuleSnapshot"
      WHERE id = ANY(${[...new Set(set.latest.map((row) => row.ruleSnapshotId))]}::text[]) ORDER BY id FOR SHARE`;
    await reauthorize();
    await tx.$queryRaw`SELECT id FROM "TimePolicyVersion"
      WHERE id = ANY(${[...new Set(set.latest.map((row) => row.policyVersionId))]}::text[]) ORDER BY id FOR SHARE`;
    await reauthorize();
    // A lock can wait: discard the pre-wait collection and read current rows again.
    return await this.queries.readSourceSetInTx(tx, proof);
  }

  private async replay(
    tx: Tx,
    activityId: string,
    actor: CurrentUserPayload,
    operationCode: Operation,
    operationKey: string,
    requestHash: string,
    meta: AuditMeta,
    reauthorize: Reauthorize,
  ): Promise<TimeSettlementReceiptResult | null> {
    const receipt = await tx.activitySettlementTimeCommandReceipt.findUnique({
      where: {
        actorUserId_operationCode_operationKey: {
          actorUserId: actor.id,
          operationCode,
          operationKey,
        },
      },
      include: { timeRevision: true },
    });
    if (!receipt) return null;
    if (receipt.activityId !== activityId || receipt.requestHash !== requestHash)
      throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_COMMAND_CONFLICT);
    if (
      receipt.timeRevision.activityId !== activityId ||
      receipt.timeRevision.id !== receipt.timeRevisionId ||
      receipt.timeRevision.createdByUserId !== actor.id
    )
      throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_INVALID);
    const result = parseTimeSettlementReceipt(
      receipt.resultJson,
      activityId,
      receipt.timeRevisionId,
    );
    await this.audit.log(tx, await reauthorize(), meta, operationCode, result, true);
    return result;
  }

  async allocate(activityId: string, input: unknown, user: CurrentUserPayload, meta: AuditMeta) {
    this.gate.assertV11WriteAllowed();
    try {
      const command = parseTimeSettlementAllocationCommand(
        instanceToPlain(input, { exposeUnsetFields: false }),
      );
      const requestHash = timeSettlementAllocationRequestHash(activityId, user.id, command);
      return await this.write(
        activityId,
        user,
        'allocate',
        TIME_SETTLEMENT_ALLOCATION_OPERATION,
        command.allocation.operationKey,
        30000,
        async (tx, reauthorize) => {
          return await this.allocations.recognizeSealedDraftInTx(
            tx,
            activityId,
            command.allocation,
            requestHash,
            meta,
            reauthorize,
            async () => {
              const proof = await this.lockedProof(tx, activityId, command, reauthorize);
              if (
                proof.evidenceRevision !== command.expectedEvidenceRevision ||
                proof.populationRevision !== command.expectedPopulationRevision ||
                proof.workflowRevision !== command.expectedWorkflowRevision
              )
                throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_STALE);
              return {
                settlementDraftVersionId: proof.settlementDraftVersionId,
                settlementEvidenceSealId: proof.evidenceSealId,
                settlementEvidenceRevision: proof.evidenceRevision,
                settlementPopulationRevision: proof.populationRevision,
                settlementWorkflowRevision: proof.workflowRevision,
                settlementDraftContentHash: proof.draftContentHash,
              };
            },
          );
        },
      );
    } catch (error) {
      return timeSettlementError(error);
    }
  }

  async prepare(
    activityId: string,
    input: unknown,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<TimeSettlementReceiptResult> {
    this.gate.assertV11WriteAllowed();
    try {
      const command = parseTimeSettlementPrepareCommand(
        instanceToPlain(input, { exposeUnsetFields: false }),
      );
      const requestHash = timeSettlementPrepareRequestHash(activityId, user.id, command);
      return await this.write(
        activityId,
        user,
        'prepare',
        TIME_SETTLEMENT_PREPARE_OPERATION,
        command.operationKey,
        30000,
        async (tx, reauthorize) => {
          const replay = await this.replay(
            tx,
            activityId,
            await reauthorize(),
            TIME_SETTLEMENT_PREPARE_OPERATION,
            command.operationKey,
            requestHash,
            meta,
            reauthorize,
          );
          if (replay) return replay;
          const proof = await this.lockedProof(tx, activityId, command, reauthorize);
          const set = await this.lockedSources(tx, proof, reauthorize);
          const evaluated = await this.queries.evaluateInTx(tx, set);
          const previous = await tx.activitySettlementTimeRevision.findFirst({
            where: { settlementRunId: proof.settlementRunId },
            orderBy: { revision: 'desc' },
            select: { id: true, revision: true },
          });
          if ((previous?.revision ?? 0) !== command.expectedTimeRevision)
            throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_STALE);
          const actor = await reauthorize();
          const createdAt = new Date();
          const revision = await tx.activitySettlementTimeRevision.create({
            data: {
              activityId,
              settlementRunId: proof.settlementRunId,
              settlementVersionId: proof.settlementDraftVersionId,
              revision: command.expectedTimeRevision + 1,
              previousTimeRevisionId: previous?.id ?? null,
              kindCode: 'draft',
              sourceDraftTimeRevisionId: null,
              evidenceSealId: proof.evidenceSealId,
              evidenceRevision: proof.evidenceRevision,
              populationRevision: proof.populationRevision,
              workflowRevision: proof.workflowRevision,
              draftContentHash: proof.draftContentHash,
              sourceSetHash: set.sourceSetHash,
              bucketContentHash: evaluated.bucketContentHash,
              bucketCount: evaluated.bucketCount,
              sourceCount: evaluated.sourceCount,
              createdByUserId: actor.id,
              createdAt,
            },
          });
          await this.insertBuckets(tx, revision, evaluated.buckets);
          const result = this.result(
            revision,
            command.expectedDraftVersion,
            proof.draftContentHash,
          );
          await reauthorize();
          await this.receipt(
            tx,
            actor.id,
            TIME_SETTLEMENT_PREPARE_OPERATION,
            command.operationKey,
            requestHash,
            result,
            createdAt,
          );
          await this.audit.log(
            tx,
            await reauthorize(),
            meta,
            TIME_SETTLEMENT_PREPARE_OPERATION,
            result,
            false,
          );
          return result;
        },
      );
    } catch (error) {
      return timeSettlementError(error);
    }
  }

  async submit(
    activityId: string,
    input: unknown,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<TimeSettlementReceiptResult> {
    this.gate.assertV11WriteAllowed();
    try {
      const command = parseTimeSettlementSubmitCommand(
        instanceToPlain(input, { exposeUnsetFields: false }),
      );
      const requestHash = timeSettlementSubmitRequestHash(activityId, user.id, command);
      return await this.write(
        activityId,
        user,
        'submit',
        TIME_SETTLEMENT_SUBMIT_OPERATION,
        command.operationKey,
        SETTLEMENT_SUBMIT_TX_TIMEOUT_MS,
        async (tx, reauthorize) => {
          const replay = await this.replay(
            tx,
            activityId,
            await reauthorize(),
            TIME_SETTLEMENT_SUBMIT_OPERATION,
            command.operationKey,
            requestHash,
            meta,
            reauthorize,
          );
          if (replay) return replay;
          const proof = await this.lockedProof(tx, activityId, command, reauthorize);
          const prepared = await tx.activitySettlementTimeRevision.findFirst({
            where: { activityId, settlementRunId: proof.settlementRunId },
            orderBy: { revision: 'desc' },
          });
          if (
            !prepared ||
            prepared.id !== command.timeRevisionId ||
            prepared.kindCode !== 'draft' ||
            prepared.settlementVersionId !== proof.settlementDraftVersionId ||
            prepared.bucketContentHash !== command.expectedBucketContentHash ||
            prepared.draftContentHash !== proof.draftContentHash ||
            prepared.evidenceSealId !== proof.evidenceSealId ||
            prepared.evidenceRevision !== proof.evidenceRevision ||
            prepared.populationRevision !== proof.populationRevision ||
            prepared.workflowRevision !== proof.workflowRevision ||
            prepared.revision >= 2147483647
          )
            throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_STALE);
          const set = await this.lockedSources(tx, proof, reauthorize);
          if (set.sourceSetHash !== prepared.sourceSetHash)
            throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_STALE);
          const bucketHash = await tx.$queryRaw<
            { hash: string }[]
          >`SELECT astr_bucket_content_hash(${prepared.id}) AS hash`;
          if (bucketHash[0]?.hash !== prepared.bucketContentHash)
            throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_INVALID);
          const internalKey =
            'time-settlement:' +
            fingerprintMetricEnvelope('activity-time-settlement-submit-link-v1', {
              actorUserId: user.id,
              operationKey: command.operationKey,
            }).definitionHash;
          let result: TimeSettlementReceiptResult | undefined;
          await this.settlements.submitTimeSettlementInTx(
            tx,
            {
              activityId,
              operationKey: internalKey,
              requestHash,
              expectedDraftVersion: command.expectedDraftVersion,
              expectedEvidenceSealId: command.expectedEvidenceSealId,
            },
            await reauthorize(),
            meta,
            {
              bucketContentHash: prepared.bucketContentHash,
              sourceSetHash: prepared.sourceSetHash,
              reauthorize,
              copyPrepared: async (submitTx, target) => {
                if (submitTx !== tx || target.draftVersionId !== prepared.settlementVersionId)
                  throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_STALE);
                const actor = await reauthorize(),
                  createdAt = new Date();
                const { id: _id, createdAt: _at, createdByUserId: _actor, ...basis } = prepared;
                void _id;
                void _at;
                void _actor;
                const submitted = await tx.activitySettlementTimeRevision.create({
                  data: {
                    ...basis,
                    settlementVersionId: target.settlementVersionId,
                    revision: prepared.revision + 1,
                    previousTimeRevisionId: prepared.id,
                    kindCode: 'submitted',
                    sourceDraftTimeRevisionId: prepared.id,
                    createdAt,
                    createdByUserId: actor.id,
                  },
                });
                await this.copyBuckets(tx, prepared, submitted);
                result = this.result(submitted, target.settlementVersion, target.contentHash);
                await reauthorize();
                await this.receipt(
                  tx,
                  actor.id,
                  TIME_SETTLEMENT_SUBMIT_OPERATION,
                  command.operationKey,
                  requestHash,
                  result,
                  createdAt,
                );
                await this.audit.log(
                  tx,
                  await reauthorize(),
                  meta,
                  TIME_SETTLEMENT_SUBMIT_OPERATION,
                  result,
                  false,
                );
              },
            },
          );
          if (!result) throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_INVALID);
          return result;
        },
      );
    } catch (error) {
      return timeSettlementError(error);
    }
  }

  private result(
    revision: ActivitySettlementTimeRevision,
    settlementVersion: number,
    contentHash: string,
  ): TimeSettlementReceiptResult {
    return parseTimeSettlementReceipt(
      {
        schemaVersion: 1,
        activityId: revision.activityId,
        timeRevisionId: revision.id,
        revision: revision.revision,
        kindCode: revision.kindCode,
        settlementRunId: revision.settlementRunId,
        settlementVersionId: revision.settlementVersionId,
        settlementVersion,
        contentHash,
        bucketContentHash: revision.bucketContentHash,
        bucketCount: revision.bucketCount,
        sourceCount: revision.sourceCount,
        createdAt: revision.createdAt.toISOString(),
      },
      revision.activityId,
      revision.id,
    );
  }

  private async receipt(
    tx: Tx,
    actorUserId: string,
    operationCode: Operation,
    operationKey: string,
    requestHash: string,
    result: TimeSettlementReceiptResult,
    createdAt: Date,
  ): Promise<void> {
    await tx.activitySettlementTimeCommandReceipt.create({
      data: {
        actorUserId,
        activityId: result.activityId,
        operationCode,
        operationKey,
        requestHash,
        timeRevisionId: result.timeRevisionId,
        resultJson: result as unknown as Prisma.InputJsonValue,
        createdAt,
      },
    });
  }

  private async insertBuckets(
    tx: Tx,
    revision: ActivitySettlementTimeRevision,
    buckets: readonly TimeSettlementBucket[],
  ): Promise<void> {
    const rows = buckets.map((row) => ({
      ...row,
      id: randomUUID(),
      rawCalculatedMilliseconds: row.rawCalculatedMilliseconds?.toString() ?? null,
      rawRecognizedMilliseconds: row.rawRecognizedMilliseconds.toString(),
      sources: row.sources.map((source) => ({
        ...source,
        rawCalculatedMilliseconds: source.rawCalculatedMilliseconds?.toString() ?? null,
        rawRecognizedMilliseconds: source.rawRecognizedMilliseconds.toString(),
      })),
    }));
    const json = JSON.stringify(rows);
    const bucketCount = await tx.$executeRaw`
      INSERT INTO "ParticipantSettlementTimeBucket" (id, "timeRevisionId", "activityId", "participationIdentityId",
        "categoryCode", "calculatedSeconds", "recognizedSeconds", "adjustmentReason", "timePolicyVersionId",
        "definitionHash", "evaluatorVersion", "quantumSeconds", "rawCalculatedMilliseconds", "rawRecognizedMilliseconds")
      SELECT x.id, ${revision.id}, ${revision.activityId}, x."participationIdentityId", x."categoryCode", x."calculatedSeconds",
        x."recognizedSeconds", nullif(x."adjustmentReason", 'null'::jsonb), x."timePolicyVersionId", x."definitionHash", x."evaluatorVersion",
        x."quantumSeconds", x."rawCalculatedMilliseconds", x."rawRecognizedMilliseconds"
      FROM jsonb_to_recordset(${json}::jsonb) AS x(id TEXT, "participationIdentityId" TEXT, "categoryCode" TEXT,
        "calculatedSeconds" INTEGER, "recognizedSeconds" INTEGER, "adjustmentReason" JSONB, "timePolicyVersionId" TEXT,
        "definitionHash" TEXT, "evaluatorVersion" INTEGER, "quantumSeconds" INTEGER,
        "rawCalculatedMilliseconds" BIGINT, "rawRecognizedMilliseconds" BIGINT)
    `;
    const sourceCount = await tx.$executeRaw`
      INSERT INTO "ParticipantSettlementTimeBucketSource" (id, "bucketId", "timeRevisionId", "activityId",
        "allocationRevisionId", "sourceSegmentId", "sourceSegmentRevision", "rawCalculatedMilliseconds", "rawRecognizedMilliseconds")
      SELECT gen_random_uuid()::text, b.id, ${revision.id}, ${revision.activityId}, s."allocationRevisionId", s."sourceSegmentId",
        s."sourceSegmentRevision", s."rawCalculatedMilliseconds", s."rawRecognizedMilliseconds"
      FROM jsonb_to_recordset(${json}::jsonb) AS b(id TEXT, sources JSONB)
      CROSS JOIN LATERAL jsonb_to_recordset(b.sources) AS s("allocationRevisionId" TEXT, "sourceSegmentId" TEXT,
        "sourceSegmentRevision" INTEGER, "rawCalculatedMilliseconds" BIGINT, "rawRecognizedMilliseconds" BIGINT)
    `;
    if (bucketCount !== revision.bucketCount || sourceCount !== revision.sourceCount)
      throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_INVALID);
  }

  private async copyBuckets(
    tx: Tx,
    source: ActivitySettlementTimeRevision,
    target: ActivitySettlementTimeRevision,
  ): Promise<void> {
    const bucketCount = await tx.$executeRaw`
      INSERT INTO "ParticipantSettlementTimeBucket" (id, "timeRevisionId", "activityId", "participationIdentityId",
        "categoryCode", "calculatedSeconds", "recognizedSeconds", "adjustmentReason", "timePolicyVersionId",
        "definitionHash", "evaluatorVersion", "quantumSeconds", "rawCalculatedMilliseconds", "rawRecognizedMilliseconds")
      SELECT gen_random_uuid()::text, ${target.id}, "activityId", "participationIdentityId", "categoryCode",
        "calculatedSeconds", "recognizedSeconds", "adjustmentReason", "timePolicyVersionId", "definitionHash",
        "evaluatorVersion", "quantumSeconds", "rawCalculatedMilliseconds", "rawRecognizedMilliseconds"
      FROM "ParticipantSettlementTimeBucket" WHERE "timeRevisionId" = ${source.id} AND "activityId" = ${source.activityId}
    `;
    const sourceCount = await tx.$executeRaw`
      INSERT INTO "ParticipantSettlementTimeBucketSource" (id, "bucketId", "timeRevisionId", "activityId",
        "allocationRevisionId", "sourceSegmentId", "sourceSegmentRevision", "rawCalculatedMilliseconds", "rawRecognizedMilliseconds")
      SELECT gen_random_uuid()::text, target_bucket.id, ${target.id}, s."activityId", s."allocationRevisionId",
        s."sourceSegmentId", s."sourceSegmentRevision", s."rawCalculatedMilliseconds", s."rawRecognizedMilliseconds"
      FROM "ParticipantSettlementTimeBucketSource" s
      JOIN "ParticipantSettlementTimeBucket" old_bucket ON old_bucket.id = s."bucketId"
      JOIN "ParticipantSettlementTimeBucket" target_bucket ON target_bucket."timeRevisionId" = ${target.id}
        AND target_bucket."participationIdentityId" = old_bucket."participationIdentityId"
        AND target_bucket."categoryCode" = old_bucket."categoryCode" AND target_bucket."activityId" = s."activityId"
      WHERE s."timeRevisionId" = ${source.id} AND s."activityId" = ${source.activityId}
    `;
    if (bucketCount !== target.bucketCount || sourceCount !== target.sourceCount)
      throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_INVALID);
  }
}
