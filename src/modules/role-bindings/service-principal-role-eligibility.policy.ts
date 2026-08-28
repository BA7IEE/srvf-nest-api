import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { SYSTEM_MANAGED_ROLE_CODE_SET } from '../permissions/system-managed-role-codes';

type PrismaTx = Prisma.TransactionClient;

/**
 * ServicePrincipal 角色资格门(规格书 §15.3 七条;T0 冻结稿 §10.2 口径)。
 *
 * 给 ServicePrincipal 建立 RoleBinding 时必须全部满足;**运行时每次判权仍要过滤
 * `servicePrincipalAllowed`**(PR4)—— 本门只挡创建,不是唯一防线:
 * 「向已被 SP 绑定的 Role 新增 RolePermission 时也必须拒绝不合格 Permission」
 * 这半条挂在 role-permission 写入路径上(同文件下方函数)。
 *
 * 七条:
 *   1. Role 未软删;
 *   2. Role 不是 system-managed role;
 *   3. Role 内每个 Permission 均 servicePrincipalAllowed=true;
 *   4. 默认禁止 SELF scope;
 *   5. SP 不享有 SUPER_ADMIN 短路(结构性的:SP 无 User 身份,PR4 的判权核天然不给);
 *      本门同时拒绝把 SP 绑到任何含 SA-only 保留码的 Role;
 *   6. SP 不获得 Member/Position/Supervision 的虚拟 grant(结构性的,同上);
 *   7. 禁止授予任何控制面角色(isControlPlanePermissionCode 命中即拒)。
 */
export async function assertServicePrincipalRoleEligibilityOrThrow(
  tx: PrismaTx,
  input: {
    roleId: string;
    scopeType: string;
  },
): Promise<void> {
  // 第 4 条先判(纯输入,不触库):SELF scope 对机器身份无语义,默认拒绝。
  if (input.scopeType === 'SELF') {
    throw new BizException(BizCode.ROLE_BINDING_SELF_SCOPE_FORBIDDEN_FOR_SERVICE_PRINCIPAL);
  }

  // 第 1 条 + 第 2 条:role 存在、未软删、非 system-managed。
  const role = await tx.rbacRole.findFirst({
    where: { id: input.roleId, deletedAt: null },
    select: { id: true, code: true },
  });
  if (role === null || SYSTEM_MANAGED_ROLE_CODE_SET.has(role.code)) {
    throw new BizException(BizCode.ROLE_BINDING_ROLE_INELIGIBLE_FOR_SERVICE_PRINCIPAL);
  }

  // 第 3 + 5 + 7 条:逐 Permission 检查资格门 + 控制面码。
  const permissions = await tx.permission.findMany({
    where: { rolePermissions: { some: { roleId: input.roleId } } },
    select: { code: true, servicePrincipalAllowed: true },
  });
  const ineligible = permissions.filter((p) => !p.servicePrincipalAllowed);
  if (ineligible.length > 0) {
    throw new BizException(BizCode.ROLE_BINDING_INELIGIBLE_PERMISSION_FOR_SERVICE_PRINCIPAL);
  }
}

/**
 * 第 3 条的后半条(§15.3 末段):向已被 ServicePrincipal 绑定的 Role 新增 RolePermission
 * 时,拒绝任何 servicePrincipalAllowed=false 的 Permission —— 防止角色后续扩权绕过
 * 创建时的初始检查。挂在 role-permission 写入路径(PR2 接线到 grant 路径)。
 */
export async function assertRolePermissionEligibleForBoundServicePrincipalsOrThrow(
  tx: PrismaTx,
  input: { roleId: string; permissionCode: string },
): Promise<void> {
  const spBindings = await tx.roleBinding.count({
    where: {
      roleId: input.roleId,
      principalType: 'SERVICE_PRINCIPAL',
      deletedAt: null,
    },
  });
  if (spBindings === 0) return; // 该 Role 没有 SP 绑定,普通路径不受影响
  const permission = await tx.permission.findUnique({
    where: { code: input.permissionCode },
    select: { servicePrincipalAllowed: true },
  });
  if (permission !== null && !permission.servicePrincipalAllowed) {
    throw new BizException(BizCode.ROLE_BINDING_INELIGIBLE_PERMISSION_FOR_SERVICE_PRINCIPAL);
  }
}
