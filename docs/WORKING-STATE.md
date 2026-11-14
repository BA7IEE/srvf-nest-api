# 工作状态查询

当前任务身份以所在工作树的 `git status`、分支/HEAD 和 GitHub PR 为准；
生产状态见 [current-state](current-state.md)。

`scripts/dev-guard.py` 保留为可选来源审计工具，不要求按 preflight/checkpoint/handoff
或固定时间间隔运行。其 build/release 来源证明不替代测试、维护者授权或生产验收。
旧任务的 SHA、路径和资源记录见 `harness-v3-final:docs/WORKING-STATE.md`，不能套用到新任务。
