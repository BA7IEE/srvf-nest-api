# Activity OS R4 D6 正式分类时长账本：评审与精确实施计划草案

> **D6 implementation 已授权并开工（2026-09-14）**：#1330 已合并至 `ce85663a`，main CI 34802958459 通过。维护者批准第11–13节及98个去重路径完整实施，含权限说明、错误码、访问复核、兼容测试及具名测试触发器处理；仅允许 app_test_w98 隔离验证及测试夹具重建，验证后提交、推送并创建 PR；不合并、不操作生产、不启用 Gate、不删除业务数据。11项本工作树 D6 红区令牌已核验。以下“待审批/不实施”属于历史过程；本段不表示实现或验收已完成。跨模型独立整体复审仍未完成。

> **D6 精确计划确认与文档交付授权（2026-09-14）**：维护者已确认 D6 精确计划方案 A（D6 计划第11–13节及98个去重实施路径），允许本轮五份文档（D5计划、D6计划、NEXT_TASKS、FROZEN_DRAFTS、D6 changelog）提交、推送并创建计划 PR；不合并、不实施。本条覆盖下方“精确计划待审批”“仅四份文档”“未获提交推送/PR授权”等历史时点。计划确认不等于98路径实施权限、数据库操作许可或红区令牌；D6仍未实施，生产、Gate、业务数据删除及独立整体复审均未获本轮执行授权。

> **方案方向已确认，精确计划待审批（2026-09-14）**：维护者确认方案 A 方向，并允许保留本轮四份未提交文档继续完善，不修改门禁。第 11–13 节是本轮补齐后的具体合同与写集；第 7 节的 68 路径和待核事项为初稿记录，以第 12 节去重后的完整清单为准。本轮仍只有四份 Markdown 写权限；没有实施、数据库、提交推送或 PR 授权。

## 1. 当前状态与授权

2026-09-14，源码基线 main `2609856e00b8274abb40cbd0cf5687d22d652b46`。D5 #1329 已合并，PR CI、可信审批及 main CI 34795854470 均成功；没有执行真实业务 cutover。D5 本地及 CI 对账是隔离夹具证据，不替代业务差异逐条签收、永久归档或切换日期。

维护者本轮仅授权 D5 台账更正与 D6 评审、精确计划起草。方案 A、以下未来写集、数据库验证、签字、提交推送及 PR 均未因此获批。本稿是可评审草案，不是已经冻结或可直接下发的 implementation goal。冻结合同依据为 T0-A §7.1、§10.3、§11；旧 mixed ledger 的远期 contract 不在本刀内。

本轮实际写集四份 Markdown：本文件、D5 计划、NEXT_TASKS、FROZEN_DRAFTS。与保留中的 #1324 五份流程文档无交集；使用 lane 开工检查，未借用“唯一 open PR”合并豁免为新的合并许可。

## 2. 人话简报

D4 保存审核材料，D5 检查新旧差异，D6 才让分类时长成为可以核验来源、不能偷偷改写的正式分录。四类时长不能挤回一个 serviceHours 数字；贡献分也不能替代时长。

- 方案 A（方向已确认，具体实施合同待审批）：新增独立 ParticipationTimeLedgerEntry；沿用现有 LedgerPostingBatch 及 worker 的准备、统一提交协议。分类账和该批次的既有分录共用 committed 可见边界，不开第二个提交事务。
- 方案 B：新增独立时长批次和第二套 worker/提交状态机。能隔离模型，但需解决两个批次部分成功、恢复顺序和长期双真相，扩大冻结合同以外的协调协议，本轮不推荐。
- 最坏风险：旧账先可见、新账缺行；未知分类被当志愿服务；旧更正冲回了旧账却漏掉新账。分别用同一提交事务、分类闭集和 D7 前的分类批次更正拒绝保护。
- 回退：D6 未启用生产 Gate，可暂停部署；若已有分类 committed 行，禁止降级成会忽略分类保护的旧应用，禁止删行或改历史。应停写并前向修复，业务冲回等 D7，不执行 down migration。

## 3. 源码核验与调用链

| 当前连接点                                                          | 已核验事实                                                             | 计划处理                                                                      |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| prisma/schema.prisma / ActivitySettlementTimeRevision               | run/version/activity/seal 同链，submitted 唯一性在 migration 121       | 用固定 submitted 修订，不拼接 latest                                          |
| ParticipantSettlementTimeBucket / Source                            | 身份×分类唯一；整数认定秒、可空计算秒；不可变来源与政策锚点            | 分录引用桶，不重算 policy 或解析第二套参与段                                  |
| LedgerPreparationService.ensurePrepareJob / prepareChunk / finalize | 既有 ledger_prepare 任务、分块围栏、完成计数和 ready                   | 新账准备接在同一个受控 chunk 中；finalize 同时核验分类清单完整                |
| LedgerPostingService.commitBatchWithin / commitBatchProtocol        | Activity→Run→Version→Batch，再既有 member/day-state 锁；共用事务及重放 | 在共同提交点增加分类一致性验证；不复制提交协议                                |
| LedgerReadyBatchCommitter.commitReadyBatch                          | 从该版本 final/approve 决定取 actor，调用既有 commitBatch              | 保留调用方式，撤权、失效身份与重放权限均须 characterization 核验              |
| ActivityBatchWorkerModule                                           | 独立注入 LedgerPreparationService                                      | 新依赖必须同时登记 activities.module 与 worker module，不能只让 HTTP 启动成功 |
| ActivityTimeSettlementAccessService.authorize(read)                 | 当前身份、显式组织 scope、活动组织资格及负责人/该版本审核资格          | 分类账 GET 复用 read，不把 owner 的 prepare 权限当入账权限                    |
| 旧 LedgerQueryService / ParticipationLedgerEntry                    | 既有贡献与 serviceHours 混合账                                         | D6 不切旧 GET，不回写旧已提交行，不改贡献日上限                               |

先跑原账本准备、提交、重放、并发、自动 worker 的 characterization，再修改编排。权限判定有缺口或原断言需要改变时停止并集中补充方案，不用新账功能顺手重写旧鉴权。

## 4. 推荐数据合同（须确认）

### 4.1 两个新增模型，不新建生命周期

**ParticipationTimeLedgerManifest**：每个 postingBatchId 至多一份不可变清单。字段为 id、postingBatchId、activityId、settlementRunId、settlementVersionId、timeRevisionId、bucketContentHash、sourceSetHash、expectedEntryCount、recognizedSecondsTotal（BigInt）、contentHash、formatVersion、createdAt。它冻结已提交分类来源，不代替 LedgerPostingBatch.statusCode。复合 FK 必须证明 batch/version/run/activity/timeRevision 是同一链；为被引用模型添加精确 unique 靶点。禁止靠几个独立单列 FK 冒称同链。

**ParticipationTimeLedgerEntry**：id、manifestId、postingBatchId、activityId、timeRevisionId、bucketId、participationIdentityId、categoryCode、recognizedSeconds（Int）、entryKey、contentHash、createdAt。一个冻结 bucket 对应一个分录，包含零秒桶，不筛掉零值后改变分母。桶复合 FK 需覆盖 revision/activity/identity/category；manifest FK 覆盖 batch/revision/activity。唯一键包括 entryKey 与 manifestId+bucketId。entryKey 由版本化 canonical/hash 工具计算，禁止字符串不定长拼接或随机键绕过重放。

两表没有 updatedAt/deletedAt，UPDATE/DELETE/TRUNCATE 的数据库保护须按既有 append-only 先例核验；INSERT 在 batch 非 preparing 时拒绝，触发器须锁同一 batch，堵住 finalize/commit 与晚到 INSERT 的竞态。同内容重放先读取比对而非尝试 UPDATE，不能用 upsert 更新不可变行。禁止 CASCADE 清理。

不提前占位 reversesEntryId 或未来 correction 数据列；D7 另做引用、冲回占位及负数合同。D6 只接受四种初始 credit 类别：volunteer_service、training、organization、non_creditable。legacy_unclassified 不自动转类别、不入这条新初始信用链；历史旧账继续读旧路径。

### 4.2 完整性与数值

认定秒是当前入账值；calculatedSeconds=null 可以作为“计算未知”保留在源桶，不能转成 0 也不能虚构计算差异已解决。新分录不复制敏感 adjustmentReason，保留可授权追溯的源桶引用。四类独立汇总，禁止把非志愿类别加入志愿服务总量。

一批最多 2000 身份、8000 桶、40000 来源；引用现有 10000 分配修订、50000 切片证据，不把账本行数偷换成分配数。合计用 BigInt 防 Int 求和溢出；JSON 返回精确十进制字符串或显式经过安全范围校验的整数，不能裸序列化 BigInt。格式在 DTO 与 snapshot 中明确。

本刀按桶记账，不先做日拆分，不填一个假的 ledgerDate。D8 证明需要分段/日口径时沿冻结 bucket sources → allocation/segment 获取，禁止把 createdAt 当服务日期。

### 4.3 旧兼容面与 D7/D8 边界

没有 submitted 分类修订的历史版本继续既有路径；存在分类修订则必须建 manifest，缺分类分录时不能退回“按旧流程成功”。manifest 的“无分类”判定必须绑定该 settlementVersion，重放不重新选 latest。

旧 serviceHours 接口在 D6 保持历史兼容读，不将其标成分类账真相，也不建立新双写同步任务。把兼容 serviceHours 改成 volunteer_service 投影及切换正式证明/统计读源在 D8 整体切换验收，不在本刀提前开。旧贡献账和日上限完全保留。

凡 correction 涉及已有分类 manifest 的原批次，D7 完成前必须在原应用事务内拒绝；不能仅在新 HTTP 接口拒绝而让既有 correction 入口漏过。原 legacy correction 行为不变。这是一项需维护者确认的新分类业务限制，不是本轮已修改的行为。

## 5. 准备、提交、恢复与鉴权

1. 从现有审核通过后的 ledger_prepare 链进入，只有确切 submitted 分类修订才启用分类准备；不新建 cron/queue，也不增加手工绕过终审的 POST。
2. 同一 chunk 内先经过既有租约/围栏检查，再按该块身份集合批量读桶、写新账；保留所有 worker 锁序、批量大小、原分录和 member day-state 逻辑。不得逐身份新增一次查询。
3. manifest 唯一性竞争失败后重读并比对 hash；同源同内容幂等，不同内容冲突。重放不得吞掉非唯一约束错误。
4. finalize 在同一事务里验证集合等价、条数、分类与金额/hash，全部完成才允许 ready；不能只 count 相等而忽略漏一行多一行。
5. commit 在现有锁及事务内复验 manifest/source 完整性、final approver 当前资格和 D7 保护；任一失败全部回滚。classified entries 只有关联 batch=committed 才在正式 GET 可见。
6. ready/failed/voided 的准备行永久保留但不可计入正式汇总；恢复沿既有任务重放，不新增业务数据清理 CLI。数据库重建许可仅可另行申请隔离测试夹具。
7. Gate 关闭与只读维护窗拒绝普通新账写入；legacy conversion 入口不自动创建分类账，不猜旧历史类别。禁止为了测试跳过生产 Gate 检查。

