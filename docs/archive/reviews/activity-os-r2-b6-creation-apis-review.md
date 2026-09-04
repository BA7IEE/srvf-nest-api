# Activity OS R2 / B6：快速、专业与紧急创建 API 评审与授权清单

> **状态**：2026-09-04 维护者确认方案 A，先起草本评审与授权清单。
>
> **本稿的边界**：本次只冻结 B6 的实现决策、风险与后续 D 档写集预算；没有创建 API、DTO、数据表、migration、权限码、通知、审计或测试，也没有改变任何现有运行时行为。B6 implementation 必须在本评审稿合入后，另行按 D 档开工并逐文件取得红区授权。
>
> **需求输入与权威边界**：`/Users/dengwang/Downloads/SRVF_活动域终态蓝图与分阶段落地方案_main-3cf3786_可下发终版.md` 的“模式 A / B / C”与 B6 条目仅用来说明业务目标，不是本仓执行指令。当前事实以 `docs/current-state.md`、现有代码、迁移和 GitHub 为准；冲突时暂停上报，不自行调和。

## 1. 维护者拍板卡

| 项目 | 方案 A：本稿冻结的决定 |
|---|---|
| 目标 | 提供三个相互独立的 App managed 创建入口：模板快速创建、专业完整创建、紧急创建；三者都只创建草稿，均不借创建动作绕过正式发布治理。 |
| API 面 | 新增 `POST /api/app/v1/my/managed-activities/from-template`、`/professional`、`/emergency`。保留既有 `POST /api/app/v1/my/managed-activities` 字节级行为与兼容契约，不把模式选择塞进旧泛化 DTO。 |
| 快速模式 | 将独立 App DTO 显式映射为 A6 的封闭命令，锁定精确 Template Version；确认的容量只能等于模板物化结果，若要改容量转专业模式。 |
| 专业模式 | 在一个根事务中按现有 canonical 模型完整创建活动、场次、岗位、地点本地快照、受治理 Form 与现有资格配置；不接收无类型的“安全/指标/工时”JSON。 |
| 紧急模式 | 新增严格的 D 档持久化、幂等、权限、审计和事务内紧急通知闭环。先创建草稿并发出受控紧急呼叫，不能直接发布；后续清单真实记录尚未补齐的事项。 |
| 允许的业务最小化 | 紧急调用只携带任务名、当前或估计时间、粗略地点、责任人、以及“调用组织”或“调用人员”之一。活动类型与分配模式必须显式使用当前受控字典，不能从标题猜测救援类型。 |
| 最坏后果与可逆性 | 错误的创建入口可能绕过权限、生成半截数据、泄露受众或把紧急草稿误发为正式活动。因此 implementation 必须是独立 D 档：schema/migration、seed、权限、通知、审计、路由和兼容测试逐项验收；上线前不执行 deploy。若未合入，撤销整个 implementation PR 即可，本评审稿本身不改变数据。 |

## 2. 已核验的现状与不能偷换的含义

