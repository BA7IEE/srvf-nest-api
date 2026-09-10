# Activity OS D1-3：四级时长政策选择与发布冻结实施计划（评审草案）

> 2026-09-11，依据 main `ba100c1e`。维护者已确认 D1-3 精确计划方案 A，允许补充 changelog、提交、推送并创建计划 PR；不合并、不实施。本次写集仅八份文档，140路径为后续实施清单，不是本轮写入许可。本文不能充当红区 grant 或数据库授权。

> **历史续写授权**：维护者此前允许保留七份未提交文档继续完善计划，不修改门禁规则；当前文档提交权限以上条追加确认为准。下文“推荐/待确认”描述方案起草过程，方案 A 已确认，但实施、数据库操作和合并仍未获批准。

## 1. 已完成与本批目标

D1-1 数据基础已合并 #1310，D1-2 Human 目录八操作已合并 #1312。#1312 的主干测试初始化问题经 #1313 修复；main `ba100c1e` 的 CI run 34498288827 成功。当前 154 模型、118 迁移、620 端点、260 权限、166 审计事件总计/161 活跃。此基线不是 D1-3 的预计终态计数。

D1-3 必须完整交付模板→活动→场次→场次岗位四级选择、最近完整引用覆盖、模板 V4、新提案 V8、Readiness、批准冻结和变更审批。不得只做活动一层，也不得只增加 JSON 解析后宣布完成。D2–D8 的实际秒数、分类分配、桶、shadow、独立账本、更正和证明均不在本批。

## 2. 已核验的接入点

| 当前入口 | 事实与实施要求 |
|---|---|
| `activity-template-definition-v3.ts` | V3 严格四根键，复用 V2 并加入 metricSelection。V4 必须独立分支，不放宽 V1–V3。 |
| `activity-publish-proposal-v2.service.ts` | 当前支持 V2–V7；timePolicyPointers 类型及校验仍限定 null。所有分支应按语义逐一接入 V8，禁止字符串批量替换版本号。 |
| `activity-publish-proposal-v7.ts` | 指标选择、revision 与历史零版本有独立兼容合同。V8 保持这些语义，不修改 V7。 |
| `activity-publish-readiness.service.ts` | 当前无条件增加 TIME_POLICY_UNREPRESENTABLE；只有完成本批真实解析才可对有效新选择取消此项，其他问题照常保留。 |
| `activity-metric-selection-access.ts` | 现有指标写资格复用 activity.update.record，且有 SA 例外。这不是本批权限批准依据，不能原封照搬成时长选择访问合同。 |
| `prisma/schema.prisma` 的 ActivitySessionPosition | 岗位持有 activityId/sessionId，已有场次复合 FK；必须使用场次岗位，不能使用旧 ActivityPosition。 |
| TimePolicyVersion | 已有 `(id, policyId, definitionHash)` 唯一锚、不可变定义和 active/retired 生命周期，可复用；不新增同义政策模型或第二套 hash。 |

## 3. 推荐数据合同 A

推荐“活动级不可变选择修订 + 分层明细 + 专用命令收据”，不把三个层级的可变 JSON 分散写入现有模型。理由是同一修订能原子描述四层选择、保留完整历史，并被发布快照引用。

拟新增三个模型，命名在实施批准前固定：

1. `ActivityTimePolicySelectionRevision`：id、activityId、revision、schemaVersion、selectionHash、selectionJson、itemCount、templateId（可空）、templateDefinitionHash（可空）、originCode、creationReceiptId（可空）、seriesOccurrenceId（可空）、publishReviewId（可空）、proposalSelectionHash（可空）、createdAt、createdByUserId。唯一 `(activityId, revision)`、`(id, activityId)` 及 `(id, activityId, revision)`；revision 正整数、schemaVersion 固定 1；模板身份/hash 同空同有。引用指定不可变模板版本，不查询 family 最新版本。Activity 新增 `timePolicySelectionRevision` 默认 0 和可空 `currentTimePolicySelectionRevisionId`，复合 FK 保证同活动；0/null 只代表历史未配置。
2. `ActivityTimePolicySelectionItem`：id、selectionRevisionId、activityId、layerCode、sessionId（可空）、positionId（可空）、mode、policyId/versionId/definitionHash（同空同有）。layerCode 为 template/activity/session/position；template、activity 不得携带场次岗位 ID，session 必须且仅有 sessionId，position 两者齐全。revision/activity、session/activity、position/activity/session 和 policy/version/hash 均以复合 FK 保证同链。不同层使用部分唯一索引，禁止依赖 nullable UNIQUE 判断重复。mode 为 inherit/explicit；explicit 三指针必填，inherit 三指针必空。
3. `ActivityTimePolicySelectionCommandReceipt`：id、actorUserId、activityId、operationCode、operationKey、requestHash、selectionRevisionId、resultJson、createdAt。唯一 `(actorUserId, operationCode, operationKey)`，revision/activity 复合 FK；收据不可更新删除。operationCode 固定 `patch_time_policy_selection`，不复用目录 create/activate/retire。resultJson闭合为 `{activityId,selectionRevisionId,revision,selectionHash,createdAt}`，不返operationKey、requestHash或actor；提交时核对修订、创建者及五键内容。请求hash包括operationCode、actor、activityId、expectedRevision和排序后的changes，不含operationKey与命令时间。

三表业务字段从写入起不可变，不提供删除、清理、过期或退队级联。新增 revision 的事务同时写明细、当前指针、审计及对应来源凭据；只有standalone命令新增专用选择收据，创建/审批复用外层凭据。使用延迟约束/触发器验证提交时完整性；根层恰一行、明细归属、hash格式/引用与当前修订递增分别设数据库探针。命名见§3.3，业务错误见§4。

校验职责澄清：上述 hash 的数据库探针指格式、三元引用及同链字段相等，不等于数据库重算应用 canonical。现有 `activity-template-definition.ts:145–197` 定义对象键 UTF-16 排序、数组保序及 `{definition,schemaVersion}` envelope，明确由 writer 重算 SHA256；`activity-time-policy-definition.ts:1–4` 直接复用。推荐本批沿用这一职责：应用在写入、读取解释及批准前严格解析并重算 selectionHash；数据库验证不可变内容、明细与父内容相等、引用同链和收据一致。不新增 PostgreSQL canonical 函数或把 `jsonb::text` 当作同一序列化；语义 hash 篡改由独立应用负例验证，不能写成 SQL 已证明全部语义。

已核验的 FK 列顺序：明细 `(activityId, sessionId)` 引用 ActivitySession `(activityId, id)`；岗位明细 `(activityId, sessionId, positionId)` 引用 ActivitySessionPosition `(activityId, sessionId, id)`；版本 `(versionId, policyId, definitionHash)` 引用 TimePolicyVersion 同序三列。ActivityTemplate 目前只有 code/version 与 familyId/version 复合唯一，没有 id/hash 唯一锚；本方案须新增 `@@unique([id, definitionHash])`（拟名 `activity_template_id_definition_hash_key`）后，修订 `(templateId, templateDefinitionHash)` 才可建立真实 FK。历史 template 的 hash 可空保持不变，新的来源二元组必须同空同有，不能把单 id 引用误写成 hash 已由数据库校验。上述均是未来 migration 计划，本轮不修改 schema。

备选 B 是在 Activity/Session/Position 增加可变指针并另外保存日志。它对当前读取较直接，但需要三处 revision 与历史一致性维护；不推荐，不能以省略历史修订替代 A。

### 3.1 选择语法与解析

历史封闭要求：禁止 UPDATE/DELETE 还不够，必须防止事务结束后给旧 revision 追加新 item。推荐父修订保存不可变 `itemCount` 与 `selectionJson`，其中明细为按 layer/session/position 三元键编码的对象，不依赖数组顺序或拼接分隔符。每个 item 的 BEFORE INSERT 检查其完整业务投影与父 JSON 对应键完全相等，未知键拒绝；父修订的延迟 INSERT 检查只在提交时执行一次，验证 JSON 键数、itemCount、实际行数和根项。部分唯一索引保证每个目标至多一行，因此后续追加只可能是“已占用键”或“不在父清单的键”，两者都拒绝，不需要对每条 item 重新聚合全部明细。SQL 的 JSON 类型/NULL 分支必须 fail-closed，不能让 CHECK 的 UNKNOWN 通过。应用只对这份规范化选择求 hash，不另造数据库 canonical。当前 Activity 引用建议使用 `(currentTimePolicySelectionRevisionId, id, timePolicySelectionRevision)` 到修订 `(id, activityId, revision)` 的三列 FK，额外提供该唯一锚；CHECK 保证历史 0/null 和已配置正整数/非空两种形状。已配置不得清零、降版本或跳过修订；新修订必须继承上一版本并原子切换。独立测试追加旧明细、伪造计数、同 revision 换 ID、跨活动、清零/降号和未切换孤儿修订。

