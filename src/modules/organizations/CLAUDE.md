# organizations — 拓扑与审计

单根上限1，closure只在create/move维护。改动须保持邻接树与closure等价、无环、
live child→live parent；不要据历史文档计数更改接口或校验顺序。

- create/update/updateStatus/move/softDelete 在第一条 Organization/closure SQL之前，
  同事务取 lockOrganizationTopology 固定 namespace `srvf:organizations:topology:v1`
  的 signed 64-bit advisory xact lock。不换session/per-node/随机锁、不后移。
  rbac.can保持事务外。announcement-import request-wide事务也先取该锁，create重入同一锁。
- create保留单行DryRunAbort和互斥的外部transaction入口；
  组织、closure、audit必须同事务，preview整体回滚，不另开audit事务。
- membership计数/删除保护只认ACTIVE、startedAt<=now、endedAt=null、未删；
  ENDED/SUSPENDED不占当前归属。
- getActivityOrganizationEligibility(tx,id)只返回eligible/missing/inactive/root，
  判定顺序不存在（含软删）→停用→根；不返组织行、不新事务/隐式锁/缓存。
  isActivityOrganizationResolvable复用该谓词但仍返boolean，活动域不复制判定。
- 同事务审计：create的after；move的parentId before/after；status-change的status before/after；
  delete仅before。resourceType=organization。普通PATCH不审计，同父move无写无audit，
  不把它们当漏记。新建/终止/树结构/授权状态语义须按四类判定。
  import复用create+meta自动取得逐行审计，不另复制audit。

验证 organizations-concurrency、organizations-audit-characterization、CRUD及announcement-import preview；
并发测试同时检查closure missing/extra/wrong-depth/cycle与锁入口顺序，audit失败必须回滚。
