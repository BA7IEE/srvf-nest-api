# Activity OS R3 / C1：指标定义与指标集版本评审及授权清单

> **状态**：2026-09-05，维护者已确认起草并发放本文件新增授权。方案 A 是本稿的推荐方案，**尚未获得 implementation 拍板**；合并本评审不等于授权实施。
>
> **本次 PR 为 A 档 docs-only**。后续 C1 涉及新模型、migration 和版本冻结，按 D 档执行。评审以 `main@2f4d15d1` 为调查基点，实施前必须重新核验。
>
> **需求不是执行指令**：外部《SRVF 活动域终态蓝图与分阶段落地方案》§14、Release 3 表只提供需求；本仓当前事实、AGENTS 与 T0-A 冻结合同决定边界。文档中的模型名、命令和流程不自动构成写库、改权限或生产授权。

## 1. 需要拍板：先建立可追溯的指标目录，再接入活动

- **做什么**：让“统计什么、用什么单位、哪些必填”有明确版本，后续成果能按当时口径解释。
- **不做会怎样**：成果只能依赖临时字段或最新配置，修改指标后历史数字可能失去原来的含义。
- **最坏情况与回退**：错误定义或版本选择会污染后续成果解释。地基阶段不接现有业务，出问题停用新代码、保留新增表；接入阶段必须另有兼容与停止新写方案，不删历史数据回滚。
- **推荐方案 A**：C1 分为 D1 数据地基、D2 目录维护与活动选用接入，串行独立 PR；D1 完成不宣称 C1 完成。**本稿只提出 D1 的实施候选合同，D2 必须补齐外部契约评审和独立授权。**
- **方案 B**：在一个 D 档 PR 中同时建表、目录 CRUD、活动选用、v7、Readiness 与全部 handoff。终态目标相同，但兼容面、权限面和回退面叠加，暂不推荐。
- **拍板前承诺**：只交付本评审及台账，不写业务代码、不建表、不发放授权、不运行 migration。

这里的 D1 / D2 是 **C1 内部实施步骤**，不是 Release 4 的 TimePolicy D1 / D2。C2 及之后仍按 T0-A 顺序另立项，不能用拆步永久省掉 C1 的接入。

## 2. 已核验事实与兼容边界

