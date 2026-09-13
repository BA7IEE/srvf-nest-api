# Activity OS R4 D5 时长影子对账：合并评审与实施计划草案

> **implementation 授权更新（2026-09-14）**：维护者已批准按 #1328 第 10 节 34 路径实施，允许 app_test_w98 隔离验证及测试夹具重建，验证后提交推送并创建 PR；不合并、不操作生产、不启用 Gate、不删除业务数据。四项精确红区令牌已核验。以下 docs-only 及候选表述为计划历史，以本条和第 10 节收敛合同为执行范围。

> **2026-09-14 维护者确认**：D5 方案 A 已确认；允许本轮四份文档提交、推送并创建计划 PR，不合并、不实施。下文候选/待确认等为起草过程记录，以本条和第 10 节的收敛合同为准。34 路径是后续实施清单，不是本轮代码写权限；D5 接口尚不存在。D4 合并后 main CI 已通过。

## 1. 状态、目标与边界

2026-09-14 起草，基线 main `519d232e6d187bf58e9982b287764f05108dcf21`。本文件是候选方案，不是实施授权或已存在接口。D4 已合入 #1327，前置草稿执行链已合入 #1326；D4 PR CI、Docker 与可信审批通过，合并后 main CI 34768550257 起草时仍在运行。

本轮只起草本文件、NEXT_TASKS、FROZEN_DRAFTS 与 changelog 四份文档。不实施、不操作数据库、不部署、不启用 Gate、不删除数据；提交、推送和文档 PR 单独确认。D5 实施须在前置 main 验证成功与本稿决策确认之后。

冻结依据：T0-A §7.1、§10.3、§11。D5 必须给出旧服务时长与新分类 bucket 的对账和差异清单。D6 才建设正式 Time Ledger；D7 更正/冲回；D8 证明与正式切换。不得把 D5 对账通过当成生产 GO。

## 2. 人话简报与推荐方向

- 做什么：让有资格的负责人/审核者查看同一结算版本的新旧时长差异，逐人定位来源和不可比较原因。
- 不做会怎样：D6 接线前无法知道差异来自分类、人工认定、取整还是数据缺失。
- 最坏情况：把不同版本或不同单位强行比较，产生看似归零的假证据；通过版本同链、精确十进制换算、完整分母和反例测试防止。
- 方案 A（推荐、待确认）：按指定的 D4 submitted 时长修订提供独立只读对账报告；不建立第二套参与事实、不写正式账本、不自动接受差异。报告只证明该冻结版本，不承诺当前版本仍适用。
- 方案 B：只输出内部算法对拍；不能覆盖真实访问资格、同链读取和用户可见差异，不能作为 D5 完整交付，不推荐。

## 3. 已核验的源码连接点

| 连接点                                        | 当前事实                                                                              | D5 限制                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| ActivitySettlementTimeRevision                | 固定 activity/run/settlementVersion/seal/source/hash，kindCode 区分材料类型           | 候选首期只比较 submitted 修订；draft 与正式结果不得混算 |
| ParticipantSettlementTimeBucket               | calculatedSeconds 可空，recognizedSeconds 与分类/政策来源                             | 空计算值保留未知，不用零代替                            |
| ParticipantSettlementResultRevision           | 同 settlementVersionId + participationIdentityId 唯一；旧计算/认定小时为 Decimal(5,2) | 分别对比 calculated/recognized，不混淆人工调整          |
| ActivityTimeSettlementAccessService.authorize | 当前用户、组织资格、显式 scope、负责人/版本审核资格                                   | 复用 read 判权，历史版本不绕开撤权与审核分离            |
| ActivityTimeSettlementQueryService            | 既有只读事务与版本访问复核                                                            | 不复制一套弱化判权；接入方式需继续核实私有 read 边界    |
| TIME_SETTLEMENT_LIMITS                        | 2000 身份、10000 段、50000 切片、8000 桶、40000 来源                                  | 最大规模不缩减、不截断成成功报告                        |

B7 的 shadow 是创建控制面，不是时长对账开关；不得复用它宣称时长已切换。D4 冻结来源不等于已入账事实，报告明确区分。

## 4. 候选数据合同

