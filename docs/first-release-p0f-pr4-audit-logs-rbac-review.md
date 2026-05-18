# P0-F PR-4 audit-logs 模块 RBAC 接入评审稿 v1(评审稿,非执行稿)

> **状态**:**v1 评审稿,D 档前置评审稿,非执行稿**。
> 本文档**不是**代码实现说明,**不是**铁律修订,**不是** seed/schema 变更。
> 本文档冻结 P0-F PR-4 audit-logs 模块 RBAC 接入的设计决策,供 PR-4B(代码 PR)严格按本评审稿落地。
>
> **冲突优先级**(沿 [`process.md §6`](process.md)):`ARCHITECTURE.md` > `CLAUDE.md` / `AGENTS.md` > [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) > [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) > **本评审稿** > handoff > [`current-state.md`](current-state.md) > [`process.md`](process.md)。冲突时本评审稿让步。
>
> **不在本文范围**:接口字段细节(回 [`v2-api-contract.md`](v2-api-contract.md));BizCode 全量翻译(回 [`first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md));`users` / `auth` / 业务记录类(activities / activity-registrations / attendances / members / member-profiles / emergency-contacts / certificates)的 RBAC 接入(归独立 P0-F PR / Slow-4);代码落地细节(归 PR-4B 实施稿);`User.role` 字段删除 / `Role` enum 变化 / `JwtPayload` / `JwtStrategy` / `CurrentUserPayload.role` 调整(本期红线);`actorRoleSnap` schema / DTO / select / `audit_logs` 表 / `AuditLogsService.log()` 入参 / 写入路径(本期红线 + audit 不可改不可删);`CLAUDE.md` / `AGENTS.md` 铁律修订(若有,归独立 docs PR)。
>
> **本稿是评审稿,不代表已经允许直接写代码**。**禁止**在 D1-D6 拍板前启动 PR-4B;PR-4B 启动前**必须**重读本评审稿 §13 复核点。

---

## §0 用途与定位

### 0.1 解决什么问题

P0-F PR-1([PR #132](https://github.com/) commit `488b814`)+ PR-2A([PR #134](https://github.com/) commit `31b7e55`)+ PR-2B([PR #136](https://github.com/) commit `93e87ac`)+ PR-3([PR #138](https://github.com/) commit `8941a8d`)已完成 5 个 RBAC 元接口 + 6 个配置类模块 + users 8 管理端点共 69 端点的 RBAC 接入,把 v1 三层 `@Roles(SUPER_ADMIN, ADMIN)` 全部切换到 service 层 `rbac.can()`(沿 attachments F3 / F5 v1.0 范本)。但**当前事实仍然是**:

- 已接入 `rbac.can()`:`permissions` / `rbac-roles` / `role-permissions` / `user-roles` / `rbac` 5 元接口(13 端点)+ `attachments` 主模块(17 端点)+ 6 配置类模块(48 端点)+ `users` 8 管理端点 = 86 端点
- 仍走 `@Roles(SUPER_ADMIN, ADMIN)`:`audit-logs`(2 处)+ `activities` / `activity-registrations` / `attendances` / `members` / `member-profiles` / `emergency-contacts` / `certificates` 业务记录类(多处)
- **audit-logs 模块在 PR-3 评审稿 §1.4 已被显式列为"本期红线"**(沿 [first-release-p0f-pr3-users-rbac-review.md §1.4](first-release-p0f-pr3-users-rbac-review.md));PR-3 范围明确不动,**留独立 P0-F 后续 PR**(即本 PR-4)。

audit-logs 的复杂度与其它已接入模块**显著不同**:

1. **历史快照语义**:`actorRoleSnap` 是操作发生当下的 `Role` enum 快照,**不能**用 `currentUser.role` 反向回查替代,事后操作人可能被改角色 / 禁用 / 软删
2. **数据范围由角色驱动**:list ADMIN 注入 `where.OR = [{actorUserId: self}, {actorRoleSnap: USER}]`,detail `assertCanReadAuditLog` 二次校验 ADMIN 越级 SA → 14101;这两段都**依赖 Prisma 行级查询字段**,无法用 RBAC 的 ownership(`.self`)模型自然承载
3. **业务级越级错误码并存**:`FORBIDDEN_AUDIT_LOG_READ=14101` 是 audit-logs 模块独有的"通过 Guard / 通过 RBAC 但 detail 越级"业务级错误码;与通用 `RBAC_FORBIDDEN=30100` 并存,**不可合并**
4. **audit 红线不可改不可删**:`audit_logs` 表无 `updatedAt` / `deletedAt`;PR-4 **绝不**改 schema / DTO / select / `log()` 入参 / 写入路径
5. **跨模块强依赖**:`AuditLogsService.log()` 被 emergency-contacts / certificates / contribution-rules / activities / activity-registrations / attendances / attachments / users / auth 多模块 import 调用;PR-4 仅在 controller / service 业务方法(list / findOne)接 RBAC,**写入路径绝对不动**

PR-4 的最小目标:让 audit-logs 模块 2 个 GET 端点接入 `rbac.can()`,通过 `ops-admin` 角色承载运营审计的职责;**保留**上述 5 处 service-level role 判断与数据范围 + 14101 业务护栏;**且不破** PR-1 / PR-2 / PR-3 已建立的 RBAC 模型(JwtPayload 仍最小、JwtStrategy 每请求查库、单一 `RBAC_FORBIDDEN=30100`、不引入 Redis、`User.role` / `Role` enum 不动)。

### 0.2 本评审稿的边界

- 本评审稿**只**讨论 audit-logs 模块 2 个 GET 端点(`list` + `findOne`)的 RBAC 接入策略与 permission code 设计。
- 本评审稿**不**讨论:
  - `AuditLogsService.log()` 写入路径(沿批次 6 R1 红线:audit 写入后不可改不可删)
  - `audit_logs` 表 / `AuditLog` Prisma model / migration(沿批次 6 红线)
  - `actorRoleSnap` 字段语义 / DB 字段 / DTO 字段 / select 字段(本期红线 + 历史快照不可重新定义)
  - `AuditLogResponseDto.actorRoleSnap` 字段是否保留(**保留**;沿 PR-3 §10.1 `UserResponseDto.role` 保留范式)
  - users / auth / 业务记录类(activities / activity-registrations / attendances / members / member-profiles / emergency-contacts / certificates)RBAC 接入(归独立 P0-F PR / Slow-4)
  - 是否新增 `audit-log.export.*`(本期不开 export 接口;沿批次 6 §3 F5 红线)
  - 是否新增 `audit-log.read.sensitive.*`(本期已有打码机制,沿批次 6 D-C 拍板)
  - 是否为 list / findOne 自身补 `audit-log.read` 事件(沿批次 6 F6 红线:**不审计 audit_logs 自身**)
  - **RBAC schema 变更**(`User.role` 删除、`Role` enum 变化、`JwtPayload` 调整、`CurrentUserPayload.role` 调整、`JwtStrategy.validate` select 字段调整 — **全部排除**)
  - migration / seed 真实运营数据录入(seed 仅扩 permission + RolePermission 映射)
  - `tokenVersion` / access token blacklist(已在 P0-E 评审稿 D-4 锁死本期不做)
- 本评审稿**不**改任何运行时代码 / schema / migration / seed / 测试 / OpenAPI snapshot。
- 本评审稿**不**改 [`readiness-plan`](first-release-readiness-plan.md) / [`frontend-scope`](first-release-frontend-scope.md) / [`bizcode-mapping`](first-release-bizcode-mapping.md) / [`bootstrap-sop`](first-release-bootstrap-sop.md) / [`current-state.md`](current-state.md) / [`security.md`](security.md)(这些状态回填归 PR-4B 的 docs 收口子 PR 或后续 handoff)。
- 本评审稿**不**改 [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md)(若 D1-D6 拍板后确需铁律修订,归独立 docs PR;沿 P0-D / P0-E / PR-2 / PR-3 范式)。

### 0.3 谁要拍板

本评审稿 v1 提出 6 个决议项(D1-D6),全部由用户拍板:

- **D1**:permission code 命名采用 `audit-log.*` 还是 `audit-logs.*`
- **D2**:`audit-log.read.entry` 是否绑 ops-admin
- **D3**:是否拆 `.self` / `.other` 4 段 scope
- **D4**:list / findOne 是否共用单条 `read` code
- **D5**:是否预留 `audit-log.export.*` / `audit-log.read.sensitive.*` 权限
- **D6**:PR 拆分(单 PR 还是评审稿 + 代码两阶段)

PR-4B 启动前必须 D1-D6 全部拍板。

---

## §1 当前事实盘点

> 本节带文件 + 行号引用,凡判断必有证据;v1 / V1.1 / V2 / V2.x / PR-1 / PR-2 / PR-3 历史决策不重述。

### 1.1 PR-1 / PR-2 / PR-3 已建立的 RBAC 接入范式(代码层 + e2e 层)

| 层 | 范式 | 引用 |
|---|---|---|
| controller | 移除 `@Roles(...)` 装饰器;仅留 `JwtAuthGuard`;`@ApiBizErrorResponse(...)` 内 `FORBIDDEN` 替换为 `RBAC_FORBIDDEN` | [`permissions.controller.ts:28-31`](../src/modules/permissions/permissions.controller.ts:28) / [`users.controller.ts`](../src/modules/users/users.controller.ts) |
| service | constructor 注入 `RbacService`;加 helper `assertCanOrThrow(user, action)`;每业务方法首句调用 | [`permissions.service.ts:41-45`](../src/modules/permissions/permissions.service.ts:41) / [`users.service.ts`](../src/modules/users/users.service.ts) |
| 失败响应 | 统一 `BizException(BizCode.RBAC_FORBIDDEN)`(`30100`,HTTP 403);沿 [biz-code.constant.ts:763](../src/common/exceptions/biz-code.constant.ts:763) | PR-1 commit `488b814` |
| e2e fixture | `seedRbacPermissionsAndOpsAdmin` / `grantOpsAdminToUser` / `revokeOpsAdminFromUser` 三 helper;`beforeAll` seed 完整 RBAC 数据 | [`test/fixtures/rbac.fixture.ts`](../test/fixtures/rbac.fixture.ts) |
| e2e 矩阵 | 5 用例(USER → 30100 / ADMIN 默认 → 30100 / ADMIN+ops-admin → 通过 / SUPER_ADMIN 短路 / me/permissions 任意登录) | [`test/e2e/permissions.e2e-spec.ts:69-168`](../test/e2e/permissions.e2e-spec.ts:69) |

### 1.2 audit-logs 模块当前结构(7 文件,实际 2 端点)

| 文件 | 行数 | 关键内容 |
|---|---|---|
| [audit-logs.controller.ts](../src/modules/audit-logs/audit-logs.controller.ts) | 71 | 2 端点(`list` + `findOne`);**2 处 `@Roles(SA, ADMIN)`** |
| [audit-logs.service.ts](../src/modules/audit-logs/audit-logs.service.ts) | 183 | 3 业务方法(`log` / `list` / `findOne`)+ `assertCanReadAuditLog` helper;**5 处 `currentUser.role` / `actorRoleSnap` 判读权** |
| [audit-logs.dto.ts](../src/modules/audit-logs/audit-logs.dto.ts) | 193 | 3 类(`AuditContextDto` / `AuditLogResponseDto` / `AuditLogQueryDto`);`AuditLogResponseDto.actorRoleSnap: Role \| null` |
| [audit-logs.select.ts](../src/modules/audit-logs/audit-logs.select.ts) | 25 | `auditLogSafeSelect.actorRoleSnap: true` |
| [audit-logs.types.ts](../src/modules/audit-logs/audit-logs.types.ts) | 83 | `AuditLogEvent` union(24 项)+ `AuditContext` 锁形 + `AuditMeta` |
| [audit-logs.module.ts](../src/modules/audit-logs/audit-logs.module.ts) | 19 | imports: `DatabaseModule`;exports: `AuditLogsService`(被多业务模块 import) |
| [audit-logs.service.spec.ts](../src/modules/audit-logs/audit-logs.service.spec.ts) | — | 既有 unit 测试 |

### 1.3 audit-logs.service 内 role 依赖点(5 处;PR-4B 全部保留)

| 行号 | 用法 | 用途 | PR-4B 是否动 |
|---|---|---|---|
| [99-101](../src/modules/audit-logs/audit-logs.service.ts:99) | `currentUser.role === Role.ADMIN` → `where.OR = [{actorUserId: self}, {actorRoleSnap: USER}]` | list ADMIN where 注入(数据范围)| ❌ 不动 |
| [154](../src/modules/audit-logs/audit-logs.service.ts:154) | `currentUser.role === Role.SUPER_ADMIN` 直通 | detail 二次校验 SA 短路 | ❌ 不动 |
| [155](../src/modules/audit-logs/audit-logs.service.ts:155) | `currentUser.role === Role.ADMIN` | detail 二次校验 ADMIN 分支入口 | ❌ 不动 |
| [156-158](../src/modules/audit-logs/audit-logs.service.ts:156) | `log.actorUserId === currentUser.id` OR `log.actorRoleSnap === Role.USER` 否则抛 14101 | detail ADMIN 越级判断 | ❌ 不动 |
| [160-161](../src/modules/audit-logs/audit-logs.service.ts:160) | USER 防御性 fallback → 14101 | Guard 失效兜底 | ❌ 不动 |

### 1.4 跨模块对 `User.role` / `Role` enum / `actorRoleSnap` 的强依赖(本期红线,**全部不动**)

| 文件 | 行号 | 用法 | PR-4B 是否动 |
|---|---|---|---|
| [JwtStrategy.validate](../src/modules/auth/strategies/jwt.strategy.ts:47) | 47 | `select: { id, username, role, status, memberId }` | ❌ **本期不动**(沿 P0-E v1 D-4 / Zero Drift)|
| [CurrentUserPayload](../src/common/decorators/current-user.decorator.ts:16) | 16 | `role: Role` 字段 | ❌ **本期不动** |
| [JwtPayload](../src/modules/auth/strategies/jwt.strategy.ts:14) | 14 | `{ sub, username }`(不含 role) | ❌ **本期不动** |
| [audit-logs.service.ts](../src/modules/audit-logs/audit-logs.service.ts) | 30 / 37 / 66 | `actorRoleSnap: Role \| null` 在 `log()` 入参与 Prisma 写入 | ❌ **本期不动**(写入路径不动) |
| [audit-logs.dto.ts](../src/modules/audit-logs/audit-logs.dto.ts) | 88-92 | `AuditLogResponseDto.actorRoleSnap: Role \| null` + `@ApiPropertyOptional({ enum: Role })` | ❌ **本期不动**(沿 PR-3 §10.1 范式,前端契约 zero drift)|
| [audit-logs.select.ts](../src/modules/audit-logs/audit-logs.select.ts) | 14 | `auditLogSafeSelect.actorRoleSnap: true` | ❌ **本期不动** |
| [AuditLog.actorRoleSnap](../prisma/schema.prisma:748) | 748 | `Role?` enum 字段 | ❌ **本期不动**(audit 不可改不可删) |
| [auth.service](../src/modules/auth/auth.service.ts) | 113 / 295 / 368 | `actorRoleSnap: user.role` 3 处写入 | ❌ **本期不动**(写入路径不动) |
| [users.service](../src/modules/users/users.service.ts) | 244 / 400 | `actorRoleSnap: currentUser.role` 2 处写入 | ❌ **本期不动** |
| 业务记录类 service / controller(activities / activity-registrations / attendances / members / member-profiles / emergency-contacts / certificates)| 多处 | `@Roles(...)` + `actorRoleSnap` 写入 | ❌ **本期不动**(归 Slow-4) |

**关键结论**:`User.role` / `Role` enum / `CurrentUserPayload.role` / `JwtStrategy` select / `actorRoleSnap` schema 与 DTO 是整个 RBAC 模型与审计历史快照模型的承载基础设施。PR-4 / PR-4B **绝对不动**;若发现需要动,**立即停止并升级到 ARCHITECTURE.md §9 升级路径评审**。

### 1.5 actorRoleSnap 历史快照语义(本期红线核心)

| 维度 | 内容 |
|---|---|
| **来源** | 操作发生**当下**的 `currentUser.role` 快照,由调用方在 `log()` 入参显式提供(沿 [audit-logs.service.ts:30-41](../src/modules/audit-logs/audit-logs.service.ts:30)) |
| **类型** | Prisma `Role?` enum(`SUPER_ADMIN` / `ADMIN` / `USER` / null;`null` 表示系统操作或未登录场景)|
| **为什么是快照** | 事后查 user 表反向取 `role` 不可靠:操作发生后用户可能被改角色 / 禁用 / 软删,沿用查表会"角色历史失真";`actorRoleSnap` 锁定操作当下事实 |
| **为什么不用 RBAC 业务角色** | RBAC 业务角色(`ops-admin` 等)本身有"被撤销"语义;v1 三层 enum(`Role`)**永久存在**,适合做不可变快照 — 这是审计可信的基础设施保证 |
| **当前数据范围如何用** | list ADMIN 注入 `actorRoleSnap === USER`(看 USER 角色操作的记录);detail ADMIN 越级查 `actorRoleSnap === SA` → 14101 |
| **本期是否动** | **绝对不动**:audit 不可改不可删红线 + PR-3 §1.4 列入本期红线 + 历史快照重新定义会破坏跨期审计语义 |

### 1.6 当前数据范围规则(沿 [批次6_audit_logs_业务确认稿](批次6_audit_logs_业务确认稿.md) Q3=B)

| currentUser.role | list 可见范围 | detail 可见范围 |
|---|---|---|
| `SUPER_ADMIN` | **全部**(short-circuit;list 不注入 where;detail 不校验) | **全部** |
| `ADMIN` | `actorUserId === self` **OR** `actorRoleSnap === USER` | 同 list 规则;越级 SA / 越级 其它 ADMIN → **14101 `FORBIDDEN_AUDIT_LOG_READ`** |
| `USER` | Guard 已挡(`40300`,沿 v1 `@Roles(SA, ADMIN)` Guard 拒绝)| Guard 已挡;防御性 fallback → 14101 |

**业务意图**(沿批次 6 业务确认稿 §问题 3 B 选项):

- 管理员能看自己操作过的全部记录(便于回头查自己上周做过什么)
- 管理员能看 USER 角色被操作的记录(便于审计普通用户行为)
- 但**不能**看其他 ADMIN / SA 操作过的记录(防止互相窥探)
- 操作记录不可删除红线已堵死"自己擦痕迹"的可能,放开看自己安全

### 1.7 BizCode 段位现状(P0-F PR-4 涉及段)

| 段位 | 实数 | PR-4 后 |
|---|---|---|
| `14001 AUDIT_LOG_NOT_FOUND` | 已实装([biz-code.constant.ts:618-622](../src/common/exceptions/biz-code.constant.ts:618))| **完全保留**(detail 命中但不存在;沿 D6 v1.1 §9)|
| `14101 FORBIDDEN_AUDIT_LOG_READ` | 已实装([biz-code.constant.ts:623-627](../src/common/exceptions/biz-code.constant.ts:623))| **完全保留**(ADMIN 越级查 SA detail;沿 D6 v1.1 §9 / D-D)|
| `30100 RBAC_FORBIDDEN` | 已实装([biz-code.constant.ts:763-767](../src/common/exceptions/biz-code.constant.ts:763))| 复用,**不新增**(PR-4B controller `@ApiBizErrorResponse` 内 `FORBIDDEN` → `RBAC_FORBIDDEN`)|
| `40300 FORBIDDEN`(通用) | 仍存在,沿 v1 通用 | PR-4 把 audit-logs 2 端点 controller 装饰器替换;通用段保留,**不删除** |

PR-4B **不新增任何 BizCode**(沿 PR-1 / PR-2 / PR-3 零新增范式)。

### 1.8 seed / fixture 现状(PR-3 后)

| 实体 | 当前 seed 数量 | PR-4 后预期(默认推荐组合)|
|---|---|---|
| `RBAC_PERMISSION_SEED`(rbac.*) | 14 条 | 14 条(不动) |
| `ATTACHMENT_PERMISSION_SEED`(attachment.*) | 20 条 | 20 条(不动) |
| `MEMBER_ROLE_PERMISSION_CODES`(member 角色) | 9 条 | 9 条(不动) |
| `PR_2A_PERMISSION_SEED`(dict / org / member-department / contribution) | 19 条 | 19 条(不动) |
| `PR_2B_PERMISSION_SEED`(attachment-config / storage-setting) | 15 条 | 15 条(不动) |
| `USER_PERMISSION_SEED`(user.*) | 7 条(PR-3B) | 7 条(不动) |
| **PR-4 新增 `AUDIT_LOG_PERMISSION_SEED`**(audit-log.*) | 0 | **1 条** |
| Permission 表 RBAC/config/user 段位合计 | 14 + 19 + 15 + 7 = **55 条** | 55 + 1 = **56 条** |
| `ops-admin` RolePermission 绑定 | 53 条(沿 PR-3 默认推荐 D1=A / D2=B / D3=A)| **沿 D2 拍板扩张**(默认推荐 53 + 1 = **54 条**) |
| Permission 全集(含 attachments) | 55 + 20 = 75 条 | 56 + 20 = **76 条** |

### 1.9 OpenAPI contract snapshot 约束

- 当前 [`test/contract/__snapshots__/openapi.contract-spec.ts.snap`](../test/contract/__snapshots__/openapi.contract-spec.ts.snap) 已锁定 v1 14 路由 + V2 79 路由的完整契约
- PR-1 / PR-2 / PR-3 已经把 86 端点的 `403` 段从 `40300/FORBIDDEN` 改为 `30100/RBAC_FORBIDDEN`
- PR-4B **预期 snapshot diff**:
  - 仅 2 端点(`GET /api/v2/audit-logs` + `GET /api/v2/audit-logs/{id}`)的 `403` 段 enum 替换;**0 路径增删** / **0 schema 字段增删**(`AuditLogResponseDto.actorRoleSnap` 字段保留)/ **0 tag 变化** / **404 段 `AUDIT_LOG_NOT_FOUND=14001` 完全保留** / **detail 接口的 `FORBIDDEN_AUDIT_LOG_READ=14101` 完全保留**(沿现状作为业务级越级码并存)
  - 量级:2 端点 × ~14 行 ≈ **~30 行**(沿 PR-3 8 端点 / ~115 行同款行/端点比例推算)

### 1.10 现有 e2e 测试覆盖边界(P0-F PR-4 涉及部分)

| spec 文件 | 行数 | 受影响断言 | PR-4B 是否需改 |
|---|---|---|---|
| [audit-logs.e2e-spec.ts](../test/e2e/audit-logs.e2e-spec.ts) | 534 | 权限边界段 4 用例(行 142-164)断言 `FORBIDDEN` / 40300 | **需改**(沿 5 用例矩阵改 + 数据范围保留段)|
| [audit-logs-migrations.e2e-spec.ts](../test/e2e/audit-logs-migrations.e2e-spec.ts) | 1979 | 测的是 8 + 业务 service 调用 `AuditLogsService.log()` 落库迁移,**不动** list/findOne 端点 | **不动** |

[audit-logs.service.spec.ts](../src/modules/audit-logs/audit-logs.service.spec.ts):service 增 `assertCanOrThrow` helper 需补 4-6 单元用例(mock `rbac.can` 返 true/false × 2 业务方法);**不动** `assertCanReadAuditLog` 既有用例(逻辑保留)。

---

## §2 PR-4 范围

### 2.1 在本范围(2 GET 端点 / 1 controller / 1 模块)

| 端点 | HTTP | 当前 Guard | service 数据范围 / 业务护栏 |
|---|---|---|---|
| `GET /api/v2/audit-logs` | GET | `@Roles(SA, ADMIN)` | ADMIN where 注入(`actorUserId=self OR actorRoleSnap=USER`)|
| `GET /api/v2/audit-logs/:id` | GET | `@Roles(SA, ADMIN)` | `assertCanReadAuditLog`(SA 直通 / ADMIN 校验 self OR USER / 越级 14101)|

合计 **2 端点 / 2 处 `@Roles` / 1 段 list ADMIN where 注入 / 1 段 detail 二次校验 / 14101 业务护栏**。

### 2.2 不在本范围(显式排除)

| 模块 / 端点 | 排除原因 |
|---|---|
| `AuditLogsService.log()` 写入路径 | 沿批次 6 R1 红线:audit 写入后不可改不可删;**绝对不动入参 / 函数体 / 签名** |
| `audit_logs` 表 / `AuditLog` Prisma model / migration | 沿批次 6 红线:不改 schema / 不创建 migration |
| `actorRoleSnap` 字段(schema / DTO / select / log() 入参) | 历史快照本期红线(沿 §1.5);**绝对不动** |
| `AuditLogEvent` union(24 项)| 沿批次 6 §8.1 锁定 + 业务模块写入路径不动 |
| `AuditContext` 锁形 6 字段(3 必填 + 3 可选) | 沿批次 6 §10 D-F 拍板;**不动** |
| 敏感字段打码工具(`mask-pii.util.ts` 4 函数)| 沿批次 6 §7 D-C 拍板;**不动** |
| `audit-log.export.*` permission | 沿批次 6 §3 F5 红线:**禁开 export 接口** → permission 也不预占段位 |
| `audit-log.read.sensitive.*` permission | 当前 detail 暴露的本就是脱敏值;细分"看脱敏"vs"看原文"等同重新发起业务确认稿 → **不预占** |
| 为 list / findOne 自身补 `audit-log.read` 事件 | 沿批次 6 §3 F6 红线:**不审计 audit_logs 自身**(避免循环)|
| `users` / `auth` 模块 | PR-3 + P0-E PR-3 已实施;PR-4 **不动** |
| 业务记录类(activities / activity-registrations / attendances / members / member-profiles / emergency-contacts / certificates)| 涉敏数据 self/other 拆分;归 Slow-4 |
| `attachments` 主模块 | F3/F5 v1.0 已落地;**不动** |
| `permissions` / `rbac-roles` / `role-permissions` / `user-roles` / `rbac` | PR-1 #132 已接入;**不动** |
| `dictionaries` / `organizations` / `member-departments` / `contribution-rules` | PR-2A 已接入;**不动** |
| `attachment-{type,mime,size-limit}-configs` / `storage-settings` | PR-2B 已接入;**不动** |
| `health` / `ai` | 全 `@Public()` / README 占位;无需 RBAC |
| User.role / Role enum / JwtPayload / CurrentUserPayload.role / JwtStrategy.validate select | **本期红线,绝对不动**(沿 §0.2 / §1.4) |
| 数据范围与 detail 越级护栏(`list` ADMIN where 注入 / `assertCanReadAuditLog` / 14101 防御性 fallback)| **全部保留**;不挪到 RBAC 层 / 不改用 `.self` 后缀 / 不拆 sub-permission |

**Slow-3 / Slow-4 启动诉求**:本评审稿**不**触发,沿 [`current-state.md §3`](current-state.md) Slow-3 待用户拍板。

---

## §3 当前 @Roles 使用点统计(2 处)

> 全部数据基于 main HEAD `8941a8d`(P0-F PR-3 落地后)+ grep 实测。

| controller | 端点 / HTTP / 角色锁 | 行号 |
|---|---|---|
| `AuditLogsController` | `GET /api/v2/audit-logs` SA+ADMIN | [36](../src/modules/audit-logs/audit-logs.controller.ts:36) |
| `AuditLogsController` | `GET /api/v2/audit-logs/:id` SA+ADMIN | [51](../src/modules/audit-logs/audit-logs.controller.ts:51) |

**小结**:2 端点;USER 由 Guard 直接挡(`40300`);ADMIN 通过 Guard 但 service 再做"自己 OR USER 操作的"数据范围 + detail 越级 14101 兜底。

---

## §4 permission code 设计(1 条候选)

### 4.1 命名规则(沿 PR-1 / PR-2 / PR-3 + D2 v1.2 正则)

- 正则 `/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,3}$/` —— 3-4 段 kebab-case
- 语义 `<module>.<action>.<resource_type>[.<scope>]`
- 段间严格 `.` 分隔;段内仅 `[a-z0-9-]`;首字母小写
- PR-4 本期**不使用** `.self` 后缀(沿 §5.3 D3 拒绝理由)
- 沿 PR-1 / PR-3 "list / findOne 共享 `read`"范式
- 复用 `RBAC_FORBIDDEN=30100`,**不开**新 BizCode

### 4.2 1 条候选 permission code(推荐方案)

| # | code | 覆盖端点 | 段数 | 数据范围 / 业务护栏并存说明 |
|---|---|---|---|---|
| 1 | `audit-log.read.entry` | `GET /api/v2/audit-logs`(list)+ `GET /api/v2/audit-logs/:id`(findOne) | 3 | service 内 list ADMIN where 注入 + detail `assertCanReadAuditLog` + 14101 越级码**全部保留**(收窄到目标 actorRoleSnap === USER OR actorUserId === self 的范围)|

**端点 → code 映射汇总**:2 端点 → 1 code(GET list + GET :id 共享 `audit-log.read.entry`)。

### 4.3 段位与已实装的物理隔离

| 已实装 module 段位 | 新增 module 段位 | 是否碰撞 |
|---|---|---|
| `rbac.*`(14 条;PR-1) | `audit-log.*` | ❌ |
| `attachment.*`(20 条;F3/F5 v1.0) | `audit-log.*` | ❌ |
| `dict.*` / `org.*` / `member-department.*` / `contribution.*`(PR-2A 共 19 条) | `audit-log.*` | ❌ |
| `attachment-config.*` / `storage-setting.*`(PR-2B 共 15 条)| `audit-log.*` | ❌ |
| `user.*`(7 条;PR-3) | `audit-log.*` | ❌ |

**特别说明**:`audit-log.*` 单数模块名沿 PR-1 `rbac.*` / PR-2 `dict.*` / `org.*` / `contribution.*` / PR-3 `user.*` 单数模块名范式;**不**用 `audit-logs.*`(沿 §5 D1)。

### 4.4 命名取舍说明

**为什么用 `audit-log.read.entry` 而不是 `audit-log.list.*` / `audit-log.find.*`?**

- 沿 PR-1 `rbac.permission.read` / `rbac.role.read` / `rbac.role-permission.read` / `rbac.user-role.read` / PR-3 `user.read.account` 范式,**list / findOne 共享 `read`**
- `entry` resource_type 显式表示"一条审计记录入口",与 `event` 字段语义对偶("事件入口");沿 PR-3 `user.read.account` "account 是 user 的承载对象"范式

**为什么不用 `record` / `log` 而用 `entry`?**

- `record` 与 `RolePermission` / `UserRole` 等 RBAC 表内"关系记录"语义重叠,易混淆
- `log` 与 nestjs-pino / `logger.info` / `auditPlaceholder` pino-only 占位语义重叠
- `entry` 在审计领域常用("audit entry" / "log entry"),不与已有概念碰撞

**为什么不开 `audit-log.list.entry` / `audit-log.find.entry` 分离 code?**

- 沿 PR-1 / PR-2 / PR-3 "list + findOne 共用 read" 范式;两端点权限边界天然一致(同一表的读权)
- 单 code 减少 ops-admin 绑定矩阵复杂度;沿 D4 推荐 A

**为什么不开 `audit-log.export.*` / `audit-log.read.sensitive.*`?**

- export 接口本期不开(沿批次 6 §3 F5 红线);**绝不**预占段位 → 未来真出现 export 诉求时单独评审(沿 [`CLAUDE.md §1 B 档`](../CLAUDE.md))
- sensitive 字段已在写入路径打码(沿批次 6 §7 D-C);detail 暴露的就是脱敏值,无"看原文"路径 → 重新发起业务确认稿才能开此码
- 沿 D5 推荐 A

---

## §5 决议项 D1-D6

> 每个决议列 A / B / C 三选项 + 推荐项 + 理由 + 风险。**禁止预判用户拍板结果**;§6 推荐拍板作为默认,但**任一项**可被用户改动。

### 5.1 D1:permission code 命名采用 `audit-log.*` 还是 `audit-logs.*`

**问题**:HTTP 路径是 `/api/v2/audit-logs`(复数,沿表名 `audit_logs`);DB 表名 `audit_logs`(复数);permission code module 段是 `audit-log.*`(单数)还是 `audit-logs.*`(复数)?

**选项**:

| 选项 | code 示例 | 优点 | 缺点 |
|---|---|---|---|
| **A**(推荐) | `audit-log.read.entry` | 沿 PR-1 `rbac.*` / PR-2 `dict.*` / `org.*` / `contribution.*` / `member-department.*` / `attachment-config.*` / `storage-setting.*` / PR-3 `user.*` 全部单数模块名范式;module 段是"业务能力域名",不是"HTTP 路径名" | HTTP 路径复数 + DB 表名复数 / permission code 单数,前端需注意映射 |
| **B** | `audit-logs.read.entry` | 与 HTTP 路径 + 表名复数一致 | 偏离 PR-1 / PR-2 / PR-3 单数模块名范式;`audit-logs.*` 在 OpenAPI tag / module 文件 / 文档中都需重新对齐 |
| **C** | 混合:list `audit-log.list` + 详情 `audit-log.find` | 各端点动词最贴切 | 段位混乱;沿 R/C/U/D 范式偏离;`audit-log.list` 无 resource_type 段(2 段)违反正则下限 3 段 |

**推荐**:**A**——沿 PR-1 / PR-2 / PR-3 范式;permission code 是"业务能力名",不是"HTTP 路径名",单复数无强对应。

**风险**:无实质风险;前端 BizCode 文档需明示 `audit-log.*` 单数(沿 [`first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md))。

