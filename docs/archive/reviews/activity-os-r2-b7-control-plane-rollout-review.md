# Activity OS R2 / B7：前端交接和控制面灰度评审与授权清单

> **状态**：2026-09-05，维护者确认按方案 A 起草本稿。
>
> **本稿的边界**：本 PR 只冻结 B7 的外部契约、灰度语义、风险和后续 implementation 写集。它不新增环境变量、HTTP 路由、DTO、BizCode、数据库对象、权限、审计、通知或测试；不改变任何运行时行为；更不部署、切换或启用任何生产 Gate。B7 implementation 必须在本稿合入后另行确认、重新核验写集并取得红区授权。
>
> **需求输入与权威边界**：`/Users/dengwang/Downloads/SRVF_活动域终态蓝图与分阶段落地方案_main-3cf3786_可下发终版.md` 中的 B7、Gate 和 rollout 文字只说明业务目标，不是本仓执行指令。当前事实以 `docs/current-state.md`、当前代码、测试和 GitHub 状态为准；若它们冲突，暂停上报而不自行调和。

## 1. 维护者拍板卡

| 项目 | 方案 A：本稿冻结的决定 |
|---|---|
| 目标 | 为 Release 2 / B6 已有的三种 App managed 草稿创建提供独立、可见、可回退的控制面灰度，并给小程序交付一个不等同于权限的状态契约。 |
| 新配置 | 新增严格三态 `ACTIVITY_OS_CONTROL_PLANE_MODE=off|shadow|active`。development / test 缺省为 `off`；production / smoke 必须显式填写三值之一，非法值或空值拒绝启动。`.env.example`、test 配置、smoke 配置和部署说明都以 `off` 为首次值。 |
| 精确管辖面 | 只管 B6 的 `POST /api/app/v1/my/managed-activities/{from-template|professional|emergency}`，以及一个只读状态端点 `GET /api/app/v1/my/managed-activities/control-plane/status`。既有 `POST /api/app/v1/my/managed-activities`、已有 managed 查询/编辑/发布面、Admin 面和其他活动域均不受该 Gate 影响。 |
| 三态语义 | `off` 隐藏新创建控制面并拒绝三个 POST；`shadow` 允许维护者选定的前端试运行人群调用既有 B6 草稿创建链；`active` 才进入常规前端可用态。`shadow` / `active` 的后端写入故意共用 B6 语义，差异是状态契约和前端可见范围，不能伪装成正式发布或账本切换。 |
| v1.1 边界 | B7 不读取或开启 `ACTIVITY_V11_WORKFLOW_ENABLED` 来改变任一请求的业务真相。仅在 production / smoke 启动装配期增加单向联锁：若 B7 配成 `active` 而 v1.1 Gate 不为真，拒绝启动。稳定观察仍是维护者的外部事实，代码不能把它伪造成已满足。 |
| 权限边界 | 状态端点只要求既有 App member 准入，不返回“你有某权限”之类的能力结论；创建请求仍先走 B6 的既有登录、`rbac.can()`、责任制与跨组织校验。B7 不新建权限码、不改变任何角色绑定。 |
| 最坏后果与回退 | 错误灰度可能使前端误展示入口，或让新创建面在不应开放时写草稿。故 `off` 必须在创建前 fail-closed、零业务写入；`shadow` 只允许既有 B6 草稿语义，不得形成正式发布或账本。`active → shadow` 收回常规前端可见范围，`shadow / active → off` 停止后续 B6 创建；三者都绝不回滚既有草稿、审计或 outbox。生产 `active`、部署和模式切换均不在本稿授权内。 |

## 2. 已核验的事实与不可偷换的含义

