### Fixed

- 活动协办委托、职责结束与负责人移交通知改为和 assignment、系统 RoleBinding、审计同事务写入 durable outbox。
- 负责人移交分别向旧、新负责人写稳定幂等 intent；任一 intent 失败都会回滚完整移交。
