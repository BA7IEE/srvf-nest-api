# Activity OS C3-1 精确实施计划：可复现的系统指标候选

> **当前授权（2026-09-08，覆盖下方起草时点的“仅文档／待批准”状态）**：维护者已确认 C3-1 完整方案 A，按本计划实施；允许 app_test_w98 隔离验证与重建；验证通过后提交、推送并创建 PR，包含本轮文档。§7.5 八项精确文件授权已核验存在。不得合并、操作生产、启用 Gate 或删除业务数据；禁止自动 migrate dev/reset/db push。3b／4b 仍按实际结果另行重签。本稿保留起草证据，不把历史措辞当作重复审批要求；实现及 P01–P17 验收尚未完成。

> 2026-09-08，调查基点 main `638fc784`（#1296）。本稿是工作草稿，不是冻结合同或实施授权。
> 本轮维护者仅授权四份台账更正及起草本计划；不提交、推送、开 PR、操作数据库或实施。
> 最新决定：维护者明确“不删除”，将数据视为长期资产。候选、计算明细及规则版本长期保留并支持历史复算；撤回此前三年到期清理方案。本轮仍仅文档，不实施、不提交、不操作数据库。

> 上位合同：[T0-A §7.3](../archive/reviews/activity-os-t0-terminal-review.md)、[C3 方案 A](../archive/reviews/activity-os-r3-c3-automatic-metrics-confirmation-review.md)。C3 方案 A 已随 #1294 获批；历史评审稿的“尚未批准”是冻结时点记录，不回改。

## 1. 目标与完成边界

C3-1 必须完整交付“受控规则 → 精确绑定 → 读取来源 → 计算并保留可复现候选 → 历史读取与过期判定”。实际参与人数与实际参与时长都要能算，不能用只有解析器、人工兜底或已认定 serviceHours 代替。

C3-2 才实现完整成果确认、正式更正与现行 confirmed 选择器。C3-1 不产生 confirmed，也不改变 C2 manual 草稿写入、旧收据和历史读取。C3-1 完成不等于 C3、Release 3 或 Activity OS 完成。

前置修复 #1296 已合并，暂存段不再占用正式段唯一键。PR CI 全过；[main CI 34186995204](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34186995204) 已核验 completed/success。3b 115 已签，未来 migration 如有新增仍须重新批准和重签。

## 2. 已查证的接缝与证据

| 证据路径／符号 | 当前事实与本稿约束 |
|---|---|
| `src/modules/activities/activity-outcome.service.ts` / `record` | 命令锁、Activity 锁、指标引用锁、附件边界后重验资格；仅 manual 草稿。新候选不塞进此入口。 |
| `activity-outcome-access.service.ts` / `authorize` | 用户与成员当前有效、显式组织授权、组织有效、draft initiator／其他状态 owner；不是 SUPER_ADMIN 直通。新动作扩展此公共校验，不重复造权限逻辑。 |
| `controllers/app-managed-activity-outcomes.controller.ts` | 当前仅人工写、列表、明细三接口，旧 DTO 与收据语义保持不变。 |
| `activity-participation-metrics.ts` / `buildActivityParticipationMetrics` | 展示统计的到场来自记录，时长来自 approved sheet；不是服务段区间并集，不可直接复用为自动成果。 |
| `prisma/schema.prisma` / `ActivityParticipationIdentity` | 含 activity/session/member 及当前参与状态；不能按报名行数计人数，也不能因成员退队删除历史参与事实。 |
| `ParticipantServiceSegmentRevision` | draft/committed/superseded；valid/early_departure_zero/voided/replaced；checkOutAt 可空，serviceHours 可空。每个筛选条件都需要业务选择与反例。 |
| `src/modules/attendances/attendance-punch-segment-revision.service.ts` / `rebuild` | 原段 superseded，再建 draft；新打卡写受现有 Gate 约束。 |
| `settlement-draft.service.ts` / `persistSegments` | 结算重投影也是段 writer；仅枚举打卡服务不构成来源闭包。 |
| `ledger-posting.service.ts` / `commitBatchProtocol` | 根 Activity 锁后，将活动 draft 段转 committed，并填 effectiveBatchId。 |
| `correction-application.service.ts` | prepare 仅待提交区；commit 在根锁后替换正式段。候选不得读 CorrectionPendingSegmentRevision。 |
| `src/modules/permissions/permission-catalog.ts` | 当前 outcome.record/read 显式人类动作；新增动作须登记元数据、eligibility 与引用，不自动赋给内建角色。 |

上表来自源码阅读，不是运行验证结论。符号所在文件以仓库当前版本为准；不得用同名 grep 命中代替调用链证明。

## 3. 建议冻结的计算合同（待维护者批准）

### 3.1 两条必交付规则

规则采用代码闭集与不可变 evaluatorVersion，不允许 SQL／表达式／脚本上传。首批绑定既有 `non_negative_integer`／`non_negative_decimal`，不是新增 `numeric` 类型；规则内部 count/hours 不冒充 C1 单位枚举，精确映射见 §3.4。不改 C1 V1 定义 JSON。

| 规则 | 输入与计算 | 必须拒绝或排除 |
|---|---|---|
| `actual_participant_count_v1` | 同活动正式段表当前非 superseded 修订，result 为 valid 或 early_departure_zero；每段须有合法闭合区间，按 identity 所属 member 去重，跨岗位／场次不重复。 | voided/replaced、暂存段排除；报名通过／候补不构成到场；开放段见下文。 |
| `actual_participation_hours_v1` | 同一来源集合，按 member 合并重叠和首尾相接的半开区间 `[checkInAt, checkOutAt)`；先求整数毫秒总和，最后一次转小时，Decimal 按绑定精度 HALF_UP 舍入。 | 不用 serviceHours、不按区间逐次舍入、不混入 contribution、不重复计算重叠分钟。 |

**待拍板口径**：early_departure_zero 仍有真实参与区间，即使认定服务时长为零也计实际人数／实际时间；draft 与 committed 仅代表结算生效阶段，不据此删除实际发生的有效区间。开放段不补“现在”作结束时间、不默认为零：本次 calculate 返回 `source_incomplete`，不生成候选。负区间、缺 member／session 同链引用、重复当前修订均拒绝。零长度闭合段建议不计人数／时间，但需要独立反例确认。

跨日按 UTC instant 差计算，不按日截断，不叠加时区／DST 偏移；显示时区与计算分离。历史来源的当前 member ACTIVE 不是参与事实有效条件，**调用者资格**则始终当前复验。

### 3.2 来源可用、零值与 Gate

来源提供者必须先证明活动存在、来源模式为服务段链、相关 session/identity 链完整、无开放／异常段，再声明 `available`。available 且有效集合为空才可返回 0。读取失败、未建立来源、旧链只有 serviceHours、Gate 关闭均返回 unavailable，不生成伪零。

本稿建议服务段来源仅在既有 V11 Gate 已由维护者按独立 SOP 开启的实例提供；本实施不打开 Gate。旧链没有足够区间时不猜实际时长。该选择意味着 Gate 关闭时 system calculate 明确不可用，manual 不受影响；必须由维护者认可此产品边界，不能以它冒充“两种指标在旧链已可用”。

已认定服务时长是 C3 评审允许的独立可选指标，本批不增加该第三规则。未来若纳入，必须明示旧 approved 与新 committed ledger 的选择及冲回净额，不替代本批两条规则。

### 3.3 有界规模

建议每命令一活动、最多 100 个绑定、2000 名参与成员、10000 个当前段；逐类多取一条检测越界，显式拒绝，禁止截断结果。10000 个段不是解锁万人档。探针沿已批准 30/500/2000 人档，额外检验边界外一条。上述新增段数预算仍待批准与查询计划验证，不把建议数当现有合同。

#### 来源事件预算的纯计算测量（非数据库性能结论）

2026-09-08 经 `pnpm exec tsx` 直接执行既有 rebuildServiceSegments：每人 10 个交替签到／签退事件、5 个合法闭合段，分别测得 30 人／300 事件／150 段 0.51ms，500 人／5000 事件／2500 段 3.08ms，2000 人／20000 事件／10000 段 6.02ms；逐人断言无异常，总段数正确。另测单身份连续 void 操作链深度 100/500/1000，实际事件 101/501/1001，耗时 0.67/3.04/13.22ms，均输出一段、无链异常。均为单次本地合成输入，无数据库、网络、候选持久化或并发，不是延迟承诺或最坏复杂度证明。

据此提出待整体批准的事件输入预算：单活动最多 20000 事件、单 identity 最多 1000 事件；均按预算+1 检出后拒绝，不丢历史、不截断。该上限仅控制一次同步计算，不删除超额事实，也不禁止既有打卡操作。覆盖 2000 人每人五段的上述基准，不代表每个 2000 人活动都必然不超预算；大量历史更正可能明确报超限，届时需要独立规模方案，不能返回少算的成功结果。

属主入口先有界取活动事件，再按身份检查局部上限，使用完整事件链才调用 projector；单身份超限不自动拆链。未来 P12 需加入活动 20000/20001、身份 1000/1001、替换／作废密集链以及真实数据库查询计划、事务等待和端到端预算。上述两个新事件限额与 §3.3 段数／绑定上限一起评审，不把本轮测量当批准。

### 3.4 C1 类型、单位与 C2 canonical 值接缝

源码核验：`activity-metric-definition.ts:5–11/125–141` 定义整数和小数两种数值配置，字段是 `configuration.unit` 自由文本，不是 unitCode；仅小数配置有 scale（0–6）。`activity-outcome-value.ts` 对值校验精确定义 hash、类型、范围及规范格式，小数字符串禁止多余尾零，整数不是字符串。因而不能把“数值指标”写成既有 `numeric` 判别值，也不能直接输出 Decimal.toFixed(scale) 给旧解析器。

建议绑定合同：人数规则仅绑定 `non_negative_integer`，内部 scale 固定为 0；时长规则仅绑定 `non_negative_decimal`，scale 取精确定义。binding 保存的 unitCode 是**新规则内部维度**，不是向旧 definition JSON 增加字段。人数单位文本建议仅精确接受 `人`，时长仅精确接受 `小时`；这是待批准的绑定准入闭集，不据名称猜单位，不把 `次`、`分钟`、`千克` 转换或当同义词。若需其他语言／显示单位，由业务明确追加映射后另版绑定合同，不改历史定义或 hash。

聚合后一次 HALF_UP，再转普通十进制、去多余小数尾零／孤立小数点，零规范为 `"0"`，不使用指数记法。人数结果仍为 JSON number。最终一律调用既有 `fingerprintActivityOutcomeValue`（`activity-outcome-value.ts:10`），不得复制放宽版解析器；超出目标 definition.minimum/maximum 或精度时整命令拒绝、不裁剪值、不改变定义、不留下部分候选。若精确定义的 minimum 大于零，来源真零仍计算为零，但不能保存为违反定义的成功候选；应明确报告取值越界，不能反写成来源不可用。

新增纯函数探针至少覆盖：整数 0/1/上界及上界+1；小时结果 `1.00 → "1"`、`0.00 → "0"`；半舍入边界；scale=0/6；中文单位不匹配；目标 minimum>0 的真零；definitionHash 错配。已有 C1/C2 parser 与测试保持不动，新增规则测试验证对既有解析器的兼容。

#### 纯函数兼容性实测记录

2026-09-08 在 main `638fc784` 的现有源码上，以 `pnpm exec tsx` 标准输入脚本直接调用 `fingerprintActivityMetricDefinition` 和 `fingerprintActivityOutcomeValue`，使用 node:assert/strict 验证 **14 项断言通过**，退出码 0。未写入测试文件、未连接数据库、未改生产代码。

