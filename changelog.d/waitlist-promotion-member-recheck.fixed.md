### Fixed

- 活动候补**自动递补**补上锁后队员生命周期重验(第六轮评审 C-BLOCKER-1):`promoteAfterCancellationInTransactionTrusted` 在队首被 `lockFirstComeWaitlistHead` / `lockBatchWaitlistHead` 选出之后、占名额之前,先锁 Member 聚合再重读 live 真相;候选已离队 / 被软删 / 转非 ACTIVE 时**跳过该名额**(保持 waitlisted,不炸掉整批取消/驳回事务),不再把已离队的人自动录取、占名额并投影成 `populationIncluded`。锁序沿本模块既有次序 Activity → 报名头 / permanent identity → **Member** → capacity,复用 `member-lifecycle-lock` 的同一把排他锁。

### Added

- 「正式准入必须锁后重验被录取人」**结构判据**(`participation-admission-gate.criteria.ts`):对参与域永久身份链上写 `statusCode: 'pass'` 的路径动态现扫(不写死路径名单),要求同一事务内存在针对**非操作人**的 Member 行锁重验 —— 对操作人自己的准入复核不满足该条,避免上层边界遮蔽下层边界。配正反对照(摘掉任一兄弟路径的检查必红并点名 / 新增写 pass 的方法必红 / 降级成不加锁读判 G3)。同类未修复敞口以自清洁登记表显式登记:登记项一旦被修好即报 G4 逼其清理。