提交完整性探针必须拆开：缺活动根项、缺模板根项、重复层目标、当前指针与 revision 数字不符、收据引用别的活动、收据 hash 不符分别独立事务验证，不放在同一个首错即停用例中。根项定义为 activity 恰一行；template 仅在有指定模板来源时恰一行，无来源则零行。场次/岗位 inherit 可省略，因此不得把“明细行数等于全部岗位数”当作完整性不变量。

延迟检查分工：修订 INSERT 事件负责核验该次新修订有合法来源、完整明细且已成为本次提交的当前选择；item INSERT 的即时检查仅比较其父清单对应项，不要求旧修订永久保持 current；Activity 指针改变事件只核验 NEW 引用及合法递增，不逐份扫描历史修订。普通标题/展示字段更新不触发选择写入要求。新增第二修订后，旧修订及旧 RuleSnapshot 仍能原样读取，作为必要正向探针；否则一个“历史必须等于当前”的错误约束会把正常修订流程锁死。全量明细计数每份新 revision 只做一次，不以逐条延迟触发器全表聚合实现。

创建/复制/Series 与发布批准复用下文明确的外层来源锚，不强制客户端另外发送 select 幂等键。只有 standalone select 创建本批专用命令收据；其他来源在同一外层事务保留其真实凭据与审计，并由 originCode 分支核验。不把“无需新增客户端键”误写成“外层成功凭据不需要校验”。

外层来源核验结果：专业/紧急创建由 ActivityCreationCommandReceipt 提供 `(id, activityId)` 复合锚；快速/传统模板复制使用 Activity 上 A6 创建幂等字段，并非统一的创建收据表；Series 单次活动由 ActivitySeriesOccurrence 的唯一 activityId 和 series/occurrenceKey 绑定；批准依赖 ActivityPublishReview 的 reviewOperationKey/reviewRequestHash 与状态，而非独立批准收据表。因此不能把所有入口都建 FK 到 ActivityCreationCommandReceipt。推荐新修订登记明确 originCode（select / creation_receipt / template_creation / series_occurrence / publish_review），按来源分支验证真实凭据并保证同活动；不改变既有对外 operationKey，内嵌选择写入不单独接受客户端幂等键。新增 origin 字段、来源复合唯一锚和延迟检查须列入最终 migration 写集，不以 JSON 中一个 sourceId 假装数据库同链。

统一选择表达为 `{mode:'inherit'}` 或 `{mode:'explicit', pointer:{policyId,versionId,definitionHash}}`。闭合键、拒绝空字符串/未知键/重复目标。哈希是小写 SHA256；ID 使用既有 ID 校验而非自造格式。selectionHash 复用 canonical 工具，对规范化后的整份选择与 schemaVersion 求值。

模板 V4 增加 `timePolicySelection` 根对象：default 为模板默认选择；sessionOverrides 按模板稳定 session code 定位；positionOverrides 按 session code + position code 定位。未知 code、跨场次同名误配、重复键拒绝。复制时在同一事务将稳定 code 映射到本次新建的 ID，保留来源模板 id/hash，不保留指向别的活动的 ID。

活动修订包含模板默认来源、活动选择及场次/岗位覆盖。缺省下层等同 inherit，根无来源且 inherit 则为 unresolved，不猜系统默认、不按活动名称或活动分类补规则。最近 explicit 完整覆盖上层，禁止定义字段合并。non_creditable 是有效显式类别，不等于 null 或“无需选择”。

解析为每个实际场次岗位输出最终 policyId/versionId/definitionHash/evaluatorVersion、sourceLayer、sourceTarget、计划生效区间。无岗位场次仍须解析场次默认；无场次活动须报告计划不完整，不能得到伪完整结果。岗位有效区间采用岗位时间，否则采用场次时间；全部区间必须被所选版本的左闭右开生效区间覆盖。边界相等、空结束时间、岗位跨场次必须独立测试。

### 3.2 状态与保留

来源字段使用可空的 `creationReceiptId`、`seriesOccurrenceId`、`publishReviewId`，由originCode的CHECK保证只填对应一项；template_creation与select不填这三项。creation_receipt引用既有(id,activityId)，并验证actor、commandCode及requestHash形状；series_occurrence引用同活动的生成事实；这两张来源表没有status列，不虚构“status=success”检查。它们须与选择修订在同一外层事务提交，creation与template/series初始化均为revision=1。series_occurrence与publish_review按§3.3新增(id,activityId)唯一锚。template_creation检查Activity的A6 key/hash成对有效；select核验专用收据。发布来源则真实检查review.status=approved、reviewedByUserId与创建者一致及proposalSelectionHash相等，不能只凭存在。外层请求hash/重放仍由原命令负责，不创建额外公开命令。本轮不新增模型。

新选、提交和批准时均重验版本 active、hash、evaluator、区间及目标存活。退役后历史冻结仍可解释，但不能偷偷替换最新版。已发布活动只能走变更提案；普通选择命令只写无待审提案的草稿。相同 operationKey 重放仍校验当前身份/权限，返回原收据而不重新选择版本。

用途是规则审计，不采集新身份证、手机号、附件内容或自由文本理由。createdByUserId 仅内部同链/审计使用，普通选择 DTO 不返回人员身份；选择、收据和冻结历史永久保留，退队撤销访问不删除历史。

### 3.3 migration、命名与回退

新增SQL路径固定为 `prisma/migrations/20260911100000_activity_os_r4_d1_3_time_policy_selection/migration.sql`，当前118条之后的第119条；实施前若main有新增迁移，重新确认顺序，不沿用未经核验的签字编号。该SQL只建空三表、增加可空/default0列、索引/FK/约束，并扩展模板收据V4分支；不回填旧活动、不更新旧快照、不写政策或角色授权、不删除任何业务数据。所有业务引用ON DELETE/UPDATE RESTRICT。不可变修订和收据只含createdAt，无updatedAt/deletedAt。

为避免数据库63字符标识符截断，新增自定义约束/函数统一使用短前缀，推荐精确名称如下：

| 名称 | 职责 |
|---|---|
| `atps_revision_activity_revision_key` / `atps_revision_id_activity_key` / `atps_revision_id_activity_revision_key` | 三个修订唯一锚。 |
| `atps_item_template_key` / `atps_item_activity_key` / `atps_item_session_key` / `atps_item_position_key` | 按layer的部分唯一索引。 |
| `atps_item_revision_idx` | selectionRevisionId普通索引，提交计数/读明细不扫描全部历史，不能误认为部分唯一索引覆盖所有层查询。 |
| `atps_receipt_actor_operation_key` | 专用收据幂等唯一键。 |
| `atps_receipt_revision_activity_key` | (selectionRevisionId,activityId)唯一；同一standalone修订只有一份专用收据，也支持反向查找。 |
| `activity_template_id_definition_hash_key` | 模板来源hash复合锚。 |
| `atps_review_id_activity_key` / `atps_occurrence_id_activity_key` | 既有Review/Occurrence上的来源复合锚。 |
| `atps_current_shape_check` / `atps_revision_shape_check` / `atps_item_shape_check` / `atps_receipt_shape_check` | 各自闭合形状，统一以IS TRUE拒绝NULL/UNKNOWN。 |
| `atps_current_revision_fkey` / `atps_item_revision_fkey` / `atps_receipt_revision_fkey` / `atps_snapshot_revision_fkey` | 当前指针/明细/收据/快照的同活动复合引用。 |
| `atps_item_session_fkey` / `atps_item_position_fkey` / `atps_item_policy_version_fkey` | 场次、岗位、政策版本同链引用。 |
| `atps_revision_template_fkey` / `atps_revision_creation_fkey` / `atps_revision_occurrence_fkey` / `atps_revision_review_fkey` | 四种真实来源复合引用。 |
| `atps_reject_mutation` | 三表UPDATE/DELETE拒绝函数；各表触发器分别 `atps_revision_immutable` / `atps_item_immutable` / `atps_receipt_immutable`。 |
| `atps_check_item_manifest` / `atps_item_manifest_guard` | item BEFORE INSERT与父manifest对应项相等。 |
| `atps_check_revision_complete` / `atps_revision_complete_guard` | 父修订延迟完整性、来源成功状态、当前指针及专用收据分支核验。 |
| `atps_check_current_revision` / `atps_current_revision_guard` | 当前修订形状及单步递增，不逐份核验历史是否current。 |
| `atps_check_snapshot_reference` / `atps_snapshot_reference_guard` | Snapshot列/JSON引用及审核同活动一致；V8配置态不得无修订引用。 |
| `atps_check_template_receipt` / `atps_template_receipt_guard` | 模板操作收据schemaVersion与实际模板相等，既有其他operation不参与该新分支。 |

