# 服务段更正与当前段唯一索引冲突：方案 A 与实施／复现清单

状态：维护者已确认方案 A 方向、计数调整与暂存生命周期，授权起草精确实施与复现清单。2026-09-08 已进一步授权补 changelog、验证后提交推送并创建文档评审 PR；不合并、不实施、不操作数据库、不启用 Gate。基点 main `2bfb0031`；只读代码与 migration 推导，未连接数据库、未执行复现。本文件精确归档路径授权已核验到账。

## 1. 结论与证据边界

当前段唯一索引要求每个 (participationIdentityId, segmentKey) 至多一个非 superseded 记录。更正 prepare 却在保留旧 committed 段时插入同键 draft，旧段到 commit 才 superseded。若数据库按仓内 migration 建立，该非空段更正路径会在新段插入处发生唯一性冲突。不是已经观察到的线上故障，也不是数据库实测结论。

证据：

- `prisma/migrations/20260804060000_activity_v11_slice3_punch_evidence/migration.sql:544`：partial unique 的键不含 revision，谓词 statusCode<>superseded。未在当前 migration 文本中找到该索引的删除或重定义。
- `src/modules/activities/correction-application.service.ts:626`：prepare 调用 createNewSegmentRevisions；`:1482` 创建同键 draft；`:817` 到 commit 才替代旧段。
- `src/modules/activities/ledger-posting.service.ts:353`：先批量把 draft 改 committed，再返回 correction 执行旧段 supersede；不能只调整 prepare 而不考虑提交顺序。
- `test/e2e/activity-settlement-correction.e2e-spec.ts:442`、`:1222`：已定位的更正请求均为 segments:[]；创建服务段夹具不等于测试更正该段。

准备事务失败会回滚，不能据此宣称已经污染账本；主要缺陷是服务段更正不可交付。C3 必须解释来源更正，不能靠忽略此路径绕开。

## 2. 必须保留的终态

1. 准备期间旧 committed 段、正式账本、day-state、active closure 仍有效。
2. 正式段业务内容不可覆盖；成功更正追加新 revision，并保留 baseRevisionId。
3. 每个业务段最多一个当前段，不能通过删索引把重复正式事实放进来。
4. 提交时段替换、账本生效、更正应用状态和闭包更新在同一事务；失败全部回滚。
5. 仍复用 commitBatchWithin、既有 member 锁／日上限／baseline 校验，不新增第二条入账路径。
6. 只更正积分／认定结果、不更正段的既有成功行为保持不变；重试不多创建、不重复冲回。

AGENTS §3 的业务冻结决策锁存在：原合同所述“prepare 即创建正式段表中的 draft”与唯一约束不兼容，任何修复均须明确修改相应合同，不能称零行为变更。冻结原稿不回改，由新评审稿记录调整。

## 3. 方案 A（推荐）：独立待提交段记录，提交时物化

### 数据形态

新增专用待提交段模型（候选名 `CorrectionPendingSegmentRevision`），隶属本次 CorrectionApplication；存目标活动／identity／segmentKey、精确 baseRevisionId 与 base revision、已批准目标区间／result／serviceHours、原始来源引用和请求内容摘要。准确字段与同链 FK 在实施计划锁定，不复制姓名、自由备注、位置或凭证。

待提交记录不属于当前参与事实，不进入任何正式参与／时长查询。处理期间内容不可修改，新请求新记录；成功后符合下述条件才可清理重复明细。重放依赖持久化的最小命令事实，不依赖暂存明细永久存在。保持 ParticipantServiceSegmentRevision 现有三态与当前唯一索引不变；仅新增 additive migration，旧 migration 不改。

### 已确认的暂存生命周期（仅文档方案）

维护者已确认按推荐调整：暂存是恢复中间数据，不作为第二套永久个人时间档案。此调整替代早期预览的“暂存记录永久禁止删除”，不改变正式段／既有更正记录的保留规则，也不授权本轮执行清理。

| 阶段 | 暂存内容 | 重放与访问 |
|---|---|---|
| preparing／处理中 | 保留完整已批准输入，不修改、不删除 | 当前身份、显式授权与业务范围仍须有效；支持重试和失败恢复 |
| 提交失败、失败原因未解决 | 保留，不因超时或 failed/voided 标签直接删除 | 不自动重新提交；先确认能否恢复，不丢恢复依据 |
| committed 且正式事实与重放摘要完整 | 不再长期重复保留个人时间明细；进入受控清理候选 | 重放使用最小持久化摘要，不能重新创建段或依赖已删暂存行 |
| 成员退队 | 立即撤销其访问资格，不直接触发业务历史删除 | 已成功暂存沿相同清理条件；未解决流程保留恢复依据，正式历史清理由统一政策另定 |

