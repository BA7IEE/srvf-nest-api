import {
  CONTROL_DESCRIPTION_HALF,
  CONTROL_DESCRIPTION_REWORDED,
  CONTROL_DESCRIPTION_WITHOUT_DISCLAIMER,
  CONTROL_DESCRIPTION_WITH_DISCLAIMER,
  CONTROL_SCHEMA_THIRD_STATE,
  CONTROL_SCHEMA_TWO_STATES,
  EXPECTED_ENUM_MEMBERS,
  MIN_PINNED_SITES,
  analyzeSmsSentSemantics,
  missingAnchorGroups,
  parseEnumMembers,
  selfCheck,
} from '../../../scripts/check-sms-sent-semantics';

/**
 * 「`SmsSendStatus.SENT` 是**提交态**不是**送达态**」类闸。
 *
 * ⚠️ **本文件只是薄运行器,实质逻辑在 `scripts/check-sms-sent-semantics.ts`。**
 *    那个文件在 selfGuard(`scripts/check-*.ts`)内,改松它要过红区人闸;
 *    而 `src/**\/*.criteria.spec.ts` 不在 selfGuard —— 判据若住在这里,
 *    任何 PR 都能顺手把它改成恒绿。本文件存在的唯一理由是让 `pnpm test`
 *    自动收它,免掉一份 CI 接线。
 *
 * 背景(P2-10 项 1):2026-08-20 真机实测反例 —— `status=SENT` + `providerMsgId`
 * 非空 + `errCode=null`,腾讯云控制台却是「提交成功 / 送达失败 / 运营商免打扰名单」,
 * 手机始终没收到。零故障,但运营会照字面把 `SENT` 读成「用户收到了」。
 */
describe('sms SENT semantics', () => {
  const report = analyzeSmsSentSemantics();

  // ===========================================================================
  // 自证:先证明仪器没瞎,再报数
  //
  // 「站点解析不到 ⇒ 零违规 ⇒ 全绿」是本仓已登记的假绿形状。地板锚点 + 解析自证
  // 一起堵这条路:把登记表删空 / 把类改名,都会红在这一条上而不是静静变绿。
  // ===========================================================================

  it('self-proves every pinned site actually resolved', () => {
    expect(selfCheck(report)).toEqual([]);
    expect(report.pinnedSites.length).toBeGreaterThanOrEqual(MIN_PINNED_SITES);
  });

  // ===========================================================================
  // 对照:假阳性 / 真阳性各两条
  //
  // 假阳性对照是本闸可用性的前提 —— 它若把「换了措辞的等价写法」也判成违规,
  // 人只会把闸删掉。真阳性对照是本闸未来唯一要干的活的样本。
  // ===========================================================================

  it('passes the current two-state enum — the correct shape must stay green', () => {
    expect(parseEnumMembers(CONTROL_SCHEMA_TWO_STATES)).toEqual(EXPECTED_ENUM_MEMBERS);
  });

  it('sees a third state land in the enum', () => {
    // ⭐ 项 2(三态细化 + 腾讯云回调)落地那天,仓内的免责说明全部过期。
    //    这条对照让「加了送达态就必须回来重看文案」每次 CI 都被验一遍。
    expect(parseEnumMembers(CONTROL_SCHEMA_THIRD_STATE)).not.toEqual(EXPECTED_ENUM_MEMBERS);
  });

  it('passes a disclaimer written in different words and punctuation', () => {
    expect(missingAnchorGroups(CONTROL_DESCRIPTION_WITH_DISCLAIMER)).toEqual([]);
    expect(missingAnchorGroups(CONTROL_DESCRIPTION_REWORDED)).toEqual([]);
  });

  it('flags a description with the disclaimer stripped, and one that says only half', () => {
    expect(missingAnchorGroups(CONTROL_DESCRIPTION_WITHOUT_DISCLAIMER)).not.toEqual([]);
    expect(missingAnchorGroups(CONTROL_DESCRIPTION_HALF)).not.toEqual([]);
  });

  // ===========================================================================
  // 主断言
  // ===========================================================================

  it('keeps the enum frozen at two states', () => {
    expect(report.enumMembers).toEqual(EXPECTED_ENUM_MEMBERS);
  });

  it('keeps the disclaimer on every human-facing description of the status', () => {
    // findings 自带 site / rule / detail,报错直接告诉人补哪一处、补什么。
    expect(report.findings).toEqual([]);
  });
});
