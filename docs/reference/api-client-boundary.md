# API Client Boundary:设计纪律与决策锁全文(reference · 触碰才读)

> Harness 2.0 细则层:承接 harness v1 `AGENTS.md` §18 / §19 / §21 **原文逐字搬家(零放宽;唯一机械改写=相对链接前缀)**;恒读入口与速查见根 [`AGENTS.md`](../../AGENTS.md),原文快照 [`archive/harness-v1/AGENTS.md`](../archive/harness-v1/AGENTS.md)。
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
> `CLAUDE.md` 自 v0.15.0 起已收口为入口 / 路由文件,不再镜像本节;长期决策以本 `AGENTS.md §19.7` 为权威源。

**D-1**:`contribution-rules` 客户端边界归 **System**(2026-05-19 拍板;详 [`api-client-boundary-inventory.md §2.25`](../archive/reviews/api-client-boundary-inventory.md))。目标路径 `/api/system/v1/contribution-rules/*`;普通 ADMIN 如需使用通过 `contribution-rule.*` 权限点明确授权,**不**归 Admin API。

**D-2**:Phase 3 路径策略 = **方案 C**(`/api/v2/*` 长期保留为 Admin Legacy;2026-05-19 拍板;详 [`api-client-boundary-migration-plan.md §5`](../archive/plans/api-client-boundary-migration-plan.md))。旧 `/api/v2/*` **不**主动 deprecated / **不**强制迁移 / **不**做大面积老接口双写;新 App API 默认 `/api/app/v1/*` / 新 System API 默认 `/api/system/v1/*` / 新 Admin API 默认 `/api/admin/v1/*`;PC 管理后台联调口径**不**因 Phase 3 破坏。
> ⚠️ **2026-06-01 已重开并被 §21 D-9 取代**:用户主动要求重开本条(已按本节 preamble"暂停说明后再讨论"履行),拍板放弃"方案 C",改为 **Route B 全量物理迁移**。**本条"不强制迁移 / 不做大面积双写"自 2026-06-01 起不再作为执行约束**;新 App / System / Admin 默认前缀的部分仍有效。当前执行权威源:§21 D-9 + [`docs/api-surface-migration-plan.md`](../api-surface-migration-plan.md)。D-1 / D-3 ~ D-8 不受影响。

**D-3**:Phase 1 拆分 = **1A(Tag 改名)+ 1B(Public/Auth path alias)两个独立 PR**(2026-05-19 评审稿;详 [`api-client-boundary-phase-1-review.md`](../archive/reviews/api-client-boundary-phase-1-review.md))。Phase 1 整体为 **C 档**(非 A 档 docs-only),1A 与 1B 各自单独走 C 档验收;AI **禁止**自行启动 Phase 1A / 1B 代码改造,必须用户在 [`docs/process.md`](../process.md) 流程内单独立项。

**D-4**:Phase 0.5 App 身份 / 权限 / 数据可见性专项评审是 **Phase 2 启动的硬前置**(2026-05-19 立项;详 [`app-permission-boundary-review.md`](../archive/reviews/app-permission-boundary-review.md))。Phase 2 立项评审稿启动前,业务方**必须**先决议该专项 §10.1 标记 ✅ 阻塞的事项(候选 / 临时编号 App 登录策略、Admin 兼队员 `/me` 行为、`/me/permissions` 返 capability vs permission code、`me/*` 与 `my/*` 是否拆等);AI **禁止**在没有该专项决议结果的情况下启动 Phase 2 任何 P0 接口代码实施;该专项**不**改 schema / migration / Role enum / Permission seed / 任何 endpoint / 任何 DTO,严格沿 §19.1 设计期硬禁止。

