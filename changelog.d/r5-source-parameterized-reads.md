### Changed

- 新增迁移153，仅把 `e4_source_rows(text)` 的 time_revision slice 与 result 读取参数化到已定位的 allocation、根 version 和 identity。历史144、两个来源分支、12列、NULL、重复度及窗口权重保持。
- 显式适配153迁移总数，并把原152升级测试固定到152。C1-v2完整业务断言、prepare事务60秒、独立oracle30秒、其余预算与active500准入保持。
- 旧来源查询30秒超时及全部失败记录保留；候选的真实PG等价、升级回归、S13及原满额按一次有界队列验证。120秒旧参考比较仅为验证器资源上限，不是业务SLA。153人工审阅与最终CI尚未完成，不表示生产交付。
