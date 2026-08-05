import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { runMemberLinearizedTransaction } from '../../common/prisma/member-advisory-lock.util';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ActivityClosureService, type ActivityClosureOutcome } from './activity-closure.service';
import { CorrectionAuditRecorder } from './correction-audit-recorder';
import {
  parseCorrectionChangeSet,
  type CorrectionChangeSet,
  type CorrectionSegmentChange,
} from './correction-change-set';
import { evaluateCorrectionReviewSeparation } from './correction-review-separation';
import {
  allocateDailyCredit,
  decimalToHundredths,
  fromHundredths,
  splitRecognizedIntoDays,
  type LedgerServiceSpan,
} from './ledger-day-allocation';
import { LedgerPostingService, type LedgerCommitResult } from './ledger-posting.service';
import {
  LEDGER_BASELINE_PAYLOAD_KEY,
  LEDGER_PREPARE_JOB_TYPE,
  ledgerBaselineDigest,
  ledgerBaselineKey,
  ledgerBaselineValue,
  toDateOnlyText,
  type LedgerDayStateBaseline,
} from './ledger-preparation.service';
import {
  computeSettlementContentHash,
  decimalToCanonicalString,
  SETTLEMENT_CONTENT_SCHEMA_VERSION,
  type SettlementContentItem,
} from './settlement-content-hash';

// ===== 活动改造 v1.1 第 2 批第七刀:更正应用(合同 §5.14 + §3.25)=====
//
// 🔴🔴 **更正是全仓唯一能改动"已生效账本"的通路。** 本文件成功返回的那一刻,
//    队员账上的贡献值就换了一份真值。它的失败模式**不是报错,是账悄悄错了**:
//    冲错、冲两次、冲了没补、补了没冲 —— 每一种都会产出一个看起来完全正常的账本,
//    而维护者看不懂代码、发现不了。
//    因此本文件的每一处判定都走**拒绝**,没有一处走"警告后放行"。
//
// ## ⭐ 复用,不另写(goal 背景三条红线)
//
//   ① **第五刀的 commit 协议**(baseline 比对 / day-state CAS / 日合计 0..3 /
//      锁槽预算信号量 / 零部分生效)—— 经 `LedgerPostingService.commitBatchWithin`
//      **原样复用**。本文件里**没有第二套生效路径**:一次 `pg_advisory` 都不取,
//      一行 `MemberContributionDayState` 都不写(判据:e2e 的结构断言)。
//   ② **第六刀的 `ActivityClosureService`** —— §5.14 ⑦ 的重新关账直接调它,不复制。
//   ③ **既有 `lockMembersForWrite`** —— 由 ① 间接使用;本文件不新建 member+date
//      advisory lock(合同 §0.4 死线)。
//
// ## 🔴 对第五刀 `ledger-posting.service.ts` 的改动(仅两处;PR body 单独成段)
//
//   **改动 A ——「按更正场景放宽 `*_reversal` 闸」**(goal 明确授权的那一处):
//     `assertPreparedSetConsistent` 开头加一个分支:批次被某条 `CorrectionApplication`
//     指向 ⇒ 走更正侧配对判据(`correction-posting-shape.ts`,**比原判据更严**);
//     否则**逐字走原判据**。⇒ 普通批次里出现 reversal 仍然 20089
//     (判据:e2e「普通批次仍被拒」那一条)。
//
//   **改动 B ——「把事务体抽成 `commitBatchWithin`」**(⚠️ **超出 goal 的"其余一行不动"**,
//     报告已单列并请维护者点头):
//     §5.14 ⑥ 要求「旧 revisions superseded、新 revisions committed、旧 active closure
//     superseded、`Activity.currentClosureRevision` 清空、correction → applied」
//     **全部同一事务**,而 Prisma 的交互事务**无法从外部加入** —— 先调 `commitBatch`
//     再另开事务做切换,就是把 DoD 7 的原子性拆成两段(中间崩溃 ⇒ 账已生效、
//     旧版本却还挂着 current,读面同时看到两份真值)。
//     三条路里:自己写第二套 commit = goal 禁止;两个事务 = DoD 7 不成立;
//     **把事务体原样抽成方法** = 协议一个字不改、普通路径行为零变化
//     (`commitBatch` 只剩「开事务 + 调它」),更正能在**自己的**事务里逐字复用它。
//     选第三条。判据:第五刀既有 e2e 全绿(行为零变化的正对照)。
//
// ## 锁序(与前六刀同序,只在中间**追加**一把,不得倒置)
//
//   ① `Activity` → ② `AttendanceSettlementRun` → ③ `AttendanceCorrectionRequest`
//   → ④ `AttendanceSettlementVersion` → ⑤ `LedgerPostingBatch`
//   → ⑥ 恒串行闸 → ⑦ `lockMembersForWrite` → ⑧ day-state `FOR UPDATE`
//
// ③ 是本刀新增的**唯一**一把,插在 run 之后、version 之前 —— 它是 run 的子行、
// version 的祖先,插在这里不产生任何反向边。④⑤⑥⑦⑧ 全部由 `commitBatchWithin`
// 按第五刀原样取,本文件一把都不重排。
//
// ## 三段式,以及「准备失败不改变正式页面」(§5.14 末句)靠什么成立
//
//   `submit` → `review` → `prepare` → `commit`(`apply` = 后两步 + 重新关账的组合)
//
// **`prepare` 写的每一行都对正式读面不可见**,逐条:
//   - 新 `AttendanceSettlementVersion`:`run.currentPostedVersion` **仍指向旧版本**;
//   - 新 `ParticipantSettlementResultRevision` / `ParticipantServiceSegmentRevision`:
//     全部 `draft`,而正式读面只认 `committed`;
//   - 新 `ParticipationLedgerEntry`:挂在 `ready` 批次上 —— §3.22 明写未 committed
//     的分录对所有正常读面不可见;
//   - `MemberContributionDayState`:**一行都不写**(那是 commit 的事)。
// ⇒ 准备阶段抛错 ⇒ 整个事务回滚 ⇒ 旧账**一分未动**。
//   判据:e2e 断言旧分录、day-state、active closure、`currentPostedVersion` 逐字未变。
//
// ⚠️ **两处诚实标注**(不是"没影响",是"影响不在正式读面上"):
//   `prepare` 会把 `run.statusCode` 推到 `posting`、把 `run.currentSubmittedVersion`
//   指向新版本。两者都是**工作流指针**,不是正式结算页面的真源
//   (页面读 `currentPostedVersion` / active closure / committed 分录)。
//   推它们是**必须**的:第五刀 `lockVersion` 按 `currentSubmittedVersion` 定位版本、
//   `commitBatch` 只接受 `run.statusCode === 'posting'` —— 不推就复用不了 ①。
//
// ## §3.25「旧记录不更新删除」的**逐字**口径
//
// §3.25 末句是一句话里的两半:「committed 后旧 Result／Segment revision 标为
// **superseded 投影**,新版本成为 current;**旧记录不更新删除**」。
// ⇒ 允许的**唯一**改动就是那个状态投影(`statusCode` → `superseded`,连带 `updatedAt`);
//   业务内容列(结果码、四个金额、标签、时间)与行的存在性**一律不动**。
// 🔴 账本分录更强:`ParticipationLedgerEntry` 上有 append-only trigger(55000)——
//   旧分录在物理上就**不可能**被 UPDATE/DELETE,冲回只能是**另写一条负数分录**。
//   判据:e2e 对旧结果行做逐列比对(除 statusCode/updatedAt 外全等)+ 旧分录整行等值。
//
// ## 本刀不做的事
//
// ❌ 零端点 / 零 DTO / 零权限码(对外入口归第 ⑧ 刀);判权在调用方。
// ❌ 零 schema:39 张表已够用。❌ 零 Punch 写路径;❌ 不新增 cron / Redis / queue。
// ❌ 不删第五刀那道 `*_reversal` 闸(只按场景放宽,普通批次仍被拒)。
// ❌ 不改第六刀 `ActivityClosureService` 一行(只调用)。

type PrismaTx = Prisma.TransactionClient;

/**
 * 准备事务的显式预算。Prisma 默认只有 **5s**,而准备段要读回全部旧分录、算日拆分、
 * 写两套分录 —— bind 参数与人数无关(一律 `unnest`),但**行数**与人数相关。
 * 取值与第三刀 `SETTLEMENT_SUBMIT_TX_TIMEOUT_MS` 同量级:本段只持
 * Activity / run / request 三把行锁,**不碰任何队员维度的锁**(§5.12 首条红线)。
 */
export const CORRECTION_PREPARE_TX_TIMEOUT_MS = 120_000;

/** §3.25 七值闭集里"占住 target"的四个 —— 与 DB partial unique 的谓词逐字一致。 */
const CORRECTION_OPEN_STATUSES = ['pending', 'returned', 'approved', 'applying'];

/** §5.14 ①:只有账已经生效过的 run 才谈得上更正。 */
const CORRECTION_SUBMITTABLE_RUN_STATUSES = ['posted', 'closed', 'correction_open'];

/** §3.25 六值闭集(`attendance_correction_request_type_code_check` 逐字一致)。 */
const CORRECTION_REQUEST_TYPE_CODES = [
  'result',
  'service',
  'time',
  'points',
  'person_identity',
  'other',
];

/** 段的哪些形态**参与**日拆分的权重。与第五刀 `WEIGHT_BEARING_SEGMENT_RESULT_CODES` 同一口径。 */
const WEIGHT_BEARING_SEGMENT_RESULT_CODES = ['valid', 'early_departure_zero'];

export type CorrectionReviewAction = 'approve' | 'return' | 'reject';

const REVIEW_ACTION_TO_STATUS: Record<CorrectionReviewAction, string> = {
  approve: 'approved',
  return: 'returned',
  reject: 'rejected',
};

export interface CorrectionSubmitInput {
  activityId: string;
  /** null = **活动级**更正(§3.25 明标 `?`);有值 = 单人更正。 */
  participationIdentityId: string | null;
  /** result / service / time / points / person_identity / other(§3.25 六值闭集)。 */
  requestTypeCode: string;
  /** 形状见 `correction-change-set.ts`(合同未给字段表,由本刀补齐)。 */
  requestedChangeJson: unknown;
  reason: string;
  attachmentIds?: readonly string[];
  operationKey: string;
  requestHash: string;
}

export interface CorrectionSubmitResult {
  correctionRequestId: string;
  activityId: string;
  settlementRunId: string;
  baseSettlementVersionId: string;
  baseResultRevisionId: string | null;
  baseClosureRevision: number;
  statusCode: string;
  /** true = 同 key 同 payload 的重放,没有产生第二条申请。 */
  replayed: boolean;
}

