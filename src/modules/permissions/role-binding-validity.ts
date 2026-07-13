import { BindingScopeType, BindingStatus, PrincipalType, Prisma } from '@prisma/client';

// RoleBinding / assignment / supervision 共用的任期边界：起止时刻均包含在有效期内。
export function isWithinTerm(startedAt: Date, endedAt: Date | null, now: Date): boolean {
  return (
    startedAt.getTime() <= now.getTime() && (endedAt === null || endedAt.getTime() >= now.getTime())
  );
}

// Legacy RBAC 的唯一有效读源：当前生效的 USER × GLOBAL RoleBinding。
// Authz 为保留 expired_grant 归因会读取失效行后调用 isWithinTerm；两条判权链共享同一任期边界真相。
export function effectiveGlobalUserRoleBindingWhere(
  principalId: string,
  now: Date,
): Prisma.RoleBindingWhereInput {
  return {
    principalType: PrincipalType.USER,
    principalId,
    scopeType: BindingScopeType.GLOBAL,
    status: BindingStatus.ACTIVE,
    startedAt: { lte: now },
    OR: [{ endedAt: null }, { endedAt: { gte: now } }],
    deletedAt: null,
    role: { deletedAt: null },
  };
}
