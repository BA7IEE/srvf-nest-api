import { Injectable } from '@nestjs/common';
import {
  BindingScopeType,
  BindingStatus,
  PrincipalType,
  Prisma,
  Role,
  UserStatus,
} from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

export const LAST_SUPER_ADMIN_LOCK_KEY = 'users:last-super-admin';
export const LAST_OPS_ADMIN_LOCK_KEY = 'role-bindings:last-ops-admin';

const OPS_ADMIN_CODE = 'ops-admin';

type PrismaTx = Prisma.TransactionClient;

export interface RemovableRoleBinding {
  id: string;
  principalType: PrincipalType;
  principalId: string | null;
  scopeType: BindingScopeType;
  status: BindingStatus;
  role: { code: string };
}

// 两个「至少保留一名管理员」不变量的单一事务策略。
// 调用方仍持有 transaction；本策略只负责同不变量共锁、锁后重算与拒绝。
@Injectable()
export class LastAdminProtectionPolicy {
  async assertCanRemoveSuperAdmin(tx: PrismaTx, affectedUserId: string): Promise<void> {
    await this.acquireInvariantLock(tx, LAST_SUPER_ADMIN_LOCK_KEY);
    const remaining = await tx.user.count({
      where: {
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
        deletedAt: null,
        id: { not: affectedUserId },
      },
    });
    if (remaining === 0) {
      throw new BizException(BizCode.LAST_SUPER_ADMIN_PROTECTED);
    }
  }

  async assertCanRemoveOpsAdminBinding(tx: PrismaTx, binding: RemovableRoleBinding): Promise<void> {
    if (
      binding.principalType !== PrincipalType.USER ||
      binding.principalId === null ||
      binding.scopeType !== BindingScopeType.GLOBAL ||
      binding.status !== BindingStatus.ACTIVE ||
      binding.role.code !== OPS_ADMIN_CODE
    ) {
      return;
    }

    await this.acquireInvariantLock(tx, LAST_OPS_ADMIN_LOCK_KEY);
    const activeHolderIds = await this.getActiveOpsAdminHolderIds(tx);
    if (!activeHolderIds.some((id) => id !== binding.principalId)) {
      throw new BizException(BizCode.LAST_OPS_ADMIN_PROTECTED);
    }
  }

  async assertCanDeactivateOpsAdminUser(tx: PrismaTx, affectedUserId: string): Promise<void> {
    // 必须先锁再判断 target 是否持有 ops-admin：禁用与并发授予/撤销交错时也不能留下零可用管理员。
    await this.acquireInvariantLock(tx, LAST_OPS_ADMIN_LOCK_KEY);
    const activeHolderIds = await this.getActiveOpsAdminHolderIds(tx);
    if (
      activeHolderIds.includes(affectedUserId) &&
      !activeHolderIds.some((id) => id !== affectedUserId)
    ) {
      throw new BizException(BizCode.LAST_OPS_ADMIN_PROTECTED);
    }
  }

  private async acquireInvariantLock(tx: PrismaTx, lockKey: string): Promise<void> {
    // Prisma 不支持 PostgreSQL void 结果型；cast text 仅为驱动可反序列化，锁语义不变。
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS locked`;
  }

  private async getActiveOpsAdminHolderIds(tx: PrismaTx): Promise<string[]> {
    const bindings = await tx.roleBinding.findMany({
      where: {
        principalType: PrincipalType.USER,
        scopeType: BindingScopeType.GLOBAL,
        status: BindingStatus.ACTIVE,
        deletedAt: null,
        role: { code: OPS_ADMIN_CODE, deletedAt: null },
      },
      select: { principalId: true },
    });
    const candidateIds = [
      ...new Set(
        bindings.map(({ principalId }) => principalId).filter((id): id is string => id !== null),
      ),
    ];
    if (candidateIds.length === 0) return [];

    const activeUsers = await tx.user.findMany({
      where: {
        id: { in: candidateIds },
        status: UserStatus.ACTIVE,
        deletedAt: null,
      },
      select: { id: true },
    });
    return activeUsers.map(({ id }) => id);
  }
}
