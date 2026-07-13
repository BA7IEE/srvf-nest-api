import { BindingScopeType, BindingStatus, PrincipalType } from '@prisma/client';
import { effectiveGlobalUserRoleBindingWhere, isWithinTerm } from './role-binding-validity';

describe('role-binding-validity', () => {
  const now = new Date('2026-07-13T08:00:00.000Z');

  it('isWithinTerm 起止边界均含等号；未来未生效与过去已结束均无效', () => {
    expect(isWithinTerm(now, null, now)).toBe(true);
    expect(isWithinTerm(new Date('2026-07-01T00:00:00.000Z'), now, now)).toBe(true);
    expect(isWithinTerm(new Date('2026-07-13T08:00:00.001Z'), null, now)).toBe(false);
    expect(
      isWithinTerm(new Date('2026-07-01T00:00:00.000Z'), new Date('2026-07-13T07:59:59.999Z'), now),
    ).toBe(false);
  });

  it('effectiveGlobalUserRoleBindingWhere 固化 ACTIVE + GLOBAL + 任期 + 双软删过滤', () => {
    expect(effectiveGlobalUserRoleBindingWhere('user-1', now)).toEqual({
      principalType: PrincipalType.USER,
      principalId: 'user-1',
      scopeType: BindingScopeType.GLOBAL,
      status: BindingStatus.ACTIVE,
      startedAt: { lte: now },
      OR: [{ endedAt: null }, { endedAt: { gte: now } }],
      deletedAt: null,
      role: { deletedAt: null },
    });
  });
});
