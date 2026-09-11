# Activity OS Release 4 / D3：时长分配修订精确实施计划与授权清单

> **当前状态（2026-09-12）**：维护者已确认 D3 方案 A，并授权本计划及台账的 docs-only PR。本计划的基点是 main 84e96f9135f2adc8585d0af6839cf856ade4ef01。本文只定义未来 D 档实施的合同、探针和精确候选写集；当前没有 D3 代码、schema、migration、数据库操作、Gate、合并或生产授权。

> **不把计划当能力**：以下模型名、错误码、权限、审计事件、锁序和未来路径，是实施前必须逐项兑现并验证的约束，不是当前仓库已经提供的功能。未来实施前如 main 已变化，必须重新 preflight、逐路径运行 harness:needs，并把实际生成的 migration 路径重新报维护者确认。

## 1. D3 要交付什么，以及绝不交付什么

D1 已固定活动在发布时选择的 TimePolicy，D2 已提供当前参与事实。D3 只补两者之间的不可变认定层：对一个已闭合、当前的服务段，依其发布快照中冻结的政策选择，记录可追溯的分类原始时间区间。

本批的完成定义如下：

1. 一个新 allocation revision 永远锚定一条 D2 当前服务段、一个活动发布 RuleSnapshot、一个冻结的 selection revision 和一个具体 policy/version/definitionHash/evaluatorVersion。
2. 自动认定与人工认定都只追加完整 revision；已写 revision、片段、证据和命令收据均不可原地改写或删除。
3. 分类片段只记录原始左闭右开区间，严格落在源服务段内、彼此不重叠、总秒数不超过源段；D3 不计算最终入账小时数。
4. 写命令具有独立幂等收据、最小审计、活动聚合锁、锁后资格重验和事务回滚语义。
5. D3 没有 HTTP controller、DTO、OpenAPI、客户端、Gate、队列、cron、AI 写入口或生产调用。D4 才单独评审 Bucket/人工工作台，D5-D8 仍各自独立立项。

| 明确排除 | 原因 |
| --- | --- |
| 改写 ParticipantServiceSegmentRevision、旧 serviceHours、结算、贡献、成果、证明或旧考勤读面 | 它们不是 D3 的新真相层；历史资产只保留，不双写、不回填。 |
| 正式 Time Ledger、入账、冲回、更正、证明、shadow 对账或 cutover | 分别属于 D4-D8，不能借 D3 先落地。 |
| Admin/App/Integration/AI HTTP 面、DTO、客户端、路由或 Gate | D3 先提供内部 application command；没有已获授权的对外行为。 |
| 按计划时段虚构 preparation、duty 或 travel 时间 | 当前事实只给真实参与段；不能从排班或计划时间制造实际时长。 |
| 删除、清库、回填或生产 migration | 不可逆业务数据动作和生产操作均不在本计划授权内。 |

## 2. 已核验的当前事实

| 依据 | 已核验事实 | 对 D3 的约束 |
| --- | --- | --- |
| T0 合同 §7.1 | AttendancePunchEvent 到 ParticipantServiceSegmentRevision 是唯一参与事实；allocation revision 是其后的认定层。 | D3 只能消费当前服务段，不能新建第二套参与事实。 |
| D2 ParticipationSegmentFacade | reader 返回同链的 activity/session/member/identity、历史 check-in 岗位、来源事件锚、状态、结果和时间区间；调用方自带 tx 与锁。 | D3 只能通过 Facade 读取段，锁后重读；不读取 serviceHours。 |
| ActivityRuleSnapshot 与 D1-3 selection revision | V8 快照持有 timePolicySelectionRevisionId；V2-V7 历史快照可为空。 | 正式 D3 只接受有 V8 选择锚的发布快照；旧快照 fail-closed，不能用目录默认值补齐。 |
| TimePolicyVersion 与 definition parser | definition 固定四类、allowSplit、specialIntervals、证据、manualAdjustment、evaluator 和向下取整规则。 | D3 只解释已验证的 immutable definition；退役版本仍可解释历史，不能替换为当前 active 版本。 |
| ActivityParticipationIdentity 与服务段复合锚 | identity 绑定 activity/session/member；服务段可用 sourceSegmentId 与 identity 组合证明来源。 | allocation 必须使用复合 FK 闭合活动、场次、成员、identity 与源段，不能只存裸 ID。 |
| Attachment 现状 | Attachment 是 ownerType/ownerId 多态归属；既有成果证据已经采用 owner/storage 双锁。 | D3 证据须在同一事务锁定活动 owner 与存储边界，并扩展删除保护。 |

