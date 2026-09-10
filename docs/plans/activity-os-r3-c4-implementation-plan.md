# C4 精确实施计划与授权清单（方案 A）

> **main CI 异常补记（2026-09-10）**：[34438228787](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34438228787) 第2组 E2E 已失败：`activity-os-r2-b6-emergency-creation.e2e-spec.ts:236` 创建前置预期201、实际500（调用于601行）；该组72套/1349项通过，1套/1项失败。第1、3、4、5组全部通过，运行最终为failure。下文“仍运行”为早先核验记录，不代表当前或全绿；根因尚未确认，不能认定与C4无关。本轮只读诊断，未重试CI、未改代码或数据库；此异常不阻止仅文档起草，但不能登记验证收口。

> **2026-09-10 合并收口**：维护者确认合并后，#1304已squash合入 `bab5110e`。最终head `147dea7a` 的18项PR检查全部成功；main与head文件树diff为空，本地main已ff-only同步、工作区在起草C5前clean、远端及本地任务分支均已清理。合并后 [main CI](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34438228787) 核验仍运行中。首轮CI的CODEMAP陈旧7行已仅刷新生成读数后通过最终CI，不改守护。下方未提交/未合并属于历史记录。C5仅评审起草获授权，不实施，不操作生产、Gate或删除业务数据。

> **2026-09-10 实施授权更新**：维护者已明确批准 C4 implementation 方案 A、40路径、app_test_w98 隔离验证及测试夹具重建、验证通过后提交推送创建 PR；7条精确红区授权已核验。不合并、不操作生产、不启用 Gate、不删除业务数据。#1303 已合入 main `a9b55067`，main CI 34376313831 已通过。以下“未实施授权”等为原计划时点，不代表当前许可。

### C4 实施验证记录（2026-09-10，未合并）

- 实际写集37路径，逐项比对§4无越界；RBAC_MAP、state-machines、STATE_MACHINE_INVENTORY 三项检查未产生差异，未制造修改。
- 新增事务查询、纯摘要投影、四个 App DTO 和一个 GET；沿用既有成果访问属主，Activity 锁后及返回前重验；不改旧命令、旧权限策略或旧测试断言。
- quick 已通过：352套单元测试、7873项通过、5项既有 todo；lint 为缓存口径。TypeScript（生产、测试、脚本）与 Nest build 通过。新增14项单元测试含真实调用参数的 latest1/confirmed2/101/21 上界断言。
- contract 使用真实 Jest、专用 w98 启动配置验证；最终可空分支更新后以不更新快照模式重跑，1033项及2份快照通过。OpenAPI/snapshot 最终均仅新增382行，逐对象比较旧 paths/schemas 均不变，仅新 GET 和4个 DTO。既有生成器忽略 allOf 外层 nullable，故新 DTO 用显式 oneOf 对象/空值分支（仅本轮 DTO，不改生成器），确保生成客户端允许 null；生成的重复 `null | null` 与单个 null 类型等价。语义比较 breaking0/additive1，旧609路由授权等价，新1条，没有旧路由扩权。
- w98 新 HTTP 7项通过（真实 Jest）：含真实初次确认、准备、取消、再次准备及替代，双应用连接池在 PostgreSQL 实际锁等待后读取一致摘要；归档及 retired 指标历史仍可读取。另有双连接选择/撤权/发起人变化3项诊断通过。
- 旧 C3-2 finalization 8项、concurrency 59项在临时串行诊断运行器通过；此口径不冒充标准 Jest 全量。旧 settlement HTTP boundary 2项、archive action 15项在真实 Jest 通过。
- 旧 C3-1 candidate 整份真实 Jest 初轮29通过、1失败：最大容量用例返回500。单独筛选最大用例因跳过前序 binding 建立而返回400，该次不作为业务结论；补入既有前置后，脱敏诊断捕获 P2028（30000ms 事务预算、177941ms 实际耗时）。只读比对发现模板克隆库第116条 `20260908054308_activity_os_r3_c3_metric_candidates` 校验和与当前文件不同，仍有已移除的 source/value complete 触发器；`migrate deploy` 不会重放已经登记的旧 migration，因此前述克隆库结果不作为最终验收。按既有授权仅从空库重建 w98、重放当前117条迁移并逐条校验和比对后重跑；不修改共享模板、旧测试或迁移文件。
- **最终定向回归**：空库 w98 的117条 checksum 全部吻合；真实 Jest 串行执行7份 spec、124项全部通过（91.543s）：C4 HTTP 7、C4 concurrency 3、C3-2 finalization 8、C3-2 concurrency 59、C3-1 candidate 30、settlement HTTP boundary 2、archive action 15。隔离配置只负责 w98 空库生命周期及 worker98 定位，不替换断言或修改仓库门禁；全仓 E2E 仍由 PR CI 冷跑。新增锁测试最初漏算间接阻塞，已按当前库及 holder pid 的两级实际阻塞链修正后通过。
- counts、authz、codemap、rbacmap、客户端新鲜度、权限绑定、边界元数据、台账及 diff check 已核验；读数610 endpoint、117 migration、258权限、165总计/160活跃审计。旧3b/4b登记检查通过，无新增迁移或重签。
- 本地验收完成，按本轮授权提交、推送并创建实施 PR；PR编号、状态及全量 CI 以 GitHub 实时结果为准，不在提交前预写通过。当前 main 基点仍为 `a9b55067`，没有其他 open PR。
- 本次未做：尚无本轮 PR CI 全量结论；不合并、不操作生产、不启用 Gate、不删除业务数据、不改前端实际页面。跨模型整体复审仍按维护者要求留待整体完成；旧紧急创建500根因仍未定位，不能由本轮候选测试模板漂移结论替代。共享 app_test 模板仍有历史校验和漂移，未获本轮写授权，未修补或重建。

