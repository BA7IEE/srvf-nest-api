### Added

- **活动业务改造 v1.1 第 2 批第二刀:结算草稿生成 + 服务段重建**(合同
  [`docs/archive/reviews/activity-business-overhaul-v1.1/`](docs/archive/reviews/activity-business-overhaul-v1.1/)
  §5.9 算法 / §4.5 服务段状态机 / §3.18 写入对象;修订件 `AMENDMENTS-v1.1.1` 五条缺口均不阻塞本刀)。

  **零 schema / 零 migration / 零端点 / 零 DTO / 零权限码 / 零 Punch 写路径**
  (`test:contract` 零 diff);新增 **5 个 BizCode**(20047–20051)。消费方是第三刀(提交不可变版本)。

  新增两个文件承载算法:

  - `src/modules/activities/settlement-segment-projector.ts` —— **纯函数**投影器:
    打卡事件链 → 服务段。无 Prisma / 无 ConfigService / 无 `process.env` / 无 `Date.now()`,
    阈值只能从入参来。
  - `src/modules/activities/settlement-draft.service.ts` —— 编排:锁序
    `Activity` → `AttendanceSettlementRun`(**只有这两把**,不取 member advisory lock);
    写 `ParticipantServiceSegmentRevision`(draft)+ `AttendanceSettlementVersion`(draft)
    + `ParticipantSettlementResultRevision`(draft)。

  🔴 **本刀的错不会报错** —— 段算多算少、把待定当缺勤、无规则填 0,每一种都会安静地产出一个
  "看起来正常"的结果然后进账本。故每一处"算不出来"都走**拒绝或待定**,没有一处走默认值:

  - **绝不用计划 `endAt` 补签退**(§5.9 明文 / AC-039):已签到、无签退、窗口已过 ⇒ 段保持
    **开放**(`checkOutAt` / `serviceHours` / `sourceCloseEventId` 三列全 `null`)。
    闭合函数 `closeSegment()` 的签名里**拿不到**任何计划时间,结构上不可能补出一个签退时刻。
  - **void / replace 链整体重建**:用不动点迭代解析"哪些操作事件生效"——
    一条 `replace` 被 `void` 之后,它原本顶掉的事实**自动复活**;`replace` 以自己的
    `occurredAt` 顶上被替代事实的角色,链式 replace 沿链上溯取角色。
  - **`early_departure_close` ⇒ `early_departure_zero`,固定 0 时长 0 分**(不看实际跨度)。
  - **无 event 者不自动判 `absent`**:落**待定**态,「建议」(`suggestedResultCode`)与
    「认定」(`resultCode`)是**两个互斥填充的字段**。
  - **应计分但算出 0 分 ⇒ 标 blocker**,绝不出现"0 分且无标记"的项。
  - 迟到 / 早退只取 `ActivitySession` 行上的**冻结阈值**(`lateGraceMinutes` /
    `earlyLeaveThresholdMinutes`),不读运行时配置、不读模板。
  - 同步路径上限 **500**(具名常量 `SETTLEMENT_DRAFT_SYNC_MAX_POPULATION`,§5.9);
    超阈值明确拒绝并提示走批处理,**本刀不实现 worker / `ActivityBatchJob`**(归第五刀)。

  **重复生成的处置 = 内容寻址**:输入没变 ⇒ 一行不动(幂等,`contentHash` 与版本号都不漂);
  输入变了 ⇒ 旧行标 `superseded` + 写 `revision+1`(§4.5「生成新的 segment revision,
  **不覆盖**旧 revision」);段消失了 ⇒ 只降级不写替代行。

  **贡献规则查找复用** `attendances/contribution-calculator.ts`(它带「同 pair 重复 ACTIVE
  规则 fail-closed」不变量),活动模块**零处**直接查 `ContributionRule`;北京日界仍只有
  `common/datetime/date-only.util.ts` 一份实现 —— 两条都有结构判据钉住。

  ⚠️ **与合同的一处偏离(待拍板)**:§5.9 / §5.10 要求 working draft 里存在「**未决结果**」态,
  但 §3.20 的 `resultCode` 是 **NOT NULL 十值闭集**(DB 有 CHECK),十个值全是**认定**,
  没有一个表示"尚未认定"。本刀取**不写结果行**来表达未决(而不是写一行 `absent` 再挂个标记)
  —— 后者会让任何没读那个标记的下游把人静默判成缺勤,而 DB 上没有任何执行位强迫下游读它。
  机器执行位:`AttendanceSettlementVersion.sessionParticipationCount` 落的是"应有几项",
  第三刀提交时按 §5.10 ④ 一比就红;「未决」与「不在人口」靠 `populationIncluded` 可区分。
  代价:系统给出的**建议值**目前只在服务返回值里、不落库(§5.9 原话是「系统**可**建议」,
  故不违约);若读面需要它可查,需合同方补一个不是 `resultCode` 的字段。

  判据:新增 **64** 例(投影器单测 20 + 结构判据 7 + e2e 37),并跑了 **12 次单点变异 A/B**
  证明每条硬判据都绑在它自己那处实现上(红集除一处可解释的重叠外互不相交)。
