# Activity OS R4 D7 分类时长更正与冲回：评审及分阶段精确计划

> **D7-1实施中（2026-09-15，未提交）**：维护者已确认#1333的90路径及第10–12节完整实施包，工作树精确授权已核验，允许app_test_w98隔离验证及测试夹具重建，验证后提交、推送并创建Draft PR。当前实现及回归验证进行中，尚未完成验收、重签或创建PR。下方仅文档/未获实施授权为历史时点；不合并、不操作生产、不启用Gate、不删除业务数据。D7-2及整个D7仍未完成。

> **方案 A 已确认，精确计划细化（2026-09-15）**：维护者确认 D7 分阶段方案 A，允许继续完善精确计划，仅文档。第10–12节补齐此前工程闭包，以这些章节为当前下发候选；下文“方案尚未选择”保留为初稿历史，不再重复索要方向确认。本次未获得实施、数据库、Ready或合并许可；本轮文档修改先留本地待审。

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

唯一性：manifest.postingBatchId；manifest的correctionRequestId仅建索引（允许失败后追加新application，不删除旧凭证）；entry.entryKey；entry(manifestId,rootEntryId,entryTypeCode)；receipt.manifestId；receipt(baseSettlementVersionId)。receipt 的 base 唯一键只在 commit 时占用，避免失败准备永久占死原账。不同准备结果可以留存但不能同时生效；同请求重放复用原准备。所有 FK 为 Restrict，禁止 CASCADE 删除。

### 3.3 数据库与恢复协议

新增单条候选 migration `20260915120000_activity_os_r4_d7_time_correction/migration.sql`，预计为第123条；真正实施前核验排序及未占用，变化须同步精确路径，不能改第122条。新三表初始为空，无业务回填、删列、降级或历史 hash 重算。

具名 CHECK：`ptcm_shape_check`（format=1、1..8000根、分录=根×2、合计合法）、`ptcm_hash_check`、`ptce_shape_check`（四类闭集、credit>=0、reversal<=0、引用形状）、`ptce_hash_check`、`ptcr_hash_check`。FK/unique 名称均使用 ptcm/ptce/ptcr 前缀且小于63字节；具体 Prisma 映射在实施时逐条列入 migration 测试，不依赖自动截断。

三表各有 immutable 与 no_truncate 具名触发器。Manifest/Entry 插入按 batch 稳定排序加锁且只允许 preparing；集合校验根与前驱，禁止每条分录单独查库。ready 必须有完整根集合、每根两类型、正确符号和金额、正确前驱及总和；同数量换另一根必须拒绝。DB 证明集合和金额，Service 另外复算 canonical/hash，不能把两者混为同一种保证。

Receipt 仅允许持同一 batch 锁、完整且 ready 的批次插入。commit 事务内先写 receipt，再切 committed；事务失败 receipt 一起回滚，不能留下冲回占位。增加延迟到事务结束的约束，要求 receipt 与 committed 批次互相成立，防止直接SQL留下 ready receipt 或无 receipt 的 committed 更正。晚到 INSERT 等待 batch 锁后重新判断状态，必须拒绝。receipt 不支持UPDATE/DELETE/TRUNCATE。

失败准备、失败/作废批次、所有旧原账及更正凭证永久保留。恢复同应用同内容，不删旧任务或另造幂等键。无 down migration；若上线后发现问题，停相应写入口并前向修复，不能回退到忽略 D7 manifest 的旧应用。此处是未来故障边界，不是本轮生产操作许可。

## 4. 编排、权限与查询

prepare 仍复用既有 Activity→Run→Request 锁和旧更正 prepare 事务；在新版本/旧账效果准备之后、ready 之前准备分类 manifest 与分录并验证完整性。新 helper 全部接收 caller tx，不另开事务，不反向取得父锁。v2 segments 为空仍须建立既有合法空段准备收据，不能绕过115条 migration 的完成证明。

