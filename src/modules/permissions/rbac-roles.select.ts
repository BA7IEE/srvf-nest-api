import { Prisma } from '@prisma/client';

// V2.x C-6 RBAC 实施 PR #3:RbacRole 模块对外 select 集中定义。
// 详见 docs/reference/naming-dto-validation.md §11
// + docs/批次8_RBAC_API前评审.md §4.1(D7 v1.1)。
//
// 任何对外返回必须使用本常量,禁止散写不同 select(沿 dictionaries / permissions 范式)。
// RbacRole 软删(D4 v1.0;deletedAt 字段);对外 select **不返 deletedAt**
// (软删除内部状态;查询接口已通过 notDeletedWhere 过滤;沿 v1 userSafeSelect 范式)。
// P1-32 PR 4a(2026-08-23):`permissionRevision` 进本常量而**不**另起一份 detail-only select ——
// 本文件的铁律是「任何对外返回必须使用本常量,禁止散写不同 select」,为一个字段拆第二份
// 就是自己破自己的规矩。代价是它同时出现在列表 / 详情 / 建 / 改四处响应上,那是**加分不是代价**:
// `PUT /roles/:id/permissions` 的 `expectedRevision` 必须有地方拿,而 4b 的 GET permission set
// 还没落地 —— 列表里就带上版本号,前端「列表→编辑权限」这条路当天就能闭环。
// 四处响应都是**新增字段**(additive),契约语义门按 ADD 放行。
export const rbacRoleSelect = {
  id: true,
  code: true,
  displayName: true,
  description: true,
  permissionRevision: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.RbacRoleSelect;
