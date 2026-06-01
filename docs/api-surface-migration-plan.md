# API Surface 全量迁移计划(Route B)

> **状态**:立项冻结(2026-06-01 用户拍板)+ 滚动执行追踪。
> **档位**:**D 档**(surface 互转 / 删除 legacy / path alias / 前端联调口径变化);严格**分阶段、分 PR、串行**;每阶段先评审稿冻结再动代码。
> **承接**:[`AGENTS.md §21 D-9`](../AGENTS.md)(2026-06-01 重开并取代 §19.7 D-2)、[`api-surface-policy.md §0`](api-surface-policy.md)。
> **配套**:当前事实见 [`current-state.md`](current-state.md);PR 分级 / D 档降速见 [`process.md §3 / §4`](process.md)。
> **本立项稿不改任何代码、不改 OpenAPI snapshot;仅冻结目标形态、原则、阶段顺序与禁止事项**。

---

## 1. 目标形态(canonical 长期边界)

| Surface | 目标前缀 | 用途 | 当前来源 |
|---|---|---|---|
| **Admin** | `/api/admin/v1/*` | 管理后台 / 运维后台业务 | 现 `/api/v2/*`(业务 CRUD)+ `/api/users/*` |
| **App** | `/api/app/v1/*` | App / 小程序 / 队员端(**已建成 15 endpoint**) | 已就位,**不迁移** |
| **Auth** | `/api/auth/v1/*` | 登录 / 刷新 / 登出 / 认证会话 | 现 `/api/auth/*` |
| **System** | `/api/system/v1/*` | 健康检查 / 运行状态 / 系统元信息 / ops 配置 | 现 `/api/health/*` + 现 `/api/v2/*` 中的 ops/配置/可观测类(承接 D-1:`contribution-rules` → System) |
| **Open** | `/api/open/v1/*` | **预留**:未来开放平台;**本期不实现、不占用** | — |

---

## 2. 决策冻结(2026-06-01;不回改)

- **放弃** `AGENTS.md §19.7 D-2` 的"方案 C(`/api/v2/*` 长期保留、不强制迁移)";**改为 Route B 全量物理迁移**。
- **重开依据**:用户 2026-06-01 主动要求重开 D-2,已按 [`AGENTS.md §19.7` preamble](../AGENTS.md) "暂停说明本节存在后再讨论" 履行,拍板 Route B。
- **冻结的不变式**(贯穿全部阶段):
  1. **alias 阶段只加不删**:新路径与老路径并存,保证零破坏;
  2. **删除老路径**只能在满足"deprecation 窗口 ≥ 2 release + 前端/移动端切流确认 + 单独 deprecated 公告"后执行(沿 [`api-surface-policy.md §6`](api-surface-policy.md) 既有铁律);
  3. **每阶段单独立项 + 单独 PR + 串行**,AI **禁止**自行启动任一阶段代码改造;
  4. **不夹带**:迁移 PR 不顺手改 DTO 字段 / BizCode / RBAC / Guard / schema / god-service 内部逻辑(沿 [`process.md §4`](process.md) D 档铁律);
  5. **App 边界铁律 D-4 ~ D-8 不受本迁移影响**(DTO 隔离 / `scope=self` / L3 字段永不返回 / 6 类抽离边界继续有效)。

---

## 3. 现状 → 目标 surface 映射(Phase 0;2026-06-01 用户签字冻结)

> **签字记录**:2026-06-01 用户授权按下述规则全量冻结,并确认 8 个 legacy mobile-like 端点纳入 Phase 4 删除;明确约束"**不留后遗症 / 终态彻底干净**"。本节自此为 **Phase 0 冻结产物,不回改**;逐 route 权威清单见 [`test/contract/openapi.contract-spec.ts`](../test/contract/openapi.contract-spec.ts) `EXPECTED_ROUTES`(**156 路由**)。后续任何 Phase 1+ PR **不得偏离**本映射。

### 3.1 冻结规则

