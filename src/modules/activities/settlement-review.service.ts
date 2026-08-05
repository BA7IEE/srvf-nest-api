import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { SettlementNotificationProducer } from './settlement-notification-producer';
import { SettlementReviewAuditRecorder } from './settlement-review-audit-recorder';
import {
  compareSettlementReviewSnapshot,
  type SettlementReviewExpectation,
  type SettlementReviewMismatch,
} from './settlement-review-comparison';
import {
  evaluateSettlementReviewSeparation,
  type SettlementReviewSeparationViolation,
  type SettlementReviewStage,
} from './settlement-review-separation';

// ===== 活动改造 v1.1 第 2 批第四刀:一审 / 终审(合同 §5.11 + §3.19)=====
//
// 🔴 **这一刀决定"谁有资格说这份结算算数"。** 隔离漏一条,自提自审就成立;
//    并发漏一条,同一版本会有两个互相矛盾的生效决定。故本文件每一处判据都走
//    **拒绝**,没有一处走"警告后放行"。宁可多拒,不可少拒。
//
// ## 锁序(§10.1;与前三刀逐字同序,不得倒置)
//
// ① `Activity` `FOR UPDATE` → ② `AttendanceSettlementRun` `FOR UPDATE`
// → ③ `AttendanceSettlementVersion` `FOR UPDATE`。
//
// 第三把是本刀新加的,因为本刀的并发单位是**版本**:§5.11 明写「与 approve 并发
// 通过 SettlementVersion／Batch row lock 只能一个成功」。
//
// ❌ **不取 member advisory lock**:本刀仍不写任何队员维度的事实(账本分录、日上限
//    归第五刀 commit),取了只会凭空多一条死锁边(沿 concurrency-review-m1-m6 的判断)。
//
// ## 🔴 终审 approve **不把 run 标 `posted`**(本刀红线)
//
// §5.11 逐字:「approve 只创建／恢复 LedgerPostingBatch 准备,**不立即把 run 标
// posted**」。run 走到 `posted` 是**第五刀 `commitBatch` 成功之后**的事(§5.13 ⑦)。
// 本刀把 run 推到 `posting`(§3.19 九值闭集里"正在入账"的那一格),批次留在
// `preparing` —— 账还没记,不能宣布记完了。
//
// ⇒ 判据在 `activity-settlement-review.e2e-spec.ts`:终审通过后断言
//    `run.statusCode === 'posting'`、`batch.statusCode === 'preparing'`、
//    `batch.committedAt === null`、且 `ParticipationLedgerEntry` 零行。
//
// ## 判据的分层(为什么校验顺序是这个)
//
//   ④ 幂等(operationKey)—— 必须**排在所有状态闸之前**。重放请求打过来时,run 早已
//      被第一次审核推走了;先判状态会把一次合法重放判成非法(第三刀同一处置)。
//   ⑤ 一版本一阶段一个生效决定 —— 排在 run 状态闸**之前**。ReviewAction 行是**事实**,
//      run.statusCode 只是**投影**(§3.19 原话「是页面投影和流程根」)。并发败者因此
//      恒收 20072(而不是"运气好收 20072、运气差收 20065"),错误面才是确定的。
//   ⑥⑦ run / version 状态闸。
//   ⑧ **三方分离(锁后复判)** —— 见 `settlement-review-separation.ts` 文件头。
//   ⑨ 四项比对 —— 见 `settlement-review-comparison.ts` 文件头。
//
// ## 本刀不做的事
//
// ❌ 零端点 / 零 DTO / 零权限码(整条结算流程的对外入口统一留到第 2 批收尾);判权在调用方。
//    ⇒ 三方分离的**入口层**(`ActionConstraint`)因此无处注册,留到开端点那一刀 ——
//      这是**显式偏离**,见 `settlement-review-separation.ts` 与报告。
// ❌ 零 schema 变更;❌ 零 Punch 写路径;❌ 不重算 contentHash(只比对)。
// ❌ 不 update / 不软删 `SettlementReviewAction`(append-only,表上本就没有 updatedAt)。