### 5.2 D2:`audit-log.read.entry` 是否绑 ops-admin

**问题**:audit-logs 是"运营审计能力"的核心入口。`ops-admin` 是否绑 `audit-log.read.entry`?

**选项**:

| 选项 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **A** | seed 创建该 permission 但**不绑** `ops-admin`;SUPER_ADMIN 经短路通过;ADMIN+ops-admin → `30100` | 最强保守;audit 读权收紧到 SA;类比 PR-2 D2 `storage-setting.reset.credentials` / PR-3 D1 `user.update.role` 不绑 ops-admin | 与 v1 `@Roles(SA, ADMIN)` 现状反转;运营无法回头查自己上周做过什么操作(批次 6 业务确认稿 Q3=B 拒绝 A 选项的核心痛点重新出现)|
| **B**(推荐) | 绑给 `ops-admin`;与 PR-3 `user.read.account` 同等心智 | (1)沿 v1 SA+ADMIN 现状,心智一致;(2)批次 6 业务确认稿 Q3=B 明确"管理员能看自己 + 看 USER 操作记录"是合理运营诉求;(3)**service 层数据范围已收紧到自己 OR USER 操作的记录**,ADMIN+ops-admin 无法越权看其它 ADMIN / SA 的记录(沿 §1.6);(4)沿 PR-3 默认推荐 D2=B 同款心智 | 与 PR-2 D2 `storage-setting.reset.credentials` / PR-3 D1 `user.update.role` 收紧路径不对称(凭证 reset / 角色修改收紧 / audit 读放宽);需运维理解差异 |
| **C** | 新建独立 `audit-reader` 角色,grant 给指定 SUPER_ADMIN / ADMIN | 职责分离最细 | 新增角色 + 运维额外 grant 步骤;PR-4B 复杂度上升;偏离 PR-2 / PR-3 "ops-admin 一角通吃运营"心智 |

