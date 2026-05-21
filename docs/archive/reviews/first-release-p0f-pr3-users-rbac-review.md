# P0-F PR-3 users 模块 RBAC 接入评审稿 v1(评审稿,非执行稿)

> **状态**:**v1 评审稿,D 档前置评审稿,非执行稿**。
> 本文档**不是**代码实现说明,**不是**铁律修订,**不是** seed/schema 变更。
> 本文档冻结 P0-F PR-3 users 模块 RBAC 接入的设计决策,供 PR-3B(代码 PR)严格按本评审稿落地。
>
> **冲突优先级**(沿 [`process.md §6`](process.md)):`ARCHITECTURE.md` > `CLAUDE.md` / `AGENTS.md` > [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) > [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) > **本评审稿** > handoff > [`current-state.md`](current-state.md) > [`process.md`](process.md)。冲突时本评审稿让步。
>
> **不在本文范围**:接口字段细节(回 [`v2-api-contract.md`](v2-api-contract.md));BizCode 全量翻译(回 [`first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md));`auth` / `audit-logs` / 业务记录类(activities / members / certificates / attendances 等)的 RBAC 接入(归后续 P0-F PR);Slow-3 部门部长 / 副部长细粒度权限(归 V2 Slow 通道);Slow-4 79 接口全量 RBAC(归 V2 Slow 通道);代码落地细节(归 PR-3B 实施稿);`User.role` 字段删除 / `Role` enum 变化 / `JwtPayload` / `JwtStrategy` / `CurrentUserPayload.role` 调整(本期红线);`CLAUDE.md` / `AGENTS.md` 铁律修订(若有,归独立 docs PR)。
>
> **本稿是评审稿,不代表已经允许直接写代码**。**禁止**在 D1-D6 拍板前启动 PR-3B;PR-3B 启动前**必须**重读本评审稿 §13 复核点。

---

## §0 用途与定位

### 0.1 解决什么问题

P0-F PR-1([PR #132](https://github.com/) commit `488b814`)+ PR-2A([PR #134](https://github.com/) commit `31b7e55`)+ PR-2B([PR #136](https://github.com/) commit `93e87ac`)已完成 5 个 RBAC 元接口 + 6 个配置类模块共 61 端点的 RBAC 接入,把 v1 三层 `@Roles(SUPER_ADMIN, ADMIN)` 全部切换到 service 层 `rbac.can()`(沿 attachments F3 / F5 v1.0 范本)。但**当前事实仍然是**:

- 已接入 `rbac.can()`:`permissions` / `rbac-roles` / `role-permissions` / `user-roles` / `rbac` 5 元接口(13 端点)+ `attachments` 主模块(17 端点)+ 6 配置类模块(48 端点)= 78 端点
- 仍走 `@Roles(SUPER_ADMIN, ADMIN)`:`users`(8 处)+ `auth-logs`(2 处)+ `activities` / `activity-registrations` / `attendances` / `members` / `member-profiles` / `emergency-contacts` / `certificates` 业务记录类(多处)
- **users 模块尤为关键**:8 个管理端点直接控制账号生命周期(创建、查看、改资料、改密、改角色、启用/禁用、软删),是整个系统**最敏感**的 RBAC 边界;且双层校验(Guard `@Roles` + service `assertCanXxx`)的复杂度显著高于配置类:
  1. **角色分级语义**:ADMIN 仅能管理 USER,SUPER_ADMIN 可管理所有(`canViewUser` / `canManageUser`)
  2. **角色透传安全**:`canCreateRole` 永禁业务 API 创建 SUPER_ADMIN
  3. **角色提升禁令**:`canChangeRole` 永禁把任何人改成 SUPER_ADMIN(仅 seed 能创建 SA)
  4. **自我保护**:`assertNotSelf` 防止自删 / 自降级 / 自禁用
  5. **最后一个 SUPER_ADMIN 保护**:`assertNotLastSuperAdmin` 跨表 count 不变式
  6. **审计跨模块耦合**:`actorRoleSnap` 写入 / `audit-logs.service.list` ADMIN where 注入仍读 `currentUser.role`

PR-3 的最小目标:让 users 模块 8 个管理端点接入 `rbac.can()`,通过 `ops-admin` 角色显式承载运营管理用户的职责;**保留**上述 6 项业务护栏(`canViewUser` / `canManageUser` / `canCreateRole` / `canChangeRole` / `assertNotSelf` / `assertNotLastSuperAdmin`);**且不破** PR-1 / PR-2 已建立的 RBAC 模型(JwtPayload 仍最小、JwtStrategy 每请求查库、单一 `RBAC_FORBIDDEN=30100`、不引入 Redis、`User.role` / `Role` enum 不动)。

### 0.2 本评审稿的边界

- 本评审稿**只**讨论 users 模块 8 个管理端点的 RBAC 接入策略与 permission code 设计。
- 本评审稿**不**讨论:
  - `/me` 3 端点(`GET /me` / `PATCH /me` / `PUT /me/password`)— 任意登录用户即可,不进入 RBAC 范围
  - `auth` 模块(全 `@Public()` + 登录路径;无 `@Roles` 装饰器需迁移)
  - `audit-logs` 模块(2 处 `@Roles` 留独立 P0-F 后续 PR)
  - 业务记录类(activities / activity-registrations / attendances / members / member-profiles / emergency-contacts / certificates)的 self/other RBAC 接入(归 Slow-4)
  - 部门部长 / 副部长层级权限(归 Slow-3 业务方拍板)
  - **RBAC schema 变更**(`User.role` 删除、`Role` enum 变化、`JwtPayload` 调整、`CurrentUserPayload.role` 调整、`JwtStrategy.validate` select 字段调整 — **全部排除**)
  - migration / seed 真实运营数据录入(seed 仅扩 permission + RolePermission 映射)
  - `tokenVersion` / access token blacklist(已在 P0-E 评审稿 D-4 锁死本期不做)
- 本评审稿**不**改任何运行时代码 / schema / migration / seed / 测试 / OpenAPI snapshot。
- 本评审稿**不**改 [`readiness-plan`](first-release-readiness-plan.md) / [`frontend-scope`](first-release-frontend-scope.md) / [`bizcode-mapping`](first-release-bizcode-mapping.md) / [`bootstrap-sop`](first-release-bootstrap-sop.md) / [`current-state.md`](current-state.md) / [`security.md`](security.md)(这些状态回填归 PR-3B 的 docs 收口子 PR 或 v0.15.0 handoff)。
- 本评审稿**不**改 [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md)(若 D1-D6 拍板后确需铁律修订,归独立 docs PR;沿 P0-D / P0-E / PR-2 范式)。

### 0.3 谁要拍板

本评审稿 v1 提出 6 个决议项(D1-D6),全部由用户拍板:

- **D1**:`user.update.role` 是否绑 ops-admin
- **D2**:`user.reset.password` 是否绑 ops-admin
- **D3**:其余 5 条 user 管理权限(read / create / update / status / delete)是否绑 ops-admin
- **D4**:permission code 命名采用 `user.*` 还是 `users.*`
- **D5**:本 PR 是否顺手补 user 操作 audit event
- **D6**:PR 拆分(单 PR 还是评审稿 + 代码两阶段)

PR-3B 启动前必须 D1-D6 全部拍板。

---

## §1 当前事实盘点

> 本节带文件 + 行号引用,凡判断必有证据;v1 / V1.1 / V2 / V2.x / PR-1 / PR-2 历史决策不重述。

### 1.1 PR-1 / PR-2 已建立的 RBAC 接入范式(代码层 + e2e 层)

| 层 | 范式 | 引用 |
|---|---|---|
| controller | 移除 `@Roles(...)` 装饰器;仅留 `JwtAuthGuard`;`@ApiBizErrorResponse(...)` 内 `FORBIDDEN` 替换为 `RBAC_FORBIDDEN` | [`permissions.controller.ts:28-31`](../src/modules/permissions/permissions.controller.ts:28) / [`dictionaries.controller.ts`](../src/modules/dictionaries/dictionaries.controller.ts) |
| service | constructor 注入 `RbacService`;加 helper `assertCanOrThrow(user, action)`;每业务方法首句调用 | [`permissions.service.ts:41-45`](../src/modules/permissions/permissions.service.ts:41) / [`permissions.service.ts:89`](../src/modules/permissions/permissions.service.ts:89) |
| 失败响应 | 统一 `BizException(BizCode.RBAC_FORBIDDEN)`(`30100`,HTTP 403);沿 [biz-code.constant.ts:763](../src/common/exceptions/biz-code.constant.ts:763) | PR-1 commit `488b814` |
| e2e fixture | `seedRbacPermissionsAndOpsAdmin` / `grantOpsAdminToUser` / `revokeOpsAdminFromUser` 三 helper;`beforeAll` seed 完整 RBAC 数据 | [`test/fixtures/rbac.fixture.ts`](../test/fixtures/rbac.fixture.ts) |
| e2e 矩阵 | 5 用例(USER → 30100 / ADMIN 默认 → 30100 / ADMIN+ops-admin → 通过 / SUPER_ADMIN 短路 / me/permissions 任意登录) | [`test/e2e/permissions.e2e-spec.ts:69-168`](../test/e2e/permissions.e2e-spec.ts:69) |

### 1.2 users 模块当前结构(8 文件,实际 11 端点)

| 文件 | 行数 | 关键内容 |
|---|---|---|
| [users.controller.ts](../src/modules/users/users.controller.ts) | 262 | 11 端点(3 /me + 8 管理);8 处 `@Roles` |
| [users.service.ts](../src/modules/users/users.service.ts) | 520 | 11 业务方法 + 5 helpers + 10 处 `currentUser.role` / `Role.*` / `target.role` 依赖 |
| [users.policy.ts](../src/modules/users/users.policy.ts) | 52 | 4 个纯函数(canViewUser / canManageUser / canCreateRole / canChangeRole)|
| [users.policy.spec.ts](../src/modules/users/users.policy.spec.ts) | 126 | 9×4 = 36 用例完整角色矩阵 |
| [users.dto.ts](../src/modules/users/users.dto.ts) | 219 | 3 处 `Role` 字段(`UserResponseDto.role` / `CreateUserDto.role` / `UpdateUserRoleDto.role`)|
| [users.select.ts](../src/modules/users/users.select.ts) | 20 | `userSafeSelect.role: true` |
| [users.module.ts](../src/modules/users/users.module.ts) | 16 | imports: `DatabaseModule` + `AuditLogsModule` |

### 1.3 users.service 内 role 依赖点(10 处;PR-3B 全部保留)

| 行号 | 用法 | 用途 | PR-3B 是否动 |
|---|---|---|---|
| [65](../src/modules/users/users.service.ts:65) | `canManageUser(currentUser.role, targetUser.role)` | 修改边界 | ❌ 不动 |
| [74](../src/modules/users/users.service.ts:74) | `canViewUser(currentUser.role, targetUser.role)` | 查看边界 | ❌ 不动 |
| [90](../src/modules/users/users.service.ts:90) | `role: Role.SUPER_ADMIN` 查剩余 SA count | 最后一个 SA 保护 | ❌ 不动 |
| [244](../src/modules/users/users.service.ts:244) | `actorRoleSnap: currentUser.role` | audit `password.change.self` | ❌ 不动 |
| [272](../src/modules/users/users.service.ts:272) | `canViewUser(currentUser.role, r)` 压成 IN 子句 | list 可见范围 | ❌ 不动 |
| [299](../src/modules/users/users.service.ts:299) | `canCreateRole(currentUser.role, targetRole)` | 创建角色透传 | ❌ 不动 |
| [400](../src/modules/users/users.service.ts:400) | `actorRoleSnap: currentUser.role` | audit `password.reset.by-admin` | ❌ 不动 |
| [426](../src/modules/users/users.service.ts:426) | `canChangeRole(currentUser.role, dto.role)` | 改角色 | ❌ 不动 |
| [432](../src/modules/users/users.service.ts:432) | `target.role === Role.SUPER_ADMIN && dto.role !== ...` | role 改 → 最后保护触发 | ❌ 不动 |
| [460](../src/modules/users/users.service.ts:460) | `target.role === Role.SUPER_ADMIN && dto.status === DISABLED` | status 改 → 最后保护触发 | ❌ 不动 |
| [496](../src/modules/users/users.service.ts:496) | `target.role === Role.SUPER_ADMIN` | softDelete → 最后保护触发 | ❌ 不动 |

### 1.4 跨模块对 `User.role` / `Role` enum 的强依赖(本期红线,**全部不动**)

| 文件 | 行号 | 用法 | PR-3B 是否动 |
|---|---|---|---|
| [JwtStrategy.validate](../src/modules/auth/strategies/jwt.strategy.ts:47) | 47 | `select: { id, username, role, status, memberId }` | ❌ **本期不动**(沿 P0-E v1 D-4 / v1 §8 Zero Drift) |
| [CurrentUserPayload](../src/common/decorators/current-user.decorator.ts:16) | 16 | `role: Role` 字段 | ❌ **本期不动** |
| [JwtPayload](../src/modules/auth/strategies/jwt.strategy.ts:14) | 14 | `{ sub, username }`(不含 role)| ❌ **本期不动** |
| [auth.service](../src/modules/auth/auth.service.ts) | 113 / 295 / 368 | `actorRoleSnap: user.role` 3 处 | ❌ **本期不动** |
| [audit-logs.service](../src/modules/audit-logs/audit-logs.service.ts) | 99-100 / 154-157 | `currentUser.role === Role.SUPER_ADMIN/ADMIN/USER` 5 处判读权 | ❌ **本期不动** |
| [audit-logs.controller](../src/modules/audit-logs/audit-logs.controller.ts) | 36 / 51 | `@Roles(Role.SUPER_ADMIN, Role.ADMIN)` 2 处 | ❌ **本期不动**(归独立 P0-F 后续 PR) |
| 业务记录类 controller(activities / activity-registrations / attendances / members / member-profiles / emergency-contacts / certificates)| 多处 | `@Roles(Role.SUPER_ADMIN, Role.ADMIN)` 大量 | ❌ **本期不动**(归 Slow-4) |
| `AuditLog.actorRoleSnap` schema | [schema.prisma:748](../prisma/schema.prisma:748) | `Role?` enum 字段 | ❌ **本期不动** |

**关键结论**:`User.role` 字段 / `Role` enum / `CurrentUserPayload.role` / `JwtStrategy` select 是整个 RBAC 模型的承载基础设施。PR-3 / PR-3B **绝对不动**;若发现需要动,**立即停止并升级到 ARCHITECTURE.md §9 升级路径评审**。

### 1.5 seed / fixture 现状(PR-2 后)

| 实体 | 当前 seed 数量 | PR-3 后预期(默认推荐组合)|
|---|---|---|
| `RBAC_PERMISSION_SEED`(rbac.*) | 14 条 | 14 条(不动)|
| `ATTACHMENT_PERMISSION_SEED`(attachment.*) | 20 条(member 8 + cert 8 + activity 4)| 20 条(不动)|
| `MEMBER_ROLE_PERMISSION_CODES`(member 角色) | 9 条 | 9 条(不动)|
| `DICT_PERMISSION_SEED` / `ORG_PERMISSION_SEED` / `MEMBER_DEPARTMENT_PERMISSION_SEED` / `CONTRIBUTION_PERMISSION_SEED`(PR-2A)| 19 条 | 19 条(不动)|
| `ATTACHMENT_CONFIG_PERMISSION_SEED` / `STORAGE_SETTING_PERMISSION_SEED`(PR-2B)| 15 条(含 `storage-setting.reset.credentials`)| 15 条(不动)|
| **PR-3 新增 `USER_PERMISSION_SEED`**(user.*)| 0 | **7 条** |
| Permission 表 RBAC/config 段位合计 | 14 + 19 + 15 = **48 条** | 48 + 7 = **55 条** |
| `ops-admin` RolePermission 绑定 | 47 条(14 rbac + 19 PR-2A + 14 PR-2B,**不含** `storage-setting.reset.credentials`)| **沿 D1 / D2 / D3 拍板扩张**(默认推荐 47 + 6 = 53 条) |

### 1.6 BizCode 段位现状(P0-F PR-3 涉及段)

| 段位 | 实数 | PR-3 后 |
|---|---|---|
| `30100 RBAC_FORBIDDEN` | 已实装([biz-code.constant.ts:763](../src/common/exceptions/biz-code.constant.ts:763)) | 复用,**不新增** |
| `40300 FORBIDDEN`(通用 HTTP 级) | 仍存在,沿 v1 通用 | PR-3 把 users 8 端点的 `@ApiBizErrorResponse(FORBIDDEN)` 替换为 `RBAC_FORBIDDEN`;通用 `FORBIDDEN` 段位保留,不删除 |
| `10101 FORBIDDEN_ROLE_OPERATION` | 已实装(users 模块业务级 service 层错误码)| **完全保留**(`assertCanManageUser` / `assertCanViewUser` / `canCreateRole` / `canChangeRole` 全部抛此码,沿 v1 §13)|
| `10102 CANNOT_OPERATE_SELF` | 已实装 | **完全保留**(`assertNotSelf` 抛此码) |
| `10103 LAST_SUPER_ADMIN_PROTECTED` | 已实装 | **完全保留**(`assertNotLastSuperAdmin` 抛此码) |

PR-3B **不新增任何 BizCode**(沿 PR-1 / PR-2 零新增范式)。

### 1.7 OpenAPI contract snapshot 约束

- 当前 [`test/contract/__snapshots__/openapi.contract-spec.ts.snap`](../test/contract/__snapshots__/openapi.contract-spec.ts.snap) 已锁定 v1 14 路由 + V2 79 路由的完整契约
- PR-1 / PR-2 已经把 78 端点的 `403` 段从 `40300/FORBIDDEN` 改为 `30100/RBAC_FORBIDDEN`
- PR-3B **预期 snapshot diff**:
  - 仅 8 端点的 `403` 段 enum 替换;**0 路径增删** / **0 schema 字段增删**(`UserResponseDto.role` 字段保留)/ **0 tag 变化**
  - 量级:8 端点 × ~14 行 ≈ **~115 行**(沿 PR-1 184 行 / 13 端点 ≈ 14 行/端点 推算)

### 1.8 现有 e2e 测试覆盖边界(P0-F PR-3 涉及部分)

| spec 文件 | 行数 | FORBIDDEN 断言数 | PR-3B 是否需改 |
|---|---|---|---|
| [users-admin-crud.e2e-spec.ts](../test/e2e/users-admin-crud.e2e-spec.ts) | 532 | 多处 `FORBIDDEN_ROLE_OPERATION` / `BAD_REQUEST` | **需改**(加 5 用例矩阵 × 部分端点)|
| [users-admin-list.e2e-spec.ts](../test/e2e/users-admin-list.e2e-spec.ts) | 200 | 可见范围验证 | **需改**(加 ADMIN+ops-admin 可见范围)|
| [users-change-my-password.e2e-spec.ts](../test/e2e/users-change-my-password.e2e-spec.ts) | 471 | 0(`/me/password` 非 RBAC)| **不动** |
| [users-last-super-admin.e2e-spec.ts](../test/e2e/users-last-super-admin.e2e-spec.ts) | 101 | 最后 SA 保护 | **不动**(语义不变)|
| [users-me.e2e-spec.ts](../test/e2e/users-me.e2e-spec.ts) | 218 | 0(`/me` 非 RBAC)| **不动** |
| [users-password-reset.e2e-spec.ts](../test/e2e/users-password-reset.e2e-spec.ts) | 241 | `FORBIDDEN_ROLE_OPERATION` 多处 | **需改**(加 5 用例矩阵 + D2 决议验证)|
| [users-role-boundary.e2e-spec.ts](../test/e2e/users-role-boundary.e2e-spec.ts) | 146 | `FORBIDDEN`(40300)14 处 + `FORBIDDEN_ROLE_OPERATION` 5 处 | **重写**(40300 → 30100;注释满篇 `@Roles` 字样需更新)|
| [users-self-protection.e2e-spec.ts](../test/e2e/users-self-protection.e2e-spec.ts) | 92 | `CANNOT_OPERATE_SELF` 多处 | **不动**(10102 语义不变)|
| [users-soft-delete.e2e-spec.ts](../test/e2e/users-soft-delete.e2e-spec.ts) | 132 | — | **需改**(加 5 用例矩阵)|
| **合计** | **2133** | — | 5 spec 改 / 4 spec 不动 |

[users.policy.spec.ts](../src/modules/users/users.policy.spec.ts) 126 行 / **36 用例**:**全部保留不动**(policy 函数本身不动)。

---

## §2 PR-3 范围

### 2.1 在本范围(8 管理端点 / 1 controller / 1 模块)

| 端点 | HTTP | 当前 Guard | service 业务护栏 |
|---|---|---|---|
| `GET /api/users` | GET | `@Roles(SA, ADMIN)` | `canViewUser` 收窄列表 |
| `POST /api/users` | POST | `@Roles(SA, ADMIN)` | `canCreateRole`(永禁 SA + 角色分级)|
| `GET /api/users/:id` | GET | `@Roles(SA, ADMIN)` | `assertCanViewUser` |
| `PATCH /api/users/:id` | PATCH | `@Roles(SA, ADMIN)` | `assertCanManageUser` |
| `PUT /api/users/:id/password` | PUT | `@Roles(SA, ADMIN)` | `assertCanManageUser` + audit + 撤 refresh |
| `PATCH /api/users/:id/role` | PATCH | **`@Roles(SA)` only** | `assertNotSelf` + `assertCanManageUser` + `canChangeRole` + `assertNotLastSuperAdmin`(降级时)|
| `PATCH /api/users/:id/status` | PATCH | `@Roles(SA, ADMIN)` | `assertCanManageUser` + `assertNotSelf`(DISABLED) + `assertNotLastSuperAdmin` + 撤 refresh(DISABLED)|
| `DELETE /api/users/:id` | DELETE | `@Roles(SA, ADMIN)` | `assertNotSelf` + `assertCanManageUser` + `assertNotLastSuperAdmin` + 撤 refresh |

合计 **8 端点 / 8 处 `@Roles` / 6 项 service-level 业务护栏**。

### 2.2 不在本范围(显式排除)

| 模块 / 端点 | 排除原因 |
|---|---|
| `GET /api/users/me` | 任意登录用户;不进 RBAC 范围 |
| `PATCH /api/users/me` | 任意登录用户;不进 RBAC 范围 |
| `PUT /api/users/me/password` | 任意登录用户 + `@PasswordChangeThrottle()`;不进 RBAC 范围 |
| `auth` 模块 | 全 `@Public()` + JWT;无 `@Roles` 装饰器需迁移 |
| `audit-logs` 模块 | 2 处 `@Roles(SA, ADMIN)`;读权限策略需独立评审(谁能看谁的 audit);归独立 P0-F 后续 PR |
| 业务记录类(activities / activity-registrations / attendances / members / member-profiles / emergency-contacts / certificates)| self/other 拆分敏感;涉敏数据 self/other 拆分;归 Slow-4 |
| `attachments` 主模块 | 已接入 `rbac.can()`(PR-1 前 F3/F5 v1.0 已落地);**不动** |
| `permissions` / `rbac-roles` / `role-permissions` / `user-roles` / `rbac` | PR-1 #132 已接入;**不动** |
| `dictionaries` / `organizations` / `member-departments` / `contribution-rules` | PR-2A 已接入;**不动** |
| `attachment-{type,mime,size-limit}-configs` / `storage-settings` | PR-2B 已接入;**不动** |
| `health` / `ai` | 全 `@Public()` / README 占位;无需 RBAC |
| User.role / Role enum / JwtPayload / CurrentUserPayload.role / JwtStrategy.validate select | **本期红线,绝对不动**(沿 §0.2 / §1.4) |
| audit log `user.*` event 命名(`user.create` / `user.update` / `user.update.role` / `user.update.status` / `user.delete`)| 评审稿 §5 D5 拍板,默认推荐 B(不补,归独立 PR)|
| 业务护栏(canViewUser / canManageUser / canCreateRole / canChangeRole / assertNotSelf / assertNotLastSuperAdmin)| **全部保留**;不挪到 RBAC 层 / 不改用 `.self` 后缀 / 不拆 sub-permission |

**Slow-3 / Slow-4 启动诉求**:本评审稿**不**触发,沿 [`current-state.md §3`](current-state.md) Slow-3 待用户拍板。

---

## §3 当前 @Roles 使用点统计(8 处)

> 全部数据基于 main HEAD `93e87ac`(PR-2B 落地后)+ grep 实测。

| controller | 端点 / HTTP / 角色锁 | 行号 |
|---|---|---|
| `UsersController` | `GET /api/users` SA+ADMIN | [111](../src/modules/users/users.controller.ts:111) |
| `UsersController` | `POST /api/users` SA+ADMIN | [123](../src/modules/users/users.controller.ts:123) |
| `UsersController` | `GET /api/users/:id` SA+ADMIN | [144](../src/modules/users/users.controller.ts:144) |
| `UsersController` | `PATCH /api/users/:id` SA+ADMIN | [162](../src/modules/users/users.controller.ts:162) |
| `UsersController` | `PUT /api/users/:id/password` SA+ADMIN | [182](../src/modules/users/users.controller.ts:182) |
| `UsersController` | `PATCH /api/users/:id/role` **SA only** | [202](../src/modules/users/users.controller.ts:202) |
| `UsersController` | `PATCH /api/users/:id/status` SA+ADMIN | [223](../src/modules/users/users.controller.ts:223) |
| `UsersController` | `DELETE /api/users/:id` SA+ADMIN | [244](../src/modules/users/users.controller.ts:244) |

**小结**:8 端点;1 处 SA only(命中 D1);其余 7 处 SA+ADMIN。

---

## §4 permission code 设计(7 条候选)

### 4.1 命名规则(沿 PR-1 / PR-2 + D2 v1.2 正则)

- 正则 `/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,3}$/` —— 3-4 段 kebab-case
- 语义 `<module>.<action>.<resource_type>[.<scope>]`
- 段间严格 `.` 分隔;段内仅 `[a-z0-9-]`;首字母小写
- PR-3 本期**不使用** `.self` 后缀(管理类对象,`/me` 已独立路径,沿 PR-2 不引入 `.self`)
- 沿 PR-1 "dash + R/C/U/D 4 段拆分"(read/create/update/delete + 个别自定义动词如 reset)
- 复用 `RBAC_FORBIDDEN=30100`,**不开**新 BizCode

### 4.2 7 条候选 permission code

| # | code | 覆盖端点 | 段数 | 业务护栏并存说明 |
|---|---|---|---|---|
| 1 | `user.read.account` | `GET /api/users`(list)+ `GET /api/users/:id`(findOne) | 3 | service 内 `canViewUser` / `assertCanViewUser` 仍生效(收窄到目标 role 可见范围) |
| 2 | `user.create.account` | `POST /api/users` | 3 | service 内 `canCreateRole` 仍生效(永禁创建 SA;ADMIN 仅能创 USER) |
| 3 | `user.update.account` | `PATCH /api/users/:id` | 3 | service 内 `assertCanManageUser` 仍生效(ADMIN 仅能改 USER) |
| 4 | `user.reset.password` | `PUT /api/users/:id/password` | 3 | service 内 `assertCanManageUser` 仍生效 + audit `password.reset.by-admin` + 撤 refresh |
| 5 | `user.update.role` | `PATCH /api/users/:id/role` | 3 | service 内 4 项护栏全保留:`assertNotSelf` + `assertCanManageUser` + `canChangeRole`(永禁升 SA) + `assertNotLastSuperAdmin`(降级时) |
| 6 | `user.update.status` | `PATCH /api/users/:id/status` | 3 | service 内 4 项护栏全保留:`assertCanManageUser` + `assertNotSelf`(DISABLED) + `assertNotLastSuperAdmin` + 撤 refresh(DISABLED)|
| 7 | `user.delete.account` | `DELETE /api/users/:id` | 3 | service 内 3 项护栏全保留:`assertNotSelf` + `assertCanManageUser` + `assertNotLastSuperAdmin` + 撤 refresh |

**端点 → code 映射汇总**:8 端点 → 7 code(GET list + GET :id 共享 `user.read.account`;其余 1:1)。

### 4.3 段位与已实装的物理隔离

| 已实装 module 段位 | 新增 module 段位 | 是否碰撞 |
|---|---|---|
| `rbac.*`(14 条;PR-1) | `user.*` | ❌ |
| `attachment.*`(20 条;F3/F5 v1.0) | `user.*` | ❌ |
| `dict.*` / `org.*` / `member-department.*` / `contribution.*` / `attachment-config.*` / `storage-setting.*`(PR-2A/B 共 34 条)| `user.*` | ❌ |

**特别说明**:`user.*` 单数模块名沿 PR-1 `rbac.*` / PR-2 `dict.*` / `org.*` / `contribution.*` 单数模块名范式;**不**用 `users.*`(沿 §5 D4)。

### 4.4 命名取舍说明

**为什么用 `user.read.account` 而不是 `user.list` / `user.list.account`?**

- 沿 PR-1 `rbac.permission.read` / `rbac.role.read` / `rbac.role-permission.read` / `rbac.user-role.read` 范式,**list / findOne 共享 `read`**
- `account` resource_type 显式表示"用户账号",与 `password` / `role` / `status` 资源类型平行(都隶属 user 模块,但语义粒度不同)
- 若 D4 拍板 `users.*`,则全部改为 `users.read.account` 等(评审稿 §5 D4 详述)

**为什么 `password` 是 `user.reset.password` 不是 `user.update.password`?**

- `update` 语义是"改资料",`reset` 显式表示"清零并设置新值",与 v1 端点动词 `PUT` 对齐(管理员重置无需 oldPassword)
- 沿 PR-2 D4 `member-department.set.current` / `member-department.clear.current` 自定义动词范式
- 与本人改密 `password.change.self`(P0-D)语义对称区分:**reset** 是"管理员重置",**change** 是"本人改"

**为什么 `role` / `status` 是 `user.update.role` / `user.update.status` 不是 `user.role.update`?**

- `<module>.<action>.<resource_type>` 严格三段;`role` / `status` 作为 resource_type 自然延伸 `user.update.{role,status}`
- 沿 PR-1 `rbac.role-permission.delete` / `rbac.user-role.create` 范式 — action 在中间,resource_type 在末尾

---

## §5 决议项 D1-D6

> 每个决议列 A / B / C 三选项 + 推荐项 + 理由 + 风险。**禁止预判用户拍板结果**;§6 推荐拍板作为默认,但**任一项**可被用户改动。

### 5.1 D1:`user.update.role` 是否绑 ops-admin

**问题**:`PATCH /api/users/:id/role` 当前 v1 仅 `@Roles(SUPER_ADMIN)`(SA-only)。PR-3 接入 RBAC 后,`user.update.role` 权限是否绑给 `ops-admin`?

**选项**:

| 选项 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **A**(推荐) | seed 创建 `user.update.role` permission 但**不绑** `ops-admin`;SUPER_ADMIN 经短路通过;ADMIN+ops-admin → `30100` | 沿 v1 SA-only 现状;最强保守;与 `storage-setting.reset.credentials`(PR-2 D2=A 不绑 ops-admin)类比合理 | ADMIN(包括 ops-admin)调 PATCH `:id/role` 时报 30100,与 v1 现状行为对齐;ops-admin 即使持也无 role 修改权 |
| **B** | 绑给 `ops-admin`,与 `user.update.account` 同等 | RBAC 模型完整(运营持单一角色 = 全套 user 管理) | 与 v1 SA-only 现状反转;**风险**:即使 service 层 `canChangeRole` 仍拦 ADMIN+ops-admin(`canChangeRole` 要求 actor=SA),BizCode 会从 v1 的 40300(Guard 拒)变成 10101(service 拒);前端 / e2e 期望若按 v1 假设可能错配 |
| **C** | 新建独立 `role-admin` 角色,grant 给指定 SUPER_ADMIN | 职责分离最细 | 新增角色 + 运维额外 grant 步骤;PR-3B 复杂度上升;偏离 PR-2 "ops-admin 一角通吃运营"心智 |

**推荐**:**A**——SA-only 收紧;沿 PR-2 D2 凭证 reset 类比;**`canChangeRole`** 业务护栏要求 actor=SA 是**业务级硬铁律**(沿 [users.policy.ts:49-52](../src/modules/users/users.policy.ts:49)),即使 RBAC 层放开也无法逾越;不绑 ops-admin 让 Guard 层 / RBAC 层 / Service 层三道防线对齐。

**风险**:
- 若 D2 拍板 B 而 D1 拍板 A,会出现"reset password 走 ops-admin / update role 走 SA"的双轨认知;运维需理解差异
- 紧急回滚:DB 直改 `RolePermission`(`INSERT INTO role_permissions ...` grant `user.update.role` 给 `ops-admin`)+ `POST /api/v2/rbac/reload`;**但 service 层 `canChangeRole` 仍拒**(BizCode 10101);若真需让非 SA 改角色,需评估是否动 `canChangeRole`(本期不建议)

### 5.2 D2:`user.reset.password` 是否绑 ops-admin

**问题**:管理员重置用户密码 (`PUT /api/users/:id/password`)是高频运营动作还是凭证敏感操作?是否绑给 `ops-admin`?

**选项**:

| 选项 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **A** | seed 创建该 permission 但**不绑** `ops-admin`;SUPER_ADMIN 短路通过;ADMIN+ops-admin → `30100` | 最强保守;管理员重置作为"凭证级"动作收紧到 SA;类比 PR-2 D2 `storage-setting.reset.credentials` 不绑 ops-admin | 与 v1 SA+ADMIN 现状反转;运营"忘记密码协助找回"场景需 SA 介入;运维负担提升 |
| **B**(倾向推荐,需用户拍板) | 绑给 `ops-admin`,与 `user.update.account` 同等 | 业务上"运营帮用户重置密码"是合理日常诉求(类比 PR-2 D3 dict/org 软删放宽);`assertCanManageUser` 仍生效(ADMIN+ops-admin 仍只能 reset USER 的密码);P0-E PR-3 已实装"管理员重置 → 撤销目标 user 全部 refresh token"(沿 [`docs/first-release-p0e-refresh-token-review.md §7.2`](first-release-p0e-refresh-token-review.md)),不会引发凭证残留风险 | 与 PR-2 D2 凭证策略不对称(凭证 reset 收紧 / 密码 reset 放宽);需运维理解差异 |
| **C** | 新建独立 `password-admin` 角色 | 职责分离最细 | 增设角色;PR-3B 复杂度上升 |

**推荐**:**倾向 B,但需用户拍板**。理由:
1. **业务高频**:救援队管理后台日常会出现"队员忘记密码,运营协助重置";若仅 SA 可重置,SA 在职密度低时会成为瓶颈
2. **safeguard 已足**:`assertCanManageUser` 拦 ADMIN+ops-admin 越权(ADMIN+ops-admin 仍只能重置 USER,不能重置另一个 ADMIN);refresh 撤销(P0-E PR-3)保证旧 token 失效
3. **与 v1 行为对齐**:v1 `@Roles(SA, ADMIN)`,B 选项保持心智一致
4. **与 storage-setting.reset.credentials 不对称是有理由的**:storage 凭证是"系统级 secret",泄露影响 COS / 数据;user password 是"账号 credential",泄露影响单账号且可即时撤 refresh

如用户更偏保守,改 **A**(沿 PR-2 D2 凭证范式);用户拍板 A 时风险:见 D1 风险段。

**风险**:
- B 选项下,持 ops-admin 的 ADMIN 可批量 reset USER 密码;**虽然 audit log 会捕获**,但运营若被攻陷会导致大量用户密码被替换 → 缓解依赖审计 + refresh 撤销;**不**算严重 → 沿 v1 SA+ADMIN 现状已存在此风险
- A 选项下,运营无法重置 USER 密码,SA 在职时段以外的紧急找回受阻

### 5.3 D3:其余 5 条 user 管理权限是否绑 ops-admin

**问题**:`user.read.account` / `user.create.account` / `user.update.account` / `user.update.status` / `user.delete.account` 共 5 条,默认是否一并绑给 `ops-admin`?

**选项**:

| 选项 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **A**(推荐) | `ops-admin` 全部绑 5 条;PR-3 节奏统一 | 心智模型简单(运营持单一 `ops-admin` 角色 = RBAC 元 + 配置全权 + 用户管理 5 条);沿 PR-2 D1 "ops-admin 一角通吃运营"范式 | 角色范围继续扩大(47 → 52,默认推荐组合 → 53);未来"运营 ≠ 用户管理员"诉求出现时不易回滚 |
| **B** | 拆 `user-admin` 独立角色:5 条全归 `user-admin`,`ops-admin` 不绑 | 职责分离更清晰 | 运维负担提升;偏离 PR-2 D1 心智 |
| **C** | 部分绑:`read` + `update.account` 绑,`create` / `update.status` / `delete` 仅 SA | 创建 / 禁用 / 软删被收紧到 SA | 5 条拆 2/3 难找清晰边界;若 D2 已选 A 形成"reset 仅 SA + delete 仅 SA + status 仅 SA"的怪格局 |

**推荐**:**A**——一致性优先;`assertCanManageUser` / `canCreateRole` 已经在 service 层把"ADMIN+ops-admin 仅能管 USER"的护栏锁死,无越权风险;沿 PR-2 D1 推荐 A 心智一致。

**风险**:`ops-admin` 一旦绑这 5 条,合计权限 47 + 5 = 52 条(或叠加 D2=B 53 条 / D2=A 52 条);未来若需拆 `user-admin`,改 seed + 运行时迁移 RolePermission 即可(非破坏性)。

### 5.4 D4:permission code 命名采用 `user.*` 还是 `users.*`

**问题**:HTTP 路径是 `/api/users`(复数);permission code module 段是 `user.*`(单数)还是 `users.*`(复数)?

**选项**:

| 选项 | code 示例 | 优点 | 缺点 |
|---|---|---|---|
| **A**(推荐) | `user.read.account` / `user.create.account` / ... | 沿 PR-1 `rbac.*` / PR-2 `dict.*` / `org.*` / `contribution.*` 单数模块名范式;模块名与领域概念对齐(user 是单数实体)| HTTP 路径复数 / permission code 单数,前端需注意映射 |
| **B** | `users.read.account` / `users.create.account` / ... | 与 HTTP 路径复数一致 | 偏离 PR-1 / PR-2 单数模块名范式;`users.*` 在 OpenAPI tag / module 文件 / 文档中都需重新对齐 |
| **C** | 混合:list `users.list` + 详情 `user.read` | 各端点动词最贴切 | 段位混乱;沿 R/C/U/D 范式偏离 |

**推荐**:**A**——沿 PR-1 / PR-2 范式;permission code 是"业务能力名",不是"HTTP 路径名",单复数无强对应。

**风险**:无实质风险;前端 BizCode 文档需明示 `user.*` 单数(沿 [`first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md))。

