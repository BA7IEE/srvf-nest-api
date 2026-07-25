import { BindingScopeType, BindingStatus, PrincipalType, Prisma } from '@prisma/client';

export const OPS_ADMIN_ROLE_CODE = 'ops-admin';

export interface RoleBindingValiditySnapshot {
  status: BindingStatus;
  startedAt: Date;
  endedAt: Date | null;
  deletedAt: Date | null;
}

// RoleBinding / assignment / supervision 共用的任期边界：起止时刻均包含在有效期内。
export function isWithinTerm(startedAt: Date, endedAt: Date | null, now: Date): boolean {
  return (
    startedAt.getTime() <= now.getTime() && (endedAt === null || endedAt.getTime() >= now.getTime())
  );
}

// RoleBinding 当前有效性的唯一纯谓词。User / Role 自身可用性由调用方按各自实体边界补充。
export function isEffectiveRoleBinding(binding: RoleBindingValiditySnapshot, now: Date): boolean {
  return (
    binding.status === BindingStatus.ACTIVE &&
    binding.deletedAt === null &&
    isWithinTerm(binding.startedAt, binding.endedAt, now)
  );
}

// 所有 scope / principal 共用的当前有效 RoleBinding where；起止边界均包含。
export function effectiveRoleBindingWhere(now: Date): Prisma.RoleBindingWhereInput {
  return {
    status: BindingStatus.ACTIVE,
    startedAt: { lte: now },
    OR: [{ endedAt: null }, { endedAt: { gte: now } }],
    deletedAt: null,
  };
}

// 当前有效的 USER × GLOBAL RoleBinding 基座。principalId 由具体消费者按需追加。
export function effectiveGlobalUserRoleBindingsWhere(now: Date): Prisma.RoleBindingWhereInput {
  return {
    ...effectiveRoleBindingWhere(now),
    principalType: PrincipalType.USER,
    scopeType: BindingScopeType.GLOBAL,
    role: { deletedAt: null },
  };
}

// Legacy RBAC 的唯一有效读源：当前生效的 USER × GLOBAL RoleBinding。
// Authz 为保留 expired_grant 归因会读取失效行后调用 isWithinTerm；两条判权链共享同一任期边界真相。
export function effectiveGlobalUserRoleBindingWhere(
  principalId: string,
  now: Date,
): Prisma.RoleBindingWhereInput {
  return {
    ...effectiveGlobalUserRoleBindingsWhere(now),
    principalId,
  };
}

// 当前有效的 USER × GLOBAL × ops-admin RoleBinding；User ACTIVE/未删仍由 holder 策略统一过滤。
export function effectiveGlobalOpsAdminBindingWhere(now: Date): Prisma.RoleBindingWhereInput {
  return {
    ...effectiveGlobalUserRoleBindingsWhere(now),
    role: { code: OPS_ADMIN_ROLE_CODE, deletedAt: null },
  };
}

// 常驻兜底 = 当前有效 ops-admin 且无 endedAt。
export function currentPermanentGlobalOpsAdminBindingWhere(
  now: Date,
): Prisma.RoleBindingWhereInput {
  return {
    ...effectiveGlobalOpsAdminBindingWhere(now),
    endedAt: null,
  };
}
