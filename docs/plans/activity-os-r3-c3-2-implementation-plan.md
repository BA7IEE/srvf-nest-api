# Activity OS C3-2 精确实施计划：完整确认、正式更正与现行成果

> **2026-09-09 实施状态更新**：维护者已批准 #1299 完整实施包、app_test_w98 隔离验证与通过后提交/推送/创建 PR；不合并、不操作生产、不启用 Gate、不删除业务数据。另确认保留本轮未提交改动继续，以及 §4 附件锁序说明更正。当前实施与本地验证见 §11；下方“仅文档/不实施/尚未复现”保留为原评审时点记录，不再代表当前授权。3b/4b 已于 2026-09-09 按维护者确认重签并通过机器对拍。

> 2026-09-09；调查基点 main `62abb469`（#1298）。维护者已批准 **C3-1 台账更正、本计划起草及补充 changelog、提交、推送、创建文档评审 PR**；不合并、不实施、不操作数据库。下面均为待批准方案，不是已交付事实或可执行授权。
> 上位合同：[C3 方案 A §4–§8](../archive/reviews/activity-os-r3-c3-automatic-metrics-confirmation-review.md)。C3 只按 C3-1／C3-2 串行交付；本计划包含正式更正，不另拆 C3-3。候选、成果、来源、附件引用和命令收据长期保留，不设计删除或到期清理。

## 1. 当前证据与完成边界

C3-1 已合入 #1298，116 migration、权限 256、Audit events 164 总计／159 活跃。18 项 PR 检查及 3b/4b 已通过；main CI [34329487288](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34329487288) 已核验 completed/success。C3-1 只产候选，不能冒充正式成果；C3-2 完成也不代表 C4/C5、生产或整份蓝图完成。

| 当前源码证据 | 对本计划的约束 |
|---|---|
| `activity-outcome.service.ts:record`、`activity-outcome-policy.ts:nextActivityOutcomeRevision` | C2 仅录完整 manual draft，latest 非 draft 即拒绝。保留原方法、旧 DTO、record_manual_outcome 收据及历史重放；不能扩大此入口支持 confirmed 后编辑。 |
| `prisma/schema.prisma:ActivityOutcomeRevision` | 已有 draft/confirmed/superseded、priorRevisionId，没有独立现行正式指针；最大 revision 可能是更正草稿。 |
| 第 113 条 migration 的 `activity_outcome_content_guard`、`activity_outcome_child_immutable` | 头仅允许状态变化；值、证据不可更新或删除。新确认必须复制成新修订，不能给旧值补确认人时间。 |
| 第 113 条 `activity_outcome_chain_guard`／`activity_value_confirmation_guard` | 只检已有行 metadata，不证明 required、至少一值、每值附件或唯一 confirmed；必须 additive 加强，旧 SQL 不改。 |
| `activity-metric-candidate-query.service.ts:get` | 开自身事务且验证 read 权限；freshness 包含 expectedOutcomeRevision。确认不得调用此 HTTP 查询再另开写事务，也不能仅凭 DTO 的 fresh 字符串写入。 |
| `activity-metric-candidate-source.query.ts:readTrusted` | 接收 caller tx，复算输入可在同一 Activity 锁边界读取；不新增跨域直查。 |
| `activity-outcome-access.service.ts:authorize` | 已有 Human App、显式组织权限、组织有效性、initiator/owner 及锁后重读；新增动作扩闭集，不能将 read/record 当 confirm。 |
| `attachments.service.ts:lockOwnerReferenceStorageBoundaryTrusted/findOwnedAttachmentsTrusted` | 已有 tx 内同活动附件、删除意图围栏；沿用这两个公开属主接口。 |
| `attachment-storage-orchestrator.ts:prepareDelete` | Attachment 锁后查 `activityMetricValueEvidence`，被成果引用则拒绝删除意图。新正式值继续用该证据表，不另开绕过保护的附件表。 |
| `activity-outcome-query.service.ts`／`activity-outcome-presenter.ts` | 历史按自身精确集解释；保持原响应。新增 current-confirmed 独立读面和 caller-tx 选择器。 |

## 2. 推荐方案 A：一套成果修订链，独立新命令

保留 C2 三表作为成果事实，新增不可变确认／更正命令收据与来源关联；不建立第二套正式成果表。拒绝方案 B“覆盖旧值／直接把旧 draft 改 confirmed”：会破坏旧创建事实与重放合同。失败回退停新命令，保留所有新增历史及 migration，不恢复旧值、不 down migration。

### 2.1 人工和系统值组成一份完整成果

- Confirm 请求固定 activity、operationKey、expectedLatestRevision、expectedConfirmedRevision（首次为 0）、精确集 id/hash、可选当前 manual draft ID、可选 system candidate ID，以及逐指标来源选择和附件 ID。每指标只能选 manual 或 system；拒绝重复、未知指标、AI/import、short_text、客户端自报系统数值和自由来源字符串。
- manual 选择必须引用所选 draft 内既有 value ID；服务端重新跑 C2 canonical/valueHash 校验并复制。需要改变人工数字时，初次确认前走原 C2，已有 confirmed 后走本节专用更正草稿。请求不能在 confirm 时夹带未保存的人工改值。
- system 选择引用同活动、同精确集候选内的指标值；服务端按旧 evaluator 和持久输入复算、对拍值与 rule/source/bindings 摘要，再在根事务内验证 live 来源。候选必须可复算且当前来源未变；不可用／stale 明确拒绝，不能静默重新算后确认。
- 每个 required 项必须恰好一次，optional 可缺省；至少一个有效值。每个被确认值必须有 1–20 个不重复、同活动且可用的附件引用。最多 100 值、合计最多 2000 引用；超一即拒绝，不截断。系统来源快照不算附件，不自动生成证明附件。
- 每值 metadata 在新行写入同一当前确认人和同一服务端时间。manual 固定受控版本标识，system 固定 binding/evaluator/candidate-value 引用；不可让客户端指定确认人、时间、规则或来源摘要。

