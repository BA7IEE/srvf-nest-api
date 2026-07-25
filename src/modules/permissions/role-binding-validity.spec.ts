import { BindingScopeType, BindingStatus, PrincipalType } from '@prisma/client';
import {
  currentPermanentGlobalOpsAdminBindingWhere,
  effectiveGlobalOpsAdminBindingWhere,
  effectiveGlobalUserRoleBindingWhere,
  effectiveGlobalUserRoleBindingsWhere,
  effectiveRoleBindingWhere,
  isEffectiveRoleBinding,
  isWithinTerm,
} from './role-binding-validity';

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

  it('isEffectiveRoleBinding 同时锁定 ACTIVE、未软删与双含等号任期边界', () => {
    const base = {
      status: BindingStatus.ACTIVE,
      startedAt: now,
      endedAt: now,
      deletedAt: null,
    };
    expect(isEffectiveRoleBinding(base, now)).toBe(true);
    expect(isEffectiveRoleBinding({ ...base, status: BindingStatus.ENDED }, now)).toBe(false);
    expect(isEffectiveRoleBinding({ ...base, deletedAt: now }, now)).toBe(false);
    expect(
      isEffectiveRoleBinding(
        { ...base, startedAt: new Date(now.getTime() + 1), endedAt: null },
        now,
      ),
    ).toBe(false);
    expect(isEffectiveRoleBinding({ ...base, endedAt: new Date(now.getTime() - 1) }, now)).toBe(
      false,
    );
  });

  it('可组合 where：generic、USER/GLOBAL、ops-admin 与 permanent 逐层只收窄同一真值', () => {
    expect(effectiveRoleBindingWhere(now)).toEqual({
      status: BindingStatus.ACTIVE,
      startedAt: { lte: now },
      OR: [{ endedAt: null }, { endedAt: { gte: now } }],
      deletedAt: null,
    });
    expect(effectiveGlobalUserRoleBindingsWhere(now)).toMatchObject({
      ...effectiveRoleBindingWhere(now),
      principalType: PrincipalType.USER,
      scopeType: BindingScopeType.GLOBAL,
      role: { deletedAt: null },
    });
    expect(effectiveGlobalOpsAdminBindingWhere(now)).toMatchObject({
      ...effectiveGlobalUserRoleBindingsWhere(now),
      role: { code: 'ops-admin', deletedAt: null },
    });
    expect(currentPermanentGlobalOpsAdminBindingWhere(now)).toMatchObject({
      ...effectiveGlobalOpsAdminBindingWhere(now),
      endedAt: null,
    });
  });
});
