# 系统底座治理期入口(System Foundation Governance)

> **状态**:active(2026-05-23 启动)
> **定位**:SRVF 当前治理期的总入口 + 业务需求重新碰撞前置入口。
> **本文不是**:架构铁律(见 [`AGENTS.md`](../AGENTS.md))、当前事实(见 [`current-state.md`](current-state.md))、流程制度(见 [`process.md`](process.md))。
> **退场**:见 §7;本文档完成使命后归档至 [`archive/plans/`](archive/plans/)。

---

## 1. 当前阶段定义

**SRVF 系统底座治理期**。本阶段不再以"发新业务能力"为目标,而是**先把系统底座、文档底座、AI 协作规则、业务边界与后续需求再碰撞机制梳理清楚**,再进入下一轮业务开发。

启动依据:v0.15.0 已完成 P0-F 管理面 RBAC 收紧 + Phase 1A Swagger Tag 重命名 + App API Phase 2 完整 15 endpoint;post-v0.15.0 docs 治理、characterization、state-machine / audit-recorder 抽离已累计多轮 PR;系统底座达到"先停一下、把规则与边界对齐"的合适时点。

---

## 2. 本阶段暂停事项

| 暂停项 | 范围 |
|---|---|
| 业务功能开发 | 任何新业务 endpoint / 新业务模块 / 新业务流程 |
| `attendances` controller 拆分(P1-C 第四步) | 沿 [`api-surface-policy.md §7`](api-surface-policy.md);characterization tests 已就绪,但拆分本身待治理期后启动 |
| 招新 / 活动 / 考勤 / 成员生命周期 业务改造 | 全部走 §5 RCT 模板碰撞后再启动 |
| schema / migration / 状态机扩展 / Permission seed | D 档,任何变更必须经 §5 RCT + [`process.md §4`](process.md) D 档降速 |
| god-service 拆分(`attendances.service.ts` / `attachments.service.ts` / `activity-registrations.service.ts` / `activities.service.ts`) | 沿 [`architecture-boundary.md §8`](architecture-boundary.md);必须在业务流程碰撞之后启动,避免按技术直觉切错聚合边界 |
| Phase 1B path alias / 新 surface 前缀 | 沿 [`api-surface-policy.md §7 P1-D`](api-surface-policy.md);本阶段不启动 |

> **铁律**:本节暂停项与"当前未启动 / 等业务方拍板"项(沿 [`current-state.md §3`](current-state.md))共同生效;冲突时以更严格者为准。

---

## 3. 本阶段目标

1. **清理冗余文档**:identify stale 状态、过期措辞、重复维护的规则;具体清单见 §6 Phase G1。
2. **补齐顶层规则缺口**:G-1 ~ G-12 共 12 项(摘要见 §4);具体落地按 §6 Phase G2 逐项立项。
3. **建立业务需求再碰撞机制**:把所有"未来真业务需求出现时如何启动"沉淀为 §5 RCT 模板;以后招新 / 活动 / 考勤 / 成员生命周期等都走此模板,不再凭直觉动手。
4. **形成后续业务开发前置门槛**:任何业务方向再启动前,必须先有 RCT 拍板;无 RCT → 不动一行代码。

---

## 4. 顶层规则缺口摘要(G-1 ~ G-12)

> 本节**只摘要**;**不在本文件展开成新规则正文**。每条 G-x 的最终条款由 §6 Phase G2 对应子项落地时,放入目标 active 文档。

