// ===== 活动改造 v1.1 第 2 批第四刀:§5.11「比较 seal / revisions / workflow / contentHash」=====
//
// 审核人点"通过"的那一刻,他同意的是**某一份具体内容**。本文件守的就是
// "他同意的那一份 == 现在要被批准的那一份"。四项比对各自一个具名码。
//
// ## 三个输入,不是两个
//
//   - `expected` —— **审核人看到的那一版**(调用方随动作一起带上来的快照)。
//   - `version`  —— 不可变的 `AttendanceSettlementVersion` 行(第三刀固化的那一份)。
//   - `live`     —— **此刻**的现场事实(当前 active seal、当前 evidence/population
//                   revision、当前 `Activity.workflowRevision`)。
//
// 为什么三个都要:
//   - 只比 `expected ↔ version`,只能抓住"审核人看的是别的版本",抓不住"版本没变
//     但现场事实在送审之后又动了"(那笔账已经不对应现在的现场);
//   - 只比 `version ↔ live`,只能抓住现场漂移,抓不住"审核人看的是别的版本"。
// §5.11 要求的是审核这一刻**重验**,所以两侧都比。宁可多拒。
//
// ## 🔴 `contentHash` **只比对,不重算**(goal DoD 5 / 禁止域)
//
// `contentHash` 是第三刀在提交事务里 canonical 算出来、写死在不可变版本行上的。
// 本刀**只把 `expected.contentHash` 与 `version.contentHash` 做字符串比较**,
// 一行都不重算 —— 重算等于把"审的是哪一版"这件事又交回给**可变数据**
// (结果行、规则表、小数标度……都可能已经变了),那正是不可变版本要根除的东西。
// ⇒ 故 `content_hash` 这一项**没有 live 侧**:版本行不可变,没有"现在的 hash"。
//
// ## 四项互不重叠(逐项一码 + 逐项一条 red-first 用例)
//
// 顺序即求值序,首个失配即返。四项各读**互不相交的字段**:
//   ① seal 身份(id / 是否仍 active)     —— 不读任何 revision;
//   ② evidence + population revision     —— 不读 seal id、不读 workflow;
//   ③ workflow revision                  —— 只读 workflow;
//   ④ contentHash                        —— 只读 hash。
// ⇒ 卸掉第 i 项,只有第 i 条用例会红(红集矩阵见报告)。
//
// ⚠️ ②把 evidence 与 population 合成**一项**,是照 goal DoD 5 的原文
//   (「seal / evidence+population revision / workflowRevision / contentHash」四项)。
//   它们同源同生命周期(都由 `ActivityEvidenceState` 一行承载、一起递增),
//   拆两个码只会让审核人多背一个不影响下一步动作的区分。

/** 四项比对的失配种类。每一种在 service 层一一对应一个具名 BizCode。 */
export type SettlementReviewMismatch =
  /** ① 版本引用的封场凭证已不是当前 active 的那一张(或已无 active seal),或审核人看的是别的 seal。 */
  | 'evidence_seal'
  /** ② 证据 / 人口版本与提交时的快照不一致。 */
  | 'evidence_population_revision'
  /** ③ 活动流程版本(`Activity.workflowRevision`)与提交时的快照不一致。 */
  | 'workflow_revision'
  /** ④ 审核人看到的内容摘要与不可变版本行上的不一致。 */
  | 'content_hash';

/** 审核人随动作带上来的快照 —— "我审的是这一份"。 */
export interface SettlementReviewExpectation {
  evidenceSealId: string;
  evidenceRevision: number;
  populationRevision: number;
  workflowRevision: number;
  /** 🔴 只用于**比对**。本刀不重算 hash。 */
  contentHash: string;
}

/** 不可变版本行上的快照(第三刀写死的那一份)。 */
export interface SettlementReviewVersionSnapshot {
  evidenceSealId: string;
  evidenceRevision: number;
  populationRevision: number;
  workflowRevision: number;
  contentHash: string;
}

/** 审核这一刻的现场事实。 */
export interface SettlementReviewLiveFacts {
  /** 当前 active seal 的 id;没有 active seal 时为 null。 */
  activeEvidenceSealId: string | null;
  evidenceRevision: number;
  populationRevision: number;
  workflowRevision: number;
}

export function compareSettlementReviewSnapshot(input: {
  expected: SettlementReviewExpectation;
  version: SettlementReviewVersionSnapshot;
  live: SettlementReviewLiveFacts;
}): SettlementReviewMismatch | null {
  const { expected, version, live } = input;

  // ① seal 身份。三种不满足形态归一个码(对审核人是同一件事:去重新封场):
  //    没有 active seal / 当前 active seal 换了一张 / 审核人看的是另一张。
  if (
    live.activeEvidenceSealId === null ||
    live.activeEvidenceSealId !== version.evidenceSealId ||
    expected.evidenceSealId !== version.evidenceSealId
  ) {
    return 'evidence_seal';
  }

  // ② 证据 + 人口版本。
  if (
    live.evidenceRevision !== version.evidenceRevision ||
    live.populationRevision !== version.populationRevision ||
    expected.evidenceRevision !== version.evidenceRevision ||
    expected.populationRevision !== version.populationRevision
  ) {
    return 'evidence_population_revision';
  }

  // ③ 流程版本。
  if (
    live.workflowRevision !== version.workflowRevision ||
    expected.workflowRevision !== version.workflowRevision
  ) {
    return 'workflow_revision';
  }

  // ④ 内容摘要。**只比对**(见文件头红字)。
  if (expected.contentHash !== version.contentHash) {
    return 'content_hash';
  }

  return null;
}