### 2.2 正式更正与取消（不删数据）

| 操作 | 条件 | 同事务结果 |
|---|---|---|
| 初次确认 | completed/terminated；无现行 confirmed；精确匹配 latest draft 或 latest=0 的 system-only 候选 | 新 revision 为 confirmed；若存在旧 draft，仅转 superseded；其值与旧收据不动。 |
| 准备／追加更正草稿 | completed/terminated；明确 expectedLatestRevision 与 expectedConfirmedRevision；当前负责人有 correct 权限 | 新 draft 复制完整拟议值和来源，旧 pending draft 转 superseded；原 confirmed 保持现行。 |
| 确认更正草稿 | latest 指向该 draft；base confirmed 双锚未变；confirm 权限、来源与证据重新核验 | 原 confirmed 和该 draft 转 superseded，新 revision 成为 confirmed；失败全部回滚。 |
| 取消更正草稿 | latest 为指定更正 draft；base confirmed 未变；correct 权限 | draft 转 superseded，写不可变取消收据；原 confirmed 不动，全部旧值和来源仍保留。不新增 cancelled 状态码。 |
| 再次更正 | 允许 latest 是已取消／被替换的 superseded 头，必须经新 C3 命令核验其收据与现行 confirmed | 新 revision=latest+1，prior 指向真实 latest，baseConfirmed 指向仍有效的 confirmed。C2 旧 record 仍拒绝。 |

同一活动至多一个当前 confirmed；准备更正不造成“暂时没有正式成果”。正式选择器只查 confirmed，不取 max(revision)。superseded 不可恢复；不提供删除、撤销正式成果或跨活动搬运接口。

### 2.3 候选 freshness 与草稿推进不能混为一谈

C3-1 候选记录计算时 expectedOutcomeRevision。准备更正会新建 Outcome draft，若确认时机械要求 candidate.expectedOutcomeRevision==当前 latest，新 draft 自己就会使来源失效。

推荐：准备时校验候选 expectedOutcomeRevision==准备前 latest；在不可变来源关联中固定 preparedAgainstRevision 和 candidateId。确认该更正草稿时要求：draft 仍为 latest、baseConfirmed 未变、关联记录的 preparedAgainstRevision 等于 draft.prior 的 revision；另外重新验证 live sourceDigest、规则、精确集和重算结果。这只豁免本草稿自身造成的一次版本推进，绝不豁免源事实变化或另一笔修订。初次直接确认候选仍要求候选 expectedOutcomeRevision==当前 latest。

不修改 C3-1 对外 freshness 合同。提取候选纯复算部分为共享纯函数；确认专用 caller-tx 验证器分别判断“输入可复算”“live 来源匹配”“允许的成果版本关系”。原 C3-1 查询保持原判定，新增 characterization 保证不漂移。

## 3. 数据库合同（拟议，不预占 migration）

预计一条第 117 additive migration，实际编号、时间戳在 implementation 批准前按 main 重核；本轮不创建 SQL，不申请假路径授权。

1. 新 `ActivityOutcomeFinalizationReceipt`：id、actorUserId、operationCode、operationKey、requestHash、activityId、outcomeRevisionId、baseConfirmedRevisionId?、resultJson、createdAt。operation 闭集 confirm_outcome / prepare_outcome_correction / cancel_outcome_correction；唯一(actorUserId,operationCode,operationKey)。同活动复合 FK 指向 outcome/base；actor FK Restrict。取消收据指向被取消 draft，不伪造新 Outcome 行。
2. 新 `ActivityOutcomeValueSource`：id、valueRevisionId、outcomeRevisionId、activityId、setVersionId、metricDefinitionId、sourceKind、manualValueRevisionId?、candidateValueId?、preparedAgainstRevision?、createdAt。每新值至多一个关联；manual/system XOR，受控 FK 而非仅自由 sourceReference。新值同链复合键必须含 definition；manual 原值同 activity/set/definition；candidate 原值同 activity/set/definition。需在被引用表补精确 unique 锚和 Prisma 反向关系；全部 Restrict，不级联删除。C2 历史值不回填新关联，C3 新收据覆盖的值必须完整关联。
3. 更正基点由 prepare 收据的 baseConfirmedRevisionId 和 outcome FK 固定；不为每 Outcome 复制指针、不改旧 createdAt。确认的新值可引用 manual 草稿值或 candidate 值，不能只留一个不可复算的 hash。
4. 增加 `ActivityOutcomeRevision(activityId) WHERE statusCode='confirmed'` partial unique。生命周期只允许 draft→superseded、confirmed→superseded；C3 新 confirmed 通过 INSERT 创建，禁止 draft→confirmed 原地升级和 superseded 复活。必要的旧 trigger 替换只放新 migration，不改第 113/114/116 SQL。
5. confirmed 完整性使用 deferred constraint trigger：至少一值、required 集合完全覆盖、值数≤100、每值 1–20 evidence、所有确认 metadata 一致、同链来源引用、精确集及规范值约束。完整聚合在最终新收据触发一次；头／子行局部守卫防止缺收据、晚追加、UPDATE/DELETE 和封存后补值。为旧 C2 writer 保留原合法 draft 组装路径；不能要求旧 record 收据具有新 operation。
6. 新 receipts 和 source 记录 UPDATE/DELETE 拒绝。取消和更正只变化允许的头状态，历史值、附件引用、source 和旧 receipts 逐字不变。
7. migration 先只读扫描唯一 confirmed、生命周期、metadata、required、证据异常；异常 fail-closed，零回填／修数／删除。不假定历史只有 draft，非空升级必须含合法 confirmed 和 superseded 夹具；合法历史 confirmed 不被强迫补新收据或来源关联，新增命令覆盖范围由新 receipt 辨别。历史异常需单独汇报，不用宽松豁免隐藏。