当前仓库读数为 157 个模型、119 条 migration、262 个权限码、167 个 AuditLogEvent（162 个活跃）、625 个端点。若本计划完整实施且 main 未先变化，预期为 161 个模型、120 条 migration、263 个权限码、168 个 AuditLogEvent（163 个活跃）、625 个端点；这是预算，不是当前事实或提前签字。

## 3. 方案 A：不可变 allocation revision 合同

### 3.1 一条服务段的修订链

一条逻辑服务段由 participationIdentityId 加 segmentKey 定义。每次自动认定、人工认定或源段更正后的重新认定，都新增一条完整 ParticipantTimeAllocationRevision：

1. revision 从 1 单调递增，previousAllocationRevisionId 指向同一 identity/segmentKey 的上一条 revision；迁移以延迟检查拒绝跨链、跳号、倒退和伪造 previous 指针。
2. 每条 revision 固定 sourceSegmentId 和 sourceSegmentRevision。源服务段被更正而产生新 revision 时，D3 追加新 allocation revision，不更新旧 D3 行。
3. “当前 D3 认定”不是可变 current 指针：只能在持有活动锁后，以 D2 返回的当前 sourceSegmentId 为条件，取该源段对应的最高 D3 revision。任何缓存、updatedAt 或后台同步都禁止。
4. 一个历史 allocation 可继续被审计读取，但不能因政策目录后续变化而重算或被改成新分类。

### 3.2 四张新表

| 模型 | 必需字段与关系 | 禁止形态 |
| --- | --- | --- |
| ParticipantTimeAllocationRevision | id、activityId、sessionId、memberId、participationIdentityId、segmentKey、revision、previousAllocationRevisionId、sourceSegmentId、sourceSegmentRevision、sourcePositionId、ruleSnapshotId、ruleSnapshotHash、timePolicySelectionRevisionId、selectionHash、policyId、policyVersionId、definitionHash、evaluatorVersion、recognitionModeCode、manualReason、allocationJson、allocationHash、sliceCount、createdAt、createdByUserId。 | 不含 updatedAt、deletedAt、serviceHours、roundedHours、ledger/proof/settlement 字段或可变 current 指针。 |
| ParticipantTimeAllocationSlice | id、allocationRevisionId、activityId、ordinal、categoryCode、intervalKindCode、startAt、endAt。revision/activity 以复合 FK 归属父行；ordinal 在同 revision 唯一。 | 不存计划时段、分数、成员敏感资料、可独立修改的 duration 或类别目录默认值。 |
| ParticipantTimeAllocationEvidence | id、allocationRevisionId、activityId、attachmentId、ordinal。revision/activity 复合 FK，Attachment 外键，revision/attachment 与 revision/ordinal 分别唯一。 | 不复制附件 URL、内容、对象 key 或 owner 自由文本；删除附件前必须受引用保护。 |
| ParticipantTimeAllocationCommandReceipt | id、actorUserId、activityId、operationCode、operationKey、requestHash、allocationRevisionId、resultJson、createdAt。actor/op/key 唯一，revision/activity 复合 FK。 | 不返回或记录 operationKey、requestHash、用户敏感字段为业务结果；不复用 D1 选择或旧结算收据。 |

所有外键均为 Restrict。至少建立以下复合关联：sourceSegmentId + participationIdentityId 到服务段；participationIdentityId + activityId + sessionId + memberId 到参与身份；ruleSnapshotId + activityId 到 RuleSnapshot；selectionRevisionId + activityId 到选择修订；policyVersionId + policyId + definitionHash 到 TimePolicyVersion。migration 必须为被引用侧补齐真正的 unique 靶点，不得把单列主键误写成已验证同链。

allocationJson 是与子片段一一对应的 canonical manifest，allocationHash 是其 SHA-256。应用负责严格解析、canonical 和 hash 重算；数据库只负责形状、计数、同链、不可变和引用约束，不能把 jsonb 文本序列化冒充应用 canonical。

