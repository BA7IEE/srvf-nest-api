# API Surface Policy

> **目的**:锁定 SRVF API 当前对外提供的 surface(客户端面)分类与新增规则。
> **配套文档**:[`current-state.md`](./current-state.md)(当前事实)。设计期顶层规范 `api-client-boundary.md` 已归档至 [`docs/archive/plans/api-client-boundary-design-period.md`](./archive/plans/api-client-boundary-design-period.md);本文件已承接为 surface 边界的 active 单一权威源。
> ⚠️ **2026-06-01 方向变更(Route B)**:用户拍板重开 [`AGENTS.md §19.7 D-2`](../AGENTS.md) 的"方案 C(`/api/v2/*` 长期保留)",改为**按客户端/场景四分的全量物理迁移**,并已于 **2026-06-01 全部完成**(见本文件 §0 + [`api-surface-migration-plan.md`](api-surface-migration-plan.md) + [`AGENTS.md §21 D-9`](../AGENTS.md))。**自该日起,本文件 §1 ~ §3 + §7 P1-D + §8 中一切关于"冻结 v2 / 不迁移 / Phase 1B 暂缓 / 不动 controller path / 新接口默认落 v2"的条款,均被本 §0 + Route B 取代,仅作迁移前历史口径保留**(其中 §1 表整体为迁移前现状快照)。§4 / §9(归档关系 / App·System semantic locks)继续有效;§5 / §6(Mixed Controller 存量 / mobile-like 处置矩阵)所列存量已被 **Route B Phase 4 全量删除**(见各节顶部终态注记),正文表格仅留作迁移前记录。

---

## 0. API Surface 终态形态(Route B;2026-06-01 完成)

> 本节是 surface 长期边界的 **canonical 权威源**,取代原"方案 C 冻结"口径。执行细节见 [`api-surface-migration-plan.md`](api-surface-migration-plan.md);决策锁见 [`AGENTS.md §21 D-9`](../AGENTS.md)(取代 §19.7 D-2)。

| Surface | 目标前缀 | 用途 |
|---|---|---|
| **Admin** | `/api/admin/v1/*` | 管理后台 / 运维后台业务(现 `/api/v2/*` 业务 CRUD + `/api/users/*`) |
| **App** | `/api/app/v1/*` | App / 小程序 / 队员端(**已建成 15 endpoint,不迁移**) |
| **Auth** | `/api/auth/v1/*` | 登录 / 刷新 / 登出 / 认证会话(现 `/api/auth/*`) |
| **System** | `/api/system/v1/*` | 健康检查 / 运行状态 / 系统元信息 / ops 配置(现 `/api/health/*` + 现 `/api/v2/*` 中 ops/配置/可观测类;承接 D-1 `contribution-rules` → System) |
| **Open** | `/api/open/v1/*` | **首用(2026-06-18 招新一期 T3)**:无账号公开 surface(`@Public` 跳过 JwtAuthGuard;首落地 = 招新报名提交/查询,小程序自助直连);**2026-06-21 CMS 第二用** = 内容公开列表/详情(`open/v1/contents`,published+public,第 10 throttler `content-public`);未来开放平台扩展仍按需 D 档立项 |

**新增规则(自 2026-06-01 生效,覆盖 §2.1 / §2.2 的"新接口落 v2"口径)**:

- ✅ **新接口一律落新前缀**:新管理面 → `/api/admin/v1/*`;新 App → `/api/app/v1/*`;新认证 → `/api/auth/v1/*`;新 ops/系统 → `/api/system/v1/*`。**不再向 `/api/v2/*` 新增任何 endpoint**。
- ✅ 存量 `/api/v2/*` / `/api/auth/*` / `/api/users/*` / `/api/health/*` 已按 [`api-surface-migration-plan.md §6`](api-surface-migration-plan.md) 全部迁移并删除(**2026-06-01 完成**,终态由 contract 前缀断言锁定:**2026-06-01 = 4 canonical 前缀**;**2026-06-18 招新一期 T3 首用 `open/v1` → 5 canonical 前缀**,见 [`test/contract/openapi.contract-spec.ts`](../test/contract/openapi.contract-spec.ts) + [`scripts/check-rbac-map.ts`](../scripts/check-rbac-map.ts) 的 `CANONICAL_PREFIXES`);此后任何 surface / path 变更仍需 **D 档、单独立项**。
- ✅ App / Admin / System / Auth / Open surface 间 **DTO 不得复用或派生**(沿 §2.1 / D-6);五 surface 物理分离(`open/v1` 公开出参为独立 class,不派生自 admin/app DTO)。
- ✅ audit-logs / storage / RBAC 系 / dictionaries / attachment-configs 的 admin↔system 灰区归属**已由迁移计划 Phase 0 映射表(经用户签字)冻结**(见 [`api-surface-migration-plan.md §3`](api-surface-migration-plan.md);均落 System surface `/api/system/v1/*`);**不**在常规 PR 内擅自重归类。

