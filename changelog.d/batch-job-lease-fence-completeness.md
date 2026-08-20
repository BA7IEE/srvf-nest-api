### Fixed

- **批任务状态变更全员带围栏 —— 过期 worker 不得覆盖新一代持有者**(第六轮评审 B-02;零 schema、零端点、零权限码)。
  `ActivityBatchWorker` 的租约围栏此前**只覆盖核心事务**:同一个文件里,
  `releaseReconciliationForRetry` 带 `leaseOwner + leaseGeneration` 围栏,
  而 `releaseForRetry` / `markItemFailed` / `markCommitSucceeded` / `markReadyForCommit`
  四处按裸 `id` 更新 —— **不是能力限制,是不一致**。
  - **可复现时序**:A 领 job(generation=7)→ A 超时但仍在跑 → B 重领(generation=8)
    → B 处理完某 item → A 从旧调用返回、进入异常清理 → A 把 B 已完成的 item 改 `failed`、
    把 B 持有的 job 清回 `pending`、或替 B 跑自动提交并释放它的租约。
  - ⚠️ **「账本插入本身幂等」消不掉这个竞态**(已实测坐实):分录靠
    `ParticipationLedgerEntry.entryKey` 唯一键 `ON CONFLICT DO NOTHING`,重跑不重复插入;
    但 `LedgerPostingBatch.preparedCount` 是**累加式**投影
    (`preparedCount: { increment: chunkMemberIds.length }`),旧 worker 重置已完成 item 后
    下一轮会**再累加一遍** ⇒ `preparedCount > totalCount` ⇒ `finalize` 判
    `LEDGER_PREPARE_COUNT_MISMATCH`,把一个业务上其实已经准备完成的批次判 `failed`。
  - **修复**:四处一律改 `updateMany` + **照抄既有写法**的围栏条件
    (`leaseOwner` + `leaseGeneration`,不自创第二种)。`ActivityBatchJobItem` 本身没有租约列,
    围栏经 `job` 关系过滤(`job: { leaseOwner, leaseGeneration }`)。
  - **落空(0 行)= 安静退出**:过期 worker 发现自己过期是**正常路径**,不是异常 ——
    不抛错、不重试,只落一行 `warn`;`markReadyForCommit` 落空时**放弃本轮**,
    不替新持有者跑 `commitReadyBatch`(与既有 `LedgerPrepareLeaseLostError` 分支同一形状)。
  - ⭐ **主要产出是机器闸**:新增 `src/modules/activities/activity-batch-lease-fence.spec.ts`,
    按 TypeScript AST **动态现取**扫描面(不写死行号、不写「恰 N 条」),断言
    `activity-batch.worker.ts` 内对 `activityBatchJob` / `activityBatchJobItem` 的每一个写点
    where 都含围栏两列,否则**点名 `file:line` 与缺哪个条件**。
    豁免必须**显式登记 + 逐条写理由**(领取 / 两处清道夫 / ready 恢复器,共 4 条),
    没有默认放行;登记了却扫不到的死条目同样红。覆盖面含**裸 SQL**——
    否则「把违规改写成 `$executeRaw`」就是一条现成的逃生门,且围栏必须出现在 `WHERE` 之后
    (`SET "leaseOwner" = NULL` 不能冒充)。
  - **e2e 用 generation 差异构造时序,不用 sleep**:`activity-batch2-8a-auto-commit.e2e-spec.ts`
    新增 4 条,每条都配一条**只在「有没有人重领」这一维上不同**的反面样本 ——
    只断言「A 的清理不生效」是不够的,一个清理**永远**不生效的 worker 也能让它全绿。
  - footprint:Endpoint / BizCode / AuditLogEvent / 权限码 / Migration / Cron **恒等**;
    `ROUTE_AUTHZ.md` 与 `CODEMAP.md` 仅生成器重跑产物(inputDigest + 体量行)。
