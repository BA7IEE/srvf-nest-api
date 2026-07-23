import { Role, UserStatus } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  isControlPlanePermissionCode,
  isPrivilegedRole,
  RoleDelegationPolicy,
} from './role-delegation.policy';
import { RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES } from './reserved-super-admin-permission-codes';

describe('role delegation control-plane classification', () => {
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
    const policy = new RoleDelegationPolicy({
      roleBinding: { findFirst },
    } as never);

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
});