通过的具体输入：人数 0/1/2000 接受，字符串 `"1"`、2001、负零拒绝；小时 scale=2 时 `"0"`、`"1"`、`"1.25"` 接受，`"0.00"`、`"1.00"`、`"1.001"` 拒绝；minimum=`"0.1"` 时真零拒绝；相同定义／值重复调用 valueHash 相等。这支持 §3.4 的类型和规范化接缝，**不证明尚未实现的 C3 区间并集、舍入函数、权限、持久化或并发正确**。未来仍须将 C3 专属行为写成持久测试并跑完整验收。

## 4. 规则、绑定、来源与候选存储（建议方案 A）

选择“代码规则版本 + 独立不可变绑定 + 独立候选事实”，不修改 C1 定义／集版本。§7.4 已提出精确 migration 候选路径用于评审；不创建空迁移占位，不预签序号。

1. `ActivityMetricRuleBinding`：id、schemaVersion、metricDefinitionId/hash、ruleCode、evaluatorVersion、ruleDigest、unitCode、scale、bindingHash、createdAt/createdByUserId。完整元组唯一；绑定只创建／读取，不 UPDATE/DELETE。规则变更必须新版本，旧 evaluator 保留以复算。
2. `ActivityMetricCandidate`：id、activityId、candidateRevision、priorCandidateId、metricSetVersionId/hash、预期 Outcome revision、来源模式与 providerVersion、sourceDigest、bindingsDigest、createdAt/createdByUserId。唯一 activity/candidateRevision；不沿用 Outcome revision 编号，也不宣称 candidate 是正式成果。
3. `ActivityMetricCandidateValue`：candidateId、bindingId、definitionId/hash、canonical value/hash；同候选同指标唯一，与候选集项、绑定精确定义组成同链约束。
4. `ActivityMetricCandidateSource`：candidateId、ordinal、内部源 revision/identity/session 标识、member 分组序号、原区间 instant、resultCode、源指纹。只保存两规则复算必需的最小事实；不保存姓名、手机、自由备注、附件凭证、source URL。
5. `ActivityMetricCandidateCommandReceipt`：actor/operation/key 唯一、requestHash、activity/candidate 锚、安全 resultJson、createdAt；与候选及审计同事务，不更改第 114 条旧收据。
6. `ActivityMetricRuleBindingCommandReceipt`：独立绑定命令收据，actor/operation/key 唯一、requestHash、bindingId、安全 resultJson、createdAt；不扩写既有 `ActivityMetricCommandReceipt` 操作闭集。

候选保留完整输入、精确规则版本及历史值以长期复算，不只留 hash。来源属于受控参与数据，即使分组序号是伪名也不声称匿名。**敏感字段三问**：用途为历史核验／复算／审计；仅事实属主授权内部通路查看，普通 Outcome DTO 与 Audit 不暴露明细；按维护者“不删除”决定长期保留，退队撤销访问不删除参与历史。本批无到期删除机制。该产品决定不等于法律结论，适用要求仍须上线前独立核对，不据此自行删数据。

数据库约束要证明 activity/set/definition/binding/candidate 同链、不可变、唯一和收据安全结果闭集；不能仅依赖 Service 检查。精确引用键、字段类型、payload 上限、28 个 SQL 拟用名称和 13 个触发器挂载已在本节展开；本稿待整体评审，不授权 schema。

方案 B：仅保留源 ID/hash，复算时读取原段。当前未证明所有原字段不可变及可永久读取，因此不采用 B；不得为了减少表把不可复算快照包装成完整成果候选。

### 4.1 键与同链合同补稿（待批准，未落 schema）

当前代码证据：ActivityMetricSetVersion 已有 `(id, definitionHash)` 唯一键；ActivityMetricSetItem 已有 `(setVersionId, metricDefinitionId)`；ActivityMetricDefinition 当前没有 `(id, definitionHash)` 复合唯一键。不能在方案中把最后一项写成“直接复用既有 FK”。

建议 additive migration 为定义增加 `(id, definitionHash)` 唯一引用锚；绑定只允许指向经目录属主验证的 active 整数／小数定义（精确 kindCode 及单位见 §3.4），保存当时 hash，读取旧绑定不要求定义现在仍 active。定义退役不改变历史解释，新绑定拒绝退役定义。

状态机已补证：`activity-metric-state-machine.ts` 仅允许 draft 更新／激活及 active 退役，并校验 expectedHash；`activity-metric-definition.service.ts` 对既有定义先 FOR UPDATE，等待后重新授权再读取当前定义。第 110 migration `20260905160133_activity_os_r3_c1_metric_definition_set/migration.sql:107–115` 限制生命周期转换并冻结非 draft 内容。因此新绑定须使用同一行锁协议，锁后验证 active 与精确 hash；FK 仅证明引用，不能代替状态验证。绑定先成功再退役时历史绑定保留；退役先成功时新绑定拒绝。这两种交错需新增测试，不改旧状态机或旧 migration。

| 新行 | 引用键／唯一性建议 | 附加约束 |
|---|---|---|
| Binding | `(metricDefinitionId, definitionHash)` → Definition 新引用锚；bindingHash 唯一；另 `(id, metricDefinitionId, definitionHash)` 唯一 | ruleCode/version/digest 对应固定 manifest；unit/scale 必须经 C1 定义校验；数据不可改删。 |
| Candidate | `(metricSetVersionId, metricSetDefinitionHash)` → Set；`(priorCandidateId, activityId)` → 同活动 Candidate；唯一 `(activityId, candidateRevision)`；分别提供 `(id, activityId)`、`(id, activityId, metricSetVersionId)` 引用锚 | prior 为空仅 revision=1；非空 priorRevision+1，expectedOutcomeRevision≥0；创建时的数量字段与子行对账。 |
| CandidateValue | 冗余 activityId、setVersionId、definitionId/hash，分别 FK 到 Candidate 三元锚、SetItem 双元锚、Binding 三元锚；唯一 candidate/definition | 不能各自只引用合法 ID 却拼出跨活动／跨集值；valueHash 使用 C2 value fingerprint，类型不另造。 |
| CandidateSource | 冗余 activityId，FK 到 Candidate `(id,activityId)`；ordinal≥0，唯一 candidate/ordinal 与 candidate/sourceRevisionId | source revision → identity → activity/session 的链需现有复合键或 insert trigger 同 tx 验证。没有对应复合键时不得编造已闭合 FK；快照原字段与当时来源逐字段一致。 |
| CandidateReceipt | actor FK User；`(candidateId,activityId)` → Candidate；唯一 actor/operation/key | operation 仅 calculate_metric_candidate；result 锚、revision、数量、createdAt 与候选一致，不允许多余字段。 |
| BindingReceipt | actor FK User，bindingId FK Binding；唯一 actor/operation/key | operation 仅 create_metric_rule_binding；result 精确 id/hash/definition/ruleVersion，不含参与事实。 |

所有新 FK 建议 ON DELETE/UPDATE RESTRICT；历史 UPDATE status 的来源关系不能因此被错误禁止。source 输入快照保留不应绑死允许的源状态切换：状态是否参与引用键必须排除，生命周期通过来源查询语义体现。

数量合同建议在 Candidate 固定 valueCount/sourceCount，提交时 deferred constraint trigger 核对子行数、ordinal 连续性及唯一指标；候选、值、来源、绑定及命令收据均不可 UPDATE/DELETE。来源数量始终与生成时相符，不设置清理收据豁免。零来源候选须有 value 行且来源可用证明，不能因 sourceCount=0 省略完整性验证。数据库负责结构／同链，真实复算探针负责 digest 和值相等。

#### 来源 FK 收敛补充

已核实 `ActivityParticipationIdentity` 存在 `(id,activityId,sessionId)` 唯一键（schema 4688 附近），因此 Source 的 `(identityId,activityId,sessionId)` 可直接复用此引用锚，不新增 memberId 副本。`ParticipantServiceSegmentRevision` 当前没有 `(id,participationIdentityId)` 唯一键；建议 additive 增加精确引用锚 `metric_source_segment_identity_key`，Source 的 `(sourceRevisionId,identityId)` 引用它。新索引只为证明所属身份，不增加当前段业务唯一性，不改历史索引。

以上 FK 加上 Source→Candidate 的 `(candidateId,activityId)`，可证明“段属于该身份，该身份属于同活动场次，候选属于同活动”。member 分组序号与当时 identity.memberId 的对应、输入区间是否与源行一致仍需创建时同事务校验；不能由 FK 推导出其余字段相等。此设计不把 mutable status 放入外键，不阻碍 draft→committed→superseded。来源载荷删除是 FK 子行删除，不级联到原段／identity。

拟新增 FK 显式名称：`metric_candidate_source_candidate_fk`、`metric_candidate_source_identity_fk`、`metric_candidate_source_segment_fk`；所有名称需在最终 migration 中与 Prisma map 一致，并核验 PostgreSQL 名称长度和全库冲突。这里是计划中的名字，不代表已创建。若历史数据允许修改 identity 的活动／场次锚，新 FK 将收紧该能力，须先用实际 writer 与旧测试证明兼容，不能只凭没有直接 update 命中就批准。

#### 新约束命名与执行责任表（静态核验通过，未创建）

以下 28 个拟用名称已核对：彼此不重复、UTF-8 字节数均不超过 63，且在当前 schema 与全部 migration SQL 中无同名字符串。这是仓内静态证据，不代表真实数据库无额外对象；实施迁移前仍须在获批库核验。名称定稿不能代替 SQL 行为测试。

| 拟用 SQL 名称 | 责任 |
|---|---|
| `metric_definition_id_hash_key` | Definition(id,definitionHash) 引用 unique |
| `metric_source_segment_identity_key` | Segment(id,participationIdentityId) 引用 unique |
| `metric_rule_binding_hash_key` | Binding(bindingHash) unique |
| `metric_rule_binding_definition_key` | Binding(id,metricDefinitionId,definitionHash) 引用 unique |
| `metric_rule_binding_definition_fk` | Binding 精确定义 FK |
| `metric_candidate_revision_key` | Candidate(activityId,candidateRevision) unique |
| `metric_candidate_activity_key` | Candidate(id,activityId) 引用 unique |
| `metric_candidate_chain_key` | Candidate(id,activityId,metricSetVersionId) 引用 unique |
| `metric_candidate_set_fk` | Candidate 精确 set/hash FK |
| `metric_candidate_prior_fk` | Candidate 同活动前驱 FK |
| `metric_candidate_value_definition_key` | Value(candidateId,definitionId) unique |
| `metric_candidate_value_candidate_fk` | Value 到 Candidate 三元 FK |
| `metric_candidate_value_set_item_fk` | Value 到 SetItem 双元 FK |
| `metric_candidate_value_binding_fk` | Value 到 Binding 三元 FK |
| `metric_candidate_source_ordinal_key` | Source(candidateId,ordinal) unique |
| `metric_candidate_source_revision_key` | Source(candidateId,sourceRevisionId) unique |
| `metric_candidate_source_candidate_fk` | Source 到 Candidate 同活动 FK |
| `metric_candidate_source_identity_fk` | Source 到 identity 同活动场次 FK |
| `metric_candidate_source_segment_fk` | Source 到 segment 同 identity FK |
| `metric_candidate_receipt_operation_key` | CandidateReceipt(actorId,operation,operationKey) unique |
| `metric_candidate_receipt_candidate_fk` | CandidateReceipt 到 Candidate 同活动 FK |
| `metric_binding_receipt_operation_key` | BindingReceipt(actorId,operation,operationKey) unique |
| `metric_binding_receipt_binding_fk` | BindingReceipt 到 Binding FK |
| `metric_candidate_fact_immutable` | 六表通用 UPDATE/DELETE 拒绝函数 |
| `metric_candidate_aggregate_complete` | 候选值／来源数量及连续序号的延迟核验函数 |
| `metric_candidate_source_snapshot_check` | 来源快照插入时与真实输入的一致性函数 |
| `metric_candidate_receipt_shape_check` | 候选安全收据闭集与锚点核验函数 |
| `metric_binding_receipt_shape_check` | 绑定安全收据闭集与锚点核验函数 |

