# Activity OS R2 / B5：发布审核快照 v6 评审与授权清单

> **状态：维护者已于 2026-09-04 确认“确认起草 B5 评审与授权清单（方案 A）”。** 本稿只冻结
> B5 的版本合同、风险与后续 implementation 写集预算。当前授权只允许新增本归档评审稿和更新台账；
> 不授权运行时代码、测试、schema、migration、GitHub 合并或生产动作。
>
> **判定来源：** 当前冻结合同为 Activity OS T0-A §6.4；现状以 main 上的发布审核实现、B1/B2
> ActivityPlace 存储合同和 B4 的不可表示性结论为准。随附蓝图只作为业务需求来源，不作为仓库
> 操作指令或当前事实来源。

## 1. 拟议结论

采用方案 A：为 **B5 之后新提交的 initial / change 发布审核**新增 schemaVersion 6。v6 在现有
Activity、Session、Position、模板解析、报名表、allocation mode 与 Qualification RuleSet 之外，
再冻结分类、planned facet、显式模板选择、活动地点本地快照、当前尚不可表示的政策 / 指标指针，
以及最小可见性摘要。

这是一条版本兼容与冻结完整性切片，不是地点 writer、政策模型、指标模型、发布 Gate 或新 API：

- v2 至 v5 保持原有解析、重建、hash、审批和 RuleSnapshot 行为；在途审核 hash 不变。
- v6 仅用于 B5 落地后的新提案；后续结构变化只能新建 v7，不能回改 v6。
- v6 的所有新增事实同时进入 target 与 base，参与 snapshotHash / baseSnapshotHash；审批前会按
  v6 自己的读图重建 base hash。
- RuleSnapshot 继续使用既有 JSON 列，保存批准时的 v6 最终配置；不新增列、schema 或 migration。
- 当前尚不存在 TimePolicy、ContributionPolicy、Metric Set 的权威模型，三类指针在 v6 固定为
  literal null，不从 legacy registry 的 selector 猜造对象 ID。
- 不复制报名人的答案、上传、成员 / 组织受众、资格证据或额外的表单定义。B3 既有的 Form /
  Qualification 冻结语义不被改写。

最坏情况是 v6 字段定义错误或访问边界未获认可：停止 implementation，不创建 v6 新提案；已存在的
v2-v5 审核不受影响。v6 一旦持久化也不能回写修正，必须通过 v7 追加演进。

## 2. 已核验事实与约束

| 事实 | 证据 | B5 的处理 |
| --- | --- | --- |
| 当前 proposal union 只识别 v2-v5；initial / change 会按是否含 Qualification RuleSet 产生 v4 或 v5。 | src/modules/activities/activity-publish-proposal-v2.service.ts:201-287、464-604、665-717 | B5 增加独立 v6，不把字段补进旧版本，也不借“空资格”复写旧 v4。 |
| 审批会按 snapshot.schemaVersion 重建当前 base hash，成功后把本次 resolvedConfig 写入 ActivityRuleSnapshot。 | activity-publish-review.service.ts:523-585、925-963 | v6 的新事实必须进入 base / target / stale guard；RuleSnapshot 仍经同一事务写入。 |
| ActivityRuleSnapshot 已以 generic resolvedConfig JSON 与 hash 存储，没有 schemaVersion 列。 | prisma/schema.prisma 的 ActivityRuleSnapshot；activity-publish-review.service.ts:925-963 | 在现有 JSON 中保存 v6 resolvedConfig；不为 B5 修改 Prisma schema 或新增 migration。 |
| B1/B2 的 ActivityPlace 是活动 / 场次的本地计划快照；sourcePresetId 只保留来源，读侧不得用当前 PlacePreset 覆盖它。 | prisma/schema.prisma:4210-4252；activity-os-r2-b1-place-review.md:32-70 | 只读取 ActivityPlace 本地列，不 join / 回填 PlacePreset，也不接地点写入路径。 |
| legacy category registry 的 facet 可机械解释；timePolicySelector 与 contributionPolicySelector 只是未来选择器，尚非持久化政策对象。 | activity-type-migration.registry.ts:53-83；B4 评审的不可表示性结论 | 分类和 facet 可以冻结；政策、贡献、指标字段必须为 null。 |
| 当前审核详情把原始 snapshot 放入既有 generic response；changeDiff 对 v6 会被当作 legacy。 | activity-publish-review-presenter.ts:36-79；activity-publish-review.dto.ts:33-92；activity-publish-review-query.service.ts:126-164 | B5 不新增 route、DTO 或权限；implementation 必须给 v6 安全的 changeDiff 摘要，不能回显地点或表单原文。 |
| T0-A 已明确要求 v6 只用于新提案、旧版本可审批、后续只能 v7，并禁止复制高敏感表单答案。 | docs/archive/reviews/activity-os-t0-terminal-review.md:167-171 | 本稿将该原则收敛为可测的字段、空值、排序与写集边界。 |