commit/apply 的重放出口之前识别 D7 manifest，核验当前用户与 GLOBAL `activity.settlement-final-review.record`；等待 member/day-state 等锁后再次核验。沿已批准的更正请求绑定 application actor，不要求替代版存在普通 final-review decision，也不自动换人代签。原请求提交/审核分离、base drift、关账失效与贡献日上限不变。新增校验失败必须使旧账、分类账、receipt、结果、关账指针与最后审计整体回滚。

公共 LedgerPostingService 必须按初始D6 / D7更正 / legacy 三分支核验，不能只修改 correction.prepare。普通worker不得自动提交更正批次并绕过 application 收尾；既有 correction posting shape 只核对旧账冲补集合，不排除自动提交，须新增第10节明确防护。独立worker模块仍能启动，DI 两处一起覆盖。conversion 继续拒绝任何 D6/D7 分类来源，不给历史数据自动分类。

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

## 10. 方案 A 的工程闭包与修正

### 10.1 三条提交链不能混用

当前 `ledger-posting.service.ts:274–284` 和 `:341–347` 分别在重放之前、member/day-state 等待之后核验 D6；这两处同时扩展三分支，不能只移除20229。初始D6仍按原manifest与final-review资格；D7必须绑定已批准请求、application、替代版、根manifest和当前实际操作者；legacy原样。D7调用 `assertComplete` 时不走 D6 的 `source()`，因为替代版没有新的 submitted timeRevision，不能将其误判成无分类。

D7更正commit在既有外层事务中先锁Activity→Run→Request→Application，完成当前资格检查，再调用共享账本协议。Receipt只能由这条应用事务写入；公共提交只验证，不代为补建receipt。普通 `commitBatch` 与 conversion 不得通过传一个boolean绕开；数据库延迟校验还必须要求对应CorrectionApplication为committed、Request为applied且关联batch/version完全相等，核验的是事务结束时的行状态。这样内部直接调 `commitBatchWithin` 即使伪造actor也无法只提交半条链。

当前 `ledger-ready-batch-committer.service.ts:23` 后只查batch与final-review决定，没有显式更正排除；不是原稿所称“已有排除规则”。计划新增对D7更正manifest/application的明确拒绝，并补其现有单测；不改变legacy自动提交。`correction-posting-shape.ts` 的旧集合规则继续保留，不能拿它替代入口保护。worker编排本体不改。

D6数据库 `ptl_visibility_guard` 在没有初始manifest且没有submitted timeRevision时返回，D7-1正是这类替代版。新增独立 `ptc_visibility_guard`，不改122条函数；两者各管自己的清单。新guard须从CorrectionApplication/已批准v2请求识别“应有D7清单”，不能仅在新manifest存在时才校验，防止缺整份manifest直接逃过。prepare将application创建提前到ready之前，仍在同一事务；不提前物化业务段。不得依赖同事件trigger的名称执行顺序。

Receipt插入时允许ready；批次转committed时同步检查receipt存在且金额/集合一致；事务结束时由挂在receipt插入和batch状态变动两侧的DEFERRABLE INITIALLY DEFERRED约束再查询最终状态，并核验application/request已收尾。prepared、failed、voided不能留receipt；同一事务插receipt后出错必须整体回滚。收据不是提前占位或异步补账，不新增清理路径。

### 10.2 输入、重复与引用的精确落点

submit在锁住实际posted基础版之后核对v2的baseSettlementVersionId与baseTimeLedgerHash，不信调用者传来的基础版；review按现有base漂移和审核分离规则；prepare再核对完整根集及前驱committed状态；commit和重放再核对所绑定不可变内容，不重新选latest。空更正继续原语义：只有原因不同而结果和分类认定完全相同，仍拒绝20102；这是沿用既有空更正规则，不新增原因编辑业务。

v2的requestHash必须覆盖既有请求主体和完整规范化timeCorrection；v1的canonical/hash保持原算法，不为新格式重签历史请求。条目排序rootEntryId；entryKey基于formatVersion/manifest确定性输入/rootEntryId/type组成的canonical对象，不能随机生成去绕过幂等。首次reversal的前驱是D6根行，后续是指定前驱manifest的credit，严格核对金额相反数；零值用type区分，不靠正负号推断类型。

