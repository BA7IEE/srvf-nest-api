# Activity OS R4 D7-2 事实更正与 Human 写链：评审及精确计划草案

> 2026-09-15，仅文档，方案 A 方向已确认；第10–13节为最终待审实施合同。第3–8节保留初稿取证历史；以第10–13节为最终待审口径。后续 D7-2 实施、验证、Draft PR 与 CI 的实际进展以第13–14节和台账顶部当前状态为准。

## 1. 基线与问题

D7-1 已通过 [#1334](https://github.com/BA7IEE/srvf-nest-api/pull/1334) 合入 main `28d74f3d413fa79f7cb1018295f0e0949f9bb7df`。合并前最终提交 `0f89ddfc` 的全量 CI、Docker Smoke 和 Ready 后可信审批成功。合并后的 [CI 34955332231](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34955332231) 初次核验运行中，现已 completed/failure：第5组E2E的2000身份最终审计回滚探针提前发生7秒事务超时（9989ms），其余分组通过；不能登记main验证成功，诊断记录见第13节。

D7-1 解决原事实不变时的分类认定更正；D7-2 要让真人提交事实修订、看到新旧差异、由另一人审核，再原子冲回与补记。原始记录、更正理由、失败准备和审计永久保留。D7-2 完成前整个 D7 保持进行中，D8 证明/统计与旧 serviceHours 投影切换不夹带。

### 1.1 现场代码证据

| 锚点                                                            | 事实与实施影响                                                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `correction-change-set.ts` 的 parseCorrectionChangeSet          | v1 历史合同保留；v2 强制 segments 为空。新事实必须另立 v3，不能放宽 v2。                                                        |
| `correction-application.service.ts:405/520`                     | submit/review 已有内部方法与审核分离，但不能直接当作已具备 App 访问控制的接口。新入口的当前资格检查必须覆盖重放出口。           |
| 同文件 `:1634/1675`                                             | prepare 只写 CorrectionPendingSegmentRevision，commit 才物化真实段；当前逐段查询/写入不能拿 D7-1 零段容量通过冒充满额更正通过。 |
| `prisma/schema.prisma:2548`                                     | allocation 的 sourceSegment 必须引用真实 ParticipantServiceSegmentRevision；不能用暂存行 ID 冒充正式来源。                      |
| 第121条 migration 的 ptar_settlement_draft_guard（约235–247行） | sealed-draft 分支要求 run=drafting 和当前草稿；correction_open/applying 不能复用这个证明。                                      |
| `activity-time-allocation-policy.ts`                            | 来源内分割、非重叠、政策与证据检查已有属主纯函数，继续复用。                                                                    |
| `activity-time-settlement-access.service.ts:38`                 | 现有 App/read、显式组织授权、负责人或指定版本审核资格可复用，不能把 GLOBAL 终审码等同新 App 写资格。                            |
| `correction-review-separation.ts`                               | 申请人不得审核自己的申请；不额外禁止原结算提交人审核别人提出的更正。                                                            |
| `correction-application.service.ts:148/592`                     | returned 仍占开放请求；当前无 resubmit/withdraw 方法。HTTP 审核若开放退回，必须同时设计可用的重新提交链。                       |

## 2. 人话简报与推荐

做什么：把“参与时间记错后的修订、重新分配、审核和记账”接成有证据、能重放的完整流程。
不做会怎样：只能改认定数字，不能证明修改后的参与事实与新分类账一致。
最坏情况与回退：若只冲回不补记会造成账缺失；所有生效动作放在同一事务，失败整体回滚。上线故障停对应写入口并前向修复，不删旧账、不回退到不识别新凭证的版本。

- 方案 A（方向已确认）：保留 D7-1 固定根账，先覆盖原结算身份和既有 segmentKey 的时间/类别分配更正；政策沿原冻结政策。增加更正来源证明、v3、真人完整写链，提交前明确核验请求、计算与认定摘要。
- 方案 B：本包同时加入遗漏人员、全新服务段和政策替换。需要身份来源、补建资格、新增根账及政策变更合同，必须扩大模型设计；不能套用 A 的路径或假称 A 覆盖 B。
- 选择 A 不表示遗漏人员/全新段需求消失：这部分仍是 D7 退出条件的待决范围，须由维护者明确分期或纳入本包。不得自行将整个 D7 标完成。

## 3. 数据合同候选

### 3.1 v3 与前置冻结

v1/v2 的解析、canonical、hash、消息与重放逐字兼容。v3 顶层候选闭集为 schemaVersion、results、segments、timeCorrection、allocations；其中旧 results/segments 保持旧字段语义，v3 额外要求来源版本与 hash 一致；timeCorrection 仍携完整根项及认定秒数，allocations 提交本次变化段的完整分配而非任意 patch。客户端不得提交可信 requestHash、actor、计算秒数、正式 allocation ID 或审批人。

allocations 项候选字段：participationIdentityId、segmentKey、baseSegmentRevisionId、baseAllocationRevisionId、recognitionModeCode、manualReason、slices、evidenceAttachmentIds。slice 沿 D3 四类别/区间格式；服务端以更正后区间校验互斥与来源内约束。自动模式执行原冻结 evaluator；人工模式仍受原政策 manualAdjustment 和证据要求约束。全部变更段恰有一份分配，遗漏、重复、越界、跨活动和未声明额外段一律拒绝。未变化来源按明确 base 快照读取，不能按 latest 扫描。

理由用于解释更正；原理由字段永久留存，仅经审核资格复核的详情返回，普通列表/审计不复制全文；不新增证件、医疗、轨迹或凭证字段。附件沿既有属主接口在事务内核验存在、活动归属与访问资格，保存引用不复制文件，不新增清理任务。

### 3.2 暂存与真实分配

候选新增两类追加模型，最终字段/FK 见第8节待闭合项：

1. CorrectionPendingTimeAllocation：绑定 application、pendingSegment、baseAllocation、冻结 policy/version/selection/hash、canonical 分配、条数和摘要。只保存待应用证明，不成为可查询正式参与事实，不占正式 allocation revision 唯一槽。
2. CorrectionTimeAllocationBinding：在 commit 中绑定 pendingAllocation、物化后的真实 segment revision、正式 allocation revision、D7 manifest 和 request/application。复合同链外键、唯一映射及延迟闭合校验，不靠若干独立 ID 外键证明同链。

ParticipantTimeAllocationRevision 新增明确更正证明分支，旧 committed-only 与 sealed-draft 两分支原校验保留。更正分支必须绑定同一已批准请求/application、精确 replacement version、真实段和 pending payload。不得传 boolean 绕过，也不得暂时禁用旧触发器。新 SQL 通过追加 migration 覆盖必要函数；前123条 SQL 均保持校验和，不自动分配尚未核验的第124条摘要。

prepare 阶段以暂存证明计算四类桶与完整 credit，但不能发布为正式来源；commit 物化真实段和 allocation 后逐项核验与准备摘要一致，再关闭 manifest 的来源证明。原 D7 rootEntry 保留用于冲回定位，新增来源绑定解释本轮计算；旧根桶 calculatedSeconds 不被改写，读取必须区分“根账来源”与“本轮来源”。零桶、未知计算值与 BigInt 合计沿既有规则。

### 3.3 同事务顺序与重放

继续 Activity → Run → Request → Application → Version/Batch → 既有 member/day 锁序；不得在持有子锁后反向取得父锁。附件锁、来源锁的精确相对顺序须在第10.7节冻结。

prepare：当前资格 → 锁后复判 → 校验精确 base/hash → 生成替代版、段暂存及分配暂存 → 集合计算/认定核验 → 旧贡献和新分类冲补 → 完整性通过才 ready。
commit：当前资格及重放资格 → 父锁后重读 → 核验未漂移 → 集合物化新段和新 allocation → 核验绑定/准备摘要 → 同批次冲回与补记 → receipt、application/request、生效版本与关账指针、最后审计同事务提交。

准备失败不占用正式源版本；并发只有一个 base 的 receipt 能生效；不因重放绕过当前用户停用、权限撤销或组织失效。普通 worker/公共提交继续拒绝绕过 application 的更正。任何最后一步失败，全部正式效果回滚；已成功重放不重复记账或审计。

## 4. Human API 与权限候选

只新增 App Human 面，不开放 Integration/Service Token、Admin 旁路或 AI 自动审核。候选前缀：
`/api/app/v1/my/managed-activities/:activityId/time-corrections`。

| 方法/后缀                 | 用途                  | 推荐资格（待批准）                                                                                |
| ------------------------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| POST /                    | 提交冻结 v2/v3 申请   | 当前 App 准入 + 活动负责人 + 显式 prepare、settlement-submit；v3 再要求 time-allocation.recognize |
| GET / 与 GET /:requestId  | 列表及完整差异详情    | 当前 App/read 与精确 base 版本资格；原因/证据详情另核申请或审核资格，列表不返回全文               |
| POST /:requestId/review   | approve/return/reject | 当前 App 准入、显式 GLOBAL settlement-final-review + 目标活动/版本资格；提交人不得自审            |
| POST /:requestId/resubmit | 退回后重新提交        | 原提交人仍满足当前提交资格；旧请求正文/审核永久留存，新请求显式关联旧请求                         |
| POST /:requestId/prepare  | 准备冻结已批准请求    | 当前 App 准入、显式 GLOBAL 终审与精确目标资格；操作者沿 application 绑定                          |
| POST /:requestId/commit   | 应用准备结果          | 与 prepare 相同且绑定实际 application actor；所有重放仍复判                                       |

当前 returned→新申请的状态转换/关联字段尚未冻结，不以改写旧 requestedChangeJson 消灭审核历史。需核验现有七状态允许的转移与开放唯一索引，另在新 migration 中精确实现；不能口头声称已有功能。

服务端计算操作域、actor、activity、base、业务输入组成的 hash；operationKey 必须沿已有格式限制且不同内容冲突。不开放“一键 apply”HTTP 端点；prepare/commit 分离，页面先展示审核内容及状态，任务成功后再刷新。分页 page/pageSize≤100，稳定排序，BigInt 以十进制字符串返回，不返回完整 signed URL 或人员敏感字段。

不新增默认角色授予；优先复用现有码，但访问说明仍必须重签4b。错误按既有 correction/time-allocation 具名 BizCode 逐条登记，不用通用500吞掉SQL错误；新增码须在最终路径预算中明确，不在本稿编造空闲号段。

## 5. 实施顺序与验收探针

本轮只写文档，下表不是已执行记录。

| 顺序 | 交付             | 必须通过的探针                                                                                                                  |
| ---- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| P0   | 固化历史行为     | v1/v2、D3/D4/D6、服务段115迁移及更正审核回归；记录未改生产前结果                                                                |
| P1   | 来源证明与迁移   | 冷库+123→新版本非空升级；跨链、伪造来源、缺整份证明、半提交、UPDATE/DELETE/TRUNCATE拒绝；全部旧migration checksum不变           |
| P2   | 纯函数和集合计算 | 时间延长/缩短/作废、四类转移、零桶、重叠拒绝、政策不允许手工、证据缺失、未知不变零、空更正拒绝                                  |
| P3   | prepare/commit   | 原账→v2→v3→v2连续更正；两个请求争base、两actor重放、最后审计抛错全回滚、版本漂移、附件失效、权限等待后撤销                      |
| P4   | Human闭环        | HTTP提交→详情差异→他人审核→准备→提交→精确版本查询；自审、跨活动、停用、无App成员、只有GLOBAL码无目标资格均拒绝；退回→重提可继续 |
| P5   | 满额与兼容       | 1/100/2000身份，实际变更段而非空segments；三轮连续更正；所有旧断言保留；独立worker启动及旁路拒绝                                |
| P6   | 交接与收口       | 逐行contract diff、生成物、权限说明、SQL/权限重签；本地定向后Draft PR全量CI冷跑；合并/Gate仍独立授权                            |

保留现有业务事务限制，不以提高超时解决逐段查询。D7-1新增查询预算24/24及GET40不能冒称v3整链预算；v3应单独给出按步骤查询账单和最大段/分片数量后冻结，仍禁止按身份或段线性查库。容量测试总时限与业务事务时限分开说明。

## 6. 精确路径候选与禁止域

当前仅四份Markdown：本稿、D7总计划、NEXT_TASKS、FROZEN_DRAFTS。静态needs为0红区；未提交、未推送、未建PR。#1324写集独立，按lane检查通过，未改其内容或状态。

未来候选核心路径逐项列出（新文件明确标注）；这些路径仅供评审，不是完整已批准写集：

1. `src/modules/activities/correction-application.service.ts`
2. `src/modules/activities/correction-change-set.ts`
3. `src/modules/activities/correction-change-set.spec.ts`
4. `src/modules/activities/correction-review-separation.ts`
5. `src/modules/activities/correction-audit-recorder.ts`
6. `src/modules/activities/participation-time-correction.service.ts`
7. `src/modules/activities/participation-time-correction.service.spec.ts`
8. `src/modules/activities/participation-time-correction-policy.ts`
9. `src/modules/activities/participation-time-correction-policy.spec.ts`
10. `src/modules/activities/participation-time-correction-query.service.ts`
11. `src/modules/activities/participation-time-correction-query.service.spec.ts`
12. `src/modules/activities/activity-time-allocation.service.ts`
13. `src/modules/activities/activity-time-allocation.service.spec.ts`
14. `src/modules/activities/activity-time-allocation-command.ts`
15. `src/modules/activities/activity-time-allocation-command.spec.ts`
16. `src/modules/activities/activity-time-allocation-policy.ts`
17. `src/modules/activities/activity-time-allocation-policy.spec.ts`
18. `src/modules/activities/ledger-posting.service.ts`
19. `src/modules/activities/participation-time-ledger.service.ts`
20. `src/modules/activities/participation-time-ledger-access.service.ts`
21. `src/modules/activities/participation-time-ledger-access.service.spec.ts`
22. `src/modules/activities/activities.module.ts`
23. `src/modules/activities/activity-batch-worker.module.ts`
24. `prisma/schema.prisma`
25. `prisma/CLAUDE.md`
26. `src/modules/permissions/permission-catalog.ts`
27. `test/e2e/activity-settlement-correction.e2e-spec.ts`
28. `test/e2e/activity-service-segment-correction-pending-migration.e2e-spec.ts`
29. `test/e2e/activity-os-r4-d7-time-correction.e2e-spec.ts`
30. `test/e2e/activity-os-r4-d7-time-correction-migration.e2e-spec.ts`
31. `test/e2e/activity-os-r4-d7-time-correction-concurrency.e2e-spec.ts`
32. `test/setup/time-ledger-fixture-cleanup.ts`
33. `test/contract/openapi.contract-spec.ts`
34. `test/contract/__snapshots__/openapi.contract-spec.ts.snap`
35. `src/modules/activities/activity-time-correction-access.service.ts`（新增）
36. `src/modules/activities/activity-time-correction-access.service.spec.ts`（新增）
37. `src/modules/activities/activity-time-correction-command.service.ts`（新增）
38. `src/modules/activities/activity-time-correction-command.service.spec.ts`（新增）
39. `src/modules/activities/activity-time-correction-query.service.ts`（新增）
40. `src/modules/activities/activity-time-correction-query.service.spec.ts`（新增）
41. `src/modules/activities/activity-time-correction.presenter.ts`（新增）
42. `src/modules/activities/activity-time-correction.presenter.spec.ts`（新增）
43. `src/modules/activities/correction-time-allocation.service.ts`（新增）
44. `src/modules/activities/correction-time-allocation.service.spec.ts`（新增）
45. `src/modules/activities/controllers/app-managed-activity-time-correction.controller.ts`（新增）
46. `src/modules/activities/dto/app/app-activity-time-correction.dto.ts`（新增）
47. `test/e2e/activity-os-r4-d7-2-fact-correction.e2e-spec.ts`（新增）
48. `test/e2e/activity-os-r4-d7-2-fact-correction-migration.e2e-spec.ts`（新增）
49. `test/e2e/activity-os-r4-d7-2-fact-correction-concurrency.e2e-spec.ts`（新增）

以上49个核心候选已查存在性，34个既有、15个新增。最终写集还必须逐个列明新migration、所有派生客户端/地图/权限/状态登记、旧迁移计数适配与changelog；不得用目录通配符代替。现阶段不把49称作完整实施路径数。

## 7. 授权清单（一次集中确认方向）

| 项                   | 推荐                                                                | 当前状态                       |
| -------------------- | ------------------------------------------------------------------- | ------------------------------ |
| 范围                 | A：既有身份/segmentKey与冻结政策；遗漏人员/新段继续明确保留后续范围 | 待维护者选择，整个D7不提前完成 |
| Human资格            | 第4节复用显式权限，App准入+目标资格+自审禁止；零默认角色授予        | 待确认                         |
| 退回重提             | 旧正文和审核永久保留，新增关联请求；不覆盖旧申请                    | 待确认方向，状态机/FK还需闭合  |
| 数据留存             | 全部业务原账、暂存和失败证明永久保留，不建删除任务                  | 沿已确认决定，不重复索要       |
| 执行授权             | 最终精确写集+红区逐文件needs+维护者worktree令牌                     | 未申请；本稿不能当实施命令     |
| 验证                 | 建议仅app_test_w98隔离验证，禁止改断言/抬业务超时；全量由PR CI冷跑  | 将来实施单独授权，本轮不连库   |
| 提交/推送/PR         | 四份文档验证后如需交付PR，另确认changelog与提交推送                 | 本轮未获授权                   |
| Ready/合并/生产/Gate | 均独立                                                              | 未授权                         |

## 8. 精确计划下发前尚须闭合

本稿是代码核验后的评审及精确计划草案，不是可无人值守执行的终稿。方向选择之后在同一稿补齐，不把下列问题留给实现者自行决定：

1. 两新模型全部字段类型、复合unique/FK、来源与receipt的集合完整性、真实allocation更正分支的具名SQL函数/触发器以及失败恢复；确定追加migration准确目录。pending→真实段/分配→D7 manifest证明必须有正反例，不能仅靠JSON摘要。
2. returned旧请求终态和新请求关联、开放请求唯一索引以及审核历史不可变方案。核验现有状态机转移，若需新增边须作为本稿明确审批项，不偷改历史返回行为。
3. 新Human权限的精确主体/目标/重放矩阵、DTO字段闭集与限制、operation/hash域及错误码表，逐项对齐既有属主接口；不得允许仅凭角色或客户端传actor通行。
4. 每步SQL查询账单、段数/分片数/请求大小上限、附件锁序与原5秒提交事务可行性；真实非零段满额测试，不能复用D7-1空段证据。
5. 生成物和全部旧migration测试的完整写集与精确授权命令。所有新增函数引用链、DI两个模块、worker拒绝旁路、旧v2在v3之后的前驱来源解释一并冻结。

## 9. 本次未做

本轮文档验证：lane preflight 通过（#1324 五路径与本轮四路径无交集）；逐文件 harness:needs 为0红区；git diff --check、本文Prettier、docs:codemap:check、docs:rbacmap:check、check-frozen-drafts-ledger.ts、docs:counts:check 均通过。保留CODEMAP既有2项WARN/1项INFO及RBAC动态权限INFO。未跑quick/contract/e2e，本轮没有代码变化；文档检查不代表P0–P6业务验收通过。

未实施D7-2，未创建模型、migration、接口、权限或测试，未操作任何数据库；未提交推送、创建PR、修改#1324、生产/Gate、删除业务数据或执行整体跨模型复审。D7-1间歇性占库仅增加诊断并通过后续CI，不宣称已定位根因。

## 10. 方案 A 最终待审合同（2026-09-15）

维护者已确认方案 A 方向并要求继续补齐本稿，仅文档。本节及第11–13节取代第3–8节的候选/待细化表述；下述新增数据结构、接口边界和预算是**待整包审批的设计**，不是已批准实施或已通过实测。身份、segmentKey、冻结政策均不扩展；遗漏人员、全新段与政策替换明确留在后续 D7 范围。

### 10.1 先纠正两个工程假设

- `CorrectionApplicationService.lockApplication` 返回的 actor 来自当前用户资格复核，不是持久化准备人绑定。新 Human prepare/commit 以 `LedgerPostingBatch.preparedByUserId` 为准备人，commit与重放必须相同；旧内部v1/v2调用不因此改行为。Human包装不能只在事务外查一次，需显式tx编排入口，将资格复判传到所有锁后与重放出口。
- 仅有“两张新表”无法同时保留完整来源快照和暂存附件引用。本版最终设计为**四张新增表**，不是两表方案已实现：暂存分配、暂存证据、来源证明头、正式来源绑定。没有新增业务状态枚举、权限码或审计事件，但新增 returned→voided 重提场景与不可变配置登记，必须列入审批。

### 10.2 最终输入与规模

v3顶层恰为 schemaVersion=3、results、segments、timeCorrection、allocations；unknown key、重复键对象解析歧义、缺失键、非整数秒、超长ID、NaN、浮点秒均拒绝。JSON重复属性的原始文本拒绝若全局解析器无法提供证据，不假称普通JSON.parse已防住；HTTP合同以解析后的键闭集为准，不另改全局JSON语义。

- results与segments沿v1字段，v3数组按identity/segmentKey排序，所有ID非空≤128；results最多2000，segments最多10000且至少一项。每一segment必须在指定base完整来源集中；不创建新身份/segmentKey。
- timeCorrection沿v2闭集，items恰覆盖原D6根账四类完整桶，最多8000。认定秒0..2147483647；总量BigInt。v3更改事实或分类来源，即使最终认定值不变也不是空更正；v2空更正规则不变。
- allocations与segments一一对应，字段为participationIdentityId、segmentKey、baseSegmentRevisionId、baseAllocationRevisionId、recognitionModeCode、manualReason、slices、evidenceAttachmentIds。每项slice≤500，全请求slice≤50000，引用去重附件总数≤2000、每分配≤20。所有限制在事务前和数据库集合守护分别核验。
- automatic模式slices为空、manualReason=null，由服务端重算；manual模式使用D3既有slice闭集与政策检查。有效非零段要求合法分配；零时长或voided/replaced/early_departure_zero段只允许空slice且四类计算为0，不调用要求至少一片的普通D3函数。必须有独立正反例，不能悄悄放宽D3普通输入。
- 原始check-in证据指针不伪造；新时间值仍是经真人审核的更正声明，不能宣称旧打卡证明了新时刻。旧serviceHours与贡献保留独立字段，不从分类秒反推旧小时/贡献。
- 整体人数2000、服务段10000、slice50000、桶8000、桶来源40000沿D4上限。准备、提交使用集合SQL和固定分块，不允许每段Prisma往返。

HTTP满额不能只测内部Service。当前 `main.ts` 使用Nest默认body parser，仓内未发现给本入口配置大JSON。计划在 `apply-global-setup.ts` **仅对本前缀的POST / 与POST /:requestId/resubmit** 安装有界JSON parser（32MiB，禁压缩请求体），并保留其余路由原限制；不关全局parser，不改main.ts、不加全局宽松默认。核验中间件在Nest默认parser之前注册；非目标路由、大于上限和压缩体独立HTTP反例。此为明确列出的bootstrap红区改动，不是默认实现权。

### 10.3 四模型和既有字段的准确合同

以下String均为非空ID≤128（hash除外），DateTime默认now，Json为服务器canonical内容；没有updatedAt/deletedAt字段，四表UPDATE/DELETE/TRUNCATE均拒绝。所有FK使用Restrict，名称≤63字节。

| 模型                                    | 完整业务字段（另有id String、createdAt DateTime）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CorrectionPendingTimeAllocation         | applicationId String、activityId String、participationIdentityId String、segmentKey String、pendingSegmentId String、baseAllocationRevisionId String、targetAllocationRevisionId String、targetSegmentRevisionId String、targetAllocationRevision Int、ruleSnapshotId String、ruleSnapshotHash String、timePolicySelectionRevisionId String、selectionHash String、policyVersionId String、definitionHash String、evaluatorVersion Int、recognitionModeCode String、manualReason String?、allocationJson Json、allocationHash String、sliceCount Int |
| CorrectionPendingTimeAllocationEvidence | pendingAllocationId String、activityId String、attachmentId String、ordinal Int                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| CorrectionTimeSourceProof               | applicationId String、correctionManifestId String、activityId String、settlementRunId String、rootManifestId String、baseSettlementVersionId String、settlementVersionId String、postingBatchId String、sourceSetHash String、calculationHash String、sourceSnapshotJson Json、calculatedBucketsJson Json、expectedSegmentCount Int、expectedPendingCount Int、expectedSliceCount Int、expectedBindingCount Int、formatVersion Int=1                                                                                                                 |
| CorrectionTimeAllocationBinding         | proofId String、activityId String、participationIdentityId String、segmentKey String、allocationRevisionId String、sourceSegmentId String、sourceSegmentRevision Int、pendingAllocationId String?、sourceHash String                                                                                                                                                                                                                                                                                                                                 |

来源snapshot是每个有效segment一项，不是每bucket一项：记录identity、segmentKey、真实/预分配target段ID与revision、allocation ID/hash、冻结政策及选项摘要、该段规范化slice与计算输出。每轮v3完整复制有效来源集合，未变化项来自精确base，不扫描latest；最大10000项。calculatedBucketsJson是全部rootEntryId、nullable calculatedSeconds、四类计算依据摘要的排序集合；unknown保持null，不替换成0。准备时即可预生成target两个ID，只作为String保存，不提前占真实表FK或唯一版本；失败准备永不物化正式段。绑定插入后真实FK才能成立。

既有字段最小增加：

- AttendanceCorrectionRequest.resubmittedFromRequestId String?，自引用，unique，仅一个后继；新增(id,activityId,settlementRunId)复合锚点供自引用，同活动同run。旧行默认null，不改旧请求内容/hash。
- ParticipationTimeCorrectionManifest.sourceProofId String?、sourceProofHash String?；formatVersion允许1或2。format1两字段均null，旧hash域逐字保留；format2两字段必有，新的manifest-v2 hash包含这两字段。v3必format2并指向本application证明头；v2在format2前驱后继续format2、直接继承前驱的证明ID/hash，不递归遍历祖先。v2输入canonical/request hash不变，只对新增且有v3事实前驱的输出选format2；已有任何manifest不重算。
- ParticipantTimeAllocationRevision.correctionPendingAllocationId String?，关联pending allocation。该值与6字段sealed-draft证明互斥；为null时原D3/D4校验逐条不变。非null必须是本application物化的目标段/分配ID、精确revision和冻结政策。allocation command receipt新增operationCode值 `recognize_correction_time_allocation`，不新增权限码。

复合锚点/FK清单（允许仅为这些FK增加被引用侧unique）：

1. pending(applicationId,activityId,pendingSegmentId,identity,segmentKey)→CorrectionPendingSegmentRevision对应复合锚点；pendingSegment的application/request/base同链仍受115校验，不能只单列连上。
2. pending(baseAllocationRevisionId,activityId,identity,segmentKey)→ParticipantTimeAllocationRevision对应锚点；base来源必须是proof.base的来源集合，DB集合校验额外证明，不能只凭同活动。
3. pending(policyVersionId,definitionHash)→TimePolicyVersion对应锚点；selection(activityId,id)、snapshot(activityId,id)均复合；政策、selection及源分配的一致性由插入守护核验。
4. evidence(pendingAllocationId,activityId)→pending(id,activityId)，attachmentId→Attachment.id；unique(pendingAllocationId,attachmentId)和(pendingAllocationId,ordinal)。
5. proof(applicationId,postingBatchId,settlementVersionId)→CorrectionApplication(id,newPostingBatchId,newSettlementVersionId)；proof(correctionManifestId,postingBatchId,activityId,settlementRunId,baseSettlementVersionId,settlementVersionId)→D7 manifest原receipt_anchor。root(activity,run)沿原D6锚点。
6. manifest(sourceProofId,rootManifestId,activityId,settlementRunId,sourceProofHash)→proof(id,rootManifestId,activityId,settlementRunId,sourceSetHash)，DEFERRABLE INITIALLY DEFERRED解决本application互相引用；Prisma不表达的延迟属性由migration测试固定。
7. binding(proofId,activityId)→proof，(allocationId,sourceSegmentId,sourceSegmentRevision,activityId)→现有ptar_id_source_revision_activity_key；(sourceSegmentId,identity)→真实段锚点；pending可空但非空时须与同proof.application且target IDs一致。
8. pending unique(applicationId,identity,segmentKey)、unique(targetAllocationRevisionId)、unique(targetSegmentRevisionId)；proof unique(applicationId)、unique(correctionManifestId)；binding unique(proofId,identity,segmentKey)。仅同申请准备重放复用；不以baseAllocation全局unique阻止失败后恢复。

源证明头在prepare插入；bindings只在commit真实段/分配建立后插入。新增四表不引业务清理函数。暂存证据会长期引用附件：精确扩展attachments删除前的既有不可变证据引用检查，包含pending evidence；否则只靠FK会晚于外部存储删除。失败/作废的证据也保留。HTTP尚未prepare的请求只保存附件ID声明，详情必须标“未冻结证据”，不能声称文件已受永久引用保护；prepare时丢失则拒绝，不能悄悄去掉引用。

### 10.4 数据库函数与可见性

新migration固定候选 `20260915180000_activity_os_r4_d7_2_fact_correction/migration.sql`（D7-1 SQL修复前置追加124后，未来排序预期125；实施前重新核验，不创建文件，不预签SQL hash）。

- 新增 `cpta_insert_guard`：pending仅application preparing、请求approved/applying，逐项匹配已批准v3 JSON与base来源；预生成ID不碰真实表。
- `cptae_insert_guard`：证据与pending同活动、ordinal完整；附件属主Service复核，加FK禁止已引用内容被硬删。
- `ctsp_insert_guard`：头仅在batch preparing插入，同一完整来源快照/计数；来源替换集合必须恰为请求变化段。不可缺一整个未变segment，不能只查总条数。
- `ptar_assert_correction_proof`：分配仅在batch ready、application preparing、request applying且已存在目标真实段时写入；保持原D3/D4两分支全部判断，三分支互斥。零段例外仅本证明分支，receipt仍闭合。
- `ctab_insert_guard`：真实分配及源hash与proof snapshot精确一致；仅batch ready接受，未变项必须来自base来源，变更项恰对应pending，禁止ready之后旁插。
- `ctsp_assert_complete(batch_id, require_bindings)`：prepare ready前校验头/暂存/完整bucket计算集合；receipt插入、batch committed以及事务末尾必须校验全部binding和真实来源，不能拿prepare校验替代commit。
- 追加migration仅CREATE OR REPLACE第121条 `ptar_parent_anchor_guard/ptar_receipt_guard` 和第123条 `ptcm_guard_insert/ptc_assert_complete/ptc_guard_commit_closure` 的明确分支；旧v2仍要求segments空。缺整个manifest/proof以请求schemaVersion=3触发required检查，不能仅“有行才验”。原ptc_guard_visibility/ptcr_guard_insert调用完整性入口时也覆盖v3。
- 四表各具名immutable/no_truncate；延迟闭合挂proof、binding、batch/receipt实际插入或状态变化，事务终态必须application committed、request applied、batch committed、receipt齐全，否则回滚。prepared证明允许无bindings；ready receipt不允许单独提交。
- CHECK/unique/FK名称使用cpta/cptae/ctsp/ctab前缀，SQL错误只映射明确集合；未知SQLSTATE、连接、deadlock不得吞成业务成功。

旧SQL文件0修改；新列全nullable、四新表空，不回填旧业务，不DROP旧列/表。先完成独立D7-1 SQL修复，再冻结前124条checksum清单，冷回放125与有值124→125分别验证；旧历史阶段计数保持原值，只有“当前全量”124→125。前文123基线为评审初稿历史，不代表修复后的实施基线。

### 10.5 退回重提与幂等

resubmit只接受原请求returned、原提交人仍有当前App提交资格。锁Activity→Run→旧Request后检查幂等，再进行以下同事务：核验原base仍是当前posted → 原请求returned→voided（只变状态/version，不覆盖reviewNote/正文）→新建pending请求并指向resubmittedFromRequestId → run仍correction_open →记录correction-resubmit审计。新记录需要他人重新审核。新建或最后审计失败则旧请求仍returned；唯一后继阻止两个重提同时生效。基线已漂移时只允许原有明确voided结果并要求普通submit以新base创建，不伪装重提成功。

新resubmit不调用普通submit的“run必须posted”前置来绕过correction_open，也不放宽普通submit；抽取tx内共享建请求函数。状态集合仍七值，登记新增场景与单测，不将inventory伪标governed。hash域 `attendance-correction-resubmit-v1` 包含actor/activity/旧request/operationKey/新完整输入；沿既有request.operationKey撞键检查，同key不同内容20111。新请求独立operationKey；旧key不重用、不删除。

HTTP submit hash域 `attendance-correction-human-submit-v1`，v3业务正文canonical域 `attendance-correction-request-v3`；prepare/commit都使用服务端冻结requestHash加requestId/base ID构造操作域，不信任客户端hash。review使用requestId、expectedRequestVersion、action、note构成完整动作；重放只在已存审核人与动作/note相同时返回，同时复核当前资格。prepare/commit客户端必须带expectedBaseVersionId；prepare返回applicationId/batchId/冻结hash；commit要求这些标识精确一致。失权后的重放拒绝，不更改已提交事实。

### 10.6 访问矩阵和返回合同

第4节7个HTTP端点固定，不增加一键apply。所有路径参数DTO、App DTO独立定义；不用Admin派生。GET列表只走当前活动/read资格，不以最近版本替代每条request的base资格；每页统一批量判读且不做逐条DB授权，total按可见集合计数。详情必须确认URL activity与request相同。

- submit/resubmit：当前App准入，显式activity.time-settlement.prepare与activity.settlement-submit.record，活动负责人；v3再要求activity.time-allocation.recognize，均为同活动显式scope。只拥有GLOBAL终审码不获得这些资格。
- review：当前App准入，GLOBAL activity.settlement-final-review.record，精确base版本现有终审目标资格，申请人≠审核人。无须再要求负责人，不能把两个岗位强行合一。
- prepare/commit：当前App准入，GLOBAL终审及精确base版本资格；prepare的操作者绑定到batch.preparedByUserId，commit含重放须一致。已审批人和执行人可不同，但执行人每次都具上述资格；无静默代签。
- read：沿activity.time-settlement.read及指定base版本负责人/现任审核资格；完整原因/附件ID只给当前合格申请人或上述审核者。其他可见人仅摘要，永不输出完整signed URL或L3。
- 所有权限检查使用既有tx属主接口，初查、任何实际锁等待后、进入写/重放出口前重读。无role短路、跨请求缓存；旧内部调用仍保持原入口规则，新Human tx入口必须显式接入，禁止可由HTTP传入的“trusted=true”。

返回：submit/resubmit返回requestId、baseVersionId、statusCode、requestVersion、replayed；review返回reviewed/voided判别及状态；prepare返回applicationId、postingBatchId、settlementVersionId、requestHash、sourceProofHash、replayed；commit沿既有结果及上述确定ID。详情返回冻结输入的新旧差异与完整proof hash、审核记录、后继请求ID；较大来源分页，单页≤100，不把50000slice全塞单次列表响应。现有correction-ledger DTO保持原字段；本入口详情提供本轮来源，D8不切换。

错误复用：20099/20100基础状态，20101开放请求冲突，20102输入不合法，20103审核/重提状态不合法，20104自审，20105基线漂移，20106应用状态，20107–20110旧冲补不变，20111幂等冲突；20225规模，20226来源，20227内容冲突，20228完整性，20229不支持形态，20230读取不可见；资格错误沿现有UNAUTHORIZED/FORBIDDEN/RBAC_FORBIDDEN。HTTP请求体超限为413，不能改成500；具体已有message/status不改。零新BizCode、零新权限码、零新AuditLogEvent；访问目录说明、状态场景仍有变更，4b不能免签。

### 10.7 锁序、性能与审计

顺序：Activity→Run→Request→Application→Version/Batch→去重排序附件FOR SHARE（既有owner facade）→段/分配来源→既有串行闸/member/day。附件facade实际只锁Attachment并核存储状态，不虚称持有StorageObject锁；不在调用前先取StorageObject锁。SQL触发器不能反向抢父锁。批量查附件后锁后复核当前资格；新增证据引用与附件删除意图检查用同一个Attachment锁互斥。

定向验收预算建议作为整包审批项：submit/resubmit业务查询≤100，review≤60，prepare≤240，commit≤240，列表≤40、详情≤50；其中当前资格复核分别预留30/24/40/50/20/24，来源批量校验分别预留30/12/60/60/10/16，其余用于写/审计及原贡献链。按每次Prisma/$queryRaw实际SQL计数，transaction begin/commit另列、不混入；事务预算按源码更正为prepare 120000ms、commit 7000ms（单次member锁等待4000ms+工作预算3000ms），均保持既有值、不提高。固定分块每块最多1000源、5000slice；总查询不随人数逐条增长，10000段与50000slice压力单独覆盖。预算是待验收上限，不是已测性能保证；超限先同写集集合优化，仍失败上报，不放宽断言。

暂存证据批量插入、正式段/分配/receipt/slice/binding均集合写；不得复用现有逐段preparePendingSegments/materializePendingSegments循环宣称性能已解决。单测保留旧v1/v2行为；v3集合实现与旧结果逐项characterization对拍。满额HTTP 32MiB边界、1/100/2000身份×真实变化段、三轮连续更正、10000段/50000slice都要实际通过，整体测试时间可600秒；prepare/commit仍按上述120秒/7秒原值。

审计复用activity.publish及既有correction-\*操作，增加correction-resubmit操作值；只记ID/hash/计数/状态，原因和整份输入不入审计。v3 prepare/commit可补sourceProofHash；相同任务重放不再写，不同请求即使内容相同仍各自留审计。失败准备、暂存证据、旧请求与已生效记录永久保留；不提供删除入口。

## 11. 完整精确写集（124个去重路径）

本节取代第6节49核心候选；124指文件数，不是已经存在第124条migration。本轮存在性核验：107路径已存在（含本轮未跟踪计划），17个未来文件尚未创建；其中迁移目录未占用。实施前仍须核验main基线。以下不是“所有文件必须改”，是可触及上限，实际diff必须逐文件说明必要性。

用途约束：业务文件只接本合同；既有E2E只允许当前迁移计数/清理前置/本稿具名行为覆盖，原历史断言保留，main新发现失败不在此夹带修复。治理文件只登记本次模型/字段/新方法/权限说明与准确生成摘要，不改裁判判定规则；bootstrap只做第10.2节两入口解析；附件只做暂存证据的删除前保护；clock测试只登记新增createdAt，不改断言；客户端为生成产物，非手工改写。

1. `src/modules/activities/correction-application.service.ts`
2. `src/modules/activities/correction-change-set.ts`
3. `src/modules/activities/correction-change-set.spec.ts`
4. `src/modules/activities/correction-review-separation.ts`
5. `src/modules/activities/correction-audit-recorder.ts`
6. `src/modules/activities/participation-time-correction.service.ts`
7. `src/modules/activities/participation-time-correction.service.spec.ts`
8. `src/modules/activities/participation-time-correction-policy.ts`
9. `src/modules/activities/participation-time-correction-policy.spec.ts`
10. `src/modules/activities/participation-time-correction-query.service.ts`
11. `src/modules/activities/participation-time-correction-query.service.spec.ts`
12. `src/modules/activities/activity-time-allocation.service.ts`
13. `src/modules/activities/activity-time-allocation.service.spec.ts`
14. `src/modules/activities/activity-time-allocation-command.ts`
15. `src/modules/activities/activity-time-allocation-command.spec.ts`
16. `src/modules/activities/activity-time-allocation-policy.ts`
17. `src/modules/activities/activity-time-allocation-policy.spec.ts`
18. `src/modules/activities/ledger-posting.service.ts`
19. `src/modules/activities/participation-time-ledger.service.ts`
20. `src/modules/activities/participation-time-ledger-access.service.ts`
21. `src/modules/activities/participation-time-ledger-access.service.spec.ts`
22. `src/modules/activities/activities.module.ts`
23. `src/modules/activities/activity-batch-worker.module.ts`
24. `prisma/schema.prisma`
25. `prisma/CLAUDE.md`
26. `src/modules/permissions/permission-catalog.ts`
27. `test/e2e/activity-settlement-correction.e2e-spec.ts`
28. `test/e2e/activity-service-segment-correction-pending-migration.e2e-spec.ts`
29. `test/e2e/activity-os-r4-d7-time-correction.e2e-spec.ts`
30. `test/e2e/activity-os-r4-d7-time-correction-migration.e2e-spec.ts`
31. `test/e2e/activity-os-r4-d7-time-correction-concurrency.e2e-spec.ts`
32. `test/setup/time-ledger-fixture-cleanup.ts`
33. `test/contract/openapi.contract-spec.ts`
34. `test/contract/__snapshots__/openapi.contract-spec.ts.snap`
35. `src/modules/activities/activity-time-correction-access.service.ts`
36. `src/modules/activities/activity-time-correction-access.service.spec.ts`
37. `src/modules/activities/activity-time-correction-command.service.ts`
38. `src/modules/activities/activity-time-correction-command.service.spec.ts`
39. `src/modules/activities/activity-time-correction-query.service.ts`
40. `src/modules/activities/activity-time-correction-query.service.spec.ts`
41. `src/modules/activities/activity-time-correction.presenter.ts`
42. `src/modules/activities/activity-time-correction.presenter.spec.ts`
43. `src/modules/activities/correction-time-allocation.service.ts`
44. `src/modules/activities/correction-time-allocation.service.spec.ts`
45. `src/modules/activities/controllers/app-managed-activity-time-correction.controller.ts`
46. `src/modules/activities/dto/app/app-activity-time-correction.dto.ts`
47. `test/e2e/activity-os-r4-d7-2-fact-correction.e2e-spec.ts`
48. `test/e2e/activity-os-r4-d7-2-fact-correction-migration.e2e-spec.ts`
49. `test/e2e/activity-os-r4-d7-2-fact-correction-concurrency.e2e-spec.ts`
50. `src/modules/activities/correction-posting-shape.ts`
51. `src/modules/activities/correction-posting-shape.spec.ts`
52. `src/modules/activities/participation-time-ledger.service.spec.ts`
53. `src/modules/activities/controllers/app-managed-activity-time-settlement.controller.ts`
54. `src/modules/activities/dto/app/app-activity-time-settlement.dto.ts`
55. `test/e2e/activity-os-r4-d6-time-ledger.e2e-spec.ts`
56. `test/e2e/activity-os-r4-d6-time-ledger-migration.e2e-spec.ts`
57. `test/setup/reset-db.ts`
58. `test/e2e/activity-os-r4-d6-time-ledger-fixture-cleanup.e2e-spec.ts`
59. `CODEMAP.md`
60. `docs/current-state.md`
61. `harness/domain-map.json`
62. `harness/state-machines.json`
63. `docs/ai-harness/STATE_MACHINE_INVENTORY.md`
64. `docs/ai-harness/ROUTE_AUTHZ.md`
65. `harness/permission-surface-baseline.json`
66. `docs/ai-harness/RBAC_MAP.md`
67. `docs/ai-harness/CUTOVER_SIGNOFF.md`
68. `scripts/check-boundaries.ts`
69. `scripts/harness-guards.selftest.ts`
70. `docs/handoff/openapi.json`
71. `docs/handoff/admin-web.md`
72. `docs/handoff/miniapp.md`
73. `docs/handoff/clients/admin/client.ts`
74. `docs/handoff/clients/admin/types.ts`
75. `docs/handoff/clients/app/client.ts`
76. `docs/handoff/clients/app/types.ts`
77. `docs/handoff/clients/auth/client.ts`
78. `docs/handoff/clients/auth/types.ts`
79. `docs/handoff/clients/integration/client.ts`
80. `docs/handoff/clients/integration/types.ts`
81. `docs/handoff/clients/open/client.ts`
82. `docs/handoff/clients/open/types.ts`
83. `docs/handoff/clients/shared/types.ts`
84. `docs/handoff/clients/system/client.ts`
85. `docs/handoff/clients/system/types.ts`
86. `docs/ops/activity-time-ledger.md`
87. `docs/plans/activity-os-r4-d7-time-ledger-correction-review-and-plan.md`
88. `docs/ai-harness/NEXT_TASKS.md`
89. `docs/ai-harness/FROZEN_DRAFTS.md`
90. `test/e2e/activity-v11-batch4-allocation-mode-migration.e2e-spec.ts`
91. `test/e2e/activity-v11-batch4-allocation-candidate-position-anchor-migration.e2e-spec.ts`
92. `test/e2e/activity-v11-batch4-allocation-command-replay-migration.e2e-spec.ts`
93. `test/e2e/activity-v11-batch4-allocation-determinism-migration.e2e-spec.ts`
94. `test/e2e/activity-os-r3-c1-d2a-metric-command-receipt-migration.e2e-spec.ts`
95. `test/e2e/activity-os-r1-a4-explicit-template-version-pointer.e2e-spec.ts`
96. `test/e2e/activity-os-r4-d1-1-time-policy-migration.e2e-spec.ts`
97. `test/e2e/activity-os-r2-b2-coordinate-projection-schema-constraints.e2e-spec.ts`
98. `test/e2e/activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts`
99. `test/e2e/insurance-evidence-registration-revision-migration.e2e-spec.ts`
100. `test/e2e/activity-os-r2-b3-form-blueprint-governance.e2e-spec.ts`
101. `test/e2e/activity-v11-batch4-qualification-contract-migration.e2e-spec.ts`
102. `test/e2e/activity-os-r3-c1-metric-definition-set.e2e-spec.ts`
103. `test/e2e/activity-os-r2-b1-place-schema-constraints.e2e-spec.ts`
104. `test/e2e/activity-os-r2-b6-creation-data-foundation.e2e-spec.ts`
105. `test/e2e/activity-os-r1-a3-template-definition-lifecycle-guards.e2e-spec.ts`
106. `test/e2e/activity-os-r4-d3-time-allocation-revision-migration.e2e-spec.ts`
107. `test/e2e/activity-os-r4-d4-time-bucket-migration.e2e-spec.ts`
108. `test/e2e/activity-os-r4-d1-3-selection-migration.e2e-spec.ts`
109. `test/e2e/activity-os-r3-c2-outcome-value-revision.e2e-spec.ts`
110. `test/e2e/activity-os-r4-d1-1-time-policy-foundation.e2e-spec.ts`
111. `src/modules/activities/ledger-ready-batch-committer.service.ts`
112. `src/modules/activities/ledger-ready-batch-committer.service.spec.ts`
113. `prisma/migrations/20260915180000_activity_os_r4_d7_2_fact_correction/migration.sql`
114. `src/bootstrap/apply-global-setup.ts`
115. `src/bootstrap/apply-global-setup.spec.ts`
116. `src/modules/attachments/attachment-storage-orchestrator.ts`
117. `src/modules/attachments/attachment-storage-orchestrator.spec.ts`
118. `src/common/datetime/clock-authority.spec.ts`
119. `docs/plans/activity-os-r4-d7-2-fact-correction-review-and-plan.md`
120. `changelog.d/activity-os-r4-d7-2-fact-correction.md`
121. `test/e2e/activity-service-segment-correction-lifecycle.e2e-spec.ts`
122. `test/e2e/activity-service-segment-correction-conflict.e2e-spec.ts`
123. `test/e2e/activity-service-segment-correction-concurrency.e2e-spec.ts`
124. `src/modules/activities/CLAUDE.md`

旧测试适配细则：D7-1 SQL修复后，CURRENT_MIGRATION_COUNT=124及当前全回放length/title更新为125；D7-1历史122→123测试仍停在123、保留原校验，不让“恢复到current”污染历史目标。D3/D4/D6固定索引119/120/121、D7-1固定122不动。清理时显式纳入新四表的合法测试夹具，按现有具名测试触发器处理，不删除原断言、不改全局超时。115旧schema空壳仅补新查询实际需要的列与CHECK(false)，不能让旧库提前拥有125功能。此写集不包含主库重建、生产SQL或业务清理。

## 12. 授权与最终验收包

本节以下“仅文档/未来实施”是 #1335 计划阶段的历史时点。维护者随后已确认方案 A 的完整实施，授权按本稿第10–13节及124个精确路径在隔离工作树推进，并只允许 `app_test_w98` 做本地数据库验证；不授权合并、生产操作、Gate 或删除业务数据。当前工作树已核验原15条精确红区令牌；第125条 migration 仍须实际SQL摘要的3b重签后才可运行迁移、数据库E2E或contract。

静态 `harness:needs` 的124路径预算为15红区、109非红区。聚合输出的 `prisma/**` / `src/bootstrap/**` 不能替代精确令牌；以下命令是本实施工作树的逐条授权记录，AI不运行grant：

```bash
cd /Users/dengwang/Documents/coding/srvf-nest-api-r4-d7-2-implementation
pnpm harness:grant 'prisma/schema.prisma' --reason "维护者确认 D7-2 最终计划第10–13节；仅该精确路径"
pnpm harness:grant 'prisma/migrations/20260915180000_activity_os_r4_d7_2_fact_correction/migration.sql' --reason "维护者确认 D7-2 最终计划第10–13节；仅该精确路径"
pnpm harness:grant 'src/modules/permissions/permission-catalog.ts' --reason "维护者确认 D7-2 最终计划第10–13节；仅该精确路径"
pnpm harness:grant 'harness/domain-map.json' --reason "维护者确认 D7-2 最终计划第10–13节；仅该精确路径"
pnpm harness:grant 'harness/permission-surface-baseline.json' --reason "维护者确认 D7-2 最终计划第10–13节；仅该精确路径"
pnpm harness:grant 'harness/state-machines.json' --reason "维护者确认 D7-2 最终计划第10–13节；仅该精确路径"
pnpm harness:grant 'scripts/check-boundaries.ts' --reason "维护者确认 D7-2 最终计划第10–13节；仅该精确路径"
pnpm harness:grant 'scripts/harness-guards.selftest.ts' --reason "维护者确认 D7-2 最终计划第10–13节；仅该精确路径"
pnpm harness:grant 'test/contract/openapi.contract-spec.ts' --reason "维护者确认 D7-2 最终计划第10–13节；仅该精确路径"
pnpm harness:grant 'test/contract/__snapshots__/openapi.contract-spec.ts.snap' --reason "维护者确认 D7-2 最终计划第10–13节；仅该精确路径"
pnpm harness:grant 'test/setup/reset-db.ts' --reason "维护者确认 D7-2 最终计划第10–13节；仅该精确路径"
pnpm harness:grant 'test/setup/time-ledger-fixture-cleanup.ts' --reason "维护者确认 D7-2 最终计划第10–13节；仅该精确路径"
pnpm harness:grant 'docs/ai-harness/ROUTE_AUTHZ.md' --reason "维护者确认 D7-2 最终计划第10–13节；仅该精确路径"
pnpm harness:grant 'src/bootstrap/apply-global-setup.ts' --reason "维护者确认 D7-2 最终计划第10–13节；仅该精确路径"
pnpm harness:grant 'src/bootstrap/apply-global-setup.spec.ts' --reason "维护者确认 D7-2 最终计划第10–13节；仅该精确路径"
```

只在实际执行worktree发放，换worktree必须重新核验；AI不运行grant。路由生成器会原子处理 `docs/ai-harness/ROUTE_AUTHZ.md` 与 `harness/authz-assertion-patterns.json`，后者不在原124路径内且当前未获令牌；在维护者显式追加该单一路径授权前，只可运行check，不可运行写入生成器。SQL完成后请求3b（预期125条、实际完整摘要）；权限仍265、Audit169总计/164活跃，但Human访问范围说明已变，必须用实际目录hash重签4b。是否需要其它签字按实际SQL/依赖摘要核查，不提前填通过。

最终DoD：第5节P0–P6逐条证据，加四表互链/整表缺失、附件删除竞态、退回→重提失败回滚、v3→v2直接证明继承、零/作废段、旧hash不变、满额HTTP及非目标路由限制、普通worker与独立模块启动。query预算实测、生成物与contract逐行解释全部完成后才允许创建Draft PR；全量由CI冷跑。禁止降低断言/擅自重试掩盖失败，红区审批绑最终SHA，Ready后新审批仍独立，合并不随implementation自动授权。

## 13. 新基线风险与本轮收尾

> **实施状态（2026-09-16）**：D7-2 已在本隔离工作树按本稿实施；一轮 TypeScript、Human command 定向单元和生成物一致性检查已完成。第125条 migration 尚未3b重签，因此尚未运行 `app_test_w98` 迁移、数据库E2E或contract，尚未创建PR、跑CI、Ready、合并、操作生产或启用Gate。静态架构债棘轮当前报告13条新写入候选；不得通过扩充债务基线掩盖，需先以属主事务原语或维护者明确的架构决定消除。

D7-1 main CI 34955332231已失败。失败用例位于 `test/e2e/activity-os-r4-d7-time-correction.e2e-spec.ts:944` 的2000身份最终审计回滚探针：预期D7 final audit rollback probe，实际在 `ledger-posting.service.ts:364` 的batch.update之前得到P2028，7000ms事务已耗时9989ms。第5组77套/1263项通过、1套/1项失败，其余四组通过。只能证明该次未到预期最后审计故障点，不能判为已修复、必属CI噪声或证明原子性失效；本轮不改代码、不重跑CI、不连测试库。

原稿“prepare/commit均5秒”不符合当前源码，现按 `CORRECTION_PREPARE_TX_TIMEOUT_MS=120000` 与 `MEMBER_TX_TIMEOUT_MS=4000+3000` 更正；不修改代码或抬超时。该main回归须独立诊断/授权处置，作为D7-2实施前基线风险，不能用旧PR绿色覆盖main红色。

最终合同与写集已获实施授权，当前代码和派生文档在隔离工作树收口；通过最终静态、3b后限定的w98验证以及4b后，才可按既有授权提交、推送并创建Draft PR。D7-1回归诊断可独立并行只读推进，修复与数据库复现另授权。生产、Gate、业务数据删除、整体跨模型复审、遗漏身份/新段/政策替换及D8均未做。

本轮核验：第11节独立解析得到124条、124唯一、107存在，未来迁移路径未占用；四份实际改动needs为0红区，未来写集15红区/109非红区。文档地图、权限地图、冻结台账、counts、readtax、Prettier和git diff --check分别退出0；既有WARN/INFO保留。首次干净lane preflight通过；本轮重跑因同四份已授权未提交文档报dirty，未将该退出1写成通过，未修改门禁或清除本轮工作。沿维护者本轮明确继续完善这四份文档的授权保留编辑，不开启新实现任务。未运行quick/contract/e2e，本轮没有代码修改。

路由解析实现注意：使用独立命名包装中间件调用局部JSON parser，不能让Nest按全局jsonParser名称检测误判为已安装默认parser；测试必须证明其它路由仍能解析合法JSON、仍按原上限拒绝超大输入。实际登记位置及顺序由apply-global-setup的HTTP集成测试验证，不凭单测mock宣称生产启动等价。

## 14. #1337 CI 性能修复评审（2026-09-19，仅文档）

### 14.1 已证实的现象与边界

[#1337](https://github.com/BA7IEE/srvf-nest-api/pull/1337) 当前保持 Draft，HEAD 为 `f779191d`。其 [PR CI 35449265173](https://github.com/BA7IEE/srvf-nest-api/actions/runs/35449265173) 已完成，可信扫描与该 SHA 的维护者审批通过；两个失败分片仍不能登记为绿：

| 面                             | 远端事实                                                                                      | `app_test_w98` 隔离诊断                                                                                                 | 可得出的结论                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 结算 prepare 的 2,000 身份配对 | `activity-os-r4-d7-pairing-index-probe` 在 30,000ms 事务预算内得到 P2028，已记录耗时 36,786ms | 干净重建模板后的目标路径通过（整项148.158s，含夹具、submit和回放）；`/prepare` 9.210s，P-Guard三段回滚计划合计632.284ms | 不是断言漂移；P-Guard在暖 w98 中不足以单独解释36.786s，仍须保留30秒预算并定位 prepare 其余工作或 CI 资源差异 |
| Human V3 的 2,000 身份更正提交 | `activity-os-r4-d7-time-correction` 在 7 秒事务预算内 P2028                                   | 相同目标本地通过约 5.8s；账本提交和事务内其它查询占主要时间                                                             | 不是可接受的“偶发绿”；7 秒业务预算不改，必须把事务内重复工作收敛到安全的最小集合                             |
| audit migration 清理           | 当前四项隔离诊断本地通过，耗时主要在 `TRUNCATE`                                               | `truncateActivityRegistrations()` 自己没有测试夹具 30 秒事务配置；`resetDb` 已有同类配置                                | 这是独立的测试夹具敏感性，不能混为业务事务超时或产品性能修复                                                 |
| A2 TemplateFamily 清理         | 当前四项隔离诊断本地通过                                                                      | 该 spec 的 `resetDb` 和局部 `ActivityTemplate` 清理均已有 30 秒测试夹具配置                                             | 没有已证实的独立代码缺陷；本轮禁止为了“凑四项”修改它                                                         |

源代码定位只支持下列方向，不预先宣称根因已经唯一确定：

- `ActivityTimeSettlementService.prepare()` 写入桶后才写 command receipt；D4 的 `astr_receipt_complete_guard` 在 receipt 插入时独立重建来源/桶规范化哈希、来源完整性、分配与规模约束。该守卫不能跳过、不能改为信任应用层 hash，也不能改 30 秒预算。
- `activity-os-r4-d7-pairing-index-probe` 的 2,000 身份路径先调用结算 `/prepare`、`/submit`，随后才进入更正申请/提交。因此 P-Guard 的取证对象精确限定为 `ActivitySettlementTimeCommandReceipt` 的 `astr_receipt_complete_guard`；D7 的 `ptar_receipt_guard`（分配收据）和 `ptc_assert_complete`（更正批次）不在这一次 prepare 红点的修复面，不能借机修改。
- `CorrectionApplicationService.commit()` 的 Human 链必须在等待锁后复核当前资格；`LedgerPostingService.commitBatchWithin()` 又承担更正批次的完整性和账本原子提交。任何收敛都必须保留锁后资格、完整性、member/day 锁序和全事务回滚，不能把先前读取当作最终结论。
- `audit-logs-migrations.e2e-spec.ts` 的局部清理是测试夹具，不是业务写链；若进入实施，测试夹具的 30 秒只覆盖该清理事务，业务 5 秒、7 秒、30 秒预算均保持不变。

**本轮 P-Guard 实测（仅 w98、回滚式 `EXPLAIN (ANALYZE, BUFFERS)`，临时代码已还原）**：在干净第125条 migration 模板克隆的2,000身份夹具上，`astr_receipt_complete_guard` 的 `source_ready` 为42.804ms、`bucket_source` 为405.783ms、`bucket_total` 为183.697ms，合计632.284ms；三段均为 `Shared Read Blocks=0` 的暖缓存读数。`bucket_source` 确有40,000来源行、40,000次桶/分配/服务段索引关联和163,760次切片索引命中，是三段中最重者，但该证据不支持把它单独认定为36.786秒 CI P2028的根因。整项通过耗时148.158秒含夹具生成、submit和回放，不能被误写为 prepare 单事务耗时。

### 14.2 方案 A：三组独立候选包，不互相掩盖

1. **P-Guard：本轮不选实施包。** 已取得回滚式计划证据，当前暖 w98 读数不足以支持“第121条守卫本身就是30秒根因”或猜测性加索引。除非后续同一受控夹具的分段时序或冷态证据证明等价 SQL/索引能缩短真实 prepare 工作量，否则不改 `astr_receipt_complete_guard`、不新增第127条 migration；所有 fail-closed、4类桶、来源/规模上限、不可变 receipt 和约束触发器继续原样保留。
2. **P-Commit：Human V3 更正提交的安全重复读收敛。** 只允许在同一 member-linearized transaction 中收敛已被证明重复、且不承担锁后重新授权意义的查询。最终资格复核、`assertComplete` 的生效侧复核、账本原子提交、审计末步和重放语义均保留；不得缓存跨请求身份或把 prepare 结果直接当 commit 结论。
3. **P-Fixture：审计迁移夹具隔离。** 只给 `truncateActivityRegistrations()` 的 fixture transaction 显式设置 30 秒；保留所有清理安全检查、业务断言和 Jest 用例时限。A2 不在该包内。

未来实际选中的包可在同一 D7-2 CI 修复 PR 串行落地；当前 P-Guard 不在实施包内。不得把 P-Fixture 的超时设置解释为 P-Guard/P-Commit 已修复，也不得用未来 P-Guard 的数据库变更扩大到产品接口、权限、Gate 或业务数据。

### 14.3 风险表与回退条件

| 包                    | 主要风险                                              | 不可变约束                                                                           | 失败时如何处理                                                      |
| --------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| P-Guard（如后续重提） | 错误的 SQL 等价化会漏掉伪造来源、桶合计或规模越界     | 所有现有 guard 分支、异常约束名、不可变性和 30 秒预算                                | 任何反例不一致即不提交 SQL；保留现状并将 `EXPLAIN` 结论写入复审记录 |
| P-Commit              | 误删锁后复核会让停用/撤权用户从等待后的重放或提交逃逸 | Activity→Run→Request→Application→Version/Batch→member/day 锁序；最终资格与完整性复核 | characterization 或并发反例变化即不提交代码；不改业务预算           |
| P-Fixture             | 把测试夹具配置扩大成全局或业务超时                    | 仅一处局部 `TRUNCATE` transaction；全部既有断言                                      | 若不能稳定复现，只保留诊断结论，不改全局 Jest/Prisma 配置           |

### 14.4 候选写集与后续授权清单

本节是**候选**，不是本轮写权限；实施时只选择实际被第14.2节证据支持的包，并逐文件运行 `pnpm harness:needs`。禁止以目录通配符代替精确路径。

| 包              | 候选路径                                                                                                                                                                                                                                                                                                            | 预期授权/签字                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| P-Guard（未选） | 本轮无生产写集。若未来新的分段证据推翻当前结论，才重新提出新建 `prisma/migrations/<第127条目录>/migration.sql`、`prisma/schema.prisma`（仅实际新增索引时）、`src/modules/activities/activity-time-settlement.service.ts`、其spec及两份具名E2E的精确清单                                                             | 重新取得精确红区令牌；若新增 migration，实际 SQL 摘要的3b重签；不新增权限或审计事件则不要求4b |
| P-Commit        | `src/modules/activities/correction-application.service.ts`、`src/modules/activities/ledger-posting.service.ts`、`src/modules/activities/participation-time-correction.service.ts`、`src/modules/activities/participation-time-correction.service.spec.ts`、`test/e2e/activity-os-r4-d7-time-correction.e2e-spec.ts` | 非红区路径仍需独立实施确认；不得新增 schema、权限、接口或 Gate                                |
| P-Fixture       | `test/e2e/audit-logs-migrations.e2e-spec.ts`                                                                                                                                                                                                                                                                        | 测试专用最小写集；不动 `test/setup`、Jest 配置或业务超时                                      |
| 共同登记        | `docs/plans/activity-os-r4-d7-2-fact-correction-review-and-plan.md`、`docs/ai-harness/FROZEN_DRAFTS.md`、`docs/ai-harness/NEXT_TASKS.md`，以及实施后按实际需要的 changelog、migration 摘要/计数生成物                                                                                                               | 生成物只在最终写操作后刷新；不预填通过、PR、Ready 或合并结论                                  |

上述 P-Commit / P-Fixture 六个候选实现路径已逐一运行 `pnpm harness:needs`，静态结果均为非红区；这只说明不需要 `harness:grant`，不替代维护者对实际修复包、验证、提交推送和 Draft PR 的业务确认。

未来实施前必须一次性获得：选中的包、最终精确路径、是否允许 `app_test_w98` 重建与定向验证、是否允许提交/推送更新 #1337、以及若有第127条 migration 的实际 3b 摘要。实施后仍须由 #1337 PR CI 冷跑裁决；Ready、合并、生产、Gate 和业务数据操作继续各自独立授权。

### 14.5 本轮完成与未做

本轮仅补充本节及两份当前台账：既有四项隔离诊断之外，已完成并还原 P-Guard 回滚式计划取证；已记录其分段耗时、修复边界、风险表和候选写集。未修改生产代码、schema、migration、测试断言、任何超时、Gate、CI 配置或数据库；未提交、推送、Ready、合并或操作生产。

### 14.6 当前 #1337 CI 修复授权（2026-09-19）

维护者已确认以下独立、精确的实施包，并允许仅 `app_test_w98` 的定向验证及测试夹具重建、验证后提交推送更新 #1337（保持 Draft）：

1. `test/setup/reset-db.ts` 的全局 `withTimeLedgerFixtureCleanup` transaction 与 `test/e2e/activity-os-r1-a7-series-generation.e2e-spec.ts` 的 `beforeEach` 两段受控 `TRUNCATE` transaction 均设置 Prisma `timeout: 60_000`。它们不是业务事务；`resetDb` 的当前库校验和精确清理 SQL、所有业务超时、断言、生产代码与 Jest 配置保持不变。
2. `src/modules/activities/correction-time-allocation.service.ts` 及其 `.spec.ts`：只把 `CorrectionTimeAllocationBinding` 的专用写批次改为 5,000。allocation／receipt 的 1,000 上限和 child 的 5,000 上限不变；10 个显式字段 × 5,000 行为 50,000 参数，低于 PostgreSQL 65,535 参数上限。单测必须用完整 10,000 来源断言恰好两个 5,000 行批次、零遗漏。
3. 只允许刷新 `CODEMAP.md`、现有 changelog、本评审稿与两个台账顶部当前状态。不得修改 schema、migration、API、DTO、权限、Gate、生产数据；不得 Ready、合并或操作生产。

本包不以超时掩盖 Human 写链：`MEMBER_TX_TIMEOUT_MS=7,000` 保持不变。若上述最小减少写批次的措施在冷跑仍不足，必须另行给出实际 SQL、精确 migration 写集和新的 3b 摘要；禁止盲目重跑、固定等待或放宽断言。

### 14.7 第127条 correction allocation 集合守护（2026-09-20）

第126条将 `CorrectionTimeAllocationBinding` 改为语句级集合守护后，#1337 的 Human V3 2,000 身份链仍在更正 allocation 物化阶段触发 7 秒 `P2028`。本轮只在新建的第127条
`prisma/migrations/20260920090000_activity_os_r4_d7_2_allocation_guard_set/migration.sql` 中，把 correction allocation 从既有 `ptar_parent_anchor_guard` 的逐行分支迁为 AFTER INSERT 的新行集合校验；D3/D4 原触发器主体仍由 `correctionPendingAllocationId IS NULL` 条件路径运行，`ptar_receipt_guard` 继续逐条复核同一 immutable proof。

守卫仍以既有锁序锁定待物化分配、申请、请求、批次、目标段、基础分配和政策版本，并保持 V3、同活动复合锚点、完整形状/来源分支、所有 fail-closed 错误和 7 秒业务预算。CI 首次冷跑仍在该集合守护的重复链读取阶段触发 `P2028` 后，本轮只把五个同一 immutable chain 的拒绝查询收敛为一次语句级集合聚合；四段锁查询以去重 transition-table 输入保留相同锁定集合与顺序，错误仍按 application-not-ready → pending-fact-mismatch → valid-nonempty → zero-source → unsupported-source 的既有优先级逐一抛出。无新表、列、权限、DML、回填、删除、API、DTO、Gate 或生产操作。维护者已按实际 SHA-256 `d76418fb2b837a6ff264c4d061b43e7c0b476d3b71b238480b2ce67a8aeaf51d` 重签第127条 3b；该签字已通过 `migration-total=127` 的机器对拍。

仅使用显式 `SRVF_D7_2_W98=1` 的受控单进程入口，跳过通用 global setup，由测试自身重建并回收本工作树的 `app_test_w98`。当前 SQL 的第127条冷回放、126→127 非空升级与两项守卫/历史校验共4/4通过（25.346秒）；含 FK 合法但目标锚点不匹配的单身份 fail-closed 链通过；2,000 身份 Human V3 完整来源证明链通过（129.67秒）；完整 `activity-os-r4-d7-time-correction` 套件7/7通过（362.357秒）。typecheck、lint、Harness自检与1,072项contract也通过。这只证明上述定向本地结果，不能替代新 SHA 的 PR CI；13份使用其他 scratch worker 的旧迁移测试仍只由 PR CI 冷跑。

本节覆盖 §14.6 中“若仍需 migration”的历史前提，不扩大其余 CI 修复写集。TypeScript、lint、Harness 自检、代码地图与签字对拍已完成；#1337 新 SHA 的 PR CI仍待裁决。PR保持 Draft，未 Ready、合并、操作生产或启用 Gate。

### 14.8 第128条 correction receipt 集合守护（2026-09-20）

第127条将 correction allocation 本身改为语句级集合守护后，#1337 冷跑的 2,000 身份 Human V3 链仍在 receipt 写入阶段触发 7 秒 `P2028`。分段诊断显示这批 receipt 已在同一 bounded `createMany` 内写入，而第125条 `ptar_receipt_guard` 会对每一行再次执行整条 immutable correction proof；因此本轮只新增第128条 `20260920110000_activity_os_r4_d7_2_correction_receipt_guard_set`，不改表、列、索引、schema、权限、DML、回填、删除、API、DTO、Gate 或业务预算。

该 migration 仅重建 `ptacr_receipt_guard`：已识别的 `recognize_correction_time_allocation` receipt 由新 AFTER INSERT transition-table 守卫处理；D3/D4、其他 receipt 及 correction parent 的错误 operationCode 仍逐行进入原 `ptar_receipt_guard`。新守卫按原优先级复核父行存在、operation、result JSON、slice/evidence/manifest 完整性、correction proof shape，并以去重输入先锁 parent，再锁 pending/application/request/batch/segment、source、base、policy，随后一次集合聚合保留 application-not-ready → pending-fact-mismatch → valid-nonempty → zero-source → unsupported-source 的拒绝顺序。所有路径保持 fail-closed 与既有 7 秒预算。

获准 `app_test_w98` 已完成第128条冷回放、127→128 非空升级、单身份 Human V3 链和 2,000 身份 Human V3 链，运行后确认 w98 已回收；`pnpm test:contract` 另在本工作树受控 `app_test_*` 测试库应用第128条并通过1,072项契约，非生产库。旧迁移测试中使用其他 scratch worker 的13份仍由 PR CI 冷跑，不扩大本地数据库授权。最终 SQL SHA-256 计算后必须获得维护者第128条3b重签，才可更新 `CUTOVER_SIGNOFF.md` 并依既有授权提交、推送 #1337；PR仍保持 Draft，Ready、合并、生产与 Gate 不在本轮范围。
