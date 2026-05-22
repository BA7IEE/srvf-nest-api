# docs/ — 文档地图

> 本目录是 SRVF API 的文档集合;**本文件是入口索引,不是规则源**。
> 当前事实读 [`current-state.md`](./current-state.md);长期铁律读根目录 [`../AGENTS.md`](../AGENTS.md)。

---

## 1. Active docs(当前生效,直接读)

| 文件 | 用途 |
|---|---|
| [`current-state.md`](./current-state.md) | **当前事实唯一入口**:版本、open PR、最新 release、surface 状态、当前债务、不做清单 |
| [`process.md`](./process.md) | 开发流程与协作制度:开工 checklist、PR 五档分级、release 收口、AI 协作纪律 |
| [`api-surface-policy.md`](./api-surface-policy.md) | API surface 长期边界:Mobile App / Admin Legacy / Root Legacy 三层 + 新增/迁移规则 |
| [`api-client-boundary.md`](./api-client-boundary.md) | 客户端边界顶层规范(Phase 0/1 设计意图、Surface × Module 分类原则) |
| [`participation-bounded-context.md`](./participation-bounded-context.md) | Participation 业务上下文边界图:`activities` / `activity-registrations` / `attendances` / `contribution-rules` 4 模块的状态链条、跨模块耦合、API surface 与 governance;**不**含 `certificates`(独立 member-qualifications 上下文) |
| [`attachment-config-boundary.md`](./attachment-config-boundary.md) | 附件配置三表(`AttachmentTypeConfig` / `AttachmentMimeConfig` / `AttachmentSizeLimitConfig`)的 override-with-default 边界说明:为什么不合表、为什么不抽 facade、新增规则落点 |
| [`architecture-boundary.md`](./architecture-boundary.md) | 架构边界铁律 / active architecture boundary policy for Presenter / QueryService / PolicyService / StateMachine / AuditRecorder / Effect extraction decisions;承接 `AGENTS.md §19.7 D-7` |
| [`srvf-foundation-baseline.md`](./srvf-foundation-baseline.md) | V2 派生项目基线规范(BizCode 段位 / 命名 / DTO / 软删除 / 验收门槛 13 项) |
| [`V2红线与复活路径.md`](./V2红线与复活路径.md) | V2 五档红线 A/B/C/D/E 与解锁触发条件 |
| [`security.md`](./security.md) | 已落地安全策略、软删除策略、token 吊销升级路径 |
| [`deployment.md`](./deployment.md) | Docker 镜像、生产部署、迁移流程 |
| [`development.md`](./development.md) | 项目结构 / 路由总览 / 环境变量 / 排错 |
| [`testing.md`](./testing.md) | E2E 测试运行与覆盖范围 |
| [`docker-smoke-test.md`](./docker-smoke-test.md) | docker smoke CI 形态说明 |
| [`ops/cos-production-rollout-checklist.md`](./ops/cos-production-rollout-checklist.md) | 运维侧真实 COS 上线 SOP |

V2 设计期产物(仍在使用,但属于"参考级"):

| 文件 | 用途 |
|---|---|
| [`srvf-foundation-research.md`](./srvf-foundation-research.md) | V2 调研报告(三档分类 A/B/C) |
| [`srvf-foundation-data-model-draft.md`](./srvf-foundation-data-model-draft.md) | V2 数据模型草案 |
| [`srvf-foundation-interview-brief.md`](./srvf-foundation-interview-brief.md) | V2 业务访谈提纲 |
| [`v2-plan.md`](./v2-plan.md) | V2 第一阶段开发执行计划(Step 1-7 已完成) |
| [`v2-data-model.md`](./v2-data-model.md) | V2 第一阶段数据模型说明 |
| [`v2-api-contract.md`](./v2-api-contract.md) | V2 第一阶段接口契约(完整字段 / 错误码 / 权限矩阵) |
| [`srvf-business-docs.md`](./srvf-business-docs.md) | 外部业务文档库路径索引(不在本仓库内) |

---

## 2. Archived docs(归档,仅作历史证据)

`docs/archive/**` 内的文档**只代表归档时刻的决议**,不再作为当前执行约束:

| 目录 | 内容 |
|---|---|
| [`archive/handoff/`](./archive/handoff/) | 历史 release handoff(v0.4.0 ~ v0.15.0),release 时刻快照,**合入后不回改** |
| [`archive/reviews/`](./archive/reviews/) | 历史评审稿:App API Phase 2(P2-2~P2-7)/ Phase 0.5/0.6/0.7 boundary review / Phase 1 client-boundary review / P0-D/P0-E/P0-F 评审稿 |
| [`archive/batches/`](./archive/batches/) | 批次 5-A / 6 / 7 / 8 的 API 前评审、业务确认稿、业务访谈提纲、V2.x 立项记录(中文文件名) |
| [`archive/plans/`](./archive/plans/) | 历史阶段计划:v1.3 / v1.4 / first-release readiness / bizcode mapping / bootstrap SOP / frontend scope / API client boundary migration plan |
| [`archive/legacy/`](./archive/legacy/) | 自承"历史归档"的早期收尾报告(`FINAL_REPORT.md`) |

---

## 3. How to decide authority

冲突时按以下顺序判定:

1. **当前事实** → [`current-state.md`](./current-state.md)
2. **长期铁律** → [`../AGENTS.md`](../AGENTS.md) + [`srvf-foundation-baseline.md`](./srvf-foundation-baseline.md) + [`V2红线与复活路径.md`](./V2红线与复活路径.md) + [`api-surface-policy.md`](./api-surface-policy.md)
3. **流程** → [`process.md`](./process.md)
4. **架构设计背景** → [`../ARCHITECTURE.md`](../ARCHITECTURE.md)(请先读其顶部"当前阶段说明")
5. **历史证据** → [`archive/**`](./archive/)

`archive/**` 内的任一文档,只有在 (1)~(4) 都未覆盖某具体场景时,才作为辅助参考。

---

## 4. What NOT to read as current truth

- ❌ `archive/handoff/v*.md`:已合入的 release 历史快照,字段、状态、PR 编号都冻结在 release 时刻;**当前版本状态以 [`current-state.md`](./current-state.md) §1 为准**
- ❌ `archive/reviews/**`:评审稿在被实施落地后,**实施细节会演进**(BizCode 段位补全、字段命名调整、限流参数调整);**实际代码以 `src/**` 为准**
- ❌ `archive/batches/**`:各批次冻结时刻的业务决议;**业务诉求若发生变化,需通过新的评审稿覆盖**
- ❌ `archive/plans/**`:阶段开始前的执行计划;**实际执行可能偏离计划**
- ❌ `archive/legacy/FINAL_REPORT.md`:v0.1.3 时代的收尾报告;**与当前 v0.15.0 状态无关**

---

## 5. 增删文档原则

- 新增"当前生效"文档:**必须**在本文件 §1 列出,且必须明确"用途"与"权威等级"
- 新增"归档"文档:直接放入对应 `archive/<分类>/`,本文件 §2 无需逐文件列出(查 `ls archive/<dir>/` 即可)
- 删除文档:**禁止**;只允许移动到 `archive/` 子目录
- 把归档文档"复活"回 `docs/` 活跃位置:**必须**单独立项并更新本文件 §1 / §2