## 6. 对外合同与预算

候选新增只读 GET：
`/api/app/v1/my/managed-activities/:activityId/time-settlement/revisions/:timeRevisionId/ledger`。

输入复用版本参数与标准 page/pageSize。只返回该活动、该确切修订、committed batch 的分类分录分页；包含 postingBatchId、manifestId、timeRevisionId、内容指纹、四类汇总、标准 resultPage。页间总数与指纹来自同一冻结 manifest；先验权限，不泄露未提交状态或跨活动存在性。详情不增加敏感原因全文、成员姓名、电话、证件或 signed URL。

读取复用 `activity.time-settlement.read`；写入继续现有 final-review / worker 资格，不新增权限码、不默认授予任何角色。新行为若现有权限说明无法准确涵盖，须显式扩权评审，不能把更新 baseline 当成已批准语义。

目标预算（实施阶段维护者已批准更正commit预算，验收证据见第14节）：GET 总查询≤120、业务≤30秒；各块额外分类 SQL≤8（不含旧链已有语句，测试同时报告含原链总数）、finalize 额外≤8、commit 额外≤56且总业务查询≤85。事务控制语句与单独记录的SELECT 1健康探针不算业务查询；两轮当前权限和完整性复核保留。原commit额外≤6的失败记录在第14节保留，不追认旧测试通过。member advisory 锁和旧业务事务时间预算原样保留。1/100/2000 档必须同口径测量。满额 E2E 整体最多600秒只用于构造/验证夹具，不能据此放宽业务事务。

错误优先复用含义一致的既有 unavailable/stale/conflict/scale-limit 与 ledger prepare/commit 拒绝码；逐分支做映射表。确需新码时先列真实编号、HTTP 状态与准确 message，再冻结写集，不借用含义不符的旧码掩盖错误。错误分支及新码的具体映射已在第11.6节补齐，尚未实施。

## 7. 初稿路径清单（与第12节合并后为最终待审批写集）

这是拟实施的逐路径预算，不是写权限。既有路径按调用链列出；新增名是方案选择，未创建。新 migration 名候选固定为 `20260914120000_activity_os_r4_d6_time_ledger`；当前121条，若实施前新增其他 migration，必须重新核验序号与签字，不照抄“第122条”。

### 7.1 业务与新测试

```text
prisma/schema.prisma
prisma/migrations/20260914120000_activity_os_r4_d6_time_ledger/migration.sql
src/modules/activities/participation-time-ledger-policy.ts
src/modules/activities/participation-time-ledger-policy.spec.ts
src/modules/activities/participation-time-ledger.service.ts
src/modules/activities/participation-time-ledger.service.spec.ts
src/modules/activities/participation-time-ledger-query.service.ts
src/modules/activities/participation-time-ledger-query.service.spec.ts
src/modules/activities/ledger-preparation.service.ts
src/modules/activities/ledger-posting.service.ts
src/modules/activities/activities.module.ts
src/modules/activities/activity-batch-worker.module.ts
src/modules/activities/controllers/app-managed-activity-time-settlement.controller.ts
src/modules/activities/dto/app/app-activity-time-settlement.dto.ts
test/e2e/activity-os-r4-d6-time-ledger-migration.e2e-spec.ts
test/e2e/activity-os-r4-d6-time-ledger.e2e-spec.ts
test/e2e/activity-os-r4-d6-time-ledger-concurrency.e2e-spec.ts
```

### 7.2 派生与治理闭包

```text
prisma/CLAUDE.md
CODEMAP.md
docs/current-state.md
harness/domain-map.json
harness/state-machines.json
docs/ai-harness/STATE_MACHINE_INVENTORY.md
docs/ai-harness/ROUTE_AUTHZ.md
harness/permission-surface-baseline.json
docs/ai-harness/CUTOVER_SIGNOFF.md
test/contract/openapi.contract-spec.ts
test/contract/__snapshots__/openapi.contract-spec.ts.snap
docs/handoff/openapi.json
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
docs/plans/activity-os-r4-d6-time-ledger-review-and-plan.md
docs/ops/activity-time-ledger.md
docs/ai-harness/NEXT_TASKS.md
docs/ai-harness/FROZEN_DRAFTS.md
changelog.d/activity-os-r4-d6-time-ledger.md
```

### 7.3 旧迁移测试计数候选

以下19份是当前121计数的直接命中，逐份核实只更新“当前全量回放”，历史升级段与断言原样保留。命中不等于已获得修改权限或已证明完整闭包；动态迁移恢复与旧 schema 夹具须额外检查，不能盲改所有121。

```text
test/e2e/activity-v11-batch4-allocation-mode-migration.e2e-spec.ts
test/e2e/activity-v11-batch4-allocation-candidate-position-anchor-migration.e2e-spec.ts
test/e2e/activity-v11-batch4-allocation-command-replay-migration.e2e-spec.ts
test/e2e/activity-v11-batch4-allocation-determinism-migration.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2a-metric-command-receipt-migration.e2e-spec.ts
test/e2e/activity-os-r1-a4-explicit-template-version-pointer.e2e-spec.ts
test/e2e/activity-os-r4-d1-1-time-policy-migration.e2e-spec.ts
test/e2e/activity-os-r2-b2-coordinate-projection-schema-constraints.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts
test/e2e/insurance-evidence-registration-revision-migration.e2e-spec.ts
test/e2e/activity-os-r2-b3-form-blueprint-governance.e2e-spec.ts
test/e2e/activity-v11-batch4-qualification-contract-migration.e2e-spec.ts
test/e2e/activity-os-r3-c1-metric-definition-set.e2e-spec.ts
test/e2e/activity-os-r2-b1-place-schema-constraints.e2e-spec.ts
test/e2e/activity-os-r2-b6-creation-data-foundation.e2e-spec.ts
test/e2e/activity-os-r1-a3-template-definition-lifecycle-guards.e2e-spec.ts
test/e2e/activity-os-r4-d3-time-allocation-revision-migration.e2e-spec.ts
test/e2e/activity-os-r4-d4-time-bucket-migration.e2e-spec.ts
test/e2e/activity-os-r4-d1-3-selection-migration.e2e-spec.ts
```

### 7.4 初稿核验清单（现已按第11–13节细化）

已对上面三个代码块逐行运行 harness:needs：68 个唯一候选路径，其中 8 个红区路径、60 个非红区路径。此工具只算预算，不验证授权，也不证明写集完整。本轮四个实际 Markdown 路径另算，均不需红区令牌；没有执行任何 grant。schema 与单条 migration 在真正下发时应使用精确路径授权，不因工具聚合输出 prisma/\*\* 而扩大到 seed 或其他 migration。

- 两模型逐字段 Prisma 类型、复合 FK 的精确 unique 靶列、SQL CHECK/trigger 名称与并发锁协议须在方案选择后逐项表格化；不得在实施时即兴增列。
- worker 注入到 prepareChunk/finalize 和普通/自动/converted/correction 的所有提交入口做全引用图；上述17路径不足以覆盖时补成一个最终清单再请批，禁止把本稿候选总数冒称最终写集。
- 审核与 correction 兼容 characterization 的精确测试名、当前时钟字段注册表及新 kindCode/领域归属派生需检查。manifest 和 entry 不新建状态机，但已有 batch 状态与不可变配置登记仍需按实际守护契约核验。
- 当前19旧迁移测试逐份区分历史和全回放；新 FK 影响清理顺序的测试另列名单及仅夹具适配说明。禁止调整旧行为断言。
- §6 错误分支表、预算证据探针、所有生成摘要输入和 3b 签字位置一起冻结。不存在新权限/审计时不得机械要求重签4b；若新增或扩语义必须单独列出。
- 不把以上缺口拖给无人值守 implementation。补齐后再给一条完整实施授权，未补齐只能继续文档。

## 8. 验收与探针队列

| 编号 | 必须为真的结果                                                         | 证据探针                                                  |
| ---- | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| G1   | 只 additive，新表初始为空；旧账与旧审核内容不变                        | 干净回放、121→下一条非空升级，旧表内容摘要对比            |
| G2   | 两表 append-only；跨 batch/version/activity/identity/category 组合拒绝 | 每维独立负例；UPDATE/DELETE/TRUNCATE 与晚到INSERT并发负例 |
| G3   | 四类及零秒桶完整，不混志愿/贡献，不把未知计算变零                      | policy 单测与真实 HTTP/DB 行逐项比对                      |
| G4   | 重放同批同桶不增分录；不同hash拒绝；两个worker抢占只有一个效果         | 双连接屏障、围栏过期、进程中断重放                        |
| G5   | 准备未完整不得ready；同计数错集合拒绝                                  | 漏一行换一行、hash与金额分别变异，独立断言                |
| G6   | 普通/自动提交共用事务；最后一步异常零部分生效                          | 原准备/提交/并发/自动消费 characterization + 故障注入     |
| G7   | 非committed不进分页和汇总；历史版本不被latest污染                      | preparing/ready/failed/voided/committed全状态HTTP         |
| G8   | 锁等待后撤权、停用、成员失效、越组织及自审限制不绕过                   | 当前actor/作用域真实HTTP与并发屏障；只GET和mock不够       |
| G9   | classified correction在D7前明确拒绝，legacy correction不变             | 既有应用入口及内部提交入口反例；原行为断言保留            |
| G10  | 旧贡献、legacy转换、serviceHours读源不偷偷切换                         | 原账本与转换链回归，存量内容摘要相等                      |
| G11  | 1/100/2000不N+1；满额来源不截断，查询/事务预算原样                     | 分项SQL计数含授权和健康查询，真实worker全链计时           |
| G12  | 契约、生成物及签字与最终SHA一致                                        | snapshot逐行解释、harness/派生检查、PR全量CI与可信审批    |

每项先探针，已满足则留证据不重写；失败不得删除测试或放宽断言。定向隔离库建议仅 app_test_w98，须维护者另行授权；无授权本轮不运行任何数据库命令。全量E2E由CI执行，本地仅quick及受影响定向验证。

## 9. 一次性拍板清单与交付顺序

