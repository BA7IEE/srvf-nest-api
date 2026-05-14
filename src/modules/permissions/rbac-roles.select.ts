import { Prisma } from '@prisma/client';

// V2.x C-6 RBAC 实施 PR #3:RbacRole 模块对外 select 集中定义。
// 详见 ARCHITECTURE.md §7.9 + docs/批次8_RBAC_API前评审.md §4.1(D7 v1.1)。
//
// 任何对外返回必须使用本常量,禁止散写不同 select(沿 dictionaries / permissions 范式)。
// RbacRole 软删(D4 v1.0;deletedAt 字段);对外 select **不返 deletedAt**
// (软删除内部状态;查询接口已通过 notDeletedWhere 过滤;沿 v1 userSafeSelect 范式)。
export const rbacRoleSelect = {
  id: true,
  code: true,
  displayName: true,
  description: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.RbacRoleSelect;
