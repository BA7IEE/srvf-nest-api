import { Injectable } from '@nestjs/common';
import { Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { LastAdminProtectionPolicy } from './last-admin-protection.policy';
import { RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET } from './reserved-super-admin-permission-codes';
import { effectiveGlobalUserRoleBindingWhere, OPS_ADMIN_ROLE_CODE } from './role-binding-validity';
import { SYSTEM_MANAGED_ROLE_CODE_SET } from './system-managed-role-codes';

const CONTROL_PLANE_PERMISSION_PREFIXES = ['rbac.', 'role-binding.'] as const;

type RoleDelegationClient = Pick<Prisma.TransactionClient, 'roleBinding' | 'user'>;

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

/**
 * 「这条码是不是那 7 条 SA-only 保留码之一」。
 *
 * ⚠️ **与 `isControlPlanePermissionCode` 是真子集关系,不是同义词** —— 后者还并进了
 * `rbac.*` / `role-binding.*` 两个前缀族(含 `rbac.permission.read`、
 * `role-binding.read.record` 这类**纯只读**码)。两者的授码口径**不同**:
 *
 *   - 保留码(本谓词):维护者 2026-08-22 拍板②「**一条都不该进任何角色**」
 *     ⇒ 授码侧任何身份都拒,含 SUPER_ADMIN(P1-32 PR 3a 落地)。
 *   - 前缀族(仅 `isControlPlanePermissionCode` 命中的其余部分):**非 SA 拒、SA 可授**,
 *     语义一字未变。SUPER_ADMIN 仍能建出「RBAC 只读观察员」这类自定义角色 ——
 *     砍掉它没有任何拍板支持,而且会当场打掉 rbac-multi-instance-consistency e2e
 *     赖以证明「权限解析直读 DB」的那条授权。
 *
 * 🔴 别把这两个谓词合并成一个。它们回答的是两个不同的问题,合并等于在
 *    「谁不能授」上取并集,悄悄扩大或缩小其中一侧的口径。
 */
export function isReservedSuperAdminOnlyPermissionCode(code: string): boolean {
  return RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET.has(code);
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly lastAdminProtection: LastAdminProtectionPolicy,
  ) {}

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
    this.assertTargetRoleMayBeConferred(actor, targetRole);
    await this.assertActorMayDelegate(actor, client);
  }

  /**
   * preview 等只读入口在读取 target 前先复核 actor；SA 保持零查询短路。
   */
  async assertActorMayDelegate(
    actor: CurrentUserPayload,
    client: RoleDelegationClient = this.prisma,
  ): Promise<void> {
    if (actor.role === Role.SUPER_ADMIN) return;
    await this.assertActorIsCurrentOpsAdmin(actor, client);
  }

  /**
   * 非 SA 委派写必须在读取/锁定任何 target 前取得 ops invariant advisory，
   * 随即在锁内复核 actor 当前事实，并一直持锁到调用方事务提交。
   */
  async assertActorMayDelegateForWrite(
    actor: CurrentUserPayload,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (actor.role === Role.SUPER_ADMIN) return;
    await this.lastAdminProtection.acquireOpsAdminInvariantLock(tx);
    await this.assertActorIsCurrentOpsAdmin(actor, tx);
  }

  /**
   * actor-first 复核通过后才可加载 target role，并用本同步守卫保持 system-managed /
   * privileged role 的既有边界；SA 仍只短路普通/特权角色，不短路 system-managed。
   */
  assertTargetRoleMayBeConferred(
    actor: CurrentUserPayload,
    targetRole: RoleDelegationTarget,
  ): void {
    this.assertRoleIsNotSystemManaged(targetRole);

    if (actor.role === Role.SUPER_ADMIN) return;

    this.assertTargetIsOrdinaryRole(targetRole);
  }

  private assertTargetIsOrdinaryRole(targetRole: RoleDelegationTarget): void {
    if (isPrivilegedRole(targetRole)) {
      throw new BizException(BizCode.CANNOT_ASSIGN_HIGHER_ROLE);
    }
  }

  private async assertActorIsCurrentOpsAdmin(
    actor: CurrentUserPayload,
    client: RoleDelegationClient,
  ): Promise<void> {
    const actorUser = await client.user.findFirst({
      where: { id: actor.id, status: UserStatus.ACTIVE, deletedAt: null },
      select: { id: true },
    });
    if (!actorUser) {
      throw new BizException(BizCode.CANNOT_ASSIGN_HIGHER_ROLE);
    }

    const now = new Date();
    const actorOpsAdminBinding = await client.roleBinding.findFirst({
      where: {
        ...effectiveGlobalUserRoleBindingWhere(actor.id, now),
        role: { code: OPS_ADMIN_ROLE_CODE, deletedAt: null },
      },
      select: { id: true },
    });
    if (!actorOpsAdminBinding) {
      throw new BizException(BizCode.CANNOT_ASSIGN_HIGHER_ROLE);
    }
  }
}