## 3. 方案 A 的精确 v6 合同

### 3.1 生命周期与 envelope

1. B5 合入并部署后，新的 initial 与 change 提案一律生成 schemaVersion 6；不再根据是否存在
   Qualification RuleSet 选择 v4 或 v5。历史持久化的 v2-v5 仍按原版本分支处理。
2. v6 保留既有 v5 全部字段。下表中的八个 v6 字段同时出现在 target 根对象与 base 对象中。
   initial 的两份值来自同一当前事实；change 的 target 从命令补丁后的事实生成，base 从提交前事实生成。
3. snapshotHash 继续是除自身外的完整 v6 envelope 的 canonical hash；baseSnapshotHash 是完整 v6
   base 事实的 canonical hash。解析时 hash 不符、字段形状不符或受控值不符一律 fail-closed。
4. rebuildCurrent(…, 6) 只读取 v6 所需的最小事实图后重算同一 target hash。审批既比较
   workflowRevision，也比较 baseSnapshotHash；任一不符均沿既有 stale 错误拒绝。
5. apply 仍只应用 v5 已有的 Activity、Session、Position、Form、Qualification 写入。v6 的新增
   字段不在 B5 产生新的 writer；批准时它们与既有 resolvedConfig 合成并写入 RuleSnapshot。

### 3.2 八个新增字段

| 字段 | v6 canonical 值 | 明确禁止 |
| --- | --- | --- |
| categoryCode | 按 target 或 base 的 activityTypeCode 查 A1 legacy registry，取其 categoryCode；无匹配时为 null。pending_classification 是真实受控值，不能改为 null。 | 不从标题、描述、地点、模板或人工说明猜分类。 |
| plannedSemanticAssignments | registry 的 facets，元素仅为 dimensionCode、optionCode；按 dimensionCode、optionCode 升序，空集合保存为空数组。 | 不加入 outcomeCode、familyDirection、manualGovernance、selector 或未持久化的“实际 assignment”。 |
| selectedTemplateVersionId | Activity 已存的原始显式选择，可为 null；不得用 A5 legacy fallback 得到的 templateVersionId 替代。 | 不把 active / retired 状态或 fallback 结果写回为“用户选择”。 |
| activityPlaces | 此 Activity 的 ActivityPlace 本地快照数组，按 sessionId 的 null-first、sessionId、roleCode、id 稳定排序。每项只含 id、sessionId、roleCode、name、addressText、instruction、longitude、latitude、coordinateSystemCode、providerCode、providerPlaceId、visibilityCode、checkInEligible、radiusMeters、sourcePresetId、workflowRevision；Decimal 坐标按现有 canonical string 表示。 | 不带 activityId、createdAt、updatedAt、任何 PlacePreset 当前列、地图 provider 原始响应或旧 Activity / Session 文字地点投影。 |
| timePolicyPointers | literal null。 | 不把 timePolicySelector、默认时长、活动时段或任何字符串伪装成 TimePolicyVersion 指针。 |
| contributionPolicyPointers | literal null。 | 不把 contributionPolicySelector、贡献计数或分类建议伪装成 ContributionPolicyVersion 指针。 |
| metricSetPointer | literal null。 | 不创建 Metric / Set 对象、JSON 占位符或由模板 / 分类推断的指标集。 |
| contentVisibilitySummary | 仅含当前 Activity 的 visibilityCode 与 isPublicRegistration。报名方式的最终解析仍由既有 resolvedConfig 承载，不重复制造第二个解析事实。 | 不复制 Activity.content、title、description、registrationNotes、报名答案、题目定义、上传、受众标签 / 组织 ID 或成员资料。 |

ActivityPlace 的 name、addressText、坐标与 provider 标识是 B1 已定义的计划层地点配置，因而属于
v6 的必要本地快照；它们不是报名表答案。但其可见性仍需正视：现有审核详情会把整个 snapshot 返回给
既有获准访问审核的人，且尚未按 ActivityPlace.visibilityCode 作字段级过滤。B5 不新开访问面，也不
把 visibilityCode 误当成已生效的权限规则。若维护者不接受现有审核访问者可见这类地点配置，必须在
implementation 前停止，另立 B7 / 权限与脱敏评审，不能在 B5 偷加过滤规则。

