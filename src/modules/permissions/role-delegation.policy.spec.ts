import { isControlPlanePermissionCode, isPrivilegedRole } from './role-delegation.policy';
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
});