### 3.3 数据库不变量

迁移必须用 SQL 约束、部分唯一索引和触发器落实下列规则，并在新的 migration E2E 中逐条做正反向对拍：

1. revision、slice、evidence、receipt 禁止 UPDATE/DELETE；父 revision 创建后也禁止向旧 revision 追加片段或证据。
2. categoryCode 只允许 volunteer_service、training、organization、non_creditable；recognitionModeCode 只允许 automatic、manual；manualReason 仅 manual 必填。
3. startAt 小于 endAt；所有片段都在源段内；同 revision 任意两片不重叠；片段总秒数不超过源段真实秒数。
4. allowSplit 为 false 时，一个 revision 恰有一片，且该片完整覆盖源段；manual 不得绕过该规则。
5. sliceCount 与实际子行数、allocationJson 键数及 allocationHash 语义一致；每条命令最多 500 个片段和 500 个唯一附件，超过即拒绝，不能截断。
6. ruleSnapshot 的 selection revision 必须等于 allocation 记录的 selection revision；snapshotHash、selectionHash 和 policy 三元锚必须与锁后读取的 immutable 行相等。
7. 收据只能指向同活动、同创建者和同一次完整 revision。相同 actor/op/key 的不同 requestHash 必须冲突，不能覆盖旧结果。

## 4. 认定与政策解释

### 4.1 源服务段的 fail-closed 矩阵

| D2 当前段形态 | D3 处理 |
| --- | --- |
| statusCode=committed、resultCode=valid、checkOutAt 非空且严格晚于 checkInAt | 可进入政策解析和认定。 |
| draft、开放段、早退零值、voided、replaced、未知状态或未知结果码 | 拒绝，不写 allocation/receipt/audit。 |
| sourceCloseEventId 为空但 D2 已验证同链，且段本身已闭合有效 | 可继续；D3 不额外把 close ID 与 checkOutAt 强行绑定。 |
| 任何活动、场次、成员、identity、sourcePosition 或源段修订错链 | 拒绝；不能静默滤成空集合。 |

### 4.2 固定解释输入

1. 写命令只接受其源段 checkInAt 之前已创建的、最新一份可用 ActivityRuleSnapshot；它必须有非空 timePolicySelectionRevisionId。未来发布的快照不能追溯改变既有参与段。
2. 使用该 snapshot 固定的 selection revision、完整 stored selection document、历史 session 与 sourcePositionId 解析最近 explicit 指针；不得按 live session/position、当前目录默认值或活动名称重新推断。
3. 解析出的 policy/version/definitionHash/evaluatorVersion 必须与 selection item 和 TimePolicyVersion 三元锚完全相等，并覆盖整段真实区间。版本虽已 retired，仍是合格历史锚；缺失、hash 不符、未覆盖或无 V8 选择时，以 POLICY_UNAVAILABLE 拒绝。
4. V2-V7 历史快照和没有选择锚的历史数据仍可原样读取，但 D3 不为它们写 formal allocation，也不伪造 legacy_unclassified 行。

### 4.3 自动与人工的固定边界

自动认定只能使用 definition 中的确定性角色映射/默认分类，且 requireManualRecognition 为 false、所需事实来源均满足、没有需要实际 special interval 的规则。specialIntervals 为 category 或 manual 时，当前链没有可证明的 preparation/duty/travel 实际区间，自动路径必须拒绝或要求人工，绝不能从计划时间补造。

人工认定必须提交真实的左闭右开区间和非空理由。它仍受 allowSplit、类别闭集、源段边界、总量、证据和 policy 的 manualAdjustment 开关约束；人工不能把不存在的时间变成证据，也不能绕过 policy 的禁止项。

证据来源按 definition 的全部要求同时满足，不把它们当可选替代：service_segment 由已锁定的 D2 段满足；punch_event 只可使用同链来源锚；attachment 只可使用已锁定、活动 owner 匹配且存储边界稳定的附件。manualAdjustment.evidenceRequired 也要求至少一份这样的附件。

### 4.4 取整归属

D3 仅持久化原始片段与原始秒数验证，不做逐片或逐段 rounding，也不产出正式 credited hours。D1 规定的“同参与身份/类别聚合后再向下取整”由 D4 Bucket 负责；这样 D3 的可追溯事实不会因未来聚合口径改变而丢失原始区间。