> 2026-09-10；基点 main `a31d38b7`。[#1302](https://github.com/BA7IEE/srvf-nest-api/pull/1302) 已 squash 合并，10 项检查通过、4 项跳过；不是 E2E 全量通过。原 PR head `82a0a110` 与合并后文件树无差异，远端／本地任务分支已清理，preflight 通过。
> 维护者已于 2026-09-10 确认本精确计划，并允许补 changelog、提交、推送和创建计划 PR；**不合并、不实施**。上位依据：[已确认 C4 方案 A](activity-os-r3-c4-ending-workbench-review.md)。字段、实现细节和40路径方案已确认，但执行代码及数据库验证仍须实施授权，不借文档批准启动代码。下方“待批准／候选”保留为方案起草时点表述，以本段最新授权边界为准。

## 1. 完成定义和禁止域

交付一个单活动只读汇总 API，明确指标选择、现行正式成果、当前草稿和下一步功能入口；复用 C1/C2/C3 的事实与访问规则。客户端不必自己遍历历史猜正式成果。工作台不负责执行确认、结算或归档，也不新增这些动作的门槛。

不交付前端页面、C5 报表、Release 4 D4 分类时长工作台。不新增表、migration、权限码、审计事件、角色授权、业务状态、后台任务或缓存。不写参与／结算／附件事实，不删除或压缩历史，不改旧命令、旧 DTO、旧测试断言、Gate 或全局执法规则。

## 2. 精确 HTTP 合同（待批准）

`GET /api/app/v1/my/managed-activities/:activityId/ending-workbench`，成功 HTTP 200，经既有包装器返回对象。无 body、无分页或过滤参数；这是单对象详情，不是整取历史列表。复用 `AppActivityOutcomeParamsDto` 校验路径参数。

在现有 `app-managed-activities.controller.ts` 增加独立方法及依赖，沿方案 A，不拆改既有方法。结构化声明与正式成果读面相同：`activity.outcome.read`、`admission: app-member`、`require: all`、`engine: authz-scoped`、`scopes: responsibility`。Service 才是实际授权者，声明不替代判权。

出参由 `AppActivityEndingWorkbenchDto` 及三种嵌套 DTO 显式表达，不使用 Prisma 类型或 Admin 派生，不返回自由 JSON：

| 字段 | 类型及语义 |
|---|---|
| activityId | string，当前活动锚点 |
| activityStatusCode | 既有活动六态，不新增“全面完成”状态 |
| metricRequirementCode | `unconfigured / not_required / required`；不存在“optional”第四态 |
| metricSelectionRevision | 非负整数，沿当前活动选择版本 |
| selectedMetricSetVersionId | string 或 null，当前选择锚点，不代表正式成果采用的历史版本 |
| currentConfirmed | `AppActivityEndingConfirmedSummaryDto` 或 null；字段仅 id、revision、metricSetVersionId、confirmedAt（ISO 时间）、valueCount |
| pendingDraft | `AppActivityEndingDraftSummaryDto` 或 null；字段仅 id、revision、kind（`initial / correction`）、baseConfirmedRevision（整数或 null） |
| notices | 固定闭集数组，元素 `AppActivityEndingNoticeDto` 仅 code、target；顺序见下表，不返回任意 URL 或用户输入 |

所有可空字段显式 nullable；缺失不是 null。正式确认时间来自已存在的确认元数据，不新增“观察时间”或写入时间字段；不返回确认人、实际指标值、附件、名单或原始来源。

| 提示 code | 条件 | target（功能标识，不是权限承诺） |
|---|---|---|
| metric_selection_unconfigured | 未配置指标选择 | metric_selection |
| formal_outcome_missing | required 且没有现行 confirmed | outcome_history |
| initial_draft_pending | 当前有效初次草稿存在 | outcome_history |
| correction_pending | 当前有效更正草稿存在 | outcome_history |

提示按上述顺序稳定输出，最多 3 项，不重复。`not_required` 不产生“缺正式成果”提示，但若已有历史正式成果仍返回它。提示只描述事实，不叫 readiness、不返回 blocker、不推导可确认。结算／归档入口由前端按已有页面导航提供，**不由此接口返回 canSettle/canArchive**；进入原接口仍重新判权。

## 3. 查询、权限和一致性

### 3.1 已确认调用链

新 controller 方法 → 新 `ActivityEndingWorkbenchQueryService.get` → `ActivityOutcomeAccessService.authorize` → 同事务活动锁／读取 → 既有 `readCurrentConfirmedOutcomeInTx` 与 `presentConfirmedActivityOutcome` → 新纯 Presenter 输出最小摘要。

直接证据：正式选择器在 `activity-outcome-confirmed-query.service.ts`；确认元数据一致性检查在 `activity-outcome-confirmed-presenter.ts`；选择解析在 `activity-metric-selection.ts:readActivityMetricSelection`。均在 activities 同模块，**只调用，不改原实现**。不调用另开事务的 HTTP query service 拼成伪原子摘要。

### 3.2 事务步骤

1. 开 `ReadCommitted` 事务，沿正式读面 30 秒预算；先 authorize 当前 Human App 身份、显式权限、组织资格／范围、initiator 或 owner。
2. 对未软删 Activity 执行既有形状的 `FOR UPDATE`，锁后再次 authorize，使用锁后返回的 activity。该锁用于读一致性，不写业务行。
3. 按当前选择 ID 读取指标集及最多 101 项定义，调用 `readActivityMetricSelection`。历史 retired 定义可解释；损坏锚点不能读成 unconfigured。null 四元组／revision 0 才是未配置。
4. 调用既有 confirmed 选择器（最多 2 个头、101 个值、每值 21 个证据）；使用既有 Presenter 验证正式事实，随后只投影安全摘要，不把完整对象 spread 到响应。
5. latest 仅用于草稿候选：按 revision desc 取 1 个头。非 draft 一律 pendingDraft=null。无正式成果时 draft 为 initial；有正式成果时，必须存在同活动、同 draft、operationCode=`prepare_outcome_correction` 且 baseConfirmedRevisionId 指向现行 confirmed 的准备收据，才为 correction。缺关联拒绝，不猜。取消已将头转 superseded，不能仅凭准备收据存在显示 pending。
6. 完成构造前再次 authorize；TypeError/RangeError 类领域损坏沿正式查询映射 `ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE`，不吞未知数据库错误。无权／不可见沿既有泛化行为，未登录和 App 准入失败沿原规则。

不重新实现 max(revision) 正式选择器。新 Presenter 不访问数据库，只接收已验证事实；不会检查对象就顺带授权。指标准备与最终确认都继续以原命令端实时状态和权限为准。

### 3.3 边界及规模

活动六态均可按既有资格只读；archived 按 archivedFromStatusCode 判断历史责任资格。未获得写权限的读者可以看到事实提示，不能据此执行命令。不得为了“给出更友好的按钮”放宽至结算协作者、普通参与者或 SUPER_ADMIN 直通。

查询数不随历史修订数增长；最新头利用既有 activityId/revision 唯一索引，正式读取沿现成选择器；准备收据查询以活动、草稿、操作和正式 base 收敛且取 1。禁止全量加载历史、N+1 读取每个值、复算参与来源。既有选择器内部最多读取 100 值／2000 证据的正常正式快照，上限探针仍照原逻辑校验，不以投影摘要为由跳过完整性检查。

## 4. 精确候选写集（40 路径，整体批准后才可写）

下列为允许上限，不强迫无差异文件制造修改。A=新增，M=修改；派生项仅按工具真值刷新。生成发现清单外路径先说明，不自行扩写。

| # | 路径 | 变更 |
|---|---|---|
| 1 | src/modules/activities/activity-ending-workbench-query.service.ts | A：事务与查询 |
| 2 | src/modules/activities/activity-ending-workbench-query.service.spec.ts | A：查询及授权顺序单测 |
| 3 | src/modules/activities/activity-ending-workbench-presenter.ts | A：纯摘要投影 |
| 4 | src/modules/activities/activity-ending-workbench-presenter.spec.ts | A：闭集与边界单测 |
| 5 | src/modules/activities/dto/app/app-ending-workbench.dto.ts | A：四个显式 DTO |
| 6 | src/modules/activities/controllers/app-managed-activities.controller.ts | M：仅新增 GET 与依赖 |
| 7 | src/modules/activities/activities.module.ts | M：注册新 query |
| 8 | src/modules/permissions/permission-catalog.ts | M：仅既有 outcome.read 中文说明补“结束工作台摘要”；码、分类、风险、授权策略不变 |
| 9 | test/e2e/activity-os-r3-c4-ending-workbench.e2e-spec.ts | A：HTTP、隐私、状态、兼容 |
| 10 | test/e2e/activity-os-r3-c4-ending-workbench-concurrency.e2e-spec.ts | A：双连接交错 |
| 11 | test/contract/openapi.contract-spec.ts | M：仅登记新路由及新 DTO 断言，保留旧断言 |
| 12 | test/contract/__snapshots__/openapi.contract-spec.ts.snap | M：逐行核验新增路径与四 DTO |
| 13 | CODEMAP.md | M：真实生成读数 |
| 14 | docs/ai-harness/RBAC_MAP.md | M：生成新增路由引用与说明 |
| 15 | docs/ai-harness/ROUTE_AUTHZ.md | M：生成新增路由声明 |
| 16 | harness/permission-surface-baseline.json | M：仅 outcome.read 新读路由绑定及说明摘要 |
| 17 | docs/current-state.md | M：仅生成 endpoint 609→610 计数，其他非派生叙事不动 |
| 18 | docs/handoff/miniapp.md | M：任务入口及提示不等于权限的交接 |
| 19 | docs/handoff/openapi.json | M：生成新增合同 |
| 20 | src/modules/activities/CLAUDE.md | M：本模块能力与未部署边界 |
| 21 | docs/ai-harness/NEXT_TASKS.md | M：真实进度，不提前宣告合并 |
| 22 | docs/ai-harness/FROZEN_DRAFTS.md | M：真实进度及必要派生读数 |
| 23 | docs/plans/activity-os-r3-c4-implementation-plan.md | M：验证证据与授权记录 |
| 24 | changelog.d/activity-os-r3-c4-implementation.md | A：本批变更 |
| 25 | harness/domain-map.json | M：模块接线导致 inputDigest 刷新，域归属不变 |
| 26 | harness/state-machines.json | M：仅如检查证明输入摘要联动才刷新；状态与迁移规则不变 |
| 27 | docs/ai-harness/STATE_MACHINE_INVENTORY.md | M：仅上述派生摘要联动，无新增状态机 |
| 28 | docs/handoff/clients/admin/client.ts | M：生成摘要 |
| 29 | docs/handoff/clients/admin/types.ts | M：生成摘要 |
| 30 | docs/handoff/clients/app/client.ts | M：生成新 GET |
| 31 | docs/handoff/clients/app/types.ts | M：生成新 DTO |
| 32 | docs/handoff/clients/auth/client.ts | M：生成摘要 |
| 33 | docs/handoff/clients/auth/types.ts | M：生成摘要 |
| 34 | docs/handoff/clients/integration/client.ts | M：生成摘要 |
| 35 | docs/handoff/clients/integration/types.ts | M：生成摘要 |
| 36 | docs/handoff/clients/open/client.ts | M：生成摘要 |
| 37 | docs/handoff/clients/open/types.ts | M：生成摘要 |
| 38 | docs/handoff/clients/system/client.ts | M：生成摘要 |
| 39 | docs/handoff/clients/system/types.ts | M：生成摘要 |
| 40 | docs/handoff/clients/shared/types.ts | M：按真实共享闭包生成；不得借生成改变旧字段 |

联动证据：`check-boundaries.ts:metadataInputs` 包含所有 module 文件；`generate-authz-manifest.ts` 输出 ROUTE_AUTHZ；`generate-fe-client.ts:computeInputDigest/renderAll` 将全合同摘要写入 13 个 client 文件；permission surface 守护要求新增绑定时复核业务说明。故不是只授权几份手写文件就能收口。

## 5. 探针与验证队列

每组先证明失败反例能被测试发现，再实施；不提前承诺通过数量。

| 探针 | 通过依据 |
|---|---|
| P1 契约 | 新 GET、包装、四 DTO、nullable、提示闭集逐项断言；旧路径/schema 不变，snapshot 不盲更新 |
| P2 选择 | null/revision0、not_required、required、损坏引用、retired 历史；缺失不得伪造零值或完成 |
| P3 修订 | 无头、初稿、正式、准备更正、再次准备、取消、重新准备、确认替代；正式始终由 confirmed 状态选择 |
| P4 权限 | 当前有效 owner／draft initiator 正例；缺显式码、跨组织、失效组织、非 owner、退队、禁用、机器身份、仅结算资格反例；含归档有权历史 |
| P5 数据最小化 | 响应键白名单，无实际值/名单/身份/来源/附件 key 或签名 URL；调用前后业务表与收据无新增修改 |
| P6 并发 | Activity 锁等待与确认、准备、取消交错；锁后撤权／负责人更换拒绝；结果不混用新旧状态；屏障按当前库/pid 收敛 |
| P7 有界 | 大量历史仍只取 latest1、confirmed2；101/21 探针保持，禁止历史全读和源计算；捕获实际 ORM 参数，不只检查固定 mock 返回 |
| P8 兼容 | 既有 C3-2 finalization/concurrency、C3-1 candidate、settlement HTTP boundary、archive action 定向回归；原断言零修改 |
| P9 派生 | counts/authz/rbacmap/codemap/openapi/feclient、permission surface、边界元数据、冻结稿台账、diff check；预期117 migration、258权限、165/160审计不变 |

本地 quick 和定向 E2E；全量按 PR CI 冷跑。仅拟申请 `app_test_w98` 隔离验证／重建，先核验实际 worker 指向，禁止误落 app_test 或其他库；不得由 AI 自动执行 migrate dev/reset/db push。没有新增 migration，无第118条迁移，也无新3b/4b重签；旧签字有效性仍须检查，陈旧则报告而非自签。

## 6. 授权、风险和回退

本批新增 API，最低 C 档；权限目录仅改说明但属受控路径，需维护者精确 grant，不能把语义不变当成免红区。红区命令必须在批准实施后按上表逐文件 `pnpm harness:needs` 的真实结果列齐，维护者每条单独执行；AI 不发放令牌，不使用目录通配扩大授权。

最坏风险是混合修订或提示误导用户，以 P3/P4/P6 和原命令独立判权兜住；不因工作台读失败停止原成果和结算能力。回退为撤回新 GET 与前端入口，旧 API、数据和历史保持；不 down migration、不回填、不清理业务数据。

建议实施授权一次覆盖 §2–§5、40 路径、仅 app_test_w98 验证及测试夹具重建、通过后提交推送开 PR；不合并、不操作生产、不启用 Gate、不删除业务数据。执行前还须文档计划确认与真实红区授权，当前不视为已获准。

## 7. 本轮记录与本次未做

#1302 合并成功，main 已 ff-only 同步且工作树在起草前 clean；原分支本地/远端不再存在。新计划仅文档。#1302 的 main CI `34374332752` 起草时仍运行中，不能用 PR CI 代替其最终结果。

本轮未实施接口、DTO、测试、权限说明或任何派生代码；未执行数据库命令，未创建本计划 PR，未启用 Gate、删除业务数据或完成整体跨模型复审。C3 旧紧急创建 500 根因仍未定位。