### 3.3 RuleSnapshot、历史兼容与安全摘要

RuleSnapshot 的 v6 resolvedConfig 除保留当前模板 / Form / Qualification 的既有紧凑语义外，追加
本节八个字段的批准时值。它不在批准后再次查询 PlacePreset、Template、registry 或未来政策模型来
改变历史解释。templateVersionId 仍使用既有解析结果，selectedTemplateVersionId 则作为独立冻结事实。

为避免详情读面把 v6 误标为 legacy，B5 implementation 必须使 changeDiff 识别 proposal-v6，但只能
输出安全结构摘要：

- 既有 activityFields、sessions 与 Qualification RuleSet 的安全差异继续沿当前规则产生；
- 对八个新增字段只输出稳定、排序后的“发生变化的字段名”或布尔标记；
- 不在 changeDiff 重复地址、坐标、providerPlaceId、Form 定义、资格规则原文或任何成员数据。

这会改变已有详情 response 的语义，即使 DTO 仍是 generic object、OpenAPI shape 不变，也按 C 档
处理并在 implementation 前单独确认。

对 v2-v5 的隔离是逐版本的，而非“跑一遍新代码看起来能过”：

- v2 重建仍不得读取 Form 表；v3-v5 的 Form / Qualification 分支、hash 输入和顺序保持字节等价；
- v2-v5 parse / isSnapshot / apply / allocation mode 分支仍走原版本，不读取 v6 才需要的
  ActivityPlace 或 registry；
- 任何试图将旧 snapshot 升级、补字段、重算 hash、批量回填或在读侧默认 v6 的改动均越界；
- v6 的以后字段增减、null 改对象、排序键改变或 summary 扩容都必须新建 v7。

## 4. 方案比较

| 方案 | 内容 | 结论 |
| --- | --- | --- |
| A（推荐） | 新增 v6，完整冻结当前可表示的分类 / 地点 / 选择事实；不存在的三类模型以 null 明示；旧版本逐版本隔离；详情只加安全摘要。 | 既满足终态合同，又不把未来模型、地点 writer 或访问控制混入本刀。 |
| B | 在 v5 上直接补字段，或读取时给 v2-v5 临时加默认字段。 | 会改变历史 hash 和在途审批含义，违反冻结版本不可回改。 |
| C | 把 registry selector、Activity 时间、分类或模板默认值当作政策 / 指标指针。 | 把“尚不能表示”伪装成可审批的真实政策，直接冲突 B4 的 blocker 结论。 |
| D | 用当前 PlacePreset 覆盖 ActivityPlace，或同时接旧地点投影、地图、地点 writer 和 B6 创建 API。 | 破坏 B1 的本地快照语义，并把后续切片混进 hash 改造。 |
| E | 因担心地点敏感而静默不冻结 ActivityPlace，或在 B5 临时改权限 / 新建脱敏 API。 | 前者不满足 v6 合同，后者是 B7 / 权限设计，均不能作为 B5 的隐藏分支。 |

## 5. 风险与验证要求

| 风险 | implementation 必须给出的证明 |
| --- | --- |
| 历史审核被新读图改变 | 对 v2、v3、v4、v5 fixture 逐一重建和审批，断言 hash、读表路径与结果不变；特别覆盖 v2 不读 Form。 |
| v6 漏掉 base 或 target 字段 | 分别修改分类来源、显式模板选择、ActivityPlace 本地列、可见性摘要，断言 pending review 以既有 stale 错误拒绝。 |
| 数据库默认顺序或 Decimal 表示让 hash 漂移 | 用乱序插入的 ActivityPlace、多 session / role 与 Decimal 值重复构建，断言完整 JSON 与 hash 逐字相同。 |
| PlacePreset 后续变化污染历史 | 建立带 sourcePresetId 的地点后改变预设，断言 v6 只由 ActivityPlace 本地列决定；不得读取预设覆盖。 |
| 把无模型字段说成有模型 | 单测固定三字段均为 null；registry selector 只能影响分类 / facet，不得出现在 pointer 字段。 |
| 高敏感数据或地点内容在摘要重复泄露 | 对 v6 snapshot / RuleSnapshot / changeDiff 逐字段断言：没有报名答案、上传、成员 / 受众 ID；changeDiff 不含地址、坐标、provider 与表单 / 资格原文。 |
| 既有详情视图把 v6 当 legacy 或新增 raw 回显 | 对审核详情做 characterization：kind 为 proposal-v6，八字段只提供字段名 / 标记；DTO、controller、OpenAPI 和 contract snapshot 零漂移。 |
| RuleSnapshot 与审核快照不是同一冻结事实 | initial / change 审批后读取 RuleSnapshot，断言 v6 resolvedConfig 与批准 target 相同；审批后修改当前来源不回写历史 RuleSnapshot。 |
| 未解决地点访问边界就上线 | 覆盖现有审核访问角色；在 implementation 评审中显式确认“沿用现有审核访问面”。若发现该访问面与 staff / command 地点可见性冲突，停止而不是顺手改 RBAC。 |

