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
import {
  effectiveGlobalOpsAdminBindingWhere,
  isEffectiveRoleBinding,
  OPS_ADMIN_ROLE_CODE,
} from './role-binding-validity';

export const LAST_SUPER_ADMIN_LOCK_KEY = 'users:last-super-admin';
export const LAST_OPS_ADMIN_LOCK_KEY = 'role-bindings:last-ops-admin';

type PrismaTx = Prisma.TransactionClient;

export interface RemovableRoleBinding {
  id: string;
  principalType: PrincipalType;
  principalId: string | null;
  scopeType: BindingScopeType;
  status: BindingStatus;
  startedAt: Date;
  endedAt: Date | null;
  deletedAt: Date | null;
  role: { code: string; deletedAt: Date | null };
}

export interface OpsAdminBindingMutation {
  status?: BindingStatus;
  startedAt?: Date;
  endedAt?: Date | null;
  deletedAt?: Date | null;
}

// 两个「至少保留一名管理员」不变量的单一事务策略。
// 调用方仍持有 transaction；本策略只负责同不变量共锁、锁后重算与拒绝。
@Injectable()
export class LastAdminProtectionPolicy {
  async acquireSuperAdminInvariantLock(tx: PrismaTx): Promise<void> {
    await this.acquireInvariantLock(tx, LAST_SUPER_ADMIN_LOCK_KEY);
  }

  async acquireOpsAdminInvariantLock(tx: PrismaTx): Promise<void> {
    await this.acquireInvariantLock(tx, LAST_OPS_ADMIN_LOCK_KEY);
  }

  async assertCanRemoveSuperAdmin(tx: PrismaTx, affectedUserId: string): Promise<void> {
    await this.acquireSuperAdminInvariantLock(tx);
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
    const now = new Date();
    await this.assertCanMutateOpsAdminBinding(tx, binding, {
      status: BindingStatus.ENDED,
      endedAt: now,
      deletedAt: now,
    });
  }

  async assertCanUpdateOpsAdminBinding(
    tx: PrismaTx,
    binding: RemovableRoleBinding,
    mutation: OpsAdminBindingMutation,
  ): Promise<void> {
    await this.assertCanMutateOpsAdminBinding(tx, binding, mutation);
  }

  async assertCanDeactivateOpsAdminUser(tx: PrismaTx, affectedUserId: string): Promise<void> {
    // 必须先锁再判断 target 是否持有 ops-admin：禁用与并发授予/撤销交错时也不能留下零可用管理员。
    await this.acquireOpsAdminInvariantLock(tx);
    const now = new Date();
    const holders = await this.getCurrentOpsAdminHolders(tx, now);
    if (!holders.effectiveHolderIds.has(affectedUserId)) return;

    const remainingEffective = this.without(holders.effectiveHolderIds, affectedUserId);
    const remainingPermanent = this.without(holders.permanentHolderIds, affectedUserId);
    if (remainingEffective.size === 0 || remainingPermanent.size === 0) {
      throw new BizException(BizCode.LAST_OPS_ADMIN_PROTECTED);
    }
  }