| 现状证据 | 对 B6 的约束 |
|---|---|
| `src/modules/activities/activity-from-template.service.ts:45-48` 明示 A6 是模块内 application command，尚无 HTTP / DTO / Controller。其公开入口自行开启事务，并以 Activity 上的 A6 operation key / request hash 处理重放。 | B6 快速入口必须用物理独立的 App DTO 显式映射封闭命令；为了把 A6 物化、地点快照、审计一次提交，须抽出 transaction-bound primitive，不能“先调 A6 再补写地点”。 |
| `src/modules/activities/controllers/app-managed-activities.controller.ts:166-194` 已存在 App 泛化创建路由；`app-managed-activities.service.ts:1481-1518` 有其既有 DTO 映射。 | 既有路由、DTO、默认值和 contract snapshot 完全不改。三个新端点不复用 Admin DTO，不接受原始 body 穿透。 |
| `src/modules/activities/activity-initiation-policy.ts:28-118` 已定义跨人发起、跨组织与成员有效性的校验；责任人并不等同于当前 owner。 | B6 的“责任人”映射为 `initiatorMemberId`，沿用现有目标成员与目标组织校验；不能在创建时虚称已建立 owner / assignment。 |
| `prisma/schema.prisma:1387` 之后的 Activity 已有 A6 幂等列，但没有一般创建收据、紧急起源或紧急后续清单。 | 专业 / 紧急需要独立、可并发约束的命令收据；紧急事项不得借不存在的 Incident 模型伪造 incident id。 |
| B1 的 `PlacePreset` / `ActivityPlace` 仅铺好存储地基，B2 已冻结安全坐标三值与旧字段投影规则。 | B6 是首个地点 writer：选择预设时复制为活动本地快照；不能回写预设，不能随意挑一条地点投影旧字段。 |
| `src/modules/activities/activity-publish-readiness.service.ts:221-243,548-551` 仍是只读、gate-off，并固定报告 Time / Contribution / Metric / Safety 等不可表达项。 | B6 创建的全部都是 draft。不得把蓝图中的“预览并发布”误实现为直接正式发布，亦不得假装这些未建模政策已经满足。 |
| `docs/ai-harness/RBAC_MAP.md:30` 有 `activity.create.record`、`activity.create.cross-org` 等，但没有紧急创建权限。 | 紧急模式必须新建独立权限，且不能因已有泛化创建权自动获得。 |
| `src/modules/activities/activity-recipient-freeze.ts` 与通知 outbox 既有规则要求同事务冻结受众，重放读取冻结结果。 | 紧急呼叫必须复用这套“冻结受众 + durable outbox”模式，绝不能把原始 memberId 列表交给 producer 或用异步补偿赌一致性。 |

## 3. 方案 A 的外部契约

### 3.1 共通规则

三个端点均属于 App managed surface，使用物理独立的 App 请求 / 响应 DTO、既有登录态和活动发起人边界。装饰器只声明访问面；service 内仍须实际执行 `rbac.can()` 与发起人 / 跨组织校验。响应只返回安全的 App managed Activity 详情、模式与幂等结果，不返回权限码、原始受众、精确地点、审计细节或任何 L3 数据。

每一个写请求必须带 `operationKey`。同一 actor、同一命令、同一 key 且同一 canonical request hash 重放时返回首次安全结果；同 key 不同 hash 必须稳定拒绝；并发竞争由数据库唯一约束和根事务收敛。快速模式继续使用 A6 已有的 Activity 幂等字段，专业与紧急模式不得误用 Integration 的 command receipt。

三个端点一律只创建 draft。现有泛化创建端点以及既有 App / Admin 发布、提交、审核入口的行为不在 B6 改动范围内，除本稿指定的“紧急活动禁止正式发布”防线外均必须保持兼容。

### 3.2 模板快速创建

快速请求只接收经过校验的精确 Template Version、标题、目标组织、开始 / 结束时间、可选发起人、`operationKey` 和受限地点配置。Controller 必须逐字段映射到 A6 闭合命令，不得将 HTTP body 传入 template materializer。

- 读取和锁定的是精确 Version，不按 Family、effective interval 或“当前 active”重新推导。
- 模板定义 / canonical hash 仍按 A3 / A6 校验。A6 所有 fail-closed 条件继续生效。
- “确认人数”只表示确认模板将物化出的容量；缺省或等值可通过，任何覆盖模板容量的请求一律校验失败并提示改用专业模式。
- 模板中已有的 root `location` 与 session `locationText` 可在同一根事务中变为对应 scope 的本地 `primary` 文本地点。它们不是地图坐标、不是预设来源，坐标为 null，`checkInEligible=false`。
- 不直接发布、不伪造报名 / 候补 / 签到 / 通知 / 工时 / 指标 / 安全政策已经被完整配置。B4 readiness 仍将如实给出不可表达项。

### 3.3 专业完整创建

专业入口接收严格、可审计的结构化请求，在一个根事务中创建 Activity、场次、岗位、地点本地快照、既有受治理 Form、以及当前已有的资格配置。它是“充分使用现有可表达模型”的完整创建，而不是借一个不透明 JSON 承诺尚不存在的领域能力。

