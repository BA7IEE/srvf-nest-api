# Activity OS Release 4 / D3：时长分配修订精确实施计划与授权清单

> **当前状态（2026-09-12）**：D3 已随 [#1323](https://github.com/BA7IEE/srvf-nest-api/pull/1323) 合入 main `921a6bf3fac66067e5232768d5c5d32bf92765fc`；批准 HEAD 为 `c3a969a22b4f59b2e2ca51a46660c04d10d53b41`，18 项 PR 检查及可信审批通过，[合并后 main CI](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34677507039) 在该合并 SHA 上 completed/success。仓内基线为 161 模型／120 migration／625 端点／263 权限／168 审计总计（163 活跃），3b/4b 已重签；零内建角色默认授码。维护者本轮只授权 D3 台账更正及 D4 [评审](../plans/activity-os-r4-d4-time-bucket-settlement-workbench-review.md)／[精确计划](../plans/activity-os-r4-d4-time-bucket-settlement-workbench-implementation-plan.md)合并起草、验证后提交推送并创建 docs-only PR；D4 方案和实施仍待确认。本轮不合并、不实施、不操作数据库、不启用 Gate；整体跨模型复审、前端发布与生产验收尚未完成。下方较早阶段描述保留为历史，以本条为当前状态。

> **仓内完成不等于上线**：以下 D3 实施已通过 PR 与合并后 main 的独立验证；生产部署、Gate、前端可用性和整体跨模型复审没有因此完成。D4 候选方案也不因 D3 合并而自动获准实施。

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

当前仓内 main 基线 `921a6bf3` 为 161 个模型、120 条 migration、263 个权限码、168 个 AuditLogEvent（163 个活跃）、625 个端点；不据此声明生产数据库或线上能力已经更新。

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

本分支新增一个独立权限 activity.time-allocation.recognize，元数据为 module=activity、action=time-allocation、resourceType=recognize。它不是 activity.time-policy.select、目录管理权限或 activity.settlement-final-review.record 的别名，也不自动授予任何内建角色。

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

本分支实际第 120 条 migration 为 `prisma/migrations/20260912090000_activity_os_r4_d3_time_allocation_revision/migration.sql`。它只做 expand：建四张空表、必要 unique/FK/index/check/trigger，并在 SQL 层核验 snapshot 的 source session／position 仍属于冻结历史图；没有 DML、回填、删除、旧服务段或旧时长更新。

所有业务关联均为 Restrict。获批隔离验证已经覆盖冷回放、历史非空升级、同链失败、append-only、防重叠、总量、receipt replay、snapshot source target 错配和 Attachment 被引用后删除拒绝；这些结果不代替最终 Harness、签字、可信审批或 CI。

Storage 的改动限于 AttachmentStorageOrchestrator 的已存在删除引用查询：在已锁定 Attachment 下，除现有 activityMetricValueEvidence 外，再拒绝任何 ParticipantTimeAllocationEvidence 引用。D3 不改 Storage 上传、Provider、密钥、签名 URL 或删除流程其它语义。

## 8. D3 implementation 的精确写集

下表是维护者已经确认的 D3 implementation 白名单；后续扩展为 `prisma/seed.ts`，以及 `harness/state-machines.json`、`docs/ai-harness/STATE_MACHINE_INVENTORY.md` 的精确 inventory 登记。任何其它新增路径仍须先逐路径复核并由维护者明确授权。

维护者 2026-09-12 另已确认 #1323 的五份旧 E2E 适配及 3b/4b 重签，精确增量如下；不改生产代码或门禁，不放宽历史升级与业务断言。

| 已确认路径 | 本轮唯一改动 |
| --- | --- |
| test/e2e/activity-os-r4-d1-1-time-policy-migration.e2e-spec.ts | 当前全链回放标题与总数 119→120；保留历史 117→118 升级、SQL checksum 与历史迁移锚。 |
| test/e2e/activity-os-r4-d1-3-selection-migration.e2e-spec.ts | 当前全链标题与总数 119→120；D1-3 锚固定为第 119 条 `names[118]`，保留 118→119 历史升级。 |
| test/e2e/activity-os-r3-c2-outcome-value-revision.e2e-spec.ts | 当前全链标题与总数 119→120；保留 112→113 历史升级及全部成果行为断言。 |
| test/e2e/activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts | 在原计数适配外，仅将当前 seed 权限总数 262→263；保留旧收据逐字一致、seed 二跑、零默认授码与历史 111→112。 |
| test/e2e/activity-os-r4-d1-1-time-policy-foundation.e2e-spec.ts | 测试清理 TRUNCATE 显式加入四张 ParticipantTimeAllocation 表，不使用 CASCADE，不改行为断言。 |
| docs/ai-harness/CUTOVER_SIGNOFF.md | 按维护者当轮确认重签 3b 第 120 条及 4b 权限 263、审计 168/163，保留历史签字依据。 |

验证只使用 `app_test_w98`，每套串行重建测试夹具；不运行会写入 `app_test` / `app_test_w1` 的默认全局初始化，不修改仓库 test/setup 或 Jest 门禁配置。验证后与下表已授权的计划、台账及 changelog 一次提交推送更新 #1323；检查通过后才可 Ready，不合并。

| 分类 | 实施路径 | 允许范围 |
| --- | --- | --- |
| schema | prisma/schema.prisma | 四个不可变模型、复合锚与已有 Attachment 关系；不改既有服务段语义。 |
| migration | prisma/migrations/20260912090000_activity_os_r4_d3_time_allocation_revision/migration.sql | 仅第 120 条 expand/guard SQL；无 DML、无回填、无删除。 |
| activities 实现 | src/modules/activities/activity-time-allocation-command.ts、activity-time-allocation-policy.ts、activity-time-allocation.service.ts、activity-time-allocation-access.service.ts、activity-time-allocation-audit-recorder.ts、activity-time-allocation.presenter.ts、activities.module.ts | 新内部 command、纯解析、访问、审计与 provider 接线；无 controller/DTO。 |
| activities 单测 | 上述六个新实现对应的 .spec.ts | 每项不变量、错误、重放、资格、锁后重验和安全展示的独立断言。 |
| attendance 桥 | src/modules/attendances/participation-segment.facade.ts 及其 .spec.ts | 只增加窄活动锁桥；不改 reader 字段、服务段 writer 或既有消费者。 |
| attachments | src/modules/attachments/attachment-storage-orchestrator.ts 及其 .spec.ts | 只补 D3 evidence 删除保护，保持现有锁点和 Storage 行为。 |
| permission / seed | src/modules/permissions/permission-catalog.ts、seed-permission-codes.ts、permission-code-holders.spec.ts、prisma/seed.ts | 仅一枚新码、显式持码登记；`prisma/seed.ts` 只纳入该码的 seed 闭包与目录，零内建角色默认授予。 |
| audit/error | src/modules/audit-logs/audit-logs.types.ts、audit-event-registry.spec.ts、src/common/exceptions/biz-code.constant.ts、biz-code.constant.spec.ts | 一个活跃事件与五个确有语义的 BizCode；不改全局异常行为。 |
| time registry | src/common/datetime/clock-authority.spec.ts | 仅登记新 receipt/revision 时间字段，保留既有断言。 |
| 非生命周期 inventory（维护者后续扩展） | harness/state-machines.json、docs/ai-harness/STATE_MACHINE_INVENTORY.md | 仅登记 recognitionModeCode 为 L1 inventory / not-derived，并刷新派生摘要；不新增状态边或改变裁决规则。 |
| 新 E2E | test/e2e/activity-os-r4-d3-time-allocation-revision.e2e-spec.ts、activity-os-r4-d3-time-allocation-revision-migration.e2e-spec.ts | 隔离库端到端、冷回放、非空升级、SQL/事务/并发反例。 |
| 旧 migration 计数 | test/e2e/activity-os-r1-a3-template-definition-lifecycle-guards.e2e-spec.ts、activity-os-r1-a4-explicit-template-version-pointer.e2e-spec.ts、activity-os-r2-b1-place-schema-constraints.e2e-spec.ts、activity-os-r2-b2-coordinate-projection-schema-constraints.e2e-spec.ts、activity-os-r2-b3-form-blueprint-governance.e2e-spec.ts、activity-os-r2-b6-creation-data-foundation.e2e-spec.ts、activity-os-r3-c1-d2a-metric-command-receipt-migration.e2e-spec.ts、activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts、activity-os-r3-c1-metric-definition-set.e2e-spec.ts、activity-v11-batch4-allocation-candidate-position-anchor-migration.e2e-spec.ts、activity-v11-batch4-allocation-command-replay-migration.e2e-spec.ts、activity-v11-batch4-allocation-determinism-migration.e2e-spec.ts、activity-v11-batch4-allocation-mode-migration.e2e-spec.ts、activity-v11-batch4-qualification-contract-migration.e2e-spec.ts、insurance-evidence-registration-revision-migration.e2e-spec.ts | 仅 CURRENT_MIGRATION_COUNT 119→120；所有历史世代基线和行为断言保持不变。 |
| harness/生成/台账 | scripts/harness-guards.selftest.ts、harness/domain-map.json、harness/authz-assertion-patterns.json、harness/authz-implication-graph.json、harness/permission-surface-baseline.json、docs/current-state.md、CODEMAP.md、docs/ai-harness/RBAC_MAP.md、docs/ai-harness/ROUTE_AUTHZ.md、docs/ai-harness/AUDIT_EVENT_REGISTRY.md、docs/ai-harness/FROZEN_DRAFTS.md、docs/ai-harness/NEXT_TASKS.md、src/modules/activities/CLAUDE.md、prisma/CLAUDE.md、changelog.d/activity-os-r4-d3-time-allocation-revision-implementation.md、docs/plans/activity-os-r4-d3-time-allocation-revision-review.md、本文 | 仅真实派生读数、D3 状态、实施证据和未做项；生成物必须由对应脚本刷新，守护只改计数/登记，不改裁决。 |

明确不在 D3 写集内：controller、DTO、OpenAPI/contract snapshot、客户端、Gate、global guard、Activity/Attendance 既有 writer、旧 serviceHours 投影、结算/账本/证明、test/setup、生产配置、Redis/queue/cron、任何业务数据清理。D3 没有 statusCode 生命周期；本仓扫描把 recognitionModeCode 识别为需显式分类的 string-state 字段，现已按维护者确认登记为 L1 inventory、`not-derived` 的 immutable configuration。不虚构生命周期，也不提升为 governed。

## 9. 必过探针与签收

| 层面 | 必须独立验证的内容 |
| --- | --- |
| 数据合同 | 四张表的 FK、同链、append-only、父子完整、category/mode 闭集、片段边界、重叠、总量、allowSplit、hash/manifest 与收据一致性。 |
| 政策 | V8 snapshot 固定解释、历史 V2-V7 拒绝、policy/version/hash/evaluator 不符、有效区间、retired 历史版本、special interval、证据全集和 manualAdjustment。 |
| 并发 | 同键同 payload 重放、异 payload 冲突、源段更正交错、活动锁交错、资格撤回、选择变更、附件删除交错；每一例无半写。 |
| 兼容 | D2 reader 原字段/排序/上限不变；旧服务段、serviceHours、结算、账本、成果、证明、D1 selection、D2 Facade 原有测试均不改行为。 |
| migration | 空库全链回放、非空历史升级、120 条计数、每条 SQL guard 的正反变异；不把旧固定 migration 基线改成 120。 |
| 安全 | 未持码、无显式组织范围、非 owner、失效成员、跨活动附件、附件已被 Storage 删除、AI/外部来源和未锁重读都 fail-closed。 |

本轮补验只使用 `app_test_w98`，从空库部署当前 migration 文件；临时验证入口保留测试环境护栏，跳过会重建其它模板／worker 库的通用全局初始化。没有运行 `prisma migrate dev`、`migrate reset` 或 `db push`。3b/4b 已按维护者 2026-09-12 确认重签并通过对拍：migration 120，权限 263、seed 摘要 `9f305e80d3f5`，审计 168 总计／163 活跃。可信审批、PR CI 与合并后 main CI 未完成前，不登记 D3 收口。

### 9.1 本地补验证据（2026-09-12）

| 验证 | 结果与范围 |
| --- | --- |
| 全仓单测 | 376 套、8174 项通过；5 项既有 todo。未以定向单测替代全仓单测。 |
| D3 application E2E | 18/18；真实 PostgreSQL 同键重放、revision 竞争、六类锁等待后身份停用、组织撤权、源段更正、政策退役、选择变更、附件删除双向竞争和最终审计失败回滚。 |
| D3 migration E2E | 3/3；120 条冷回放、119→120 非空升级、SQL 同链／不可变／manifest／evidence／receipt 正反例。SQL SHA-256 为 `caee91d1e8f2d1dae5e79d7789cd3473e886f23693ec200fd057f6a23d71ca54`。 |
| 五份旧 E2E 兼容补验 | 全部通过，共 106 项：D1-1 migration 2、D1-3 migration 3、C2 D1 8、C1 D2b 63、D1-1 foundation 30。逐套仅在 app_test_w98 从空库串行验证，历史升级与业务断言保留；结束仅回收该测试夹具库。 |
| 类型、构建与 lint | 完整 typecheck 通过；build 与全仓 lint 在本轮前段通过，后续变动的 TypeScript 已再次 lint；没有修改 lint 内存配置或裁决规则。 |
| 契约 | 1049 项、2 个快照通过；未更新 snapshot。 |
| Harness selftest | guards 543 通过、eslint 138 通过、hooks 68 通过，各组失败均为 0；保留脚本明确报告的已知缺口，不把它们宣称为已覆盖。 |
| 派生检查 | metadata、authz、counts、migration count、RBAC map、CODEMAP、readtax 与 FROZEN 台账通过；CODEMAP 保留 2 项既有非阻断 warning。 |
| 签字对拍 | 维护者明确确认后更新 3b/4b，`pnpm cutover:check:signoff` 已通过；不替代可信审批、PR CI、整体复审、合并或生产授权。 |

**验证执行范围偏差**：D3 补验由测试自身重建 `app_test_w98`。契约验证误用默认 global setup，对 `app_test` 执行了无待迁移的 deploy 核验，并创建／回收 `app_test_w1`，超出本轮限定的 w98 范围；已向维护者说明并停止该入口。只读复核确认 w1 与 w98 均已回收，未触及生产。没有将此偏差解释为新的授权，也不为此放宽测试库护栏。

本地没有执行全量 E2E；`agent:check:full` 的全仓 E2E 冷跑仍由 PR CI 验证。

首轮 [CI 34672472993](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34672472993) 已结束：Diff guards 因 3b/4b 旧读数失败，E2E 第 2/3/4 组因 §8 五份旧测试的当前读数及清理前置失败，第 1/5 组通过。上述 106 项本地补验及签字对拍已通过；本次提交后仍须由新 SHA 的完整 PR CI 独立裁决，不能沿用旧运行或宣称全量已绿。

## 10. 实施授权与剩余动作

维护者已授权本表中的 implementation 路径、实际第 120 条 migration、`app_test_w98` 隔离验证及 `prisma/seed.ts` 的精确 seed 闭包扩展。实施没有增加内建角色默认授予，也没有把 D3 变成对外能力。

原写集、seed 闭包、inventory 扩展及 §8 的旧测试适配均已获得维护者确认。后续维护者明确确认合并 #1323，已于 2026-09-12T06:11:55Z squash 合入 main `921a6bf3`。最终批准 HEAD `c3a969a2` 的 18 项 PR 检查及可信审批通过；合并树与批准 HEAD 树一致，独立 main CI 34677507039 成功，五个 Contract + E2E 分片均通过。此证据覆盖 §9 的历史待验证状态，但不抹去首轮失败及测试库范围偏差记录。

本轮仅更正 D3 台账并合并起草 D4 评审与精确计划。D4 的来源扩展、聚合规则、访问面和实施写集均是待确认提案；没有 D4 implementation、数据库、生产或 Gate 授权。

## 11. 本次未做

本次台账更正没有新增 controller、DTO、OpenAPI／contract snapshot、客户端、schema、migration 或业务代码；没有操作数据库、生产，未删除／清理／回填业务数据，未启用 Gate、部署、合并当前文档 PR 或执行整体跨模型复审。D3 仓内交付已完成；D4 仅有待确认评审与精确计划，D4-D8 的实施仍未完成。
