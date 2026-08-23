import {
  BASELINE_FILE,
  MIN_PERMISSION_CODES,
  analyzeSurfaceBinding,
  formatFailures,
  selfCheck,
} from '../../../scripts/check-permission-surface-binding';

/**
 * 「权限说明 ↔ 管辖面」绑定闸的**薄运行器**(P2-13)。
 *
 * ⚠️ **本文件只是薄运行器,实质逻辑在 `scripts/check-permission-surface-binding.ts`。**
 *    那个文件在 `harness/redzone.json` 的 selfGuard 内(`scripts/check-*.ts`);
 *    spec(`src/**\/*.spec.ts`)不在 selfGuard,任何 PR 都能顺手改松它。
 *    所以判据往这里加逻辑等于把它搬出保护区 —— 要改判据,改那边。
 *    这条分工与 `permission-catalog-closure.spec.ts` 逐字同款。
 *
 * 它挡的是什么:**权限码总数不变,不能证明权限说明没过期**。
 * B7 受众标签那批加了 3 个新端点、**零个新权限码**,三条说明当场过期,
 * 而码数 / 四桶闭包 / 角色持有人三类判据全部照绿,`docs:authz:check` 红了一下、
 * `pnpm docs:authz` 一跑就绿 —— 重新生成**不碰任何说明**。
 * 立项前的四判据实测读数见那个文件的头注。
 */
describe('权限说明 ↔ 管辖面绑定(P2-13)', () => {
  const report = analyzeSurfaceBinding();

  it('仪器先自证:三条扫描面都不许塌(地板锚点,不是「恰 N 条」)', () => {
    expect(selfCheck(report.facts)).toEqual([]);
    expect(report.facts.universe.size).toBeGreaterThanOrEqual(MIN_PERMISSION_CODES);
    expect(report.facts.surface.size).toBeGreaterThanOrEqual(MIN_PERMISSION_CODES);
    expect(report.facts.descriptions.size).toBeGreaterThanOrEqual(MIN_PERMISSION_CODES);
  });

  it(`基线本身必须可用 —— 缺失 / 读空 / 截断都是红,不是「零差异 = 全绿」(${BASELINE_FILE})`, () => {
    expect(report.baselineFailure).toBeNull();
    expect(Object.keys(report.baseline ?? {}).length).toBeGreaterThanOrEqual(MIN_PERMISSION_CODES);
  });

  it('追踪面是从权限码全集动态发现的,不是写死的清单', () => {
    // 码全集 ∪ 管辖面出现过的码 —— 两侧都要被覆盖,任一侧漏了都会让新码静默失明。
    for (const code of report.facts.universe) expect(report.facts.tracked).toContain(code);
    for (const code of report.facts.surface.keys()) expect(report.facts.tracked).toContain(code);
  });

  it('没有「管辖面变了而说明没改」的码', () => {
    const stale = report.surfaceDrift.filter((drift) => !drift.descriptionChanged);
    expect(
      stale.map((drift) => `${drift.code}(${drift.baselineEndpoints}→${drift.currentEndpoints})`),
    ).toEqual([]);
  });

  it('基线与当前事实一致(新码已登记、废码已清、面已重看)', () => {
    expect(formatFailures(report)).toEqual([]);
  });
});
