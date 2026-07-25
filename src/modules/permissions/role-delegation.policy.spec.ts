import { BindingStatus, Role, UserStatus } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  isControlPlanePermissionCode,
  isPrivilegedRole,
  RoleDelegationPolicy,
} from './role-delegation.policy';
import { RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES } from './reserved-super-admin-permission-codes';

interface ActorOpsAdminWhere {
  principalId: string;
  status: BindingStatus;
  startedAt: { lte: Date };
  OR: Array<{ endedAt: null } | { endedAt: { gte: Date } }>;
  deletedAt: null;
  role: { code: string; deletedAt: null };
}

function createPolicy(
  client: unknown,
  acquireOpsAdminInvariantLock = jest.fn().mockResolvedValue(undefined),
) {
  return {
    policy: new RoleDelegationPolicy(
      client as never,
      {
        acquireOpsAdminInvariantLock,
      } as never,
    ),
    acquireOpsAdminInvariantLock,
  };
}

describe('role delegation control-plane classification', () => {
  const ordinaryRole = { code: 'ordinary-role', rolePermissions: [] };
  const actor = {
    id: 'actor-id',
    username: 'actor',
    role: Role.ADMIN,
    status: UserStatus.ACTIVE,
    memberId: null,
  };

  it.each(['rbac.role.create', 'role-binding.create.record'])('%s 前缀属于控制面权限码', (code) => {
    expect(isControlPlanePermissionCode(code)).toBe(true);
  });

  it.each(RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES)('%s 保留码属于控制面权限码', (code) => {
    expect(isControlPlanePermissionCode(code)).toBe(true);
  });

  it.each(['activity.read.record', 'member.update.record', 'rbacx.role.create'])(
    '%s 不是控制面权限码',
    (code) => {
      expect(isControlPlanePermissionCode(code)).toBe(false);
    },
  );

  it('角色仅在 code=ops-admin 或包含控制面权限时为特权角色', () => {
    expect(isPrivilegedRole({ code: 'ops-admin', rolePermissions: [] })).toBe(true);
    expect(
      isPrivilegedRole({
        code: 'custom-control',
        rolePermissions: [{ permission: { code: 'rbac.role.read' } }],
      }),
    ).toBe(true);
    expect(
      isPrivilegedRole({
        code: 'custom-reserved',
        rolePermissions: [{ permission: { code: 'member.delete.record' } }],
      }),
    ).toBe(true);
    expect(
      isPrivilegedRole({
        code: 'custom-business',
        rolePermissions: [{ permission: { code: 'activity.read.record' } }],
      }),
    ).toBe(false);
  });

  it('系统托管角色对 SUPER_ADMIN 也在数据库查询前拒绝 34006', async () => {
    const findFirst = jest.fn();
    const { policy } = createPolicy({
      roleBinding: { findFirst },
    });

    let thrown: unknown;
    try {
      await policy.assertActorMayConferRole(
        {
          id: 'su-id',
          username: 'su',
          role: Role.SUPER_ADMIN,
          status: UserStatus.ACTIVE,
          memberId: null,
        },
        { code: 'activity-owner', rolePermissions: [] },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BizException);
    expect((thrown as BizException).biz.code).toBe(
      BizCode.ROLE_BINDING_SYSTEM_MANAGED_ROLE_FORBIDDEN.code,
    );
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('SUPER_ADMIN 委派普通角色保持短路，不查询 User 或 RoleBinding', async () => {
    const userFindFirst = jest.fn();
    const bindingFindFirst = jest.fn();
    const { policy, acquireOpsAdminInvariantLock } = createPolicy({
      user: { findFirst: userFindFirst },
      roleBinding: { findFirst: bindingFindFirst },
    });

    await expect(
      policy.assertActorMayConferRole({ ...actor, role: Role.SUPER_ADMIN }, ordinaryRole),
    ).resolves.toBeUndefined();
    expect(userFindFirst).not.toHaveBeenCalled();
    expect(bindingFindFirst).not.toHaveBeenCalled();
    expect(acquireOpsAdminInvariantLock).not.toHaveBeenCalled();
  });

  it('非 SUPER_ADMIN 的 User 已禁用/软删：即使有 binding 也拒绝 30102', async () => {
    const bindingFindFirst = jest.fn().mockResolvedValue({ id: 'binding-1' });
    const { policy } = createPolicy({
      user: { findFirst: jest.fn().mockResolvedValue(null) },
      roleBinding: { findFirst: bindingFindFirst },
    });

    await expect(policy.assertActorMayConferRole(actor, ordinaryRole)).rejects.toEqual(
      new BizException(BizCode.CANNOT_ASSIGN_HIGHER_ROLE),
    );
    expect(bindingFindFirst).not.toHaveBeenCalled();
  });

  it('future/expired/ENDED/软删 binding 均由统一当前有效 where 排除，无命中即拒绝 30102', async () => {
    const bindingFindFirst = jest
      .fn<Promise<{ id: string } | null>, [{ where: ActorOpsAdminWhere }]>()
      .mockResolvedValue(null);
    const { policy } = createPolicy({
      user: { findFirst: jest.fn().mockResolvedValue({ id: actor.id }) },
      roleBinding: { findFirst: bindingFindFirst },
    });

    await expect(policy.assertActorMayConferRole(actor, ordinaryRole)).rejects.toEqual(
      new BizException(BizCode.CANNOT_ASSIGN_HIGHER_ROLE),
    );
    const where = bindingFindFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      principalId: actor.id,
      status: BindingStatus.ACTIVE,
      deletedAt: null,
      role: { code: 'ops-admin', deletedAt: null },
    });
    expect(where.startedAt.lte).toBeInstanceOf(Date);
    expect(where.OR[0]).toEqual({ endedAt: null });
    const endRange = where.OR.find(({ endedAt }) => endedAt !== null);
    expect(endRange?.endedAt).not.toBeNull();
    if (endRange?.endedAt === null || endRange === undefined) {
      throw new Error('expected endedAt current-term range');
    }
    expect(endRange.endedAt.gte).toBeInstanceOf(Date);
  });

  it('当前有效临时 ops-admin 可按旧规则委派普通角色', async () => {
    const { policy } = createPolicy({
      user: { findFirst: jest.fn().mockResolvedValue({ id: actor.id }) },
      roleBinding: { findFirst: jest.fn().mockResolvedValue({ id: 'binding-1' }) },
    });

    await expect(policy.assertActorMayConferRole(actor, ordinaryRole)).resolves.toBeUndefined();
  });

  it('非 SUPER_ADMIN 写委派先取 ops advisory，再查询 actor User 与当前 binding', async () => {
    const tx = {
      user: { findFirst: jest.fn().mockResolvedValue({ id: actor.id }) },
      roleBinding: { findFirst: jest.fn().mockResolvedValue({ id: 'binding-1' }) },
    };
    const { policy, acquireOpsAdminInvariantLock } = createPolicy(tx);

    await expect(
      policy.assertActorMayDelegateForWrite(actor, tx as never),
    ).resolves.toBeUndefined();

    expect(acquireOpsAdminInvariantLock).toHaveBeenCalledWith(tx);
    expect(acquireOpsAdminInvariantLock.mock.invocationCallOrder[0]).toBeLessThan(
      tx.user.findFirst.mock.invocationCallOrder[0],
    );
    expect(tx.user.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      tx.roleBinding.findFirst.mock.invocationCallOrder[0],
    );
  });
});