export interface CorrectionReviewInput {
  correctionRequestId: string;
  actionCode: CorrectionReviewAction;
  note?: string | null;
}

export interface CorrectionReviewed {
  correctionRequestId: string;
  statusCode: string;
  runStatus: string;
  reviewedByUserId: string;
  replayed: boolean;
}

export interface CorrectionBaseDrift {
  /** 申请提交时锚定的基础版本。 */
  baseSettlementVersionId: string;
  /** 此刻真正生效的版本(与上一行不同,正是"基础版本变化"本身)。 */
  currentSettlementVersionId: string | null;
  baseClosureRevision: number;
  currentClosureRevision: number;
}

/**
 * §3.25 末句「审核时基础版本变化则置 voided 并要求新申请」。
 *
 * 🔴 **必须是返回值,不能是抛出**:置 voided 本身是一次**要落库的写**,而抛异常会把
 *    它一起回滚掉 —— 那样申请永远停在 `pending`,下一次审核再判一次、再回滚一次,
 *    「要求新申请」这句话就永远不成立。判别联合让调用方漏判编译不过。
 */
export type CorrectionReviewOutcome =
  | ({ outcome: 'reviewed' } & CorrectionReviewed)
  | ({ outcome: 'voided'; correctionRequestId: string } & CorrectionBaseDrift);

export interface CorrectionApplyInput {
  correctionRequestId: string;
  operationKey: string;
  requestHash: string;
}

export interface CorrectionPrepareResult {
  correctionRequestId: string;
  correctionApplicationId: string;
  activityId: string;
  settlementRunId: string;
  baseSettlementVersionId: string;
  newSettlementVersionId: string;
  newSettlementVersion: number;
  newPostingBatchId: string;
  newResultRevisionIds: string[];
  newSegmentRevisionCount: number;
  /** 冲回分录条数(= 被冲回的旧分录条数)。 */
  reversalEntryCount: number;
  /** 补记分录条数。 */
  replacementEntryCount: number;
  batchStatus: string;
  replayed: boolean;
}

export interface CorrectionCommitResult {
  correctionRequestId: string;
  correctionApplicationId: string;
  activityId: string;
  /** 第五刀 commit 协议的原样读数。 */
  ledger: LedgerCommitResult;
  // ---- §5.14 ⑥ 七项切换的读数(供调用方与 audit 核对)----
  supersededResultRevisionCount: number;
  supersededSegmentRevisionCount: number;
  supersededClosureRevision: number | null;
  activityClosurePointerCleared: boolean;
  correctionStatus: string;
  applicationStatus: string;
  replayed: boolean;
}

export interface CorrectionApplyResult {
  prepare: CorrectionPrepareResult;
  commit: CorrectionCommitResult;
  /** §5.14 ⑦ 重新关账的结论。缺口清单原样带回,**不吞**。 */
  reclose: ActivityClosureOutcome;
}

interface LockedRun {
  id: string;
  statusCode: string;
  currentSubmittedVersion: number | null;
  currentPostedVersion: number | null;
  currentClosureRevision: number | null;
}

interface LockedRequest {
  id: string;
  activityId: string;
  settlementRunId: string;
  participationIdentityId: string | null;
  baseSettlementVersionId: string;
  baseResultRevisionId: string | null;
  baseClosureRevision: number;
  requestedChangeJson: Prisma.JsonValue;
  statusCode: string;
  submittedByUserId: string | null;
  reviewedByUserId: string | null;
  reviewNote: string | null;
  operationKey: string | null;
  requestHash: string | null;
}

interface VersionRow {
  id: string;
  version: number;
  evidenceSealId: string;
  evidenceRevision: number;
  populationRevision: number;
  workflowRevision: number;
  contentHash: string;
  personCount: number;
  sessionParticipationCount: number;
  serviceSegmentCount: number;
  statusCode: string;
}

interface BaseResultRow {
  id: string;
  participationIdentityId: string;
  revision: number;
  resultCode: string;
  lateFlag: boolean;
  earlyLeaveFlag: boolean;
  exceptionFlagsJson: Prisma.JsonValue;
  recognizedServiceHours: Prisma.Decimal;
  recognizedContributionPoints: Prisma.Decimal;
  calculatedServiceHours: Prisma.Decimal;
  calculatedContributionPoints: Prisma.Decimal;
  adjustmentReason: string | null;
  memberId: string;
  sessionId: string;
}

/** 一条新结果行的**目标取值**(基础值叠加变更集之后)。 */
interface ResolvedResult {
  participationIdentityId: string;
  baseResultRevisionId: string;
  baseRevision: number;
  memberId: string;
  sessionId: string;
  resultCode: string;
  lateFlag: boolean;
  earlyLeaveFlag: boolean;
  exceptionFlagsJson: Prisma.JsonValue;
  recognizedServiceHours: number;
  recognizedContributionPoints: number;
  calculatedServiceHours: string;
  calculatedContributionPoints: string;
  adjustmentReason: string | null;
  /** 落库之后回填。 */
  newResultRevisionId: string;
}

interface OriginalEntryRow {
  id: string;
  memberId: string;
  sessionId: string;
  participationIdentityId: string;
  resultRevisionId: string;
  ledgerDate: string;
  entryTypeCode: string;
  serviceHoursDelta: string;
  recognizedPointsDelta: string;
  creditedPointsDelta: string;
  cappedOutPointsDelta: string;
}