type PrismaTx = Prisma.TransactionClient;

export type SettlementReviewActionCode = 'approve' | 'return';

export interface SettlementReviewInput {
  activityId: string;
  /** §5.11「只允许 approve 或 return」——**第三种动作不存在**。 */
  actionCode: SettlementReviewActionCode;
  /** §3.19 `SettlementReviewAction.operationKey`(DB 上单列 unique)。 */
  operationKey: string;
  /** 与 `operationKey` 成对,决定"是重放还是撞键"。 */
  requestHash: string;
  /** 审核备注(可选);退回时缺省取 `returnReason`,免得 append-only 的动作行说不清原因。 */
  note?: string | null;
  /** §5.11「return 写原因」。approve 时忽略;return 时必填(空白也算没填)。 */
  returnReason?: string | null;
  /** 审核人看到的那一版。四项比对的 `expected` 侧,见 comparison 文件头。 */
  expectation: SettlementReviewExpectation;
}

export interface SettlementReviewResult {
  activityId: string;
  settlementRunId: string;
  settlementVersionId: string;
  settlementVersion: number;
  stageCode: SettlementReviewStage;
  actionCode: SettlementReviewActionCode;
  reviewActionId: string;
  runStatusBefore: string;
  runStatusAfter: string;
  versionStatusAfter: string;
  /** 终审通过时创建/恢复的账本批次;其余情形恒 null。 */
  ledgerPostingBatchId: string | null;
  /** 🔴 恒不为 `committed` —— 本刀只做准备,入账是第五刀。 */
  ledgerPostingBatchStatus: string | null;
  /** true = 同 key 同 payload 的重放,没有产生第二条决定。 */
  replayed: boolean;
}

interface LockedActivity {
  title: string;
  workflowRevision: number;
}

interface LockedRun {
  id: string;
  statusCode: string;
  currentSubmittedVersion: number | null;
}

interface LockedVersion {
  id: string;
  version: number;
  statusCode: string;
  createdByUserId: string | null;
  evidenceSealId: string;
  evidenceRevision: number;
  populationRevision: number;
  workflowRevision: number;
  contentHash: string;
  personCount: number;
}

/** 三条分离判据 → 具名码。**一一对应,没有一条落到兜底码上**(那等于没具名)。 */
const SEPARATION_TO_BIZ_CODE: Record<
  SettlementReviewSeparationViolation,
  (typeof BizCode)[keyof typeof BizCode]
> = {
  self_first_review: BizCode.SETTLEMENT_SELF_FIRST_REVIEW_FORBIDDEN,
  self_final_review: BizCode.SETTLEMENT_SELF_FINAL_REVIEW_FORBIDDEN,
  same_reviewer: BizCode.SETTLEMENT_SAME_REVIEWER_FORBIDDEN,
};

/** 四项比对 → 具名码。同上,一一对应。 */
const MISMATCH_TO_BIZ_CODE: Record<
  SettlementReviewMismatch,
  (typeof BizCode)[keyof typeof BizCode]
> = {
  evidence_seal: BizCode.SETTLEMENT_REVIEW_EVIDENCE_SEAL_STALE,
  evidence_population_revision: BizCode.SETTLEMENT_REVIEW_EVIDENCE_REVISION_CHANGED,
  workflow_revision: BizCode.SETTLEMENT_REVIEW_WORKFLOW_REVISION_CHANGED,
  content_hash: BizCode.SETTLEMENT_REVIEW_CONTENT_HASH_CHANGED,
};

/** 各阶段唯一合法的 run 前置状态(§4.7 的链)。 */
const REQUIRED_RUN_STATUS: Record<SettlementReviewStage, string> = {
  first: 'pending_first_review',
  final: 'pending_final_review',
};