首先只需确认推荐方向：共用提交批次、独立分类分录；四类精确秒及零秒入账；旧兼容读切换归D8；classified correction在D7前拒绝；永久保存业务分录、源证据与失败准备材料。

方向确认后，在本稿完成§7.4剩余的字段/调用链/旧测试闭包，给出可下发的最终精确写集与目标、幂等探针、授权清单和禁止域；这遵循 srvf-goal-author 的“未决问题不得带入 implementation goal”。不把未确定的 SQL 摘要或未来生成值提前请签。

本轮后续文档提交/推送/开PR须明确批准；方案确认、implementation、w98测试、3b签字、Ready/合并、真实业务验收与生产Gate互不替代。永久证据目录、可访问主体和备份位置可在业务演练前确定，不需要为写代码删除任何业务数据。

## 10. 本次未做

未实现模型、migration、服务或GET；未操作数据库、生成代码或启动worker；未修改既有断言、权限、审计、Gate、CI规则；未提交、推送或开PR；未开展独立跨模型评审；尚未获得实施授权；以下第11–13节为后续细化成果。

## 11. 精确数据、事务与访问合同（方案 A 细化，待审批）

### 11.1 两表逐字段

以下字段均 NOT NULL；没有 actor 敏感资料、自由原因、软删列或未来占位。id 用 String/@id/@default(cuid())；createdAt 用 DateTime/@default(now())、仅审计展示，不参与过期、调度或判权，沿 clock-authority.spec.ts 的 createdAt 审计列豁免，不新增时钟注册项。

| 表       | 字段                                                                                          | Prisma / SQL 类型与约束                                          |
| -------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Manifest | id、postingBatchId、activityId、settlementRunId、settlementVersionId、timeRevisionId          | String / text；关系见下一节                                      |
| Manifest | bucketContentHash、sourceSetHash、contentHash                                                 | String / text；小写64位hex；前两项等于该 timeRevision 的冻结字段 |
| Manifest | expectedEntryCount                                                                            | Int / integer，0..8000，等于源修订 bucketCount                   |
| Manifest | recognizedSecondsTotal                                                                        | BigInt / bigint，非负，等于全部源桶 recognizedSeconds 精确求和   |
| Manifest | formatVersion                                                                                 | Int / integer，当前恰为1                                         |
| Manifest | createdAt                                                                                     | DateTime / timestamp(3)，@default(now())                         |
| Entry    | id、manifestId、postingBatchId、activityId、timeRevisionId、bucketId、participationIdentityId | String / text；关系见下一节                                      |
| Entry    | categoryCode                                                                                  | String / text；四值闭集，与源桶相同                              |
| Entry    | recognizedSeconds                                                                             | Int / integer，0..2147483647，与源桶相同；零值也生成一行         |
| Entry    | entryKey、contentHash                                                                         | String / text；小写64位hex，entryKey唯一                         |
| Entry    | createdAt                                                                                     | DateTime / timestamp(3)，@default(now())                         |

无需另存 memberId/sessionId：源桶→ActivityParticipationIdentity 已经证明成员、活动、场次同链。不得为了 UI 便利复制姓名、证件或原始理由。用途是准确记账与追溯；查看者限第11.5节资格；分录、清单及源证据永久保留，退队只影响访问资格，不删账。敏感字段三问因此不引入新的自由文本或身份信息副本。

entryKey = fingerprintMetricEnvelope("participation-time-ledger-entry-key-v1", { postingBatchId, bucketId }).definitionHash（返回对象只取 definitionHash）；不修改该 canonical/hash 属主文件。contentHash 使用独立 domain，覆盖 entry 的所有业务锚点、categoryCode、recognizedSeconds，不含随机id和createdAt。manifest hash覆盖所有锚点、两个来源hash、formatVersion、预期条数、十进制字符串总秒数，以及按bucketId字典序排列的完整entry业务内容。相同源同批必相同；换批是不同分录键。哈希算法固定SHA-256，不复用D5比较指纹充当新账内容hash。

JSON 单行 recognizedSeconds 为 integer；所有汇总 recognizedSecondsTotal 和各分类合计统一为十进制字符串（含 "0"），避免接口在大数边界偷偷改类型。calculatedSeconds 不复制入账本，未知值留在源桶；sourceSetHash 包含的来源继续可追溯。

### 11.2 索引与复合外键清单

新增 unique 靶点只能在列完全相同、确有引用处使用；不得改写现有主键或删除旧索引。全部 FK 为 ON DELETE/UPDATE RESTRICT。

| 名称                                               | 表与列 / 引用                                                                                                                                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| lpb_id_version_run_key                             | LedgerPostingBatch unique(id, settlementVersionId, settlementRunId)                                                                                                                            |
| astr_id_version_run_activity_key                   | ActivitySettlementTimeRevision unique(id, settlementVersionId, settlementRunId, activityId)                                                                                                    |
| pstb_id_rev_activity_identity_category_seconds_key | ParticipantSettlementTimeBucket unique(id,timeRevisionId,activityId,participationIdentityId,categoryCode,recognizedSeconds)                                                                    |
| ptlm_batch_key                                     | Manifest unique(postingBatchId)                                                                                                                                                                |
| ptlm_id_batch_revision_activity_key                | Manifest unique(id,postingBatchId,timeRevisionId,activityId)                                                                                                                                   |
| ptlm_batch_fkey                                    | Manifest(postingBatchId,settlementVersionId,settlementRunId) → LedgerPostingBatch(id,settlementVersionId,settlementRunId)                                                                      |
| ptlm_revision_fkey                                 | Manifest(timeRevisionId,settlementVersionId,settlementRunId,activityId) → TimeRevision(id,settlementVersionId,settlementRunId,activityId)                                                      |
| ptle_manifest_fkey                                 | Entry(manifestId,postingBatchId,timeRevisionId,activityId) → Manifest(id,postingBatchId,timeRevisionId,activityId)                                                                             |
| ptle_bucket_fkey                                   | Entry(bucketId,timeRevisionId,activityId,participationIdentityId,categoryCode,recognizedSeconds) → Bucket(id,timeRevisionId,activityId,participationIdentityId,categoryCode,recognizedSeconds) |
| ptle_manifest_bucket_key / ptle_entry_key          | Entry unique(manifestId,bucketId) / unique(entryKey)                                                                                                                                           |
| ptlm_revision_idx                                  | Manifest(timeRevisionId,postingBatchId)                                                                                                                                                        |
| ptle_manifest_identity_category_idx                | Entry(manifestId,participationIdentityId,categoryCode,id)                                                                                                                                      |

两条 FK 可传递证明所有批次/版本/活动链，不再加重复的独立 activity/user FK 冒充保护。Prisma 反向关系只加在实际被引用的 Batch、TimeRevision、Bucket、Manifest 上，Member/User 不增加无用途关系。

### 11.3 SQL 约束与晚到写保护

migration 固定候选名保持第7节所列；当前追加序号预计122，以实施基线复核为准。新约束/函数名均少于PG63字节。事务内完成建表、unique/FK、CHECK和trigger；不做旧数据回填、DROP列、修改历史migration、CREATE EXTENSION或更改数据库角色。

- CHECK：ptlm_shape_check（format=1、条数范围、非负合计）、ptlm_hash_check（三hash格式）；ptle_shape_check（四类/非负秒）、ptle_hash_check（两个hash格式）。字段非空与CHECK同时存在，不能让NULL通过三值逻辑。
- ptl_deny_mutation()：ptlm_immutable/ptle_immutable 在 UPDATE/DELETE 时拒绝；ptlm_no_truncate/ptle_no_truncate 为 BEFORE TRUNCATE statement trigger，始终拒绝。SQLSTATE 23514 +稳定constraint名，不输出业务原文。
- ptl_manifest_insert_guard()：AFTER INSERT、REFERENCING NEW TABLE，按postingBatchId稳定排序锁batch FOR UPDATE，检查preparing、确切submitted修订、hash/条数/合计与源一致；不得插入draft manifest。多批次插入也按同一序处理。
- ptl_entry_insert_guard()：AFTER INSERT、REFERENCING NEW TABLE，集合取得批次并按同序锁batch，要求preparing；同链/分类/秒数交给复合FK，禁止8000行各查一遍源桶的应用N+1或逐行触发器查询。
- ptl_batch_visibility_guard()：BEFORE UPDATE OF statusCode，只有本批次有manifest或该settlementVersion存在submitted分类修订时介入。进入ready/committed必须有唯一manifest及完整源桶集合，按源bucketId反连接证明无缺失/多余，求和一致。晚到INSERT拿不到batch锁，待状态已变后拒绝。
- 旧历史批次没有分类来源则不新增分类业务拒绝；已有committed历史批次不补manifest。不得用“查询不到manifest”作为忽略已有submitted分类来源的理由。
- 服务还须重算内容hash；DB的集合与FK证明不冒称校验了应用canonical算法。unique冲突只允许捕获指定键，失败后在有效事务/保存点中重读；禁止在已abort的PG事务里继续查询，禁止笼统吞P2002。

### 11.4 真实调用链和落点

| 路径                                                                              | 分类处理落点                                                                                              | 不变部分                                            |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| worker.enqueuePreparingBatches → ensurePrepareJob                                 | 第一次任务建立，在batch锁内冻结manifest；已有任务重放比对来源，缺失不能直接返回成功                       | 保留operationKey、availableAt=now+1与两轮消费语义   |
| worker → prepareChunk(job,item,fence)                                             | job/item/batch现有锁与fence之后，按该块result identities集合批量写分类分录；成功标记之前同事务完成        | chunk成员大小、原贡献/日拆分、基线、item计数均不变  |
| worker → finalize                                                                 | 原ready写入前复验manifest完整；遗漏、同计数错集合、未知分类均拒绝                                         | 保留原failed/ready协议与重放，不增加状态            |
| LedgerReadyBatchCommitter → commitBatch → commitBatchWithin → commitBatchProtocol | 分类来源检测/当前操作者校验放在committed重放出口之前；所有等待之后再次复验，再与旧账同事务可见            | 原member锁、日上限、outbox、audit最后一步与事务预算 |
| CorrectionApplicationService.prepare                                              | 锁后、resumable返回和创建替换版本/claims之前，拒绝baseSettlementVersion对应已有分类manifest               | legacy更正仍按原流程，原断言不动                    |
| CorrectionApplicationService.commit/apply                                         | materializePendingSegments与重放出口之前检查同一base分类保护；公共commit再按CorrectionApplication来源复验 | 不创建D7负分录，不借“内部调用”绕过保护              |
| LegacyLedgerConversionService → commitConvertedBatchWithin                        | 公共协议检查conversion=true时不得带分类manifest或submitted分类来源                                        | 保留旧转换SOP、窗口与旧audit，不猜分类              |
| 新GET → ParticipationTimeLedgerQueryService                                       | 复用read资格，锁定指定revision/committed batch，读取不可变manifest与分页                                  | 不切旧LedgerQueryService或D5 shadow                 |

