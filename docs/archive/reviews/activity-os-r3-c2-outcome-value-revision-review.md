# Activity OS R3 / C2：成果与指标值修订评审及授权清单

> **状态**：2026-09-07，维护者已确认起草并发放本文件新增路径授权。方案 A 是本稿推荐方案，**尚未获得 implementation 拍板**；合并本评审不等于授权建表、写值、迁移、启用路由或部署。
>
> **本次 PR 为 A 档 docs-only**。后续 C2 会触碰新模型、migration、成果来源、附件引用、权限和审计，按 D 档分步执行。评审以 main@9a4a91d3 为调查基点，实施前必须重新核验。
>
> **需求不是执行指令**：外部《SRVF 活动域终态蓝图与分阶段落地方案》的成果章节只作为需求材料；本仓当前事实、AGENTS 与 Activity OS T0-A 冻结合同决定边界。材料中的模型名、流程和来源枚举不自动构成数据库、附件、权限、AI、Integration 或生产授权。

## 1. 需要拍板：先把成果修订链建成可追溯事实，再讨论自动计算与确认

- **做什么**：让一个活动在已选定的指标集口径下，能保留成果草稿、后续修订、每个值的来源和证据链；历史成果不被“最新指标定义”或后续编辑静默改写。
- **不做会怎样**：成果继续只能散落在备注、附件或临时统计里，无法说明“按哪份指标集、谁在何时、依据什么记录了这个数”。
- **最坏情况与回退**：把不相干活动、指标、附件拼成一条成果，或把草稿误当正式确认值，会污染报表和后续归档判断。回退优先停新 writer、保留已产生的不可变记录；不删除成果、附件或 migration 里的历史事实。
- **推荐方案 A**：C2 串行拆为 D1 成果数据地基与 D2 人工草稿／修订闭环。D1 不建 API、不写成果值；D2 只允许已授权负责人写 manual 草稿和修订，**不产生 confirmed 正式成果**。C3 才单独接入系统自动指标和人工确认；import 与 AI 来源也不能因本稿出现枚举值就自动解锁。
- **方案 B**：一个 D 档 PR 同时建表、接人工写读、附件、确认、自动指标、权限、审计、OpenAPI 和报表入口。终态相同，但数据治理、访问控制、兼容和回退面彼此叠加，暂不推荐。
- **本次承诺**：只交付本评审、台账和 changelog；不写生产代码、不建表、不运行 migration、不发放任何后续授权。

这里的 C2 D1／D2 是 Release 3 的内部施工步骤，不是 Release 4 的时长 D1／D2。拆步不减少 C2 的最终责任：只有数据链、人工路径与 C3 的确认边界都被明确并交付，才可声称 C2 的仓内范围闭环。

## 2. 已核验事实与边界

| 证据（调查基点） | 结论 |
|---|---|
| Activity OS T0-A §7.3、§8、§11、§12 | C2 负责 ActivityOutcomeRevision 与 ActivityMetricValueRevision；成果与时长、贡献、参与事实正交。每个正式值需要来源、来源参考、证据、规则版本、确认人和确认时间；成果不能伪造参与事实。 |
| prisma/schema.prisma:1406–1408、1565、1704–1779 | C1 已有 ActivityMetricDefinition、ActivityMetricSetVersion、ActivityMetricSetItem、ActivityMetricCommandReceipt，以及 Activity 上的精确指标集指针和 hash；当前没有 ActivityOutcomeRevision、ActivityMetricValueRevision 或成果值 writer。 |
| src/modules/activities/CLAUDE.md:38 | C1 D1–D2c 的仓内实现已完成，但整体跨模型复审、生产可用性、正式目录初始化与成果值仍未完成。C2 不得把 C1 的“可选指标集”误写成“已有成果”。 |
| src/modules/activities/activity-type-migration.registry.ts:75 及 assembled_no_action 条目 | legacy outcomeCode 只是未来选择器；当前不创建 Outcome 字典或持久化对象。C2 不从旧 activityTypeCode 自动回填或推断任何成果。 |
| src/modules/attachments/attachments.service.ts:181–202；activity-cover.service.ts | 附件归属只由 attachments 模块判定。活动侧必须在已完成判权、锁住 Activity 根后调用受信任 facade；不得直接查询 Attachment，也不得新造第二套 owner 校验。 |
| src/modules/audit-logs/audit-logs.types.ts:19–23 | 当前仅有三个 C1 指标审计事件，没有 outcome 事件。C2 D1 不新增事件；D2 如需要写命令，必须另行拍板事件名、可记录字段和计数签字。 |
| Activity OS T0-A §9 与 AGENTS 的敏感字段三问 | 指标“短文本可用”不等于获准收集敏感成果。身份证、健康、人员名单、精确轨迹、原始图片／文档内容都不能被成果值或来源参考默认接收。 |

