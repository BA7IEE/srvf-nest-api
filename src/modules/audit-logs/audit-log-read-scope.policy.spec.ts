import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AuditLogReadScopePolicy } from './audit-log-read-scope.policy';

function makeCurrentUser(overrides: Partial<CurrentUserPayload> = {}): CurrentUserPayload {
  return {
    id: 'reader-id',
    username: 'reader',
    role: Role.USER,
    status: UserStatus.ACTIVE,
    memberId: null,
    ...overrides,
  };
}

describe('AuditLogReadScopePolicy', () => {
  const policy = new AuditLogReadScopePolicy();

  it('SUPER_ADMIN 解析为全量范围,不下推额外 where', () => {
    const scope = policy.resolve(makeCurrentUser({ role: Role.SUPER_ADMIN }));

    expect(scope).toEqual({ kind: 'all' });
    expect(policy.toWhere(scope)).toBeNull();
    expect(policy.includes(scope, { actorUserId: null, actorRoleSnap: null })).toBe(true);
  });

  it.each([Role.ADMIN, Role.USER])('%s 使用同一个 self-or-user 范围', (role) => {
    const scope = policy.resolve(makeCurrentUser({ role }));

    expect(scope).toEqual({ kind: 'self-or-user', currentUserId: 'reader-id' });
    expect(policy.toWhere(scope)).toEqual({
      OR: [{ actorUserId: 'reader-id' }, { actorRoleSnap: Role.USER }],
    });
  });

  it('非 SUPER_ADMIN 可读本人(不依赖历史角色快照)与其它 USER 操作记录', () => {
    const scope = policy.resolve(makeCurrentUser());

    expect(
      policy.includes(scope, {
        actorUserId: 'reader-id',
        actorRoleSnap: Role.SUPER_ADMIN,
      }),
    ).toBe(true);
    expect(
      policy.includes(scope, {
        actorUserId: 'other-user',
        actorRoleSnap: Role.USER,
      }),
    ).toBe(true);
  });

  it('非 SUPER_ADMIN 拒其它 ADMIN/SUPER_ADMIN 与 null/null system actor', () => {
    const scope = policy.resolve(makeCurrentUser());

    expect(
      policy.includes(scope, {
        actorUserId: 'other-admin',
        actorRoleSnap: Role.ADMIN,
      }),
    ).toBe(false);
    expect(
      policy.includes(scope, {
        actorUserId: 'other-super-admin',
        actorRoleSnap: Role.SUPER_ADMIN,
      }),
    ).toBe(false);
    expect(policy.includes(scope, { actorUserId: null, actorRoleSnap: null })).toBe(false);
  });

  it('actorUserId=null 但历史角色快照为 USER 时仍属于 USER 操作范围', () => {
    const scope = policy.resolve(makeCurrentUser());

    expect(policy.includes(scope, { actorUserId: null, actorRoleSnap: Role.USER })).toBe(true);
  });
});
