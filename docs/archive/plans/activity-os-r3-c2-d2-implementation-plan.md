# C2 D2 人工成果闭环：实施计划与精确授权预算

> 基点 main `82d28c5c`（#1291）；[main CI 34094984817](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34094984817)通过。维护者已确认 [C2 D2 方案 A](../reviews/activity-os-r3-c2-d2-manual-outcome-review.md)及合并 #1291。
>
> 本次只获四份文档的起草、提交、推送和创建计划 PR 授权；**未获合并、implementation、数据库或 Gate 授权**。以下是下一步待批准的 D 档实施预算，不是当前代码事实。既有评审稿冻结不回改。

## 1. 交付定义与不变边界

一条业务轴完整交付 RecordActivityOutcome、GetActivityOutcome 与分页历史：Human App managed 主体录入 manual 草稿、追加完整修订、读取有权历史，并由同事务的责任、组织、指标、附件、收据和审计保证一致性。三个候选路由沿已批准评审 §3.1，不增加 Admin/Open/Integration 或成员自助入口。

不产生 confirmed、system、import、AI 来源；不修改发布、指标选择、v2–v7、Readiness、考勤、时长、贡献、账本、结束／归档条件。D1 三表的数据形状不重做；只新增专用成果收据及必要反向关系。C3 的正式确认、计算与证据完整性仍另行实施。

## 2. 已核验接缝与实施决定

| 接缝证据 | 计划处理 |
|---|---|
| `activity-metric-set-definition.ts:30` 的 metricArray 上限 100 | values 定为 1–100 项，单项必须属于锁后精确集；不因未填 required 项拒绝草稿，也不把它当正式完成。 |
| `activity-outcome-value.ts` 与 C1 定义解析器 | 复用实际值校验与独立 value hash；新命令层拒绝 short_text，不修改 D1 解析器以改变既有形状合同。 |
| `activity-responsibility-policy.ts` 的 assertOwner；`activity-access.service.ts:364` 的旧 managed 锁方法 | 发布后复用责任属主的 owner 判定；draft 用加载后的 initiatorMemberId 比对。禁止使用 assertOwnerOrOverride／assertInitiatorOrOverride 或旧 managed 的 SUPER_ADMIN 特例。权限、责任和组织是同时满足，不是三选一。 |
| `activity-metric-selection-access.ts` 的 writable 仅支持 draft | 不复用其状态闸；新 OutcomePolicy 显式支持 draft/published/completed/terminated，拒绝 cancelled/archived 新写。读历史不改活动状态。 |
| `authz.service.ts` 的 getVisibleOrganizationScope 与现有 tx 透传 | 用当前 outcome 动作对应的 scope，不借 activity.create.cross-org 扩权；用户／成员当前身份及组织资格通过已有属主入口复验。不能完成时停下列精确扩展，不复制跨模块 SQL。 |
| `attachments.service.ts:181/198` 的 trusted facade | Activity 根锁及判权后调用归属查询和引用边界锁；内部 key 不进入响应、回执或审计。不得直接查 Attachment。 |
| 第 112 条 migration 对 ActivityMetricCommandReceipt 的目标／结果 CHECK | 新建 ActivityOutcomeCommandReceipt；保留 C1 收据闭集、解析器、旧回执不变，不把 resultJson 当万能仓库。 |
| `permission-code-holders.spec.ts` 及 seed 事实闭包 | 两条新码默认不赋内建角色；新增精确治理例外及反向测试，不放宽全仓“孤码”判据。验收通过显式授予证明真实可用，而不是跳过判权。 |

上述主体细化以 owner 为发布后记录和读取主体，collaborator 不自动获成果权；缺 owner 的 legacy 活动 fail-closed，不按历史发起人替代现任 owner。已归档历史以其归档前身份语义判责任，仍须当前显式权限和组织范围；不得因归档恢复管理员直通。实施前的 characterization 必须核验这些接缝，不把旧接口“可管理”的宽口径视为成果授权。

### 2.1 有界 DTO 与安全结果