额外约束要求：revision 为正整数；expectedOutcomeRevision 非负；valueCount 为 1–100，sourceCount 为 0–10000；ordinal 从 0 连续；所有 hash 为 64 位小写十六进制；schemaVersion 固定已批准版本。区间只存合法闭合 instant，成员分组序号只能由服务端同事务派生。绑定和候选 receipt 的 JSON 必须精确键闭集，不允许额外明细字段。具体列类型与 payload 字节上限仍须与 DTO／parser 同尺定稿，不靠随意 VARCHAR 长度代替输入预算。

不可变函数须附到六个新表；数量核验使用提交时的 constraint trigger，同时覆盖候选父行及 Value/Source 插入，防止父行先通过后补子行。缺收据／无值／断号／跨链必须回滚；零来源合法不等于允许没有值。触发器应核对来源快照字段，不在数据库重造第二套业务舍入算法。各函数触发器实例的名字与事件列表须在最终 SQL 中逐个展开，禁止仅创建函数却忘记挂载。

#### 字段类型与规范化输入补稿

六模型的 ID／外键沿既有 C1/C2：Prisma String、数据库 TEXT，应用闭集解析长度 1–64，不擅自约束为 UUID。所有 hash 为 TEXT 且 CHECK 64 位小写十六进制；修订／数量／序号为 Int，时间为 DateTime（与源精度一致），createdAt 只作创建事实，不参与删除或过期计算。除 priorCandidateId 外，本批业务字段原则上必填，不以 null 暗示“以后补”。JSON 仅用于候选标量值和安全命令结果，不存任意客户配置或来源名单大包。

| 模型 | 列集合与补充约束 |
|---|---|
| Binding | id、schemaVersion=1、metricDefinitionId、definitionHash、ruleCode、evaluatorVersion、ruleDigest、unitCode、scale、bindingHash、createdAt、createdByUserId；ruleCode 与 evaluatorVersion 为代码闭集，unitCode=count/hours 是本批内部维度，scale 0–6；人数固定 0。 |
| Candidate | id、schemaVersion=1、activityId、candidateRevision、priorCandidateId?、metricSetVersionId、metricSetDefinitionHash、expectedOutcomeRevision、sourceMode、providerVersion、sourceDigest、bindingsDigest、valueCount、sourceCount、createdAt、createdByUserId；不存会随外部变化的 fresh/stale 状态。 |
| Value | id、candidateId、activityId、setVersionId、definitionId、definitionHash、bindingId、valueJson、valueHash；valueJson 只能为非负安全整数或已规范化的十进制字符串，精确定义范围仍由 C2 既有函数校验。 |
| Source | id、candidateId、activityId、ordinal、sourceRevisionId、identityId、sessionId、memberGroupOrdinal、checkInAt、checkOutAt、resultCode、sourceFingerprint；两时间均必填且 checkOutAt>checkInAt，零长段按已提议口径不进入来源，resultCode 只含本批纳入类别。 |
| CandidateReceipt | id、actorId、operation、operationKey、requestHash、candidateId、activityId、resultJson、createdAt；operation 固定 calculate_metric_candidate；key 的长度与字符合同沿既有命令风格单独闭集，不接收任意 JSON。 |
| BindingReceipt | id、actorId、operation、operationKey、requestHash、bindingId、resultJson、createdAt；operation 固定 create_metric_rule_binding；不同 key 同绑定可复用 Binding，但有独立 receipt。 |

所有 creator／actor 都引用 User；不能用请求自由传入的用户 ID 代替已验证调用者。FK 与 unique 的列名须据上表统一，避免文中 metricSetVersionId/setVersionId 等不同模型字段被盲目批改。双锚点的 receipt 不能只建单列外键。

**复算闭包**：sourceFingerprint 与 sourceDigest 只依赖确实持久保存的规范字段，不依赖源表现在的状态、当前 memberId、updatedAt 或未保存配置。按 identity 当时的 memberId 分组后，组顺序建议由组内最小 sourceRevisionId 排序决定，生成稳定 memberGroupOrdinal；每组内部按 sourceRevisionId 排序，再分配全局 ordinal。相同来源集合与相同成员分组应得到同一序列，与数据库返回顺序无关。memberId 不写快照，长期复算仅读持久分组序号即可去重／合并区间；发生分组变化时当前输入序列变化，旧候选 stale。

计算来源摘要时包含 sourceMode/providerVersion、活动锚与规范 Source 输入序列，但排除随机 candidateId/Source.id 和创建时间；bindingsDigest 包含排序后的精确绑定及其 hash。每行指纹也不包含其自身 fingerprint，避免循环定义。旧 evaluator 的版本／digest 必须能从绑定还原；不能只保存“v1”标签却替换实现内容。新增测试需同时证明乱序输入指纹不变、成员分组改变指纹改变，以及仅使用六模型持久输入即可复算，不回查当前 Member 来恢复旧分组。

### 4.2 绑定命令的幂等合同

现有 `activity-metric-command.ts` 的 MetricOperation、parseMetricReceipt 及 target 路由绑定 definition/set，不能强制类型转换塞入 rule_binding。建议单独解析器及独立 BindingReceipt（上列第六模型），不改变旧命令闭集。

请求闭集为 schemaVersion=1、operationKey、metricDefinitionId/definitionHash、ruleCode/evaluatorVersion；unit/scale 从精确定义与规则核对后固定，不接受客户端自由表达式。requestHash 复用 `fingerprintMetricEnvelope`，domain 用 `activity-metric-rule-binding-command-v1`；不能包含时钟或随机 ID。

锁序为命令键 → 定义引用锁；每次等待后重新判 Human GLOBAL 显式绑定权限及当前用户有效性。同 key 同请求返回原 BindingReceipt；异请求 conflict。不同 key 请求相同 immutable binding 内容时复用已有 binding，并给当前命令写独立收据；首次创建与复用均记录最小审计。bindingHash 唯一竞争须按唯一约束名归类，不能把所有 P2002 都当幂等成功。

calculate 中先拒绝重复 bindingId，再排序并验证“同指标最多一个绑定”，组成 bindingsDigest；不静默去重。绑定与目标 set 的精确定义不匹配即拒绝，不按 code/name 猜映射。变更绑定列表产生新候选，不更新历史候选。退役 evaluator 的读取／复算兼容策略需随新 evaluator 版本独立验收。

#### 命令与安全结果闭集

沿 C2 已核实的 `metricText` 规则：operationKey 长度 1–128；ID 1–64；预期 revision 为 0–2147483646，新 revision 为 1–2147483647；所有 hash 为精确 64 位小写十六进制。拒绝未知键、getter／非普通 JSON 对象、重复绑定和空绑定集合，不能靠类型断言绕过。字符串按既有函数语义处理，不额外 trim 改请求含义。

| 对象 | 精确键（全部必填） |
|---|---|
| CreateBinding 请求 | schemaVersion=1、operationKey、metricDefinitionId、definitionHash、ruleCode、evaluatorVersion |
| Calculate 请求（activityId 来自路径） | schemaVersion=1、operationKey、expectedCandidateRevision、expectedOutcomeRevision、metricSetVersionId、metricSetDefinitionHash、bindingIds |
| Binding 安全结果 | schemaVersion=1、bindingId、bindingHash、metricDefinitionId、definitionHash、ruleCode、evaluatorVersion、unitCode、scale、createdAt |
| Candidate 安全结果 | schemaVersion=1、candidateId、activityId、revision、metricSetVersionId、metricSetDefinitionHash、createdStatusCode=candidate、sourceCode=system、valueCount、sourceCount、createdAt |

bindingIds 为 1–100 个唯一 ID，字典序规范化；同 metricDefinitionId 多绑定拒绝。单位、scale、值、来源时间或 sourceCode 不作为请求输入。结果 createdAt 为被创建 Binding/Candidate 的真实创建时刻，复用旧绑定时不伪造新的绑定创建时间；receipt 本身另有创建时间。序列化时间统一 ISO UTC，并在解析时往返核验合法日期。

请求 hash 不含 operationKey、随机候选 ID、处理时钟；它必须包含 activityId（calculate）、全部预期版本／hash 和规范化绑定集合。相同 key 下任何业务字段改变都 conflict；同一语义的绑定排列顺序不同仍同 hash。重放只返原安全结果、重验当前访问资格；不重算、不把当前 fresh/stale 塞回原收据。引用依赖变动的即时状态由独立 GET 表达。

安全结果序列化 JSON 的建议硬上限为 4096 UTF-8 字节，请求规范化 envelope 为 16384 UTF-8 字节；是本批封闭字段结构的预算，不改变全局 HTTP body 限额。超限拒绝而非截断，边界须覆盖中文／多字节 ID、最大绑定数组和所有固定字段。具体值与规则信息由安全查询 DTO 单独返回，命令 receipt 不存来源清单或自由文本。

#### 触发器逐表挂载清单

| 实例名称 | 表／事件 | 执行函数或职责 |
|---|---|---|
| metric_binding_immutable_trg | Binding，BEFORE UPDATE OR DELETE | metric_candidate_fact_immutable |
| metric_candidate_immutable_trg | Candidate，BEFORE UPDATE OR DELETE | 同上 |
| metric_candidate_value_immutable_trg | Value，BEFORE UPDATE OR DELETE | 同上 |
| metric_candidate_source_immutable_trg | Source，BEFORE UPDATE OR DELETE | 同上 |
| metric_candidate_receipt_immutable_trg | CandidateReceipt，BEFORE UPDATE OR DELETE | 同上 |
| metric_binding_receipt_immutable_trg | BindingReceipt，BEFORE UPDATE OR DELETE | 同上 |
| metric_candidate_complete_trg | Candidate，AFTER INSERT，DEFERRABLE INITIALLY DEFERRED | metric_candidate_aggregate_complete |
| metric_candidate_value_complete_trg | Value，AFTER INSERT，DEFERRABLE INITIALLY DEFERRED | 同上，以 NEW.candidateId 定位父行 |
| metric_candidate_source_complete_trg | Source，AFTER INSERT，DEFERRABLE INITIALLY DEFERRED | 同上 |
| metric_candidate_receipt_complete_trg | CandidateReceipt，AFTER INSERT，DEFERRABLE INITIALLY DEFERRED | 同上，防绕过命令再给旧候选追加收据 |
| metric_candidate_source_insert_trg | Source，BEFORE INSERT | metric_candidate_source_snapshot_check |
| metric_candidate_receipt_insert_trg | CandidateReceipt，BEFORE INSERT | metric_candidate_receipt_shape_check |
| metric_binding_receipt_insert_trg | BindingReceipt，BEFORE INSERT | metric_binding_receipt_shape_check |

aggregate_complete 在提交态验证原 valueCount/sourceCount、连续 ordinal、同指标唯一及**每候选恰一条创建收据**；actor 与 Candidate.creator 一致，收据锚／数量／时间与父行一致。Binding 可被不同命令复用，故不对每 Binding 强加一条 receipt。候选前驱同活动且 revision 恰加一的检查并入父行核验；max revision 边界先拒绝，不溢出。上述表简称严格对应 §4 的六模型，不能把同一通用触发器误挂到原始服务段或 C2 历史表。