**D-5**:App permission decisions locked before Phase 2(详 [`app-permission-boundary-review.md §10.2`](../archive/reviews/app-permission-boundary-review.md)):
- **D-5.1**:Candidate / temporary-number volunteers **out of App login scope**;App APIs only support users with `User.memberId != null` AND `User.status = ACTIVE` AND `User.deletedAt IS NULL` AND `Member.status = ACTIVE`
- **D-5.2**:Admin-as-member uses **linked-member self perspective**;`ADMIN` / `SUPER_ADMIN` 角色**不**扩大 AppSelf 字段可见性;account without `memberId` → `canUseApp = false`
- **D-5.3**:App `GET /api/app/v1/me/capabilities` 返 product-level capabilities(`canUseApp` / `canRegisterActivity` 等),**禁止** raw RBAC permission codes;capabilities **不是**授权证明,后端每个写端点必须重做授权校验;**禁止 reintroduce** `/api/app/v1/me/permissions` as raw RBAC code endpoint
- **D-5.4**:`/me/*`(identity / account / profile / capability)与 `/my/*`(business records owned by current member)**physically separated** in path segments

**D-6**:Data access and lifecycle boundary is a Phase 2 precondition(详 [`app-permission-boundary-review.md`](../archive/reviews/app-permission-boundary-review.md) + [`data-access-lifecycle-boundary-review.md`](../archive/reviews/data-access-lifecycle-boundary-review.md))。Agents **不得**:reuse Admin DTOs(`extends` / `Pick` / `Omit` 构造 App DTO 视作越权);assume `Role.USER` equals "mobile access"(Admin 兼队员也走 App self perspective);Mobile endpoint 内默认 `scope = all`(Mobile 默认 `scope = self`);跳过状态机校验直接执行写动作;响应 DTO 中暴露 **L3 Credential** 字段(`passwordHash` / `refreshToken` / `tokenHash` / `secretKey*` / `secretId*` / 完整 signed URL)— snapshot 测试出现直接拒合并。

**D-7**:Code architecture boundary before App API implementation(详 [`code-architecture-boundary-review.md`](../archive/reviews/code-architecture-boundary-review.md);active execution policy 见 [`docs/architecture-boundary.md`](../architecture-boundary.md))。Agents **不得**继续把 surface-specific DTO / scope / field masking / state transition / export / audit / effect 逻辑直接堆进大 service 而不先识别 6 类抽离边界:**Presenter**(entity → DTO/View + FieldPolicy)/ **QueryService**(读 + scope + 分页;Mobile 默认 `scope = self`)/ **PolicyService**(业务合法性,**不**塞 `rbac.can(...)`)/ **StateMachine**(显式 transition,**不**零散 if/else)/ **AuditRecorder**(统一审计 + mask 敏感字段)/ **Effect / Workflow**(post-commit 副作用,**不**和主交易混)。**不要求**立即大规模重构(`attendances.service.ts` 1413 LOC 等不动),要求新工作 **boundary-aware**;Refactor Triggers:新 mobile endpoint → 新 Mobile Controller + App DTO + Presenter;新高敏字段 → 同步 FieldPolicy;新导出 → ExportService + AuditRecorder;新审批状态 → StateMachine;新 scope → ScopeResolver + QueryService;新通知 / 短信 → Effect / Workflow。

**D-8**:Phase 2 App API implementation requires Phase 2 review(详 [`app-api-phase-2-review.md`](../archive/reviews/app-api-phase-2-review.md) + Phase 0.5/0.6/0.7 评审稿)。Agents **不得**实现 Phase 2 endpoints from [`api-client-boundary-migration-plan.md §4.1`](../archive/plans/api-client-boundary-migration-plan.md) 旧 11-endpoint list 而不应用 Phase 0.5/0.6/0.7 决策。关键约束:`/me/permissions` → `/me/capabilities`(沿 D-5.3);`/me/*` 与 `/my/*` 物理分离(沿 D-5.4);App DTOs **不得** reuse Admin DTOs(沿 D-6;`extends` / `Pick` / `Omit` / `IntersectionType` / `PartialType` / `OmitType` 视作越权);Mobile scope defaults to `self`(沿 D-6;App where 子句永远 `currentUser.memberId` 锁定本人,**禁止**用 `role` 短路);L3 字段(`passwordHash` / `refreshToken` / `tokenHash` / `secretKey*` / `secretId*` / 完整 signed URL)**永远不返回**(snapshot 测试出现直接拒合并)。Phase 2 实施按 [`app-api-phase-2-review.md §8.1`](../archive/reviews/app-api-phase-2-review.md) P2-0 ~ P2-7 串行;agents **禁止**自行启动 P2-N,必须用户在 [`docs/process.md`](../process.md) 流程内逐个立项。

