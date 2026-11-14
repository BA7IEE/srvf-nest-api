# 按需资料

此目录不再是开工门禁。只读取任务需要的资料。

| 资料 | 用途 |
|---|---|
| [ROUTE_AUTHZ](ROUTE_AUTHZ.md) | 从路由声明生成的授权清单，journey/契约工具仍消费 |
| [AUDIT_EVENT_REGISTRY](AUDIT_EVENT_REGISTRY.md) | 审计事件注册，业务测试校验 |
| [DICTIONARY_SEED_REGISTRY](DICTIONARY_SEED_REGISTRY.md) | 字典 seed 注册，业务测试校验 |
| [CUTOVER_SIGNOFF](CUTOVER_SIGNOFF.md) | 生产切换签字，`cutover:check` 仍校验 |
| [CAPABILITIES](CAPABILITIES.md) | 能力及业务合同指针 |
| [NEXT_TASKS](NEXT_TASKS.md) | 未完事项入口；不再强制逐 PR 更新 |

API 派生物使用 `pnpm docs:refresh`（OpenAPI → client；授权清单独立生成）；
检查使用 `docs:openapi:check`、`docs:feclient:check`、`docs:authz:check`。
RBAC 的代码不变量使用 `pnpm check:rbac`，不要求维护生成的权限地图。

旧 read-tax、计数、CODEMAP、架构债务/尺寸台账、冻结稿分类和事故回放已退出必过检查。
业务验收、切换前检查、ESLint 规则与业务注册表仍有效。
旧版材料可用 `git show harness-v3-final:docs/ai-harness/<文件名>` 读取。
