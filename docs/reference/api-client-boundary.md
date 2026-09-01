# API Client Boundary:设计纪律与决策锁全文(reference · 触碰才读)

> Harness 2.0 细则层:承接 harness v1 `AGENTS.md` §18 / §19 / §21,并按后续已拍板终态 true-up;恒读入口与速查见根 [`AGENTS.md`](../../AGENTS.md),原文快照 [`archive/harness-v1/AGENTS.md`](../archive/harness-v1/AGENTS.md)。
> 机器锁定:contract CANONICAL_PREFIXES 断言 + L3 字段快照拒合;决策锁重开须先暂停声明。

## 18. V2 设计纪律(当前仍有效部分)

V2 早期调研 / 设计阶段过程性约束(原 §18.1 / §18.2 / §18.3 / §18.5 / §18.6 / §18.7)已随批次 5-A / 6 / 7 / 8 + P0-* 落地完成其阶段使命,原文已归档至 [`docs/archive/legacy/agents-historical-design-period.md`](../archive/legacy/agents-historical-design-period.md)。下列子节(§18.4 / §18.4.1)是**长期仍生效**的设计纪律,保留原小节编号,以本节为权威源,适用任何 AI Agent / 自动化工具(不限工具链)。

### 18.4 协作纪律与敏感信息字段三问(精简自原 §18.4)

- **敏感信息字段三问**:涉及身份证 / 紧急联系人 / 医疗 / 证件照等敏感字段,**纳入任何 schema / DTO / 草案之前**必须先单独回答三问 ——
  1. **业务用途**:服务于哪个具体业务流程?
  2. **查看角色**:哪些角色 / 权限点可见?默认掩码策略是什么?
  3. **保存期限**:保留多久?是否需要"队员退队 → 清理"的处理?

  任何"先占位以后再用 / 先存着规则以后补"在敏感字段场景下视作越权。
- **不假设合规方案**:涉及敏感字段必须单独提问,不假设默认合规方案。
- **字典 seed 真实内容**:由用户**私下提供**,不进公共仓库历史。
- **冲突暂停铁律**:发现 v1 / V1.1 铁律 / baseline / V2 红线与新诉求冲突 → **必须暂停说明**,不擅自调和。

### 18.4.1 baseline 规范的强制读取与遵守

任何 Agent 在 V2 草案 / 开发场景下动手之前,**必须**读取并遵守 [`docs/srvf-foundation-baseline.md`](../srvf-foundation-baseline.md)(自 commit `16876fe` 起锁定)承载的 13 项 A 档基线规范(BizCode 段位 / 命名 / 响应包装 / DTO 白名单 / 模块结构 / 错误码命名 / 配置归属 / 日志屏蔽 / Guard / 软删除 / v1 兼容性 / 时区 / 验收门槛)。

冲突优先级见 baseline §14.4。**违反 baseline 任一项视作越权**,必须暂停并向用户说明,**禁止**自行调和。


## 19. API Client Boundary 决策锁

API Client Boundary 设计期(Phase 0)过程性约束(原 §19.1 ~ §19.6)已随 Phase 0 设计期 + Phase 1A Swagger Tag 重命名(v0.15.0)+ Phase 2 完整 15 endpoint(P2-0 ~ P2-8)落地完成其阶段使命,原文已归档至 [`docs/archive/legacy/agents-historical-design-period.md`](../archive/legacy/agents-historical-design-period.md)。当前 API surface 长期边界以 [`docs/api-surface-policy.md`](../api-surface-policy.md) 为准(归档的设计期顶层规范 `docs/api-client-boundary.md` 已迁至 [`docs/archive/plans/api-client-boundary-design-period.md`](../archive/plans/api-client-boundary-design-period.md));冲突优先级见 §18.4.1 / [`docs/srvf-foundation-baseline.md §14.4`](../srvf-foundation-baseline.md)。

§19.7 D-1 ~ D-8 是用户已拍板的**长期决策锁**,**未归档**,仍以本节为权威源。后续若需新增"客户端边界执行铁律",应**新增** §20+,**不**修订本节(§19)。

### 19.7 已锁定决策(不再重开讨论)

