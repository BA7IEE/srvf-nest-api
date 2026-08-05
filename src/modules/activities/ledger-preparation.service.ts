import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import {
  allocateDailyCredit,
  decimalToHundredths,
  fromHundredths,
  splitRecognizedIntoDays,
  type LedgerDaySplitRow,
} from './ledger-day-allocation';

// ===== 活动改造 v1.1 第 2 批第五刀:§5.12 万人账本准备协议 =====
//
// 🔴 **准备阶段写的是"还看不见的账"。** 它写进 `ParticipationLedgerEntry` 的每一行
//    都挂在一个尚未 committed 的批次上,对所有正常读面不可见(§3.22)。
//    真正让它变成钱的是第五刀的另一半 `LedgerPostingService.commitBatch`(§5.13)。
//
// ## 🔴 本文件的第一条红线:**零 `pg_advisory`**
//
// §5.12 末句逐字:「准备阶段**不持有一万人 member locks 长事务**;基线变化在最终提交时
// 统一发现。」万人 advisory 锁一次占满 PostgreSQL 共享锁表保底(12800)的 78%,
// 而准备是**分块的、可能跑几分钟**的路径 —— 在这里持锁等于把整库的锁预算按分钟计地占住。
//
// ⇒ 本文件**一处 advisory 锁都没有**,判据是结构断言(源码里 `pg_advisory` 命中数 = 0),
//   见 `test/e2e/activity-ledger-posting.e2e-spec.ts` ⑦。排他性完全由
//   `commitBatch` 那一次**短**事务提供。
//
// ## 分块口径:**按队员分块**,不是按 ResultRevision 逐条分块
//
// §5.12 首句是「分块处理 ResultRevision」。本实现的一个块 = **一批队员的全部
// ResultRevision**,理由是硬的:
//
//   日上限(§3.24)是 **(member, ledgerDate) 维度**的跨行不变量。若按 ResultRevision
//   随意切块,同一个人同一天的两个场次会落进两个块 —— 每块各自按"当日还剩多少额度"
//   分配,两块都以为自己拿得到,合起来就超了。**按队员分块 ⇒ 一个人一天的全部服务
//   必定在同一个块内**,块内一次算完(`allocateDailyCredit`)。
//
// ⚠️ 这**不能**解决"另一场活动的批次同时在准备同一个人同一天"—— 那是跨批次的,
//    准备阶段无锁就必然看不见。它归 `commitBatch` 的 baseline 比对 + 日上限复判
//    (那里有 member advisory lock)。两层各管一段,不重叠。
//
// ## 块的成员由**索引**决定,不落 payload
//
// 第 k 块 = 本 SettlementVersion 全部 distinct memberId 升序排列后
// `[k·CHUNK, (k+1)·CHUNK)` 那一段。SettlementVersion 提交后不可变(§3.19)⇒ 这个
// 列表是确定的,崩溃重放时算出的块与第一次逐字相同。
// ⇒ payload 里**不存队员名单**(万人名单进 Json 是没必要的膨胀)。
//
// ## 幂等与崩溃重入(§5.12 ⑦)
//
// 一个 item 的**业务写 + item 标成功**在**同一个事务**里 —— 严格强于合同设想的
// 「业务写成功但 item 尚未标成功」。即便如此仍留第二道:分录的 `entryKey` /
// `operationKey` 都是**内容确定**的单列 unique,写入走 `ON CONFLICT DO NOTHING`,
// 重放不可能翻倍(判据见 e2e ④)。
//
// ⚠️ `ParticipationLedgerEntry` 上有 append-only trigger(第 1 批第四刀,`55000`)——
//    分录**只能 INSERT**,不能 UPDATE / DELETE。所以重放必须是"结果逐字相同"的,
//    而不是"改写上一次的结果":整块在一个事务里算完并写完,要么全在要么全不在。
//
// ## 本刀不做的事
//
// ❌ 零端点 / 零 DTO / 零权限码(整条流程入口留到第 2 批收尾)。
// ❌ 零 schema:39 张表已够用。
// ❌ 不产生 reversal(`LedgerEntryReversalClaim` 零行)—— 更正归第六刀,见文件末尾声明。

type PrismaTx = Prisma.TransactionClient;

/**
 * 一个 job item 覆盖多少个队员。
 *
 * 500 不是拍脑袋:它同时满足三条 ——
 *   ① 块内 `IN (...)` 类查询的 bind 参数上界恒为 500 × 常数,与**总人数无关**
 *      (万人不会把 bind 顶到 32767 上限);
 *   ② 万人 = 20 个 item,item 表不会膨胀成"一人一行";
 *   ③ 单块事务的工作量与本仓已实测的批量规模同量级。
 */
export const LEDGER_PREPARE_MEMBER_CHUNK_SIZE = 500;