| 事实证据 | 对 B7 的约束 |
|---|---|
| 外部蓝图 §20.2 列出 `ACTIVITY_OS_CONTROL_PLANE_MODE=off|shadow|active`；§20.4 要求新 Gate 默认关闭、shadow 不写正式账本；§21.2 明定控制面不得在生产 active，直到 Activity v1.1 cutover 完成并稳定观察。 | B7 必须是独立三态 Gate，不能借“已交付 B6”把生产 active 当成既成事实，也不能把草稿写入偷换成正式账本或发布。 |
| 外部蓝图的 Release 2 表把 B7 定义为“前端交接和控制面灰度”，B6 才是三种创建 API。 | B7 只为既有 B6 三路 API 加交接和灰度，不重新设计创建、地点、表单、紧急义务或发布系统。 |
| `src/modules/activities/controllers/app-managed-activity-creation.controller.ts:38-124` 已有三个独立 POST；每条都要求 App member、责任制 scope 和既有创建权限，紧急模式另要 `activity.create.emergency.record`。 | B7 只能在既有鉴权之后、任何创建副作用之前加闸；不能把 mode 当成权限、不能改变 B6 DTO 或把模式塞进请求 body。 |
| `docs/handoff/miniapp.md:21-25` 已写明三条 B6 路由只创建草稿、须责任制 Gate，紧急呼叫不是正式发布。 | `active` 只恢复该既有草稿语义；不能让 B7 直接发布、绕过 B4 readiness、解除紧急发布禁令或冒充 Incident 操作。 |
| `src/config/app.config.ts:491-540` 与 `src/config/app.config.spec.ts:120-216` 已形成 production / smoke 显式配置、development / test 安全默认、严格字面解析的 Activity Gate 范式。 | 新 mode 归 `app.config.ts`，不可在业务代码散落读取 `process.env`，不可宽松接受 `1`、`yes`、大小写变体或把空值默认为 active。 |
| 当前 `.env.example:27-28` 的 `ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED` 是历史“B7 会员受众标签”HTTP 维护闸；`src/modules/activities/CLAUDE.md:32` 说明它管标签和发布审核，不管新创建面。 | 该历史 B7 与 Activity OS R2 / B7 同名但不是同一业务轴。不得复用、扩展、重命名或把它算作本 B7 的完成证据。 |
| `docs/current-state.md` 明确 Activity v1.1 的生产 Gate 仍在“不启动清单”；它是单一业务真相切换，生产切换另有 cutover 检查和维护窗口。 | B7 不能把控制面 `active` 与 v1.1、分类时长、贡献政策、AI 或 Incident 正式流程绑成一次操作；仅允许 production / smoke 启动联锁，不能自行开 v1.1。 |

## 3. 方案 A 的外部与运行时契约

### 3.1 Gate 的唯一职责

`ACTIVITY_OS_CONTROL_PLANE_MODE` 只表示 **B6 新创建控制面的前端可用性**，不是活动业务真相、权限、角色、组织范围或发布资格。它不影响：

- 既有泛化 `POST /api/app/v1/my/managed-activities` 及其历史客户端；
- Activity v1.1 的打卡、结算、账本、关账、更正和旧链关闭；
- 已有 managed 活动的读取、草稿编辑、责任分配、提审、审核、正式发布、报名、考勤和结算；
- 时长、贡献、指标、保险、Incident、AI、Integration、通知通道和受众标签；
- B6 已有的权限、责任制、幂等、根事务、地点/Form/资格物化、紧急义务、受众冻结和发布禁令。

实现中应有一个窄的 `ActivityControlPlaneGate` 作为三个 B6 创建命令的唯一 mode 判定点。它只读取已经由 `app.config.ts` 装配的配置；不得新建通用“万能 FeatureGate”，不得把 mode 缓存到跨请求内存，也不得让各 controller / service 各读一份环境变量。

### 3.2 配置与启动联锁