上列两个新模型的复合 unique/FK 字段顺序、约束名及 trigger 挂载责任见 §10.3，事务组装与旧 C2 共存见 §9.1。均为待评审设计，数据库验证必须在 implementation 与隔离库授权后进行；不能把文档静态核验当作 SQL 验证通过。

## 4. 事务、权限与证据留存

推荐新增 `activity.outcome.confirm`、`activity.outcome.correct` 两码：分别负责确认与准备／取消更正；read 沿既有 `activity.outcome.read`。均为显式 Human 授权，不自动赋给内建角色，不允许 SP/delegation、SUPER_ADMIN 直通。确认者可为录入者，沿已批准负责人单人确认，不新增双人审批。

锁序（维护者 2026-09-09 确认更正）：命令 advisory → Activity FOR UPDATE → 按稳定次序的指标引用锁 → Attachment FOR SHARE。确认沿既有附件属主接口，在附件引用锁内校验 StorageObject 的 available、资源归属与删除意图，不额外取得 StorageObject/operation 锁。Attachment → StorageObject → operation 是删除路径的锁序，不是成果确认路径；此前把两者混写，本次不改 Storage 生产代码。候选与成果 immutable 子记录在 Activity 锁下读，不能为了确认另开事务。每次实际锁等待后重验当前用户、成员、显式权限、组织有效性和 owner；只有 completed/terminated 接受新写，cancelled/archived 拒绝。重放先验证当前访问权，再返原收据；不重新要求原创建状态仍存在、不重新执行业务。

附件在最后一次引用锁后重验同活动、可用、未有删除意图；被引用后沿既有 Evidence 删除保护，不改 Storage 私有实现。用两连接分别让确认先拿锁和删除意图先拿锁，证明拒绝方向正确。若发现既有原语不足，先列精确扩展再批准，不复制 Storage 表查询到活动模块。

敏感字段三问：用途=证明指定成果值；查看=当前显式获权负责人／既有受控附件访问；留存=本轮不删业务数据、退队不抹历史；个人身份与原始来源不进入列表或审计。未获单项敏感证据审批的内容保持不可用，不借“不删除”开放敏感字段。

推荐新增安全事件 `activity.outcome.finalization`，独立新 recorder，避免扩旧 C2 result 类型。仅 operation、活动与修订锚、createdStatus、source 类别、值／证据数量；不含实际值、成员名单、附件凭证、operationKey、requestHash 或原始来源。预计权限 258、Audit 165 总计／160 活跃仅为预算，不修改现读或提前 4b 签字。

## 5. 拟议接口与安全回执

公共前缀 `/api/app/v1/my/managed-activities/:activityId`，采用独立 controller／App DTO，不派生 Admin。

| 方法与相对路径 | 行为／权限 |
|---|---|
| POST `outcome-confirmations` | 初次或更正确认；confirm |
| POST `outcome-corrections` | 创建／追加完整更正草稿；correct |
| POST `outcome-corrections/:outcomeRevisionId/cancel` | 保留事实的取消命令；correct |
| GET `outcome-confirmed` | 当前正式摘要与安全明细；read；无正式结果返回明确空值，不伪造 draft。 |

新回执 schemaVersion=1，固定 activityId、outcomeRevisionId、revision、createdStatusCode、valueCount、evidenceCount、createdAt、operationCode；取消额外以 operationCode 表意，不谎称新建修订。旧回执不变。新读面可返回 isCurrentConfirmed 与 confirmedAt，但不返回确认人身份或内部来源明细；历史详情是否追加新字段不在本批，沿原 DTO。

错误按无权／不存在同出口；重复 key 异 hash=冲突，陈旧 revision／source=明确 stale，无 source=unavailable，证据不足与非法值=校验错误。复用现有错误语义可覆盖者，不盲加 BizCode；确需新码先核闭集与 HTTP 映射，再在授权表写数字。当前未分配错误码。

## 6. 精确路径预算（候选，不是写许可）

### 6.1 本轮实际文档写集

本轮七文件：`docs/ai-harness/NEXT_TASKS.md`、`docs/ai-harness/FROZEN_DRAFTS.md`、`prisma/CLAUDE.md`、`src/modules/activities/CLAUDE.md`、`docs/plans/activity-os-r3-c3-1-implementation-plan.md`、本文件，以及 `changelog.d/activity-os-r3-c3-2-plan.md`。历史 archive、代码、schema、测试及生成物不动；仅允许提交、推送和创建文档评审 PR，不合并、不实施。