**推荐**:**B**——沿 PR-3 D2 + 批次 6 业务确认稿 Q3=B 心智一致;**数据范围 service 层已足够强**(ADMIN+ops-admin 仍只能看自己 OR USER 操作的记录),无越权风险;且批次 6 业务确认稿明示"管理员能看自己回头查"是 B 选项的核心价值。

**理由**:

1. **业务诉求合理**:救援队管理后台日常运营场景包括"运营回头查自己上周做过什么"+"运营核查 USER 角色违规操作";若仅 SA 可看 audit,运营审计能力受限
2. **safeguard 已足**:list ADMIN where 注入(`actorUserId=self OR actorRoleSnap=USER`) + detail `assertCanReadAuditLog` 越级 14101 已经把 ADMIN+ops-admin 锁死到合规范围
3. **沿 v1 行为对齐**:v1 `@Roles(SA, ADMIN)`,B 选项保持心智一致
4. **与 `storage-setting.reset.credentials` / `user.update.role` 不对称是有理由的**:audit 是"读权",数据范围已收紧;前两者是"凭证级写权" / "角色提升级写权",影响面 + 风险等级不同

**风险**:

- B 选项下,持 ops-admin 的 ADMIN 可读取自己 + USER 操作的所有 audit 记录;**虽然 audit log 本身只读,无破坏性**,但运营若被攻陷会增加历史操作信息泄露面 → 缓解依赖**数据范围已收紧** + 14101 越级码
- A 选项下,运营无法回头审计自己 / USER 角色行为,SA 在职时段以外的审计能力受阻;违反批次 6 业务确认稿 Q3=B 已经拒绝的"A 太严格"路径