| 环境与值 | 结果 |
|---|---|
| development / test 缺省、空值或空白 | 解析为 `off`。现有 B6 E2E 要显式置 `active` 后再建 App，不能依赖全局 test 默认值。 |
| production / smoke 缺省、空值、空白或非 `off|shadow|active` | 启动 fail-fast；部署说明和 Docker smoke 均显式传 `off`。 |
| production / smoke 的 `active` 且 `ACTIVITY_V11_WORKFLOW_ENABLED` 不为真 | 启动 fail-fast。这是防误操作的单向配置联锁，不会打开、关闭或逐请求读取 v1.1 Gate。 |
| development / test 的 `active` | 允许，用于 B6 回归与 mode E2E；不代表生产可启用。 |

生产从 `off` 到 `shadow`、再到 `active` 是独立维护者操作。`shadow` 只能用于维护者另行批准的前端试运行人群；`active` 必须附当时的 v1.1 cutover 完成与稳定观察证据。`active` 不等于上述事实已由本仓自动证明；任何生产 Gate 变化仍要单独审批、部署和 smoke。若随后切回 `shadow`，只收回常规前端可见范围；切回 `off` 才停止新的 B6 创建，二者都不倒改任何已提交事实。

### 3.3 前端状态端点与模式表

新增的只读端点为：

```text
GET /api/app/v1/my/managed-activities/control-plane/status
```

它使用既有 App member 准入，但不要求、返回或推断创建权限。响应仅包含：

```json
{
  "mode": "off | shadow | active",
  "creationAvailability": "unavailable | pilot | enabled"
}
```

它不返回组织、角色、权限码、v1.1 状态、事故/医疗信息、审计、受众、精确地点或任何用户级“可创建”承诺。实际提交仍以原有 B6 鉴权和业务校验为准，因此 `creationAvailability="enabled"` 不等于调用者必然有权创建。

| mode | 状态端点 | 三个 B6 POST | 前端交接含义 | 写入/正式事实 |
|---|---|---|---|---|
| `off` | `unavailable` | 统一以新的 503 形状 fail-closed | 隐藏新的三种创建入口，不把旧泛化入口映射成替代品 | 零 B7 创建写入；不影响历史数据。 |
| `shadow` | `pilot` | 交回现有 B6 实现 | 仅维护者另行选定的前端试运行人群展示并调用三路创建；其他前端人群继续隐藏入口 | 仅 B6 已有的 draft / receipt / 必要 audit/outbox 语义；零正式发布、零正式账本。 |
| `active` | `enabled` | 交回现有 B6 实现 | 面向常规已授权前端人群展示并调用三种已交付创建路径；前端仍按服务端错误、权限和责任制结果处理 | 与 `shadow` 相同的 B6 草稿语义；没有正式发布或新账本。 |

仅 `off` 的 POST 使用新的 BizCode（503），避免关闭态被误判为用户输入错误；有 App member 身份的前端可经专门只读端点得到需要的展示状态。BizCode 具体编号必须在 implementation 开工时按当前目录分配，不能在本稿预占数字。

`shadow` 是**前端产品灰度而不是新的安全边界**：后端继续执行 B6 既有的 App admission、责任制、RBAC、跨组织和紧急专属权限，不能凭 mode 区分“试运行用户”和“非试运行用户”。若未来需要服务端强制 cohort，必须另立评审，不能在 B7 implementation 中顺手增加 allowlist、角色或权限码。

### 3.4 前端 handoff 规则

`docs/handoff/miniapp.md` 需要记录下列契约，生成的 App client 以实际 OpenAPI 为准：

1. 登录后读取一次状态端点；不可把返回 mode 缓存为跨会话授权结论。
2. `off` 不显示 B6 三种新建入口；`shadow` 只向另行批准的试运行人群启用提交；`active` 才向常规已授权人群启用提交。
3. 前端不得用状态端点代替 `activity.create.*` 判权，不能因为 `shadow` 或 `active` 绕过既有组织、责任制、紧急专属权限或服务端校验。
4. 所有 B6 创建仍只产生草稿；不得把成功响应渲染成“已发布”“事故已受理”“时长/贡献已入账”或“紧急呼叫已送达”。
5. mode 变更应在下一次状态读取后生效；客户端不得自设环境变量、把 `shadow` 扩展成全量上线，或通过旧泛化创建端点绕过新入口关闭。