| 证据（调查基点） | 结论 |
|---|---|
| T0-A §7.3、§11；外部蓝图 §14.2 与 Release 3 C1–C5 | C1 管定义和集版本；C2 管 Outcome / Value revision；C3 管自动计算与人工确认；C4/C5 管工作台与报表。成果不能伪造参与事实或反向改变时长、贡献。 |
| `prisma/schema.prisma`：`rg` 定位后，以 Node 读取并解析全部 132 个 model 声明复核 | 当前没有 `ActivityMetricDefinition`、`ActivityMetricSetVersion`、`ActivityOutcomeRevision` 或 `ActivityMetricValueRevision`；不能把文本同名当作已实现。 |
| `src/modules/activities/activity-participation-metrics.ts:49`；调用者 `activity-participation-query.service.ts:238`、`src/modules/meta/participation-overview-query.service.ts:169` | 现有函数计算报名、出勤、服务时长、贡献等参与统计，不是版本化指标目录。C1 不替换或重命名它，也不改变统计口径。 |
| `src/modules/activities/activity-publish-proposal-v2.service.ts:236,1546,1700`；`test/e2e/activity-os-r2-b5-snapshot-v6.e2e-spec.ts:318,329,351` | v6 的 `metricSetPointer` 类型、解析和构建均限定为 null，已有行为锁。**非空指针接入必须新增 v7，v2–v6 解析、在途 hash 和既有断言不变。** |
| `src/modules/activities/activity-publish-readiness.service.ts:233,550`；T0-A §6.3 | 当前无条件报告 `METRIC_SET_UNREPRESENTABLE`。有新表不等于某活动已选有效指标集；D1 不删 blocker、不伪造满足条件、不启用 Readiness Gate。 |
| `src/modules/activities/activity-template-definition.ts`；`prisma/schema.prisma:1720` | 已有版本号、canonical/hash、冻结生命周期的工程先例。指标使用独立强类型合同；不得修改模板 canonical 口径或把模板 JSON 当万能容器。 |
| [#1275](https://github.com/BA7IEE/srvf-nest-api/pull/1275)、[#1276](https://github.com/BA7IEE/srvf-nest-api/pull/1276) | B7 仓内实现与台账已合，前端发布、生产部署和 Gate 切换不是本轮事实。 |

**已报告的摘要偏差**：`prisma/CLAUDE.md:7` 仍称第 109 条 migration 尚待合入；[#1270](https://github.com/BA7IEE/srvf-nest-api/pull/1270) 已于 2026-09-04 合并。本稿只记录核验差异，不改旧摘要、不推断生产 deploy 已完成；后续触碰 Prisma 时须在明确写集内校准当前摘要，历史长记不回改。

## 3. 方案 A / C1 D1 的候选数据合同

### 3.1 三张空表，不存成果值

| 模型 | 职责与候选结构 |
|---|---|
| `ActivityMetricDefinition` | 一个指标的一份明确口径。`id`、`code`、正整数 `version`、名称、类型、单位、受控校验配置、`schemaVersion`、`definitionHash`、生命周期和时间元数据；`(code, version)` 全局唯一，包括已退役版本。 |
| `ActivityMetricSetVersion` | 一个指标集的一份版本。`id`、`code`、正整数 `version`、名称、`schemaVersion`、`definitionHash`、生命周期和时间元数据；`(code, version)` 全局唯一。D1 不引入组织覆盖、默认优先级或租户。 |
| `ActivityMetricSetItem` | 集版本与精确指标定义版本的关联，保存 `setVersionId`、`metricDefinitionId`、集内稳定 key、顺序及 `required`。同集内 key、指标引用和顺序各自唯一；两端真实 FK，删除/改号均 Restrict。 |

第三张表只是关系明细，不是另起一条业务轴。它避免在 JSON 中保存无 FK 的定义 ID；不新增 Outcome、Value、Activity 指针、成员信息、结果附件、导入批次或确认人字段。未来值的“所属集项”必须由 C2 的复合锚点约束证明，不能把两条独立合法 ID 当作同一条业务链。

推荐以不可变版本行承载身份口径，不另造 Metric Family、通用规则引擎或独立配置平台。变更单位、含义或选项时新增定义版本；集必须精确引用版本，不能查“同 code 最新值”。不 seed 蓝图示例为队内正式指标，不自动选定任何必填成果。

### 3.2 强类型与范围

D1 候选 Definition V1 支持五类：非负整数、非负定点小数、布尔、限长短文本、单选。用途是表达人数/次数/数量、是否完成、主题或受控结果，不承担复杂问卷和任意对象。

- 数值单位必须显式；整数只用安全整数，小数以规范化十进制字符串参与 canonical/hash，不经浮点转换。小数候选精度上限为 18 位、其中小数位最多 6 位；具体指标可进一步收紧。
- 名称不超过 100 字符；短文本配置上限不超过 500 字符；单选不超过 50 项，选项 code 非空唯一，label 不超过 100 字符；一个集最多 100 项。code/key 使用有界小写字母、数字和下划线。边界和拒绝行为须在实现的 unit 中逐项证明。
- 单选必须声明选项，非单选拒绝选项；数值类型才接受数值上下界/精度，布尔不接受伪字符串；无适用单位时明确 null，不默认为人数。
- `required` 属于集项，表示该成果集合的完整性要求，**不等于时长/贡献结算阻断条件**。D1 不实现归档、年报或 Incident 关闭规则。
- definition 只允许受控元数据，拒绝未知 key、任意 JS/SQL/表达式、计算脚本、文件 URL、嵌套自由对象与 AI Prompt。系统计算规则与来源确认属于 C3，不在 D1 添加占位运行器。
- 目录不承载身份证、病情明细、人员名单、精确轨迹或个人附件。短文本支持不构成敏感成果采集授权；未来实际值涉及敏感信息时，须先独立回答用途、查看角色/掩码、期限/退队清理三问。

以上数值是**待拍板的工程边界**，不是声称现有合同已规定这些限制。业务具体指标名称、单位、选项、必填集合仍未提供；本稿不代替维护者制定正式统计制度。

### 3.3 生命周期、hash 与并发

1. 定义和集版本均为 `draft → active → retired`，不允许逆转、跳级或同版本复活；retired 保留历史可读，不能供新的活动选用。允许多份历史 active 版本并存，不通过“唯一 active”暗中替换历史指针。
2. draft 可编辑内容；id、code、version 和创建时间不可改。active / retired 的语义内容和关系明细冻结，只允许 active 退役及受控生命周期时间元数据变化；不提供物理删除或复用版本号的路径。
3. 激活集时必须非空，精确引用的定义必须当时 active，并复验每份定义及整个集的 canonical/hash。随后定义退役不改变已冻结集或历史解释；D2 的新选用资格需在同一事务重查集及其引用的定义，不把历史可读等同于可新选。
4. definition hash 含 schemaVersion 和全部语义配置；集 hash 含集语义、项顺序、required、精确定义标识与 hash。对象 key 排序、数组按确定顺序、拒绝重复项与未知版本；不得复用一个可变“最新配置”解释旧 hash。
5. 数据库 CHECK / UNIQUE / FK / trigger 负责形状、生命周期及冻结不变量；纯函数负责完整语义与 hash 复算，**不声称数据库已证明应用 canonical/hash 正确**。未来 writer 激活前必须调用它们，禁止只校验 64 位字符串就信任 hash。
6. 修改集项、激活、退役和定义并发变更须锁定相应父版本，检查与写入在同一事务，锁序稳定；数据库原生 SQL 绕过 service 的反例也必须被结构性约束拒绝。D1 不新增用户业务 writer；用隔离数据库测试验证这些不变量。

## 4. C1 D2 必须补齐的接入合同（本稿不授权实现）

D1 之后、C2 之前，必须再评审并交付以下实际闭环；不能把它们自动塞进 C2 或报成已完成：

| 必须交付 | 评审/验收要求 |
|---|---|
| 目录维护和选用 | 明确 Human 管理入口、读面、权限与组织范围、幂等及审计；不凭管理员角色直通，不借用模板权限。先列实际 route/DTO/permission 矩阵再批准。D1 的全局目录不自动赋予任何人读写权。 |
| Activity / Template 选定版本 | 明确由谁选、何时可改、模板默认如何复制、旧活动 NULL 如何保持兼容，以及发布后如何通过变更提案更换；无精确已批准指针不退回“最新 active”。相关 schema / Template Definition 新版本另列写集。 |
| 新提案 v7 | v2–v6 保持原解析、原 hash 和审批行为；v7 才承载非空 metricSetPointer，并冻结版本/hash。集引用退役后的历史重建仍可解释，失联或 hash 不一致 fail-closed；安全 changeDiff 不复制成果值或敏感内容。 |
| Readiness 真正消费 | 活动选定有效集、有明确适用要求后才能判定；“明确不要求指标集”与“配置缺失/无法表达”必须区分。只新增版本感知判据，不整段删 blocker；不得解除时长、贡献、安全等无关 blocker 或打开 Gate。 |
| 历史与新链并行验收 | 无选择的历史活动、三种 B6 创建、v2–v6 在途审批、B7 off/shadow/active、旧参与统计均回归；新增 handoff / OpenAPI / client 逐项解释 diff。 |

这些业务与权限决定尚未齐备，因此现在**不能下发一个宣称完整 C1 已获授权的无人值守实施 goal**。本稿冻结的是审议记录和 D1 候选边界，D2 细节通过后续新增评审补齐，不回改本冻结稿。

## 5. D1 风险表与回退

| 项 | 本次评审 PR | 后续 D1 方案 A |
|---|---|---|
| 修改 `prisma/schema.prisma` | 否 | 是，三张新表及必要关系；不改现有业务字段语义。 |
| 新增/改动 migration | 否 | 新增一条 additive migration；当时数量/文件名现场核验，不预占第 110 条，不改任何历史 SQL。 |
| 修改 `prisma/seed.ts` | 否 | 否；正式目录内容不自动 seed。 |
| 影响现有数据 | 否 | 零回填、零 DML、零删除、零旧记录重解释；非空库 rehearsal 证明原数据保持。 |
| 不可逆 | 无数据库动作 | 不含 DROP/枚举移除/破坏性变换；加表仍需锁与部署评估。回退优先旧应用+保留新表，不承诺自动删表；已有新记录绝不销毁回滚。 |
| OpenAPI / contract snapshot | 不改 | 预期零差异；D1 无 HTTP、DTO 或 Activity 指针。 |
| 鉴权 / Permission seed / 审计 | 不改 | 不改、不新增正式 writer；D2 另评审真实授权与审计。 |
| 新 BizCode | 否 | 不新增；纯解析错误不能未经适配就作为未来 HTTP 错误。 |
| 需要用户拍板 | 已获起草授权 | 是，方案拍板、实施写集、红区与隔离测试库目标分别核验；生产部署另批。 |

## 6. 探针与验收清单

### 6.1 本评审 PR

- 仅 §7.1 四个文档路径；新稿登记 `open · P1-33`，C1 不标 landed。
- 台账与 NEXT_TASKS 均说明“已起草、未实施”；派生读数由脚本生成，台账检查与 unit 通过。
- 链接/地图、事实计数与恒读预算守护通过；不以 docs-only CI 跳过 E2E 冒称业务测试全绿。

### 6.2 后续 D1 的 DoD 与幂等探针队列

| 顺序 | 未满足才实施的探针 | 必须提供的证据 |
|---|---|---|
| 1 | 当时 main 是否已有本组三表和对应 migration | 精确模型/约束/迁移清单；已有部分实现先核对，不重复建表、不自动补数据。 |
| 2 | 强类型 Definition / Set V1 是否可确定性解析和 hash | 正反 unit：边界值、未知 key/version、浮点、非法选项、重复集项、hash 篡改；对象换 key 顺序不改 hash，语义变化必须改 hash。 |
| 3 | 生命周期和关系冻结是否在 DB 真生效 | 授权隔离库 PostgreSQL E2E：非法状态、逆转、active 修改、集项增删改、跨版本引用、孤立 FK、并发激活/退役/编辑；每个维度独立断言，不仅查 SQL 字符串。 |
| 4 | 旧数据及读写是否不变 | 空库完整 replay、非空库 rehearsal；原数据前后核对；定向 B5/B6/B7、现有参与统计 characterization 与 contract 零差异。测试准备不改业务断言。 |
| 5 | 守护与收口是否完成 | schema/client 一致、migration 计数锚点同步、机读 digest 与派生文档准确；本地 quick 与定向 E2E、PR CI 全量、D 档跨模型评审及其处置、可信红区审批、handoff。 |

本地不跑全量 E2E；数据库验证仅在维护者明确批准的隔离测试目标上执行。无 Docker/目标未批准时如实标记未验，不擅自启动数据库。跨模型评审限定明确 diff 和单轮任务，发现问题先复现，分歧上报，不运行无界重试或后台循环。

## 7. 写集与授权

### 7.1 本次已授权的评审写集

1. `docs/archive/reviews/activity-os-r3-c1-metric-definition-set-review.md`：仅新增本稿。
2. `docs/ai-harness/FROZEN_DRAFTS.md`：仅 C1/P1-33 登记及派生读数。
3. `docs/ai-harness/NEXT_TASKS.md`：仅 P1-33 的 C1 状态和顺序。
4. `changelog.d/activity-os-r3-c1-metric-review.md`：docs-only fragment。

本稿新增红区授权已经核验；**本地令牌只解决能否写，不构成合并或后续实施授权**。不沿用旧 `prisma/**` 等令牌的历史 reason 执行 C1。

### 7.2 D1 实施候选写集（尚未授权）

| 组 | 候选路径与限定 |
|---|---|
| 存储 | `prisma/schema.prisma`、仅本次新增 `prisma/migrations/<现场确定时间>_activity_os_r3_c1_metric_definition_set/migration.sql`、`prisma/CLAUDE.md` 的当前摘要；历史长记和 migration 不改。 |
| 纯函数与测试 | 新增 `src/modules/activities/activity-metric-definition.ts`、`activity-metric-set-definition.ts` 及对应 `.spec.ts`；新增 `test/e2e/activity-os-r3-c1-metric-definition-set.e2e-spec.ts`；模块 CLAUDE 仅登记边界。不改现有模板 canonicalizer 或参与统计。 |
| 迁移/机读登记 | 现场定位所有 migration count 锚点（含裸数字断言，不限于常量同名），仅同步计数；`harness/domain-map.json`、`harness/state-machines.json` 仅新增模型归属/生命周期和必要 digest，不改裁判；3b 因迁移数变化重新核验签字，4b 无权限/审计变化则不预设需要重签。 |
| 交接与派生 | `docs/handoff/miniapp.md`、`docs/handoff/admin-web.md` 仅说明内部地基未开放；`docs/current-state.md` 计数生成块、`CODEMAP.md`、`docs/ai-harness/FROZEN_DRAFTS.md`、`docs/ai-harness/NEXT_TASKS.md` P1-33、独立 changelog fragment。 |

上述是预算，**不是通配授权清单**。实施前必须输出核验后的每个精确路径；新增后果路径先上报，不以“生成物”或“测试适配”为由越集。`pnpm harness:needs` 不验证现有授权，授权须从当前 worktree 的实际令牌读取。

维护者需要依次确认：

- **方案选择**：`确认 C1 方案 A（D1 数据地基；D2 接入另评审，未完成前不宣称 C1 完成）`。
- **实施授权**：本稿合入且实际写集核验后，再确认 `C1 D1 implementation 方案 A`；届时提供精确红区命令与隔离数据库目标/回退清单。现在不要求执行 `prisma/**` 广泛授权。
- **合并与部署**：评审 PR、D1 PR 分别处理合并确认和所需 GitHub 环境审批；3b 等签字必须基于实际读数。生产 migration、目录初始化、前端发布和任何 Gate 切换始终独立审批。

## 8. 本次未做

未实施任何模型、migration、seed、解析器、数据库 trigger、HTTP/DTO、权限、审计或测试；未生成 OpenAPI/client；未修改旧 Prisma 摘要、v6/hash、Readiness、B6/B7、时长、贡献、AI 或 Incident；未运行数据库命令、部署、初始化正式指标、开启 Gate、创建新的 goal 执行会话或启动跨模型后台评审。C1 D1/D2 与 C2–C5 均未完成。
