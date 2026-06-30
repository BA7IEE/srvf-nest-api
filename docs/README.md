# docs/ — 文档地图

> 本目录是 SRVF API 的文档集合;**本文件是入口索引,不是规则源**。
> 当前事实读 [`current-state.md`](./current-state.md);长期铁律读根目录 [`../AGENTS.md`](../AGENTS.md)。

---

## 1. Active docs(当前生效,直接读)

| 文件 | 用途 |
|---|---|
| [`current-state.md`](./current-state.md) | **当前事实唯一入口**:版本、open PR、最新 release、surface 状态、当前债务、不做清单 |
| [`system-foundation-governance.md`](./system-foundation-governance.md) | **治理期入口 / 需求碰撞前置入口**(2026-05-23 启动):本阶段暂停项、G-1 ~ G-12 顶层规则缺口摘要、RCT 需求碰撞前置模板、Phase G0 → G4 治理路线图、退场条件 |
| [`process.md`](./process.md) | 开发流程与协作制度:开工 checklist、PR 五档分级、release 收口、AI 协作纪律 |
| [`api-surface-policy.md`](./api-surface-policy.md) | API surface 长期边界(active 单一权威源):Mobile App / Admin Legacy / Root Legacy 三层 + 新增/迁移规则;原设计期顶层规范 `api-client-boundary.md` 已归档至 `archive/plans/api-client-boundary-design-period.md` |
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
| [`ops/sms-production-rollout-checklist.md`](./ops/sms-production-rollout-checklist.md) | 运维侧腾讯云 SMS 真实通道上线 SOP(签名/模板审核 → 凭证录入 → 真实发送验收) |
| [`ops/sms-data-retention-sop.md`](./ops/sms-data-retention-sop.md) | SMS 数据 retention 手动清理 SOP(验证码 90 天 / 发送流水 1 年,数值可改;维护者手动 psql,**不**引入 cron 清理;SQL 已 app_test 实测冻结) |
| [`ops/wechat-mini-production-rollout-checklist.md`](./ops/wechat-mini-production-rollout-checklist.md) | 运维侧微信小程序登录真实通道上线 SOP(注册小程序 → AppID/AppSecret → admin 录凭证〔仅 SA〕→ DevStub 全链 → 真实验收;系统侧已"正确但休眠") |
| [`ai-harness/README.md`](./ai-harness/README.md) | **AI Harness 操作层单页**(derived,**非规则源**,与权威源冲突时让步;必读三件套之一):铁律速查表 / AI 修改三档 + 触发即停 / 全仓读写分区;同目录另两文件 = `RBAC_MAP.md`(权限地图,`docs:rbacmap:check` 守护)+ `NEXT_TASKS.md`(后续任务清单);2026-06-10 Review 冻结档见 `archive/ai-harness/` |
| [`reviews/org-position-scoped-authz-terminal-design-review.md`](./reviews/org-position-scoped-authz-terminal-design-review.md) | **T0 冻结稿(2026-07-01)**:终态「组织职务 + 分管关系 + scoped RBAC + 统一鉴权」架构评审稿;R1–R8 + BD-1–BD-4 全拍板,§11 给 PR1–PR12 落地序列。**design-only,实现以 `../prisma/schema.prisma` + `src/**` 为准**;落地中作活文档,全序列实施完成后归档至 `archive/reviews/` |

V2 设计期产物(V2-D8 立项时刻 draft 历史快照,**非当前事实权威源**):

> **当前字段 / 接口 / 错误码事实权威源 ≠ 本区块文档**;以下列三项为准:
> 1. **数据模型(字段 / 类型 / 约束 / 索引)** → [`../prisma/schema.prisma`](../prisma/schema.prisma)
> 2. **接口契约(路径 / DTO / 权限 / 错误码 schema)** → Swagger UI(`/api/docs`)+ [`../test/contract/openapi.contract-spec.ts`](../test/contract/openapi.contract-spec.ts) `EXPECTED_ROUTES` + OpenAPI snapshot
> 3. **长期 API surface 边界与新增 / 迁移规则** → [`api-surface-policy.md`](./api-surface-policy.md)
>
> [`v2-data-model.md`](./v2-data-model.md) / [`v2-api-contract.md`](./v2-api-contract.md) 是 V2-D8 立项(2026-05-07)时刻的设计快照;V2 第一阶段及后续批次实装后**正文未逐行回填**,阅读它们仅用于了解 V2 第一阶段最初的设计意图,**不能作为字段 / 接口 / 错误码的执行依据**。

| 文件 | 用途 |
|---|---|
| [`v2-data-model.md`](./v2-data-model.md) | V2-D8 立项时刻的数据模型 draft(覆盖 `dict_types` / `dict_items` / `organizations` / `members` / `member_departments` + `users.memberId` 追加)— **字段事实以 [`../prisma/schema.prisma`](../prisma/schema.prisma) 为准** |
| [`v2-api-contract.md`](./v2-api-contract.md) | V2-D8 立项时刻的 API 契约 draft(29 接口口径)— **接口事实以 Swagger UI(`/api/docs`)+ [`../test/contract/openapi.contract-spec.ts`](../test/contract/openapi.contract-spec.ts) + OpenAPI snapshot 为准** |
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
| [`archive/ai-harness/`](./archive/ai-harness/) | 2026-06-10 全仓 Review 总报告与 AI Harness 底座设计(冻结快照;旧操作层 9 文档 + 3 模板已于同日瘦身收口为 `ai-harness/README.md` 单页,文内相对链接属预期死链) |

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