/** 单个 item 事务的显式预算。分块之后每块工作量有界,不需要第三刀那种长预算。 */
export const LEDGER_PREPARE_ITEM_TX_TIMEOUT_MS = 60_000;

export const LEDGER_PREPARE_JOB_TYPE = 'settlement_prepare';

/** 段的哪些形态**参与**日拆分的权重。voided / replaced 不是有效服务事实。 */
const WEIGHT_BEARING_SEGMENT_RESULT_CODES = ['valid', 'early_departure_zero'];

export interface LedgerPrepareChunkResult {
  jobId: string;
  itemId: string;
  itemKey: string;
  /** 本块实际处理的队员数。 */
  memberCount: number;
  /** 本块新写入的分录数(重放时为 0)。 */
  entriesInserted: number;
  dayRowsWritten: number;
  /** true = 该 item 早已成功,本次直接跳过(崩溃重入的正常形态)。 */
  skipped: boolean;
}

export interface LedgerPrepareFinalizeResult {
  jobId: string;
  postingBatchId: string;
  batchStatus: string;
  preparedCount: number;
  totalCount: number;
  baselineJsonHash: string | null;
}

/** 租约围栏(fencing token):`(leaseOwner, leaseGeneration)` 成对,缺一不成立。 */
export interface LedgerPrepareLeaseFence {
  readonly leaseOwner: string;
  readonly leaseGeneration: number;
}

/** 租约已被别的 worker 抢走 —— 本次处理必须整体作废(不是业务错,不给 BizCode)。 */
export class LedgerPrepareLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`活动批处理任务 ${jobId} 的租约已失效`);
    this.name = 'LedgerPrepareLeaseLostError';
  }
}

/** job payload 里 day-state 基线的落点。键 = `${memberId}|${YYYY-MM-DD}`。 */
export const LEDGER_BASELINE_PAYLOAD_KEY = 'dayStateBaseline';

/** 基线值的字面形状 `${version}:${creditedHundredths}` —— 紧凑,万人量级也不撑爆 Json。 */
export type LedgerDayStateBaseline = Record<string, string>;

export function ledgerBaselineKey(memberId: string, ledgerDate: string): string {
  return `${memberId}|${ledgerDate}`;
}

export function ledgerBaselineValue(version: number, creditedHundredths: number): string {
  return `${version}:${creditedHundredths}`;
}

/**
 * 基线摘要 = 按键排序后的 canonical JSON 的 sha256。
 *
 * 落在 `LedgerPostingBatch.baselineJsonHash`(§3.22 给它的定义就是
 * 「seal、人员、day-state 基线摘要」)。生效时先用它复核 job payload 里的明细
 * 没有被绕过应用层改动过,再逐条比对 —— 两层各抓一种形态(20085 / 20084)。
 */