如用户更偏保守,改 **A**(沿 PR-2 D2 / PR-3 D1 凭证 / 角色提升级收紧范式);用户拍板 A 时 e2e 矩阵需相应调整(沿 §9.3)。

### 5.3 D3:是否拆 `.self` / `.other` 4 段 scope

**问题**:audit-logs 数据范围(`actorUserId=self OR actorRoleSnap=USER`)与 attachments `.self` / `.other` 范式有相似性。是否拆 `audit-log.read.entry.self` / `audit-log.read.entry.other`?

**选项**:

| 选项 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **A**(推荐) | 单条 `audit-log.read.entry`(3 段);数据范围保留 service 层 | **审计数据范围本就不是 ownership 模型**;`.self` 只能表达 "owner=self",**无法表达** "owner=self **OR** target role=USER";拆 self/other 后 service 仍需保留判断 → 没真正减负 | 数据范围逻辑在 service 层"硬编码",未来若需细分需改 service |
| **B** | 拆 `audit-log.read.entry.self`(看自己操作的)+ `audit-log.read.entry.other`(看任意人操作的)| RBAC 模型表达完整;ownership 走 ownerType=user / ownerId=actorUserId | (1)`actorRoleSnap === USER` 这条 service 层规则**无 RBAC 对应**,仍需保留 → 没真正减负;(2)`.self` 模型语义是"对自己的资源",但 audit 是"对操作记录"的 ownership 反向 — 语义不自然;(3)需新增 2 条 permission + 数据范围 service 仍保留 → 复杂度上升 |
| **C** | 拆 `audit-log.read.entry.self`(看自己操作的)+ `audit-log.read.entry.observe-user`(看 USER 角色操作的)| 完整对应当前数据范围两条规则 | (1)`.observe-user` 不是标准 scope 后缀;(2)RbacService.judge 不识别 `.observe-user` → 仅命名提示;(3)data model 视角不自然 |

**推荐**:**A**——单条 code,数据范围保留 service 层;沿 PR-3 §8.3 "业务护栏全部保留,不挪到 RBAC 层"范式。

**理由**:

- `actorRoleSnap === USER` 这条规则**不是 ownership 模型**:audit 记录的"主人"是 actorUserId(操作人),而非"被操作的目标对象";拆 `.self` / `.other` 无法表达"我能看 USER 角色操作的记录"
- attachments `.self` 模型成功是因为附件本身有清晰的 owner 概念(uploadedBy);audit 记录是"事件流",无 owner 概念
- 单条 code + service 层数据范围是更小代价的设计;若未来真需要细分(如 dept-chief 看部门内成员操作),沿 Slow-3 升级路径单独评审

**风险**:无实质风险;若未来出现"按部门 / 按角色细分 audit 可见范围"诉求,改 service 层数据范围即可,不影响 permission code 模型。

### 5.4 D4:list / findOne 是否共用单条 `read` code

**问题**:`audit-log.read.entry` 同时覆盖 `GET list` + `GET findOne`,是否合理?还是拆成 list-only / findOne-only 两条?

**选项**:

| 选项 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **A**(推荐) | 共用单条 `audit-log.read.entry`;list / findOne 同一权限 | 沿 PR-1 `rbac.permission.read` / PR-2 / PR-3 `user.read.account` 共用 read 范式;心智一致;ops-admin 绑定矩阵简单 | 若未来需要"运营只能看 list 列表不能看 detail"细分,需改 RBAC 模型 |
| **B** | 拆 `audit-log.list.entry` + `audit-log.read.entry`;各自独立绑定 | RBAC 表达细;运营若被拆分职责可区别授权 | (1)`list.entry` 命名违反"list / findOne 共用 read" 范式;(2)`audit-log.list.entry` 在正则范围内但 action 段是 `list` 偏离 R/C/U/D + 自定义动词范式;(3)实际权限边界相同(都是读) — 拆分无业务价值 |
| **C** | 仅开 `audit-log.read.entry` 覆盖 findOne;list 走另一段(如 `audit-log.read.list`)| 名称对偶清晰 | 偏离 PR-1 范式;`.list` 不是标准 resource_type — 语义不自然 |

**推荐**:**A**——共用单条 code;沿 PR-1 / PR-2 / PR-3 范式。

**风险**:无实质风险;若未来需要细分,新增 permission code 即可,不影响向后兼容。

### 5.5 D5:是否预留 `audit-log.export.*` / `audit-log.read.sensitive.*` 权限

**问题**:audit-logs 模块未来可能扩展 export(导出 csv)或 sensitive(看原文非脱敏)能力。是否在 PR-4B 顺手预留 permission code?

**选项**:

| 选项 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **A**(推荐) | 不预留;仅开 `audit-log.read.entry` 1 条 | 沿批次 6 §3 F5 (export) + §3 F6 (audit 自身) 红线;**绝不**预占段位;未来真需求触发评审解锁(沿 [`CLAUDE.md §1 B 档`](../CLAUDE.md)) | 未来 export / sensitive 真上线时需新增 permission + seed + ops-admin 绑定(常规增量,非破坏性) |
| **B** | 预留 `audit-log.export.csv` + `audit-log.read.sensitive.*`;seed 创建 + 不绑 ops-admin | 未来扩展时仅运维补 grant 即可;迁移成本低 | (1)沿 [`CLAUDE.md §1`](../CLAUDE.md) "不预设未来需求"铁律;(2)预占段位 → 未来真需求来时设计可能演化,预占的 code 命名风险;(3)沿 PR-2 D2 / PR-3 D1 "凭证 reset / 角色提升不预占" 范式 |
| **C** | 预留 `audit-log.export.csv` 但不预留 sensitive(分级) | 仅预留 export 一类 | 同 B 缺点;且无原则区分为何 export 预留而 sensitive 不预留 |

**推荐**:**A**——不预留;沿 batches 6 F5 / F6 红线 + [`CLAUDE.md §1`](../CLAUDE.md) 铁律。

**理由**:

- export 接口本期不开(沿批次 6 §3 F5);**绝不**预占段位 → 未来 export 真上线时一并发起业务确认稿(决定导出范围 / 频率限制 / 审计) + 评审稿 + 代码 PR
- sensitive 字段已在写入路径打码(沿批次 6 §7 D-C 拍板);detail 暴露的就是脱敏值,无"看原文"路径 → 若有此诉求需重新发起业务确认稿(因为打码策略可能改)

**风险**:无实质风险;A 选项与 v1 / V1.1 / V2 "不预设未来需求"铁律对齐。

### 5.6 D6:PR 拆分

**问题**:本评审稿(PR-4A,docs-only)与代码实施(PR-4B)是分两 PR 还是合一?

**选项**:

| 选项 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **A** | 单 PR(docs + 代码一起)| 一次 review 完成 | docs 评审与代码实施混在一起;若 D1-D6 评审反复,代码已写部分需返工;违反 P0-D / P0-E / PR-2 / PR-3 串行范式 |
| **B**(推荐) | PR-4A docs-only(本评审稿)+ PR-4B 代码实现 | 沿 P0-D / P0-E / PR-2 / PR-3 4-PR 串行精神;评审稿先冻结决议项,代码 PR 严格按评审稿落地;回滚链路清晰 | PR 数量增加;PR-4A merged → PR-4B 启动需等待 |
| **C** | PR-4A docs + PR-4B 代码再拆 audit-logs 端点子集 | 风险隔离最细 | 2 端点拆 2 子 PR 收益极低;偏离 PR-2 / PR-3 单 PR 范式 |

**推荐**:**B**——沿 P0-D PR-1/2/3 + P0-E PR-1/2/3 + PR-2A/2B / PR-3A/3B 串行范式;PR-4A 是本评审稿,merged 后启动 PR-4B 代码 PR。

**风险**:无实质风险;PR-4A → PR-4B 间隔可控(1-2 周)。

---

## §6 推荐拍板

### 6.1 默认推荐组合

| 决议 | 推荐 | 引用 |
|---|---|---|
| D1 permission code 命名 | **A**:`audit-log.*` 单数模块名 | §5.1 |
| D2 `audit-log.read.entry` 绑定策略 | **B**:绑 `ops-admin` | §5.2 |
| D3 是否拆 `.self` / `.other` | **A**:不拆,数据范围保留 service 层 | §5.3 |
| D4 list / findOne 是否共用单条 code | **A**:共用 `audit-log.read.entry` | §5.4 |
| D5 是否预留 export / sensitive 权限 | **A**:不预留 | §5.5 |
| D6 PR 拆分 | **B**:PR-4A docs + PR-4B 代码 | §5.6 |

### 6.2 推荐组合下的 ops-admin 最终绑定矩阵

> 假设 D1=A、D2=B、D3=A、D4=A、D5=A、D6=B。