/**
 * 审核事务的显式预算。
 *
 * 本刀的事务里**没有一步与人数相关**(全是单行读写 + 几条聚合计数),所以不需要
 * 第三刀那样的 120s。取 15s 是因为它要在**并发排队**下跑得完:两条审核撞同一版本时,
 * 后到者要先等前者走完整个事务。Prisma 默认 5s 里还包含等锁时间,压测边缘会假红。
 */
export const SETTLEMENT_REVIEW_TX_TIMEOUT_MS = 15_000;

@Injectable()
export class SettlementReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: SettlementReviewAuditRecorder,
    private readonly notifications: SettlementNotificationProducer,
  ) {}

  /** §5.11 一审。approve ⇒ 推进 `pending_final_review`;return ⇒ 版本转 `returned`。 */
  async firstReview(
    input: SettlementReviewInput,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<SettlementReviewResult> {
    return await this.review('first', input, currentUser, auditMeta);
  }

  /**
   * §5.11 终审。
   *
   * 🔴 approve **只创建／恢复 `LedgerPostingBatch` 准备**,run 推到 `posting`,
   *    **不标 `posted`** —— 那是第五刀 `commitBatch` 之后的事。
   */
  async finalReview(
    input: SettlementReviewInput,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<SettlementReviewResult> {
    return await this.review('final', input, currentUser, auditMeta);
  }

  // ===== ① Activity FOR UPDATE(锁序第一层)=====
  private async lockActivity(tx: PrismaTx, activityId: string): Promise<LockedActivity> {
    const rows = await tx.$queryRaw<Array<LockedActivity>>`
      SELECT title, "workflowRevision"
      FROM "Activity"
      WHERE id = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return row;
  }

  // ===== ② AttendanceSettlementRun FOR UPDATE(锁序第二层)=====
  //
  // ⚠️ **只加锁、不判状态**:状态闸必须排在幂等判定之后(见 `review` 里的注释)。
  private async lockRun(tx: PrismaTx, activityId: string): Promise<LockedRun> {
    const rows = await tx.$queryRaw<Array<LockedRun>>`
      SELECT id, "statusCode", "currentSubmittedVersion"
      FROM "AttendanceSettlementRun"
      WHERE "activityId" = ${activityId}
      FOR UPDATE
    `;
    const run = rows[0];
    // 连 run 行都没有 ⇒ 从来没生成过草稿,没有任何可审核的东西。
    if (run === undefined) throw new BizException(BizCode.SETTLEMENT_REVIEW_RUN_STATUS_INVALID);
    return run;
  }

  // ===== ③ AttendanceSettlementVersion FOR UPDATE(锁序第三层;本刀的并发单位)=====
  //
  // §5.11「与 approve 并发通过 SettlementVersion／Batch row lock 只能一个成功」——
  // 就是这一把。它把同一版本上的一切审核动作串行化,⑤ 的"锁后再查一次已有决定"
  // 才是可靠的(否则两条并发都会读到"还没有决定")。
  private async lockSubmittedVersion(tx: PrismaTx, run: LockedRun): Promise<LockedVersion> {
    // run 指针没有指向任何提交版本 ⇒ 没有审核对象。
    if (run.currentSubmittedVersion === null) {
      throw new BizException(BizCode.SETTLEMENT_REVIEW_VERSION_MISSING);
    }
    const rows = await tx.$queryRaw<Array<LockedVersion>>`
      SELECT
        id, version, "statusCode", "createdByUserId",
        "evidenceSealId", "evidenceRevision", "populationRevision", "workflowRevision",
        "contentHash", "personCount"
      FROM "AttendanceSettlementVersion"
      WHERE "settlementRunId" = ${run.id} AND version = ${run.currentSubmittedVersion}
      FOR UPDATE
    `;
    const version = rows[0];
    if (version === undefined) {
      throw new BizException(BizCode.SETTLEMENT_REVIEW_VERSION_MISSING);
    }
    return version;
  }

  // ===== ④ 幂等:`operationKey + requestHash` =====
  //
  // `SettlementReviewAction.operationKey` 在 DB 上**是单列 unique**(§3.19 点名),
  // 所以这里"先查后写"有唯一约束兜底;P2002 在 `createReviewAction` 里也翻成同一个码。
  //
  // ⚠️ 查询**不按版本/阶段收窄**:同一个 operationKey 被用在**另一个版本或另一阶段**
  //    上,同样算撞键(与第三刀同一立场 —— 复合收窄恰好放行"同 key 不同 payload")。
  private async resolveIdempotency(
    tx: PrismaTx,
    input: {
      settlementVersionId: string;
      stageCode: SettlementReviewStage;
      actionCode: SettlementReviewActionCode;
      operationKey: string;
      requestHash: string;
    },
  ): Promise<{ id: string; actedAt: Date } | null> {
    const existing = await tx.settlementReviewAction.findUnique({
      where: { operationKey: input.operationKey },
      select: {
        id: true,
        actedAt: true,
        settlementVersionId: true,
        stageCode: true,
        actionCode: true,
        requestHash: true,
      },
    });
    if (existing === null) return null;
    if (
      existing.settlementVersionId !== input.settlementVersionId ||
      existing.stageCode !== input.stageCode ||
      existing.actionCode !== input.actionCode ||
      existing.requestHash !== input.requestHash
    ) {
      throw new BizException(BizCode.SETTLEMENT_REVIEW_OPERATION_KEY_CONFLICT);
    }
    return { id: existing.id, actedAt: existing.actedAt };
  }

  // ===== ⑤ §3.19「一版本一阶段只允许一个生效决定」=====
  //
  // ⚠️ DB 上**没有** `(settlementVersionId, stageCode)` 唯一 —— §3.19 只给 operationKey
  //    点了 unique。正确性来自 ③ 的版本行锁把并发串行化之后的这一次重查。
  private async assertNoEffectiveDecision(
    tx: PrismaTx,
    settlementVersionId: string,
    stageCode: SettlementReviewStage,
  ): Promise<void> {
    const decided = await tx.settlementReviewAction.findFirst({
      where: { settlementVersionId, stageCode },
      select: { id: true },
    });
    if (decided !== null) throw new BizException(BizCode.SETTLEMENT_REVIEW_ALREADY_DECIDED);
  }

  /** 本版本一审阶段的操作人(尚未一审时 null)。**三方分离第 ③ 条的事实源**。 */
  private async readFirstReviewerUserId(
    tx: PrismaTx,
    settlementVersionId: string,
  ): Promise<string | null> {
    const first = await tx.settlementReviewAction.findFirst({
      where: { settlementVersionId, stageCode: 'first' },
      orderBy: { actedAt: 'asc' },
      select: { actorUserId: true },
    });
    return first?.actorUserId ?? null;
  }

  /** 四项比对的 `live` 侧:当前 active seal + 当前证据/人口版本 + 当前流程版本。 */
  private async readLiveFacts(
    tx: PrismaTx,
    activityId: string,
    workflowRevision: number,
  ): Promise<{
    activeEvidenceSealId: string | null;
    evidenceRevision: number;
    populationRevision: number;
    workflowRevision: number;
  }> {
    const seal = await tx.evidenceSeal.findFirst({
      where: { activityId, statusCode: 'active' },
      orderBy: { sealRevision: 'desc' },
      select: { id: true },
    });
    // 真源与前三刀一致:evidence / population 在 `ActivityEvidenceState`(行不存在 = 0/0),
    // workflow 在**已加锁的** Activity 行上。
    const state = await tx.activityEvidenceState.findUnique({
      where: { activityId },
      select: { evidenceRevision: true, populationRevision: true },
    });
    return {
      activeEvidenceSealId: seal?.id ?? null,
      evidenceRevision: state?.evidenceRevision ?? 0,
      populationRevision: state?.populationRevision ?? 0,
      workflowRevision,
    };
  }

  /** 活动当前 active owner 的 memberId(通知收件人;没有则 null)。 */
  private async readOwnerMemberId(tx: PrismaTx, activityId: string): Promise<string | null> {
    const owner = await tx.activityResponsibilityAssignment.findFirst({
      where: { activityId, responsibilityType: 'owner', status: 'active' },
      orderBy: { startedAt: 'desc' },
      select: { memberId: true },
    });
    return owner?.memberId ?? null;
  }

  // ===== 🔴 终审 approve:创建／恢复账本发布批次准备(§5.11 + §3.22)=====
  //
  // **只准备,不入账**:`statusCode='preparing'`、`committedAt=null`、零 LedgerEntry。
  // 分块准备(§5.12)与统一生效(§5.13)都归第五刀。
  //
  // 「恢复」的语义:本版本已有一条**未 committed**的批次时原样复用,不再开第二条 ——
  // §3.22 明写「一个 SettlementVersion 至多一个 committed posting batch」,开第二条
  // 准备批次只会让第五刀面对两份互相矛盾的基线。
  private async prepareLedgerPostingBatch(
    tx: PrismaTx,
    input: {
      settlementRunId: string;
      settlementVersionId: string;
      operationKey: string;
      requestHash: string;
      actorUserId: string;
      totalCount: number;
    },
  ): Promise<{ id: string; statusCode: string }> {
    await this.assertNoCommittedBatch(tx, input.settlementVersionId);

    const restorable = await tx.ledgerPostingBatch.findFirst({
      where: {
        settlementVersionId: input.settlementVersionId,
        statusCode: { in: ['preparing', 'ready'] },
      },
      orderBy: { batchRevision: 'asc' },
      select: { id: true, statusCode: true },
    });
    if (restorable !== null) return restorable;

    // §3.22「batchRevision 同一 run 单调递增」——**按 run 取最大值**,不是按 version。
    const maxRevision = await tx.ledgerPostingBatch.aggregate({
      where: { settlementRunId: input.settlementRunId },
      _max: { batchRevision: true },
    });

    try {
      return await tx.ledgerPostingBatch.create({
        data: {
          settlementRunId: input.settlementRunId,
          settlementVersionId: input.settlementVersionId,
          batchRevision: (maxRevision._max.batchRevision ?? 0) + 1,
          statusCode: 'preparing',
          // requestKey 单列 unique(§3.22)。用审核动作的 operationKey 派生 ⇒
          // 同一次终审无论被重放几次,都只会有一条批次。
          requestKey: `settlement-final-approve:${input.settlementVersionId}:${input.operationKey}`,
          requestHash: input.requestHash,
          totalCount: input.totalCount,
          preparedByUserId: input.actorUserId,
        },
        select: { id: true, statusCode: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BizException(BizCode.SETTLEMENT_REVIEW_OPERATION_KEY_CONFLICT);
      }
      throw error;
    }
  }

  // §5.11「return 只能在 batch 未 committed 前执行」。
  //
  // ⚠️ 诚实说明:在**只有本刀**的世界里,⑤「一版本一阶段一个生效决定」已经先一步挡住了
  //    "终审通过之后又来退回"——所以这条闸的主路径此刻是够不到的,它守的是另外两种
  //    形态:(a) 更正流程(§5.14)给同一版本挂上 committed 批次之后;(b) 第五刀
  //    `commitBatch` 与本刀并发。**是防御位,不是主闸**,报告里逐字列明。
  private async assertNoCommittedBatch(tx: PrismaTx, settlementVersionId: string): Promise<void> {
    const committed = await tx.ledgerPostingBatch.findFirst({
      where: { settlementVersionId, statusCode: 'committed' },
      select: { id: true },
    });
    if (committed !== null) {
      throw new BizException(BizCode.SETTLEMENT_REVIEW_BATCH_ALREADY_COMMITTED);
    }
  }

  // 终审退回时,把本版本上尚未 committed 的批次作废。
  //
  // 不作废会留下一条"挂在已退回版本上的 preparing 批次"—— 第五刀照着它入账,
  // 记的就是一份被退回的账。`voided` 与 `voidedAt` 都是 §3.22 已有的闭集取值/列,
  // 不发明字段。
  private async voidPendingBatches(
    tx: PrismaTx,
    settlementVersionId: string,
    now: Date,
  ): Promise<number> {
    const result = await tx.ledgerPostingBatch.updateMany({
      where: { settlementVersionId, statusCode: { in: ['preparing', 'ready'] } },
      data: { statusCode: 'voided', voidedAt: now, version: { increment: 1 } },
    });
    return result.count;
  }

  // append-only(§3.19):只 create,永不 update / 软删。表上本就没有 `updatedAt`。
  private async createReviewAction(
    tx: PrismaTx,
    input: {
      settlementVersionId: string;
      stageCode: SettlementReviewStage;
      actionCode: SettlementReviewActionCode;
      actorUserId: string;
      actedAt: Date;
      note: string | null;
      operationKey: string;
      requestHash: string;
    },
  ): Promise<{ id: string }> {
    try {
      return await tx.settlementReviewAction.create({
        data: {
          settlementVersionId: input.settlementVersionId,
          stageCode: input.stageCode,
          actionCode: input.actionCode,
          actorUserId: input.actorUserId,
          actedAt: input.actedAt,
          note: input.note,
          operationKey: input.operationKey,
          requestHash: input.requestHash,
        },
        select: { id: true },
      });
    } catch (error) {
      // 本表能撞的唯一约束只有 `operationKey`。持有版本行锁时 ④ 已经查过一次,
      // 所以这条正常不可达 —— 但"Prisma 异常裸奔成 500"是明令禁止的形态,兜底不能省。
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BizException(BizCode.SETTLEMENT_REVIEW_OPERATION_KEY_CONFLICT);
      }
      throw error;
    }
  }

  private async review(
    stageCode: SettlementReviewStage,
    input: SettlementReviewInput,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<SettlementReviewResult> {
    const { activityId, actionCode, operationKey, requestHash } = input;

    // §5.11「只允许 approve 或 return」的**运行期兜底**。类型联合是编译期闸,
    // 但调用方 `as any` 绕过时不得裸奔成未映射 500。
    if (actionCode !== 'approve' && actionCode !== 'return') {
      throw new BizException(BizCode.SETTLEMENT_REVIEW_ACTION_INVALID);
    }
    // §5.11「return 写原因」。空白字符串也算没填。
    const returnReason = (input.returnReason ?? '').trim();
    if (actionCode === 'return' && returnReason.length === 0) {
      throw new BizException(BizCode.SETTLEMENT_REVIEW_RETURN_REASON_REQUIRED);
    }

    return await this.prisma.$transaction(
      async (tx) => {
        // ①②③ 锁序固定 Activity → Run → Version,不得倒置。
        const activity = await this.lockActivity(tx, activityId);
        const run = await this.lockRun(tx, activityId);

        // ④ 幂等**排在所有状态闸之前**:重放打过来时 run 早已被第一次审核推走。
        //    这里要先拿到版本 id 才能判"是不是同一条决定",所以版本行必须先锁上 ——
        //    锁序不变(版本本来就是第三把)。
        const version = await this.lockSubmittedVersion(tx, run);

        const replay = await this.resolveIdempotency(tx, {
          settlementVersionId: version.id,
          stageCode,
          actionCode,
          operationKey,
          requestHash,
        });
        if (replay !== null) {
          const batch = await tx.ledgerPostingBatch.findFirst({
            where: { settlementVersionId: version.id },
            orderBy: { batchRevision: 'desc' },
            select: { id: true, statusCode: true },
          });
          const result: SettlementReviewResult = {
            activityId,
            settlementRunId: run.id,
            settlementVersionId: version.id,
            settlementVersion: version.version,
            stageCode,
            actionCode,
            reviewActionId: replay.id,
            // 重放不改状态 ⇒ 前后同值(取此刻锁后重读的真值,不臆造历史)。
            runStatusBefore: run.statusCode,
            runStatusAfter: run.statusCode,
            versionStatusAfter: version.statusCode,
            ledgerPostingBatchId: batch?.id ?? null,
            ledgerPostingBatchStatus: batch?.statusCode ?? null,
            replayed: true,
          };
          await this.audit.log({
            ...result,
            firstReviewerUserId: await this.readFirstReviewerUserId(tx, version.id),
            contentHash: version.contentHash,
            operationKey,
            requestHash,
            actorUserId: currentUser.id,
            actorRoleSnap: currentUser.role,
            auditMeta,
            tx,
          });
          return result;
        }

        // ⑤ 一版本一阶段一个生效决定(排在 run 状态闸之前 —— 见文件头「判据的分层」)。
        await this.assertNoEffectiveDecision(tx, version.id, stageCode);

        // ⑥ run 状态闸。
        if (run.statusCode !== REQUIRED_RUN_STATUS[stageCode]) {
          throw new BizException(BizCode.SETTLEMENT_REVIEW_RUN_STATUS_INVALID);
        }
        // ⑦ version 状态闸。审核对象必须还是那个"已提交待审"的版本。
        if (version.statusCode !== 'submitted') {
          throw new BizException(BizCode.SETTLEMENT_REVIEW_VERSION_STATUS_INVALID);
        }

        // ⑧ 🔴 三方分离 —— **锁后复判**,事实全部取自本事务内、行锁之后的重读。
        const firstReviewerUserId = await this.readFirstReviewerUserId(tx, version.id);
        const violation = evaluateSettlementReviewSeparation(
          stageCode,
          {
            submittedByUserId: version.createdByUserId,
            firstReviewerUserId,
          },
          currentUser.id,
        );
        if (violation !== null) throw new BizException(SEPARATION_TO_BIZ_CODE[violation]);

        // ⑨ 四项比对(seal / evidence+population revision / workflowRevision / contentHash)。
        //    🔴 contentHash **只比对不重算**。
        const live = await this.readLiveFacts(tx, activityId, activity.workflowRevision);
        const mismatch = compareSettlementReviewSnapshot({
          expected: input.expectation,
          version: {
            evidenceSealId: version.evidenceSealId,
            evidenceRevision: version.evidenceRevision,
            populationRevision: version.populationRevision,
            workflowRevision: version.workflowRevision,
            contentHash: version.contentHash,
          },
          live,
        });
        if (mismatch !== null) throw new BizException(MISMATCH_TO_BIZ_CODE[mismatch]);

        const actedAt = new Date();

        // ⑩ 状态推进 + 批次准备。
        let runStatusAfter: string;
        let versionStatusAfter: string;
        let batch: { id: string; statusCode: string } | null = null;

        if (actionCode === 'approve') {
          if (stageCode === 'first') {
            // §5.11「approve 写 ReviewAction 并推进 pending_final_review」。
            runStatusAfter = 'pending_final_review';
            versionStatusAfter = 'submitted';
          } else {
            // 🔴 §5.11「approve 只创建／恢复 LedgerPostingBatch 准备,**不立即把 run
            //    标 posted**」。run → `posting`(正在入账),批次留 `preparing`。
            batch = await this.prepareLedgerPostingBatch(tx, {
              settlementRunId: run.id,
              settlementVersionId: version.id,
              operationKey,
              requestHash,
              actorUserId: currentUser.id,
              totalCount: version.personCount,
            });
            runStatusAfter = 'posting';
            versionStatusAfter = 'approved';
          }
        } else {
          // §5.11「return 写原因并推进 returned」。`returned` 是**版本**的状态
          // (§3.19 五值闭集里有它);run 的九值闭集里没有 `returned`,只能回
          // `drafting` —— 那正是 §5.10 末句「修改必须从 returned 状态创建新 version」
          // 所需的前置(第二刀重生成草稿、第三刀再提交,都只认 `drafting`)。
          if (stageCode === 'final') {
            // §5.11「return 只能在 batch 未 committed 前执行」。
            await this.assertNoCommittedBatch(tx, version.id);
            // 已退回的版本不能再留着可入账的批次。
            await this.voidPendingBatches(tx, version.id, actedAt);
          }
          runStatusAfter = 'drafting';
          versionStatusAfter = 'returned';
        }

        const reviewAction = await this.createReviewAction(tx, {
          settlementVersionId: version.id,
          stageCode,
          actionCode,
          actorUserId: currentUser.id,
          actedAt,
          // 退回时缺省把原因也落进 append-only 的动作行 —— 否则单看审核流水
          // 说不清为什么退。
          note: input.note ?? (actionCode === 'return' ? returnReason : null),
          operationKey,
          requestHash,
        });

        // 版本行:只写审核结论相关的三列。**append-only 的是 ReviewAction,不是 Version**
        // ——版本的 `statusCode / returnFromStage / returnReason` 本就是 §3.19 给版本行
        // 定义的审核结论列(第三刀提交时写 `submitted`,本刀写审核结果)。
        await tx.attendanceSettlementVersion.update({
          where: { id: version.id },
          data: {
            statusCode: versionStatusAfter,
            returnFromStage: actionCode === 'return' ? stageCode : null,
            returnReason: actionCode === 'return' ? returnReason : null,
          },
        });

        // ⚠️ `currentSubmittedVersion` **退回时也不清空**。这一条写反过一次,是实测
        //    推翻的:清空之后,approve/return 真并发里 return 先赢的那一半,败者会在
        //    ③ 取不到版本行而收 20067(VERSION_MISSING),而不是 ⑤ 的 20072 ——
        //    "一版本一阶段一个生效决定"这条判据就只在一半的交错顺序上说得通,
        //    败者错误面变成掷骰子。
        //
        //    不清空也**不留洞**:§3.19 原话「快速指针,不是真相源」;真正挡住
        //    "拿已退回的版本再审一次"的是 ⑥(run 已回 `drafting`)与 ⑦(版本已是
        //    `returned`)两道闸,而第三刀的下一次提交会把指针整体覆盖。
        await tx.attendanceSettlementRun.update({
          where: { id: run.id },
          data: { statusCode: runStatusAfter, version: { increment: 1 } },
        });

        // ⑪ 通知 intent —— **必须在本事务内**(本仓 Outbox 铁律)。
        await this.notifications.enqueueReviewed(tx, {
          activityId,
          activityTitle: activity.title,
          settlementVersionId: version.id,
          settlementVersion: version.version,
          stageCode,
          actionCode,
          returnReason: actionCode === 'return' ? returnReason : null,
          ownerMemberId: await this.readOwnerMemberId(tx, activityId),
        });

        const result: SettlementReviewResult = {
          activityId,
          settlementRunId: run.id,
          settlementVersionId: version.id,
          settlementVersion: version.version,
          stageCode,
          actionCode,
          reviewActionId: reviewAction.id,
          runStatusBefore: run.statusCode,
          runStatusAfter,
          versionStatusAfter,
          ledgerPostingBatchId: batch?.id ?? null,
          ledgerPostingBatchStatus: batch?.statusCode ?? null,
          replayed: false,
        };

        await this.audit.log({
          ...result,
          firstReviewerUserId,
          contentHash: version.contentHash,
          operationKey,
          requestHash,
          actorUserId: currentUser.id,
          actorRoleSnap: currentUser.role,
          auditMeta,
          tx,
        });

        return result;
      },
      { timeout: SETTLEMENT_REVIEW_TX_TIMEOUT_MS },
    );
  }
}