| # | 缺口主题 | 摘要(一句话) |
|---|---|---|
| **G-1** | 状态机扩展铁律 | 新 statusCode / 新 transition 的评审与 characterization 前置 |
| **G-2** | 成员生命周期规则 | 候选 / 临时编号 / 正式 / 离队 / 软删 / 回归 的统一参照 |
| **G-3** | 招新流程 | 公开报名 → 候选 → 入队 → memberNo 分配 → 同意书 |
| **G-4** | 活动流程 | 立项 → 发布 → 报名 → 现场 → 终审 → 贡献值 完整业务流程 |
| **G-5** | 考勤流程 | 现场打卡 vs 事后录入 / GPS / 二维码 / 手签 / 上传材料 |
| **G-6** | 数据导入导出规则 | CSV / Excel / 模板 / 字段映射 / 脱敏 / audit 留痕 / 分批落库 |
| **G-7** | 通知 / 短信 / 推送 | Effect 真出现时的统一出口策略(沿 [`architecture-boundary.md §3.6`](architecture-boundary.md)) |
| **G-8** | 字典治理规则 | 字典码值变更的同步与影响面通知 |
| **G-9** | 已锁决策解锁路径 | [`AGENTS.md §19.7`](../AGENTS.md) D-x 决策重开的最小入参 |
| **G-10** | 双仓库协作规则 | 业务文档库与代码仓库的引用 / 同步 / 仲裁 |
| **G-11** | worktree / 并行任务协作 | 多 worktree 下 "open PR=0" 门禁与协作纪律 |
| **G-12** | 依赖升级 / 安全更新节奏 | `pnpm audit` / Renovate / 周期性 patch 触发条件 |

---

## 5. RCT 需求碰撞前置模板(Requirement Collision Template)

> **触发条件**:任何对"必须再碰撞"业务模块(沿 [`current-state.md §3`](current-state.md) + 本文 G-2 ~ G-5)的扩展诉求出现时,**必须先填本模板**,业务方拍板后再走 [`process.md §3`](process.md) PR 五档与降速流程。
> **存放位置**:建议未来在 `docs/adr/` 目录(若启用),命名 `RCT-NN-<topic>.md`;治理期内可暂存于会话与本文件附录链接。

### 5.1 模板字段(11 项,必填)

```text
# RCT-NN — <主题名>

状态:Draft / In Collision / Approved / Rejected / Superseded
业务方:<具体决策人 / 角色>
触发时间:YYYY-MM-DD
关联铁律:<列出本主题碰到的 AGENTS.md §X / V2 红线 A-X / D-x 决策锁>

 1. 原流程是什么(线下 / Excel / 微信群 怎么做)
 2. 谁在操作 / 谁在决策(角色矩阵)
 3. 当前痛点 / 出错频率 / 出错后果
 4. 哪些动作可被系统替代(逐条 ✅ / 🟡 / ❌)
 5. 哪些动作必须保留人工判断
 6. 需要沉淀哪些数据(实体 + 字段 + 敏感字段三问)
 7. 哪些动作必须 audit 留痕(事件名草案 + extra 字段)
 8. 涉及哪些角色和权限点(Guard / rbac.can / 权限点草案)
 9. 是否影响现有 schema / API / 状态机(D 档判定)
10. 是否需要先出 ADR / 流程图 / 评审稿
11. 决策锁(碰撞完成后填:决议日期 / 决议人 / 锁定结论 / 解锁触发条件)
```

### 5.2 使用纪律

- **无 RCT → 不动一行业务代码**;AI 看到业务诉求不得直接进入实现。
- RCT 仅由**业务方拍板**;AI 协助填写但不代决策。
- RCT 拍板结论若升级为长期决策锁,**必须**同步写入 [`AGENTS.md §19.7`](../AGENTS.md) 并引用本 RCT 编号。
- 若 RCT 触发已锁决策的重开,**先走 G-9 解锁路径**(待 G2-1 落地),不得绕过。

---

## 6. 治理路线图(Phase G0 → G4)

### Phase G0 — 治理期入口锚点(本 PR 范围)

- **G0-1**:新建本文件 `docs/system-foundation-governance.md`(active 治理期入口)
- **G0-2**:在 [`docs/README.md §1`](README.md) active 文档表加入本文件指针,定位"治理期入口 / 需求碰撞前置入口"
- **G0-3**:本文件 §2 已显式声明暂停事项;不修改 AGENTS / CLAUDE / ARCHITECTURE / current-state / process / api-surface-policy / architecture-boundary 任一现有规则文件