worker实际调用位置由 activity-batch.worker.ts:421 的 ensurePrepareJob 链和其 prepareChunk/finalize 引用核验；不为新依赖修改worker编排本体。DI需要在 ActivitiesModule、ActivityBatchWorkerModule 同时提供新增service/access/policy依赖，独立worker启动测试必须覆盖。调用链内新增检查只纳入已有父锁方向；不得从持有Batch锁的分类helper反向锁Activity/Run。

桶中的identity集合必须是该settlementVersion结果identity集合的子集，且所有预期桶都覆盖；按member分块不能把同一成员多个identity合并。未知身份、重复分块或遗漏分块拒绝进入ready，不截断。

### 11.5 分类批次当前资格补全

当前事实：ledger-posting.service.ts 的 commitBatchProtocol 在锁完batch后直接处理committed重放，没有在该函数内查询当前actor权限。不能把它写成“已有当前权限复核”。本刀建议仅补**有分类来源/manifest**的分支；全量legacy鉴权重构不在本计划。

新增 ParticipationTimeLedgerAccessService：

- loadActiveUserIdentityInTx + AppIdentityResolver，要求当前User ACTIVE、Member ACTIVE、App准入；停用/软删拒绝。
- 当前actor必须等于该确切settlementVersion的final/approve决定actor；角色名称不替代审核决定。
- 在当前事务中获取 activity.settlement-final-review.record 的显式组织scope，校验活动组织当前资格，authz.can(actor,code,{type:'attendance_settlement_version',id},tx) 执行自审/同人审核限制；不赋予新权限、不默认授予内建角色。
- 初次提交、committed重放都要校验。沿batch所绑定version而非run最新version查询资格，避免后续版本污染历史重放。
- Activity/Run/Version/Batch锁等待后先校验；member/day-state等后续等待后、真正写入之前再校验。这里保证“锁后当前事实”，不声称把权限撤销事务与账本提交完全串行化。
- 失败UNAUTHORIZED/FORBIDDEN沿原通用码；GET沿原read面20219防枚举。新增检查只补分类分支，legacy流程原样返回；独立新测试证明撤权/变更组织/失效成员/伪造actor/重放均不绕过。
- 已无资格的final actor不能让worker自动换一个人代签；任务保留并报告拒绝，业务重新审核/更正恢复不在D6自动完成。

权限说明中“冻结分类桶及证据”不能静默涵盖正式账本。拟同步 permission-catalog.ts 的 time-settlement.read 说明为“冻结分类桶、证据及其已提交分类时长账本”；权限码、角色默认授予和风险档位不变。此语义扩展纳入本次D档审批及4b摘要复核，而不以数量265不变为免审理由。

### 11.6 固定错误分支与DTO

新增候选码在当前biz-code文件未占用；实施前再次查重。只在准确新含义处使用，不更改旧码message/HTTP：

| 名称                                        | code / HTTP | message与条件                                                              |
| ------------------------------------------- | ----------- | -------------------------------------------------------------------------- |
| ACTIVITY_TIME_LEDGER_SOURCE_INVALID         | 20226 / 409 | 分类时长账本来源不完整或不一致；draft/legacy_unclassified/源hash及集合不符 |
| ACTIVITY_TIME_LEDGER_CONTENT_CONFLICT       | 20227 / 409 | 分类时长账本幂等内容冲突；指定唯一键同键异内容                             |
| ACTIVITY_TIME_LEDGER_NOT_READY              | 20228 / 409 | 分类时长账本尚未准备完整；ready/commit前缺分录或manifest                   |
| ACTIVITY_TIME_LEDGER_CORRECTION_UNAVAILABLE | 20229 / 409 | 分类时长账本更正尚未开放；D7前classified correction                        |
| ACTIVITY_TIME_LEDGER_REFERENCE_UNAVAILABLE  | 20230 / 404 | 分类时长账本不存在或不可访问；GET跨链/无committed批次                      |

格式参数仍BAD_REQUEST；超过规模复用20225；旧Gate/只读维护窗/ledger状态/日上限/锁槽/终审错误原码透传。SQL约束错误仅将具名ptl约束映射到对应新码，其他异常不伪装为幂等成功。GET宣告20230/20225及通用401/403/400；内部worker失败码按明确分支留存安全摘要。

新增DTO固定为 AppTimeLedgerCategoryTotalDto、AppTimeLedgerEntryDto、AppTimeLedgerPageDto、AppTimeLedgerReportDto（四个）。Report包含postingBatchId、manifestId、timeRevisionId、formatVersion、contentHash、entryCount、recognizedSecondsTotal、categories、resultPage。Entry只含id/bucketId/participationIdentityId/categoryCode/recognizedSeconds；Page沿标准page/pageSize/total/items。四类汇总固定顺序含零，页按identity/category/id稳定排序；没有createdAt作为账期，不返原始理由。

## 12. 最终待审批写集与测试清理闭包

第7.1–7.3节68条全部保留；加上下方两块后去重构成**唯一实施写集**，没有通配符。修改理由随组列出；它是待审批范围，不意味着本轮已获红区、测试或实现权限。

### 12.1 新发现的必要连接点

```text
src/modules/activities/participation-time-ledger-access.service.ts
src/modules/activities/participation-time-ledger-access.service.spec.ts
src/modules/activities/correction-application.service.ts
src/common/exceptions/biz-code.constant.ts
src/modules/permissions/permission-catalog.ts
docs/ai-harness/RBAC_MAP.md
test/setup/reset-db.ts
test/setup/time-ledger-fixture-cleanup.ts
test/e2e/activity-os-r4-d6-time-ledger-fixture-cleanup.e2e-spec.ts
```

权限说明生成RBAC_MAP；新的helper只在test/setup，由四重边界控制，不成为生产公共工具。clock-authority仅createdAt无需改；seed无新增码不改；audit沿既有posting事件、原payload和replay不重复语义，不加event；不手改生成RBAC_MAP。

### 12.2 局部TRUNCATE关联测试（保留SQL目标与全部断言）

静态检查从Prisma的实际FK方向沿TRUNCATE CASCADE传播到Activity/Run/Batch/TimeRevision/Bucket，再逐个定位执行语句，不能只搜索新表名。命中行数不是文件数，部分文件同时已在19份迁移计数列表中；最终去重计数见第13节。

```text
test/e2e/activity-batch3-1p5-schema-constraints.e2e-spec.ts
test/e2e/activity-os-r1-a2-template-family-version-schema-constraints.e2e-spec.ts
test/e2e/activity-os-r1-a3-template-definition-lifecycle-guards.e2e-spec.ts
test/e2e/activity-os-r1-a4-explicit-template-version-pointer.e2e-spec.ts
test/e2e/activity-os-r1-a6-from-template-transaction.e2e-spec.ts
test/e2e/activity-os-r1-a7-series-generation.e2e-spec.ts
test/e2e/activity-os-r2-b3-form-blueprint-governance.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2a-metric-catalogue-concurrency.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2a-metric-catalogue.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2b-authz-transaction.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2b-creation-compatibility.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2b-metric-selection.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2b-selection-concurrency.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2b-template-catalogue.e2e-spec.ts
test/e2e/activity-os-r3-c1-metric-definition-set.e2e-spec.ts
test/e2e/activity-os-r3-c3-1-candidate-concurrency.e2e-spec.ts
test/e2e/activity-os-r3-c3-1-candidate.e2e-spec.ts
test/e2e/activity-os-r4-d1-1-time-policy-foundation.e2e-spec.ts
test/e2e/activity-registrations-audit-characterization.e2e-spec.ts
test/e2e/activity-registrations-state-transition.e2e-spec.ts
test/e2e/audit-logs-migrations.e2e-spec.ts
test/e2e/members.e2e-spec.ts
test/e2e/notifications-participation-producers.e2e-spec.ts
test/e2e/organizations-concurrency.e2e-spec.ts
test/e2e/organizations.e2e-spec.ts
```

清理helper合同：

1. 必须先复用 assertTestDatabaseUrl 和 assertConnectedTestDatabase，确认连接实际库；本地只用后续获准的app_test_w98，CI沿既有worker派生隔离。
2. 仅在同一连接的事务内，对存在的新两表暂时 DISABLE 两个具名no_truncate trigger；执行调用者原有静态TRUNCATE，恢复原trigger状态后提交。禁止DISABLE ALL、session_replication_role、跳过其他immutable触发器或全局guard。
3. 参数不是任意SQL字符串执行器。调用点传已有Prisma事务callback；raw迁移测试的同连接SQL批次使用同样的固定表/trigger名单与真实库保护。必须证明没有切换连接；本helper不负责创建、删库或生产修复。
4. 新表不存在的旧schema不发ALTER语句；一张存在另一张不在须按实际存在集合处理，不能把其他查询异常当不存在。任何失败事务回滚恢复trigger，测试故意注入失败并核验pg_trigger状态。
5. 非CASCADE的D1-1时长地基清理在原表清单前显式加新两表（仅表存在的当前schema），不删原清理项、不扩大到其他业务表；其他局部语句保留原目标、RESTART/CASCADE及后续fixture。
6. shared resetDb 的两道安全检查保留，原TRUNCATE静态字面量仍留在reset-db.ts，兼容A7对清理清单的结构检查；只包事务与具名trigger处理，不搬走清单、不降低断言。
7. 整套临时豁免仅属隔离测试夹具的重建技术步骤，生产trigger始终开启。若现有测试必须改变行为断言才通过，立刻停止，不能以此清单授权为由弱化业务合同。

### 12.3 19份迁移回放的精确适配

- 15份使用CURRENT_MIGRATION_COUNT=121，改为新基线当前总数；它引用的“current/all migrations”标题自动随常量，另显式更新C1 D2b的裸121标题。
- D1-1 migration:124、D1-3 selection migration:167/174、D3 migration:546/553、D4 migration:507/510/612 是裸计数或标题；仅current回放/结束恢复读数改121→122，D4原四张表的历史断言仍然是四张，不能改成六张。
- 历史升级目标的112→113等、旧migration文件/checksum及旧schema夹具均保留。新表增加引用但不增旧表必填列，不要求用新Prisma客户端往旧schema写新字段。
- C2 D2局部TRUNCATE只覆盖Outcome链，未沿FK到新时长账，不为凑闭包把其六表清单再次扩大。
- 对旧表所有unique靶点是additive冗余键；依赖“当前unique总数”的既有断言若真实受影响，不能静默改数，须附实际diff补审。新migration测试明确核验新增键名与旧键仍在。

