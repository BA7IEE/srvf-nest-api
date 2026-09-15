# Activity OS R4 D7 分类时长更正与冲回：评审及分阶段精确计划

> 2026-09-15，**仅文档，方案 A 待维护者选择；不是可执行 implementation goal**。本轮允许 D6 台账更正、D7 评审和计划起草，验证后提交、推送、创建 Draft PR；不合并、不实施、不操作数据库、不启用 Gate。下述未来路径不是本轮写权限。

## 1. 基线与人话简报

D6 [#1331](https://github.com/BA7IEE/srvf-nest-api/pull/1331) 已合入 main `e3eadddffc0f2c49ec27e3c34fa36df94043eec7`，[main CI 34920687573](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34920687573) completed/success。当前计数为122条 migration、635端点、265权限、169审计事件（164活跃）；这些是 D6 基线，不是 D7 实施后读数。main 的 report-only 审批 skipped，不写成通过。

D6 能把四类时长记入不可改写的账。D7 要解决记错以后怎么改：旧账永久留下，另记一笔冲回和一笔正确值；任何失败都不能只冲回、不补记。贡献账保持独立，不能通过贡献积分反推时长。

当前还有两个不能隐瞒的事实：现有 correction 仅为导出的内部 Service，尚无调用它的生产 Controller；更正参与段会影响分配来源，不能把“人工改认定秒数”冒称“已经重新核验参与事实”。因此本稿推荐分阶段，不以第一阶段验收代替整个 D7。

| 方案                | 内容与代价                                                                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A，推荐，待确认** | D7-1 先完成同一既有事实下的认定更正、冲回、连续更正与查询；D7-2 再完成参与事实变化后的重新分配、面向人的写接口及审核交互。两阶段各有验收，D7-2 完成前 D7 保持 open。本稿给出 D7-1 精确候选写集，D7-2 不伪造尚未核验的路径。 |
| B                   | 一次打包事实修订、重新分配、审核写接口及账本冲回。范围更大，需要先补齐这些接口的数据与权限合同，不能直接把本稿 D7-1 清单当全量授权。                                                                                        |

本轮尚未得到 A/B 选择。选择 A 是产品范围决策，不由 AI 默认为维护者批准。根据 `srvf-goal-author` 的拍板先行原则，本稿保持评审草案，不输出带未决事项的无人值守执行 goal。

## 2. 代码核验与责任边界

以下行号基于上述 main，可用符号再次定位，不以行号代替引用核验。

| 位置                                               | 当前事实                                                                                       | D7-1 推荐处理                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `prisma/schema.prisma:6557` / `:6580`              | D6 Manifest 与 Entry 绑定 submitted 修订；Entry 的秒数直接参加 bucket 复合外键，只允许非负认定 | 不把负数硬塞进去，不改 D6 历史行或第122条 migration；新增同批次更正附表，逻辑上仍是一套分类账 |
| `correction-change-set.ts:33` / `:94`              | v1 严格闭集，仅 results、segments；空更正拒绝                                                  | v1 原样保留，新增 v2 显式分类认定更正，不在 v1 偷加键                                         |
| `correction-application.service.ts:595` / `:616`   | prepare 在既有事务内创建替代版本、冲回、补记；D6保护位在重放之前                               | 仅经 v2 全部校验的分类请求接通，其他分类请求保留20229拒绝                                     |
| 同文件 `:791` / `:807` / `:832`                    | commit 复用同事务 ledger commit，之后失效旧结果和关账指针，审计在最后                          | 分类冲回/补记与原效果同一事务可见；绝不另开一次时长提交                                       |
| 同文件 `:1505`                                     | 更正应用重新查当前用户，复用 GLOBAL 终审权限；绑定成员失效拒绝                                 | 保留；分类分支在等待锁后再次核验，不能套用 D6 新版本 final-decision 假设                      |
| `participation-time-ledger.service.ts:90` / `:105` | D6 分类来源与更正拒绝只识别原 manifest                                                         | 同时识别 D7 更正 manifest，堵住第二次更正被误当 legacy 的漏洞                                 |
| `participation-time-ledger-query.service.ts:19`    | 旧 GET 绑定 timeRevisionId，返回原始非负账                                                     | 原响应与历史含义不变；新增明确 settlementVersionId 的更正账查询，不把原始数静默改成净额       |
| `activities.module.ts:420` / `:437`                | correction Service 注册并导出；全 src 引用未发现生产 Controller 调用                           | D7-1 的写链验收是 Service + 真数据库，不宣称已有 HTTP 写入口或前端可用                        |

冻结依据为 [T0-A §7.1 与 §11](../archive/reviews/activity-os-t0-terminal-review.md)。当前运维边界以 [current-state](../current-state.md) 为准。旧 serviceHours 投影与正式证明切换继续归 D8；不把本刀附表写成另一套可独立提交的账本。

## 3. D7-1 推荐合同（整体待批准）

### 3.1 输入与业务限制

v1 的解析、hash 和历史重放保持逐字语义。v2 顶层固定为 schemaVersion=2、results、segments、timeCorrection；results 保留 v1 形状，**segments 必须为空**。timeCorrection 固定包含 baseSettlementVersionId、baseTimeLedgerHash、reason、items。reason 为1–500字符且不能空白；不采集新敏感字段，不把原因全文放审计或普通列表。原因作为永久更正凭证留存，查看沿更正审核授权，不建立清理期限或删除任务。

items 每项固定 rootEntryId、recognizedSeconds；rootEntryId 必须属于原 D6 已提交根清单，recognizedSeconds 为0..2147483647的整数，不接受浮点、负数或字符串。每次必须提交该根清单**全部**分录（最多8000，含四类零桶）；排序后 canonical/hash，不接受重复、缺失或额外根。根条目固定 identity/category/bucket，调用者不能伪造分类或跨活动移动。类别转移表现为相应两个已有类别桶的认定值变化，不创造新参与身份或新桶。

这是对既有事实的人工认定修正，保留原 calculatedSeconds、政策与来源，不声称重跑分配，也不更改源桶认定值。总和使用 BigInt；原始计算未知仍未知。即使仅修改旧贡献结果，分类批次也必须显式提供完整分类快照，以证明未遗漏新账；全量结果、分类数值都未变时拒绝空更正。分类 v1、v2 带段变更、没有完整根来源的请求继续拒绝，legacy v1 完全保留。

身份集合不能超出原 D6 根清单；新增身份、改参与区间、改分配类别区间/政策或自动重算均归 D7-2。认定值变化不自动改旧 recognizedServiceHours，不拿小时小数反推秒；旧结果修正由 results 单独表达，D8 前不宣称旧读面已成为分类投影。

### 3.2 三个新增模型，沿用一个批次状态

所有模型无 updatedAt/deletedAt，不引新生命周期、队列、cron 或批次状态。初始两表保持不变；仅为新增引用添加必要复合 unique 目标，不改历史内容。

| 模型                                     | 固定字段及类型                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ParticipationTimeCorrectionManifest      | id String；correctionRequestId String；postingBatchId String；activityId String；settlementRunId String；baseSettlementVersionId String；settlementVersionId String（替代版）；rootManifestId String；predecessorManifestId String?（首次为空）；baseContentHash String；requestHash String；contentHash String；expectedRootCount Int；expectedEntryCount Int；reversalSecondsTotal BigInt；replacementSecondsTotal BigInt；formatVersion Int=1；createdAt DateTime |
| ParticipationTimeCorrectionEntry         | id String；manifestId String；postingBatchId String；activityId String；rootEntryId String；participationIdentityId String；categoryCode String；entryTypeCode String（credit/reversal）；secondsDelta Int；reversesCorrectionEntryId String?；entryKey String；contentHash String；createdAt DateTime                                                                                                                                                               |
| ParticipationTimeCorrectionCommitReceipt | id String；manifestId String；postingBatchId String；activityId String；settlementRunId String；baseSettlementVersionId String；settlementVersionId String；contentHash String；createdAt DateTime                                                                                                                                                                                                                                                                   |

每个根条目每轮恰有 reversal/credit 两条，包括0值。首次 reversal 指向 rootEntryId，secondsDelta 等于原 D6 recognizedSeconds 的相反数；后续 reversal 必须引用紧邻前一已提交 correction manifest 中该根的 credit，不能再次冲原 D6，也不能冲 reversal。credit 是本轮完整替代值，不是净差额。净影响为 reversal+credit，但当前版本展示值取本轮完整 credit；不沿无界历史链扫描求当前余额。

Manifest 与请求的 base/version/run/activity、替代 batch 的 version/run、root manifest 的 activity/run 必须同链；前驱为空仅在 base 就是 root manifest 版本时合法，否则前驱必须是 base 版本唯一 committed 的更正 manifest，且 root 一致。禁止选择 latest 或跳过中间版本。rootEntry 与 identity/category/rootManifest 必须同链，前驱 entry 必须与 rootEntry、activity 同链。通过精确复合 FK + 具名约束落实，不能仅列几个独立 FK。

唯一性：manifest.postingBatchId；manifest.correctionRequestId；entry.entryKey；entry(manifestId,rootEntryId,entryTypeCode)；receipt.manifestId；receipt(baseSettlementVersionId)。receipt 的 base 唯一键只在 commit 时占用，避免失败准备永久占死原账。不同准备结果可以留存但不能同时生效；同请求重放复用原准备。所有 FK 为 Restrict，禁止 CASCADE 删除。

### 3.3 数据库与恢复协议

新增单条候选 migration `20260915120000_activity_os_r4_d7_time_correction/migration.sql`，预计为第123条；真正实施前核验排序及未占用，变化须同步精确路径，不能改第122条。新三表初始为空，无业务回填、删列、降级或历史 hash 重算。

具名 CHECK：`ptcm_shape_check`（format=1、1..8000根、分录=根×2、合计合法）、`ptcm_hash_check`、`ptce_shape_check`（四类闭集、credit>=0、reversal<=0、引用形状）、`ptce_hash_check`、`ptcr_hash_check`。FK/unique 名称均使用 ptcm/ptce/ptcr 前缀且小于63字节；具体 Prisma 映射在实施时逐条列入 migration 测试，不依赖自动截断。

三表各有 immutable 与 no_truncate 具名触发器。Manifest/Entry 插入按 batch 稳定排序加锁且只允许 preparing；集合校验根与前驱，禁止每条分录单独查库。ready 必须有完整根集合、每根两类型、正确符号和金额、正确前驱及总和；同数量换另一根必须拒绝。DB 证明集合和金额，Service 另外复算 canonical/hash，不能把两者混为同一种保证。

Receipt 仅允许持同一 batch 锁、完整且 ready 的批次插入。commit 事务内先写 receipt，再切 committed；事务失败 receipt 一起回滚，不能留下冲回占位。增加延迟到事务结束的约束，要求 receipt 与 committed 批次互相成立，防止直接SQL留下 ready receipt 或无 receipt 的 committed 更正。晚到 INSERT 等待 batch 锁后重新判断状态，必须拒绝。receipt 不支持UPDATE/DELETE/TRUNCATE。

失败准备、失败/作废批次、所有旧原账及更正凭证永久保留。恢复同应用同内容，不删旧任务或另造幂等键。无 down migration；若上线后发现问题，停相应写入口并前向修复，不能回退到忽略 D7 manifest 的旧应用。此处是未来故障边界，不是本轮生产操作许可。

## 4. 编排、权限与查询

prepare 仍复用既有 Activity→Run→Request 锁和旧更正 prepare 事务；在新版本/旧账效果准备之后、ready 之前准备分类 manifest 与分录并验证完整性。新 helper 全部接收 caller tx，不另开事务，不反向取得父锁。v2 segments 为空仍须建立既有合法空段准备收据，不能绕过115条 migration 的完成证明。

commit/apply 的重放出口之前识别 D7 manifest，核验当前用户与 GLOBAL `activity.settlement-final-review.record`；等待 member/day-state 等锁后再次核验。沿已批准的更正请求绑定 application actor，不要求替代版存在普通 final-review decision，也不自动换人代签。原请求提交/审核分离、base drift、关账失效与贡献日上限不变。新增校验失败必须使旧账、分类账、receipt、结果、关账指针与最后审计整体回滚。

公共 LedgerPostingService 必须按初始D6 / D7更正 / legacy 三分支核验，不能只修改 correction.prepare。普通worker不得自动提交更正批次并绕过 application 收尾；保持既有 correction posting shape 的排除规则。独立worker模块仍能启动，DI 两处一起覆盖。conversion 继续拒绝任何 D6/D7 分类来源，不给历史数据自动分类。

新增 Human App 查询建议路径：`GET /api/app/v1/my/managed-activities/{activityId}/time-settlement/versions/{settlementVersionId}/correction-ledger`。仅返回确切目标版本 committed 的 correction manifest 和 receipt；preparing/ready/failed/voided 与跨活动统一不可访问。入口复用显式 time-settlement.read、当前App准入及活动组织资格；版本资格沿该链原 D6 冻结版本的既有负责人/审核资格核验，不以 latest 或“知道ID”放行。该授权范围须作为方案选择的一部分确认，权限说明同步并重签4b，不因权限数量不变免审。

响应固定含 manifestId/postingBatchId/settlementVersionId/baseSettlementVersionId/rootManifestId/predecessorManifestId/contentHash/formatVersion，reversalSecondsTotal/replacementSecondsTotal/netSecondsDelta 为十进制字符串；四类相同三项汇总，固定含零。resultPage 沿 page/pageSize/total/items，pageSize<=100，按 identity/category/entryTypeCode/id 稳定排序；明细 id/rootEntryId/reversesCorrectionEntryId/identity/category/type/secondsDelta。不返回原因全文、人员敏感字段或假账期。旧 D6 GET 继续原 DTO 和含义，D8 才切证明/统计。

错误继续精确复用20102（v2形状非法）、20225（规模）、20226（源或引用不完整）、20227（内容冲突）、20228（尚未完整）、20229（不支持的分类更正形态）、20230（读不可访问）；为20229扩展说明而不改历史message/HTTP。命名SQL错误仅按新具名约束映射；未知SQL、deadlock、连接异常原样失败。权限错误沿原通用码，不泄露引用存在性。审计复用既有更正/账本事件和同任务重放规则，只记标识、hash、条数与总量；不新增审计事件或默认角色授权。

## 5. 精确候选写集与收口条件

本轮实际仅五份 Markdown：本稿、D6计划、NEXT_TASKS、FROZEN_DRAFTS、`changelog.d/activity-os-r4-d7-review-and-plan.md`。逐路径 harness:needs 为0红区；它不证明未来实施有令牌。下列为 **D7-1 待评审候选**，不是整个 D7 或已批准的执行清单。路径实查为66个唯一候选，55个已存在、11个新增；逐路径静态预算13红区、53非红区。工具聚合显示 prisma/\*\* 不构成通配写授权；未来只允许明确schema和那一条migration。

### 5.1 业务与新测试（标注“新增”的文件不得冒称当前代码）

```text
prisma/schema.prisma
prisma/migrations/20260915120000_activity_os_r4_d7_time_correction/migration.sql
src/modules/activities/participation-time-correction-policy.ts
src/modules/activities/participation-time-correction-policy.spec.ts
src/modules/activities/participation-time-correction.service.ts
src/modules/activities/participation-time-correction.service.spec.ts
src/modules/activities/participation-time-correction-query.service.ts
src/modules/activities/participation-time-correction-query.service.spec.ts
src/modules/activities/correction-change-set.ts
src/modules/activities/correction-change-set.spec.ts
src/modules/activities/correction-application.service.ts
src/modules/activities/correction-posting-shape.ts
src/modules/activities/correction-posting-shape.spec.ts
src/modules/activities/participation-time-ledger.service.ts
src/modules/activities/participation-time-ledger.service.spec.ts
src/modules/activities/participation-time-ledger-access.service.ts
src/modules/activities/participation-time-ledger-access.service.spec.ts
src/modules/activities/ledger-posting.service.ts
src/modules/activities/activities.module.ts
src/modules/activities/activity-batch-worker.module.ts
src/modules/activities/controllers/app-managed-activity-time-settlement.controller.ts
src/modules/activities/dto/app/app-activity-time-settlement.dto.ts
src/modules/permissions/permission-catalog.ts
test/e2e/activity-os-r4-d7-time-correction.e2e-spec.ts
test/e2e/activity-os-r4-d7-time-correction-migration.e2e-spec.ts
test/e2e/activity-os-r4-d7-time-correction-concurrency.e2e-spec.ts
test/e2e/activity-os-r4-d6-time-ledger.e2e-spec.ts
test/e2e/activity-os-r4-d6-time-ledger-migration.e2e-spec.ts
test/setup/time-ledger-fixture-cleanup.ts
test/setup/reset-db.ts
test/e2e/activity-os-r4-d6-time-ledger-fixture-cleanup.e2e-spec.ts
```

新增为单条 migration、六个 participation-time-correction 源码/单测和三个 d7 E2E。D6旧测试仅增 v1仍拒绝/v2另测对照，保留原20229断言；历史迁移121→122断言不改，仅将“当前全部迁移”与结束恢复分开。cleanup helper 只在未来获准的 w98 及 CI 实际worker隔离库内临时处理三张新表的具名 no_truncate；同连接同事务恢复、失败回滚、目标库双重核验保持。不禁用 ALL、不清理业务数据，不把测试helper变成生产清理器。

### 5.2 治理、生成物与说明

```text
prisma/CLAUDE.md
CODEMAP.md
docs/current-state.md
harness/domain-map.json
harness/state-machines.json
docs/ai-harness/STATE_MACHINE_INVENTORY.md
docs/ai-harness/ROUTE_AUTHZ.md
harness/permission-surface-baseline.json
docs/ai-harness/RBAC_MAP.md
docs/ai-harness/CUTOVER_SIGNOFF.md
scripts/check-boundaries.ts
scripts/harness-guards.selftest.ts
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
docs/ops/activity-time-ledger.md
docs/plans/activity-os-r4-d7-time-ledger-correction-review-and-plan.md
docs/ai-harness/NEXT_TASKS.md
docs/ai-harness/FROZEN_DRAFTS.md
changelog.d/activity-os-r4-d7-time-correction.md
```

implementation changelog 为新增；生成客户端仅刷新真实受影响内容与输入摘要。检查器仅精确登记新 Entry 的 categoryCode/entryTypeCode，L1 inventory、not-derived，不泛化发现规则、不放宽门禁、不改架构身份。预计新增三模型、一migration、一个GET；零新增权限/角色/审计，最终计数以实现为准，3b实际SQL摘要和4b实际权限说明摘要另签，不能预填批准。格式1不是业务状态机。

### 5.3 尚需完成的闭包，不冒称已具备无人值守条件

选择方案 A 后，精确计划收口前还须逐份核验当前19份旧迁移计数测试与 D6/C2 新增回放测试、25份局部TRUNCATE使用者和115条旧schema夹具。不能照抄 D6 的98路径或对122做全局替换：原 D4 第121条、D6 第122条及历史升级断言必须分别保持。只有确认实际依赖新 FK/触发器的路径才加入最终写集，逐项写明前置适配和不变断言。

还需核验公共提交分类分支的全部引用、当前batch触发器与新延迟约束的执行顺序、查询权限helper的tx透传，以及纯粹原因变化是否仍拒绝空更正的业务确认。以上未补齐前，5.1/5.2仅是精确候选路径，不报成“完整去重写集已批准”，不发 implementation 授权命令。此处保留缺口是为了防止开工后不断补授权，不是将缺口转交执行者猜测。

## 6. D7-1 DoD 与验收计划（尚未执行）

| 编号 | 必须证明的结果                                                       | 探针                                                                                                                                                      |
| ---- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1   | 新三表空建，旧D6行/hash与前122条checksum不变                         | 全量冷回放、122→123非空升级、旧内容逐表摘要；历史回放与current分离                                                                                        |
| G2   | v1完全兼容；v2拒绝缺根、重复、跨链、越界、带段变化；四类与0保留      | 纯policy正反例、真实Service/DB反例，不只mock                                                                                                              |
| G3   | 首次冲原账、第二次只冲上一轮credit，第三次仍正确；当前值无需遍历全史 | 连续三次全快照更正，逐行核验前驱、负数、补记与净额，禁止冲reversal                                                                                        |
| G4   | 一条基础版本仅一个committed更正；失败准备不永久占位                  | 双连接屏障与pg_blocking_pids，commit最后一步失败后另次合法提交，receipt全回滚                                                                             |
| G5   | 缺行/同数错集合/错金额不能ready或commit                              | 服务与直接SQL独立反例、晚到INSERT实际锁等待、延迟约束提交时拒绝                                                                                           |
| G6   | 旧账、分类账、receipt、结果、关账与审计零部分生效                    | 最后审计注入失败逐行比较；相同operationKey重放不增行，不换最新来源                                                                                        |
| G7   | 撤权、停用、绑定成员失效、锁后资格变化及重放仍拒绝                   | 实际并发等待后变更资格；legacy characterization 保持                                                                                                      |
| G8   | 新GET只读确切committed版本，原GET内容不变                            | 真HTTP五种批次态、跨活动、越权、分页、四类总量与0；不冒称HTTP写链                                                                                         |
| G9   | worker/转换不能绕过更正收尾；准备中断可恢复且不删数据                | 独立worker启动与真实任务，保留旧围栏、自动消费及转换拒绝断言                                                                                              |
| G10  | 1/100/2000身份均不截断；8000根/16000分录，集合查询不N+1              | 分开计量准备、提交、查询及权限SQL；计划新增分类准备≤24次、提交新增≤24次（相对同规模legacy基线），GET总≤40次；所有既有事务上限不变，不因16000行提高5秒预算 |
| G11  | legacy贡献/日上限、v1更正、原D6普通入账、历史回放保持                | 旧ledger posting、settlement correction、service-segment lifecycle/concurrency、D4/D5/D6联动；失败先定位不改断言                                          |
| G12  | 快照、客户端、签字和可信CI绑定最终SHA                                | 单元/静态/contract，受影响w98定向与全量CI；明确skip、已知盲区与本次未做                                                                                   |

G10预算是待审批目标，不是实测数据；须先记录原路径同规模查询计数，包含全部授权与DB trigger耗时。首次不达标保留失败证据，不能用预热后的独立SQL速度代替真实全链路，也不以提高测试总时长冒充业务事务达标。若旧同步prepare本身不支持该规模，必须改计划统一补完整执行链，不能漏掉旧贡献写入的成本。

## 7. D7-2 与整个 D7 的退出条件

D7-2 必须另行补齐：参与段修正→合法新的 allocation revision→新的分类认定依据→更正审核→同批次冲回/补记；新来源仍位于真实参与段内且分类互斥、不重复计时。不能改参与段后继续声称原 allocation 证明新事实，也不能新增平行参与段真相。面向人的创建/审核/prepare/commit/查询接口、DTO、访问面、错误码、审核分离、交接和HTTP全链验收一并评审，不默认给原GLOBAL权限的人开放新App写入口。

整个 D7 只有在 D7-1、D7-2 均有独立实现和验收证据后才能登记完成。D8正式证明/统计、旧serviceHours投影切换、真实影子对账、独立整体跨模型复审、生产migration与Gate部署仍是独立未做事项。永久保留业务数据的既定决定不重开。

## 8. 本轮交付与下一次授权

本轮只交付 D6 合并事实更正与 D7 评审草案，不发实施指令。建议下一次先确认“D7 方案 A 的分阶段边界”，继续仅文档补齐5.3与最终授权表；或者选择 B 先完成全链合同。选择方案不等于合并本PR，不等于批准数据库或红区写入。完成所有前置选择和闭包后再生成一条完整 implementation 授权，避免把待决问题带入无人值守执行。

本次未做：D7生产代码、schema/migration、数据库验证与重建、权限变更、红区发放、Ready/合并、Gate、生产操作、任何业务数据删除。文档校验通过也不能填作G1–G12通过。

## 9. 本轮文档核验记录

lane preflight 通过，main基线与D6合并/CI状态已从GitHub重读。保留中的#1324未修改，本轮五路径与其写集不相交，未借用历史合并豁免。

`docs:codemap:check`、`docs:rbacmap:check`、`check-frozen-drafts-ledger.ts`、`docs:counts:check`、`docs:readtax:check` 通过；CODEMAP既有2项WARN/1项INFO、RBAC动态权限INFO与readtax容量提醒保留。冻结台账检查只证明对照一致，不证明D7实现完成。新文档首次格式检查失败，仅格式化本稿后复核，不回改历史长文格式。

未运行unit/contract/E2E或数据库命令，因本轮只有Markdown变更且明确禁止数据库操作；后续PR CI结果须按实际SHA另报，不把本地文档检查称为全量测试通过。