> 本子节记录 2026-05-19 设计期 v0 + Phase 1 评审稿轮中**用户已拍板**的决策。
> AI 在未来会话中**禁止**重新质疑、重新评估、或建议变更以下决策;若用户主动要求重开,**必须**先暂停说明本节存在再讨论。
> `CLAUDE.md` 自 v0.15.0 起已收口为入口 / 路由文件,不再镜像本节;长期决策以本文件 §19.7 + 根 [`AGENTS.md §2`](../../AGENTS.md) 为权威入口。

**D-1**:`contribution-rules` 客户端边界归 **System**(2026-05-19 拍板;详 [`api-client-boundary-inventory.md §2.25`](../archive/reviews/api-client-boundary-inventory.md))。目标路径 `/api/system/v1/contribution-rules/*`;普通 ADMIN 如需使用通过 `contribution-rule.*` 权限点明确授权,**不**归 Admin API。

**D-2**:Phase 3 路径策略 = **方案 C**(`/api/v2/*` 长期保留为 Admin Legacy;2026-05-19 拍板;详 [`api-client-boundary-migration-plan.md §5`](../archive/plans/api-client-boundary-migration-plan.md))。旧 `/api/v2/*` **不**主动 deprecated / **不**强制迁移 / **不**做大面积老接口双写;新 App API 默认 `/api/app/v1/*` / 新 System API 默认 `/api/system/v1/*` / 新 Admin API 默认 `/api/admin/v1/*`;PC 管理后台联调口径**不**因 Phase 3 破坏。
> ⚠️ **2026-06-01 已重开并被 D-9 取代**:用户主动要求重开本条(已按本节 preamble"暂停说明后再讨论"履行),拍板放弃"方案 C",改为 **Route B 全量物理迁移**。**本条"不强制迁移 / 不做大面积双写"自 2026-06-01 起不再作为执行约束**;新 App / System / Admin 默认前缀的部分仍有效。当前执行权威源:根 [`AGENTS.md §2 D-9`](../../AGENTS.md) + [`api-surface-policy.md §0`](../api-surface-policy.md)；[`api-surface-migration-plan.md`](../api-surface-migration-plan.md) 仅保留签字映射与实施记录。D-1 / D-3 ~ D-8 不受影响。

**D-3**:Phase 1 拆分 = **1A(Tag 改名)+ 1B(Public/Auth path alias)两个独立 PR**(2026-05-19 评审稿;详 [`api-client-boundary-phase-1-review.md`](../archive/reviews/api-client-boundary-phase-1-review.md))。Phase 1 整体为 **C 档**(非 A 档 docs-only),1A 与 1B 各自单独走 C 档验收;AI **禁止**自行启动 Phase 1A / 1B 代码改造,必须用户在 [`docs/process.md`](../process.md) 流程内单独立项。

**D-4**:Phase 0.5 App 身份 / 权限 / 数据可见性专项评审是 **Phase 2 启动的硬前置**(2026-05-19 立项;详 [`app-permission-boundary-review.md`](../archive/reviews/app-permission-boundary-review.md))。Phase 2 立项评审稿启动前,业务方**必须**先决议该专项 §10.1 标记 ✅ 阻塞的事项(候选 / 临时编号 App 登录策略、Admin 兼队员 `/me` 行为、`/me/permissions` 返 capability vs permission code、`me/*` 与 `my/*` 是否拆等);AI **禁止**在没有该专项决议结果的情况下启动 Phase 2 任何 P0 接口代码实施;该专项**不**改 schema / migration / Role enum / Permission seed / 任何 endpoint / 任何 DTO,严格沿 §19.1 设计期硬禁止。

