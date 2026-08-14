### Added

- 活动业务改造 v1.1 第 4 批接通邀请 accept 与分配 runtime：邀请接受复用 canonical 报名的 Form、资格、保险、永久身份、容量和幂等链；`first_come` 按场次即时分配，`qualification_rank`/`lottery` 提供负责人 prepare、commit、void、安全读取四条 canonical 路由。
- rank/lottery 批次冻结候选、报名修订、资格快照/hash 与算法版本；lottery 在 commit 前只保存服务端 seed commitment。commit/void 在同一 Activity 根事务内复核容量、pointer、population 与 D86 applied projection，漂移统一 20147 零写；候补递补只限原场次、原岗位。

### Changed

- allocation command 的同 `operationKey` + 同 canonical 请求现在重放首次安全视图；同 key 异请求保持稳定冲突，后续 commit/void 不会改写旧 prepare/commit 的回执语义。
