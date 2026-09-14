# Activity OS R4 D6 正式分类时长账本：评审与精确实施计划草案

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

目标预算（待实测而非现有达标事实）：GET 总查询≤120、业务≤30秒；各块额外分类 SQL≤8（不含旧链已有语句，测试同时报告含原链总数）、finalize 额外≤8、commit 额外≤6。member advisory 锁和旧事务时间预算原样保留，不为通过测试扩大。1/100/2000 档必须同口径测量。满额 E2E 整体最多600秒只用于构造/验证夹具，不能据此放宽业务事务。

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
