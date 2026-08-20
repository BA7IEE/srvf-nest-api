import { Prisma } from '@prisma/client';
import { toMemberLabelFields } from '../../common/identity/member-label.util';
import type { UserResponseDto } from './users.dto';

// 集中定义对外字段的 Prisma select。详见 docs/reference/naming-dto-validation.md §11。
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
// memberId + member 摘要关系(身份三件套 memberNo / realName / nickname)。**仅**服务这两个 admin 端点——
// App 自助面(me/password 等)继续用 userSafeSelect,不叠加本 select(沿 §5.2 #2
// App DTO 隔离铁律;避免 App API 边界被顺手改动)。
export const userAdminSelect = {
  ...userSafeSelect,
  memberId: true,
  member: {
    select: {
      memberNo: true,
      realName: true,
      nickname: true,
    },
  },
} as const satisfies Prisma.UserSelect;

export type SafeUserWithMember = Prisma.UserGetPayload<{ select: typeof userAdminSelect }>;

// issue #1048 T1:`UserLinkedMemberDto` 多了一个后端拼装的 `label`,
// 而 Prisma 行里没有它 —— 两个 admin 端点(list / findOne)都必须过这一层再出。
// 放在 select 文件而不是 service:投影与它的呈现形状本来就该一起看。
export function presentUserWithMember(row: SafeUserWithMember): UserResponseDto {
  const member = row.member;
  // `member` 恒在 userAdminSelect 里 ⇒ 真实运行时只可能是对象或 null。
  // 仍然用 `!member` 而不是 `=== null`:`UserLinkedMemberDto` 在契约上是**可选**属性
  //(缺失 ≠ null,见其顶部注释),而 characterization spec 用的是手搓最小 mock、
  // 根本没有这个键 —— 只判 null 会在那里抛 TypeError。原样回传保住「缺失仍缺失」。
  if (!member) return { ...row, member };
  return { ...row, member: toMemberLabelFields(member) };
}