### 6.2 implementation 新增候选路径

- `src/modules/activities/activity-outcome-finalization.service.ts`
- `src/modules/activities/activity-outcome-finalization-command.ts`
- `src/modules/activities/activity-outcome-finalization-command.spec.ts`
- `src/modules/activities/activity-outcome-finalization-policy.ts`
- `src/modules/activities/activity-outcome-finalization-policy.spec.ts`
- `src/modules/activities/activity-outcome-finalization-audit-recorder.ts`
- `src/modules/activities/activity-outcome-finalization-audit-recorder.spec.ts`
- `src/modules/activities/activity-outcome-confirmed-query.service.ts`
- `src/modules/activities/activity-outcome-confirmed-query.service.spec.ts`
- `src/modules/activities/activity-outcome-confirmed-presenter.ts`
- `src/modules/activities/activity-outcome-confirmed-presenter.spec.ts`
- `src/modules/activities/activity-metric-candidate-replay.ts`
- `src/modules/activities/activity-metric-candidate-replay.spec.ts`
- `src/modules/activities/activity-outcome-candidate-validation.ts`
- `src/modules/activities/activity-outcome-candidate-validation.spec.ts`
- `src/modules/activities/controllers/app-managed-activity-outcome-finalizations.controller.ts`
- `src/modules/activities/dto/app/app-activity-outcome-finalization.dto.ts`
- `test/e2e/activity-os-r3-c3-2-outcome-finalization.e2e-spec.ts`
- `test/e2e/activity-os-r3-c3-2-outcome-concurrency.e2e-spec.ts`
- `test/e2e/activity-os-r3-c3-2-outcome-migration.e2e-spec.ts`

### 6.3 implementation 既有直接路径

- `prisma/schema.prisma`
- `src/modules/activities/activities.module.ts`
- `src/modules/activities/activity-outcome-access.service.ts`
- `src/modules/activities/activity-outcome-access.service.spec.ts`
- `src/modules/activities/activity-metric-candidate-query.service.ts`
- `src/modules/activities/activity-metric-candidate-query.service.spec.ts`
- `src/modules/permissions/permission-catalog.ts`
- `src/modules/permissions/seed-permission-codes.ts`
- `src/modules/permissions/permission-code-holders.spec.ts`
- `src/modules/audit-logs/audit-logs.types.ts`
- `src/common/exceptions/biz-code.constant.ts`（仅在错误语义预算定稿后）
- `test/contract/openapi.contract-spec.ts`
- `test/contract/__snapshots__/openapi.contract-spec.ts.snap`

既有 C2 record／policy／DTO／receipt parser、附件私有实现、Authz/Users/Organization 原语只读复用，未列为可改路径。未来移出共享纯复算逻辑前先跑 C3-1 characterization，差异即停，不改旧断言掩盖。

### 6.4 派生与旧测试后果（待逐文件展开后才可授权）

schema 会联动 domain-map、state-machines、STATE_MACHINE_INVENTORY、counts；接口会联动 ROUTE_AUTHZ、OpenAPI snapshot/json、13 个 clients 生成文件、RBAC_MAP、permission-surface-baseline；新权限影响 permission holders／seed 及 harness 计数自测。未来还涉及 CODEMAP、AUDIT_EVENT_REGISTRY、current-state、handoff、模块摘要、两份台账、CUTOVER_SIGNOFF 和获批 changelog fragment。

旧 migration 测试至少包含 C3-1 §7.3 的 16 份及 C3-1 自身 migration suite；不得把此前名单当完整清单。实施前按 CURRENT_MIGRATION_COUNT、标题直接字面量和权限总数引用链交叉扫描，输出逐文件修改位置与历史目标保持项。当前不允许通配替换 116→117、256→258，不更新 snapshot 基线或编造授权命令。

直接路径已核验：§6.2 的 20 个新增路径均不存在，§6.3 的 13 个既有路径均存在。派生闭包与 16 份当前 migration 计数测试见 §10；21 个拟议约束／触发器名均不超过 63 字节。migration 的最终时间戳须在 implementation 授权包中按当时 main 指定，不使用通配符替代精确授权。本稿只提供评审设计，不表示已经获准写上述路径。

## 7. 探针／DoD 与验证顺序