- 既有 53 条(沿 PR-1 + PR-2 + PR-3;14 rbac + 19 PR-2A + 14 PR-2B + 6 PR-3B,**不含** `storage-setting.reset.credentials` + `user.update.role`)
- PR-4 后扩 1 条:`audit-log.read.entry`
- 合计 **54 条**;SUPER_ADMIN 短路通过任意 action(沿 D7 §7.1 / `rbac.service.ts:118`)

| 备选组合 | ops-admin 绑定数 | 备注 |
|---|---|---|
| D2=A(audit 收紧 SA-only) | 53 + 0 = **53 条**(无变化) | `audit-log.read.entry` 入 Permission 表但不绑 ops-admin |
| D2=B(默认推荐) | 53 + 1 = **54 条** | `audit-log.read.entry` 绑 ops-admin;数据范围 service 层兜底 |

Permission 表全集(含未绑 ops-admin 的)始终 = 55(RBAC/config/user)+ 1(audit-log)= **56 条**;加 attachments 20 条 = 整库 **76 条**。

---

## §7 seed / fixture 变更设计

### 7.1 只改 seed,不改 schema(沿 §0.2 / §2.2 / [`CLAUDE.md §1 不解锁`](../CLAUDE.md))

- **不动** [`prisma/schema.prisma`](../prisma/schema.prisma)
- **不动** 任何 [`prisma/migrations/`](../prisma/migrations/)
- **不动** RBAC 4 表(`permissions` / `rbac_roles` / `role_permissions` / `user_roles`)结构
- **不动** `audit_logs` 表结构

### 7.2 [`prisma/seed.ts`](../prisma/seed.ts) 变更点(预生成 SQL 不适用 —— seed 是运行时 upsert)

| 位置 | PR-4B 改 |
|---|---|
| `USER_PERMISSION_SEED` 之后新增 module 段位常量 | 新增 `AUDIT_LOG_PERMISSION_SEED` 常量数组(1 条 `audit-log.read.entry`)|
| `ALL_PERMISSION_SEED` | 加入 `...AUDIT_LOG_PERMISSION_SEED`;Permission 表从 55 + 20(attachments)= 75 条扩到 56 + 20 = **76 条** |
| `OPS_ADMIN_PERMISSION_SEED` | 按 D2 拍板扩张:D2=B(默认推荐)→ +1 条;D2=A → 0 条 |
| `OPS_ADMIN_DESCRIPTION` 常量文案 | "RBAC 自身 14 条 + 配置类 33 条 + 用户管理 6 条 + audit 读 1 条;凭证 reset / 角色修改仅 SUPER_ADMIN" |
| `console.log('[seed] RBAC role-permissions ensured ...')` | 数字与上述同步 |

### 7.3 [`test/fixtures/rbac.fixture.ts`](../test/fixtures/rbac.fixture.ts) 变更点

- 沿 fixture 现有说明:`resetDb` 清空 RBAC 4 表,e2e 必须自带 seed
- PR-4B:`seedRbacPermissionsAndOpsAdmin` 内的 `RBAC_PERMISSIONS` 常量从 53 条扩到默认推荐组合 54 条(沿 D2=B);若 D2=A,则仍 53 条(`audit-log.read.entry` 加入 `permission.upsert` 但**不**加入 `rolePermission.createMany`)
- `grantOpsAdminToUser` / `revokeOpsAdminFromUser` 不变(签名不动)
- **不**新建独立 fixture 文件(沿 PR-1 / PR-2 / PR-3 "一个 fixture 一次 seed 全集"范式)

### 7.4 seed 幂等性保证

- 现有 `prisma.permission.upsert({ where: { code }, update: {}, create: {...} })` 范式天然幂等
- 现有 `prisma.rolePermission.upsert({ where: { roleId_permissionId: ... }, update: {}, create: ... })` 范式天然幂等
- 多次跑 seed 不重复创建;**已绑的 RolePermission 不会因 seed re-run 被撤销**

### 7.5 生产 / 测试 / 演练环境的 seed 行为

| 环境 | 首次 seed 后 ops-admin 权限(默认推荐 D2=B)| 第二次 seed(re-run)后 |
|---|---|---|
| dev | 54 条 | 54 条(upsert no-op) |
| test(e2e DB) | fixture 控制,与 seed 解耦 | fixture 控制 |
| staging | 54 条 | 54 条(upsert no-op) |
| production | 54 条 | 54 条(upsert no-op);**运营若手工撤销了某 RolePermission,seed re-run 会重新加回**(沿现 seed `update: {}` 不覆盖既有,但 RolePermission 走 upsert,需 PR-4B 实施时显式确认;沿 PR-3 §7.5 同款)|

**实施前置**(沿 [`CLAUDE.md §0`](../CLAUDE.md)):seed 改动**不需要** `prisma migrate dev`,但 PR-4B 提交前**必须**在 dev 跑一次 `pnpm db:seed` 验证 54 条 RolePermission 都符合预期。

---

## §8 controller / service 改造范式

> 严格沿 PR-1 / PR-2 / PR-3 范本;**禁止**自创新范式。

### 8.1 controller 改 4 项(每端点)

```ts
// 改前(沿 v1 / V2 既有 audit-logs.controller.ts)
@Get()
@Roles(Role.SUPER_ADMIN, Role.ADMIN)
@ApiOperation({ summary: '列出审计记录...' })
@ApiWrappedPageResponse(AuditLogResponseDto)
@ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
list(
  @Query() query: AuditLogQueryDto,
  @CurrentUser() currentUser: CurrentUserPayload,
): Promise<PageResultDto<AuditLogResponseDto>> {
  return this.service.list(query, currentUser);
}

// 改后(沿 PR-3 users.controller.ts 范式)
@Get()
@ApiOperation({ summary: '列出审计记录...' })
@ApiWrappedPageResponse(AuditLogResponseDto)
@ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
list(
  @Query() query: AuditLogQueryDto,
  @CurrentUser() currentUser: CurrentUserPayload,
): Promise<PageResultDto<AuditLogResponseDto>> {
  return this.service.list(query, currentUser);
}
```

**4 项动作**(每 2 端点)

1. 移除 `@Roles(Role.SUPER_ADMIN, Role.ADMIN)` 装饰器
2. `@ApiBizErrorResponse(...)` 内 `BizCode.FORBIDDEN` → `BizCode.RBAC_FORBIDDEN`(detail 接口的 `BizCode.AUDIT_LOG_NOT_FOUND` + `BizCode.FORBIDDEN_AUDIT_LOG_READ` **完全保留**)
3. `Roles` import 在所有 `@Roles` 移除后整文件清理(controller 内只 2 处 `@Roles`,移除后 `Roles` import 与 `Role` import 同时清理)
4. `@CurrentUser() currentUser: CurrentUserPayload` 已注入(audit-logs.controller.ts 现状两端点均已注入),**无新增**

### 8.2 service 改 3 项

```ts
// 沿 PR-1 / PR-3 范式
private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
  if (!(await this.rbac.can(user, action))) {
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }
}

// list 业务方法首句调用
async list(
  query: AuditLogQueryDto,
  currentUser: CurrentUserPayload,
): Promise<PageResultDto<AuditLogResponseDto>> {
  await this.assertCanOrThrow(currentUser, 'audit-log.read.entry');
  // ... 既有业务逻辑(QueryDto 过滤 + ADMIN where 注入 + Prisma findMany;沿现状)
}

// findOne 业务方法首句调用
async findOne(id: string, currentUser: CurrentUserPayload): Promise<AuditLogResponseDto> {
  await this.assertCanOrThrow(currentUser, 'audit-log.read.entry');
  // ... 既有业务逻辑(findUnique + assertCanReadAuditLog + toResponseDto;沿现状)
}
```

**3 项动作**:

1. constructor 注入 `private readonly rbac: RbacService`(从 PermissionsModule 取)
2. 加 `assertCanOrThrow` private helper(沿 PR-1 `permissions.service.ts:41-45` 字面复制,**禁止**改动签名)
3. **仅** list / findOne 两方法首句 `await this.assertCanOrThrow(currentUser, 'audit-log.read.entry')`;**`log()` 写入路径绝对不动**

### 8.3 业务护栏全部保留(5 处 role 判断 + 1 条业务护栏码,**不挪动**)

| 护栏 | service 位置 | 调用点 | 保留理由 |
|---|---|---|---|
| list ADMIN where 注入 | [audit-logs.service.ts:99-101](../src/modules/audit-logs/audit-logs.service.ts:99) | list | 数据范围需要 `actorRoleSnap` 查询字段,permission code 不能表达 |
| `assertCanReadAuditLog` SA 短路 | [audit-logs.service.ts:154](../src/modules/audit-logs/audit-logs.service.ts:154) | findOne | RBAC 已短路 SA;但本地兜底为防御性,保留 |
| `assertCanReadAuditLog` ADMIN 分支 | [audit-logs.service.ts:155-159](../src/modules/audit-logs/audit-logs.service.ts:155) | findOne | ADMIN 越级越级 → 14101 是业务级错误码 |
| `assertCanReadAuditLog` USER 防御性 fallback | [audit-logs.service.ts:160-161](../src/modules/audit-logs/audit-logs.service.ts:160) | findOne | RBAC 已拒(30100)→ 此 fallback 永不到达;但保留作防御 |
| `BizCode.FORBIDDEN_AUDIT_LOG_READ`(14101) | [biz-code.constant.ts:623-627](../src/common/exceptions/biz-code.constant.ts:623) | service / controller | 业务级越级码,沿评审稿 D-D 拍板 |
| `BizCode.AUDIT_LOG_NOT_FOUND`(14001) | [biz-code.constant.ts:618-622](../src/common/exceptions/biz-code.constant.ts:618) | service / controller | 业务级 404 码,沿 D6 v1.1 §9 |

**禁止**(沿评审稿 §0.2 + §2.2):

- 把数据范围逻辑挪到 RBAC 层
- 拆 `.self` / `.other` 后缀(沿 §5.3 D3 拒绝理由)
- 修改 `assertCanReadAuditLog` 函数体或签名
- 修改 `AuditLogsService.log()` 入参 / 签名 / 内部逻辑(**绝对不动**)
- 删除或合并 14001 / 14101 业务级 BizCode

### 8.4 module 改 1 项

```ts
// 沿 PR-3 module 范式追加 PermissionsModule import
@Module({
  imports: [DatabaseModule, PermissionsModule],  // ← 新增 PermissionsModule
  controllers: [AuditLogsController],
  providers: [AuditLogsService],
  exports: [AuditLogsService],  // 保留:多业务模块强依赖
})
export class AuditLogsModule {}
```

**前置确认**:[`permissions.module.ts`](../src/modules/permissions/permissions.module.ts) 必须 `exports: [RbacService]`(PR-1 已实施);PR-4B 启动前 grep 验证(沿 PR-3 §8.4 同款前置)。

**特别检查 circular import**:`AuditLogsModule` 被多业务模块 import,`PermissionsModule` 本身也可能间接依赖某些 audit 写入模块;PR-4B 实施前必须 grep 验证 `permissions.*` import 链未触及 `audit-logs.*`(沿 PR-1 范式);若发现循环,**先**调整 module 边界。

### 8.5 特殊处理:write path 绝对零改动