## 5. 访问、错误和审计

未来新增一个独立权限 activity.time-allocation.recognize，建议元数据为 module=activity、action=time-allocation、resourceType=recognize。它不是 activity.time-policy.select、目录管理权限或 activity.settlement-final-review.record 的别名，也不自动授予任何内建角色。

调用者必须同时满足：活跃 User、可用 App 身份、显式可见组织范围、对活动资源的 authz.can 通过，以及当前 Activity responsibility owner。没有“全局管理员天然绕过”的捷径；每次锁后都重验这些资格。实现采用新的 ActivityTimeAllocationAccessService，沿既有 Outcome access 的同一资格顺序，但不深引其私有实现。

拟新增一个活跃审计事件 activity.time-allocation.command。只有首个成功提交在同一事务写一条审计；同键安全重放只返回既有结果，失败、冲突和拒绝不留下新的 allocation、receipt 或 audit。审计只记录安全的活动、源段、allocation revision 与模式；不写 operationKey、requestHash、附件内容、精确敏感身份资料或完整 policy JSON。

以当前 20212 为已占用上界，实施前必须再次验证码位。建议只申请确有命令语义的五码：ACTIVITY_TIME_ALLOCATION_INVALID（20213）、REFERENCE_UNAVAILABLE（20214）、STALE（20215）、COMMAND_CONFLICT（20216）、POLICY_UNAVAILABLE（20217）。若任一码已被 main 占用，停止并重排；不为未发生的“revision 上限”等假设预占错误码。

## 6. 固定锁序、幂等与事务

所有写入在一笔 ReadCommitted 事务中完成，maxWait 为 2 秒、timeout 为 10 秒。任何失败都回滚 parent、slice、evidence、receipt 和 audit，绝不返回半完成结果。

1. 在事务外严格解析输入并生成 requestHash；hash 包含 actor、活动、源段、预期 revision、模式、片段和附件的 canonical 内容，不含 operationKey 与命令时间。
2. 事务内先做最小资格检查，再按 actor + operationCode + operationKey 取得既有 advisory transaction lock。
3. 重验资格后，通过 ParticipationSegmentFacade 新增的窄锁桥取得既有 Activity FOR UPDATE；Facade 只委托 AttendanceAccessService 的活动锁，不公开或深引考勤 writer。
4. 再次重验调用者与活动；读取同键收据。相同 hash 安全重放原 resultJson，不同 hash 抛 COMMAND_CONFLICT。
5. 在活动锁后通过 D2 Facade 重读当前段，只选请求的 sourceSegmentId、segmentKey 和 revision；按第 4.1 节验证。
6. 以稳定 ID 顺序锁定 RuleSnapshot、selection revision/items 和 policy/version；重新解析历史 session/sourcePosition，验证 snapshot、hash、有效期与 evaluator。
7. 按附件 ID 排序，通过 lockOwnerReferenceStorageBoundaryTrusted 锁活动 owner/存储边界，再用 findOwnedAttachmentsTrusted 重验附件归属；每次等待后重验调用者资格。
8. 读取同 logical segment 的最后 allocation revision，验证 expectedRevision，计算新 revision、canonical manifest、hash 和原始区间不变量。
9. 同事务写 parent、slices、evidence、receipt 和一个 audit event；SQL 触发器在提交时核验完整性。
10. 任何资格撤回、活动删除、源段替换、snapshot/selection 不一致、政策不可用、附件失稳、重复键异 payload、锁超时或约束失败，都不留可见新业务行。

锁序固定为 advisory receipt → Activity → D2 current source → snapshot/selection/policy（稳定 ID 顺序）→ attachment owner/storage。不能为“先查快一点”反向取锁，也不能把 D2 读取搬到 Activity 锁之前。

## 7. migration、Storage 保护与验证策略

未来 migration 是 main 的第 120 条。实际目录只能在实施时由维护者生成并逐文件确认，命名格式为 prisma/migrations/<timestamp>_activity_os_r4_d3_time_allocation_revision/migration.sql；本文不授权生成或执行它。

