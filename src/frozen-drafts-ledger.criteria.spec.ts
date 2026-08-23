/**
 * 冻结稿落地台账的判据(`docs/ai-harness/FROZEN_DRAFTS.md`)。
 *
 * ⚠️ **本文件只是薄运行器,实质逻辑在 `scripts/check-frozen-drafts-ledger.ts`。**
 *    那个文件在 selfGuard(`scripts/check-*.ts`)内,改松它要过红区人闸;
 *    而 `src/**\/*.spec.ts` 不在 selfGuard —— 把逻辑放这里等于没锁。
 *
 *    ⭐ 那份计算侧**原名 `scripts/frozen-drafts-ledger.ts`** —— 放在 `scripts/` 下
 *    却不匹配任何 selfGuard glob,实测 `harness:needs` = 0 需授权,**同样是零保护**。
 *    「搬进 scripts/」不够,必须「搬成 `check-*.ts`」;本刀顺带把它改名收编。
 *
 * **要防的缺陷类**:归档目录里新增一份冻结稿 / 施工依据,却没人把它登记进台账 ——
 * 而**漏登记不产生任何坏链接**,既有的 `referenced-paths-exist` 之类守护看不见它。
 * 这一类在本仓已发生过两次(`docs/ai-harness/README.md` 漂成"恰 4 文件";
 * `docs/README.md` 那句「当前两份」漏掉 rbac 目录终态与整个活动 v1.1 合同目录)。
 *
 * **判据形状**:不是"至少登记了几份",而是**双向集合相等** ——
 * 少一份 = 新文件未分类;多一份 = 登记了已删除的文件。两个方向都会红。
 *
 * ⚠️ **扫描面不得退化成关键词匹配**。"头部含冻结 / FROZEN"那版试过并当场否决:
 * 实测漏掉 `activity-responsibility-workflow-v2-review.md`(头部写"业务已定版"),
 * 而那份正是"代码已落、闸未开"的欠账项 —— 关键词判据会把最需要看见的那份漏掉。
 *
 * ⚠️ 每条判据前先跑**自证**:扫描面为空 / 解析不出编号时,判据当场红而不是静默放行。
 * 「判据失去输入 ≠ 通过」。
 */
import { analyzeLedger, selfCheck } from '../scripts/check-frozen-drafts-ledger';

describe('冻结稿落地台账 —— 自证', () => {
  const report = analyzeLedger();

  it('扫描面非空、三个锚点都在、验收编号自洽、读数条数够(判据失去输入 ≠ 通过)', () => {
    // 地板锚点全部是受保护文件里的具名常量(ARCHIVED_DOCS_FLOOR / READINGS_FLOOR /
    // ACTIVITY_ACCEPTANCE_DEFINED_FLOOR)—— 写在这里的数字任何 PR 都能调小。
    expect(selfCheck(report)).toEqual([]);
  });
});

describe('冻结稿落地台账 —— 分类完整性', () => {
  const report = analyzeLedger();

  it('归档目录里的每一份 .md 都在 §3 有且只有一条分类(双向集合相等)', () => {
    // 方向一:新增文件未登记。
    expect(report.missingFromLedger).toEqual([]);
    // 方向二:登记了已不存在的文件。
    expect(report.staleInLedger).toEqual([]);
    // 同一份文件不得登记两次(两条分类 = 又一份"第二真相")。
    expect(report.duplicateDeclarations).toEqual([]);
  });

  it('分类取值落在闭集内,且 open 必须带台账编号', () => {
    expect(report.badCategories).toEqual([]);
    expect(report.openWithoutLedgerId).toEqual([]);
  });

  it('§1 欠账表的台账编号与 §3 的 open 行互证', () => {
    expect(report.openNotInSummary).toEqual([]);
    expect(report.summaryNotInOpen).toEqual([]);
  });
});

describe('冻结稿落地台账 —— 读数新鲜度', () => {
  const report = analyzeLedger();

  it('文档里的读数块与现算结果逐字节相同', () => {
    // 非空串即为「现算结果」,失败输出直接可粘贴回文档。
    expect(report.readingsDrift).toBe('');
  });
});

describe('冻结稿落地台账 —— 跨台账落地度对照', () => {
  const report = analyzeLedger();

  it('§1 每行都对 NEXT_TASKS 的状态显式表态,且不沉默地互相矛盾', () => {
    // ⚠️ 判据形状**不是**「两边数字必须相等」—— 存在刻意用两把尺子的合法情形
    //    (§1.1 ③ 的标题逐字写着「两根尺子读数不同,别混用」)。
    //    闸治的是「沉默」:没标记 = 红;标了同尺却不一致 = 红并打印两边原文;
    //    标了 `↔另尺(<说明>)` = 绿。
    // ⚠️ 逃生门不得把闸整体关掉 —— 「真正做过对照的行数 ≥ 4」由上面那条自证守。
    expect(report.crossLedger.failures).toEqual([]);
  });
});
