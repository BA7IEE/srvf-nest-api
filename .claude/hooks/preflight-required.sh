#!/usr/bin/env bash
# Harness 3.0 P2b — 开工门禁的执法半边(PreToolUse: Edit|Write|MultiEdit|NotebookEdit)。
#
# SessionStart 不能阻断,所以真正的门禁在这里:首次写操作前校验通行标记。
# 标记由 .claude/hooks/preflight-gate.sh 在会话开始时写入,内容含 HEAD 与时间戳。
#
# 失效条件(任一即拒):
#   - 标记不存在(preflight 未过 / 未跑)
#   - 标记里的 HEAD 与当前 HEAD 不一致(会话中途换了分支 → 门禁结论已过期)
#
# 设计取舍:只拦**写**,不拦读 —— 未过门禁时只读调研完全允许,
# 这与 process §2「门禁不过不开新功能」的语义一致(调研不是开功能)。
set -u

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
MARKER_PATH="$(git -C "$REPO_ROOT" rev-parse --git-path srvf-preflight.json 2>/dev/null)"
case "$MARKER_PATH" in
  /*) MARKER="$MARKER_PATH" ;;
  *)  MARKER="$REPO_ROOT/$MARKER_PATH" ;;
esac

if [ ! -f "$MARKER" ]; then
  cat >&2 <<'MSG'
⛔ 开工门禁未通过,拒绝写操作。
   原因:没有本会话的 preflight 通行标记(工作树不 clean / 有 open PR / 落后 origin/main /
        依赖或 Prisma client 未就绪 —— 会话开始时的门禁输出里有具体哪一条)。

   修复:
     pnpm agent:preflight          # 看是哪一项没过并按提示修
     # fresh worktree 还需:pnpm install --frozen-lockfile && pnpm prisma:generate
   修完重开会话(门禁在会话开始时判定),或由维护者确认后放行。

   注:只读调研不受影响,仅写操作被拦。
MSG
  exit 2
fi

command -v jq >/dev/null 2>&1 || exit 0
MARKED_HEAD="$(jq -r '.head // ""' "$MARKER" 2>/dev/null)"
CUR_HEAD="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"

if [ -n "$MARKED_HEAD" ] && [ "$MARKED_HEAD" != "$CUR_HEAD" ]; then
  cat >&2 <<MSG
⛔ 开工门禁标记已过期,拒绝写操作。
   门禁判定时 HEAD=${MARKED_HEAD},当前 HEAD=${CUR_HEAD} —— 会话中途换过分支/拉过新提交,
   原先「工作树 clean · 无 open PR · 未落后 origin/main」的结论已不可信。

   修复:pnpm agent:preflight 重新确认后重开会话。
MSG
  exit 2
fi

exit 0
