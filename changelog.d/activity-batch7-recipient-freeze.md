### Changed

- 活动业务改造 v1.1 第 7 批第一刀：活动侧四个 Notification Outbox producer 统一收口到单一收件人冻结入口 `activity-recipient-freeze.ts`（纯 tx 函数，不新建表/列）。收件人集合仍是既有「每人一行 intent」的 `destinationRef`，计算依据 / 计算时刻 / 算法版本号 / 集合基数落在既有 `payload` 的可选键 `recipientFreeze`（不 bump `payloadVersion`，in-flight 老行照常投递）。冻结批次按 `cohortKey` 先回捞后重算，回捞命中时**一次收件人查询都不发**；受众标签 `null/[]/非空` 三分支解析由 `activity-publish-review.service.ts` 与 `activity-status-command.service.ts` 的**两份拷贝**收敛为一份。producer 的收件人入参改为品牌类型 `FrozenRecipientCohort`，裸 `memberIds` / `ownerMemberId` 不再可表达。零 endpoint、零 schema、零 BizCode。