成功不等于只检查一个 committed 字符串：清理前须同时核验 application 与对应 posting batch 已成功、该次新正式 revision 的同链和数量完整、最小重放摘要已持久化、无进行中的恢复／排障保留要求。正式 revision 后来被另一更正 superseded 不影响它作为历史成功证据；不能要求它永远是 current 才能清理。

清理安排采用独立、人工触发的有界流程，不新增 cron/queue，不在普通请求或启动时自动删除。未来执行前先给精确 application ID 清单、行数与脱敏预览，再由维护者批准；按既有 Activity→run→request/application 锁顺序重新核验，删除本 application 的重复暂存明细、登记清理结果及最小审计同事务。任何条件缺失、竞争或审计失败整笔回滚。重复执行返回原清理事实，不二次删除其他数据。不提供本轮可执行 SQL。

处理期仍有 DB 防篡改；不能为了支持清理直接去掉所有 DELETE 防护。具体受控清理入口、数据库约束及审计接缝须进入独立精确实施写集，阻止未提交 application 的暂存删除；现有索引、正式段不可变性、正式历史 FK 均不放宽。若与仓内硬删守护冲突，按 D 档另报，不绕过执法。清理机制需与修复一同完成验收，不能只写“以后清理”便宣告生命周期已落地；实际物理删除仍逐次独立授权。

最小持久化摘要只保留 application/命令锚点、首次准备数量、首次提交／清理时间和必要状态，用于区分“历史准备过零条”“已清理”“损坏缺失”；不保留可反查名单的新增明细清单、时间区间或将个人明细换成 hash 冒充匿名。摘要与首次成功操作同事务写入，具体字段在最终数据计划中列齐，不读取可被删除的 pending 行数作为历史返回值。旧空段 application 沿兼容分支返回零，不批量回填；新格式缺摘要必须报错，不能默认零。

本方案确定的是按业务事件结束重复保存，不虚构保留年限，也不构成正式服务段或既有 requestedChangeJson 的长期保留政策。已存在的业务历史清理仍另行确认。

### prepare

- 在现有 Activity→run→request 锁内验证 base 是该活动该业务段的当前 committed 版本，拒绝缺段、跨活动、过期 base 和同键重复。
- 先建立可绑定的 application 锚点，再创建待提交段；重新排列 application 的创建必须仍在同一事务，不能暴露半成品。
- 继续用变更集覆盖输入来计算更正后的日分配，`readWeightBearingSpans` 已有 overrideByKey 接缝；正式源表不变。
- 审计与响应必须如实区分暂存和正式段创建，见下一节。prepare 失败旧正式事实逐字段不变。

### commit

- 保持 Activity→run→request/application 的现有根锁，读取本 application 的待提交段，重新验证精确 base/current、数量、同链与批准内容摘要。
- 在同一事务内，逐个同键先将旧段 superseded，再创建新 draft（同 identity/key、baseRevisionId、revision 递增），不在事务外提前替换。此时唯一索引允许新行，其他事务看不到中间状态。
- 调用原 commitBatchWithin，让新 draft 按既有 member 锁、跨活动重叠、baseline、日上限与批次协议变为 committed。
- 原“在 commitBatchWithin 后再 supersede 旧段”的 SQL 须精确替换；返回的 supersededSegmentRevisionCount 必须来自实际旧段替换，不写死零。
- application、旧 closure 与新账本一起完成；任何锁等待后版本漂移、重叠、审计失败或 commit 错误，回滚刚才的旧段替换和新段创建。
- 不向 ledger 模块引入 correction 私有依赖。若现有批量 draft 提交通路可能吸入无关段，先通过负例证明或另列精确修复，不顺手扩大 ledger 写集。

### 响应与重放：明确的合同调整

`newSegmentRevisionCount` 当前在 prepare 表示写入段表数量，方案 A 下 prepare 未写段表，应为 0，不能改成“待提交条数”而不改名字。推荐增加 `pendingSegmentRevisionCount` 表示实际暂存数，commit 再报告真实创建／替代数。

后续调用链核验更正：当前生产代码仅在 activities.module 注册／导出 CorrectionApplicationService，未发现 Controller 调用 prepare/commit/apply；计数属于 service 返回接口，不是现有 HTTP DTO。因此本刀只调整内部返回类型、audit prepare 字段与 replay，不新增 Controller/DTO/OpenAPI 路由。空 segments 历史请求原字段仍为 0；旧历史 application 沿明确兼容分支返回零，不能将所有无暂存行情况都默认为零。历史成功审计原文不回填。pendingSegmentRevisionCount 固定表示首次准备的数量，清理后从持久化摘要重放，不是“当前剩余行数”；commit 重放现有各类操作计数为 0 的语义保留，不借机改为回显首次操作数。