最终FK目标按以下元组建立必要冗余unique，不做旧数据回填：Manifest的batch引用(id,settlementVersionId,settlementRunId)；root引用(id,activityId,settlementRunId)；request引用(id,baseSettlementVersionId,activityId,settlementRunId)（已核验AttendanceCorrectionRequest直接持有settlementRunId）；Entry的manifest引用(id,postingBatchId,activityId)，root引用(id,participationIdentityId,categoryCode)，前驱引用(id,rootEntryId,activityId)；Receipt引用manifest(id,postingBatchId,activityId,settlementRunId,baseSettlementVersionId,settlementVersionId)。前驱类型、manifest根一致和跨父表推导由集合触发器验证，不以单列FK冒充全部同链。

三表SQL命名：`ptcm_immutable/ptce_immutable/ptcr_immutable`、`ptcm_no_truncate/ptce_no_truncate/ptcr_no_truncate`；插入guard分别`ptcm_insert_guard/ptce_insert_guard/ptcr_insert_guard`；金额/配对完整性统一`ptc_visibility_guard`；延迟提交闭合`ptc_commit_closure_guard`。unique与FK以同前缀加字段语义命名，长度<63；反例断言精确名称，禁止宽泛吞P2002或未知SQL错误。

### 10.3 查询与鉴权复用，不扩属主模块

新query在同一tx内查指定version对应manifest、receipt和committed batch；先用既有ActivityTimeSettlementAccessService做当前App/read范围校验，再以manifest.rootManifest所绑定的历史原D6版本做版本资格核验，锁batch后重读当前资格。该helper已有tx入口，不新增缓存、不修改组织/users/authz属主文件。D7写授权沿原更正GLOBAL终审资格，在现有ParticipationTimeLedgerAccessService新增独立更正方法并补单测；不能复用原方法要求新版本存在普通final-review决定。

列表不返原因，源依据访问仍走已有权限；原因保留于已有申请JSON，不复制至Entry或审计payload。本阶段不扩大CorrectionAuditRecorder的审计字段，沿原请求/批次标识可关联新清单，因此不修改该文件、不新增审计event。新增GET说明与permission-catalog、生成surface基线一致，4b仍按实际语义摘要签字。

### 10.4 旧测试的真实影响

当前20份测试命中CURRENT_MIGRATION_COUNT=122或当前回放长度122，另C2 D1 `activity-os-r3-c2-outcome-value-revision.e2e-spec.ts:184–190`有字符串122。D6测试已在5.1，其余19份和C2 D1列入第11节。C2 D2 outcome-receipt迁移测试明确113→114历史升级且动态恢复当前，不存在待改122，本轮不纳入写集。

D6迁移测试`:337–364`标题称121→122但实际deploy当前schema；计划在临时迁移目录中只追加原D6 migration完成历史122断言，再在finally恢复当前全量schema。首条current回放更新123，`names[121]`仍锚定原D6。D4的`names[120]`和120→121历史升级保持不变；禁止把所有122替换为123。

局部TRUNCATE的26份helper调用者中，多数已由固定helper处理存在的新表，CASCADE沿父FK带入，无需逐份改调用者。只有D1-1 foundation两处不带CASCADE的静态表清单须显式加入新三表；其余25份为回归执行范围，不为凑数扩写集。helper必须同步更新TS名单、psql VALUES和恢复允许名单三处；不存在新表的历史库跳过，存在但缺具名trigger仍报错。新模型没有新业务表以外的清理目标。

115条服务段旧schema测试`:130–154`在reset之后创建CHECK(false)的空D4/D6表；D7新增来源探测会再读取CorrectionManifest，须在同一位置补禁止INSERT的只读空表及查询需要的准确列，不跑123 migration、不把旧库当新库验收。所有原服务段准备/物化/重放断言保持。D1-1无CASCADE清理、115旧库与新helper回滚恢复均列为独立兼容验收。

### 10.5 容量与验证范围

