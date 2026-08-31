import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { SYSTEM_MANAGED_ROLE_CODE_SET } from './system-managed-role-codes';

type PrismaTx = Prisma.TransactionClient;

/**
 * Service Principal Role 的跨写路径资格门。
 *
 * 调用方负责先取得同一 Role 的生命周期锁；本 Policy 在锁后读取最终事实，避免 RolePermission
 * 改写与 SP Binding 创建/恢复从两个快照交错提交。运行时仍保留 servicePrincipalAllowed 过滤，
 * 这是控制面约束之外的第二道防线。
 */
@Injectable()
export class ServicePrincipalRoleEligibilityPolicy {
  /** 建立或重新生效的 SP Binding 必须满足的完整资格门。 */
  async assertBindingEligible(
    tx: PrismaTx,
    input: { roleId: string; scopeType: string },
  ): Promise<void> {
    if (input.scopeType === 'SELF') {
      throw new BizException(BizCode.ROLE_BINDING_SELF_SCOPE_FORBIDDEN_FOR_SERVICE_PRINCIPAL);
    }

    const role = await tx.rbacRole.findFirst({
      where: { id: input.roleId, deletedAt: null },
      select: {
        code: true,
        rolePermissions: {
          select: { permission: { select: { servicePrincipalAllowed: true } } },
        },
      },
    });
    if (role === null || SYSTEM_MANAGED_ROLE_CODE_SET.has(role.code)) {
      throw new BizException(BizCode.ROLE_BINDING_ROLE_INELIGIBLE_FOR_SERVICE_PRINCIPAL);
    }
    if (role.rolePermissions.some((row) => !row.permission.servicePrincipalAllowed)) {
      throw new BizException(BizCode.ROLE_BINDING_INELIGIBLE_PERMISSION_FOR_SERVICE_PRINCIPAL);
    }
  }

  /**
   * RolePermission 整集替换的最终态资格门。
   *
   * 只要存在任意未软删 SP Binding（包括 SUSPENDED、未来和已过期但未软删的 Binding），
   * 目标权限全集就必须全部允许机器身份。检查放在 no-op 之前，确保历史脏数据不会被回显为有效。
   */
  async assertFinalPermissionSetEligibleForBoundServicePrincipals(
    tx: PrismaTx,
    input: { roleId: string; targetPermissionCodes: readonly string[] },
  ): Promise<void> {
    const binding = await tx.roleBinding.findFirst({
      where: {
        roleId: input.roleId,
        principalType: 'SERVICE_PRINCIPAL',
        deletedAt: null,
      },
      select: { id: true },
    });
    if (binding === null) return;

    const targetPermissionCodes = [...new Set(input.targetPermissionCodes)];
    const permissions = await tx.permission.findMany({
      where: { code: { in: targetPermissionCodes } },
      select: { code: true, servicePrincipalAllowed: true },
    });
    if (permissions.length !== targetPermissionCodes.length) {
      throw new BizException(BizCode.PERMISSION_NOT_FOUND);
    }
    if (permissions.some((permission) => !permission.servicePrincipalAllowed)) {
      throw new BizException(BizCode.ROLE_BINDING_INELIGIBLE_PERMISSION_FOR_SERVICE_PRINCIPAL);
    }
  }
}
