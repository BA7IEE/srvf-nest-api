// ===== 活动改造 v1.1 第 2 批第七刀:更正审核的人员隔离(合同 §7.5,纯函数)=====
//
// 🔴 合同 §7.5 逐字:「Correction review:request submitter != reviewer;
//    **若更正由原结算提交人提出仍适用**。」
//
// ## 后半句在守什么(它不是废话)
//
// 前半句单独看已经够用了。后半句存在的理由是**堵一条很自然的想当然**:
// 结算版本的提交人是这场活动账目的"作者",最了解哪里算错了 —— 于是很容易出现
// 「他自己提的更正、自己批」这种"反正他最清楚"的口子。§7.5 明确说**不给这个豁免**。
//
// ⇒ 本模块只实现**一条**判据(操作人 ≠ 申请提交人),并由 e2e 用
//   **「原结算提交人提更正、再由他自己审」**这个具体场景 red-first 钉住它 ——
//   那正是后半句点名的形态。
// ❌ **不**顺手加"审核人 ≠ 原结算版本提交人":合同没有这一条。多加一条看似更安全,
//    实际会把"合同要求"与"我们自己加码"混成一堆,日后没人分得清哪条能改。
//    (沿本仓「合同没给的不发明」;若维护者要加严,那是一次独立拍板。)
//
// ## 为什么是纯函数,而不是 `ActionConstraint`
//
// 与第四刀 `settlement-review-separation.ts` 完全同一处置,理由逐字相同:
// 本刀**零端点 / 零权限码**,而 `ActionConstraint` 的键就是 action(权限码)字符串
// —— 没有 action 就没有注册点,编一个此刻无人调用的 action 只会得到一条**永远不被
// 触发**的约束(「描述文本冒充执行位」,本仓栽过四次)。且 `src/modules/authz/**`
// 是本刀红区。⇒ 入口层留到第 ⑧ 刀,本刀落**锁后层**,并在报告里作为显式偏离列明。
//
// ## 判定所依据的事实必须是**行锁之后重读**的值
//
// 入口处那一次读到的 `submittedByUserId` 可能在等锁期间被改掉(更正申请可以被撤回后
// 由别人重提)。本函数只是纯判定,调用方有责任传锁后的值 —— 调用点写在
// `CorrectionApplicationService.review` 的 `FOR UPDATE` 之后,不在别处。

/** 违例种类。目前恰好一种 —— 一种就一个具名 BizCode,不留兜底码。 */
export type CorrectionReviewSeparationViolation =
  /** 操作人就是更正申请的提交人(自提自审)。 */
  'self_correction_review';

export interface CorrectionReviewSeparationFacts {
  /**
   * 更正申请的提交人(`AttendanceCorrectionRequest.submittedByUserId`)。
   *
   * ⚠️ Prisma 上可空(沿本仓 actor FK 一律可空的既有范式),但 FK 是 `onDelete: Restrict`
   *    ⇒ 有值之后不可能被删成 null;而写入方(本刀 `submit`)恒传 `currentUser.id`。
   *    **故 null 分支结构上不可达**,不是漏判的放行口 —— 留它只是类型诚实
   *    (与第四刀 `submittedByUserId` 的同一处置)。
   */
  readonly submittedByUserId: string | null;
}

export function evaluateCorrectionReviewSeparation(
  facts: CorrectionReviewSeparationFacts,
  actorUserId: string,
): CorrectionReviewSeparationViolation | null {
  if (facts.submittedByUserId === actorUserId) return 'self_correction_review';
  return null;
}