可由Prisma表达的FK/unique全部登记在schema，不能只在SQL添加后让diff下次建议DROP；部分索引、CHECK与触发器留SQL并以独立数据库探针维护。`activity_metric_receipt_result_check`在新migration中完整保留旧operation分支，仅模板版本允许3/4；不修改第112条SQL。语义hash仍归应用重算，不给上述函数虚构此能力。

回退为停止新选择/新V4/V8写入，保留三表、所有修订和快照；不执行down/DROP。已经写入V4/V8后，旧二进制不认识新格式，不能宣称直接回滚旧版本安全；需使用仍能读取V4/V8的兼容版本或前向修复，不能靠抹掉新数据恢复运行。

## 4. 拟定 HTTP 与权限方案

推荐四个活动读写操作及一个 App 选项查询，共五个新增 operation：

| 面 | 路径（均带 /api 前缀） | 资格建议 |
|---|---|---|
| Admin | GET/PATCH `/admin/v1/activities/:id/time-policy-selection` | 显式 read/select 码 + 当前活动范围；写仅合法草稿。 |
| App managed | GET/PATCH `/app/v1/my/managed-activities/:activityId/time-policy-selection` | 当前 User/Member ACTIVE，显式 read/select 码、组织范围、发起人或已登记责任资格；写仅合法草稿。 |
| App managed | GET `/app/v1/my/managed-activities/time-policy-options` | organizationId + 计划区间 + 分页；当前发起资格和目标组织资格，不因此开放 GLOBAL 目录。 |

推荐新增权限固定为 `activity.time-policy.read`、`activity.time-policy.select`；SA不绕过显式授权，机器/委托不开放，成果/结算权限不直通，read/select不互相隐含。两码均CUSTOM_ROLE_ALLOWED、ACTIVE，不自动分配内建角色；业务元数据排序194/195，读LOW/READ、写HIGH/WRITE。Admin/App DTO独立，不继承另一面DTO。此为待确认权限合同，当前不新增或授码。

Admin活动读写要求当前有效User、真实显式码、组织范围、中央activity资源判定及目标组织有效；不额外强制Admin必须是App成员或发起人。App再要求当前User/Member ACTIVE，草稿仅本人发起，非草稿读取仅当前owner（归档沿archivedFromStatusCode判定），不复用指标路径的SA例外。options要求read码的目标组织scope、App准入及 `ActivityInitiationPolicy.resolveInitiator(actor,organizationId,undefined,tx)`，不会获得GLOBAL目录读写权。新显式创建选择另保留原create资格，并验证select码与组织scope；Series按原合同允许无initiator，但不是免码。V4模板管理沿既有显式GLOBAL模板管理资格，涉及政策指针时另验既有时长目录read码；复制V4到活动则按活动选择资格，不要求App具备GLOBAL目录权限。批准沿既有发布审核资格，不要求审核人冒充草稿选择者，仍重验新政策引用。

PATCH 接受闭合三键 `{operationKey,expectedRevision,changes}`；operationKey 为8–128字符，expectedRevision 为0–2147483646整数，changes 为1–100项，整份规范化请求不超过64KiB。每项是 `{scope:{layerCode,sessionId,positionId},selection}`；仅 activity/session/position 三个可写层，形状按§3，重复 scope 拒绝。template 层来自指定不可变 V4，不能借活动命令改模板。省略目标保持原选择，session/position 的 inherit 规范化为移除当前覆盖，activity 根 inherit 仍保留根项。数据库永久保留旧修订，这里的“移除覆盖”不是 DELETE 历史行。无语义变化拒绝递增。

每批锁后读取完整当前修订、应用 changes、规范化并写一份完整新修订。100是单次请求上限，不是整个活动的岗位或覆盖上限；1万岗位允许分批全部配置，中间状态仅草稿可见，最终一次发布冻结最终修订。新传 explicit 引用必须可新选；未修改的失效引用允许留在草稿供分批修复，Readiness持续报告问题，不能因此阻止后续修复批次。提交与批准必须验证全部最终目标。任一批次失败整体回滚，不能部分成功；不自动重试。

已发布活动提供时长changes的变更提案，须在原owner/提审资格之外验证select码和组织scope；该检查复用新Access的资格部分，不误调用“仅草稿可写”的standalone状态检查。省略时长changes的无关变更不新增select资格要求，不能借新接线扩大或收紧旧审核访问面。批准仍按原审核资格，不要求审核人持有发起人的select码。

GET 按 page/pageSize（默认20、最大100）返回原始层项、全活动解析摘要和安全指针；返回 revisionId/revision/selectionHash，后续页可指定 revision 保持同一不可变版本。总量不是分页截取后长度；不返整份 selectionJson、完整人员或无限明细。历史选择与当前计划的解析不冒称原发布冻结，原发布解释以对应 RuleSnapshot 为准。选项分页同样最大100；请求含 organizationId、plannedFrom/plannedUntil，按版本createdAt desc/id desc稳定排序，过滤 active/evaluator/区间，不按岗位逐次查询目录。查询不写审计。

该 PATCH 方案替代起草阶段的“全量 PUT”，属本次待确认设计。只读本地依赖复现：Nest Express adapter 默认调用 express.json()，body-parser 2.3.0 的 `lib/utils.js:61–62` 默认102400字节；一条合成指针326字节返回200，一万条3150011字节返回413。仅启动临时本地解析器并已关闭，未连数据库，未修改代码。不得通过测试特设更大 body limit 冒充生产支持。推荐小批命令而不修改 bootstrap、全站请求上限或包依赖；模板/专业创建的既有传输限制保持，万人验收针对选择与冻结链，不宣称本批修复既有创建接口的全量容量问题。

推荐单个审计事件 `activity.time-policy.selection`，仅记录activityId、revision、selectionHash、operationCode、目标数量；不输出定义全文、自由文本或用户身份。重放不再写该事件。错误编号如下，旧码仅在语义一致时复用。

错误编号推荐如下；已扫描531条现有BizCode，20197为阳性对照，下列八码均未占用。实施前若main前进再次核验，不覆盖他人新增编号：

| BizCode 后缀（统一 `ACTIVITY_TIME_POLICY_SELECTION_`） | 编号 / HTTP | 语义 |
|---|---|---|
| INVALID | 20205 / 400 | 闭合语法、目标形状、重复scope或64KiB预算非法。 |
| REFERENCE_UNAVAILABLE | 20206 / 404 | 不存在/已删/越权的活动或场次岗位统一不可用，避免枚举。 |
| STALE | 20207 / 409 | expectedRevision与当前不符。 |
| COMMAND_CONFLICT | 20208 / 409 | 同actor/operationKey但请求指纹不同。 |
| RECEIPT_INVALID | 20209 / 409 | 持久化收据形状、内容或同链损坏。 |
| POLICY_UNAVAILABLE | 20210 / 409 | 新显式引用不是可选active/hash/evaluator/区间组合。 |
| UNCHANGED | 20211 / 409 | 规范化后没有语义变化。 |
| REVISION_LIMIT | 20212 / 409 | 已到Int版本上限，不回绕。 |

未登录/停用使用现有UNAUTHORIZED；无该操作权限使用FORBIDDEN；已发布普通写用ACTIVITY_CHANGE_REVIEW_REQUIRED；待审用ACTIVITY_PUBLISH_REVIEW_PENDING；其余不合法活动状态用ACTIVITY_STATUS_INVALID。只在已通过活动访问资格后报告状态差异，数据库异常不透传SQL/连接信息。

## 5. 事务、锁和预算

权限调用链补充：新选择 Access 先调用 `loadActiveUserIdentityInTx`；App 再通过 `AppIdentityResolver.resolve(actor, tx)` 验证成员准入；随后使用 `AuthzService.getExplicitVisibleOrganizationScope(actor, action, tx)`，检查 hasPermission 且 global 或 organizationIds 包含活动组织。该入口真实计算 GLOBAL/ORGANIZATION/ORGANIZATION_TREE 有效授权，不提供 SA 免码，但不替调用者检查当前目标组织资格、活动发起人/责任或发布状态。目标组织应另走既有组织资格属主原语；活动读写资格由新选择 Access 明确检查，不能把“有组织权限”误当作“是活动发起人”。已有 `activity-outcome-access.service.ts` 是此组合的使用证据，仅作参考，不扩成果权限、不修改成果业务代码。锁后以同一 tx 重新执行该链，不能使用锁前返回值或跨请求缓存。