### 最坏情况与回退

主要风险是提交顺序／关联锚点变动导致无关段被提交、重放不一致或锁序倒置。上线前以真 PG 并发和失败注入验证。代码回退只能在确认没有已准备但未提交的新格式 application 时进行；已有 pending 时先停新更正命令，按独立处置决定排空或中止，不能让旧二进制忽略暂存段继续提交。保留新增表和历史记录，不自动 DROP 或清理数据。

## 4. 方案 B：服务段表增加 preparing 状态

同表保存准备修订，新 preparing 状态不占当前段唯一位；提交时同事务替代旧 committed，再把指定 preparing 转 draft 并走既有提交协议。

优点：prepare 仍真正创建段 revision，计数语义容易保留，无独立暂存模型。

风险：必须同时调整三态 CHECK、唯一索引谓词、状态机、所有 statusCode<>superseded 与 statusCode not superseded 查询；否则准备数据提前进入当前参与/封场/结算/关账/更正读面。受影响不局限 C3，漏一个查询就可能污染正式统计。回退旧三态二进制也必须先处置 preparing 数据。

不推荐原因：跨读面扩散更大，且实质重开既有服务段状态合同与索引定义。不是绝对不可行，若选 B，须单独完整列出所有引用链和 writer 测试预算。

## 5. 明确排除的捷径

- 直接删除或改成按 revision 唯一：会丢掉“只有一个当前段”的业务约束。
- prepare 先把旧 committed 改 superseded：准备成功尚未提交时旧正式事实已经消失，违反合同。
- 捕获唯一冲突后跳过该段：账本可能按新输入计算、服务段却仍旧，造成两套事实。
- 修改旧 migration 或放宽既有 E2E 断言使 CI 变绿。
- 用 C3 只读过滤掩盖修复欠账；C3-1 来源规则仍须等修复协议冻结。

## 6. 验证与授权预算（尚未执行）

必须先添加真实非空 segments 的失败复现，再实施修复。新增测试文件，不修改旧断言；若旧合同断言确需适配，逐条提请批准。

最低用例：

1. 旧 committed 同键段→批准非空段更正→prepare：旧段／账本／day-state／closure 不变，只有暂存记录和准备批次。
2. commit：旧段 superseded，新段 committed，唯一当前段成立，区间／认定量／账本符合批准内容。
3. prepare/commit 幂等及不同 key 重试；响应与 audit 计数来自真实记录。
4. base 漂移、跨活动、缺段、重复同键、待提交记录篡改均拒绝。
5. 在段切换之后、ledger 期间、audit 期间注入失败，旧段和所有正式数据恢复，零部分生效。
6. 两连接同活动更正竞争、跨活动同人时间重叠、零分录成员、member 锁等待／预算失败；不以 mock 代替。
7. 空 segments 的旧更正 E2E 原样通过；普通 ledger、封场与关账回归，暂存段不被任何正式读面消费。
8. 新 migration 冷回放与非空旧 application 升级；FK/索引/不可变性实测；无生产迁移与业务回填。

