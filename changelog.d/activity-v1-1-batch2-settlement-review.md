### Added

- **活动业务改造 v1.1 第 2 批第四刀:结算一审 / 终审**(合同
  [`docs/archive/reviews/activity-business-overhaul-v1.1/`](docs/archive/reviews/activity-business-overhaul-v1.1/)
  §5.11 算法 / §3.19 `SettlementReviewAction` / §3.22 `LedgerPostingBatch`;
  修订件 `AMENDMENTS-v1.1.1` 未触及本刀真源)。

  **零 schema / 零 migration / 零端点 / 零 DTO / 零权限码 / 零 Punch 写路径**
  (`test:contract` 零 diff);新增 **15 个 BizCode**(20062–20076)。
  消费方是第 2 批收尾那一刀(整条结算流程的对外入口)。

  🔴 **这一刀守的是"谁说了算"** —— 隔离漏一条,自提自审就成立(合同 §4.1 与修订说明
  列为一级阻断的同一类问题);并发漏一条,同一版本会有两个互相矛盾的生效决定。
  故本刀每一处判据都走**拒绝**,没有一处走"警告后放行"。

  新增两个纯判定件 + 一个编排件 + 一个边界件:

  - `settlement-review-separation.ts` —— **纯函数**三方分离:提交人 ≠ 一审人、
    提交人 ≠ 终审人、一审人 ≠ 终审人。三条**各一个具名码、各读互不相交的 (阶段, 字段)
    组合**,故逐条卸掉后红集两两不相交。判定语义逐字沿用考勤
    `attendances.service.ts::assertLockedReviewSeparation`(含"某一方为 null 时不否决"的口径)。
  - `settlement-review-comparison.ts` —— **纯函数** §5.11 四项比对(seal /
    evidence+population revision / workflowRevision / contentHash)。三个输入:
    审核人看到的那一版 `expected`、不可变版本行 `version`、此刻现场事实 `live`;
    两侧都比(只比一侧会漏掉另一半防的那件事)。
    🔴 `contentHash` **只比对不重算** —— 重算等于把"审的是哪一版"又交回给可变数据。
  - `settlement-review.service.ts` —— 编排:锁序 `Activity` → `AttendanceSettlementRun`
    → `AttendanceSettlementVersion`(不倒置;**不取 member advisory lock**);
    幂等 → 一版本一阶段一个生效决定 → run/version 状态闸 → **锁后复判三方分离**
    → 四项比对 → 写 append-only `SettlementReviewAction` → 推进状态 →
    同事务 enqueue 通知 intent + audit。
  - `settlement-review-audit-recorder.ts` + `settlement-notification-producer.ts`
    新增 `enqueueReviewed` —— 复用既有 `activity.publish` 伞事件 + `extra.operation`
    (不新增事件串);通知 intent 走既有 outbox,**在业务事务内** enqueue。

  ⭐ **三方分离必须是事务内锁后复判,不是入口处查一次**(§3.19 明写)。
  判据打在锁后那一层,证据是一条**真并发**用例:同一个人 B 先做一审(事务停在
  commit 前、握着 Activity 行锁),同时发起终审 —— 终审已经在等锁,而从事务外看
  (= 入口处那一次读)**一审动作行还不存在**;一审 commit 后终审才拿到锁并复判,拒 20064。
  变异 A/B:把分离事实源改成"入口处查一次",这条用例里**终审真的成立了**
  (返回 `stageCode=final / versionStatusAfter=approved / batch=preparing`),
  即一次自审落地;而四条顺序用例**全部仍绿** —— 顺序用例结构上抓不到这个缺陷。

  🔴 **终审 approve 只创建/恢复 `LedgerPostingBatch` 准备,不把 run 标 `posted`**
  (§5.11 逐字;`posted` 是第五刀 `commitBatch` 之后的事)。run 推到 `posting`,
  批次留 `preparing`、`committedAt=null`、`ParticipationLedgerEntry` 零行。
  「恢复」= 同版本已有未 committed 批次时复用,不开第二条(§3.22「至多一个 committed」)。
  终审 return 只能在批次未 committed 前执行,并把该版本上未 committed 的批次置 `voided`。

  **一版本一阶段一个生效决定**(§3.19):`SettlementReviewAction.operationKey` 是 DB 单列
  unique,但**没有** `(settlementVersionId, stageCode)` 唯一 —— 该不变量由行锁串行化 +
  锁后重查承载,P2002 另有兜底翻译。approve/return 真并发(两套 Nest/Prisma pool +
  PostgreSQL lock waiter barrier)恰好一个成功,败者恒收具名码 20072。

  判据:新增 **72** 例(三方分离单测 10 + 四项比对单测 16 + e2e 41 + 并发 e2e 5),
  并跑了 **11 次单点变异 A/B**(读数逐条进报告);其中一次(删掉版本行锁)
  **反过来推翻了实现自己的注释**,注释已按实测改写。

  ⚠️ **与合同的偏离(三处,均已在源码文件头逐条标注)**:
  ① §3.19 要求「Authz action constraint **和**事务内锁后复判」两层,本刀只落**锁后层** ——
  `ActionConstraint` 的注册键就是 action(权限码)字符串,而本刀零权限码、零端点,
  且 `src/modules/authz/**` 是本刀红区;编一个无人调用的 action 会得到一条永不触发的
  约束(描述文本冒充执行位)。入口层留到**开端点那一刀**接。
  ② §5.11 只说 return「推进 returned」——`returned` 是**版本**状态(§3.19 五值闭集有它),
  run 的九值闭集里没有,故 run 回 `drafting`(§5.10 末句所需的前置)。
  ③ §5.11 点名的 `SettlementVersion` row lock **实测对同活动并发是结构性冗余**
  (删掉它 46/46 仍全绿):同版本并发必然先在 Activity 行锁上排队。仍保留(合同点名 +
  第五刀 Batch 锁的天然锚点),但源码与本条都不把它写成"并发安全的来源"。