补充限定：`activity-outcome-access.service.ts` 在显式组织范围之外还调用 `authz.can(actor, permission, {type:'activity', id}, tx)`。新选择 Access 同样必须保留这一资源级判定，避免遗漏中央 ActionConstraint；显式组织范围是防 SA 免码的附加要求，不替代原资源判权。候选权限 seed 三段对应 `module:'activity' / action:'time-policy' / resourceType:'read'|'select'`，须同时登记业务元数据与 runtime 清单，不能只改字符串数组。当前没有证据要求修改全局 AuthzService 的生产逻辑，暂不把该文件纳入实施写集；引用链测试发现确实缺能力时先在文档中说明再申请扩展。

独立命令采用RC、maxWait 2秒、timeout 10秒。顺序为初次资格检查→幂等键锁→Activity根锁→目标场次/岗位按稳定ID排序→政策/版本按稳定ID排序共享锁→锁后当前身份/组织/权限重验→写修订/明细/审计/收据。每个可能等待的锁之后都重验当前资格，不缓存锁前结论。政策/版本先后次序与目录一致，发布/模板的既有指标锁先于新时长锁，不能倒序。

模板复制/Series/三种创建复用外层事务与收据，不在内部再开事务；新活动从指定模板复制选择，手工创建可暂未配置但发布必须解决。紧急创建不能因新政策悄悄改变既有 Gate/紧急合同，旧版本按历史语法保留；新 V8 路径必须明确选择或拒绝，不隐式 non_creditable。

三种创建的准确边界：`activity-creation.service.ts` 的专业/紧急流程在外层事务建草稿、写 ActivityCreationCommandReceipt；紧急分支随后排入通知，不调用发布批准。`activity-creation-emergency.ts` 同样仅建草稿及受众通知。因此不为“创建紧急草稿/发通知”强制已具备场次或最终政策，不修改通知/Gate。可选的显式选择随创建写入同一事务；省略时保留原请求 hash 和重放。快速/Series 的 V4 来源复制全部四层选择；专业创建按本次 session/position code 映射，紧急初建无场次时仅接受活动层选择，其后通过受控选择入口补完整。新 V8 初次发布才要求实际目标全部可解析。旧收据不补写新修订、不重发通知；现有创建资格之外，仅新显式选择分支增加本批选择资格验证。

明细/岗位/版本均批量读取与写入，禁止逐岗位查询；大量INSERT按最多500行一批避免数据库参数上限，全量计数仅每份新修订一次，不要求“任意数量永远一条INSERT”。推荐新独立选择事务RC、maxWait 2秒、timeout 10秒；沿外层创建/审批事务调用时不另设事务或修改其既有超时。此前5秒只是起草建议，以此10秒方案为准。验收预算为独立PATCH最多160条SQL、分页GET最多48条、options最多32条，包含资格查询与事务语句，不只数业务表；这是待实施验证的上限，不是假称已经实测。1、100、10000岗位分别测量，业务读查询数不能逐岗位增长，批量INSERT增长须与500行批次匹配。既有创建流程的场次逐个创建不借本批重构，但新增时长接线不得再增加逐条查询。满额超过预算先报告，不删资格检查、不降支持规模；锁后撤权/退役/组织失效/活动状态变化仍分别验证。

已核验锁序：目录退役在 `activity-time-policy.service.ts:184–190` 先锁 TimePolicy 再锁 TimePolicyVersion，目录命令不会回头取 Activity 锁。发布审核在 `activity-publish-review.service.ts:225–226` 先锁 Activity 再锁 review，之后已有指标引用锁。V8 应保留这些相对顺序，新增时长引用锁置于既有指标引用锁之后，所有政策身份按 ID 排序批量锁定，再按 ID 排序批量锁定版本；不得在选择路径先锁版本再锁政策。选择与发布采用共享政策/版本锁，退役的更新锁形成真实互斥；锁后重新读取 active/hash/时间覆盖，验证“退役先提交则批准拒绝、批准先提交则冻结保留且之后退役不改历史”。模板复制的实际锁序见§6，实施探针还需对拍完整交错，不能由目录单链无反向锁推断全链无死锁。

## 6. 模板 V4、提案 V8 与冻结

模板锁序证据：`activity-from-template.service.ts:347,381,639–647` 的 Series 精确版本验证和实际复制均先对 ActivityTemplate 取 FOR UPDATE，再进入指标引用锁。V4 应在指标锁之后取时长政策/版本锁，且创建路径不得为读取来源反向锁另一个既有 Activity。重放路径 `612` 单独锁既有 Activity，应独立审查其模板读取是否引入回头锁，不能为了“统一方法”让重放再次物化模板或再次写选择。V4 模板目录创建/激活若增加引用有效性校验，也必须采用模板→指标→时长的同序链；该要求需覆盖目录命令、Series 验证、复制、重放四条真实调用路径测试。

模板 V4 复用 V3 指标与 V2 表单语义，仅新增时长选择分支。V1–V3 parser/hash/复制夹具保留；旧模板不自动升级。模板目录创建、版本验证、预览与 from-template、Series、三种创建均按引用链显式识别 V4。

模板目录不能机械切换默认 V3：现有 `dto/admin/activity-template-version.dto.ts` 没有请求 schemaVersion，definition 被显式绑定为 V3 DTO。推荐保留省略 schemaVersion 的既有 V3 请求；新增显式 `schemaVersion:4` 分支及独立 V4 DTO。V4 复制须明确完整时长选择，不把 V1–V3 来源静默推断成新政策；更新不得改变目标版本的 schemaVersion。列表/详情允许读取 4，旧筛选仍合法。命令结果与重放支持 3/4，旧 schemaVersion=3 收据逐字保持。

**数据库接线已定位**：第 112 条 `20260906114906_activity_os_r3_c1_metric_selection_template_v3/migration.sql:74–89` 的模板命令收据 CHECK 将 resultJson.schemaVersion 限定为 3。未来新增 migration 必须在保持既有其他 operation 分支不变的前提下，为模板分支加入 4，并核验其目标模板的实际 schemaVersion；只改 TypeScript 会被数据库拒绝。禁止修改第 112 条历史 SQL。需要“旧 V3 收据合法、新 V4 收据合法、V4 收据指向 V3 模板非法”的三个独立数据库探针。

新提案使用 V8 独立 envelope 和 parser；冻结原始四层选择、选择 revision/hash、各目标最终指针、evaluator 与覆盖来源。changeDiff 只暴露安全、可解释字段。创建/保存/预览/提交/批准/拒绝/变更/重放逐个接线，不能只升级创建时的 schemaVersion。

V8具体采用现有V7 envelope的同级目标结构（不是新造target嵌套键），顶层及base各自携带 `timePolicyPointers`：历史未配置为null；已配置为闭合对象 `{schemaVersion:1,selectionRevision,proposalSelectionHash,selection,resolved}`。selection使用§3规范化四层对象；提案里新增目标使用已验证的clientRef，既有目标用ID，二者须显式区分。resolved按场次/岗位稳定key排序，每项只含目标、最终policy/version/hash/evaluator、sourceLayer/sourceTarget及UTC区间。新增顶层 `timePolicySelectionExplicit` 布尔参与提案hash，区分省略继承与明确改选；指标V7字段/显式意图原样保留。变更DTO使用同一有界changes语法与expectedRevision；针对新增场次/岗位复用现有clientRef解析，不接受别的活动ID，批准物化后将稳定key映射至新ID再写修订及Snapshot，不能提前创建悬空修订。未修改选择时不为无关变更制造新修订；改变目标拓扑或覆盖映射需重新规范化，实际选择事实变化才递增。

不得混淆两种hash：proposalSelectionHash绑定提案阶段含clientRef的逻辑选择；修订selectionHash绑定物化后含真实ID的选择，两者不保证相等。批准先验证提案hash和目标映射完整性，再生成真实选择/hash；publish_review来源的修订保存proposalSelectionHash作为与审核顶层timePolicyPointers的相等锚，其他来源该字段为null。冻结resolvedConfig的timePolicyPointers保存上述提案证据，另含selectionRevisionId、selectionHash以及使用真实ID的selection/resolved；Snapshot列引用同一revision。同一已校验的最终对象参与Snapshot hash与存储。数据库核对来源reviewId/activityId/已批准状态、提案hash字段相等及Snapshot引用，应用验证映射前后语义；不声称数据库独立运行了clientRef映射算法。新增目标、缺失/重复clientRef、故意换映射、hash混用均需独立失败探针。

