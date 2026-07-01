import { Prisma } from '@prisma/client';

// 终态 scoped-authz PR5(2026-07-01;冻结稿 §3.5):分管对外字段集中 select(沿 position-assignments.select 范式)。
// 永不含 deletedAt(软删内部状态)。增删字段必须与 SupervisionAssignmentResponseDto 两边同步。
export const supervisionAssignmentSafeSelect = {
  id: true,
  supervisorMemberId: true,
  organizationId: true,
  scopeMode: true,
  status: true,
  startedAt: true,
  endedAt: true,
  appointedByUserId: true,
  revokedByUserId: true,
  note: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.OrganizationSupervisionAssignmentSelect;

export type SafeSupervisionAssignment = Prisma.OrganizationSupervisionAssignmentGetPayload<{
  select: typeof supervisionAssignmentSafeSelect;
}>;
