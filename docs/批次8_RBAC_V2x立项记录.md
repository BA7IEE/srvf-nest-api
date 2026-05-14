# 《C-6 RBAC V2.x 立项记录(批次 8)》

> **状态(2026-05-14 PR #9 docs 收口更新)**:🎯 **实施 PR #1-#8 全部合入 main**;基础能力 + seed/bootstrap 落地。
> 剩余 PR #9(本 docs 收口)/ PR #10(bump version 0.8.0 → 0.9.0)/ PR #11(v0.9.0 handoff)三步,**未启动业务模块判权接入**(`rbac.can()` 在业务接口的实际调用留后续 PR)。
>
> **批次号**:C-6 RBAC(批次 8)
> **撰写日期**:2026-05-14(立项)/ 2026-05-14(PR #9 docs 收口更新)
> **接续(设计阶段)**:
> - PR #46 业务访谈提纲(squash commit `1b33c4e`)
> - PR #47 D6 业务确认稿(squash commit `44e1326`)
> - PR #48 D7 v0.1 草稿(squash commit `b892a7e`)
> - PR #50 D7 v0.2 局部收口(squash commit `6d54ec3`)
> - PR #51 D7 v1.0 冻结(squash commit `b301da8`)
> - PR #53 D7 v1.1 命名修订(`Role` → `RbacRole` 避 v1 enum 冲突;squash commit `569771b`)
>
> **实施阶段(全部合入)**:见 §四 PR 拆分表 PR #1-#8 状态列。

---

## 一、立项背景

### 1.1 已完成的设计阶段

C-6 RBAC 的设计阶段已**全部完成**(沿 PR #46 → #47 → #48 → #50 → #51 五段)。

| 阶段 | PR | squash commit | 状态 |
|---|---|---|---|
| 业务访谈提纲 | #46 | `1b33c4e` | ✅ 已合并 |
| D6 业务确认稿 | #47 | `44e1326` | ✅ 已合并(13 题逐项拍板 + 4 决议) |
| D7 v0.1 草稿 | #48 | `b892a7e` | ✅ 已合并(25 项决议提出) |
| D7 v0.2 局部收口 | #50 | `6d54ec3` | ✅ 已合并(锁定 5 项:D12 / F5 / F1 + baseline §1.1 + ARCHITECTURE.md §9) |
| **D7 v1.0 冻结** | **#51** | **`b301da8`** | ✅ **已合并;25 项决议全部 🔒 锁定** |

### 1.2 已锁定的 25 项决议(沿 D7 v1.0)

完整决议表见 [`docs/批次8_RBAC_API前评审.md §18`](批次8_RBAC_API前评审.md)。

**B 类(模型骨架,3 项)**:

- B1 RBAC 模型 = 完整 4 表(`Role` + `Permission` + `RolePermission` + `UserRole`)+ 沿用三层 Role 并存
- B2 三层 Role 自动继承(SUPER_ADMIN > ADMIN > USER)
- B3 RBAC 业务角色无显式继承(seed 显式映射)

**D 类(决策,12 项)**:

- D1 权限点粒度 = resource type 级
- D2 权限点 code 命名 = `<module>.<action>.<resource_type>`(kebab-case)
- D3 资源所有权 = `user.id` + `Member.id` 混合;Service 层显式构造 `RbacResource`
- D4 RBAC 4 model 软删策略 = Role 软删 / Permission/RolePermission/UserRole 物理删
- D5 缓存策略 = 进程内 short TTL + 显式 reload(沿 V1.1 §17.3 不引入 Redis)
- D6 缓存 TTL 默认 = 30 分钟(`RBAC_CACHE_TTL_SECONDS=1800`,env 可调)
- D7 角色层级 = 三级:SUPER_ADMIN > ops-admin > 业务部门角色
- D8 角色可分配性 = 代码硬编码(**不**引入 `role_assignable_targets` 配置表)
- D9 bootstrap = `RBAC_INITIAL_OPS_ADMIN_USER_ID` 优先 + SUPER_ADMIN fallback
- D10 "最后一个 ops-admin 保护" = 4 个触发场景(撤角色 / 软删角色 / disable user / 降级 SUPER_ADMIN)
- D11 `AuditLogEvent` 新增 9 项 union(路线 A 多 operation 共用 + `extra.operation` 区分)
- D12 过渡终止条件 = (c) **永不切换**;`users.policy.ts` 永久共存 + RBAC 业务级补充

**F 类(实施细节,10 项)**:

- F1 BizCode 段位 = **`300xx` 通用 / `301xx` 权限边界**(避开 `140xx + 141xx` audit_logs;baseline §1.1 已同步追加)
- F2 16 API 端点路径(permissions × 4 / roles × 5 / role-permissions × 2 / user-roles × 3 / me-permissions × 1 / reload × 1)
- F3 `me/permissions` 返回字段 = `permissions: string[]` + `effectiveRoles: { code, displayName }[]`
- F4 reload scope = `all` / `user` / `role` 三种
- F5 judge 调用方式 = **Service 层显式 `rbac.can()`**,**不**做 `RbacGuard` 装饰器
- F6 seed 真实角色名走 `.env.seed.local`(R13)
- F7 `Role.code` 长度 = 3-32 字符
- F8 RBAC 缓存允许多 TTL(env 可调)
- F9 `rbac.can()` 仅在新增 V2 接口启用;v1 14 + V2 79 接口走 `users.policy.ts`(沿 A-2 红线)
- F10 PR 拆分 = 9 个 feat PR + 1 bump version + 1 docs 收口

### 1.3 已建立的基础设施(D7 v0.2 局部收口已落地)

- [`docs/srvf-foundation-baseline.md §1.1`](srvf-foundation-baseline.md):段位 `300xx + 301xx` `permissions`(C-6 RBAC)模块预留(附录 A v0.6)
- [`ARCHITECTURE.md §9`](../ARCHITECTURE.md):升级路径条目修订(去 `casl` + 加 4 表 + 自实现 `RbacService` + Service 层显式 `rbac.can()` + BizCode 段位 `300xx + 301xx` 链路)

---

## 二、立项内容(C-6 RBAC 实施范围)

### 2.1 RBAC 4 表模型(B1 / D4)

| 表 | 用途 | 软删策略 |
|---|---|---|
| `Role` | 业务角色定义(`code` / `displayName` / `description`)| 软删(`deletedAt`)|
| `Permission` | 权限点定义(`code` / `module` / `action` / `resourceType`)| 物理删(seed-driven;运营不主动删)|
| `RolePermission` | 角色 ↔ 权限点 多对多 | 物理删(撤权 = 物理删,沿 D11 audit 记录)|
| `UserRole` | 用户 ↔ 角色 多对多 | 物理删(沿 D13 disable 时 user_roles 不动)|

**沿用现有三层 `Role` enum**(`SUPER_ADMIN / ADMIN / USER`)**不变**(B2 / D12 / A-4 红线);RBAC 4 表作为业务级权限点;两层并存。

### 2.2 BizCode 段位(F1)

| 段位 | 用途 | 容量 |
|---|---|---|
| `300xx` | RBAC 模块通用错误(权限点 / 角色 / 关系不存在 / 重复 / 校验失败) | 100 |
| `301xx` | RBAC 权限 / 边界错误(无权配置 / 最后一个 ops-admin 保护 / 不可分配 / 不可删) | 100 |

**避开 `140xx + 141xx` audit_logs 已占用段位**(批次 6 v0.7.0 实装 `14001 / 14101`)。**中间留 `240xx-290xx`** 给未来未规划业务模块(训练 / 装备 / 财务 / 通知等)。

baseline §1.1 已同步追加(沿 [PR #50 D7 v0.2 局部收口](https://github.com/BA7IEE/srvf-nest-api/pull/50))。

### 2.3 共存模式(D12 / F9 / A-2)

- **`users.policy.ts` 永久共存**(沿 D12 永不切换):v1 §13 `assertCanManageUser` 等系统级身份判断保留
- **v1 14 + V2 79 既有接口零漂移**(沿 A-2 红线;OpenAPI contract snapshot CI 守护)
- **RBAC 仅作为新增 V2 业务接口的业务级补充**(沿 F9):新增 V2 接口在 Service 层入口调 `rbac.can()`;v1 14 + V2 79 接口仍按 `@Roles(...)` + `users.policy.ts` 工作

### 2.4 判权调用方式(F5)

- **Service 层显式 `rbac.can()`**:每个 controller 在 Service 层入口调 `await this.rbac.can(currentUser, action, resource)`
- **不**实现 `RbacGuard` 装饰器或 `@RbacRequired(...)` 装饰器形式
- 失败抛 `BizException(BizCode.RBAC_FORBIDDEN)`(`30100`)
- 理由(沿 D7 §8 头部):Service 层显式调用便于审计 / 调试 / 资源 owner 上下文构造;Guard 装饰器在装饰器作用域内难以注入资源对象

---

## 三、实施前置硬约束

### 3.1 不引入(沿 V1.1 §17.3 + D7 §3)

- ❌ **不引入 `casl`**(沿 D7 v0.2 ARCHITECTURE.md §9 修订;自实现 `RbacService`)
- ❌ **不引入 Redis**(限流仍内存 storage;RBAC 缓存仅进程内 short TTL)
- ❌ **不引入队列**(BullMQ / 任务队列任一)
- ❌ **不引入定时任务**(cron / `@nestjs/schedule` 任一)
- ❌ **不引入 OpenTelemetry / Sentry / APM**
- ❌ **不暴露 `/metrics` 端点**

### 3.2 不改 v1(沿 A-2 / A-4 红线)

- ❌ **不扩 Role enum**(`SUPER_ADMIN / ADMIN / USER` 三层永远不变;沿 A-4)
- ❌ **不改 v1 14 接口**(路径 / HTTP 方法 / 入参 DTO / 出参 DTO / 错误码 / 权限标注 / 响应包装 全部 zero drift;沿 A-2)
- ❌ **不改既有 V2 79 接口**(同 A-2)
- ❌ **不动 `users.policy.ts`**(沿 D12 永久共存)
- ❌ **不修改 `JwtStrategy.validate()` 查库逻辑**(沿 v1 §8)

### 3.3 启动顺序(沿 PR #45 决议 1)

- ❌ **C-7 attachments 必须等 C-6 上线后再进入 D7-attachments 评审**
- 沿 [`docs/批次7_attachments_业务确认稿.md §三 决议 1`](批次7_attachments_业务确认稿.md):C-6 RBAC 完整模型批次先行 → C-7 attachments 批次跟进
- attachments 的查看 / 上传权限走 RBAC(问题 6 / 7),attachments 启动前 RBAC 模型必须就绪,否则要承担"硬编码权限 → 后续迁移"的二次工程债

---

## 四、实施 PR 拆分(沿 D7 §16 + bump version + docs 收口)

| PR | 实际 PR # | 类型 | 主题 | squash commit | 状态 |
|---|---|---|---|---|---|
| **1** | **#54** | `chore(prisma)` | add RBAC schema and migration(`RbacRole` + `Permission` + `RolePermission` + `UserRole` 4 model + migration;v1.1 命名修订) | `88cb4d1` | ✅ 已合入 |
| 2 | #55 | `feat(permissions)` | Permission CRUD module(端点 1-4) | `6ff55b6` | ✅ 已合入 |
| 3 | #56 | `feat(permissions)` | RbacRole CRUD module(端点 5-9) | `edcb91e` | ✅ 已合入 |
| 4 | #57 | `feat(permissions)` | RolePermission assignment module and cache skeleton(端点 10-11) | `0d50c99` | ✅ 已合入 |
| 5 | #58 | `feat(permissions)` | UserRole CRUD module(端点 12-14;Q7 C2 中庸 + 最后一个 ops-admin 保护) | `affc1e8` | ✅ 已合入 |
| 6 | #59 | `feat(permissions)` | RbacService and me permissions endpoint(端点 15;`can` / `judge` / `checkOwnership` / `getMyPermissions` + `CurrentUserPayload.memberId`) | `46664c7` | ✅ 已合入 |
| 7 | #60 | `feat(permissions)` | RBAC reload endpoint(端点 16;3 档 scope) | `6de6f64` | ✅ 已合入 |
| 8 | #61 | `feat(permissions)` | RBAC seed/bootstrap(14 条 rbac.* + ops-admin + RolePermission 映射 + env/SUPER_ADMIN fallback) | `43db185` | ✅ 已合入 |
| **9** | **本 PR** | `docs(v2)` | **record C-6 RBAC implementation landing**(本 docs 收口 PR;沿 PR #35 / #37 / #39 / #41 收口范式) | — | 🔄 **本 PR** |
| 10 | 待启动 | `chore` | bump version 0.8.0 → 0.9.0(SemVer minor;新模块 + 新表 + 16 接口) | — | ⏳ 等用户授权 |
| 11 | 待启动 | `docs(v2)` | v0.9.0 handoff(类比 v0.8.0 / v0.8.1 handoff) | — | ⏳ 等用户授权 |

**实施周期**:实际 1 天(2026-05-14 PR #54 → #61 + 本 PR #9)— 远快于"参考 batch6 audit_logs 第二波 4 PR 落地节奏"的 2-3 周预估。

**新增依赖**:**0 个**(自实现 `RbacService`;`RbacCacheService` 用 `Map + setTimeout`-等价进程内 TTL,沿 D7 §9.1 / D6 v1.0 锁定;未引入 `node-cache` / `lru-cache`)。

**累计代码体量(PR #54-#61)**:`src/modules/permissions/` 14 个文件(controller / service / dto / select × N + cache + 共享 Rbac*)+ 1 个共用 prisma seed 拓展 + 6 个 e2e spec(`permissions` / `rbac-roles` / `role-permissions` / `user-roles` / `rbac-me-permissions` / `rbac-reload` / `seed-rbac`)+ 1 个 unit spec(`rbac.service.spec.ts`)+ contract snapshot 增量(16 端点 + 22 DTO)。

---

## 五、本立项 PR 边界

### 5.1 本 PR 做(仅文档 3 处)

- ✅ 新增本文件 [`docs/批次8_RBAC_V2x立项记录.md`](批次8_RBAC_V2x立项记录.md)
- ✅ TASKS.md 追加 §7 V2.x C-6 RBAC 立项准备(短摘要 + 链回本文件)
- ✅ CHANGELOG.md Unreleased 追加一行

### 5.2 本 PR 不做(全部沿 V2.x 立项 ≠ 实施 红线)

- ❌ **不动代码**:`src/**` / `prisma/**` / `test/**` 零触碰
- ❌ **不动 schema**:`prisma/schema.prisma` 不动,**不新增 migration**
- ❌ **不改 seed**:`prisma/seed.ts` 不动
- ❌ **不动依赖**:`package.json` / `pnpm-lock.yaml` 不动
- ❌ **不 bump version**:`package.json#version` 仍 `0.8.0` / Swagger `setVersion(...)` 仍 `0.8.0`
- ❌ **不打 tag** / **不发 GitHub Release**
- ❌ **不启动 RBAC 实施**(实施 PR #1 仍需单独启动 + 用户授权)
- ❌ **不改 baseline / ARCHITECTURE.md**(D7 v0.2 已修订,v1.0 沿用)
- ❌ **不改 V2 红线与复活路径**(C-6 / Slow-1 状态在实施 PR 上线后再更新)
- ❌ **不改 docs/handoff/v0.8.1.md**(沿 V2 红线 §5.1 历史 handoff 不回改)

---

## 六、合并后的下一步

### 6.1 PR #1-#8 已合入 main(2026-05-14)

**实施阶段 8 个 PR 全部合入**,详见 §四 PR 拆分表 squash commit / 状态列。基础能力(4 表 schema + 16 端点 + seed/bootstrap + RbacService + 缓存 + reload)全部就位;`v1 14 + V2 79` 既有接口 schema / paths **zero drift**(contract snapshot 增量仅新增 16 路由 + 22 DTO,既有段位无变化)。

### 6.2 本 PR #9 docs 收口范围

- ✅ 更新本立项记录:标记 PR #1-#8 已合入(§四)+ 状态头部更新(已落地;剩 docs/bump/handoff)
- ✅ 更新 [`CHANGELOG.md`](../CHANGELOG.md) Unreleased `### Added`:记录 PR #1-#8 累计 + 明确未做项
- ✅ 更新 [`docs/V2红线与复活路径.md`](V2红线与复活路径.md):C-6 行从 "5-A 留 5-B" 描述更新为 "基础能力已落地;业务模块判权接入留后续批次"
- ✅ 更新 [`TASKS.md §7`](../TASKS.md):立项准备状态 → 基础能力已落地

**本 PR docs-only 边界**:
- ❌ 不动 `src/**` / `prisma/**` / `test/**` / `package.json` / `pnpm-lock.yaml`
- ❌ 不 bump version(仍 0.8.0)/ 不 tag / 不 release
- ❌ 不启动 C-7 attachments / 不接入业务模块判权 / 不实装 dept-chief / 不 seed `attachment.*` / 不 seed `role-a..role-f`

### 6.3 下一步:PR #10 / #11(待用户授权)

| PR | 类型 | 主题 | 启动条件 |
|---|---|---|---|
| **PR #10** | `chore` | bump version 0.8.0 → 0.9.0(SemVer minor;新模块 + 新表 + 16 接口) | 本 PR #9 合入后,用户明确授权 |
| **PR #11** | `docs(v2)` | v0.9.0 handoff(类比 v0.8.0 / v0.8.1 handoff;13 章节范式 + 下一会话提示词) | PR #10 合入后,用户明确授权 |

**禁止**:未经用户授权,**不**启动 PR #10 bump 与 PR #11 handoff;**不**直接进入 C-7 attachments D7 评审稿。

### 6.4 仍待启动的业务模块判权接入(独立后续 PR)

- 14 个 RBAC CRUD 端点接入 `rbac.can()`(本 PR #1-#8 入口仍是 `@Roles(SUPER_ADMIN, ADMIN)`)
- 4 条 `attachment.*` Permission seed(D7 §10.2;留 C-7 attachments 启动时另行评审 Permission code 正则放宽 / 4 段 code 改 3 段)
- ADMIN 自动继承 USER 权限(D7 §7.1 / §8.2;需 seed 给 ADMIN 内置角色配 USER 级业务权限点)
- dept-chief / dept-deputy 部门层级判定(D7 §6.2 锁定层级表但本批次 seed 不实装)
- `role-a..role-f` 业务角色 placeholder seed(D7 §10.1;留 `.env.seed.local` 私有 seed 或运营后台创建)

以上**均不**在本 PR 范围;每项均需独立 PR + 用户明确授权后启动。

### 6.5 C-6 完整收口后启动 C-7 attachments

PR #9 / #10 / #11 全部合入 + v0.9.0 release 后,**才**启动 C-7 attachments D7 评审稿(沿 PR #45 决议 1);C-7 启动时第一件事是评审 D7 §10.2 `attachment.*` 4 段 code 命名 / Permission code 正则放宽决策。

---

## 七、风险与边界声明

### 7.1 立项 ≠ 实施

**本 PR 仅完成 V2.x 立项准备**;C-6 实施需单独 PR 推进。AI / 维护者**不得**在本 PR 合并后"顺手"启动实施 PR #1,必须等用户明确授权。

### 7.2 D7 v1.0 决议不可绕过

实施 PR 必须**严格遵循** D7 v1.0 冻结的 25 项决议(沿 [`docs/批次8_RBAC_API前评审.md §18`](批次8_RBAC_API前评审.md))。任何"实施时发现需要调整决议"的情况,必须**暂停 + 向用户说明**,不得擅自调整。如确需调整决议,需另起 D7 v1.x 修订 PR + 用户拍板,再启动实施。

### 7.3 不引入未登记新依赖

实施 PR 中如需引入新依赖(例如 `node-cache`),必须在对应 PR 任务卡中显式登记,沿 baseline `不得引入未在任务卡声明的新依赖` 纪律。

### 7.4 contract snapshot 守护

实施 PR 必须保证 v1 14 + V2 79 接口 schema + paths **zero drift**;新增 16 RBAC 接口加入 snapshot。任何 v1 / 既有 V2 接口字段变化视作 A-2 红线破口,**不可合并**。

### 7.5 段位预留 ≠ 段位实装

baseline §1.1 已预留 `300xx + 301xx`,但 14 个 BizCode **尚未实装**;实装由实施 PR 完成(主要在 PR #2-#8 各模块加 BizCode)。

---

## 八、参考引用

### 主要引用

- [`docs/批次8_RBAC_API前评审.md`](批次8_RBAC_API前评审.md):D7 v1.0 冻结稿(25 项决议、4 表 schema、16 端点、judge 函数、缓存、seed、audit 集成)
- [`docs/批次8_RBAC_业务确认稿.md`](批次8_RBAC_业务确认稿.md):D6 业务方 13 题拍板
- [`docs/批次8_RBAC_业务访谈提纲.md`](批次8_RBAC_业务访谈提纲.md):访谈提纲
- [`docs/批次7_attachments_业务确认稿.md`](批次7_attachments_业务确认稿.md):C-6 → C-7 启动顺序来源(§三 决议 1)

### 红线 / 复活路径

- [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) **A-2**:v1 14 + V2 79 接口 zero drift
- [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) **A-4**:不扩 Role enum
- [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) **C-6 / Slow-1**:APD 部门部长 / 副部长权限细分(本立项启动)

### 基线 / 段位

- [`docs/srvf-foundation-baseline.md §1.1`](srvf-foundation-baseline.md):BizCode 段位 `300xx + 301xx` permissions(C-6 RBAC)模块预留(附录 A v0.6)

### 升级路径 / 架构

- [`ARCHITECTURE.md §9`](../ARCHITECTURE.md):升级路径(C-6 RBAC 条目;沿 D7 v0.2 已修订)
- [`ARCHITECTURE.md §12.11.2`](../ARCHITECTURE.md):V2.x 复活路径

### 阶段交接

- [`docs/handoff/v0.8.1.md`](handoff/v0.8.1.md):v0.8.0 后 V2 设计文档阶段交接(本立项的触发源)
- [`docs/handoff/v0.8.0.md`](handoff/v0.8.0.md):audit_logs 第二波收官(C-6 排在其后)

---

## 九、撰写元信息

- **状态标签**:V2.x 立项准备(等用户授权启动实施 PR #1)
- **commit message**:`docs(v2-design): start C-6 RBAC V2.x implementation track`
- **PR 标题**:同 commit message
- **未做项**(本 PR 边界):
  - 不动 `src/**` / `prisma/**` / `test/**` / `package.json` / `pnpm-lock.yaml`
  - 不新增 migration
  - 不改 seed
  - 不 bump version / 不打 tag / 不发 Release
  - **不启动 RBAC 实施**
- **本 PR 修订范围**(3 处文档):
  - 新增本文件 `docs/批次8_RBAC_V2x立项记录.md`
  - `TASKS.md` 追加 §7 V2.x C-6 RBAC 立项准备(短摘要 + 链回本文件)
  - `CHANGELOG.md` Unreleased 追加一行
- **撰写者签名**:Claude Code(基于 D7 v1.0 冻结 PR #51 b301da8 + 用户立项指令;**未动任何代码 / schema / migration**)
