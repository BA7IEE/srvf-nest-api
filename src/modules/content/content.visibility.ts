import { Prisma } from '@prisma/client';

import {
  CONTENT_STATUS_PUBLISHED,
  CONTENT_VISIBILITY_DEPARTMENT,
  CONTENT_VISIBILITY_FORMAL_MEMBER,
  CONTENT_VISIBILITY_MANAGEMENT,
  CONTENT_VISIBILITY_MEMBER,
  CONTENT_VISIBILITY_PUBLIC,
} from './content.constants';

// CMS 内容发布模块(第 28 模块)可见性模型(冻结评审稿 docs/archive/reviews/content-module-review.md §4)。
//
// 5 档可见(每篇选一):public / member / formal_member / department / management。
// 设计:caller 上下文**一次性 async 解析**(在 content-read.service:isMember = canUseApp /
// isFormalMember = 有活跃 member_department / activeOrgIds / isManagement = rbac.can('content.read.record')
// 或 role ∈ {SUPER_ADMIN, ADMIN}),再喂入本文件**纯同步函数**(可单测,零 DB)。
//
// - canSeeContent:单条判定(app/v1 详情用;已含 published 前提)。
// - buildVisibilityWhere:list where(published + 命中可见档 OR;分页正确性靠 DB 过滤,绝不读后内存过滤)。
//   open/v1 用 ANON_VISIBILITY_CONTEXT(只命中 public);app/v1 用解析出的真实 ctx。
//   搜索 keyword / 标签 tags 由调用方 AND 在本 where 之上(评审稿 §6:绝不旁路可见性)。

export interface CallerVisibilityContext {
  // 任意活跃登录会员(志愿者 + 队员;= AppIdentityResolver.canUseApp)
  isMember: boolean;
  // 有 ≥1 活跃 member_department(正式队员;org ACTIVE 且未软删)
  isFormalMember: boolean;
  // 活跃 member_department.organizationId 数组(department 档命中判定用)
  activeOrgIds: string[];
  // 管理层 = rbac.can('content.read.record') 或 role ∈ {SUPER_ADMIN, ADMIN}
  isManagement: boolean;
}

// 匿名上下文(open/v1 无登录):只命中 public 档。
export const ANON_VISIBILITY_CONTEXT: CallerVisibilityContext = {
  isMember: false,
  isFormalMember: false,
  activeOrgIds: [],
  isManagement: false,
};

// 单条可见性判定(纯函数)。app/v1 详情:先取行再判;非 published 一律不可见。
export function canSeeContent(
  ctx: CallerVisibilityContext,
  content: {
    statusCode: string;
    visibilityCode: string;
    visibleOrganizationIds: readonly string[];
  },
): boolean {
  if (content.statusCode !== CONTENT_STATUS_PUBLISHED) return false;
  switch (content.visibilityCode) {
    case CONTENT_VISIBILITY_PUBLIC:
      return true;
    case CONTENT_VISIBILITY_MEMBER:
      return ctx.isMember;
    case CONTENT_VISIBILITY_FORMAL_MEMBER:
      return ctx.isFormalMember;
    case CONTENT_VISIBILITY_DEPARTMENT:
      return ctx.activeOrgIds.some((id) => content.visibleOrganizationIds.includes(id));
    case CONTENT_VISIBILITY_MANAGEMENT:
      return ctx.isManagement;
    default:
      // 未知 / 脏可见档 → fail-close(看不到不该看的)
      return false;
  }
}

// list where:published + 按 ctx 命中的可见档 OR(纯函数,返回 Prisma where 片段)。
// 调用方在此之上 AND keyword(ILIKE title/body)/ tags(hasSome),保证搜索/标签不旁路可见性。
export function buildVisibilityWhere(ctx: CallerVisibilityContext): Prisma.ContentWhereInput {
  const or: Prisma.ContentWhereInput[] = [{ visibilityCode: CONTENT_VISIBILITY_PUBLIC }];
  if (ctx.isMember) or.push({ visibilityCode: CONTENT_VISIBILITY_MEMBER });
  if (ctx.isFormalMember) or.push({ visibilityCode: CONTENT_VISIBILITY_FORMAL_MEMBER });
  if (ctx.activeOrgIds.length > 0) {
    or.push({
      visibilityCode: CONTENT_VISIBILITY_DEPARTMENT,
      visibleOrganizationIds: { hasSome: ctx.activeOrgIds },
    });
  }
  if (ctx.isManagement) or.push({ visibilityCode: CONTENT_VISIBILITY_MANAGEMENT });
  return { deletedAt: null, statusCode: CONTENT_STATUS_PUBLISHED, OR: or };
}