### 12.4 必跑但不修改的characterization

activity-ledger-posting、activity-ledger-posting-concurrency、activity-ledger-posting-scale、activity-ledger-commit-scale-tiers、activity-batch2-8a-auto-commit、activity-batch2-9b-ledger-read、activity-settlement-correction、activity-service-segment-correction-lifecycle、activity-service-segment-correction-concurrency、legacy-ledger-conversion、activity-settlement-review、activity-settlement-review-concurrency 十二份现有E2E，是读取/执行范围，不是额外写权限。worker独立启动、lease丢失、自动提交两轮语义必须保留。

schema/permission/error/common接线属于枢纽影响；本地quick和授权w98定向、完整contract，PR CI执行agent:check:full；不在本机重跑全量E2E。运行前再次核验测试URL指向w98，迁移rehearsal清空只限测试夹具，不自动执行prisma migrate dev/reset/db push。

## 13. 下发条件、签字与本轮验证

本轮逐块抽取并去重：102条列举、98个唯一精确路径；harness:needs 逐路径预算为11个红区、87个非红区。25份局部TRUNCATE关联测试中4份已在19份迁移测试清单内，不能重复计数。现有文件均已核验存在；新增路径逐项标为待创建，不冒称已实现。本轮实际仍是4份Markdown，未执行任何grant。

治理具体口径：Manifest/Entry归activities领域；Entry.categoryCode登记为四值闭集L1 inventory、not-derived的不可变配置，不新增生命周期或升级governed。更新domain-map/state-machines的真实schema输入摘要与STATE_MACHINE_INVENTORY；格式版本1是序列化版本，不登记成状态机。新的GET预计634→635端点、当前read管辖面6→7；只有最终生成结果和契约证明才可登记为事实。数据库migration数和权限/审计目标同理。

本稿已将初稿六类空缺细化为字段/FK/SQL名、全部提交入口、分类资格、错误分支、DTO、具体测试和写集。此为**待审批的完整实施方案**，不是已批准的实现。未知代码生成摘要、SQL最终checksum和运行预算只有实施后才能实测，不能在计划中编造通过证据。

新增schema预计121→122；3b须按最后实际migration内容重签。权限码仍265、审计仍169总计/164活跃是计划不增量目标，不是本次实测新增后读数；time-settlement.read正式账本说明扩展需4b语义摘要审核。新错误五码会影响BizCode和契约计数，刷新生成物不得改守护基线去强行放过真实违规。国家/组织权限与原终审访问规则不因读权限范围变更而扩授。

建议单个D6 implementation包按“schema与纯policy→worker准备与提交保护→GET→兼容测试/生成物→全量CI”串行实施，仍只处理分类时长一条业务轴；不是拆成多个无人授权的小任务。最终授权须同时覆盖第7及第12节去重写集、五个错误码、分类actor复核、D7前拒绝、具名测试trigger临时处理、权限说明、w98与提交推送边界。若不接受其中任一业务限制，先改计划，不开工后再选。

本轮没有对新TRUNCATE触发器、actor拒绝或新错误码做运行验证，因为代码尚不存在；文档检查不能替代这些验收。只保留四份Markdown改动，不提交、不推送、不创建PR、不操作数据库、不启用Gate。计划评审PR也需下一条明确授权，changelog未在本轮写入。

## 14. Implementation 阶段验证记录（未完成，不代表交付）

维护者补充授权：允许扩展 `scripts/check-boundaries.ts`、`scripts/harness-guards.selftest.ts`，仅识别 `ParticipationTimeLedgerEntry.categoryCode` 并补正反例；不泛化其他字段、不放宽门禁。两份维护者本地授权已核验，原98路径加这两项形成100路径实施范围，其余禁止域不变。此前第7/12/13节98路径读数保留为原计划历史。

该扩展验证通过：`harness-d6-final.log` 三组自检分别553/138/68项通过、零失败；前两组仍分别报告1/5项已知缺口，不能合并成同一种行为覆盖保证。新增D6正例及四个负例均实际执行检查器。元数据、授权路由、权限说明管辖面、客户端新鲜度和CODEMAP检查通过；CODEMAP保留2条WARN及1条INFO。状态登记实测72项（8 governed、64 inventory），只增L1不可变配置；read权限管辖面6→7，说明已同步且基线只变该码。没有新增角色授权、生命周期或状态边。

以下是维护者批准完整实施包后的本地工作树证据，不回写第13节计划起草时的历史事实。全部数据库运行限定 `app_test_w98` 测试夹具；尚无最终提交 SHA、D6 PR 或生产验收。

- D4 当前全量回放计数更新为122；维护者另行批准以 `names[120]` 锚定原第121条D4 migration，历史120→121升级的计数和内容断言保留。D4/A7定向复跑2套12项通过；此前一次A7失败发生在夹具清理5秒事务超时，复跑未复现，未调整超时或业务断言。
- D6 policy/service/query 三套单测30项通过。1/100/2000身份、至多8000桶验证的是纯计算完整性、确定性与边界，不等于数据库G11性能验收。
- 新D6真实来源、准备与提交E2E通过；涵盖四类含零秒桶、ready不可见、同批重放、伪造终审actor、当前用户停用/成员失效、提交后撤权拒绝重放。读取资格绑定实际历史版本，并在批次锁后复核；单测的锁后撤权不冒充真实并发撤权证据。
- 分类提交最后一步审计故障注入后，批次、run、结果revision和日汇总逐行与提交前相等，HTTP仍404。双连接提交用独立事务持有批次锁，并通过 `pg_blocking_pids` 确认实际阻塞；释放后仅一次生效、一次重放。该证据不是worker租约恢复证据。
- 两张新表UPDATE/DELETE被23514拒绝且内容不变；具名TRUNCATE保护及同事务临时关闭后恢复、失败回滚恢复的测试通过。尚未以此宣称所有跨锚点与晚到INSERT并发负例完成。
- 本地日志位于 `/tmp/srvf-d6-tests.618UPL/`：`compatibility-recheck.log`、`unit-expanded.log`、`classified-immutability.log`、`classified-lock-barrier.log`。临时日志不是永久验收归档；最终PR须按最终源码重新整理可复现证据。

后续补证：`classified-completeness-final.log` 5项真实数据库E2E通过（30.369秒），每项重建独立夹具。缺一条分录在finalize得到20228；同数量但contentHash错误或entryKey错误分别得到20227；秒数与原桶不符由复合外键P2003拒绝，分块分录为0且preparedCount保持0。前三项坏账均仍preparing且HTTP不可见。故障数据通过测试替身写入真实数据库，未关闭任何完整性触发器；这不代表正常生产写入会生成此类数据。

同轮真实锁后撤权证据：独立连接持有成员advisory lock，提交已通过首次授权并实际等待（`pg_blocking_pids`确认）；此时撤销终审人的显式角色绑定，释放锁后提交403，批次及日汇总与之前逐行相同。恢复仅限测试夹具。它覆盖角色撤权，不冒充停用/组织变化在锁等待期间的并发覆盖。该轮测试类型检查和定向lint通过。

准备任务补证：`classified-worker-recovery.log` 定向正常路径1项通过、其他4项未重跑（10.025秒）。旧leaseOwner/leaseGeneration在首次写入及成功item重放时均被拒绝；当前代际重放分录逐行不变。测试再构造“最后一个分块已提交、processing任务租约过期”的持久状态，真实 `ActivityBatchWorker.drainOnce` 领取新代际并收尾到ready，分录逐行不变且不自动提交。这里没有启动/杀死独立进程，不能据此宣称独立进程崩溃恢复全部完成。

自动提交补证：`classified-auto-commit.log` 定向1项通过。使用真实worker类和真实committer，仅测试实例启用autoCommit；最后审计失败后同一job退回pending、batch保持ready、日汇总为0，按该job的availableAt推进下一轮后成功committed，四条分类分录逐行未变，GET总秒数3600。未改生产配置或部署Gate。测试收尾已改用公开onModuleDestroy接口，类型复查通过。

契约补证：`contract-full.log` 完整1063项及2个快照通过。635路由为原634加一个ledger GET；快照仅新增429行（264行路径、165行四个DTO），逐项核对无旧路径/字段删除或改写。scope仍Human App，四分类闭集、汇总十进制字符串、分页上限及错误码与实现一致。此次本地通过仍不代表最终SHA CI、handoff客户端或其余派生物已完成。

可见性补证：`classified-invisibility.log` 两项独立真实HTTP负例通过（21.949秒，其余6项未重跑）。各自在完整四条分录已准备后构造failed/voided测试状态，GET均返回404/20230且data为null；不新增状态切换接口。此前已覆盖preparing/ready不可见及committed可见，历史版本不受后续latest污染的HTTP证据仍待补齐。

全仓lint首轮因Node默认堆上限耗尽以134退出，不计作代码检查通过；按现有CI的 `NODE_OPTIONS=--max-old-space-size=6144` 在本地重新运行后退出码0，日志 `d6-lint-6144.log`。未修改工作流或lint规则；后续新增源码仍须继续复查，不把该次结果当作最终SHA证据。

历史版本补证：`classified-historical-counterexample.log` 正常链路定向1项通过（10.585秒，其余7项未重跑）。给原终审人显式read权限后，先读取已提交分类账本；再创建由其本人起草的后续版本并推进currentDraftVersion。对照断言证明按latest判read资格会返回20219，但明确旧timeRevisionId的HTTP仍200，响应data逐项等于后续版本出现之前。该场景证明历史指针和实际版本资格不被latest污染，不提供任何真实业务的人工改版本入口。

更正入口补证：`classified-and-legacy-correction.log` 三套35项全过（56.697秒），包含D6八项、具名清理三项及原更正24项，均在w98运行。新增测试显式授予既有GLOBAL终审权限，先确认更正内容解析合法，再调用真实prepare和commit，均返回409/20229，批次、run、日汇总、分类分录和申请逐行不变。另在事务内构造满足延迟约束的更正应用与准备收据，通过共享内部commitBatchWithin尝试已提交批次重放，同样409/20229，事务回滚且未留下应用。没有关闭约束或修改生产代码；这补齐G9入口证据，不代替最终SHA全量CI。测试类型检查及定向lint退出码0。