---

## 1. 当前 surface 分类(迁移前现状快照)

| Surface | 当前路径前缀 | 状态 | 用途 |
|---|---|---|---|
| **Mobile App** | `/api/app/v1/*` | 新增唯一入口 | 移动端(队员视角)接口;面向 App / 小程序 / Mobile Web |
| **Admin Legacy** | `/api/v2/*` | 长期保留,不强制迁移 | PC 管理后台接口;v0.13.0 起按此前缀落地的 V2 业务接口集合 |
| **Root Legacy** | `/api/auth/*` / `/api/users/*` / `/api/health/*` | 兼容入口长期保留 | v1 阶段已锁定的 14 路由及 P0-D / P0-E 在 `/api/users/me/*` / `/api/auth/*` 下的扩展 |
| **Public / Auth** | 当前与 Root Legacy 重合(无独立前缀) | Phase 1B path alias 暂缓 | `/api/auth/login` / `/api/auth/refresh` / `/api/auth/logout` / `/api/auth/logout-all` / `/api/health/*` |

具体每个 endpoint 的归属与 Swagger Tag(`App` / `Admin` / `System` / `Public` × module)分类,沿 v0.15.0 Phase 1A 重命名后的状态;细节查 `/api/docs` 与 `docs/current-state.md`。

---

## 2. 新增规则(长期生效)

### 2.1 移动端

- ✅ 新移动端接口**只能**落在 `/api/app/v1/*`,且必须新建独立的 Mobile Controller(允许文件位于 `src/modules/<module>/controllers/app-*.controller.ts`)
- ✅ 新移动端 DTO **必须**独立定义在 `src/modules/<module>/dto/app/` 子目录,**禁止** `extends` / `Pick` / `Omit` / `IntersectionType` / `PartialType` / `OmitType` 一个 Admin DTO 构造 App DTO
- ✅ App API where 子句永远使用 `currentUser.memberId` 锁定本人(`scope = self`);**禁止**用 `role` 短路决定数据范围
- ❌ App API **永远不返回** L3 凭证字段:`passwordHash` / `refreshToken` / `tokenHash` / `secretKey*` / `secretId*` / 完整 signed URL
- ❌ 不在 Admin / System / Public controller 内新增 Mobile-only 方法
- ❌ **不再新增 "Mixed Controller"**(class-level `@ApiTags('Admin - X')` 同时在方法级追加 `@ApiTags('Mobile - X')`);已存在的(如 `users.controller.ts` 中 `/me` 三端点)作为**历史存量**保留,不再扩展

### 2.2 管理面

- ✅ 新 PC 管理后台接口默认落在 `/api/v2/*`(沿现状;短期内不再新建别的管理前缀)
- ✅ 管理面 DTO 与移动端 DTO **物理分离**,即使字段集相同,也不共用 class
- ❌ 不在管理面接口中夹带"顺手满足 Mobile"的字段语义

### 2.3 兼容入口

- ✅ `/api/auth/*` / `/api/users/*` / `/api/health/*` 保留作为 Root Legacy,**不强制迁移**到任何带版本号的前缀
- ✅ 已存在的"双端点"模式(如 `PUT /api/users/me/password` 与 `PUT /api/app/v1/me/password` 共存)**只维护兼容、不扩展新字段**;两端点共享同一 service 与同一 DTO 的现状沿用,未来如要拆分,**必须单独立项**

### 2.4 迁移与别名

- ✅ 若需迁移旧 endpoint(例如 `/api/auth/login` → `/api/auth/v1/login`),**必须单独立项**(C/D 档评审稿 + 双写 alias + 灰度切流 + 旧 endpoint deprecated 公告)
- ❌ **不**在常规 PR 中"顺手"添加路径别名
- ❌ **不**在常规 PR 中"顺手" deprecate 现有 endpoint

