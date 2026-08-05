import { createHash } from 'node:crypto';

import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';

// ===== 活动改造 v1.1 第 2 批第六刀:机器关账的**判定层**(合同 §5.15 ④–⑨ + §3.26)=====
//
// 🔴 **关账是"这场活动的账算完了"的唯一权威**(合同 §1.2 把它从「负责人声明」改成
//    机器检查)。它的失败模式不是报错,是**悄悄关掉一场没算完的活动** —— 之后所有
//    统计、评价资格、入队进度都会读这张 closure,而维护者看不懂代码、发现不了。
//
// 本文件刻意**没有 DB、没有时钟、没有随机**:全部输入是一组整数计数,输出是
// 缺口清单 / checksJson / checksHash。这样 `activity-closure-checks.spec.ts` 能把
// 「哪一类由哪几项计数决定」逐条钉死,而不必起库。取数在 service 里,判定在这里。
//
// ## 为什么是「返回缺口清单」而不是「抛第一个错」
//
// §5.15 ⑫ 逐字:「任一失败返回**结构化缺口码和数量**,不写半张 closure」;
// 业务 §9.2 更具体:「30 人报名通过、0 打卡、0 人员结果时……必须拒绝关闭,并**清楚
// 提示 30 个队员×场次尚未处理**」。⇒ 光说"关账失败"等于把排查成本原样推给一个
// 看不懂代码的人。故:**八类全跑、不 fail-fast**,一次把所有缺口交出去
// (合同 §6 的关账页要渲染的正是这份清单)。
//
// ## 八类是怎么来的(不是自作主张)
//
// §5.15 的 ④⑤⑥⑦⑧⑨ 是六步,但 ③「重读 Execution 状态、sessions、EvidenceState、
// active EvidenceSeal」在业务 §9.2 里是**两道独立硬检查**(① 已自然结束或正式提前终止;
// ② 打卡窗口已关闭、当前证据版本已封场)。合并成一个码会让"哪一道没有执法位"
// 再也读不出来 —— 沿 20062-20064(三方分离三条各一码)的同一理由拆开。⇒ 2 + 6 = 八类。
//
// ## `count` 与 `details` 的口径(写死,免得日后被理解成别的意思)
//
//   - `details` = 本类**逐项**失败计数,键是稳定英文标识,值是非负整数;
//   - `count`   = `details` 全部值之和。布尔型判据(如"活动还没结束")以 0/1 计入。
// ⇒ `count > 0` ⟺ 本类不通过。两者都进 `checksJson`,页面直接渲染。

/** 八类缺口的稳定机器标识。**不随 BizCode 段位调整而变** —— 页面与 checksJson 都认它。 */
export type ActivityClosureGapCode =
  | 'execution_not_ended'
  | 'evidence_not_sealed'
  | 'pending_work_exists'
  | 'participation_unresolved'
  | 'settlement_incomplete'
  | 'result_inconsistent'
  | 'ledger_incomplete'
  | 'closure_already_active';

/** 一类缺口的对外形态(§5.15 ⑫「结构化缺口码和数量」)。 */
export interface ActivityClosureGap {
  gapCode: ActivityClosureGapCode;
  /** 对应 BizCode 的数值码,页面据此定位文案与帮助。 */
  bizCode: number;
  message: string;
  /** 本类失败项计数之和;恒 > 0(通过的类不会出现在缺口清单里)。 */
  count: number;
  /** 逐项拆解。⚠️ 只放**计数**,不放任何人员明细(§3.26)。 */
  details: Readonly<Record<string, number>>;
}

/** 每一类在 checksJson 里的摘要(通过的类也留一行 —— 「查过了且是 0」本身是证据)。 */
export interface ActivityClosureCheckSummary {
  gapCode: ActivityClosureGapCode;
  bizCode: number;
  passed: boolean;
  count: number;
  details: Readonly<Record<string, number>>;
}

/** 八类 → BizCode。**一一对应,没有一条落到兜底码上**(那等于没具名)。 */
const GAP_BIZ_CODE: Readonly<Record<ActivityClosureGapCode, BizCodeEntry>> = {
  execution_not_ended: BizCode.ACTIVITY_CLOSURE_EXECUTION_NOT_ENDED,
  evidence_not_sealed: BizCode.ACTIVITY_CLOSURE_EVIDENCE_NOT_SEALED,
  pending_work_exists: BizCode.ACTIVITY_CLOSURE_PENDING_WORK_EXISTS,
  participation_unresolved: BizCode.ACTIVITY_CLOSURE_PARTICIPATION_UNRESOLVED,
  settlement_incomplete: BizCode.ACTIVITY_CLOSURE_SETTLEMENT_INCOMPLETE,
  result_inconsistent: BizCode.ACTIVITY_CLOSURE_RESULT_INCONSISTENT,
  ledger_incomplete: BizCode.ACTIVITY_CLOSURE_LEDGER_INCOMPLETE,
  closure_already_active: BizCode.ACTIVITY_CLOSURE_ALREADY_ACTIVE,
};