### 5.5 D5:是否本 PR 顺手补 user 操作 audit event

**问题**:users 模块当前仅 2 处 audit log 写入(`password.change.self` / `password.reset.by-admin`)。其余 6 个端点(create / update / list / read / update.role / update.status / delete)**未写 audit**。PR-3B 是否顺手补 5-6 项 audit event?

**选项**:

| 选项 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **A** | 补 5 项:`user.create` / `user.update` / `user.update.role` / `user.update.status` / `user.delete`(read / list 不写 audit)| audit 覆盖完整;运营动作全可追溯 | PR-3B 范围扩张(audit-logs.types union 加 5 项 + 5 处 service 调用 + 命名风格再次复核);沿 P0-E PR-3 "顺手补 1 项 password.reset.by-admin" 已是边界,5 项不算"顺手" |
| **B**(推荐) | 不补,留独立后续 PR | PR-3B 范围最小化(仅 RBAC 接入,沿 PR-2A/2B 范式);audit 补丁与 RBAC 解耦,各自评审与回滚清晰 | audit 覆盖期暂时不完整(用户操作高风险但无审计) |
| **C** | 仅补高风险 3 项(`user.update.role` / `user.update.status` / `user.delete`)| 兼顾覆盖与范围 | 拆得不彻底;3 项还是 5 项的边界模糊 |

