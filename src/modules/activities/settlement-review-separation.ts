// ===== 活动改造 v1.1 第 2 批第四刀:提交人 / 一审人 / 终审人三方分离(合同 §3.19)=====
//
// 🔴 **这是本刀守的那件事**:隔离漏一条,自提自审就成立 —— 合同 §4.1 与修订说明把
//    它列为一级阻断的同一类问题。所以这里的每一条都走**拒绝**,没有"警告后放行"。
//
// ## 为什么是纯函数,而不是又一个 `ActionConstraint`
//
// 仓内既有的三审隔离(考勤)是**两层**,不是一层:
//
//   - **入口层** = `authz` 的 `ActionConstraint` 注册表(`attendance.final-approve.sheet`
//     等六个 action),在 `AuthzService.explain` 里、事务之外、按 `ResolvedResource`
//     判定;`attendances.service.ts` 把 `self_approval_forbidden` /
//     `same_reviewer_forbidden` 映射成 22074 / 22075(见该文件 :336 一线注释)。
//   - **锁后层** = 同文件 `assertLockedReviewSeparation`(:366):**事务内、行锁之后**
//     用当前行上的 `submitterUserId / lastSubmittedByUserId / reviewerUserId` 与
//     当前操作人**再判一次**,抛的是同一组码。
//
// 合同 §3.19 明写「Authz action constraint **和**事务内锁后复判提交人／一审人／
// 终审人分离」—— **两层都要**。本刀落的是**锁后层**,原因是硬的:
//
//   1. 本刀**零端点 / 零权限码**(与前三刀同,整条结算流程的对外入口留到第 2 批收尾),
//      而 `ActionConstraint` 的键**就是 action(权限码)字符串** —— 没有 action 就没有
//      注册点。给它编一个此刻无人调用的 action,注册表会返回一条**永远不被触发**的
//      约束:那是"描述文本冒充执行位",本仓栽过四次。
//   2. `ACTION_CONSTRAINTS` 与 `ResourceResolverService` 都在 `src/modules/authz/**`,
//      是本刀的**红区**(授权清单明列),不得改。
//
// ⇒ 入口层留到**开端点那一刀**接(那一刀本来就要新增 action 与权限码,注册点届时才
//    真实存在)。**本刀在报告里把这条列为显式偏离**,不假装两层都齐了。
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
