// ===== 活动改造 v1.1 第 2 批第七刀:更正 posting batch 的形状判据(纯函数)=====
//
// 🔴🔴 **这是"冲回与补记有没有配平"的全部判据。** 它放行一个残缺批次不会报错 ——
//    会安静地让队员的贡献值多一笔或少一笔,而维护者看不懂代码、发现不了。
//    因此本模块每一条都走**拒绝**,没有一处走"警告后放行"。
//
// ## 它长在哪儿:第五刀那道 `*_reversal` 闸的**更正侧分支**
//
// 第五刀 `LedgerPostingService.assertPreparedSetConsistent` 有一条
// `nonCreditCount !== 0 ⇒ 20089`(批次里出现任何 `*_reversal` 分录就拒绝生效),
// 并在文件末尾写明「等第 ⑥/⑦ 刀真的要写 reversal 时,那条判据会**当场变红**,
// 逼它在同一刀里把『service 锁后检查 + `LedgerEntryReversalClaim` unique』一起做出来,
// 而不是悄悄绕过」。
//
// 🔴 **本刀不是把那条闸拆掉,是给它划了适用范围**:
//   - **普通结算批次**(没有 `CorrectionApplication` 指向它)⇒ 判据**逐字不动**,
//     出现任何 `*_reversal` 仍然 20089;
//   - **更正批次**(有 `CorrectionApplication.newPostingBatchId` 指向它)⇒ 换成本模块
//     这套**更严**的配对判据:reversal 不但被允许,而且**必须**成对、必须等额、
//     必须有 claim、必须把旧账**全部**冲干净。
//
// 判别式取自 **DB 上的事实**(`CorrectionApplication` 行)而不是调用方传进来的 flag ——
// flag 是"调用方说自己是更正",事实是"确实有一份更正申请把这条批次登记成了自己的产物"。
// 前者可以被任何调用点伪造,后者不行。
//
// ## 三条判据必须**互不重叠**(goal 报告要的红集矩阵)
//
// 每一条只读**自己那几个计数**,彼此不共享中间量:
//   ① `replacement_missing` 只看**补记侧**(credit 分录 vs 新版本的 SettlementDay 行数);
//   ② `reversal_missing`    只看**冲回侧**(旧 committed 分录有没有被冲干净 + claim 齐不齐);
//   ③ `reversal_amount_invalid` 只看**金额**(冲回是不是原分录逐列的相反数)。
// ⇒ 卸掉任何一条,只有它对应的那一条用例会红。
// ❌ 不得合并成一个"总数对不上"的判定 —— 那样卸一条就同时放行三条,
//    "哪一条没有执法位"就再也读不出来。

/** 违例种类。每一种在 service 层一一对应**一个**具名 BizCode,没有兜底码。 */
export type CorrectionPostingShapeViolation =
  /** ① 只冲不补:补记侧与新版本的应记日行数对不上。 */
  | 'replacement_missing'
  /** ② 只补不冲:旧 committed 分录没被冲干净,或冲回分录缺少独占 claim。 */
  | 'reversal_missing'
  /** ③ 冲回金额不是原分录逐列的相反数。 */
  | 'reversal_amount_invalid';

export interface CorrectionPostingShapeFacts {
  // ---- ① 补记侧 ----
  /** 本批次里 `*_credit` 分录的条数。 */
  readonly creditEntryCount: number;
  /** 本批次 `*_credit` 分录覆盖的 distinct `(resultRevisionId, ledgerDate)` 对数。 */
  readonly creditPairCount: number;
  /** **新**版本的 `ParticipantSettlementDay` 行数 —— 补记侧应有的对数。 */
  readonly settlementDayCount: number;

  // ---- ② 冲回侧 ----
  /** 本批次里 `*_reversal` 分录的条数。 */
  readonly reversalEntryCount: number;
  /** 本批次 `*_reversal` 分录覆盖的 distinct `(resultRevisionId, ledgerDate)` 对数。 */
  readonly reversalPairCount: number;
  /** 本批次冲回分录所对应的 `LedgerEntryReversalClaim` 条数。 */
  readonly reversalClaimCount: number;
  /** **基础版本**下已生效、却没有被本批次冲回的 credit 分录条数。 */
  readonly unreversedOriginalCount: number;
  /** 冲回了一条**并非已生效批次**里的原分录 —— 那等于冲一笔根本没入过账的账。 */
  readonly reversalOfUncommittedCount: number;

  // ---- ③ 金额 ----
  /** 四个 delta 不是原分录逐列相反数的冲回分录条数。 */
  readonly mismatchedReversalAmountCount: number;
}

/**
 * §5.14 ④ +§3.23.5 的配对判据。
 *
 * 返回 `null` = 形状成立,可以进入第五刀的 commit 协议;否则调用方**必须**按返回值
 * 抛对应的具名码(调用点用 `Record` 映射,漏一种编译不过)。
 */
export function evaluateCorrectionPostingShape(
  facts: CorrectionPostingShapeFacts,
): CorrectionPostingShapeViolation | null {
  // ===== ① 只冲不补 ==========================================================
  //
  // 补记侧的形状与**普通批次逐字相同**:每个 `(resultRevision, ledgerDate)` 恰好两条
  // (`service_credit` + `contribution_credit`),且对数必须等于新版本的
  // `ParticipantSettlementDay` 行数。
  // ⚠️ 这里**不能**换成"补记条数 == 冲回条数":更正完全可以让一个人从 present 变 absent
  //    (旧账要冲、新账没有),两侧条数天然不等 —— 拿它们相等会把合法更正判死。
  //    正确的锚点是**新版本自己算出来的应记日行数**。
  if (facts.creditPairCount !== facts.settlementDayCount) return 'replacement_missing';
  if (facts.creditEntryCount !== facts.creditPairCount * 2) return 'replacement_missing';

  // ===== ② 只补不冲 ==========================================================
  //
  // 🔴 **这一条是"旧账有没有被冲干净"的唯一执法位。** 少冲一条,那笔钱就在队员账上
  //    留了两遍(旧的没冲掉 + 新的又补了一遍)。
  if (facts.unreversedOriginalCount !== 0) return 'reversal_missing';
  // 冲回同样是每个 `(旧 resultRevision, ledgerDate)` 恰好两条(service + contribution)。
  if (facts.reversalEntryCount !== facts.reversalPairCount * 2) return 'reversal_missing';
  // §3.23.5:每一条冲回都必须有一条 `LedgerEntryReversalClaim` 占住那条原分录。
  // 缺了 claim ⇒「一条原 entry 至多被一个 committed reversal 冲回」就失去了 DB 锚点,
  // 下一次更正可以把同一条原分录**再冲一遍**。
  if (facts.reversalClaimCount !== facts.reversalEntryCount) return 'reversal_missing';
  // 冲一笔从没生效过的账 = 凭空造一笔负数。
  if (facts.reversalOfUncommittedCount !== 0) return 'reversal_missing';

  // ===== ③ 金额必须是逐列相反数 ==============================================
  //
  // 光"有一条冲回"不够 —— 冲回 1.2 分的账却只冲 0.2 分,配对计数完全正确,
  // 而队员账上凭空多出 1.0 分。四个 delta 必须逐列相反。
  if (facts.mismatchedReversalAmountCount !== 0) return 'reversal_amount_invalid';

  return null;
}