兼容旧写入口：历史未配置活动仍按既有旧入口/旧提案分支执行；已经配置新选择或来自V4的活动，不允许通过旧V1–V7提交入口绕开冻结，应拒绝并引导新proposal入口。旧在途V2–V7批准保持原解释，但若其base已被新的选择写入改变，必须按既有并发失效原则拒绝，不能把它当作重置已配置状态的许可。此限定同时列入新历史兼容E2E，不改旧历史JSON。

批准在同一事务锁后重验目标、版本与权限，将同一解析结果写入新 ActivityRuleSnapshot；hash 与 snapshot 内容一致。旧 V2–V7 在途与历史快照原解释、原 hash、原批准行为不变，不批量升级 JSON。历史未配置活动的无关变更允许保留原未配置表示；一旦显式迁移进入时长选择，不能再清回历史 null/0。如何区分历史保留与新发布缺项必须有单独行为锁。

Readiness 不再无条件报不可表示：未配置、引用失效、未覆盖时间、目标错链分别报告；仅所有目标实际解析成功才解除时长问题。其他贡献/组织/表单/指标 Readiness 保持原行为，不变成结算或归档新增硬门。

Readiness 不只改 evaluator：`activity-publish-readiness.service.ts:619–780` 的事实加载目前未读岗位 startAt/endAt、attendanceRoleCode 或选择修订；同文件必须批量补齐事实及当前政策状态，再把脱离 Prisma 的纯事实交给 evaluator。保留原查询只读性、排序稳定性和其他领域问题；缺事实不得被解释为已配置。无需新建另一个 resolver 或在纯 evaluator 内查库。

冻结接线证据：`activity-publish-review.service.ts:1100–1108` 从 applied resolvedConfig 写 ActivityRuleSnapshot，并按 `{schemaVersion, resolvedConfig}` 求 hash；V8 必须使用同一个已校验对象同时生成存储内容与 hash。建议 ActivityRuleSnapshot 增加可空 `timePolicySelectionRevisionId`，与 activityId 建复合 FK 指向选择修订；旧快照 null 保持不动。V8 明确已配置时该列必须存在且与 resolvedConfig 内 revision/hash 相符，未配置历史保留例外必须由 schemaVersion/历史迁移规则区分，不能任意 null 绕过。该字段是引用既有不可变选择事实，不是另造一份选择真相；最终解析政策仍作为 V8 resolvedConfig 的冻结解释。验收直接 SQL 插入跨活动修订必须失败，并对“列指针和 JSON 指针不一致”作单独失败探针。

## 7. 探针与验收顺序

1. 先跑现有模板 V1–V3、V7 指标提案、发布/变更/紧急创建 characterization，保存原断言基线；差异即停。
2. 新 schema 冷回放与 118→新迁移非空升级；根/场次/岗位错活动、错 policy/hash、重复明细、缺收据、非法 revision、更新/删除不可变记录逐项真实 SQL 失败；原数据不变。
3. 四层覆盖全组合、继承未解析、无岗位场次、相同岗位 code 分属场次、时间边界、draft/retired/未知 evaluator、定义hash错误均测试；不以 parser 通过代替 HTTP。
4. Admin/App 五操作真实 HTTP，当前身份/成员/组织/明确授权/责任/机器/委托反例；同键同/异payload并发与锁后撤权、退役、活动变更。
5. V4 模板复制、Series、快速/专业/紧急创建；V8 全发布生命周期与变更审批；V1–V3、V2–V7 历史夹具与断言保留。
6. 每次测试前后核对 ParticipantServiceSegmentRevision、现有结算和账本事实无新增或改写；Gate 保持关闭。测试生命周期须恢复本 worker 合法迁移记录，防重演 #1313。
7. quick、定向 E2E、contract 增量逐行解释、OpenAPI/客户端及治理派生检查；PR CI 全量与合并后 main CI 分别留证。全部通过也不代表 D2–D8 或生产上线完成。

## 8. 本轮文档写集

### 既有 E2E 候选影响面（仅定位，不是改断言授权）

以下均在 `test/e2e/`，下一步须按调用链逐例分类；命中版本数字只代表候选，不可机械替换：

| 文件 | 必须核对的边界 |
|---|---|
| activity-os-r3-c1-d2c-proposal-v7.e2e-spec.ts | 新提案端到端与 V7 历史语法测试必须拆清，历史 V7 不改成 V8 冒充兼容。 |
| activity-os-r3-c1-d2c-proposal-compatibility.e2e-spec.ts | V2–V7 历史、在途、零修订升级夹具永久保留；无关变更行为不放宽。 |
| activity-os-r3-c1-d2c-proposal-concurrency.e2e-spec.ts | 指标并发断言不变；新创建提案是否需补时长选择前置逐例确认。 |
| activity-os-r3-c1-d2c-readiness.e2e-spec.ts | 已核对 206–209 行仅提取 metrics.requiredSet；269–280 行检查指标状态、V3 模板、同输入重复读取一致性，后段核验活动/审计未写。保留原断言，不为时长选择新增字段重写指标期望；时长 Readiness 用新增测试覆盖。 |
| activity-os-r3-c1-d2b-template-catalogue.e2e-spec.ts | V3 收据与模板定义继续保留；新 V4 另加真实调用，不改历史 hash。 |
| activity-os-r3-c1-d2b-creation-compatibility.e2e-spec.ts | 快速/专业/紧急的旧来源、访问面及重放保持；新选择仅新版本接入。 |
| activity-batch3-2-publish-review.e2e-spec.ts | 审批/变更行为与新提案版本断言分离。 |
| activity-batch4-form-runtime.e2e-spec.ts | 保留表单运行时行为断言，只评估新提案前置。 |
| activity-batch4-allocation-mode-runtime.e2e-spec.ts | 不改既有分配模式行为及其冻结证据。 |
| activity-batch4-qualification-configuration.e2e-spec.ts | 不改资格配置合同，只核对发布前置。 |
| activity-os-r2-b7-control-plane.e2e-spec.ts | 第 302 行的 7 是前后计数差，不是提案版本；排除该数字命中，控制面资格保持不变。 |
| activity-os-r2-b5-snapshot-v6.e2e-spec.ts | V6 历史快照仍按 V6；新 HTTP 返回版本另列。 |
| activity-settlement-closure.e2e-spec.ts | 已核对第 574 行命中为 archiveWaitingDays=7，与提案 V7 无关；不因该命中纳入版本适配写集，结算业务断言保持。 |
| activity-v11-batch4-allocation-candidate-position-anchor-migration.e2e-spec.ts | 已核对第 564 行命中为 d87ArtifactCount=7，与提案 V7 无关；不因该命中纳入版本适配写集，迁移历史断言保持。 |

候选分类以本表、下方实际新HTTP断言及§9.3为准；只有列入140路径的旧E2E才申请适配。未列入的旧模板目录、创建兼容、指标Readiness及误命中计数用例保持原文件并运行回归。当前没有修改旧测试的授权。

已定位真实新提案断言：publish-review 第 293/602 行及 changeDiff 第 604 行；form-runtime 第 299/318/342/580 行；allocation-mode-runtime 第 445 行标题和 455/554 行；qualification-configuration 第 654 行；B5 snapshot 第 330 行。它们来自新 HTTP 提交/变更结果，应申请仅将版本/差异类型改为 V8 并补合法政策前置，其业务字段、审批和表单/资格/分配断言全部保留。具体 HTTP 前置必须走未来受控选择命令，不直接 SQL 填充新选择；历史夹具不随之升级。此处是待确认适配方案，不是当前测试写入授权。

补充定位：C1 proposal-v7 的第 281/332 行及第 349 行 changeDiff 是新提交结果的版本/类型断言，未来申请 V8 适配；不能因文件名含 v7 而把全部测试当固定历史。C1 template-catalogue 的 schemaVersion=3 默认夹具、第 310 行 hash、823 行 detail 和 922 行筛选参数用于真实 V3 模板合同，保持 3，V4 新增独立覆盖。C1 readiness 已完成断言范围核验，见上表；仍作为定向回归执行，但无已识别的必要修改。

仅以下七份；不补 changelog、不提交或开 PR：