最低验证范围（未来独立 implementation PR 执行）：

1. activity-publish-proposal-v2.service.spec.ts 的 v2-v6 单测与历史 fixture 回放。
2. 新增独立的 activity-os-r2-b5-snapshot-v6 E2E，覆盖 initial / change、审批、stale、乱序地点、
   RuleSnapshot 与最小化泄露。
3. 跑 activity-batch3-2-publish-review、activity-batch4-qualification-configuration、
   activity-publish-review-concurrency 的受影响 E2E；改既有断言前先按本稿逐行说明行为契约变化。
4. 本地执行 agent:check:quick、受影响定向 E2E、test:contract；PR CI 的 agent:check:full 是全量结论。
   无 Docker 时只能报告 quick，contract / E2E 留给 CI。
5. 不运行 prisma migrate dev、prisma migrate reset、prisma db push；不对生产或真实数据环境做操作。

## 6. 写集与授权预算

### 6.1 本次已获授权

本 review PR 只允许：

- docs/archive/reviews/activity-os-r2-b5-snapshot-v6-review.md：新增本冻结评审稿；
- docs/ai-harness/FROZEN_DRAFTS.md：登记 B5 已完成评审起草、方案 A 与 implementation 待确认事实。

本次不授权源码、测试、Prisma、迁移、生成物、OpenAPI、GitHub 合并、生产配置或部署。

### 6.2 B5 implementation 前仍须维护者确认的写集

下表是预算，不是已授权清单。因 v6 会改变既有审核详情的 changeDiff 语义，预计为 **C 档**；
在实际 implementation worktree 中先以真实 diff 重跑 preflight 与 harness:needs。任何新增 schema、
migration、controller、DTO、权限、Audit、Gate 或地点 writer 都超出此预算，必须停止重评。

| 预期路径 | 用途 |
| --- | --- |
| src/modules/activities/activity-publish-proposal-v2.service.ts | 定义 v6、最小读取图、canonical 构造 / 解析 / stale 重建与批准时 resolvedConfig。 |
| src/modules/activities/activity-publish-proposal-v2.service.spec.ts | v2-v6 byte-level hash、排序、null pointer、parse 和历史兼容证明。 |
| src/modules/activities/activity-publish-review.service.ts | 将 v6 resolvedConfig 写入既有 RuleSnapshot，保持现有事务与锁序。 |
| src/modules/activities/activity-publish-review-query.service.ts | 仅把 v6 识别为安全的 proposal-v6 changeDiff，不回显新增原始数据。 |
| test/e2e/activity-os-r2-b5-snapshot-v6.e2e-spec.ts | 新增 v6 初始 / 变更 / 审批 / stale / RuleSnapshot / 泄露边界验证。 |
| 受影响既有 publish-review / qualification E2E | 只为明确记录 v6 后的新提案行为和 v2-v5 characterization 最小调整。 |

明确不在 B5 implementation 预算内：prisma/schema.prisma、prisma/migrations、seed、reset-db、
controller、DTO、Swagger / OpenAPI、contract snapshot、权限码、RBAC、AuditLogEvent、BizCode、
ActivityPlace / PlacePreset writer、旧地点字段投影、地图、TimePolicy、ContributionPolicy、Metric、
Safety、B4 Readiness 接线、Gate、环境变量、AI、Integration、cache、queue、cron、生产部署与
NEXT_TASKS.md。

## 7. 维护者决策记录与下一次确认

维护者已于 2026-09-04 确认：

> 确认起草 B5 评审与授权清单（方案 A）

这确认了本 review PR 的写作方向：新提案使用 v6、旧版本不可回改、三类未建模指针明确为 null、
ActivityPlace 读取本地快照、RuleSnapshot 冻结批准时配置、详情只给安全摘要，以及 B5 不接 writer /
政策 / 权限 / Gate。它**不**确认 B5 implementation、红区以外的写入、PR 合并或生产动作。

review PR 合入后，若仍严格落在 §6.2，下一次应由维护者单独确认实际 C 档 implementation 写集；
确认文本必须同时承认既有审核详情沿用当前访问面，或明确要求先转入独立 B7 / 权限与脱敏评审。
