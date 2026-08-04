### Added

- **活动业务改造 v1.1 第 2 批第一刀:北京日历收口 + 证据封场算法**
  (合同 [`docs/archive/reviews/activity-business-overhaul-v1.1/`](docs/archive/reviews/activity-business-overhaul-v1.1/)
  §3.21 + §5.8,冲突以 `AMENDMENTS-v1.1.1.md` 为准)。

  第 1 批建的 39 张表**第一次真正有了消费方**。本刀纯服务层:**零端点 / 零 DTO /
  零权限码 / 零 schema / 零 migration / 零 seed / 零 cron**;`test:contract` 与
  `docs/handoff/openapi.json` 逐字不动。

  **① 北京日界口径收口(§3.21)。** 合同要求「业务转换统一调用 `BeijingCalendarService`」——
  本仓**不新建**那个类:它要求的日界口径与既有 [`src/common/datetime/date-only.util.ts`](src/common/datetime/date-only.util.ts)
  的 `beijingDateOnly` 是同一件事,再包一层就是冻结稿 §19 明禁的「第二套日期算法」。
  合同点名的是**单一入口**这个性质,不是类名。新能力加在该 util 内:
  `beijingDayBoundsUtc()`(北京日覆盖的 UTC 区间)与 `splitSpanByBeijingDay()`
  (把一个服务段按北京日切成有序、无缝、不重叠的多片,直接产出 §3.21
  `ParticipantSettlementDay.ledgerDate`)。13 条新单测覆盖跨日界 / 月末 / 闰日与非闰年对照 /
  多日跨度 / 日界端点归属 / 空区间 / 无效 Date。消费方在第 2 批后续刀,本刀零调用方是预期状态。

  **② `EvidenceSealService.seal()` 八步全实现(§5.8)。** 这条服务存在的全部理由是合同末句:
  「seal 不是"负责人承诺",没有所有条件不能写。」旧世界由负责人**声明**考勤完成、不逐人核验;
  这里换成八步机器判定:Activity `FOR UPDATE`(全流程唯一的锁,且在最前)→ 重读 live sessions
  与终止截止 → authoritative now(取事务内 `now()`,不取应用时钟)必须晚于所有有效签退截止 →
  查开放段 / 待人工复核 / 未处理 event effect → 读 evidence/population revision →
  算 population distinct 与 by-session 摘要 → pending 变更审核或版本在本事务内变化则拒 →
  写 immutable `EvidenceSeal` + audit,旧 active seal 同事务标 `superseded`(§4.6 投影)。

  **③ 七条拒绝理由,七个具名 BizCode(20040–20046)。** 不用一个笼统的
  `ACTIVITY_STATUS_INVALID` 兜底 —— 那会让调用方只知道"封不了"、不知道差哪一项,
  机器判定退化回人工排查。七条各有独立 e2e 用例,并各配一条**翻面的放行用例**
  (终止截止已过 / superseded 段 / voided 段 / 已审结的变更 / 版本真变了),
  证明闸守的是它声称的那个条件。逐条卸闸的变异 A/B 实测:七次红集**两两不相交**,
  合计 9 条红恰好等于未接闸版本的 9 条红。

  **④ 并发。** 两个并发 `seal(同一 activityId)` 只能成功一个,败者以
  `EVIDENCE_SEAL_ALREADY_ACTIVE` 收场(不是未映射 500)。e2e 用真实 barrier ——
  两套 Nest/Prisma pool + 第三个事务当闸门,并以 `pg_stat_activity.wait_event_type='Lock'`
  正面证明两条调用真的在排队,**不是 `Promise.all` 假并发**。把行锁从 `FOR UPDATE`
  变异成 `FOR SHARE` 后该用例立刻红在「败者必须是具名业务码」那一行(败者退化成
  `PrismaClientKnownRequestError`)⇒ 判据确实绑在锁模式上。

  **⑤ audit 零新事件串。** 沿本模块 `activity.publish` 伞事件 + `extra.operation='evidence-seal'`
  区分的既有范式,`AuditLogEvent` 总数不变(136)。

  ⚠️ **与合同的偏离(四条,详见 service 文件头)**:
  (a) §5.8 ⑤ 说三个 revision 都读自 `ActivityEvidenceState`,但 §3.17 该表字段表**没有**
  `workflowRevision` —— 真源是 §3.1 的 `Activity`(§4.2「approved 时…递增 workflowRevision」),
  故从**已加锁的 Activity 行**读。这是合同内部不一致。
  (b) §5.8 ④「待人工复核数量」的真源 `OfflinePunchReviewItem` **至今没有定义**
  (`AMENDMENTS-v1.1.1` §3 裁定为第 6 批开工硬门,并明禁从 §5.7 散文推导表结构)⇒
  计数今天结构上恒 0,已在代码与 e2e 里**显式标注**为「闸已接、真源待接线」,不假装守住。
  (c) §5.8 未给「已存在吻合版本的 active seal」的处置,本实现拒绝它,依据是 §3.17 的逆命题。
  (d) 零 live 场次时 `allWindowsClosedAt` 取 authoritative now(该列 NOT NULL 必须有值),
  不为此发明新的拒绝理由。