**D-5**:App permission decisions locked before Phase 2(详 [`app-permission-boundary-review.md §10.2`](../archive/reviews/app-permission-boundary-review.md)):
- **D-5.1**:Candidate / temporary-number volunteers **out of App login scope**;App APIs only support users with `User.memberId != null` AND `User.status = ACTIVE` AND `User.deletedAt IS NULL` AND `Member.status = ACTIVE`
- **D-5.2**:Admin-as-member uses **linked-member self perspective**;`ADMIN` / `SUPER_ADMIN` 角色**不**扩大 AppSelf 字段可见性;account without `memberId` → `canUseApp = false`
- **D-5.3**:App `GET /api/app/v1/me/capabilities` 返 product-level capabilities(`canUseApp` / `canRegisterActivity` 等),**禁止** raw RBAC permission codes;capabilities **不是**授权证明,后端每个写端点必须重做授权校验;**禁止 reintroduce** `/api/app/v1/me/permissions` as raw RBAC code endpoint
- **D-5.4**:`/me/*`(identity / account / profile / capability)与 `/my/*`(business records owned by current member)**physically separated** in path segments

**D-6**:Data access and lifecycle boundary is a Phase 2 precondition(详 [`app-permission-boundary-review.md`](../archive/reviews/app-permission-boundary-review.md) + [`data-access-lifecycle-boundary-review.md`](../archive/reviews/data-access-lifecycle-boundary-review.md))。Agents **不得**:reuse Admin DTOs(`extends` / `Pick` / `Omit` 构造 App DTO 视作越权);assume `Role.USER` equals "mobile access"(Admin 兼队员也走 App self perspective);Mobile endpoint 内默认 `scope = all`(Mobile 默认 `scope = self`);跳过状态机校验直接执行写动作;响应 DTO 中暴露 **L3 Credential** 字段(`passwordHash` / `refreshToken` / `tokenHash` / `secretKey*` / `secretId*` / 完整 signed URL)— snapshot 测试出现直接拒合并。**唯一范围例外(a)**:content-image/content-file 的短 TTL signed URL 可在 open/app 内容读面通过文章可见级后返回;其余 owner 与写面不变,详 [`api-surface-policy.md §9.6`](../api-surface-policy.md)。

**D-7**:Code architecture boundary before App API implementation(详 [`code-architecture-boundary-review.md`](../archive/reviews/code-architecture-boundary-review.md);active execution policy 见 [`docs/architecture-boundary.md`](../architecture-boundary.md))。Agents **不得**继续把 surface-specific DTO / scope / field masking / state transition / export / audit / effect 逻辑直接堆进大 service 而不先识别 6 类抽离边界:**Presenter**(entity → DTO/View + FieldPolicy)/ **QueryService**(读 + scope + 分页;Mobile 默认 `scope = self`)/ **PolicyService**(业务合法性,**不**塞 `rbac.can(...)`)/ **StateMachine**(显式 transition,**不**零散 if/else)/ **AuditRecorder**(统一审计 + mask 敏感字段)/ **Effect / Workflow**(post-commit 副作用,**不**和主交易混)。**不要求**立即大规模重构(`attendances.service.ts` 1413 LOC 等不动),要求新工作 **boundary-aware**;Refactor Triggers:新 mobile endpoint → 新 Mobile Controller + App DTO + Presenter;新高敏字段 → 同步 FieldPolicy;新导出 → ExportService + AuditRecorder;新审批状态 → StateMachine;新 scope → ScopeResolver + QueryService;新通知 / 短信 → Effect / Workflow。

**D-8**:Phase 2 App API implementation requires Phase 2 review(详 [`app-api-phase-2-review.md`](../archive/reviews/app-api-phase-2-review.md) + Phase 0.5/0.6/0.7 评审稿)。Agents **不得**实现 Phase 2 endpoints from [`api-client-boundary-migration-plan.md §4.1`](../archive/plans/api-client-boundary-migration-plan.md) 旧 11-endpoint list 而不应用 Phase 0.5/0.6/0.7 决策。关键约束:`/me/permissions` → `/me/capabilities`(沿 D-5.3);`/me/*` 与 `/my/*` 物理分离(沿 D-5.4);App DTOs **不得** reuse Admin DTOs(沿 D-6;`extends` / `Pick` / `Omit` / `IntersectionType` / `PartialType` / `OmitType` 视作越权);Mobile scope defaults to `self`(沿 D-6;App where 子句永远 `currentUser.memberId` 锁定本人,**禁止**用 `role` 短路);L3 字段默认不返回,仅沿 D-6 范围例外(a)允许 content-* 读面短 TTL signed URL。Phase 2 实施按 [`app-api-phase-2-review.md §8.1`](../archive/reviews/app-api-phase-2-review.md) P2-0 ~ P2-7 串行;agents **禁止**自行启动 P2-N,必须用户在 [`docs/process.md`](../process.md) 流程内逐个立项。