1. **只换前缀,不改路径结构**(endpoint zero drift;仅 `@Controller` 前缀段变化,方法 path / param / 段顺序全不动)。
2. **tag 即 surface**:`Admin - *` → Admin;`Ops - *` + `Public`(health)→ System;`Auth` → Auth;`Mobile - *` → App(已就位)/ legacy 删除。surface 分类沿 v0.15.0 Phase 1A Swagger Tag(#141/#142,已评审),不重新讨论。

### 3.2 controller → 目标映射(全 37 controller / 156 路由)

| 现 tag / controller | 现前缀 | 目标前缀 | surface | 路由 |
|---|---|---|---|---|
| Auth / auth | `auth/*` | `auth/v1/*` | **Auth** | 4 |
| Public / health | `health/*` | `system/v1/health*` | **System** | 3 |
| Admin - Users / users(管理 CRUD) | `users`(`/:id*`) | `admin/v1/users` | **Admin** | 8 |
| Admin - Organizations | `v2/organizations` | `admin/v1/organizations` | Admin | 7 |
| Admin - Members | `v2/members` | `admin/v1/members` | Admin | 6 |
| Admin - Member Departments | `v2/members/:id/department` | `admin/v1/members/:id/department` | Admin | 3 |
| Admin - Member Profiles | `v2/members/:id/profile` | `admin/v1/members/:id/profile` | Admin | 3 |
| Admin - Emergency Contacts | `v2/members/:id/emergency-contacts` | `admin/v1/…` | Admin | 4 |
| Admin - Certificates | `v2/members/:id/certificates` | `admin/v1/…` | Admin | 8 |
| Admin - Activities | `v2/activities` | `admin/v1/activities` | Admin | 7 |
| Admin - Registrations | `v2/activities/:id/registrations` | `admin/v1/…` | Admin | 6 |
| Admin - Attendances | `v2/attendance-sheets` + `v2/activities/:id/attendance-sheets` | `admin/v1/…` | Admin | 10 |
| Admin - Attachments | `v2/attachments`(8 admin 端点) | `admin/v1/attachments` | Admin | 8 |
| Ops - Dictionaries | `v2/dict-types` + `v2/dict-items` | `system/v1/…` | **System** | 13 |
| Ops - Contribution Rules(D-1) | `v2/contribution-rules` | `system/v1/contribution-rules` | System | 5 |
| Ops - Audit Logs | `v2/audit-logs` | `system/v1/audit-logs` | System | 2 |
| Ops - Permissions | `v2/permissions` | `system/v1/permissions` | System | 4 |
| Ops - Roles | `v2/roles` | `system/v1/roles` | System | 5 |
| Ops - Role Permissions | `v2/roles/:id/permissions` | `system/v1/…` | System | 2 |
| Ops - User Roles | `v2/users/:userId/roles` | `system/v1/users/:userId/roles` | System | 3 |
| Ops - RBAC | `v2/rbac`(reload + me/permissions) | `system/v1/rbac` | System | 2 |
| Ops - Attachment Configs | `v2/attachment-{type,mime,size-limit}-configs` | `system/v1/…` | System | 17 |
| Ops - Storage Settings | `v2/storage-settings` | `system/v1/storage-settings` | System | 3 |
| Mobile - *(App) | `app/v1/*` | **不变** | **App** | 15 |
| Mobile - *(legacy 重复) | `users/me*` + `v2/users/me/*` | **删除(Phase 4)** | — | 8 |

合计:Admin **70** / System **59** / Auth **4** / App **15**(不迁移)/ legacy 删除 **8** + `attachments/me/uploaded` 特殊 **1** = **157**。
> 计数 true-up(2026-06-01 Phase 1c 实测):`attachments` admin 端点实为 **8**(原稿 §3.2 误记 7),故 Admin **69→70**、总计 **156→157**;surface 归属决策不变(仍全 Admin),仅修正计数。contract `EXPECTED_ROUTES` 为路由权威源。

### 3.3 特殊项处置(2026-06-01 拍板)

1. **8 个 legacy mobile-like → Phase 4 删除**(均已有 app/v1 对等):`GET`/`PATCH /api/users/me` + `PUT /api/users/me/password`(3;对 `app/v1/me*`)、`/api/v2/users/me/registrations*` 系 4(对 `app/v1/my/registrations`)、`GET /api/v2/users/me/attendance-records`(1;对 `app/v1/my/attendance-records`)。
2. **`GET /api/v2/rbac/me/permissions` → `GET /api/system/v1/rbac/me/permissions`**:raw RBAC code,PC 后台靠它显示按钮可见性,与 `app/v1/me/capabilities` 语义不等价(D-5.3),**不删**,随 Ops 迁 System。
3. **`GET /api/v2/attachments/me/uploaded`(无 app/v1 对等)→ 不留孤儿**:删除该端点的**硬前置 = 先单独立项新建 `GET /api/app/v1/my/attachments`**(App surface + Mobile DTO,C 档,可与 alias 阶段并行);新端点上线 + 切流后,旧端点随 Phase 4 删除。该 App 端点建成前,旧端点保留(**不**进 Admin、**不**算迁移完成)。

### 3.4 终态声明(无后遗症验收基线)

迁移全部完成后,`EXPECTED_ROUTES` 中**只允许**出现 4 个前缀:`/api/admin/v1/*`、`/api/app/v1/*`、`/api/auth/v1/*`、`/api/system/v1/*`。**零** `/api/v2/*`、**零**裸 `/api/auth/*` / `/api/health/*` / `/api/users/*`、**零** legacy mobile-like 重复端点、**零**孤儿 mobile-like 端点。`/api/open/v1/*` 仍仅预留。**此为 Phase 4 收口的验收基线**(可写成 contract 断言:非四前缀路由数 = 0)。

---

## 4. 风险表(沿 `process.md §4` step 2)

| 维度 | 影响面 |
|---|---|
| 模块 | 全部 37 个 controller 文件(其中约 24 个 `@Controller('v2/...')` 前缀 + auth + health + users + 3 个 v2 legacy mobile-like + 已就位的 5 个 app/v1) |
| 测试 | OpenAPI contract snapshot(单文件 ~1MB / 37k 行)、`openapi.contract-spec.ts` `EXPECTED_ROUTES`、78+ e2e spec、引用路径的 unit spec |
| 已发版本 / 客户端 | 任何直连 API 的消费者(PC 管理后台、运维脚本)在删除阶段前必须切流;**D-2 原承诺"PC 后台联调不破坏"在 Route B 下改为"分阶段迁移、删除前必达零流量"** |
| 用户可见行为 | 路径变化 = 对直连消费者的 breaking change;通过 alias 双挂 + deprecation 窗口缓冲 |
| 文档 | `api-surface-policy.md` / `current-state.md §2.1` / README 路由总览 / Swagger Tag 体系 需逐阶段 true-up |

---

## 5. 实施方案对比(沿 `process.md §4` step 3)

| 方案 | 做法 | 优 | 劣 |
|---|---|---|---|
| **A(推荐 alias 阶段用)** | `@Controller(['v2/members', 'admin/v1/members'])` 数组双 path,单 handler 双挂 | 改动最小、零 service 改动、endpoint 逻辑零 drift | OpenAPI 双路径膨胀;**需先 spike 验证 NestJS 11 + path-to-regexp v8 对数组 path 的行为**(见 [`src/bootstrap/logger-options.ts`](../src/bootstrap/logger-options.ts) 既有 v8 注意事项) |
| **B(removal 阶段收口用)** | 删除老 path,`@Controller('admin/v1/members')` 单 path;legacy 端点整文件删除 | 终态干净、单一前缀 | 是不可逆步骤,必须 gated 在零流量 + 公告后 |

**回退基线**:alias / canonical / deprecation 三阶段均可逆(移除新 path / 取消 deprecate 标记);**仅 Phase 4 removal 不可逆**,因此 removal 单独 gated。

---

## 6. 分阶段计划(每阶段单独立项 + 单独 PR + 严格串行)

| Phase | 内容 | 档 | 可逆 | 硬前置 |
|---|---|---|---|---|
| **Phase 0** | ✅ **已完成(2026-06-01 签字冻结;见 §3)**:全 156 路由现状→目标映射 + 终态验收基线 | D(立项 docs) | ✅ | 本立项稿 |
| **Phase 1** | additive alias:每个 controller 双挂老+新 path;contract snapshot 显式扩为双路径;e2e 双路径回归 | D | ✅ | Phase 0 映射冻结 |
| **Phase 2** | canonical 切换:新 path 为 Swagger 正统、老 path 标 `@deprecated`;前端/移动端切流;接入 old-path 流量观测 | D | ✅ | Phase 1 全绿 |
| **Phase 3** | deprecation 窗口:维持双挂 ≥ 2 release;监测老 path 流量 → 0;发 deprecated 公告 | D | ✅ | Phase 2 切流确认 |
| **Phase 4** | removal:删除老 path + 历史 mobile-like 重复端点;OpenAPI snapshot 收口为单一新前缀(达成 §3.4 终态) | D | ❌ | 老 path 零流量 + 公告期满 + `/api/app/v1/my/attachments` 已建成(§3.3 项 3) |

> **NestJS 数组 path spike(Phase 1 硬前置)= ✅ 已验证(2026-06-01)**:`@Controller([old, new])` 双挂(§5 方案 A)在 NestJS 11 + path-to-regexp v8 下,老+新前缀路由均注册;OpenAPI **operationId 自动 `[0]`/`[1]` 消歧,无重复**(Phase 4 删旧后恢复无后缀)。spike + Phase 1a(auth/health)实测均通过。

---

## 7. 本计划明确不做(边界)

- ❌ 不在迁移 PR 内拆 god-service(`attendances.service.ts` 等)/ 改 DTO 字段 / 改 BizCode / 改 RBAC / 改 schema / migration。
- ❌ 不实现 `/api/open/v1/*`(仅预留命名,不占用、不建 controller)。
- ❌ 不改 App 边界铁律(D-4 ~ D-8);App surface 已就位,**不**参与本迁移。
- ✅ admin↔system 归属**已于 Phase 0 冻结**(§3,全部按 `tag→surface`,无遗留灰区);后续 PR **不得偏离 §3 映射**,如需调整须重新立项。
- ❌ AI 不自动推进下一 Phase;每 Phase 收口后停下等用户立项。

---

## 8. 执行追踪(滚动维护)

| Phase | 状态 | PR | 备注 |
|---|---|---|---|
| 立项冻结 | ✅ 本稿(2026-06-01) | — | docs-only;重开 D-2 → §21 D-9 |
| Phase 0 映射表 | ✅ 已签字冻结(2026-06-01;见 §3) | (本 PR) | 156 路由全映射 + 终态验收基线;tag→surface 无遗留灰区 |
| Phase 1 alias | ✅ **完成** | 1a #259 / 1b #260 / 1c PR | **全 133 非-app 路由双挂完成**:1a auth+health(7)/ 1b system(56)/ 1c admin(70);contract 423 + e2e 双路径绿;老路径零回归 |
| Phase 2 canonical | 🔄 进行中 | Phase 2 PR | **仓内 deprecate 已落地**(apply-swagger 后处理:142 老前缀 operation 标 `deprecated`;canonical 新前缀不标;contract 425 断言锁定);**余前端/移动端切流 + old-path 流量观测(仓外,作为 Phase 3→4 gate)** |
| Phase 3 deprecation | ⏭️ **豁免** | — | **无生产消费者**(用户 2026-06-01 确认),deprecation 窗口 / 前端切流 / 流量观测 gate 均不适用,直接进 Phase 4 |
| Phase 4 removal | 🔄 进行中 | 4a PR… | **4a auth+health 老路径已删**(收为单一前缀 `auth/v1` + `system/v1/health`;contract 418 + full e2e 1800 绿);余 4b system / 4c admin / 4d orphan(建 `app/v1/my/attachments`)+ 收尾(删 deprecation 后处理 + 终态断言) |