export function ledgerBaselineDigest(baseline: LedgerDayStateBaseline): string {
  const canonical = JSON.stringify(
    Object.keys(baseline)
      .sort()
      .map((key) => [key, baseline[key]]),
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

interface ResultRevisionRow {
  id: string;
  statusCode: string;
  recognizedServiceHours: Prisma.Decimal;
  recognizedContributionPoints: Prisma.Decimal;
  participationIdentityId: string;
  identity: { memberId: string; sessionId: string; activityId: string };
}

interface PreparedDayRow {
  resultRevisionId: string;
  memberId: string;
  sessionId: string;
  participationIdentityId: string;
  ledgerDate: string;
  serviceHours: number;
  recognizedPoints: number;
  creditedPoints: number;
  cappedOutPoints: number;
  sequenceStartAt: Date;
  stableOrderKey: string;
}

@Injectable()
export class LedgerPreparationService {
  constructor(private readonly prisma: PrismaService) {}

  // =========================================================================
  // ① 建任务(§5.12 的入口)。幂等:`operationKey` 单列 unique 兜底。
  // =========================================================================
  async ensurePrepareJob(postingBatchId: string): Promise<{ jobId: string; itemCount: number }> {
    return await this.prisma.$transaction(async (tx) => {
      const batch = await this.lockBatch(tx, postingBatchId);
      if (batch.statusCode !== 'preparing') {
        throw new BizException(BizCode.LEDGER_PREPARE_BATCH_STATUS_INVALID);
      }

      const operationKey = `${LEDGER_PREPARE_JOB_TYPE}:${postingBatchId}`;
      const existing = await tx.activityBatchJob.findUnique({
        where: { operationKey },
        select: { id: true, total: true },
      });
      if (existing !== null) return { jobId: existing.id, itemCount: existing.total };

      const memberIds = await this.readVersionMemberIds(tx, batch.settlementVersionId);
      const chunkCount = Math.max(
        1,
        Math.ceil(memberIds.length / LEDGER_PREPARE_MEMBER_CHUNK_SIZE),
      );

      const job = await tx.activityBatchJob.create({
        data: {
          jobTypeCode: LEDGER_PREPARE_JOB_TYPE,
          activityId: batch.activityId,
          settlementVersionId: batch.settlementVersionId,
          postingBatchId,
          statusCode: 'pending',
          operationKey,
          requestHash: batch.requestHash,
          payloadVersion: 1,
          // ⚠️ payload 只放**块划分参数**与基线累积位,**不放队员名单**:
          //    名单由 `readVersionMemberIds` 的确定性顺序 + 块索引复算得出。
          payload: {
            postingBatchId,
            memberChunkSize: LEDGER_PREPARE_MEMBER_CHUNK_SIZE,
            memberCount: memberIds.length,
            [LEDGER_BASELINE_PAYLOAD_KEY]: {},
          },
          total: chunkCount,
        },
        select: { id: true },
      });

      await tx.activityBatchJobItem.createMany({
        data: Array.from({ length: chunkCount }, (_unused, index) => ({
          jobId: job.id,
          itemKey: chunkItemKey(index),
          statusCode: 'pending',
          resourceType: 'ledger_posting_batch',
          resourceId: postingBatchId,
        })),
      });

      return { jobId: job.id, itemCount: chunkCount };
    });
  }

  // =========================================================================
  // ② 处理一个块(§5.12 ②-⑦)。**业务写与 item 标成功同一事务**。
  // =========================================================================
  async prepareChunk(
    jobId: string,
    itemId: string,
    fence?: LedgerPrepareLeaseFence,
  ): Promise<LedgerPrepareChunkResult> {
    return await this.prisma.$transaction(
      async (tx) => {
        // job 行锁:同一 job 的 item 串行处理,基线合并(读-改-写 payload)才安全。
        const job = await this.lockJob(tx, jobId);
        // 🔴 fencing:租约被别人抢走之后,**本 worker 一行都不许再写**。
        //    行锁只保证"不同时写",fence 才保证"不写在别人的回合里"——
        //    少了它,一个卡住的旧 worker 醒来后会把自己那半份结果补写进去。
        if (
          fence !== undefined &&
          (job.leaseOwner !== fence.leaseOwner || job.leaseGeneration !== fence.leaseGeneration)
        ) {
          throw new LedgerPrepareLeaseLostError(jobId);
        }
        const item = await this.lockItem(tx, itemId);
        if (item.jobId !== jobId)
          throw new BizException(BizCode.LEDGER_PREPARE_BATCH_STATUS_INVALID);
        if (item.statusCode === 'succeeded') {
          return {
            jobId,
            itemId,
            itemKey: item.itemKey,
            memberCount: 0,
            entriesInserted: 0,
            dayRowsWritten: 0,
            skipped: true,
          };
        }

        const batch = await this.lockBatch(tx, requireBatchId(job.postingBatchId));
        if (batch.statusCode !== 'preparing') {
          throw new BizException(BizCode.LEDGER_PREPARE_BATCH_STATUS_INVALID);
        }

        const chunkIndex = chunkIndexOf(item.itemKey);
        const memberIds = await this.readVersionMemberIds(tx, batch.settlementVersionId);
        const chunkMemberIds = memberIds.slice(
          chunkIndex * LEDGER_PREPARE_MEMBER_CHUNK_SIZE,
          (chunkIndex + 1) * LEDGER_PREPARE_MEMBER_CHUNK_SIZE,
        );

        const revisions = await this.readResultRevisions(
          tx,
          batch.settlementVersionId,
          chunkMemberIds,
        );
        // §3.20 三值闭集:只有 `draft` 能入账。committed = 已随别的批次入过账;
        // superseded = 已被更正取代。两种都是账错,不是流程问题。
        if (revisions.some((row) => row.statusCode !== 'draft')) {
          throw new BizException(BizCode.LEDGER_PREPARE_RESULT_REVISION_STATUS_INVALID);
        }

        const spansByIdentity = await this.readWeightBearingSpans(
          tx,
          revisions.map((row) => row.participationIdentityId),
        );

        // ===== §5.12 ③ 按北京日拆 day rows =====
        const splitRows: PreparedDayRow[] = [];
        for (const revision of revisions) {
          const outcome = splitRecognizedIntoDays({
            spans: spansByIdentity.get(revision.participationIdentityId) ?? [],
            recognizedServiceHours: Number(revision.recognizedServiceHours.toString()),
            recognizedContributionPoints: Number(revision.recognizedContributionPoints.toString()),
            // §3.21 `stableOrderKey`:场次 + 身份,确定性且不依赖 id 生成顺序。
            stableOrderKey: `${revision.identity.sessionId}:${revision.participationIdentityId}`,
          });
          // 🔴 有认定值却一天都归不上 ⇒ 拒绝。**不猜日期**(见 20078 的注释)。
          if (outcome.kind === 'no_service_day') {
            throw new BizException(BizCode.LEDGER_PREPARE_DAY_SPLIT_UNRESOLVED);
          }
          for (const row of outcome.rows) {
            splitRows.push(toPreparedDayRow(revision, row));
          }
        }

        // ===== §5.12 ④ 保存基线 + ⑤ 按稳定服务顺序分配日上限 =====
        const baselineByKey = await this.readDayStateBaseline(tx, splitRows);
        this.applyDailyCap(splitRows, baselineByKey);

        const dayRowsWritten = await this.writeSettlementDays(tx, splitRows);
        const entriesInserted = await this.writeLedgerEntries(tx, batch, splitRows);

        // 基线并进 job payload(job 行已加锁 ⇒ 读-改-写安全)。
        await this.mergeBaselineIntoJob(tx, job, baselineByKey);

        await tx.activityBatchJobItem.update({
          where: { id: itemId },
          data: {
            statusCode: 'succeeded',
            attempts: { increment: 1 },
            lastErrorCode: null,
            safeMessage: null,
            // §3.27「payloadHash 是摘要,不是原值」:本块处理了哪些人的摘要。
            payloadHash: createHash('sha256')
              .update(chunkMemberIds.join(','), 'utf8')
              .digest('hex'),
          },
        });
        await tx.activityBatchJob.update({
          where: { id: jobId },
          data: { statusCode: 'processing', succeeded: { increment: 1 } },
        });
        await tx.ledgerPostingBatch.update({
          where: { id: batch.id },
          data: {
            preparedCount: { increment: chunkMemberIds.length },
            version: { increment: 1 },
          },
        });

        return {
          jobId,
          itemId,
          itemKey: item.itemKey,
          memberCount: chunkMemberIds.length,
          entriesInserted,
          dayRowsWritten,
          skipped: false,
        };
      },
      { timeout: LEDGER_PREPARE_ITEM_TX_TIMEOUT_MS },
    );
  }

  // =========================================================================
  // ③ 收口(§5.12 ⑧):全部 item 成功**且数量一致** ⇒ batch 进 `ready`。
  // =========================================================================
  async finalize(jobId: string): Promise<LedgerPrepareFinalizeResult> {
    return await this.prisma.$transaction(async (tx) => {
      const job = await this.lockJob(tx, jobId);
      const batch = await this.lockBatch(tx, requireBatchId(job.postingBatchId));

      const pending = await tx.activityBatchJobItem.count({
        where: { jobId, statusCode: { not: 'succeeded' } },
      });
      if (pending > 0) {
        return {
          jobId,
          postingBatchId: batch.id,
          batchStatus: batch.statusCode,
          preparedCount: batch.preparedCount,
          totalCount: batch.totalCount,
          baselineJsonHash: batch.baselineJsonHash,
        };
      }
      if (batch.statusCode !== 'preparing') {
        return {
          jobId,
          postingBatchId: batch.id,
          batchStatus: batch.statusCode,
          preparedCount: batch.preparedCount,
          totalCount: batch.totalCount,
          baselineJsonHash: batch.baselineJsonHash,
        };
      }

      // 🔴 §5.12 ⑧「数量一致」:准备到的队员数必须等于批次声明的人口数。
      //    不一致时**不进 ready**,也**不留在 preparing**(那等于一个永远可能
      //    "再试一次"的僵尸批次)—— 直接判 `failed`,让第四刀的下一次终审
      //    另开一条新批次(它只会恢复 preparing / ready 的批次)。
      if (batch.preparedCount !== batch.totalCount) {
        await tx.activityBatchJob.update({
          where: { id: jobId },
          data: {
            statusCode: 'failed',
            completedAt: new Date(),
            lastErrorCode: 'LEDGER_PREPARE_COUNT_MISMATCH',
          },
        });
        const failed = await tx.ledgerPostingBatch.update({
          where: { id: batch.id },
          data: {
            statusCode: 'failed',
            failedAt: new Date(),
            failureCount: { increment: 1 },
            version: { increment: 1 },
          },
          select: { statusCode: true, preparedCount: true, totalCount: true },
        });
        return {
          jobId,
          postingBatchId: batch.id,
          batchStatus: failed.statusCode,
          preparedCount: failed.preparedCount,
          totalCount: failed.totalCount,
          baselineJsonHash: null,
        };
      }

      const baseline = readBaselineFromPayload(job.payload);
      const baselineJsonHash = ledgerBaselineDigest(baseline);
      const now = new Date();

      await tx.activityBatchJob.update({
        where: { id: jobId },
        data: { statusCode: 'succeeded', completedAt: now, lastErrorCode: null },
      });
      const ready = await tx.ledgerPostingBatch.update({
        where: { id: batch.id },
        data: {
          statusCode: 'ready',
          preparedAt: now,
          baselineJsonHash,
          version: { increment: 1 },
        },
        select: { statusCode: true, preparedCount: true, totalCount: true },
      });

      return {
        jobId,
        postingBatchId: batch.id,
        batchStatus: ready.statusCode,
        preparedCount: ready.preparedCount,
        totalCount: ready.totalCount,
        baselineJsonHash,
      };
    });
  }

  // ===== 读写细节 ==========================================================

  private async lockBatch(
    tx: PrismaTx,
    postingBatchId: string,
  ): Promise<{
    id: string;
    statusCode: string;
    settlementVersionId: string;
    settlementRunId: string;
    activityId: string;
    requestHash: string | null;
    preparedCount: number;
    totalCount: number;
    baselineJsonHash: string | null;
  }> {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        statusCode: string;
        settlementVersionId: string;
        settlementRunId: string;
        activityId: string;
        requestHash: string | null;
        preparedCount: number;
        totalCount: number;
        baselineJsonHash: string | null;
      }>
    >`
      SELECT b.id, b."statusCode", b."settlementVersionId", b."settlementRunId",
             r."activityId", b."requestHash", b."preparedCount", b."totalCount",
             b."baselineJsonHash"
      FROM "LedgerPostingBatch" b
      JOIN "AttendanceSettlementRun" r ON r.id = b."settlementRunId"
      WHERE b.id = ${postingBatchId}
      FOR UPDATE OF b
    `;
    const row = rows[0];
    if (row === undefined) throw new BizException(BizCode.LEDGER_PREPARE_BATCH_STATUS_INVALID);
    return row;
  }

  private async lockJob(
    tx: PrismaTx,
    jobId: string,
  ): Promise<{
    id: string;
    postingBatchId: string | null;
    payload: Prisma.JsonValue;
    leaseOwner: string | null;
    leaseGeneration: number;
  }> {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        postingBatchId: string | null;
        payload: Prisma.JsonValue;
        leaseOwner: string | null;
        leaseGeneration: number;
      }>
    >`
      SELECT id, "postingBatchId", payload, "leaseOwner", "leaseGeneration"
      FROM "ActivityBatchJob"
      WHERE id = ${jobId}
      FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined) throw new BizException(BizCode.LEDGER_PREPARE_BATCH_STATUS_INVALID);
    return row;
  }

  private async lockItem(
    tx: PrismaTx,
    itemId: string,
  ): Promise<{ id: string; jobId: string; itemKey: string; statusCode: string }> {
    const rows = await tx.$queryRaw<
      Array<{ id: string; jobId: string; itemKey: string; statusCode: string }>
    >`
      SELECT id, "jobId", "itemKey", "statusCode"
      FROM "ActivityBatchJobItem"
      WHERE id = ${itemId}
      FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined) throw new BizException(BizCode.LEDGER_PREPARE_BATCH_STATUS_INVALID);
    return row;
  }

  /**
   * 本版本涉及的 distinct memberId,**升序**。
   *
   * 块的划分完全由这个顺序 + 块索引决定,所以它必须是确定性的 ——
   * `ORDER BY` 写在 SQL 里,不靠 JS 侧再排一次。
   */
  private async readVersionMemberIds(tx: PrismaTx, settlementVersionId: string): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ memberId: string }>>`
      SELECT DISTINCT i."memberId"
      FROM "ParticipantSettlementResultRevision" rr
      JOIN "ActivityParticipationIdentity" i ON i.id = rr."participationIdentityId"
      WHERE rr."settlementVersionId" = ${settlementVersionId}
      ORDER BY i."memberId" ASC
    `;
    return rows.map((row) => row.memberId);
  }

  private async readResultRevisions(
    tx: PrismaTx,
    settlementVersionId: string,
    memberIds: readonly string[],
  ): Promise<ResultRevisionRow[]> {
    if (memberIds.length === 0) return [];
    return await tx.participantSettlementResultRevision.findMany({
      where: { settlementVersionId, identity: { memberId: { in: [...memberIds] } } },
      select: {
        id: true,
        statusCode: true,
        recognizedServiceHours: true,
        recognizedContributionPoints: true,
        participationIdentityId: true,
        identity: { select: { memberId: true, sessionId: true, activityId: true } },
      },
      // 稳定序:同一份数据必须得到同一份分录写入顺序。
      orderBy: { id: 'asc' },
    });
  }

  /** 参与日拆分权重的服务段:非 superseded、非 voided/replaced、且**已闭合**。 */
  private async readWeightBearingSpans(
    tx: PrismaTx,
    identityIds: readonly string[],
  ): Promise<Map<string, Array<{ startAt: Date; endAt: Date | null }>>> {
    const byIdentity = new Map<string, Array<{ startAt: Date; endAt: Date | null }>>();
    if (identityIds.length === 0) return byIdentity;
    const rows = await tx.participantServiceSegmentRevision.findMany({
      where: {
        participationIdentityId: { in: [...identityIds] },
        statusCode: { not: 'superseded' },
        resultCode: { in: WEIGHT_BEARING_SEGMENT_RESULT_CODES },
      },
      select: { participationIdentityId: true, checkInAt: true, checkOutAt: true },
      orderBy: [{ checkInAt: 'asc' }, { id: 'asc' }],
    });
    for (const row of rows) {
      const span = { startAt: row.checkInAt, endAt: row.checkOutAt };
      const bucket = byIdentity.get(row.participationIdentityId);
      if (bucket === undefined) byIdentity.set(row.participationIdentityId, [span]);
      else bucket.push(span);
    }
    return byIdentity;
  }

  /**
   * §5.12 ④:读取每个 (member, ledgerDate) 的**基线** —— day-state 版本与已 committed 日合计。
   *
   * ⚠️ 行不存在时记 `0:0`(虚拟的"零版本零合计"行)。这与"真有一行 version=0 且
   *    合计 0"在语义上完全等价:day-state 的 version 只由 `commitBatch` 递增,
   *    version=0 就意味着还没有任何批次在这一天记过账。
   */
  private async readDayStateBaseline(
    tx: PrismaTx,
    rows: readonly PreparedDayRow[],
  ): Promise<Map<string, { version: number; creditedHundredths: number }>> {
    const baseline = new Map<string, { version: number; creditedHundredths: number }>();
    const pairs = uniquePairs(rows);
    if (pairs.length === 0) return baseline;

    const existing = await tx.$queryRaw<
      Array<{ memberId: string; ledgerDate: string; version: number; credited: string }>
    >`
      SELECT d."memberId", to_char(d."ledgerDate", 'YYYY-MM-DD') AS "ledgerDate",
             d.version, d."committedCreditedPoints"::text AS credited
      FROM "MemberContributionDayState" d
      JOIN unnest(${pairs.map((pair) => pair.memberId)}::text[], ${pairs.map((pair) => pair.ledgerDate)}::text[])
        AS t(member_id, ledger_date)
        ON d."memberId" = t.member_id AND d."ledgerDate" = t.ledger_date::date
    `;
    const found = new Map(
      existing.map((row) => [
        ledgerBaselineKey(row.memberId, row.ledgerDate),
        { version: row.version, creditedHundredths: decimalToHundredths(row.credited) },
      ]),
    );
    for (const pair of pairs) {
      const key = ledgerBaselineKey(pair.memberId, pair.ledgerDate);
      baseline.set(key, found.get(key) ?? { version: 0, creditedHundredths: 0 });
    }
    return baseline;
  }

  /**
   * §5.12 ⑤:同一 (member, ledgerDate) 内按稳定服务顺序分配日上限。
   *
   * **就地改写** `splitRows` 的 credited / cappedOut 两列(其余列不动)。
   */
  private applyDailyCap(
    rows: PreparedDayRow[],
    baseline: ReadonlyMap<string, { version: number; creditedHundredths: number }>,
  ): void {
    const byMemberDate = new Map<string, PreparedDayRow[]>();
    for (const row of rows) {
      const key = ledgerBaselineKey(row.memberId, row.ledgerDate);
      const bucket = byMemberDate.get(key);
      if (bucket === undefined) byMemberDate.set(key, [row]);
      else bucket.push(row);
    }
    for (const [key, bucket] of byMemberDate) {
      const prior = baseline.get(key)?.creditedHundredths ?? 0;
      const allocations = allocateDailyCredit(bucket, fromHundredths(prior));
      bucket.forEach((row, index) => {
        row.creditedPoints = allocations[index].creditedPoints;
        row.cappedOutPoints = allocations[index].cappedOutPoints;
      });
    }
  }

  /**
   * §3.21 `ParticipantSettlementDay` 落库。
   *
   * 🔴 **bind 参数恒为列数**(第 0 批实测 Prisma 上限 32767;逐行 `VALUES` 每人 4 参数
   *    在 8191 人处确定性失败)⇒ 一律 `unnest(...)`,与人数无关。
   *    数组元素**全部按 text 传**再在 SQL 里 `::date` / `::numeric` / `::timestamptz`,
   *    免得驱动对日期/小数的类型推断在不同版本上漂。
   *
   * §3.21 明写本表「preparing 阶段可重算」⇒ 冲突时 DO UPDATE(与分录的 append-only 相反)。
   */
  private async writeSettlementDays(
    tx: PrismaTx,
    rows: readonly PreparedDayRow[],
  ): Promise<number> {
    if (rows.length === 0) return 0;
    await tx.$executeRaw`
      INSERT INTO "ParticipantSettlementDay" (
        "id", "createdAt", "updatedAt", "resultRevisionId", "memberId", "ledgerDate",
        "serviceHours", "recognizedPoints", "creditedPoints", "cappedOutPoints",
        "sequenceStartAt", "stableOrderKey"
      )
      SELECT gen_random_uuid()::text, NOW(), NOW(),
             t.result_revision_id, t.member_id, t.ledger_date::date,
             t.service_hours::numeric, t.recognized_points::numeric,
             t.credited_points::numeric, t.capped_out_points::numeric,
             t.sequence_start_at::timestamptz, t.stable_order_key
      FROM unnest(
        ${rows.map((row) => row.resultRevisionId)}::text[],
        ${rows.map((row) => row.memberId)}::text[],
        ${rows.map((row) => row.ledgerDate)}::text[],
        ${rows.map((row) => row.serviceHours.toFixed(2))}::text[],
        ${rows.map((row) => row.recognizedPoints.toFixed(2))}::text[],
        ${rows.map((row) => row.creditedPoints.toFixed(2))}::text[],
        ${rows.map((row) => row.cappedOutPoints.toFixed(2))}::text[],
        ${rows.map((row) => row.sequenceStartAt.toISOString())}::text[],
        ${rows.map((row) => row.stableOrderKey)}::text[]
      ) AS t(result_revision_id, member_id, ledger_date, service_hours, recognized_points,
             credited_points, capped_out_points, sequence_start_at, stable_order_key)
      ON CONFLICT ("resultRevisionId", "ledgerDate") DO UPDATE SET
        "serviceHours" = EXCLUDED."serviceHours",
        "recognizedPoints" = EXCLUDED."recognizedPoints",
        "creditedPoints" = EXCLUDED."creditedPoints",
        "cappedOutPoints" = EXCLUDED."cappedOutPoints",
        "sequenceStartAt" = EXCLUDED."sequenceStartAt",
        "stableOrderKey" = EXCLUDED."stableOrderKey",
        "updatedAt" = NOW()
    `;
    return rows.length;
  }

  /**
   * §5.12 ⑥ + §3.23:写 preparing 分录。
   *
   * 每个 (resultRevision, ledgerDate) 写**两条**——`service_credit` 与 `contribution_credit`。
   * 这是 §3.23 的形状要求(unique 键里带 `entryTypeCode`,四值闭集把两类分开),
   * 不是本刀的发明:时长与贡献值在冲回时可以各自独立地被冲,合成一条就冲不动了。
   *
   * 🔴 DB 上三条 CHECK 与本函数逐条对应,写歪当场 23514 而不是静默入库:
   *    - `..._balance_check`  :贡献分录必须 recognized = credited + cappedOut;
   *    - `..._sign_check`     :credit 分录四个 delta 全 ≥ 0;
   *    - `..._magnitude_check`:|时长| ≤ 24、|credited| ≤ 3。
   *
   * 幂等:`entryKey` / `operationKey` 都由内容确定且是**单列** unique
   * ⇒ `ON CONFLICT DO NOTHING`(不指定冲突目标 —— 两个 unique 任一命中都算重放)。
   */
  private async writeLedgerEntries(
    tx: PrismaTx,
    batch: { id: string; requestHash: string | null; activityId: string },
    dayRows: readonly PreparedDayRow[],
  ): Promise<number> {
    const entries = dayRows.flatMap((row) => [
      {
        ...row,
        entryTypeCode: 'service_credit',
        serviceHoursDelta: row.serviceHours,
        recognizedPointsDelta: 0,
        creditedPointsDelta: 0,
        cappedOutPointsDelta: 0,
      },
      {
        ...row,
        entryTypeCode: 'contribution_credit',
        serviceHoursDelta: 0,
        recognizedPointsDelta: row.recognizedPoints,
        creditedPointsDelta: row.creditedPoints,
        cappedOutPointsDelta: row.cappedOutPoints,
      },
    ]);
    if (entries.length === 0) return 0;

    const entryKeys = entries.map(
      (entry) => `${batch.id}:${entry.resultRevisionId}:${entry.ledgerDate}:${entry.entryTypeCode}`,
    );
    const inserted = await tx.$executeRaw`
      INSERT INTO "ParticipationLedgerEntry" (
        "id", "createdAt", "postingBatchId", "entryKey", "operationKey", "requestHash",
        "memberId", "activityId", "sessionId", "participationIdentityId", "resultRevisionId",
        "ledgerDate", "entryTypeCode",
        "serviceHoursDelta", "recognizedPointsDelta", "creditedPointsDelta", "cappedOutPointsDelta"
      )
      SELECT gen_random_uuid()::text, NOW(), ${batch.id}, t.entry_key,
             'ledger-prepare:' || t.entry_key, ${batch.requestHash},
             t.member_id, ${batch.activityId}, t.session_id, t.identity_id,
             t.result_revision_id, t.ledger_date::date, t.entry_type,
             t.service_hours::numeric, t.recognized_points::numeric,
             t.credited_points::numeric, t.capped_out_points::numeric
      FROM unnest(
        ${entryKeys}::text[],
        ${entries.map((entry) => entry.memberId)}::text[],
        ${entries.map((entry) => entry.sessionId)}::text[],
        ${entries.map((entry) => entry.participationIdentityId)}::text[],
        ${entries.map((entry) => entry.resultRevisionId)}::text[],
        ${entries.map((entry) => entry.ledgerDate)}::text[],
        ${entries.map((entry) => entry.entryTypeCode)}::text[],
        ${entries.map((entry) => entry.serviceHoursDelta.toFixed(2))}::text[],
        ${entries.map((entry) => entry.recognizedPointsDelta.toFixed(2))}::text[],
        ${entries.map((entry) => entry.creditedPointsDelta.toFixed(2))}::text[],
        ${entries.map((entry) => entry.cappedOutPointsDelta.toFixed(2))}::text[]
      ) AS t(entry_key, member_id, session_id, identity_id, result_revision_id, ledger_date,
             entry_type, service_hours, recognized_points, credited_points, capped_out_points)
      ON CONFLICT DO NOTHING
    `;
    return inserted;
  }

  private async mergeBaselineIntoJob(
    tx: PrismaTx,
    job: { id: string; payload: Prisma.JsonValue },
    chunkBaseline: ReadonlyMap<string, { version: number; creditedHundredths: number }>,
  ): Promise<void> {
    const merged: LedgerDayStateBaseline = { ...readBaselineFromPayload(job.payload) };
    for (const [key, value] of chunkBaseline) {
      merged[key] = ledgerBaselineValue(value.version, value.creditedHundredths);
    }
    // 逐键重建而不是直接 spread:`Prisma.JsonValue` 允许 null,而 `InputJsonValue` 不允许。
    const payload: Record<string, Prisma.InputJsonValue> = {};
    if (isJsonObject(job.payload)) {
      for (const [key, value] of Object.entries(job.payload)) {
        if (value !== null && value !== undefined) payload[key] = value;
      }
    }
    payload[LEDGER_BASELINE_PAYLOAD_KEY] = merged;
    await tx.activityBatchJob.update({ where: { id: job.id }, data: { payload } });
  }
}