旧createNewResultRevisions为单次unnest插入，buildReplacementDayRows遍历纯内存，readWeightBearingSpans在segments为空时批量查库；D7-1不进入逐段写循环。满额仍需测完整旧贡献/日分配和新分类链，不能只测新helper。保持G10新增准备≤24、提交≤24、GET总≤40的待审批预算及既有业务事务上限；若实测失败优化同写集实现，禁止默默抬预算或改断言。

2026-09-15维护者明确更正验收方式：本地w98定向验证通过后创建Draft PR，全量由PR CI冷跑；其余授权边界不变。该确认覆盖初稿“本地完整agent:check:full”的表述，与仓库process一致。本地仍执行lint、typecheck、unit、build、harness、contract及受影响w98定向测试，不让默认脚本创建其他库，不放宽断言或预算。额外w82–w88、w91–w97未获授权，也不再作为本地验收前置。

## 11. 最终补充写集（与5.1、5.2去重合并）

以下19份只适配current全量回放计数/标题与结束恢复，历史目标、checksum和业务断言保留。路径均已在当前仓库存在，不用通配符授权。

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

另补五个精确路径，分别对应C2 D1当前回放、D1-1非CASCADE清理、115旧schema只读空表、自动提交明确拒绝及其单测：

```text
test/e2e/activity-os-r3-c2-outcome-value-revision.e2e-spec.ts
test/e2e/activity-os-r4-d1-1-time-policy-foundation.e2e-spec.ts
test/e2e/activity-service-segment-correction-pending-migration.e2e-spec.ts
src/modules/activities/ledger-ready-batch-committer.service.ts
src/modules/activities/ledger-ready-batch-committer.service.spec.ts
```

5.1、5.2、11节合计90个唯一精确路径，新增11个、既有79个；未来实现必须逐项比对此集合，未变化的文件不为凑齐而修改。不得扩大到src/modules/users、organizations、authz、storage、workflow、package、历史migration或架构登记裁判。原66路径及13个红区读数是初稿，最终预算另行逐路径核验。

## 12. 下发条件与授权清单

方案A方向已确认；第10–11节完成本轮代码可查的工程闭包。D7-1精确实施包仍须维护者整体确认，不把文档编辑权转换成生产代码写权。完整包包含v2严格形状、仅认定不改段、三个追加模型、单批次原子更正、明确阻止旁路、旧回放/夹具前置适配、读权限说明和生成物；不再附带“实现者自行选方案”的未决产品问题。来源模型字段、约束SQL与性能只能在未来实施时验证，计划不伪造实测。

建议实施授权应一次包含：按5.1/5.2/11节90路径和第10节修正实施；允许app_test_w98隔离验证及测试夹具重建，且仅固定具名no_truncate触发器的同事务测试处理；验证后提交、推送并创建Draft PR；不合并、不操作生产、不启用Gate、不删除业务数据。该段是待批准文字，不是当前已授予权限。

红区由维护者在实施工作树逐路径发放，AI不执行harness:grant；SQL完成后重签3b（预计第123条，最终完整hash），权限说明完成后重签4b（预计265权限、169审计/164活跃，最终实际语义hash）；不预签未知摘要。无新事件/角色默认授予，若确需新增则另行报告，不能借原数量目标改守护过关。

本轮只保留四份本地文档改动：本稿、NEXT_TASKS、FROZEN_DRAFTS及已有review changelog。#1333远端625a0686的CI成功仅代表旧稿；新稿未提交推送，须验证后另获更新PR授权。不Ready、不合并。后续D7-2继续独立完整计划，D7-1通过不等于D7全部完成。

## 13. Implementation 验证记录（进行中，未交付）

2026-09-15：已按维护者确认的90路径开工，13项工作树红区授权核验通过；未修改门禁、生产、业务数据或其他PR。新三表和第123条migration、v2解析及Service写链、新GET和生成物已落本地，尚未完成整体验收，不登记D7完成。

