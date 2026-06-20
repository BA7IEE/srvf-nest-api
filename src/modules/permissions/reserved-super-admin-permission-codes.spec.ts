import {
  RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES,
  RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET,
} from './reserved-super-admin-permission-codes';

// F1(#399):冻结 SA-only 保留码集合。
// 改动本集合是 RBAC 授权事实变更 —— 本测试令任何增删都"显式可见、需同步 seed 与漂移哨兵"。
// 端到端的"集合 ↔ seed 不绑矩阵"一致性由 seed-rbac.e2e-spec.ts 漂移哨兵守。
describe('RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES', () => {
  it('恰为这 6 条 SA-only 保留码(改动需同步 seed 不绑矩阵 + e2e 漂移哨兵)', () => {
    expect([...RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES].sort()).toEqual(
      [
        'member.delete.record',
        'realname-setting.reset.credentials',
        'sms-setting.reset.credentials',
        'storage-setting.reset.credentials',
        'user.update.role',
        'wechat-setting.reset.credentials',
      ].sort(),
    );
  });

  it('无重复项', () => {
    expect(RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES).toHaveLength(
      new Set(RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES).size,
    );
  });

  it('Set 与数组同步,membership 查询正确', () => {
    expect(RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET.size).toBe(
      RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES.length,
    );
    expect(RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET.has('member.delete.record')).toBe(true);
    expect(RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET.has('member.read.list')).toBe(false);
  });
});