### 4.3 长期保留与历史复算

沿六模型方案，不增加清理收据、到期字段、删除入口或清理角色。新计算产生新候选，旧候选的值、来源及规则绑定不覆盖；成员退队、归档或后来成果更正均不删除旧来源。规则升级保留旧 evaluator，不用新算法重新解释旧结果。

复算与是否仍适用于当前成果是两回事：旧来源仍完整且旧 evaluator 可用时可以复算；来源后来发生变化，旧候选仍须判 stale，不能当新成果直接确认。输入缺失、损坏或版本无法解释时明确 unavailable，不能补零或静默回源拼装历史。

所有普通写路径与数据库约束禁止修改／删除候选事实；不设计到期清理例外。容量尚未测量，不声称“占不了多少空间”或以未验证容量假设减留明细。未来仅在独立获批测试环境测量每候选数据、索引及备份占用，提出不损失历史的容量方案，不构成本轮数据库授权。

## 5. 事务、来源围栏与 stale

推荐沿 READ COMMITTED、命令 advisory lock → Activity FOR UPDATE → 指标／绑定引用锁，再同事务取来源与写候选。每次等待后复验当前用户、成员、显式权限、组织资格、负责人、活动状态和版本。不可用 REPEATABLE READ 的旧权限快照假装“锁后当前资格”。

来源一致性必须由全部 writer 共用的根锁或可证版本围栏保证。当前识别五组 writer；以下是**实施前必须完成的证明队列，不是已证明全覆盖**：

| writer | 已定位入口／锁候选 | 待补证明 |
|---|---|---|
| 打卡与 void/replace | `attendance-punch-command.service.ts` 调用 `attendance-punch-access.service.ts.lockActivity` 后 `segments.rebuild` | 遍历普通、补打卡、撤销／替换、离线分支全部调用；是否传入同一 tx；每个 writer 两连接竞态。 |
| 结算重投影 | `settlement-draft.service.ts.lockActivity/persistSegments` | 全部 persist caller 与 tx 传播，不只是 updateItem。 |
| 生效提交 | `ledger-posting.service.ts.commitBatchProtocol` | 常规／转换入口均受根锁；status 变化对输入语义是否应 stale。 |
| 更正提交 | `correction-application.service.ts` 根锁与物化 | prepare 不改变来源；commit 改变来源后旧候选 stale；失败回滚不污染候选。 |
| identity/session 生命周期 | 待逐路径扫描活动参与与场次 writer | member 分组映射、软删、区间关联发生变化同样进入摘要与围栏，不能遗漏 phantom insert。 |

建议新增 activities 公共来源查询原语，使用 caller tx，从该活动完整当前输入一次批量取数；不得从 Outcome service 深引 attendances 私有类。读取 identity/segment 的 domain-map 属主与 import 方向需真实运行边界判据，无新债务前不得批准实现。若根锁证据不闭合，先补精确属主协议的方案，再实施；不以“锁了 Activity”一句话通过。

新计算绑定 expectedCandidateRevision、expectedOutcomeRevision 和精确 set/hash；同 key 同请求返回原安全回执，异请求冲突；重放重验权限，不重算、不依来源当前值改原回执。

stale 是读取时的派生结果，不修改历史候选：比较当前来源模式/providerVersion、canonical 输入摘要、精确集／绑定／预期 Outcome 版本。返回 fresh/stale/unavailable 三态，读失败不得显示 fresh。C3-2 确认必须在写事务的同一来源围栏内重验，不能信任先前 GET 的 fresh 标志。

### 5.1 补充证据：2026-09-08 同一基点的静态调用链核查

以下为本轮只读新增证据；行号绑定 main `638fc784`，不代表运行探针已通过。

| 入口到写入的链 | 已核实证据 | 尚不能据此声称 |
|---|---|---|
| selfPunch → segments.rebuild | `attendance-punch-command.service.ts:171` 同一事务，172 调用 lockActivity，313 调用 rebuild 并传入 tx | 没有两连接探针，不宣称所有锁后授权竞态已验证。 |
| managedPunchWithinTransaction → writeManagedOnlinePunch | 同文件 396 公开入口转 623 私有编排；627 先 lockActivity，747 rebuild | 仍须核实所有上层适配器使用同一 tx，不依赖 Controller 名称推断。 |
| earlyDepartureClose → writeManagedEvent；void/replace → correctEvent | 同文件 809/917 开事务、810/918 根锁、885/1008 rebuild | 不是仅 ordinary check-in 的证明，仍要每类写入交错用例。 |
| offline package sync → offlinePunchWithinTransaction | `attendance-offline-package.service.ts:340` 事务、342 根锁，444 重放及 576 正式写均透传 tx | offlinePunchWithinTransaction 自身只锁 session/identity，不能把它当独立安全根入口暴露。 |
| offline review → offlinePunchWithinTransaction | `attendance-offline-review.service.ts:162` 事务、164 根锁、253 同 tx 调用 | 待证明 review 队列所有决议分支及源状态变化。 |
| generate → persistSegments | `settlement-draft.service.ts:853` 事务、854 根锁、910 唯一 persistSegments 调用 | 当前文本搜索只有此调用；实施前须 AST/引用搜索复核别名和原生 SQL。 |
| 常规／转换提交 → commitBatchProtocol | `ledger-posting.service.ts:246` 转换入口进入共享协议，266 根锁，353 SQL 更新段 | 不表示转换前创建 identity 的上层流程已完全核查。 |

**不能采用单一 evidenceRevision 判 stale**：`attendance-punch-command.service.ts:1299` 在打卡时增加 evidenceRevision；但 `correction-application.service.ts:1400/1414` 将新结算版本的 evidenceRevision 取自 baseVersion。该事实不证明整个系统不存在其他递增，已足够否定“看见新段就一定有新 evidenceRevision”的假设。C3-1 的 freshness 必须比较当前候选实际输入的 canonical digest，不能仅比较封场／结算版本的 evidenceRevision；P05 必须固定这条反例。

属主证据：`harness/domain-map.json:585/597/621` 分别登记 ActivitySession、ActivityParticipationIdentity、ParticipantServiceSegmentRevision 属 participation / activities / lifecycle，三项 confirmed 均为 true。活动内候选来源读原语放 activities 有现行属主依据，不需要跨模块深引 attendances 的 projector。此证据解除这三类表的属主登记疑问，不代替 tx 完整传播、所有 writer 根锁或运行中的查询预算证明。

路径补核：结算、账本及更正三个 writer 的实际路径分别为 `src/modules/activities/settlement-draft.service.ts`、`src/modules/activities/ledger-posting.service.ts`、`src/modules/activities/correction-application.service.ts`，不在 attendances 目录。账本常规／转换入口在 224/250 行调用同一私有 commitBatchProtocol，266 行取得 Activity 锁；更正的根锁候选在 415/497/604/798 行，实际 SQL 在 930–935 行。以上只用于后续逐入口核验，不把文本出现四个锁点等同四条完整竞态证明。

本轮还定位到 identity 写入候选：activity-registrations 下的 registration-command、onsite-participation-command、activity-registration-lifecycle、activity-allocation、registration-reconciliation、activity-cancellation-lifecycle，以及 activities 下的 legacy-ledger-conversion、activity-session-participation-cancellation。这些是**继续核查清单，不是已批准扩展的代码写集**。需要区分改 member/session 锚、仅改 population/status、以及新增 identity 的 phantom；仅有无有效段的报名变化不应被误算为真实人数变化。

### 5.2 来源输入收敛的补充说明（待业务口径批准）

本轮使用 TypeScript AST 遍历 `src/**/*.ts` 的直接 `activityParticipationIdentity.create/update/updateMany/upsert` 调用，排除 `.spec.ts`，实际识别 14 处：3 create、11 updateMany。14 处 data 均为可展开对象。创建分布于 registration-command:929、onsite-participation-command:340、legacy-ledger-conversion:258；11 处更新只写 currentRevision/currentStatusCode/currentPositionId/capacityReservationId/populationIncluded/version，没有写 activityId/sessionId/memberId。另读 `activity-session-participation-cancellation.ts:232` 原生 SQL，同样只改状态／计数／updatedAt。

此结论严格限定直接调用形状；未覆盖别名、中间变量、动态 SQL、外部数据库写入，**不是“锚点不可变”的数据库证明**。不能用该 AST 读数为 snapshot 只留 ID 的方案背书。

| 已读场次 writer | 具体变更 | 对本稿建议规则的影响 |
|---|---|---|
| `activity-draft.service.ts:239` | 间接 data 可含时间窗、迟到／早退阈值、排序 | 不能用 session.updatedAt 判数值过期；来源段尚未重建时还需确认投影是否跟上配置。 |
| `activity-draft.service.ts:278` | deletedAt；此前同 tx 统计 identity，非零禁止删 | 不能据“没有段”忽略来源是否已被软删；空集可用性需重新验证。 |
| `activity-place-writer.ts:178` | 地址／坐标／会合等文本 | 两条区间计算规则不直接使用这些字段，不应仅因地点展示调整 stale。 |
| `activity-publish-proposal-v2.service.ts:2957` | 正式场次内容及 workflowRevision | 阈值／时间／取消变化影响来源可解释性；须验证重投影或明确 source_incomplete，不按新阈值偷偷改旧段。 |
| `activity-lifecycle.service.ts:255` | terminationCheckOutDeadline | 开放段必须先按既有事实链闭合；候选不得自己补签退时间。 |

建议把 freshness 分为两层：①来源资格／完整性检查（Gate、活动／场次存活、投影与配置关系、无开放或异常段）；②计算输入 digest（活动与 providerVersion、按稳定顺序排列的段 revision ID、identity/session 锚、member 分组映射、checkIn/out、纳入类别及绑定版本）。只有两层均通过才 fresh。

在 §3 筛选批准的前提下，不把 registration 的候补排名、populationIncluded、当前岗位指针或不参与两规则的展示字段塞入 value input；改变这些字段而有效段集合未变，不能误判为人数／时长变化。也不能因 identity 变为 cancelled 就抹掉已发生区间。新增 identity 无有效段不增加人数；新增有效段则须改变 digest。

draft→committed 本身不改实际区间，本稿建议归一为同一“当前有效”类别，不单凭 status 变化 stale；superseded／voided／replaced 会改变有效源集合，必须 stale。**这只是建议的实际参与口径，不改变现有结算 writer**。若业务选择“仅 committed 才算”，必须另版规则并重新评审，不能在实现时无声替换本稿口径。

### 5.3 正式段写入枚举及具体竞态探针

继续核查同一基点：TypeScript AST 扫描生产 `.ts` 的直接 `participantServiceSegmentRevision` 写调用，得到 8 处：打卡 rebuild 的 update/create 各两处（91/96/119/123 行），结算 persistSegments 的 updateMany/create（687/693 行），更正 materializePendingSegments 的 updateMany/create（1650/1655 行）。另对正式表名的原生 INSERT/UPDATE/DELETE 字面 SQL 搜索，定位账本 353 行 UPDATE。该枚举不覆盖动态表名、别名或仓外 SQL，不能声明数据库全体 writer 已被机器证明。

进一步读到的协议：

