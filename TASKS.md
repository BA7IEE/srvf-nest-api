# TASKS.md — 历史任务入口索引

> **本文件不再作为日常任务源。**
> V2 第一阶段(原 §6 Step 1-7)与 V2.x 批次(原 §7 RBAC / §8 attachments / §9 Provider / §10 后续任务)全部已迁档,根目录仅保留入口索引与章节锚点。
>
> - **当前事实**:见 [`docs/current-state.md`](docs/current-state.md)(版本 / open PR / 已发能力 / 当前债务 / 不做清单)
> - **治理路线图**:见 [`docs/system-foundation-governance.md`](docs/system-foundation-governance.md)(本阶段暂停项 / G-1 ~ G-12 顶层规则缺口 / Phase G0-G4 路线图 / RCT 模板)
> - **版本变更历史**:见 [`CHANGELOG.md`](CHANGELOG.md) + [`docs/archive/handoff/`](docs/archive/handoff/)
> - **流程制度**:见 [`docs/process.md`](docs/process.md)(开工 checklist / PR 五档分级 / release 收口)
> - **长期 AI 协作铁律**:见 [`AGENTS.md`](AGENTS.md)(命名 / 错误码 / Guard / 软删除 / App API 边界 / §19.7 D-series 决策锁)
> - **架构蓝图与升级路径**:见 [`ARCHITECTURE.md`](ARCHITECTURE.md)(请先读顶部"当前阶段说明")
>
> **章节编号保留原值**(§6 / §7 / §8 / §9 / §10),§1-§5 留作历史归档占位,以避免破坏外部文档对 `TASKS.md §X.X` 的现有引用(详见 §0.3)。

---

## 0. 历史归档索引

> 以下任务卡阶段已收口,原文移至归档目录,**仅作历史证据**,不再作为当前执行约束。
> 当前事实以 [`docs/current-state.md`](docs/current-state.md) 为准;冲突时归档让步。

### 0.1 V1.1 工程加固任务卡(原 §0-§4)

- **归档位置**:[`docs/archive/legacy/tasks-v1-1-historical.md`](docs/archive/legacy/tasks-v1-1-historical.md)
- **覆盖任务**:V1.1 任务 15.1-15.9(GitHub Actions CI / `nestjs-pino` 结构化日志 / `x-request-id` 贯通 / 优雅关闭 / `@nestjs/terminus` 健康检查分层 / `helmet` / `@nestjs/throttler` 登录限流 / Dockerfile 多阶段 / README + 验收收尾)
- **收口于**:v0.1.5 / v0.1.6
- **承接当前事实**:
  - 已落地能力清单 → [`docs/current-state.md §2`](docs/current-state.md) "V1.1 工程加固"段
  - 架构蓝图 → [`ARCHITECTURE.md §11`](ARCHITECTURE.md) "V1.1 Engineering Hardening"
  - 长期铁律承接 → [`AGENTS.md §17`](AGENTS.md)(原 V1.1 规则细节已自承归档至 `docs/archive/legacy/agents-historical-design-period.md`)

### 0.2 V2 设计期任务卡(原 §5,含 V2-D1~D8 + A 档快车道 §5.5)

- **归档位置**:[`docs/archive/plans/v2-design-phase/tasks.md`](docs/archive/plans/v2-design-phase/tasks.md)
- **覆盖任务**:V2-D1(研究文档)/ V2-D2(`docs/archive/plans/architecture-v2-first-stage-blueprint.md §12`,原 `ARCHITECTURE.md §12`,PR-6 已归档)/ V2-D3(`CLAUDE.md §18` / `AGENTS.md §18`)/ V2-D4(`TASKS.md §5`)/ V2-D5(调研访谈)/ V2-D6(数据模型草案)/ V2-D7(模型评审 D7-min)/ V2-D8(开发立项)+ A1 / A2(✅ 已完成)+ A3(⏸️ 暂缓)+ A4 / A5(❌ 不做)
- **收口于**:V2-D8 立项完成 2026-05-08;V2 第一阶段开发任务卡(原 §6)已 ✅ 全部交付
- **承接当前事实**:
  - V2 第一阶段已交付能力 → [`docs/current-state.md §2`](docs/current-state.md) "V2 数据底座" / "V2 批次"段
  - 完整数据模型 → [`prisma/schema.prisma`](prisma/schema.prisma)(字段事实权威源;`docs/v2-data-model.md` 仅 D8 立项时刻 draft 历史快照)
  - 完整接口契约 → Swagger UI(`/api/docs`)+ [`test/contract/openapi.contract-spec.ts`](test/contract/openapi.contract-spec.ts) `EXPECTED_ROUTES`(接口事实权威源;`docs/v2-api-contract.md` 仅 D8 立项时刻 draft 历史快照)
  - 长期铁律承接 → [`AGENTS.md §18`](AGENTS.md)(原 V2 设计纪律细节已自承归档,仅保留 §18.4 / §18.4.1 当前仍生效部分)

