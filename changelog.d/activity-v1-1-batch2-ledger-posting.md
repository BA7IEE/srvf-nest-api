### Added

- **活动业务改造 v1.1 第 2 批第五刀:账本分块准备 + 万人短事务统一生效**
  (合同 [`docs/archive/reviews/activity-business-overhaul-v1.1/`](docs/archive/reviews/activity-business-overhaul-v1.1/)
  §5.12 + §5.13 + §3.22 / §3.23 / §3.24 / §3.27;
  **零端点 / 零 DTO / 零权限码 / 零 schema / 零新增 cron**)。

  🔴 **本刀语义像钱。** `LedgerPostingService.commitBatch` 返回成功的那一刻,
  `ParticipationLedgerEntry` 就从"看不见的准备结果"变成队员贡献值的**真值**。
  它的失败模式**不是报错,是账悄悄错了**,所以本刀每一处判定都走**拒绝**,
  没有一处走"警告后放行"。

  **§5.12 分块准备**(`LedgerPreparationService` + `ActivityBatchWorker`):
  worker 复用既有 PostgreSQL `SKIP LOCKED + lease/fencing` 形态(镜像 outbox /
  storage-consistency 两条既有链路),**零新增 cron**(全仓终态仍恰 2)、零 Redis /
  queue、零新进程。准备把每条 `ParticipantSettlementResultRevision` 的**认定值**按
  `splitSpanByBeijingDay` 拆成 `ParticipantSettlementDay`,再按稳定服务顺序算
  credited / cappedOut,写出挂在未 committed 批次上的 preparing 分录;
  全部 item 成功且数量一致时批次进 `ready`,并把 day-state 基线摘要写进
  `LedgerPostingBatch.baselineJsonHash`。**分块按队员切**(不是按 ResultRevision 随意切):
  日上限是 (member, ledgerDate) 维度的跨行不变量,同一个人同一天的服务必须落在同一块内
  才算得对。**准备路径零 `pg_advisory`**(§5.12 末句;结构断言 + `pg_locks` 双判据钉住)。

  **§5.13 统一生效**(`LedgerPostingService.commitBatch`):固定锁序
  `Activity → SettlementRun → SettlementVersion → LedgerPostingBatch` → 恒串行闸 →
  既有 `lockMembersForWrite` → day-state 排序 `FOR UPDATE`。三条判定各管一段:
  **基线记录完整性**(20085)、**基线漂移**(20084,任一 (member, date) 变化即整批拒绝,
  **不允许部分 commit**)、**日合计 0..3**(20086)。全部通过才在**同一事务内**把
  批次 → `committed`、run → `posted`、result / segment revisions → `committed`、
  day-state 版本递增 + 日合计更新、写 Audit 与 NotificationOutbox intent。

  🔴 **「日合计 0..3」的唯一执行位就在这里。** 第 1 批已实测判定它是**跨行**不变量
  (表级 CHECK 只看单行;trigger 求和在并发下骗人)⇒ 刻意零 DB 执行位。本刀在
  member advisory lock 内、day-state `FOR UPDATE` 之后判,写松即"贡献值当日无声超限"。

  ⭐ **「万人统一生效恒串行」有了执行位**(维护者 2026-08-04 拍板,
  `docs/current-state.md` 逐字记录;此前只是文字约束)。形态是**锁槽预算信号量**而不是
  人数阈值 —— 拍板已点明阈值不严格成立(4999 + 8000 两场都在阈值下,合计 12999 > 共享锁表
  公式保底 12800 照样炸)。预算 10 槽 × 1000 人 = 10000 把 advisory 锁,低于 12800 且留
  2800 余量;按**并发总量**扣减,用 `pg_try_advisory_xact_lock`(非阻塞 ⇒ 自身不可能进
  死锁环)在取队员锁**之前**占位,占不满即 20087(429,可重试);单场就超预算总量的
  给 20088(409,重试无用,须运维调 `max_locks_per_transaction`)。

  🔴 **bind 参数上限**(第 0 批实测 32767,非协议 65535):day-state 补建 / 加锁 / 回写与
  分录批量写**全部改 `unnest($1::text[], …)`**,bind 数恒为列数、与人数无关。
  **8192 人**(恰好越过"每人 4 参数 ⇒ 8191 人"那条线)实测:准备 17 块 4.4s、
  生效**851ms / 21 条语句**(远低于 7s 事务预算),生效事务里唯一超过 64 个 bind 的语句
  是既有 `lockMembersForWrite` 的每人 1 参数 `VALUES`(只读文件,本刀不改)。

  新增 BizCode **20077-20089**(13 条,全 409,唯 20087 是 429)。
  新增读面 `LedgerQueryService` —— 账本的**唯一**读入口,每个方法无条件 join
  `batch.statusCode='committed'`,调用方拿不到"要不要过滤"这个开关(§3.22)。

  **本刀不产生任何 reversal**(§3.23.5 `LedgerEntryReversalClaim` 零行):reversal 的唯一
  来源是更正流程(§5.14),归第六刀。这不是靠自觉 —— 生效前有一条"批次里出现任何
  `*_reversal` 分录即拒"(20089),第六刀真要写 reversal 时它会当场变红,逼那一刀把
  「service 锁后检查 + 辅助表 unique」一起做出来。

  **与合同的两处显式偏离**(PR body 与报告逐条列):① §3.27「在现有 worker 进程注册」——
  两个 worker 进程入口在本刀写集之外,故只交付可被任一进程注册的 provider
  (`drainOnce()` / `drainUntilIdle()`,无定时器、不自启动),进程注册与整条流程的对外
  入口一起留到第 2 批收尾;② §5.13 ⑦「写 ReviewAction」—— `SettlementReviewAction` 的
  `stageCode` / `actionCode` 在 DB 上都是二值闭集,没有一个值表示"账本已生效",
  硬塞一条还会与第四刀的终审决定重复而破坏 §3.19,故只写 Audit + NotificationOutbox。