| 路径 | PR-4B 改动 |
|---|---|
| `AuditLogsService.log(input: AuditLogInput): Promise<void>` 函数体 | ❌ **零改动**(沿批次 6 R1 红线 + 多业务模块强依赖) |
| `AuditLogInput` interface(`actorUserId` / `actorRoleSnap` / `resourceType` / `resourceId` / `event` / `meta` / `before` / `after` / `extra` / `tx`) | ❌ **零改动** |
| `AuditContext` / `AuditMeta` 锁形 type | ❌ **零改动** |
| `auditLogSafeSelect` / `SafeAuditLog` | ❌ **零改动** |
| `AuditLogResponseDto` 字段集 9 字段 | ❌ **零改动**(`actorRoleSnap` 保留;沿 §1.4 + PR-3 §10.1 范式)|
| `AuditLogQueryDto` 字段集 8 字段 | ❌ **零改动**(`page` / `pageSize` / `resourceType` / `resourceId` / `event` / `actorUserId` / `startDate` / `endDate`)|
| `mask-pii.util.ts` 4 函数 | ❌ **零改动** |
| `AuditLogEvent` union(24 项)| ❌ **零改动**(本期不补 audit 自身 event;沿 D5=A) |

**关键铁律**:**所有 service 写入路径 / DTO 字段集 / select / types 全部保留**(沿 §1.3 + §1.4 行号清单);PR-4B 只在 controller 上移除 `@Roles` 装饰器,在 service 业务方法(list / findOne)首句加一行 `assertCanOrThrow`,**其它代码逻辑零改动**。

---

## §9 e2e 矩阵

### 9.1 每 spec 文件最小 5 用例(沿 PR-1 / PR-2 / PR-3 范式)

| 用例 | 行为 | 期望响应 |
|---|---|---|
| 1 | 未登录 GET → 401 | `expectBizError(res, BizCode.UNAUTHORIZED)` |
| 2 | USER 角色任一端点 → 403 | `expectBizError(res, BizCode.RBAC_FORBIDDEN)` |
| 3 | ADMIN 默认(未持 ops-admin)任一端点 → 403 | `expectBizError(res, BizCode.RBAC_FORBIDDEN)` |
| 4 | ADMIN 持 ops-admin → 通过(`grantOpsAdminToUser` + try / finally + `revokeOpsAdminFromUser`)| 业务成功响应;**数据范围仍受 list ADMIN where 注入限制**(沿 §9.2);若 D2=A 改 30100 |
| 5 | SUPER_ADMIN 短路 → 通过(无需 grant)| 业务成功响应,可看全部 |

### 9.2 数据范围保留段(D2=B 推荐组合下;**ADMIN+ops-admin 仍受 service 数据范围限制**)

| spec | 用例 | 期望 | 触发护栏 |
|---|---|---|---|
| audit-logs | ADMIN+ops-admin GET list → 200,total 仅含 actorUserId=self OR actorRoleSnap=USER 的记录 | list ADMIN where 注入保留 | service:99-101 |
| audit-logs | ADMIN+ops-admin GET findOne(自己操作的)→ 200 | `assertCanReadAuditLog` ADMIN 分支 self 匹配 | service:156 |
| audit-logs | ADMIN+ops-admin GET findOne(USER 操作的)→ 200 | `assertCanReadAuditLog` ADMIN 分支 USER 匹配 | service:157 |
| audit-logs | ADMIN+ops-admin GET findOne(SA 操作的)→ 14101 | `assertCanReadAuditLog` ADMIN 越级 → 14101 | service:158 |
| audit-logs | ADMIN+ops-admin GET findOne(其它 ADMIN 操作的)→ 14101 | `assertCanReadAuditLog` ADMIN 越级 → 14101 | service:158 |

**若 D2 拍板 A(SA-only)**:上述全部用例改 `→ 30100 RBAC_FORBIDDEN`(ops-admin 不持 `audit-log.read.entry`);**SA-only 收紧验证**沿 PR-2 D2 / PR-3 D1 范式。

### 9.3 必须保留的反向断言(14001 / 14101)

PR-4B 改造期间,以下既有 e2e 断言**全部保留,不可破**:

| spec | 用例 | 期望 | 触发护栏 |
|---|---|---|---|
| audit-logs(detail 权限段) | ADMIN1 越级查 SUPER_ADMIN 操作的记录 → 14101 | `FORBIDDEN_AUDIT_LOG_READ` | `assertCanReadAuditLog` |
| audit-logs(detail 权限段) | ADMIN1 看另一个 ADMIN(ADMIN2)操作的记录 → 14101 | `FORBIDDEN_AUDIT_LOG_READ` | `assertCanReadAuditLog` |
| audit-logs(detail 权限段) | 不存在的 id → 14001 | `AUDIT_LOG_NOT_FOUND` | `findUnique` 返 null |
| audit-logs(list where 注入) | SA 可看全部 5 条 / ADMIN 仅看自己 + USER 共 3 条 / ADMIN2 看自己 + USER 共 2 条 | list 数据范围 | list:99-101 |
| audit-logs(不可改不可删) | PATCH / DELETE / PUT 返 404(无对应路由)| 沿批次 6 §3 F5 红线 | controller 不开写路径 |
| audit-logs(不审计自身) | GET audit 后查 audit_logs 表无新记录 | 沿批次 6 §3 F6 红线 | service 不调 log() |

### 9.4 USER / ADMIN 默认 / ADMIN+ops-admin / SA 矩阵

| 用例 | 当前 ([audit-logs.e2e-spec.ts:142-164](../test/e2e/audit-logs.e2e-spec.ts:142)) | PR-4B 后 |
|---|---|---|
| 未登录 GET list / detail | `BizCode.UNAUTHORIZED`(40100) | **保留**(沿 v1 401)|
| USER GET list / detail | `BizCode.FORBIDDEN`(40300) | **改为** `BizCode.RBAC_FORBIDDEN`(30100) |
| ADMIN 默认 GET list / detail | (当前 e2e 无此用例;ADMIN 默认通过 Guard)| **新增**:断言 `BizCode.RBAC_FORBIDDEN`(30100) |
| ADMIN+ops-admin GET list | **新增**:断言通过 + 数据范围(沿 §9.2) | — |
| ADMIN+ops-admin GET findOne | **新增**:断言通过(self / USER 操作的)+ 越级(SA / 其它 ADMIN 操作的)→ 14101 | — |
| SA GET list / detail | 沿 v1 通过(沿 [audit-logs.e2e-spec.ts:170-178 / 213-220](../test/e2e/audit-logs.e2e-spec.ts:170))| **保留**(短路)|

### 9.5 用例数量估算

| 范围 | spec 文件 | 用例增量 |
|---|---|---|
| PR-4B 改造 | audit-logs.e2e-spec.ts 权限边界段 4 用例 → 5 用例矩阵改 | ~4 改写 |
| | audit-logs.e2e-spec.ts 新增 ADMIN+ops-admin 数据范围段(5 用例;沿 §9.2)| ~5 新用例 |
| | audit-logs.e2e-spec.ts 新增 ADMIN 默认 30100 段(2 用例)| ~2 新用例 |
| **不动 spec** | audit-logs.e2e-spec.ts 其余(list where 注入 / detail 权限 / list 过滤排序 / 分页 / 不可改不可删 / AuditContext 锁形 / 不审计自身 / DTO 白名单 / cleanup helper)| 0 |
| **不动 spec** | audit-logs-migrations.e2e-spec.ts(1979 行,测落库迁移)| 0 |
| **合计** | 1 spec 改 + 1 spec 不动 | **~7-11 新增 / 改写用例** |

`pnpm test:e2e` 耗时预期增加 < 1%(2 端点改造增量极小)。

### 9.6 fixture 复用方式

- `seedRbacPermissionsAndOpsAdmin` 扩到 54 条 permission(沿 §6.2 默认推荐组合 D2=B;若 D2=A 则 53 条)
- `grantOpsAdminToUser` / `revokeOpsAdminFromUser` 不变(签名不动)
- 每 spec `beforeAll` 调用 `seedRbacPermissionsAndOpsAdmin` 一次;`grantOpsAdminToUser` 在用例 4 / 数据范围用例内按需调用,`afterEach` / `finally` 内 revoke
- 沿 audit-logs.e2e-spec.ts 现有 `truncateAuditLogsTestOnly` 清理范式(沿 [audit-logs-cleanup.ts](../test/helpers/audit-logs-cleanup.ts) test-only 豁免)

---

## §10 OpenAPI snapshot 预期变化

### 10.1 变化范围

| 变化类型 | 量级 | 备注 |
|---|---|---|
| `responses.403` enum 替换:`40300 / 无权限访问` → `30100 / 无权执行此操作` | 2 端点 × ~14 行 ≈ **~30 行** | PR-4B 单 PR |
| `paths.*` 路径增删 | **0** | PR-4 不动 endpoint |
| `paths.*.parameters` 或 `requestBody` | **0** | PR-4 不动 DTO / 入参 |
| `components.schemas.AuditLogResponseDto.actorRoleSnap` | **保留** | `actorRoleSnap: Role \| null` 字段不动,前端契约 zero drift |
| `components.schemas.AuditLogResponseDto.*`(其它 8 字段)| **保留** | 沿现状 |
| `components.schemas.AuditContextDto.*`(6 字段)| **保留** | 沿现状 |
| `components.schemas.AuditLogQueryDto.*`(8 字段)| **保留** | 沿现状 |
| `responses.404`(detail 接口)`AUDIT_LOG_NOT_FOUND=14001` | **保留** | 业务级 404 段不动 |
| `responses.403`(detail 接口)`FORBIDDEN_AUDIT_LOG_READ=14101` | **保留**(与通用 30100 并存于 enum)| 业务级越级码并存 |
| `tags` | **0** | controller `@ApiTags('audit-logs')` 不动 |

### 10.2 contract spec 验收(沿 [`test/contract/openapi.contract-spec.ts`](../test/contract/openapi.contract-spec.ts))

- PR-1 / PR-2A / PR-2B / PR-3B 已通过完整 contract spec 验证(沿 commit message)
- PR-4B 预期不引入新 contract spec 失败;若失败,优先检查 `@ApiBizErrorResponse` 装饰器签名与 `RBAC_FORBIDDEN` BizCode 引用(沿 PR-1 / PR-2 / PR-3 同款修复路径)
- snapshot diff 必须**只**包含 `403` enum 段位变化;**禁止**出现路径 / DTO / tag diff(若出现,视为越权改动,PR-4B 必须回退)
- 特别检查:detail 接口的 `403` 段在 PR-4B 后**同时含** `30100`(controller 装饰器 `@ApiBizErrorResponse` 加入)和 `14101`(原有业务级越级码),OpenAPI snapshot 可能需要支持 enum 多值或两段并存(沿 [audit-logs.controller.ts:57-63](../src/modules/audit-logs/audit-logs.controller.ts:57) `@ApiBizErrorResponse` 当前已有 5 个 BizCode 并列)

### 10.3 breaking change 性质