#### 0.2.1 重要 redirect — V2.x 复活触发条件

原 `§5.5.4.3` "V2.x 复活触发条件(D7-min 延后模型)"已迁入归档。**当前事实**以以下 active 文档为准:

| 维度 | 权威源(active) |
|---|---|
| **V2.x 复活触发条件 / 延后模型当前清单** | [`docs/V2红线与复活路径.md §4.3`](docs/V2红线与复活路径.md)(滚动维护) |
| **延后模型的红线分类**(C-7 / C-8 / C-9 / C-10) | 同上 §4 |
| **`audit_logs` 当前状态**(v0.7.0 局部启动 + 剩余 22 处迁移) | 同上 §4.1 C-1 |
| **D7-min 决议时刻历史快照**(2026-05-07,commit `4333c31`) | [归档:`v2-design-phase/tasks.md`](docs/archive/plans/v2-design-phase/tasks.md) §5.5.4.3 |

**当前延后模型清单**(沿 V2 红线 §4.3):`member_profiles` / `attachments` / `events` / `event_participants` 共 **4 个**;`audit_logs` 已不再延后(v0.7.0 后已局部启动)。

### 0.3 章节编号说明

为保留以下 active / archive 文档对 `TASKS.md §6 / §7 / §8 / §9 / §10` 的现有引用,**G1-PR-D 不重新编号本文件章节**;§1-§5 留作历史归档占位:

- [`ARCHITECTURE.md`](ARCHITECTURE.md):引用 `TASKS.md §6` / `§6.10`(原 `§5.5.4.3` 引用已在 PR-2 刷新至 `docs/V2红线与复活路径.md §4.3`;原 `§6.4` 引用为 pre-existing bug,PR-2 已修正为 `§6.10`)
- [`docs/V2红线与复活路径.md`](docs/V2红线与复活路径.md):引用 `§6.0` / `§6.9` / `§6.10` / `§6.11`(原 `§5.5.4.3` 引用已在 PR-2 刷新为指向本文件 §4.3 或归档快照;原 `§6.4` 引用为 pre-existing bug,PR-2 已修正为 `§6.9`)
- [`docs/archive/plans/v2-first-stage-plan.md`](docs/archive/plans/v2-first-stage-plan.md):引用 `§6`(原 `docs/v2-plan.md`,PR-5 已归档;原 `§5.5.4.3` 引用已在 PR-2 刷新至 `V2红线 §4.3`)
- [`docs/v2-data-model.md`](docs/v2-data-model.md):引用 `§6`(原 `§5.5.4.3` 引用已在 PR-2 刷新至 `V2红线 §4.3`)
- [`docs/v2-api-contract.md`](docs/v2-api-contract.md):引用 `§6`
- [`docs/archive/plans/v2-design-phase/srvf-foundation-research.md`](docs/archive/plans/v2-design-phase/srvf-foundation-research.md) / [`docs/archive/plans/v2-design-phase/srvf-foundation-data-model-draft.md`](docs/archive/plans/v2-design-phase/srvf-foundation-data-model-draft.md):原引用 V2 设计任务卡(PR-2 已标注归档指针;PR-4 已将这两个文件整体归档至 `docs/archive/plans/v2-design-phase/`)
- [`docs/archive/handoff/v0.9.0.md`](docs/archive/handoff/v0.9.0.md) / `v0.10.0.md` / `v0.11.0.md` / `v0.12.0.md`:引用 `§7` / `§8` / `§9`(frozen handoff,沿铁律不回改)

**外部引用刷新已在 PR-2 完成**;读者遇到指向 `§1-§5` 的旧引用时,以本 §0 归档索引 + redirect 提示为准;读者遇到指向 `§6` ~ `§10` 的旧引用时,**根目录本文件保留对应章节锚点 + redirect 短段**,具体历史内容查 §0.4 指向的归档文件。

### 0.4 V2 第一阶段 + V2.x 批次任务卡(原 §6 ~ §10)

- **归档位置**:[`docs/archive/legacy/tasks-v2-first-stage-historical.md`](docs/archive/legacy/tasks-v2-first-stage-historical.md)
- **覆盖任务**:
  - 原 §6 V2 第一阶段开发任务卡 Step 1-7(2026-05-08 全部 ✅ 已完成)
  - 原 §7 V2.x C-6 RBAC 批次 8(v0.9.0 收口)
  - 原 §8 V2.x C-7 attachments 批次 7(v0.10.0 收口)
  - 原 §9 V2.x C-7.5 Provider 选型批次 7.5(v0.11.0 收口)
  - 原 §10 V2.x 后续任务入口(已转向 `docs/current-state.md` 与 `docs/system-foundation-governance.md` 双权威)