迁移只做 expand：建四张空表、必要 unique/FK/index/check/trigger、Attachment 删除保护与权限/审计相关声明，不回填、不删除、不更新旧服务段或旧时长。所有业务关联 Restrict。必须同时验证空库完整回放、历史非空库升级、同链失败、append-only、防重叠、总量、receipt replay 和 Attachment 被引用后删除拒绝。

Storage 的改动限于 AttachmentStorageOrchestrator 的已存在删除引用查询：在已锁定 Attachment 下，除现有 activityMetricValueEvidence 外，再拒绝任何 ParticipantTimeAllocationEvidence 引用。D3 不改 Storage 上传、Provider、密钥、签名 URL 或删除流程其它语义。

## 8. 后续 implementation 的精确候选写集

下表是下一次 D3 implementation 授权时的候选白名单，不是本轮写入许可。任何少列或新增路径都要先逐路径复核 harness:needs；实际 migration 目录不以占位符获得授权。

| 分类 | 未来路径 | 允许范围 |
| --- | --- | --- |
| schema | prisma/schema.prisma | 四个不可变模型、复合锚与已有 Attachment 关系；不改既有服务段语义。 |
| migration | prisma/migrations/<timestamp>_activity_os_r4_d3_time_allocation_revision/migration.sql | 仅第 120 条 expand/guard SQL；无 DML、无回填、无删除。 |
| activities 实现 | src/modules/activities/activity-time-allocation-command.ts、activity-time-allocation-policy.ts、activity-time-allocation.service.ts、activity-time-allocation-access.service.ts、activity-time-allocation-audit-recorder.ts、activity-time-allocation.presenter.ts、activities.module.ts | 新内部 command、纯解析、访问、审计与 provider 接线；无 controller/DTO。 |
| activities 单测 | 上述六个新实现对应的 .spec.ts | 每项不变量、错误、重放、资格、锁后重验和安全展示的独立断言。 |
| attendance 桥 | src/modules/attendances/participation-segment.facade.ts 及其 .spec.ts | 只增加窄活动锁桥；不改 reader 字段、服务段 writer 或既有消费者。 |
| attachments | src/modules/attachments/attachment-storage-orchestrator.ts 及其 .spec.ts | 只补 D3 evidence 删除保护，保持现有锁点和 Storage 行为。 |
| permission | src/modules/permissions/permission-catalog.ts、seed-permission-codes.ts、permission-code-holders.spec.ts | 仅一枚新码、显式持码登记、零内建角色默认授予。 |
| audit/error | src/modules/audit-logs/audit-logs.types.ts、audit-event-registry.spec.ts、src/common/exceptions/biz-code.constant.ts、biz-code.constant.spec.ts | 一个活跃事件与五个确有语义的 BizCode；不改全局异常行为。 |
| time registry | src/common/datetime/clock-authority.spec.ts | 仅登记新 receipt/revision 时间字段，保留既有断言。 |
| 新 E2E | test/e2e/activity-os-r4-d3-time-allocation-revision.e2e-spec.ts、activity-os-r4-d3-time-allocation-revision-migration.e2e-spec.ts | 隔离库端到端、冷回放、非空升级、SQL/事务/并发反例。 |
| 旧 migration 计数 | test/e2e/activity-os-r1-a3-template-definition-lifecycle-guards.e2e-spec.ts、activity-os-r1-a4-explicit-template-version-pointer.e2e-spec.ts、activity-os-r2-b1-place-schema-constraints.e2e-spec.ts、activity-os-r2-b2-coordinate-projection-schema-constraints.e2e-spec.ts、activity-os-r2-b3-form-blueprint-governance.e2e-spec.ts、activity-os-r2-b6-creation-data-foundation.e2e-spec.ts、activity-os-r3-c1-d2a-metric-command-receipt-migration.e2e-spec.ts、activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts、activity-os-r3-c1-metric-definition-set.e2e-spec.ts、activity-v11-batch4-allocation-candidate-position-anchor-migration.e2e-spec.ts、activity-v11-batch4-allocation-command-replay-migration.e2e-spec.ts、activity-v11-batch4-allocation-determinism-migration.e2e-spec.ts、activity-v11-batch4-allocation-mode-migration.e2e-spec.ts、activity-v11-batch4-qualification-contract-migration.e2e-spec.ts、insurance-evidence-registration-revision-migration.e2e-spec.ts | 仅 CURRENT_MIGRATION_COUNT 119→120；所有历史世代基线和行为断言保持不变。 |
| harness/生成/台账 | scripts/harness-guards.selftest.ts、harness/domain-map.json、harness/authz-assertion-patterns.json、harness/authz-implication-graph.json、harness/permission-surface-baseline.json、docs/current-state.md、CODEMAP.md、docs/ai-harness/RBAC_MAP.md、docs/ai-harness/ROUTE_AUTHZ.md、docs/ai-harness/AUDIT_EVENT_REGISTRY.md、docs/ai-harness/FROZEN_DRAFTS.md、docs/ai-harness/NEXT_TASKS.md、src/modules/activities/CLAUDE.md、prisma/CLAUDE.md、changelog.d/activity-os-r4-d3-time-allocation-revision-implementation.md、docs/plans/activity-os-r4-d3-time-allocation-revision-review.md、本文 | 仅真实派生读数、D3 状态、实施证据和未做项；生成物必须由对应脚本刷新，守护只改计数/登记，不改裁决。 |

