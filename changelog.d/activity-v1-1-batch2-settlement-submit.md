### Added

- **活动业务改造 v1.1 第 2 批第三刀:提交不可变 SettlementVersion**(合同
  [`docs/archive/reviews/activity-business-overhaul-v1.1/`](docs/archive/reviews/activity-business-overhaul-v1.1/)
  §5.10 算法 / §4.7 结算状态机 / §3.19 + §3.20 写入对象;修订件 `AMENDMENTS-v1.1.1` 五条缺口均不阻塞本刀)。

  **零 schema / 零 migration / 零端点 / 零 DTO / 零权限码 / 零 Punch 写路径**
  (`test:contract` 零 diff);新增 **10 个 BizCode**(20052–20061)。消费方是第四刀(一审 / 终审)。

  🔴 **提交是单向门** —— 固化之后只能靠退回重来,而退回是人工成本。故本刀每一处判据都走
  **拒绝**,没有一处走"警告后放行"。

  新增三个承载算法的文件 + 两个边界件:

  - `settlement-content-hash.ts` —— **纯函数** canonical 序列化 + sha256。递归**排序对象 key**
    (⇒ 字段书写顺序不影响 hash),小数只能经 `decimalToCanonicalString` 变成定标度文本
    (载荷类型把四个金额列声明成 `string`,TypeScript 直接挡住 `Number(decimal)`),
    并且 **hash 里一个时间字段都没有** —— 提交时刻是元数据不是内容,时区口径问题在结构上不存在。
  - `settlement-submission-validator.ts` —— **纯函数** §5.10 ④ 的五条校验,每条只读**自己那一个计数**。
  - `settlement-submit.service.ts` —— 编排:锁序 `Activity` → `AttendanceSettlementRun`
    (**只有这两把**,不取 member advisory lock);seal 复验 → 五条校验 → contentHash →
    写不可变版本 + 结果行快照 → 推进 run → 同事务 enqueue 通知 intent + audit。
  - `settlement-submit-audit-recorder.ts` / `settlement-notification-producer.ts` ——
    复用既有 `activity.publish` 伞事件 + `extra.operation`(不新增事件串);
    通知 intent 走既有 outbox,**在业务事务内** enqueue。

  ⭐ **本刀最重要的东西是 §5.10 ④ 那五条闸** —— 第二刀把「未决」表达成**不写结果行**,
  那个设计成立的唯一前提就是提交时"人口里有他、结果表里没有他"必须红。五条各有具名码:

  - `PENDING_RESULT`(20056,**包含式**:人口 ⊆ 结果集)与 `ITEM_COUNT_MISMATCH`(20057,
    **基数式**:|结果集| = |人口|)是**双闸**不是冗余 —— 各自能抓到对方抓不到的形态
    (人口 {A,B}、结果 {A,X} 基数相等只有包含式能红;人口 {A}、结果 {A,X} 无人缺席只有基数式能红)。
    自然形态的未决两条都会红,卸掉任意一条仍被另一条拦住。
  - `DUPLICATE_IDENTITY`(20058)/ `OPEN_SEGMENT`(20059)/ `MISSING_RULE`(20060,
    第二刀标的 blocker 在这里真正挡住提交)。

  **提交 = 另开一版,不是把草稿行翻状态**(§3.19「把当前草稿**固化为** immutable
  SettlementVersion」「审核永远引用 versionId,不引用可变 run 内容」):提交版本的结果行是
  **物理上另一批行**(另一个 `settlementVersionId`,`baseResultRevisionId` 指回草稿行),
  第二刀的生成器只写挂在草稿版本下的行,**结构上够不到**已提交版本的任何一行。
  草稿版本行保持 `draft` 不动 —— 它仍是那个可编辑的工作区。

  **幂等**(§5.10 ⑥):`operationKey` + `requestHash`。同 key 同 payload ⇒ 原样返回同一版本
  (不产生第二条、不复制第二批结果行);同 key 不同 payload(或用在另一条 run 上)⇒ 20061。
  ⚠️ `AttendanceSettlementVersion.operationKey` 在 DB 上**只有普通 index、没有 unique**
  (§3.19 只给 `SettlementReviewAction` 点了 unique),防重的正确性来自 **run 行锁的串行化**,
  不是唯一约束;P2002 仍有兜底翻译,不让 Prisma 异常裸奔成 500。
  幂等判定**排在 run 状态闸之前** —— 重放请求打过来时 run 早已被第一次提交推到
  `pending_first_review`,先判状态会把合法重放判成非法。

  **规模**(实测,PG16 + Prisma 6.19.3):结果行固化用一条 `INSERT ... SELECT`,
  **8192 行 ⇒ 1 条 SQL、2 个 bind 参数**,与人数完全无关。
  ⚠️ 顺带更正一个流传的假前提:**Prisma `createMany` 不会**在 bind 上限处崩 —— 它自动分块
  (实测 8192 行拆成 2 条 INSERT)。确定性打穿的是**手写逐行 `VALUES`**
  (8192 行 × 4 列 = 32768 个参数即报 `expected maximum of 32767`;32000 通过 ⇒ 上限逐字 32767)。
  不用 createMany 的真实理由是它的 SQL 条数为 O(人数)、且要把全部结果行读进应用进程再发回去,
  两条都不满足本仓「SQL 次数固定」的批量化判据。

  显式事务预算 **120s**(`SETTLEMENT_SUBMIT_TX_TIMEOUT_MS`):Prisma 默认 5s 在 8192 人的提交上
  必然超时(第一版实测栽在这里)。这与 bind 上限是**两种不同的失败模式**,不能互相顶替。

  判据:新增 **86** 例(contentHash 单测 32 + 五条校验单测 13 + e2e 41),
  并跑了 **7 次单点变异 A/B**:五条闸逐条卸掉后红集**两两不相交**;
  双闸同时卸掉才让"自然未决必被拒"那条红;去掉 canonicalize 的 key 排序只让
  "key 序无关"那三条红(可复现 / 内容敏感两组仍绿)。

  ⚠️ **与合同的偏离(两处,均已在源码文件头逐条标注)**:
  ① §3.20 的 `statusCode` 三值闭集 `draft/committed/superseded` 讲的是**账本是否已入账**,
  没有一个值表示"已提交待审" ⇒ 提交版本的结果行仍写 `draft`,审核阶段落在**版本行**的
  `statusCode` 上(§3.20 本就明写「最新当前结果通过 SettlementVersion 指针确定」)。
  ② §5.10 ⑨ 的「写 Review 待办」合同没有另立一张表 ⇒ 取 run 的
  `statusCode='pending_first_review'` 作为待办本身(§3.19 明写 run 状态「是页面投影和流程根」)。
  通知收件人取活动当前 active owner(一审人解析是 §5.11 的事,本刀不发明);
  没有 active owner 时**跳过通知但不拒绝提交**,是有意的降级。
