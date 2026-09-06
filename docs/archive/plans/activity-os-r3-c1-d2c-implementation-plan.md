# C1 D2c：v7 提案、指标 Readiness 实施与授权清单

> 2026-09-06。维护者已批准 **D2b 台账更正方案 A及本清单起草**，并发放本文件精确新增授权。下文为待批准的 implementation 方案 A，**不构成实施、测试库重建、合并或生产授权**。本 PR 仅九份 Markdown 文档，A 档；后续实施涉及发布审核写链与安全边界，按 D 档组织验收。
>
> 调查基点 `main@f5b5b226d62c4e5178bfcc8d9a43efe021f1591c`，版本 0.72.0。D2b [#1282](https://github.com/BA7IEE/srvf-nest-api/pull/1282) 已合并，最终批准 HEAD `1ceaedac35e7093b03b48b393fc4ee86a6f69903`；18 项 PR 检查、可信审批及 [main CI](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34030385503) 成功。开工时工作树 clean、0 open PR；CHANGELOG 无 Unreleased 标题，未发布内容留在 changelog.d，未另行发版。
>
> 需求依据为已批准的 [C1 D2 外部契约评审 §6–9](../reviews/activity-os-r3-c1-d2-metric-catalogue-selection-review.md)。其调查时点和“待授权”文字为历史，不回改。阶段性跨模型复审已按维护者要求延后至整体完成后；未取得独立结论，不登记通过或永久豁免。

## 1. 需要拍板：完整接入 v7 与指标就绪语义

- 做什么：让新的版本化发布/变更提案冻结指标选择，经原审核事务落地；就绪检查按真实三态判断指标，同时识别已交付的模板 V3。
- 不做会怎样：目录、模板和活动选择虽可配置，审核快照仍固定空指标指针，就绪检查仍无条件阻塞，C1 不能收口。
- 最坏情况与回退：旧在途审核失效、退役引用误拒或已发布选择绕过审批。以逐版本兼容、锁内复验和只允许 v7 写新列控制；出现问题停止新写并保留 v7 兼容读者，不删数据或回退到 v6-only 二进制。
- **方案 A（推荐，待批准）**：一个独立实施 PR 完成下文 v7、原审核链、历史兼容、安全差异摘要、指标 Readiness、V3 识别及交接；无 schema/migration/seed/权限码/审计事件/Gate 增量。
- 方案 B：同一完整范围拆成 v7 与 Readiness 两个串行 PR；可分段定位问题，但中间状态仍非 C1 完成。不得删去 Readiness 或历史兼容后提前转 C2。
- 拍板前不动业务代码。需要修改冻结行为、写集外文件或新增权限/事件/迁移时沿 process §4.1 单独上报，不以本稿笼统扩权。

## 2. 代码现状与调用链证据

行号定位于调查基点；实施前以符号和引用链重新核验。

| 现有锚点 | 当前事实 / D2c 后果 |
|---|---|
| `src/modules/activities/activity-publish-proposal-v2.service.ts:236,625,639,1390,1546,1700` | v6 类型、writer、parser 与字段构造均固定 metricSetPointer=null；新契约必须另建 v7 分支，不能放宽 v6。 |
| 同文件 `rebuildCurrent:711`、`parseSnapshot:795`、`apply:868` | 版本化快照在同一 service 分发。真正的 v2–v6 applier 在这里，不因另有同名文件就盲改。 |
| `activity-publish-review-submit.service.ts:237,266,429,471` → `activity-publish-review.service.ts:497,531,536,571,933` | 提交与批准均有根事务、Activity 锁、snapshot/revision 守护及 RuleSnapshot 落库。v7 必须接完整链，包括直发的兼容调用。 |
| `activity-proposal-applier.ts:77`；`activity-publish-review-submit.service.ts:72,143` | 另有 legacy 提案链，不能误当成版本化 v7 writer。既有 legacy 路由/解析/apply 保持，不允许它侧写四个指标列。 |
| `controllers/app-managed-activities.controller.ts:1236,1265,1323,1350,1378` | 新版本化提审入口为 publish-reviews/change-reviews；另有 legacy submit-* 和 direct-publish。所有入口都要回归，不能把 legacy DTO 强制升级为新必填请求。 |
| `activity-publish-review-query.service.ts:126,149,190` | 详情 changeDiff 目前只识别至 v6；v7 必须有安全分支，不能降级为 legacy 或返回任意快照全文。 |
| `activity-metric-selection.ts:85,98,138` | 已有三态持久化解读、严格指针、immutable closure 校验；历史解释允许 retired，新选默认不允许。复用原语，不复制值域规则。 |
| `activity-metric-selection-access.ts:151` | `lockMetricSelectionReference` 固定集 SHARE → 排序定义 SHARE → closure 复验；每次等待后执行 revalidate。当前仅支持新选资格，历史解释不得通过全局放宽它实现。 |
| `activity-publish-readiness.service.ts:338,550,571,579` | 模板仅解析 V1/V2，指标恒报 METRIC_SET_UNREPRESENTABLE；evaluate 是内部只读事务，未连接任何 Controller 或发布 Gate。D2c 不新造 readiness HTTP 端点。 |
| `activity-publish-review-audit-recorder.ts:10,27` | 已有 activity.publish 事件记录提交/批准/退回/撤回及 reviewId。复用该审计与 review 的不可变快照，不新增指标选择事件去冒充草稿命令。 |

当前计数为模块 43、Controller 115、Endpoint 598、migration 112、BizCode 510、权限 252、Audit 161 总计/156 活跃、cron 2。方案 A 预算全部不变；若实际不能保持，先报真实差值，不能预签 3b/4b。

## 3. v7 合同与旧版隔离

### 3.1 冻结内容与 revision

v7 保留 v6 的其他字段语义，在 base 与 target 均显式冻结 `metricRequirementCode`、`metricSetPointer`、`metricSelectionRevision`，纳入各自 canonical/hash。取值如下：

| 模式 | 指针 | revision / 语义 |
|---|---|---|
| unconfigured | null | 仅解释旧/未配置活动，revision=0；新命令不能主动清回此态。 |
| not_required | null | revision≥1；由获授权真人明确选择，不由缺省/null 自动推断。 |
| required | 精确五字段 id/code/version/schemaVersion/definitionHash | revision≥1；schemaVersion=1，必须能重建集与定义的完整 hash 闭包。 |

变更 DTO 的 `metricSelection` 为可省略的严格两字段对象，复用 **App** selection DTO；不得引用 Admin DTO。显式 null、unconfigured、未知键、伪 hash 拒绝。省略表示保留，不能覆盖旧列。显式提供时同时要求 `expectedMetricSelectionRevision`，不得仅传 revision。双方在 Activity 锁内比较；真实选择变化令 target revision=base+1，不变则保留 revision；同值显式请求仍按新选资格复验，不成为退役重选旁路。整个提案无其他变化时沿原“无有效变更”拒绝规则，不单为升版本制造空审核。

首次版本化提审冻结当前 draft 的选择，提交/批准均按新选规则复验 required。已发布活动的变更若省略选择，则只解释该活动已冻结指针，允许 retired；若显式新选则提交和批准均要求集与每个定义 active。比较使用 canonical 值，不用客户端 changed 标记或名称。

base 和 target 的闭包损坏、指针不存在、hash 不匹配均 fail-closed。不自动选择 latest，不把退役等同删除，不携带成果数值、名单、答案、题干、个人信息、Token 或完整 URL。引用最多 100 个定义，101 为超限探针；不无界读取。

### 3.2 提交、批准、原子性

根事务锁序沿既有活动审核顺序，新增部分为 Activity → 指标集 → 定义按 ID 排序；不得反向获得 Activity 锁。保留 review 锁/幂等键顺序。等待后用同一 tx 重验当前操作者身份、原有权限与责任、活动状态和新选资格；不能用请求开始时身份或无 tx 的读数授权最终写入。

审核期间 Activity workflowRevision、选择 revision 或 base hash 改变均拒绝落地；新选引用退役后批准失败并要求重提。无关变更保留历史引用，不要求换新集。批准时 Activity 选择、workflowRevision、Form/Qualification/场次原有联动、RuleSnapshot、review 状态、审计与已有 outbox 在原根事务一次完成；失败不能留下选择已变但审核未批准的半成品。批准重放保留原幂等行为，不多写、不多审计、不多发通知。

v7 写选择只发生在已有批准/apply 分支。草稿 PUT 仍只允许 draft 且无 pending；通用 PATCH、legacy submit-*、Admin 直发、App direct-publish 不接收或侧写新选择字段。直发若调用版本化 writer，必须走同一 v7 freeze/validate，不另辟绕过入口。紧急起源不得正式发布的既有拒绝保持。

### 3.3 兼容与安全读面

v2–v6 的 parser、canonical、hash、在途 apply、错误和原审计形状不改；legacy 也不改。旧快照没有选择字段不代表清空四列，逐版本用已配置活动验证。新版本化提交统一 v7，旧请求省略新增字段仍可提交；不重新哈希已持久化旧提案。

`changeDiff.kind='proposal-v7'`，保留已有活动字段名、场次 ID/变更类及 qualification 安全摘要；新增 `v7Fields.changedFields` 只允许显式白名单字段名，包含三项指标字段及原 v6 安全字段。无原始 before/after 值、集名称或定义内容；未知/损坏 v7 返回受控不可解析摘要或原有业务错误，不透出整份 JSON。v6 摘要逐字保留。

## 4. Readiness 语义（仍内部、只读、gate-off）

在单一只读一致性快照内加载选择四列、精确集及有界定义闭包，把最小结果交纯 evaluator；不让 Presenter/evaluator 查库。固定 referenceTime 和事实时结果排序、去重与域序完全确定。

| 事实 | 指标判定 / 候选 issue |
|---|---|
| unconfigured | missing，blocker `METRIC_SELECTION_MISSING`，fieldPath=`metrics.requiredSet`；不豁免。 |
| not_required 且形状/revision 正确 | 明确不适用，不发指标 blocker；不表示已有成果。 |
| required 且有效 | draft 按新选 active 资格检查；已发布历史选择按 immutable closure 检查并允许 retired。不替代真实批准时复验。 |
| 非法形状、缺失指针、hash/闭包损坏 | blocker `METRIC_SELECTION_INVALID`，同 fieldPath。 |
| draft required 引用已退役 | blocker `METRIC_REFERENCE_UNAVAILABLE`，同 fieldPath，要求重新选择。 |

以上为 Readiness issue 字符串，不新增 BizCode。提示语分别解释“尚未配置指标要求”“指标选择或引用校验失败”“指标引用不可新选”，不得输出底层异常或原始内容。旧恒定 METRIC_SET_UNREPRESENTABLE 不再用于可表达的这三态；仅调整相应新语义断言，其他 blocker 不删。

模板 V3 使用既有 `parseActivityTemplateDefinitionV3` 及其 canonical/hash 合同；V1/V2/legacy 行保持原分支。检查活动的指标选择，不把模板默认直接当作当前活动选择；历史 V3 引用退役也不能使无关编辑强行选 latest。

TimePolicy、ContributionPolicy、保险、安全及其他域的缺口、排序和原提示保持；不写成果、不增加人数/时长/贡献联动，不开启任何 Gate。没有新增 HTTP 就绪接口，也不把 B7 control-plane/status 宣称为 Readiness 返回面。

## 5. 端点、DTO、权限和错误矩阵

以下均为既有路径，新增端点预算为 0。App 基址 `/api/app/v1/my/managed-activities`；Admin 基址 `/api/admin/v1/activity-publish-reviews`。Human-only；Integration/Open 不新增消费面。

| 入口 | DTO / 差值 | 判权 / 成功 HTTP |
|---|---|---|
| App POST `/:activityId/publish-reviews` | SubmitActivityPublishReviewDto 不增加必填；服务端新冻结 v7 | 原 app-member + 发起人/责任/目标判权；200 |
| App POST `/:activityId/change-reviews` | ChangeReviewDto 新增可省略 metricSelection + expectedMetricSelectionRevision 的成对验证；省略保留 | 原 app-member + 当前 owner/原 scoped 业务判权；200 |
| Admin GET `/`、`/:id` | ActivityPublishReviewResponseDto 的 changeDiff 支持安全 proposal-v7；不直接返 snapshot | 原 activity-review.read.request 访问面；200 |
| Admin POST `/:id/approve` | ApproveActivityPublishReviewDto 形状不改；补声明引用不可用等已有错误 | 原 activity.publish.record 与 Service 内审核规则，非 ADMIN 角色直通；200 |
| Admin POST `/:id/return`；App reviews/withdraw | 请求形状不改；旧/新审核均走原状态机和幂等链 | 原权限与状态；200 |
| App legacy submit-publish-review、submit-change-review；direct-publish | 不强制新增字段，不接受指标旁路；新版本化内部调用按 v7 验证，legacy 历史分支保留 | 原可见性/责任/业务开关，紧急正式发布仍拒绝 |
| App template-resolution；Admin 原活动发布/受众发布 | 原返回与业务行为保持，核验内部版本分发不遗漏 v7 | 原权限，不扩大 surface |

新权限、Permission seed、Role/Binding、审计事件和资源类型增量均为 0。新 v7 继续使用已有 activity.publish 审核审计，以 reviewId 关联冻结快照；不改变旧 extra 或追加重复“成功事件”。若现有审计不足以覆盖实测原子性，先上报具体扩展，不悄悄变更目录。

| 已有错误符号 | code / HTTP | 原 message / 使用边界 |
|---|---|---|
| BAD_REQUEST | 40000 / 400 | 请求参数错误；DTO 字段/成对输入非法。 |
| ACTIVITY_METRIC_SELECTION_INVALID | 20174 / 400 | 活动指标选择无效；新输入指标 grammar 非法。 |
| ACTIVITY_METRIC_SELECTION_STALE | 20175 / 409 | 活动指标选择已变化，请刷新后重试；提交 expected revision 不符。 |
| ACTIVITY_METRIC_REFERENCE_UNAVAILABLE | 20172 / 409 | 引用的指标定义不可用，请重新选择；新选资格失败。 |
| ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID | 20022 / 409 | 活动审核快照无效或已过期；持久化 v7 envelope/hash 非法。 |
| ACTIVITY_PUBLISH_REVIEW_EXPECTED_SNAPSHOT_MISMATCH | 20144 / 409 | 发布审核预期的活动快照已变化,请刷新后重新提交；批准 base/revision 过期。 |
| RBAC_FORBIDDEN | 30100 / 403 | 无权执行此操作；原判权拒绝，不能先泄露指标/组织存在性。 |

身份、不存在、pending、self-review、operationKey、紧急起源和底层错误继续沿原顺序/消息/HTTP；不重新映射旧错误。实现若需新错误符号则暂停，不预占 20184。

## 6. 精确实施写集预算（待批准）

这是允许差值的上界，不是要求每个文件都改；每条必须有调用链或派生依据。未列路径不授权，历史归档不修改。当前文档 PR 只写 §9 的九个路径，下列代码路径本次均不写。

### 6.1 现有业务与测试文件

```text
src/modules/activities/activity-publish-proposal-v2.service.ts
src/modules/activities/activity-publish-proposal-v2.service.spec.ts
src/modules/activities/activity-publish-review-submit.service.ts
src/modules/activities/activity-publish-review.service.ts
src/modules/activities/activity-publish-review-query.service.ts
src/modules/activities/activity-publish-review.dto.ts
src/modules/activities/activity-publish-review-access.ts
src/modules/activities/activity-publish-readiness.service.ts
src/modules/activities/activity-publish-readiness.service.spec.ts
src/modules/activities/controllers/app-managed-activities.controller.ts
src/modules/activities/controllers/admin-activity-publish-reviews.controller.ts
test/e2e/activity-os-r2-b5-snapshot-v6.e2e-spec.ts
```

唯一预列的旧 E2E 适配为 B5 中“新 writer 产 v6”的当前时态断言，改为“新 writer 产 v7”，同时把原 v6 样本/解析/hash/apply 断言保留成历史兼容用例。不是批准删除测试或放宽断言；其他旧 E2E 若需适配必须列出差异另报。readiness 旧指标恒阻塞断言只能改为本稿三态的独立正反例，其他域原断言保留。

### 6.2 拟新增具名文件

```text
src/modules/activities/activity-publish-proposal-v7.ts
src/modules/activities/activity-publish-proposal-v7.spec.ts
src/modules/activities/activity-publish-metric-selection.ts
src/modules/activities/activity-publish-metric-selection.spec.ts
test/e2e/activity-os-r3-c1-d2c-proposal-v7.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2c-proposal-compatibility.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2c-proposal-concurrency.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2c-readiness.e2e-spec.ts
docs/ops/activity-metric-proposal-v7-rollout.md
changelog.d/activity-os-r3-c1-d2c.added.md
```

v7 helper 为纯类型/grammar/canonical/hash；metric-selection helper 接受调用者 tx，组合已有原语与明确 historical 分支，不建独立根事务或新 provider。不改 D2b 全局新选锁原语、不新增 module 接线，不扩大 authz/rbac/用户/组织写集。

### 6.3 契约、派生与交接预算

```text
test/contract/openapi.contract-spec.ts
test/contract/__snapshots__/openapi.contract-spec.ts.snap
docs/handoff/openapi.json
docs/handoff/clients/admin/client.ts
docs/handoff/clients/admin/types.ts
docs/handoff/clients/app/client.ts
docs/handoff/clients/app/types.ts
docs/handoff/clients/auth/client.ts
docs/handoff/clients/auth/types.ts
docs/handoff/clients/integration/client.ts
docs/handoff/clients/integration/types.ts
docs/handoff/clients/open/client.ts
docs/handoff/clients/open/types.ts
docs/handoff/clients/system/client.ts
docs/handoff/clients/system/types.ts
docs/handoff/clients/shared/types.ts
docs/ai-harness/ROUTE_AUTHZ.md
harness/state-machines.json
docs/ai-harness/STATE_MACHINE_INVENTORY.md
CODEMAP.md
src/modules/activities/CLAUDE.md
docs/handoff/admin-web.md
docs/handoff/miniapp.md
docs/ops/activity-metric-selection-template-rollout.md
docs/ai-harness/FROZEN_DRAFTS.md
docs/ai-harness/NEXT_TASKS.md
```

客户端只由生成器产生真实差值；无关 surface 预期不变。ROUTE_AUTHZ 仅真实派生新鲜度，不改权限声明。state-machines 只记录真实 writer，不变更状态图或 schema 摘要来抹掉失败。若生成器要求 domain-map 等写集外文件，先列原因再申请，禁止直接扩大授权。

红区实施令牌需维护者在实施批准后逐路径发放：`test/contract/openapi.contract-spec.ts`、`test/contract/__snapshots__/openapi.contract-spec.ts.snap`、`docs/ai-harness/ROUTE_AUTHZ.md`、`harness/state-machines.json`。执行前用 harness:needs 逐文件复核，不能把起草授权当实施授权；AI 不运行 harness:grant。新稿合入冻结后不回改。

仅供维护者**批准实施后**执行的命令如下；每个命令只有一个精确路径，不授通配符：

```bash
cd /Users/dengwang/Documents/coding/srvf-nest-api
pnpm harness:grant 'test/contract/openapi.contract-spec.ts' --reason '确认 C1 D2c implementation 方案 A；仅 v7 已批准契约与历史兼容断言'
pnpm harness:grant 'test/contract/__snapshots__/openapi.contract-spec.ts.snap' --reason '确认 C1 D2c implementation 方案 A；仅逐行审查后的真实契约差值'
pnpm harness:grant 'docs/ai-harness/ROUTE_AUTHZ.md' --reason '确认 C1 D2c implementation 方案 A；仅派生新鲜度，不扩权限'
pnpm harness:grant 'harness/state-machines.json' --reason '确认 C1 D2c implementation 方案 A；仅真实 writer 登记，不放宽状态图'
```

## 7. DoD 与幂等探针队列

| 探针 | 未满足才实施 | 必须回传的证据 |
|---|---|---|
| P0 旧行为基线 | 先跑原 proposal/readiness 单测与发布审核、B5 v6、D2b 选择定向 E2E，再改 service 编排 | 原 HEAD、命令、退出码；原行为差异先报告。 |
| P1 版本闭环 | 缺新 v7 时补建/解析/hash/变更/apply/RuleSnapshot/详情分发 | 三态 base/target，逐字段变异 hash 必变，unknown/null/伪指针各自拒绝；新提交的真实 HTTP+DB 证据。 |
| P2 历史隔离 | 缺逐版本证据时补 v2/v3/v4/v5/v6 与 legacy 在途夹具 | 每版旧 hash 原样、旧请求原错误/响应、批准后指标四列逐字保持；不得用只测 v6 代替六条链。 |
| P3 真人闭环 | 从合法 Human 目录命令建定义→集→V3/活动选择→提交→另一获权真人批准 | required/not_required、专业/模板路径、旧省略输入、选集变更和无关编辑各自完整落库；不以直接造已批准 DB 行代替流程。 |
| P4 竞争与原子性 | 缺锁等待行为证据则补双连接屏障 | 提交/批准等待期间退役、撤权、停用、revision 变化各自拒绝；不触及选择的 retired 历史变更成功；异常回滚、重复键不多写；验证 scope 和锁序，不只查 SQL 字符串。 |
| P5 安全读面 | 缺 v7 diff 白名单则补 | 真实审核 GET 只含安全字段名，伪造含敏感键的快照不泄露；旧 v6 输出保持。 |
| P6 Readiness | 无真实三态/闭包结果则补 | 每态/坏锚点/退役新选/历史引用各一断言；V1/V2/legacy 原样及 V3 正反例；反复/重排事实结果确定；读前后零业务写与零审计。 |
| P7 授权及绕过 | 缺入口矩阵则补 | 无 member/停用/撤权/跨组织/非 owner/Admin 非角色直通拒绝；草稿 PUT pending、legacy PATCH/直发不侧写；紧急正式发布仍拒绝；B7 off/shadow/active 不扩成总开关。 |
| P8 收口 | 有未解释差值不得提交合并 | snapshot 逐行说明、客户端与 handoff、新 SOP、精确写集核验、本地 quick+定向/contract/build、完整 PR CI 与可信审批；跨模型复审债务仍标待整体评审。 |

测试库申请范围拟为本机 `app_test` 仅 migrate deploy/核验既有 112 条 SQL；`app_test_w1`、`app_test_w98` 用于定向 E2E 隔离验证与必要重建。必须维护者另行确认、核验 host/库名与无并发使用；不能沿用 D2b 的重建许可。本次不执行数据库操作。禁止 AI 自动 migrate dev/reset/db push/force-reset/accept-data-loss；若确需被禁止命令，由维护者当场执行，不以 goal 预授权替代。无新 migration，不改旧 SQL；不碰生产或其他测试库。

本地不跑全仓 E2E；全量由同一最终 HEAD 的 PR CI 冷跑。docs:refresh 在最后一次写后执行，并单独跑 frozen-drafts-ledger，随后复核无写集外派生差值。计数保持时不重签 3b/4b；任何新读数变化先解释，不自行签字。

## 8. 兼容停止新写与交付硬门

v7 已写入后不能直接 revert 为仅识别 v6 的二进制。维护者批准部署时必须指定统一 v7 兼容版本、禁止混合 fleet；如需暂停，通过独立批准的维护窗口停止受影响提审/批准/直发入口，保留兼容读者处理/解释在途审核。不能把 B7 off 当作这些入口已关闭的证据，不新增总开关。

回退不删除 v7 review、RuleSnapshot、选择或目录，不重哈希旧快照。正式指标内容、模板初始化、人员授码、部署与前端发布均独立审批。C1 仓内完成要求 D1+D2a+D2b+D2c 的完整证据；统一复审未完成就明确留债，不声称整体审查通过。C2/C3 Outcome/Value、Release 4 时长、Release 5 贡献不在本稿。

## 9. 本次文档写集与待确认语句

本次仅新增本文件，更正下列八份当前说明：`docs/ai-harness/FROZEN_DRAFTS.md`、`docs/ai-harness/NEXT_TASKS.md`、`docs/ops/activity-metric-selection-template-rollout.md`、`docs/ops/activity-metric-catalogue-rollout.md`、`src/modules/activities/CLAUDE.md`、`prisma/CLAUDE.md`、`docs/handoff/admin-web.md`、`docs/handoff/miniapp.md`。只修正 D2b 状态并登记本稿，未授权改历史归档、当前事实无关债务或旧 migration 摘要长记。

建议维护者回复：**“确认 C1 D2c implementation 方案 A（v7、旧版兼容、指标 Readiness、V3 识别及本稿精确写集）；允许指定测试库验证与隔离重建”**。这是待确认建议，不是已收到的授权；红区令牌、可信环境批准、具体 PR 合并和生产仍分别办理。本稿按 srvf-goal-author 规范给出 DoD/探针/授权/禁区/写集，批准前不生成或下发可执行 goal。

## 本次未做

未实施 v7/Readiness，未改代码、API、DTO、schema、migration、seed、权限、审计事件或 Gate；未跑数据库、跨模型评审、生产部署、发版或合并新 PR。D2b 已合入不等于 C1 整体完成。