**推荐**:**B**——沿 P0-E PR-3 "1 项顺手补" 是 audit 范围扩展上限,5 项明显越界;PR-3B 严格聚焦 RBAC 接入,审计补丁归独立 docs-only 评审稿 + 代码 PR(可命名 `P0-F PR-4 users audit log coverage`)。

**风险**:
- B 选项下,用户创建 / 修改 / 软删 / 改角色 / 改状态等高敏操作在 PR-3B 上线后仍无 audit 记录(沿 v1 现状,**不算回退**)
- 若运维对 audit 覆盖有刚性诉求,可在 PR-3B 上线前先做 PR-4(audit 补丁)再做 PR-3B(RBAC 接入);但**不**建议合并到 PR-3B

### 5.6 D6:PR 拆分

**问题**:本评审稿(PR-3A,docs-only)与代码实施(PR-3B)是分两 PR 还是合一?

**选项**:

| 选项 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **A** | 单 PR(docs + 代码一起)| 一次 review 完成 | docs 评审与代码实施混在一起;若 D1-D6 评审反复,代码已写部分需返工;违反 P0-D / P0-E / PR-2 串行范式 |
| **B**(推荐) | PR-3A docs-only(本评审稿)+ PR-3B 代码实现 | 沿 P0-D / P0-E / PR-2 4-PR 串行精神;评审稿先冻结决议项,代码 PR 严格按评审稿落地;回滚链路清晰 | PR 数量增加;PR-3A merged → PR-3B 启动需等待 |
| **C** | PR-3A docs + PR-3B 代码再拆 user 端点子集(如 PR-3B-1 read/create/update + PR-3B-2 role/status/delete)| 风险隔离最细 | 8 端点拆 2 子 PR 收益有限;seed + fixture 两阶段扩展复杂;偏离 PR-2 8 controller 单 PR 范式 |