迁移补证：`d6-migration-rehearsal.log` 两项通过（18.905秒）。w98从空库回放122条，逐条核对磁盘SQL SHA-256与迁移登记；121条旧schema下建立非空旧贡献账本、审核、日汇总、批次、版本、run、结果夹具，七表行数分别2/2/1/1/1/1/1。应用第122条后，这七表按id排序的完整JSON逐行相等、前121条checksum不变，两张新表为空。夹具直接构造历史数据，不冒充旧业务流程端到端验证；原流程另有回归证据。测试结束已重建并恢复当前122条schema，不触及其他库；新增测试类型检查及lint通过。

跨锚点补证：`classified-cross-anchors.log` 九个独立用例通过（60.276秒）。每例建立两条真实来源链，先验证正确组合可INSERT并主动回滚，再只替换一个引用。分录覆盖batch/activity/timeRevision/identity/category，清单覆盖settlementVersion/run/activity/timeRevision，错误均为复合FK的P2003，原清单不变、无残余分录。替换ID真实存在，分类取另一合法值，不用不存在ID或非法枚举冒充同链验证。

晚到INSERT补证：`classified-late-insert.log` 两项通过（12.526秒）。清单和分录分别做成功写入后回滚的正对照；独立连接持批次锁并改为failed，实际插入通过pg_blocking_pids确认阻塞，释放后均23514拒绝且无残留。没有唯一键冲突代替批次状态检查，没有放宽约束。该证据覆盖退出preparing到failed时的晚到写入，不冒称ready/committed状态的独立并发场景；后两者已有完整性/可见性测试。类型检查、定向lint与diff空白检查通过。

本轮合跑：`d6-all-current.log` 三套24项全部通过（129.796秒），覆盖当前19项准备/提交/关联/并发用例、3项具名清理和2项迁移。该次为同一工作树源码下串行w98执行，无跳过项；CODEMAP检查零失败，保留既有2条WARN、1条INFO。它不是全仓E2E或最终SHA CI。

错误映射补证：清单/分录写入、finalize批次ready写入、普通及转换内部commit协议，仅捕获本次具名ptl约束；唯一键字段按具体写入对象精确匹配。未知错误、其他约束及死锁原样抛出，不重试、不返回成功。三套D6单测47项通过（含service 24项）；真实分录FK故障通过实际prepareIdentities写入，被映射为409/20226，分块回滚且preparedCount为0（`constraint-mapping-real-db.log`，1项、8.376秒）。源码和测试类型检查、定向lint、CODEMAP检查通过。

本轮旧链回归保留失败事实：`error-mapping-regression.log` 六套86项中79通过、7失败（174.554秒），失败均在beforeEach/beforeAll的resetDb五秒事务，未进入业务断言。D6三项实耗8.998–13.740秒，旧并发套初始化5.092秒；现场w98无阻塞连接，不据此断言超时根因已定位。结果结束后Jest因残留连接不退出，显式停止本轮PID12499，runner退出143。原超时/断言不变，随后对同7项单独复核全过（`constraint-isolated-recheck.log`，25.728秒，其余17项跳过），不能将79+7称为一次全绿合跑。另发现`test/helpers/activity-time-policy.fixture.ts`在createTestApp之后resetDb失败无app.close兜底；该既有helper不在写集，未修改，后续如修复须补精确授权。

锁后资格补证：`current-eligibility-wait.log` 三项通过（21.849秒）。与既有角色撤销场景使用同一真实成员锁屏障，分别在确认提交请求实际阻塞后停用终审User、使其Member失效、停用活动Organization，释放锁后分别401/403/403；批次、日汇总、run和结果revision逐行不变。仅测试夹具变更，未改生产判权逻辑或超时。

同计数集合补证：`equal-count-bucket-set.log` 新反例通过。先以四条正确分录INSERT成功并回滚，再将其中一条bucketId替换为另一真实活动同分类的合法桶，仍四条且bucketId互异；真实批量INSERT被复合FK的P2003拒绝，四条全部回滚，manifest逐行不变、preparedCount为0、HTTP不可见。同次正常链前置D4 prepare返回500，原因为未知（未到D6）。新增固定字段诊断只记Prisma错误码/类型和是否过期事务，不输出SQL、ID或原始message；`normal-chain-prepare-diagnostic.log` 单独正常链复核通过（8.947秒），不据此宣称该500根因已解决。类型、lint及diff检查通过。

上述四个新增场景在保留诊断的最终测试源码下再次合跑全过（`eligibility-and-set-final.log`，25.393秒，其余20项未重跑）。这不抵消上面的偶发失败记录。

访问单测补证：新增计划中`participation-time-ledger-access.service.spec.ts`，14项验证每项调用透传同一tx与历史version、再次调用重读当前身份、成员失效、缺失/错误actor/退回/重复终审、组织缺失/停用/root、缺失活动、无权限/跨组织、GLOBAL仍执行版本资格判定。DI测试替身只模拟当前访问服务边界，显式断言实际查询参数，不冒充PostgreSQL或并发证明；后者见上文真实w98证据。四套D6单测共61项合跑通过（`d6-four-unit-suites.log`，1.389秒），测试类型检查及lint通过；CODEMAP已刷新并通过检查，保留既有2条WARN、1条INFO。

G11开始真实数据库分档验收：新增1/100/2000身份用例，复用既有D5满额来源构造方式，实际执行分类prepare/submit、worker分块及finalize、commit与GET；保留原查询预算断言。1/100档均到达正式读取，commit总查询均85次、耗时分别86/149毫秒，但新增查询预算6次断言失败（`scale-one-actual.log`、`scale-100-isolated.log`）。初次仪器记录新增55次，其中授权44次；随后发现漏计`assertNotClassifiedCorrectionBatch`，已补计量，该55次不作为最终新增查询结论。没有删除二次授权或集合核验来满足预算。

2000档首次已构造满额来源并运行worker，在finalize批次ready更新时报5000毫秒事务过期（实耗10087毫秒，`scale-2000-isolated.log`，整例59.546秒），未到commit/GET。新增脱敏逐步SQL次数及耗时采集，并在失败收尾输出已经完成步骤；不输出SQL参数或业务ID。首次带诊断复测又在resetDb夹具初始化超时（9438毫秒），未进入D6；结果结束后显式停止残留测试PID18638，runner退出143（`scale-2000-timing.log`）。该失败不计作业务性能结果，也不宣称环境根因已解决。当前测试类型检查及定向lint通过；未调整生产事务预算或业务断言。

2000档带逐查询耗时复测再次在finalize失败（`scale-2000-timing-recheck.log`，整例78.065秒）：ensure 362毫秒，四个chunk分别622/621/586/656毫秒，各新增6次查询；finalize 9539毫秒，新增5次查询，但事务过期，未到commit/GET。只输出次数与毫秒，不输出SQL文本/参数。随后增加仅含SQL首词与相对时间的时间线；该轮又在resetDb前置5700毫秒超时，未进入D6（`scale-2000-timeline.log`），终止已结束但残留连接的测试PID19359，runner退出143。未将反复重跑未复现误写为修复，最终耗时归因仍待完成。

验证命令更正：一次类型检查误用不存在的`test/tsconfig.json`，TS5058且不计通过；使用实际`test/tsconfig.test.json`重新执行，`scale-timing-types-current.log`退出0。最新时间线源码的类型检查及定向lint串行`&&`执行同样退出0（`scale-timeline-types.log`、`scale-timeline-lint.log`），diff空白检查通过。

满额保留夹具诊断：确认w98无其他连接且保留8000分录后，不重建夹具，READ ONLY事务执行实际`assertComplete`返回true、243毫秒（`readonly-assert-complete.log`）；对应集合查询EXPLAIN ANALYZE为21.044毫秒，原migration的PL/pgSQL条件块只读执行12.472毫秒（`readonly-visibility-block.log`）。这不证明刚写入数据时的查询计划或负载相同，不能据此排除SQL性能问题。

在同一保留夹具上调用真实finalize，以外层默认5秒事务承载原回调并强制回滚：tsx对照到ready耗时273毫秒（`finalize-rollback-diagnostic.log`），独立Jest诊断到ready耗时412毫秒、1项通过（`finalize-jest-diagnostic.log`，整套1.409秒）。测试实例Gate放行仅用于w98隔离操作，未更改任何部署配置；回滚后未保留ready状态。该对照没有执行整条满额准备链，不能替代失败的G11验收，也尚未确定测试运行方式、刚写入后的数据库状态或其他负载哪项是根因。未动未获扩展授权的fixture helper，未加大任何超时。

维护者补充批准`test/helpers/activity-time-policy.fixture.ts`，仅关闭初始化失败后的应用和连接，不改断言或超时；原100路径扩为101路径。`harness:needs`判定该路径不需红区令牌。实现只为既有初始化体增加try/catch，失败时await app.close并重抛原错误；若关闭亦失败，用AggregateError保留两项错误。忽略缩进后的diff确认成功路径无改动。真实应用故障注入覆盖reset失败及首个用户创建失败，两项均核验app.close与Prisma.$disconnect各调用一次、原错误对象保持；`helper-cleanup-failures.log`两项通过、其余三项未跑，4.684秒且进程正常退出0。类型检查与定向lint通过。该修复解决失败收尾，不宣称解决原事务超时。

失败收尾修复后满额复测仍在finalize失败，但runner正常退出1、无手动终止（`scale-2000-after-cleanup.log`，69.893秒）。时间线显示四个分块各639–693毫秒；finalize在344毫秒完成任务UPDATE，随后ready更新未成功完成，ROLLBACK于9758毫秒返回。不能将该失败归为已解决。随后复制8000分录/16000桶到仅限w98会话的临时表，保持索引并执行原集合条件块，冷统计48.553毫秒、显式ANALYZE后38.414毫秒，最终全部ROLLBACK（`visibility-cold-statistics.log`）。该对照未复现9秒耗时，不能确认“统计未更新”根因；没有修改正式表统计或生产SQL。

共享夹具修复后的成功路径回归：`helper-success-and-cleanup.log`两套定向共6项通过（正常完整分类账本链1项、初始化失败清理2项、具名触发器清理3项），11.696秒，其他26项未跑；runner正常退出0。类型、lint及diff检查通过。它验证本次失败清理改动未破坏该正常链与既有清理断言，不替代G11满额失败或全量E2E。

ready执行计划采集尝试两次均在初始化resetDb超时，未到临时诊断SQL（`scale-ready-explain.log`、`scale-ready-explain-recheck.log`，20.214/23.471秒，均正常退出1）。临时诊断钩子已完整撤去，未留下额外UPDATE、预热步骤或新的测试超时设置。直接调用现有resetDb并采集查询时间线，在同一w98完成一次真实夹具清理：TRUNCATE 3001毫秒，事务提交前3120毫秒，总3258毫秒，其余前置SELECT/ALTER单条1–8毫秒（`reset-query-timeline.log`，退出0）。这表明默认5秒清理事务余量较小，但不证明每次20秒失败均由同一原因造成，也不解释ready业务更新超时。