/**
 * 八类的**顺序**(缺口清单与 checksJson 都按它排)。
 *
 * 顺序 = 合同 §5.15 的步骤顺序,不是重要性排序。固定顺序让 `checksHash` 稳定:
 * 同样的事实必然得到同样的 hash(沿第一刀 `EvidenceSeal.contentHash` 的 canonical 立场)。
 */
export const ACTIVITY_CLOSURE_GAP_ORDER: readonly ActivityClosureGapCode[] = [
  'execution_not_ended',
  'evidence_not_sealed',
  'pending_work_exists',
  'participation_unresolved',
  'settlement_incomplete',
  'result_inconsistent',
  'ledger_incomplete',
  'closure_already_active',
];

/**
 * 八类的逐项计数。**每一个字段都必须由 service 真查一次**(没有默认值可依赖)。
 *
 * 字段顺序 = 进 `details` 的顺序 = 进 `checksHash` 的顺序。
 */
export interface ActivityClosureCheckCounts {
  /** ① §5.15 ③ 前半 / §9.2 ①:活动已自然结束或正式提前终止。 */
  readonly execution: {
    /** 尚未到计划结束时刻、且没有正式提前终止事实。 */
    readonly notEnded: number;
    /** 普通取消的活动进"取消收口",不伪造服务结算(§9.2 ①)。 */
    readonly cancelled: number;
  };
  /** ② §5.15 ③ 后半 / §9.2 ②:当前证据版本已封场。 */
  readonly evidence: {
    readonly missingActiveSeal: number;
    /** seal 上的三个 revision 与当前值不吻合 ⇒ 封场后世界又变了。 */
    readonly staleSeal: number;
  };
  /** ③ §5.15 ④ / §9.2 ③④⑤:五项待办。 */
  readonly pendingWork: {
    readonly pendingChangeReview: number;
    readonly pendingCorrection: number;
    readonly manualReviewPending: number;
    readonly openSegment: number;
    readonly unfinishedJob: number;
  };
  /** ④ §5.15 ⑤ / §9.2 ⑥:报名 / 邀请终态 + 与 population 一一对应。 */
  readonly participation: {
    readonly nonTerminalRegistration: number;
    readonly pendingInvitation: number;
    readonly unresolvedIdentity: number;
    /** 在人口里、但当前状态并不是"参与中/已参与"⇒ 人口与状态自相矛盾。 */
    readonly populationIdentityNotParticipating: number;
    /** 状态说参与、却不在人口里 ⇒ 「一一对应」的另一侧。 */
    readonly participatingIdentityOutOfPopulation: number;
    /** 报名已终态且属参与类,却一个场次身份都没有。 */
    readonly participatingRegistrationWithoutIdentity: number;
  };
  /** ⑤ §5.15 ⑥ / §9.2 ⑦⑨:posted 版本覆盖全部人口,result 数量唯一。 */
  readonly settlement: {
    readonly runNotPosted: number;
    readonly postedVersionMissing: number;
    /** ⭐ §9.2 那句「30 个队员×场次尚未处理」就是这一项。 */
    readonly populationWithoutResult: number;
    readonly resultOutOfPopulation: number;
    readonly uncommittedResult: number;
  };
  /** ⑥ §5.15 ⑦ / §9.2 ⑧:服务结果 / 零时长结果 / 标签一致。 */
  readonly resultConsistency: {
    readonly presentWithoutSegment: number;
    readonly zeroResultWithNonZeroTotals: number;
    readonly flagMismatch: number;
    readonly earlyDepartureFlagMissing: number;
  };
  /** ⑦ §5.15 ⑧ / §9.2 ⑨⑩⑪:账本、日上限、重叠、对账。 */
  readonly ledger: {
    readonly committedBatchMissing: number;
    readonly entriesInUncommittedBatch: number;
    readonly resultWithoutLedgerEntry: number;
    readonly dayCapExceeded: number;
    readonly duplicatePosting: number;
    readonly overlappingSegment: number;
    readonly capacityReconciliationMismatch: number;
  };
  /** ⑧ §5.15 ⑨:没有 active closure。 */
  readonly closure: {
    readonly activeClosure: number;
  };
}

/** 每类取哪一组计数。**这张表是"八类互不重叠"的结构保证**(键集两两不交)。 */
function detailsOf(
  counts: ActivityClosureCheckCounts,
  gapCode: ActivityClosureGapCode,
): Readonly<Record<string, number>> {
  switch (gapCode) {
    case 'execution_not_ended':
      return counts.execution;
    case 'evidence_not_sealed':
      return counts.evidence;
    case 'pending_work_exists':
      return counts.pendingWork;
    case 'participation_unresolved':
      return counts.participation;
    case 'settlement_incomplete':
      return counts.settlement;
    case 'result_inconsistent':
      return counts.resultConsistency;
    case 'ledger_incomplete':
      return counts.ledger;
    case 'closure_already_active':
      return counts.closure;
  }
}