**违反铁律**:发现本节决策与新任务诉求冲突 → **必须暂停说明**,不擅自调和;不主动建议"重新评估方案 A/B"或"把 contribution-rules 改归 Admin"等回滚动作。


## 21. API Surface 全量迁移决策(Route B;承接并取代 §19.7 D-2)

> 本节是 §19.7 决策锁的**后续层**:沿 §19 开头"新增'客户端边界执行铁律'应**新增 §20+,不修订本节(§19)**"的 append-only 规则;§20 已被"Git 安全"占用,故顺延至本节。**D-series 编号在本节延续**(D-9),保持与 §19.7 D-1 ~ D-8 的交叉引用连续性。
> 2026-06-01 用户主动要求重开 §19.7 D-2(已按 §19.7 preamble"暂停说明本节存在后再讨论"履行),拍板放弃"方案 C(`/api/v2/*` 长期保留)",改为 **Route B 全量物理迁移**。

**D-9(2026-06-01 拍板;取代 D-2 的"不迁移"部分)**:API surface 改为**按客户端 / 使用场景四分 + 预留开放平台**:

| Surface | 前缀 | 用途 |
|---|---|---|
| Admin | `/api/admin/v1/*` | 管理后台 / 运维后台业务 |
| App | `/api/app/v1/*` | App / 小程序 / 队员端(**已建成,不迁移**) |
| Auth | `/api/auth/v1/*` | 登录 / 刷新 / 登出 / 认证会话 |
| System | `/api/system/v1/*` | 健康检查 / 运行状态 / 系统元信息 / ops 配置(承接 D-1 `contribution-rules` → System) |
| Open | `/api/open/v1/*` | **首用(2026-06-18 招新一期 T3)**:无账号公开 surface(`@Public`;首落地 = 招新报名提交/查询);**2026-06-21 CMS 第二用** = 内容公开列表/详情(`open/v1/contents`);第 5 canonical 前缀,执行细节以 [`docs/api-surface-policy.md §0`](../api-surface-policy.md) 为准 |

存量 `/api/v2/*` / `/api/auth/*` / `/api/users/*` / `/api/health/*` **将按 alias → 灰度 → deprecate → 删除分阶段全量迁移**(取代 D-2 的"不强制迁移 / 不做大面积老接口双写")。执行细节、逐 endpoint 归属、阶段顺序、回退条件以 active 权威源 [`docs/api-surface-migration-plan.md`](../api-surface-migration-plan.md) + [`docs/api-surface-policy.md §0`](../api-surface-policy.md) 为准。

约束:
- 迁移是 **D 档**:严格分阶段、分 PR、串行;每阶段先评审稿冻结再动代码;AI **禁止**自行启动任一阶段代码改造,必须用户逐阶段立项(沿 [`docs/process.md §4`](../process.md))。
- **alias 阶段只加不删**(老 + 新 path 并存),保证零破坏;删除老 path 只能在 deprecation 窗口 ≥ 2 release + 前端/移动端切流确认 + 单独公告后执行。
- **D-1**(`contribution-rules` → System)、**D-3** Phase 1A(Tag 改名,已完成)、**D-4 ~ D-8**(App 身份/权限/DTO/数据访问/架构边界)**继续完全有效**,本节不触碰;raw permission code ≠ app capability(D-5.3)在迁移中继续保持。
- 灰区归属(audit-logs / storage / RBAC 系 / dictionaries / attachment-configs 归 Admin 还是 System)由迁移计划 Phase 0 产出映射表并经用户签字冻结,本节**不**预先拍板。