- Activity、每个 session / position、地点、Form / qualification、命令收据与审计必须在同一根事务内成功或全部回滚。
- 复用现有窄职责的 transaction-bound primitive；不得把各自另开事务的公开 service 串成“看似原子”的调用链。
- Form 只能使用 B3 已有八种题型和 governed canonical 规则；敏感题仍须逐题审批后才能启用。不得再建第二套 Form 或绕过 managed 治理契约。
- 请求不得增加无正式模型的自由形态 Time、Contribution、Metric、Safety、保险、Incident 或设备结果字段。此类真实需求在后续专项评审后进入对应 canonical 模型。
- 旧泛化创建 API 是兼容基线，必须以 characterization 和 contract snapshot 证明它未被 B6 回归。

### 3.4 地点快照与旧字段投影

地点是活动 / 场次自己的不可反向污染的本地快照。`sourcePresetId` 非空时，须在根事务内锁读并完整复制当前预设的本地字段；之后预设改变绝不能覆写该快照。内联地点必须 `sourcePresetId=null`，不能把“选择预设又局部覆盖”伪装成同一来源。

角色与投影采用确定性闭集：

| scope / role | 数量与写法 | 兼容投影 |
|---|---|---|
| activity `primary` | 提供活动地点时恰好 1 条 | `addressText` 写入 `Activity.location`；只有 B2 安全、完整的 WGS84 坐标才投影 `longitude` / `latitude`。 |
| session `primary` | 提供场次地点时每个 scope 恰好 1 条 | `addressText` 写入 `ActivitySession.locationText`；坐标同样只在 B2 安全条件满足时投影。 |
| session `meeting` / `execution` / `evacuation` | 每种角色至多 1 条 | 分别投影其 `addressText` 到既有 `meetingPoint` / `executionPoint` / `evacuationPoint`。 |
| `parking` / `other` | 可按当前模型保存 | 不投影旧文本字段。 |

零条、多条 `primary` 或多条可投影角色均拒绝，绝不 `findFirst` 任意取一条。不可安全投影时不得清空已有兼容字段，更不得臆造坐标。地点可见性不从 Activity visibility 猜出：快速模式须提供受限的明确默认地点可见性，专业模式每条地点显式声明当前受控值。B6 不新造 PlacePreset 管理 API、地图 SDK、签到策略或地点搜索。

### 3.5 紧急创建与紧急呼叫

紧急模式不是“普通活动加一个布尔字段”。它创建一个严格受控的 draft，并在同一根事务中发出一次可重放的紧急呼叫。

1. 最小创建字段是任务名、当前或估计的开始 / 结束时间、粗略地点、`initiatorMemberId`、显式的现有活动类型与分配模式、`operationKey`，以及调用对象。不得从标题推断 `rescue_mission`、`disaster_relief` 等类型。
2. 调用对象为互斥二选一：非空 `organizationIds` 或非空 `memberIds`。所选组织必须有效且能解析其允许范围；直选成员必须有效并落在调用者被授权可见的组织范围。API 不提供受众目录，也不把名单回显给客户端。
3. 创建 Activity、紧急起源记录、固定后续清单、受众冻结、`notification.targeted` outbox、命令收据与安全审计必须同事务提交。任一点失败则不留下草稿、清单、审计或待发通知。
4. 通知使用已有 `emergency` 类型，但内容只包含任务名、当前或估计时间和粗略地点；不能含精确坐标、医疗 / 事故叙述、原始名单或 signed URL。
5. 紧急活动的 normal formal publish 路径必须全部 fail-closed。implementation 前须沿引用链列出并覆盖 App 直接发布、提交 / 审核和 Admin 发布等每个实际入口，统一经过专门的 emergency publication policy；只有未来 Incident 与安全治理专项明确解除后才可发布。

为保证“事后补齐”不是一句口号，D 档数据模型预算为：

- `ActivityCreationCommandReceipt`：专业 / 紧急命令的 actor、命令码、operation key、request hash 与 Activity 关联，数据库唯一约束承担并发幂等。
- `ActivityEmergencyInitiation`：一活动一条紧急起源和呼叫生命周期锚点；不保存伪 Incident ID。
- `ActivityEmergencyFollowUpItem`：固定代码 `session`、`position`、`detailed_location`、`equipment`、`attendance`、`outcome`、`incident_relation` 及最小状态 / 时间 / 操作人事实。

