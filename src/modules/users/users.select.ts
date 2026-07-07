import { Prisma } from '@prisma/client';

// 集中定义对外字段的 Prisma select。详见 ARCHITECTURE.md §7.9。
// 任何对外返回 User 的查询必须使用本常量,禁止散写不同的 select。
// 本常量与 UserResponseDto 字段必须严格同步:增删字段时同时改两边。
// 永不包含 passwordHash / deletedAt。
export const userSafeSelect = {
  id: true,
  username: true,
  email: true,
  nickname: true,
  avatarKey: true,
  role: true,
  status: true,
  createdAt: true,
  lastLoginAt: true,
  updatedAt: true,
} as const satisfies Prisma.UserSelect;

export type SafeUser = Prisma.UserGetPayload<{ select: typeof userSafeSelect }>;

// 队员账号闭环 v1(2026-07-07):admin list / findOne 专用 select,additive 叠加
// memberId + member 摘要关系(memberNo/displayName)。**仅**服务这两个 admin 端点——
// App 自助面(me/password 等)继续用 userSafeSelect,不叠加本 select(沿 §5.2 #2
// App DTO 隔离铁律;避免 App API 边界被顺手改动)。
export const userAdminSelect = {
  ...userSafeSelect,
  memberId: true,
  member: {
    select: {
      memberNo: true,
      displayName: true,
    },
  },
} as const satisfies Prisma.UserSelect;

export type SafeUserWithMember = Prisma.UserGetPayload<{ select: typeof userAdminSelect }>;
