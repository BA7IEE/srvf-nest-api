#!/usr/bin/env bash
# agent-preflight.sh — AI / Claude Code 开工门禁
#
# 用途:把 docs/process.md §2 的开工 checklist 固化为一条命令。
# 只读检查;不动工作树、不 fetch、不 checkout、不 prune、不 install。
#
# 硬门禁(任一成立 → exit 1,见末尾 "Preflight gate (hard)"):
#   1. 工作树非 clean(git status --short 非空)
#   2. 存在 open PR(gh pr list --state open 非空)
#   3. 落后 origin/main(git rev-list --count HEAD..origin/main > 0;
#      基于上次 fetch 的本地 ref,本脚本刻意不 fetch)
# 其余咨询项(版本三方一致 / handoff / Unreleased)仍只读打印,人工研判,不在此硬判。
# gh 未登录 / 未安装、或 origin/main 不可解析时:对应硬判跳过(打印原因)而非误杀——
# 沿"只读门禁不硬失败"约定。本门禁仅供本地 pre-work;CI 不调用本脚本
# (open-PR 判定假设本地语境;若日后接入 PR 触发的 CI,需为该判定加 `[ -z "$CI" ]` 守卫)。

set -euo pipefail

section() {
  printf '\n== %s ==\n' "$1"
}

# --- 采集(只读;一次取值,打印与判定复用,避免 TOCTOU) ---
WORKTREE_DIRTY="$(git status --short)"

section "Git status"
if [ -n "$WORKTREE_DIRTY" ]; then
  printf '%s\n' "$WORKTREE_DIRTY"
fi

section "Current branch"
git branch --show-current

section "Recent commits"
git log --oneline -5

section "Open PRs"
GH_OK=1
if PR_OPEN="$(gh pr list --state open --limit 20 2>/dev/null)"; then
  if [ -n "$PR_OPEN" ]; then
    printf '%s\n' "$PR_OPEN"
  else
    echo "(none)"
  fi
else
  GH_OK=0
  PR_OPEN=""
  echo "(gh 不可用 / 未登录 — 跳过 open-PR 硬判)"
fi

section "Behind origin/main"
BEHIND=""
if git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
  BEHIND="$(git rev-list --count HEAD..origin/main 2>/dev/null || echo "")"
  echo "${BEHIND:-?} commit(s) behind origin/main(本地 ref;本脚本不 fetch)"
else
  echo "(origin/main 不可解析 — 跳过落后硬判)"
fi

section "Version"
grep '"version"' package.json

section "Swagger version"
grep 'setVersion' src/bootstrap/apply-swagger.ts || true

section "Latest tags"
git tag --sort=-creatordate | head -5

section "Worktrees"
git worktree list || true

# --- 硬门禁判定 ---
section "Preflight gate (hard)"
GATE_FAIL=0
FAIL_MSG=""
fail() { GATE_FAIL=1; FAIL_MSG="${FAIL_MSG}  ✗ $1"$'\n'; }

if [ -n "$WORKTREE_DIRTY" ]; then
  fail "工作树非 clean(git status --short 非空)→ 先 commit / stash / 与维护者对齐"
fi
if [ "$GH_OK" -eq 1 ] && [ -n "$PR_OPEN" ]; then
  fail "存在 open PR(gh pr list --state open 非空)→ 先合并 / 关闭 / 对齐(release 收口阶段例外,见 process §5)"
fi
if [ -n "$BEHIND" ] && [ "$BEHIND" -gt 0 ]; then
  fail "落后 origin/main ${BEHIND} 个提交 → 先对齐 main(本脚本不 fetch,必要时先 git fetch)"
fi

if [ "$GATE_FAIL" -ne 0 ]; then
  echo "preflight 门禁未过:"
  printf '%s' "$FAIL_MSG"
  echo "(仅工作树 / open-PR / 落后 origin/main 三条机械门禁硬判;其余咨询项见上,人工研判)"
  exit 1
fi

# 通过摘要据"实际校验到的项"如实拼装(gh 不可用 / origin/main 不可解析时,对应项标记为"未校验"而非谎报通过)。
SUMMARY="工作树 clean"
if [ "$GH_OK" -eq 1 ]; then SUMMARY="$SUMMARY · 无 open PR"; else SUMMARY="$SUMMARY · open-PR 未校验(gh 不可用)"; fi
if [ -n "$BEHIND" ]; then SUMMARY="$SUMMARY · 未落后 origin/main"; else SUMMARY="$SUMMARY · 落后判定跳过(origin/main 不可解析)"; fi
echo "✅ 硬门禁通过($SUMMARY)"