| 编号 | 必证行为 |
|---|---|
| Q01 | manual-only、system-only、混合来源三种完整成果均确认成功；每个 required、至少一值、每值附件闭合。 |
| Q02 | source/hash/规则/跨活动/跨集/跨指标任一篡改拒绝；不可用不当零、stale 不静默重算。 |
| Q03 | 初次确认复制新值；旧 draft/值/evidence/C2 收据逐字保持，仅允许头转 superseded。 |
| Q04 | 更正草稿存在时旧 confirmed 仍可读；确认后仅新头有效；取消不删历史、取消后仍可再次更正。 |
| Q05 | 候选准备前 expectedOutcomeRevision 与自身 draft 推进分离：自己推进可确认，外部修订／来源变化必拒绝。 |
| Q06 | 两池同 key 同请求原回执、异请求冲突；双 expected 锚竞争至多一笔；确认与取消交错不丢正式头。 |
| Q07 | 每种锁等待后撤权、用户／成员／组织失效、owner 变更含重放拒绝，候选／成果／审计无部分写。 |
| Q08 | 附件删除意图与确认双向锁交错；删除先胜则拒绝确认，确认先胜则永久引用保护生效。 |
| Q09 | 值／来源／证据／收据／审计每一步故障完整回滚；旧正式值及参与／结算／账本不变。 |
| Q10 | PG 直接 SQL 双 confirmed、空 confirmed、缺 required/metadata/evidence、错链、晚追加、非法状态跃迁均被拒绝；合法路径通过。 |
| Q11 | 116 冷回放→117、非空升级含 C2/C3-1/合法历史正式与异常反例，失败整体回滚、零修数。 |
| Q12 | 退队／归档历史仍可由当前获权者读取；原用户失效；superseded 来源与附件引用保留。 |
| Q13 | 无外部模型或网络也能确认；App DTO／审计无名单、确认人身份、原始来源或凭证；SP/delegation 拒绝。 |
| Q14 | 原 C2/C3-1 E2E、收据和 snapshot 行为不变；原 SQL hash 不变。 |
| Q15 | 100 值／2000 evidence 边界和 cap+1；复用 C3-1 2000 人／20000 event／10000 source 来源预算，不能截断。 |
| Q16 | quick、build、contract、受影响 E2E、所有派生／架构新债检查、PR CI、main CI 分别核验；整体复审明确后置。 |

顺序：先旧行为 characterization → 纯函数与 SQL 约束正反例 → 真实 HTTP/DB 与并发 → quick/build/派生 → PR CI → main CI。P/Q 名字不是完成证据；需记录真实命令、退出码、具体测试与 commit。不得改断言让历史红变绿。

## 8. 集中授权与禁止域

本轮继续补齐文档不用反复请示。待计划全部字段与写集闭合后，一次呈交：完整方案 A、精确红区路径、隔离库范围、验证预算、真实 migration/权限/审计增量、提交推送开 PR 边界。只在实际新增后重签 3b/4b，不预签。

数据库建议仅 app_test_w98；**当前未授权本阶段任何数据库操作**，沿 C3-1 的授权不得自动继承。migrate dev/reset/db push 不自动运行；维护者 grant 由维护者执行，AI 不自行授令牌。生产部署、Gate、前端发布、AI/import、C4/C5、业务数据删除、扩大 CI 超时与跨域白名单均不包含。

## 9. 本次未做

未实施任何接口、模型、migration、测试或权限；未改 C2/C3-1 行为，未操作数据库、提交推送或创建 PR。合同、直接路径、派生清单及旧测试前置调整已形成评审草案；实际 SQL／并发／升级验证尚未执行，不能声明实现通过或生产可用。

## 9.1 数据库兼容接缝复核（覆盖前文相应待补事项）

### 新 confirmed 的事务内组装

推荐同一事务按“旧头合法 supersede（更正确认时）→ INSERT 新 confirmed 头 → INSERT 带齐 confirmation metadata 的值 → evidence → source → finalization receipt → 最小 audit → COMMIT”组装。第 113 条 BEFORE value trigger 要求 confirmed 值当场带齐 metadata，因此不插中间不完整值。头完整性使用 deferred trigger，允许本事务内先头后子，提交时不允许空正式成果。收据在子记录齐全后写，写后禁止追加；任何错误回滚所有状态变化，不存在对其他事务可见的临时无正式头。

新 prepare draft 同样先头、值、证据、source，最后 prepare receipt；不使旧 confirmed 失效。prepare 可以像 C2 一样保存尚缺 required／附件的完整拟议快照，prepare receipt 只检查形状、数量、同链和来源，不套用确认级完整性；确认时才检查 required 和每值附件。取消只允许现行 prepare receipt 对应的 latest draft，取消回执时间取新收据 createdAt，目标修订创建时间单独保留，不能将取消操作者错误要求为旧 draft 创建人。

### 人工更正的新输入不能伪造旧值来源

更正草稿允许录入新 manual value，而不是强迫每个新值引用旧值（否则无法真正更正数字）。因此前文 Source manual/system XOR 细化为：system 必须 candidateValueId 非空、manualValueRevisionId 为空；manual 必须 candidateValueId 为空，manualValueRevisionId 在 prepare 新人工值时为空（受控 human_manual／manual-outcome-v1），在 confirm 复制人工草稿值时非空且精确指向该草稿。是否允许 NULL 由父头的 prepare/confirm 收据约束，不由客户端选择绕过。C2 原 manual 草稿无需补新 Source；从它确认时新正式值必须建立指向旧值的 Source。manual 前代必须 revision 更小且 sourceCode=manual；禁止自环、互环或将 system 改字面标签为 manual。

### 收据封存与旧 C2 不相互代替

第 114 条 `activity_outcome_receipt_guard` 只验证 INSERT 时的创建事实、operation 固定 record_manual_outcome，不是通用 finalization receipt，也没有晚追加守卫。新局部守卫以“存在 C2 创建收据或 C3 prepare/confirm 收据”为封存标记；cancel 收据不能充当创建收据。历史合法 C2 创建协议先子后收据可通过；之后只允许有合法新命令证据的状态推进，子记录永久不变。

生命周期 UPDATE 的 deferred 校验必须绑定**新追加的后继修订／取消收据**，不能仅查到任意旧 receipt 就放行：C2 supersede 对应后继 draft.priorRevisionId=旧头、后继的 record receipt；更正确认对应新 confirmed 的 confirm receipt、精确 baseConfirmed 与目标 draft；取消对应 cancel receipt、精确目标与仍现行的 baseConfirmed。旧 receipt 只能证明自己的历史创建事实，不能证明本次非法状态转换。