预期改动域：correction orchestration、专用暂存模型／migration、内部 prepare/commit 返回类型与审计／重放、受控清理及最小摘要、新测试、schema 生成摘要／架构及状态登记、派生文档。不新增 HTTP DTO 或路由；schema/事务与内部合同变更按 D 档，清理后果精确写集须补齐，不现在发 prisma/** 或全域 grant。

本次授权仅起草。未来隔离复现的测试文件写入、app_test_w98 建库/重建与测试运行需要明确授权；不执行 prisma migrate dev/reset/db push。不访问生产。跨模型评审按维护者要求后置，不称已通过。

## 7. 下一步拍板

维护者已确认方案 A 方向及计数调整，实施／复现清单见第 8–10 节。本文件新增已获精确路径授权；不代表批准实施。

修复协议冻结并验证后，再恢复 C3-1 来源计划。独立暂存方案下，C3 不读取 pending 表；确认 source stale 必须识别已提交的新段，而不是准备内容。

## 本次未做

未改生产代码、schema、migration 或测试；未数据库复现、未执行清理、未提交推送开 PR、未合并、未运行模型评审、未启用 Gate。本轮仅维护本评审稿与 FROZEN_DRAFTS 登记。

## 8. 方案 A 实施顺序与精确复现清单

### R0：先写新增复现测试，再获得隔离库授权后运行

新增 `test/e2e/activity-service-segment-correction-conflict.e2e-spec.ts`，不改旧测试辅助函数或断言。独立建立最小正式活动、合法 identity、已提交结算／账本及 committed 服务段；通过 CorrectionApplicationService 的 submit/review/prepare 调用链提交包含一个真实 segments 项的更正，不直接调用 private 方法。复现成功标准是锁定那次同键 INSERT 的唯一错误（客户端 P2002 或其保留的 PG 23505），并核对索引名称、旧行／账本／day-state／closure 完全未变；泛化 500、任意抛错或夹具失败均不算复现。

新测试写成终态行为要求：prepare 应成功且旧事实不变，因此修复前应红、修复后应绿；另一个独立 DB 约束用例证明直接插入两个 current 同键段仍拒绝。保留首次失败日志作为证据，不把“期待永远报错”当修复后的验收。

### R1：一个 additive migration

迁移目录名称在实施开始时按当前时间与 main 顺序确定，当前不预占第 115 条或虚构日期。模型定名 CorrectionPendingSegmentRevision，不增 statusCode，处理期间禁止改删；成功后的重复明细仅按第 3 节受控清理。另需最小持久化重放／清理摘要，不能用永久暂存替代摘要设计。

最小字段：id/createdAt、applicationId、activityId、participationIdentityId、segmentKey、baseRevisionId、baseRevisionNumber、targetRevisionNumber、checkInAt、checkOutAt、resultCode、serviceHours、sourceCheckInEventId、payloadHash。不得复制自由备注或位置，不添加暂未使用字段。applicationId+identityId+segmentKey 唯一；base 与 pending 的 activity/identity/key 同链校验、base revision 精确匹配、区间和 result 闭集、hash/数值形状均须 DB 与 service 双验证。

复合 FK 所需被引用侧 unique 只增加最小列组；无法用 FK 表达的 application→request→activity 同链由约束触发器验证，禁止假装单列 FK 已证明全部链路。不更改既有 current 段索引／三态 CHECK。

数据用途是冻结处理中已批准更正的精确输入；仅既有获权更正服务内部读取，普通 API/审计不返名单与区间。暂存保留与退队边界已按第 3 节确认：处理中／未解决失败保留、成功后可受控清理重复明细、退队撤权不擅删正式历史。不得把已有 requestedChangeJson 解释为新表永久保存已获批准。

### R2：服务内部切换

prepare：创建版本和 batch 后建立 application，暂存段并完成所有校验，再推进 request/run 与审计；全部保持同一事务。现有 application 主键、版本和批次非空约束不改成 nullable 来绕开创建顺序。任何先前步骤失败均回滚。

commit：持根锁后核验 pending 清单与 approved request 一一对应；无 pending 且非空 segments 的旧 preparing application 一律 fail-closed，不静默按空更正提交。锁后校验 base 是当前 committed 且来源字段／revision 匹配；按 identity/key 稳定顺序 supersede 旧行并创建新 draft，随即复用 ledger commit；不得自行取得新的 member 锁或先提交事务。目标 revision 在 prepare 固定，漂移拒绝，不按最新最大值临时加一。

失败回滚测试须覆盖 supersede 后、新 draft 创建后、ledger 失败后和 audit 失败后四个独立位置。旧 committed 段对外一直有效到成功事务提交，新段独占 current；不改变 C3 或 Gate 读写行为。

### R3：内部计数

CorrectionPrepareResult 新增 pendingSegmentRevisionCount，表示首次准备数量并同事务保存在最小摘要中；newSegmentRevisionCount 在新 prepare 为 0。prepare 重放读取该历史摘要，清理前后相同，旧字段语义不改变。首次 commit 的 supersededSegmentRevisionCount 为真实受影响旧段数，commit replay 沿既有 0 次新操作语义；不为修复一个计数扩展所有历史重放字段。Audit prepare 新增暂存数；未来受控清理审计需单独核验事件注册与消费者，不能预先承诺总数不变，4b 按最终实际变更决定。

## 9. 未来实施逐文件预算（不构成本次写权限）

原段冲突修复核心三份（不含新增生命周期清理的完整写集）：

1. `prisma/schema.prisma`：新 pending 模型、必需反向关系／unique。
2. `src/modules/activities/correction-application.service.ts`：暂存、物化、校验、首次及重放计数；尽量复用现有方法，不另建通用工作流框架。
3. `src/modules/activities/correction-audit-recorder.ts`：prepare 暂存数。

新增：一份精确时间戳 migration（开始实施时补齐路径）；`test/e2e/activity-service-segment-correction-conflict.e2e-spec.ts`、`test/e2e/activity-service-segment-correction-pending-migration.e2e-spec.ts`、`test/e2e/activity-service-segment-correction-concurrency.e2e-spec.ts`、`src/modules/activities/correction-pending-contract.spec.ts`。旧 E2E 不删不放宽。

治理联动修改预算：`harness/domain-map.json`、`harness/state-machines.json`（仅真实生成摘要／原有模型关系变化，新 pending 无状态字段不虚构状态机）、`CODEMAP.md`、`docs/current-state.md`（仅 counts）、`prisma/CLAUDE.md`、`src/modules/activities/CLAUDE.md`、`docs/ai-harness/STATE_MACHINE_INVENTORY.md`、`docs/ai-harness/FROZEN_DRAFTS.md`、`docs/ai-harness/NEXT_TASKS.md`，新增 `changelog.d/service-segment-correction-pending.md`。3b 重签按新增 migration 实际读数；清理审计设计尚未冻结，4b 按最终 registry／权限实际变化决定，不预先承诺无增量或要求无变化重签。

已定位十五份 CURRENT_MIGRATION_COUNT 持有者，未来仅允许当前 migration 数与相应升级末端核验同步，旧历史阶段数字、业务断言及权限数不动：

- `test/e2e/activity-v11-batch4-allocation-candidate-position-anchor-migration.e2e-spec.ts`
- `test/e2e/activity-v11-batch4-allocation-determinism-migration.e2e-spec.ts`
- `test/e2e/insurance-evidence-registration-revision-migration.e2e-spec.ts`
- `test/e2e/activity-v11-batch4-qualification-contract-migration.e2e-spec.ts`
- `test/e2e/activity-os-r1-a4-explicit-template-version-pointer.e2e-spec.ts`
- `test/e2e/activity-v11-batch4-allocation-command-replay-migration.e2e-spec.ts`
- `test/e2e/activity-v11-batch4-allocation-mode-migration.e2e-spec.ts`
- `test/e2e/activity-os-r3-c1-d2a-metric-command-receipt-migration.e2e-spec.ts`
- `test/e2e/activity-os-r2-b2-coordinate-projection-schema-constraints.e2e-spec.ts`
- `test/e2e/activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts`
- `test/e2e/activity-os-r2-b3-form-blueprint-governance.e2e-spec.ts`
- `test/e2e/activity-os-r1-a3-template-definition-lifecycle-guards.e2e-spec.ts`
- `test/e2e/activity-os-r3-c1-metric-definition-set.e2e-spec.ts`
- `test/e2e/activity-os-r2-b1-place-schema-constraints.e2e-spec.ts`
- `test/e2e/activity-os-r2-b6-creation-data-foundation.e2e-spec.ts`

实施前还须逐条运行 schema 持有者／生成摘要预算；新增模型是否导致其他已登记客户端摘要更新，以真实工具结果补齐后一次授权，不允许在实施中盲改十个同名文件。该后果预算未核验完毕前，不发 implementation 广域 grant。

### 只读补充：生成摘要实际输入闭包

- `scripts/check-boundaries.ts:397–415`：domain-map 摘要包含 schema/module；state-machines 摘要包含整个 schema。新增模型必使两者摘要变化，已列入预算；不得靠选择同名字面量文件将现有 inventory 升 governed。
- `scripts/generate-authz-manifest.ts:119–145`：摘要取全部非 spec 的 src TS，而不仅是 controller。修改 correction service／recorder 即会影响 `docs/ai-harness/ROUTE_AUTHZ.md`；把该文件补入未来写集，只允许真实生成摘要及证据变化，不允许新增路由或权限。
- `scripts/generate-fe-client.ts:441–447`：客户端摘要输入为 generatorVersion、surfaces、contractText，不直接读取 Prisma schema。不能沿用上一轮经验要求十份客户端全部刷新；本刀无 HTTP 合同变化时预计不需改客户端。实际检查若显示 contractText 变化，先调查来源，不自动批准 snapshot 或客户端改动。
- `scripts/check-permission-surface-binding.ts:230` 的 surfaceDigest 对端点集合计算，ROUTE_AUTHZ 全文摘要变化不等于权限管辖面变化；permission-surface-baseline 仍不列入本刀写集。
- 新 pending 模型属主必须明确：现有 CorrectionApplication 在 domain-map 登记为 participation/attendances，而 service 位于 activities；ParticipantServiceSegmentRevision 则登记 participation/activities。不可仅按 service 所在目录给新模型归属。实施前核对既有 CorrectionApplicationService 精确登记，采用最小 owner/允许查询设计，不改两个既有属主，不扩跨域白名单；若无法在当前边界内接入，先报新决策。

以上为静态输入闭包核验，不是“实现后的所有生成物已通过”；本轮没有修改 schema 来试跑生成器。

### 新模型归属建议与旧债边界

已核对 `scripts/check-boundaries.ts:2530`：同 domain 也会检查 ownerModule，写别的 owner 会产生 cross-owner-write；`harness/architecture-debt.json` 已登记 CorrectionApplicationService.prepare/commit 对 CorrectionApplication 的旧跨属主写入。因此不能以“同属 participation”推断无新增债，也不能趁本刀重归属旧模型。

推荐新 Pending 模型归 participation/activities/lifecycle：其职责是本次活动结算应用在提交前的物化输入，由 activities 的更正编排唯一创建和消费，不是 attendances 的更正请求／审核记录。新模型通过 application/request 锚点关联已批准请求，不接管请求审批。此为新增模型的建议归属，随实施计划批准，不修改现有 CorrectionApplication 或 AttendanceCorrectionRequest 的 owner。

保留旧 application 创建／更新的既有方法符号与明确语义，避免仅为代码搬移改变登记定位；真正新增旧跨属主操作仍须另报，不能改 architecture-debt.json 基线吞掉。未来验证执行精确债差分：新增 Pending 自属主操作不产生新 cross-owner-write；所有旧债仅比较对应操作，不能将全仓历史债误报为本次新增，也不能以全仓总数相同证明零新增。

禁止写集：ledger-posting.service.ts、其他参与／更正 writer、C1/C2/C3 实现、controllers/DTO、permission/seed、audit registry/types、contract snapshot、workflow/package/脚本裁判、任何旧 migration。若验证要求触碰禁止域，先报告原因与最小扩展，不以本节预算推导许可。

## 10. 后续授权分层

当前授权更新：本轮三份文档（本稿、FROZEN_DRAFTS、changelog）已允许提交推送开 PR；下述“不含提交推送”是起草阶段历史边界，不再适用于本轮文档交付。implementation、数据库操作及合并仍未授权。

本次只起草方案及清单，暂存生命周期方向已获确认。正式评审文件的精确 archive grant 已核验；不含提交推送开 PR。后续需依次：补齐最小重放摘要／清理守护的数据合同与精确文件→锁定 migration 与全部派生写集→批准新增复现测试及隔离库→复现→批准 implementation→验证→提交/PR→3b 与可信审批→合并。物理清理另按精确目标逐次批准，不由本稿或 implementation 预授权。不得把最后一句“已执行”当上述所有操作的 blanket 授权。

生命周期新增验收：处理中和未解决失败禁止清理；成功但缺正式同链／摘要拒绝；清理前后 prepare 重放数量一致且不再创建事实；清理与重试并发、审计失败原子回滚、清理重复执行幂等；新格式缺暂存与缺摘要不得默认为零；退队后访问拒绝但历史记录不被顺手删除。只新增测试，不放宽原断言。第 9 节原核心三文件预算尚不覆盖清理入口和摘要持久化的完整后果，必须补齐后再批准实施，不能据此直接修改脚本、审计注册表或 DELETE 守护。

## 11. 最终建议数据合同（2026-09-08 文档补齐，待实施拍板）

本节补齐第 3、8–10 节原待定的摘要／清理设计；不表示已复现、已实现或允许执行清理。方案 A 与生命周期方向已批准，本节字段、数据库清理原语及完整写集仍须作为实施合同整体审核。

### 11.1 三类模型与生命周期

| 模型 | 字段／唯一键 | 修改规则 |
|---|---|---|
| CorrectionPendingSegmentRevision | 第 8 节 R1 的既定字段；applicationId+participationIdentityId+segmentKey 唯一 | 禁 UPDATE；只有成功且清理收据一致的受控清理可 DELETE，不允许级联删 |
| CorrectionSegmentPreparationReceipt | applicationId 主键/FK；schemaVersion=1、preparedSegmentCount、preparedAt | INSERT 后禁止 UPDATE/DELETE；与 prepare 完整事务同写；不存名单、区间、原始请求或新增逐人 hash |
| CorrectionSegmentCleanupReceipt | applicationId 主键/FK；schemaVersion=1、preparedSegmentCount、deletedSegmentCount、cleanedAt、databasePrincipal、authorizationReference | INSERT 后禁止 UPDATE/DELETE；与清理同事务；不存已删除明细或操作键内容 |

三模型均建议 participation/activities/lifecycle，非状态机表，不增加独立 statusCode。preparedAt/cleanedAt 由服务器/数据库写，计数为非负整数；有准备收据但 count=0 是合法零段，不等于缺收据。准备收据为所有新格式 application 写入，包括零段。

authorizationReference 只接受维护者本次清理批准的固定格式引用标识，限制长度，不接受自由备注或 URL 凭证；databasePrincipal 由数据库 session_user 记录，明确它是执行的数据库身份，不能把 CLI 自报 User ID 当作已认证操作人。SOP 将批准记录与执行主体对应，不冒充 App 登录审计。

暂存表只保存恢复期间必须的个人时间事实；成功后可清理。两类收据只证明发生过多少准备／清理和何时发生，按既有更正事实一并受控保留，不据此批准正式业务历史永久保存。清理收据是本动作的最小不可变审计凭据，本建议不额外新增 AuditLogEvent、不改活动发布审计事件承载清理；旧 prepare 审计仅增加已批准的计数字段。若维护者要求统一 AuditLog 事件，另列审计注册与身份接入写集，不在实现时随意增码。

### 11.2 同链与数据库约束

1. Pending→application、identity、baseSegment、sourceCheckInEvent 均 Restrict FK；校验 application→request 的 activity 与 pending.activityId 一致，base 的 identity/key/revision/源事件与 pending 的锚点一致。基段必须是在 prepare 时锁后确认的 current committed；targetRevisionNumber=baseRevisionNumber+1。
2. 准备收据与暂存清单须在事务结束时数量完全相等，且与已批准 requestedChangeJson 的闭集段输入一致；不能用 receipt 存在作为插入任意行的许可。prepare 失败两者均不存在。
3. committed application 的清理必须有对应 committed posting batch、完整的物化历史段及该批次来源；用 baseRevisionId、target revision、identity/key、effectiveBatchId 与暂存内容逐项比对。不以“同活动总段数相等”代替同链证明。
4. 清理收据计数必须等于准备收据及实际删除数量；没有清理收据不得删除暂存行。有清理收据时，事务结束必须零剩余暂存；不得插空收据来伪装删除成功。两者以同一事务的约束检查保证，不依靠可伪造的 session 开关跳过触发器。
5. 清理后禁止对该 application 补插 pending 或重复 prepare；prepare/commit 重放仍复验调用方当前访问资格，返回历史摘要／既有零次新操作结果，不重做业务。
6. 新旧格式用数据库新建约束区分，不新增时间边界表：在 CorrectionApplication 的 INSERT 上安装事务末 deferred constraint trigger，要求新 application 同事务存在准备收据；收据禁止 DELETE/UPDATE。升级前已有 application 不批量回填。兼容缺收据的旧 application 前须证明该约束链有效，且只能处理原有零段重放；非空 segments 且缺摘要／pending 一律 fail-closed。不按 createdAt 猜测格式，不因为版本号新就跳过校验。新建缺收据、收据被删、新格式伪装旧格式须有 DB 负例；若约束链被管理员修改或无法验证，拒绝兼容而不是猜零。

### 11.3 清理入口与执行权限

新增维护者 CLI `scripts/cleanup-correction-pending.ts`，不接 package script、Controller、cron、queue 或 App 启动流程。默认只输出脱敏预览；参数仅接受一个明确 applicationId 和批准引用，不接受全库/all、通配、按天扫描后自动删除或任意 SQL。每次至多一个 application，最大明细数 2000；超限直接拒绝，不能截断清理。该 2000 是清理行数上限，不冒充 C3 的 2000 人规模承诺；更大目标需独立容量方案。

同一文件的 apply 必须显式开启，要求本次维护者精确批准；操作前明确数据库目标，禁止默认落入生产。连接凭证只通过现有安全配置路径获取，输出和日志不打印连接串。新 CLI 不能自行签发 harness grant 或清理批准，不把传入 authorizationReference 本身当成真实性认证。

数据库侧在该 migration 内定义受控函数 `cleanup_correction_pending_segment`，只允许按 applicationId 清理本暂存表；无动态 SQL、无 SECURITY DEFINER 提权、无清理其他表。函数负责 Activity→run→request/application 同序锁、检查清理前提、INSERT 清理收据、精确删除暂存、验证实际条数；任一步失败整事务回滚。CLI 使用具备已审查运维权限的连接调用，应用请求面不暴露该函数；数据库部署时的权限必须由独立部署审批落实，文档不声称仅有函数名就隔离了调用权限。

该数据库函数包含物理 DELETE，明确属于本次待审批 D 档例外，不因避开 src ESLint 就视为允许。不得新增 eslint-disable、改守护、使用原始 SQL 偷绕业务软删红线。其实现与隔离库测试需要明确拍板，实际环境每次执行仍须精确目标授权；不存在“模型自主自动清理”。生产执行另行批准。

无进行中恢复／调查保留需求须由批准人确认并在执行前复核 application/batch 状态；系统没有现成 legal-hold 模型，不虚构能自动查询一切人工保留意图。未解决 failed/voided、缺摘要、缺正式同链均拒绝；commit 成功也不能跳过保留需求确认。

重复执行若已存在合法清理收据且无 pending，返回原 receipt 与 replayed=true。若 receipt 有但 pending 仍有、无 receipt 却丢明细，返回一致性错误，不能补造成功记录。

### 11.4 复现与验收补齐

- 新增 lifecycle E2E：prepare 保留；未解决失败拒删；成功但缺同链或摘要拒删；直接 DELETE/UPDATE 拒绝；受控清理成功；清理收据伪造/计数不符/残余行导致整笔回滚。
- 两连接：cleanup 与 prepare replay/commit replay、两个 cleanup 同时执行、锁等待后状态变化；证明只产生一张清理收据，重放计数清理前后一致，正式段和账本逐字未变。
- 新增 CLI 单测：默认 preview 不写、无 ID/通配/批量参数拒绝、超 2000 行不写、输出不含时间明细和凭证、失败退出码非零、不自行重试 destructive apply。
- 升级：旧空段 application 兼容；旧非空异常状态不被当零成功；新格式收据损坏失败；冷库和非空库约束均验证。迁移断言不放宽原 current 索引。
- 清理收据写失败、删除失败、事务末约束失败分别验证 rollback；未经实际 PG 验证不宣告能安全删除。

## 12. 合并后的精确实施写集建议

以下补齐第 9 节预算，只有本节列出的新增项可以请求下一轮授权；目前仅文档，所有实现路径都尚未获得写许可。

沿用第 9 节三份核心文件、十五份具名旧迁移计数 E2E、四份具名新增测试、治理派生文档及 changelog 路径；原测试只调整当前 migration 计数／对应末端核验，历史阶段与行为断言保持。

新增生命周期必需路径：

1. `scripts/cleanup-correction-pending.ts`：唯一维护者 preview/apply CLI，不写通用裁判脚本。
2. `src/correction-pending-cleanup-cli.spec.ts`：CLI 参数／默认只读／脱敏／失败退出码单测；不调用真实库。
3. `test/e2e/activity-service-segment-correction-lifecycle.e2e-spec.ts`：数据库清理函数、收据、竞态与回滚。
4. `docs/ops/correction-pending-cleanup.md`：执行身份、精确预览、批准记录、逐 application apply、验证与失败处置；不输出数据库口令。
5. `docs/ai-harness/ROUTE_AUTHZ.md`：仅真实源码摘要／证据变化，已由输入闭包确认需要预算。

migration 建议精确路径为 `prisma/migrations/20260908000000_correction_pending_segment_lifecycle/migration.sql`，纳入三模型、必要 Restrict/unique、不可变与生命周期约束、清理函数；此为拟议路径，未创建也未预签 migration 计数。实施前须核对 main 新增 migration 顺序与同名路径不存在，冲突则在写前更新精确授权，不把目录名当成数据库迁移已发生。

不新增 activities.module.ts 接线（核心沿原 service、CLI 不注册 HTTP provider）；不改 permission/seed、audit registry/types、contract snapshot/Controller/DTO、FE 客户端、workflow/package/ESLint、旧 migration、ledger-posting.service.ts 或 architecture-debt.json。这替代第 6 节早期宽泛候选；未来真实检查若证明还需额外文件，报告具体输入链后批准扩展，不能宣称本静态清单覆盖未知后果。

清理脚本不拥有历史正式记录的删除权；schema 中不得把正式段 FK 反向指向可清理 pending 导致删不掉或级联删除正式事实。准备摘要及清理收据只引用永久 application，不引用 pending 行。

仍需实施拍板的明确项：三模型字段／约束、清理物理 DELETE 原语、CLI 运维执行身份、历史新旧格式区别的可验证规则、上述精确路径及隔离验证范围。方案文档完成不等于这些实现或运行权限已下发。

未来隔离验证建议 app_test_w98，复用仓内既有 E2E 基础设施、不自写数据库重建脚本。仅收到当次数据库授权后运行；本地 quick、上述三份新 E2E，加 activity-settlement-correction、activity-ledger-posting、activity-ledger-posting-concurrency、activity-settlement-closure 和 activity-settlement-closure-concurrency 原用例；全量由 PR CI，contract 期望零 API 漂移，任何 snapshot 差异先调查而非更新。
