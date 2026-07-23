import { Injectable } from '@nestjs/common';
import { BindingScopeType, BindingStatus, PrincipalType, Prisma, Role } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET } from './reserved-super-admin-permission-codes';
import { SYSTEM_MANAGED_ROLE_CODE_SET } from './system-managed-role-codes';

const OPS_ADMIN_ROLE_CODE = 'ops-admin';
const CONTROL_PLANE_PERMISSION_PREFIXES = ['rbac.', 'role-binding.'] as const;

type RoleDelegationClient = Pick<Prisma.TransactionClient, 'roleBinding'>;

export interface RoleDelegationTarget {
  code: string;
  rolePermissions: ReadonlyArray<{
    permission: { code: string };
  }>;
}

/**
 * 控制面权限码单一谓词。
 *
 * 保留码集合的唯一真相仍在 reserved-super-admin-permission-codes.ts；本谓词只把该 SoT
 * 与 RBAC / RoleBinding 两类控制面前缀合并，供授码与角色委派共同消费。
 */
export function isControlPlanePermissionCode(code: string): boolean {
  return (
    RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET.has(code) ||
    CONTROL_PLANE_PERMISSION_PREFIXES.some((prefix) => code.startsWith(prefix))
  );
}

export function isPrivilegedRole(role: RoleDelegationTarget): boolean {
  return (
    role.code === OPS_ADMIN_ROLE_CODE ||
    role.rolePermissions.some(({ permission }) => isControlPlanePermissionCode(permission.code))
  );
}

/**
 * 角色委派单一强制入口。
 *
 * 系统托管角色对所有人工入口（包括 SUPER_ADMIN）关闭；其余角色由 SUPER_ADMIN 短路，
 * 非 SUPER_ADMIN 只有 global ops-admin 持有者可操作，且不得授予/撤销任何特权角色。
 * 调用方负责在进入本策略前加载未软删目标角色及其权限码。
 */
@Injectable()
export class RoleDelegationPolicy {
  constructor(private readonly prisma: PrismaService) {}

  assertRoleIsNotSystemManaged(targetRole: Pick<RoleDelegationTarget, 'code'>): void {
    if (SYSTEM_MANAGED_ROLE_CODE_SET.has(targetRole.code)) {
      throw new BizException(BizCode.ROLE_BINDING_SYSTEM_MANAGED_ROLE_FORBIDDEN);
    }
  }

  async assertActorMayConferRole(
    actor: CurrentUserPayload,
    targetRole: RoleDelegationTarget,
    client: RoleDelegationClient = this.prisma,
  ): Promise<void> {
    this.assertRoleIsNotSystemManaged(targetRole);

    if (actor.role === Role.SUPER_ADMIN) return;

    if (isPrivilegedRole(targetRole)) {
      throw new BizException(BizCode.CANNOT_ASSIGN_HIGHER_ROLE);
    }

    const actorOpsAdminBinding = await client.roleBinding.findFirst({
      where: {
        principalType: PrincipalType.USER,
        principalId: actor.id,
        scopeType: BindingScopeType.GLOBAL,
        status: BindingStatus.ACTIVE,
        deletedAt: null,
        role: { code: OPS_ADMIN_ROLE_CODE, deletedAt: null },
      },
      select: { id: true },
    });
    if (!actorOpsAdminBinding) {
      throw new BizException(BizCode.CANNOT_ASSIGN_HIGHER_ROLE);
    }
  }
}
