# changelog.d/ — 发布说明片段

需要发布说明的变更放在 `changelog.d/<topic>.md`，减少并行修改 CHANGELOG 的冲突。
内容使用可直接并入 `## Unreleased` 的 Markdown 条目。普通文档修订无需机械登记。

发版前按 `docs/process.md` 执行 `pnpm changelog:merge`：
按文件名顺序归并到 CHANGELOG 的 Unreleased 段并删除已归并片段。
本 README 不参与归并。不再要求 lane 或 PR 分级。