**C1 与 C2 的硬边界**：C1 的 MetricSetVersion 是“这场活动适用哪份受控指标口径”；C2 的 Outcome／Value Revision 是“这场活动在某次修订中记录了什么”。两者必须精确关联，但 C2 不修改 C1 定义、集项、活动选择、v7、Readiness 或任何旧 proposal。

## 3. 方案 A / C2 D1 的候选数据合同

### 3.1 不可变成果头与指标值修订

| 候选模型 | 职责和关键约束 |
|---|---|
| ActivityOutcomeRevision | 一个 Activity 的一份成果修订头：activityId、正整数 revision、精确 metricSetVersionId／metricSetDefinitionHash、statusCode、priorRevisionId、创建人和时间。activityId + revision 永久唯一；prior 链只能指向同一活动。精确指标集以 C1 的 id + definitionHash 外键固定，不查“当前最新”集。 |
| ActivityMetricValueRevision | 一份 OutcomeRevision 中某一受控指标的值：outcomeRevisionId、activityId、setVersionId、metricDefinitionId、按 C1 定义验证后的 canonical valueJson／valueHash，以及来源和确认元数据。同一成果修订中同一指标定义至多一值。 |
| ActivityMetricValueEvidence | 支撑表，不是第五条业务轴：把一个值与一个或多个已有附件以排序关系连接。它以复合外键证明值、成果头、活动和指标集同链；Attachment 一侧 Restrict，正式证据不能在引用后被物理删掉。 |

“修订”不是原地 UPDATE：每次内容变化创建新 ActivityOutcomeRevision 及其完整值快照。外部材料中的“revised”在数据层映射为“新 revision 已产生、前一份被 superseded”，不把 revised 做成一条可继续改内容的状态。候选状态为 draft、confirmed、superseded；C2 D1 只存形状，C2 D2 不开放 confirmed 写入，C3 另行决定确认状态的合法迁移。

### 3.2 复合锚点、历史解释与事务

1. 创建或修订时先锁 Activity 根，重新读取其 selectedMetricSetVersionId 与 selectedMetricSetDefinitionHash；没有精确已选指标集就 fail-closed，不凭 code 查 active 最新集。
2. OutcomeRevision 固定当次 C1 集 id + hash。ValueRevision 以 [outcomeRevisionId, activityId, setVersionId] 关联成果头，并以 [setVersionId, metricDefinitionId] 关联 C1 集项；这样两条各自合法的 id 不能跨活动、跨指标集拼接。
3. 活动后来通过已批准流程切换指标集，不回写旧成果。新成果是否允许使用新集，必须在同一 Activity 根事务内由后续 writer 重查；本稿不把“当前选择”做成会阻止历史读取的跨表硬绑定。
4. C1 的受控解析器是唯一值类型规则来源。C2 不加万能 JSON、表达式、脚本、SQL、浮点重算或“按 code 猜类型”；kind、配置和 hash 不一致一律拒绝。
5. 一次人工命令的授权重查、Activity 锁、指标集／集项校验、修订头和值、收据、附件引用锁与最小审计必须在一个 transaction 内。不得先写值、再异步补附件或审计。

### 3.3 来源、证据和确认的最小语义

候选 sourceCode 闭集为 system、manual、import、ai_suggested_confirmed，与 T0-A 一致；但数据库能表示不等于本阶段能写。

| 来源 | C2 D2 是否可写 | 条件 |
|---|---:|---|
| manual | 是，限草稿／修订 | 只能由后续明确授权的 Human facade 写入；默认只开放非敏感数值、布尔和单选。 |
| system | 否 | 归 C3 自动指标；必须明确输入事实、计算规则版本、可复现性和人工确认。 |
| import | 否 | 需独立 importer、来源信任、幂等、错误行与回滚合同；C2 不借此引入批量导入。 |
| ai_suggested_confirmed | 否 | AI 不能进入核心事务或直写成果；只有 C3／后续 Assist 的人工确认路径才能形成正式修订。 |

对 **confirmed 正式值**，候选约束为：sourceReference、calculatedByRuleVersion、confirmedByUserId、confirmedAt 全部非空，且至少一条证据关系存在。manual 可使用受控的人工记录／规则版本标识，不能把 Idempotency-Key、完整 URL、Token、原始 Prompt、模型响应或自由备注塞进 sourceReference。draft 可以暂缺确认元数据，但绝不显示为正式结果。

“至少一条证据”是跨行不变量，单行 CHECK 不能诚实地证明它。D1 不假称数据库已完整解决它；未来 C3 的确认 transaction 必须锁定值和附件关系并做运行时复验，必要时再以独立评审决定 deferred trigger。C2 D2 也不得通过先确认、后补附件绕开这条条件。