### 历史 confirmed 与新 confirmed 的边界

migration 对已有 confirmed 逐项验证唯一性、非空、required、metadata 和证据，异常整体失败；合法历史头和值不回填新 Source/receipt。新增头的 deferred INSERT 校验只针对本次触发的 NEW.id 必须存在新 confirm receipt，因此不需要按 createdAt 猜历史、不需要迁移哨兵列或清理名单。历史 confirmed 的 supersede 只能由新合法更正确认 receipt 支撑；未触碰的历史事实不因缺新关联而被重写。

### 值校验分工

Service 复用 `fingerprintActivityOutcomeValue` 负责 TypeScript canonical/valueHash；system 复用旧 evaluator。数据库负责标量闭集、定义同链、required、metadata、来源 FK、证据完整性及不可变性；需要 DB 检验的类型范围／精度／options 必须按已存定义配置逐类编写，不能把 JS 序列化 hash 在 SQL 中随意再实现一遍。直接 SQL 篡改 hash 与值的数学一致性不宣称已由普通 CHECK 证明；读面复算拒绝与写服务受控生成分别给证据，数据库强约束声明限定到实际执行的规则。

### 已定位旧测试冲突，须随实施包明确批准

`test/e2e/activity-os-r3-c2-outcome-value-revision.e2e-spec.ts` 的 “rejects confirmation without value metadata on either insertion or status change” 用例（基点第 236–247 行），在独立 sql 调用中先提交空 confirmed，再插非法值。该前置与 C3 提交时禁止空 confirmed 直接冲突，不是简单迁移计数调整。

推荐将第二个反例改为**同一事务**组装新 confirmed 后立即尝试缺 metadata 的值，仍断言 23514；错误使事务回滚，并验证零残留。第一个“旧 draft 不能靠 UPDATE 绕过 metadata”的反例保留 23514，不更改为放行。新增另一个独立 C3 反例证明“仅插空 confirmed 后 COMMIT”失败。该调整改变测试前置但保留原行为断言，必须明确纳入 implementation 批准，不在本次文档授权下修改。

这项源码证据已定位；当前没有数据库授权，未执行 SQL 复现。上述内容是可评审设计而非通过验证的实现，复现留到批准后的隔离测试。

## 10. 精确后果清单补稿（2026-09-09，只读定位）

### 10.1 当前迁移计数 16 文件

已用 rg 和 Node 独立逐文件读取核对，下列 15 份 CURRENT_MIGRATION_COUNT=116 及 C2 D1 一份直接标题／toBe('116') 共 16 文件。仅当前全回放读数更新为实际新总数；历史 112→113、113→114、115→116 的升级目标不改。

- `test/e2e/activity-os-r1-a3-template-definition-lifecycle-guards.e2e-spec.ts`
- `test/e2e/activity-os-r1-a4-explicit-template-version-pointer.e2e-spec.ts`
- `test/e2e/activity-os-r2-b1-place-schema-constraints.e2e-spec.ts`
- `test/e2e/activity-os-r2-b2-coordinate-projection-schema-constraints.e2e-spec.ts`
- `test/e2e/activity-os-r2-b3-form-blueprint-governance.e2e-spec.ts`
- `test/e2e/activity-os-r2-b6-creation-data-foundation.e2e-spec.ts`
- `test/e2e/activity-os-r3-c1-d2a-metric-command-receipt-migration.e2e-spec.ts`
- `test/e2e/activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts`
- `test/e2e/activity-os-r3-c1-metric-definition-set.e2e-spec.ts`
- `test/e2e/activity-os-r3-c2-outcome-value-revision.e2e-spec.ts`
- `test/e2e/activity-v11-batch4-allocation-candidate-position-anchor-migration.e2e-spec.ts`
- `test/e2e/activity-v11-batch4-allocation-command-replay-migration.e2e-spec.ts`
- `test/e2e/activity-v11-batch4-allocation-determinism-migration.e2e-spec.ts`
- `test/e2e/activity-v11-batch4-allocation-mode-migration.e2e-spec.ts`
- `test/e2e/activity-v11-batch4-qualification-contract-migration.e2e-spec.ts`
- `test/e2e/insurance-evidence-registration-revision-migration.e2e-spec.ts`

C3-1 migration suite 不是简单 CURRENT_MIGRATION_COUNT 适配：`test/e2e/activity-os-r3-c3-1-candidate-migration.e2e-spec.ts` 必须保留第 116 条目标与 115→116 验证，新的 116→117 由新增 C3-2 suite 承载。另将 `test/e2e/activity-os-r3-c2-d2-outcome-receipt-migration.e2e-spec.ts` 纳入影响核对（不是默认要改）。C2 D1 旧 TRUNCATE 引用新表 FK 后可能需要显式清理新收据／source 测试夹具；仅允许补前置，原行为断言不变。涉及正式状态的新约束若使旧合法行为断言失败，必须逐例报告，不能将行为变更伪装成夹具适配。

### 10.2 已枚举派生文件