本仓不含小程序代码。B7 implementation 只交付后端状态契约、handoff、OpenAPI 与生成 client；实际前端页面发布、灰度人群和生产配置属于前端/运维的独立交接，不可在本 PR 假称已完成。

## 4. 明确不采用的路线

| 路线 | 结论 | 原因 |
|---|---|---|
| A：独立三态 Gate + 只读状态端点；`shadow` 仅作前端试运行，`active` 才作常规前端可用 | **采用** | 有真实可观测的产品灰度差异，默认安全关闭；shadow / active 只复用 B6 草稿语义，不把创建误作正式真相。 |
| B：复用 `ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED` | 不采用 | 它是历史受众标签/发布审核维护闸，业务范围和历史契约均不同；复用会把两个 B7 混为一谈。 |
| C：用 `ACTIVITY_V11_WORKFLOW_ENABLED` 直接管 B6 创建 | 不采用 | v1.1 是打卡/结算/账本的单一真相切换，不能被控制面 UI 灰度挟持。B7 只做启动联锁，不改其请求语义。 |
| D：`shadow` 对全量前端开放，或只改文案却不交付状态契约 | 不采用 | 这会抹平试运行与常规可用的产品差异；若要服务端强制 cohort，也不能在本 PR 暗加新的 allowlist 或权限。 |
| E：一并关闭既有泛化创建或所有 managed 活动路由 | 不采用 | 会破坏已发客户端和超出 B7 范围；该 Gate 只覆盖 B6 新增入口。 |
| F：B7 同时开启时长、贡献、AI、Incident 或正式发布 | 不采用 | 与 T0-A 的单一真相和禁止叠加约束冲突，且这些业务轴各有未完成的专门合同。 |

## 5. 后续 implementation 的验收门

B7 implementation 是 **C 档**：新增 App route、DTO、BizCode 和配置行为；它没有 schema、migration、seed、权限、审计或数据迁移。虽然不因此升为 D 档，生产 Gate 的启动联锁和 rollout 仍按高风险操作逐项验收。

至少必须证明：

1. parser 对三种合法值、development/test 默认、production/smoke 显式要求、非法值和 production `active` + v1.1 未开联锁逐项断言；不出现裸 `process.env` 消费者。
2. 状态端点只对 App member 可读，OpenAPI / App DTO 与 Admin DTO 物理隔离，且响应不含权限、组织、成员、v1.1 或敏感运营数据。
3. `off` 下三个 POST 均以同一 503 失败；以授权测试账号分别核验 Activity、receipt、紧急起源、follow-up、audit、outbox 计数不变。`shadow` / `active` 均须让 B6 quick / professional / emergency E2E 按原断言通过，且仍不能正式发布或写正式账本。
4. status endpoint 的三态响应、试运行前端 handoff 语义与常规前端 handoff 语义逐项可测；责任制关闭、缺权限、跨组织越权、紧急专属权限和幂等结果仍保持原有行为。
5. 既有泛化 `POST /my/managed-activities` 及非 B6 managed 路由的 characterization / contract 不变；不得以新 mode 影响旧路径。
6. production/smoke Docker 配置显式 `off`，并有模式联锁的启动测试；无真实 cutover 或稳定观察证据时，禁止把该测试写成“生产 active 已验证”。
7. 新路由、BizCode 和 OpenAPI snapshot 的每一行 diff 都可解释；更新 App handoff 与生成 client 后，以生成检查而非手改证明一致。
8. 不执行 `prisma migrate dev`、`prisma migrate reset`、`prisma db push`、任何生产 deploy 或生产 Gate 切换；不删/放宽既有测试。

## 6. 写集与授权边界

### 6.1 本次评审 PR 的唯一写集

