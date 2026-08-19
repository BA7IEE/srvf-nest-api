import { Injectable } from '@nestjs/common';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  SETTLEMENT_DRAFT_SYNC_MAX_POPULATION,
  SettlementDraftService,
  type SettlementDraftResult,
} from './settlement-draft.service';

type PrismaTx = Prisma.TransactionClient;

export const SETTLEMENT_DRAFT_GENERATE_JOB_TYPE = 'bulk_proxy';
export const SETTLEMENT_DRAFT_GENERATE_JOB_ACTION = 'settlement_draft_generate';
const SETTLEMENT_DRAFT_GENERATE_ITEM_KEY = 'generate';

export interface SettlementDraftGenerateInput {
  activityId: string;
  operationKey: string;
  requestHash: string;
}

export type SettlementDraftDispatchResult =
  | {
      outcome: 'draft';
      activityId: string;
      settlementRunId: string;
      settlementVersionId: string;
      personCount: number;
      sessionParticipationCount: number;
      replayed: boolean;
    }
  | {
      outcome: 'job';
      activityId: string;
      jobId: string;
      statusCode: string;
      total: number;
      replayed: boolean;
    };

@Injectable()
export class SettlementDraftDispatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly drafts: SettlementDraftService,
    // 活动 v1.1 cutover gate —— 新结算真相链的判闸依据(合同 §16.2 单轨)。
    private readonly activityWorkflowGate: ActivityWorkflowGate,
  ) {}

  async generate(
    input: SettlementDraftGenerateInput,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<SettlementDraftDispatchResult> {
    // 活动 v1.1 单一 cutover gate(合同 §16.2):闸未开时本实例仍按旧口径结算,
    // 新结算真相链禁止落库 —— 否则就是合同点名禁止的「新打卡＋旧结算」混合态。
    this.activityWorkflowGate.assertV11WriteAllowed();
    const reservation = await this.reserveWithOperationKeyReplay(input, currentUser);
    if (reservation.kind === 'job' || reservation.kind === 'draft') return reservation.result;

    try {
      // 旧生成器仍是唯一的草稿/段算法。调度层只做 operation receipt 与规模分流,
      // 不复制 punch 投影、贡献规则或 contentHash 协议。
      const draft = await this.drafts.generate(input.activityId, currentUser, auditMeta);
      await this.finishSync(reservation.jobId, draft, input);
      return draftResult(draft, false);
    } catch (error) {
      await this.failSync(reservation.jobId, error);
      throw error;
    }
  }

  private async reserveWithOperationKeyReplay(
    input: SettlementDraftGenerateInput,
    currentUser: CurrentUserPayload,
  ): ReturnType<SettlementDraftDispatchService['reserve']> {
    try {
      return await this.reserve(input, currentUser);
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;

      // 不同 activity 并发抢同一 operationKey 时，唯一约束决定赢家；输家重读
      // winner 的 receipt，随后走同 payload replay 或具名 conflict，避免泄漏 P2002。
      return await this.reserve(input, currentUser);
    }
  }

  private async reserve(
    input: SettlementDraftGenerateInput,
    currentUser: CurrentUserPayload,
  ): Promise<
    | { kind: 'sync'; jobId: string }
    | { kind: 'job'; result: Extract<SettlementDraftDispatchResult, { outcome: 'job' }> }
    | { kind: 'draft'; result: Extract<SettlementDraftDispatchResult, { outcome: 'draft' }> }
  > {
    return await this.prisma.$transaction(async (tx) => {
      const activity = await this.lockActivity(tx, input.activityId);

      const existing = await tx.activityBatchJob.findUnique({
        where: { operationKey: input.operationKey },
        select: {
          id: true,
          activityId: true,
          jobTypeCode: true,
          statusCode: true,
          requestHash: true,
          total: true,
          payload: true,
        },
      });
      if (existing !== null) return await this.resolveExisting(tx, existing, input);

      await this.requireActiveSeal(tx, input.activityId, activity.workflowRevision);
      const run = await tx.attendanceSettlementRun.findUnique({
        where: { activityId: input.activityId },
        select: { statusCode: true },
      });
      if (run !== null && run.statusCode !== 'not_started' && run.statusCode !== 'drafting') {
        throw new BizException(BizCode.SETTLEMENT_DRAFT_RUN_STATUS_INVALID);
      }

      const population = await tx.activityParticipationIdentity.findMany({
        where: { activityId: input.activityId, populationIncluded: true },
        select: { memberId: true },
      });
      const populationSize = Math.max(
        population.length,
        new Set(population.map((row) => row.memberId)).size,
      );
      const asyncMode = populationSize > SETTLEMENT_DRAFT_SYNC_MAX_POPULATION;
      const now = new Date();
      const job = await tx.activityBatchJob.create({
        data: {
          jobTypeCode: SETTLEMENT_DRAFT_GENERATE_JOB_TYPE,
          activityId: input.activityId,
          statusCode: asyncMode ? 'pending' : 'processing',
          operationKey: input.operationKey,
          requestHash: input.requestHash,
          payloadVersion: 1,
          payload: {
            action: SETTLEMENT_DRAFT_GENERATE_JOB_ACTION,
            executionMode: asyncMode ? 'async' : 'sync',
            activityId: input.activityId,
            populationSize,
          },
          total: 1,
          attempts: asyncMode ? 0 : 1,
          // 写与判同源:领取判据是 `"availableAt" <= ${now}`(应用时钟),故此处显式写应用时钟,
          // 不吃列上的 `@default(now())`(数据库时钟)。
          availableAt: now,
          startedAt: asyncMode ? null : now,
          createdByUserId: currentUser.id,
        },
        select: { id: true, statusCode: true, total: true },
      });
      await tx.activityBatchJobItem.create({
        data: {
          jobId: job.id,
          itemKey: SETTLEMENT_DRAFT_GENERATE_ITEM_KEY,
          statusCode: asyncMode ? 'pending' : 'processing',
          resourceType: 'activity',
          resourceId: input.activityId,
          payloadHash: input.requestHash,
        },
      });

      if (asyncMode) {
        return {
          kind: 'job' as const,
          result: {
            outcome: 'job' as const,
            activityId: input.activityId,
            jobId: job.id,
            statusCode: job.statusCode,
            total: job.total,
            replayed: false,
          },
        };
      }
      return { kind: 'sync' as const, jobId: job.id };
    });
  }

  private async resolveExisting(
    tx: PrismaTx,
    existing: {
      id: string;
      activityId: string;
      jobTypeCode: string;
      statusCode: string;
      requestHash: string | null;
      total: number;
      payload: Prisma.JsonValue;
    },
    input: SettlementDraftGenerateInput,
  ): Promise<
    | { kind: 'sync'; jobId: string }
    | { kind: 'job'; result: Extract<SettlementDraftDispatchResult, { outcome: 'job' }> }
    | { kind: 'draft'; result: Extract<SettlementDraftDispatchResult, { outcome: 'draft' }> }
  > {
    const payload = jsonObject(existing.payload);
    if (
      existing.activityId !== input.activityId ||
      existing.jobTypeCode !== SETTLEMENT_DRAFT_GENERATE_JOB_TYPE ||
      payload['action'] !== SETTLEMENT_DRAFT_GENERATE_JOB_ACTION ||
      existing.requestHash !== input.requestHash
    ) {
      throw new BizException(BizCode.SETTLEMENT_DRAFT_OPERATION_KEY_CONFLICT);
    }

    if (payload['executionMode'] === 'async') {
      return {
        kind: 'job',
        result: {
          outcome: 'job',
          activityId: input.activityId,
          jobId: existing.id,
          statusCode: existing.statusCode,
          total: existing.total,
          replayed: true,
        },
      };
    }

    if (existing.statusCode === 'succeeded') {
      const item = await tx.activityBatchJobItem.findFirst({
        where: { jobId: existing.id, itemKey: SETTLEMENT_DRAFT_GENERATE_ITEM_KEY },
        select: { resultReference: true },
      });
      if (item?.resultReference !== null && item?.resultReference !== undefined) {
        const version = await tx.attendanceSettlementVersion.findUnique({
          where: { id: item.resultReference },
          select: {
            id: true,
            settlementRunId: true,
            personCount: true,
            sessionParticipationCount: true,
          },
        });
        if (version !== null) {
          return {
            kind: 'draft',
            result: {
              outcome: 'draft',
              activityId: input.activityId,
              settlementRunId: version.settlementRunId,
              settlementVersionId: version.id,
              personCount: version.personCount,
              sessionParticipationCount: version.sessionParticipationCount,
              replayed: true,
            },
          };
        }
      }
    }

    await tx.activityBatchJob.update({
      where: { id: existing.id },
      data: {
        statusCode: 'processing',
        attempts: { increment: 1 },
        startedAt: new Date(),
        completedAt: null,
        lastErrorCode: null,
      },
    });
    await tx.activityBatchJobItem.updateMany({
      where: { jobId: existing.id, itemKey: SETTLEMENT_DRAFT_GENERATE_ITEM_KEY },
      data: { statusCode: 'processing', lastErrorCode: null, safeMessage: null },
    });
    return { kind: 'sync', jobId: existing.id };
  }

  private async finishSync(
    jobId: string,
    draft: SettlementDraftResult,
    input: SettlementDraftGenerateInput,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Version 上是第一把 generate key 的直达落点；每次调用的完整幂等 receipt 则由
      // ActivityBatchJob.operationKey unique 保存，因同内容草稿本来就可能复用同一 version。
      await tx.attendanceSettlementVersion.updateMany({
        where: { id: draft.settlementVersionId, operationKey: null },
        data: { operationKey: input.operationKey, requestHash: input.requestHash },
      });
      await tx.activityBatchJobItem.updateMany({
        where: { jobId, itemKey: SETTLEMENT_DRAFT_GENERATE_ITEM_KEY },
        data: {
          statusCode: 'succeeded',
          attempts: { increment: 1 },
          resultReference: draft.settlementVersionId,
          lastErrorCode: null,
          safeMessage: null,
        },
      });
      await tx.activityBatchJob.update({
        where: { id: jobId },
        data: {
          statusCode: 'succeeded',
          succeeded: 1,
          failed: 0,
          completedAt: new Date(),
          lastErrorCode: null,
        },
      });
    });
  }

  private async failSync(jobId: string, error: unknown): Promise<void> {
    const lastErrorCode = errorName(error);
    await this.prisma.$transaction(async (tx) => {
      await tx.activityBatchJobItem.updateMany({
        where: { jobId, itemKey: SETTLEMENT_DRAFT_GENERATE_ITEM_KEY },
        data: { statusCode: 'failed', attempts: { increment: 1 }, lastErrorCode },
      });
      await tx.activityBatchJob.update({
        where: { id: jobId },
        data: { statusCode: 'failed', failed: 1, completedAt: new Date(), lastErrorCode },
      });
    });
  }

  private async lockActivity(
    tx: PrismaTx,
    activityId: string,
  ): Promise<{ workflowRevision: number }> {
    const rows = await tx.$queryRaw<Array<{ workflowRevision: number }>>`
      SELECT "workflowRevision"
      FROM "Activity"
      WHERE id = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return row;
  }

  private async requireActiveSeal(
    tx: PrismaTx,
    activityId: string,
    workflowRevision: number,
  ): Promise<void> {
    const seal = await tx.evidenceSeal.findFirst({
      where: { activityId, statusCode: 'active' },
      orderBy: { sealRevision: 'desc' },
      select: {
        evidenceRevision: true,
        populationRevision: true,
        workflowRevision: true,
      },
    });
    if (seal === null) {
      const sealCount = await tx.evidenceSeal.count({ where: { activityId } });
      throw new BizException(
        sealCount === 0
          ? BizCode.SETTLEMENT_DRAFT_EVIDENCE_SEAL_MISSING
          : BizCode.SETTLEMENT_DRAFT_EVIDENCE_SEAL_SUPERSEDED,
      );
    }
    const state = await tx.activityEvidenceState.findUnique({
      where: { activityId },
      select: { evidenceRevision: true, populationRevision: true },
    });
    if (
      seal.evidenceRevision !== (state?.evidenceRevision ?? 0) ||
      seal.populationRevision !== (state?.populationRevision ?? 0) ||
      seal.workflowRevision !== workflowRevision
    ) {
      throw new BizException(BizCode.SETTLEMENT_DRAFT_EVIDENCE_SEAL_STALE);
    }
  }
}

function draftResult(
  draft: SettlementDraftResult,
  replayed: boolean,
): Extract<SettlementDraftDispatchResult, { outcome: 'draft' }> {
  return {
    outcome: 'draft',
    activityId: draft.activityId,
    settlementRunId: draft.settlementRunId,
    settlementVersionId: draft.settlementVersionId,
    personCount: draft.personCount,
    sessionParticipationCount: draft.sessionParticipationCount,
    replayed,
  };
}

function jsonObject(value: Prisma.JsonValue): Prisma.JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function errorName(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) return error.name;
  return 'UnknownError';
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