/** `details` 全部值之和。布尔型判据以 0/1 计入(见文件头口径声明)。 */
function sumDetails(details: Readonly<Record<string, number>>): number {
  return Object.values(details).reduce((total, value) => total + value, 0);
}

/** 八类逐类摘要(通过的也在内)。顺序恒为 `ACTIVITY_CLOSURE_GAP_ORDER`。 */
export function summarizeClosureChecks(
  counts: ActivityClosureCheckCounts,
): ActivityClosureCheckSummary[] {
  return ACTIVITY_CLOSURE_GAP_ORDER.map((gapCode) => {
    const details = detailsOf(counts, gapCode);
    const count = sumDetails(details);
    return { gapCode, bizCode: GAP_BIZ_CODE[gapCode].code, passed: count === 0, count, details };
  });
}

/** 只保留不通过的类 ⇒ §5.15 ⑫ 的「结构化缺口码和数量」。空数组 = 十二步可以往下走。 */
export function collectClosureGaps(counts: ActivityClosureCheckCounts): ActivityClosureGap[] {
  return summarizeClosureChecks(counts)
    .filter((summary) => !summary.passed)
    .map((summary) => ({
      gapCode: summary.gapCode,
      bizCode: summary.bizCode,
      message: GAP_BIZ_CODE[summary.gapCode].message,
      count: summary.count,
      details: summary.details,
    }));
}

/** 关账那一刻的人数与金额摘要(§3.26 的五个摘要列)。 */
export interface ActivityClosureTotals {
  readonly personCount: number;
  readonly sessionParticipationCount: number;
  /** `{ present: 3, leave: 1, … }` —— 按 resultCode 的**计数**,不含任何人员明细。 */
  readonly resultCountsJson: Readonly<Record<string, number>>;
  readonly serviceHours: string;
  readonly contributionPoints: string;
}

/**
 * §3.26 `checksJson`:「**仅保存非敏感摘要和失败计数,不复制人员明细**」。
 *
 * 🔴 这句话是本文件的硬边界:下面这个对象里**只有**数字、稳定英文标识、版本号与
 *    幂等键。❌ 没有 memberId / 姓名 / 手机号 / 坐标 / identityId / 任何逐人条目。
 *    判据是 e2e 里一条按结构扫描的断言(`JSON.stringify(checksJson)` 不含这些字段名
 *    与本次夹具的样本值),不是"作者保证"。
 *
 * ⚠️ `idempotency` 进 checksJson 是**与合同的显式偏离**:§5.15 ② 要求按
 *    `operationKey + requestHash` 防重,而 §3.26 的字段表**没给这两列**
 *    (合同内部不一致,已作为新 finding 上报)。本刀零 schema ⇒ 幂等键只能存在这里,
 *    去重域因此是 (activityId, operationKey),正确性来自 Activity 行锁而非 DB unique。
 *    两者都不是人员明细,不违反上面那条硬边界。
 */
export interface ActivityClosureChecksJson {
  readonly schemaVersion: 1;
  readonly idempotency: { readonly operationKey: string; readonly requestHash: string };
  readonly checks: readonly ActivityClosureCheckSummary[];
  readonly totals: ActivityClosureTotals;
  readonly failedClassCount: number;
  readonly failureCount: number;
}

export function buildClosureChecksJson(input: {
  counts: ActivityClosureCheckCounts;
  totals: ActivityClosureTotals;
  operationKey: string;
  requestHash: string;
}): ActivityClosureChecksJson {
  const checks = summarizeClosureChecks(input.counts);
  return {
    schemaVersion: 1,
    idempotency: { operationKey: input.operationKey, requestHash: input.requestHash },
    checks,
    totals: input.totals,
    failedClassCount: checks.filter((check) => !check.passed).length,
    failureCount: checks.reduce((total, check) => total + check.count, 0),
  };
}

/**
 * §3.26 `checksHash`。
 *
 * key 顺序全部写死在字面量与 `ACTIVITY_CLOSURE_GAP_ORDER` 里 ⇒ 同样的事实必然得到
 * 同样的 hash(沿第一刀 `EvidenceSeal.contentHash` 的 canonical 立场:漂移一位就等于
 * 这张关闭凭证再也没法与另一次关账比对)。
 */
export function computeClosureChecksHash(checksJson: ActivityClosureChecksJson): string {
  return createHash('sha256').update(JSON.stringify(checksJson), 'utf8').digest('hex');
}