---

## 3. 本 policy 不主动改的范围(长期生效)

> 本节适用于**任何引用本 policy 的常规 PR**(包括 docs-only / 代码 PR);若需突破任一项,**必须单独立项**。

- ❌ **不改** controller path(任何 `@Controller(...)` 字符串)
- ❌ **不删** `/api/v2/*` 任何 endpoint
- ❌ **不改** `/api/auth/*` / `/api/users/*` / `/api/health/*` 根路径
- ❌ **不改** OpenAPI snapshot 或任何 contract 测试
- ❌ **不改**前端联调口径
- ❌ **不改** E2E / unit 测试
- ❌ **不启动** Phase 1B path alias(`/api/auth/v1/*` + `/api/public/v1/*`;沿 §7 P1-D)
- ❌ **不**物理拆分已存在的 Mixed Controller(沿 §7 P1-C 顺序)

---

## 4. 与设计期归档文档的关系

- `api-surface-policy.md`(本文件):**surface 边界的 active 单一权威源** — 长期生效的新增 / 扩展铁律,无须依赖任何具体 Phase 评审稿即可独立适用
- 原设计期顶层规范 `docs/api-client-boundary.md` 已于 PR-3 归档至 [`docs/archive/plans/api-client-boundary-design-period.md`](./archive/plans/api-client-boundary-design-period.md)("Surface × Module × Resource" 三元组分类原则、Phase 0/1 设计意图、Phase 1A Swagger Tag 改名结论的历史快照)
- 配套设计期评审稿(`api-client-boundary-inventory.md` / `-migration-plan.md` / `-phase-1-review.md`)同期归档于 [`archive/reviews/`](./archive/reviews/) 与 [`archive/plans/`](./archive/plans/),作为历史证据保留

冲突时:**本文件 > 归档设计期文档 / 评审稿**;**当前事实(`current-state.md`) > 本文件**(若现状已超出本文件锁定的边界,先以 current-state 描述为准并升级本文件)。

---

## 5. 历史 Mixed Controller 存量清单(2026-05-21 P1-A 决策锁补齐)