1. 输入 activityId 与明确 timeRevisionId；服务器验证同活动、同结算 run/version。禁止只取双方各自 latest 后拼接。不存在和不可访问沿既有不可用错误处理，不暴露跨活动信息。
2. 比较单位为 participationIdentityId；成员可能有多个参与身份，不按 memberId 粗暴合并。报告输出身份/版本标识、分类汇总和理由代码，不输出姓名、证件、电话或原始敏感备注。
3. 旧 calculatedServiceHours/recognizedServiceHours 分别按精确十进制转为秒（0.01 小时 = 36 秒），不得使用二进制浮点近似再容差归零。
4. 新侧 volunteer_service 分别与旧计算/认定秒比较；training、organization、non_creditable 单独展示，不加到志愿服务时长。legacy_unclassified 不自动归入 volunteer_service，列为需治理/不可直接开证明。
5. 差额定义为新秒数减旧秒数；计算差额与认定差额分别返回。calculatedSeconds 为 null 时，计算差额为 null 且明确不可比较。缺旧结果、缺桶、版本不匹配、来源异常均不补零。
6. 结果分为 matched、different、not_comparable。matched 仅为该项双方可比较且精确相等，不等于政策合法、已批准或允许 cutover。
7. 以新旧身份集合的并集建立分母；摘要恒满足总数 = matched + different + not_comparable。只在两边皆空时显示 empty，不得以“0 差异”伪装验收成功。
8. 差异原因分为可证事实与未知原因。可展示分类分流、计算值未知、人工认定存在等事实，但不单凭数值差额推断根因；未证明的统一保留 unexplained。没有自动豁免或自动调整按钮。
9. 稳定按身份排序、分页，摘要覆盖完整集合而非当前页；无静默截断。返回报告格式版本、比较器版本、双方版本锚和 D4 hash。时间戳仅作生成时间，不参与确定性内容 hash。
10. D5 不写持久化业务记录、不删除业务数据。正式放行证据需保留报告文件/hash、验证提交及人工差异清单；具体受控归档位置和批准清单格式须在实施前定案，不能用临时目录作为永久审计存储。

## 5. 访问、事务与查询策略

候选只读 GET 挂既有 App managed 时长结算 controller，复用 activity.time-settlement.read 及指定版本的资格复核，零新增默认授码。具体 URI 在核验现有路由命名和防枚举约定后冻结，不先写入 EXPECTED_ROUTES。

所有关联读取在同一只读一致性事务内完成；授权在事务内使用当前身份/权限，不跨请求缓存。新旧版本及身份采用集合读取，禁止逐身份查询。来源下钻只引用既有冻结入口，若为计算差异新建下钻，须重新列出路径和访问合同，不能临场增加。

查询预算和最大耗时不得凭空继承 D4 写命令预算：先列实际查询调用链、按 1/100/2000 身份验证不随人数线性增加，再冻结数值。预算未定前本稿不具备“完整实施包”资格。只读报告故障不影响原创建、结算、审核和账本链，不增加定时任务或后台队列。

## 6. 验收清单（待实施，不是通过记录）

- G1 同活动、同结算版本正例；跨活动、旧/新各取 latest、draft/submitted 混用反例。
- G2 Decimal 精确换算：0、0.01、多段、跨日；计算和认定差异分别保留；禁止浮点容差抹平差异。
- G3 四类并存、非志愿类别不混入志愿总量、legacy_unclassified 与未知计算值显式阻断比较。
- G4 新旧单侧缺项、双方空、零时长合法项；分母守恒且不漏掉只在旧侧存在的人。
- G5 人工调整存在但原因不能由数值推断；未解释差异不自动归零或接受。
- G6 负责人/合格审核者正例；普通成员、跨组织、撤权、停用账号、失效成员及自审限制反例。
- G7 指定历史版本可重复读取；并发新提交不混版，撤权即时生效；输出不含敏感备注。
- G8 分页前后摘要一致、顺序稳定、确定性 hash；1/100/2000 身份规模，完整有效来源规模与无 N+1 证明。
- G9 对账前后所有业务表无写入；正式 serviceHours、贡献分数、账本、审计事件、Gate 均不变。不可只依赖 mock 查询次数证明零写。
- G10 characterization、quick、定向 w98 E2E、契约逐项解释、CI 全量、派生文档/治理检查；不删测试、不放宽断言。生产演练另行授权，不混入本轮。

## 7. 实施写集候选与精确化剩余工作

已定位的既有候选连接点：

- src/modules/activities/activity-time-settlement-query.service.ts
- src/modules/activities/activity-time-settlement-query.service.spec.ts
- src/modules/activities/activity-time-settlement-access.service.ts（优先不改；若 read 复用足够则排除）
- src/modules/activities/controllers/app-managed-activity-time-settlement.controller.ts
- src/modules/activities/dto/app/app-activity-time-settlement.dto.ts
- test/contract/openapi.contract-spec.ts 与对应 snapshot
- docs/handoff/admin-web.md、docs/handoff/miniapp.md