```text
docs/plans/activity-os-r4-d1-3-implementation-plan.md
docs/plans/activity-os-r4-d1-2-implementation-plan.md
docs/plans/activity-os-r4-d1-time-policy-review.md
docs/ai-harness/NEXT_TASKS.md
docs/ai-harness/FROZEN_DRAFTS.md
src/modules/activities/CLAUDE.md
docs/handoff/admin-web.md
```

## 9. 后续精确实施写集（待确认，不是当前写入授权）

已定位必须评估的现有入口：`prisma/schema.prisma`、`src/modules/activities/activities.module.ts`、`activity-template-version-command.ts`、`activity-template-version.service.ts`、`activity-template-version-query.service.ts`、`activity-template-version-presenter.ts`、`activity-from-template.service.ts`、`activity-creation-command.ts`、`activity-creation.service.ts`、`activity-series-command.ts`、`activity-series.service.ts`、`activity-publish-proposal-v2.service.ts`、`activity-publish-review.dto.ts`、`activity-publish-review-submit.service.ts`、`activity-publish-review.service.ts`、`activity-publish-review-query.service.ts`、`activity-publish-review-presenter.ts`、`activity-publish-readiness.service.ts`。未特别注明的文件属于 `src/modules/activities/`。

§9.3逐一列出新纯解析器、选择命令/查询/展示/审计、Admin/App controller与独立DTO、migration及数据库/HTTP/兼容/并发E2E全名。本节前面的入口概述只是引用链说明，实际白名单以140项为准，不能用简称申请通配授权。

联动必查：权限 catalog/运行时 seed 列表/持码测试/守护计数、audit registry、BizCode、日期权威、Prisma摘要、状态机/domain-map、OpenAPI contract、13客户端文件、CODEMAP/RBAC_MAP/ROUTE_AUTHZ、current-state counts、FROZEN_DRAFTS、签字登记、handoff。仅由生成器刷新派生文件；旧 migration 测试当前回放计数需逐份列出，历史升级编号不跟随当前计数改写。

### 9.1 已核实的精确联动路径

以下路径已现场核实存在，补足此前影响面段落的省略；仍是未来实施计划，不授权当前修改：

| 路径 | 允许的未来改动 |
|---|---|
| `src/modules/activities/dto/admin/activity-template-version.dto.ts` | 独立 V4 请求分支、3/4 收据及列表/详情 schema 枚举；不缩窄 V3 输入。 |
| `src/modules/activities/dto/app/app-managed-activity-creation.dto.ts` | 紧急创建可选活动层时长选择；不把专业/模板层 DTO 混入 App。 |
| `src/modules/activities/dto/app/app-managed-activity-creation-professional.dto.ts` | 可选按本次稳定 code 的四层选择；既有创建字段不变。 |
| `src/modules/activities/activity-creation-professional.ts` | 在现有创建结果内部保留本次 code→ID 映射供选择物化；不新增对外返回字段、不改场次/岗位创建语义。 |
| `src/modules/activities/activity-creation-dto.spec.ts` | 可选字段显式映射、旧输入 hash 不变及拒绝跨面字段。 |
| `src/modules/permissions/permission-catalog.ts` | 两码及真实 scope/主体/ActionConstraint 元数据。 |
| `src/modules/permissions/seed-permission-codes.ts` | 运行时清单仅补两码。 |
| `src/modules/permissions/permission-code-holders.spec.ts` | 人工授予例外精确登记，不扩角色默认权限。 |
| `scripts/harness-guards.selftest.ts` | 仅 CLOSURE_PERMISSION_CODE_COUNT 与对应注释 260→262，不改守护裁决。 |
| `src/modules/audit-logs/audit-logs.types.ts` | 单个具名事件及安全资源类型。 |
| `src/common/exceptions/biz-code.constant.ts` | 本批明确业务错误，不把目录错误强行兼作选择错误。 |
| `src/common/exceptions/biz-code.constant.spec.ts` | 新错误编号及状态语义登记。 |
| `src/common/datetime/clock-authority.spec.ts` | 新修订/收据 createdAt 的时钟来源登记，不放宽断言。 |
| `prisma/CLAUDE.md` | 实施后按真实模型/迁移更新摘要；本轮不动。 |

### 9.2 旧迁移测试的精确适配边界

以下路径均以 `test/e2e/` 为根。未来仅更新“回放当前全部迁移”的计数；如果本批只新增一条 migration，118→119。历史升级区间、SQL checksum 与业务断言不改：

```text
activity-os-r3-c1-d2a-metric-command-receipt-migration.e2e-spec.ts
activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts
activity-v11-batch4-allocation-candidate-position-anchor-migration.e2e-spec.ts
activity-v11-batch4-allocation-command-replay-migration.e2e-spec.ts
activity-v11-batch4-qualification-contract-migration.e2e-spec.ts
insurance-evidence-registration-revision-migration.e2e-spec.ts
activity-v11-batch4-allocation-mode-migration.e2e-spec.ts
activity-v11-batch4-allocation-determinism-migration.e2e-spec.ts
activity-os-r4-d1-1-time-policy-migration.e2e-spec.ts
activity-os-r1-a3-template-definition-lifecycle-guards.e2e-spec.ts
activity-os-r1-a4-explicit-template-version-pointer.e2e-spec.ts
activity-os-r2-b1-place-schema-constraints.e2e-spec.ts
activity-os-r2-b2-coordinate-projection-schema-constraints.e2e-spec.ts
activity-os-r2-b3-form-blueprint-governance.e2e-spec.ts
activity-os-r2-b6-creation-data-foundation.e2e-spec.ts
activity-os-r3-c1-metric-definition-set.e2e-spec.ts
activity-os-r3-c2-outcome-value-revision.e2e-spec.ts
```

共15份明确 CURRENT_MIGRATION_COUNT=118（含名称不带migration的schema/data-foundation测试）；D1-1 第 108/115 行是当前全量冷回放标题/断言，更新为119，但第137行以后的117→118历史升级与第173行历史计数118保持。C1 D2b 第496行还需独立申请当前 seed 权限260→262。§8排除 allocation-candidate 文件中的数字7仅指“不是提案版本”；不排除该文件真实迁移计数联动。不能把两种筛选理由混为同一结论。C2 D1 `activity-os-r3-c2-outcome-value-revision.e2e-spec.ts:184/190` 的当前冷回放标题/计数118→119，89行历史migration索引112及原112→113升级断言保持；不因文件名不带migration而遗漏。


### 9.3 精确实施路径清单（140项，待维护者确认）

逐路径核验：109项已存在、31项拟新增，140项无重复；新增为21项生产/单测、7项E2E、1项测试辅助、1条migration及1份实施changelog。仅白名单内实际发生的接线才修改，无差异不制造修改。当前仅七份文档获授权，本表不是当前可执行写集。

#### 新增选择生产与单测

```text
src/modules/activities/activity-time-policy-selection.ts
src/modules/activities/activity-time-policy-selection.spec.ts
src/modules/activities/activity-time-policy-selection-access.ts
src/modules/activities/activity-time-policy-selection-access.spec.ts
src/modules/activities/activity-time-policy-selection.service.ts
src/modules/activities/activity-time-policy-selection.service.spec.ts
src/modules/activities/activity-time-policy-selection-query.service.ts
src/modules/activities/activity-time-policy-selection-query.service.spec.ts
src/modules/activities/activity-time-policy-selection-presenter.ts
src/modules/activities/activity-time-policy-selection-presenter.spec.ts
src/modules/activities/activity-time-policy-selection-audit-recorder.ts
src/modules/activities/activity-time-policy-selection-audit-recorder.spec.ts
src/modules/activities/activity-template-definition-v4.ts
src/modules/activities/activity-template-definition-v4.spec.ts
src/modules/activities/activity-publish-proposal-v8.ts
src/modules/activities/activity-publish-proposal-v8.spec.ts
src/modules/activities/controllers/admin-activity-time-policy-selection.controller.ts
src/modules/activities/controllers/app-managed-activity-time-policy-selection.controller.ts
src/modules/activities/dto/admin/activity-time-policy-selection.dto.ts
src/modules/activities/dto/app/app-activity-time-policy-selection.dto.ts
src/modules/activities/dto/admin/activity-template-definition-v4.dto.ts
```

#### 活动既有接线