- 路径 ID 非空、最长 64；operationKey 非空、最长 128；expectedRevision 为 0–2147483646 的整数；hash 为 64 位小写十六进制，所有未知字段拒绝。
- values 1–100 项，metricDefinitionId 不重复；每项 evidenceAttachmentIds 0–20 个、同项不重复，顺序有意义。该附件上限是本计划建议的请求预算，不修改附件模块上传策略；等待实施方案批准后执行。
- `value` 仅 number/string/boolean，经对应精确定义验证；小数只接受规范字符串，不用浮点计算。single_choice 仅受控代码，不接标签或自由文本。任何值都不能绕过非敏感指标治理要求。
- POST 使用完整快照；缺省附件列表统一 canonical 为 []，指标按 id 排序，附件按请求顺序保留。请求 hash 包含 activity、expectedRevision、精确集和全部规范化内容，使用独立 domain；operationKey 不落审计。
- 分页沿公共 page/pageSize，默认 1/20，上限 100，按 revision 倒序；不新增分页别名。明细不返原始 Prisma row、key、URL、源异常或个人信息。
- 源固定 manual；来源与人工规则版本采用服务端受控常量，confirmedByUserId/confirmedAt 均空。不接客户端 source、状态、创建人、确认字段或 valueHash。
- POST 回执只存创建时安全摘要；状态 draft 是创建事实，不冒充当前 revision 状态。GET 明细按该 revision 固定的集 id/hash 解释，不能回退“最新指标集”。

### 2.2 收据、锁序与错误合同

收据候选模型字段：id、actorUserId、operationCode、operationKey、requestHash、activityId、outcomeRevisionId、resultJson、createdAt。operationCode 仅 record_manual_outcome；actor/operation/key 唯一；outcomeRevisionId/activityId 复合 FK；结果版本和字段闭集、锚点一致性、hash 格式及不可改删由真实 PostgreSQL 约束验证。

命令锁 → Activity 根锁 → 引用锁的顺序须与已有写入口对拍；每次可能等待后复验当前身份、owner／initiator、组织与权限。重放查到原收据时先校验当前资源访问，再校验 hash／回执，但不重复执行新写的 expectedRevision 与活动状态门。新写必须用当前精确集、latest revision 和合法状态；创建新头/值/证据、旧 draft→superseded、回执及 audit 一起提交。未来 confirmed 不被 C2 降级或替代，交 C3 处理。

同 key 异请求、同 expectedRevision 不同 key 并发、坏收据、跨活动 prior/value/evidence、锁等待后撤权均必须确定性拒绝；事务失败零部分成果/收据/审计。归属不可见与不存在统一 404，不把底层数据库错误直接给客户端。拟新增五类成果 BizCode：INVALID(400)、STALE(409)、COMMAND_CONFLICT(409)、RECEIPT_INVALID(409)、REFERENCE_UNAVAILABLE(404)；名称使用 ACTIVITY_OUTCOME 前缀，数值正式开工时查重后确认，不提前占号。旧码和旧 message 均不改。

## 3. 下一步 implementation 精确文件预算（尚未授权）

下列路径逐一声明；“新增”不是当前已存在。未使用的候选路径保持不改。禁止以同目录／同模块推导通配写权。一个例外是 migration 文件名必须正式开工现场确定，见 §3.4；定名之前不得执行其写入授权。

### 3.1 新领域代码与测试（候选新增）

| 文件 | 唯一职责 |
|---|---|
| `src/modules/activities/activity-outcome-command.ts`、`activity-outcome-command.spec.ts`（同目录） | 命令形状、canonical/request hash、安全回执解析；单测覆盖未知字段／边界／坏回执。 |
| `src/modules/activities/activity-outcome-access.service.ts`、`activity-outcome-access.service.spec.ts`（同目录） | 当前 Human 身份、责任、组织与权限；不缓存，不给角色直通。 |
| `src/modules/activities/activity-outcome-policy.ts`、`activity-outcome-policy.spec.ts`（同目录） | 纯状态／修订决策，不碰 DB、不承担 RBAC。 |
| `src/modules/activities/activity-outcome.service.ts`、`activity-outcome.service.spec.ts`（同目录） | RecordActivityOutcome 事务编排与重放，不混入读面投影。 |
| `src/modules/activities/activity-outcome-query.service.ts`、`activity-outcome-query.service.spec.ts`（同目录） | 分页历史与同链明细；当前访问校验、历史口径验证。 |
| `src/modules/activities/activity-outcome-presenter.ts`、`activity-outcome-presenter.spec.ts`（同目录） | 白名单 DTO 投影；不碰数据库。 |
| `src/modules/activities/activity-outcome-audit-recorder.ts`、`activity-outcome-audit-recorder.spec.ts`（同目录） | 单一 activity.outcome.command，资源锚／状态／来源／数量；无实际值及凭证。 |
| `src/modules/activities/controllers/app-managed-activity-outcomes.controller.ts` | 三个已批准 App 路由，完整访问声明、响应与业务错误注解。 |
| `src/modules/activities/dto/app/app-activity-outcome.dto.ts` | App 独立输入/查询/响应 DTO；不派生 Admin，不开放任意 JSON。 |
| `test/e2e/activity-os-r3-c2-d2-manual-outcomes.e2e-spec.ts` | 真实 HTTP 人工闭环、可见性、状态和不影响其他业务轴。 |
| `test/e2e/activity-os-r3-c2-d2-outcome-concurrency.e2e-spec.ts` | 并发/重放/撤权/附件竞争与整笔回滚。 |
| `test/e2e/activity-os-r3-c2-d2-outcome-receipt-migration.e2e-spec.ts` | 非空升级、冷回放、收据约束及保留旧成果。 |

