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