```text
src/modules/activities/activities.module.ts
src/modules/activities/activity-template-version-command.ts
src/modules/activities/activity-template-version-command.spec.ts
src/modules/activities/activity-template-version.service.ts
src/modules/activities/activity-template-version.service.spec.ts
src/modules/activities/activity-template-version-query.service.ts
src/modules/activities/activity-template-version-query.service.spec.ts
src/modules/activities/activity-template-version-presenter.ts
src/modules/activities/activity-template-version-presenter.spec.ts
src/modules/activities/activity-from-template.service.ts
src/modules/activities/activity-from-template.service.spec.ts
src/modules/activities/activity-creation-command.ts
src/modules/activities/activity-creation.service.ts
src/modules/activities/activity-creation.service.spec.ts
src/modules/activities/activity-creation-professional.ts
src/modules/activities/activity-creation-dto.spec.ts
src/modules/activities/activity-series.service.ts
src/modules/activities/activity-series-command.spec.ts
src/modules/activities/activity-publish-proposal-v2.service.ts
src/modules/activities/activity-publish-proposal-v2.service.spec.ts
src/modules/activities/activity-publish-review.dto.ts
src/modules/activities/activity-publish-review-submit.service.ts
src/modules/activities/activity-publish-review.service.ts
src/modules/activities/activity-publish-review-query.service.ts
src/modules/activities/activity-publish-readiness.service.ts
src/modules/activities/activity-publish-readiness.service.spec.ts
src/modules/activities/dto/admin/activity-template-version.dto.ts
src/modules/activities/dto/app/app-managed-activity-creation.dto.ts
src/modules/activities/dto/app/app-managed-activity-creation-professional.dto.ts
src/modules/activities/controllers/admin-activity-template-versions.controller.ts
src/modules/activities/controllers/app-managed-activities.controller.ts
src/modules/activities/controllers/admin-activity-publish-reviews.controller.ts
src/modules/activities/controllers/app-managed-activity-creation.controller.ts
```

#### 数据与治理

```text
prisma/schema.prisma
src/modules/permissions/permission-catalog.ts
src/modules/permissions/seed-permission-codes.ts
src/modules/permissions/permission-code-holders.spec.ts
scripts/harness-guards.selftest.ts
src/modules/audit-logs/audit-logs.types.ts
src/common/exceptions/biz-code.constant.ts
src/common/exceptions/biz-code.constant.spec.ts
src/common/datetime/clock-authority.spec.ts
harness/domain-map.json
harness/state-machines.json
harness/authz-assertion-patterns.json
harness/authz-implication-graph.json
harness/permission-surface-baseline.json
test/contract/openapi.contract-spec.ts
test/contract/__snapshots__/openapi.contract-spec.ts.snap
prisma/migrations/20260911100000_activity_os_r4_d1_3_time_policy_selection/migration.sql
```

#### 旧E2E适配候选

```text
test/e2e/activity-os-r3-c1-d2c-proposal-v7.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2c-proposal-compatibility.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2c-proposal-concurrency.e2e-spec.ts
test/e2e/activity-batch3-2-publish-review.e2e-spec.ts
test/e2e/activity-batch4-form-runtime.e2e-spec.ts
test/e2e/activity-batch4-allocation-mode-runtime.e2e-spec.ts
test/e2e/activity-batch4-qualification-configuration.e2e-spec.ts
test/e2e/activity-os-r2-b5-snapshot-v6.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2a-metric-command-receipt-migration.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts
test/e2e/activity-v11-batch4-allocation-candidate-position-anchor-migration.e2e-spec.ts
test/e2e/activity-v11-batch4-allocation-command-replay-migration.e2e-spec.ts
test/e2e/activity-v11-batch4-qualification-contract-migration.e2e-spec.ts
test/e2e/insurance-evidence-registration-revision-migration.e2e-spec.ts
test/e2e/activity-v11-batch4-allocation-mode-migration.e2e-spec.ts
test/e2e/activity-v11-batch4-allocation-determinism-migration.e2e-spec.ts
test/e2e/activity-os-r4-d1-1-time-policy-migration.e2e-spec.ts
test/e2e/activity-os-r1-a3-template-definition-lifecycle-guards.e2e-spec.ts
test/e2e/activity-os-r1-a4-explicit-template-version-pointer.e2e-spec.ts
test/e2e/activity-os-r2-b1-place-schema-constraints.e2e-spec.ts
test/e2e/activity-os-r2-b2-coordinate-projection-schema-constraints.e2e-spec.ts
test/e2e/activity-os-r2-b3-form-blueprint-governance.e2e-spec.ts
test/e2e/activity-os-r2-b6-creation-data-foundation.e2e-spec.ts
test/e2e/activity-os-r3-c1-metric-definition-set.e2e-spec.ts
test/e2e/activity-os-r3-c2-outcome-value-revision.e2e-spec.ts
test/e2e/activity-full-chain.e2e-spec.ts
test/e2e/activity-session-cancel-effects.e2e-spec.ts
test/e2e/app-managed-activity-registrations.e2e-spec.ts
test/e2e/activity-batch4-capacity-projection.e2e-spec.ts
test/e2e/app-managed-activity-attendances.e2e-spec.ts
test/e2e/app-managed-activities.e2e-spec.ts
```

#### 新增E2E

```text
test/e2e/activity-os-r4-d1-3-selection-migration.e2e-spec.ts
test/e2e/activity-os-r4-d1-3-selection-http.e2e-spec.ts
test/e2e/activity-os-r4-d1-3-selection-concurrency.e2e-spec.ts
test/e2e/activity-os-r4-d1-3-template-v4.e2e-spec.ts
test/e2e/activity-os-r4-d1-3-proposal-v8.e2e-spec.ts
test/e2e/activity-os-r4-d1-3-history-compatibility.e2e-spec.ts
test/e2e/activity-os-r4-d1-3-readiness.e2e-spec.ts
test/helpers/activity-time-policy.fixture.ts
```

#### 文档与派生

```text
docs/current-state.md
CODEMAP.md
docs/ai-harness/RBAC_MAP.md
docs/ai-harness/ROUTE_AUTHZ.md
docs/ai-harness/AUDIT_EVENT_REGISTRY.md
docs/ai-harness/STATE_MACHINE_INVENTORY.md
docs/ai-harness/CUTOVER_SIGNOFF.md
docs/ai-harness/FROZEN_DRAFTS.md
docs/ai-harness/NEXT_TASKS.md
src/modules/activities/CLAUDE.md
prisma/CLAUDE.md
docs/plans/activity-os-r4-d1-time-policy-review.md
docs/plans/activity-os-r4-d1-3-implementation-plan.md
docs/handoff/admin-web.md
docs/handoff/miniapp.md
docs/handoff/openapi.json
docs/handoff/clients/admin/client.ts
docs/handoff/clients/admin/types.ts
docs/handoff/clients/app/client.ts
docs/handoff/clients/app/types.ts
docs/handoff/clients/auth/client.ts
docs/handoff/clients/auth/types.ts
docs/handoff/clients/system/client.ts
docs/handoff/clients/system/types.ts
docs/handoff/clients/open/client.ts
docs/handoff/clients/open/types.ts
docs/handoff/clients/integration/client.ts
docs/handoff/clients/integration/types.ts
docs/handoff/clients/shared/types.ts
changelog.d/activity-os-r4-d1-3-implementation.md
```

范围约束：活动既有接线只扩V4/V8及新选择调用，V1–V3/V2–V7分支保留；既有单测只补新分支/新依赖或对应新提案版本，原行为断言不放宽。四份既有controller仅更新本批schema/error/summary声明与参数传递，不改原访问面。旧E2E按§8、§9.2及下表适配；新E2E承担时长专属覆盖。harness JSON只登记真实边界/权限/状态与派生摘要，不添豁免、不弱化检查。客户端仅admin/app有实际接口变更，其余只允许必要摘要/共享类型联动。测试辅助仅创建隔离夹具、显式赋予本用例需要的码并走真实政策目录/选择HTTP，不篡改全局fixture角色权限、不直接SQL填新选择。目录fixture使用独立唯一code，不假定resetDb会清除无User/Activity外键的TimePolicy根表。

排除路径：`prisma/seed.ts` 不盲目加入，实际两码运行时位置为 `seed-permission-codes.ts`；`activity-series-command.ts` 不新增对外字段，V4重放接在series.service；publish-review-presenter仅透传现有安全snapshot，不做版本分支，差异解释接在query.service。bootstrap、全局Authz/Users/Organization原语、Storage、test/setup/reset-db.ts、旧migration与V1–V3/V7纯parser均不修改。

补充六份测试都有真实新提案成功前置，并非仅命中字符串；只在下列初次发布前通过测试辅助增加合法政策选择及必要人工授码，不动后续行为断言：

