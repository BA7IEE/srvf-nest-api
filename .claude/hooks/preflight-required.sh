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

# 仓库根由**脚本自身位置**推导,不依赖 git ——
# 本脚本恒在 <仓库根>/.claude/hooks/ 下。原先用 git rev-parse 时,git 一旦不可用
# (容器内 worktree 的 .git 未挂载、PATH 异常等)就 `|| exit 0` **放行一切** =
# fail-open:守护在最需要它的异常环境里悄悄消失。脚本位置是恒定事实,没有这个失效模式。
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HOOK_DIR/../.." && pwd)"

# 仓库**外**的写入不受本仓门禁管(实测踩到:写 ~/.claude 下的 memory 文件被拦)。
# 门禁语义是「本仓状态不干净时别改本仓代码」,与仓外文件无关;拦它们纯属误伤。
if command -v jq >/dev/null 2>&1; then
  TARGET="$(cat | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""')"
  case "$TARGET" in
    "") ;;                                  # 拿不到路径:按仓内处理(保守)
    /*) case "$TARGET" in "$REPO_ROOT"/*) ;; *) exit 0 ;; esac ;;  # 绝对路径且不在仓内 → 放行
  esac
fi

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
# 按**分支名**判过期,不按 HEAD sha:会话内正常提交会改 HEAD,
# 若按 sha 判,每 commit 一次就全线卡死(实测踩到)。要捕捉的是「中途换了分支」。
MARKED_BRANCH="$(jq -r '.branch // ""' "$MARKER" 2>/dev/null)"
CUR_BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"

if [ -n "$MARKED_BRANCH" ] && [ "$MARKED_BRANCH" != "$CUR_BRANCH" ]; then
  cat >&2 <<MSG
⛔ 开工门禁标记已过期,拒绝写操作。
   门禁判定时在分支 ${MARKED_BRANCH},当前在 ${CUR_BRANCH} —— 会话中途换过分支,
   原先「工作树 clean · 无 open PR · 未落后 origin/main」的结论已不可信。

   修复:pnpm agent:preflight 重新确认后重开会话。
MSG
  exit 2
fi

exit 0
