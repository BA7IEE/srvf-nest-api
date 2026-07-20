### Fixed

- 修复从主仓运行 Jest 时递归发现仓内 `.worktrees/**` 测试与模块副本的问题：unit、contract、E2E 配置同时从 spec discovery 与 haste map 排除 `.worktrees/**`，保留 `.claude/worktrees/**` 隔离，并新增须显式运行的 harness selftest 守卫。