**推荐**:**B**——沿 P0-D PR-1/2/3 + P0-E PR-1/2/3 + PR-2A/2B 串行范式;PR-3A 是本评审稿,merged 后启动 PR-3B 代码 PR。

**风险**:无实质风险;PR-3A → PR-3B 间隔可控(1-2 周)。

---

## §6 推荐拍板

### 6.1 默认推荐组合

| 决议 | 推荐 | 引用 |
|---|---|---|
| D1 `user.update.role` 绑定策略 | **A**:SA-only,**不绑** `ops-admin` | §5.1 |
| D2 `user.reset.password` 绑定策略 | **倾向 B**(绑 `ops-admin`),**但需用户拍板** | §5.2 |
| D3 其余 5 条 user 管理权限 | **A**:全部绑 `ops-admin` | §5.3 |
| D4 permission code 命名 | **A**:`user.*` 单数模块名 | §5.4 |
| D5 是否顺手补 audit | **B**:不补,留独立 PR | §5.5 |
| D6 PR 拆分 | **B**:PR-3A docs + PR-3B 代码 | §5.6 |

### 6.2 推荐组合下的 ops-admin 最终绑定矩阵

> 假设 D1=A、D2=B、D3=A、D4=A、D5=B、D6=B。

- 既有 47 条(沿 PR-1 + PR-2;14 rbac + 19 PR-2A + 14 PR-2B,**不含** `storage-setting.reset.credentials`)
- PR-3 后扩 6 条:`user.read.account` / `user.create.account` / `user.update.account` / `user.reset.password` / `user.update.status` / `user.delete.account`
- **不绑** 1 条:`user.update.role`(沿 D1=A SA-only)
- 合计 **53 条**;SUPER_ADMIN 短路通过任意 action(沿 D7 §7.1 / `rbac.service.ts:118`)

