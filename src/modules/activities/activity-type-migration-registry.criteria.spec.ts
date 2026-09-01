import { checkActivityTypeMigrationRegistry } from '../../../scripts/check-dictionary-seed-registry';

/**
 * A1 旧 activityTypeCode 迁移目录的薄运行器。
 *
 * 实质判据、冻结矩阵和 seed 读取都在
 * scripts/check-dictionary-seed-registry.ts：它属于 selfGuard 红区，改松
 * 需要维护者授权；这里仅执行已受保护的裁判。
 */
describe('Activity OS R1/A1 legacy activity type migration registry', () => {
  it('keeps the frozen registry, controlled catalog and seed coverage aligned', () => {
    expect(checkActivityTypeMigrationRegistry()).toEqual([]);
  });
});
