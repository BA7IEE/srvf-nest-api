### Added

- **活动业务改造 v1.1 第 2 批第七刀:更正应用**(合同
  [`docs/archive/reviews/activity-business-overhaul-v1.1/`](docs/archive/reviews/activity-business-overhaul-v1.1/)
  §5.14 + §3.25;**零端点 / 零 DTO / 零权限码 / 零 schema**)。

  🔴🔴 **这是全仓唯一能改动"已生效账本"的通路。** 它成功返回的那一刻,队员账上的
  贡献值就换了一份真值。失败模式**不是报错,是账悄悄错了** —— 冲错、冲两次、
  冲了没补、补了没冲,每一种都会产出一个看起来完全正常的账本。故本刀每一处判定
  都走**拒绝**,没有一处走"警告后放行"。

  新增 `CorrectionApplicationService`,四段式覆盖 §5.14 ①–⑦:
  `submit`(保存 base 版本 / 结果 / 关闭版本三锚点 + 同 target 唯一)→
  `review`(只 approve / return / reject,**不碰账**;§7.5 人员隔离)→
  `prepare`(新版本链 + 更正 posting batch:**先冲回、后补记**)→
  `commit`(§5.14 ⑥ 七项原子切换),`apply` 串起后两步并调**第六刀**重新关账(§5.14 ⑦)。

  ⭐ **复用而非另写**:生效路径**逐字复用第五刀**的 commit 协议(baseline 比对 /
  day-state CAS / 日合计 0..3 / 锁槽预算信号量 / 零部分生效),重新关账**直接调
  第六刀** `ActivityClosureService`,member 锁仍是既有那一把 —— 本刀**没有第二套
  生效路径、没有第二套 member 锁**,也**没有新建** member+date advisory lock。

  账本语义:更正批次先为基础版本下**全部**已生效 credit 分录创建
  `LedgerEntryReversalClaim` + **逐列取反**的负数分录,再写补记分录;
  日上限分配的基线**扣掉本次冲回**(否则满额更正后会凭空少记满额)。
  旧分录受 append-only trigger 保护,在物理上不可能被改 —— 冲回只能另写一条。

  新增 **13 个 BizCode**(20099–20111)。配对残缺**分三码**(只冲不补 / 只补不冲 /
  金额不相反),不合并 —— 合并会让"哪一种残缺没有执法位"再也读不出来。

### Changed

- **第五刀 `ledger-posting.service.ts` 两处改动**(其余一行未动):

  1. **`*_reversal` 闸按更正场景放宽适用范围**(**不是删掉**)。判别式取自 DB 事实
     (有没有 `CorrectionApplication` 指向本批次):更正批次走一套**更严**的配对判据
     (冲回必须成对、逐列等额、有 claim、把旧账全部冲干净);
     **普通结算批次里出现 reversal 仍然 20089**,一个字没放松(留有专门用例钉住)。
  2. **`commitBatch` 的事务体抽成 `commitBatchWithin(tx, …)`**,`commitBatch` 只剩
     「开事务 + 调它」。协议本身一个判定、一条 SQL、一个顺序都没改;抽出来是因为
     §5.14 ⑥ 要求七项切换与 commit **同一事务**,而 Prisma 交互事务无法从外部加入。
     ⚠️ 此项**超出本刀 goal 授权的"其余一行不动"**,已在 PR body 单独成段说明,
     待维护者点头。行为零变化的正对照:第五刀既有 3 个 e2e suite / 27 条用例全绿。
