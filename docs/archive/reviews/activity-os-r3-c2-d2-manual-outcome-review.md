# Activity OS R3 / C2 D2：人工成果草稿与修订评审及授权清单

> 2026-09-07，调查基点 main `22c1ba8f`。维护者已批准本稿及五份配套文档的起草、提交、推送与创建 PR；**未批准方案实施、合并、数据库操作或 Gate**。本 PR 为 A 档 docs-only，后续 implementation 按 D 档另行确认。
>
> 外部蓝图是需求材料，不是执行授权。本稿承接 [T0-A §7.3/§8](activity-os-t0-terminal-review.md)、[C2 评审](activity-os-r3-c2-outcome-value-revision-review.md)与 [D1 两项已批准订正](../plans/activity-os-r3-c2-d1-implementation-plan.md)，不回改历史冻结稿。

## 1. 需要拍板：人工草稿／修订闭环，正式确认仍归 C3

- **做什么**：让有权活动负责人按精确指标集录入 manual 成果草稿、追加修订，并读取本人可管理活动的历史成果；把 D1 的附件存在性提升为事务内的活动归属验证。
- **不做会怎样**：D1 只有数据地基，仍没有可使用的人工成果路径，证据归属也不能宣称闭环。
- **最坏情况与回退**：越权读取草稿、跨活动关联附件、并发覆盖或重放泄露历史结果。回退撤回新增路由／writer 的应用版本，保留追加数据、收据及 migration；不删除历史，不另造半开 Gate。
- **推荐方案 A**：先确认本稿，再列精确实施写集；仅 Human App managed 读写、独立成果收据、最小权限与审计。一次业务轴完整交付，不用“只接一个写入口”代替读写、历史、并发和附件验收。
- **方案 B**：同时开放 Admin、成员自助、确认、自动计算和报表。范围和风险明显扩大，需分别重开对应评审，本稿不推荐。
- **当前承诺**：只写六份已授权文档；下文均为待拍板合同，不是已有接口或实施授权。

## 2. 当前证据与 D1 收口事实