“同目录”两文件名是精确名字的简写，不是 glob。

### 3.2 既有实现与治理联动（仅指定增量）

1. `prisma/schema.prisma`：仅新增成果收据及必要反向 relation。
2. `src/modules/activities/activities.module.ts`：仅 Outcome providers/controller 装配。
3. `src/common/exceptions/biz-code.constant.ts`：仅五类新成果码，实施前查重。
4. `src/modules/permissions/permission-catalog.ts`：仅 activity.outcome.record/read 目录与治理元数据，Service/Delegated 均不允许。
5. `src/modules/permissions/seed-permission-codes.ts`：仅新码闭包同步。
6. `prisma/seed.ts`：仅两码幂等登记，不扩默认内建角色、不写业务成果。
7. `src/modules/permissions/permission-code-holders.spec.ts`：仅新码“显式治理、默认不分配”的精确例外与自证，不删旧断言。
8. `src/modules/audit-logs/audit-logs.types.ts`：仅新增 activity.outcome.command。
9. `harness/domain-map.json`：仅新收据及真实归属。
10. `harness/state-machines.json`：仅成果 draft→superseded 的真实 writer/入口和输入摘要，不声称 confirmed 已治理。
11. `harness/permission-surface-baseline.json`：仅两码 App 管辖；不放宽旧权限基线。
12. `harness/authz-assertion-patterns.json`：仅已授权新声明的派生更新；不改变守护语义。
13. `scripts/harness-guards.selftest.ts`：仅新码带来的实际计数联动，不改裁判逻辑。
14. `test/contract/openapi.contract-spec.ts`：仅三端点白名单及精确新 DTO 检查；旧行为断言不变。
15. `test/contract/__snapshots__/openapi.contract-spec.ts.snap`：仅逐行可解释的新增合同；禁止盲更新。

现有 users/organizations/attachments/Authz/RBAC 实现、全局 Filter/Guard、测试 setup 与 workflow 不在写集内。需要新属主原语或透传才能保证事务时，必须先列实际引用链和精确路径再请求扩展，不把上述预算当作已证明依赖足够。

### 3.3 精确文档与生成物预算

- `docs/current-state.md`（仅计数生成块）、`CODEMAP.md`、`docs/ai-harness/RBAC_MAP.md`、`docs/ai-harness/ROUTE_AUTHZ.md`。
- `docs/ai-harness/AUDIT_EVENT_REGISTRY.md`、`docs/ai-harness/STATE_MACHINE_INVENTORY.md`（仅当前事实）、`docs/ai-harness/FROZEN_DRAFTS.md`、`docs/ai-harness/NEXT_TASKS.md`。
- `prisma/CLAUDE.md`、`src/modules/activities/CLAUDE.md`（仅当前摘要）。
- `docs/handoff/miniapp.md`、`docs/handoff/openapi.json`。
- `docs/handoff/clients/app/client.ts`、`docs/handoff/clients/app/types.ts`、`docs/handoff/clients/shared/types.ts`（仅生成器实际差异；其他 surface 产物若变化先查明再授权）。
- `changelog.d/activity-os-r3-c2-d2-manual-outcomes.md`（新增 implementation fragment，不是本次计划 fragment）。
- `docs/ai-harness/CUTOVER_SIGNOFF.md`：仅维护者再次确认实际 3b/4b 后可改，本计划不预签。

预计新增两权限、一活跃事件：当前 252→254、Audit 161/156→162/157；这里只是预算，正式计数由代码和守护重新测量。不得提前把这些数写入当前事实。

### 3.4 迁移与旧测试计数

当前 113 条 migration。正式实施启动时确定唯一 `prisma/migrations/<现场时间戳>_activity_os_r3_c2_outcome_command_receipt/migration.sql`，生成**精确文件路径**的维护者授权命令；不授整个 migrations、不改历史 SQL。只 additive，不做回填/物理删数据。模板迁移验证和 worker 生命周期见 §4，不能把本计划当数据库授权。

