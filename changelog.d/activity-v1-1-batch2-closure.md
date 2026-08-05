### Added

- **活动业务改造 v1.1 第 2 批第六刀:机器关账(`ActivityClosureService`)**
  (合同 [`docs/archive/reviews/activity-business-overhaul-v1.1/`](docs/archive/reviews/activity-business-overhaul-v1.1/)
  §5.15 + §3.26;业务 §9.2 的十二道硬检查)。

  🔴 **关账是"这场活动的账算完了"的唯一权威。** 合同 §1.2 把它从「负责人**声明**考勤完成」
  改成 **机器检查**:八类判定全过,才追加一张不可变 `ActivitySettlementClosureRevision`;
  此后统计、评价资格、入队进度全部读它。它的失败模式不是报错,是**悄悄关掉一场没算完的
  活动**,而维护者看不懂代码、发现不了 —— 故本刀每一处判定都走拒绝,没有一处走
  "警告后放行"。

  **⭐ 本刀与旧关账路径并存,一个字都没动它。** 合同 §1.2 还要求删除
  `declareAttendanceComplete` 的关账权威地位、把 `activity-closure-policy.ts` 改为读最新有效
  ClosureRevision —— 那是**既有行为 + 既有 e2e 断言的变更**,本仓铁律是"改既有 e2e 断言 =
  改行为契约 ⇒ 停下报告"。旧路径退场另立一刀并单独拍板(已登记 P1-28)。
  ⇒ 本刀 `activity-closure-policy.ts` / `app-managed-activities.service.ts` / 全部既有 spec
  **零改动**。

  **零端点 / 零 DTO / 零权限码 / 零 schema / 零 migration / 零 seed / 零 cron**(全仓终态仍恰 2)、
  零 Redis / queue、零 Punch 写路径;`pnpm test:contract` 零 diff。对外入口统一留到第 ⑧ 刀。

  新增 **9 个 BizCode(20090-20098)**:八类缺口码各一个 + 幂等撞键码。

  五处值得记的落点:

  - ⭐ **失败是"返回结构化缺口清单",不是抛第一个错。** §5.15 ⑫ 逐字要求「返回**结构化
    缺口码和数量**」,业务 §9.2 举的例子是「30 人报名通过、0 打卡、0 人员结果时……必须
    **清楚提示 30 个队员×场次尚未处理**」。一次尝试可能同时缺好几类,只抛第一个码等于
    把排查成本原样推给一个看不懂代码的人。故 `close()` 返回判别联合
    `{ outcome:'closed' | 'blocked', gaps:[{gapCode,bizCode,count,details}] }` ——
    **八类全跑、不 fail-fast**,`details` 逐项给数,关账页直接渲染成合同 §6 的缺口清单。
    (第二个、也是结构性的理由:本仓 `BizException` 只能携带一个 `BizCodeEntry`,
    抛异常装不下这份清单;`biz.exception.ts` 也不在本刀写集内。)
    真正的异常态(活动不存在 / 幂等撞键 / 撞 partial unique)仍然抛。

  - 🔴 **「任一失败不写半张 closure」是结构性的,不是靠回滚兜底。** 八类检查全部排在
    第一次写入**之前**:缺口路径上事务里只有 `SELECT`,一条写语句都没执行过。
    e2e 造出「前七类过、只有第 ⑧ 类失败」的场景后逐条取证:closure **零新增**、
    Activity 与 Run 的 closure 指针**未动**、outbox intent **零条**、audit **零条**。

  - ⭐ **§5.15 ③ 拆成两类缺口码,不是自作主张。** 业务 §9.2 把"已自然结束或正式提前终止"
    与"打卡窗口已关闭、证据版本已封场"列为**两道独立硬检查**;合并成一个码会让
    "哪一道没有执法位"再也读不出来(沿 20062-20064 三方分离三条各一码的同一理由)。
    ⇒ 2 + §5.15 ④–⑨ 的 6 = **八类**,每类一个具名码 + 逐项计数。

  - ⚠️ **幂等键在合同里无处安放,这是合同的第五处内部不一致(新 finding)。**
    §5.15 ② 要求按 `operationKey + requestHash` 防重,而 §3.26 的字段表**没有给这两列**。
    本刀零 schema ⇒ 幂等键存进 `checksJson.idempotency`,去重域是 **(activityId, operationKey)**。
    **诚实说明**:正确性来自第一把 `Activity` 行锁(所有关账写入都先取它,同一活动的两次
    关账必然串行),**不是** DB unique —— 与第三/四/五刀靠单列 unique 兜底的幂等**不同级**,
    跨活动同 key 不冲突。

  - ⚠️ **「进入 archive waiting」零新列,且刻意不做成截止日。** 全仓没有 archive 状态列,
    §3.1 只给了 `Activity.archiveWaitingDays`(默认 7)⇒ 归档等待是**派生态**
    (存在 active closure 且 `now < closedAt + archiveWaitingDays`),算出来返回并写进 audit。
    修订说明 §4 明确「7 天只是便于发现问题的等待期,**不是合法更正的最终截止日**」⇒
    本刀没有任何一处拿它做拒绝判据,并用一条 e2e 钉住(`archiveWaitingDays=0` 的活动
    在等待期早已过去之后,让位后重新关账照样成功并追加第 2 版)。

  锁序 `Activity FOR UPDATE` → `AttendanceSettlementRun FOR UPDATE`(后者因为本刀要写它);
  **不取 member advisory lock**(关账只读账、不写任何队员维度事实,取了只会凭空多一条
  死锁边)。只读的 Version / Batch 不加锁 —— AC-063 要的串行由第一把提供(前五刀也都
  先取 Activity 行锁)。评价开放 intent **同事务** enqueue(本仓 Outbox 铁律),判据是
  让其后一步抛错、断言 intent 与 closure 一起回滚。

  判据钉在 `test/e2e/activity-settlement-closure.e2e-spec.ts`(**26 例**)与
  `src/modules/activities/activity-closure-checks.spec.ts`(**15 例**)。八类逐类 red-first,
  每条用例**自己断言**「`gaps` 恰好等于那一类」;另跑八次卸闸变异 A/B,八个红集
  **互不重叠**(读数见 PR 报告的红集矩阵)。