> **铁律**:Mixed Controller **不再新增**(沿 §2.1 末项)。以下为 v0.15.0 之前已经落地的存量例外,**只维护、不扩展、不复制范式**;以上为存量例外清单,**不代表允许新增同类模式**。
>
> 实际盘点共 6 处(2026-05-21 P1 只读评审落地;前 3 处在 PR #165 时已登记,后 3 处由 P1-A 决策锁补登)。"surface Mixed"指单文件同时承载多个 surface;"same-file multi-controller, same surface"仅是文件结构问题、不构成 surface 混合。

> ✅ **Route B 终态注记(2026-06-01)**:下表 6 项中,P1-C 拆出的 4 个 `controllers/*-legacy.controller.ts`(users / attachments / activity-registrations / attendances)已于 **Phase 4 删除**,队员自助流统一在 App surface(`controllers/app-me.controller.ts` / `controllers/app-my-*.controller.ts`);仅 `permissions/rbac.controller.ts` `me/permissions`(现 `@Controller('system/v1/rbac')`)仍 method-level Mixed,**按 §9.4 / D-5.3 保留**;`dictionaries.controller.ts`(现 `system/v1/dict-*`)为非 surface Mixed。下表为**迁移前 P1-A 存量快照**,路径前缀与"未来 deprecate 候选 / 本阶段不删"等处置均为当时口径,仅留作历史。

### 5.1 Mixed Controller 存量(6 项;迁移前 P1-A 快照)

| # | 文件 | 类型 | 现状 | 涉及端点 | 处置 |
|---|---|---|---|---|---|
| 1 | [`src/modules/users/users.controller.ts`](../src/modules/users/users.controller.ts) | ~~method-level Mixed~~ → **P1-C step 1 已拆**(2026-05;详 §7) | 主 controller 当前仅 class-level `@ApiTags('Admin - Users')` + `@Controller('users')`(8 个 `/:id*` 管理端点);原 3 个 `/me*` 端点已迁出至独立 `users-me-legacy.controller.ts`(同 `@Controller('users')` 前缀 + Tag `Mobile - Me`) | `GET /api/users/me` / `PATCH /api/users/me` / `PUT /api/users/me/password` | endpoint zero drift;主 controller 不再 surface Mixed;legacy 只兼容、不扩展 |
| 2 | [`src/modules/attendances/attendances.controller.ts`](../src/modules/attendances/attendances.controller.ts) | ~~same-file Mixed~~ → **P1-C step 4 已拆**(2026-05;详 §7) | 主 controller 仅剩 2 个 Admin class(`v2/activities/:activityId/attendance-sheets` + `v2/attendance-sheets`,Tag `Admin - Attendances`);原同文件 Mobile class `AttendanceRecordsMeController`(`v2/users/me/attendance-records`,1 路由,Tag `Mobile - Attendance`)已迁出至 `attendances-me-records-legacy.controller.ts` | `GET /api/v2/users/me/attendance-records` | endpoint zero drift;主 controller 不再 surface Mixed;已有 `/api/app/v1/my/attendance-records` 对等(P2-6);legacy 未来 deprecate 候选,本阶段不删;`attendances.service.ts` 1157 LOC 拆 service 仍需单独立项 |
| 3 | [`src/modules/activity-registrations/activity-registrations.controller.ts`](../src/modules/activity-registrations/activity-registrations.controller.ts) | ~~same-file Mixed~~ → **P1-C step 3 已拆**(2026-05;详 §7) | 主 controller 仅剩 Admin class(`v2/activities/:activityId/registrations`,Tag `Admin - Registrations`);原同文件 Mobile class(`v2/users/me`,4 路由)已迁出至 `activity-registrations-me-legacy.controller.ts`(Tag `Mobile - Registrations`) | `POST /api/v2/users/me/activities/:activityId/registration` / `GET /api/v2/users/me/registrations` | endpoint zero drift;主 controller 不再 surface Mixed;已有 `/api/app/v1/my/registrations` 对等(P2-5);legacy 未来 deprecate 候选,本阶段不删 |
| 4 | [`src/modules/attachments/attachments.controller.ts`](../src/modules/attachments/attachments.controller.ts) | ~~method-level Mixed~~ → **P1-C step 2 已拆**(2026-05;详 §7) | 主 controller 当前仅 class-level `@ApiTags('Admin - Attachments')` + `@Controller('v2/attachments')`(8 个 admin 端点);原 `me/uploaded` 单方法已迁出至 `attachments-me-legacy.controller.ts`(同 `@Controller('v2/attachments')` 前缀 + Tag `Mobile - Attachments`) | `GET /api/v2/attachments/me/uploaded` | endpoint zero drift;主 controller 不再 surface Mixed;**仍无 `/api/app/v1/my/attachments` 对等端点**,legacy 只兼容、不扩展 |
| 5 | [`src/modules/permissions/rbac.controller.ts`](../src/modules/permissions/rbac.controller.ts) | **method-level Mixed**(P1-A 补登) | class-level `@ApiTags('Ops - RBAC')` + `@Controller('v2/rbac')`,内含 1 个方法 `me/permissions` 追加 `@ApiTags('Mobile - Capabilities')` | `GET /api/v2/rbac/me/permissions` | **必须保留**;与 `/api/app/v1/me/capabilities` **语义不等价**(`me/permissions` 返 raw RBAC permission code,`me/capabilities` 返 product-level capability;沿 D-5.3);**不作为近期拆分目标** |
| 6 | [`src/modules/dictionaries/dictionaries.controller.ts`](../src/modules/dictionaries/dictionaries.controller.ts) | **same-file multi-controller, same surface**(P1-A 修正:非 surface Mixed) | 同文件 2 个 `@Controller` class:`v2/dict-types` + `v2/dict-items`,**两者 Tag 均为 `Ops - Dictionaries`** | (Ops 后台字典 CRUD) | **不是 surface 混合**,仅文件结构问题;低风险,**暂不拆**;不属于 P1-C 范围 |

### 5.2 与 PR #165 初版登记的差异

- PR #165 初版 §5 登记 3 项:`users.controller.ts` / `activity-registrations.controller.ts` / `dictionaries.controller.ts`
- 2026-05-21 P1 只读评审发现实际存量为 6 项;P1-A 决策锁补登 3 项:`attendances.controller.ts` / `attachments.controller.ts` / `rbac.controller.ts`
- 同时修正 `dictionaries.controller.ts` 的分类:**不是 surface Mixed**,只是同 surface 同文件双 class
- **截至 2026-05-26**:6 项中 `users.controller.ts` / `attachments.controller.ts` / `activity-registrations.controller.ts` / `attendances.controller.ts` 四项已完成 P1-C step 1/2/3/4 物理拆分(legacy controller 迁出至独立文件,主 controller 不再 surface Mixed,endpoint 全部 zero drift;`attendances` 拆分见 PR #236,merge commit `bfb93b9`);实际仍为 surface Mixed 的存量降至 **rbac.controller.ts**(P1-A 决策暂不拆);**dictionaries.controller.ts** 仍按非 surface Mixed 保留

---

## 6. 历史 mobile-like endpoint 处置矩阵(2026-05-21 P1-A 决策锁)

> ✅ **Route B 终态注记(2026-06-01)**:下表 8 个 mobile-like endpoint 中,**7 个 v2 / Root-legacy 端点已于 Phase 4 删除**(`/api/users/me*` 三项、`/api/v2/users/me/*` registrations + attendance-records、`/api/v2/attachments/me/uploaded`);其 App 对等端点(`/api/app/v1/me*` / `/api/app/v1/my/*`)为 canonical。唯一保留的是 `GET /api/system/v1/rbac/me/permissions`(原 `/api/v2/rbac/me/permissions`;与 `/api/app/v1/me/capabilities` 语义不等价,沿 §9.4 / D-5.3 **不 deprecate**)。下表为**迁移前 P1-A 处置矩阵快照**,"全部保留 / 未来 deprecate 候选"为当时口径,仅留作历史。

| # | Endpoint | Current surface | App `/api/app/v1/*` equivalent | Decision |
|---|---|---|---|---|
| 1 | `GET /api/users/me` | Root Legacy `users` | ✅ `GET /api/app/v1/me`(返回 `AppMeResponseDto` + `canUseApp`;字段集不等价但语义对等) | **只兼容,不扩展**(沿 §2.3) |
| 2 | `PATCH /api/users/me` | Root Legacy `users` | ✅ `PATCH /api/app/v1/me/profile`(白名单 `nickname` + `avatarKey`) | **只兼容,不扩展** |
| 3 | `PUT /api/users/me/password` | Root Legacy `users` | ✅ `PUT /api/app/v1/me/password`(共享同 throttler / 同 service / 同 DTO) | **只兼容,不扩展**;两端点共享 service 与 DTO 现状沿用 |
| 4 | `POST /api/v2/users/me/activities/:activityId/registration` | Admin Legacy(内 Mobile class) | ✅ `POST /api/app/v1/my/registrations`(P2-5b) | **已有 app/v1 对等,未来 deprecate 候选**;本阶段不删 |
| 5 | `GET /api/v2/users/me/registrations` | Admin Legacy(内 Mobile class) | ✅ `GET /api/app/v1/my/registrations`(P2-5a) | **已有 app/v1 对等,未来 deprecate 候选**;本阶段不删 |
| 6 | `GET /api/v2/users/me/attendance-records` | Admin Legacy(已物理迁出至独立 `attendances-me-records-legacy.controller.ts`;P1-C step 4 已拆,PR #236) | ✅ `GET /api/app/v1/my/attendance-records`(P2-6) | **已有 app/v1 对等,未来 deprecate 候选**;characterization tests 已落地(沿 §7 P1-B);本阶段不删 |
| 7 | `GET /api/v2/rbac/me/permissions` | Ops(method-level Mobile) | ⚠️ **不等价**:`/api/app/v1/me/capabilities` 返 product-level capability,不返 raw RBAC permission code(沿 D-5.3 故意) | **必须保留**;PC 管理后台还要靠它显示按钮可见性;**不 deprecate** |
| 8 | `GET /api/v2/attachments/me/uploaded` | Admin Legacy(method-level Mobile) | ❌ 无 `/api/app/v1/my/attachments` 对应端点 | **保留**;未来可单独立项新建 `/api/app/v1/my/attachments` 与现 endpoint 并存;本阶段不删 |

**铁律**:
- 上述 8 个 endpoint **全部保留**,常规 PR **不得**删除、deprecate 标记、或改变 path
- 任何 deprecate 操作必须**单独立项**(沿 §2.4 迁移与别名规则)
- "已有 app/v1 对等"不等于"可立即删除旧端点",必须先满足:① 前端 / 移动端确认已切流;② OpenAPI snapshot 双路径覆盖期 ≥ 2 release;③ 单独 deprecated 公告

---

## 7. P1 执行计划(2026-05-21 P1-A 决策锁)

> P1 = API surface / Mixed Controller 治理。分 4 个子阶段,**严格串行**,每阶段单独立项 + 单独 PR。

### P1-A:docs-only 决策锁(本 PR)

- ✅ 补齐 Mixed Controller 存量清单 6 项(沿 §5)
- ✅ 锁定 mobile-like endpoint 处置矩阵 8 项(沿 §6)
- ✅ 锁定 P1-B / C / D 执行顺序与禁止事项(沿本节 + §8)
- ✅ Phase 1B path alias **维持暂缓**(沿 §7 P1-D)
- ✅ 第一优先 Mixed Controller 拆分目标 = [`users.controller.ts`](../src/modules/users/users.controller.ts)(沿 §7 P1-C)
- ❌ **不改任何代码**

### P1-B:characterization tests / contract guard

> 在拆任何 Mixed Controller 或 god-service **之前**,先补 e2e + contract snapshot 锁定现有行为。

覆盖范围(必须):

- `GET /api/users/me` / `PATCH /api/users/me` / `PUT /api/users/me/password`(沿 §5 项 1)
- `GET /api/v2/users/me/attendance-records`(沿 §5 项 2 / §6 项 6;**拆 attendances controller 前的硬前置**)
- `GET /api/v2/attachments/me/uploaded`(沿 §5 项 4 / §6 项 8)
- `GET /api/v2/rbac/me/permissions`(沿 §5 项 5 / §6 项 7;保留前的回归保护)
- `GET /api/app/v1/me/profile` / `PATCH /api/app/v1/me/profile`(对比锚点)

检测点:HTTP status / response shape / role guard / throttler / audit log 字段
**不改任何 controller / service / DTO 行为**;仅添加 spec。

**当前状态(2026-05-26 回填)**:characterization tests 已经覆盖 attendances / activities / activity-registrations / attachments 4 个 god-service(沿 #196 / #199 / #202 / #203 系列 PR 合入;详 [`docs/current-state.md §1`](current-state.md) 与 [`architecture-boundary.md §5`](architecture-boundary.md));attendances controller 物理拆分硬前置已满足且 P1-C step 4 已落地(PR #236,merge commit `bfb93b9`);attendances service 拆分硬前置同样已满足,但 service 行为本身仍需单独立项。剩余 §5 项 1 / 4 / 5 端点的额外 characterization spec 可按需补,**不作为本节策略变更**。

### P1-C:Mixed Controller physical split(逐 PR 串行)

拆分顺序(从低风险到高风险);截至 2026-05-26 回填,step 1/2/3/4 已完成,step 5/6 仍按 P1-A 暂不拆:

1. ✅ **P1-C step 1 已完成**:[`src/modules/users/users.controller.ts`](../src/modules/users/users.controller.ts) — 3 个 `/me*` 方法物理迁出至 `users-me-legacy.controller.ts`;`users.service.ts` 544 LOC,风险可控;endpoint zero drift
2. ✅ **P1-C step 2 已完成**:[`src/modules/attachments/attachments.controller.ts`](../src/modules/attachments/attachments.controller.ts) — `me/uploaded` 单方法迁出至 `attachments-me-legacy.controller.ts`;endpoint zero drift
3. ✅ **P1-C step 3 已完成**:[`src/modules/activity-registrations/activity-registrations.controller.ts`](../src/modules/activity-registrations/activity-registrations.controller.ts) — 同文件 Mobile class 迁出至 `activity-registrations-me-legacy.controller.ts`;endpoint zero drift
4. ✅ **P1-C step 4 已完成**(PR #236,merge commit `bfb93b9`):[`src/modules/attendances/attendances.controller.ts`](../src/modules/attendances/attendances.controller.ts) — 原同文件 Mobile class `AttendanceRecordsMeController` 已迁出至 `attendances-me-records-legacy.controller.ts`;主 controller 仅剩 2 个 Admin class;path / method / tag / roles / DTO / service call / operationId 全部 zero drift,OpenAPI snapshot zero drift;[`attendances.service.ts`](../src/modules/attendances/attendances.service.ts) 1157 LOC 拆 service 行为本身仍需单独立项
5. **暂不拆**:[`src/modules/permissions/rbac.controller.ts`](../src/modules/permissions/rbac.controller.ts) — `me/permissions` 语义独特(双端共用),拆分性价比低
6. **暂不拆**:[`src/modules/dictionaries/dictionaries.controller.ts`](../src/modules/dictionaries/dictionaries.controller.ts) — 同 surface 双 class,风险低,拆分性价比低

每个 P1-C 拆分 PR 的硬约束(沿 §8):**不改任何 endpoint path / DTO / Guard / RBAC / OpenAPI;仅文件物理拆分 + 必要的 module 注册更新**。

### P1-D:Phase 1B path alias

- **暂缓**,不在 P1 范围内启动
- **不启动** `/api/auth/v1/*` / `/api/public/v1/*` / `/api/users/v1/*`
- 等 P1-C Mixed Controller 拆分完成 **且** 真实客户端诉求(前端 / 移动端 / 运维侧)触发后,**单独立项评审**

---

## 8. P1 禁止事项(2026-05-21 P1-A 决策锁)

> 适用于**所有 P1-A / P1-B / P1-C 子阶段的 PR**;违反任一项视作越权,必须暂停说明。

- ❌ **不改任何 endpoint path**(任何 `@Controller(...)` 字符串与方法装饰器 path)
- ❌ **不删除任何旧 endpoint**(包括 §6 表中标记"未来 deprecate 候选"的 6 个 endpoint)
- ❌ **不改任何 DTO 字段**(增 / 删 / 重命名 / 类型变更全部禁止)
- ❌ **不改任何 BizCode**(段位 / 编号 / message / httpStatus 全部禁止)
- ❌ **不改任何 Guard / Roles / RBAC / @Public / 限流装饰器**
- ❌ **不重排 Swagger Tag 体系**(沿 v0.15.0 Phase 1A 命名)
- ❌ **不启动 Phase 1B path alias**(沿 §7 P1-D)
- ❌ **不引入 repository 抽象层**
- ❌ **不拆 god-service 业务逻辑**([`attendances.service.ts`](../src/modules/attendances/attendances.service.ts) 1157 LOC / [`attachments.service.ts`](../src/modules/attachments/attachments.service.ts) 826 LOC / [`activity-registrations.service.ts`](../src/modules/activity-registrations/activity-registrations.service.ts) 750 LOC / [`activities.service.ts`](../src/modules/activities/activities.service.ts) 607 LOC 行为零变更;LOC 数为 2026-05-23 实测,已计入 state-machine + audit-recorder 抽离后的余量)
- ❌ **P1-C step 4 已完成(PR #236)后不得顺手 deprecate `/api/v2/users/me/attendance-records` / 改 [`attendances.service.ts`](../src/modules/attendances/attendances.service.ts) / 改 DTO / 改 OpenAPI snapshot / 启动 Phase 1B alias**(沿 §7 P1-C 项 4 / §7 P1-D / §6 项 6;若需推进必须单独立项)
- ❌ **不改 OpenAPI snapshot / contract 测试期望值**(P1-C 拆分必须保证 snapshot zero drift)
- ❌ **不改任何 audit log 事件命名 / 字段**

---

## 9. App / System surface semantic locks

> 本节把 `AGENTS.md §19.7` 中与 API surface 相关的 D-series 决策正式承接到本 active policy。
> `AGENTS.md §19.7` 仍是 decision-lock record(出处 / 拍板时间 / 不再重开讨论);本节是 execution policy(常规 PR 直接引用)。
> 冲突时:沿 §4 现有规则,`AGENTS.md §19.7` > 本节;本节 > 归档评审稿。

### 9.1 contribution-rules belongs to the System / Ops surface

- `contribution-rules` is a participation-context configuration / rule resource, not a normal Admin business CRUD resource.
- Current implementation is under `/api/system/v1/contribution-rules` with an Ops-oriented Swagger tag (`Ops - Contribution Rules`)(Route B 已落 System surface).
- The surface stays System / Ops (`/api/system/v1/contribution-rules/*`,承接 D-1);**不得**改归 Admin / App / Public。
- Normal ADMIN users may be authorized through `contribution-rule.*` permission codes, but that does not change the surface classification.
- 常规 PR **不得**把 `contribution-rules` 重新归 Admin / App / Public 任一其他 surface;若需重开,必须单独立项并先回到 `AGENTS.md §19.7 D-1`。
- This section executes `AGENTS.md §19.7 D-1`.

### 9.2 App access requires a linked active member

- Candidate users and temporary-number users are outside the current App login scope.
- App access requires:
  - `User.memberId != null`
  - `User.status = ACTIVE`
  - `User.deletedAt IS NULL`
  - linked `Member.status = ACTIVE`
- ADMIN / SUPER_ADMIN accounts without a linked member remain backend accounts only; they do not automatically get an App self perspective.
- `canUseApp = false` means the identity / member binding does not satisfy App access requirements; it is **not** a substitute for endpoint authorization — backend write endpoints must still re-check RBAC / service-level guards regardless of `canUseApp` value.
- 新增任何接受 candidate / temporary-number 进入 App 的能力,**必须**单独立项并先回到 `AGENTS.md §19.7 D-5.1 / D-5.2`。
- This section executes `AGENTS.md §19.7 D-5.1 / D-5.2`.

### 9.3 Admin-as-member uses linked-member self perspective

- When an ADMIN / SUPER_ADMIN account has a linked member (`User.memberId != null`), the App surface only exposes the linked member's self perspective.
- Backend role (ADMIN / SUPER_ADMIN) **does not** expand AppSelf field visibility — App responses are field-identical to a regular USER linked-member would see.
- App endpoints must still apply `scope = self` semantics (沿 §2.1 `currentUser.memberId` 锁定本人) and must not infer broader data access from backend role.
- 任何 App endpoint 出现 `if (role === ADMIN) { 返回扩展字段 / 扩展数据范围 }` 之类的分支视作越权,**必须**回退并回到 `AGENTS.md §19.7 D-5.2`。
- This section executes `AGENTS.md §19.7 D-5.2`.

### 9.4 capability is not raw RBAC permission

- `/api/app/v1/me/capabilities` returns **product-level** capabilities (e.g. `canUseApp` / `canRegisterActivity`) for App UX and entry control.
- It must **not** expose raw RBAC permission codes.
- `/api/system/v1/rbac/me/permissions` remains the backend / PC / raw permission-code view; the two endpoints are **semantically not equivalent** and must not be merged or deprecated against each other (沿 §5.1 项 5 与 §6 项 7)。
- Capabilities are **not** authorization proof — every write endpoint must still perform backend authorization through RBAC and / or service-level checks.
- **禁止**把 `/api/app/v1/me/capabilities` 改回返回 raw RBAC permission code,或在 App surface 新增任何返回 raw permission code 的端点;若需重开,必须单独立项并先回到 `AGENTS.md §19.7 D-5.3`。
- This section executes `AGENTS.md §19.7 D-5.3`.

### 9.5 `/me/*` and `/my/*` are physically separated

- `/me/*` is for **identity / account / profile / capability** resources(身份与账号本体)。
- `/my/*` is for **business records owned by the current linked member**(本人持有的业务记录)。
- New App endpoints must choose `/me` or `/my` before implementation; **do not mix** identity resources and owned business records under one path family。
- Current examples(沿 v0.15.0 Phase 2 P2-0 ~ P2-7 落地):
  - `/api/app/v1/me`
  - `/api/app/v1/me/account`
  - `/api/app/v1/me/profile`
  - `/api/app/v1/me/password`
  - `/api/app/v1/me/capabilities`
  - `/api/admin/v1/me`(**Admin surface** 本人身份只读 bootstrap,2026-06-14;`/me = 身份` 原则跨 surface 适用——管理后台登录后取本人昵称/头像/角色。**只读**,不内联角色/权限——权限走 `/api/system/v1/rbac/me/permissions`〔§9.4〕;与 App `/me` **物理隔离、DTO 不派生**〔§2.1〕)
  - `/api/app/v1/my/activities`
  - `/api/app/v1/my/registrations`
  - `/api/app/v1/my/attendance-records`
  - `/api/app/v1/my/certificates`
- 新增 `/api/app/v1/me/<owned-business-record>` 或 `/api/app/v1/my/<identity-or-capability>` 这种语义错配的路径视作越权,**必须**回退并回到 `AGENTS.md §19.7 D-5.4`。
- This section executes `AGENTS.md §19.7 D-5.4`.
