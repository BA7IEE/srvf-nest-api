### Harness 2.0 · PR2 机器层(#TBD)

- 新增 `pnpm docs:counts` / `docs:counts:check`:current-state §1 计数由脚本从真源生成与守护(模块 / 行首 `@Controller` 类 / EXPECTED_ROUTES / migration / BizCode / 权限码〔镜像 check-rbac-map 口径〕/ AuditLogEvent / 内建角色 / cron 共 9 项;锚未接线时宽限跳过,PR3 接线)
- 新增 `pnpm docs:readtax:check`:恒读层字符预算守护(AGENTS 18,000 / current-state 4,500 / CLAUDE 2,500;本批全量 report-only,收口 PR 逐个翻 enforced)
- 新增 `pnpm changelog:merge` + `changelog.d/` fragment 机制:lane 并行下 CHANGELOG 防冲突;单 lane 直接编辑旧路径不废除
- `agent:preflight` 新增 lane 模式(`--lane` / env `SRVF_LANE`):clean tree 与未落后 origin/main 仍硬判,open-PR 降为清单打印供总控研判;global 模式行为逐字不变,E 档收口强制 global
- e2e 测试库按 worktree 派生:linked worktree 自动使用 `app_test_<slug>`(实测 `app_test_harness_2_0` 54 migration 全量 deploy + health e2e 绿),主仓与 CI 恒 `app_test` 零变化,既有 `app_test` 子串安全断言原样生效
- 新增 `.github/pull_request_template.md`(档位 / 写集声明 / 本次未做 / 验证骨架);CI Lint job 接线两项 docs 守护(docs-only 快速路径同样必跑);`.claude/settings.json`(+example)allow 白名单收录 5 条新命令