### 3.4 附件与敏感数据边界

- C2 D2 只考虑已归属本 Activity 的现有 activity owner 附件；不新增 owner type、不修改附件配置表、不假定当前 MIME／大小策略一定适合所有证据。
- 关联前必须调用 attachments 的 findOwnedAttachmentsTrusted 和 lockOwnerReferenceStorageBoundaryTrusted；模块外禁止直接 tx.attachment 查询。
- 值、审计和 DTO 不保存附件 key、完整 signed URL、文件内容、Token 或外部系统凭证。读面是否能取得受控下载链接，留给附件访问策略的独立评审。
- C2 D2 默认拒绝 short text 值。若业务要求它或证据中含个人／健康／身份／位置数据，先逐项回答用途、查看角色与掩码、保存期限及退队清理；没有答案就不启用该指标和写路径。

## 4. C2 D2 与 C3 必须补齐的外部合同

本稿不固定 route、DTO 或权限码，避免用 C1 的已有权限“顺手扩大”成果访问面。C2 D2 评审至少要列出以下矩阵后才能 implementation：

| 项 | 需要先拍板的内容 |
|---|---|
| Human facade | RecordActivityOutcome 与 GetActivityOutcome 的输入、输出、错误、幂等和 revision 语义；不能返 Prisma row。 |
| 主体与范围 | 是否仅限 App managed 活动责任人、是否存在 Admin 管理面、谁能读草稿／确认结果。App 不返回 raw permission code，且不得因 ADMIN／SUPER_ADMIN 身份绕过业务 scope。 |
| 权限与审计 | 是否新设 activity.outcome.record／read 等最小权限，或为何不需要；不得静默扩大 activity.update.record。写命令如新增 activity.outcome.command，审计只存资源锚、操作、状态、来源类别和数量，不存实际值、附件 key 或敏感来源。 |
| 命令收据 | 必须证明现有 ActivityMetricCommandReceipt 是否真的能表达成果命令的重放与安全响应；不能证明就新建精确 receipt，而不是滥用 resultJson。 |
| 读面与可见性 | C2 不开 Open、Integration、成员自助或报表面；C4／C5 以后若要展示汇总，单独定义字段分级、掩码与分页。 |
| C3 接缝 | confirmed、system 和 ai_suggested_confirmed 的唯一 writer／确认人／规则版本／证据校验由 C3 独立定义；import 仍需独立方案。 |

## 5. 风险、兼容与回退

| 项 | 本评审 PR | 后续 C2 D1 方案 A | 后续 C2 D2／C3 |
|---|---|---|---|
| Prisma schema / migration | 否 | 是，纯 additive 新表、FK、CHECK／UNIQUE／冻结约束 | 仅在 D1 已审查形状上接 writer；如发现缺列或约束，另起评审。 |
| 现有数据 | 不改 | 零回填、零旧 Activity 解释、零从 registry 推断 Outcome | 只追加新 revision；历史活动无指标集继续保持无成果。 |
| C1 / v2–v7 / Readiness | 不改 | 不改 C1 模型、选择、proposal 或 Readiness | 回归 C1 选择、v2–v7、B6／B7，不把成果完整性接入发布或结算。 |
| 附件 | 不改 | 只建引用形状，不接 writer | 仅通过 trusted facade；无法证明 owner／留存／敏感边界时停下。 |
| 权限 / Audit / OpenAPI | 不改 | 不改 | D2 单独评审、单独 4b 实际读数、契约／可信审批和 handoff。 |
| 回退 | 无运行时影响 | 停旧应用、保留空表；不承诺删 migration | 停新 writer／route，保留不可变成果和附件；生产 deploy 始终独立审批。 |

任何 C2 migration 的编号、文件名、锁时长、非空库 rehearsal 目标和生产 deploy 都必须在 D1 开工时现场确定。不得预占 migration 编号、修改历史 SQL、跑 migrate dev／reset／db push、或把测试库授权当生产授权。

## 6. 探针与验收清单

### 6.1 本评审 PR

- 仅第 7.1 节四个文档路径；登记为 open · P1-33，明确“已起草、未实施”。
- FROZEN_DRAFTS 与 NEXT_TASKS 的 C1／C2 状态互相一致；派生读数由现有脚本刷新，不把历史冻结稿回改成“已完成”。
- docs 校验、台账守护、链接／地图／计数检查通过；docs-only CI 未覆盖业务 E2E 时如实标示，不冒称 C2 行为已验证。

### 6.2 后续 C2 D1 的最低 DoD