**违反铁律**:发现本节决策与新任务诉求冲突 → **必须暂停说明**,不擅自调和;不主动建议"重新评估方案 A/B"或"把 contribution-rules 改归 Admin"等回滚动作。


## 21. API Surface 全量迁移决策(Route B;承接并取代 §19.7 D-2)

> 本节是 §19.7 决策锁的**后续层**:沿 §19 开头"新增'客户端边界执行铁律'应**新增 §20+,不修订本节(§19)**"的 append-only 规则;§20 已被"Git 安全"占用,故顺延至本节。**D-series 编号在本节延续**(D-9),保持与 §19.7 D-1 ~ D-8 的交叉引用连续性。
> 2026-06-01 用户主动要求重开 §19.7 D-2(已按 §19.7 preamble"暂停说明本节存在后再讨论"履行),拍板放弃"方案 C(`/api/v2/*` 长期保留)",改为 **Route B 全量物理迁移**。

**D-9(2026-06-01 拍板;取代 D-2 的"不迁移"部分;2026-06-18 Open 首用、2026-08-30 Integration Foundation v1 PR6 首用后终态 true-up)**:API surface 固定为 **6 个 canonical surface**:

| Surface | 前缀 | 用途 |
|---|---|---|
| Admin | `/api/admin/v1/*` | 管理后台 / 运维后台业务 |
| App | `/api/app/v1/*` | App / 小程序 / 队员端(**已建成,不迁移**) |
| Auth | `/api/auth/v1/*` | 登录 / 刷新 / 登出 / 认证会话 |
| System | `/api/system/v1/*` | 健康检查 / 运行状态 / 系统元信息 / ops 配置(承接 D-1 `contribution-rules` → System) |
| Open | `/api/open/v1/*` | **首用(2026-06-18 招新一期 T3)**:无账号公开 surface(`@Public`;首落地 = 招新报名提交/查询);**2026-06-21 CMS 第二用** = 内容公开列表/详情(`open/v1/contents`);第 5 canonical 前缀,执行细节以 [`docs/api-surface-policy.md §0`](../api-surface-policy.md) 为准 |
| Integration | `/api/integration/v1/*` | **首用(2026-08-30 Integration Foundation v1 PR6)**:外部系统机器调用面,只接受显式 Service / Delegated principal;第 6 canonical 前缀,执行细节以 [`docs/api-surface-policy.md §0`](../api-surface-policy.md) 为准 |

存量 `/api/v2/*` / `/api/auth/*` / `/api/users/*` / `/api/health/*` **已按 alias → 灰度 → deprecate → 删除完成全量迁移**(取代 D-2 的"不强制迁移 / 不做大面积老接口双写")。当前归属以 [`api-surface-policy.md §0`](../api-surface-policy.md) 为准；逐 endpoint 签字映射、阶段顺序与回退记录保留在 [`api-surface-migration-plan.md`](../api-surface-migration-plan.md)。

约束:
- Route B 迁移已按 **D 档**分阶段完成;未来若重开既有 endpoint 的 surface 重归类、path 迁移 / alias / deprecate / removal,仍须 D 档单独立项(沿 [`api-surface-policy.md §2.4`](../api-surface-policy.md))。
- **alias 只加不删 + deprecation 窗口 ≥ 2 release**是本轮迁移实施期已履行的历史约束,不是恢复 legacy alias 的授权;当前禁止恢复已删除老 path。
- **D-1**(`contribution-rules` → System)、**D-3** Phase 1A(Tag 改名,已完成)、**D-4 ~ D-8**(App 身份/权限/DTO/数据访问/架构边界)**继续完全有效**,本节不触碰;raw permission code ≠ app capability(D-5.3)在迁移中继续保持。
- 灰区归属已由迁移计划 Phase 0 映射表经用户签字冻结:audit-logs / storage / RBAC 系 / dictionaries / attachment-configs 均归 System;当前执行见 [`api-surface-policy.md §0`](../api-surface-policy.md),常规 PR 不得重归类。

