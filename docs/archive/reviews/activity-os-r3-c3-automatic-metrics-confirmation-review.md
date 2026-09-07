# Activity OS R3 / C3：自动指标与人工确认评审及授权清单

> 状态：2026-09-07，维护者已授权起草、验证、提交、推送和创建文档 PR，并已发放本文件精确新增授权。**方案 A 为推荐，尚未批准；implementation 未授权。** 本次为 A 档 docs-only，后续实现按 D 档。
>
> 调查基点：main `7f4fdbd7`，C2 D2 已随 [#1293](https://github.com/BA7IEE/srvf-nest-api/pull/1293) 合入；18 项 PR 检查、可信审批及 [main CI 34118403784](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34118403784) 均通过。整体跨模型复审仍待统一进行，不能用 CI 代替。
>
> 外部蓝图第十四章是需求材料，不是执行授权。以 [T0-A §7.3、§9、§11](activity-os-t0-terminal-review.md)、当前代码及维护者拍板为准。本稿不改变参与事实、时长／贡献真相链或任何 Gate。

## 1. 需要拍板

- 做什么：把系统可复算的指标作为有出处的成果候选，并让负责人明确确认完整成果修订；正式值具备来源、证据、规则版本、确认人与时间，后续更正不覆盖旧值。
- 不做会怎样：C2 只能记录人工草稿，不能交付正式成果；把现有统计页数字当成果，会混淆参与事实、已认定时长与实时投影。
- 最坏情况与回退：源数据过期、跨活动拼接或误把草稿当正式值污染后续报表。回退停新命令，不删除历史修订、证据、收据或 migration；旧 C2 manual 草稿接口继续维持原合同。
- 方案 A（推荐）：串行完成 C3-1「来源规则及可复现候选」、C3-2「完整人工确认与正式更正」，先冻结完整合同再分别列精确实施写集。C3-1 单独完成不算 C3 完成；必须两步均实现并验收。
- 方案 B：一个 D 档 PR 同时加入候选快照、确认命令、正式更正、存储约束和所有读面。终态相同，但失败面和回退面更难隔离，不推荐。
- 本次不实施承诺：只写第 9 节八份文档；不预占 migration、权限码或错误码，不修改 schema、测试断言、架构登记或生产配置。

## 2. 已核验事实与关键差距

| 证据 | 已有能力／不能直接沿用的原因 |
|---|---|
| `prisma/schema.prisma` 的 ActivityOutcomeRevision / ActivityMetricValueRevision / ActivityMetricValueEvidence | 已有精确指标集、revision/prior、来源及确认元数据；值与证据不可变。字段存在不代表已有正式确认 writer。 |
| `prisma/migrations/20260907103134_activity_os_r3_c2_outcome_value_revision/migration.sql` 的 child_immutable、chain_guard | 值和证据禁止 UPDATE/DELETE；确认字段成对、来源／规则非空已有形状检查，但不会证明必填集完整、证据齐全或合法生命周期。不能对旧 draft 值直接补 confirmedAt。 |
| `activity-outcome-policy.ts` 的 nextActivityOutcomeRevision | C2 仅 draft/published/completed/terminated 可新写，latest 必须是 draft；不创建／替代 confirmed。C3 不能悄悄放宽旧入口。 |
| 第 114 条 migration 的 ActivityOutcomeCommandReceipt | 操作仅 record_manual_outcome，安全结果固定 manual/draft；不能把 confirm/recalculate 塞入旧收据结果。新操作须独立收据设计与 additive migration 评审。 |
| `activity-metric-definition.ts`、`activity-metric-set-definition.ts` | 配置为闭集类型，集项带 required、精确定义 ID/hash；没有自动计算 binding。禁止往 V1 JSON 暗加字段、按标题／code 猜计算器。 |
| `activity-participation-query.service.ts` 的 participationSummary | 是展示读面，人数与时长可能来自不同既有链，含单独判权、非统一事务查询；不能将整个 DTO 无条件当作 C3 事实快照。 |
| `ledger-query.service.ts:435` 的 sumCommittedByMemberForActivities | 支持调用方 client，固定 committed join；是已认定时长聚合，不等于实际参与区间，返回聚合本身也不构成足以复现的来源清单。 |
| `activity-outcome-access.service.ts`、attachments trusted facade | 当前 Human App 身份、显式权限、活动责任、组织范围和附件同链已有接缝；新权限与锁后校验不能用旧 read/record 隐式代替。 |
| `harness/domain-map.json` 的 Authz 精确查询登记；#1293 两项 CI 修复 | 属主调用仍可能触发依赖方向检查。实施计划必须同时核验查询归属、import 方向和精确登记，不先写再要求放宽基线。 |

## 3. 自动指标：口径先于计算

### 3.1 规则、绑定与候选事实

推荐建立受控、不可变的规则版本与精确绑定：metricDefinitionId + definitionHash、输入事实种类、单位／精度、evaluatorVersion、取数口径。规则只允许代码实现的闭集，不接任意 SQL、表达式、脚本、AI 模型调用；不重写 C1 V1 定义或活动历史指标选择。

候选不是实时数字缓存：必须保留可重放的来源快照身份／摘要、规则版本、目标 Activity、精确指标集、计算时点和候选值。绑定与快照采用新存储还是已有不可变事实清单组合，由 C3-1 精确计划比较后拍板；不得只存一个 hash，却丢掉复算需要的事实。

首批必须覆盖蓝图要求的「系统可算人数和时长」，但下列三种量不允许互相顶替：

| 量 | 推荐口径及验收要求 |
|---|---|
| 实际参与人数 | 基于正式参与事实的 Member 去重，跨场次／岗位同人不重复；报名通过、候补、未到场不等于实际参与，临时参加不能漏。具体有效参与段／修订筛选交给事实属主导出的查询，实施前锁定引用链和反例。 |
| 实际参与时长 | 消费既有 ParticipantServiceSegmentRevision 的有效事实，按人去重重叠区间后求和；不新增第二套参与段，不以 serviceHours 代替。区间并集、撤销／更正、跨日及单位换算规则必须版本化；与 Release 4 中性 Facade 对齐，缺安全属主入口则列精确扩展，不跳过该指标宣告完成。 |
| 已认定服务时长（独立可选指标） | 仅在明示的来源规则中使用 approved 历史链或 committed ledger 现行链；来源按现有 Gate 决定，不合并两链、不擅开闸。正式值固定当次来源版本，不随后来 Gate 切换被重算覆盖；冲回／更正按账本净额语义处理。它不替代前两项必交付指标。 |

表中“实际参与”是目标合同，不声称当前展示查询已实现全部口径。候选取数必须通过属主、同一一致快照或可证明的版本围栏；仅锁 Activity 不能假定所有参与、审核、账本 writer 都被锁住。C3-1 必须逐条证明相关 writer 的锁／版本协议，无法证明时不得把结果标为可确认。

有效空事实集可以计算为零，但先证明来源可用且范围正确；未迁移、缺引用、来源不可解释、读取失败不是零。超过已批准有界规模显式失败，不截断取数；沿 30/500/2000 档验证，10000 档不自动解锁。

### 3.2 重算、过期与来源保留

1. Calculate 候选是 Human 发起的确定性命令，sourceCode=system 仅表示值由受控规则算出，不授予后台 SYSTEM 身份，不新增 cron、queue 或自动写入循环。
2. 同 key 同请求重放原候选；异请求冲突。请求绑定活动、指标集、预期修订和规则版本；来源由服务端读取，客户端不能上传伪造系统值。
3. 新计算产生新候选／revision，不覆盖旧值。确认时重查来源版本／摘要与精确引用；已变则 stale，要求重新计算并由人重新确认，禁止静默替换为新值。
4. 取数失败保留旧草稿和现行正式成果。人工可改用 manual 输入，但必须明确改变来源并保留新证据，不把手填数字继续标为 system。
5. 来源参考为受控内部标识，不是原始名单、URL、凭证或自由备注；复算需要的敏感事实留在其属主的授权面，不复制进普通 Outcome DTO 或 Audit。

## 4. 人工确认与正式更正

### 4.1 以新修订确认，不修改旧值

推荐 Confirm 命令绑定目标 draft／候选 ID、expectedLatestRevision、精确集 id/hash 及来源快照版本。服务端复制已验证的完整值和证据，创建新的 confirmed Outcome revision；新值写入当前确认人、服务端时间、受控 sourceReference 和 calculatedByRuleVersion。旧 draft 只转 superseded，其值、证据、创建事实和命令重放结果保持不变。

新正式修订必须包含精确集的每个 required 项，允许缺省 optional 项；每个实际纳入的正式值都必须通过 C1/C2 值校验，具备来源、规则版本、确认人／时间、至少一条同活动且可用的附件证据。系统自动计算也不免证据要求；来源快照不自动等价于附件，除非另行批准受控附件生成合同。无 required 项也不能以空成果绕过确认：至少一个有效值。

不能直接复用 C2 的结果 DTO／收据冒充确认成功。确认的安全回执只保留锚点、revision、createdStatus、数量和时间；必须区分“当时创建为 confirmed”与“现在是否仍为有效正式版本”。

### 4.2 正式结果更正

- 初次确认前 latest draft 是唯一可编辑候选；已有 confirmed 后的编辑必须走 C3 专门的更正草稿命令，不放宽 C2 record_manual_outcome 的 frozen 行为。
- 更正草稿 pending 期间，原 confirmed 继续作为现行正式成果；不得创建草稿即把正式成果降级。确认新更正时同事务让旧正式头转 superseded、新头成为 confirmed，历史值始终保留。
- expectedLatestRevision 与 expectedConfirmedRevision 双锚点避免并发更正覆盖；更正草稿可追加，但一个活动最多一份现行 confirmed。取消草稿不删除事实，具体可表达状态在 C3-2 migration／状态机计划内明确，不能临时新增状态码。
- C2 历史列表与明细继续按自身指标集解释，不把最大的 revision 自动当“当前正式值”。新读字段／正式选择器须独立契约评审；C4/C5 以后消费该选择器，不自造 max(revision) 逻辑。

### 4.3 活动状态与权限（候选方案，待批准）

| 动作 | 推荐状态／访问面 |
|---|---|
| 计算候选、准备人工草稿 | draft/published/completed/terminated；沿 Human App managed，当前身份＋显式权限＋组织范围＋draft initiator／非 draft owner。 |
| 确认、正式更正 | completed/terminated；只允许当前负责人且具显式确认权限。published 阶段的分期正式成果若需要，另行拍板，不从草稿权限推导。 |
| 历史只读 | 保留 C2 当前授权矩阵，含有权归档历史；cancelled/archived 不允许新确认，更正前如需撤销归档沿既有独立流程。 |

候选权限为 calculate、confirm、correct 三种动作，是否精确拆码由实现计划判定；默认不分配内建角色、无角色直通、SP/Delegated 禁止。确认者可为录入者：本稿推荐负责人单人明确确认，不擅自引入双人审批；如业务要职责分离，必须在方案拍板时确定并补相应测试。

## 5. 事务、审计及收据

根事务按已验证锁序：命令键 → Activity → 来源／指标引用 → 附件引用；新增来源锁必须与参与／结算 writer 对照避免逆序。每次等待后复验当前身份、显式权限、组织资格、负责人、目标版本和状态；重放也重新验当前访问权，但返回原创建事实，不执行新命令。

确认写入、旧头状态变化、值／证据、命令收据和最小审计必须同事务，任一失败整笔回滚。两个连接池证明同键竞争、不同键竞争、源修订竞争、撤权、负责人变化、附件删除和审计失败，不能用 mock 证明锁后安全。

新操作优先设计独立精确收据，保留第 114 条收据及原重放协议；编号、表名和结果闭集在实施时确定。不改旧 SQL。若新增 DB 生命周期／唯一现行 confirmed／证据完整性约束，必须 additive migration 并对非空历史 draft/superseded、现有收据逐字保留；检查现存数据再约束，不默认可回填。

审计可沿既有 outcome 事件增加封闭 operation，或增加最小事件；必须核对消费者与 registry，实际增量决定 4b 是否重签。日志只含资源锚、操作、状态、来源类别、数量，不记录实际值、名单、操作键、原始来源快照、Prompt、附件 key 或签名 URL。

## 6. AI、敏感数据及禁止域

AI 候选的人工确认语义归本节约束，但 C3 不引入 AI Provider／Assist 模块。未来 Release 7 的建议需有可验证来源，再进入与人工相同的显式确认流程，才可标 ai_suggested_confirmed；当前没有可信建议入口时该来源保持不可写，不能接客户端自报字符串。import 仍须独立 importer 方案。

首批继续拒绝 short_text 和新增敏感指标；证据敏感性不因“只存附件 ID”而消失。用途：仅证明指定指标值；查看：显式获权负责人及既有附件受控访问；普通列表不暴露确认人身份或来源明细。保存期限、退队清理与附件保留冲突尚需业务逐项定案，未定案的敏感证据不得启用，不能虚构保留年限。现有证据不因本稿获删除／导出授权。

不修改 C1 定义／选择或 v2–v7 历史快照，不把成果确认接到发布、报名、考勤、时长入账、贡献、Incident 关闭或归档硬门。C4 结束工作台、C5 报表 DTO 各自另立；成果缺失不能反推没有参与事实，也不能伪造参与记录。

## 7. 实施拆分与验收门

| 步骤 | 必交付 | 进入下一步的证据 |
|---|---|---|
| C3-1 | 来源口径、精确规则绑定、可复现候选、系统人数与实际参与时长、幂等及有界取数 | 逐源引用链／锁围栏、零值反例、多人多场次去重、重叠区间并集、跨日精度、源更正后 stale、无 AI 完整运行；不是只有解析器或人工 fallback。 |
| C3-2 | manual/system 完整人工确认、正式更正、当前正式选择器、收据／审计／附件原子性与安全读面 | required 缺失和每值缺证据拒绝、旧值不可改、并发至多一个 confirmed、旧正式保留到新确认、旧 C2 重放和行为不变。 |

每步独立精确计划：DoD、探针、授权清单、禁止域、写集五要素齐全。公共依赖、旧测试和生成物后果必须开工前一次性扫描；不能用“计数适配”预授权改变历史行为。本次不预先允许所有候选模块。

最低验收还包括：

1. 无 AI Key／外部网络不可用仍能计算和人工确认；没有模型调用进入核心事务。
2. sourceReference／ruleVersion／valueHash／集 hash 任一篡改或跨活动引用均拒绝，报错不泄露无权资源存在性。
3. 撤权、用户／成员失效、组织失效、owner 变化、附件删除意图在锁等待后发生时，写入拒绝且无部分结果；重放权限当前有效。
4. 正式值确认 metadata／证据／required 与同链完整性在实际 PostgreSQL 验证，不把 schema 字段存在当保障；source snapshot 不可复算则不通过。
5. 未生效账本永远不计入已认定量；Gate 前后不混算；参与人数／实际时间与认定时间分别有反例，改成果不改变任何参与／结算表。
6. 新 migration 在获批隔离库冷回放与非空升级通过；不改旧 SQL、不自动 migrate dev/reset/db push。app_test/w1/w98 的未来使用仍须当次明确授权，本次不使用数据库。
7. 本地 quick＋定向 E2E、contract、build、架构新增债／引用方向、派生文档与全部 PR CI 通过；跨模型整体复审按维护者要求后置，不能写成已通过。

C3 完成判据是两步全部达成，不是“候选可看”“manual 能录”或“已有 confirmed 列”。生产与 Gate 另行验收，C3 代码完成不代表整份 Activity OS 蓝图完成。

## 8. 待决策与授权清单

- 先确认方案 A 的完整范围：系统人数／实际参与时间、来源可复现、完整新修订确认、正式更正、当前正式选择器，以及上述状态／权限／证据边界。
- C3-1 精确计划必须决定来源规则和绑定存储、输入事实保留与失效协议、属主 tx 接口和依赖方向、命令端点／DTO／错误及收据；数据模型确有缺口才新增，不凭本稿预占第 115 条 migration。
- C3-2 精确计划必须决定 confirmed 唯一性／生命周期约束、单人确认或职责分离、实际权限／审计增量、安全读字段与证据留存。未决定不得进入实施。
- 正式目录内容、AI／import、前端发布、生产、Gate、物理删除及跨域白名单扩展均不包含在本次拍板；每项实际需要时一次性列风险和精确路径。
- 评审 PR 合并、后续每步 implementation 与测试库使用、3b/4b 重签、可信审批、实施 PR 合并分别按实际对象确认，不让历史批准自动继承。

## 9. 本次精确八份文档写集

1. `docs/ai-harness/FROZEN_DRAFTS.md`：C2 D2 landed 事实、整体复审未完成、C3 open 登记及派生读数。
2. `docs/ai-harness/NEXT_TASKS.md`：P1-33 当前状态与 C3 顺序。
3. `src/modules/activities/CLAUDE.md`：仅 C2 已合入当前摘要。
4. `prisma/CLAUDE.md`：仅 114 migration 已合入摘要，不改历史长记。
5. `docs/ai-harness/STATE_MACHINE_INVENTORY.md`：C2 当前交付事实，不升 governed。
6. `docs/handoff/miniapp.md`：C2 已交付但未部署，C3 未实施。
7. `docs/archive/reviews/activity-os-r3-c3-automatic-metrics-confirmation-review.md`：仅新增本稿，不回改其他冻结稿。
8. `changelog.d/activity-os-r3-c3-review.md`：本次 docs-only 记录。

## 10. 本次未做

未实施 C3-1/C3-2、未新建模型或 migration、未改测试断言／生产代码／权限／审计／API／DTO／架构白名单；未操作数据库、运行外部模型、初始化指标、部署、合并或启用 Gate。C2 历史 500 根因未定位，整体跨模型复审未完成。
