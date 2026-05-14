import { Prisma } from '@prisma/client';

// V2.x C-6 RBAC 实施 PR #2:permissions 模块对外 select 集中定义。
// 详见 ARCHITECTURE.md §7.9 + docs/批次8_RBAC_API前评审.md §4.2(D7 v1.1)。
//
// 任何对外返回必须使用本常量,禁止散写不同 select(沿 dictionaries / members 等范式)。
// Permission 物理删(D4 v1.0 锁),无 deletedAt 字段;select 全字段对外。
export const permissionSelect = {
  id: true,
  code: true,
  module: true,
  action: true,
  resourceType: true,
  description: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.PermissionSelect;