- `settlement-draft.service.ts` 的 generate 在 853 行开启事务、854 行持 Activity 锁、910 行同 tx 调用私有 persistSegments。内容相同保留原段 ID；变化则先 superseded 后创建。候选不能把“调用 generate”本身当成 stale，须比较实际来源。
- `correction-application.service.ts` 的 commit 在 `runMemberLinearizedTransaction` 内先取 Activity 锁（798 行），同 tx 在 820 行物化正式段，再交 `ledgerPosting.commitBatchWithin`；preparePendingSegments 只写暂存表和准备收据，不提供候选来源。
- `ledger-posting.service.ts` 常规提交由 `runMemberLinearizedTransaction` 包裹，Within 方法传 tx 到共享协议；转换入口也进入该协议。候选读取不可等待到一半改用根 prisma client。
- 打卡命令实际有五处 `segments.rebuild`：313、552、747、885、1008 行。552 行是 offlinePunchWithinTransaction，必须连同已定位的 offline package／review 上层根锁一起验证，不能漏掉，也不能单独暴露为可自行开事务的来源写入口。

P06 在实施测试中必须展开为如下双连接交错，而不是单一 happy path：

| 交错 | 预期结果 |
|---|---|
| calculate 先持 Activity 锁，打卡／void／replace 等待 | 候选只含写入前完整来源；writer 提交后，GET 判旧候选 stale。 |
| writer 先持锁，calculate 等待 | calculate 锁后读取写入后完整来源，不得混合旧身份分组和新区间。 |
| offline package／review 在来源写入前暂停 | 两个真实入口分别跑，确认上层 tx 锁覆盖 552 行 rebuild；不直接调用底层方法伪造通过。 |
| prepare 成功但 commit 尚未发生 | 不读取 pending；正式来源未变，不能仅因存在更正申请而 stale。 |
| correction 物化后、账本提交前注入失败 | 整笔回滚，calculate 之后仍读取原正式来源，不看见短暂 draft。 |
| generate 重投影输入不变／输入变化 | 前者原 ID/digest 不变；后者新来源使旧候选 stale。draft→committed 若区间与选定类别不变，沿 §5.2 不单独 stale。 |

来源查询计划的额外边界：不能先把活动全部 identity／全部历史段加载进内存，再用“2000 人／10000 段”限制结果。建议从当前正式段按活动关系过滤、稳定排序、有界 `take=10001` 取必要区间及同链 identity/session 字段；在内存计算前检测上限，历史 superseded 不加载。该限额拟覆盖读取到的当前段，包括稍后按 voided/replaced 排除的行，避免排除条件掩盖无限扫描；这是预算口径建议，须与 §3.3 一并批准。成员去重检查在有界来源内完成，不按 identity 数冒充人数。

空集可用性、开放段／投影落后检查必须独立有界查询或存在性探针，不能把取不到有效行当成零，也不能为验证完整性无界加载报名表。具体 SQL 与 EXPLAIN 仍须未来获批隔离库实测；当前未操作数据库，不宣称已有索引保证延时预算。若发现所需查询无法在现有索引预算内完成，先列精确新增索引方案，不能顺手改旧 migration。

### 5.4 空集完整性的属主边界补证

`harness/domain-map.json:849` 将 AttendancePunchEvent 登记为 participation / **attendances** / attendance；不能由三个段／identity／session 的 activities 属主归属推断打卡事件也归 activities。`AttendanceSegmentProjectorService` 是 activities 已公开的无数据库纯投影 façade，输入事件由调用者提供，**它不证明事件集合完整**。`settlement-segment-projector.ts` 的 chainAnomalies 可报告重复签到／无签到闭合等异常，不是零值兜底。

建议新增 attendances 公共只读服务 `AttendanceMetricSourceQueryService`，方法 `readActivityPunchProjectionInputTrusted(tx, activityId, maximumEvents)`：必须使用 caller tx，精确活动条件、稳定排序、最多预算+1 行；仅返投影所需 event id/type/occurredAt/supersedesEventId 与 identity/session 锚，不返坐标、设备、人员文本、凭证或附件。预算参数由服务端规则固定并验证，不由 App DTO 任意指定；事件预算需随整体规模方案批准，当前不自行设一个“足够大”的无限上限。超限明确失败，禁止分页拼接不同时点快照。

activities 的候选来源查询经此入口取得完整有界事件输入，结合既有纯投影器核查未提交段链／异常／遗漏。空事实集须同时证明无有效区间、无未闭合或异常有效事件；不能只见段数=0 就返回零。对于已 committed 且经过正式更正的段，以正式更正事实为准，**不能用原打卡重投影覆盖更正**。因此完整性比较必须区分未提交投影与正式更正链，最终服务协议仍要用更正反例核验，不能把一个通用“投影不等就报错”当完整实现。

模块接线证据：`activities.module.ts:179` 已 forwardRef 导入 AttendancesModule，后者当前仅导出既有现场批次／导入预览服务。新只读服务在 AttendancesModule 提供并显式导出，不新建模块循环、不复制另一套打卡 projector、不跨模块深引私有目录。现有模块图注释有历史描述，本轮不顺手清理。

新增未来审批候选三路径：`src/modules/attendances/attendance-metric-source-query.service.ts`、`src/modules/attendances/attendance-metric-source-query.service.spec.ts`、`src/modules/attendances/attendances.module.ts`。新方法的 tx、活动隔离、越界拒绝与最小返回字段须测；attendances 公共出口变化也需跑该模块受影响 E2E，不能仅测 activities。

#### 现有投影器实测与正式段分流要求

2026-09-08 用 `pnpm exec tsx` 标准输入脚本直接调用既有 `rebuildServiceSegments`，9 项 node:assert 断言通过，退出码 0，无数据库操作：空事件得零段且无异常；只有签到得开放段，结束时间及 serviceHours 均 null；只有签退报 close_without_open；重复签到报 duplicate_check_in；10 分钟 early_departure_close 得 early_departure_zero、认定时长 0，但原区间仍为 600000 毫秒。这实证支持“实际参与区间不等于认定 serviceHours”，不证明数据库事件集合完整或 C3 新规则已经实现。

来源完整性查询按两类处理，不将全部段都与原打卡盲比：

1. 当前 draft：通过属主事件入口取完整有界链，校验链异常／开放段，并与持久化当前段的身份、segmentKey、区间及本规则纳入类别比较。比较异常或缺段明确 source_incomplete，不自己写回修复段。
2. 当前 committed：核对有效 batch 经 settlementRun 属于同活动且已 committed。`ledger-posting.service.ts:353–359` 在同事务为正式段设置 effectiveBatchId；该锚应参与有效性验证。已正式更正的区间不按原始事件重投影回退；后继 revision、baseRevision 与正式更正链的证明必须独立成立。
3. 当前集合全为空：仍通过有界事件／事实链检查排除遗漏有效事实；空投影纯函数的通过不能替代数据库完整性证据。存在未解决异常或无法解释的来源就不生成候选。

两类路径最终统一为最小 canonical 区间输入。batch／更正记录用于证明来源有效，但本规则不计算其 serviceHours 或贡献值。批量关联查询须同 tx 且有界，不能 per-segment 开新查询或在缺锚时用默认值。正式更正链证明的具体字段与唯一引用仍在技术核验队列，不能把此分流建议宣称已验证闭环。

#### 正式更正关联的精确核验接缝

已读 schema 与 domain-map：LedgerPostingBatch 属 activities；AttendanceCorrectionRequest／CorrectionApplication 属 attendances（登记 873/879 行），即使当前写服务位于 activities 也不构成新查询可跨属主的许可。CorrectionApplication.newPostingBatchId 只有普通索引，没有唯一约束；查询不能以 findFirst 或 Map 后者覆盖前者来忽略重复关联。

在 §5.4 同一个新属主查询服务中增加 `readCommittedCorrectionAnchorsTrusted(tx, activityId, batchIds)`，不另增模块或暴露 HTTP：输入 batchIds 来自本次已限量的当前段集合，去重并验证预算；只返回 applicationId/status、newPostingBatchId、newSettlementVersionId、requestId/status/activityId/settlementRunId/baseSettlementVersionId 等证明锚，不返 reason、reviewNote、附件或完整 requestedChangeJson。属主以 activityId 限定请求，同时对请求批次的异活动／重复关联明确报错，不能被 where 过滤成“未发生更正”。批量查询须能检测每批次多于一个匹配，不接受截断后看似唯一。

activities 侧验证 batch.status=committed、batch.run.activityId=目标活动、batch.settlementVersion 与 run 同链；若存在更正关联，再要求 application.status=committed、request.status=applied、request.run 与 batch.run 相同、application.newSettlementVersionId=batch.settlementVersionId。代码依据是 correction-application.service.ts:863/867 在提交事务内分别设置 committed/applied。当前更正段的 baseRevision 必须同 identity、同 segmentKey，revision 递增；历史 base 已 superseded 不算缺证据。

不能反过来把所有有 baseRevisionId 的段都当正式更正：普通打卡／结算重建也会产生前驱段。分流依据是生效 batch 的正式更正关联，不是 baseRevisionId 是否非空。没有更正关联时按普通 committed 链验证；任何冲突都不降级到普通路径。查询本身不调用更正 prepare/commit，不复制或写入更正内容。

本方案不以该关联核验声称数据库已阻止所有历史源内容篡改。长久复算依赖新候选不可变来源快照；新候选创建时仍须按同一事务取到的真实来源逐字段固化，并用跨活动／双应用／错误版本／普通前驱／历史更正用例证明不误接或误拒。此接缝使用 §7.4 已列的新 query service/spec，不额外增加代码文件。

## 6. 建议命令面、权限与安全回执

下列为新合同建议，不是已存在路由；不改旧 C2 三接口及结果 DTO。

| 路由（均 `/api/` 下） | 权限与资格 | 结果／边界 |
|---|---|---|
| POST `admin/v1/activity-metric-rule-bindings` | 新 `activity-metric.manage.rule-binding`，Human GLOBAL 显式授权，无自动角色绑定 | 创建受控绑定；服务端校验规则与 definitionHash。 |
| GET `admin/v1/activity-metric-rule-bindings` | 既有 `activity-metric.read.catalog`，Human GLOBAL；与 `admin-activity-metric-definitions.controller.ts` 的目录读面一致 | 分页安全绑定信息；不返回参与数据。 |
| POST `app/v1/my/managed-activities/:activityId/metric-candidates` | 新 `activity.outcome.calculate`，Human App managed，显式授权＋组织＋initiator/owner | operationKey、expectedCandidateRevision、expectedOutcomeRevision、set/hash、bindingIds；不接受客户端 system value。 |
| GET `app/v1/my/managed-activities/:activityId/metric-candidates/:candidateId` | 既有 `activity.outcome.read`，沿现行 managed 边界 | 值及规则说明、source 状态；不返回源 ID 清单／分组／原区间。 |

calculate 状态 draft/published/completed/terminated；cancelled/archived 拒绝新写。SP/Delegated 禁止，负责人变化、撤权与重放均验证当前资格。

安全回执严格使用 §4.2 的 Candidate 结果闭集，createdStatusCode=`candidate`、sourceCode=`system`；不复用 C2 manual/draft 的旧解析器。请求／来源／绑定 canonical hash 使用已有 fingerprint 工具，不发明第二套 JSON 排序。

错误语义须包含 invalid、stale、command_conflict、reference_unavailable、source_incomplete、source_unavailable、source_limit_exceeded、receipt_invalid；具体 BizCode 名与数值在实施前分配并查重，不以现稿预占。

审计建议沿 `activity.outcome.command` 扩闭集 operation，但要先核对 recorder、registry 和消费者；若现事件只承诺 manual，另提最小新事件。只记锚、操作、数量、来源类别，不记录值／来源快照／key。实际权限与审计读数确定后才出 4b 重签，不提前声称 256 等计数已成立。

## 7. 实施写集草案与需要补齐的精确项

