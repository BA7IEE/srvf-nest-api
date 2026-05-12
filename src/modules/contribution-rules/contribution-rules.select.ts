import { Prisma } from '@prisma/client';

// V2 第一阶段批次 5-A contribution_rules 模块对外字段集中 select(D6 v1.1 §3.3 / 决议 E2)。
// 沿 v1 users.select.ts 范式;模块主体 4 文件 + 本辅助文件 = 5 个文件(D6 v1.1 §0 元信息)。
//
// 对外字段必须与 ContributionRuleResponseDto 严格同步:增删字段两边同时改。
// 永不包含 deletedAt / deletedByUserId(沿 v1 §11 严格类型分离)。
// 不暴露用户摘要(nickname / role / username,D6 v1.1 §2.2 E7)。
export const contributionRuleSafeSelect = {
  id: true,
  activityTypeCode: true,
  attendanceRoleCode: true,
  durationThreshold: true,
  pointsBelow: true,
  pointsAbove: true,
  dailyCap: true,
  status: true,
  remark: true,
  createdAt: true,
  updatedAt: true,
  createdByUserId: true,
  updatedByUserId: true,
} as const satisfies Prisma.ContributionRuleSelect;

export type SafeContributionRule = Prisma.ContributionRuleGetPayload<{
  select: typeof contributionRuleSafeSelect;
}>;