| 备选组合 | ops-admin 绑定数 | 备注 |
|---|---|---|
| D1=A / D2=A / D3=A(最保守) | 47 + 5 = **52 条** | `user.update.role` + `user.reset.password` 双 SA-only |
| D1=A / D2=B / D3=A(默认推荐) | 47 + 6 = **53 条** | `user.update.role` SA-only;`user.reset.password` 绑 |
| D1=B / D2=B / D3=A(最宽) | 47 + 7 = **54 条** | 7 条 user.* 全绑 |

Permission 表全集(含未绑 ops-admin 的)始终 = 48(RBAC/config)+ 7(user.*)= **55 条**。

---

## §7 seed / fixture 变更设计

### 7.1 只改 seed,不改 schema(沿 §0.2 / §2.2 / [`CLAUDE.md §1 不解锁`](../CLAUDE.md))

- **不动** [`prisma/schema.prisma`](../prisma/schema.prisma)
- **不动** 任何 [`prisma/migrations/`](../prisma/migrations/)
- **不动** RBAC 4 表(`permissions` / `rbac_roles` / `role_permissions` / `user_roles`)结构

### 7.2 [`prisma/seed.ts`](../prisma/seed.ts) 变更点(预生成 SQL 不适用 —— seed 是运行时 upsert)

| 位置 | PR-3B 改 |
|---|---|
| `STORAGE_SETTING_PERMISSION_SEED` 之后新增 module 段位常量 | 新增 `USER_PERMISSION_SEED` 常量数组(7 条 `user.*`)|
| `seedRbac` 函数 step 1 upsert Permission | 把新数组与现有数组一同循环 upsert;Permission 表从 48 + 20(attachments)= 68 条扩到 55 + 20 = **75 条** |
| `seedRbac` 函数 step 3 ops-admin RolePermission 映射 | `ops-admin` 绑定数组按 D1 / D2 / D3 拍板扩张(默认推荐 D1=A / D2=B / D3=A → 53 条) |
| `OPS_ADMIN_DESCRIPTION` 常量文案 | "RBAC 自身 14 条 + 配置类 33 条 + 用户管理 6 条;角色修改仅 SUPER_ADMIN" |
| `console.log('[seed] RBAC role-permissions ensured ...')` | 数字与上述同步 |

### 7.3 [`test/fixtures/rbac.fixture.ts`](../test/fixtures/rbac.fixture.ts) 变更点

- 沿 fixture 现有说明:`resetDb` 清空 RBAC 4 表,e2e 必须自带 seed
- PR-3B:`seedRbacPermissionsAndOpsAdmin` 内的 `RBAC_PERMISSIONS` 常量从 47 条扩到默认推荐组合 53 条(沿 D1=A / D2=B / D3=A);若 D2=A,则 52 条
- `user.update.role` 加入 `permission.upsert` 但**不**加入 `rolePermission.createMany`(沿 D1=A)
- **不**新建独立 fixture 文件(沿 PR-1 / PR-2 "一个 fixture 一次 seed 全集"范式)

### 7.4 seed 幂等性保证

- 现有 `prisma.permission.upsert({ where: { code }, update: {}, create: {...} })` 范式天然幂等
- 现有 `prisma.rolePermission.upsert({ where: { roleId_permissionId: ... }, update: {}, create: ... })` 范式天然幂等
- 多次跑 seed 不重复创建;**已绑的 RolePermission 不会因 seed re-run 被撤销**

### 7.5 生产 / 测试 / 演练环境的 seed 行为

| 环境 | 首次 seed 后 ops-admin 权限(默认推荐) | 第二次 seed(re-run)后 |
|---|---|---|
| dev | 53 条 | 53 条(upsert no-op) |
| test(e2e DB) | fixture 控制,与 seed 解耦 | fixture 控制 |
| staging | 53 条 | 53 条(upsert no-op) |
| production | 53 条 | 53 条(upsert no-op);**运营若手工撤销了某 RolePermission,seed re-run 会重新加回**(沿 现 seed `update: {}` 不覆盖既有,但 RolePermission 走 upsert,需 PR-3B 实施时显式确认;沿 PR-2 §7.5 同款) |

**实施前置**(沿 [`CLAUDE.md §0`](../CLAUDE.md)):seed 改动**不需要** `prisma migrate dev`,但 PR-3B 提交前**必须**在 dev 跑一次 `pnpm db:seed` 验证 53 条 RolePermission 都符合预期。

---

## §8 controller / service 改造范式

> 严格沿 PR-1 / PR-2 范本;**禁止**自创新范式。

### 8.1 controller 改 4 项(每端点)

```ts
// 改前(沿 v1 / V2.x 既有 users.controller.ts)
@Get()
@Roles(Role.SUPER_ADMIN, Role.ADMIN)
@ApiOperation({ summary: '用户列表(分页;ADMIN 仅能看到 USER)' })
@ApiWrappedPageResponse(UserResponseDto)
@ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
list(
  @CurrentUser() currentUser: CurrentUserPayload,
  @Query() query: ListUsersQueryDto,
): Promise<PageResultDto<UserResponseDto>> {
  return this.usersService.list(currentUser, query);
}

// 改后(沿 PR-1 permissions.controller.ts:40-49 范式)
@Get()
@ApiOperation({ summary: '用户列表(分页;ADMIN 仅能看到 USER)' })
@ApiWrappedPageResponse(UserResponseDto)
@ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
list(
  @CurrentUser() currentUser: CurrentUserPayload,
  @Query() query: ListUsersQueryDto,
): Promise<PageResultDto<UserResponseDto>> {
  return this.usersService.list(currentUser, query);
}
```

**4 项动作**(每 8 端点)
1. 移除 `@Roles(Role.SUPER_ADMIN, Role.ADMIN)`(或 `@Roles(Role.SUPER_ADMIN)`)装饰器
2. `@ApiBizErrorResponse(...)` 内 `BizCode.FORBIDDEN` → `BizCode.RBAC_FORBIDDEN`
3. `Roles` import 在所有 `@Roles` 移除后整文件清理(若 controller 内已无 `@Roles` 引用)
4. `@CurrentUser() currentUser: CurrentUserPayload` 已注入(users.controller.ts 现状沿 v1 11 端点均已注入),**无新增**

### 8.2 service 改 3 项

```ts
// 沿 PR-1 permissions.service.ts:41-45 范式
private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
  if (!(await this.rbac.can(user, action))) {
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }
}

// 业务方法首句调用(在 DB 查询 / 事务之前)
async list(currentUser: CurrentUserPayload, query: PaginationQueryDto): Promise<PageResultDto<UserResponseDto>> {
  await this.assertCanOrThrow(currentUser, 'user.read.account');
  // ... 既有业务逻辑(notDeletedWhere + canViewUser 收窄 + Prisma findMany;沿 v1)
}
```

**3 项动作**:
1. constructor 注入 `private readonly rbac: RbacService`(从 PermissionsModule 取)
2. 加 `assertCanOrThrow` private helper(沿 PR-1 `permissions.service.ts:41-45` 字面复制,**禁止**改动签名)
3. 8 个管理方法各自首句 `await this.assertCanOrThrow(currentUser, '<permission.code>')`;`/me` 3 方法**不动**

### 8.3 业务护栏全部保留(6 项,**不挪动**)

| 护栏 | service 位置 | 调用点 | 保留理由 |
|---|---|---|---|
| `canViewUser` | [users.service.ts:74](../src/modules/users/users.service.ts:74) + [272](../src/modules/users/users.service.ts:272) | findOne + list | 需要 target.role,permission code 不知道目标对象 |
| `canManageUser` | [users.service.ts:65](../src/modules/users/users.service.ts:65) | update / resetPassword / updateRole / updateStatus / softDelete | 同上 |
| `canCreateRole` | [users.service.ts:299](../src/modules/users/users.service.ts:299) | create | 需要 dto.role,permission code 不区分目标角色;**永禁创建 SA** |
| `canChangeRole` | [users.service.ts:426](../src/modules/users/users.service.ts:426) | updateRole | 需要 dto.role + actor=SA;**永禁升 SA** |
| `assertNotSelf` | [users.service.ts:79-83](../src/modules/users/users.service.ts:79) | softDelete / updateRole / updateStatus(DISABLED) | currentUser.id vs target.id 自我保护 |
| `assertNotLastSuperAdmin` | [users.service.ts:87-99](../src/modules/users/users.service.ts:87) | softDelete / updateRole / updateStatus(降级 / DISABLED 时) | 跨表 count 不变式,transactional |

