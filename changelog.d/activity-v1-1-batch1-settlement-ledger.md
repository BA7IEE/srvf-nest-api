### Added

- **活动业务改造 v1.1 第 1 批第四刀:结算 / 账本 / 更正 / 关账 / 任务 schema expand**
  (第 **74** migration
  `20260804080000_activity_v11_slice4_settlement_ledger_correction_closure_job`;合同
  [`docs/archive/reviews/activity-business-overhaul-v1.1/`](docs/archive/reviews/activity-business-overhaul-v1.1/)
  §3.19..§3.27,批次划分见 §14「第 1 批」建议拆分第 4 项)。

  净新 **14 张空表**:`AttendanceSettlementRun` / `AttendanceSettlementVersion` /
  `SettlementReviewAction`(§3.19)、`ParticipantSettlementResultRevision`(§3.20)、
  `ParticipantSettlementDay`(§3.21)、`LedgerPostingBatch`(§3.22)、
  `ParticipationLedgerEntry` + `LedgerEntryReversalClaim`(§3.23)、
  `MemberContributionDayState`(§3.24)、`AttendanceCorrectionRequest` /
  `CorrectionApplication`(§3.25)、`ActivitySettlementClosureRevision`(§3.26)、
  `ActivityBatchJob` / `ActivityBatchJobItem`(§3.27)。

  既有表加 **2 列,均可空**,都是**兑现第三刀欠下的跨切片外键列**(目标表正是本刀建的):
  `ParticipantServiceSegmentRevision.effectiveBatchId` → `LedgerPostingBatch`、
  `AttendancePunchEvent.importJobItemId` → `ActivityBatchJobItem`。

  **expand-only:零 DROP / 零 RENAME / 零既有列语义变更 / 零回填 / 零删数 / 零 enum。**
  十四张新表**零调用方 / 零端点 / 零 DTO / 零权限码 / 零 audit / 零 seed** —— 纯 schema 刀,
  契约 snapshot 一字未动;消费方在第 2 批。**零新增 cron**(全仓终态仍恰 2)、
  零 Redis / queue、零新 worker 进程。生产未 deploy。

  末尾 **42 条手写约束**:37 条 CHECK + 4 条 partial unique + **1 组 append-only trigger**
  (本仓第三组同形状 trigger)。判据钉在
  `test/e2e/activity-v11-slice4-schema-constraints.e2e-spec.ts`(**82 例**,含 25 条正对照)。

  五处值得记的落点:

  - 🔴 **`recognized = credited + cappedOut`(§3.23.6)是本刀最高危的一条 —— 纯算术等式,
    NULL 陷阱的教科书形状。** 三列任一为 NULL 时朴素等式求值成 NULL,而 CHECK 在 NULL 时
    **判通过** ⇒ 约束静默失效,且只在"恰好有 NULL"的那些行上失效,正对照全绿完全看不出来。
    落了**两道**独立防线:①四个 delta 列全部 NOT NULL;②CHECK 自身把三条 `IS NOT NULL`
    守卫写在 **AND 链最前**(AND 是 FALSE-主导 ⇒ 整式塌成 FALSE 而不是 NULL)。
    第二道**已实测而非推理**:在 scratch 库上 `DROP NOT NULL` 后插 NULL 行,仍被 23514
    拒;换成朴素式 `a = b + c` 之后,**同一行被静默放行并真的入库**(变异 A/B 双向)。
  - 🔴 **`ParticipationLedgerEntry` 由 DB trigger 强制 append-only**(§3.23.8「只允许
    INSERT;数据库角色层禁止业务账号 UPDATE/DELETE」),镜像第三刀
    `trg_attendance_punch_event_10_append_only` 的函数 + trigger 两段范式,`ERRCODE='55000'`。
    四条判据全部实测:INSERT 放行(正对照)/ UPDATE 拒 / DELETE 拒 / **TRUNCATE 仍放行且
    trigger 存活** —— 第四条是 e2e 地基(`reset-db.ts` 靠 TRUNCATE 清库,本表不在
    TRUNCATE 列表里、靠引用 `Activity` / `Member` 被 CASCADE 带走)。
    **加列之后重跑了第三刀打卡 trigger 的同一组四条判据**,证明 `ALTER TABLE ADD COLUMN`
    没把既有 trigger 顺手弄坏。
  - ⚠️ **「日合计必须 0..3」(§3.24)刻意不进 DB,一条 CHECK 都不加,更不用 trigger 伪造。**
    它是**跨行**不变量(同 member 同 ledgerDate 多条分录求和),表级 CHECK 只能看单行;
    用 trigger 求和会在并发下**骗人**(两个事务各自看不见对方未提交的行,双方都判"没超"),
    比没有更危险。执行位归第 2 批 service,在**既有** member advisory lock 内按
    `(memberId, ledgerDate)` 排序 `FOR UPDATE`。连 `MemberContributionDayState`
    `.committedCreditedPoints`(物化日合计)上的单行 range CHECK 也**没加** —— 加了会让人
    误以为日上限已有 DB 执行位。"刻意"用**两条会变红的判据**钉死:①同人同日合计 6.0 的
    两条分录**必须放行**;②账本三表上不得出现 append-only 之外的任何 trigger。
  - 🔴 **`ledgerDate` 三处同型 `@db.Date`**(§3.21 明写「必须唯一选型」):
    `ParticipantSettlementDay` / `ParticipationLedgerEntry` / `MemberContributionDayState`,
    `information_schema` 实测三行全 `date`。混型(date vs timestamp)会让
    `(memberId, ledgerDate)` 唯一在跨表 join 时静默错位。
    列型同时对第 0 批结论友好:全是明确标量、无逐行表达式 ⇒ 第 2 批的日状态批量回写可以走
    `unnest($1::text[], $2::date[], …)`,bind 数恒等于列数、与人数无关(逐行 VALUES 每人
    4 参数会在 8191 人处撞上实测 32767 的 bind 上限,10000 人确定性失败)。
  - 🔴 **`attendance_correction_request_open_unique` 必须带 `NULLS NOT DISTINCT`**
    (PG15+;沿第二刀 `activity_invitation_active_unique` 先例):键含**可空**的
    `participationIdentityId`(NULL = 活动级更正)。不带该子句时同一活动可以被提出任意多条
    并行的活动级 open 更正而一条都不被拦 —— 索引恰好在它最该生效的那类行上完全失效,
    **而人员级因该列有值照样被拦,漏写在只测人员级的用例里完全看不出来**。
    已跑变异 A/B:去掉子句后第二条活动级 open 直接入库。

  与合同的偏离(逐条在 PR body 展开):`ActivityBatchJobItem` 的
  `resourceType` / `resourceId` **改可空**(合同字段表未标 `?`,但 `import_preview` 这类
  "资源尚未创建"的任务此刻没有资源可指);`AttendanceSettlementVersion.returnFromStage`
  的取值集从**同节** SettlementReviewAction 的 `first/final` 推导(§3.19 没有单列它);
  §3.23.7 只说"小数位和范围有 CHECK"没给数值,范围值全部从合同其它条款推导
  (时长 ±24 ← §3.21 按北京自然日拆分;credited ±3 ← §3.24 日合计 0..3;
  recognized / cappedOut **不设**上界 —— 它们是封顶**前**的值,设了会误杀合法行)。
  **小数位这一半诚实说明:`numeric(5,2)` 对多余小数是四舍五入而不是报错,DB 层做不到
  "既保留原值又拒绝",若业务要求报错,执行位只能在第 2 批 service/DTO。**
  合同**未给**的一律不发明:`ActivityBatchJobItem.statusCode` **不落闭集 CHECK**
  (§3.27 给了 Job 的七值、没给 Item 的),并用一条"任意值必须放行 + 该表零 statusCode
  CHECK"的 e2e 把这个**合同缺口**钉成会变红的判据。
  §3.11 分配相关四表与 `allocationBatchId` 是**合同第四处内部矛盾**(§14 任何一刀都没列入,
  第 4 批行为实现却要用),维护者 2026-08-04 拍板**另走第五刀**,本刀不建、不占位。