1. 现场证明三个候选模型尚未存在，迁移只 additive，空库与获批非空隔离库的 migrate deploy／rehearsal 都通过。
2. PostgreSQL E2E 逐项证明：跨 Activity prior 链、跨集指标、错误 hash、重复 revision、重复指标值、非法状态、confirmed 字段缺失和关联附件跨活动都被拒绝；不只检查 migration 文本。
3. 单元证明 C1 五类值解析、canonical 和 hash 仍为唯一规则；边界、未知 key、浮点、配置漂移及 valueHash 篡改均拒绝。
4. C1 D2c、B5、B6、B7、现有参与统计、时长和贡献 characterization 保持行为不变；不修改任何既有 E2E 断言来换绿。
5. migration 计数、schema client、domain／state-machine 登记、派生文档和 D 档 3b 签字按实际读数更新；D1 无权限／审计增量时不预设 4b 重签。

### 6.3 后续 C2 D2／C3 的行为探针

- 相同 operation key + 相同请求重放原结果；同 key 异请求拒绝且零新 revision。
- Activity 责任、组织可见性、指标集指针、附件归属和当前用户身份都在锁后重验；任一漂移整笔回滚。
- manual 草稿不能被读成 confirmed；C3 之前 system／import／AI 来源全部拒绝。
- confirmed 只能在值、来源、规则版本、确认人与时间、至少一条受控证据都齐备时产生；确认不改写旧值。
- 任何 Outcome 操作不创建／修改报名、考勤、服务时长、贡献、账本、发布状态、Readiness Gate 或 Incident 数据。

## 7. 写集与授权

### 7.1 本次已授权的评审写集

1. docs/archive/reviews/activity-os-r3-c2-outcome-value-revision-review.md：仅新增本稿。
2. docs/ai-harness/FROZEN_DRAFTS.md：仅 P1-33 的 C2 登记和派生读数。
3. docs/ai-harness/NEXT_TASKS.md：仅 P1-33 的 C2 当前状态和顺序。
4. changelog.d/activity-os-r3-c2-outcome-value-review.md：docs-only fragment。

本地授权令牌只允许写这份评审稿，不构成 merge、C2 D1、C2 D2、C3、数据库、附件、权限、生产或 Gate 授权。历史 C1 令牌也不得带入。

### 7.2 C2 D1 实施候选写集（尚未授权）

| 组 | 候选路径与限定 |
|---|---|
| 存储 | prisma/schema.prisma、仅一条现场确定的 prisma/migrations/<timestamp>_activity_os_r3_c2_outcome_value_revision/migration.sql、prisma/CLAUDE.md 当前摘要；不改历史 migration、seed 或现有 C1 结构。 |
| 领域与测试 | 新增 activities 模块内 outcome／value canonical、链路约束及对应 unit；新增独立 activity-os-r3-c2-outcome-value-revision E2E。不得改 C1 parser、模板 canonicalizer、参与统计或旧测试断言。 |
| 机读与派生 | 现场定位 migration count 锚点；harness/domain-map.json、harness/state-machines.json 仅登记实际新模型／状态；docs/current-state.md 计数生成块、CODEMAP、FROZEN_DRAFTS、NEXT_TASKS、独立 changelog 与必要 handoff。 |
| 明确排除 | 无 HTTP、DTO、OpenAPI、Permission seed、AuditLogEvent、附件 owner type／config、AI、Integration、importer、Readiness／Gate、生产 deployment。 |

上述仅是预算，不是通配授权。D1 实施前必须列出实际精确路径、风险和隔离测试库；新增后果路径不能以“生成物”“测试适配”或“C2 顺带”为由越集。

维护者后续需要依次确认：

- **方案选择**：确认 C2 方案 A（D1 数据地基；D2 仅人工草稿／修订另评审；confirmed／system／AI 归 C3，import 另立）。
- **D1 implementation**：在本稿合入、实际写集与隔离测试计划核验后，单独确认 C2 D1 implementation 方案 A。
- **D2 / C3**：分别确认权限、审计、附件／敏感字段、route／DTO、收据和真实测试库；不得以 D1 授权带入。
- **合并与部署**：评审 PR、D1 PR、D2／C3 PR 分别确认合并；生产 migration、正式指标初始化、前端发布和任何 Gate 永远独立审批。

## 8. 本次未做

未实施任何 Outcome／Value／Evidence 模型、migration、seed、canonicalizer、数据库触发器、HTTP／DTO、权限、审计、附件写链或测试；未生成 OpenAPI/client；未修改 C1、v2–v7、Readiness、时长、贡献、参与、AI、Integration、import 或 Incident；未运行数据库命令、部署、初始化正式指标、开启 Gate、创建 C2 implementation goal 或启动跨模型后台评审。C2 的仓内 implementation、C3–C5、前端发布和生产可用性均未完成。