**禁止**(沿评审稿 §0.2 + §2.2):
- 把 6 项护栏挪到 RBAC 层
- 拆 `.self` 后缀(PR-3 配置类无 owner 语义)
- 拆 sub-permission `user.update.role.demote-super` 之类的 4 段 scope(`.demote-super` 在 `RbacService` 无原生支持,仅起命名提示作用,反而误导;沿 PR-2 D3 选项 C 拒绝理由)

### 8.4 module 改 1 项

```ts
// 沿 PR-2 module 范式追加 PermissionsModule import
@Module({
  imports: [DatabaseModule, AuditLogsModule, PermissionsModule],  // ← 新增 PermissionsModule
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
```

**前置确认**:[`permissions.module.ts`](../src/modules/permissions/permissions.module.ts) 必须 `exports: [RbacService]`;PR-3B 启动前 grep 验证(沿 PR-2 §8.3 同款前置);若未导出**先**改 [`permissions.module.ts`](../src/modules/permissions/permissions.module.ts) 加 exports(此改动单独不算"改 PR-3B 范围",视为前置基建)。

### 8.5 特殊处理:role / status / delete 端点

| 端点 | 改造细节 |
|---|---|
| `PATCH /api/users/:id/role` | controller 移除 `@Roles(Role.SUPER_ADMIN)`(注意是 SA-only,不是 SA+ADMIN);service 首句 `assertCanOrThrow(currentUser, 'user.update.role')`;**4 项业务护栏全保留**;`canChangeRole` 仍要求 actor=SA → ADMIN+ops-admin(若 D1=B)走到 service 仍被 10101 拒(沿 §5.1 风险段) |
| `PATCH /api/users/:id/status` | controller 移除 `@Roles(Role.SUPER_ADMIN, Role.ADMIN)`;service 首句 `assertCanOrThrow(currentUser, 'user.update.status')`;**4 项业务护栏全保留**(`assertCanManageUser` + `assertNotSelf`(DISABLED) + `assertNotLastSuperAdmin` + 撤 refresh);**注意 refresh 撤销逻辑不动**(沿 P0-E PR-3 + CLAUDE.md §9) |
| `DELETE /api/users/:id` | controller 移除 `@Roles(Role.SUPER_ADMIN, Role.ADMIN)`;service 首句 `assertCanOrThrow(currentUser, 'user.delete.account')`;**3 项业务护栏全保留**(`assertNotSelf` + `assertCanManageUser` + `assertNotLastSuperAdmin` + 撤 refresh);**注意 refresh 撤销逻辑不动** |
| `PUT /api/users/:id/password` | controller 移除 `@Roles(Role.SUPER_ADMIN, Role.ADMIN)`;service 首句 `assertCanOrThrow(currentUser, 'user.reset.password')`;**1 项业务护栏保留**(`assertCanManageUser`)+ audit `password.reset.by-admin` 不动(沿 P0-E PR-3)+ 撤 refresh 不动 |
| `POST /api/users` | controller 移除 `@Roles(Role.SUPER_ADMIN, Role.ADMIN)`;service 首句 `assertCanOrThrow(currentUser, 'user.create.account')`;**1 项业务护栏保留**(`canCreateRole`,永禁创建 SA) |
| `PATCH /api/users/:id` | controller 移除 `@Roles(Role.SUPER_ADMIN, Role.ADMIN)`;service 首句 `assertCanOrThrow(currentUser, 'user.update.account')`;**1 项业务护栏保留**(`assertCanManageUser`)|
| `GET /api/users/:id` | controller 移除 `@Roles(Role.SUPER_ADMIN, Role.ADMIN)`;service 首句 `assertCanOrThrow(currentUser, 'user.read.account')`;**1 项业务护栏保留**(`assertCanViewUser`) |
| `GET /api/users` | controller 移除 `@Roles(Role.SUPER_ADMIN, Role.ADMIN)`;service 首句 `assertCanOrThrow(currentUser, 'user.read.account')`;**1 项业务护栏保留**(`canViewUser` 收窄列表)|

**关键铁律**:**所有 service 内的 role 依赖点(10 处)、business policy 函数(4 个)、audit 写入(2 处)全部保留**(沿 §1.3 行号清单);PR-3B 只在 controller 上移除 `@Roles` 装饰器,在 service 业务方法首句加一行 `assertCanOrThrow`,**其它代码逻辑零改动**。

---

## §9 e2e 矩阵

### 9.1 每 spec 文件最小 5 用例(沿 PR-1 / PR-2 范式)

| 用例 | 行为 | 期望响应 |
|---|---|---|
| 1 | 未登录 GET → 401 | `expectBizError(res, BizCode.UNAUTHORIZED)` |
| 2 | USER 角色任一端点 → 403 | `expectBizError(res, BizCode.RBAC_FORBIDDEN)` |
| 3 | ADMIN 默认(未持 ops-admin)任一端点 → 403 | `expectBizError(res, BizCode.RBAC_FORBIDDEN)` |
| 4 | ADMIN 持 ops-admin → 通过(`grantOpsAdminToUser` + try / finally + `revokeOpsAdminFromUser`)| 业务成功响应,或被 service 业务护栏拦截抛特定 BizCode(沿 §9.2 / §9.3)|
| 5 | SUPER_ADMIN 短路 → 通过(无需 grant)| 业务成功响应 |

### 9.2 D1 SA-only 验证(`user.update.role` 不绑 ops-admin)

| spec | 用例 | 期望 |
|---|---|---|
| users-role-boundary | USER 调 `PATCH /:id/role` → 30100 | `RBAC_FORBIDDEN`(沿 D1=A,与所有其他端点对齐)|
| users-role-boundary | ADMIN 默认 调 `PATCH /:id/role` → 30100 | `RBAC_FORBIDDEN`(沿 D1=A,**不再** 40300)|
| users-role-boundary | ADMIN+ops-admin 调 `PATCH /:id/role` → 30100 | `RBAC_FORBIDDEN`(沿 D1=A,ops-admin 不持 `user.update.role`)|
| users-role-boundary | SUPER_ADMIN 调 `PATCH /:id/role` { role: ADMIN } → 200 | 角色变更成功 |
| users-role-boundary | SUPER_ADMIN 调 `PATCH /:id/role` { role: SUPER_ADMIN } → 10101 | `FORBIDDEN_ROLE_OPERATION`(`canChangeRole` 永禁升 SA,**业务护栏反向验证**)|

**若 D1 拍板 B**:ADMIN+ops-admin 调 `PATCH /:id/role` 期望从 30100 改为 10101(`canChangeRole` 要求 actor=SA,service 层拦截);**评审稿 §5.1 风险段已警示**此差异。

### 9.3 D2 reset password 决议验证

**默认推荐组合(D2=B 绑 ops-admin)下**:

| spec | 用例 | 期望 |
|---|---|---|
| users-password-reset | ADMIN+ops-admin 调 `PUT /:id/password` 操作 USER target → 200 | reset 成功 |
| users-password-reset | ADMIN+ops-admin 调 `PUT /:id/password` 操作 SA target → 10101 | `FORBIDDEN_ROLE_OPERATION`(`assertCanManageUser` 拦)|
| users-password-reset | SUPER_ADMIN 调 `PUT /:id/password` → 200 | reset 成功 |

**若 D2 拍板 A(SA-only)**:第一用例改 `→ 30100 RBAC_FORBIDDEN`(ops-admin 不持 `user.reset.password`);**SA-only 凭证收紧验证**沿 PR-2 D2 范式。

### 9.4 必须保留的反向断言(10101 / 10102 / 10103)

PR-3B 改造期间,以下既有 e2e 断言**全部保留,不可破**:

| spec | 用例 | 期望 | 触发护栏 |
|---|---|---|---|
| users-role-boundary | ADMIN+ops-admin 调 `PATCH /:id` / `PUT /:id/password` / `PATCH /:id/status` / `DELETE /:id` 操作 SA target → 10101 | `FORBIDDEN_ROLE_OPERATION` | `assertCanManageUser` |
| users-admin-crud | SA 调 `POST /` { role: SUPER_ADMIN } → 10101 | `FORBIDDEN_ROLE_OPERATION` | `canCreateRole` |
| users-admin-crud | ADMIN+ops-admin 调 `POST /` { role: ADMIN / SUPER_ADMIN } → 10101 | `FORBIDDEN_ROLE_OPERATION` | `canCreateRole` |
| users-self-protection | SA 调 `DELETE /:id` 操作自己 → 10102 | `CANNOT_OPERATE_SELF` | `assertNotSelf` |
| users-self-protection | SA 调 `PATCH /:id/status` 操作自己(DISABLED) → 10102 | `CANNOT_OPERATE_SELF` | `assertNotSelf` |
| users-self-protection | SA 调 `PATCH /:id/role` 操作自己 → 10102 | `CANNOT_OPERATE_SELF` | `assertNotSelf` |
| users-last-super-admin | SA-A 软删另一个 SA-B(剩余 ≥ 1)→ 200 | 软删成功 | `assertNotLastSuperAdmin` 不触发 |
| users-admin-list | ADMIN 默认 → 200,列表仅 USER 角色 | `canViewUser` 列表收窄 | `canViewUser` |
| users-admin-list | ADMIN+ops-admin → 200,列表仅 USER 角色 | `canViewUser` 列表收窄(**不**因 RBAC 通过而扩大可见范围)| `canViewUser` |

### 9.5 用例数量估算

| 范围 | spec 文件 | 用例增量 |
|---|---|---|
| PR-3B 改造 | users-admin-crud(部分端点)| ~10 新用例(含 5 用例矩阵)|
| | users-admin-list(可见范围)| ~3 新用例 |
| | users-password-reset(D2 决议)| ~5 新用例 |
| | users-role-boundary(改造 14 处 40300 + 加 D1 验证)| ~8 改写 + ~5 新用例 |
| | users-soft-delete(5 用例矩阵)| ~5 新用例 |
| **不动 spec** | users-me / users-change-my-password / users-self-protection / users-last-super-admin | 0 |
| **合计** | 5 spec 改 + 4 spec 不动 | **~35-40 新用例** |

`pnpm test:e2e` 耗时预期增加 ~3-4%(沿 PR-2A/2B 增量推算)。

### 9.6 fixture 复用方式

