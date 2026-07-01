import { Prisma } from '@prisma/client';

// 终态 scoped-authz PR4(2026-07-01;冻结稿 §3.4):任职对外字段集中 select(沿 positions.select 范式)。
// 永不含 deletedAt(软删内部状态)。增删字段必须与 PositionAssignmentResponseDto 两边同步。
export const positionAssignmentSafeSelect = {
  id: true,
  organizationId: true,
  positionId: true,
  memberId: true,
  status: true,
  startedAt: true,
  endedAt: true,
  appointedByUserId: true,
  revokedByUserId: true,
  appointmentSource: true,
  isConcurrent: true,
  note: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.OrganizationPositionAssignmentSelect;

export type SafePositionAssignment = Prisma.OrganizationPositionAssignmentGetPayload<{
  select: typeof positionAssignmentSafeSelect;
}>;