- 前端调用方:**HTTP status 不变**(仍是 403);**响应 body `code` 由 40300 → 30100**(USER / ADMIN 默认场景);**`code: 14101` 在 ADMIN 越级 detail 场景完全保留**
- 翻译表:沿 [`first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md) `RBAC_FORBIDDEN=30100` 已存在(PR-1 收口时落地);PR-4 不引入新翻译
- 前端处理:若前端按 HTTP status 处理,无变化;若按 BizCode 处理,需识别 30100 + 14101 两段(沿 PR-1 / PR-2 / PR-3 同款 breaking)

---

## §11 PR 拆分建议

### 11.1 推荐:PR-4A docs-only(本评审稿)+ PR-4B 代码实现

| 因素 | PR-4A + PR-4B 拆分的理由 |
|---|---|
| 沿袭范式 | P0-D PR-1/2/3 + P0-E PR-1/2/3 + PR-2A/2B + PR-3A/3B 均为串行评审稿 + 代码 PR;PR-4 不破例 |
| 决议复杂度 | D1-D6 共 6 项;评审稿先冻结再代码,避免反复返工 |
| 审计语义敏感 | `actorRoleSnap` / 不可改不可删 / 数据范围三道红线需要评审稿明示边界,代码 PR 严守 |
| 角色边界敏感 | `User.role` / `Role` enum / `JwtPayload` / `JwtStrategy` 全部本期红线;评审稿明示边界,代码 PR 严守 |
| 风险隔离 | PR-4A 仅文档;PR-4B 涉及 2 端点 + ~10 e2e + ~30 OpenAPI snapshot 行;两阶段评审 + 实施风险可控 |
| 回滚成本 | PR-4A 独立 revert 0 风险;PR-4B 独立 revert 仅影响 2 端点 RBAC 接入 |

### 11.2 备选(不推荐):单 PR 合并

| 缺点 |
|---|
| 评审稿与代码混在一起;若 D1-D6 评审反复,代码已写部分需返工 |
| 偏离 P0-D / P0-E / PR-2 / PR-3 串行范式 |
| OpenAPI snapshot diff + seed 改 + 1 e2e spec 改 + ~10 新用例**一次过**,review 负担虽小,但与既有 P0-F 节奏不一致 |

### 11.3 不推荐:PR-4B 再拆 audit-logs 端点子集

| 缺点 |
|---|
| 2 端点拆 2 子 PR 收益极低;seed + fixture 两阶段扩展复杂 |
| 偏离 PR-3 8 端点单 PR 范式;2 端点单 PR 是更小的可控量级 |

### 11.4 PR-4A / PR-4B 各自的 commit message 范式

**PR-4A**(本评审稿,docs-only):

```
docs(rbac): add P0-F PR-4 audit-logs module RBAC review

P0-F PR-4A:加入 audit-logs 模块 RBAC 接入评审稿;冻结 D1-D6 决议项,
供 PR-4B 代码 PR 按本评审稿落地。

- 1 条候选 permission code(audit-log.read.entry)
- 2 端点 controller / service 改造范式(沿 PR-1 / PR-2 / PR-3 字面复制)
- 5 处 service-level role 判断 / 数据范围 / actorRoleSnap 历史快照 / 14101
  业务护栏全部保留
- AuditLogsService.log() 写入路径绝对零改动
- e2e 5 用例矩阵 + 14101 / 14001 反向断言全部保留
- 不动:src / test / prisma / seed / 其它 docs

本 PR docs-only;PR-4B 代码 PR 在 D1-D6 拍板后启动。
```

**PR-4B**(代码 PR):沿 PR-3B commit message 范式,描述 2 端点接入 + 1 条 permission code + ops-admin 绑定矩阵(按 D2 拍板组合)。

---

## §12 风险与回滚

### 12.1 ADMIN 默认无 audit-log 读权限导致运营审计不可用(最高优先级风险)

- **风险**:PR-4B merged 上线后,所有现役 ADMIN 立即对 2 端点报 30100;若未提前 grant `ops-admin`(D2=B 推荐组合下),运营审计当天瘫痪;若 D2=A,SA 在职时段以外审计能力全停
- **缓解**:
  - PR-4B 上线 SOP 前置:运维**必须**手工调 `POST /api/v2/users/:userId/roles` 把所有现役 ADMIN 都绑 `ops-admin`,**再** merge PR-4B(沿 PR-1 / PR-2 / PR-3 已建立此心智)
  - 沿 [`first-release-bootstrap-sop.md`](first-release-bootstrap-sop.md) ops-admin grant SOP
- **回滚**:若运营瘫痪,DB 直改 `INSERT INTO user_roles ...` 给受影响 ADMIN;或 revert PR-4B 整 PR

### 12.2 `actorRoleSnap` 字段误改风险(本期红线核心)

- **风险**:PR-4B 实施时若误想"既然 v1 Role 退役不在本期但 audit 看的是 `actorRoleSnap` 而不是 `currentUser.role`,是不是顺手把字段精简",会**破坏跨期审计语义** — 已写入的 audit 行内 `actorRoleSnap` 是历史快照,改字段定义会让历史数据失去解释能力
- **缓解**:
  - 评审稿 §0.2 / §1.4 / §1.5 / §2.2 / §8.5 五处明示`actorRoleSnap` schema / DTO / select / 写入 / 入参**绝对不动**
  - PR-4B 实施前**必须** grep 验证 [audit-logs.service.ts:30-41 / 66](../src/modules/audit-logs/audit-logs.service.ts:30) / [audit-logs.dto.ts:88-92](../src/modules/audit-logs/audit-logs.dto.ts:88) / [audit-logs.select.ts:14](../src/modules/audit-logs/audit-logs.select.ts:14) / [schema.prisma:748](../prisma/schema.prisma:748) 全部未被触及
- **回滚**:若已误改,revert 改动文件;若数据已写入(本期红线**不动 schema**,不会发生)

### 12.3 数据范围与 self/other 误拆风险

- **风险**:PR-4B 实施时若误想"既然 attachments 有 `.self` / `.other`,audit-logs 是不是也拆一下,把数据范围挪到 RBAC 层",会**破坏数据范围语义**:`.self` 只能表达 "owner=self",**无法表达**"owner=self **OR** target role=USER";拆后 service 仍需保留判断 → 没真正减负,反而引入语义错配
- **缓解**:
  - 评审稿 §5.3 D3 推荐 A + 拒绝理由明示;PR-4B 严守 §6.1 默认推荐组合
  - 评审稿 §8.3 明示"数据范围逻辑保留在 service 层,不挪到 RBAC 层"
  - PR-4B 实施前 grep 验证 [audit-logs.service.ts:99-101 / 154-161](../src/modules/audit-logs/audit-logs.service.ts:99) 5 处 role 判断仍存在
- **回滚**:若误拆,revert 改动文件

### 12.4 audit log 自身不应再写 audit(沿批次 6 F6 红线)

- **风险**:PR-4B 改造期若顺手在 list / findOne 加 audit `audit-log.read.*` 事件,会**违反 F6 红线**"不审计 audit_logs 自身",并造成审计循环(查 audit → 写 audit → 又一条记录可能被查 → 死循环写入)
- **缓解**:
  - 评审稿 §0.2 / §2.2 / §5.5 D5 三处明示**禁止**为 list / findOne 加 audit 事件
  - 沿批次 6 §3 F6 红线
  - PR-4B 实施前 grep 验证 service list / findOne 方法内**无** `this.log(...)` / `await this.log(...)` 调用
- **回滚**:若误加,revert service 改动

### 12.5 多业务模块依赖 `log()`,`log()` 路径不能接 `rbac.can()`

- **风险**:`AuditLogsService.log()` 被 emergency-contacts / certificates / contribution-rules / activities / activity-registrations / attendances / attachments / users / auth 多模块 import 调用;若 PR-4B 在 `log()` 路径内加 `rbac.can()`,会:
  - 破坏批次 6 R1 红线(audit 写入是业务的副作用,不应被权限拦截)
  - 在事务内引入额外查询,影响性能 / 锁
  - 跨模块强依赖被 RBAC 调用链污染
- **缓解**:
  - 评审稿 §8.5 明示`log()` 函数体 / 入参 / 签名**零改动**
  - 评审稿 §8.2 明示**仅** list / findOne 两方法首句 `assertCanOrThrow`,`log()` 写入路径不接 RBAC
  - PR-4B 实施前 grep 验证 [audit-logs.service.ts:52-74](../src/modules/audit-logs/audit-logs.service.ts:52) `log()` 函数体未被触及
- **回滚**:若误加,revert service 改动

### 12.6 module 循环依赖风险

- **风险**:`AuditLogsModule` 被多业务模块 import;`PermissionsModule` 本身依赖 DatabaseModule,可能与某些 audit 写入模块间接形成循环
- **缓解**:
  - PR-4B 启动前 grep 验证 [`permissions.module.ts`](../src/modules/permissions/permissions.module.ts) 的 imports 链未触及 `audit-logs.*`
  - 若发现循环,**先**调整 module 边界(沿 PR-1 范式;若 `PermissionsModule.exports[RbacService]` 已正确,通常不会循环)
  - 沿 NestJS 标准 `forwardRef` 兜底(仅在确认循环时使用,**不**主动启用)
- **回滚**:若发现循环编译失败,撤回 module imports 改动

### 12.7 `User.role` 退役不在本期

- **风险**:本期红线;若 PR-4B 实施时误改 `User.role` / `Role` enum / `JwtPayload` / `CurrentUserPayload.role` / `JwtStrategy.validate` select / `actorRoleSnap` 字段,会摧毁整个 RBAC 模型与审计历史快照模型
- **缓解**:
  - 评审稿 §0.2 / §1.4 / §1.5 / §2.2 多处明示本期不动
  - PR-4B 实施前**必须** grep 验证 [JwtStrategy.validate](../src/modules/auth/strategies/jwt.strategy.ts:47) / [CurrentUserPayload](../src/common/decorators/current-user.decorator.ts:16) / [auth.service](../src/modules/auth/auth.service.ts) / [users.service](../src/modules/users/users.service.ts) / [audit-logs.service / dto / select / schema](../src/modules/audit-logs/) 全部未被触及
- **回滚**:若已误改,revert 改动文件;若数据已写入(本期红线**不动 schema**,不会发生)

### 12.8 业务记录类不在本期(双轨期说明)

- PR-4B merged → 后续 P0-F 业务记录类 PR(Slow-4)启动前的窗口期:
  - audit-logs 2 端点走 `rbac.can()`(`RBAC_FORBIDDEN=30100`)
  - 业务记录类多端点仍走 `@Roles`(`FORBIDDEN=40300`)
  - **不**算"破坏一致性",沿 PR-1 / PR-2A / PR-2B / PR-3B 后双轨期同样存在
- 双轨期内运维 / 文档需明示:不同模块的 403 响应 BizCode 不一致是预期行为,且会随后续 PR 收敛
- 双轨期长度:沿 P0-F PR-* 串行节奏 + Slow-4 评审节奏,1-N 周(取决于业务记录类评审节奏)

### 12.9 OpenAPI breaking change(40300 → 30100;audit-logs 2 端点)

- **风险**:前端若按 `code: 40300` 硬判 forbidden,会断
- **缓解**:
  - 前端联调起步包文档([`first-release-frontend-scope.md`](first-release-frontend-scope.md))已建议按 HTTP status 处理,而非 BizCode
  - 14101 业务级越级码完全保留,前端按业务码处理的代码无需改
  - PR-4B 收口时同步更新 [`first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md)
- **回滚**:仅 BizCode 替换,改 controller 装饰器还原即可

### 12.10 回滚链路总结

- PR-4A(docs-only)出错 → 直接 revert,**零代码影响**
- PR-4B(代码 PR)出错 → 直接 revert,**不涉及 DB schema 回滚**(本期不动 schema / migration);仅 seed 中新增 1 条 permission + ops-admin 绑定的 RolePermission 残留(可忽略,不影响 v1 行为;若运维强迫清理,跑 `DELETE FROM permissions WHERE code = 'audit-log.read.entry'` + `POST /api/v2/rbac/reload`)

---

## §13 实施前 checklist(PR-4B 启动前逐项确认)

### 13.1 评审 / 决议前置