// ===== 纯辅助 =============================================================

function chunkItemKey(index: number): string {
  return `chunk-${String(index).padStart(6, '0')}`;
}

function chunkIndexOf(itemKey: string): number {
  const parsed = Number.parseInt(itemKey.slice('chunk-'.length), 10);
  if (!itemKey.startsWith('chunk-') || Number.isNaN(parsed) || parsed < 0) {
    throw new BizException(BizCode.LEDGER_PREPARE_BATCH_STATUS_INVALID);
  }
  return parsed;
}

function requireBatchId(postingBatchId: string | null): string {
  // `settlement_prepare` 任务必然带批次指针;没有则这条任务本身是坏的。
  if (postingBatchId === null) throw new BizException(BizCode.LEDGER_PREPARE_BATCH_STATUS_INVALID);
  return postingBatchId;
}

function toPreparedDayRow(revision: ResultRevisionRow, row: LedgerDaySplitRow): PreparedDayRow {
  return {
    resultRevisionId: revision.id,
    memberId: revision.identity.memberId,
    sessionId: revision.identity.sessionId,
    participationIdentityId: revision.participationIdentityId,
    ledgerDate: toDateOnlyText(row.ledgerDate),
    serviceHours: row.serviceHours,
    recognizedPoints: row.recognizedPoints,
    // 下面两列在 `applyDailyCap` 里就地覆盖 —— 先写 0 是**不可能被误当结果用**的初值:
    // 若哪天有人删掉那一步,分录会全部记 0 分,e2e 立刻红(不会静默记成全额)。
    creditedPoints: 0,
    cappedOutPoints: 0,
    sequenceStartAt: row.sequenceStartAt,
    stableOrderKey: row.stableOrderKey,
  };
}

/** `Date`(UTC 午夜)→ `YYYY-MM-DD`。**不做本地化格式化**(§3.21 明禁散落的时间字符串切割)。 */
export function toDateOnlyText(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function uniquePairs(
  rows: readonly PreparedDayRow[],
): Array<{ memberId: string; ledgerDate: string }> {
  const seen = new Map<string, { memberId: string; ledgerDate: string }>();
  for (const row of rows) {
    seen.set(ledgerBaselineKey(row.memberId, row.ledgerDate), {
      memberId: row.memberId,
      ledgerDate: row.ledgerDate,
    });
  }
  return [...seen.values()].sort(
    (a, b) => a.memberId.localeCompare(b.memberId) || a.ledgerDate.localeCompare(b.ledgerDate),
  );
}

function isJsonObject(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readBaselineFromPayload(payload: Prisma.JsonValue): LedgerDayStateBaseline {
  if (!isJsonObject(payload)) return {};
  const raw = payload[LEDGER_BASELINE_PAYLOAD_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const result: LedgerDayStateBaseline = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}
