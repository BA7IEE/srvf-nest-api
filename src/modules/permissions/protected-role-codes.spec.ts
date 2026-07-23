import { PROTECTED_ROLE_CODES } from './protected-role-codes';

describe('PROTECTED_ROLE_CODES', () => {
  it('单一清单锁定 15 个 seed 内置角色且无重复', () => {
    expect(PROTECTED_ROLE_CODES).toHaveLength(15);
    expect(PROTECTED_ROLE_CODES).toHaveLength(new Set(PROTECTED_ROLE_CODES).size);
  });
});
