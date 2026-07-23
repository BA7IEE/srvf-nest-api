import { SYSTEM_MANAGED_ROLE_CODES } from './system-managed-role-codes';

describe('SYSTEM_MANAGED_ROLE_CODES', () => {
  it('单一清单锁定 3 个活动责任自动投影角色且无重复', () => {
    expect(SYSTEM_MANAGED_ROLE_CODES).toEqual([
      'activity-owner',
      'activity-registration-collaborator',
      'activity-attendance-collaborator',
    ]);
    expect(SYSTEM_MANAGED_ROLE_CODES).toHaveLength(new Set(SYSTEM_MANAGED_ROLE_CODES).size);
  });
});
