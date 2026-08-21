import {
  MIN_PERMISSION_CODES,
  analyzeCatalogClosure,
  selfCheck,
} from '../../../scripts/check-permission-catalog-closure';
import { SEED_PERMISSION_CODES, SEED_PERMISSION_CODE_SET } from './seed-permission-codes';

/**
 * 「运行时护栏清单必须等于 seed 事实闭包」漂移哨兵。
 *
 * ⚠️ **实质逻辑(typed-AST 提取 + 自证)在 `scripts/check-permission-catalog-closure.ts`。**
 *    那个文件在红区 selfGuard(`scripts/check-*.ts`)内,改松它要过人闸;
 *    本文件只做薄对照 —— 与 `permission-catalog-closure.spec.ts` 同范式。
 *
 * 守的是什么:[`seed-permission-codes.ts`](seed-permission-codes.ts) 是护栏在**运行时**
 * 唯一读得到的闭包。它一旦落后于事实源,护栏就会对新权限码失明 ——
 * 而失明的症状恰好是「什么都不发生」(新码照样能删),所以必须有判据盯着。
 */
describe('seed permission codes (runtime guardrail catalog)', () => {
  const report = analyzeCatalogClosure();

  // ===========================================================================
  // 自证:先证明两侧都没塌,再报数。空集 == 空集会静默变绿。
  // 全部用地板锚点(≥N),不用「恰 N 条」。
  // ===========================================================================

  it('self-proves the closure scan surface is non-empty before asserting', () => {
    expect(selfCheck(report)).toEqual([]);
    expect(report.full.size).toBeGreaterThanOrEqual(MIN_PERMISSION_CODES);
    expect(SEED_PERMISSION_CODES.length).toBeGreaterThanOrEqual(MIN_PERMISSION_CODES);
  });

  it('has no duplicate entries', () => {
    // 有重复时 Set 会比数组短,而下面的集合对照仍可能全绿 —— 单列一条盯它。
    expect(SEED_PERMISSION_CODE_SET.size).toBe(SEED_PERMISSION_CODES.length);
  });

  // ===========================================================================
  // 两个方向都查(沿 #1129 范式)
  // ===========================================================================

  it('contains every permission code in the seed facts closure', () => {
    // (a) 事实源有、清单没有 —— 新增权限码时忘了补清单。护栏会对这些码失明。
    const missing = [...report.full].filter((code) => !SEED_PERMISSION_CODE_SET.has(code)).sort();
    expect(missing).toEqual([]);
  });

  it('contains no code outside the seed facts closure', () => {
    // (b) 清单有、事实源没有 —— 清单里有幽灵码,或事实源删码时忘了同步清单。
    // 后果相反但同样实:护栏会挡住一个根本不该被它管的码,且删不掉(永久卡住)。
    const phantom = SEED_PERMISSION_CODES.filter((code) => !report.full.has(code)).sort();
    expect(phantom).toEqual([]);
  });

  it('is sorted, so that future diffs stay reviewable', () => {
    expect([...SEED_PERMISSION_CODES]).toEqual([...SEED_PERMISSION_CODES].sort());
  });
});