新增候选：src/modules/activities/activity-time-shadow-policy.ts、对应 .spec.ts、test/e2e/activity-os-r4-d5-time-shadow.e2e-spec.ts。若需独立查询 service，则先核验模块接线再加入 activities.module.ts，而不是先声明无限写集。

生成项由实际路由/DTO 变更和生成器枚举后逐文件登记，包含 CODEMAP、ROUTE_AUTHZ、OpenAPI/客户端等；禁止使用“所有派生文档”作为授权通配符。schema/migration/seed、权限目录、全局守卫、原账本写路径、数据库清理与 CI 配置不在候选业务写集。

本稿尚须完成三项才可一次性请求实施：①旧 submitted 结果字段与 D4 snapshot 同一性、hash/状态变动的读取合同核验；②最终 URI、查询数/耗时预算与归档验收位置定案；③生成路径枚举和逐文件 harness:needs 预算。不得把此候选列表冒称最终精确写集。

## 8. 授权清单与后续节奏

先在同一文档分支补齐上述精确化项，再一次请求方案/写集/隔离测试/提交推送权限。实施与 PR Ready、合并、部署、Gate 仍分开；不能因要求加速而把生产权限默认为同意。若发生超出写集的真实发现，按完整引用链一次列清，不零碎扩修。

本次未做：D5 代码、接口、数据库验证、影子报告运行、正式时长账本、cutover、整体跨模型复审、前端发布与生产部署。

## 9. 源码复核补充（2026-09-14，仅计划）

### 9.1 版本同链和现有事务语义

- `activity-time-settlement.service.ts:420–441` 的 copyPrepared 在旧提交事务回调中创建 submitted TimeRevision，使用回调返回的 settlementVersionId，并复制已准备的桶。旧结果由 `settlement-submit.service.ts` 复制到同一提交版本。因此候选报告以 submitted TimeRevision 的 settlementVersionId 为唯一旧侧入口，不调用当前草稿重算。
- `settlement-submit.service.ts:411` 的 canonical 内容 hash 包含逐人结果和四个十进制金额字段；`settlement-review.service.ts` 明确只比对已存 hash、不重算。D5 不修改这些既有方法，也不得声称 D4 draftContentHash 就是旧 submitted contentHash。报告分开携带两种 hash，并以读取到的对账金额生成独立 inputFingerprint，避免混淆语义。
- `activity-time-settlement-query.service.ts:400` 的私有 read 包装采用 ReadCommitted、30 秒事务和前后两次当前访问资格检查。D5 推荐在同类内新增 shadow 方法复用它；不新增 service/provider、不改模块接线、不改 access service、不换成可能看不到新撤权的 RepeatableRead。
- §5 的“只读一致性”指同版本冻结内容关联读取，不代表现有包装已执行 `SET TRANSACTION READ ONLY`。实施验收须检查报告路径没有业务写调用并用数据库证据核验零写；不能把命名 read 当作数据库只读证明。
- 旧结果的可变 status/updatedAt 不进入对账计算。D5 对异常数值变化不接受静默复用历史报告：完整金额集合 inputFingerprint 不同即是不同证据。冻结约束的具体覆盖仍须结合既有迁移/回归完成审计，不能仅凭注释认定数据库不可变。

### 9.2 接口与性能候选

候选单一路由：`GET /api/app/v1/my/managed-activities/:activityId/time-settlement/revisions/:timeRevisionId/shadow`。复用既有 timeRevision 参数 DTO 和分页规范，在 app-activity-time-settlement.dto.ts 增加独立报告/行 DTO；无写命令、无修改旧返回字段、无跨 surface DTO 继承。

候选预算为总查询不超过 120、沿用原 read 的 30 秒事务上限；这是待批准的验收上限，不是实测读数。用固定集合查询读取修订/版本锚、旧结果和新桶，最多 2000 身份、8000 桶；不为每个身份读取来源表。需要解释来源时返回既有冻结下钻链接所需 ID，不从 40000 来源逐条反查。若无法满足规模和预算，应报告原因，不提高上限或缩小人数。

摘要和本页来自同一完整比较结果，使用相同 inputFingerprint；多页导出时任何 fingerprint 变化均拒绝拼接。候选归档为维护者按 SOP 将完整分页结果与 manifest 保存至既有受控证据存储，不增加第三方服务或业务清理。存储位置与访问主体须由维护者确认，不能写成已有可用设施；未归档不得登记 D8 放行证据。