- **迁档于**:G1-PR-D(沿 [`docs/system-foundation-governance.md §6 Phase G1-5`](docs/system-foundation-governance.md))
- **承接当前事实**:
  - 当前能力清单 → [`docs/current-state.md §2`](docs/current-state.md)
  - 当前不做 / 暂停项 → [`docs/current-state.md §3`](docs/current-state.md) + [`docs/system-foundation-governance.md §2`](docs/system-foundation-governance.md)
  - 当前债务 → [`docs/current-state.md §4`](docs/current-state.md)
  - 版本变更累计 → [`CHANGELOG.md`](CHANGELOG.md) + [`docs/archive/handoff/`](docs/archive/handoff/)
  - 通用验收 checklist → [`docs/srvf-foundation-baseline.md §13`](docs/srvf-foundation-baseline.md)
  - 范围外统一处理 / RCT → [`docs/system-foundation-governance.md §5`](docs/system-foundation-governance.md)
  - V2.x 复活触发条件 → [`docs/V2红线与复活路径.md §4.3`](docs/V2红线与复活路径.md)

---

## 6. V2 第一阶段任务卡(已迁档)

> **状态**:Step 1-7 全部 ✅ 已于 2026-05-08 完成。全文已迁档至 [`docs/archive/legacy/tasks-v2-first-stage-historical.md`](docs/archive/legacy/tasks-v2-first-stage-historical.md);本节仅保留章节锚点供历史引用解析。
>
> - **当前已交付能力**:见 [`docs/current-state.md §2`](docs/current-state.md)(V2 数据底座 / V2 批次)
> - **版本变更累计**:见 [`CHANGELOG.md`](CHANGELOG.md)
> - **完整 commit 时间线**:见归档文件 §6.1 任务总览
> - **通用验收 checklist**:见 [`docs/srvf-foundation-baseline.md §13`](docs/srvf-foundation-baseline.md)
> - **范围外处理 / RCT 机制**:见 [`docs/system-foundation-governance.md §5`](docs/system-foundation-governance.md)

### 6.0 范围速读(迁档索引)

V2 第一阶段 Step 1-7 已全部 ✅ 完成(2026-05-08)。详细范围速读、Step 1-7 完成情况事实块、commit hash、A 档 / B 档验收记录见归档文件 [`tasks-v2-first-stage-historical.md §6.0`](docs/archive/legacy/tasks-v2-first-stage-historical.md)。

### 6.9 通用验收 checklist(迁档索引)

A 档(必跑)+ B 档(涉及全局行为 / v1 兼容性 / schema / API 时追加)详见 [`docs/srvf-foundation-baseline.md §13`](docs/srvf-foundation-baseline.md);历史 Step 1-7 期使用的版本见归档文件 [`tasks-v2-first-stage-historical.md §6.9`](docs/archive/legacy/tasks-v2-first-stage-historical.md)。

### 6.10 范围外的统一处理(迁档索引)

当前"范围外统一处理"流程已升级为 RCT 需求碰撞前置模板,见 [`docs/system-foundation-governance.md §5`](docs/system-foundation-governance.md);V2 第一阶段时期的具体处置清单与"唯一已开口子"(`auth.service.ts` memberNo 登录回退)历史见归档文件 [`tasks-v2-first-stage-historical.md §6.10`](docs/archive/legacy/tasks-v2-first-stage-historical.md)。

### 6.11 V2.x 复活触发条件(迁档索引)

V2.x 复活触发条件 active 权威源为 [`docs/V2红线与复活路径.md §4.3`](docs/V2红线与复活路径.md)(滚动维护);D7-min 决议时刻历史快照见 [`docs/archive/plans/v2-design-phase/tasks.md`](docs/archive/plans/v2-design-phase/tasks.md) §5.5.4.3;Step 7 收口时刻的清单见归档文件 [`tasks-v2-first-stage-historical.md §6.11`](docs/archive/legacy/tasks-v2-first-stage-historical.md)。

---

## 7. V2.x C-6 RBAC(已迁档)

