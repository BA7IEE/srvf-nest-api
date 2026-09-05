# Activity OS R3 / C1 D2：指标目录、活动选用与 v7 接入评审及授权清单

> **状态**：2026-09-05，维护者已确认起草并发放本文件新增授权；下文方案 A 是候选方案，**尚未批准实施**。本次只更正 D1 台账、起草 D2，不运行 migration、seed 或模型评审。
>
> **调查基点**：`main@3b3e57aa`，C1 D1 已随 [#1278](https://github.com/BA7IEE/srvf-nest-api/pull/1278) 合入，最终 18 项检查通过。历史 [C1 评审](activity-os-r3-c1-metric-definition-set-review.md) 不回改；外部蓝图 §14 / Release 3 是需求资料，不是数据库、权限或生产操作授权。
>
> 本 PR 为 **A 档 docs-only**；D2 实施涉及 schema、seed、权限、审计和对外契约，按 **D 档**。维护者已将阶段性跨模型复审延后至整体完成后统一执行；本稿不是独立模型复审通过记录，也不解除方案拍板、红区、CI、签字、合并和部署边界。

## 1. 人话简报与推荐方案

- **做什么**：让真人能维护有版本的指标目录，为活动明确选择一份指标集或声明无需指标，并让模板、发布提案和就绪检查使用同一份选择事实。
- **不做会怎样**：D1 的三张表仍只是内部地基；没有入口和活动指针，不能填写配置，也不能诚实移除“指标无法表达”的提示。
- **最坏情况**：选错口径、旧提案被新解析器拒绝、退役导致历史无法解释，或扩大目录权限。通过不可变版本、旧解析器保留、同事务复验及原路径回归控制风险；回退停用新写并保留数据，不删表、不覆盖历史。
- **方案 A（推荐，待拍板）**：D2a 指标目录维护与命令收据 → D2b 活动选择、模板 Definition V3 与最小 Human 模板维护 → D2c 新提案 v7、Readiness 与交接。三个独立实施 PR 串行，任何一步都不等于 C1 完成；D2c 验收后才进入 C2。
- **方案 B**：把三步放进一个 D 档实施 PR，交付内容相同，但鉴权、迁移、模板、在途审批与回退面同时叠加，不推荐。

这里的 D2a/b/c 是 C1 内部交付顺序，不是 Release 4。不能把目录 CRUD 当作整个 C1，也不能把模板维护或 v7 留成永久待办后进入 C2。本稿尚有明确的产品/权限候选决策，**不是可直接下发的无人值守 implementation goal**。

## 2. 已核验的当前事实

| 锚点 | 当前事实 / 对本稿的约束 |
|---|---|
| `prisma/schema.prisma:1695–1752` | D1 三表已经存在；定义/集固定 schemaVersion 1，集项有真实 FK；没有 Activity 选用字段。 |
| `activity-metric-definition.ts:170,223`；`activity-metric-set-definition.ts` | 五种强类型与 canonical/hash 已有唯一纯函数入口；未来 writer 必须调用，不能只检查 hash 字符串长度。 |
| `activity-publish-proposal-v2.service.ts:236,1546,1700` | v6 的 metricSetPointer 是类型、解析和构建三处固定 null；已有 B5 用例锁定。非空选择只能进入新 v7。 |
| `activity-publish-readiness.service.ts:550` | 当前无条件添加 METRIC_SET_UNREPRESENTABLE；新增目录表本身不能证明某活动已满足指标要求。 |
| `activity-template-definition-v2.ts:17,64`；`activity-from-template.service.ts:578–610` | 模板 V2 在 V1 上增加 governed Form；精确选用只支持 V1/V2。新增 V3 分支，不放宽旧版未知键和 hash。 |
| `prisma/schema.prisma:1754–1840`；`activity-from-template.service.ts:318,334` | Family/Version 和精确模板物化已存在；Family scope/status 的 String 字段本身不是已批准治理合同。 |
| `src/modules/activities/controllers/`、`activities.controller.ts` 的路由声明与 `docs/handoff/openapi.json` paths | 当前有 from-template 和 template-resolution，但没有 Human 模板目录维护路由。不能写成“扩展已有模板 CRUD”。D2b 的最小维护入口是本稿明确提出的新增范围。 |
| `activity-series.service.ts:80–100`；`activity-from-template.service.ts` | Series 复用精确模板校验和物化；V3 默认指标需随每个新实例冻结，不改已生成实例和旧 revision。 |
| `activity-access.service.ts:199`；`controllers/app-managed-activities.controller.ts:1378` | 现有活动命令走 ActivityAccessService / Authz 和 managed 责任检查；变更提案有正式入口，不能绕过审批直接改已发布活动。 |
| `RBAC_MAP.md`、`permissions/seed-permission-codes.ts`、`permission-catalog.ts` | 当前权限码 247；没有指标或模板目录专属权限。不能借活动创建权、模板权或 ADMIN 身份授权全局目录修改。 |
| T0-A §7.3；外部蓝图 §14 | C1 只管定义和选用；正式成果值、来源确认属于 C2/C3。指标不能反写参与事实、时长或贡献。 |

以上行号为调查基点定位，实施前按符号/引用链复核，不将文档中的候选名字当作已实现代码。

## 3. 待拍板的权限与目录合同

### 3.1 目录归属与可见性

推荐指标目录为队内全局业务目录，Human 管理面落 Admin，不迁移任何现有 System 目录。定义名称、类型、单位、受控配置及版本/hash 可供获授权者读取；不存个人成果、证件、病情、名单、轨迹或附件。

新增权限候选如下，均通过当前 RBAC / 权限目录机制声明，GLOBAL-only，不扩展 Role enum，不创建 RoleBinding、PositionRolePolicy 或默认组织权限；Service/Delegated eligibility 均 false。默认不向通用业务角色自动分配新码，SUPER_ADMIN 仍仅走现有统一 RBAC 的规则；其他维护者由真人另行配置授权。

| 候选权限码 | 能做什么 |
|---|---|
| `activity-metric.read.catalog` | 读取全量状态的指标定义/集目录及版本详情。 |
| `activity-metric.manage.definition` | 创建、编辑 draft、激活、退役指标定义；不含删除或改 active 内容。 |
| `activity-metric.manage.set` | 创建、编辑 draft 集及整组集项、激活、退役；不隐含定义写权。 |
| `activity-template.read.catalog` | 读取本稿最小 Human 模板维护面中的 Family/V3 及来源版本元数据。 |
| `activity-template.manage.version` | 本稿限定的全局 Family/V3 创建、draft 编辑、激活、退役。不能改 legacy/V1/V2 内容、组织归属或任意模板治理政策。 |

五个码是待审批预算，不在本 PR seed，不预签“252 条”。实施时对真实差值重算 4b。App 可选目录通过“当前队员可发起活动 / 可管理目标活动”的现有业务资格收窄，只返回可新选的指标/模板摘要，不返回目录原始权限码或不可见的 draft。

### 3.2 定义和集的写入

- D1 五种类型、数值/文本/选项/集项上限不变；所有 DTO 显式列字段，拒绝任意 JSON 扩展、计算表达式和脚本。系统计算规则仍归 C3。
- 创建请求明确 code/version；唯一身份占用包含 retired，不复用、不自动选“下一个最大版本”。相同身份不同命令冲突，不伪装幂等成功。
- 每次写命令携带 operationKey；编辑/激活另带 expectedDefinitionHash，状态也在锁后重查。相同请求重放只返回原最小收据，不重复 audit；同 key 不同 payload 拒绝。纯读取无需收据。
- 根事务包含当前授权复验、父行锁、强类型复验、canonical/hash、业务写、收据和审计。集项整组替换只允许 draft，同父行锁下进行；使用 D1 约束支持的 draft 明细替换，不删除定义或集版本。
- 激活集时锁集，再按 id 排序锁定义，逐条复验 active 与 hash；退役定义只锁自身，不反向锁所有集。退役不级联更改集或历史选择。
- 目录读可解释 retired，**可新选资格**另判：集及其每份定义均 active，hash 闭包一致；任一不满足不出现在选项中，点选提交仍需在事务重查。

### 3.3 收据与审计

推荐新增领域专属 `ActivityMetricCommandReceipt`，不把活动创建收据改成万能命令表。候选字段为 actorUserId、operationCode、operationKey、requestHash、最小 resultJson、createdAt，以及指向 definition/set/template/activity 的可空 Restrict FK；按操作恰好一个目标非空，DB CHECK 闭合。唯一键 `(actorUserId, operationCode, operationKey)`；收据不可改删，无 TTL、定时清理或后台重试。Template Family 首建与首个 V3 同事务，收据锚定新 Version，不产生无版本的半成品 Family。

resultJson 只包含稳定 ID、版本、状态、hash 与重放需要的最小结果；不得放自由配置全文、表单题干、用户答案、签名 URL 或 Token。返回前仍重新验证当前用户和访问权，收据不是权限缓存。

审计候选事件为 `activity.metric-definition.command`、`activity.metric-set.command`、`activity.metric-selection.command`、`activity.template-version.command`，以 operation 区分创建/编辑/激活/退役；只保存 target、code/version、前后 hash/status、操作者和规范化请求元数据。是否新增这些事件及其 resourceType/目录映射须随实施清单明列，不暗用无关 audit event。拒绝与回滚不留下成功审计。

## 4. Activity 选择与 Template V3

### 4.1 三态，不把缺失当作豁免

| 选择事实 | 含义 | 持久化 / 读面约定 |
|---|---|---|
| `unconfigured` | 旧活动或尚未配置，未知是否需要指标 | 存量新增列全 NULL，无回填；新 DTO 显式投影 unconfigured。 |
| `not_required` | 获授权真人明确声明该活动不要求指标集 | mode 有值，setId/hash 为 NULL，必须由命令/模板版本记录来源。不是空集代替。 |
| `required` | 必须按精确集版本采集成果 | mode、setVersionId、definitionHash 成组非空；真实 Restrict FK，复合锚点/约束证明 id 与 hash 属于同一集版本。 |

Activity 候选新增 `metricRequirementCode`、`selectedMetricSetVersionId`、`selectedMetricSetDefinitionHash`、`metricSelectionRevision`；前三列 nullable、revision 初值 0。旧 NULL 不按新政策批量推断。复合 FK 的 referenced unique 与新增 DB shape CHECK 同 migration 交付，CHECK 显式防 NULL 三值漏口。

草稿选择通过独立 PUT 命令，不能在通用 PATCH 里透传。授权=现有 activity.update.record 对目标 Activity 的判权，加 managed 责任规则；Admin 也走同一领域命令，不凭角色直通。行锁后复验 draft、expected revision、待审状态与精确集资格，再写选择、revision、收据和最小审计。只允许明确新请求将 required 改成 not_required，不因引用退役自动清空选择。

已发布活动的选择变更只能通过新 v7 变更提案和原审核链；不得由草稿接口修改。取消、终止、完成、归档等非 draft 状态不新增旁路写入口。C2 未实施前不声称已有成果值迁移；未来已有正式 Outcome 后换集的处理必须由 C2 的版本锚点合同接住。

### 4.2 模板默认与最小 Human 维护范围（新增候选决策）

推荐增加 **Template Definition V3**：保留 V2 的 activity/sessions/registrationForm，在新版本根增加必填 `metricSelection`，值为 not_required 或 required 的精确指针。V1/V2 保留原解析/hash，映射到活动时仍为 unconfigured，不自动升级。

为避免“只能在数据库造模板才可用”，D2b 明确包含最小 Human V3 维护入口：

- 首次创建允许同时建立全局 Family 与首个 draft V3，显式提供 code/name/category 与有效 activityTypeCode、完整 V3 definition；选择业务类别，不 seed 蓝图示例。Family 身份固定，候选写入 scopeTypeCode=`global`、ownerOrganizationId=NULL、statusCode=`active`。这些是**本稿新增写入口的合同**，不是给既有 Family String 字段补全仓闭集。
- 为已有全局 Family 新建 V3 时必须明确 familyId 与新 version；可提供既有精确 V1/V2/V3 为复制来源，服务端重建完整 V3、复算 hash。读取来源不等于允许修改来源。既有组织 Family 的读/写治理不在本稿自动扩面，不能冒充全局 Family。
- draft V3 可整份编辑、激活、退役；沿 A3 生命周期/冻结。激活前强类型、表单治理、effectiveFrom/effectiveTo、分类/业务类型、指标指针全部复验。指标集锁与定义锁顺序固定在模板行锁之后；不能只写 schemaVersion=3 就判模板可用。
- 不做全局模板搜索推荐、组织继承覆盖、迁移旧 Family、批量升级或正式模板内容初始化。上述最小入口是 C1 默认指标可人工配置的闭环，不宣称完成模板管理平台。

三种 B6 创建：from-template 在同一事务复制 V3 指标选择；professional/emergency 的新可选字段缺省保持旧请求/hash/收据语义，显式提供才参与新请求 hash 和资格复验。紧急创建可以保持 unconfigured，其事后成果义务不由“选择了指标集”改为 verified，也不得解除紧急起源的正式发布禁止。

Series 与普通 clone 同样逐条列入调用链：新实例继承精确 V3 选择，生成重放不重复建行、不改已存在实例；旧实例不跟随目录或模板更新。复用集指针的“新活动”须重验可新选资格；历史提案解释则允许 retired，二者不可混用。

## 5. 候选 route / DTO / 权限矩阵

表中每个动作都是新路由预算，不更改已有路径。Admin 与 App 顶层 DTO 物理分离，Controller 使用结构化权限声明、全局 Human JWT、IdParamDto 与统一响应；禁 @Roles、局部 Guard 或裸 Prisma 返回。列表默认 page/pageSize=1/20、上限 100，不能因为“目录不大”整取无限集合。

| Human endpoint 候选 | 核心 DTO 内容 | 准入 / 权限 / scope | 命令与审计 |
|---|---|---|---|
| GET `/api/admin/v1/activity-metric-definitions`、`/:id` | 分页筛选；显式定义详情含 schema/hash/status | `activity-metric.read.catalog`，GLOBAL | 只读，无命令收据 |
| POST `/api/admin/v1/activity-metric-definitions` | operationKey、完整 Definition V1 | `activity-metric.manage.definition`，GLOBAL | create_definition；definition.command |
| PUT `/api/admin/v1/activity-metric-definitions/:id/draft` | operationKey、expected hash、完整配置 | 同上，draft | update_definition；同上 |
| POST `/api/admin/v1/activity-metric-definitions/:id/activate`、`/:id/retire` | operationKey、expected hash | 同上，锁后状态机 | activate/retire_definition；同上 |
| GET `/api/admin/v1/activity-metric-sets`、`/:id` | 分页；集及有界明细、精确定义/hash | `activity-metric.read.catalog`，GLOBAL | 只读 |
| POST `/api/admin/v1/activity-metric-sets` | operationKey、code/version/name、明细 | `activity-metric.manage.set`，GLOBAL | create_set；set.command |
| PUT `/api/admin/v1/activity-metric-sets/:id/draft` | operationKey、expected hash、完整集项 | 同上，draft | update_set；同上 |
| POST `/api/admin/v1/activity-metric-sets/:id/activate`、`/:id/retire` | operationKey、expected hash | 同上，锁后状态机 | activate/retire_set；同上 |
| GET `/api/admin/v1/activity-template-versions`、`/:id` | Family/Version 元数据，分页/详情 | `activity-template.read.catalog`，GLOBAL；不扩大 App 可见域 | 只读 |
| POST `/api/admin/v1/activity-template-versions` | operationKey、Family 身份、version、完整 V3 | `activity-template.manage.version`，GLOBAL；只处理本稿全局 Family | create_template_version；template-version.command |
| PUT `/api/admin/v1/activity-template-versions/:id/draft` | operationKey、expected hash、完整 V3 | 同上，只限 draft V3 | update_template_version；同上 |
| POST `/api/admin/v1/activity-template-versions/:id/activate`、`/:id/retire` | operationKey、expected hash | 同上，A3 状态机 | activate/retire_template_version；同上 |
| GET `/api/app/v1/my/managed-activities/metric-set-options`、`/template-version-options` | organizationId、分页；仅有效可新选摘要 | app-member + 现有可发起组织判定；不是全局目录权限 | 只读；点选时再次验证 |
| GET `/api/app/v1/my/managed-activities/:activityId/metric-selection` | 三态选择、revision、历史解释/当前可新选标志 | app-member + 现有 managed 目标可见性 | 只读，允许解释 retired |
| PUT 同一路径 | operationKey、expected revision、not_required/required 指针 | app-member + managed + `activity.update.record` 的 Activity scope | select_metric_set；selection.command |
| GET/PUT `/api/admin/v1/activities/:id/metric-selection` | 独立 Admin DTO，同一业务命令 | 读沿既有 Activity 可见性；写 `activity.update.record` + 目标 scope | 同上，非 draft 拒绝 |

新增 POST 创建返回 201，PUT/激活/退役等命令显式 200；失效身份 401，权限拒绝 30100/403，资源不存在沿现有防枚举顺序。目录不存在、不可新选、hash 无效、并发 revision 冲突应独立新增业务错误符号并沿当前活动段分配数字；实施前列出 symbol/code/message/httpStatus，不预占编号、不复用无关模板错误伪装指标错误。

旧 B6 创建与发布/审核端点的路径、已有权限面保留；新增字段、v7 出参及 changeDiff 的 OpenAPI 差异逐项解释。Integration/Open 不新增端点，机器主体不能借 Human 目录进入。

## 6. v7 与 Readiness 的真消费

1. v7 增加显式 metricRequirementCode、精确 metricSetPointer 与选择 revision；not_required/unconfigured 指针为 null。required 指针冻结 set id/code/version/schema/hash，定义引用闭包可由不可变行重建，缺失/hash 不符 fail-closed。结果值、名单、表单答案和敏感内容不进入 pointer/changeDiff。
2. v2–v6 parser/canonical/hash/在途审批行为原样保留；旧提案仍可能在 D2 部署后被审批。旧 snapshot 没有选择字段不等于请求清空选择，applier 对旧版不得写 D2 新列。新提案统一生成 v7，历史分支只解释，不按新格式重新哈希。
3. 草稿选择在提交 v7 时冻结；新选择在提交/批准落地时均重验资格。审核期间新选集或定义退役、选择 revision 变化，拒绝落地并要求重提；若变更不触及既有已冻结选择，允许 retired 的历史解释，不能无关编辑也要求“换到最新”。
4. 发布后改集只走现有 change-review 和审核/apply 根事务，Activity 锁、指标集锁、定义排序锁一致；旧活动通用 PATCH、Admin 直发与 App 发布链均不能侧写新选择字段。
5. Readiness：unconfigured 为 missing；not_required 为明确不适用；required 只有 pointer/闭包完整且符合本次新选规则才满足；未知字段/格式不是 not_required。不得整段删除 metrics blocker，也不得消除时长/贡献/保险/安全等其他问题或开启 Gate。
6. “选择完成”不等于“成果已填/已确认”。本稿不写 Outcome/Value、不计算人数时长、不把指标 required 绑定到时长入账条件。

## 7. 风险、迁移与回退

| 风险项 | 候选实施影响 |
|---|---|
| schema / migration | 是：D2a 收据；D2b Activity 三态/revision、精确 FK 与必要 referenced unique。是否分两条迁移按各自 PR 现场确定，不预占 111/112，不改 D1 SQL。 |
| seed / 权限 / audit | 是：五个候选权限和四个事件及对应目录元数据；不 seed 正式指标、模板或 RoleBinding，既有角色权限不静默增加。3b/4b 按实际读数重签。 |
| 现有数据 | additive；旧 Activity 选择 NULL 保持 unconfigured，旧模板/提案不回填、不重解释，不运行批量修数。 |
| OpenAPI / snapshot | 是：新路由与独立 DTO、新字段/v7；不删除既有用例、不放宽旧断言，不盲更新全量快照。 |
| 并发 | 根事务与统一锁序覆盖目录激活/退役、选择、模板物化及审核；真实 PostgreSQL 竞态证明，不仅 mock。 |
| 兼容回退 | **v7 写入后不能直接回滚到只识别 v6 的旧二进制**。先停止新命令/新提案受理，保留能读 V3/v7 的兼容版本处理在途数据；无清库/删提案回退。新旧进程不得混合接收 v7。 |
| 外部与生产 | 不新增 AI/Redis/queue/cron，不开放 Integration，不启用 Readiness/Gate，不部署生产。部署与新格式切流必须另出兼容停止新写 SOP 并由维护者批准。 |

本稿不把业务 Gate-off 当成新目录/新 writer 自动不可达的证明：各新端点的上线、权限初始化和停止新写方式须在实施 handoff 中明确验证。B7 仍只控制 B6 创建链，不扩成新的总开关。

## 8. DoD、探针与验证队列（方案获批后才下发实施 goal）

| 顺序 | 未满足才做的探针 | 验收证据 |
|---|---|---|
| D2a-1 | 是否已有领域收据、五个权限中本步所需项和目录 writer | schema/seed/route 实际差异；不重复建表或插目录内容。 |
| D2a-2 | 定义/集可由 Human 完整建成并激活、退役 | HTTP 正反 E2E，五类值域、全量集项替换、hash复验、无越权、重复命令不多写、不多审计。 |
| D2a-3 | 不同 key 并发编辑/激活/退役是否守冻结 | expected hash冲突、DB正反例、真实锁等待；收据与审计失败时全事务回滚。 |
| D2b-1 | 三态与 FK 是否真实、旧活动是否保持原样 | 空库 replay、授权非空隔离库 rehearsal、NULL非法组合/伪 id-hash 反例；旧行除新默认列外逐项一致。 |
| D2b-2 | 人工建立 V3、活动选择和三种创建是否闭环 | 从空新目录经合法 Human 流程建定义→集→V3→活动；另测无模板专业创建、紧急 unconfigured、明确 not_required；不给fixture预灌正式业务结果代替流程。 |
| D2b-3 | 旧模板/Series/clone是否兼容 | V1/V2 hash与请求重放原样通过；V3精确复制；更新目录不改变旧实例；不拓宽组织Family或App身份。 |
| D2c-1 | v2–v6在途与v7能否并存 | 逐版本构建/解析/hash/apply回归，旧提案不清空选择；无敏感字段/完整URL；不存在孤立变更落库。 |
| D2c-2 | Readiness只按真实选择区分三态 | unconfigured/missing、not_required、不完整required、退役新选、合法历史解释，各自独立断言；其他blocker和Gate不变。 |
| D2c-3 | 授权/兼容/交接是否一致 | B7 off/shadow/active、App无member/禁用、目录无权、目标越组织、Admin非角色短路；OpenAPI/client/handoff和CI全量通过。 |
| C1收口 | 目录、模板、选择、v7、Readiness是否全部有正式入口和证据 | 三步PR、独立状态登记、迁移/权限实际签字、最终统一评审待办明确；没做完D2不进C2。 |

每步本地 quick + 定向 E2E/contract，PR CI 执行全量；不本地跑全仓 E2E。数据库仅使用当步再次核验并获批的隔离目标，重建命令与目标列清，不沿用 D1 的授权扩写任意库。改现有 service 编排前跑 characterization，既有行为断言需要改变时停下上报。

## 9. 写集和待授权项

### 9.1 本次 docs-only 已授权写集

仅四个文件：本评审新增；`docs/ai-harness/FROZEN_DRAFTS.md` 的 C1 状态、D2登记与派生读数；`docs/ai-harness/NEXT_TASKS.md` 的 P1-33；`prisma/CLAUDE.md` 当前 migration 摘要。历史 C1 冻结稿、其他台账项及 Prisma 历史长记不回改。本 PR 不新增代码、changelog fragment、schema、migration、seed、配置或测试。

### 9.2 实施写集预算，不构成授权

- 存储：`prisma/schema.prisma`、各步新 migration、`prisma/seed.ts` 及真实权限seed闭包；本稿收据、选择/FK范围，不改旧SQL。
- 指标目录/选择：activities 内新增具名命令/查询/Presenter/AuditRecorder及独立Admin/App Controller、DTO和测试；D1两份纯函数优先复用，不重定义校验合同。
- 模板：新增 `activity-template-definition-v3.ts` 与最小 Human V3 管理面；`activity-from-template.service.ts`、`activity-series.service.ts` 及实际 clone/创建调用链，只新增明确分支、不顺手拆god-service。
- 提案：`activity-publish-proposal-v2.service.ts` 的新版本分发、`activity-proposal-applier.ts`、`activity-publish-review-access.ts` 及实际 changeDiff/审核调用链；新增具名v7辅助模块，旧v2–v6语义不改。
- 就绪与访问：`activity-publish-readiness.service.ts`、`activity-access.service.ts` 和 managed入口的最小接线；不改变全局Guard、auth或既有判权模型。
- 权限/审计/契约：permission-catalog/seed事实闭包、audit事件及资源类型映射、ROUTE_AUTHZ/生成客户端/OpenAPI/contract，逐文件核验真实后果，不把本段当glob授权。
- 派生与交接：domain-map、state-machines及对应清单、counts/CODEMAP/RBAC_MAP生成物、3b/4b实际重签、当前台账、admin-web/miniapp与兼容停止新写SOP；具体路径在每步实现前列齐。

实施前必须提供每步**精确现有/新增文件列表、端点/DTO矩阵、错误码、权限/事件差值和隔离库目标**，再给 `harness:grant` 精确命令。新增后果路径先报告；AI 不自行发放令牌，不沿用旧理由执行新范围。

待维护者选择的是：是否批准方案 A 的三步完整范围，尤其五个新权限的默认不分配策略、not_required 的真人决定，以及本稿显式新增的最小全局模板 V3 Human 维护入口。**批准本评审方案仍不等于批准任意写集、每步合并、生产初始化或部署。**

## 10. 本次未做

未实施 D2a/b/c；未创建目录内容、模板、Activity选择、收据表、权限或审计事件；未改任何 API/DTO/v2–v6/Readiness/Gate；未调用外部模型；未执行数据库、生产部署或正式内容初始化。D1 已合入不等于 C1 整体完成。