### 9.3 已定位的生成物闭包

生成器 `scripts/generate-fe-client.ts` 声明六个 surface 和共享类型，统一 digest 会联动 13 个客户端路径。候选仅 app 的类型和调用有新增语义，其他 surface 仅允许生成摘要变化：

1. docs/handoff/clients/admin/client.ts
2. docs/handoff/clients/admin/types.ts
3. docs/handoff/clients/app/client.ts
4. docs/handoff/clients/app/types.ts
5. docs/handoff/clients/auth/client.ts
6. docs/handoff/clients/auth/types.ts
7. docs/handoff/clients/integration/client.ts
8. docs/handoff/clients/integration/types.ts
9. docs/handoff/clients/open/client.ts
10. docs/handoff/clients/open/types.ts
11. docs/handoff/clients/shared/types.ts
12. docs/handoff/clients/system/client.ts
13. docs/handoff/clients/system/types.ts

另有 docs/handoff/openapi.json、CODEMAP.md、docs/ai-harness/ROUTE_AUTHZ.md。是否联动授权声明 baseline、domain-map 摘要和 counts 文件须继续按输入闭包核实，未核实时不登记最终路径总数，不执行生成器写入。

### 9.4 本轮检查说明

四份文档预算已逐路径通过 harness:needs，无红区授权需求。FROZEN_DRAFTS 的 Prettier 告警在 HEAD 原文和本轮文件均存在，已用同一 Prettier 配置分别检查；本轮不批量重排历史台账。新计划已格式化，既有测试/断言和生产文件未修改。本地全量回归历史失败仍保留，未来验证以定向本地检查和 PR CI 全量为准，不再次本机全量空跑。

## 10. 精确写集与合并决策包（候选，覆盖前述未收敛项）

### 10.1 最小闭包

以下 34 个路径为方案 A 的实施候选上限，不是本轮已获写权限。没有实际差异的生成文件不制造空改动。业务新增仅七个路径；契约、交接和派生登记与实现同 PR 完成。

```text
src/modules/activities/activity-time-settlement-query.service.ts
src/modules/activities/activity-time-settlement-query.service.spec.ts
src/modules/activities/controllers/app-managed-activity-time-settlement.controller.ts
src/modules/activities/dto/app/app-activity-time-settlement.dto.ts
src/modules/activities/activity-time-shadow-policy.ts
src/modules/activities/activity-time-shadow-policy.spec.ts
test/e2e/activity-os-r4-d5-time-shadow.e2e-spec.ts
test/contract/openapi.contract-spec.ts
test/contract/__snapshots__/openapi.contract-spec.ts.snap
docs/handoff/admin-web.md
docs/handoff/miniapp.md
docs/handoff/clients/admin/client.ts
docs/handoff/clients/admin/types.ts
docs/handoff/clients/app/client.ts
docs/handoff/clients/app/types.ts
docs/handoff/clients/auth/client.ts
docs/handoff/clients/auth/types.ts
docs/handoff/clients/integration/client.ts
docs/handoff/clients/integration/types.ts
docs/handoff/clients/open/client.ts
docs/handoff/clients/open/types.ts
docs/handoff/clients/shared/types.ts
docs/handoff/clients/system/client.ts
docs/handoff/clients/system/types.ts
docs/handoff/openapi.json
CODEMAP.md
docs/ai-harness/ROUTE_AUTHZ.md
docs/current-state.md
harness/permission-surface-baseline.json
docs/ops/activity-time-shadow-reconciliation.md
docs/plans/activity-os-r4-d5-time-shadow-review-and-plan.md
docs/ai-harness/NEXT_TASKS.md
docs/ai-harness/FROZEN_DRAFTS.md
changelog.d/activity-os-r4-d5-time-shadow-plan.md
```

生成范围的理由：`generate-authz-manifest.ts` 生成 ROUTE_AUTHZ；`check-permission-surface-binding.ts` 将具体端点纳入权限管辖面指纹，因此复用旧权限也必须审核该基线差异，不能称“权限码没新增所以治理无变化”。`docs-counts.ts` 生成 current-state，预期端点 633→634，其他事实计数不变，最终以生成检查为准。不调整判据脚本或放宽守护。