| test/e2e/ 文件 | 接入锚点（main基线行） | 保留行为 |
|---|---|---|
| activity-full-chain.e2e-spec.ts | 446，新提案第4站 | 全链所有站点、账本与结束断言。 |
| activity-session-cancel-effects.e2e-spec.ts | 410/656/757，初次发布；217/792是后续变更 | 取消/改期影响、报名、二维码失效与并发反例。 |
| app-managed-activity-registrations.e2e-spec.ts | 173，发布fixture | 报名资格及名额行为。 |
| activity-batch4-capacity-projection.e2e-spec.ts | 277，approveInitial；295后续变更 | 容量投影与审批行为。 |
| app-managed-activity-attendances.e2e-spec.ts | 160，发布fixture | 考勤权限与事实。 |
| app-managed-activities.e2e-spec.ts | 260，publishThroughReview | managed可见性、资格及后续操作。 |

## 10. 核验记录、预计计数与授权分段

本稿为待维护者确认的精确推荐方案，**不是已经实施或测试通过的结论**。变更本稿不启动140路径施工。

### 10.1 只读核验结论

- 本轮最终检查：git diff --check、docs:counts:check、docs:readtax:check、docs:codemap:check、docs:rbacmap:check、docs:migcount:check及两项台账检查通过。CODEMAP保留既有2类warning，readtax保留既有接近预算提示；未因此修改守护或无关文件。GitHub再次核验main仍为ba100c1e08e803116a67dfbf5a800090f6cc83c6，对应run34498288827为completed/success。

- 当前基线118条migration、531条BizCode；拟第119条路径不与现有SQL重名，20205–20212无占用且20197阳性对照存在。
- 140个具体路径逐一执行harness:needs：12个受保护、128个无需本地令牌；清单无重复，109项已存在、31项拟新增。工具仅计算预算，不证明已授权，也不授予任何令牌。
- V4必须同时接DTO、模板收据CHECK、列表/详情、复制、Series重放；V3旧请求hash保持原生成分支，不能因新增可选schemaVersion字段让省略字段的旧重放冲突。
- 14份测试含真实新publish-reviews/change-reviews调用，分别落在§8的8份提案测试及§9.3新增定位的6份测试；另17份仅当前migration计数/seed联动，共31份旧E2E。旧V3模板目录、纯V1–V3/V7解析器、固定历史V6紧急fixture、仅指标Readiness测试不改。
- B5 snapshot测试336/349/373行的timePolicyPointers=null属于**新HTTP生成**的目标/base/最终Snapshot，未来须改为精确断言本用例所选指针、修订/hash及物化结果，不能只改版本号。contributionPolicyPointers=null及地点/指标断言保持。V8 changeDiff保留v7Fields的指标安全摘要，新增timePolicyFields安全摘要，不能把原指标字段/防泄漏断言删掉。
- 现有模板V1–V3 parser未限定数组总数，不能把专业DTO的100×100冒称全仓旧模板上限。本批不修改旧parser或静默截断历史；新选择输入每批100项而非总量100，历史大活动可逐批表达选择。性能基准必须至少覆盖100场次/10000岗位，超过基准的历史规模不宣称已实测。
- 全量选择请求3150011字节的本地解析器复现返回413，已据此推荐小批PATCH、分页GET，避免纳入全局body parser改动。该复现只证明默认解析器限制，不代替真实D1-3 HTTP、数据库、压力或端到端验收。
- 物理表名注意：ActivityPublishReview映射为 `activity_publish_reviews`；ActivityTemplate/ActivitySeriesOccurrence/ActivityCreationCommandReceipt沿各自模型表名。SQL不得凭模型名猜审核表名。

### 10.2 预计终态与必须留证项

按本稿完整实施且无其他main新增时，预计157模型、119迁移、122 Controller、625端点、262权限、167审计总计/162活跃、539 BizCode。均为计划值，本轮当前计数不改。3b需在真实第119条SQL稳定后确认；4b需在真实262/167/162读数核验后确认；现在不提前签字。

DoD依次为：三表与全部来源/不可变/同链探针通过；Admin/App五操作及当前资格/真实锁等待反例通过；四层全部可解析、V4复制/三种创建/Series实接；V8初次与变更审批完成真实冻结，旧历史hash和行为保留；1/100/10000目标下预算验证；原参与段、结算、账本、证明事实不变；生成物/quick/contract/定向E2E通过；PR全量CI与未来合并后main CI分别留证。未达到任一项不登记D1-3完成；不以docs检查替代这些证据。

当SQL预算、锁顺序或兼容探针失败时，先定位具体差异，不删断言、不扩超时、不增加未列路径、不修改Gate来“通过”。数据库测试失败的恢复仅限未来批准的隔离worker，并恢复当前全部migration及合法迁移记录；不重演#1313裸SQL回放后遗留不合法库状态。

### 10.3 本轮文档PR授权（已确认，仅文档）

维护者已明确确认：

> 确认 D1-3 精确计划方案 A；允许补充 changelog、提交、推送并创建计划 PR；不合并、不实施。

本轮在§8七份文档基础上仅补充 `changelog.d/activity-os-r4-d1-3-plan.md`，形成8份文档PR；不使用实施changelog，不创建schema/API/测试文件，不运行数据库。计划PR合并与implementation分别需要后续确认。

### 10.4 后续implementation授权（不是现在执行）

计划PR合并后，维护者须确认140路径完整方案、两码/八码/单事件、小批更新及旧测试上述精确适配；建议只申请 `app_test_w98` 隔离验证与测试夹具重建，验证后提交推送创建implementation PR，不合并、不操作生产、不启用Gate、不删除业务数据。禁止自动migrate dev/reset/db push；已审SQL仅在确认的隔离库执行migrate deploy。数据库连接目标要再次核对，不能因变量名含test就认定安全。

以下12条仅供那时维护者执行，**AI不得代发grant；现在不需要运行**。每条仅一个具体路径，不使用prisma/**或test/**扩大写集：

```bash
cd /Users/dengwang/Documents/coding/srvf-nest-api
pnpm harness:grant 'prisma/schema.prisma' --reason "维护者确认 D1-3 140路径完整实施方案 A；仅计划合并后执行"
pnpm harness:grant 'src/modules/permissions/permission-catalog.ts' --reason "维护者确认 D1-3 140路径完整实施方案 A；仅计划合并后执行"
pnpm harness:grant 'scripts/harness-guards.selftest.ts' --reason "维护者确认 D1-3 140路径完整实施方案 A；仅计划合并后执行"
pnpm harness:grant 'harness/domain-map.json' --reason "维护者确认 D1-3 140路径完整实施方案 A；仅计划合并后执行"
pnpm harness:grant 'harness/state-machines.json' --reason "维护者确认 D1-3 140路径完整实施方案 A；仅计划合并后执行"
pnpm harness:grant 'harness/authz-assertion-patterns.json' --reason "维护者确认 D1-3 140路径完整实施方案 A；仅计划合并后执行"
pnpm harness:grant 'harness/authz-implication-graph.json' --reason "维护者确认 D1-3 140路径完整实施方案 A；仅计划合并后执行"
pnpm harness:grant 'harness/permission-surface-baseline.json' --reason "维护者确认 D1-3 140路径完整实施方案 A；仅计划合并后执行"
pnpm harness:grant 'test/contract/openapi.contract-spec.ts' --reason "维护者确认 D1-3 140路径完整实施方案 A；仅计划合并后执行"
pnpm harness:grant 'test/contract/__snapshots__/openapi.contract-spec.ts.snap' --reason "维护者确认 D1-3 140路径完整实施方案 A；仅计划合并后执行"
pnpm harness:grant 'prisma/migrations/20260911100000_activity_os_r4_d1_3_time_policy_selection/migration.sql' --reason "维护者确认 D1-3 140路径完整实施方案 A；仅计划合并后执行"
pnpm harness:grant 'docs/ai-harness/ROUTE_AUTHZ.md' --reason "维护者确认 D1-3 140路径完整实施方案 A；仅计划合并后执行"
```

未来若main有变化，先重新核对路径/编号/基线；新增写集仍单独报告，不借“140路径方案”改变全局执法规则。机器授权只解写入，不解合并。

## 11. 本次未做

本轮仅文档与只读核验，按追加授权补充changelog并提交计划PR。没有D1-3代码/schema/migration实施，没有数据库连接或重建，没有Gate/生产/业务数据清理，没有跨模型复审或合并。D1-2已收口，D1-3方案已确认但未实施，D2–D8及整个Activity OS目标仍未完成。