- `seedRbacPermissionsAndOpsAdmin` 扩到 53 条 permission(沿 §6.2 默认推荐组合;若 D2=A 则 52 条)
- `grantOpsAdminToUser` / `revokeOpsAdminFromUser` 不变(签名不动)
- 每 spec `beforeAll` 调用 `seedRbacPermissionsAndOpsAdmin` 一次;`grantOpsAdminToUser` 在用例 4 / D2 用例内按需调用,`afterEach` / `finally` 内 revoke

---

## §10 OpenAPI snapshot 预期变化

### 10.1 变化范围

| 变化类型 | 量级 | 备注 |
|---|---|---|
| `responses.403` enum 替换:`40300 / 无权限访问` → `30100 / RBAC 权限不足` | 8 端点 × ~14 行 ≈ **115 行 +-** | PR-3B 单 PR |
| `paths.*` 路径增删 | **0** | PR-3 不动 endpoint |
| `paths.*.parameters` 或 `requestBody` | **0** | PR-3 不动 DTO / 入参 |
| `components.schemas.UserResponseDto.role` | **保留** | `UserResponseDto.role: Role` 字段不动,前端契约 zero drift |
| `components.schemas.CreateUserDto.role` | **保留** | 可选入参,沿 v1 |
| `components.schemas.UpdateUserRoleDto.role` | **保留** | 角色修改入参,沿 v1 |
| `tags` | **0** | controller `@ApiTags('users')` 不动 |

### 10.2 contract spec 验收(沿 [`test/contract/openapi.contract-spec.ts`](../test/contract/openapi.contract-spec.ts))

- PR-1 / PR-2A / PR-2B 已通过完整 contract spec 验证(沿 commit message)
- PR-3B 预期不引入新 contract spec 失败;若失败,优先检查 `@ApiBizErrorResponse` 装饰器签名与 `RBAC_FORBIDDEN` BizCode 引用(沿 PR-1 / PR-2 同款修复路径)
- snapshot diff 必须**只**包含 `403` enum 段位变化;**禁止**出现路径 / DTO / tag diff(若出现,视为越权改动,PR-3B 必须回退)

### 10.3 breaking change 性质

- 前端调用方:**HTTP status 不变**(仍是 403);**响应 body `code` 由 40300 → 30100**
- 翻译表:沿 [`first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md) `RBAC_FORBIDDEN=30100` 已存在(PR-1 收口时落地);PR-3 不引入新翻译
- 前端处理:若前端按 HTTP status 处理,无变化;若按 BizCode 处理,需识别 30100(沿 PR-1 / PR-2 同款 breaking)

---

## §11 PR 拆分建议

### 11.1 推荐:PR-3A docs-only(本评审稿)+ PR-3B 代码实现

| 因素 | PR-3A + PR-3B 拆分的理由 |
|---|---|
| 沿袭范式 | P0-D PR-1/2/3 + P0-E PR-1/2/3 + PR-2A/2B 均为串行评审稿 + 代码 PR;PR-3 不破例 |
| 决议复杂度 | D1-D6 共 6 项,显著多于 PR-2 的 4 项(D1-D4);评审稿先冻结再代码,避免反复返工 |
| 业务护栏多 | 6 项 service-level 护栏需评审稿明示保留;若直接代码 PR,易被误删 / 误重构 |
| 角色边界敏感 | `User.role` / `Role` enum / `JwtPayload` / `JwtStrategy` 全部本期红线;评审稿明示边界,代码 PR 严守 |
| 风险隔离 | PR-3A 仅文档;PR-3B 涉及 8 端点 + ~35 e2e + ~115 OpenAPI snapshot 行;两阶段评审 + 实施风险可控 |
| 回滚成本 | PR-3A 独立 revert 0 风险;PR-3B 独立 revert 仅影响 8 端点 RBAC 接入 |

### 11.2 备选(不推荐):单 PR 合并

| 缺点 |
|---|
| 评审稿与代码混在一起;若 D1-D6 评审反复,代码已写部分需返工 |
| 偏离 P0-D / P0-E / PR-2 串行范式 |
| OpenAPI snapshot diff + seed 改 + 5 e2e spec 改 + ~35 新用例**一次过**,review 负担大 |

### 11.3 不推荐:PR-3B 再拆 user 端点子集

| 缺点 |
|---|
| 8 端点拆 2 子 PR 收益有限;seed + fixture 两阶段扩展复杂 |
| 偏离 PR-2 8 controller 单 PR 范式;PR-2 已证明 8 controller / 28 端点(PR-2A)/ 20 端点(PR-2B)单 PR 是可控量级 |
| user 模块 8 端点 < PR-2A 28 端点,**没必要**再拆 |

### 11.4 PR-3A / PR-3B 各自的 commit message 范式

**PR-3A**(本评审稿,docs-only):

```
docs(rbac): add P0-F PR-3 users module RBAC review

P0-F PR-3A:加入 users 模块 RBAC 接入评审稿;冻结 D1-D6 决议项,
供 PR-3B 代码 PR 按本评审稿落地。

- 7 条候选 permission code(user.read/create/update.account / user.reset.password
  / user.update.role / user.update.status / user.delete.account)
- 8 端点 controller / service 改造范式(沿 PR-1 / PR-2 字面复制)
- 6 项业务护栏(canViewUser / canManageUser / canCreateRole / canChangeRole /
  assertNotSelf / assertNotLastSuperAdmin)全部保留
- e2e 5 用例矩阵 + 反向断言 10101 / 10102 / 10103 全部保留
- 不动:src / test / prisma / seed / 其它 docs

本 PR docs-only;PR-3B 代码 PR 在 D1-D6 拍板后启动。
```

**PR-3B**(代码 PR):沿 PR-2A commit message 范式,描述 8 端点接入 + 7 条 permission code + ops-admin 绑定矩阵(按 D1-D3 拍板组合)。

---

## §12 风险与回滚

### 12.1 ADMIN 默认无 user 管理权限导致运营不可用(最高优先级风险)

- **风险**:PR-3B merged 上线后,所有现役 ADMIN 立即对 8 端点报 30100;若未提前 grant `ops-admin`,运营当天瘫痪
- **缓解**:
  - PR-3B 上线 SOP 前置:运维**必须**手工调 `POST /api/v2/users/:userId/roles` 把所有现役 ADMIN 都绑 `ops-admin`,**再** merge PR-3B
  - 沿 PR-1 #132 / PR-2A / PR-2B 已建立此心智("ADMIN 默认 30100")
  - 评审稿明文要求:上线 SOP 增 "PR-3B 上线前 grant ops-admin 给所有 ADMIN"步骤
- **回滚**:若运营瘫痪,DB 直改 `INSERT INTO user_roles ...` 给受影响 ADMIN;或 revert PR-3B 整 PR

### 12.2 `user.update.role` 越权风险(D1=B 路径)

- **风险**:若 D1 拍板 B(`user.update.role` 绑 ops-admin),ADMIN+ops-admin 可进入 service,触发 `canChangeRole`(actor 必须 SA)→ 抛 10101 而非 30100;前端 / e2e 若按 v1 假设按 40300 / 30100 判断会错配
- **缓解**:
  - **推荐 D1=A**(SA-only,不绑)— 让 Guard / RBAC / Service 三道防线对齐到 30100
  - 若用户拍板 D1=B,评审稿 §5.1 + §9.2 已明示 e2e 期望从 30100 改为 10101
- **回滚**:改 seed 撤销 `ops-admin` 绑 `user.update.role`(若 D1 拍板 B 后反悔)

### 12.3 `user.reset.password` 凭证敏感性(D2=B 路径)

- **风险**:若 D2 拍板 B(绑 ops-admin),持 ops-admin 的 ADMIN 可批量 reset USER 密码;运营被攻陷时危害扩散
- **缓解**:
  - `assertCanManageUser` 仍生效(ADMIN+ops-admin 只能 reset USER 不能 reset ADMIN)
  - `password.reset.by-admin` audit log 全程捕获(P0-E PR-3 已实装)
  - 撤 refresh(P0-E PR-3)保证旧 token 即时失效
  - 若用户更保守拍板 D2=A,沿 PR-2 D2 范式
- **回滚**:改 seed 撤销 `ops-admin` 绑 `user.reset.password`

### 12.4 最后一个 SUPER_ADMIN 保护

- **风险**:`assertNotLastSuperAdmin` 是 transactional cross-table count;PR-3B 改造期间若误删或重构出错,系统可能进入"零 active SA"死锁状态
- **缓解**:
  - 评审稿 §8.3 + §8.5 明示**该护栏不动**,PR-3B 实施时 grep 验证 `assertNotLastSuperAdmin` 调用点仍存在
  - users-last-super-admin.e2e-spec.ts 3 正向回归用例**保留不动**(沿 §1.8 + §9.4)
- **回滚**:若误删,revert 该函数 + 调用点

### 12.5 `User.role` 退役不在本期

- **风险**:本期红线;若 PR-3B 实施时误改 `User.role` / `Role` enum / `JwtPayload` / `CurrentUserPayload.role` / `JwtStrategy.validate` select,会摧毁整个 RBAC 模型(audit-logs 读权限 / RbacService 短路 / users.service 双层校验)
- **缓解**:
  - 评审稿 §0.2 / §1.4 / §2.2 三处明示本期不动
  - PR-3B 实施前**必须** grep 验证 [JwtStrategy.validate](../src/modules/auth/strategies/jwt.strategy.ts:47) / [CurrentUserPayload](../src/common/decorators/current-user.decorator.ts:16) / [auth.service](../src/modules/auth/auth.service.ts) / [audit-logs.service](../src/modules/audit-logs/audit-logs.service.ts) 全部未被触及
- **回滚**:若已误改,revert 改动文件;若数据已写入(本期红线**不动 schema**,不会发生)

### 12.6 audit-logs 不在本期(双轨期说明)

- PR-3B merged → 后续 P0-F PR-4(audit-logs RBAC 接入)启动前的窗口期:
  - users 8 端点走 `rbac.can()`(`RBAC_FORBIDDEN=30100`)
  - audit-logs 2 端点仍走 `@Roles`(`FORBIDDEN=40300`)
  - **不**算"破坏一致性",沿 PR-1 / PR-2A / PR-2B 后双轨期同样存在
- 双轨期内运维 / 文档需明示:不同模块的 403 响应 BizCode 不一致是预期行为,且会随后续 PR 收敛
- 双轨期长度:沿 P0-F PR-* 串行节奏,1-4 周

### 12.7 e2e 数量增长(~1339 → ~1375,~3-4%)

- **风险**:CI 时长增加;flaky 概率轻微提升
- **缓解**:
  - 沿 PR-2A/2B 增 ~45 用例后的耗时基准
  - e2e 范式严格沿 fixture,无新增 fixture 文件 / 无新增 helper / 无新增并发
- **回滚**:无回滚需求

### 12.8 OpenAPI breaking change(40300 → 30100;users 8 端点)

- **风险**:前端若按 `code: 40300` 硬判 forbidden,会断
- **缓解**:
  - 前端联调起步包文档([`first-release-frontend-scope.md`](first-release-frontend-scope.md))已建议按 HTTP status 处理,而非 BizCode
  - PR-3B 收口时同步更新 [`first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md)
