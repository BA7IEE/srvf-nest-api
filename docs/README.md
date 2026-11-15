# 文档入口

- [协作规则](../AGENTS.md)：命令、架构与授权边界。
- [现实状态](current-state.md)：生产开关、现场待办和已定业务边界。
- [开发与交付](process.md)、[维护者手册](maintainer-guide.md)。
- [测试入口](testing.md)：测试库隔离和运行方式。
- `reference/`：DTO、响应、鉴权、事务、配置等按需读取的细则。
- `handoff/`：前后端契约、客户端和任务到接口映射。
- `ops/`：生产部署、切换、恢复和外部通道操作。
- `plans/`：仍有业务价值的设计与验收依据；历史过程记录不代表当前状态。
- [业务注册表](ai-harness/README.md)：授权声明、审计/字典注册、切换签字和未完事项。

旧 harness 全文保存在远端标签 `harness-v3-final`，可用
`git show harness-v3-final:<原路径>` 读取。`docs/archive/` 中仍被业务测试或规格引用的材料继续保留，
不作为默认阅读内容，也不要求为每次代码改动更新历史台账。
