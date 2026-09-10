# activities — 本地铁律

> **D1-2 实施中（2026-09-10，尚未合并）**：按 #1311 及维护者补充确认，当前分支已接入时间政策 Human 管理目录八操作、显式 GLOBAL 读写两码、不可变版本及事务收据/审计。政策列表/详情、版本列表/详情及创建政策/版本、激活/退役均已接线；角色不自动授码，超级管理员也须显式码。当前154模型/118迁移、620端点、260权限、166审计总计/161活跃；4b按维护者确认重签。单测361套8010项通过（5项既有todo），契约1044项、定向HTTP/并发23项通过；不代表全量CI或整个D1完成。D1-3选择/发布冻结、D2–D8、生产与Gate仍未实施。本段优先于下方历史过程记录。

> **D1-1 已落地（2026-09-10）**：[#1310](https://github.com/BA7IEE/srvf-nest-api/pull/1310) 已合并至 main `04699ace`，18项PR检查通过，[合并后main CI](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34474531083)通过。实际39路径，154模型/118迁移；第118条SQL的3b已重签。TimePolicy、TimePolicyVersion、TimePolicyCommandReceipt及纯解析/生命周期已落地，尚无目录HTTP入口。维护者现授权D1-1台账更正及D1-2精确计划起草，仅文档、不实施；整个D1仍未完成，D1-3选择/发布冻结及D2–D8仍待后续。未操作生产、启用Gate或删除业务数据。下方过程记录保留为历史，不代表当前待合并状态。

> **D1 文档追加授权（2026-09-10）**：维护者已确认方案 A 方向，允许补充 changelog、提交、推送并创建文档评审 PR；不合并、不实施。本条覆盖下方起草时“方案待确认/不提交推送”的状态，不授权数据库、Gate 或后续实施。

> **2026-09-10 C5 合并收口与 D1 当前范围**：C5 已随 [#1307](https://github.com/BA7IEE/srvf-nest-api/pull/1307) 合入 main `883d66f9`，18 项 PR 检查通过；合并树与批准的 `3fe29414` 一致。合并后 [main CI 34451593463](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34451593463) 已独立核验 completed/success。当前为 612 端点、117 迁移、258 权限、165 总计/160 活跃审计。维护者仅授权 C5 台账更正及 D1 评审起草；D1 方案尚待确认，不实施、不操作数据库或 Gate，不提交推送。下方 C5 未合并等为历史时点。原紧急创建 500 根因仍未定位，本次 CI 通过不代表已修复；前端发布、生产部署和整体复审未完成。

下一步见 [D1 时长政策评审](../../../docs/plans/activity-os-r4-d1-time-policy-review.md)：建议先完成可追溯政策版本、受控选择与发布冻结，不改历史时长或现有结算；文档中的候选接口不是现有可调用能力。

> **C5 当前实施分支（2026-09-10，未合并/未部署）**：按#1306的40路径授权增加 outcome-report 单活动GET及 outcome-reports/query 有界POST200。显式 outcome.read + 当前Human成员/组织/发起人或owner资格；一个RC事务按ID稳定顺序锁Activity，等待后及返回前复判，整批失败不部分返回。完整验证历史正式成果后白名单投影，未确认返回null，保留false/0/规范小数字符串，不返证据、身份、内部来源和canXxx。612端点；117迁移、258权限、165/160审计不变；不改结算/归档/Gate。下方C5“仅起草”属历史记录，验收见C5实施计划。

> **main CI 异常补记（2026-09-10）**：[34438228787](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34438228787) 第2组 E2E 已失败：`activity-os-r2-b6-emergency-creation.e2e-spec.ts:236` 创建前置预期201、实际500（调用于601行）；该组72套/1349项通过，1套/1项失败。第1、3、4、5组全部通过，运行最终为failure。下文“仍运行”为早先核验记录，不代表当前或全绿；根因尚未确认，不能认定与C4无关。本轮只读诊断，未重试CI、未改代码或数据库；此异常不阻止仅文档起草，但不能登记验证收口。

> **2026-09-10 C4 已合并**：只读结束工作台随 #1304 合入 main `bab5110e`，18项PR检查/可信审批通过；main CI 34438228787仍在运行，不能宣称已部署。仅新增GET，610端点；117迁移、258权限、165/160审计不变。C5当前仅起草报表查询评审，方案A已确认并获准提交文档PR，未获实施批准。此段覆盖下方C4未合并/仅起草的旧时点，不更改既有访问与业务铁律。

> **C4 当前实施分支（2026-09-10，未合并）**：维护者已授权 #1303 的40路径计划。新增 ending-workbench 只读 GET，沿 outcome.read 的 Human/组织/责任授权，Activity 锁后及返回前复验；复用正式选择器和选择解析，取消草稿不再 pending，摘要不返实际值、附件、身份或操作许可。未改原命令、schema、迁移和 Gate。当前分支进度优先于下方“仅起草 C4”的历史记录。

> **2026-09-09 最新 main 事实**：C3-1 / C3-2 已合入 #1298 / [#1300](https://github.com/BA7IEE/srvf-nest-api/pull/1300)，四个 C3-2 App managed 入口已交付，3b/4b 与 PR 检查已通过。仅脱敏诊断的 #1301 已合入 `36ff609c`，[main CI](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34369385145) 通过；原紧急创建 500 根因未定位。整体复审、部署和 Gate 未完成。当前只起草 C4 评审，不改生产代码；下方“当前分支/未合并”等均为历史记录。

> **C3-2 当前工作树（2026-09-09，未提交、未合并）**：按 #1299 获批实施完整确认、正式更正与现行正式选择器。新增 App managed 四端点；confirm/correct 显式 Human 权限，无 SUPER_ADMIN 直通；read 沿既有码。确认复制新修订，准备/取消更正不替代旧正式成果；所有历史来源、值、证据与收据保留。59 项双池并发/回滚用例在 app_test_w98 通过；全仓 350 组单测（7859 项通过、5 todo）、quick 与 build 通过。3b/4b 已重签；完整验收、PR CI、合并、整体复审与生产未完成。此段覆盖下方旧阶段的“当前分支/仅文档”描述。

> **2026-09-09 当前收口（覆盖下方 C3-1 分支实施／未合并／未重签表述）**：C3-1 已随 [#1298](https://github.com/BA7IEE/srvf-nest-api/pull/1298) squash 合入 main `62abb469`；18 项 PR 检查、可信红区审批、3b（第 116 条 migration）和 4b（权限码 256；审计 164 总计／159 活跃）已完成。第 4 个 E2E 分片首次 25 分钟超时，未改代码或放宽限制，单分片重跑 9 分 18 秒通过；不据此宣告超时根因已修复。[main CI 34329487288](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34329487288) 已于本轮核验 completed/success，结果与 PR CI 分别确认。候选与来源永久保留；生产、Gate 和整体跨模型复审未完成。下一阶段严格为 **C3-2：完整人工确认、正式更正与现行正式选择器**；旧文中的“C3-2/C3-3”拆分不作为执行依据。维护者已授权台账更正及 C3-2 精确计划起草，**仅文档，不实施；已追加授权补 changelog、提交、推送和创建文档评审 PR；不合并**。

## C3-1 指标候选（当前分支，未合并、未部署）

一份 active 指标集只能显式绑定一个受控规则；绑定由 Human GLOBAL `activity-metric.manage.rule-binding` 创建，
不自动授予内建角色。App managed owner 以独立 `activity.outcome.calculate` 显式授权计算候选，
每次命令／重放和每次锁等待后都重新核验活动、组织、身份、范围及属主。
候选按已完成参与事实计算人数和时长；值、来源和计数快照不可变，读面不返回成员、身份、时段或原始来源。
Gate 关闭时明确拒绝，不用零值代替不可用来源；候选永久留存，不新增删除／过期／清理路径。
第 116 条 migration、隔离库 116 条冷回放、115→116 非空升级，以及 C3 专属 30 条 HTTP／数据库／查询计划、9 条锁等待、22 条迁移约束用例已在本分支的 app_test_w98 通过（共 61 条）。P12 已以真实库覆盖 1000／1001 单身份 replace／void 链，以及 2000 名成员／20000／20001 事件、10000 来源；满额成功只按现有 30 秒命令预算验收，不是生产延时承诺。
真实更正 prepare／失败回滚／commit、现场提前离场及现场作废、离线 package 上传、离线 review 批准、结算重投影、现场 identity 创建，以及发布后场次取消／改期 effect 的 Activity 锁交错均有验证。来源读取按既有物化器的 `occurredAt, id` 顺序重放，避免随机 UUID 排序误判有效 replace／void 链。等价有界 SQL 的 EXPLAIN 只证明 index path 可用；PR CI、可信审批、合并、生产 deploy 与整体跨模型复审仍未发生。

## 服务段更正方案 A（#1296 已合并，未部署）

prepare 仅创建 CorrectionPendingSegmentRevision 和首次准备数量收据，不创建正式段。
commit 同事务内核验精确 base，先 superseded 再物化 draft，复用原 ledger commit。
清理仅由独立批准的维护者 CLI 逐 application 执行，默认只读；收据不可变，正式历史不删。
prepare/commit（含重放）复用 GLOBAL `activity.settlement-final-review.record`；根锁等待后
经 Users 属主原语重读当前用户，绑定成员失效拒绝，未绑定成员的管理账户沿既有 GLOBAL 规则。
原更正、主路径、失败回滚、清理竞争和锁等待撤权共 8 组 110 条在 app_test_w98 通过；
另有非空旧 application 升级及冷回放 5 条通过。全量本地单测、#1296 PR CI 与可信审批通过，3b 已重签。
main `638fc784` 已包含本批；整体复审、部署和真实清理未完成。C3-1 是当前分支的未合并实现，不代表已上线或完成整体复审。

## C2 D2 当前交付（已合入 #1293，未部署）

人工成果独立使用 Outcome Service/Query/Presenter/Access/AuditRecorder；仅三个 Human App managed 接口。
写及重放都复验当前 App 身份、显式 outcome 授权、组织资格与 initiator/owner，SUPER_ADMIN 不直通。
命令锁→Activity→引用锁，每次等待后重读权限；成果/值/证据、旧 draft→superseded、收据、审计同事务。
历史明细绑定自身集 id/hash，不读取当前选集替代历史；不返原始行、内部来源引用、操作键或存储凭证。
草稿完整快照只接非敏感整数／规范小数字符串／布尔／受控选项；不接 short_text、不创建 confirmed。
C1、发布、Readiness、考勤、时长与贡献行为不变。#1293 已合入 `7f4fdbd7`，18 项 PR 检查、可信审批及 main CI 34118403784 通过；下方“成果未实施”属于历史交付时点。整体跨模型复审与生产未完成；C3-1 当前在独立分支实施，范围和验证以本文件顶部为准。

## C1 D2b/D2c 当前实施边界（D2b 已合入 #1282；D2c 已合入 #1284）

Activity 三态选择、Template V3、Human GLOBAL 模板维护、App 可新选 options 和五条物化链
已随 #1282 合入 `f5b5b226`；交付、排错及生产限制见 [`activity-metric-selection-template-rollout.md`](../../../docs/ops/activity-metric-selection-template-rollout.md)。
新选择为 required/not_required，旧活动保持 unconfigured/revision=0；历史退役引用仍可解释，不能新选。
V3 在同一事务、锁等待后重读当前身份/权限/Family/指标闭包；Quick 审计透传该当前身份，
V1/V2 保留既有 hash/重放行为。App options 只校验当前队员发起组织资格，不隐含 GLOBAL 目录权。
每目录最多 1000 候选，1001 明确 20183/409；完整 grammar/hash/active 闭包过滤先于分页和 total，
只读事务固定同一快照，不缓存资格、不返回配置/表单全文。
既有 activity.update.record 的业务说明及 6→8 管辖面基线已按精确授权同步；组织资格属主原语扩展已获批准并实现，3b/4b 已于 2026-09-06 按维护者确认重签；18 项 PR 检查、可信审批、合并及 main CI 均完成。
D2c 的新初发/变更审核写 V7：base/target 都冻结选择三事实，显式选择必须配对 expected revision；省略已发布活动的选择只保留历史引用，显式同值仍按新选资格复验。锁序为 Activity→集→定义，锁等待后重验当前 App 身份、责任和活动状态；仅 approved apply 可写 Activity 选择。旧 v2–v6/legacy 的 parser/hash/apply 不改。审核 diff 只给 `proposal-v7` 的安全字段名；内部 Readiness 识别 V3，按 unconfigured/not_required/active-required/historical-required/invalid 判定，但不接 HTTP、发布 Gate 或成果值。详见 [`activity-metric-proposal-v7-rollout.md`](../../../docs/ops/activity-metric-proposal-v7-rollout.md)。D2c 已随 [#1284](https://github.com/BA7IEE/srvf-nest-api/pull/1284) 合入；PR CI、可信审批及合并后 main CI 均通过。C1 的 D1–D2c 仓内实现已收口，但整体跨模型复审仍待统一完成；不代表生产上线、目录初始化、成果值或 Gate 开启。

## C1 D2a 当前目录边界

Human Admin 指标定义/集目录已有独立 Controller、写 Service、查询投影、状态机、审计与命令收据。
写入及重放均在根事务复验当前用户和 GLOBAL 权限，等待命令锁/父版本锁后再验；RBAC 显式传 tx。
定义/集只许 draft 编辑，draft→active→retired；激活集先锁父再按 ID 锁定义并复验 canonical/hash。
收据只返原六字段结果，不返配置或 operationKey；审计与目录/收据同事务。
D1 解析器仍是唯一值域真源。D2b/D2c 当前进展以上节为准；成果值仍未实施。

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);上下文边界读 [`/docs/participation-bounded-context.md`](../../../docs/participation-bounded-context.md);架构边界读 [`/docs/architecture-boundary.md`](../../../docs/architecture-boundary.md);API surface 边界读 [`/docs/api-surface-policy.md`](../../../docs/api-surface-policy.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## Scope

- **活动主资源**:create / update / publish / cancel / complete 生命周期管理
- **发布审核**:`ActivityPublishReview` 的 initial submit/direct publish/approve/return/withdraw/cancel；Admin 工作台由独立 controller/query/presenter 承载，审核事务固定锁序 Activity → review
- **活动责任**:`ActivityResponsibilityAssignment` 是 owner/协办历史真源；发布事务同步创建唯一 owner 与 system-managed scoped RoleBinding，Admin 责任面由独立 controller/service/policy/projector/audit 承载
- **活动岗位子资源**:`ActivityPosition` 归本模块；Admin CRUD 走 `AdminActivityPositionsController` + `ActivityPositionsService`，不新建 NestJS module
- **状态机 4 态**:`draft → published → completed`，另有 `draft|published → cancelled`;`completed` 的**唯一推进通路**是管理端 `POST admin/v1/activities/:id/complete` 经本状态机执行。考勤提交只建 pending Sheet，禁止再直写 Activity 状态。
- **App 视角**:`AppActivitiesService` 的可参加池仅含 published + 公开报名 + 未结束活动；detail 刻意仍以 published 可见；显式 invitation 仅本人 accepted 或 `expiresAt > now` 的 pending 可见，detail 纯加法仅返本人的 `myInvitations[]`。`GET :activityId/positions` 只认 published + 公开报名活动，返回 live 岗位余量 / `canRegister`。`AppMyActivitiesService` 暴露本人参与过的活动列表(按 `memberId` 锁定)
- **后台批任务**:`ActivityBatchWorker` 只复用两个既有 worker 进程与 PostgreSQL `ActivityBatchJob` lease/fence；活动开始 reconciliation 不新增 cron、queue 或进程，参与状态的实际 writer 归 `activity-registrations/`
- **不负责**:报名状态(`activity-registrations/`)、考勤(`attendances/`)、贡献值结算(`contribution-rules/` + `attendances/contribution-calculator.ts`)

## Local facts

- **Activity OS R3 / C2 D1（已随 #1289 合入）**：Outcome／Value／Evidence 三表、第 113 条迁移、纯值校验及获批回归已交付，3b 已重签；值校验复用 C1 定义配置与 canonical/hash。#1290 仅补 B6 创建失败的脱敏诊断，最终 main CI 34092294387 通过，旧 500 根因未定位，不认定已修复。没有成果 Service writer、HTTP、权限或 Gate；C2 D2 仅起草人工草稿／修订评审，实施仍待授权，附件活动归属必须在 D2 事务内验证；C3 负责正式确认及证据完整性。下方“成果值仍未完成”指业务闭环，不表示 main 没有数据地基；整体跨模型复审与生产仍未完成。

- **Activity OS R3 / C1 D1（内部数据地基）**：`ActivityMetricDefinition`、`ActivityMetricSetVersion` 与 `ActivityMetricSetItem` 提供精确 `(code,version)`、Restrict FK、draft→active→retired 与激活后冻结；集项写入同时更新 draft 父版本，使其与激活串行且旧快照事务不能绕过；定义退役不改历史集。纯函数解析五种受控类型、canonical/hash 和激活引用闭包，DB 不复算 hash。D2c 的 V7 审核在既有根事务内使用这些事实做锁后复验，不添加目录状态 writer、HTTP、权限、seed 或 Gate。D1–D2c 的仓内实现已完成，但整体复审、生产可用性、目录初始化与成果值仍未完成。

- **Activity OS R2 / B6 D2（三种草稿创建）**：App managed 独立 `from-template` / `professional` / `emergency` POST 与物理 App DTO 显式映射封闭命令。`ActivityCreationService` 是唯一根事务所有者；快速模式复用 A6 精确 Version/幂等锚点，并把地点配置与容量确认绑定到请求 hash；专业模式一次物化 Activity、Session/Position、地点、B3 governed Form、既有 Qualification、D1 收据和最小审计。紧急模式叠加独立权限，冻结组织/成员受众，起源、七项义务、一次 `emergency` 定向 outbox 和审计同事务；呼叫不是正式发布。immutable 起源在 App 提审/直发、Admin 两种发布和审核/apply 写边界均拒正式发布，补齐也不解锁。义务仅凭现有事实更新，Session/Position/地点消失会退回 pending；设备/结果/事故关联不伪装为 verified，考勤仍 pending。入口沿既有责任制开关，B4 readiness 仍不接发布 Gate；不新增 schema/migration/权限码/审计事件。

- **Activity OS R2 / B4（内部 gate-off）**：`ActivityPublishReadinessService` 在单个只读事务中把 Activity、live Session/Position、A5/V3 模板解析、Form/Qualification canonical 结果、指标选择有界闭包及既有保险开关投影为最小 facts，再由纯 evaluator 按固定域序输出 blocker/warning/suggestion。指标仅按 unconfigured/not_required/required active-or-historical/invalid 判定：未配置、坏闭包和草稿退役引用分别给 `METRIC_SELECTION_MISSING`、`METRIC_SELECTION_INVALID`、`METRIC_REFERENCE_UNAVAILABLE`；已发布历史引用可解释。Time/Contribution/Safety 仍 unrepresentable。它不 export、不接 controller、审核、发布链路、Gate、Audit 或缓存；地点只看当前 Session/Position 的 WGS84 坐标与半径，不读 ActivityPlace/PlacePreset。
- **Activity OS R1 / A2-A6**：A2 的 `ActivityTemplateFamily` 是稳定身份，future Version 的 `familyId`、definition 元数据保持零回填；A3 为其提供 canonical JSON/hash 与 `draft → active → retired` guard，legacy 行不受影响。A4 为 `Activity` 加可空 `selectedTemplateVersionId`，A5 只读时非空指针精确优先、NULL 保留 legacy fallback。A6 的模块内 `ActivityFromTemplateService` 先按 operationKey 重放，再锁定精确 Version、复验 A3 hash 与严格 Definition V1，并在同一事务复制 Activity / Session / Position 与安全审计；成功 Activity 保存选定 Version、operationKey 与 requestHash。它不按 Family 状态或 effective interval 发明“当前可选”规则；V1 不含坐标，要求定位或半径的场次 / 岗位一律 fail-closed。A6 不新增 HTTP、DTO、Swagger、路由、权限码、Gate、seed 或回填。
- **Activity OS R1 / A1(目录层，非运行时)**：`activity-type-migration.registry.ts` 是旧 `activityTypeCode` 的唯一静态迁移解释；`activity_category` 与 `activity_semantic_facet` 只由 seed 提供受控目录。本 PR 不新增 schema、模板/政策对象、Facet assignment、端点、权限、Gate 或旧值写路径；后续 A2 起必须在本 PR 合并、CI 验收后另立。
- `activities.service.ts` **1373L**(偏厚,沿 CODEMAP 标 L 体量);活动岗位 CRUD/扩容递补已边界化为 `activity-positions.service.ts`(623L) + `activity-position-audit-recorder.ts`，发布审核边界化为 `activity-publish-review.service.ts`+query/presenter/audit/state-machine,其中**提交/直发命令族**再拆为 `activity-publish-review-submit.service.ts`,两侧共用的事务原语与幂等原语落在纯函数模块 `activity-publish-review-access.ts` / `activity-publish-review-idempotency.ts`(不持 PrismaService、以调用方 `tx` 为入参,故不下放事务所有权、不产生隐式锁序)；责任边界化为 `activity-responsibility.service.ts`(755L)+policy/projector/audit，不继续堆入主 service
- **活动责任闭环 PR-5/PR-11 gate**:`ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED` 在 dev/test 缺省 false，production/smoke 必须显式；false 保持旧 Admin 行为。true 时 create 解析正式 initiator，pending 冻结 Activity/岗位，published 写转 20037，旧 publish 仅审批 pending initial 或允许发起人直接发布；发布成功同步投影唯一 owner。PR-11 已完成通用角色 contract 摘权并把 Docker smoke API/worker 切 true；真实 production 仍须先跑只读 preflight、补齐责任/reviewer、drain 全 fleet，禁止混档
- **活动责任闭环 PR-6/PR-9 App 面**:`/app/v1/my/managed-activities` 与既有报名历史 `/my/activities` 物理分离；activities 模块 3 个 managed controller 共 20 路，App DTO 独立。draft Activity/岗位只允许 initiator 直改；published 由 active owner 提交 schemaVersion=1 完整 proposal，approve 固定 Activity→review 锁序并在同事务复校、应用 Activity+positions diff、递增 revision、容量候补递补与 audit。PR-9 起 list/detail 读侧归 `activity-workflow-query.service.ts`，闭环纯判断归 `activity-closure-policy.ts`；主负责人活动结束后声明考勤完成时锁 Activity 根、同事务写声明 + audit。Activity cancelled 是责任闭环终态，优先于声明与全部考勤派生，固定 detail `closure=cancelled/null`、list 顶层 `statusCode=cancelled + nextAction=null`；只有 completed + 已声明 + 有效 Sheet 全 approved 才 closed。
- **PR-12 发起/组织不变量**：`ActivityInitiationPolicy` 是 create 与 draft 真实改组织的唯一资格入口；在 Activity 事务内校验目标组织 ACTIVE/未删/非根、initiator ACTIVE/未删且 `isFormalMemberGradeCode()` 为 true、至少一个 ACTIVE live User，以及 initiator membership 或 acting CurrentUser 的既有 scoped cross-org grant。正式等级与组织归属独立；draft 只用持久化 `initiatorMemberId`，null fail-closed；同组织值不新增策略查询。published change proposal 的 `organizationId` 必须与当前 Activity 相同，submit 与 Activity→review 锁后的 approve 都复校并复用 20022。
- **责任锁序与投影不变式**:新增/移交固定 Activity → 目标 Member（移交时新旧 memberId 排序）→ current assignment → RoleBinding；assignment 与 `system:activity-responsibility:{assignmentId}` binding 必须同事务创建/结束。owner=`activity-owner`，协办按 registrations/attendance capability 投影对应角色；通用角色 API 永不代写这些 binding
- **发布审核快照与并发**:历史 schemaVersion=2 快照/哈希/审批行为逐字兼容；schemaVersion=3 把 canonical Form target 纳入 stale hash 且永不纳入 allocation mode；schemaVersion=4 在 v3 基础上把 `allocationModeCode` 纳入 Activity target/base 与 stale hash，只有 v4 apply 可以写回该字段。历史 v1 缺字段时保留 locked Activity 当前 mode，v2/v3 审批也不得以 undefined 覆盖。RuleSnapshot 只留 `{formVersionId,version,schemaHash}` 指针。initial approve 在 Activity → review 锁后重建并比较服务端快照；change approve 在同一锁序下解析、二次验证完整 proposal，再由无自有事务的 applier 应用聚合 diff；两者均复查 revision 并只递增一次 workflowRevision。并发 E2E 必须是两套 Nest/Prisma pool + PostgreSQL lock waiter barrier
- **容量桶投影(第 4 批⑤)**:`ActivityCapacityBucketProjector` 在已持有的 Activity → review 锁序内、Form/Rules 后且 QR/population revision 前，按 `scopeTypeCode,scopeId` 锁并投影 activity/session/position 三类目标桶；同容量零 UPDATE，变容 CAS 恰加一次 version。它只核对 `occupied=active CapacityReservation` 数量；新桶仅初始化 `occupied=0`，既有 `occupied` 不修改、不增加、不减少、不重算，且生产代码零 `CapacityReservation` DML；错误锚定、漂移、降容或带占用历史 scope 一律 `20147` fail-closed 并回滚审核事务。
- **报名 Form version**:`RegistrationFormVersionService` 在 Activity 根锁内分配版本；draft 只由 initiator 直改，相同 canonical PUT 无写入/无 audit，active replacement/移除会撤销旧版本 active upload sessions。draft `schemaHash=null`，只有 active 写 hash；clone 只复制 definition 为目标 draft v1，不复制答案/附件/会话/审核历史。
- **活动通知 durable L2**:发布广播、直接改期、发布审核结果/审核后改期、活动取消 fan-out 与 Activity/岗位扩容递补，必须在各自主业务 transaction 内经 `ActivityNotificationProducer` enqueue 既有 outbox event；enqueue 失败回滚业务。审核结果 gate=true 的 change 收件人只认审核时当前 ACTIVE owner，禁止回退 `publishedBy`；initial 仍认 initiator。provider 仅由独立 worker 在 commit 后执行。
- **B7 会员受众标签**:`ActivityPublishReview.audienceTagCodes` 是 nullable JSONB，运行时只把 `string[]` 视为有效：`null` 留在 legacy 广播路径；`[]` 匹配全部 ACTIVE 且未软删的 Member，非空数组按 ACTIVE、未软删的 `member_audience_tag` 标签 OR 并集去重。B7 初发仅限公开报名活动；持有 Activity → review 根事务锁后才解析收件人并与发布/audit/outbox 同事务写入，outbox 收件人快照后不随赋标变化；取消通知范围不变。`ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED=false` 时，既有登录/权限判定先行，成员标签 GET/PUT、新发布路由及携带非空标签的发布审核 approve 返回 503；通用字典和 legacy approval 不受此 gate 影响。
- **组织定向(维护者 2026-08-25 拍板)**:`ActivityPublishReview.audienceOrganizationIds` 与 `audienceTagCodes` **逐字同形**的 nullable JSONB，是**第二个正交收窄维度**，两者取**交集(AND)**——「在这些组织(含下级)里」**且**「有这些标签」才收得到。三分支:`null` = 不按组织定向(存量行与不勾组织的新行都落这里);`[]` = 该维度不设限(与 `audienceTagCodes` 的 `[]` 同构;⚠️ **空数组不是空交集** —— 把它当交集会让「没勾组织」变成「谁都不发」);非空 = 该组织**及其全部后代**中有有效任职的会员。⭐ **「含下级」走 `organization_closure` 真子树**(`ancestorId ∈ 勾选组织 → descendantId`，含 depth-0 自身行)，复用全仓既有的同一条子树口径，**不是** `Organization.code` 前缀匹配;有效任职复用 `MembershipTermStateMachine.effectiveWhere(at)`，时刻取业务事件时刻不取新墙钟。⚠️ **不收窄时盖章逐字节不变**:`basisKind` 仍是 `audience-tags` / `all-active-members`、`basisRef` 仍是裸标签码、幂等 `requestHash` 的 payload 形状也不变 —— 否则在飞的 intent 重放会带着不同 payload 撞上 `sameIntent`;只有真的按组织收窄时才落第 6 个依据常量 `audience-organizations`，此时 `basisRef` 用 `tag:` / `org:` 前缀区分两个维度。audit 的 `audienceOrganizationIds` 键同理**空数组时整个键不进 extra**。入参校验与标签码同处置:勾选的组织解析不出未软删行即整批 400(打错 id 会让交集为空、通知一个人都不发却照样 200)。
- **责任通知 durable L3**:协办新增/结束与 owner 移交必须在 assignment、system-managed RoleBinding、audit 的同一 transaction 内经 `ActivityResponsibilityNotificationProducer` enqueue；移交以新 owner assignment id 形成稳定 key，并分别快照旧/新 owner，禁止读取 `publishedBy`。任一 intent 失败整体回滚，worker 仅在 commit 后生成定向通知。
- **判权(终态 scoped-authz PR12,2026-07-02;v0.40.0 +complete)**:6 个写方法(create/update/delete/publish/cancel/**complete**)判权走 `assertCanOrThrow` → `authz.explain`;`create` 无 ref(GLOBAL-only,scoped 创建留后续批);`update`/`delete`/`publish`/`cancel`/`complete` 带 `{type:'activity', id}` ref(scoped 持有者〔如 team-leader 经 policy→org-admin@TREE〕在其组织树内可用);`resource_not_found` 回退 `rbac.can` 全局码判定,持码者 return 交回 `findActivityOrThrow` 抛既有 `ACTIVITY_NOT_FOUND`,无码者 30100;`list`/`findOne`/`options`(F1/A6 新增)仍无码仅登录(Slow-4 现状不变;RBAC_MAP §2.4 BD-3 已决 won't-do 新增 `activity.read.*` 码)。e2e 见 `test/e2e/participation-scoped-authz.e2e-spec.ts`。
- **App 可报名池 endAt 过滤(v0.40.0 参与域生命周期收口③)**:`AppActivitiesService.listAvailableForMember` where 追加 `endAt >= now`——已结束(endAt < now)的 published 活动退出可报名列表;`findVisibleByIdForMember`(detail)口径**刻意不动**(published 即可见,已报名者回看已结束活动无碍)。报名 endAt 闸在 `activity-registrations` 侧 `assertActivityRegistrable`(20125),不在本模块。
- **F1/A6(2026-07-04,路线图 §4 A6)**:list 新增可选 `q`(模糊 title)/`dateFrom`+`dateTo`(startAt 区间)/`includeDescendants`(配合 organizationId,注入 `OrganizationsService.queryDescendantOrgIds()`)/`includeStats`(默认 false;true 时批量 `groupBy` 聚合 `registrationCount`/`attendanceSheetCount`,禁 N+1);新增 `GET /options`(`q?`/`statusCode?`/`organizationId?`/`limit?` → `{items:[{id,label,startAt,statusCode}]}`,USER 角色同样强制白名单状态防泄漏)。0 新权限码、0 schema。
- Admin Controller:`activities.controller.ts` `@Controller('admin/v1/activities')` `@ApiTags('Admin - Activities')`
- Admin 岗位 Controller:`controllers/admin-activity-positions.controller.ts` 同前缀嵌套 `:activityId/positions[/:activityPositionId]`；list/detail `[auth]`，create/update/delete 复用 `activity.update.record` + activity ref
- App Controller:`controllers/app-activities.controller.ts` `@Controller('app/v1/activities')` `@ApiTags('Mobile - Activities')`(单文件单 class,**非** Mixed Controller)
- DTO 隔离:Admin DTO 在 `activities.dto.ts`(524L);App DTO 在 `dto/app/`(4 文件)
- **活动 participation-summary 评价扩展(F3)**:`ActivityParticipationQueryService` 只调用
  `ActivityFeedbacksQueryService.aggregateForActivity(activityId)` 追加 `{feedback:{count,avgRating}}`；
  单次 aggregate、总业务查询固定 4 次；不在本模块复制评价统计，也不改既有度量字段算法。
- Audit:主资源写路径走 `activity-audit-recorder.ts`；岗位写路径走 `activity-position-audit-recorder.ts`；发布审核走 `activity-publish-review-audit-recorder.ts`；**event 统一复用 `'activity.publish'`，不新增事件**，以 `extra.operation` 区分
- **岗位容量并发基线**:PATCH capacity 必须事务内先锁 `Activity` 行，再重读 `ActivityPosition.capacity` 与本岗位 passCount；锁对象仍只有 Activity，不加岗位行锁
- **活动窗父子不变式**:PATCH Activity `startAt/endAt` 与岗位 create/update/softDelete 共用 Activity 聚合锁；锁后校验全部 live 岗位独立窗仍落在新活动窗内，越窗复用 `ACTIVITY_POSITION_TIME_RANGE_INVALID=20017`，事务整体拒绝
- **保险生命周期 PR-A**:`INSURANCE_ENFORCEMENT_ENABLED=false` 时 update 保持旧查询图；gate=true 时必须在既有 Activity `FOR UPDATE` 根事务内、真实写前检查 live(`deletedAt=null`)且 `statusCode!='cancelled'` 的报名。已有此类报名后，`requiresInsurance` 真值变化一律复用 `ACTIVITY_STATUS_INVALID`；current `requiresInsurance=true` 时 `startAt/endAt` 的实际变化同码拒绝；current false 且仍 false 的改期保持旧行为。策略归 `InsuranceRequirementService`，本模块只持根事务/锁并传当前与合并后值。
- **容量父子不变量**:`Activity.capacity` 始终是全局硬上限；岗位 capacity 只会进一步收紧。Admin/App 活动 list/detail 的 effective capacity 取父上限与岗位合计的交集；有限总容量下岗位合计不得超过父上限。Activity/岗位 capacity 写均在 Activity 聚合锁后重读全部 pass 与 live 岗位容量；岗位扩容递补还必须受全局剩余量裁剪。**B-D1(维护者 2026-08-01 拍板)**:名额语义在岗位上，**有 live 岗位时编辑 `Activity.capacity` 不触发任何递补**(Admin `update` 与 App change-proposal `applier` 同口径)；放人只走岗位扩容那条路。**无 live 岗位**活动的父容量递补行为逐字保持(调大按 delta、改无限递补全部、缩容不递补)。
- **候补 Member 生命周期(PR-E)**:`activity-waitlist-promotion.ts` 两套引擎都固定 Activity→Member→Registration；FIFO 候补的 Member inactive/软删时保持 waitlisted，本轮用 registration id 排除后继续扫描下一名 ACTIVE 队员。旧 writer 只查询无永久 identity 的 legacy header（合法当前兼容提交也可已有 header revision）；canonical 候补只能由 allocation caller 递补。只有实际推进者写 `registration.review/promote` audit 与通知。
- **整单取消 lifecycle（第 4 批第三刀）**:`cancelLocked` 已在既有 Activity 根事务内调用纯 lifecycle helper；helper 固定锁 header→identity→current revision，只关闭 canonical `pending|waitlisted`、追加 admin Registration/Participation revision 并 CAS 投影。pass 的 active reservation/pointer/population 保留，任何 current revision/status/pointer/population/active reservation 漂移为 20147 整笔零写；不复制或搬运 `CapacityReservation` DML。
- **多队列共享父预算(2026-08-01 整批评审 P1)**:一次事务里放开**多条**队列(App change proposal 同时扩容多个岗位)必须走 `promoteActivityWaitlistsWithinSharedCapacity({ activityId, orderedPositionIds })`，**不得**逐岗调单岗版 —— 递补写的是 `waitlisted → pending` **不是 `pass`**，父活动 pass 基线在整个批次里不动，逐岗调用会让每一岗都把同一份父剩余量完整领走，合计递补数突破活动容量。批量入口按**稳定岗位序**(活动自己的 `sortOrder → createdAt → id`，不是 proposal 数组书写顺序)逐条 `min(剩余父预算, 本岗 headroom)`，并按**实际 promoted 数**扣减(队列空 / 候选人被跳过时剩下的份额留给下一条队列)。容量收敛只有 `intersectHeadroom` 一份，❌ 调用方不得自维护第二套容量算法。
- **候补队列隔离(B-D2,维护者 2026-08-01 拍板)**:`promoteActivityWaitlist` 是**全仓唯一**的候补出队循环，只扫 `activityPositionId` 这一条队列；`promoteActivityWaitlistWithinCapacity` 只多算一层「父活动剩余量 ∩ 本岗剩余量」预算后委托它。共享预算入口流动的是**父容量额度**、不是候选人 —— A 岗额度用不完不会去 B 岗队列取人。**跨岗位 fallback 已删除**——A 岗释放/扩容只递补候补 A 岗的人，A 岗队列空就空着等管理员手动安排。`activityPositionId=null` 是**历史无岗位队列**(报名在先、建岗位在后即可达:`resolveActivityPositionForCreate` 只在报名当刻按 live 岗位判 21035，建岗位不回溯既有报名)，它同样隔离——有 live 岗位的活动上它会滞留，这是拍板接受的代价。❌ 不得为任何调用方重新引入"同岗无人就去别的岗位取人"。
- **完结时间闸**:`complete` 在 Activity 聚合锁后重读状态与时间，只有 `published` 且读侧 phase 已为 `ended`（严格晚于 `endAt`）才允许写 `completed`；未来/进行中活动复用 `ACTIVITY_STATUS_INVALID` fail-closed。
- 状态机错误码:wrong state 统一抛 `BizCode.ACTIVITY_STATUS_INVALID`
- **受保护状态写(2026-07-21)**:`update`/`softDelete`/`publish`/`cancel`/`complete` 在持有 Activity 聚合锁并重读后，统一调用 [`/src/common/prisma/claim-at-status.util.ts`](../../common/prisma/claim-at-status.util.ts) 的条件 `SELECT ... FOR NO KEY UPDATE`；不产生 no-op tuple，调用方在 claim 后继续以既有锁后行完成真实写。并发败者复用 `ACTIVITY_STATUS_INVALID`；helper **只认领、不判断迁移合法性**，合法矩阵仍只在 `activity-state-machine.ts`。
- E2E:`activities.e2e-spec.ts` / `activities-rbac-boundary.e2e-spec.ts` / `activities-state-transition.e2e-spec.ts` / `activities-audit-characterization.e2e-spec.ts` / `activity-publish-review.e2e-spec.ts` / `activity-publish-review-concurrency.e2e-spec.ts` / `activity-responsibilities.e2e-spec.ts` / `activity-responsibility-concurrency.e2e-spec.ts` / `activity-responsibility-rollout.e2e-spec.ts` / `app-activities-available.e2e-spec.ts` / `app-activities-detail.e2e-spec.ts` / `activity-waitlist-shared-capacity.e2e-spec.ts`(多队列共享父预算) / `activity-batch4-cancel-waitlist-lifecycle.e2e-spec.ts`(整单取消、legacy writer 收口);scoped 判权矩阵在 `participation-scoped-authz.e2e-spec.ts`

- **资格 runtime 与配置/发布激活（第 83 migration / 第 4 批⑰）**：RuleSet 的活动/场次/岗位作用域由双向完整复合 FK 固定，`draft/active/retired` 版本与 active 槽位均按 NULL 参与去重；active/retired 及子 Rule 冻结、EvaluationSnapshot append-only。`AppActivitiesService` 在 detail 事务中调用统一 evaluator，安全投影顶层/session/position `qualification` 并按实际命中 RuleSet 各写一份 display snapshot；不得回显资格敏感原值。managed `GET/PUT qualification-rules` 只允许草稿活动全量维护 #22 typed RuleSet，canonical 相同则零写；initial 与显式携带 `qualificationRuleSets` 的 change review 固定为 V5，在 Activity→review 锁序审批中冻结并激活/退役版本和岗位指针。V2–V4 历史快照/哈希逐字保持；published direct PUT 固定 `20037`。
- **分配方式运行时（第 4 批⑫）**：`Activity.allocationModeCode` 是每活动唯一权威标量，DB 仅接受 `first_come/qualification_rank/lottery`；Admin/App 新建必须显式选择，service 复核闭集，Prisma default 仅留给存量/旧 server。draft PATCH 可改，published 只能经 change review；Admin/App managed 投影返 `allocationModeCode`，公共 App detail 返 `allocationMode`（列表不扩大）。`ActivityAllocationModeService` 只能在持有 Activity `FOR UPDATE` 后调用，所有 draft PATCH、发布提交/变更提交/审批均检查全部 `preparing/committed/voided` batch 与目标 mode 一致，不自动改写历史 batch；未来 batch writer 必须先锁 Activity 并复制其 mode。本刀不实现分配、candidate、容量或候补算法。
- **D85 可重放分配地基（第 4 批⑬）**：Batch 必存 `algorithmVersionCode` 与 64 位小写十六进制 `candidateSnapshotHash`；lottery preparing 只存 server seed commitment，committed 才存 64 位 reveal，非 lottery 两列恒空。Candidate 必存永久头/revision、`acceptedAt`、资格快照 hash 和对象解释；同批 tie-break、非空 lotteryOrder、非空 waitlistRank 各自唯一，score 仅 0..100，identity/header 与 header/revision 由 DB 复合 FK 同锚。当前模块仍无 batch/candidate 生产 writer；不得把 D85 说成已执行 first_come、rank、抽签、容量或候补递补。
- **D86 command replay / committed projection 地基（第 4 批⑭）**：`ActivityAllocationCommandReceipt` 是唯一的 immutable `prepare/commit/void` 安全回执表，`(activityId,commandCode,operationKey)` 与 `(allocationBatchId,commandCode)` 唯一，receipt/batch 用复合 FK 同活动锚；同 key 的 exact hash replay 与异 hash 稳定拒绝由后续 command runtime 实现。`responseReceipt` 只准固定 v1 安全信封，非 allocation/void 真值，不含 L3/未揭示 seed；DB 仅验 shape 及 `responseHash` 和列值一致，**不重算 hash**。runtime 必须对 UTF-8 canonical payload（依序 `activityId`,`allocationBatchId`,`batchStatusCode`,`commandCode`,`responseSchemaVersion`，排除 `responseHash`）算 SHA-256，不能拿 JSONB 对象序列化或其键顺序猜口径。Batch 的 `voidReason`/`voidedAt` 是作废事实，原始 wire 长度受限且拒绝空白。每 candidate 一条 `ActivityAllocationApplicationProjection`：identity 用 `id+activity+session+member` 冻结，activity-person reservation 用 `id+member+activity+bucket` 锚，故同 member 的不同 session identity 可复用同一 activity-person 行；session/position reservation 继续用 `id+identity+bucket`。allocated 的 population/pointer/三层 reservation-bucket 及可选 position 成套，waitlisted/not_selected 全清空；projection 不可 UPDATE/DELETE。Batch committed、Candidate/Revision 内容、reservationType 与 Identity live pointer 属跨表 runtime 边界，未来必须在 Activity 根锁事务重读复核；当前仍零 writer、零 endpoint、零 20147/replay 行为。
- **D87 Candidate 候补岗位锚（第 4 批⑮）**：Candidate 必填 `activityId/sessionId`，以 `(allocationBatchId,activityId,sessionId)` 复合 FK 锚定 Batch；可空 `waitlistPositionId` 与 activity/session 组成岗位复合 FK。result/rank/position 两值闭合，只有 waitlisted 同时要求 position+rank；候补 rank unique 与查询索引均按 `allocationBatchId+waitlistPositionId+waitlistRank`，同一 session-level batch 的不同岗位可各自 rank=1，同岗位重复 rank 拒绝。lotteryOrder/tieBreakKey 仍是全 batch 不变量。migration 仅接受 Candidate 空表，count-only fail-fast、零回填；当前仍零 writer/runtime/endpoint/20147/容量或候补 caller。
- **活动开始 expiry（第 4 批⑱）**：`ActivityBatchWorker` 先保留既有 ledger claim，再补建 `reconciliation` job，ledger 优先领取；只有到点的 published Activity 仍有 canonical `pending|waitlisted` 或 pending invitation 才建 job。实际执行固定 `Activity FOR UPDATE → job fence → headers/identities/revisions → invitations`，以最早 live session start（无 live session 才回退 Activity.startAt）为准；同一外层事务追加 system revision、清 pointer/population、投影 header、写既有审计并过期 invitation。pass/active reservation 不动，任何 pointer/revision/reservation drift 为 20147，业务/audit 零写；不引入新的容量占用算法。

- **业务复合锚点闭合(第六轮评审 A-2 + B-03)**:凡持有 ≥2 个业务锚点(`activityId` / `sessionId` / `memberId`)的模型,其**指向同链对象**的外键必须是复合的 —— 数据库要证明这些 ID 属于**同一条业务主链**,不只是各自存在。判据在 [`scripts/check-composite-anchor-closure.ts`](../../../scripts/check-composite-anchor-closure.ts)(在 selfGuard 内,改松要过红区人闸;`composite-anchor-closure.criteria.spec.ts` 只是薄运行器),扫描面从 `schema.prisma` **动态解析**,新建的同形状表自动纳管;例外走 `ANCHOR_CLOSURE_EXEMPTIONS` 且**必须逐条写指向权威源的理由**,豁免一旦不再对应真实违规,判据自己会红。运行时那一格由 `test/e2e/business-composite-anchor-closure.e2e-spec.ts` 的 SQL 交叉组合负例(断 `23503` 并**钉到约束名**)承担 —— 结构判据只读 schema 文本,证明不了迁移漏跑、约束建在错列上或 `ADD CONSTRAINT` 静默失败。

## Risk points (不要做)

- ❌ **不**给多锚点表新增**单列**外键去指向同链对象(报名头 / 参与身份 / 岗位 / 规则快照 / 账本分录等);新建的表同样受管 —— 要么把锚点列一起写进 `@relation` 的 `fields` / `references`(并在被引用侧补 `@@unique`),要么进 `ANCHOR_CLOSURE_EXEMPTIONS` 并写明理由
- ❌ **不**绕过 `activity-state-machine.ts` 在 service 内裸写状态变更
- ❌ **不**改 audit event 名 `'activity.publish'`(7 类操作共用〔含 complete 与 attendance-declare-complete〕,characterization 已锁)
- ❌ **不**在发布审核事务中反转锁序或信任提交时快照；必须 Activity → review，approve 时服务端重建快照
- ❌ **不**把 Form target 从 schemaVersion=3/4 stale hash 移走，也不让历史 v2 approval 读取或改写 Form；v2/v3 hash 永不加入 `allocationModeCode`，只有 v4 可冻结并 apply 它；published Form 或 allocation mode 不得暗中直接写或代为提交 change review。
- ❌ **不**把活动发布/改期/取消/审核结果/扩容递补通知移回 commit 后直调，也不以 `publishedBy` 代替当前 ACTIVE owner；稳定 eventKey 与业务写必须同事务
- ❌ **不**给四个活动侧 producer 传裸 `memberIds` / `ownerMemberId`：收件人一律经 [`activity-recipient-freeze.ts`](activity-recipient-freeze.ts) 冻结为品牌类型 `FrozenRecipientCohort` 后再入 producer（纯 tx 函数，不进 module providers）。冻结按 `cohortKey` **先回捞后重算**，回捞命中时一次收件人查询都不发；依据/时刻/算法版本/基数盖在 intent `payload.recipientFreeze` 可选键上（不 bump `payloadVersion`）。legacy 广播也必须取一次显式 `broadcast-visibility` 盖章 —— 「这条不冻结」是冻结入口的决定，不是 producer 漏了。❌ producer 不得自查 member / 受众标签 / 责任表(结构判据在 `activity-recipient-freeze.spec.ts`)
- ❌ **不**把责任委托/结束/owner 移交通知移回 commit 后 best-effort，也不把 assignment、RoleBinding、audit 与两个移交 intent 拆成不同事务
- ❌ **不**把责任 assignment 与 system-managed RoleBinding 分成两个事务，也不绕过 projector 直接写 responsibility binding
- ❌ **不**把 `'activity.publish'` 拆成 `activity.create` / `activity.update` 等细分 event(沿现状)
- ❌ 活动岗位链路不得用裸 `positionId` / `position` 命名；字段、参数、relation 一律 `activityPositionId` / `activityPosition`，仅 URL 子资源段保留 `/positions`
- ❌ **不**从 attendances 或其它模块直写 `Activity.statusCode`;完结必须走本模块 `complete` action(`published → completed`)，取消仅允许 draft|published。
- ❌ **不**把保险生命周期查询移到 Activity 聚合锁前，不拆第二 insurance gate；报名 approve/offboard 线性化已由 PR-E 收口，但离队前责任/参与影响阻断归 PR-F，首签到/考勤 submit/edit 与其它 producer 不在本切片。
- ❌ **不**把 Admin DTO 用 `extends` / `Pick` / `Omit` / `IntersectionType` / `PartialType` / `OmitType` 派生为 App DTO(沿 [`api-client-boundary` D-6](../../../docs/reference/api-client-boundary.md));App DTO 进 `dto/app/`
- ❌ **不**新增 Mixed Controller(class-level + 方法级双 `@ApiTags`);新 App endpoint 进 `controllers/app-*.controller.ts`
- ❌ **不**主动拆 `activities.service.ts`(898L,沿 [`/docs/current-state.md §4 P2`](../../../docs/current-state.md);拆分需单独立项)
- ❌ App 服务的 `_memberId` 入参是**扩展槽**(v0.1 published 活动池对全员相同,未参与 where 过滤),**不**借口"未使用"删掉(沿 `AppActivitiesService.findVisibleByIdForMember` / `listAvailableForMember` 顶部注释)

## Before editing

- 状态机:[`activity-state-machine.ts`](activity-state-machine.ts)
- audit:[`activity-audit-recorder.ts`](activity-audit-recorder.ts)
- 跨模块边界:[`/docs/participation-bounded-context.md`](../../../docs/participation-bounded-context.md)(尤其 §3 / §5 跨模块写)
- App surface 准入与 scope 注释:[`app-activities.service.ts`](app-activities.service.ts) / [`app-my-activities.service.ts`](app-my-activities.service.ts) 文件顶部

## Validation

- `pnpm lint` + `pnpm typecheck`
- 改业务行为 → `pnpm test:e2e -- activities`(覆盖 `activities*` + `app-activities*` 5 spec)
- 改 audit event / extra → 必须跑 `activities-audit-characterization.e2e-spec.ts`
- 改状态机 → 必须跑 `activities-state-transition.e2e-spec.ts`
- 改 DTO 字段 / endpoint path / Swagger schema → 必须再跑 `pnpm test:contract`
- 改 `ActivityBatchWorker` reconciliation / 活动开始 expiry → `pnpm test:e2e -- activity-batch4-expiry.e2e-spec.ts` 与 `activity-batch2-8a-auto-commit.e2e-spec.ts`