- `CODEMAP.md`
- `docs/ai-harness/AUDIT_EVENT_REGISTRY.md`
- `docs/ai-harness/CUTOVER_SIGNOFF.md`
- `docs/ai-harness/FROZEN_DRAFTS.md`
- `docs/ai-harness/NEXT_TASKS.md`
- `docs/ai-harness/RBAC_MAP.md`
- `docs/ai-harness/ROUTE_AUTHZ.md`
- `docs/ai-harness/STATE_MACHINE_INVENTORY.md`
- `docs/current-state.md`
- `docs/handoff/admin-web.md`
- `docs/handoff/miniapp.md`
- `docs/handoff/openapi.json`
- `harness/domain-map.json`
- `harness/state-machines.json`
- `harness/permission-surface-baseline.json`
- `scripts/harness-guards.selftest.ts`
- `prisma/CLAUDE.md`
- `src/modules/activities/CLAUDE.md`
- `docs/handoff/clients/admin/client.ts`
- `docs/handoff/clients/admin/types.ts`
- `docs/handoff/clients/app/client.ts`
- `docs/handoff/clients/app/types.ts`
- `docs/handoff/clients/auth/client.ts`
- `docs/handoff/clients/auth/types.ts`
- `docs/handoff/clients/integration/client.ts`
- `docs/handoff/clients/integration/types.ts`
- `docs/handoff/clients/open/client.ts`
- `docs/handoff/clients/open/types.ts`
- `docs/handoff/clients/system/client.ts`
- `docs/handoff/clients/system/types.ts`
- `docs/handoff/clients/shared/types.ts`

admin/app 允许获批新接口对应生成定义；shared 按生成器真实分配，其他 surface 仅摘要。不改生成器、package、workflow、lockfile。权限相关计数当前定位：`scripts/harness-guards.selftest.ts` CLOSURE_PERMISSION_CODE_COUNT 及对应注释，C1 D2b selection-template migration suite 的 permissions 总数断言；按实际新增结果对拍，不放宽守卫。clock-authority 对 createdAt 有既有审计时间豁免；confirmedAt 已是旧列，本方案不新增判定时间列，暂不扩其写集。

### 10.3 SQL 约束与挂载责任细表（建议命名）

所有新模型 id=String @id @default(cuid())；字符串存 TEXT，revision=Int，resultJson=Json，createdAt=DateTime @default(now())。preparedAgainstRevision 为 nullable Int≥0；manual 来源可空，system 必填；操作键/hash 复用 C2 闭集长度及 canonical 规则，不能另建不兼容的 hash 算法。

| 名称 | 精确锚／职责 |
|---|---|
| `outcome_finalization_command_key` | Receipt UNIQUE(actorUserId,operationCode,operationKey) |
| `outcome_finalization_outcome_fk` | Receipt(outcomeRevisionId,activityId) → Outcome(id,activityId) |
| `outcome_finalization_base_fk` | Receipt(baseConfirmedRevisionId,activityId) → Outcome(id,activityId)，首次确认 NULL |
| `outcome_finalization_actor_fk` | Receipt(actorUserId) → User(id) |
| `outcome_source_value_key` | Source UNIQUE(valueRevisionId) |
| `outcome_value_source_chain_key` | Value UNIQUE(id,outcomeRevisionId,activityId,setVersionId,metricDefinitionId) |
| `outcome_source_value_fk` | Source(valueRevisionId,outcomeRevisionId,activityId,setVersionId,metricDefinitionId) → Value 同序锚 |
| `outcome_value_origin_key` | Value UNIQUE(id,activityId,setVersionId,metricDefinitionId) |
| `outcome_source_manual_fk` | Source(manualValueRevisionId,activityId,setVersionId,metricDefinitionId) → Value(id,activityId,setVersionId,metricDefinitionId) |
| `candidate_value_outcome_origin_key` | CandidateValue UNIQUE(id,activityId,setVersionId,definitionId) |
| `outcome_source_candidate_fk` | Source(candidateValueId,activityId,setVersionId,metricDefinitionId) → CandidateValue(id,activityId,setVersionId,definitionId) |
| `outcome_one_confirmed_per_activity` | Outcome(activityId) partial UNIQUE WHERE statusCode='confirmed' |
| `outcome_source_kind_check` | sourceKind manual/system；system 仅 candidateValueId 非空且 preparedAgainstRevision≥0；manual 的 candidateValueId 为空，prepare 新人工值可无前代，confirm 必有 manualValueRevisionId（由收据完整性约束）；禁止自指 |
| `outcome_finalization_operation_check` | 三 operation 闭集；基点 NULL 只限首次确认；resultJson 精确 schema、数量、时间和目标锚一致 |
| `outcome_lifecycle_guard` | Outcome BEFORE INSERT/UPDATE/DELETE：不可逆状态、禁止改内容／删头；新增 confirmed 要求 finalization 收据在提交期闭合 |
| `outcome_finalization_complete_guard` | Receipt DEFERRABLE INITIALLY DEFERRED INSERT：一次聚合，区分 prepare/confirm/cancel，校验值、来源、required、metadata、证据、base 和 createdStatus |
| `outcome_finalization_head_guard` | Outcome deferred INSERT/UPDATE：校验本次合法状态转换的收据证据；历史 C2 draft→superseded 使用原 record 收据，不强制新 receipt |
| `outcome_finalization_value_guard` | Value BEFORE INSERT：父头串行锁、封存后拒绝追加；复用旧 metadata 验证，不放宽；新 C3 行最终由 receipt 聚合验证 |
| `outcome_finalization_evidence_guard` | Evidence BEFORE INSERT：父值与 Outcome 同链、序号及封存；附件可用由 tx 属主校验与 DB 同活动校验共同覆盖 |
| `outcome_finalization_source_guard` | Source BEFORE INSERT/UPDATE/DELETE：同链和来源类别、父封存、不可改删；manual 只可引用更早修订，避免环 |
| `outcome_finalization_receipt_guard` | Receipt BEFORE UPDATE/DELETE：拒绝；INSERT 验证局部形状，与 deferred 完整性分工 |

