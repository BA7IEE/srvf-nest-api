# Activity OS C5 精确实施计划与授权清单

> **2026-09-10 实施进度（未合并）**：维护者已批准按#1306的40路径实施、app_test_w98隔离验证与测试夹具重建、验证后提交推送开PR；不合并、不操作生产、不启用Gate、不删除业务数据。7项C5精确grant已核验。两个入口与独立投影/DTO已实现，当前正在本地验收收尾，证据见§10。app_test_w98此前不存在，已仅创建该隔离库并以migrate deploy从空库重放117条已审查迁移，逐条checksum一致；未调用migrate dev/reset/db push、未使用或修复共享app_test模板。下方仅文档授权段为计划确认时的历史记录，本条及§10记录本轮实际授权和状态。

> 2026-09-10，基点 main `febc37c4`。[#1305](https://github.com/BA7IEE/srvf-nest-api/pull/1305) 已合并，方案A已确认。维护者已确认本精确计划，并允许补充changelog、提交、推送及创建计划PR；不合并、不实施。本计划的执行参数与40路径写集获文档确认，不等于实施授权；不能把文档里的命令当作已授权操作。

## 1. 终态与范围

沿 [C5评审](activity-os-r3-c5-report-query-review.md) 已确认的方案A，交付实际可调用的单活动与最多20活动正式成果查询，不只创建闲置DTO。报告展示事实，不产生候选、不确认、不改结算/时长/账本、不阻断归档。

DoD：两个新入口、独立显式DTO、当前成果权限、历史定义解释、事务有界、真实HTTP/并发/满额测试、旧契约零漂移、派生交接齐全、PR CI结果如实登记。实现合并不等于上线。月年全队聚合、队员/部门统计、Incident/Resource报表、导出文件和驾驶舱仍是终态缺口，不以此刀替代。

## 2. 代码依据与不改的原语

- `src/modules/activities/controllers/app-managed-activities.controller.ts:117` 已有App managed前缀；132行的结束工作台读声明可沿用，不新增Controller或模块。
- `ActivityOutcomeAccessService.authorize` 当前用户/成员、显式组织范围、组织资格、draft发起人/非draft负责人均在tx内核验；返回activity。未登录/失效身份沿原401/403；活动不存在与活动级无权沿同一REFERENCE_UNAVAILABLE，不返回失败ID。
- `readCurrentConfirmedOutcomeInTx` 只取confirmed、take2检测异常；items/values take101、evidence take21，不能改成取最新revision。没有正式头返回null。
- `presentConfirmedActivityOutcome` 验正式头、必填、来源、确认时间和证据；它调用的detail投影保留历史定义并验证valueHash。新报告必须在完整验证后再白名单投影，不能直接透传其证据和其他字段。
- `activity-outcome-presenter.ts` 从历史set item取definitionHash和定义；现有detail返回未含definitionHash，新报告从同一已验证item取得，不重写canonical算法。
- `ActivityEndingWorkbenchQueryService.get` 提供RC、30000ms事务及Activity锁前后/返回前复判先例。C5不调用会开独立事务的get方法，复用tx参数函数。
- `generate-fe-client.ts:computeInputDigest/renderAll` 会联动13份client；`check-boundaries.ts:metadataInputs` 包含module。因此列入相关生成摘要，但不能借刷新改变裁判规则。

以上属只读依赖，不纳入生产写集：access、confirmed query/presenter、outcome presenter/value、metric selection/definition、组织/用户/Storage原语。若原语不满足合同，报告差距，不越界修复。

## 3. 精确HTTP与数据合同

| 入口 | 请求 | 成功 |
|---|---|---|
| GET /api/app/v1/my/managed-activities/:activityId/outcome-report | 使用既有AppActivityOutcomeParamsDto；无业务查询参数 | 200，统一包装的单项 |
| POST /api/app/v1/my/managed-activities/outcome-reports/query | 新AppActivityOutcomeReportQueryDto，仅activityIds | 显式HttpCode(200)，统一包装的items |

批量输入IsArray、ArrayMinSize(1)、ArrayMaxSize(20)、ArrayUnique及逐项IsString/MinLength(1)/MaxLength(64)；不trim或去重悄悄改请求，不允许额外body字段。单活动不新增自由筛选；如需验证未知query参数，应在同一新DTO文件定义显式空query DTO并接线，不能改全局管线。静态POST与已有动态路由逐一核验，不重排旧路由改变行为。

两入口均声明现有 `activity.outcome.read`、admission app-member、engine authz-scoped、responsibility scope；声明不代替逐活动service授权。无新权限码、无角色自动授权、无审计事件、无业务收据。

输出DTO均在新文件显式声明，不继承旧详情DTO，不引Admin，不将Prisma行作为返回类型：

| DTO | 精确字段 |
|---|---|
| AppActivityOutcomeReportDto | activityId、activityStatusCode、metricRequirementCode、metricSelectionRevision、formalStatus、currentConfirmed |
| AppActivityOutcomeReportConfirmedDto | outcomeRevisionId、revision、metricSetVersionId、metricSetDefinitionHash、confirmedAt、metrics |
| AppActivityOutcomeReportMetricDto | valueRevisionId、metricDefinitionId、definitionHash、definition、value、sourceCode |
| AppActivityOutcomeReportDefinitionDto | schemaVersion(1)、code、version、name、configuration |
| AppActivityOutcomeReportBatchDto | items |

definition.configuration为现有四种非敏感闭合配置：non_negative_integer、non_negative_decimal、boolean、single_choice；配置字段逐项沿既有AppActivityOutcomeDefinitionDto的oneOf，但不修改该旧DTO。value仅number/string/boolean，decimal保留规范字符串；false/0不能丢失。sourceCode只manual/system。禁止short_text、附件ID/URL/key、身份、内部来源、候选、canXxx及动态字段透传。

当前选择由readActivityMetricSelection按当前锚点验证，metricRequirementCode无选择为unconfigured；历史正式定义独立按自身锚点验证，不能以当前选集覆盖历史。无头formalStatus=not_confirmed/currentConfirmed=null；有合法头为confirmed。metrics按metricDefinitionId稳定排序，批量items按ID稳定排序。nullable对象用显式oneOf对象ref/null，并核对生成TS，不只看Swagger UI。有头缺必填/损坏hash/重复头/证据损坏整体拒绝，不能过滤坏值继续成功。

## 4. 事务、锁与预算（本计划待确认）

单活动通过同一内部查询流程处理一个ID，不制造两套行为。批量在一个ReadCommitted事务内顺序执行：

1. 校验并稳定排序最多20个不同ID；事务内逐个调用authorize，未全部通过前不读成果。
2. 按排序逐个对未软删Activity执行参数化FOR UPDATE；每次等待后立即重验该活动。
3. 全部锁取得后，再逐个重验，读取当前选择及现行正式头并验证；每个查询均传同一tx。
4. 全部投影完成后逐个重新authorize，再返回完整items。任何一步失败则整批失败，无部分响应。
5. 不锁来源事件、附件或候选表，不调用写命令或产生持久化报告。权限复判不宣称跨域原子授权快照。

沿C4事务总timeout=30000ms，不按活动倍增；不加自动重试或缓存。锁ID顺序使用确定的字符串比较，不用依赖locale的排序。当前无授权改变timeout或缩小20上限；满额无法通过则上报实际SQL/耗时与方案，不默默降规格。

最多20个正式头正常返回、最多2000个值；防异常探针最坏20×2×101个值及每值21证据，证据虽不返回仍参与完整合法性验证。测试同时覆盖最大正常证据量20×100×20及大量旧revision，记录实际ORM参数、SQL数量、耗时、响应字节数和锁等待，不以mock或“有take”代替满额验证。不承诺未测生产延迟。

TypeError/RangeError验证失败沿既有ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE；其他错误保持既有全局处理，不吞数据库超时、不返回原始异常。活动级无权与不存在同码同message；当前主体自身失效沿原访问原语，不为泛化而修改全局认证。

## 5. 精确写集（40路径，执行前须批准）

A为新增，M为修改；存在的计划文档为M。可选派生项只有检查证明必要时才变，不为凑路径数写文件。新增文件不得覆盖已有同名内容，实施前重验。

| # | 路径 | 唯一允许的变化 |
|---|---|---|
| 1 | src/modules/activities/activity-outcome-report-query.service.ts | 新增：同事务单活动/批量查询 |
| 2 | src/modules/activities/activity-outcome-report-query.service.spec.ts | 新增：授权、锁顺序及ORM参数单测 |
| 3 | src/modules/activities/activity-outcome-report-presenter.ts | 新增：显式白名单纯投影 |
| 4 | src/modules/activities/activity-outcome-report-presenter.spec.ts | 新增：历史配置、值、隐私单测 |
| 5 | src/modules/activities/dto/app/app-activity-outcome-report.dto.ts | 新增：独立输入/输出DTO |
| 6 | src/modules/activities/controllers/app-managed-activities.controller.ts | 仅接线两个新读入口，不重构旧方法 |
| 7 | src/modules/activities/activities.module.ts | 注册新QueryService |
| 8 | src/modules/permissions/permission-catalog.ts | 仅给既有outcome.read说明补报表查询，不改码或策略 |
| 9 | test/e2e/activity-os-r3-c5-outcome-report.e2e-spec.ts | 新增：真实HTTP、边界与满额 |
| 10 | test/e2e/activity-os-r3-c5-outcome-report-concurrency.e2e-spec.ts | 新增：双连接锁等待和撤权交错 |
| 11 | test/contract/openapi.contract-spec.ts | 仅新增两路由与新DTO断言，旧断言不改 |
| 12 | test/contract/__snapshots__/openapi.contract-spec.ts.snap | 只接受可解释的新增合同 |
| 13 | CODEMAP.md | 生成模块和行数读数 |
| 14 | docs/ai-harness/RBAC_MAP.md | 生成路由引用与说明 |
| 15 | docs/ai-harness/ROUTE_AUTHZ.md | 生成新路由访问声明 |
| 16 | harness/permission-surface-baseline.json | 仅新读路由绑定和说明摘要 |
| 17 | docs/current-state.md | 仅生成Endpoint 610→612，其他叙事不动 |
| 18 | docs/handoff/miniapp.md | 正式报表读面与权限/未部署说明 |
| 19 | docs/handoff/openapi.json | 生成新合同 |
| 20 | src/modules/activities/CLAUDE.md | 模块能力与未部署边界 |
| 21 | docs/ai-harness/NEXT_TASKS.md | 真实进度，不预写完成 |
| 22 | docs/ai-harness/FROZEN_DRAFTS.md | 真实进度及必要派生读数 |
| 23 | docs/plans/activity-os-r3-c5-implementation-plan.md | 本计划验证证据 |
| 24 | changelog.d/activity-os-r3-c5-implementation.md | 新增本批fragment |
| 25 | harness/domain-map.json | 仅模块接线inputDigest，归属不变 |
| 26 | harness/state-machines.json | 仅检查证明必要时更新摘要，状态/规则不变 |
| 27 | docs/ai-harness/STATE_MACHINE_INVENTORY.md | 仅上一项导致的派生差异 |
| 28 | docs/handoff/clients/admin/client.ts | 按真实合同生成；App新增入口/DTO，其余仅摘要或共享闭包，不改旧语义 |
| 29 | docs/handoff/clients/admin/types.ts | 按真实合同生成；App新增入口/DTO，其余仅摘要或共享闭包，不改旧语义 |
| 30 | docs/handoff/clients/app/client.ts | 按真实合同生成；App新增入口/DTO，其余仅摘要或共享闭包，不改旧语义 |
| 31 | docs/handoff/clients/app/types.ts | 按真实合同生成；App新增入口/DTO，其余仅摘要或共享闭包，不改旧语义 |
| 32 | docs/handoff/clients/auth/client.ts | 按真实合同生成；App新增入口/DTO，其余仅摘要或共享闭包，不改旧语义 |
| 33 | docs/handoff/clients/auth/types.ts | 按真实合同生成；App新增入口/DTO，其余仅摘要或共享闭包，不改旧语义 |
| 34 | docs/handoff/clients/integration/client.ts | 按真实合同生成；App新增入口/DTO，其余仅摘要或共享闭包，不改旧语义 |
| 35 | docs/handoff/clients/integration/types.ts | 按真实合同生成；App新增入口/DTO，其余仅摘要或共享闭包，不改旧语义 |
| 36 | docs/handoff/clients/open/client.ts | 按真实合同生成；App新增入口/DTO，其余仅摘要或共享闭包，不改旧语义 |
| 37 | docs/handoff/clients/open/types.ts | 按真实合同生成；App新增入口/DTO，其余仅摘要或共享闭包，不改旧语义 |
| 38 | docs/handoff/clients/system/client.ts | 按真实合同生成；App新增入口/DTO，其余仅摘要或共享闭包，不改旧语义 |
| 39 | docs/handoff/clients/system/types.ts | 按真实合同生成；App新增入口/DTO，其余仅摘要或共享闭包，不改旧语义 |
| 40 | docs/handoff/clients/shared/types.ts | 按真实合同生成；App新增入口/DTO，其余仅摘要或共享闭包，不改旧语义 |

此次不预授权旧E2E适配、schema/migration/seed、common、生成器、裁判脚本、CI、全局入口及跨模块生产代码。预计Endpoint610→612；117迁移、258权限、165总计/160活跃审计不变；无第118条迁移和新3b/4b。计数与签字仍须实查，发现陈旧不擅自重签。

## 6. 探针队列与验收

每项先建立有判别力的反例；只有探针未满足才实施对应代码，失败记录真实原因。

| 探针 | 证据与范围 |
|---|---|
| P0 基线 | fresh fetch/preflight、精确grant、本地依赖新鲜；已有C4/C3接口characterization不改断言 |
| P1 DTO/合同 | GET/POST200、1/20合法、0/21/重复/超长/未知字段拒绝；nullable与四类配置/值精确；逐行snapshot新增与旧路由/schema比较 |
| P2 历史事实 | 无头/草稿/正式/准备/取消/替代/归档/retired；旧正式保持；损坏hash/重复正式/必填缺项/证据损坏失败 |
| P3 权限 | owner及draft initiator正例；无码/越组织/组织无效/退队/禁用/非owner/机器/仅结算反例；整批单个无权拒绝、不泄露ID；SA不短路 |
| P4 真并发 | 两连接池、当前库/pid屏障；反向输入批量按同序锁；等待期间确认替代/取消/负责人变化/撤权后复验，不混合事实 |
| P5 保真隐私 | 四类值、false、0、小数精度、历史选项；逐层键白名单；业务表/收据/审计前后不变，不泄露内部证据 |
| P6 满额 | 20活动×100指标×20证据、海量历史、实际ORM/SQL与墙钟；30秒预算，失败不放宽断言/上限 |
| P7 回归 | C4 ending-workbench及concurrency、C3-2 finalization及concurrency、C3-1 candidate、settlement HTTP boundary、archive action；沿既有断言 |
| P8 派生 | counts/authz/rbacmap/codemap/openapi/feclient/permission surface/boundary metadata/两台账/diff检查 |
| P9 收口 | 本地quick/build/定向真实Jest/contract；全量由PR CI冷跑；head与审批匹配后单独申请合并 |

仅拟申请app_test_w98隔离验证与测试夹具重建。先解析实际目标库并核对主机/库名、占用，再由空库重放117条已审查migration并逐条核checksum；不要沿用C4发现第116条漂移的共享app_test模板。允许的重建方式仍受禁令约束，AI不得执行migrate dev/reset/db push；实际重建命令须执行时列明并核验，不能以本计划代替实时必要确认。不操作app_test、w1或其他库，不清理业务数据。

C4合并后main CI34438228787紧急创建前置500仍未定位。C5纯文档CI跳过E2E不构成修复证据；实施若在基线复现，应将其与新功能回归分开报告，另申请诊断/修复范围，不重试到绿或改旧断言。

## 7. 一次性授权清单与命令

本轮仅写本计划一个文件，不发放授权、不执行下面命令。未来按本计划批准implementation后，由维护者在**实施所在工作区**逐条执行。已用40个具体路径运行harness:needs，7项需grant；无目录通配。

```bash
cd /Users/dengwang/Documents/coding/srvf-nest-api
pnpm harness:grant 'src/modules/permissions/permission-catalog.ts' --reason "C5 精确实施计划方案 A；仅已批准40路径内对应内容"
pnpm harness:grant 'harness/domain-map.json' --reason "C5 精确实施计划方案 A；仅已批准40路径内对应内容"
pnpm harness:grant 'harness/permission-surface-baseline.json' --reason "C5 精确实施计划方案 A；仅已批准40路径内对应内容"
pnpm harness:grant 'harness/state-machines.json' --reason "C5 精确实施计划方案 A；仅已批准40路径内对应内容"
pnpm harness:grant 'test/contract/__snapshots__/openapi.contract-spec.ts.snap' --reason "C5 精确实施计划方案 A；仅已批准40路径内对应内容"
pnpm harness:grant 'test/contract/openapi.contract-spec.ts' --reason "C5 精确实施计划方案 A；仅已批准40路径内对应内容"
pnpm harness:grant 'docs/ai-harness/ROUTE_AUTHZ.md' --reason "C5 精确实施计划方案 A；仅已批准40路径内对应内容"
```

这些令牌只允许写，不允许合并或扩张语义。未来执行授权建议一次覆盖本稿§3–6、40路径、w98隔离验证与测试夹具重建、通过后提交推送开PR；不合并、不操作生产、不启用Gate、不删除业务数据。不改变权限策略、既有断言或守护规则；任何超写集后果先报告。

维护者已确认文档并允许补changelog、提交、推送、创建计划PR，不合并、不实施。本次提交范围仅本计划及changelog.d/activity-os-r3-c5-plan.md两份文档。待计划合并、实施授权及红区令牌齐备后才开工。

## 8. 风险与回退

风险为批量锁持有过长、历史解释失真或批量越权；以30秒总预算、有界满额及真实锁等待测试验证，不凭单活动通过推断批量通过。回退撤回两个新增读入口和客户端调用，不迁移或删除事实；旧成果/C4/结算接口不变。外发报表的业务批准不是本接口自动授予的权限。

## 9. 本轮记录与本次未做

#1305已squash合入febc37c4；PR9项成功/4项按规则跳过，main文件树与528ebb5e相同，任务分支清理且起草前clean。合并后 [main CI34441834454](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34441834454) 已核验 completed/success；本次为纯文档变更，Contract/E2E与Golden journeys按规则跳过，不能以此证明业务E2E通过或紧急创建500已修复。

本轮未实施DTO/API/生产代码/测试或派生代码；未操作数据库、生产或Gate、删除业务数据；未合并本计划、未开展整体跨模型复审。提交与计划PR按本轮新授权执行，具体提交及PR状态以GitHub为准。

## 10. C5 实施验收记录（覆盖§9的计划阶段历史）

- 基点为#1306合入后的main `1b31c85b`；其main CI 34442979187为docs-only成功，不作为业务E2E证据。开工preflight通过，40路径中实际修改37项；RBAC_MAP、state-machines与STATE_MACHINE_INVENTORY经检查无须变更，不为凑数改写。未扩大写集或修改既有E2E。
- P0：4套既有C4/正式选择器单测25项通过。初次误用无config Jest造成解析失败、没有测试执行；改用仓内unit配置后通过，未改配置。
- P1：完整contract 1036项与2快照通过；逐键比较旧OpenAPI paths/schemas，无删除或修改，只新增2路由及6独立schema。快照所有旧行保持，增量363行schema/386行paths；R11语义检查breaking=0/additive=2。计数610→612及新可空结构断言已补齐，不放宽旧断言。
- P2/P5：新增单测16项通过；真实录入、首次确认、准备更正、取消、替代、归档及retired历史解释通过。四类值覆盖false/0/规范小数/历史选项，正式结果逐层白名单、不返证据/来源身份；实际报告查询前后业务修订、值、证据、两类收据与审计计数不变。
- P3/P4：显式授权正例及SA无码、越组织、组织失效、退队、禁用、非owner/发起人反例验证；两连接池、当前库/pid锁等待，正反序批量同时发起，选择/撤权/发起人/负责人变化后复验。新增C5并发4项全部通过；机器与仅结算边界纳入新增HTTP文件，不改全局配置或Gate。
- P6：真实HTTP建立20活动×100正式值×20证据，共2000值/40000证据；再加入10000条更高revision的非正式草稿夹具，验证不以最新草稿替代正式头。观测查询1163条真实SQL、20次Activity锁与20次正式头查询，无INSERT/UPDATE/DELETE；响应835904字节，首轮1.654秒、后续1.750秒，均保持30秒总事务预算。仅本地w98性能，不承诺生产延迟；240秒仅用于构造满额测试夹具，不改变报告超时。
- P7：8套128项真实E2E通过（含C5并发4项、既有C4/C3-2/C3-1/结算HTTP边界/归档124项），旧断言未改。
- P8：OpenAPI/13客户端、authz、counts、codemap、权限面绑定及domain-map摘要已刷新核验；角色地图和状态机生成物无需变化，架构新债检查通过。117迁移、258权限、165总计/160活跃审计不变，不新增3b/4b。
- P9：全仓354套单测7889通过、5 todo；build通过。首轮quick因格式/派生尚未刷新报红，已处理；冷lint默认约4GB堆发生OOM，按单次命令8GB堆重跑，不修改package/CI/规则。最终冷lint、类型及守护复验结果待本节补记，不能以初次quick称全绿。标准全量E2E由PR CI冷跑，未在本地冒用w1/共享模板。

本次未做：合并、生产部署、Gate、业务数据删除、整体跨模型复审、前端页面和完整分析报表。原紧急创建500根因仍未定位；本轮未重试历史CI或越界修复。§9所称“未实施”仅描述计划PR当时，本轮真实实施以上述记录为准。

**最终本地复验补记**：新增C5 HTTP 10项全部通过（最后一轮满额1.725秒），加上上述8套128项，定向E2E共9套138项；机器测试先因Gate关闭及空测试签名配置未满足前置而失败，最终仅在该测试进程生成独立临时签名密钥、Gate保持false，真实验证签名后请求两个Human入口均401。未开启功能或更改共享测试配置。`NODE_OPTIONS=--max-old-space-size=8192 pnpm lint`、完整`pnpm typecheck`和`pnpm harness:selftest`均exit 0（已知守护缺口照常报告，不称零风险）；新测试后置定向lint与test类型复验通过。全部派生检查、迁移计数、架构元数据/新债/登记完整性、R11与diff检查通过。非App的11份生成文件仅摘要变化，App新增两方法/六结构；重复null为既有生成器表达形式，语义仍为可空，未改生成器。进入已授权提交/推送/开PR；PR CI与可信人工审批仍待GitHub结果，不提前登记通过。