明确排除 access service、activities.module.ts、schema/migration/seed、权限目录和任何 CI 配置。`check-boundaries.ts:403–421` 的 domain-map/state-machines 摘要输入是 schema 与模块接线，本方案不改这些输入；`generate-rbac-map.ts:222–241` 生成权限码、角色和 controller 前缀清单，本方案也不改这些集合，故不预先扩展对应文件。若实际生成反证此结论，先报告具体差异，不自动扩大写集。

### 10.2 同一性与证据边界

迁移文本检索已覆盖引用旧结果模型的两个 SQL 文件：初建 slice4 迁移及 D4 迁移。前者定义旧结果约束，append-only trigger 针对 ParticipationLedgerEntry；后者校验 D4 收据和桶，不足以证明旧结果金额有数据库级不可变保护。因此本方案**不宣称旧金额受数据库不可变触发器保护**，也不顺手补迁移。旧金额采用一次集合读取，绑定明确提交版本，完整比较输入参与 fingerprint；任何内容变化生成不同证据，跨页导出拒绝混用 fingerprint。旧 stored contentHash 作为版本锚展示，不作为已重算校验通过的证明。

推荐归档方案：D5 交付只读报告及人工导出 SOP，不新建存储服务或自动上传任务。完整 manifest 包含比较器版本、代码 SHA、活动/版本锚、输入 fingerprint、全部分页及分母、差异清单和审批记录；每页 fingerprint 必须相同。报告不含姓名/电话/备注；参与身份 ID 仍受访问控制。业务证据不自动删除。具体永久存储位置、可访问主体和备份由维护者在真实影子验收前指定，未指定时允许代码验证，不允许宣称业务验收、证据已永久保存或 D8 放行。临时测试证据不冒充永久业务证据。

### 10.3 一次确认内容与执行顺序

方案决策一次覆盖：§4 比较口径、§9.2 单一路由与 120 次查询/30 秒上限、§10.1 的 34 路径、§10.2 不删业务数据的证据留存边界。这些是推荐合同，不是已测结果。不单独增加归档基础设施，不实现前端页面。

实施授权另须明确：允许 app_test_w98 隔离验证及测试夹具重建；通过后提交、推送和创建 PR；不合并、不操作生产、不启用 Gate、不删除业务数据。维护者执行精确红区授权，AI 不自行发放；新增接口的权限管辖面摘要以实施后实际 diff 复核，不能在文档阶段提前签未知摘要。

获准后连续顺序：现有查询 characterization → 纯比较器和反例 → 同类查询/DTO/controller → 定向 E2E（含最大规模、撤权及零写）→ 契约和派生生成 → 精确 diff 自检与 CI。旧测试如需修改既有行为断言或清单外文件，汇总真实发现后一次申请，禁止偷偷放宽。整体跨模型复审仍按维护者此前决定留至整体阶段，不因本轮自检登记为已完成。

当前四份 docs-only 文档已可请求提交评审授权；这不意味着获准修改上述 34 路径。主干验证前置现已满足，实施仍需明确授权。

### 10.4 精确授权预算

最新验证：D4 合并后 main CI 34768550257 已 completed/success，五组 Contract + E2E 均 success；前文“起草时仍运行”仅为历史时点。NEXT_TASKS 状态闸及 FROZEN_DRAFTS 跨台账闸均通过，git diff --check 通过。当前仅四份文档有改动，未实施、未运行数据库测试、未提交或推送；历史本地超时根因不因此视为已修复。

已将 §10.1 的代码块逐行传入 harness:needs，结果为 34 个唯一精确路径，4 个需要红区授权、30 个无需令牌。此结果只证明路径预算，不证明实施获批或检查通过。当前四份文档本身均不需要红区令牌。

维护者在**方案和实施包获准后**于下列工作树执行；本轮 docs-only 无需提前执行：

```sh
cd /Users/dengwang/Documents/coding/srvf-nest-api-r4-d4-implementation
pnpm harness:grant 'harness/permission-surface-baseline.json' --reason 'D5 方案 A 精确计划第10节；仅新增对账读接口的管辖面指纹'
pnpm harness:grant 'test/contract/__snapshots__/openapi.contract-spec.ts.snap' --reason 'D5 方案 A 精确计划第10节；仅新增对账读契约'
pnpm harness:grant 'test/contract/openapi.contract-spec.ts' --reason 'D5 方案 A 精确计划第10节；保留旧断言'
pnpm harness:grant 'docs/ai-harness/ROUTE_AUTHZ.md' --reason 'D5 方案 A 精确计划第10节；生成声明及摘要'
```

不使用 test/contract/\*\* 等宽授权替代精确路径。工作树若变更，先核验新位置，不能跨工作树借用令牌。
