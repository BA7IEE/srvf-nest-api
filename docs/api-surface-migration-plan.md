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

## 3. 当前 → 目标 surface 映射(原则冻结;逐条归属待 Phase 0 用户签字)

**分流原则**:
- **业务 CRUD 资源** → `Admin`(`/api/admin/v1/*`):members / organizations / activities / activity-registrations / attendances / certificates / emergency-contacts / member-profiles / member-departments / users(管理 CRUD)。
- **ops / 配置 / 可观测 / 平台基础设施资源** → `System`(`/api/system/v1/*`):`contribution-rules`(**D-1 已锁**)、rbac / roles / permissions / user-roles / role-permissions(现 Tag `Ops - RBAC`)、dictionaries(现 Tag `Ops - Dictionaries`)、audit-logs、storage-settings、attachment-{type,mime,size-limit}-configs。
- **认证会话** → `Auth`(`/api/auth/v1/*`):login / refresh / logout / logout-all。
- **健康/系统元信息** → `System`(`/api/system/v1/health` 等)。
- **历史 mobile-like 重复端点**(`/api/users/me/*`、`/api/v2/users/me/*`、`/api/v2/attachments/me/uploaded`、`/api/v2/rbac/me/permissions`)→ **不迁移**:已有 `/api/app/v1/*` 对等者进入 Phase 4 删除候选;**例外** `/api/v2/rbac/me/permissions`(raw RBAC code,与 `/me/capabilities` 语义不等价,沿 D-5.3)需单独决议是否保留为 System 端点,**默认保留**。

> ⚠️ 上述为**原则**,不是最终归属。`audit-logs` / `storage-settings` / RBAC 系 / `dictionaries` / `attachment-configs` 归 Admin 还是 System 存在真实灰区,**必须**在 Phase 0 产出逐 endpoint 映射表并经用户签字后冻结;本稿**不**预先拍板灰区归属。

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
| **Phase 0** | 逐 endpoint 现状 → 目标映射表(admin/system 灰区归属);用户签字冻结 | D(立项 docs) | ✅ | 本立项稿 + NestJS 数组 path spike |
| **Phase 1** | additive alias:每个 controller 双挂老+新 path;contract snapshot 显式扩为双路径;e2e 双路径回归 | D | ✅ | Phase 0 映射冻结 |
| **Phase 2** | canonical 切换:新 path 为 Swagger 正统、老 path 标 `@deprecated`;前端/移动端切流;接入 old-path 流量观测 | D | ✅ | Phase 1 全绿 |
| **Phase 3** | deprecation 窗口:维持双挂 ≥ 2 release;监测老 path 流量 → 0;发 deprecated 公告 | D | ✅ | Phase 2 切流确认 |
| **Phase 4** | removal:删除老 path + 历史 mobile-like 重复端点;OpenAPI snapshot 收口为单一新前缀 | D | ❌ | 老 path 零流量 + 公告期满 |

---

## 7. 本计划明确不做(边界)

- ❌ 不在迁移 PR 内拆 god-service(`attendances.service.ts` 等)/ 改 DTO 字段 / 改 BizCode / 改 RBAC / 改 schema / migration。
- ❌ 不实现 `/api/open/v1/*`(仅预留命名,不占用、不建 controller)。
- ❌ 不改 App 边界铁律(D-4 ~ D-8);App surface 已就位,**不**参与本迁移。
- ❌ 不擅自拍板 audit-logs / storage / RBAC / dictionaries / attachment-configs 的 admin↔system 灰区归属(Phase 0 用户签字)。
- ❌ AI 不自动推进下一 Phase;每 Phase 收口后停下等用户立项。

---

## 8. 执行追踪(滚动维护)

| Phase | 状态 | PR | 备注 |
|---|---|---|---|
| 立项冻结 | ✅ 本稿(2026-06-01) | — | docs-only;重开 D-2 → §21 D-9 |
| Phase 0 映射表 | ⬜ 未启动 | — | 需用户签字 |
| Phase 1 alias | ⬜ 未启动 | — | — |
| Phase 2 canonical | ⬜ 未启动 | — | — |
| Phase 3 deprecation | ⬜ 未启动 | — | — |
| Phase 4 removal | ⬜ 未启动 | — | 不可逆,单独 gated |
