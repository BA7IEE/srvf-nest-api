#!/usr/bin/env bash
# agent-preflight.sh — AI / Claude Code 开工只读门禁
#
# 用途:把 docs/process.md §2 的开工 checklist 固化为一条命令。
# 只读检查;不动工作树、不 fetch、不 checkout、不 prune、不 install。
# gh 未登录 / 未安装时不硬失败,只输出错误并继续。

set -euo pipefail

section() {
  printf '\n== %s ==\n' "$1"
}

section "Git status"
git status --short

section "Current branch"
git branch --show-current

section "Recent commits"
git log --oneline -5

section "Open PRs"
gh pr list --state open --limit 20 || true

section "Version"
grep '"version"' package.json

section "Swagger version"
grep 'setVersion' src/bootstrap/apply-swagger.ts || true

section "Latest tags"
git tag --sort=-creatordate | head -5

section "Worktrees"
git worktree list || true