本轮**实际文档写集只有 5 份**：本稿、`docs/ai-harness/NEXT_TASKS.md`、`docs/ai-harness/FROZEN_DRAFTS.md`、`prisma/CLAUDE.md`、`src/modules/activities/CLAUDE.md`。下面仅是未来审批候选，不是本轮授权。

已定位的未来既有文件：

1. `prisma/schema.prisma`；仅本批模型及精确关系反向字段。
2. `src/modules/activities/activities.module.ts`；新 provider/controller 接线。
3. `src/modules/activities/activity-outcome-access.service.ts` 及 `.spec.ts`；calculate 当前资格。
4. `src/modules/permissions/permission-catalog.ts`、`src/modules/permissions/seed-permission-codes.ts`；新码及显式 eligibility，不赋角色。
5. `src/common/exceptions/biz-code.constant.ts`；已冻结错误语义对应新增码。
6. `harness/domain-map.json`、`harness/state-machines.json`；属主登记／派生摘要，不扩大债务白名单。
7. `docs/ai-harness/ROUTE_AUTHZ.md`、`docs/ai-harness/RBAC_MAP.md`、`docs/ai-harness/STATE_MACHINE_INVENTORY.md`、`CODEMAP.md`、`docs/current-state.md`；按代码生成的事实，不手改生成段。
8. `docs/handoff/miniapp.md`、`docs/handoff/admin-web.md`；路径已核实存在，实施前读完各端边界后确定精确更新范围。

建议新增文件（路径未实施）：

| 路径 | 职责 |
|---|---|
| `src/modules/activities/activity-metric-rule.ts` / `.spec.ts` | 规则闭集、版本、区间并集纯函数与 hash |
| `src/modules/activities/activity-metric-rule-binding.service.ts` / `.spec.ts` | 显式创建绑定命令及精确引用校验 |
| `src/modules/activities/activity-metric-rule-binding-command.ts` / `.spec.ts` | 独立绑定请求、指纹与安全收据闭集解析，不扩写旧 MetricOperation |
| `src/modules/activities/activity-metric-candidate-source.query.ts` / `.spec.ts` | 属主来源通路与有界输入，不接受公开 DTO |
| `src/modules/activities/activity-metric-candidate.service.ts` | 命令锁、取数、候选／回执／审计原子写 |
| `src/modules/activities/activity-metric-candidate-command.ts` / `.spec.ts` | 请求与安全回执闭集解析 |
| `src/modules/activities/activity-metric-candidate-query.service.ts` / `.spec.ts` | 授权读取与 freshness |
| `src/modules/activities/activity-metric-candidate-presenter.ts` / `.spec.ts` | 安全出参，不访问 DB |
| `src/modules/activities/controllers/admin-activity-metric-rule-bindings.controller.ts` | 目录绑定接口 |
| `src/modules/activities/controllers/app-managed-activity-metric-candidates.controller.ts` | 候选接口 |
| `src/modules/activities/dto/admin/activity-metric-rule-binding.dto.ts` | Admin 独立 DTO |
| `src/modules/activities/dto/app/app-activity-metric-candidate.dto.ts` | App 独立 DTO，不派生 Admin |
| `test/e2e/activity-os-r3-c3-1-candidate.e2e-spec.ts` | 全链路、来源、访问、幂等 |
| `test/e2e/activity-os-r3-c3-1-candidate-concurrency.e2e-spec.ts` | 两连接来源变化／撤权／竞争／回滚 |
| `test/e2e/activity-os-r3-c3-1-candidate-migration.e2e-spec.ts` | 冷回放、非空升级、数据库硬约束 |

**整体评审输入已汇总**：contract 路由白名单／snapshot、13 个生成客户端、审计路径见 §7.1；16 份当前迁移计数测试及签字登记见 §7.3；§7.4 已展开并去重，包含精确 migration 候选路径，§7.5 给出红区预算。SQL 拟用名称、触发器逐表挂载及请求／结果闭集上限均已列出。来源查询新增依赖已纳入属主服务，运行正确性留 P01–P17 实测，不宣称静态闭合等于运行通过。禁止用通配符或“所有关联文件”代替当前清单；实施发现额外业务行为变化仍须报告。

### 7.1 契约、权限和审计的补充路径核验

本节仍为未来审批候选。2026-09-08 只读核对得到以下明确关联，未修改任何下列代码、测试或生成物。

| 精确路径 | 关联证据与拟变更边界 |
|---|---|
| `src/modules/permissions/permission-code-holders.spec.ts` | 123–151 行人工授码例外为七条精确集合。若批准两个新码人工授予，须同时批准增加两个集合成员和对应期望；这是治理行为合同扩展，不是普通计数刷新，不豁免同前缀其他权限。 |
| `test/e2e/activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts` | 496 行当前 seed 回放总数锁定 254。新权限若获批需精确更新当前总数；历史迁移目标和既有同链、幂等、无自动角色赋权断言保持不变。实际新总数由最终目录核验，当前不改。 |
| `test/contract/openapi.contract-spec.ts` | 98–100 行旧 C2 三路由及 2915 行起人工成果 DTO 契约保留；独立追加 C3-1 四路由和新 schema 的正反断言，不放宽旧 DTO 字段闭集。 |
| `test/contract/__snapshots__/openapi.contract-spec.ts.snap` | 实施时仅纳入已批准新路由／schema 的可逐行解释差异，不盲目更新全库快照。 |
| `docs/handoff/openapi.json` | `scripts/generate-fe-client.ts:35` 的客户端真源；由实际 API 导出后对照契约，不手写虚构接口。 |
| `docs/ai-harness/AUDIT_EVENT_REGISTRY.md` | 93 行现事件明确描述 C2 人工草稿，出现次数为 1；不能只改数字便声称涵盖绑定和系统候选。 |
| `src/modules/audit-logs/audit-logs.types.ts` | 新事件须预先明确批准后加入 union；不能用新增字符串强转绕过登记。 |

审计补证：`activity-outcome-audit-recorder.ts:19–36` 接受旧 `ActivityOutcomeCommandResult`，固定 operation=`record_manual_outcome`、sourceCode=`manual`、afterStatus=`draft`。因此不复用这个 recorder 写候选。建议改为两个独立新 recorder：`src/modules/activities/activity-metric-rule-binding-audit-recorder.ts` 及 `.spec.ts`、`src/modules/activities/activity-metric-candidate-audit-recorder.ts` 及 `.spec.ts`；候选事件名建议 `activity.metric-candidate.command`，绑定事件名建议 `activity.metric-rule-binding.command`。这是对 §6 原先“可能复用”分支的收敛建议，**两新事件仍待批准**，不能提前重签 4b 或改旧 manual 语义。`scripts/check-audit-event-registry.ts` 与 `src/modules/audit-logs/audit-event-registry.spec.ts` 使用 union／登记表动态对拍，本轮未发现需修改裁判本身的依据，不纳入未来写集。

客户端输出路径已经生成器 485–500 行及实际文件双重核对。未来候选清单逐项为：

- `docs/handoff/clients/shared/types.ts`
- `docs/handoff/clients/admin/types.ts`
- `docs/handoff/clients/admin/client.ts`
- `docs/handoff/clients/app/types.ts`
- `docs/handoff/clients/app/client.ts`
- `docs/handoff/clients/auth/types.ts`
- `docs/handoff/clients/auth/client.ts`
- `docs/handoff/clients/system/types.ts`
- `docs/handoff/clients/system/client.ts`
- `docs/handoff/clients/open/types.ts`
- `docs/handoff/clients/open/client.ts`
- `docs/handoff/clients/integration/types.ts`
- `docs/handoff/clients/integration/client.ts`

共 13 个候选产物，不把历史批次“10 个摘要文件”沿用为本批数量。admin/app 会产生新业务定义；shared 是否重分配须看真实引用闭包。其余 surface 只允许生成器产生的摘要变化，若出现业务类型／路由变化必须解释并重新核定范围。生成器本身无需为新接口修改，不纳入写集。

### 7.2 明确撤出本批的清理设计

依据维护者最新“不删除”决定，撤出先前工作稿中的第七模型（来源清理收据）、清理 CLI、retention 纯函数与测试、cleanup E2E、清理 SOP 及专用角色。先前仅是文档中的未来候选路径，从未创建相应代码文件，本次也没有删除任何真实文件或业务数据。

已有 #1296 的更正暂存清理是另一已批准任务的代码，本轮不修改、不运行、不将其权限延伸到候选历史。候选来源的长期保留测试纳入 §7 已列新候选 E2E／并发／migration 测试文件，不另建删除工具。

### 7.3 迁移计数旧测试的精确候选清单

已用 rg 定位并由 Node 逐文件读取交叉核对：15 份测试声明 CURRENT_MIGRATION_COUNT=115，另 C2 D1 一份直接锁定当前冷回放标题和数量。未来如获批新增一条 migration，以下 16 份仅更新当前总数与相应标题，不改历史升级目标、原断言语义或旧夹具；这些修改需包含在同一实施授权中，当前不改测试。

- `test/e2e/activity-os-r1-a3-template-definition-lifecycle-guards.e2e-spec.ts`
- `test/e2e/activity-os-r1-a4-explicit-template-version-pointer.e2e-spec.ts`
- `test/e2e/activity-os-r2-b1-place-schema-constraints.e2e-spec.ts`
- `test/e2e/activity-os-r2-b2-coordinate-projection-schema-constraints.e2e-spec.ts`
- `test/e2e/activity-os-r2-b3-form-blueprint-governance.e2e-spec.ts`
- `test/e2e/activity-os-r2-b6-creation-data-foundation.e2e-spec.ts`
- `test/e2e/activity-os-r3-c1-d2a-metric-command-receipt-migration.e2e-spec.ts`
- `test/e2e/activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts`
- `test/e2e/activity-os-r3-c1-metric-definition-set.e2e-spec.ts`
- `test/e2e/activity-v11-batch4-allocation-candidate-position-anchor-migration.e2e-spec.ts`
- `test/e2e/activity-v11-batch4-allocation-command-replay-migration.e2e-spec.ts`
- `test/e2e/activity-v11-batch4-allocation-determinism-migration.e2e-spec.ts`
- `test/e2e/activity-v11-batch4-allocation-mode-migration.e2e-spec.ts`
- `test/e2e/activity-v11-batch4-qualification-contract-migration.e2e-spec.ts`
- `test/e2e/insurance-evidence-registration-revision-migration.e2e-spec.ts`
- `test/e2e/activity-os-r3-c2-outcome-value-revision.e2e-spec.ts`

其中 C1 D2b 文件还持有当前权限总数 254，已在 §7.1 列明，不重复计文件数。坐标测试中同样出现数字 115，但它是经度而非迁移数量，明确不改。未来实际新增量与基点若变化，按真实目标重新对照，禁止全仓替换数字。

时间登记已读 `src/common/datetime/clock-authority.spec.ts`：createdAt 属具名审计豁免，不参与到期计算；本方案已取消删除／到期字段，因此当前没有修改该裁判的依据。若实现新增非审计判定时间列，再精确报告，不预先放宽豁免。3b／4b 的登记文件定位为 `docs/ai-harness/CUTOVER_SIGNOFF.md`，仅在真实 migration 与权限／审计结果得到批准后更新，不预签。

### 7.4 已定位路径的汇总去重表

本表将 §7–7.3 及 §5.4 分散路径展开为完整文件名：58 个既有文件、28 个尚未创建的代码／测试文件，加 1 个拟议 migration 路径，共 87 个候选路径。前 86 项已逐项核验类型、存在性和去重；拟议 migration 路径确认尚不存在。目录时间戳仅用于精确评审／授权定位，不代表已创建迁移或签字。当前计划文档本身不计入下面实施候选数，整表仍须整体评审批准后才能实施。

