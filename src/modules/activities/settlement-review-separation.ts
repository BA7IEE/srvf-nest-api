// ===== 活动改造 v1.1 第 2 批第四刀:提交人 / 一审人 / 终审人三方分离(合同 §3.19)=====
//
// 🔴 **这是本刀守的那件事**:隔离漏一条,自提自审就成立 —— 合同 §4.1 与修订说明把
//    它列为一级阻断的同一类问题。所以这里的每一条都走**拒绝**,没有"警告后放行"。
//
// ## 两层均已落地
//
// 合同 §3.19 明写「Authz action constraint **和**事务内锁后复判提交人／一审人／
// 终审人分离」—— 两层都要，且必须判同一件事:
//
//   - **入口层** = `authz/action-constraints.ts` 的两条注册：
//     `activity.settlement-first-review.record` → `selfApprovalForbidden`；
//     `activity.settlement-final-review.record` → `selfApprovalForbidden` +
//     `sameReviewerForbidden`。第 ⑩ 刀以请求中的精确 `AttendanceSettlementVersion`
//     resource 解析 `createdByUserId / first reviewer`，故 approve 与 return 共用 action
//     时也同时受约束。
//   - **锁后层** = 本纯函数，由 `SettlementReviewService` 在事务内、版本行锁之后用
//     当前行事实再判一次。入口快照在并发换版/一审落地期间可能过时，不能替代它。
//
// ⇒ 两层均已落地，入口层见 `authz/action-constraints.ts` 的两条注册；两层各自有
// `activity-batch2-10-action-constraints.e2e-spec.ts` 的短路探针，不能互相冒充执行位。
//
// ## 判定语义:逐字沿用考勤那一套,不另立一套
//
// `attendances.service.ts::assertLockedReviewSeparation` 的三条:
//   - 一审:操作人 == 提交人 ⇒ 拒;
//   - 终审:操作人 == 提交人 ⇒ 拒;
//   - 终审:操作人 == 一审人 ⇒ 拒。
// 逐条对应本文件三条,连"某一方为 null 时不否决"的口径都一致
// (考勤的 `lastSubmittedByUserId` 可空,null 与任何 actor id 都不相等 ⇒ 放行)。
//
// ⚠️ 本刀里 `submittedByUserId` 取自 `AttendanceSettlementVersion.createdByUserId`。
//    它在 Prisma 上可空(沿本仓 actor FK 一律可空的既有范式),但 **FK 是
//    `onDelete: Restrict`** ⇒ 有值之后不可能被删成 null;而写入方(第三刀
//    `createSubmittedVersion`)恒传 `currentUser.id`。**故 null 分支结构上不可达**,
//    不是"漏判的放行口"。留 null 分支只是类型诚实。
//
// ## 三条判据必须**互不重叠**(goal DoD 3)
//
// 写法上刻意让每一条只在自己的 (stage, 字段) 组合上成立:
//   - 第 1 条只在 `stage==='first'` 触发;
//   - 第 2、3 条只在 `stage==='final'` 触发,且分别读**不同的字段**
//     (提交人 / 一审人)。
// ⇒ 卸掉任何一条,只有它对应的那一条用例会红(红集矩阵见报告)。
// ❌ 不得把它们合并成 `actor ∈ {submitter, firstReviewer}` 之类的集合判定 ——
//    那样卸一条就同时放行两条,红集立刻重叠,"哪一条没执法位"就再也读不出来。

/** 三方分离的违例种类。每一种在 service 层一一对应一个具名 BizCode。 */
export type SettlementReviewSeparationViolation =
  /** 一审:操作人就是提交人(自提自审)。 */
  | 'self_first_review'
  /** 终审:操作人就是提交人(自提自终审)。 */
  | 'self_final_review'
  /** 终审:操作人就是一审人(同人两审)。 */
  | 'same_reviewer';

export type SettlementReviewStage = 'first' | 'final';

/** 判定所依据的事实。**必须是行锁之后重读的值**,不是入口处那一次读的值。 */
export interface SettlementReviewSeparationFacts {
  /** 被审版本的提交人(`AttendanceSettlementVersion.createdByUserId`)。 */
  submittedByUserId: string | null;
  /** 本版本一审阶段已生效动作的操作人;尚未一审时为 null。 */
  firstReviewerUserId: string | null;
}

export function evaluateSettlementReviewSeparation(
  stage: SettlementReviewStage,
  facts: SettlementReviewSeparationFacts,
  actorUserId: string,
): SettlementReviewSeparationViolation | null {
  // ① 提交人 ≠ 一审人。
  if (stage === 'first' && facts.submittedByUserId === actorUserId) {
    return 'self_first_review';
  }
  // ② 提交人 ≠ 终审人。
  if (stage === 'final' && facts.submittedByUserId === actorUserId) {
    return 'self_final_review';
  }
  // ③ 一审人 ≠ 终审人。
  if (stage === 'final' && facts.firstReviewerUserId === actorUserId) {
    return 'same_reviewer';
  }
  return null;
}