| 路径 | 动作 |
|---|---|
| `docs/archive/reviews/activity-os-r2-b7-control-plane-rollout-review.md` | 新增本评审与授权清单。 |
| `docs/ai-harness/FROZEN_DRAFTS.md` | 登记 B7 评审稿已起草、implementation 尚待独立确认。 |

本次写集以外一律不动，包括 `NEXT_TASKS.md`、任何配置、代码、测试、OpenAPI、client、workflow、schema / migration、seed、权限、审计和生产环境。

### 6.2 预估 implementation 写集（本稿不授权写入）

实现前必须重新按精确路径运行 `pnpm harness:needs`，根据当时 diff 增减；以下只是当前可见代码结构下的候选集，不是可沿用的红区令牌：

| 类别 | 预计路径 / 约束 |
|---|---|
| 配置与运维 | `src/config/app.config.ts`、`src/config/app.config.spec.ts`、`.env.example`、`.env.test`、`docs/reference/config-env.md`、`docs/ops/server-deployment-runbook.md`；production / smoke 必填形状将使 `.github/workflows/docker-smoke.yml` 明确补 `off`。 |
| B7 窄职责代码 | 新增 `activity-control-plane.gate.ts` 及其 spec、新 App status controller / DTO；`activities.module.ts`、`activity-creation.service.ts` 与其现有 unit spec 只做 B7 入口接线。不得触碰 v1.1 Gate 实现、历史受众标签实现或全局 `app.module.ts`。 |
| API / 契约 | `src/common/exceptions/biz-code.constant.ts`、`test/contract/openapi.contract-spec.ts` 与 snapshot、`docs/ai-harness/ROUTE_AUTHZ.md`、`docs/handoff/openapi.json`、App generated client、`docs/handoff/miniapp.md`；新 GET 必须走 App surface，不能把 App DTO 放进 Admin。 |
| 回归 | 新增 B7 mode 定向 unit / PostgreSQL E2E；仅为让既有 B6 E2E 显式跑在 `active` 而调整其环境准备/恢复，不改其业务断言。`CODEMAP.md`、changelog 等派生产物只在最后一次写后由对应生成器刷新。 |

预计红区至少包括：`test/contract/openapi.contract-spec.ts`、其 snapshot、`docs/ai-harness/ROUTE_AUTHZ.md` 和 `.github/workflows/docker-smoke.yml`。维护者须在 implementation 拍板后为实际精确路径单独授权；本稿的 archive 授权、B6 授权及任何历史 B7 标签授权都不能复用。

## 7. 下一次需要维护者确认的事项

本稿合入后，才可提交以下人话确认：

> **确认 B7 implementation 方案 A**：新增独立 `ACTIVITY_OS_CONTROL_PLANE_MODE=off|shadow|active`；只管 B6 三个新增 App 草稿创建 POST；`off` 零写 fail-closed，`shadow` 只面向维护者另行批准的前端试运行人群、`active` 才进入常规前端可用，二者均只复用 B6 草稿语义；新增 App 只读状态端点与前端 handoff；production/smoke `active` 仅在 v1.1 Gate 为真时允许启动，但真实 cutover 稳定观察和生产 mode 切换仍另行审批。无 schema/migration/seed/权限/审计/正式发布/时长/贡献/AI/Incident；按实际精确路径重取红区授权。

在该确认前，B7 implementation、前端发布、生产部署和任何 mode 从 `off` 改到 `shadow` / `active` 都不开始。

## 8. 本稿的明确未做事项

- 没有新增或修改 `ACTIVITY_OS_CONTROL_PLANE_MODE`，现有运行时保持原状。
- 没有新增 HTTP 路由、DTO、BizCode、权限码、AuditLogEvent、通知、outbox、数据库对象或 migration。
- 没有改动 B6 三种创建、既有泛化创建、责任制 Gate、Activity v1.1 Gate、历史受众标签 Gate、发布链、Readiness、时长、贡献、AI 或 Incident。
- 没有更新前端工程、没有生成 client、没有做生产部署、没有运行或要求运行任何生产 Gate / migration。