CHANGELOG.md 随未来实现记录实际结果；CUTOVER_SIGNOFF.md 仅在明确重签后修改，不能借整体提交许可预签。下面客户端文件允许的变化边界仍按 §7.1；旧测试仍按 §7.3，不能由入表推导出放宽断言许可。

| 类型 | 精确路径 |
|---|---|
| 新增候选 | `prisma/migrations/20260908054308_activity_os_r3_c3_metric_candidates/migration.sql` |
| 既有 | `src/modules/attendances/attendances.module.ts` |
| 新增候选 | `src/modules/attendances/attendance-metric-source-query.service.ts` |
| 新增候选 | `src/modules/attendances/attendance-metric-source-query.service.spec.ts` |
| 既有 | `CHANGELOG.md` |
| 既有 | `CODEMAP.md` |
| 既有 | `docs/ai-harness/AUDIT_EVENT_REGISTRY.md` |
| 既有 | `docs/ai-harness/CUTOVER_SIGNOFF.md` |
| 既有 | `docs/ai-harness/FROZEN_DRAFTS.md` |
| 既有 | `docs/ai-harness/NEXT_TASKS.md` |
| 既有 | `docs/ai-harness/RBAC_MAP.md` |
| 既有 | `docs/ai-harness/ROUTE_AUTHZ.md` |
| 既有 | `docs/ai-harness/STATE_MACHINE_INVENTORY.md` |
| 既有 | `docs/current-state.md` |
| 既有 | `docs/handoff/admin-web.md` |
| 既有 | `docs/handoff/clients/admin/client.ts` |
| 既有 | `docs/handoff/clients/admin/types.ts` |
| 既有 | `docs/handoff/clients/app/client.ts` |
| 既有 | `docs/handoff/clients/app/types.ts` |
| 既有 | `docs/handoff/clients/auth/client.ts` |
| 既有 | `docs/handoff/clients/auth/types.ts` |
| 既有 | `docs/handoff/clients/integration/client.ts` |
| 既有 | `docs/handoff/clients/integration/types.ts` |
| 既有 | `docs/handoff/clients/open/client.ts` |
| 既有 | `docs/handoff/clients/open/types.ts` |
| 既有 | `docs/handoff/clients/shared/types.ts` |
| 既有 | `docs/handoff/clients/system/client.ts` |
| 既有 | `docs/handoff/clients/system/types.ts` |
| 既有 | `docs/handoff/miniapp.md` |
| 既有 | `docs/handoff/openapi.json` |
| 既有 | `harness/domain-map.json` |
| 既有 | `harness/state-machines.json` |
| 既有 | `prisma/CLAUDE.md` |
| 既有 | `prisma/schema.prisma` |
| 既有 | `src/common/exceptions/biz-code.constant.ts` |
| 既有 | `src/modules/activities/CLAUDE.md` |
| 既有 | `src/modules/activities/activities.module.ts` |
| 既有 | `src/modules/activities/activity-outcome-access.service.spec.ts` |
| 既有 | `src/modules/activities/activity-outcome-access.service.ts` |
| 既有 | `src/modules/audit-logs/audit-logs.types.ts` |
| 既有 | `src/modules/permissions/permission-catalog.ts` |
| 既有 | `src/modules/permissions/permission-code-holders.spec.ts` |
| 既有 | `src/modules/permissions/seed-permission-codes.ts` |
| 既有 | `test/contract/__snapshots__/openapi.contract-spec.ts.snap` |
| 既有 | `test/contract/openapi.contract-spec.ts` |
| 既有 | `test/e2e/activity-os-r1-a3-template-definition-lifecycle-guards.e2e-spec.ts` |
| 既有 | `test/e2e/activity-os-r1-a4-explicit-template-version-pointer.e2e-spec.ts` |
| 既有 | `test/e2e/activity-os-r2-b1-place-schema-constraints.e2e-spec.ts` |
| 既有 | `test/e2e/activity-os-r2-b2-coordinate-projection-schema-constraints.e2e-spec.ts` |
| 既有 | `test/e2e/activity-os-r2-b3-form-blueprint-governance.e2e-spec.ts` |
| 既有 | `test/e2e/activity-os-r2-b6-creation-data-foundation.e2e-spec.ts` |
| 既有 | `test/e2e/activity-os-r3-c1-d2a-metric-command-receipt-migration.e2e-spec.ts` |
| 既有 | `test/e2e/activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts` |
| 既有 | `test/e2e/activity-os-r3-c1-metric-definition-set.e2e-spec.ts` |
| 既有 | `test/e2e/activity-os-r3-c2-outcome-value-revision.e2e-spec.ts` |
| 既有 | `test/e2e/activity-v11-batch4-allocation-candidate-position-anchor-migration.e2e-spec.ts` |
| 既有 | `test/e2e/activity-v11-batch4-allocation-command-replay-migration.e2e-spec.ts` |
| 既有 | `test/e2e/activity-v11-batch4-allocation-determinism-migration.e2e-spec.ts` |
| 既有 | `test/e2e/activity-v11-batch4-allocation-mode-migration.e2e-spec.ts` |
| 既有 | `test/e2e/activity-v11-batch4-qualification-contract-migration.e2e-spec.ts` |
| 既有 | `test/e2e/insurance-evidence-registration-revision-migration.e2e-spec.ts` |
| 新增候选 | `src/modules/activities/activity-metric-candidate-audit-recorder.spec.ts` |
| 新增候选 | `src/modules/activities/activity-metric-candidate-audit-recorder.ts` |
| 新增候选 | `src/modules/activities/activity-metric-candidate-command.spec.ts` |
| 新增候选 | `src/modules/activities/activity-metric-candidate-command.ts` |
| 新增候选 | `src/modules/activities/activity-metric-candidate-presenter.spec.ts` |
| 新增候选 | `src/modules/activities/activity-metric-candidate-presenter.ts` |
| 新增候选 | `src/modules/activities/activity-metric-candidate-query.service.spec.ts` |
| 新增候选 | `src/modules/activities/activity-metric-candidate-query.service.ts` |
| 新增候选 | `src/modules/activities/activity-metric-candidate-source.query.spec.ts` |
| 新增候选 | `src/modules/activities/activity-metric-candidate-source.query.ts` |
| 新增候选 | `src/modules/activities/activity-metric-candidate.service.ts` |
| 新增候选 | `src/modules/activities/activity-metric-rule-binding-audit-recorder.spec.ts` |
| 新增候选 | `src/modules/activities/activity-metric-rule-binding-audit-recorder.ts` |
| 新增候选 | `src/modules/activities/activity-metric-rule-binding-command.spec.ts` |
| 新增候选 | `src/modules/activities/activity-metric-rule-binding-command.ts` |
| 新增候选 | `src/modules/activities/activity-metric-rule-binding.service.spec.ts` |
| 新增候选 | `src/modules/activities/activity-metric-rule-binding.service.ts` |
| 新增候选 | `src/modules/activities/activity-metric-rule.spec.ts` |
| 新增候选 | `src/modules/activities/activity-metric-rule.ts` |
| 新增候选 | `src/modules/activities/controllers/admin-activity-metric-rule-bindings.controller.ts` |
| 新增候选 | `src/modules/activities/controllers/app-managed-activity-metric-candidates.controller.ts` |
| 新增候选 | `src/modules/activities/dto/admin/activity-metric-rule-binding.dto.ts` |
| 新增候选 | `src/modules/activities/dto/app/app-activity-metric-candidate.dto.ts` |
| 新增候选 | `test/e2e/activity-os-r3-c3-1-candidate-concurrency.e2e-spec.ts` |
| 新增候选 | `test/e2e/activity-os-r3-c3-1-candidate-migration.e2e-spec.ts` |
| 新增候选 | `test/e2e/activity-os-r3-c3-1-candidate.e2e-spec.ts` |

排除：清理代码／收据／测试／SOP、旧 C1/C2 parser、生成器与裁判逻辑、旧 migration、生产入口／Gate、真实角色赋码。若来源完整性证明需要新的生产文件，先解释职责和精确路径再更新本表；不把“最终统一”写成无限授权。

### 7.5 一次性红区授权预算（尚未执行）

2026-09-08 对 §7.4 的 87 个精确路径逐个调用现行 `scripts/check-redzone.ts` 的 judge(path,false)，得到 8 个受保护、79 个未命中红区。输入是文件清单，不用 --from-goal 把证据引用文件一并纳入，也不使用工具的目录通配符合并。该读数只回答本地写保护，不代替业务批准、可信 CI 或合并授权。

**只有维护者批准完整实施方案后才执行以下命令；当前文档授权不足以执行。** 工作目录固定如下，八条令牌仅覆盖八个文件：

```bash
cd /Users/dengwang/Documents/coding/srvf-nest-api
pnpm harness:grant 'docs/ai-harness/ROUTE_AUTHZ.md' --reason '维护者确认 C3-1 完整实施方案 A，按计划精确写集'
pnpm harness:grant 'harness/domain-map.json' --reason '维护者确认 C3-1 完整实施方案 A，按计划精确写集'
pnpm harness:grant 'harness/state-machines.json' --reason '维护者确认 C3-1 完整实施方案 A，按计划精确写集'
pnpm harness:grant 'prisma/schema.prisma' --reason '维护者确认 C3-1 完整实施方案 A，按计划精确写集'
pnpm harness:grant 'prisma/migrations/20260908054308_activity_os_r3_c3_metric_candidates/migration.sql' --reason '维护者确认 C3-1 完整实施方案 A，按计划精确写集'
pnpm harness:grant 'src/modules/permissions/permission-catalog.ts' --reason '维护者确认 C3-1 完整实施方案 A，按计划精确写集'
pnpm harness:grant 'test/contract/openapi.contract-spec.ts' --reason '维护者确认 C3-1 完整实施方案 A，按计划精确写集'
pnpm harness:grant 'test/contract/__snapshots__/openapi.contract-spec.ts.snap' --reason '维护者确认 C3-1 完整实施方案 A，按计划精确写集'
```

AI 本轮没有运行任何 harness:grant，也没有创建上述 migration。令牌不授权改旧 migration、扩 API、放宽行为断言或操作任何数据库。基点／红区规则变化时重新核对，不能沿用过期预算。新增一条迁移的预期总数为 116，仅在实际构建并验证时更新当前读数，现状仍为 115。

## 8. 探针与 DoD

| 编号 | 要证明的要求 | 证据 |
|---|---|---|
| P01 | 真零与来源不可用不同 | 可用空集得 0；Gate 关闭／缺链／查询失败拒绝；验证非空对照，先验仪器 |
| P02 | 同人跨岗位／场次只计一次 | 真数据库多 identity、一 member、未到场报名及临时参加反例 |
| P03 | 时间不等于认定 serviceHours | early_departure_zero、重叠／相接、跨日、毫秒舍入与零长边界 |
| P04 | 源事实及规则可复算 | 仅读已持久化受控输入＋旧 evaluator 得相同 value/hash；新规则不能重解释旧值 |
| P05 | 暂存与更正正确 | prepare 不 stale；commit 使旧候选 stale；失败 commit 不改变事实摘要 |
| P06 | 来源一致快照 | 对全部 writer 两连接交错；插入新段、撤销、替换和身份／场次变更不产生混合快照 |
| P07 | 权限当前有效 | 每个锁等待后撤权、用户／成员／组织失效、owner 变化，含重放，均拒绝无部分写 |
| P08 | 幂等与并发 | 同 key 同请求原回执、异请求冲突；不同 key expected revision 竞争仅一笔成功 |
| P09 | 原子性 | 候选值／来源／收据／审计任一步失败全部回滚；旧 Outcome 和正式参与／账本无改动 |
| P10 | PostgreSQL 强约束 | 跨 activity/set/definition/binding 直接 SQL、数量不符、不可变性、安全结果闭集正反例 |
| P11 | 历史与新 API 隔离 | C2 manual/旧收据逐字保留；旧 112→113、113→114 测试继续固定历史目标 |
| P12 | 上限 | 30/500/2000 档，段数和绑定 cap+1 显式失败，绝不静默截断 |
| P13 | 隐私与无外部依赖 | DTO／audit 不含原始来源清单、区间和凭证；无 AI key／网络仍可纯计算 |
| P14 | 工具与 CI | quick、build、contract、新债务／引用方向、全部派生检查及 PR CI；main 结果独立核验 |
| P15 | 历史不可改删 | 数据库直接 UPDATE/DELETE 候选／值／来源／绑定／收据被拒绝；数量始终相符，无清理豁免 |
| P16 | 退队与归档不丢历史 | 退队后原调用者资格失效；现行获权核验者仍可读取与复算历史；归档／更正不删来源 |
| P17 | 旧规则可复算 | 新 evaluator 上线不改变旧结果；旧输入和规则仍可重算相同值／hash，来源缺失明确 unavailable |