> **状态**:V2.x C-6 RBAC 批次 8 已收口于 v0.9.0(PR #54-#61 实施 + #62 docs landing + bump + handoff;P0-F 管理面接入 `rbac.can()` 已于 v0.15.0 完成)。全文已迁档至 [`docs/archive/legacy/tasks-v2-first-stage-historical.md §7`](docs/archive/legacy/tasks-v2-first-stage-historical.md);本节仅保留章节锚点供历史引用解析。
>
> - **当前 RBAC 能力清单**:见 [`docs/current-state.md §2`](docs/current-state.md)(V2.x C-6 RBAC 段)
> - **v0.9.0 发布说明**:见 [`CHANGELOG.md`](CHANGELOG.md) `v0.9.0` 段
> - **v0.9.0 handoff**:见 [`docs/archive/handoff/v0.9.0.md`](docs/archive/handoff/v0.9.0.md)
> - **RBAC 业务面全面接入路线**:沿 Slow-4(归 [`docs/current-state.md §3`](docs/current-state.md) "当前明确未做"清单)
> - **D7 v1.0 + v1.1 决议**:见 [`docs/archive/batches/批次8_RBAC_API前评审.md`](docs/archive/batches/批次8_RBAC_API前评审.md)(frozen)

---

## 8. V2.x C-7 Attachments(已迁档)

> **状态**:V2.x C-7 attachments 批次 7 已收口于 v0.10.0(PR #70-#78 实施 + #79 docs landing)。全文已迁档至 [`docs/archive/legacy/tasks-v2-first-stage-historical.md §8`](docs/archive/legacy/tasks-v2-first-stage-historical.md);本节仅保留章节锚点供历史引用解析。
>
> - **当前 attachments 能力清单**:见 [`docs/current-state.md §2`](docs/current-state.md)(V2.x C-7 attachments 段)
> - **v0.10.0 发布说明**:见 [`CHANGELOG.md`](CHANGELOG.md) `v0.10.0` 段
> - **v0.10.0 handoff**:见 [`docs/archive/handoff/v0.10.0.md`](docs/archive/handoff/v0.10.0.md)
> - **附件配置三表边界**:见 [`docs/attachment-config-boundary.md`](docs/attachment-config-boundary.md)(active)
> - **D7 v1.0 决议**:见 [`docs/archive/batches/批次7_attachments_API前评审.md`](docs/archive/batches/批次7_attachments_API前评审.md)(frozen)

---

## 9. V2.x C-7.5 Provider 选型(已迁档)

> **状态**:V2.x C-7.5 Provider 选型批次 7.5 已收口于 v0.11.0(PR #86-#93 实施 + #94 docs landing)。全文已迁档至 [`docs/archive/legacy/tasks-v2-first-stage-historical.md §9`](docs/archive/legacy/tasks-v2-first-stage-historical.md);本节仅保留章节锚点供历史引用解析。
>
> - **当前 storage 能力清单**:见 [`docs/current-state.md §2`](docs/current-state.md)(V2.x C-7.5 storage 段)
> - **v0.11.0 发布说明**:见 [`CHANGELOG.md`](CHANGELOG.md) `v0.11.0` 段
> - **v0.11.0 handoff**:见 [`docs/archive/handoff/v0.11.0.md`](docs/archive/handoff/v0.11.0.md)
> - **运维侧 COS 上线 SOP**:见 [`docs/ops/cos-production-rollout-checklist.md`](docs/ops/cos-production-rollout-checklist.md)(active)
> - **C-7.5 v1.0 决议**:见 [`docs/archive/batches/批次7_provider选型_API前评审.md`](docs/archive/batches/批次7_provider选型_API前评审.md)(frozen)

---

## 10. V2.x 后续任务(已转权威源)

> **状态**:V2.x 后续任务的"当前已知方向 / 待启动流程 / 范围外处理"已全部转移至以下 active 权威源,本节仅保留章节锚点供历史引用解析;全文迁档至 [`docs/archive/legacy/tasks-v2-first-stage-historical.md §10`](docs/archive/legacy/tasks-v2-first-stage-historical.md)。
>
> - **当前明确未做 / 暂不启动清单**:见 [`docs/current-state.md §3`](docs/current-state.md)
> - **当前最大风险 / 债务**:见 [`docs/current-state.md §4`](docs/current-state.md)
> - **新任务开工前 checklist**:见 [`docs/current-state.md §5`](docs/current-state.md) + [`docs/process.md §2`](docs/process.md)
> - **治理期暂停事项 / G-1~G-12 顶层规则缺口 / Phase G0-G4 路线图**:见 [`docs/system-foundation-governance.md`](docs/system-foundation-governance.md)
> - **PR 五档分级 + D 档降速**:见 [`docs/process.md §3-§4`](docs/process.md)
> - **范围外统一处理 / RCT 需求碰撞前置模板**:见 [`docs/system-foundation-governance.md §5`](docs/system-foundation-governance.md)

**铁律**:任何新增任务必须按 [`docs/process.md §3`](docs/process.md) PR 五档分级走立项流程;**不在本节直接动手**。本文件不再维护 V2.x 后续任务清单。