待维护者审批的清理预算方案（本段仅提案，未实施）：仅`test/setup/reset-db.ts`，将包裹现有具名触发器关闭、原TRUNCATE及恢复的测试事务显式设为30秒；不改业务事务5秒、不改测试断言、不改触发器清单或目标库校验、不重试失败事务。验证仍仅w98。原因是该事务承载全表测试夹具清理而非业务性能要求；先稳定初始化，才能继续采集满额业务失败现场。当前文件仍保持默认5秒。

维护者随后明确批准上述清理预算方案。已核验本工作树原D6精确路径令牌覆盖`test/setup/reset-db.ts`；新增的语义仅为该清理事务`timeout: 30_000`，目标库校验、原TRUNCATE和具名触发器恢复均不变，未改业务事务。类型检查及定向lint退出0。`scale-2000-reset-budget.log`已通过初始化和满额分块，仍在finalize的ready更新触发原5秒业务事务过期（69.407秒，正常退出1），不宣称本次清理调整解决业务性能。同期一次限时只读活动查询采样未命中在执行语句，不能以零采样证明没有慢查询。

刚写完满额分录后的实际ready UPDATE执行计划已采到（`scale-ready-explain-with-cleanup-budget.log`）：总执行8981.476毫秒，唯一报告的`ptl_visibility_guard`触发器8980.262毫秒、调用一次。诊断UPDATE全部回滚，随后原业务finalize仍过期；不把该轮视为性能验收。与稍后独立对照不同，该证据直接覆盖满额写入后的慢现场。临时诊断钩子已撤去。

在原已授权第122条D6 migration内，将两侧相关NOT EXISTS集合检查等价改为EXCEPT双向集合差异；数量和总秒数校验、过滤锚点、唯一键、FK及拒绝错误保持不变，没有提高业务超时。`d6-except-migration.log`冷回放及非空旧数据升级两项通过（21.392秒），结束恢复新SQL的w98；新摘要仍需最终3b签字。新增缺分录直接UPDATE ready的数据库拒绝断言，并继续真实满额验证，尚不据迁移通过宣称性能修复完成。

EXCEPT改写后的首次完整2000身份链已到达正式GET（`scale-2000-except-validation.log`）：worker3698毫秒，四分块各697–1048毫秒、额外6次SQL；finalize399毫秒、额外5次；commit1558毫秒、总85/额外56次；GET58毫秒、总31次，8000条结果及分页断言通过。缺分录的直接ready UPDATE反例也通过，数据库返回23514且原业务拒绝断言保留。整套1通过/1失败，失败仍是原commit额外SQL≤6预算（实际56），并非本轮事务超时；不得记为整套通过。此轮已移除临时EXPLAIN/UPDATE预热钩子。新的migration SHA-256为`2a5249bcf8bd1932411ab0faea2f1df784609590b2570e7984e5e7dd7ece4037`，尚未重签3b。

同源码及改正后的计量，1/100身份各到达GET后因同一预算断言失败（`scale-1-100-except-validation.log`，16.767秒）：commit总85/额外56次，权限复核占44次，耗时97/170毫秒；finalize12/32毫秒、额外5次；GET26/34毫秒、总31次。三档新增查询数均固定56（权限44、分类账本核验及更正保护12），尚不证明更复杂授权数据下的最坏分支。最新类型检查及定向lint通过；成功阶段只输出紧凑计数和耗时，逐查询时间线仅在未完成步骤的失败诊断中保留。

待维护者审批的G11提交查询预算更正（仅提案，未改断言）：commit新增SQL上限6→56，同时增加完整提交业务SQL总数≤85；事务控制语句及单独记录的SELECT 1健康探针不算业务SQL。保留两轮当前权限和完整集合校验，不扩大权限、不缓存身份、不改SQL/事务边界来规避计量。chunk/finalize额外≤8、GET≤120和原业务耗时/事务限制全部保持。批准后须在1/100/2000档及权限负例复验，不凭本段提案记作通过。

维护者已明确批准G11提交查询预算更正：新增≤56、总业务查询≤85，两轮权限和完整性复核及其余预算/断言/禁止域不变。测试已更新该阈值并新增总数上限；事务控制语句及单独计量的健康探针不计入业务SQL，真实权限查询全部计入。开始对三档容量、正常链、全部现有D6权限/完整性反例及清理测试合跑，未以旧失败记录代替新预算验收。

新预算首次合跑（`d6-approved-budget-full.log`，213.752秒）：两套32项中31通过、1失败。1/100身份分别commit72/177毫秒，均额外56/总85，GET26/25毫秒、31次SQL，原预算以外的现有断言亦通过；全部24项D6行为反例/正常场景和5项清理测试通过。唯一失败为2000身份在D6开始前调用D4 prepare时HTTP500，既有脱敏诊断捕获P2028过期事务；没有得到该档D6性能数据。只读核验D4 prepare原代码传入30000毫秒预算，该生产文件不在本轮写集，未修改。新诊断只补提取错误中的超时/实耗毫秒数字，不输出原始错误文本。正在单独复核该档，不把31+复跑计作一次32项全绿。

2000身份按批准预算单独复核通过（`d6-approved-budget-2000.log`，1通过/26未跑，85.252秒，退出0）：worker5144毫秒为多事务总耗时；各chunk657–1650毫秒、额外6次；finalize475毫秒、额外5次；commit2151毫秒、额外56/总85次，其中44次权限复核；GET55毫秒/31次。该次到达全部容量及预算断言，无诊断UPDATE或预热钩子，业务事务预算不变。三档均有新预算通过证据，但仍不是一次32项全绿合跑，D4前置偶发P2028不据复跑通过结案。补充数字诊断的最新测试源码类型检查及lint通过。

G4独立进程补证：计划内新增`activity-os-r4-d6-time-ledger-concurrency.e2e-spec.ts`，两项通过（`d6-g4-independent-workers.log`，16.098秒，runner正常退出0）。子进程沿既有ts-node/SWC配置加载真实ActivityBatchWorker、LedgerPreparationService和分类账本服务，数据库再次核验w98；测试实例Gate及禁用autoCommit仅限该进程，不启动生产部署或新的常驻worker。真实来源构造沿既有D6 fixture，测试人口1、分类分录4；它不替代G11容量验证。

竞争场景用IPC暂停点确认第一进程已领取且仍存活、job=processing而分录为0；第二独立进程此时尝试领取并返回无任务，之后放行第一进程完成一次分块到ready。该屏障证明有效租约期间不能被第二worker重复领取，不声称测到了两条领取SQL同一瞬间的行锁争用。崩溃场景在真实分块事务提交后暂停，通过父进程持有的子进程句柄SIGKILL并确认退出信号；仅将该测试job租约设过期，接管进程以更高leaseGeneration到ready，itemsProcessed=0，分录完整行快照不变。两例均无自动提交、无日汇总、GET仍404。子进程原始stdout/stderr不转发，结束后全部回收。

新文件类型检查及lint通过；CODEMAP已刷新并检查零失败，保留2 WARN/1 INFO。NEXT_TASKS与FROZEN_DRAFTS按原实施包授权改为实施验证中，历史计划时点保留；没有登记D6完成。四份D6 E2E已开始同工作树串行合跑，最终结果尚待确认。

剩余收口不得省略：前置prepare偶发P2028及最终全量稳定性复验；G12全部生成物、重签及最终SHA CI。当前不标记D6完成，不合并、不启用Gate、不删除业务数据。

本轮四文件串行复验发现另一条前置慢查询：w98 的 `activity-time-settlement.service.ts` 中 `copyBuckets` 复制来源 INSERT 连续运行超过约590秒，`pg_blocking_pids` 为空，尚未进入D6提交；600秒测试预算到期后清理等待该事务。只取消本次明确PID、库名和SQL形状匹配的测试查询以允许回滚，不提高测试或业务超时。此现象不能由D6新增56/总85查询预算更正解决，也不能归类为已通过。最终runner结果另记。

只读定位显示现有复制JOIN仅按旧桶id关联来源；非执行EXPLAIN对诊断目标得到嵌套循环，旧桶使用 `(activityId, participationIdentityId)` 索引但仅以第二列作Index Cond。该计划不是被取消语句的实际执行计划，仅支持待验证假设。现有 `pstbs_bucket_fkey` 已将bucketId/timeRevisionId/activityId绑定同链，因此推荐在旧桶JOIN显式补齐来源revision与activity条件，以便规划器利用既有复合索引；不新增索引、不改数据语义、权限或事务预算。该生产文件不在101路径写集，尚未实施，须维护者明确扩展。验证应先记录原查询与候选查询在同一w98满额夹具下的只读SELECT计划和结果集合，再执行原1/100/2000容量及全部行为断言；不得用单次复跑绿替代稳定性结论。

收口静态检查首次运行：lint和typecheck通过；unit为8593通过、5 todo、1失败，唯一失败是FROZEN_DRAFTS派生读数陈旧；harness为551通过、2失败、1已知缺口，两失败均关联ROUTE_AUTHZ摘要新鲜度。已在批准路径内通过生成器刷新两份文档，未修改守护或断言；冻结读数6项复核通过，完整quick正在重跑。

四文件最终结果（`d6-four-e2e-current.log`）：34通过、2失败，共36项，975.436秒，退出1；并发、迁移、清理专项三套通过。主套失败为2000身份复制超过600秒（随后afterEach超过30秒）及后续complete用例的初始化TRUNCATE事务超过30秒、实耗36928毫秒。未提高任何超时，不把先前单档通过替代本次失败。刷新后全仓unit为390套通过、8594项通过、5 todo；单独ROUTE_AUTHZ检查通过，quick的完整守护结果仍待收尾。当前不满足提交建PR的验证条件。

静态复验已正常结束：`d6-current-quick-refreshed.log`退出0，lint为缓存口径、typecheck、390套unit及守护自测通过；守护已知缺口照旧，不代表最终冷lint或CI完成。随后维护者批准扩展 `src/modules/activities/activity-time-settlement.service.ts`，总授权写集102路径；只在copyBuckets旧桶JOIN增加timeRevisionId和activityId与来源相等的两个条件。复合外键已保证这两个相等关系，原SQL其余部分、两次计数校验、业务事务和测试超时均不变。开始满额复验及查询结果对照；原失败不删除。