### Phase G1 — 文档 stale 与状态错位清理(逐 PR / A 档 docs-only)

- G1-1 ✅ 已完成(PR #215):[`srvf-foundation-baseline.md §1`](srvf-foundation-baseline.md) 段位表"V2 基线预留"状态已校准,头部加"2026-05-23 Phase G1 校准"批注,明确头部 §0 / §1.1 部分定性措辞源自 V2 设计期,当前各模块实装状态以 §1.1 段位表 + [`current-state.md §2`](current-state.md) + [`../prisma/schema.prisma`](../prisma/schema.prisma) 为准
- G1-2 ✅ 已完成(PR #215):[`V2红线与复活路径.md`](V2红线与复活路径.md) 头部"初始基线 v0.7.0 / 最后核对 v0.15.0" 表述已合并校准,头部加"2026-05-23 Phase G1 校准"批注,明确完整版本号 / open PR / HEAD / 最新 handoff 以 [`current-state.md`](current-state.md) 为准
- G1-3 ✅ 已完成(PR #216):[`v2-data-model.md`](v2-data-model.md) + [`v2-api-contract.md`](v2-api-contract.md) 头部加"回填注(2026-05-23 / G1-PR-B 治理刷新,v0.15.0+ 口径)",显式标注为 V2-D8 立项时刻 draft 历史快照,字段 / 接口 / 错误码事实权威源以 [`../prisma/schema.prisma`](../prisma/schema.prisma) + Swagger UI + [`../test/contract/openapi.contract-spec.ts`](../test/contract/openapi.contract-spec.ts) `EXPECTED_ROUTES` 为准
- G1-4 ✅ 已完成(PR #217):[`srvf-business-docs.md`](srvf-business-docs.md) 硬编码本机路径已泛化为 `<business-docs-repo-root>` / `<repo-root>` 占位符,沉淀双仓库协作规则(占位符约定 + 仓库分工表;关联 G-10 后续在 [`AGENTS.md`](../AGENTS.md) / [`current-state.md`](current-state.md) 展开正式条款)
- G1-5 ✅ 已完成(PR #218):[`TASKS.md`](../TASKS.md) 已入口化为 166 行入口索引;V2 第一阶段 Step 1-7 与 V2.x C-6 RBAC / C-7 attachments / C-7.5 Provider / §10 后续任务全文 verbatim 迁档至 [`docs/archive/legacy/tasks-v2-first-stage-historical.md`](archive/legacy/tasks-v2-first-stage-historical.md);根目录 §6 / §7 / §8 / §9 / §10 锚点保留,供 active 与历史 handoff 引用解析
- G1-6 ✅ 已完成(PR #219 + PR #221):[`current-state.md §4`](current-state.md) 已释放闭环 P0/P1 行(P0 入口锚点 / P0 handoff 双重身份 / P1 RBAC 管理面收紧 / P1 第一版前端联调包 等),并修正 TASKS / spec drift(service spec 比例修订为 `14 / 208 ≈ 6.7%`)
- G1-7 ✅ 已完成(PR #220):[`docs/development.md`](development.md) / [`docs/security.md`](security.md) 与 [`AGENTS.md §8 / §9`](../AGENTS.md) cross-check 完成,采用**指针式维护**(铁律以 `AGENTS.md` 为准,本文档仅作 surface 操作指引),`development.md` / `security.md` 不复制 AGENTS 全文规则

### Phase G2 — 顶层规则缺口逐项立项(独立 PR / A 或 C 档)

- 优先级 P0:G-9(解锁路径)、G-11(worktree 协作)
- 优先级 P1:G-2 + G-3(成员 + 招新)、G-4 + G-5(活动 + 考勤)、G-6(导入导出)、G-1(状态机扩展)
- 优先级 P2:G-8(字典治理)、G-10(双仓库协作)
- 优先级 P3:G-7(通知)、G-12(依赖升级节奏)

每项缺口落地时,正式条款写入目标 active 文档,**不**在本文件展开。

### Phase G3 — 业务模块边界与 RCT(独立 PR / A 档 docs-only)

- G3-1 `permissions` 业务面接入边界(前置:业务方 Slow-3 拍板)
- G3-2 `members` + `member-profiles` 生命周期(前置:业务方 + 合规)
- G3-3 `activities` + `activity-registrations` + `attendances` participation 业务流程(前置:业务方 + APD)
- G3-4 `contribution-rules` 规则扩展
- G3-5 `attachments` Slow-7 边界

每项走 §5 RCT 模板;**业务方拍板前不动代码**。

### Phase G4 — 代码层技术债(仅在业务碰撞后启动)

- G4-1 `attendances.controller.ts` 物理拆分(P1-C 第四步;characterization 已就绪)
- G4-2 `attendances.service.ts` 行为拆分(前置:G3-3 完成)
- G4-3 其余 god-service 拆分(`attachments` / `activity-registrations` / `activities`)

**铁律**:G4 严格落在 G3 之后。先碰撞业务、再拆服务,避免按技术直觉切错聚合边界。

---

## 7. 退场条件

满足以下**全部**条件时,本文档可归档至 [`archive/plans/`](archive/plans/):

1. **Phase G1 主要清理项完成或明确 reject**(7 项中至少 5 项闭环)
2. **Phase G2 P0 / P1 缺口落地或明确 reject**(G-9 / G-11 必须落地;G-1 ~ G-6 至少有明确 reject / 落地结论)
3. **Phase G3 至少 1 个业务模块完成 RCT 拍板**(成员生命周期 G3-2 或 participation G3-3 任一闭环)
4. **业务负责人碰撞机制稳定**:连续 ≥ 2 个 RCT 由业务方主动驱动并拍板(证明机制可持续)
5. **退场动作**:本文件归档至 `archive/plans/system-foundation-governance.md`;`docs/README.md §1` 移除本文件入口;`docs/README.md §2` 补归档指针

未达退场条件前,本文件持续作为 active 治理期入口。

---

## 8. 本文件不维护的事

- ❌ 不复制 [`AGENTS.md`](../AGENTS.md) 任一条铁律(本文只指路,不重抄)
- ❌ 不维护当前版本 / open PR / release 状态(那是 [`current-state.md`](current-state.md))
- ❌ 不维护 PR 五档 / D 档降速 / release SOP(那是 [`process.md`](process.md))
- ❌ 不展开 G-1 ~ G-12 任一条新规则正文(每条由 §6 Phase G2 落地时写入目标 active 文档)
- ❌ 不写 RCT 实际案例(招新 / 活动 / 考勤 / 成员等具体 RCT 由业务方驱动)
- ❌ 不动 `src/` / `prisma/` / `test/` 任何文件(治理期严格 A 档 docs-only)

---

## 9. 引用

- [`AGENTS.md`](../AGENTS.md) — 长期 AI 协作铁律主入口
- [`docs/current-state.md`](current-state.md) — 当前事实唯一入口
- [`docs/process.md`](process.md) — 开发流程与 PR 五档分级
- [`docs/api-surface-policy.md`](api-surface-policy.md) — API surface 长期边界
- [`docs/architecture-boundary.md`](architecture-boundary.md) — 架构边界 6 类抽离决策
- [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) — V2 基线规范
- [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) — A/B/C/D/E 五档红线
- [`docs/participation-bounded-context.md`](participation-bounded-context.md) — participation 业务上下文边界图
- [`docs/attachment-config-boundary.md`](attachment-config-boundary.md) — 附件配置三表边界
