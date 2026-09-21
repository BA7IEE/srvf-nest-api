# Activity OS R4 D8 证明读面与正式切换：评审及精确实施计划

> 2026-09-21，D8-1 实施候选已在独立工作树按本计划开工。基线为 `main@2af4462556f8bf13b4b73b971de8da5bc35b5a0e`；
> [#1339](https://github.com/BA7IEE/srvf-nest-api/pull/1339) 已合并，合并后
> [CI 35598127219](https://github.com/BA7IEE/srvf-nest-api/actions/runs/35598127219)
> completed/success，五个 Contract + E2E 分片全部通过。维护者已确认本文第4–6、8.1、9、11节及
> 原87个去重路径的 D8-1 方案 A，以及后续明确扩展的两个治理登记路径，共89个去重路径；仅授权
> `app_test_w98` 隔离验证、验证后提交/推送/创建 Draft PR。
> 当前代码、`docs/current-state.md` 与 GitHub 现场事实仍是执行权威；本授权不包含 Ready、合并、
> 生产、Gate、D8-2 或 D8-OPS。

## 1. 结论先说

D7 的仓内代码已经落完，D8 不再继续扩张“怎么结算”，而是解决两件最后必须说清的事：

1. 队员和有权限的管理者怎样拿到一份可复算、可追溯、不会把旧数据冒充新分类的正式时长证明。
2. 哪一个不可逆时点之后，官方工时统计与新关账开始只认分类时长账本；怎样确保切换时没有一半旧、一半新。

推荐方案 A 分成两个代码 PR 和一个独立运维动作：

- **D8-1：证明与切换地基。** 增加一张不可变切换收据、一张“切换后根账”绑定表、统一真相选择器、
  两个正式证明只读入口和只读预检／切换 CLI。收据不存在时，现有统计行为逐字不变，正式证明入口 fail-closed。
- **D8-2：官方读面切换。** 让 `totalServiceHours`、时间直方图和新关账摘要统一调用同一个真相选择器；
  原始参与账本接口、贡献值、到场人数、报名数和历史关账快照不改语义。
- **D8-OPS：生产切换。** 两个代码 PR 都上线、v1.1 已在更早的独立窗口启用并稳定后，维护者进入结算只读窗，
  跑证据预检并只写一次切换收据。代码合并、部署、v1.1 Gate、D8 切换是四个不同授权。

这样做比一个超大 PR 更快也更稳：D8-1 先把事实、证明和数据库围栏钉死；D8-2 只接消费者；生产动作不夹带在代码 PR。

## 2. 当前基线与真正缺口

| 当前已有                                        | D8 仍缺                                        |
| ----------------------------------------------- | ---------------------------------------------- |
| D1–D3 冻结政策、选择和四类分配                  | 哪一刻开始把分类秒数当官方工时                 |
| D4–D6 桶、工作台、影子对账和不可变分类账本      | 历史旧账与切换后新账怎样在同一证明中诚实共存   |
| D7-1／D7-2 冲回、补记、事实更正和来源证明       | 更正发生在切换后时，怎样仍按根账所属制度解释   |
| v1.1 单轨 Gate 与结算只读维护态                 | D8 不得再造第二个可随意开关的环境变量          |
| 旧 `ParticipationLedgerEntry.serviceHoursDelta` | 正式证明不能把它偷偷改名为 `volunteer_service` |
| `ParticipationTimeLedgerEntry` 四类整数秒       | 面向队员的按日明细、精确合计、版本和摘要       |
| D5 shadow 对账                                  | 真正切换的不可变收据、竞态围栏和运维证据       |

现有 `ActivityWorkflowGate.participationReadSource()` 只在 v1.1 Gate 打开后把统计切到旧参与账本，
它不知道分类时长。D8 不能把该方法改成读取另一个环境变量，否则会重新制造“某个实例读旧、某个实例读新”的混合真相。

## 3. 决策与禁止域

### 3.1 推荐方案 A 的决策

1. **D8 边界是数据库事实，不是可回拨开关。** 单例 `ActivityTimeCutoverReceipt` 不存在即未切换，存在即已切换；
   无 `updatedAt`／`deletedAt`，数据库拒绝 UPDATE、DELETE、TRUNCATE。
2. **按根账归属，不按更正时间归属。** 切换前提交的根账永久走旧认定工时；它在切换后发生的更正仍属于旧制度。
   切换后提交的根账必须有分类账本及切换绑定，后续更正永久走分类制度。
3. **历史服务时长保留，但不伪装。** 旧制度行在证明中标为 `legacy_recognized_service`；
   它可以计入“历史已认定服务时长”，但绝不改标成四类中的 `volunteer_service`。
4. **切换后只有 `volunteer_service` 进入官方服务时长。** `training`、`organization`、`non_creditable`
   分别展示、可审计，但不计入 `eligibleServiceSeconds` 和旧兼容字段 `totalServiceHours`。
5. **贡献值保持旧轨。** D8 不从分类秒数反推贡献，不改 `computeCappedContribution`、入队门槛或
   `ParticipationLedgerEntry` 的 credited/capped-out 语义。
6. **历史不回填、不重分类、不删除。** D8 不批量改旧行，不把影子分类结果倒灌为历史正式类别，也不建立清理任务。

### 3.2 本阶段明确不做

- 不开放匿名公共验真、不签 PDF、不宣称法律证书；本期是登录后、账本支持的正式 JSON 证明。
- 不新增 Integration／Service Token 入口，不允许 AI 自动判定或审核。
- 不新增权限码、角色默认授权、cron、Redis、queue、LLM、vector 或第二套时长账本。
- 不改变原始 `/participation-ledger` 接口含义，不把贡献账本改名成分类时长证明。
- 不重写已存在的 `ActivitySettlementClosureRevision`，只影响切换后新建的关账修订。
- 不自动开启 `ACTIVITY_V11_WORKFLOW_ENABLED`，不在同一运维窗口同时切 v1.1、D8 和贡献口径。
- 不用关闭 v1.1 Gate 回滚 D8。事故处置只允许进入现有 `ACTIVITY_WORKFLOW_READONLY=true` 后前向修复。

## 4. 数据合同与竞态围栏

### 4.1 两个新增模型

`ActivityTimeCutoverReceipt` 是全库单例，推荐完整字段：

| 字段                 | 约束与用途                                                   |
| -------------------- | ------------------------------------------------------------ |
| `id`                 | 固定值 `activity-time-v1`，主键，同时用 CHECK 保证只有这一值 |
| `operationKey`       | 非空、唯一、长度沿既有命令约束；同键同 hash 重放返回原收据   |
| `requestHash`        | 64 位小写十六进制；不同内容复用 operationKey 必须冲突        |
| `deployedMainSha`    | 40 位小写 Git SHA，证明切换针对哪个已部署 main               |
| `evidenceBundleHash` | 64 位小写十六进制，指向 D5／CI／运维证据包摘要，不存大 JSON  |
| `actorUserId`        | FK 到 User；事务内锁后确认 ACTIVE 且持既有 GLOBAL 终审权限   |
| `cutoverAt`          | 数据库 `clock_timestamp()` 生成，客户端不能传可信时间        |
| `formatVersion`      | 固定 1                                                       |
| `contentHash`        | 服务端 canonical payload 的 SHA-256；覆盖上述稳定字段        |
| `createdAt`          | 数据库默认时间；无 `updatedAt`／`deletedAt`                  |

`ParticipationTimeCutoverBinding` 是每个切换后**根账**的一次性绑定：

| 字段                                                   | 约束与用途                                         |
| ------------------------------------------------------ | -------------------------------------------------- |
| `id`、`createdAt`                                      | 不可变行                                           |
| `cutoverReceiptId`                                     | 复合 FK 指向唯一切换收据                           |
| `rootManifestId`                                       | 唯一，复合 FK 到 `ParticipationTimeLedgerManifest` |
| `postingBatchId`                                       | 唯一，且必须与 root manifest 的 batch 同锚         |
| `activityId`、`settlementRunId`、`settlementVersionId` | 复合锚，禁止跨活动拼接                             |
| `rootContentHash`                                      | 与根 manifest 当前 hash 相同，防止只靠 ID 解释     |
| `formatVersion`                                        | 固定 1                                             |

不使用 `committedAt < cutoverAt` 判制度。当前提交时间来自应用时钟，比较墙钟会留下漂移边界；
“有没有 immutable binding”才是唯一制度判据。

### 4.2 切换线性化

新 migration 建一把固定数据库 advisory xact lock，所有 `LedgerPostingBatch` INSERT 与
`ready → committed` 先取共享锁；切换收据 INSERT 先取同键排他锁，再执行以下检查：

1. 全库不存在 `LedgerPostingBatch.statusCode IN ('preparing','ready')`。
2. 不存在 `jobTypeCode='settlement_prepare' AND statusCode IN ('pending','processing')`。
3. 不存在第二张切换收据。
4. 切换请求形状、hash、actor FK 和固定版本均合法。

排他锁持有期间，已经开始的 batch 事务必须先结束；尚未开始的 batch INSERT 会等切换提交后再继续。
切换后的普通根账从 `ready → committed` 时，由同一数据库触发链自动插入 cutover binding；
更正批次不新建 binding，而是继承 `rootManifestId` 的制度。切换后普通根账没有完整 D6 manifest、
或该插入没有形成 binding，整笔 commit 回滚，不能“先提交、以后补证明”。

这把锁是全局切换围栏，不是 member/day 锁，也不改变 D6／D7 既有锁序；实现前须用并发 E2E 证明：
先到的 commit 属旧制度、先到的 cutover 使后续 commit 属新制度，不存在无绑定的第三态。

### 4.3 命令与审计

唯一生产写入口为 `scripts/activity-time-cutover.ts` 调用 `ActivityTimeCutoverService`：

- 默认 `--check-only`，只打印脱敏计数和不满足项；`--execute` 必须显式给
  `--actor-user-id`、`--operation-key`、`--deployed-main-sha`、`--evidence-bundle-hash`。
- 服务层要求 `ACTIVITY_V11_WORKFLOW_ENABLED=true` 且 `ACTIVITY_WORKFLOW_READONLY=true`；
  不满足直接拒绝。CLI 不能修改环境、Gate 或数据库配置。
- actor 在事务内 `FOR UPDATE` 后重读 ACTIVE 状态，并复用
  `activity.settlement-final-review.record` 的 GLOBAL 判权；不新增权限码、不靠角色名放行。
- 新增一个活跃审计事件 `activity.time-cutover.command`；只记 actor、收据 ID、部署 SHA、证据摘要、结果和重放标记，
  不记 token、完整请求、数据库地址或人员明细。首次成功写一次；同任务重放不重复写。

## 5. 唯一真相选择器

新增 `ParticipationTimeTruthQueryService`，成为正式证明、官方统计与新关账唯一可调用的聚合原语。
调用方不得各写一份 SQL。原始 `LedgerQueryService` 继续服务旧参与账本／贡献兼容读面，不改名、不删除。

### 5.1 根账制度

| 根账形状                                         | 正式工时来源                                                         | 更正如何解释                       |
| ------------------------------------------------ | -------------------------------------------------------------------- | ---------------------------------- |
| 无 cutover receipt                               | 沿当前行为；D8 正式证明不可用                                        | 不改变线上口径                     |
| receipt 已存在，root 无 binding                  | `ParticipationLedgerEntry.serviceHoursDelta` 的 committed 净额       | 后续 correction batch 仍计旧账净额 |
| receipt 已存在，root 有 binding                  | D6 根 `ParticipationTimeLedgerEntry` + D7 committed correction delta | 始终沿同一 `rootManifestId` 聚合   |
| root/binding/receipt/commit receipt 不完整或多义 | fail-closed                                                          | 不回退旧账、不猜测                 |

旧制度 Decimal(5,2) 小时精确换算为秒：`小时百分位 × 36`，无浮点；新制度直接使用整数秒。
所有合计先在整数秒域完成。旧兼容字段 `totalServiceHours` 只在最外层把总秒数除以 3600，
统一四舍五入到两位小数；不得逐行四舍五入后再求和。

### 5.2 分类和历史标签

正式证明展示五种 `sourceCategoryCode`：

- `legacy_recognized_service`：切换前旧制度已认定服务时长，保留原 `ledgerDate` 和来源锚；
- `volunteer_service`、`training`、`organization`、`non_creditable`：切换后分类账本四类。

`legacy_recognized_service` 是历史标签，不写回 D3/D6 类别列。任何真实
`legacy_unclassified`、未知类别、缺根 manifest、缺 commit receipt、D7 predecessor 分叉、source proof／binding 不完整，
正式证明和官方聚合都具名失败；不能把异常归零或偷偷回退旧 serviceHours。

`eligibleServiceSeconds = legacy_recognized_service + volunteer_service`。
同时返回各类独立合计，让接收方看得见历史与新制度差异。培训、组织、不可计入时长不丢失，但不进入 eligible。

### 5.3 日期与更正

- 旧制度按 `ParticipationLedgerEntry.ledgerDate` 聚合。
- 新制度按最终有效 allocation slices 以 `Asia/Shanghai` 拆日，再用确定性最大余额法把每个类别的
  recognized seconds 分配到自然日；逐日之和必须精确等于根项加 committed correction delta。
- D7-1 同事实类别更正按根 entry + correction delta 得到有效秒数；D7-2 事实更正只认冻结的
  `CorrectionTimeSourceProof` 与 `CorrectionTimeAllocationBinding`，不扫描 latest 猜来源。
- 根账与更正链按稳定键排序；同一根项每一类别只允许一个有效净额，负数、溢出、双 predecessor、孤儿 reversal 全部拒绝。

## 6. 正式证明 API

复用现有两个 ledger controller，避免新建第二套访问面：

| 路由                                                           | 资格                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET /api/app/v1/my/participation-time-proof`                  | 当前 App 准入 + self；memberId 只能来自 `AppIdentityResolver`                               |
| `GET /api/admin/v1/members/:memberId/participation-time-proof` | 既有 `attendance.read.sheet`，service 层按 member resource 做 scoped authz／GLOBAL fallback |

查询参数：`dateFrom`、`dateTo`、`page`、`pageSize`；日期最多 366 天，pageSize 1..100，完整证明集合最多 10,000 行，
超限具名拒绝而不是截断摘要。稳定顺序为 `ledgerDate, activityId, rootManifestId, participationIdentityId, sourceCategoryCode, sourceEntryId`。

响应至少包含：

- `proofVersion=1`、`cutoverReceiptId`、`cutoverAt`、`asOf`、`memberId`、请求区间；
- `legacyRecognizedSeconds`、四类秒数、`eligibleServiceSeconds`；
- 分页明细及每行的 activity／日期／类别／秒数／根账／最新更正／来源模式；
- `proofSetHash`：对**完整区间集合**的 canonical payload 求 SHA-256，不受当前页影响；
- `isPubliclyVerifiable=false` 与清晰 provenance；不返回姓名之外的新 PII、理由全文、附件内容或 signed URL。

读取使用 `REPEATABLE READ` 事务，在同一 snapshot 内计算完整 hash、合计和当前页。
receipt 不存在时返回具名 `503`，不把 shadow 数据包装成正式证明。相同数据库 snapshot 与查询区间必须得到相同 hash。

## 7. D8-2 官方读面语义

切换收据不存在时，下列服务必须保持当前测试逐字通过；存在后统一调用真相选择器：

1. `ParticipationSummaryQueryService.totalServiceHours`：按该队员全部根账的 eligible 秒数转换为兼容小时。
2. `ActivityParticipationQueryService`：逐队员和活动总时长切为 eligible；报名、到场、no-show、反馈和贡献仍按现行事实源。
3. `ParticipationOverviewQueryService.totalServiceHours`：按活动 eligible 秒数汇总。
4. `durationHistogram`：正式定义为每个 `(activityId, memberId)` 的 eligible 秒数，按精确秒边界
   `[0,7200) / [7200,14400) / [14400,28800) / [28800,∞)` 计一次；不再按旧 AttendanceRecord 行计。
5. `ActivityClosureService`：切换后新建 closure 的 `serviceHours` 使用该活动 eligible 秒数；
   `contributionPoints` 仍取旧贡献账本，人数与结果计数不变。已有 immutable closure 不回写。

原始 `/participation-ledger` 和嵌套 `ledgerTotals` 明确继续表示兼容贡献账本；不在 D8-2 暗改响应名或历史含义。

## 8. 三段交付与 DoD

### 8.1 D8-1：证明与切换地基

DoD：

1. 第129条 additive migration 冷回放、128→129 非空升级、旧128条 checksum 全不变。
2. 两新表复合锚、singleton、immutable、hash、同链、普通根账 binding 和 correction 继承均有正反例。
3. batch／cutover 两种先后顺序的真实 PostgreSQL 并发测试证明线性化，无固定 sleep。
4. receipt 缺失时现有统计 characterization 零差异，证明 API 具名不可用。
5. 证明 API 覆盖 self、admin scoped／GLOBAL、撤权、停用、跨 member、范围、分页、hash、跨北京午夜、四类、历史标签和 D7 两类更正。
6. 1／100／2,000 身份与 10,000 行证明集合测试；冻结查询预算后不得按人员／条目 N+1。
7. OpenAPI、contract、客户端、handoff、权限／审计登记、生成文档和3b/4b重签完整。

### 8.2 D8-2：官方统计与关账接线

DoD：

1. receipt absent 的现有统计／关账全部保持原断言；receipt present 才切换。
2. 切换前根账 + 切换后更正仍走 legacy；切换后根账 + 后续更正走 classified；两者在同一成员／活动下不重不漏。
3. total、逐成员、月度 overview、直方图、新 closure 五个消费者与证明合计逐项相等。
4. 贡献、报名、到场、no-show、反馈、原始 ledger、历史 closure 零漂移。
5. 任何不完整链 fail-closed；不以旧账 fallback 掩盖。
6. w98 定向验证后由 PR CI 全量冷跑；不得删测试、放宽断言、增加固定等待或抬业务超时。

### 8.3 D8-OPS：独立生产切换

硬顺序：

1. D8-1、D8-2 均已合入并部署同一 exact main SHA，PR CI 与最终 main CI 成功。
2. v1.1 Gate 已在**更早的独立窗口**完成启用与稳定验收；本窗口不切 v1.1 或贡献。
3. 归档 D5 shadow、D6/D7 满额、迁移、权限、审计和业务抽样证据，计算 `evidenceBundleHash`。
4. 设置 `ACTIVITY_WORKFLOW_READONLY=true`，确认 fleet 同版本、worker 排空；不关 v1.1 Gate。
5. 先跑 CLI `--check-only`；所有机器项通过、维护者签字后才跑一次 `--execute`。
6. 重跑 check，抽验 self/admin proof、统计、关账预检、原始 ledger 与贡献未变，再退出只读。
7. 失败时保持只读并前向修复。禁止删 receipt、改 cutoverAt、回切旧 Gate、回滚到不识别 receipt 的旧二进制。

## 9. D8-1 精确候选写集

这是未来 D8-1 的逐文件上限，不是当前写权限。新文件标注“新增”；生成物只允许运行既有生成器刷新。
实施前须从最新 main 新建独立 worktree，再跑精确 `harness:needs`；有差异先回到本文更正，不能临场扩目录。

### 9.1 业务、数据库、测试与交接

1. `prisma/schema.prisma`
2. `prisma/migrations/20260921180000_activity_os_r4_d8_proof_cutover/migration.sql`（新增）
3. `prisma/CLAUDE.md`
4. `src/common/exceptions/biz-code.constant.ts`
5. `src/modules/audit-logs/audit-logs.types.ts`
6. `src/modules/activities/CLAUDE.md`
7. `src/modules/activities/activity-time-cutover-command.ts`（新增）
8. `src/modules/activities/activity-time-cutover-command.spec.ts`（新增）
9. `src/modules/activities/activity-time-cutover.service.ts`（新增）
10. `src/modules/activities/activity-time-cutover.service.spec.ts`（新增）
11. `src/modules/activities/activity-time-cutover-audit-recorder.ts`（新增）
12. `src/modules/activities/activity-time-cutover-audit-recorder.spec.ts`（新增）
13. `src/modules/activities/participation-time-truth-query.service.ts`（新增）
14. `src/modules/activities/participation-time-truth-query.service.spec.ts`（新增）
15. `src/modules/activities/participation-time-proof-query.service.ts`（新增）
16. `src/modules/activities/participation-time-proof-query.service.spec.ts`（新增）
17. `src/modules/activities/participation-time-proof.presenter.ts`（新增）
18. `src/modules/activities/participation-time-proof.presenter.spec.ts`（新增）
19. `src/modules/activities/dto/app/app-participation-time-proof.dto.ts`（新增）
20. `src/modules/activities/dto/admin/admin-participation-time-proof.dto.ts`（新增）
21. `src/modules/activities/controllers/app-my-participation-ledger.controller.ts`
22. `src/modules/activities/controllers/admin-member-participation-ledger.controller.ts`
23. `src/modules/activities/activities.module.ts`
24. `scripts/activity-time-cutover.ts`（新增）
25. `test/setup/reset-db.ts`
26. `test/setup/time-ledger-fixture-cleanup.ts`
27. `src/common/datetime/clock-authority.spec.ts`
28. `test/e2e/activity-os-r4-d8-proof-cutover-migration.e2e-spec.ts`（新增）
29. `test/e2e/activity-os-r4-d8-proof-cutover.e2e-spec.ts`（新增）
30. `test/e2e/activity-os-r4-d8-proof-cutover-concurrency.e2e-spec.ts`（新增）
31. `test/e2e/activity-os-r4-d8-participation-time-proof.e2e-spec.ts`（新增）
32. `test/contract/openapi.contract-spec.ts`
33. `test/contract/__snapshots__/openapi.contract-spec.ts.snap`
34. `harness/permission-surface-baseline.json`
35. `harness/authz-assertion-patterns.json`
36. `harness/domain-map.json`
37. `harness/state-machines.json`
38. `CODEMAP.md`
39. `docs/current-state.md`
40. `docs/ai-harness/AUDIT_EVENT_REGISTRY.md`
41. `docs/ai-harness/ROUTE_AUTHZ.md`
42. `docs/ai-harness/RBAC_MAP.md`
43. `docs/ai-harness/CUTOVER_SIGNOFF.md`
44. `docs/handoff/openapi.json`
45. `docs/handoff/contract-version-registry.md`
46. `docs/handoff/admin-web.md`
47. `docs/handoff/miniapp.md`
48. `docs/handoff/clients/admin/client.ts`
49. `docs/handoff/clients/admin/types.ts`
50. `docs/handoff/clients/app/client.ts`
51. `docs/handoff/clients/app/types.ts`
52. `docs/handoff/clients/auth/client.ts`
53. `docs/handoff/clients/auth/types.ts`
54. `docs/handoff/clients/integration/client.ts`
55. `docs/handoff/clients/integration/types.ts`
56. `docs/handoff/clients/open/client.ts`
57. `docs/handoff/clients/open/types.ts`
58. `docs/handoff/clients/shared/types.ts`
59. `docs/handoff/clients/system/client.ts`
60. `docs/handoff/clients/system/types.ts`
61. `docs/ops/activity-time-cutover.md`（新增）
62. `docs/ops/activity-time-ledger.md`
63. `docs/plans/activity-os-r4-d8-proof-cutover-review-and-plan.md`
64. `changelog.d/activity-os-r4-d8-proof-cutover-review.md`
65. `docs/ai-harness/NEXT_TASKS.md`
66. `docs/ai-harness/FROZEN_DRAFTS.md`

### 9.2 当前迁移总数 128→129 的既有测试适配

只改“当前总数／冷回放到 current”的数字和标题；各历史升级目标、固定索引、业务断言与失败语义保留：

67. `test/e2e/activity-os-r1-a3-template-definition-lifecycle-guards.e2e-spec.ts`
68. `test/e2e/activity-os-r1-a4-explicit-template-version-pointer.e2e-spec.ts`
69. `test/e2e/activity-os-r2-b1-place-schema-constraints.e2e-spec.ts`
70. `test/e2e/activity-os-r2-b2-coordinate-projection-schema-constraints.e2e-spec.ts`
71. `test/e2e/activity-os-r2-b3-form-blueprint-governance.e2e-spec.ts`
72. `test/e2e/activity-os-r2-b6-creation-data-foundation.e2e-spec.ts`
73. `test/e2e/activity-os-r3-c1-d2a-metric-command-receipt-migration.e2e-spec.ts`
74. `test/e2e/activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts`
75. `test/e2e/activity-os-r3-c1-metric-definition-set.e2e-spec.ts`
76. `test/e2e/activity-os-r3-c2-outcome-value-revision.e2e-spec.ts`
77. `test/e2e/activity-os-r4-d1-1-time-policy-migration.e2e-spec.ts`
78. `test/e2e/activity-os-r4-d1-3-selection-migration.e2e-spec.ts`
79. `test/e2e/activity-os-r4-d3-time-allocation-revision-migration.e2e-spec.ts`
80. `test/e2e/activity-os-r4-d4-time-bucket-migration.e2e-spec.ts`
81. `test/e2e/activity-os-r4-d6-time-ledger-migration.e2e-spec.ts`
82. `test/e2e/activity-os-r4-d7-2-fact-correction-migration.e2e-spec.ts`
83. `test/e2e/activity-os-r4-d7-time-correction-migration.e2e-spec.ts`
84. `test/e2e/activity-v11-batch4-allocation-candidate-position-anchor-migration.e2e-spec.ts`
85. `test/e2e/activity-v11-batch4-allocation-command-replay-migration.e2e-spec.ts`
86. `test/e2e/activity-v11-batch4-allocation-determinism-migration.e2e-spec.ts`
87. `test/e2e/activity-v11-batch4-allocation-mode-migration.e2e-spec.ts`
88. `test/e2e/activity-v11-batch4-qualification-contract-migration.e2e-spec.ts`
89. `test/e2e/insurance-evidence-registration-revision-migration.e2e-spec.ts`

D8-1 共 89 个去重候选路径：原计划87个，另有维护者明确扩写并授权的两份治理登记。
新 migration 和既有 schema／seed 读数以实施时 main 为准；生成器可能零 diff 的文件仍不冒充必改。

## 10. D8-2 精确候选写集

D8-2 只接官方消费者，不新增 schema、migration、权限、审计事件或 API 路由。它可以再次修改 D8-1 的统一原语，
但不得复制 SQL 到调用方。

下列 `activity-time-cutover*`、`participation-time-truth-query*` 与 cutover runbook 在当前 main 尚不存在，
它们由 D8-1 创建；D8-2 必须在 D8-1 合入后开工，因此在 D8-2 中属于既有路径，不重复标“新增”。

1. `src/modules/activities/activity-time-cutover.service.ts`
2. `src/modules/activities/activity-time-cutover.service.spec.ts`
3. `src/modules/activities/participation-time-truth-query.service.ts`
4. `src/modules/activities/participation-time-truth-query.service.spec.ts`
5. `src/modules/attendances/participation-summary-query.service.ts`
6. `src/modules/activities/activity-participation-query.service.ts`
7. `src/modules/activities/activity-participation-query.service.spec.ts`
8. `src/modules/meta/participation-overview-query.service.ts`
9. `src/modules/activities/activity-closure.service.ts`
10. `src/modules/activities/activity-participation-metrics.ts`
11. `test/e2e/activity-v11-participation-read-consistency.e2e-spec.ts`
12. `test/e2e/participation-metrics.e2e-spec.ts`
13. `test/e2e/participation-overview.e2e-spec.ts`
14. `test/e2e/activity-settlement-closure.e2e-spec.ts`
15. `test/e2e/activity-settlement-closure-concurrency.e2e-spec.ts`
16. `test/e2e/activity-os-r4-d8-official-time-cutover.e2e-spec.ts`（新增）
17. `docs/ops/activity-time-cutover.md`
18. `docs/ops/activity-time-ledger.md`
19. `docs/handoff/admin-web.md`
20. `docs/handoff/miniapp.md`
21. `CODEMAP.md`
22. `docs/plans/activity-os-r4-d8-proof-cutover-review-and-plan.md`
23. `changelog.d/activity-os-r4-d8-proof-cutover-review.md`
24. `docs/ai-harness/NEXT_TASKS.md`
25. `docs/ai-harness/FROZEN_DRAFTS.md`

D8-2 共 25 个去重候选路径。若实现发现必须动 DTO、module、Gate、schema 或迁移，视为方案冲突，先停下更正计划，
不得以“顺手接线”扩写集。

## 11. 验证预算与失败处理

- 本地数据库只使用维护者当轮明确授权的隔离库；建议延续 `app_test_w98`，重建只限测试夹具。
- D8-1 先 characterization，再 migration、并发、证明 HTTP；D8-2 先 receipt-absent 零差异，再 receipt-present 新语义。
- 正式 proof 单成员／366天：业务查询建议不超过 40；官方批量 activity 汇总按 1／100／2,000 人分别冻结预算，
  查询数不得随人数逐条增长。实际预算由实施测量后写回，不用本稿数字掩盖超限。
- 业务事务超时、Jest 总时限和 CI 分片上限保持现值。超时先分段诊断和集合 SQL 优化，不固定 sleep、不盲目重跑、不抬上限。
- 任一既有 E2E 需要改变行为断言，只允许本文已经明确批准的“receipt present 后官方时长／直方图／新 closure”三类；
  其它断言变化立即上报。
- 本地定向通过后创建 Draft PR；完整冷跑由 PR CI 完成。Ready、可信红区审批、合并、main CI 与生产切换分别记录。

## 12. 一次性授权清单

### 12.1 已完成的 docs-only PR

维护者已授权的当前写集只有本文、两份台账和 changelog 共四份；`harness:needs` 为零红区。
允许验证、提交、推送并创建 docs-only Draft PR；不实施 D8、不操作数据库、不 Ready、不合并、不启用 Gate。

### 12.2 D8-1 当前授权与实施状态

推荐确认语句：

> 确认 D8-1 方案 A，按 D8 计划第4–6、8.1、9、11节及89个去重路径执行；允许 app_test_w98
> 隔离验证及测试夹具重建；验证后提交、推送并创建 Draft PR。不合并、不操作生产、不启用 Gate、不删除业务数据。

维护者先确认原87路径方案 A，随后明确扩展 `harness/domain-map.json` 与
`harness/state-machines.json`，并已在**实际实施 worktree**运行精确红区 grant；AI 未运行 grant。
当前已完成第129条 migration、切换服务/CLI、统一真相选择器、两个正式证明入口、配套单测与
`app_test_w98` 的冷回放/非空升级/并发/真实 HTTP 定向验证。第129条实际 SQL SHA-256 的3b，
以及权限265、审计170总计／165活跃、字典30类／277项、seed与权限目录实际摘要的4b均已由维护者重签。
Draft [#1341](https://github.com/BA7IEE/srvf-nest-api/pull/1341) 首轮冷跑暴露的架构读取、Prisma时钟默认值、
D8新外键下旧夹具清理与D7历史迁移索引问题，已在本节授权路径内完成修复；migration SQL 未改，3b摘要仍为
`bdfaeae5029b113c66cc85923a2e1b5307c69fe892a1c232edf3281c5672305e`。本地unit 20/20、C1旧迁移63/63、
D7历史升级5/5、D8四套9/9、B6 30/30、contract 1,074/1,074及静态门禁通过；B6首轮CI 500未本地复现，
下一步提交推送新SHA并交#1341冷跑，不据一次本地通过宣称根因已修，不Ready、不合并。

### 12.3 D8-2 将来实施需单独确认

推荐确认语句：

> 确认 D8-2 方案 A，按 D8 计划第7、8.2、10、11节及25个去重路径执行；允许 app_test_w98
> 隔离验证及测试夹具重建；验证后提交、推送并创建 Draft PR。不合并、不操作生产、不启用 Gate、不删除业务数据。

D8-2 无新 migration／权限／审计，仍需行为合同和最终 SHA 的正常 PR／可信审批；D8-1 的数据库授权不得跨 worktree 继承。

### 12.4 D8-OPS 永远独立

即使 D8-1／D8-2 都合并，也没有生产切换权限。届时必须以 exact deployed SHA、证据摘要、只读窗口和命令参数另行请示；
AI 不自行部署、不修改生产环境、不执行生产 CLI。

## 13. 风险表

| 风险                         | 物理防线                                                | 验收                                         |
| ---------------------------- | ------------------------------------------------------- | -------------------------------------------- |
| cutover 与 batch commit 交错 | 同一 advisory shared/exclusive fence + 同事务 binding   | 两个先后顺序的真实并发 E2E                   |
| 用更正时间误判制度           | 只看 root manifest 的 cutover binding                   | legacy root 在切换后更正仍 legacy            |
| 旧数据冒充志愿类别           | 独立 `legacy_recognized_service`，禁止写回四类          | proof payload 与 DB 无回填断言               |
| 分类链损坏后静默回旧账       | 统一 selector fail-closed                               | 缺 receipt／proof／binding／predecessor 负例 |
| 各统计自己写 SQL 导致分叉    | 唯一 `ParticipationTimeTruthQueryService`               | 五消费者与 proof 合计对拍                    |
| 秒转小时丢精度               | 整数秒求和，出口一次 round                              | 跨日／零点／余数用例                         |
| 提前执行切换                 | v1.1=true + readonly=true + actor GLOBAL + ops 独立授权 | CLI check-only 与 execute 负例               |
| 回滚造成历史重解释           | receipt／binding immutable，无关闭开关                  | UPDATE/DELETE/TRUNCATE 与旧二进制 SOP        |
| 证明泄露敏感信息             | self/scoped authz，DTO闭集，不返理由/附件/signed URL    | contract diff + 越权 E2E                     |
| D8 又变成多日超大 PR         | D8-1、D8-2、D8-OPS 串行拆分                             | 每刀独立 write set、CI、合并证据             |

## 14. D8-1 实施验收记录

当前候选已实测：第129条冷回放、128→129非空升级和数据库约束 3/3；cutover 业务链 3/3；
两种真并发顺序 2/2；正式证明 HTTP 真链 1/1；D8-1 新增单测 41/41。真 HTTP 已覆盖 App self、
Admin scoped 跨 member、撤权、GLOBAL 回退和 member 停用；选择器在 1／100／2,000 身份及
10,000 行时固定为 5 条业务 SQL，合并集合 10,001 行具名拒绝。实测期间抓出并修复四个真问题：
数据库具名约束错误的应用层映射不完整；无更正根账的 `null` proof 被误判为存在 proof；legacy 根账
遗漏 D7 链/收据校验；D7-2 冻结 slice 缺失时错误回退 root slice。修复后保留 fail-closed，并将
根账、更正和 slice 分组从逐项扫描收敛为集合映射。OpenAPI 差异已逐项审查，只新增两条路由和四个 DTO；
`rootManifestId` / `latestCorrectionManifestId` 的 nullable string 形状已显式锁定，定向 contract 1,074 项通过。

最终代码回归又抓出并修复两项架构偏差：cutover 检查结果不再复用只读配置的受保护字段名；北京日拆分
改为调用 `splitSpanByBeijingDay` 单一原语，不保留第二套时区算法。修复后全仓单测 405/405 套、
8,810 项通过（另有 5 项既有 todo），build 与 6 GiB CI 同口径 lint 通过；上述四套 w98 E2E 已重新
冷建并 9/9 通过。维护者随后扩写并授权原87路径漏列的 `harness/domain-map.json` 与
`harness/state-machines.json`：前者仅登记两个新增模型属主并刷新输入摘要，后者仅刷新 schema 输入摘要，
未新增状态机或生命周期；3b/4b 也已按实际读数重签。最终 Harness 自证 561／138／68 项全部通过，
build、6 GiB CI 同口径 lint、OpenAPI／客户端／权限／审计／台账／派生文档检查均通过；89 路径授权上限内
最终实际变更86路径、零越界，`RBAC_MAP.md`、`authz-assertion-patterns.json` 与 `reset-db.ts` 最终相对基线零 diff。
Draft #1341 首轮冷跑后的兼容修复已完成本地收口，下一步提交推送新 SHA；完整 Contract + E2E 冷跑仍由 PR CI 验收。

## 15. 本次未做

本轮没有实施 D8-2，没有改动现有官方统计、直方图、新关账或历史 closure 语义；没有开启 Gate、
没有生产部署或执行 cutover CLI，没有 Ready、合并、历史回填、重分类或删除业务数据。
整体跨模型复审仍按维护者此前决定留到仓内整体实现完成后统一执行，不把本计划评审冒充独立复审通过。