P01–P17 不以结构字符串断言代替数据库行为。先跑旧行为 characterization 再动编排；既有 E2E 断言若需改变，单列人话简报，不能当普通计数刷新。

## 9. 授权与实施门

本稿下一次评审需集中确认：①两规则筛选／开放段／零长／Gate 边界；②最小来源快照保存与访问／退队制度；③绑定治理及新权限；④来源一致性闭包与精确 owner 接口；⑤最终模型键／FK／收据和逐文件写集。

② 已按最新决定明确长期保留、不删除，不再要求清理角色／期限选择；④⑤ 的静态设计、路径及验收要求现已汇总，仍需整体评审和获批后的运行验证。本轮不实施、不操作数据库、不修改冻结归档。红区授权由维护者发放，AI 不自行 grant。

未来测试建议仅使用 app_test_w98；须重新取得当次明确授权。禁止自动 migrate dev/reset/db push；仅获批 deploy／隔离库重建。生产、Gate、真实清理、目录正式数据、人员赋码、跨模型整体复审、实施 PR 合并都不在当前授权中。

### 9.1 留存决定的修订记录

先前 AI 建议三年后人工清理，维护者曾同意据此完善文档，随后明确提出“不删除”，说明历史数据是宝贵资产。最新决定取代旧清理方向；旧讨论只保留这条修订说明，不继续保留可执行的到期清理方案。清理从未实施，未删除任何数据。

### 9.2 当前生效的文档设计方向

候选值、计算明细、内部关联和规则版本长期保留，支持历史核验与复算；退队只影响访问资格，不删除既有参与证据。无三年到期、归档倒计时、purged 状态、清理收据、清理工具或延期审批。访问仍按当前资格逐请求验证，明细不进入普通列表、日志或 AI 上下文。

不因“不删除”扩大采集范围，只留已说明用途的最小计算输入；容量与备份需求以后据测量处理，当前没有测量数据库空间。产品留存选择不是上线合规审查结论，遇适用要求冲突需独立报告，不擅自删除。

### 9.3 集中审批清单与责任分界

以下是剩余事项的统一入口，不要求维护者逐个回答数据库术语，也不将“同意文档方向”误记成代码或删除授权。

**已确认，不重复请示**：C3 分候选计算与正式确认串行实施；本轮仅文档；候选计算明细长期保留、不删除，退队不抹去历史，继续保有复算能力。

| 阶段 | 集中提交的事项 | 当前状态／谁负责 |
|---|---|---|
| 完整方案评审 | 实际人数／时长的筛选、整数／小数及单位绑定、开放段拒绝、Gate 关闭时不可用、规模上限 | §3 已有建议；由 AI 将全部边界与反例一次呈交，维护者批准产品口径，不逐函数请示。 |
| 完整方案评审 | 新绑定／计算权限只人工赋予；独立候选和绑定审计；保留全部旧 C2 合同 | §6–7 已有精确候选；治理集合断言变化须随同批批准，不能作为摘要刷新偷偷修改。 |
| 实施前技术收口 | 全部来源 writer 的事务引用闭包、最终 FK／触发器／查询预算、六模型及派生文件的精确清单 | AI 负责，不让维护者替代源码核验。当前仍未全闭合，不伪称“只差授权”。新增 migration 精确路径在实际建档前核定，不复用 115。 |
| 一次性实施授权 | 本稿整体方案、§7.4 全部路径、P01–P17、隔离测试库、提交／推送／PR 边界、§7.5 八条精确命令 | 待维护者整体批准。令牌由维护者发放；AI 不自行 grant。普通测试与范围内修复连续推进；新增业务选择仍须报告。 |
| CI 与合并 | 新 migration 3b、实际权限／审计读数 4b、PR 合并 | 按真实结果签字，当前不预签、不预报全绿；不把允许创建 PR 当作允许合并。 |
| 真实执行 | 生产部署、Gate、人员赋码、备份与恢复 | 全部独立批准，不在当前文档或未来一般开发授权内；本方案不包含真实数据删除。 |

计划中的“六模型”为 §4 列出的规则绑定、候选、候选值、候选来源、候选命令收据及绑定命令收据，不是当前数据库计数。SQL 拟用名称、挂载／闭集、迁移候选目录及 87 个路径已列出，供集中整体评审；不使用通配符替代。

下一步是继续完成技术收口并呈交一份可读的整体评审，不再要求维护者确认已经否定的删除功能；本轮没有提交／开 PR 授权，文档保持本地工作稿。

## 10. 起草时点未做（已由 §11 的实施记录覆盖）

以下是获批实施前的历史记录：当时未实施 C3-1/C3-2，未增加模型／migration／权限／接口／DTO，未改业务代码／旧测试／schema／CI，未操作任何数据库，未提交推送或开 PR，未运行外部模型，未开启 Gate。已按“不删除”决定汇总为待整体评审版；数据库同链／完整性／并发、全量业务验收尚未运行，不把计划及静态检查当作开发完成或生产可用证明。

## 11. 获批后的实施记录（2026-09-08，覆盖前文起草时点状态）

### 本轮验证进展与待补授权

- 四个新接口已接入；离线 OpenAPI 对照既有路径／schema 均无语义变化，仅新增四个操作、六个 schema。全量 contract 1026 条、两份快照通过。
- 仅 app_test_w98：真实 HTTP／数据库 21 条、真实锁等待并发 9 条、非空 115→116 升级及约束 20 条，共 50 条通过。新增来源后旧候选明确转 stale，原候选快照仍可复算；候选命令会等待 Activity 锁并在来源 writer 原子提交后只写入完整新来源；迁移升级及重复 deploy 保留旧目录、成果、值和旧收据逐字节不变；六类不可变记录的 UPDATE/DELETE 拒绝已实测。
- 历史读取／绑定／两类审计四组单测 29 条通过；query 另覆盖指标集退役时 stale、来源暂不可用时仍可历史复算、锁后失效与隐私闭集。类型检查通过；当前阶段不等于 P01–P17 全部完成。
- 现算 43 模块、118 controller、605 endpoint、116 migration、523 BizCode、256 权限、164 Audit events（159 活跃、5 零产出）；模型 149、状态列 67，metadata 与新增债务检查通过。3b/4b 尚未重签。
- quick 曾报三条失败：冻结读数已刷新；权限登记基线缺两新码及两条读码的新增接口；harness 两条真实计数仍固定 254。状态机表总数已同步 67。没有修改或绕过这些检查。
- **补授权已落实**：`harness/permission-surface-baseline.json` 已由生成器登记两新码及两条既有读码的新增接口面；`scripts/harness-guards.selftest.ts` 仅将真实权限计数与注释 254→256，不改断言。二者均有维护者精确 grant；`changelog.d/activity-os-r3-c3-1-candidates.md` 未获授权，未创建，也未直接改 Unreleased。
- 已完成 16 份既有迁移测试当前回放计数 115→116 适配，历史 112→113、113→114 升级目标未动；已补候选 Presenter 和 calculate 独立授权单测。P05 的真实更正 prepare、失败 commit 回滚、正式 commit stale 已通过；P06 已覆盖直接来源 writer、真实服务段更正 commit、现场提前离场与现场作废两向 Activity 锁交错。离线 package／review、结算重投影和全部身份／场次变更 writer 的两连接交错，以及真实查询计划，仍未完成；不把现有回归当作覆盖它们。

- 维护者确认完整方案及 §7.4 写集、app_test_w98 验证与重建、验证后提交／推送／创建 PR；八项红区令牌已核验。本批不合并、不启用 Gate、不操作生产或删除业务数据。
- 分支 `codex/activity-os-c3-1-candidates`；五份前期计划／台账先保存为 `8c1c8cd9`，随后 global preflight 通过。此提交仅保存起草成果，不代表实现完成；尚未推送或创建 PR。
- 已写入两条纯规则、稳定来源分组和指纹、精确区间并集／单次 HALF_UP、两个独立命令与安全收据解析器。复用 C1/C2 canonical/hash/value 校验，不改旧解析器。
- 六模型及引用键已进入 schema；Prisma validate 和生成通过。新 migration 为 `20260908054308_activity_os_r3_c3_metric_candidates`，不改旧 migration。新增约束／不可变性与来源、收据、数量触发器仍待完整行为验收。
- 现场确认 app_test_w98 不存在后，仅创建该隔离库；通过现行 assertTestDatabaseUrl 与精确库名检查后执行 migrate deploy，116 条冷迁移成功，查询确认最新 migration 正确、13 个触发器已挂载。未触碰 app_test、w1、生产或实际业务数据；未运行 migrate dev/reset/db push。
- 考勤属主新增最小有界查询与模块导出；活动来源查询已经编写，区分 draft 投影与 committed 批次／正式更正。其本地单测现为 10 条：新增“精确前代＋已应用更正链才可读取”和“旁路 stale draft 仍拒绝”两条。真实 Activity 锁交错现覆盖：候选等待来源 writer、候选等待正式更正 commit、候选等待现场提前离场，以及候选先提交、现场作废等待；每项都在释放后检查只读到完整事务边界的来源。P05 已完成；P06 仍缺离线／重投影及其余 writer 的两连接交错和查询计划验证，不能刷成全覆盖。
- 首批 6 组定向单测 99 条通过（新规则 23、命令 43、考勤属主 8、旧成果访问／值 25）；另来源查询 9 条通过。初次误用未带仓内配置的 jest，没有执行测试，已改用 pnpm test；新测试日期及类型断言 lint 问题已修复，不改裁判。
- 已完成快速门禁：lint、三套 typecheck、343 个单测及两套 harness selftest 均通过；`docs:authz:check`、`docs:codemap:check`、边界检查、新债务检查通过。受影响的 C2 当前回放已在 w98 验证；其余旧迁移用例会创建 w86/w87 scratch 库，超出本轮测试库授权，未再运行。曾误启动该批跑，发现仍在后台后立即终止；数据库清点确认未创建 w86/w87，w98 已重建为 116 条迁移。P05 已核验；P06 余项和查询计划仍须继续逐项核验。3b／4b 不预签；当前不是可交付版本，P01–P17、全量 CI 和整体复审尚未完成。
- 另以同一 w98 重跑既有正式 writer 回归：现场打卡运行 9 条、现场并发 7 条、离线 package／review writer 22 条均通过。该 38 条回归证明本批未破坏既有正式写链；它们没有把候选请求插入离线／重投影事务，故不替代上一条列明的 P06 剩余交错。