copyBuckets补齐后单档2000通过（`d6-copy-buckets-2000.log`，84.424秒，1通过/26未跑，退出0）：真实prepare→submit→worker→commit→GET完整到达，worker3335毫秒，finalize401毫秒，commit1747毫秒/额外56/总85/权限44，GET36毫秒/31次查询；所有原断言和超时不变。随后同一满额落盘夹具的只读事务中，新旧来源SELECT各40000行，双向EXCEPT ALL差异0；EXPLAIN ANALYZE分别73.483/24.176毫秒，均Hash Join（`copy-buckets-readonly-compare.log`）。该落盘后计划不能替代原事务中的慢计划，不宣称根因已被直接测到或稳定性已结案。局部lint通过，继续四套36项整组复验。

补齐后整组复验仍失败（`d6-copy-buckets-four-e2e.log`，323.423秒，35通过/1失败，退出1）。数据库已核实正在执行的复制SQL包含新增两个条件，但持续超过业务预算；仅取消明确属于此次w98测试的复制查询，使其回滚，2000档以HTTP500失败，其余35项通过。此次不是自然600秒超时，不能掩去人工取消因素。结论是新增条件语义一致但不足以保证稳定性能，尚未修复完成。最新source/test/scripts类型检查通过。随后开启仅临时诊断的同事务EXPLAIN（不执行EXPLAIN ANALYZE、不改返回或断言、不改超时，仅输出脱敏计划节点/估算行数/索引名）；该诊断运行不作为正式性能验收。

同事务计划诊断结束（`d6-copy-plan-diagnostic.log`）：3档通过、24未跑，107.131秒，正常退出0。2000档复制前的EXPLAIN计划仍为Nested Loop、连接估算1行，实际满额输入为8000桶/40000来源；源桶与来源扫描存在BitmapAnd，目标桶采用activity/identity索引。EXPLAIN未执行被解释的INSERT，之后仍运行原INSERT与原业务断言；计划读数证明估算与真实规模显著不符，但本次成功，且EXPLAIN与后续预备语句的规划不能保证完全一致，因此不冒称已捕获此前被取消执行的真实慢计划。临时探针位于/tmp、未写入仓库，正式测试不加载该探针。建议下一步只在同一copyBuckets方法内优化集合复制SQL，保留行集合、原子性、计数与权限检查以及所有预算，须另获维护者许可；当前“仅补JOIN条件”授权已实施验证，不擅自扩大。

维护者已批准copyBuckets内集合SQL优化（不限补JOIN），禁止域与全部预算不变。采用两张语句内MATERIALIZED单行JSONB映射：先按目标版本/活动将(identity,category)映射到目标桶，再按来源版本/活动将源桶id映射到目标桶id；键用jsonb_build_array序列化，避免拼接歧义。最后只扫描一次来源集合，以源桶id查映射，缺映射仍不复制、由原sourceCount守护拒绝；原bucketCount守护、两个INSERT顺序、UUID生成、BigInt原始值、业务事务和判权不变。映射不是数据库表、持久缓存或跨请求身份缓存；规模沿原8000桶上限，不新增查询或索引。单行聚合使Nested Loop的另一端始终只有一行，不再反复连接整批桶。

写生产SQL前，同一w98满额夹具只读对照（`copy-map-candidate.log`）：候选SELECT40000行、68.153毫秒，旧/新各40000行，双向EXCEPT ALL差异0；计划证明两个映射各actual rows=1/loops=1，来源扫描actual rows=40000/loops=1。此为落盘SELECT对照，不替代真实事务INSERT验收。已将候选替换到唯一授权方法，正在不带临时诊断探针的四文件36项正式复验。

语句内映射正式四套结果（`d6-copy-map-four-e2e.log`）：35通过/1失败，232.134秒，退出1。主套27项（含1/100/2000容量、权限与完整性反例）、迁移和清理专项通过，复制慢查询未再次阻塞。唯一失败为本轮新建G4测试的崩溃子进程在SIGKILL前以code=0退出；代码审查确认暂停使用永不resolve的Promise但没有保活句柄。仅在原批准的新G4文件中，于chunk_committed发送前ref已有IPC通道；不加timer、不改等待超时或SIGKILL退出信号断言。G4单独复核2通过（`d6-g4-ipc-lifetime.log`，14.760秒，退出0）。当前正在D4结算/并发、D5影子账本、D6四套共七文件联动回归；不将分次通过拼成一次全绿。

最终七文件正式联动回归通过（`d6-copy-map-d4-d5-d6-final.log`）：7套/65项全部通过，475.303秒，runner正常退出0。覆盖D4结算/并发、D5影子账本及D6主链/清理/独立进程/迁移，含真实满额prepare→submit→worker→commit→GET、全部原权限与完整性断言、真实SIGKILL和接管。该次没有临时EXPLAIN、取消查询、重试或超时改动，是一次整组通过；此前失败记录仍保留。counts检查通过（122 migration、265权限、169审计总计/164活跃），GitHub只读核验无重复D6 PR、#1324仍Draft。签字闸现唯一机器失败为3b仍记121；D6第122条migration摘要`2a5249bcf8bd1932411ab0faea2f1df784609590b2570e7984e5e7dd7ece4037`未变，须维护者重签。4b还需按计划确认既有read码覆盖正式分类账本的语义说明，权限目录摘要`3db338e67bc505faa91e9a6a257e84da1588440da767c821b6e4955d8f3d170e`，seed摘要仍`b484cbc013d5`。不自行签字；最终契约、冷lint/typecheck/build及unit/守护复核继续执行。

最终契约1063项、2份快照通过（`d6-copy-map-contract-final.log`）；冷lint→全类型检查→build命令链退出0。最终unit390套、8594项通过、5 todo（100.966秒）。该次quick退出1，lint/typecheck/unit均0，但harness两个CODEMAP新鲜度/幂等检查失败，原因为集合SQL修改增加9行后CODEMAP仍记76841行；不是路由摘要漂移。已通过原生成器刷新到76850，CODEMAP复核0 FAIL/2 WARN/1 INFO；RBAC_MAP、readtax、OpenAPI和ROUTE_AUTHZ检查通过。完整harness自测正在生成物刷新后独立复核，不冒称原quick退出0。按#1330原文第7/12节五个代码块去重98，再加四项明确扩集，允许102路径、实际100路径、越界0（`d6-copy-map-scope-final.log`）；CUTOVER_SIGNOFF待重签未写、RBAC_MAP现算不变。

生成物刷新后的完整harness自测已退出0（`d6-copy-map-harness-final.log`），三组分别553通过/0失败/1已知缺口、138通过/0失败/5已知缺口、68通过/0失败；分组性质不同，不合成一种保证。现有本地收尾证据齐：七套联动65项、契约1063项/2快照、unit8594项/5 todo、冷lint/typecheck/build及生成物/守护检查。尚未重签3b/4b，未提交、推送或创建D6 PR，最终SHA CI及整体复审/真实业务验收未完成；Gate与生产未动。此为本地验证完成，不是D6已合并或T0完成。

2026-09-15维护者已明确确认D6重签3b（第122条，摘要2a5249bcf8bd）及4b（权限265、审计169总计/164活跃、既有read权限覆盖已提交分类账本，目录摘要3db338e67bc5）。现场核验两文件完整SHA-256与上一条一致后更新CUTOVER_SIGNOFF日期、理由、依据及migration-total=122，保留旧签历史；`d6-signed-check.log`签字门禁退出0。本轮实际写集101/授权102，RBAC_MAP无内容变化；进入已批准的提交、推送、Draft PR流程。不合并、不Ready、不操作生产或Gate，跨模型整体复审仍按维护者决定延后、不记为通过。开工预检仅报已获准保留的当前脏树及既有#1324 Draft，不将该预检写成全绿。

### 14.1 PR #1331 首轮 CI 兼容修复（2026-09-15）

首版提交`b1cb705a`已创建Draft PR #1331。CI 34869605126失败：C2 D1当前全量迁移计数仍为121；D6独立子进程错误地限定本地worker98；服务段115前历史夹具无法读取当前D6所需的空分类表；三处既有更正写调用的AST定位随新增前置校验变化。可信红区审批已通过，不替代上述失败。

维护者批准追加两份旧测试`test/e2e/activity-os-r3-c2-outcome-value-revision.e2e-spec.ts`、`test/e2e/activity-service-segment-correction-pending-migration.e2e-spec.ts`及两份身份登记`harness/architecture-debt.json`、`harness/architecture-debt-baseline.json`；授权总范围由102到106路径。随后明确批准在原写集`correction-application.service.ts`中仅将新增两处校验包入独立代码块，恢复原三条登记。最终两份架构登记与HEAD逐字一致，无基线替换、新增豁免或裁判改动。`ids:check`208条当前身份全部匹配；`newdebt:check`未知0；`debt:check`229条登记完整，三命令链退出0。

旧C2仅改当前计数及标题121→122，历史112→113验证不变。服务段夹具仍回放到115前，先清理真实历史schema，再建立两张CHECK(false)的空读表以供当前服务判断无分类事实；不执行121/122 migration，不mock服务、不改变历史升级及业务断言。首轮夹具空表过早建立导致具名清理触发器检查拒绝，已调整建立顺序而未放宽清理器。一次合跑被C2专用w98测试结束删库影响后续同w98测试；改为显式串行执行历史恢复→并发→C2专用库，15项通过（40.627/15.475/15.005秒），不将前两次失败记为通过。

子进程改为校验有效worker编号，并继续由`assertConnectedTestDatabase`核验实际库名与派生名完全一致；本地运行仍只准w98，CI仍沿既有worker派生。生产校验的参数、await顺序、事务位置、拒绝行为和全部断言不变；独立块只避免新增ExpressionStatement挤占旧调用结构定位。保留原架构身份及历史，无新增别名集合。代码地图由生成器刷新，最终SHA CI另行判定。

当前代码w98串行复核正常退出0（`d6-ci-alignment-e2e.log`）：服务段历史升级5项/95.728秒；D6主链、独立进程和既有结算更正3套53项/235.570秒；C2当前/历史迁移8项/19.485秒。合计5套66项全部通过，包括D6满额档和两处分类更正拒绝；无超时或断言调整。全仓unit390套8594项通过、5 todo不变；lint和typecheck均0，测试类型检查、build、签字、counts、readtax及CODEMAP通过。该次quick整体仍退出1，因为两处ROUTE_AUTHZ生成摘要陈旧；随后由原生成器刷新两处摘要，635条声明完全不变，独立完整harness复核退出0：guards 553通过/0失败/1已知缺口，eslint 138通过/0失败/5已知缺口，不将原quick改写为通过。原102路径加本轮四项授权共106路径，当前实际103路径、越界0；三份获准但未改的文件为RBAC_MAP和两份架构身份登记。
