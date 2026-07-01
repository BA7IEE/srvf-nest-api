import { Prisma } from '@prisma/client';

// 终态 scoped-authz PR3(2026-07-01;冻结稿 §3.2):职务定义对外字段集中 select(沿 contribution-rules.select 范式)。
// 永不含 deletedAt(软删内部状态)。增删字段必须与 PositionResponseDto 两边同步。
export const positionSafeSelect = {
  id: true,
  code: true,
  name: true,
  categoryCode: true,
  rank: true,
  isLeadership: true,
  allowMultiple: true,
  allowConcurrent: true,
  sortOrder: true,
  status: true,
  description: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.OrganizationPositionSelect;

export type SafePosition = Prisma.OrganizationPositionGetPayload<{
  select: typeof positionSafeSelect;
}>;
