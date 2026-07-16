# 角色层级与管理员保护(reference · 触碰才读)

> Harness 2.0 细则层:承接 harness v1 `AGENTS.md` §13 **原文逐字搬家(零放宽;唯一机械改写=相对链接前缀)**;恒读入口与速查见根 [`AGENTS.md`](../../AGENTS.md),原文快照 [`archive/harness-v1/AGENTS.md`](../archive/harness-v1/AGENTS.md)。
> 机器锁定:users.policy.spec 3×3 矩阵 + 角色边界 e2e。

## 13. 角色层级与管理员保护

层级固定:`SUPER_ADMIN > ADMIN > USER`。三层 Role **不是 RBAC**,不要扩展 permission 表 / `user_roles` 多对多 / `casl`。

### 管理边界

- v1 只有 `prisma/seed.ts` 能创建 `SUPER_ADMIN`;业务 API **禁止**创建 `SUPER_ADMIN`
- `SUPER_ADMIN` 业务 API 创建用户只允许 `role=ADMIN | USER`
- `ADMIN` 调用创建接口最终只能创建 `USER`;显式传 `ADMIN` / `SUPER_ADMIN` 抛 `FORBIDDEN_ROLE_OPERATION`
- `ADMIN` 只能管理 `USER`,不能查看 / 修改 / 禁用 / 删除 / 降级 / 创建 `ADMIN` / `SUPER_ADMIN`
- `USER` 只能访问本人接口

### 双层校验

**Guard 管入口,Service 管业务**:Guard 层 `@Roles(Role.SUPER_ADMIN, Role.ADMIN)` 只决定谁能进管理接口;Service 层必须经统一 `assertCanManageUser(currentUser, targetUser)` 二次校验"能操作谁"——SUPER_ADMIN 总通过,ADMIN 只能管理 USER,其余抛 `BizException(BizCode.FORBIDDEN_ROLE_OPERATION)`。**禁止**在 service 散落手写 `currentUser.role === ...` 角色比较绕过此函数。

以下接口必须先 `findFirst` 查出目标用户,再 `assertCanManageUser`:`GET /api/admin/v1/users/:id` / `PATCH /api/admin/v1/users/:id` / `PUT /api/admin/v1/users/:id/password` / `PATCH /api/admin/v1/users/:id/role` / `PATCH /api/admin/v1/users/:id/status` / `DELETE /api/admin/v1/users/:id`。

### 自我保护(防误操作)

`id === currentUser.id` 时拒绝以下操作,抛 `BizException(BizCode.CANNOT_OPERATE_SELF)`:`DELETE /api/admin/v1/users/:id` / `PATCH /api/admin/v1/users/:id/status`(改 `DISABLED`)/ `PATCH /api/admin/v1/users/:id/role`。

`PATCH /api/admin/v1/users/:id` 永远不接受 `role` 字段;角色修改必须走 `PATCH /api/admin/v1/users/:id/role`。

### 最后一个 SUPER_ADMIN 保护(防代码漏洞)

任何"剥夺超级管理员权限"操作前,在同一 `prisma.$transaction` 内查询剩余活跃 super admin 数并执行更新,确保操作后剩余 ≥ 1,否则抛 `BizException(BizCode.LAST_SUPER_ADMIN_PROTECTED)`。适用接口(当且仅当目标用户当前是 super admin 时检查):`DELETE /api/admin/v1/users/:id` / `PATCH /api/admin/v1/users/:id/status`(改 `DISABLED`)/ `PATCH /api/admin/v1/users/:id/role`(改 `ADMIN` 或 `USER`)。

### 用户列表可见范围

`SUPER_ADMIN`:可看全部(`SUPER_ADMIN` / `ADMIN` / `USER`);`ADMIN`:只能看 `USER`;`USER`:不能进入管理列表。

### 字段透传安全

`CreateUserDto.role` 可选,不传默认 `USER`,**禁止把 role 从 DTO 直接透传给 Prisma**;必须经业务层根据当前用户角色校验后再决定写入值。

### SUPER_ADMIN 之间互操作(v1 设计选择)

v1 允许 `SUPER_ADMIN` **互相管理**(重置密码 / 禁用 / 改角色 / 软删除),仅受 §13 **自我保护** + **最后一个 SUPER_ADMIN 保护** 两层约束。即:`SUPER_ADMIN A` 操作 `SUPER_ADMIN B` 全部允许(剩余活跃 super admin ≥ 1 时);`SUPER_ADMIN A` 对自己执行任一上述操作命中自我保护拒绝。

这是**明确选择,不是疏漏**:v1 默认只有一个 SUPER_ADMIN(`prisma/seed.ts` 创建),互操作是低频运维场景;禁止互操作会导致"前任 SUPER_ADMIN 离职后无法被接任者接管"的死锁。真出现"SUPER_ADMIN 互不可操作"诉求按 `ARCHITECTURE.md §9` 升级路径处理(**作为权限模型升级**,不是渐进改造)。

AI **禁止**凭直觉额外加"SUPER_ADMIN 互不可操作"校验,**禁止**在 `assertCanManageUser` 里把 `targetUser.role === Role.SUPER_ADMIN` 列为禁止条件。

