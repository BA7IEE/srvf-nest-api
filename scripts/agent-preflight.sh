#!/usr/bin/env bash
# agent-preflight.sh — AI / Claude Code 开工门禁
#
# 用途:把 docs/process.md §2 的开工 checklist 固化为一条命令。
# 只读检查;不动工作树、不 fetch、不 checkout、不 prune、不 install。
#
# 硬门禁(任一成立 → exit 1,见末尾 "Preflight gate (hard)"):
#   1. 工作树非 clean(git status --short 非空)
#   2. 存在 open PR(gh pr list --state open 非空;lane 模式降为清单打印,见下)
#   3. 落后 origin/main(git rev-list --count HEAD..origin/main > 0;
#      基于上次 fetch 的本地 ref,本脚本刻意不 fetch)
#   4. (仅 lane 模式)检测到 E 档 bump 特征:package.json 与
#      src/bootstrap/apply-swagger.ts 同时脏/暂存 → 硬拒,release 收口必须 global
# 其余咨询项(版本三方一致 / handoff / Unreleased)仍只读打印,人工研判,不在此硬判。
#
# lane 模式(Harness 2.0 T0 §1.4/d3;第五轮 review R5-08 起 lane 名必填):
#   触发形态:`--lane <name>` / `--lane=<name>` / 环境变量 SRVF_LANE=<name>。
#   lane 名必须显式且合法([A-Za-z0-9_-]、至少一个字母、不以 - 开头);无名、纯数字
#   (如 0)或 false/no/off/none 等"疑似想关闭"的值 → exit 1,不猜意图、不静默回落
#   global(任意非空值都进 lane 模式曾是 E 档 open-PR 闸的机械绕过面)。
#   并行 lane 开工门禁 —— 条 1 / 条 3 仍硬判;条 2 降为打印 open PR 清单,由总控
#   研判写集是否冲突,不 exit 1。global 模式(无参)行为与 v1 逐字一致;
#   E 档 release 收口必须用 global 模式(条 4 对 bump 特征双保险)。
# gh 未登录 / 未安装、或 origin/main 不可解析时:对应硬判跳过(打印原因)而非误杀——
# 沿"只读门禁不硬失败"约定。本门禁仅供本地 pre-work;CI 不调用本脚本
# (open-PR 判定假设本地语境;若日后接入 PR 触发的 CI,需为该判定加 `[ -z "$CI" ]` 守卫)。
# 参数/环境校验样例回归:scripts/agent-preflight.selftest.sh。

set -euo pipefail

usage_fail() {
  printf '用法:pnpm agent:preflight [--lane <lane名>]\n✗ %s\n' "$1" >&2
  exit 1
}

# 合法 lane 名:[A-Za-z0-9_-] 且含至少一个字母,不以 - 开头;拒 false/no/off/none
is_valid_lane_name() {
  case "$1" in
    '' | -*) return 1 ;;
  esac
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_-]*$' || return 1
  printf '%s' "$1" | grep -q '[A-Za-z]' || return 1
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    false | no | off | none) return 1 ;;
  esac
  return 0
}

LANE_MODE=0
LANE_NAME=""
case "${1:-}" in
  '') : ;;
  --lane)
    LANE_MODE=1
    LANE_NAME="${2:-${SRVF_LANE:-}}"
    ;;
  --lane=*)
    LANE_MODE=1
    LANE_NAME="${1#--lane=}"
    ;;
  *)
    usage_fail "未知参数:$1"
    ;;
esac
if [ "$LANE_MODE" -eq 0 ] && [ -n "${SRVF_LANE:-}" ]; then
  LANE_MODE=1
  LANE_NAME="$SRVF_LANE"
fi

if [ "$LANE_MODE" -eq 1 ] && ! is_valid_lane_name "$LANE_NAME"; then
  usage_fail "lane 模式必须带显式 lane 名(R5-08):--lane <name> / --lane=<name> / SRVF_LANE=<name>;当前值 '${LANE_NAME}' 非法(空 / 纯数字 / false 类值不接受,也不静默回落 global —— 想跑 global 请去掉 --lane 并 unset SRVF_LANE)"
fi

if [ "$LANE_MODE" -eq 1 ]; then
  printf '(lane 模式:lane=%s;open-PR 不硬判,写集冲突由总控研判;E 档收口必须用 global 模式)\n' "$LANE_NAME"
fi

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
if [ "$LANE_MODE" -eq 1 ] && [ -n "$WORKTREE_DIRTY" ]; then
  # E 档 bump 特征:版本双源同时在改 = release 收口动作,lane 模式硬拒(R5-08)
  if printf '%s\n' "$WORKTREE_DIRTY" | grep -Eq '[[:space:]]package\.json$' \
    && printf '%s\n' "$WORKTREE_DIRTY" | grep -qF 'src/bootstrap/apply-swagger.ts'; then
    fail "lane 模式检测到 E 档 bump 特征(package.json 与 src/bootstrap/apply-swagger.ts 同时脏/暂存)→ release 收口必须 global 模式(process §8.4)"
  fi
fi
if [ "$GH_OK" -eq 1 ] && [ -n "$PR_OPEN" ]; then
  if [ "$LANE_MODE" -eq 1 ]; then
    echo "ℹ lane 模式:存在 open PR(清单见上)— 不硬判;写集冲突由总控研判"
  else
    fail "存在 open PR(gh pr list --state open 非空)→ 先合并 / 关闭 / 对齐(release 收口阶段例外,见 process §5)"
  fi
fi
if [ -n "$BEHIND" ] && [ "$BEHIND" -gt 0 ]; then
  fail "落后 origin/main ${BEHIND} 个提交 → 先对齐 main(本脚本不 fetch,必要时先 git fetch)"
fi

if [ "$GATE_FAIL" -ne 0 ]; then
  echo "preflight 门禁未过:"
  printf '%s' "$FAIL_MSG"
  echo "(global 模式硬判 工作树 / open-PR / 落后 origin/main 三条;lane 模式 open-PR 降为研判、另硬拒 bump 特征;其余咨询项见上,人工研判)"
  exit 1
fi

# 通过摘要据"实际校验到的项"如实拼装(gh 不可用 / origin/main 不可解析时,对应项标记为"未校验"而非谎报通过)。
SUMMARY="工作树 clean"
if [ "$GH_OK" -eq 1 ]; then
  if [ "$LANE_MODE" -eq 1 ] && [ -n "$PR_OPEN" ]; then
    SUMMARY="$SUMMARY · open-PR lane 豁免(总控研判写集)"
  else
    SUMMARY="$SUMMARY · 无 open PR"
  fi
else
  SUMMARY="$SUMMARY · open-PR 未校验(gh 不可用)"
fi
if [ -n "$BEHIND" ]; then SUMMARY="$SUMMARY · 未落后 origin/main"; else SUMMARY="$SUMMARY · 落后判定跳过(origin/main 不可解析)"; fi
echo "✅ 硬门禁通过($SUMMARY)"