- [ ] 用户拍板 **D1**(permission code 命名 `audit-log.*` vs `audit-logs.*`;沿 §5.1)
- [ ] 用户拍板 **D2**(`audit-log.read.entry` 绑定策略;沿 §5.2)
- [ ] 用户拍板 **D3**(是否拆 `.self` / `.other`;沿 §5.3)
- [ ] 用户拍板 **D4**(list / findOne 是否共用单条 code;沿 §5.4)
- [ ] 用户拍板 **D5**(是否预留 export / sensitive 权限;沿 §5.5)
- [ ] 用户拍板 **D6**(PR 拆分;沿 §5.6)
- [ ] 用户确认 permission code 命名清单(沿 §4;若 D1 拍板 B,字符串改 `audit-logs.*`)
- [ ] 用户确认 ops-admin grant 策略(沿 §6.2 + §12.1 上线 SOP 前置)
- [ ] 用户确认**不动** `User.role` / `Role` enum / `JwtPayload` / `CurrentUserPayload.role` / `JwtStrategy.validate` select(沿 §0.2 / §1.4)
- [ ] 用户确认**不动** `actorRoleSnap` 字段 / DTO / select / schema(沿 §0.2 / §1.5 / §2.2)
- [ ] 用户确认**不动** `AuditLogsService.log()` 写入路径(沿 §0.2 / §2.2 / §8.5)
- [ ] 用户确认数据范围保留 service 层(沿 §1.6 / §5.3 / §8.3)
- [ ] 用户确认**不新增** `audit-log.export.*` / `audit-log.read.sensitive.*`(沿 §5.5)

### 13.2 PR-4B 启动前技术前置

- [ ] grep [`permissions.module.ts`](../src/modules/permissions/permissions.module.ts) 确认 `RbacService` 已 exports;否则**先**改 module exports
- [ ] grep [`audit-logs.module.ts`](../src/modules/audit-logs/audit-logs.module.ts) 计划导入 `PermissionsModule` 无循环依赖
- [ ] grep [`audit-logs.service.ts:99-101 / 154-161`](../src/modules/audit-logs/audit-logs.service.ts:99) 5 处 `currentUser.role` / `actorRoleSnap` 判断仍在
- [ ] grep [`audit-logs.service.ts:52-74`](../src/modules/audit-logs/audit-logs.service.ts:52) `log()` 写入函数体未被规划触及
- [ ] grep [`audit-logs.dto.ts:88-92`](../src/modules/audit-logs/audit-logs.dto.ts:88) `AuditLogResponseDto.actorRoleSnap` 字段仍在
- [ ] grep [`audit-logs.select.ts:14`](../src/modules/audit-logs/audit-logs.select.ts:14) `actorRoleSnap: true` 仍在
- [ ] grep [`schema.prisma:742-769`](../prisma/schema.prisma:742) `AuditLog` model 未被规划修改
- [ ] grep [`JwtStrategy`](../src/modules/auth/strategies/jwt.strategy.ts) `select` 仍含 `role: true`
- [ ] grep [`CurrentUserPayload`](../src/common/decorators/current-user.decorator.ts) 仍含 `role: Role` 字段
- [ ] grep [`auth.service.ts`](../src/modules/auth/auth.service.ts) 3 处 `actorRoleSnap: user.role` 未被触及
- [ ] grep [`users.service.ts`](../src/modules/users/users.service.ts) 2 处 `actorRoleSnap: currentUser.role` 未被触及
- [ ] grep `BizCode.AUDIT_LOG_NOT_FOUND` / `BizCode.FORBIDDEN_AUDIT_LOG_READ` 仍在 [biz-code.constant.ts:618-627](../src/common/exceptions/biz-code.constant.ts:618)

### 13.3 PR-4B 启动后验收门槛(沿 [`CLAUDE.md §17.10`](../CLAUDE.md))

- [ ] `pnpm lint` 通过
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test:e2e` 全部通过(含本评审稿 §9 新增 ~7-11 用例)
- [ ] `pnpm test:unit` 全部通过(`audit-logs.service.spec.ts` 增 4-6 用例 mock rbac.can)
- [ ] `pnpm build` 通过
- [ ] OpenAPI snapshot diff 仅 `403` enum 替换,**0** 路径 / DTO / tag 变化(沿 §10)
- [ ] contract spec 全绿
- [ ] `pnpm db:seed` dev 跑一次确认 ops-admin 持有正确条数 permission(沿 §7.5;默认推荐 54 条)
- [ ] handoff / current-state 收口(归 PR-4B 的 docs 收口子 PR 或 v0.16.0 handoff;不在本评审稿范围)

---

## §14 不在本文范围 / 引用来源 / 文档元信息

### 14.1 不在本文范围

- 接口字段细节(回 [`v2-api-contract.md`](v2-api-contract.md))
- BizCode 全量翻译表(回 [`first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md))
- `users` / `auth` / 业务记录类(activities / activity-registrations / attendances / members / member-profiles / emergency-contacts / certificates)的 RBAC 接入(归独立 P0-F 后续 PR / Slow-4)
- 部门部长 / 副部长层级权限(归 Slow-3 业务方拍板)
- Slow-4 业务记录类全量 RBAC(归 V2 Slow 通道)
- `User.role` / `Role` enum / `JwtPayload` / `CurrentUserPayload.role` / `JwtStrategy.validate` select 字段调整(本期红线)
- `actorRoleSnap` schema / DTO / select / `audit_logs` 表 / `AuditLogsService.log()` 入参与写入路径(本期红线 + audit 不可改不可删)
- `tokenVersion` / access token blacklist(沿 P0-E 评审稿 D-4 锁死本期不做)
- audit log `audit-log.read.*` event(沿批次 6 F6 红线 + D5=A 不补,不审计 audit_logs 自身)
- `audit-log.export.*` / `audit-log.read.sensitive.*` permission(沿批次 6 F5 红线 + D5=A 不预留)
- 数据范围 / `assertCanReadAuditLog` / 14101 业务护栏的 RBAC 层化(全部保留在 service 层,沿 §8.3)
- 代码落地细节(归 PR-4B 实施稿)
- [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md) 铁律修订(若 D1-D6 拍板后确需,归独立 docs PR)
- 现有 [`readiness-plan`](first-release-readiness-plan.md) / [`frontend-scope`](first-release-frontend-scope.md) / [`bizcode-mapping`](first-release-bizcode-mapping.md) / [`bootstrap-sop`](first-release-bootstrap-sop.md) / [`current-state.md`](current-state.md) / [`security.md`](security.md) 的状态回填(归 PR-4B 的 docs 收口子 PR)

### 14.2 引用来源

| 文档 | 引用章节 |
|---|---|
| [`CLAUDE.md`](../CLAUDE.md) | §0 修改代码前必读 / §1 不解锁 / §8 权限与鉴权 / §17.10 验收门槛 |
| [`AGENTS.md`](../AGENTS.md) | 同 CLAUDE.md(双向对齐) |
| [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) | §1.1 BizCode 段位 / §1.3 命名 / §3.2 排序 |
| [`docs/first-release-readiness-plan.md`](first-release-readiness-plan.md) | §3.1 P0-F / §5 PR 拆分 |
| [`docs/first-release-bootstrap-sop.md`](first-release-bootstrap-sop.md) | ops-admin grant SOP |
| [`docs/first-release-p0d-change-my-password-review.md`](first-release-p0d-change-my-password-review.md) | 评审稿章节范式(§0-§10) |
| [`docs/first-release-p0e-refresh-token-review.md`](first-release-p0e-refresh-token-review.md) | 评审稿章节范式 + D 档串行 PR 范式 + 决议 D-X 格式 |
| [`docs/first-release-p0f-pr2-config-rbac-review.md`](first-release-p0f-pr2-config-rbac-review.md) | ops-admin 心智 + permission code 范式 |
| [`docs/first-release-p0f-pr3-users-rbac-review.md`](first-release-p0f-pr3-users-rbac-review.md) | **本评审稿章节结构直接对齐范式** + 业务护栏保留心智 + 历史快照红线 |
| [`docs/批次6_audit_logs_API前评审.md`](批次6_audit_logs_API前评审.md) | §3 不做清单 / §6 权限规则 / §8 事件清单 / §9 BizCode / §10 AuditContext 锁形 / §12 e2e 矩阵 |
| [`docs/批次6_audit_logs_业务确认稿.md`](批次6_audit_logs_业务确认稿.md) | §问题 3 Q3=B 拍板(管理员看自己 + USER 操作)|
| [`docs/first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md) | `RBAC_FORBIDDEN=30100` / `AUDIT_LOG_NOT_FOUND=14001` / `FORBIDDEN_AUDIT_LOG_READ=14101` 翻译现状 |
| [`docs/first-release-frontend-scope.md`](first-release-frontend-scope.md) | 前端 BizCode 处理建议 |
| [`docs/current-state.md`](current-state.md) | §3 Slow-3 / §4 当前 @Roles 现状 |
| PR #132 commit `488b814` | P0-F PR-1 范本 + attachments F3/F5 v1.0 范本引用 |
| PR #134 commit `31b7e55` | P0-F PR-2A 范本 |
| PR #136 commit `93e87ac` | P0-F PR-2B 范本 |
| PR #138 commit `8941a8d` | P0-F PR-3B 范本(users 模块 RBAC 接入)|
| [PR #132 `permissions.controller.ts`](../src/modules/permissions/permissions.controller.ts) | controller 改造范本(§8.1) |
| [PR #132 `permissions.service.ts`](../src/modules/permissions/permissions.service.ts) | service 改造范本(§8.2)+ `assertCanOrThrow` 字面复制 |
| [PR #132 `test/fixtures/rbac.fixture.ts`](../test/fixtures/rbac.fixture.ts) | e2e fixture 复用范本(§7.3 + §9.6) |
| [PR #132 `test/e2e/permissions.e2e-spec.ts`](../test/e2e/permissions.e2e-spec.ts) | e2e 5 用例矩阵范本(§9.1) |
| [`src/modules/audit-logs/audit-logs.service.ts`](../src/modules/audit-logs/audit-logs.service.ts) | 5 处 role 判读权 / `log()` 写入路径 |
| [`src/modules/audit-logs/audit-logs.dto.ts`](../src/modules/audit-logs/audit-logs.dto.ts) | `AuditLogResponseDto.actorRoleSnap` 字段保留 |
| [`prisma/schema.prisma`](../prisma/schema.prisma:742) | `AuditLog` model + `actorRoleSnap Role?` 字段 |

### 14.3 文档元信息

- **撰写日期**:2026-05-18
- **状态**:v1 评审稿,待用户拍板
- **作者**:Claude(P0-F PR-4 前置设计阶段产出)
- **基线 commit**:`8941a8d`(P0-F PR-3B merged 后)
- **下一步动作**:
  1. 用户 review 本评审稿
  2. 用户拍板 D1-D6 + PR 拆分确认
  3. (拍板后)启动 PR-4B 代码 PR
  4. PR-4B merged + 验收 → 启动后续 P0-F PR(业务记录类,沿 Slow-3 / Slow-4 评审节奏)

### 14.4 撰写边界声明

本评审稿严格 docs-only:

- 仅新增 1 个文件 [`docs/first-release-p0f-pr4-audit-logs-rbac-review.md`](first-release-p0f-pr4-audit-logs-rbac-review.md)
- 不修改 src / prisma / test / 其它 docs
- 不创建 migration
- 不改 schema / seed
- 不启动 PR-4B 任何代码实施
- 全部决议项保留 A / B / C 三选择;§6 推荐拍板可被用户改动
- 命名命题保留可改路径(D1 命名拍板后可改 §4 列表)
- code 段位与已有 `rbac.*` / `attachment.*` / `dict.*` / `org.*` / `member-department.*` / `contribution.*` / `attachment-config.*` / `storage-setting.*` / `user.*` 物理隔离

如本文与 [`ARCHITECTURE.md`](../ARCHITECTURE.md) / [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md) / [`baseline`](srvf-foundation-baseline.md) 表述冲突,按 §0 优先级让步。