## 22. Activity OS 的 Integration 与 AI Assist 执行审查

本节是 T0-B 的执行清单，不重开 §19 的已锁定决策，也不改变
[`api-surface-policy.md`](../api-surface-policy.md) 作为 surface 归属的唯一权威源。当前没有
因此新增任何 Integration 业务端点。

### 22.1 新 Integration endpoint 的逐项矩阵

每个新增或放宽的 `/api/integration/v1/*` endpoint 必须在评审稿和实现 PR 中各有一行，
十列全部非空；不能用“沿用现有端点”省略任一列。

| endpoint | principal admission | permission code | servicePrincipalAllowed | delegatedAccessAllowed | allowed scope | resource target resolver | idempotency operation | audit event | sensitive fields |
|---|---|---|---|---|---|---|---|---|---|
| `<method + path>` | `Service only` / `Delegated only` / 明确两者规则 | `<code>` | `true / false` | `true / false` | `GLOBAL / ORGANIZATION / ...` | 由服务端如何从可信输入解析目标 | `read-only` 或已注册 operation | `<event>` | 字段分级、掩码与禁传说明 |

审查时逐项确认：

1. Service Principal 使用的权限已显式 `servicePrincipalAllowed=true`；Delegated 再要求
   `delegatedAccessAllowed=true`，并且 permission 在 Grant allowlist 内。
2. User 当前 Authz、Service Principal direct RoleBinding、Grant scope 与 SP scope 都覆盖
   服务端解析的目标；任一主体、Credential、Binding 或 Grant 失效后，下一请求立即拒绝。
3. 创建类命令不信任调用方自填 target：先验证组织等输入，再由服务端构造授权目标，最后才
   进入业务事务。
4. 写命令有 `Idempotency-Key`、已注册 operation、覆盖业务输入与 Delegated 语义的 request
   hash，以及同一事务内的领域写、receipt 与最小响应快照。
5. 审计复用规范化 request-id、可信客户端 IP、principal、on-behalf-of user、operation 与
   BizCode；日志和审计不得写 Token、Client Secret、Secret hash、完整 Prompt、完整响应
   或 Idempotency-Key。
6. 需要敏感字段时，先完成敏感字段三问；默认不得将原始报名答案、证件、医疗信息、精确
   轨迹、Token、Secret 或 signed URL 交给 Integration 调用方或模型。

### 22.2 Direct、Delegated 与唯一 Gate

| 场景 | 允许 principal | 规则 |
|---|---|---|
| 公开参考目录、模板元数据、非人化探针 | Service Token | 仍需 direct RoleBinding 与 scope；只读不等于免授权。 |
| 代表负责人创建或修改活动草稿 | Delegated Token | 三腿授权、服务端 target 解析和幂等全部成立。 |
| 正式发布、时长终审、贡献调整、账本更正 | 默认 Human 流程 | 首批 Integration 不开放；以后逐端点评审，不可由 Service Token 冒充真人。 |

`INTEGRATION_API_ENABLED` 是唯一 Integration 业务 Gate。不得以 Activity、AI Assist 或单个
endpoint 为名新增第二个半开关；渐进开放依靠端点是否存在、显式 permission eligibility、
最小 RoleBinding、Grant allowlist 和 scope。异常总止损统一关闭该 Gate。

### 22.3 AI Assist 不是 Human API 的旁路

人机协作 UI 由真人调用 Human API；外部 Agent 只调用 Integration API，代人动作只能使用
Delegated Token。AI Assist 只能调用明确的 Application Facade，不能直接访问数据库或进入
核心事务；每项 Assist 能力必须保留完整的手工等价业务路径。其核心依赖禁止由红区裁判
[`scripts/check-ai-dependency-boundary.ts`](../../scripts/check-ai-dependency-boundary.ts) 持续检查，
并由 [`src/ai-dependency-boundary.criteria.spec.ts`](../../src/ai-dependency-boundary.criteria.spec.ts)
接入既有 unit runner。