  private async acquireInvariantLock(tx: PrismaTx, lockKey: string): Promise<void> {
    // Prisma 不支持 PostgreSQL void 结果型；cast text 仅为驱动可反序列化，锁语义不变。
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS locked`;
  }

  private async assertCanMutateOpsAdminBinding(
    tx: PrismaTx,
    binding: RemovableRoleBinding,
    mutation: OpsAdminBindingMutation,
  ): Promise<void> {
    // principal / role / scope 不可由 RoleBinding PATCH 改；先用它们避免普通绑定争抢 ops invariant。
    // status / 任期必须锁后重读，绝不信调用方的旧快照。
    if (!this.isGlobalUserOpsAdminBinding(binding)) return;

    await this.acquireOpsAdminInvariantLock(tx);
    const now = new Date();
    const lockedBinding = await tx.roleBinding.findFirst({
      where: { id: binding.id, deletedAt: null },
      select: {
        id: true,
        principalType: true,
        principalId: true,
        scopeType: true,
        status: true,
        startedAt: true,
        endedAt: true,
        deletedAt: true,
        role: { select: { code: true, deletedAt: true } },
      },
    });
    if (!lockedBinding || !this.isGlobalUserOpsAdminBinding(lockedBinding)) return;

    const holders = await this.getCurrentOpsAdminHolders(tx, now);
    const affectedUserId = lockedBinding.principalId;
    if (
      affectedUserId === null ||
      !holders.effectiveHolderIds.has(affectedUserId) ||
      !isEffectiveRoleBinding(lockedBinding, now)
    ) {
      // future / expired / 非 ACTIVE / 已软删 / linked User 不可用的绑定本来就不在 holder 集合，允许清理。
      return;
    }

    const nextBinding: RemovableRoleBinding = {
      ...lockedBinding,
      ...mutation,
    };
    const remainsEffective =
      nextBinding.role.deletedAt === null && isEffectiveRoleBinding(nextBinding, now);
    const remainsPermanent = remainsEffective && nextBinding.endedAt === null;
    const currentlyPermanent = holders.permanentHolderIds.has(affectedUserId);

    const deprivesEffective = !remainsEffective;
    const deprivesPermanent = currentlyPermanent && !remainsPermanent;
    if (!deprivesEffective && !deprivesPermanent) return;

    const remainingEffective = new Set(holders.effectiveHolderIds);
    const remainingPermanent = new Set(holders.permanentHolderIds);
    if (deprivesEffective) remainingEffective.delete(affectedUserId);
    if (deprivesPermanent) remainingPermanent.delete(affectedUserId);
    if (remainingEffective.size === 0 || remainingPermanent.size === 0) {
      throw new BizException(BizCode.LAST_OPS_ADMIN_PROTECTED);
    }
  }

  private isGlobalUserOpsAdminBinding(
    binding: Pick<RemovableRoleBinding, 'principalType' | 'principalId' | 'scopeType' | 'role'>,
  ): boolean {
    return (
      binding.principalType === PrincipalType.USER &&
      binding.principalId !== null &&
      binding.scopeType === BindingScopeType.GLOBAL &&
      binding.role.code === OPS_ADMIN_ROLE_CODE
    );
  }

  private async getCurrentOpsAdminHolders(
    tx: PrismaTx,
    now: Date,
  ): Promise<{
    effectiveHolderIds: Set<string>;
    permanentHolderIds: Set<string>;
  }> {
    const bindings = await tx.roleBinding.findMany({
      where: effectiveGlobalOpsAdminBindingWhere(now),
      select: { principalId: true, endedAt: true },
    });
    const candidateIds = [
      ...new Set(
        bindings.map(({ principalId }) => principalId).filter((id): id is string => id !== null),
      ),
    ];
    if (candidateIds.length === 0) {
      return { effectiveHolderIds: new Set(), permanentHolderIds: new Set() };
    }

    const activeUsers = await tx.user.findMany({
      where: {
        id: { in: candidateIds },
        status: UserStatus.ACTIVE,
        deletedAt: null,
      },
      select: { id: true },
    });
    const activeUserIds = new Set(activeUsers.map(({ id }) => id));
    const effectiveHolderIds = new Set(
      candidateIds.filter((candidateId) => activeUserIds.has(candidateId)),
    );
    const permanentHolderIds = new Set(
      bindings
        .filter(({ principalId, endedAt }) => principalId !== null && endedAt === null)
        .map(({ principalId }) => principalId)
        .filter(
          (principalId): principalId is string =>
            principalId !== null && activeUserIds.has(principalId),
        ),
    );
    return { effectiveHolderIds, permanentHolderIds };
  }

  private without(values: ReadonlySet<string>, excluded: string): Set<string> {
    return new Set([...values].filter((value) => value !== excluded));
  }
}
