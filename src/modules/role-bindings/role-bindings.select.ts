import { Prisma } from '@prisma/client';

// 终态 scoped-authz PR6(2026-07-01;冻结稿 §3.6):角色绑定对外字段集中 select(沿 supervision-assignments.select 范式)。
// 永不含 deletedAt(软删内部状态)。增删字段必须与 RoleBindingResponseDto 两边同步。
export const roleBindingSafeSelect = {
  id: true,
  principalType: true,
  principalId: true,
  roleId: true,
  scopeType: true,
  scopeOrgId: true,
  scopeActivityId: true,
  scopeResourceType: true,
  scopeResourceId: true,
  status: true,
  startedAt: true,
  endedAt: true,
  createdByUserId: true,
  note: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.RoleBindingSelect;

export type SafeRoleBinding = Prisma.RoleBindingGetPayload<{
  select: typeof roleBindingSafeSelect;
}>;