- **回滚**:仅 BizCode 替换,改 controller 装饰器还原即可

### 12.9 回滚链路总结

- PR-3A(docs-only)出错 → 直接 revert,**零代码影响**
- PR-3B(代码 PR)出错 → 直接 revert,**不涉及 DB schema 回滚**(本期不动 schema / migration);仅 seed 中新增 7 条 permission + ops-admin 绑定的 RolePermission 残留(可忽略,不影响 v1 行为;若运维强迫清理,跑 `DELETE FROM permissions WHERE code LIKE 'user.%'` + `POST /api/v2/rbac/reload`)

---

## §13 实施前 checklist(PR-3B 启动前逐项确认)

### 13.1 评审 / 决议前置

- [ ] 用户拍板 **D1**(`user.update.role` 绑定策略;沿 §5.1)
- [ ] 用户拍板 **D2**(`user.reset.password` 绑定策略;沿 §5.2)
- [ ] 用户拍板 **D3**(其余 5 条 user 管理权限绑定策略;沿 §5.3)
- [ ] 用户拍板 **D4**(permission code 命名 `user.*` vs `users.*`;沿 §5.4)
- [ ] 用户拍板 **D5**(是否顺手补 audit;沿 §5.5)
- [ ] 用户拍板 **D6**(PR 拆分;沿 §5.6)
- [ ] 用户确认 permission code 命名清单(沿 §4;若 D4 拍板 B,字符串改 `users.*`)
- [ ] 用户确认 ops-admin grant 策略(沿 §6.2 + §12.1 上线 SOP 前置)
- [ ] 用户确认**不动** `User.role` / `Role` enum / `JwtPayload` / `CurrentUserPayload.role` / `JwtStrategy.validate` select(沿 §0.2 / §1.4 / §2.2)
- [ ] 用户确认**不动** audit-logs(沿 §2.2 / §12.6)

### 13.2 PR-3B 启动前技术前置

- [ ] grep [`permissions.module.ts`](../src/modules/permissions/permissions.module.ts) 确认 `RbacService` 已 exports;否则**先**改 module exports
- [ ] grep [`users.module.ts`](../src/modules/users/users.module.ts) 确认导入 `PermissionsModule` 无循环依赖
- [ ] grep [`users.service.ts`](../src/modules/users/users.service.ts) 确认 6 项业务护栏仍在(`canViewUser` / `canManageUser` / `canCreateRole` / `canChangeRole` / `assertNotSelf` / `assertNotLastSuperAdmin`)
- [ ] grep [`JwtStrategy`](../src/modules/auth/strategies/jwt.strategy.ts) `select` 仍含 `role: true`
- [ ] grep [`CurrentUserPayload`](../src/common/decorators/current-user.decorator.ts) 仍含 `role: Role` 字段
- [ ] grep [`audit-logs.service.ts`](../src/modules/audit-logs/audit-logs.service.ts) 5 处 `currentUser.role` 判断未被触及
- [ ] grep [`auth.service.ts`](../src/modules/auth/auth.service.ts) 3 处 `actorRoleSnap: user.role` 未被触及

### 13.3 PR-3B 启动后验收门槛(沿 [`CLAUDE.md §17.10`](../CLAUDE.md))

- [ ] `pnpm lint` 通过
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test:e2e` 全部通过(含本评审稿 §9 新增 ~35-40 用例)
- [ ] `pnpm test:unit` 全部通过(`users.policy.spec.ts` 36 用例不动)
- [ ] `pnpm build` 通过
- [ ] OpenAPI snapshot diff 仅 `403` enum 替换,**0** 路径 / DTO / tag 变化(沿 §10)
- [ ] contract spec 全绿
- [ ] `pnpm db:seed` dev 跑一次确认 ops-admin 持有正确条数 permission(沿 §7.5;默认推荐 53 条)
- [ ] handoff / current-state 收口(归 PR-3B 的 docs 收口子 PR 或 v0.15.0 handoff;不在本评审稿范围)

---

## §14 不在本文范围 / 引用来源 / 文档元信息

### 14.1 不在本文范围

- 接口字段细节(回 [`v2-api-contract.md`](v2-api-contract.md))
- BizCode 全量翻译表(回 [`first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md))
- `auth` / `audit-logs` / 业务记录类(activities / activity-registrations / attendances / members / member-profiles / emergency-contacts / certificates)的 RBAC 接入(归独立 P0-F 后续 PR)
- 部门部长 / 副部长层级权限(归 Slow-3 业务方拍板)
- Slow-4 79 接口全量 RBAC(归 V2 Slow 通道)
- `User.role` / `Role` enum / `JwtPayload` / `CurrentUserPayload.role` / `JwtStrategy.validate` select 字段调整(本期红线)
- `tokenVersion` / access token blacklist(沿 P0-E 评审稿 D-4 锁死本期不做)
- audit log `user.*` event(默认推荐 D5=B 不补,留独立 PR)
- 业务护栏的 RBAC 层化(`canViewUser` / `canManageUser` / `canCreateRole` / `canChangeRole` / `assertNotSelf` / `assertNotLastSuperAdmin` 全部保留在 service 层)
- 代码落地细节(归 PR-3B 实施稿)
- [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md) 铁律修订(若 D1-D6 拍板后确需,归独立 docs PR)
- 现有 [`readiness-plan`](first-release-readiness-plan.md) / [`frontend-scope`](first-release-frontend-scope.md) / [`bizcode-mapping`](first-release-bizcode-mapping.md) / [`bootstrap-sop`](first-release-bootstrap-sop.md) / [`current-state.md`](current-state.md) / [`security.md`](security.md) 的状态回填(归 PR-3B 的 docs 收口子 PR)

### 14.2 引用来源

| 文档 | 引用章节 |
|---|---|
| [`CLAUDE.md`](../CLAUDE.md) | §0 修改代码前必读 / §1 不解锁 / §8 权限与鉴权 / §13 角色层级与管理员保护 / §17.10 验收门槛 |
| [`AGENTS.md`](../AGENTS.md) | 同 CLAUDE.md(双向对齐) |
| [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) | §1.1 BizCode 段位 / §1.3 命名 / §3.2 排序 |
| [`docs/first-release-readiness-plan.md`](first-release-readiness-plan.md) | §3.1 P0-F / §5 PR 拆分 |
| [`docs/first-release-bootstrap-sop.md`](first-release-bootstrap-sop.md) | ops-admin grant SOP |
| [`docs/first-release-p0d-change-my-password-review.md`](first-release-p0d-change-my-password-review.md) | 评审稿章节范式(§0-§10) |
| [`docs/first-release-p0e-refresh-token-review.md`](first-release-p0e-refresh-token-review.md) | 评审稿章节范式 + D 档串行 PR 范式 + 决议 D-X 格式 |
| [`docs/first-release-p0f-pr2-config-rbac-review.md`](first-release-p0f-pr2-config-rbac-review.md) | **本评审稿章节结构直接对齐范式** + ops-admin 心智 + permission code 范式 |
| [`docs/first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md) | `RBAC_FORBIDDEN=30100` 翻译现状 |
| [`docs/first-release-frontend-scope.md`](first-release-frontend-scope.md) | 前端 BizCode 处理建议 |
| [`docs/current-state.md`](current-state.md) | §3 Slow-3 / §4 当前 @Roles 现状 |
| PR #132 commit `488b814` | P0-F PR-1 范本 + attachments F3/F5 v1.0 范本引用 |
| PR #134 commit `31b7e55` | P0-F PR-2A 范本 |
| PR #136 commit `93e87ac` | P0-F PR-2B 范本 |
| [PR #132 `permissions.controller.ts`](../src/modules/permissions/permissions.controller.ts) | controller 改造范本(§8.1) |
| [PR #132 `permissions.service.ts`](../src/modules/permissions/permissions.service.ts) | service 改造范本(§8.2)+ `assertCanOrThrow` 字面复制 |
| [PR #132 `test/fixtures/rbac.fixture.ts`](../test/fixtures/rbac.fixture.ts) | e2e fixture 复用范本(§7.3 + §9.6) |
| [PR #132 `test/e2e/permissions.e2e-spec.ts`](../test/e2e/permissions.e2e-spec.ts) | e2e 5 用例矩阵范本(§9.1) |
| [`src/modules/users/users.policy.ts`](../src/modules/users/users.policy.ts) | 4 个业务护栏函数 |
| [`src/modules/users/users.service.ts`](../src/modules/users/users.service.ts) | 6 项 service-level 业务护栏调用点 |

### 14.3 文档元信息

- **撰写日期**:2026-05-18
- **状态**:v1 评审稿,待用户拍板
- **作者**:Claude(P0-F PR-3 前置设计阶段产出)
- **基线 commit**:`93e87ac`(P0-F PR-2B merged 后)
- **下一步动作**:
  1. 用户 review 本评审稿
  2. 用户拍板 D1-D6 + PR 拆分确认
  3. (拍板后)启动 PR-3B 代码 PR
  4. PR-3B merged + 验收 → 启动后续 P0-F PR(audit-logs / 业务记录类,沿 Slow-3 / Slow-4 评审节奏)

### 14.4 撰写边界声明

本评审稿严格 docs-only:
- 仅新增 1 个文件 [`docs/first-release-p0f-pr3-users-rbac-review.md`](first-release-p0f-pr3-users-rbac-review.md)
- 不修改 src / prisma / test / 其它 docs
- 不创建 migration
- 不改 schema / seed
- 不启动 PR-3B 任何代码实施
- 全部决议项保留 A / B / C 三选择;§6 推荐拍板可被用户改动
- 命名命题保留可改路径(D4 命名拍板后可改 §4 列表)
- code 段位与已有 `rbac.*` / `attachment.*` / `dict.*` / `org.*` / `member-department.*` / `contribution.*` / `attachment-config.*` / `storage-setting.*` 物理隔离

如本文与 [`ARCHITECTURE.md`](../ARCHITECTURE.md) / [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md) / [`baseline`](srvf-foundation-baseline.md) 表述冲突,按 §0 优先级让步。
