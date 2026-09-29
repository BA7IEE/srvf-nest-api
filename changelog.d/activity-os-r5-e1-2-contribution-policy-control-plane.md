# Activity OS R5 E1-2：贡献政策目录控制面

- 新增 8 个 Human System 贡献政策目录接口，覆盖政策／版本查询、创建政策／版本、激活和退役。
- 新增两项显式 GLOBAL Human 权限与两类闭合审计；内建角色零默认授予，`SUPER_ADMIN` 不短路，机器身份不可访问。
- 四类写命令以稳定 request hash、锁后身份／权限复核、不可变收据和同事务审计保证幂等与并发安全；读面使用
  Repeatable Read 同快照分页，并隐藏 actor、幂等键、请求哈希和原始 JSON。
- 新增 8 个贡献政策专属 BizCode，刷新 OpenAPI、System client、权限／路由／审计／状态机登记与当前计数。
- 4b 已按权限267、Audit events 172总计／167活跃、字典30类／277项、seed摘要 `9a62f918affc` 及最终权限目录摘要重签。
- 不改 schema 或 migration，不接旧贡献规则、考勤、账本、Readiness、Gate 或生产，不删除、回填或重算业务数据。
