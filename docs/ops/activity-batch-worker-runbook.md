# ActivityBatchWorker 运维 SOP

> 对象:`src/modules/activities/activity-batch.worker.ts` 的 `ActivityBatchWorker`(合同 §3.27)。
> **当前尚无正式生产环境。** 本文写的是这个 worker **今天在代码里的真实行为**,不是将来的目标形态;
> 未来具备正式环境后,必须用届时的 release 构建物重新复核全文。
>
> 🔴 **证据纪律(本文最重要的一条)**:每一条都注明实测依据(`文件:行` 或实跑输出)。
> **代码里没有的东西,本文如实写「没有」,并写明代偿与盲区。** 尤其是[§2 健康检查](#2-健康检查)——
> 今天**不存在**真正的健康检查,本文**不把恢复机制包装成健康检查**。
>
> 合同 §16.1 第 ⑦ 条的机器判据:`pnpm cutover:check`(`scripts/cutover-check.ts` 里 ⑦ 那一条的
> `sub('7a'…)` / `eviSub('7c'…)` 五个子判据)。⚠️ **这里刻意不写行号** —— 那个文件在动,
> 行号会静默过期,而「行号全对、转述却错」是本仓已记录的事故形状。
>
> 📎 **行号约定**:只写冒号加数字的**裸行号,一律指本文对象文件**
> `src/modules/activities/activity-batch.worker.ts`;指别的文件时一定带上文件名。**全文无例外。**

## 0. 先搞清楚它是什么

**它不是一个独立服务。** 它是一个 `@Injectable()` 类,由两个**既有** worker 进程各起一份
`run()` 循环;全仓零新增 cron、Redis、外部队列、新进程(`activity-batch.worker.ts:43-57`)。

它认四个任务家族(候选谓词 `activity-batch.worker.ts:396-412`):

| `jobTypeCode` | 来源 | 领取优先级 |
|---|---|---:|
| `settlement_prepare` | 账本分块准备 → ready → 自动提交 | 0(最高) |
| `reconciliation` | 活动开始后的 pending/waitlisted/邀请过期对账 | 1 |
| `bulk_proxy`(`payload.action='onsite_bulk_punch'`) | B6 现场批量打卡 | 2 |
| `import_execute`(`payload.action='onsite_import_execute'`) | B6 考勤导入执行 | 2 |

同优先级内按 `availableAt ASC, createdAt ASC`(`:417-424`)。

运维需要记住的五个常量:

| 含义 | 值 | 位置 |
|---|---|---|
| 租约时长 `ACTIVITY_BATCH_LEASE_MS` | **5 分钟** | `activity-batch.worker.ts:77` |
| 最大尝试次数 `ACTIVITY_BATCH_MAX_ATTEMPTS` | **5** | `:80` |
| 失败退避 `ACTIVITY_BATCH_RETRY_BACKOFF_MS` | **30 秒**(固定,非指数) | `:83` |
| 一轮最多补建任务数 `ENQUEUE_SCAN_LIMIT` | 20 | `:86` |
| 空队列轮询间隔 | **500 毫秒** | `:143` / `:146` |

三个方法别搞混(这个区别直接影响运维预期):

| 方法 | 行为 | 位置 |
|---|---|---|
| `run()` | **守护循环**。`while (!this.stopping)`,空队列时睡 500ms 再来。两个 worker 进程启动的就是它。 | `:137-152` |
| `drainOnce()` | **只跑一轮**,自身不睡眠。 | `:158` |
| `drainUntilIdle(maxRounds = 100)` | 反复 `drainOnce` 直到队列空,**有界**、无定时器 —— 供显式 / 测试排空用,**不是**进程守护循环。 | `:310-322` |

---

## 1. 启动命令

### 1.1 先构建

两个入口都是 `node dist/...`(`package.json:17-18`),所以必须先出构建物:

```bash
pnpm build
```

实测产物:`dist/notification-outbox-worker.js`、`dist/storage-consistency-worker.js`。

### 1.2 起哪个进程 = 起了它

**没有 `start:activity-batch-worker` 这个脚本,不要去找。** 它挂在下面两个既有进程里,
**起任意一个就等于起了一份 `ActivityBatchWorker`**:

```bash
pnpm start:notification-outbox-worker
```

```bash
pnpm start:storage-consistency-worker
```

| 脚本 | 入口文件 | 同进程并行启动的循环 |
|---|---|---|
| `start:notification-outbox-worker` | `src/notification-outbox-worker.ts` | `NotificationOutboxWorker.run()` + `ActivityBatchWorker.run()`(`notification-outbox-worker.ts:25`) |
| `start:storage-consistency-worker` | `src/storage-consistency-worker.ts` | `StorageConsistencyWorker.run()` + `ActivityBatchWorker.run()`(`storage-consistency-worker.ts:114`) |

两个都起 = **两份** `ActivityBatchWorker` 抢同一个队列。这是支持的:取活用
`FOR UPDATE SKIP LOCKED`(`activity-batch.worker.ts:425`),两份不会领到同一行。

### 1.3 三个会让你以为起了、其实没起的坑

1. **`storage-consistency-worker` 带任何参数就不是 daemon**。下面五种模式**全部在
   `storage-consistency-worker.ts:114`(启动 `ActivityBatchWorker` 的那一行)**之前就 `return` 了
   ⇒ 那几种调用**根本不启动 `ActivityBatchWorker`**:

   | 参数 | 提前返回处 |
   |---|---|
   | `--strict-gate` | `storage-consistency-worker.ts:56` |
   | `--purge-replays` | `storage-consistency-worker.ts:61` |
   | `--relocate` | `storage-consistency-worker.ts:66` |
   | `--attest-absent` | `storage-consistency-worker.ts:81` |
   | `--once` | `storage-consistency-worker.ts:99` |

   **只有不带任何参数的调用才启动它。**
2. **起 API 服务不等于起 worker**。HTTP app 也注册了 `ActivityBatchWorker`,但**从不调用 `run()`**,
   且把 `ACTIVITY_BATCH_AUTO_COMMIT_ENABLED` 注入为 `false`(`src/modules/activities/activities.module.ts:225-233`)。
3. **一个循环挂了,进程不会退出**。两个入口都用 `Promise.allSettled`(`notification-outbox-worker.ts:25`、
   `storage-consistency-worker.ts:114`),这是**刻意的**(`notification-outbox-worker.ts:19-24`):
   一方 reject 不拖死另一方,只打一行 `[worker] loop exited abnormally`
   (`notification-outbox-worker.ts:28` / `storage-consistency-worker.ts:117`),
   进程照常活着。⇒ **进程还在 ≠ ActivityBatchWorker 还在跑。** 这条直接决定了 §2 的盲区。

### 1.4 环境变量:`production` 下少一个就起不来

两个 worker module 都用 `ConfigModule.forRoot({ isGlobal: true, load: [appConfig, ...] })`
(`notification-outbox-worker.module.ts:32`、`storage-consistency-worker.module.ts:25`),
**没有 `envFilePath`** ⇒ 读进程工作目录下的 `.env`。

`APP_ENV=production` 或 `smoke`(`src/config/app.config.ts:16`)时,若 `ACTIVITY_V11_WORKFLOW_ENABLED`
为空,配置加载阶段直接抛错、进程起不来(`app.config.ts:515-526`)。实测:

```
[Nest] ERROR [ExceptionHandler] Error: ACTIVITY_V11_WORKFLOW_ENABLED 不能为空(production / smoke 必须显式设置 true 或 false)
```

⚠️ 它**不是**唯一一个这样的开关。同批 fail-fast 的还有 `ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED` 等
(实测中它比 v1.1 那个**先**抛)。**报错文案已经点名了缺哪个 —— 照它补,不要猜。**

### 1.5 起来了的唯一证据

启动成功后打**一行**日志(`activity-batch.worker.ts:138`),实跑输出:

```
[Nest] 68268  - 08/19/2026, 7:30:47 PM     LOG [ActivityBatchWorker] activity batch worker started
```

**只有这一行,而且只在启动时打一次**(见 §2)。

---

## 2. 健康检查

### 2.1 🔴 现状:**明确不设**健康检查(2026-08-26 维护者拍板,选 §6 的 A)

> **措辞从「今天没有」改成「明确不设」是有分量的**:前者是「还没做」,后者是
> **「知道缺什么、算过代价、决定不做」**。判据 7c 的签字落在
> [`docs/ai-harness/CUTOVER_SIGNOFF.md`](../ai-harness/CUTOVER_SIGNOFF.md) §4。
>
> 拍板内容逐字:**认可,接受由 lease 恢复代偿**。
> ⇒ §2.3 的**四个盲区全部作为已知风险留在台账上**,一个都没有被关掉。
> 特别是:任务卡住时业务不丢活(下一轮会重新领取),但**运维看不见它卡过** ——
> 只看见活干完了。
>
> 🔴 **重开条件**(出现任一条就该把本节与 §6 一起重开,别等下次评审):
> 出现「活干完了但明显延迟」的运营反馈;或部署形态仍是**单 worker 进程**(那时盲区 ① 让
> 代偿本身失效 —— 见下)。

**代码里不存在任何针对 `ActivityBatchWorker` 的存活性检查。** 具体地:

| 常见形态 | 本 worker 有没有 | 依据 |
|---|---|---|
| HTTP 探针 | **没有** | `src/modules/health/health.controller.ts` 的 `/health`、`/health/live`、`/health/ready` 是 **HTTP app** 的 controller;两个 worker 进程用 `NestFactory.createApplicationContext`(headless,不监听端口)⇒ 探针探不到它们 |
| 心跳表 / 心跳列 | **没有** | `ActivityBatchJob` 无心跳列;worker 无任何周期性写心跳的代码 |
| 外部进程探针 | **没有** | 仓内无相关脚本或配置 |
| 周期性日志 | **没有** | `run()`(`:137-152`)只在**启动时**打一行、**出错时**打 warn;**空闲时零日志** |

实测佐证:进程起来后空跑 6 秒,`ActivityBatchWorker` **再没有产生任何一行日志**。

⇒ **「worker 活着但队列空」与「worker 已经死了」,从进程外看是完全一样的。**

### 2.2 代偿是什么(注意:它是自愈机制,不是健康检查)

今天唯一的存活性代偿是**租约过期后由下一轮重新领取**:

- 持有者死掉后,`leaseExpiresAt` 到点(≤ 5 分钟),该 job 重新满足取活条件
  (`statusCode='processing' AND leaseExpiresAt <= now`,`activity-batch.worker.ts:410-412`);
- 尝试次数已用尽的,由 `sweepDead()` 原子标 `dead`(`:460-511`)。

**这是「出事之后自己爬起来」,不是「告诉你出没出事」。** 判据 7c 也是这么定性的,
**签字接受的正是这个定性**(而不是把它改称健康检查)——
维护者 2026-08-26 的原话记在签字理由里:*lease 过期后由下一轮重新领取是**恢复**机制,
**不等于存活性探测***。本文不改口径。

### 2.3 这个代偿的四个盲区(逐条实测)

**盲区 ①:恢复要求「另有一个活着的 worker」。**
租约过期只是让那一行**变得可被领取**,它自己不会跑。若部署里只有一个 worker 进程且它死了,
没有任何人来领 ⇒ **零恢复**,队列静静地停住。

**盲区 ②:空闲期没有任何正向信号。**
见 §2.1 实测:空闲时零日志;空闲轮次虽然开事务,但**不改任何一行**(见 §2.4(b))。
**看不到坏消息 ≠ 好消息。**

**盲区 ③:进程活着但这个循环死了,进程级探活看不出来。**
`Promise.allSettled`(§1.3 第 3 条)使 `run()` 崩溃**不会**让进程退出。
`ps` 看得到 PID、容器编排看得到「容器健康」、`/health` 看得到 API ——
**三者都不覆盖这个循环**。唯一痕迹是一行 `[worker] loop exited abnormally`。

**盲区 ④:卡住的那一轮没有超时,卡住的那个进程也没人发现。**
`run()` 直接 `await this.drainOnce()`(`:141-142`),**没有超时**。若某条 DB 语句挂住,
这一轮永远不结束,进程看起来一切正常。

> ⚠️ **一处口径订正**:此处**不能**说成「循环卡死 ⇒ lease 不会过期」。
> `leaseExpiresAt` 是取活时一次性写死的墙钟时刻(`:388`),**没有任何续租代码**,所以它**照常会过期**,
> 另一个活着的 worker **会**接管那条 job(盲区 ① 的前提下)。
> 真正的盲区是:**那个卡住的进程本身不会被发现**,它会一直占着一个「看起来在跑」的位置。

**附带一条:`leaseOwner` 认不出是哪个进程。**
它是每次取活现生成的 `activity-batch-worker:${randomUUID()}`(`:387`)——**不含 PID、不含主机名**,
且**每轮都换一个**。对比同进程的 outbox worker:`notification-outbox:${process.pid}:${randomUUID()}`
(`src/modules/notifications/notification-outbox.worker.ts:46`,实测日志里能看到 PID `68268`)。
⇒ **拿着 `leaseOwner` 反查不到该去杀哪个进程。**

### 2.4 今天能做的最强观测(诚实标注其弱点)

在没有健康检查的前提下,只有下面两件事可做,**两件都是弱信号**:

**(a) 查队列有没有卡住** —— 这是本文唯一一个可以定期照跑的巡检动作(展开版见 §5.0):

```sql
SELECT "statusCode", "jobTypeCode", count(*) AS jobs,
       min("availableAt") AS oldest_available_at,
       max("attempts")    AS max_attempts
FROM "ActivityBatchJob"
GROUP BY "statusCode", "jobTypeCode"
ORDER BY "statusCode", "jobTypeCode";
```

弱点:**队列本来就空的时候,它和 worker 死了长得一模一样。**

**(b) 看数据库事务量。** 每轮 `claimJob` 都开一个事务(`:390`),空闲也开。
实测:整进程空闲约 6 秒,`pg_stat_database.xact_commit` 从 3776 涨到 3832(+56)。
弱点:**这 56 次是同进程两个循环合计的,拆不开**;而且 API 服务也在往同一个库提交
⇒ **它证明不了「`ActivityBatchWorker` 这个循环还活着」。**

**结论:今天没有任何一个信号能单独证明这个 worker 还在跑。** 形态选项见 §6。

---

## 3. lease(租约 / 围栏)

### 3.1 三列各是什么

`ActivityBatchJob` 的三列(`prisma/schema.prisma` 的 `model ActivityBatchJob`,worker 侧全部在用):

| 列 | 写入时机与值 | 作用 |
|---|---|---|
| `leaseOwner` | 取活时写 `activity-batch-worker:${randomUUID()}`(`:387`);释放 / 判死时置 `NULL` | 标记「这一轮归谁」。**每轮换新值,不含进程信息**(见 §2.3 附带条) |
| `leaseGeneration` | 取活时 `{ increment: 1 }`(`:436`) | **单调围栏号**。真正防「旧持有者醒来补写」的是它 |
| `leaseExpiresAt` | 取活时写 `now + 5 分钟`(`:388`,`:77`);**全程不续租** | 到点即认定持有者已死,允许别人接管 |

配套两列:`attempts`(每次取活 `+1`,`:438`)、`availableAt`(退避到 `now + 30s`,`:767`)。

### 3.2 并发时谁赢

取活在一个事务里(`:390`),候选查询用 `FOR UPDATE SKIP LOCKED ... LIMIT 1`(`:425-426`):
**两个 worker 永远不会选中同一行** —— 后到的直接跳过被锁的行去看下一个候选,不排队、不阻塞。

可被领取的两种行(`:409-412`):

1. `statusCode='pending'` **且** `availableAt <= now` —— 还没开跑,或退避已到;
2. `statusCode='processing'` **且** `leaseExpiresAt <= now` —— **持有者已经死了**,接管。

两种都额外要求 `attempts < 5`(`:407`)。

### 3.3 真正保证正确性的是围栏,不是租约

**租约只是排队,围栏才是安全边界。** 每次真正写业务之前重新校验 `(leaseOwner, leaseGeneration)`:

```
// ledger-preparation.service.ts:277-284
// 🔴 fencing:租约被别人抢走之后,**本 worker 一行都不许再写**。
//    行锁只保证"不同时写",fence 才保证"不写在别人的回合里"——
//    少了它,一个卡住的旧 worker 醒来后会把自己那半份结果补写进去。
```

不匹配即抛 `LedgerPrepareLeaseLostError`,该轮**整体作废、不写任何收尾状态**
(`activity-batch.worker.ts:215-229` —— 收尾是新持有者的事)。
另外三个家族各有同形的 `...LeaseLostError`(`:562` / `:640` / `:723`)。

⇒ **运维含义:即使一个卡住的老进程在 5 分钟后突然活过来,它也写不进去。**
你不需要为了数据安全去抢时间杀它;要杀它是为了释放资源,不是为了防止写坏账。

### 3.4 日志里的租约字样

```
activity batch job <jobId> lease lost, aborting round        (:217)
onsite bulk punch job <jobId> lease lost, aborting round     (:562)
attendance import execute job <jobId> lease lost, ...        (:640)
activity reconciliation job <jobId> lease lost, ...          (:723)
```

**偶发是正常的**(接管本来就会让老持有者 lease lost)。**持续大量出现**说明有进程卡在长轮次里
反复被接管 —— 按 §5.2 处理。

---

## 4. 停机排空

### 4.1 收到停止信号后实际发生什么

两个入口都调了 `app.enableShutdownHooks()`(`notification-outbox-worker.ts:10`、
`storage-consistency-worker.ts:41`),所以 SIGTERM / SIGINT 会触发 Nest 的关停钩子。

`ActivityBatchWorker` 同时实现了两个钩子,**都指向同一个 `stopAndDrain()`**:

- `onApplicationShutdown()` → `stopAndDrain()`(`:128-130`)
- `onModuleDestroy()` → `stopAndDrain()`(`:132-134`)

`stopAndDrain()`(`:894-902`)按顺序做三件事:

1. **幂等**:已在关停就返回同一个 promise(`shutdownPromise` 守卫,`:895`)——重复触发不会排空两次;
2. `stopping = true`(`:896`)⇒ `run()` 的 `while` 下一次判定即退出(`:139`),
   并 `wakeIdle?.()`(`:897`)**当场叫醒 500ms 的空闲睡眠**,不必等它睡完;
3. `await` **当前正在跑的那一轮**(`activeRound`,`:899`)。用 `Promise.allSettled` ⇒
   该轮即使失败也不会让关停链路抛错。

`run()` 返回后,入口的 `Promise.allSettled` 收敛,执行 `app.close()`
(`notification-outbox-worker.ts:30` / `storage-consistency-worker.ts:120`)。

实测:发 SIGTERM 后进程自行退出,**不需要 SIGKILL**。

### 4.2 它**不**保证什么(直接影响运维预期)

- **它没有自己的超时。** `stopAndDrain()` 会一直等当前轮结束。一轮要把该 job 所有非 `succeeded`
  的 item 逐个跑完(`:200-233`,每个 item 一个独立事务)—— 大批次可能很久。
  ⇒ **编排平台的 SIGTERM→SIGKILL 宽限期必须大于最坏一轮的耗时,否则会被硬杀。**
- **它只等「当前这一轮」,不等「队列排空」。** 队列里剩下的任务留给下次启动或别的实例。
  想把队列跑干是 `drainUntilIdle()`(`:313`)干的事,**关停路径不调它**。
- **被硬杀不会丢已完成的工作。** 每个 item 各自事务提交并标 `succeeded`;下一轮取活时
  `where: { statusCode: { not: 'succeeded' } }`(`:201`)天然跳过已完成项。
  代价只是那条 job 要等 `leaseExpiresAt`(≤ 5 分钟)过期才能被接管。

### 4.3 停机前后的检查动作

停机前(可选,想少留一条 `processing` 尾巴时):停掉写入口,等 §2.4(a) 的查询里
`processing` 归零再发 SIGTERM。

停机后:若 §2.4(a) 里仍有 `processing` 行,**这是正常的**——它们会在 5 分钟内变成可接管状态。
按 §5.1 处理。

---

## 5. 恢复 SOP

> 下面每条都给可执行动作。表名是 `"ActivityBatchJob"` / `"ActivityBatchJobItem"`
> (PascalCase,**必须带双引号**;这两张表没有 `@@map`)。
> **改数前先做只读盘点,并确认连的是哪个库**(`SELECT current_database();`)。

### 5.0 先跑这一条:统一盘点

```sql
SELECT j."id", j."jobTypeCode", j."statusCode", j."attempts",
       j."availableAt", j."leaseExpiresAt", j."leaseGeneration",
       j."lastErrorCode",
       (SELECT count(*) FROM "ActivityBatchJobItem" i
         WHERE i."jobId" = j."id" AND i."statusCode" = 'failed') AS failed_items,
       (SELECT string_agg(DISTINCT i."lastErrorCode", ',') FROM "ActivityBatchJobItem" i
         WHERE i."jobId" = j."id" AND i."statusCode" = 'failed')  AS item_error_codes
FROM "ActivityBatchJob" j
WHERE j."statusCode" IN ('pending', 'processing', 'dead')
ORDER BY j."attempts" DESC, j."availableAt" ASC;
```

🔴 **错误码要去 item 上看,不要只看 job。** 块失败走
`markItemFailed()`(`:858-870`,写 item 的 `lastErrorCode` / `safeMessage`)后调
`releaseForRetry(claimed.id, now)`——**不传 error**(`:237`)⇒ **job 的 `lastErrorCode` 保持 `NULL`**。
只看 job 会看到一条「没有任何错误信息」的失败任务。

### 5.1 进程被杀(含 OOM、硬杀、节点重启)

**症状**:job 停在 `statusCode='processing'`,`leaseExpiresAt` 是个过去或很近的时刻。

**动作**:

1. **先什么都不做,等 ≤ 5 分钟**,再跑 §5.0。租约过期后会被自动接管(`:410-412`),
   已完成的 item 不会重跑(`:201`)。
2. 确认**至少还有一个 worker 进程活着**(盲区 ①)。没有就按 §1 起一个 ——
   **这是恢复的前提,不是可选项**。
3. 若 5 分钟后那一行仍是 `processing` 且 `leaseExpiresAt` 已过去 ⇒ 说明**没有活着的 worker 在领**。
   回到第 2 步,不要去改数据。

**不要做**:不要手工把 `processing` 改回 `pending`。租约到期本来就允许接管,
手改只会绕过围栏计数、把问题变复杂。

### 5.2 lease 卡住(有人一直占着,或反复 lease lost)

**症状 A —— 一直是 `processing` 且 `leaseExpiresAt` 在未来**:有个活着的进程正在跑这一轮,
它可能只是慢(大批次),也可能卡住了。

**动作**:

1. 隔 1 分钟跑两次 §5.0,对比 `leaseGeneration` 与 `attempts`:
   - **两个都变了** ⇒ 这条 job 正在被反复接管(上一任每次都没跑完)。**不是「有人占着」,
     是「谁都跑不完」** —— 转 §5.3 按错因处理,`attempts` 到 5 就会终止。
   - **两个都没变、`leaseExpiresAt` 在未来** ⇒ 有一个持有者正在跑这一轮。**这时正常动作是等**:
     等到 `leaseExpiresAt` 过去(≤ 5 分钟)。到点还没动静,进第 2 步。
   - **`leaseGeneration` 没变、`leaseExpiresAt` 却在往后推** ⇒ **这不可能**。本 worker
     **不续租**(`:388`),`leaseExpiresAt` 只在取活时改,而取活必然同时 `+1`
     `leaseGeneration`(`:436`)与 `attempts`(`:438`)。真观察到就说明**有本文之外的东西在改这张表**,
     停手,交维护者。
2. 用 §2.4(b) 判断进程是否还在动。
3. 确实要处置那个卡住的进程时:**逐个重启 worker 进程**(§1 的两个脚本)。
   ⚠️ **`leaseOwner` 认不出是哪个进程**(§2.3 附带条),所以只能按进程逐个来,不能精确定位。
4. 重启后回到 §5.1:等租约过期即可,**数据不需要动**。§3.3 已保证老持有者写不进去。

**症状 B —— 日志里 `lease lost, aborting round` 持续刷屏**:说明有轮次反复被接管。
先按第 2、3 步确认没有卡住的僵进程;再看是不是 `ACTIVITY_BATCH_LEASE_MS`(5 分钟)
对当前批次规模不够 —— **改这个常量属于改行为,不在本 SOP 范围**,记入待办交维护者拍板。

### 5.3 任务反复失败

🔴 **这里有两种完全不同的终态,必须分开处理。走错分支会一直找不到那条任务。**

先跑 §5.0,再按下表对号:

| 终态 | 怎么来的 | 会不会变成 `dead` |
|---|---|---|
| **A. `statusCode='pending'` 且 `attempts >= 5`** | **块失败**:`prepareChunk` 抛错 → 标 item `failed` → `releaseForRetry` 把 job 退回 `pending`(`:230-247`)。B6 两族的 `releaseOnsiteBulkForRetry`(`:801`)/ `releaseImportExecuteForRetry`(`:828`)同形,也退回 `pending` | **不会。永远卡在 `pending`。** |
| **B. `statusCode='dead'`** | **整轮抛错**:错误逃出 `drainOnce`(如 `finalize` 抛错)→ job 留在 `processing` 带租约 → 租约过期被重领 → `attempts` 用尽后 `sweepDead()` 标 `dead`(`:460-471`) | 是 |

**为什么 A 不会变 `dead`(实测判据)**:取活要求 `attempts < 5`,`sweepDead` 要求
`statusCode='processing'`。`attempts=5` + `pending` **两个都不满足**。
在 PostgreSQL 上按代码逐字复算这两个谓词(含正对照):

| 样本 | 可被取活 | 会被判死 |
|---|---|---|
| `pending`,`attempts=4`,`availableAt` 已到 | ✅ | ❌ |
| `processing`,`attempts=2`,租约已过期 | ✅ | ❌ |
| `processing`,`attempts=5`,租约已过期 | ❌ | ✅ → `dead` |
| **`pending`,`attempts=5`** | ❌ | ❌ ⇒ **搁浅** |

⇒ **只查 `statusCode='dead'` 会漏掉 A 类。§5.0 的查询同时覆盖两类,用它。**

#### 5.3.1 处理 A 类(`pending` + `attempts >= 5`,已搁浅)

1. **先看错因**,从 §5.0 的 `item_error_codes` 读。常见一条:`BizException:20153`
   = `ACTIVITY_V11_WORKFLOW_NOT_ENABLED`(`src/common/exceptions/biz-code.constant.ts:1714-1718`)——
   意思是**这个实例的 `ACTIVITY_V11_WORKFLOW_ENABLED` 是 `false`**,
   而 `prepareChunk` / `finalize` 是受闸写路径
   (`ledger-preparation.service.ts:272` 与 `ledger-preparation.service.ts:403`)。
   **这种情况先按合同 §16.2 的切换流程把闸开对,不要去改任务数据。**
2. 错因修掉之后,把搁浅的任务放回队列 —— **只能直接改库**(理由见下):

   ```sql
   -- 先只读确认要动哪几行
   SELECT "id", "jobTypeCode", "statusCode", "attempts"
   FROM "ActivityBatchJob"
   WHERE "statusCode" = 'pending' AND "attempts" >= 5;

   -- 确认无误后,在事务里放回队列(逐条指定 id,不要按条件批量)
   BEGIN;
   UPDATE "ActivityBatchJobItem"
     SET "statusCode" = 'pending', "lastErrorCode" = NULL, "safeMessage" = NULL
     WHERE "jobId" = '<jobId>' AND "statusCode" = 'failed';
   UPDATE "ActivityBatchJob"
     SET "attempts" = 0, "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
         "availableAt" = now(), "completedAt" = NULL, "lastErrorCode" = NULL
     WHERE "id" = '<jobId>' AND "statusCode" = 'pending' AND "attempts" >= 5;
   COMMIT;
   ```

   > **为什么不能用现成的重试接口**:`POST /app/v1/my/activity-batch-jobs/:jobId/retry-failed`
   > (`src/modules/activities/controllers/app-my-activity-batch-jobs.controller.ts:109`)只接受
   > `partial_failed` / `failed` / `dead` 三种状态(`app-my-activity-batch-jobs.service.ts:279`)——
   > **`pending` 不在其中**,A 类任务调它会被拒。
   > 而且 `settlement_prepare` / `reconciliation` 两族**从不写 job 的 `failed` 计数**
   > ⇒ 读面的 `retryFailedAllowed`(`app-my-activity-batch-jobs.service.ts:75`)对它们恒为 `false`,
   > 界面上根本不会出现重试按钮。
   > B6 的 `bulk_proxy` / `import_execute` 两族会落 `failed` / `partial_failed`,**那两族请优先走接口**。

3. 放弃这条任务时用 `POST .../cancel`(`app-my-activity-batch-jobs.controller.ts:132`)——
   `pending` 在可取消集合内(`app-my-activity-batch-jobs.service.ts:281-286`)。

#### 5.3.2 处理 B 类(`dead`)

1. 同样先从 §5.0 的 `item_error_codes` 看错因;job 的 `lastErrorCode` 这时**有值**,
   形如 `LEDGER_PREPARE_MAX_ATTEMPTS_EXHAUSTED` / `ACTIVITY_RECONCILIATION_MAX_ATTEMPTS_EXHAUSTED` /
   `ONSITE_BULK_PUNCH_MAX_ATTEMPTS_EXHAUSTED` / `ATTENDANCE_IMPORT_EXECUTE_MAX_ATTEMPTS_EXHAUSTED`
   (`:462-463`、`:490`、`:505`)——注意**它只说明「试满了」,不说明为什么失败**,原因在 item 上。
2. `dead` **在**接口的可重试集合内。**B6 两族走接口**(§5.3.1 的注解);
   `settlement_prepare` / `reconciliation` 走 SQL:

   ```sql
   -- 先只读确认
   SELECT "id", "jobTypeCode", "attempts", "lastErrorCode"
   FROM "ActivityBatchJob" WHERE "statusCode" = 'dead';

   -- 确认无误后逐条放回队列
   BEGIN;
   UPDATE "ActivityBatchJobItem"
     SET "statusCode" = 'pending', "lastErrorCode" = NULL, "safeMessage" = NULL
     WHERE "jobId" = '<jobId>' AND "statusCode" = 'failed';
   UPDATE "ActivityBatchJob"
     SET "statusCode" = 'pending', "attempts" = 0, "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
         "availableAt" = now(), "completedAt" = NULL, "lastErrorCode" = NULL
     WHERE "id" = '<jobId>' AND "statusCode" = 'dead';
   COMMIT;
   ```
3. 🔴 **`dead` 意味着没人再管它了,而且没有任何告警。** `sweepDead()`(`:460`)是静默的 ——
   不打日志、不发通知。**只有 §5.0 那条巡检能发现它。**

### 5.4 数据库不可用

**症状**:日志刷 `activity batch drain failed error=<错误类名>`(`:145`)。

**这个 worker 的行为(重要,决定了你该怎么判断)**:

- `run()` 的 `catch` **吞掉一切异常**、睡 500ms、**无限重试**(`:144-147`)。
  ⇒ **它不会退出、不会累计失败计数、不会升级告警。** 库恢复后自己就接着跑了,无需人工干预。
- 因为无限重试,**同一条 warn 会一直刷**。频率 = 一次失败耗时 + 500ms:
  **连接被拒**(库进程没了)时失败极快 ⇒ 约每秒 2 条;**连接挂起 / 超时**时会慢得多,
  可能几十秒才一条。⇒ **别把「刷得慢」当成「在恢复」** —— 以 §5.0 的读数为准,不以日志频率为准。
- 这条 warn 是这种故障下**唯一**的信号,也是唯一的噪音来源。

**动作**:

1. 先修数据库本身(这个 worker 这边**不需要任何操作**)。
2. 库恢复后跑 §5.0 确认队列在往前走(`attempts` 不再涨、`processing` 会流动)。
3. 若库不可用期间有 job 持有租约,按 §5.1 处理(等 ≤ 5 分钟)。
4. 若库不可用时间长到让某些 job 攒够 5 次 `attempts`,按 §5.3 分 A / B 类处理。

**不要做**:不要因为刷屏就去杀 worker 进程 —— 它的重试是无害的,
杀掉反而制造 §2.3 盲区 ① 的局面(没有活着的 worker ⇒ 零恢复)。

---

## 6. 已拍板:健康检查的形态 = **A(接受由 lease 恢复代偿)**

> **2026-08-26 维护者拍板:选 A。** 签字落在
> [`docs/ai-harness/CUTOVER_SIGNOFF.md`](../ai-harness/CUTOVER_SIGNOFF.md) §4 的 `7c` 条,
> 结论「认可(接受由 lease 恢复代偿)」。§2.1 已按该选项的约定把措辞改成「**明确不设**」。
>
> 🔴 **拍板买下的是哪些风险,逐条摆明**(下表 A 行那格「代价」不因为签了字而变小):
> §2.3 的盲区 **①②③④ 全部保留**。其中最贴近日常运营的后果是 ——
> **任务卡住时业务不丢活(lease 到点后下一轮重新领取),但没有任何人看得见它卡过**;
> 从运营侧只能观察到「活干完了,只是慢了一截」。
>
> 🔴 **重开条件**(任一条成立就重开本节,别等下次全量评审):
> ① 出现「活干完了但明显延迟」的运营反馈 ⇒ 应重开并按 B(心跳表)做;
> ② 部署形态确定为**单 worker 进程** ⇒ 盲区 ① 使代偿整个失效,那时 A 不再成立。
>
> ⚠️ **首次上线接受此代偿**;下面三选项的事实与代价原样留着,重开时直接用,不必重查。

合同 §16.1 第 ⑦ 条要求「有健康检查」,判据 7c 在本次签字前是**待维护者确认**。
下面只列**事实与代价,不给推荐**;若按重开条件改选 B / C,由另一刀实现,本文届时同步更新 §2。

| 选项 | 要做什么 | 代价 | 拍板后 §2 会变成 |
|---|---|---|---|
| ⭐ **A. 接受由 lease 恢复代偿(2026-08-26 已选)** | 零代码。把 §2.3 四个盲区作为**已知并接受的风险**记录在案 | 零成本。盲区 ①②③④ 全部保留:单实例部署时故障不可见也不可恢复;卡住的进程永不被发现 | §2 保持现状,措辞从「没有」改为「**明确不设**」 |
| **B. 心跳表(worker 定期写一行,外部查)** | 新增一张心跳表或一列;`run()` 每轮更新时间戳;外部按「最后心跳距今 > N 秒」判死 | 新增 schema 变更(D 档,走 `srvf-prisma-change`);**空闲时也要写库**,与「空队列不产生写」的现状相反;能解掉盲区 ②③,**解不掉 ④**(卡在 `drainOnce` 里就更新不了心跳 —— 反过来说,这恰好让 ④ 变成可检出) | §2 改写为「有心跳,判定阈值 N 秒」 |
| **C. 外部进程探针** | 编排层加探针脚本(如查 §2.4(a) 的队列年龄并设阈值) | 零 schema 变更;但**探的是队列不是循环** —— 队列本来就空时仍然探不出死活(盲区 ② 保留);阈值需按业务节奏调 | §2 改写为「有外部探针,覆盖面为队列积压,不覆盖空闲存活」 |

⚠️ 三个选项都**不解决盲区 ①**(恢复需要另一个活着的 worker)。
那是**部署形态**的问题(至少两个 worker 进程),不是代码问题 —— 需要单独拍板。

---

## 附:本文每一节的实测依据

| 节 | 主要依据 |
|---|---|
| §0 | `activity-batch.worker.ts:43-57`(协议)、`:77/:80/:83/:86`(常量)、`:137/:158/:310-322`(三个方法)、`:396-412`(家族)、`:417-424`(优先级) |
| §1 | `package.json:12/17/18`;`src/notification-outbox-worker.ts:10/16-18/25/28`;`src/storage-consistency-worker.ts:41/49-51/56/61/66/81/99/114/117/120`;`activities.module.ts:225-233`;`*-worker.module.ts` 的 `ConfigModule.forRoot`;`app.config.ts:16/515-526`;实跑 `pnpm build` + 起进程日志 |
| §2 | `src/modules/health/health.controller.ts:54/64/74`(HTTP-only);`activity-batch.worker.ts:137-152`(仅启动 / 出错打日志)、`:387-388`(owner 形态、不续租)、`:410-412`(接管条件)、`:460-511`(sweepDead);`notification-outbox.worker.ts:46`(对比);实跑:空闲 6 秒零日志、`xact_commit` +56 |
| §3 | `schema.prisma` 的 `model ActivityBatchJob`;`activity-batch.worker.ts:387/388/407/409-412/425-426/436/438/767`;`ledger-preparation.service.ts:277-284`(围栏复核);`:217/562/640/723`(lease lost 日志) |
| §4 | `notification-outbox-worker.ts:10/25/30`;`storage-consistency-worker.ts:41/114/120`;`activity-batch.worker.ts:128-134/139/894-902/904/200-233/201`;实跑 SIGTERM 后自行退出 |
| §5 | `activity-batch.worker.ts:145/237/460-471/490/505/858-870`;`app-my-activity-batch-jobs.service.ts:75/134/144-150/279/281-286`;`controllers/app-my-activity-batch-jobs.controller.ts:109/132`;`biz-code.constant.ts:1714-1718`;`ledger-preparation.service.ts:272/403`;PostgreSQL 上逐字复算取活 / 判死谓词(四样本正对照) |
| §6 | `scripts/cutover-check.ts` 的 `eviSub('7c', 'B', '有健康检查', …)`(7c 原文);`docs/ai-harness/CUTOVER_SIGNOFF.md` §4 的 `7c` 签字 |