明确不在未来候选写集内：controller、DTO、OpenAPI/contract snapshot、客户端、Gate、global guard、Activity/Attendance 既有 writer、旧 serviceHours 投影、结算/账本/证明、test/setup、生产配置、Redis/queue/cron、任何业务数据清理。D3 没有 statusCode 生命周期，故 harness/state-machines.json 与 STATE_MACHINE_INVENTORY.md 不在写集，不能为了“文档齐全”虚构状态机登记。

## 9. 必过探针与签收

| 层面 | 必须独立验证的内容 |
| --- | --- |
| 数据合同 | 四张表的 FK、同链、append-only、父子完整、category/mode 闭集、片段边界、重叠、总量、allowSplit、hash/manifest 与收据一致性。 |
| 政策 | V8 snapshot 固定解释、历史 V2-V7 拒绝、policy/version/hash/evaluator 不符、有效区间、retired 历史版本、special interval、证据全集和 manualAdjustment。 |
| 并发 | 同键同 payload 重放、异 payload 冲突、源段更正交错、活动锁交错、资格撤回、选择变更、附件删除交错；每一例无半写。 |
| 兼容 | D2 reader 原字段/排序/上限不变；旧服务段、serviceHours、结算、账本、成果、证明、D1 selection、D2 Facade 原有测试均不改行为。 |
| migration | 空库全链回放、非空历史升级、120 条计数、每条 SQL guard 的正反变异；不把旧固定 migration 基线改成 120。 |
| 安全 | 未持码、无显式组织范围、非 owner、失效成员、跨活动附件、附件已被 Storage 删除、AI/外部来源和未锁重读都 fail-closed。 |

实施时只可在维护者当场许可的 app_test 与 app_test_w98 隔离库上做 migration 验证和测试夹具重建。AI 不自动运行 prisma migrate dev、migrate reset 或 db push；生产只可能由维护者后续独立审批。完成后仍需：3b 对真实第 120 条 migration 重签、4b 对真实权限/审计读数重签、PR CI、可信红区审批、合并后 main CI；其中任一未完成，D3 不登记完成。

## 10. 本轮 docs-only 授权与下一步

本轮只允许以下七个文档路径：FROZEN_DRAFTS.md、NEXT_TASKS.md、D2 review、D2 implementation plan、D3 review、本文和 D3 plan changelog。它们只记录 D3 方案 A 已确认、精确计划已起草和后续边界；不产生实现能力。

下一步必须由维护者另行明确确认完整 implementation 写集、实际 migration 路径与每条红区 grant，并当场许可隔离数据库验证。届时才能开始 D3 代码；计划 PR 的创建、Ready、合并、生产和 Gate 仍是彼此独立的动作。

## 11. 本次未做

本轮没有修改生产代码、schema、migration、权限、审计、Storage、接口、DTO、测试、Gate 或客户端；没有连接、重建或操作任何数据库；没有删除、清理、回填或更改业务数据；没有启用 Gate、部署、合并或执行跨模型复审。D3 仅完成方案 A 的精确计划起草，D3 implementation 和 Release 4 D4-D8 仍未完成。
