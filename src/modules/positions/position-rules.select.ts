import { Prisma } from '@prisma/client';

// 终态 scoped-authz PR3(2026-07-01;冻结稿 §3.3):职务规则对外字段集中 select(沿 positions.select 范式)。
// 永不含 deletedAt(软删内部状态)。增删字段必须与 PositionRuleResponseDto 两边同步。
export const positionRuleSafeSelect = {
  id: true,
  nodeTypeCode: true,
  positionId: true,
  required: true,
  minCount: true,
  maxCount: true,
  requireMembership: true,
  allowConcurrent: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.OrganizationPositionRuleSelect;

export type SafePositionRule = Prisma.OrganizationPositionRuleGetPayload<{
  select: typeof positionRuleSafeSelect;
}>;
