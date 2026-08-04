// ===== 活动改造 v1.1 第 2 批第三刀:提交前四项校验(合同 §5.10 ④)=====
//
// 合同原话:「验证所有 working items 数量 = population,并无重复 identity／未决结果／
// 开放 segment／missing rule」—— 逐字拆成**五条独立判据**,每条一个具名拒绝码。
//
// 🔴 **为什么这五条是本刀最重要的东西**
//
// 第二刀把「未决」表达成**不写结果行**(§3.20 的 `resultCode` 十值闭集里没有
// "尚未认定")。那个设计成立的**唯一前提**就是这里:提交时"人口里有他、结果表里
// 没有他"必须红。写松一条,未决的人会安静地不出现在版本里,而版本自称已覆盖全部人口
// —— 然后这个版本进一审、进账本、进关账,全程不报错。
//
// ## 两条闸守同一件事,顺序是有意的
//
// `PENDING_RESULT`(包含式:人口 ⊆ 结果集)与 `ITEM_COUNT_MISMATCH`(基数式:
// |结果集| = |人口|)不是重复劳动 —— 它们各自能抓到对方抓不到的形态:
//
//   - 人口 {A,B}、结果 {A,X}(X 不在人口里):**基数相等**,基数式放行,
//     包含式抓住 B 缺席;
//   - 人口 {A}、结果 {A,X}:包含式放行(A 在),基数式抓住多出来的 X。
//
// 包含式在前,因为它对负责人的信息量更大(能指出"还差谁没定"),而基数式给出的是
// "对不上账"。自然形态的未决(人口 {A,B}、结果 {A})两条都会红,由包含式先报 ——
// 这是**双闸**,不是冗余:卸掉任意一条,那种形态仍然被另一条拦住。
//
// ## 为什么判据只吃计数,不吃行
//
// 五条判据全部由**聚合查询**喂进来(见 `SettlementSubmitService.readSubmissionFacts`),
// 与人数无关:一万人的活动跟三个人的活动跑同样的 SQL 条数、同样的 bind 参数数。
// 若改成"把行捞进内存再遍历",判据本身就会在规模上先垮(第 0 批实测 bind 上限 32767)。
//
// ## `DUPLICATE_IDENTITY` 的诚实说明(⚠️ 报告里也列了)
//
// DB 上有 unique `(settlementVersionId, participationIdentityId)`,同一版本内同一
// identity 出现两次是**结构上不可达**的;`ActivityParticipationIdentity` 又有
// unique `(activityId, sessionId, memberId)`,人口里同一人同一场次出现两次同样不可达。
// 所以这一条在 e2e 层**造不出红**——它的 red-first 证据在**单测**层(直接喂矛盾计数)。
// 仍然接闸的理由:判据不该依赖"别处有个 unique"这件事(那是可以被后人改掉的),
// 而且绕过应用层写库时它是最后一道。**这是防御位,不是活闸** —— 不混进"全部条件
// 都有 e2e 执法"的说法里。

/** 五条判据的失败种类。每一种在 `BizCode` 里有一个专属码,调用方逐一映射。 */
export type SettlementSubmissionRejection =
  /** ⭐ 人口里有他、结果表里没有他 —— 第二刀「不写行表达未决」的执行位。 */
  | 'pending_result'
  /** 结果行数 ≠ 人口数(含"多出不在人口里的行"这种形态)。 */
  | 'item_count_mismatch'
  /** 同一 identity 在同一版本里出现多次(防御位,见文件头)。 */
  | 'duplicate_identity'
  /** 还有人没签退就提交 —— 没有签退时刻就没有时长。 */
  | 'open_segment'
  /** 第二刀标的「应计分无有效贡献规则」blocker 必须在这里真正挡住提交。 */
  | 'missing_rule';

/**
 * 判据的全部输入。**只有计数,没有行** —— 见文件头。
 *
 * 每个字段都由一条聚合 SQL 直接产出,字段名与它回答的问题一一对应。
 */
export interface SettlementSubmissionFacts {
  /** `populationIncluded = true` 的身份数(= 应有的 working item 数)。 */
  readonly populationCount: number;
  /** 草稿版本下的结果行数。 */
  readonly resultRowCount: number;
  /** 结果行里**不同** identity 的个数;与上一项不等即有重复。 */
  readonly distinctResultIdentityCount: number;
  /** 人口里**没有**对应结果行的身份数 —— 未决项。 */
  readonly populationWithoutResultCount: number;
  /** 人口身份名下、当前(非 superseded)且**没有签退时刻**的服务段数。 */
  readonly openSegmentCount: number;
  /** 带 blocker 标记的结果行数(第二刀写在 `exceptionFlagsJson.blockers`)。 */
  readonly blockedResultCount: number;
}

/**
 * §5.10 ④ 的五条校验。全部通过返回 `null`;否则返回**第一条**不通过的种类。
 *
 * ⚠️ 每条判据只读**它自己那一个字段**,彼此不共享中间量 —— 这是"逐条卸掉后红集
 *    互不重叠"能成立的结构前提(卸掉一条,不会顺带削弱另一条)。
 */
export function validateSettlementSubmission(
  facts: SettlementSubmissionFacts,
): SettlementSubmissionRejection | null {
  // ⭐ ① 未决结果(包含式)。信息量最大,放最前 —— 见文件头「两条闸」。
  if (facts.populationWithoutResultCount > 0) return 'pending_result';

  // ② 项数 = population(基数式)。抓"多出不在人口里的行"那一侧。
  if (facts.resultRowCount !== facts.populationCount) return 'item_count_mismatch';

  // ③ 无重复 identity(防御位)。
  if (facts.resultRowCount !== facts.distinctResultIdentityCount) return 'duplicate_identity';

  // ④ 无开放 segment:还有人没签退,时长就是未知数,不许固化成审核依据。
  if (facts.openSegmentCount > 0) return 'open_segment';

  // ⑤ 无 missing rule:第二刀标的 blocker 在这里真正挡住提交,
  //    否则那条 blocker 就只是个装饰。
  if (facts.blockedResultCount > 0) return 'missing_rule';

  return null;
}