新增一条后，以下 15 份现有测试仅同步 CURRENT_MIGRATION_COUNT 和描述当前总数的标题，旧升级起点/历史 SQL/行为断言保持：

```text
test/e2e/activity-os-r1-a3-template-definition-lifecycle-guards.e2e-spec.ts
test/e2e/activity-os-r1-a4-explicit-template-version-pointer.e2e-spec.ts
test/e2e/activity-os-r2-b1-place-schema-constraints.e2e-spec.ts
test/e2e/activity-os-r2-b2-coordinate-projection-schema-constraints.e2e-spec.ts
test/e2e/activity-os-r2-b3-form-blueprint-governance.e2e-spec.ts
test/e2e/activity-os-r2-b6-creation-data-foundation.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2a-metric-command-receipt-migration.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts
test/e2e/activity-os-r3-c1-metric-definition-set.e2e-spec.ts
test/e2e/activity-v11-batch4-allocation-candidate-position-anchor-migration.e2e-spec.ts
test/e2e/activity-v11-batch4-allocation-command-replay-migration.e2e-spec.ts
test/e2e/activity-v11-batch4-allocation-determinism-migration.e2e-spec.ts
test/e2e/activity-v11-batch4-allocation-mode-migration.e2e-spec.ts
test/e2e/activity-v11-batch4-qualification-contract-migration.e2e-spec.ts
test/e2e/insurance-evidence-registration-revision-migration.e2e-spec.ts
```

另列 `test/e2e/activity-os-r3-c2-outcome-value-revision.e2e-spec.ts`：仅当其“当前全量回放”实际总数受新迁移影响时同步计数；112→113 历史升级试验仍固定 D1，不改断言证明的约束。不修改其他旧测试；若新 FK 造成旧清理失败，先确认目标库及依赖链后请求精确扩展。

## 4. 验证顺序与暂停条件

1. 正式授权后先跑 preflight、Prisma 生成物核验、原行为 characterization；本机不跑全量 E2E。D1 的既有约束、C1 指标选择及 B5/B6/B7 HTTP 原样回归；挑选精确 spec，禁止宽 pattern 意外带入 w96/w97。
2. 请求独立批准 app_test 的 migrate deploy 核验及 app_test_w1/app_test_w98 隔离验证与重建；运行前确认没有其他进程使用这些库。禁止自动 migrate dev/reset/db push，禁止触及 app_test_w97、生产或其他实例库。
3. 新收据 PostgreSQL 测试：113 非空基线→新迁移保留成果与旧收据，冷回放，唯一/FK/CHECK/不可改删正反例；只查 SQL 字符串不能验收。
4. 新 HTTP E2E 证明默认未分配用户拒绝、显式授码且责任/组织满足者可完整读写；没有这些正例不能称可用。owner 转移、账号停用、组织失效、指标选择变化、附件竞争在等待后复验；无原始值/URL/凭证进入回执、日志或审计。
5. 本地 quick、定向 E2E、contract、新生成物校验；Authz/permissions 等依赖枢纽受影响，全量 agent:check:full 由 PR CI 冷跑裁决。测试失败保留断言，需越权才能修则先上报；同类修复至多两轮。
6. 原 B6 500 根因仍未定位；遇到复发读取 #1290 的脱敏诊断，不自动判误报、放宽超时或重试。跨模型评审依维护者指示延后整体统一执行，不后台调用模型。
7. 实际新 migration/权限/审计计数和 SQL hash 稳定后再请求 3b/4b 重签；可信红区审批、提交/推送/implementation PR、合并与生产分别按当次授权执行。所有链路验收完成才登记 D2 landed。

## 5. 本次四份文档写集与下一次授权

本计划、新增 `changelog.d/activity-os-r3-c2-d2-plan.md`，以及 FROZEN_DRAFTS/NEXT_TASKS 的 C2 D2 当前方案与计划登记。仅这些文件可提交、推送、创建计划 PR；本次不合并。

下一次须明确批准本计划的 implementation 写集与上限、精确定名后的迁移文件、两权限默认不分配及显式授予验收、数据库范围；实施前对每个红区路径运行 harness:needs，并由维护者本人发令牌。未纳入的后果路径必须另行确认。方案 A 已批准不等于这些实施写权限已批准。

## 本次未做

未写代码或测试，未建收据或 migration，未修改权限、审计、合同、状态或 Gate；未执行数据库、生产部署、初始化、后台模型评审；未合并计划 PR，未启动 D2 implementation。C2 D2、C3–C5 与生产可用性仍未完成。