interface ReplacementDayRow {
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
export class CorrectionApplicationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerPosting: LedgerPostingService,
    private readonly closure: ActivityClosureService,
    private readonly audit: CorrectionAuditRecorder,
  ) {}

  // =========================================================================
  // §5.14 ① 提交更正
  // =========================================================================
  async submit(
    input: CorrectionSubmitInput,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<CorrectionSubmitResult> {
    if (!CORRECTION_REQUEST_TYPE_CODES.includes(input.requestTypeCode)) {
      throw new BizException(BizCode.CORRECTION_CHANGE_SET_INVALID);
    }
    // 形状校验放在事务**之前**:纯函数、不读库,没有理由占着行锁做。
    const changeSet = parseCorrectionChangeSet(input.requestedChangeJson);

    return await this.prisma.$transaction(async (tx) => {
      const activity = await this.lockActivity(tx, input.activityId);
      const run = await this.lockRun(tx, input.activityId);

      // 🔴 幂等**必须排在状态闸之前**:重放请求打过来时 run 早已被第一次提交推到
      //    `correction_open`,先判状态会把一次合法重放判成非法(与第三/四/六刀同一处置)。
      const replay = await this.findRequestByOperationKey(tx, input);
      if (replay !== null) return { ...toSubmitResult(replay), replayed: true };

      if (!CORRECTION_SUBMITTABLE_RUN_STATUSES.includes(run.statusCode)) {
        throw new BizException(BizCode.CORRECTION_SUBMIT_RUN_STATUS_INVALID);
      }

      // §5.14 ①「保存 base SettlementVersion / ResultRevision / ClosureRevision」。
      const baseVersion = await this.readPostedVersion(tx, run);
      if (baseVersion === null) {
        throw new BizException(BizCode.CORRECTION_SUBMIT_BASE_VERSION_INVALID);
      }
      const activeClosure = await this.readActiveClosure(tx, input.activityId);

      // 变更集引用的每个 identity 都必须**属于本活动且在基础版本里有结果行** ——
      // 否则更正会给一个不在这场账里的人凭空造一条结果。
      await this.assertChangeSetResolvable(tx, baseVersion.id, input.activityId, changeSet);

      const baseResultRevisionId =
        input.participationIdentityId === null
          ? null
          : await this.readBaseResultRevisionId(tx, baseVersion.id, input.participationIdentityId);

      // §3.25 partial unique 的**锁后检查**(第一道);DB partial unique 是第二道。
      await this.assertNoOpenRequest(tx, input.activityId, input.participationIdentityId);

      const created = await this.createRequest(tx, {
        input,
        runId: run.id,
        baseVersionId: baseVersion.id,
        baseResultRevisionId,
        baseClosureRevision: activeClosure?.revision ?? 0,
        actorUserId: currentUser.id,
      });

      // 有开放更正 ⇒ run 进 `correction_open`(§3.19 九值闭集里它正为这一步存在)。
      await tx.attendanceSettlementRun.update({
        where: { id: run.id },
        data: { statusCode: 'correction_open', version: { increment: 1 } },
      });

      const result: CorrectionSubmitResult = { ...toSubmitResult(created), replayed: false };
      await this.audit.logSubmit({
        ...result,
        activityTitle: activity.title,
        requestTypeCode: input.requestTypeCode,
        operationKey: input.operationKey,
        requestHash: input.requestHash,
        resultChangeCount: changeSet.results.length,
        segmentChangeCount: changeSet.segments.length,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        auditMeta,
        tx,
      });
      return result;
    });
  }

  // =========================================================================
  // §5.14 ② 审核 —— **只 approve / return / reject,不直接改数据**
  //
  // 🔴 本方法除了申请行本身、run 状态与 audit 之外,**一行业务数据都不写**:
  //    没有 UPDATE 结果行、没有写分录、没有建版本。
  //    判据:e2e 在 approve 前后对结果行 / 分录 / day-state 做整表快照比对,断言逐字未变。
  // =========================================================================
  async review(
    input: CorrectionReviewInput,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<CorrectionReviewOutcome> {
    const anchor = await this.readRequestAnchor(input.correctionRequestId);

    return await this.prisma.$transaction(async (tx) => {
      await this.lockActivity(tx, anchor.activityId);
      const run = await this.lockRun(tx, anchor.activityId);
      const request = await this.lockRequest(tx, input.correctionRequestId);
      const targetStatus = REVIEW_ACTION_TO_STATUS[input.actionCode];

      // 幂等:同一个人对同一条申请重复审同一个动作 ⇒ 原样返回,不写第二遍。
      if (
        request.statusCode === targetStatus &&
        request.reviewedByUserId === currentUser.id &&
        request.reviewNote === (input.note ?? null)
      ) {
        return {
          outcome: 'reviewed' as const,
          correctionRequestId: request.id,
          statusCode: request.statusCode,
          runStatus: run.statusCode,
          reviewedByUserId: currentUser.id,
          replayed: true,
        };
      }

      // §3.25 七值闭集里,只有 `pending` 是待审态。
      if (request.statusCode !== 'pending') {
        throw new BizException(BizCode.CORRECTION_REVIEW_STATUS_INVALID);
      }

      // ⭐ §3.25 末句:基础版本变化 ⇒ 置 voided 并要求新申请(**不允许照旧批准**)。
      //    刻意排在人员隔离**之前**:版本都换了,谁来审都没有意义。
      const drift = await this.detectBaseDrift(tx, anchor.activityId, run, request);
      if (drift !== null) {
        await this.voidRequest(tx, request.id);
        await this.releaseRun(tx, anchor.activityId, run.id);
        await this.audit.logVoided({
          ...drift,
          activityId: anchor.activityId,
          correctionRequestId: request.id,
          actorUserId: currentUser.id,
          actorRoleSnap: currentUser.role,
          auditMeta,
          tx,
        });
        return { outcome: 'voided' as const, correctionRequestId: request.id, ...drift };
      }

      // §7.5 人员隔离(锁后 authoritative row 上判;见 `correction-review-separation.ts`)。
      if (evaluateCorrectionReviewSeparation(request, currentUser.id) !== null) {
        throw new BizException(BizCode.CORRECTION_REVIEW_SELF_FORBIDDEN);
      }

      await tx.attendanceCorrectionRequest.update({
        where: { id: request.id },
        data: {
          statusCode: targetStatus,
          reviewedByUserId: currentUser.id,
          reviewedAt: new Date(),
          reviewNote: input.note ?? null,
          version: { increment: 1 },
        },
      });

      // `rejected` 不再占住 target(不在 partial unique 的谓词里)⇒ run 交回常态。
      // `approved` / `returned` 仍占住 ⇒ run 留在 `correction_open`。
      const runStatus =
        targetStatus === 'rejected'
          ? await this.releaseRun(tx, anchor.activityId, run.id)
          : run.statusCode;

      const result: CorrectionReviewed = {
        correctionRequestId: request.id,
        statusCode: targetStatus,
        runStatus,
        reviewedByUserId: currentUser.id,
        replayed: false,
      };
      await this.audit.logReview({
        ...result,
        activityId: anchor.activityId,
        actionCode: input.actionCode,
        note: input.note ?? null,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        auditMeta,
        tx,
      });
      return { outcome: 'reviewed' as const, ...result };
    });
  }

  // =========================================================================
  // §5.14 ③④ 准备 —— 新版本链 + 更正 posting batch(**先冲回,后补记**)
  //
  // 🔴 本方法**不取任何 member advisory lock**(沿第五刀 §5.12 首条红线:准备阶段
  //    不持一万把锁跑几分钟)。排他性完全由 `commit` 那一次短事务提供。
  // =========================================================================
  async prepare(
    input: CorrectionApplyInput,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<CorrectionPrepareResult> {
    const anchor = await this.readRequestAnchor(input.correctionRequestId);

    return await this.prisma
      .$transaction(
        async (tx) => {
          await this.lockActivity(tx, anchor.activityId);
          const run = await this.lockRun(tx, anchor.activityId);
          const request = await this.lockRequest(tx, input.correctionRequestId);

          // 幂等:已有 `preparing` / `committed` 的应用 ⇒ 原样返回(不再准备第二遍)。
          const resumable = await this.findResumableApplication(tx, request, run);
          if (resumable !== null) return resumable;

          if (request.statusCode !== 'approved') {
            throw new BizException(BizCode.CORRECTION_APPLY_STATUS_INVALID);
          }
          // 审核之后、应用之前世界又变了 ⇒ 同样置 voided,不允许照旧应用。
          // ⚠️ 这里可以抛(与 review 不同):`voidRequest` 与抛出**不在**同一条路径上 ——
          //    先写、后抛会把写一起回滚,所以本分支把置 voided 放在**独立事务**里做完再抛。
          const drift = await this.detectBaseDrift(tx, anchor.activityId, run, request);
          if (drift !== null) throw new CorrectionBaseDriftSignal(request.id);

          const changeSet = parseCorrectionChangeSet(request.requestedChangeJson);
          const baseVersion = await this.readVersionById(tx, request.baseSettlementVersionId);
          const baseResults = await this.readBaseResults(tx, baseVersion.id);

          // ===== §5.14 ③ 新的 SettlementVersion + Result / Segment revisions =====
          const resolved = resolveNewResults(baseResults, changeSet);
          const newVersion = await this.createNewVersion(tx, {
            activityId: anchor.activityId,
            run,
            baseVersion,
            resolved,
          });
          await this.createNewResultRevisions(tx, newVersion.id, request.id, resolved);
          const newSegmentRevisionCount = await this.createNewSegmentRevisions(tx, changeSet);

          // ===== §5.14 ④ 新的 PostingBatch =====
          const batch = await this.createPostingBatch(tx, {
            run,
            newVersionId: newVersion.id,
            totalCount: baseVersion.personCount,
            correctionRequestId: request.id,
            operationKey: input.operationKey,
            requestHash: input.requestHash,
            actorUserId: currentUser.id,
          });

          // 冲回集 = 基础版本下**已生效**的全部 credit 分录。
          const originals = await this.readReversibleOriginals(tx, baseVersion.id);
          // 补记集 = 新结果行按北京日拆分 + 日上限分配(基线**扣掉本次冲回**之后)。
          const replacements = await this.buildReplacementDayRows(
            tx,
            resolved,
            changeSet,
            originals,
          );

          // 🔴 §5.14 ④ 的**顺序**:先 reversal claims + 负数分录,再 replacement 分录。
          //    顺序不是排版偏好 —— claim 的 unique 是「至多冲一次」的执法位,
          //    它必须在任何补记落库之前就把原分录占住。
          await this.writeReversalClaims(tx, originals);
          const reversalEntryCount = await this.writeReversalEntries(
            tx,
            batch.id,
            anchor.activityId,
            input.requestHash,
            originals,
          );
          await this.writeReplacementDays(tx, replacements);
          const replacementEntryCount = await this.writeReplacementEntries(
            tx,
            batch.id,
            anchor.activityId,
            input.requestHash,
            replacements,
          );

          // ===== 让第五刀的 baseline 通路**原样可用** =====
          //
          // `commitBatchWithin` 读的是 `ActivityBatchJob(operationKey='settlement_prepare:<batchId>')`
          // 的 payload 与批次上的 `baselineJsonHash`。本刀**沿用同一份格式**(不改第五刀
          // 的读法、不加第二种基线来源)—— 更正的准备只是"另一种算法产出同一种准备结果"。
          const baseline = await this.readDayStateBaseline(tx, originals, replacements);
          await this.createPrepareJob(tx, {
            activityId: anchor.activityId,
            newVersionId: newVersion.id,
            batchId: batch.id,
            requestHash: input.requestHash,
            baseline,
            actorUserId: currentUser.id,
          });
          await tx.ledgerPostingBatch.update({
            where: { id: batch.id },
            data: {
              statusCode: 'ready',
              preparedAt: new Date(),
              preparedCount: baseVersion.personCount,
              baselineJsonHash: ledgerBaselineDigest(baseline),
              version: { increment: 1 },
            },
          });

          const newResultRevisionIds = resolved.map((row) => row.newResultRevisionId);
          const application = await tx.correctionApplication.create({
            data: {
              correctionRequestId: request.id,
              newSettlementVersionId: newVersion.id,
              newResultRevisionIds,
              newPostingBatchId: batch.id,
              statusCode: 'preparing',
            },
            select: { id: true },
          });

          await tx.attendanceCorrectionRequest.update({
            where: { id: request.id },
            data: { statusCode: 'applying', version: { increment: 1 } },
          });
          // ⚠️ 见文件头「两处诚实标注」:这两个指针是**工作流**指针,不是正式读面的真源;
          //    推它们是复用第五刀 commit 协议的前置条件。
          await tx.attendanceSettlementRun.update({
            where: { id: run.id },
            data: {
              statusCode: 'posting',
              currentSubmittedVersion: newVersion.version,
              version: { increment: 1 },
            },
          });

          const result: CorrectionPrepareResult = {
            correctionRequestId: request.id,
            correctionApplicationId: application.id,
            activityId: anchor.activityId,
            settlementRunId: run.id,
            baseSettlementVersionId: baseVersion.id,
            newSettlementVersionId: newVersion.id,
            newSettlementVersion: newVersion.version,
            newPostingBatchId: batch.id,
            newResultRevisionIds,
            newSegmentRevisionCount,
            reversalEntryCount,
            replacementEntryCount,
            batchStatus: 'ready',
            replayed: false,
          };
          await this.audit.logPrepare({
            ...result,
            operationKey: input.operationKey,
            requestHash: input.requestHash,
            actorUserId: currentUser.id,
            actorRoleSnap: currentUser.role,
            auditMeta,
            tx,
          });
          return result;
        },
        { timeout: CORRECTION_PREPARE_TX_TIMEOUT_MS },
      )
      .catch(async (error: unknown) => {
        // 基础版本漂移:置 voided 必须**落库**,所以它在准备事务之外独立完成。
        if (error instanceof CorrectionBaseDriftSignal) {
          await this.prisma.attendanceCorrectionRequest.update({
            where: { id: error.correctionRequestId },
            data: { statusCode: 'voided', version: { increment: 1 } },
          });
          throw new BizException(BizCode.CORRECTION_BASE_VERSION_CHANGED);
        }
        throw error;
      });
  }

  // =========================================================================
  // §5.14 ⑤⑥ 生效 —— 第五刀 commit 协议 + 七项原子切换(**同一事务**)
  // =========================================================================
  async commit(
    input: CorrectionApplyInput,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<CorrectionCommitResult> {
    const anchor = await this.readRequestAnchor(input.correctionRequestId);

    return await runMemberLinearizedTransaction(this.prisma, async (tx) => {
      // ① Activity → ② run → ③ correction request(本刀新增的唯一一把,插在 run 之后)
      await this.lockActivity(tx, anchor.activityId);
      const run = await this.lockRun(tx, anchor.activityId);
      const request = await this.lockRequest(tx, input.correctionRequestId);
      const application = await this.lockApplication(tx, request.id);

      // 幂等:已 committed ⇒ 原样返回上一次的结论。
      if (application.statusCode === 'committed') {
        return replayCommitResult(anchor.activityId, request, application);
      }
      if (request.statusCode !== 'applying' || application.statusCode !== 'preparing') {
        throw new BizException(BizCode.CORRECTION_APPLY_STATUS_INVALID);
      }

      // ===== §5.14 ⑤ ⭐ 第五刀的 commit 协议,**在本事务内逐字复用** =====
      //
      // 它自己会取 ④ version → ⑤ batch → ⑥ 恒串行闸 → ⑦ member 锁 → ⑧ day-state,
      // 并做 baseline 比对 / 日合计 0..3 / 零部分生效。本文件**不重复任何一条**。
      const ledger = await this.ledgerPosting.commitBatchWithin(
        tx,
        anchor.activityId,
        { postingBatchId: application.newPostingBatchId, operationKey: input.operationKey },
        currentUser,
        auditMeta,
      );

      // ===== §5.14 ⑥ 原子切换:以下全部与上面同一事务 =====
      //
      // ⚠️ 只翻 `statusCode`(+ `updatedAt`),业务内容列一律不动 —— §3.25
      //    「旧记录不更新删除」的逐字口径见文件头。
      const supersededResultRevisionCount = await tx.$executeRaw`
        UPDATE "ParticipantSettlementResultRevision"
        SET "statusCode" = 'superseded', "updatedAt" = NOW()
        WHERE "settlementVersionId" = ${request.baseSettlementVersionId}
          AND "statusCode" = 'committed'
      `;
      // 被本次更正顶掉的旧段:由**新段自己的 `baseRevisionId`** 指回来定位。
      // ⚠️ 必须排在 `commitBatchWithin` 之后 —— 新段的 `effectiveBatchId` 是它填的,
      //    而这里正是靠它把"本批次的新段"与别的段区分开。
      const supersededSegmentRevisionCount = await tx.$executeRaw`
        UPDATE "ParticipantServiceSegmentRevision" AS old
        SET "statusCode" = 'superseded', "updatedAt" = NOW()
        FROM "ParticipantServiceSegmentRevision" AS fresh
        WHERE fresh."effectiveBatchId" = ${application.newPostingBatchId}
          AND fresh."baseRevisionId" = old.id
          AND old."statusCode" <> 'superseded'
      `;

      const supersededClosureRevision = await this.supersedeActiveClosure(
        tx,
        anchor.activityId,
        request.id,
      );
      // §5.14 ⑥「Activity currentClosureRevision 清空／指向无 active 状态」。
      await tx.activity.update({
        where: { id: anchor.activityId },
        data: { currentClosureRevision: null },
      });
      await tx.attendanceSettlementRun.update({
        where: { id: run.id },
        data: { currentClosureRevision: null, version: { increment: 1 } },
      });

      await tx.correctionApplication.update({
        where: { id: application.id },
        data: { statusCode: 'committed' },
      });
      await tx.attendanceCorrectionRequest.update({
        where: { id: request.id },
        data: { statusCode: 'applied', version: { increment: 1 } },
      });

      const result: CorrectionCommitResult = {
        correctionRequestId: request.id,
        correctionApplicationId: application.id,
        activityId: anchor.activityId,
        ledger,
        supersededResultRevisionCount,
        supersededSegmentRevisionCount,
        supersededClosureRevision,
        activityClosurePointerCleared: true,
        correctionStatus: 'applied',
        applicationStatus: 'committed',
        replayed: false,
      };

      // audit 刻意放**最后一步**:它是 DoD 7「让最后一步抛错 ⇒ 七项全回滚」那条判据的落点。
      await this.audit.logCommit({
        ...result,
        settlementRunId: run.id,
        operationKey: input.operationKey,
        requestHash: input.requestHash,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        auditMeta,
        tx,
      });
      return result;
    });
  }

  // =========================================================================
  // §5.14 ③→⑦ 的组合:准备 → 生效 → **重新关账**
  //
  // ⑦ 刻意在 commit 事务**之外**:§5.14 把它列为第 ⑦ 步(⑥ 之后),而
  // `ActivityClosureService.close` 自带事务。硬塞进 commit 事务只会把关账的八类检查
  // 也一起绑上 member 锁,凭空拉长最像钱的那一段事务。
  // =========================================================================
  async apply(
    input: CorrectionApplyInput,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<CorrectionApplyResult> {
    const prepared = await this.prepare(input, currentUser, auditMeta);
    const committed = await this.commit(input, currentUser, auditMeta);
    const reclose = await this.closure.close(
      prepared.activityId,
      {
        operationKey: `correction-reclose:${input.correctionRequestId}:${input.operationKey}`,
        requestHash: input.requestHash,
      },
      currentUser,
      auditMeta,
    );
    return { prepare: prepared, commit: committed, reclose };
  }

  // ===== 锁序三把 ==========================================================

  private async lockActivity(tx: PrismaTx, activityId: string): Promise<{ title: string }> {
    const rows = await tx.$queryRaw<Array<{ title: string }>>`
      SELECT title FROM "Activity"
      WHERE id = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return row;
  }

  private async lockRun(tx: PrismaTx, activityId: string): Promise<LockedRun> {
    const rows = await tx.$queryRaw<LockedRun[]>`
      SELECT id, "statusCode", "currentSubmittedVersion", "currentPostedVersion",
             "currentClosureRevision"
      FROM "AttendanceSettlementRun"
      WHERE "activityId" = ${activityId}
      FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined) throw new BizException(BizCode.CORRECTION_SUBMIT_RUN_STATUS_INVALID);
    return row;
  }

  private async lockRequest(tx: PrismaTx, correctionRequestId: string): Promise<LockedRequest> {
    const rows = await tx.$queryRaw<LockedRequest[]>`
      SELECT id, "activityId", "settlementRunId", "participationIdentityId",
             "baseSettlementVersionId", "baseResultRevisionId", "baseClosureRevision",
             "requestedChangeJson", "statusCode", "submittedByUserId",
             "reviewedByUserId", "reviewNote", "operationKey", "requestHash"
      FROM "AttendanceCorrectionRequest"
      WHERE id = ${correctionRequestId}
      FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined) throw new BizException(BizCode.CORRECTION_REVIEW_STATUS_INVALID);
    return row;
  }

  private async lockApplication(
    tx: PrismaTx,
    correctionRequestId: string,
  ): Promise<{
    id: string;
    statusCode: string;
    newSettlementVersionId: string;
    newPostingBatchId: string;
  }> {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        statusCode: string;
        newSettlementVersionId: string;
        newPostingBatchId: string;
      }>
    >`
      SELECT id, "statusCode", "newSettlementVersionId", "newPostingBatchId"
      FROM "CorrectionApplication"
      WHERE "correctionRequestId" = ${correctionRequestId}
        AND "statusCode" IN ('preparing', 'committed')
      ORDER BY "createdAt" ASC
      FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined) throw new BizException(BizCode.CORRECTION_APPLY_STATUS_INVALID);
    return row;
  }

  // ===== 读 ================================================================

  /** 锁序要求先锁 Activity,而 activityId 只能从申请行读出来。这一次读**不加锁、不判定**。 */
  private async readRequestAnchor(correctionRequestId: string): Promise<{ activityId: string }> {
    const row = await this.prisma.attendanceCorrectionRequest.findUnique({
      where: { id: correctionRequestId },
      select: { activityId: true },
    });
    if (row === null) throw new BizException(BizCode.CORRECTION_REVIEW_STATUS_INVALID);
    return row;
  }

  private async readPostedVersion(tx: PrismaTx, run: LockedRun): Promise<VersionRow | null> {
    if (run.currentPostedVersion === null) return null;
    const rows = await tx.$queryRaw<VersionRow[]>`
      SELECT id, version, "evidenceSealId", "evidenceRevision", "populationRevision",
             "workflowRevision", "contentHash", "personCount", "sessionParticipationCount",
             "serviceSegmentCount", "statusCode"
      FROM "AttendanceSettlementVersion"
      WHERE "settlementRunId" = ${run.id} AND version = ${run.currentPostedVersion}
    `;
    return rows[0] ?? null;
  }

  private async readVersionById(tx: PrismaTx, settlementVersionId: string): Promise<VersionRow> {
    const rows = await tx.$queryRaw<VersionRow[]>`
      SELECT id, version, "evidenceSealId", "evidenceRevision", "populationRevision",
             "workflowRevision", "contentHash", "personCount", "sessionParticipationCount",
             "serviceSegmentCount", "statusCode"
      FROM "AttendanceSettlementVersion"
      WHERE id = ${settlementVersionId}
    `;
    const row = rows[0];
    if (row === undefined) throw new BizException(BizCode.CORRECTION_SUBMIT_BASE_VERSION_INVALID);
    return row;
  }

  private async readActiveClosure(
    tx: PrismaTx,
    activityId: string,
  ): Promise<{ id: string; revision: number } | null> {
    return await tx.activitySettlementClosureRevision.findFirst({
      where: { activityId, statusCode: 'active' },
      select: { id: true, revision: true },
    });
  }

  private async readBaseResultRevisionId(
    tx: PrismaTx,
    settlementVersionId: string,
    participationIdentityId: string,
  ): Promise<string> {
    const row = await tx.participantSettlementResultRevision.findUnique({
      where: {
        settlementVersionId_participationIdentityId: {
          settlementVersionId,
          participationIdentityId,
        },
      },
      select: { id: true },
    });
    // 更正锚点指向一个在基础版本里根本没有结果的人 ⇒ 无从更正。
    if (row === null) throw new BizException(BizCode.CORRECTION_SUBMIT_BASE_VERSION_INVALID);
    return row.id;
  }

  private async readBaseResults(
    tx: PrismaTx,
    settlementVersionId: string,
  ): Promise<BaseResultRow[]> {
    const rows = await tx.participantSettlementResultRevision.findMany({
      where: { settlementVersionId },
      select: {
        id: true,
        participationIdentityId: true,
        revision: true,
        resultCode: true,
        lateFlag: true,
        earlyLeaveFlag: true,
        exceptionFlagsJson: true,
        recognizedServiceHours: true,
        recognizedContributionPoints: true,
        calculatedServiceHours: true,
        calculatedContributionPoints: true,
        adjustmentReason: true,
        identity: { select: { memberId: true, sessionId: true } },
      },
      // 稳定序:同一份数据必须得到同一份写入顺序与同一个 contentHash。
      orderBy: { participationIdentityId: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      participationIdentityId: row.participationIdentityId,
      revision: row.revision,
      resultCode: row.resultCode,
      lateFlag: row.lateFlag,
      earlyLeaveFlag: row.earlyLeaveFlag,
      exceptionFlagsJson: row.exceptionFlagsJson,
      recognizedServiceHours: row.recognizedServiceHours,
      recognizedContributionPoints: row.recognizedContributionPoints,
      calculatedServiceHours: row.calculatedServiceHours,
      calculatedContributionPoints: row.calculatedContributionPoints,
      adjustmentReason: row.adjustmentReason,
      memberId: row.identity.memberId,
      sessionId: row.identity.sessionId,
    }));
  }

  /**
   * 变更集引用的 identity 必须**属于本活动**且在基础版本里有结果行。
   *
   * 两条一起判(而不是只判其一):只判"属于本活动"会放行一个未参与本次结算的人;
   * 只判"有结果行"会放行一个跨活动的 id(结果行在别的活动的版本下)。
   */
  private async assertChangeSetResolvable(
    tx: PrismaTx,
    settlementVersionId: string,
    activityId: string,
    changeSet: CorrectionChangeSet,
  ): Promise<void> {
    const identityIds = [
      ...new Set([
        ...changeSet.results.map((row) => row.participationIdentityId),
        ...changeSet.segments.map((row) => row.participationIdentityId),
      ]),
    ];
    if (identityIds.length === 0) return;
    const [row] = await tx.$queryRaw<Array<{ resolved: number }>>`
      SELECT count(*)::int AS resolved
      FROM "ActivityParticipationIdentity" i
      JOIN "ParticipantSettlementResultRevision" rr
        ON rr."participationIdentityId" = i.id AND rr."settlementVersionId" = ${settlementVersionId}
      WHERE i."activityId" = ${activityId}
        AND i.id = ANY(${identityIds}::text[])
    `;
    if ((row?.resolved ?? 0) !== identityIds.length) {
      throw new BizException(BizCode.CORRECTION_CHANGE_SET_INVALID);
    }
  }

  private async findRequestByOperationKey(
    tx: PrismaTx,
    input: CorrectionSubmitInput,
  ): Promise<LockedRequest | null> {
    const existing = await tx.attendanceCorrectionRequest.findFirst({
      where: { activityId: input.activityId, operationKey: input.operationKey },
      select: {
        id: true,
        activityId: true,
        settlementRunId: true,
        participationIdentityId: true,
        baseSettlementVersionId: true,
        baseResultRevisionId: true,
        baseClosureRevision: true,
        requestedChangeJson: true,
        statusCode: true,
        submittedByUserId: true,
        reviewedByUserId: true,
        reviewNote: true,
        operationKey: true,
        requestHash: true,
      },
    });
    if (existing === null) return null;
    // 同 key **不同 payload** ⇒ 撞键(与 20061 / 20073 / 20098 同一范式)。
    if (existing.requestHash !== input.requestHash) {
      throw new BizException(BizCode.CORRECTION_OPERATION_KEY_CONFLICT);
    }
    return existing;
  }

  private async assertNoOpenRequest(
    tx: PrismaTx,
    activityId: string,
    participationIdentityId: string | null,
  ): Promise<void> {
    const open = await tx.attendanceCorrectionRequest.findFirst({
      where: {
        activityId,
        participationIdentityId,
        statusCode: { in: CORRECTION_OPEN_STATUSES },
      },
      select: { id: true },
    });
    if (open !== null) throw new BizException(BizCode.CORRECTION_TARGET_ALREADY_OPEN);
  }

  private async createRequest(
    tx: PrismaTx,
    args: {
      input: CorrectionSubmitInput;
      runId: string;
      baseVersionId: string;
      baseResultRevisionId: string | null;
      baseClosureRevision: number;
      actorUserId: string;
    },
  ): Promise<LockedRequest> {
    try {
      return await tx.attendanceCorrectionRequest.create({
        data: {
          activityId: args.input.activityId,
          settlementRunId: args.runId,
          participationIdentityId: args.input.participationIdentityId,
          baseSettlementVersionId: args.baseVersionId,
          baseResultRevisionId: args.baseResultRevisionId,
          baseClosureRevision: args.baseClosureRevision,
          requestTypeCode: args.input.requestTypeCode,
          requestedChangeJson: args.input.requestedChangeJson as Prisma.InputJsonValue,
          reason: args.input.reason,
          attachmentIds:
            args.input.attachmentIds === undefined ? undefined : [...args.input.attachmentIds],
          statusCode: 'pending',
          submittedByUserId: args.actorUserId,
          submittedAt: new Date(),
          operationKey: args.input.operationKey,
          requestHash: args.input.requestHash,
        },
        select: {
          id: true,
          activityId: true,
          settlementRunId: true,
          participationIdentityId: true,
          baseSettlementVersionId: true,
          baseResultRevisionId: true,
          baseClosureRevision: true,
          requestedChangeJson: true,
          statusCode: true,
          submittedByUserId: true,
          reviewedByUserId: true,
          reviewNote: true,
          operationKey: true,
          requestHash: true,
        },
      });
    } catch (error) {
      // §3.25 partial unique 的第二道(`attendance_correction_request_open_unique`)。
      // 🔴 不让 Prisma 异常裸奔成 500 —— 翻成具名码(与 20083 / 20097 同一范式)。
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BizException(BizCode.CORRECTION_TARGET_ALREADY_OPEN);
      }
      throw error;
    }
  }

  /**
   * §3.25 末句的漂移判定:**基础版本**或**基础关闭版本**任一变了就算漂移。
   *
   * 两个锚点分开判是有意的:更正申请提交之后,既可能有另一条更正把版本顶掉
   * (第一个锚点动),也可能只是重新关了一次账(第二个锚点动)。任一变化都意味着
   * 申请人当时看到的那份账已经不是现在这份。
   */
  private async detectBaseDrift(
    tx: PrismaTx,
    activityId: string,
    run: LockedRun,
    request: LockedRequest,
  ): Promise<CorrectionBaseDrift | null> {
    const current = await this.readPostedVersion(tx, run);
    const closure = await this.readActiveClosure(tx, activityId);
    const currentClosureRevision = closure?.revision ?? 0;
    if (
      current?.id === request.baseSettlementVersionId &&
      currentClosureRevision === request.baseClosureRevision
    ) {
      return null;
    }
    return {
      baseSettlementVersionId: request.baseSettlementVersionId,
      currentSettlementVersionId: current?.id ?? null,
      baseClosureRevision: request.baseClosureRevision,
      currentClosureRevision,
    };
  }

  private async voidRequest(tx: PrismaTx, correctionRequestId: string): Promise<void> {
    await tx.attendanceCorrectionRequest.update({
      where: { id: correctionRequestId },
      data: { statusCode: 'voided', version: { increment: 1 } },
    });
  }

  /**
   * 没有开放更正了 ⇒ run 交回常态。
   *
   * 目标状态由**事实**派生,不存第二份记忆:有 active closure 就是 `closed`,
   * 否则是 `posted`。存一列"更正前的状态"只会多一处可能与事实不符的真相源。
   */
  private async releaseRun(tx: PrismaTx, activityId: string, runId: string): Promise<string> {
    const closure = await this.readActiveClosure(tx, activityId);
    const statusCode = closure === null ? 'posted' : 'closed';
    await tx.attendanceSettlementRun.update({
      where: { id: runId },
      data: { statusCode, version: { increment: 1 } },
    });
    return statusCode;
  }

  private async findResumableApplication(
    tx: PrismaTx,
    request: LockedRequest,
    run: LockedRun,
  ): Promise<CorrectionPrepareResult | null> {
    const existing = await tx.correctionApplication.findFirst({
      where: { correctionRequestId: request.id, statusCode: { in: ['preparing', 'committed'] } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        newSettlementVersionId: true,
        newResultRevisionIds: true,
        newPostingBatchId: true,
      },
    });
    if (existing === null) return null;
    const version = await this.readVersionById(tx, existing.newSettlementVersionId);
    const [counts] = await tx.$queryRaw<
      Array<{ reversalEntryCount: number; replacementEntryCount: number; batchStatus: string }>
    >`
      SELECT
        count(*) FILTER (
          WHERE e."entryTypeCode" IN ('service_reversal', 'contribution_reversal')
        )::int AS "reversalEntryCount",
        count(*) FILTER (
          WHERE e."entryTypeCode" IN ('service_credit', 'contribution_credit')
        )::int AS "replacementEntryCount",
        max(b."statusCode") AS "batchStatus"
      FROM "LedgerPostingBatch" b
      LEFT JOIN "ParticipationLedgerEntry" e ON e."postingBatchId" = b.id
      WHERE b.id = ${existing.newPostingBatchId}
      GROUP BY b.id
    `;
    const newResultRevisionIds = Array.isArray(existing.newResultRevisionIds)
      ? existing.newResultRevisionIds.filter((id): id is string => typeof id === 'string')
      : [];
    return {
      correctionRequestId: request.id,
      correctionApplicationId: existing.id,
      activityId: request.activityId,
      settlementRunId: run.id,
      baseSettlementVersionId: request.baseSettlementVersionId,
      newSettlementVersionId: existing.newSettlementVersionId,
      newSettlementVersion: version.version,
      newPostingBatchId: existing.newPostingBatchId,
      newResultRevisionIds,
      newSegmentRevisionCount: 0,
      reversalEntryCount: counts?.reversalEntryCount ?? 0,
      replacementEntryCount: counts?.replacementEntryCount ?? 0,
      batchStatus: counts?.batchStatus ?? 'ready',
      replayed: true,
    };
  }

  // ===== §5.14 ③ 新版本链 ==================================================

  private async createNewVersion(
    tx: PrismaTx,
    args: {
      activityId: string;
      run: LockedRun;
      baseVersion: VersionRow;
      resolved: readonly ResolvedResult[];
    },
  ): Promise<{ id: string; version: number }> {
    const maxVersion = await tx.attendanceSettlementVersion.aggregate({
      where: { settlementRunId: args.run.id },
      _max: { version: true },
    });
    const version = (maxVersion._max.version ?? 0) + 1;

    // contentHash 用**第三刀那把尺子**(同一 `schemaVersion`、同一 canonical 化)——
    // 不另立第二套算法,否则更正版本与提交版本的 hash 之间不可比。
    const items: SettlementContentItem[] = args.resolved.map((row) => ({
      participationIdentityId: row.participationIdentityId,
      resultCode: row.resultCode,
      lateFlag: row.lateFlag,
      earlyLeaveFlag: row.earlyLeaveFlag,
      exceptionFlags: (row.exceptionFlagsJson ?? null) as SettlementContentItem['exceptionFlags'],
      recognizedServiceHours: decimalToCanonicalString(row.recognizedServiceHours),
      recognizedContributionPoints: decimalToCanonicalString(row.recognizedContributionPoints),
      calculatedServiceHours: row.calculatedServiceHours,
      calculatedContributionPoints: row.calculatedContributionPoints,
      adjustmentReason: row.adjustmentReason,
    }));
    const seal = await tx.evidenceSeal.findUnique({
      where: { id: args.baseVersion.evidenceSealId },
      select: { sealRevision: true },
    });
    const contentHash = computeSettlementContentHash({
      schemaVersion: SETTLEMENT_CONTENT_SCHEMA_VERSION,
      activityId: args.activityId,
      settlementRunId: args.run.id,
      evidenceSealId: args.baseVersion.evidenceSealId,
      sealRevision: seal?.sealRevision ?? 0,
      evidenceRevision: args.baseVersion.evidenceRevision,
      populationRevision: args.baseVersion.populationRevision,
      workflowRevision: args.baseVersion.workflowRevision,
      personCount: args.baseVersion.personCount,
      sessionParticipationCount: args.baseVersion.sessionParticipationCount,
      serviceSegmentCount: args.baseVersion.serviceSegmentCount,
      items,
    });

    const created = await tx.attendanceSettlementVersion.create({
      data: {
        settlementRunId: args.run.id,
        version,
        evidenceSealId: args.baseVersion.evidenceSealId,
        evidenceRevision: args.baseVersion.evidenceRevision,
        populationRevision: args.baseVersion.populationRevision,
        workflowRevision: args.baseVersion.workflowRevision,
        contentHash,
        personCount: args.baseVersion.personCount,
        sessionParticipationCount: args.baseVersion.sessionParticipationCount,
        serviceSegmentCount: args.baseVersion.serviceSegmentCount,
        // §5.14 ③「approve 后生成新版本」—— 更正流程自己的审核就是它的批准动作,
        // 不再走一遍 §5.11 的两审(那是**提交**路径的审核,不是更正路径的)。
        // ⚠️ 这是与合同的显式偏离候选,已在报告列明。
        statusCode: 'approved',
        priorVersionId: args.baseVersion.id,
        submittedAt: new Date(),
      },
      select: { id: true, version: true },
    });
    return created;
  }

  /**
   * 新结果行:**全人口整份复制**,被变更集点名的那些人换成新值。
   *
   * 🔴 为什么必须整份复制、而不是只写被改的那几个人:第六刀关账的第 ⑤ 类检查
   *    (`populationWithoutResult` / `resultOutOfPopulation`)是拿**当前 posted 版本**
   *    与应结算人口做一一对应的 —— 只写几个人的新版本会让其余所有人"没有结果",
   *    §5.14 ⑦ 的重新关账当场全红。整份复制之后,未被更正的人在新版本里是逐字相同的
   *    一行(只是换了 `settlementVersionId` 与 `baseResultRevisionId`)。
   */
  private async createNewResultRevisions(
    tx: PrismaTx,
    newVersionId: string,
    correctionRequestId: string,
    resolved: ResolvedResult[],
  ): Promise<void> {
    if (resolved.length === 0) return;
    const created = await tx.$queryRaw<Array<{ id: string; participationIdentityId: string }>>`
      INSERT INTO "ParticipantSettlementResultRevision" (
        "id", "createdAt", "updatedAt", "settlementVersionId", "participationIdentityId",
        "revision", "resultCode", "lateFlag", "earlyLeaveFlag",
        "recognizedServiceHours", "recognizedContributionPoints",
        "calculatedServiceHours", "calculatedContributionPoints",
        "adjustmentReason", "statusCode", "baseResultRevisionId", "correctionRequestId"
      )
      SELECT gen_random_uuid()::text, NOW(), NOW(), ${newVersionId}, t.identity_id,
             t.revision::int, t.result_code, t.late_flag::boolean, t.early_leave_flag::boolean,
             t.recognized_hours::numeric, t.recognized_points::numeric,
             t.calculated_hours::numeric, t.calculated_points::numeric,
             t.adjustment_reason, 'draft', t.base_revision_id, ${correctionRequestId}
      FROM unnest(
        ${resolved.map((row) => row.participationIdentityId)}::text[],
        ${resolved.map((row) => String(row.baseRevision + 1))}::text[],
        ${resolved.map((row) => row.resultCode)}::text[],
        ${resolved.map((row) => String(row.lateFlag))}::text[],
        ${resolved.map((row) => String(row.earlyLeaveFlag))}::text[],
        ${resolved.map((row) => row.recognizedServiceHours.toFixed(2))}::text[],
        ${resolved.map((row) => row.recognizedContributionPoints.toFixed(2))}::text[],
        ${resolved.map((row) => row.calculatedServiceHours)}::text[],
        ${resolved.map((row) => row.calculatedContributionPoints)}::text[],
        ${resolved.map((row) => row.adjustmentReason)}::text[],
        ${resolved.map((row) => row.baseResultRevisionId)}::text[]
      ) AS t(identity_id, revision, result_code, late_flag, early_leave_flag,
             recognized_hours, recognized_points, calculated_hours, calculated_points,
             adjustment_reason, base_revision_id)
      RETURNING id, "participationIdentityId"
    `;
    const byIdentity = new Map(created.map((row) => [row.participationIdentityId, row.id]));
    for (const row of resolved) {
      const id = byIdentity.get(row.participationIdentityId);
      // 插入条数与入参条数不符 ⇒ 记录不自洽,不许带着空 id 往下走。
      if (id === undefined) throw new BizException(BizCode.CORRECTION_CHANGE_SET_INVALID);
      row.newResultRevisionId = id;
    }
  }

  /**
   * §5.14 ③ 的 Segment revisions:被变更集点名的段**追加一版**,旧版留着不动。
   *
   * ⚠️ 新版建成 `draft`;旧版的 `superseded` 投影**在 commit 事务里**才做
   *    (§5.14 ⑥)—— 在准备阶段就翻旧段会当场改变正式读面(段是关账第 ③/⑥/⑦ 类
   *    检查的输入),违反 §5.14 末句。
   */
  private async createNewSegmentRevisions(
    tx: PrismaTx,
    changeSet: CorrectionChangeSet,
  ): Promise<number> {
    if (changeSet.segments.length === 0) return 0;
    let written = 0;
    for (const change of changeSet.segments) {
      const base = await tx.participantServiceSegmentRevision.findFirst({
        where: {
          participationIdentityId: change.participationIdentityId,
          segmentKey: change.segmentKey,
        },
        orderBy: { revision: 'desc' },
        select: { id: true, revision: true, sourceCheckInEventId: true },
      });
      // 更正一个不存在的段 ⇒ 无从更正(不发明一条凭空的服务事实)。
      if (base === null) throw new BizException(BizCode.CORRECTION_CHANGE_SET_INVALID);
      await tx.participantServiceSegmentRevision.create({
        data: {
          participationIdentityId: change.participationIdentityId,
          segmentKey: change.segmentKey,
          revision: base.revision + 1,
          sourceCheckInEventId: base.sourceCheckInEventId,
          resultCode: change.resultCode,
          statusCode: 'draft',
          checkInAt: change.checkInAt,
          checkOutAt: change.checkOutAt,
          serviceHours: new Prisma.Decimal(change.serviceHours.toFixed(2)),
          baseRevisionId: base.id,
        },
      });
      written += 1;
    }
    return written;
  }

  // ===== §5.14 ④ 更正 posting batch ========================================

  private async createPostingBatch(
    tx: PrismaTx,
    args: {
      run: LockedRun;
      newVersionId: string;
      totalCount: number;
      correctionRequestId: string;
      operationKey: string;
      requestHash: string;
      actorUserId: string;
    },
  ): Promise<{ id: string }> {
    // §3.22「batchRevision 同一 run 内单调递增」—— 按 run 取最大值(沿第四刀)。
    const maxRevision = await tx.ledgerPostingBatch.aggregate({
      where: { settlementRunId: args.run.id },
      _max: { batchRevision: true },
    });
    try {
      return await tx.ledgerPostingBatch.create({
        data: {
          settlementRunId: args.run.id,
          settlementVersionId: args.newVersionId,
          batchRevision: (maxRevision._max.batchRevision ?? 0) + 1,
          statusCode: 'preparing',
          // requestKey 单列 unique(§3.22)⇒ 同一次更正应用无论被重放几次,只会有一条批次。
          requestKey: `correction-apply:${args.correctionRequestId}:${args.operationKey}`,
          requestHash: args.requestHash,
          totalCount: args.totalCount,
          preparedByUserId: args.actorUserId,
        },
        select: { id: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BizException(BizCode.CORRECTION_OPERATION_KEY_CONFLICT);
      }
      throw error;
    }
  }

  /**
   * 被冲回的旧分录 = **基础版本**下、在**已生效**批次里的全部 credit 分录。
   *
   * ⚠️ 刻意**不**过滤"已经被冲过的" —— 已被冲过是**错误**(20107),不是"跳过就好"。
   *    过滤掉它等于把一次真正的重复冲回悄悄咽下去。
   * ⚠️ 也刻意**不**冲 `*_reversal` 分录:上一次更正写下的负数分录不是"账",
   *    它是上一次冲回本身;再冲一次等于把冲销撤销掉。
   */
  private async readReversibleOriginals(
    tx: PrismaTx,
    baseVersionId: string,
  ): Promise<OriginalEntryRow[]> {
    return await tx.$queryRaw<OriginalEntryRow[]>`
      SELECT e.id, e."memberId", e."sessionId", e."participationIdentityId",
             e."resultRevisionId", to_char(e."ledgerDate", 'YYYY-MM-DD') AS "ledgerDate",
             e."entryTypeCode",
             e."serviceHoursDelta"::text AS "serviceHoursDelta",
             e."recognizedPointsDelta"::text AS "recognizedPointsDelta",
             e."creditedPointsDelta"::text AS "creditedPointsDelta",
             e."cappedOutPointsDelta"::text AS "cappedOutPointsDelta"
      FROM "ParticipationLedgerEntry" e
      JOIN "LedgerPostingBatch" b ON b.id = e."postingBatchId"
      JOIN "ParticipantSettlementResultRevision" rr ON rr.id = e."resultRevisionId"
      WHERE rr."settlementVersionId" = ${baseVersionId}
        AND b."statusCode" = 'committed'
        AND e."entryTypeCode" IN ('service_credit', 'contribution_credit')
      ORDER BY e.id ASC
    `;
  }

  /**
   * §3.23.5 的**service 锁后检查** + DB unique 两道。
   *
   * 锁后检查先判(具名码、消息可读);DB unique 是并发兜底,P2002 / 23505 同样翻成本码,
   * **不让 Prisma 异常裸奔成 500**。
   */
  private async writeReversalClaims(
    tx: PrismaTx,
    originals: readonly OriginalEntryRow[],
  ): Promise<void> {
    if (originals.length === 0) return;
    const ids = originals.map((row) => row.id);
    const [claimed] = await tx.$queryRaw<Array<{ existing: number }>>`
      SELECT count(*)::int AS existing
      FROM "LedgerEntryReversalClaim"
      WHERE "originalEntryId" = ANY(${ids}::text[])
    `;
    if ((claimed?.existing ?? 0) > 0) {
      throw new BizException(BizCode.CORRECTION_REVERSAL_ALREADY_CLAIMED);
    }
    try {
      await tx.$executeRaw`
        INSERT INTO "LedgerEntryReversalClaim" ("id", "createdAt", "originalEntryId")
        SELECT gen_random_uuid()::text, NOW(), t.original_entry_id
        FROM unnest(${ids}::text[]) AS t(original_entry_id)
      `;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new BizException(BizCode.CORRECTION_REVERSAL_ALREADY_CLAIMED);
      }
      throw error;
    }
  }

  /**
   * 冲回分录:四个 delta **逐列取反**,`reversesEntryId` 指回原分录。
   *
   * 🔴 类型码映射是**闭集到闭集**:`service_credit → service_reversal`、
   *    `contribution_credit → contribution_reversal`。DB 上三条 CHECK 与本函数对应:
   *    `reversal_shape_check`(reversal 必带 reversesEntryId)、
   *    `sign_check`(reversal 四列 ≤ 0)、`balance_check`(贡献分录 recognized =
   *    credited + cappedOut —— 逐列取反后等式依然成立)。写歪当场 23514,不静默入库。
   */
  private async writeReversalEntries(
    tx: PrismaTx,
    batchId: string,
    activityId: string,
    requestHash: string,
    originals: readonly OriginalEntryRow[],
  ): Promise<number> {
    if (originals.length === 0) return 0;
    const reversalTypes = originals.map((row) =>
      row.entryTypeCode === 'service_credit' ? 'service_reversal' : 'contribution_reversal',
    );
    const entryKeys = originals.map(
      (row, index) =>
        `${batchId}:${row.resultRevisionId}:${row.ledgerDate}:${reversalTypes[index]}`,
    );
    return await tx.$executeRaw`
      INSERT INTO "ParticipationLedgerEntry" (
        "id", "createdAt", "postingBatchId", "entryKey", "operationKey", "requestHash",
        "memberId", "activityId", "sessionId", "participationIdentityId", "resultRevisionId",
        "ledgerDate", "entryTypeCode",
        "serviceHoursDelta", "recognizedPointsDelta", "creditedPointsDelta",
        "cappedOutPointsDelta", "reversesEntryId"
      )
      SELECT gen_random_uuid()::text, NOW(), ${batchId}, t.entry_key,
             'correction-reversal:' || t.entry_key, ${requestHash},
             t.member_id, ${activityId}, t.session_id, t.identity_id,
             t.result_revision_id, t.ledger_date::date, t.entry_type,
             -(t.service_hours::numeric), -(t.recognized_points::numeric),
             -(t.credited_points::numeric), -(t.capped_out_points::numeric),
             t.original_entry_id
      FROM unnest(
        ${entryKeys}::text[],
        ${originals.map((row) => row.memberId)}::text[],
        ${originals.map((row) => row.sessionId)}::text[],
        ${originals.map((row) => row.participationIdentityId)}::text[],
        ${originals.map((row) => row.resultRevisionId)}::text[],
        ${originals.map((row) => row.ledgerDate)}::text[],
        ${reversalTypes}::text[],
        ${originals.map((row) => row.serviceHoursDelta)}::text[],
        ${originals.map((row) => row.recognizedPointsDelta)}::text[],
        ${originals.map((row) => row.creditedPointsDelta)}::text[],
        ${originals.map((row) => row.cappedOutPointsDelta)}::text[],
        ${originals.map((row) => row.id)}::text[]
      ) AS t(entry_key, member_id, session_id, identity_id, result_revision_id, ledger_date,
             entry_type, service_hours, recognized_points, credited_points, capped_out_points,
             original_entry_id)
    `;
  }

  /**
   * 补记侧的日拆分 + 日上限分配。
   *
   * 🔴 **基线必须扣掉本次冲回**,否则日上限会按"旧账还在"来分配:
   *    旧账当日已记满 3 分、更正后仍应是 3 分 —— 不扣冲回的话余额算成 0,
   *    补记全部落进 `cappedOutPoints`,队员当天凭空少 3 分,而账面处处自洽。
   *    这是本刀最隐蔽的一处,判据见 e2e「满额更正后仍是满额」。
   */
  private async buildReplacementDayRows(
    tx: PrismaTx,
    resolved: readonly ResolvedResult[],
    changeSet: CorrectionChangeSet,
    originals: readonly OriginalEntryRow[],
  ): Promise<ReplacementDayRow[]> {
    const spansByIdentity = await this.readWeightBearingSpans(
      tx,
      resolved.map((row) => row.participationIdentityId),
      changeSet,
    );

    const rows: ReplacementDayRow[] = [];
    for (const result of resolved) {
      const outcome = splitRecognizedIntoDays({
        spans: spansByIdentity.get(result.participationIdentityId) ?? [],
        recognizedServiceHours: result.recognizedServiceHours,
        recognizedContributionPoints: result.recognizedContributionPoints,
        stableOrderKey: `${result.sessionId}:${result.participationIdentityId}`,
      });
      // 有认定值却一天都归不上 ⇒ 拒绝。**不猜日期**(与第五刀同一处置,复用同码)。
      if (outcome.kind === 'no_service_day') {
        throw new BizException(BizCode.LEDGER_PREPARE_DAY_SPLIT_UNRESOLVED);
      }
      for (const row of outcome.rows) {
        rows.push({
          resultRevisionId: result.newResultRevisionId,
          memberId: result.memberId,
          sessionId: result.sessionId,
          participationIdentityId: result.participationIdentityId,
          ledgerDate: toDateOnlyText(row.ledgerDate),
          serviceHours: row.serviceHours,
          recognizedPoints: row.recognizedPoints,
          creditedPoints: 0,
          cappedOutPoints: 0,
          sequenceStartAt: row.sequenceStartAt,
          stableOrderKey: row.stableOrderKey,
        });
      }
    }

    // 冲回释放出来的当日额度,按 (member, date) 汇总。
    const reversedByKey = new Map<string, number>();
    for (const original of originals) {
      const key = ledgerBaselineKey(original.memberId, original.ledgerDate);
      reversedByKey.set(
        key,
        (reversedByKey.get(key) ?? 0) + decimalToHundredths(original.creditedPointsDelta),
      );
    }

    const baselineByKey = await this.readCommittedDayTotals(tx, rows);
    const byMemberDate = new Map<string, ReplacementDayRow[]>();
    for (const row of rows) {
      const key = ledgerBaselineKey(row.memberId, row.ledgerDate);
      const bucket = byMemberDate.get(key);
      if (bucket === undefined) byMemberDate.set(key, [row]);
      else bucket.push(row);
    }
    for (const [key, bucket] of byMemberDate) {
      const prior = (baselineByKey.get(key) ?? 0) - (reversedByKey.get(key) ?? 0);
      const allocations = allocateDailyCredit(bucket, fromHundredths(prior));
      bucket.forEach((row, index) => {
        row.creditedPoints = allocations[index].creditedPoints;
        row.cappedOutPoints = allocations[index].cappedOutPoints;
      });
    }
    return rows;
  }

  /**
   * 参与日拆分权重的服务段,**叠加本次变更集**。
   *
   * ⚠️ 叠加在**内存里**做,不依赖"旧段已经被翻成 superseded" —— 旧段的投影要等
   *    commit 事务(§5.14 ⑥),而这里是准备阶段。同 `segmentKey` 的旧段被变更集
   *    覆盖(替换,不是叠加),未被点名的段原样保留。
   */
  private async readWeightBearingSpans(
    tx: PrismaTx,
    identityIds: readonly string[],
    changeSet: CorrectionChangeSet,
  ): Promise<Map<string, LedgerServiceSpan[]>> {
    const byIdentity = new Map<string, LedgerServiceSpan[]>();
    if (identityIds.length === 0) return byIdentity;

    const overrideByKey = new Map<string, CorrectionSegmentChange>();
    for (const change of changeSet.segments) {
      overrideByKey.set(`${change.participationIdentityId}|${change.segmentKey}`, change);
    }

    const existing = await tx.participantServiceSegmentRevision.findMany({
      where: {
        participationIdentityId: { in: [...identityIds] },
        statusCode: { not: 'superseded' },
      },
      select: {
        participationIdentityId: true,
        segmentKey: true,
        revision: true,
        resultCode: true,
        checkInAt: true,
        checkOutAt: true,
      },
      orderBy: [{ checkInAt: 'asc' }, { revision: 'asc' }, { id: 'asc' }],
    });

    // 同 (identity, segmentKey) 只取**最新一版**(准备阶段可能已经追加了新版)。
    const latestByKey = new Map<
      string,
      {
        participationIdentityId: string;
        resultCode: string;
        checkInAt: Date;
        checkOutAt: Date | null;
      }
    >();
    for (const row of existing) {
      latestByKey.set(`${row.participationIdentityId}|${row.segmentKey}`, row);
    }
    for (const [key, change] of overrideByKey) {
      latestByKey.set(key, {
        participationIdentityId: change.participationIdentityId,
        resultCode: change.resultCode,
        checkInAt: change.checkInAt,
        checkOutAt: change.checkOutAt,
      });
    }

    for (const row of latestByKey.values()) {
      if (!WEIGHT_BEARING_SEGMENT_RESULT_CODES.includes(row.resultCode)) continue;
      const bucket = byIdentity.get(row.participationIdentityId);
      const span = { startAt: row.checkInAt, endAt: row.checkOutAt };
      if (bucket === undefined) byIdentity.set(row.participationIdentityId, [span]);
      else bucket.push(span);
    }
    for (const bucket of byIdentity.values()) {
      bucket.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    }
    return byIdentity;
  }

  private async readCommittedDayTotals(
    tx: PrismaTx,
    rows: readonly ReplacementDayRow[],
  ): Promise<Map<string, number>> {
    const totals = new Map<string, number>();
    if (rows.length === 0) return totals;
    const existing = await tx.$queryRaw<
      Array<{ memberId: string; ledgerDate: string; credited: string }>
    >`
      SELECT d."memberId", to_char(d."ledgerDate", 'YYYY-MM-DD') AS "ledgerDate",
             d."committedCreditedPoints"::text AS credited
      FROM "MemberContributionDayState" d
      JOIN unnest(
        ${rows.map((row) => row.memberId)}::text[],
        ${rows.map((row) => row.ledgerDate)}::text[]
      ) AS t(member_id, ledger_date)
        ON d."memberId" = t.member_id AND d."ledgerDate" = t.ledger_date::date
    `;
    for (const row of existing) {
      totals.set(
        ledgerBaselineKey(row.memberId, row.ledgerDate),
        decimalToHundredths(row.credited),
      );
    }
    return totals;
  }

  private async writeReplacementDays(
    tx: PrismaTx,
    rows: readonly ReplacementDayRow[],
  ): Promise<void> {
    if (rows.length === 0) return;
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
  }

  /** 补记分录:与第五刀 `writeLedgerEntries` **同一形状**(每个日行两条 credit)。 */
  private async writeReplacementEntries(
    tx: PrismaTx,
    batchId: string,
    activityId: string,
    requestHash: string,
    rows: readonly ReplacementDayRow[],
  ): Promise<number> {
    const entries = rows.flatMap((row) => [
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
      (entry) => `${batchId}:${entry.resultRevisionId}:${entry.ledgerDate}:${entry.entryTypeCode}`,
    );
    return await tx.$executeRaw`
      INSERT INTO "ParticipationLedgerEntry" (
        "id", "createdAt", "postingBatchId", "entryKey", "operationKey", "requestHash",
        "memberId", "activityId", "sessionId", "participationIdentityId", "resultRevisionId",
        "ledgerDate", "entryTypeCode",
        "serviceHoursDelta", "recognizedPointsDelta", "creditedPointsDelta", "cappedOutPointsDelta"
      )
      SELECT gen_random_uuid()::text, NOW(), ${batchId}, t.entry_key,
             'correction-replacement:' || t.entry_key, ${requestHash},
             t.member_id, ${activityId}, t.session_id, t.identity_id,
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
    `;
  }

  /** 基线 = 本批次覆盖的全部 (member, date) 的**当前** day-state(冲回侧 ∪ 补记侧)。 */
  private async readDayStateBaseline(
    tx: PrismaTx,
    originals: readonly OriginalEntryRow[],
    replacements: readonly ReplacementDayRow[],
  ): Promise<LedgerDayStateBaseline> {
    const pairs = new Map<string, { memberId: string; ledgerDate: string }>();
    for (const row of originals) {
      pairs.set(ledgerBaselineKey(row.memberId, row.ledgerDate), {
        memberId: row.memberId,
        ledgerDate: row.ledgerDate,
      });
    }
    for (const row of replacements) {
      pairs.set(ledgerBaselineKey(row.memberId, row.ledgerDate), {
        memberId: row.memberId,
        ledgerDate: row.ledgerDate,
      });
    }
    const baseline: LedgerDayStateBaseline = {};
    if (pairs.size === 0) return baseline;
    const list = [...pairs.values()];
    const existing = await tx.$queryRaw<
      Array<{ memberId: string; ledgerDate: string; version: number; credited: string }>
    >`
      SELECT d."memberId", to_char(d."ledgerDate", 'YYYY-MM-DD') AS "ledgerDate",
             d.version, d."committedCreditedPoints"::text AS credited
      FROM "MemberContributionDayState" d
      JOIN unnest(
        ${list.map((pair) => pair.memberId)}::text[],
        ${list.map((pair) => pair.ledgerDate)}::text[]
      ) AS t(member_id, ledger_date)
        ON d."memberId" = t.member_id AND d."ledgerDate" = t.ledger_date::date
    `;
    const found = new Map(
      existing.map((row) => [
        ledgerBaselineKey(row.memberId, row.ledgerDate),
        ledgerBaselineValue(row.version, decimalToHundredths(row.credited)),
      ]),
    );
    for (const key of pairs.keys()) {
      // 行不存在时记 `0:0` —— 与第五刀 `readDayStateBaseline` 逐字同一口径。
      baseline[key] = found.get(key) ?? ledgerBaselineValue(0, 0);
    }
    return baseline;
  }

  /**
   * 第五刀 `readPreparedBaseline` 只认 `settlement_prepare:<batchId>` 这一个 operationKey
   * 且要求 `statusCode='succeeded'`。本刀**沿用同一份格式**,不改它的读法。
   *
   * ⚠️ `statusCode` 直接写 `succeeded`(而不是 pending→processing→succeeded 走一遍):
   *    更正的准备是**一个事务里做完的**,没有分块;留一个 `pending` 的 job 只会让
   *    第六刀关账的第 ③ 类「未完成批量任务」把重新关账永久堵死。
   */
  private async createPrepareJob(
    tx: PrismaTx,
    args: {
      activityId: string;
      newVersionId: string;
      batchId: string;
      requestHash: string;
      baseline: LedgerDayStateBaseline;
      actorUserId: string;
    },
  ): Promise<void> {
    const now = new Date();
    await tx.activityBatchJob.create({
      data: {
        jobTypeCode: LEDGER_PREPARE_JOB_TYPE,
        activityId: args.activityId,
        settlementVersionId: args.newVersionId,
        postingBatchId: args.batchId,
        statusCode: 'succeeded',
        operationKey: `${LEDGER_PREPARE_JOB_TYPE}:${args.batchId}`,
        requestHash: args.requestHash,
        payloadVersion: 1,
        payload: {
          postingBatchId: args.batchId,
          correction: true,
          [LEDGER_BASELINE_PAYLOAD_KEY]: args.baseline,
        },
        total: 1,
        succeeded: 1,
        createdByUserId: args.actorUserId,
        startedAt: now,
        completedAt: now,
      },
    });
  }

  /** §5.14 ⑥「旧 active closure superseded」。partial unique 保证至多一条。 */
  private async supersedeActiveClosure(
    tx: PrismaTx,
    activityId: string,
    correctionRequestId: string,
  ): Promise<number | null> {
    const active = await this.readActiveClosure(tx, activityId);
    if (active === null) return null;
    await tx.activitySettlementClosureRevision.update({
      where: { id: active.id },
      data: {
        statusCode: 'superseded',
        supersededAt: new Date(),
        supersededByCorrectionId: correctionRequestId,
      },
    });
    return active.revision;
  }
}

// ===== 纯辅助 =============================================================

/**
 * 准备阶段发现基础版本漂移时的内部信号。
 *
 * 🔴 它**不是** BizException:置 voided 必须落库,而抛 BizException 会连同那次写一起
 *    回滚。故准备事务先抛本信号让事务干净回滚,再在事务外把 voided 写下去,最后翻成
 *    20105 抛给调用方。
 */
class CorrectionBaseDriftSignal extends Error {
  constructor(readonly correctionRequestId: string) {
    super(`更正申请 ${correctionRequestId} 的基础版本已变化`);
    this.name = 'CorrectionBaseDriftSignal';
  }
}

function toSubmitResult(request: LockedRequest): Omit<CorrectionSubmitResult, 'replayed'> {
  return {
    correctionRequestId: request.id,
    activityId: request.activityId,
    settlementRunId: request.settlementRunId,
    baseSettlementVersionId: request.baseSettlementVersionId,
    baseResultRevisionId: request.baseResultRevisionId,
    baseClosureRevision: request.baseClosureRevision,
    statusCode: request.statusCode,
  };
}

/**
 * 基础结果 + 变更集 → 新结果的**目标取值**。
 *
 * 未被点名的人**逐字沿用**基础值(只换版本与前驱指针)—— 见
 * `createNewResultRevisions` 的注释:整份复制是重新关账能成功的前提。
 */
function resolveNewResults(
  baseResults: readonly BaseResultRow[],
  changeSet: CorrectionChangeSet,
): ResolvedResult[] {
  const changeByIdentity = new Map(
    changeSet.results.map((row) => [row.participationIdentityId, row]),
  );
  return baseResults.map((base) => {
    const change = changeByIdentity.get(base.participationIdentityId);
    return {
      participationIdentityId: base.participationIdentityId,
      baseResultRevisionId: base.id,
      baseRevision: base.revision,
      memberId: base.memberId,
      sessionId: base.sessionId,
      resultCode: change?.resultCode ?? base.resultCode,
      lateFlag: change?.lateFlag ?? base.lateFlag,
      earlyLeaveFlag: change?.earlyLeaveFlag ?? base.earlyLeaveFlag,
      exceptionFlagsJson: base.exceptionFlagsJson,
      recognizedServiceHours:
        change?.recognizedServiceHours ?? Number(base.recognizedServiceHours.toString()),
      recognizedContributionPoints:
        change?.recognizedContributionPoints ??
        Number(base.recognizedContributionPoints.toString()),
      // 「计算值」是机器算出来的事实,更正改的是**认定值** —— 逐字沿用,不动。
      calculatedServiceHours: decimalToCanonicalString(base.calculatedServiceHours),
      calculatedContributionPoints: decimalToCanonicalString(base.calculatedContributionPoints),
      adjustmentReason: change === undefined ? base.adjustmentReason : change.adjustmentReason,
      newResultRevisionId: '',
    };
  });
}

function replayCommitResult(
  activityId: string,
  request: LockedRequest,
  application: { id: string; statusCode: string; newPostingBatchId: string },
): CorrectionCommitResult {
  return {
    correctionRequestId: request.id,
    correctionApplicationId: application.id,
    activityId,
    ledger: {
      postingBatchId: application.newPostingBatchId,
      activityId,
      settlementRunId: request.settlementRunId,
      settlementVersionId: '',
      settlementVersion: 0,
      batchStatus: 'committed',
      runStatus: 'posted',
      memberCount: 0,
      dayStateCount: 0,
      entryCount: 0,
      committedAt: null,
      replayed: true,
    },
    supersededResultRevisionCount: 0,
    supersededSegmentRevisionCount: 0,
    supersededClosureRevision: null,
    activityClosurePointerCleared: true,
    correctionStatus: request.statusCode,
    applicationStatus: application.statusCode,
    replayed: true,
  };
}

/** PostgreSQL 23505 = unique_violation。裸 SQL 走 P2010,Prisma 客户端走 P2002,两条都认。 */
function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return true;
  const meta = (error as { meta?: { code?: unknown } } | null)?.meta;
  if (meta !== undefined && meta !== null && String(meta.code) === '23505') return true;
  const text = error instanceof Error ? error.message : String(error);
  return text.includes('23505');
}
