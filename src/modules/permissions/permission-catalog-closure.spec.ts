import {
  MIN_BUCKETS,
  MIN_PERMISSION_CODES,
  analyzeCatalogClosure,
  selfCheck,
} from '../../../scripts/check-permission-catalog-closure';

/**
 * 「四桶并集必须等于权限码全集」类闸(第七轮评审顺带发现 ①)。
 *
 * ⚠️ **本文件只是薄运行器,实质逻辑在 `scripts/check-permission-catalog-closure.ts`。**
 *    那个文件在 selfGuard(`scripts/check-*.ts`)内,改松它要过红区人闸;
 *    而 `src/**\/*.spec.ts` 不在 selfGuard —— 把逻辑放这里等于没锁。
 *    本文件存在的唯一理由是让 `pnpm test`(CI 里跑)自动收它,免掉一份 CI 接线。
 *
 * 修的是缺陷类不是实例:不点名那 12 条,而是问「目录的各桶并起来,
 * 是不是真的等于全集」。下一个 feature 批次又建一个权限数组却忘了加桶时,
 * 本闸当场红并点名。
 */
describe('permission catalog closure', () => {
  const report = analyzeCatalogClosure();

  // ===========================================================================
  // 自证:先证明仪器没瞎,再报数
  //
  // 「两侧都塌成空集 ⇒ 空集==空集 ⇒ 全绿」是本仓已登记的假绿形状。
  // 全部用地板锚点(≥N),不用「恰 N 条」—— 后者每次新增权限码都要改判据,
  // 那份摩擦会诱导人把数字调大了事。
  // ===========================================================================

  it('self-proves both scan surfaces are non-empty before asserting', () => {
    expect(selfCheck(report)).toEqual([]);
    expect(report.bucketCounts.length).toBeGreaterThanOrEqual(MIN_BUCKETS);
    expect(report.union.size).toBeGreaterThanOrEqual(MIN_PERMISSION_CODES);
    expect(report.full.size).toBeGreaterThanOrEqual(MIN_PERMISSION_CODES);
  });

  it('reads the two sides from genuinely different sources', () => {
    // 口径对照的结构版:并集侧来自运行时导出对象(按桶分组、桶名可枚举),
    // 全集侧来自 typed-AST 静态扫描(只有一个扁平集合、没有桶的概念)。
    // 若哪天有人把全集侧换成「并集自己」,下面这条会先垮 —— 那时 bucketCounts
    // 与 full 会退化成同一个来源,而本断言要求并集侧**确实是分桶结构**。
    expect(report.bucketCounts.length).toBeGreaterThan(1);
    const summed = report.bucketCounts.reduce((total, [, count]) => total + count, 0);
    // 桶间有刻意的重叠(bootstrap 含 rbac),所以「各桶条数之和」必然大于去重并集。
    // 这条同时证明:并集侧真的走了「逐桶收集再去重」,不是拿一个现成的扁平集合冒充。
    expect(summed).toBeGreaterThan(report.union.size);
  });

  // ===========================================================================
  // 断言:两个方向都查
  // ===========================================================================

  it('has every catalog permission code in at least one bucket', () => {
    // (a) 全集有、任何桶都没有 —— 新权限数组没接进目录。本闸的主用途。
    expect(report.missingFromBuckets).toEqual([]);
  });

  it('has no bucket code missing from the typed-AST catalog', () => {
    // (b) 桶里有、全集没有 —— 提取器口径漂了,或桶里有幽灵码。
    //
    // 这条不是理论洁癖:它是**全集侧失效的唯一症状**。提取器若少认一种写法,
    // 全集缩水,而缩水后的全集恒是并集的子集 ⇒ 方向 (a) 反而全绿。
    expect(report.phantomInBuckets).toEqual([]);
  });
});
