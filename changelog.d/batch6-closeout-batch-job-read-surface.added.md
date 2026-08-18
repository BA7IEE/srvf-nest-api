### Added

- 活动业务改造 v1.1 第 6 批收口:补齐合同 §6.13「后台任务」统一读面 5 个端点
  (`GET/POST /api/app/v1/my/activity-batch-jobs[/:jobId[/items|/retry-failed|/cancel]]`),
  按 §9.9 出 job type、activity、创建人、状态与四项计数、lease 与重试的人话状态、失败项分页。
  判权基准是 `job.activityId` + 当前责任范围(**不是** job 创建人),越权与不存在同码
  `40400` 同文案,不泄露任务存在性;重试与取消在事务内对责任行取 `FOR SHARE` 重新判权,
  撤权后立即失效。`retry-failed` 只把 `failed` 项打回 `pending` 并同额扣减 job 计数
  (成功/跳过项与既有 PunchEvent 一律不动);`cancel` 对 `succeeded`/`cancelled`/`dead`
  拒绝,取消后 worker 的领取判据当场不再匹配。零新增权限码、零 schema、零 migration。