| 证据 | 当前事实及对 D2 的约束 |
|---|---|
| [#1289](https://github.com/BA7IEE/srvf-nest-api/pull/1289)，merge `c2fa226d`；`prisma/schema.prisma:1775` 起 | Outcome／Value／Evidence 三表及第 113 条 migration 已合入；成果链复合 FK、唯一约束、不可变内容、确认元数据形状已交付，不等于已有 writer。 |
| `src/modules/activities/activity-outcome-value.ts` | C2 校验实际成果值；C1 解析定义配置，复用 canonical/hash。支持形状不等于允许采集敏感短文本。 |
| `prisma/schema.prisma:1845`；`prisma/migrations/20260906114906_activity_os_r3_c1_metric_selection_template_v3/migration.sql:40` 起 | C1 收据的 target/result CHECK 与 operation 闭集绑定定义、集、模板和选择，不能把成果 JSON 塞入后声称复用成立。 |
| `src/modules/activities/controllers/app-managed-activity-metrics.controller.ts`；`activity-metric-selection-access.ts:100` 起 | C1 选择 writer 限 Activity draft，且含既有 SUPER_ADMIN 特例。D2 不能照搬成“管理员可读写任意成果”，也不能用草稿选择的状态闸阻止活动结束后录入成果。 |
| `src/modules/attachments/attachments.service.ts:181/198` | trusted 边界要求 caller 先完成 scoped 判权并持有根锁；附件属主校验由 attachments 完成，活动模块不得直接查询 Attachment。 |
| [#1290](https://github.com/BA7IEE/srvf-nest-api/pull/1290)，merge `22c1ba8f`；[main CI](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34092294387) | B6 测试仅增脱敏诊断；15 项 PR 检查与最终 main CI 通过。#1289 首轮 main CI 的 500 未定位，后续未复现，不登记为已修复或误报。 |

D1 的 113 冷回放、112→113 非空升级、8 项数据库测试、C1/C2 55 项单测、兼容回归、contract 与 PR CI 已验证；维护者已确认第 113 条 migration 的 3b 重签。D1 不增加权限或审计事件：当前权限 252、Audit events 161 总计／156 活跃不变。整体跨模型复审按维护者要求延后统一执行，未冒记为通过。上述均不是生产部署证据。

## 3. 待批准的 Human 合同

### 3.1 主体、权限与可见性

方案 A 仅开放 App managed 面。每次请求重新验证 User/Member 活跃、当前活动责任与组织可见性、显式权限；ADMIN/SUPER_ADMIN 身份不绕过本稿的业务范围。本人责任的判定复用责任属主接口，不在 Outcome 模块复制责任 SQL；若现有接口不足，实施前列精确扩展并另获授权。

建议新增 `activity.outcome.record` 与 `activity.outcome.read`，不扩大 `activity.update.record`，不把 capability 当授权。权限 eligibility 明确拒绝 Service/Delegated principal；本阶段无 Integration 入口。角色默认分配建议为空，不默认赋给全部队员或管理员；实施方案须明确责任范围与显式授予如何共同生效，并用真实 E2E 证明有权用户可走通，不能交付一个永久不可用入口。

| 候选 endpoint | 权限／范围 | 候选结果 |
|---|---|---|
| `POST /api/app/v1/my/managed-activities/:activityId/outcomes` | `activity.outcome.record` + 当前责任 + 组织范围 | RecordActivityOutcome；创建草稿或完整替代快照的新 revision，统一返回安全命令结果。 |
| `GET /api/app/v1/my/managed-activities/:activityId/outcomes` | `activity.outcome.read` + 同一业务范围 | 分页历史头摘要，revision 倒序，不返实际值或附件内容。 |
| `GET /api/app/v1/my/managed-activities/:activityId/outcomes/:outcomeRevisionId` | `activity.outcome.read` + 同一业务范围 + 同活动锚点 | GetActivityOutcome；按历史精确集解释的安全明细，不返 Prisma row。 |

无责任、不可见活动、跨活动 revision 均在披露内容前拒绝；不存在与不可见资源使用一致的 404 业务语义。认证／App 准入失败与资源可见性错误分层；专用 BizCode 名称及数值必须在实施清单现场分配，不在本稿预占。建议分类为 invalid、stale、command-conflict、receipt-invalid、reference-unavailable，HTTP 分别为 400、409、409、409、404。

### 3.2 输入、输出与完整修订

候选命令字段：`operationKey`、`expectedRevision`、`metricSetVersionId`、`metricSetDefinitionHash`、`values`。首份 expectedRevision=0，此后必须等于该活动最新成果头 revision；拒绝未知字段和客户端自定 actor、status、source、hash、确认人／时间。

- values 是本次完整草稿快照，不是对旧值原地 PATCH。每项仅 `metricDefinitionId`、强类型 `value` 和有序 `evidenceAttachmentIds`；同指标、同值内重复附件均拒绝。草稿允许未填齐所有集项，至少包含一个值；遗漏的旧值只是不进入新快照，不删除历史。
- 默认只允许 integer、规范 decimal 字符串、boolean、受控 single_choice；拒绝 short_text。具体数量、长度、分页上限沿现有 C1 集项容量现场核定，实施前必须落成 DTO 和服务层双边界，不接受无界数组或 JSON。
- 服务端固定 sourceCode=manual；sourceReference／calculatedByRuleVersion 采用受控人工记录标识，不接自由文本、URL、Prompt、Token 或请求 key。确认人／时间为空；不接受 system/import/AI 来源，不产生 confirmed。
- 明细返回 Outcome 头、指标定义必要投影、类型安全值、来源类别、证据附件 ID 和顺序；不返附件 key、URL、文件内容、命令 key、原始收据或个人身份资料。历史项按其原始集 id/hash 读取，不能套用当前最新定义。
- 命令结果仅含成果／活动锚点、revision、精确集 id/hash、创建时间与创建时状态 draft；该状态是不可变创建回执，不冒充随后查询的当前状态。完整值通过受权明细接口读取。

建议 Activity `draft/published/completed/terminated` 可写人工成果草稿，`cancelled/archived` 拒绝新写；草稿不代表参与或正式成绩。已归档活动的历史读取仍按当前权限与责任范围，不隐式解档。该矩阵待维护者拍板，不改变活动现有生命周期或结束条件。

无成果时首份 revision=1；后续只追加 latest+1，prior 指向同活动最新头，旧 draft 在同事务转 superseded。旧内容和值永不更新。未来若已有 confirmed，不允许 C2 writer 把它降级或 supersede；正式成果的更正接缝归 C3。指标集选择变化后，新草稿必须使用锁后当前精确集，旧稿继续按旧集解释，不拼接两套口径。

## 4. 独立收据与事务不变量

**建议新增专用 ActivityOutcomeCommandReceipt**，不修改 C1 收据闭集。候选字段：actorUserId、operationCode（仅 record_manual_outcome）、operationKey、requestHash、activityId、outcomeRevisionId、最小 resultJson、createdAt；唯一键覆盖 actor/operation/key，成果与活动必须复合锚定，收据不可变。resultJson 必须有严格版本、字段闭集、类型及 FK 锚点一致性检查，不能成为通用响应仓库。新增 migration 的编号、文件名和确切 SQL 在 D 档实施清单另定，不预占第 114 条。

request hash 使用独立 domain，覆盖活动、expectedRevision、精确集、全部 canonical 值和附件顺序；actor 属于幂等身份。指标按固定键排序，附件顺序保留，省略与空列表语义须唯一。相同 key/请求只返回原回执且无新写、无重复审计；异请求冲突，坏收据 fail-closed。

锁序建议与现有活动命令兼容：初步当前身份／范围校验 → 命令 advisory 锁 → Activity 根锁 → 当前身份／责任／权限复验 → 收据重放判定 → 新写的状态、expectedRevision、指标集／集项校验 → 附件归属及引用边界锁 → 等待后的再复验 → 追加成果／值／证据、旧 draft superseded、收据与最小审计 → 提交。实施前必须核对所有属主锁序，不能凭该顺序文字假称不存在死锁。

重放仍校验当前身份与资源范围，不因后来变更指标选择、成果 revision 或归档而重执行旧命令；与新写状态门分离。权限撤销者不能凭旧 key 拿回结果。两个不同 key 携相同 expectedRevision 并发时只一条成功；任一后续写失败整笔回滚。

附件先由 `findOwnedAttachmentsTrusted` 确认全部属于该 Activity，再由 `lockOwnerReferenceStorageBoundaryTrusted` 保护引用；key 只作为内部受信任锁输入，不进 DTO、审计或回执。已锁附件后的组织／责任漂移必须重新判定。D1 的 FK 只证明存在，不能替代这里的归属检查；测试必须用另一个活动的合法附件做反例，并证明零残留。

## 5. 隐私、审计和不做清单

建议新增单一 `activity.outcome.command` 审计事件：只记录资源锚、操作、revision、状态变化、manual 来源和数量，使用现有受控 actor／request 元数据；不存实际值、附件 key、原始来源、operationKey 或完整响应。实施时权限／审计的真实增量与 4b 重签单独核验，本文不提前改变当前 252／161 读数。

不新增敏感字段，不允许短文本或人员名单、健康、身份证、精确轨迹等内容。仅引用既有合法 Activity owner 附件，不新增上传口、MIME 策略、owner type 或下载权限。附件若涉及敏感内容，必须先独立回答用途、查看角色与掩码、留存／退队清理三问；未解决前不得以“已有附件”绕过。成果值本身亦须来自已治理非敏感指标，不能仅因是数字就判断安全。

不改 C1 定义／选择、v2–v7、Readiness、发布、报名、考勤、服务时长、贡献、账本、结束／归档条件；不接 Admin/Open/Integration、自助读面、报表、AI、import、system 或 confirmed。D2 不创建任何新 Gate，不开启现有 Gate。C3–C5 仍逐轴独立推进。

## 6. 实施前授权清单与验收

本稿通过后，还须单独批准 D2 implementation 清单；至少包括：

1. **存储**：新收据模型与单条 additive migration、SQL 不变量和 schema 反向关系。三个已合入成果模型若需改列／约束，必须单独列明，不借本稿概括授权。
2. **领域**：Record/Get facade、Command/Query/Presenter/Policy/Audit 各自职责、App controller/DTO、活动模块装配及测试的精确文件名；不在大 service 堆放或跨域复制私有 SQL。
3. **安全与契约**：权限注册与角色授予策略、Audit 事件、BizCode、authz 目标解析、路由声明、契约 snapshot 逐行差异、生成 OpenAPI/client、App handoff；所有实际依赖后果路径逐一列入写集。
4. **治理**：收据 ownership/state 登记、迁移计数、CODEMAP、RBAC_MAP、ROUTE_AUTHZ 与派生读数；生成物也不能越过精确授权。对应 3b/4b 和可信审批按实值办理。
5. **验证**：先核实模板／worker 库、无并发占用，再由维护者批准 app_test 核验及 app_test_w1/app_test_w98 生命周期；本次文档授权不包含任何数据库动作。禁止自动 migrate dev/reset/db push。

最低行为验收：

- Human manual 首次记录、完整修订、分页历史与单项明细均真实可用；旧 revision 内容逐字保留，不能只有数据库 fixture。
- 同 key 同请求、异请求、坏回执、跨活动 key、并发 expectedRevision、权限撤销后的重放分别验证；重放无新成果、无重复审计。
- 身份、责任、组织、指标选择和附件在锁等待期间变化均有确定性并发测试；不同活动／集／附件拼接拒绝，任何失败零部分写入。
- 四类可写值的边界、错误类型、重复项、超限、未知字段、定义/hash 漂移、敏感／short_text、伪造 source/confirmed 全部 fail-closed。
- draft/superseded 历史读取与活动状态矩阵逐格覆盖；C3 前不得产生正式成果，成果行为不影响参与／时长／贡献和发布状态。
- 113→新迁移非空保留及冷回放、真实 FK/不可变收据验证；现有 C1/B5/B6/B7 characterization 不改断言换绿。
- 本地 quick 与定向 E2E、PR 全量 CI、契约、授权计数及 handoff 完成后才报仓内闭环；生产与整体跨模型复审另列。

## 7. 本次精确文档写集

1. 本评审稿 `docs/archive/reviews/activity-os-r3-c2-d2-manual-outcome-review.md`（新增）。
2. `docs/ai-harness/FROZEN_DRAFTS.md`：C2 D1 当前状态、D2 分类登记与派生读数。
3. `docs/ai-harness/NEXT_TASKS.md`：P1-33 的 C2 当前事实和后续顺序。
4. `prisma/CLAUDE.md`：仅当前 migration 摘要，不改历史长记。
5. `src/modules/activities/CLAUDE.md`：仅 C2 当前实施摘要。
6. `changelog.d/activity-os-r3-c2-d2-review.md`（新增）。

本次允许提交、推送和开 PR；不合并。本文建议的权限、状态矩阵、收据与 route/DTO 均待方案确认和独立 implementation 授权。

## 8. 本次未做

未实施 D2，未修改生产代码、测试、schema/migration、权限、审计、DTO 或 Gate；未操作数据库、部署、回填或初始化目录；未判定旧 CI 500 已修复，未运行跨模型后台评审；未把 C2 全体、C3–C5 或生产可用性标成完成。
