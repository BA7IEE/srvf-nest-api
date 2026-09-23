# Activity OS R5 E1-3：活动贡献政策选择与发布冻结

- 新增模板／活动／岗位三层贡献政策选择，Template V5、Proposal V9、发布审批冻结和四类 Readiness；旧 V1–V4 模板、V2–V8 提案及 legacy 未配置活动保持兼容。
- 新增 Admin/App 选择读写及 App options 共五个端点；两项 scoped Human 权限均不默认授予内建角色，SUPER_ADMIN、Service Principal 与 delegation 不直通。
- 新增第131条 additive migration：不可变选择 revision、item、command receipt 三表及可空历史指针；零 DML、回填、删除或旧 migration 修改，业务数据永久留存。
- 新增选择安全审计与 `20247–20254` 闭合错误码；OpenAPI、生成客户端、RBAC／路由／状态机／审计登记和前端交接同步刷新。
- 既有 E1-1 物理地基回归改用统一受控 fixture cleanup，级联清理时完整恢复贡献政策与分类时长不可截断守卫；业务断言与超时不变。
- 第131条 migration 的3b及最终269权限、173/168审计、30/277字典与实际摘要的4b均已重签。
- 当前仅为 Draft PR 候选；不代表 Ready、合并、部署、D8-OPS、Gate、旧规则转换、正式贡献结算或前端发布。