被引用表需 Prisma 同名 map unique 与反向 relation；所有 FK ON DELETE/UPDATE RESTRICT。receipt 外键列建普通索引，Source 的 manual/candidate 复合引用列建索引。旧 child immutable trigger 保留；旧头状态守卫新增更严的独立 trigger，不改其函数源；确认 metadata 的旧 BEFORE 约束仍需通过，不能先插不完整 confirmed 再补字段。partial unique 为即时约束，确认更正必须在同一事务先 supersede 旧 confirmed 再插新 confirmed，失败恢复旧头。

事务组装、receipt 封存、旧 C2 交互、canonical 职责和已定位旧测试前置冲突统一按 §9.1。它们尚未通过运行复现；实施时先写失败反例，再写约束实现。合法历史 confirmed 升级夹具必须包含 required/metadata/evidence 全部有效项；异常夹具逐项缺失并验证迁移原子失败。不得补数据让 migration 通过。本稿不输出可执行数据库命令、不提前签第 117 migration。

## 11. 当前本地验证记录（2026-09-09，未提交、未合并）

工作树新增 `20260909092502_activity_os_r3_c3_outcome_finalization`，实际 117 个 migration、151 模型、258 权限、165 审计事件（160 活跃）。所有 HEAD 已有的 117 个迁移文件（116 条 SQL 加 migration_lock.toml）用 git show 与磁盘 Buffer 逐字对比一致；只新增第 117 条 SQL。

| 验证 | 已取得的证据与边界 |
|---|---|
| C3-2 HTTP 生命周期 | `activity-os-r3-c3-2-outcome-finalization.e2e-spec.ts` 8 项通过：人工/系统/混合、候选自身更正推进与真实来源变化、正式更正/取消后再更正、归档退队保留、真实 100 值/2000 evidence 及 cap+1 拒绝。 |
| C3-2 并发与回滚 | `activity-os-r3-c3-2-outcome-concurrency.e2e-spec.ts` 59 项通过：两池幂等/双锚竞争、确认与取消竞争、五类资格变化在五个实际锁点复验（重放覆盖命令与 Activity 锁）、四类存储状态拒绝、附件删除意图双向竞争、值/证据/来源/收据与确认/准备/取消审计故障回滚。 |
| C3-2 SQL 与升级 | `activity-os-r3-c3-2-outcome-migration.e2e-spec.ts` 26 项及 beforeAll 冷回放/非空升级通过：116→117 保留 C2/C3-1 与合法历史正式事实；异常完整性/数值使新增迁移原子失败，零修数；完整直接 SQL 对照与缺证据/来源/required/错链反例通过。 |
| C2 旧行为 | 原 `c2-d2-manual-outcomes` 6 项、`c2-d2-outcome-concurrency` 11 项在新库通过，未改这两份源码或断言。 |
| C3-1 旧行为及预算 | 原 `c3-1-candidate` 30 项、`c3-1-candidate-concurrency` 9 项通过，包含真实 1000/1001 单身份链、2000 人/20000 事件/10000 来源预算及旧参与/结算/更正锁交错；源码与断言未改。 |
| 单测与编译 | `NODE_OPTIONS=--max-old-space-size=8192 pnpm agent:check:quick` exit 0：350 suites、7859 passed、5 既有 todo；`pnpm build` exit 0；新增测试再次 `tsc --noEmit -p test/tsconfig.test.json` 与定向冷 eslint 通过。完整冷 lint 曾在默认 4GB OOM，单进程 8GB 重跑通过，未修改 package/CI。 |
| 生成契约兼容 | OpenAPI JSON 的 470 个旧路径及 780 个旧 schema 用 deepStrictEqual 逐项一致；仅新增 4 路径和 7 schema；13 个客户端由既有生成器生成，其他 surface 仅摘要更新。 |
| 治理 | authz/feclient/codemap/rbacmap/counts/readtax/migcount/openapi 检查通过，boundaries metadata 151 模型/67 状态列齐全，new-debt-check 564 扫描/unknown=0。CODEMAP 的既有提示及本批 837 行服务大小提示保留，没有更改阈值。 |

数据库用例通过受控单进程诊断运行器执行原 spec、Jest expect/mock（旧 HTTP 复用 Jest ModernFakeTimers）、原 Nest/Prisma 与原数据库保护函数；每次先断言实际派生目标严格为 app_test_w98，逐文件串行执行。它不是标准 `pnpm test:e2e` 的 CI 全量结果，也不冒充标准 Jest 超时/泄漏检测。共享 app_test/app_test_w1 未获本批授权，因此未调用会重建共享模板的标准 globalSetup。

本次未做：未提交推送/开 PR，未完成该 PR 的 CI/可信红区审批/合并或 main CI；整体跨模型复审明确后置。未操作生产、开启 Gate、修改 Storage 生产代码、删除业务事实或放宽原测试断言。以上本地证据不代表整份蓝图完成或生产可部署。