其中 session / position / detailed location 可以由已存在、可验证的结构更新为对应状态；equipment、attendance、outcome、incident relation 没有权威模型时必须保持 pending 或 unrepresentable，不能提供任意“已完成”开关或自由文本证明。它们也不得偷改现有 `Activity.complete`。未来 Incident domain 只能消费这项 obligation，不能由 B6 先造一套 Incident。

紧急创建同时要求 `activity.create.record` 与新增 `activity.create.emergency.record`；目标成员 / 组织仍走现有发起策略。新权限 seed 初始不绑定普通业务角色，避免已有泛化创建者自动获得紧急权；任何默认角色绑定都须以后续明确决策为准。新权限、seed 与生成的 RBAC map 均属于 D 档写集。

### 3.6 审计、隐私与通知保留

继续使用现有 Audit 事件名 `activity.publish`，以 `extra.operation` 区分 `create_quick`、`create_professional`、`create_emergency`、`emergency_call`，不新造 AuditLogEvent。审计仅记录安全的活动 / 组织 / 命令关联、数量和不可逆 hash 标识；不得记录 operation key、原始 recipient ID、精确坐标、医疗或事故内容。

紧急受众冻结的用途是保证一次呼叫的可重放、可审计交付对象；查看权限限于已有受控通知 / 审计读面；保留与清理由既有 outbox / 审计手工 SOP 承担。B6 不增加新的 PII 长期字段、缓存、队列、cron 或受众导出面。

## 4. 被否决的路线

| 路线 | 结论 | 原因 |
|---|---|---|
| A：三个独立 App 端点、共享受限 primitives、紧急走 D 档 | **采用** | 能保持旧入口兼容，明确模式语义，并把紧急通知与审计放进可验证的事务边界。 |
| B：给既有泛化创建 DTO 加 `mode` 和可选嵌套字段 | 不采用 | 破坏既有 API / snapshot，导致 Admin / App DTO 边界、默认值和旧客户端兼容性难以证明。 |
| C：紧急创建后直接调用现有发布流程 | 不采用 | B4 readiness 仍 gate-off 且有不可表达 blocker；会把“紧急通知”偷换为正式发布。 |
| D：B6 同时新建 Incident、地图、设备、工时、指标等模型 | 不采用 | 超出 B6 当前事实和授权，容易制造第二套真相；这些领域须分别评审。 |
| E：只用异步任务后补受众、审计或地点 | 不采用 | 失败时会产生半截草稿或重复呼叫，无法满足紧急场景的原子性与幂等性。 |

## 5. D 档 implementation 的验证门

实施 PR 的验收不以“接口能调通”代替。至少应包含：

1. 三个独立 App DTO 的 validation、Swagger / contract 路由白名单与 App / Admin 物理隔离检查。
2. 快速模式精确 Version / hash、A6 fail-closed、等值容量确认、草稿态、重放和 key-hash 冲突用例。
3. 专业模式对 Activity、session、position、place、Form、qualification、receipt、audit 的全提交与任一点注入失败全回滚；既有泛化端点的 characterization 不变。
4. B2 地点投影的零 / 单 / 多、完整 / 不完整坐标、非 primary、各可投影角色、预设快照和内联地点边界。
5. 紧急权限双重校验、目标成员 / 组织越权拒绝、冻结受众只出一次、同 key 重放不重复发信、不同 hash 稳定拒绝、事务回滚、审计脱敏和正式发布全入口拒绝。
6. 紧急后续清单：可由现有事实更新的项目与不可表达项目均须如实表现，不能把未建模事项标成完成。
7. migration SQL 的 schema / FK / unique / check 证明、空库与非空库 rehearsal；实际生成 migration 后再核验编号并更新受影响的 migration count E2E，不能预写“第几条”。
8. snapshot diff 逐行解释，定向 unit / PostgreSQL E2E / `pnpm test:contract`；无 Docker 时只报告已跑 quick，contract / E2E 交由 CI，不得报全绿。