- G1：最新migration在w98完成123条冷回放及122→123非空升级，2项通过；三张新表为空、旧数据及前122条checksum保持。生产未执行migration。
- G3/G10：早期两轮更正在1/100/2000身份通过；已扩展到连续三轮及数据库反例，最终容量复核进行中。不能把旧版本通过算到后来修改的SQL上。
- G4/G7：真实双连接等待Activity锁的同请求竞争通过一次，追加锁等待期间成员失效反例，最终复核进行中。
- G11：legacy更正24项通过。旧D6回归发现新增探测导致总查询86超过原85；已将D7识别和旧分类更正排除合为单次有界读取，保持原断言，待最终复核。一次命令误写不存在的旧测试路径，已纠正为activity-settlement-correction，未把未运行列为通过。
- G8：查询先读取不可见于响应的精确清单锚，再调用既有authorize(rootVersion)，该helper内部依次检查当前App/read范围和实际版本资格；锁后完整重查同一根版本。避免另跑一次完全重复的generic校验，不省略任何判权。曾经三次调用测得47次超过40，已改为上述两轮完整检查，待复核。
- G5：集合SQL同时核验根配对、前驱冲回金额、清单合计及每项补记与已批准items相等；新SQL须待容量复核后才报最终3b摘要。测试直接注入缺清单/缺行/错金额，准备失败须整笔回滚；三表UPDATE必须返回精确immutable约束名。
- 旧清理测试补齐新表FK前置。未带CASCADE的拒绝用例先被FK拦截为0A000，现仅补CASCADE使其仍实际触发原23514断言；未放宽断言，待复核。
- 首轮unit为391套通过、2套生成物读数失败，8650项通过、3失败、5todo；读数刷新后对应复测14项通过。一次unit与harness自测同时运行撞上临时探针文件创建/移除，后续须串行复核，不作为业务失败或全绿。
- 本地全量回归还包含固定w82–w88、w91–w97临时库，不受JEST_WORKER_ID=98统一覆盖。维护者已更正为本地w98定向、PR CI全量，不操作这些额外库，不更改其目标和断言。

- 维护者已确认3b SQL摘要9e922fefdb03及4b权限目录871a4c9d426d，签字登记已保存。随后2000身份反例仍遇5秒事务超时；w98只读auto_explain证实JSON明细Nested Loop为8000×8000，Join Filter排除63992000行，单次检查约3秒。现于原migration写集内先物化完整配对再筛选异常，保持全部检查及5秒预算；新SQL验证和重新签署尚待完成，旧摘要签字不覆盖本次变更。

- 优化后SQL SHA-256为c2f06bcf6e190f4eaafee23687b31d458197c1803a9057116251c04f6ec96627。w98重新执行迁移2项通过（24.055秒），1/100/2000身份全部3项通过（139.172秒），连续三轮、数据库反例、事务及24/24/40查询预算断言全部保留。新3b已提请维护者确认；4b目录摘要未变。
- 串行unit复核393套、8654项通过、5todo；lint、typecheck、build及harness自测通过。上述结果不等于本地全量E2E或远端CI通过。
- 优化后并发、受控夹具清理及旧activity-settlement-correction三套31项通过（30.325秒），包含等待锁时成员失效双请求均403。contract的1064项通过，两个快照仅新增已批准GET和四个DTO，共476行新增、零删除，逐项复核无原因或L3字段。counts/codemap/rbacmap检查通过，现有2WARN/INFO保留；85个实际改动路径全部属于90路径授权。旧D6行为用例单独复核中。

- 旧D6行为本轮23通过、1项anchor_entry_category在beforeEach夹具TRUNCATE阶段超过30秒（61611ms）失败；该项未改代码/断言/超时单独复跑通过（9.627秒，另外26项未运行），不把两次结果写成单轮全绿。contract无更新参数复跑1064项、2快照通过（9.319秒）。已保存本地失败历史，远端全量冷跑仍须独立确认。

- 维护者已确认优化后3b（第123条，c2f06bcf6e19），已按完整摘要登记；4b沿用871a4c9d426d。按已确认验收方式完成本地定向验证，后续提交/推送并创建Draft PR，全量以PR CI冷跑为准；不得登记已合并或D7整体完成。

本次未做：全量可信CI、Ready/合并、D7-2、整体跨模型复审、生产/Gate和任何业务数据删除。提交/推送/Draft PR状态以GitHub为准。