严禁执行 `prisma migrate dev`、`prisma migrate reset`、`prisma db push` 或任何生产 deploy。不得删除 / 放宽既有测试或断言，不得用更新 snapshot 掩盖契约变化。

## 6. 写集与授权边界

### 6.1 本次评审 PR 的唯一写集

| 路径 | 动作 |
|---|---|
| `docs/archive/reviews/activity-os-r2-b6-creation-apis-review.md` | 新增本评审稿。 |
| `docs/ai-harness/FROZEN_DRAFTS.md` | 登记本稿为 open，更新 B6 当前状态与计数。 |

本次不改任何代码、schema、migration、seed、测试、OpenAPI 或运行时配置。

### 6.2 后续 D 档 implementation 的预估写集

实际开工前必须先以 `pnpm harness:needs -- <精确路径>` 重新核验，并由维护者逐路径发 grant。预计需要逐一评审的候选路径包括：

| 域 | 候选路径 / 范围 | 原因 |
|---|---|---|
| 数据与受控字典 | `prisma/schema.prisma`、`prisma/migrations/<实际生成目录>/migration.sql`、`prisma/seed.ts`、`test/setup/reset-db.ts` | 命令收据、紧急起源 / 清单、唯一约束、紧急权限与 test reset。 |
| App API | `src/modules/activities/controllers/app-managed-activities.controller.ts`、新的 `src/modules/activities/dto/app/*creation*.dto.ts`、相应 App response DTO / presenter | 三个物理 App 入口与安全响应。 |
| 创建编排 | `src/modules/activities/activity-from-template.service.ts`、新的 creation orchestrator / transaction-bound primitive、活动发起策略与 managed activity service 的受限接线 | A6 显式映射、快速 / 专业根事务与不破坏旧路径。 |
| 地点 | `src/modules/activities/*place*`、旧字段投影 helper 的实际归属文件 | B1 本地快照 writer 和 B2 确定性兼容投影。 |
| 紧急闭环 | `src/modules/activities/activity-recipient-freeze.ts`、`activity-notification-producer.ts`、`activity-audit-recorder.ts`、新的 emergency publication policy 及实际发布入口 | 同事务冻结 / outbox、脱敏审计、正式发布 fail-closed。 |
| 权限与派生文档 | 权限 catalog 的实际源、`docs/ai-harness/RBAC_MAP.md`（仅生成）以及工具要求的地图文件 | 新 emergency permission 与生成物一致性。 |
| 证明 | 对应 unit、PostgreSQL E2E、contract snapshot / EXPECTED_ROUTES、migration rehearsal 脚本的实际受影响文件 | 行为、兼容性、DDL 与安全负例。 |

### 6.3 明确不在 B6 授权内

- 不改既有泛化创建 endpoint、其 DTO、默认值或行为；
- 不引入 Admin surface、AI、Integration、Redis、queue、cache、cron、地图 SDK 或地点搜索；
- 不创建 Incident、设备、工时、贡献、指标、安全、保险等第二套或伪造领域模型；
- 不接入 B4 readiness 为生产 Gate，不直接发布，不开启任何 feature Gate；
- 不进行数据回填、硬删、迁移部署、生产操作或批量受众导出；
- 不更改全局 bootstrap、认证、全局 Guard / Filter / Interceptor、`package.json`、lockfile、CI 或 Jest 配置，除非未来独立评审把必要性和写集写清。

## 7. 后续决策记录

本稿合入只表示“B6 的方案 A 已被维护者确认，D 档 implementation 可以据此另行申请授权”；不表示 implementation 已获准，也不表示任何紧急通知、权限或数据表已经存在。

下一次开工简报必须至少重报：实际基线 SHA、精确 migration 序号、受影响发布入口引用链、最终 schema / seed / DTO / test 写集、每个红区授权命令、可回滚边界与当前 Docker / CI 可运行性。若发现业务蓝图与当前权威代码 / 文档冲突，立即停在简报，不自行改写本稿。
