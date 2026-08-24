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

# ── 本次写操作归哪棵工作树管(2026-08-24)─────────────────────────────────────
# ⚠️ 本段在 preflight-required.sh / preflight-gate.sh / redzone-guard.sh 里**逐字相同**,
#    由 harness-guards.selftest 的「三份仓根推导逐字一致」断言钉死 —— 改一处必须改三处。
#
# REPO_ROOT(脚本自身位置)继续只用来找**执法层自己的资产**:判据脚本 / tsx / redzone.json /
# preflight 脚本。那部分不动 —— 脚本位置是恒定事实,没有「git 不可用就放行一切」的失效模式。
#
# 但「这次写操作归哪棵工作树管」是**另一件事**,原先也用 REPO_ROOT,那是错的:
# hook 以 $CLAUDE_PROJECT_DIR/.claude/hooks/… 注册,而 CLAUDE_PROJECT_DIR 恒指主仓 ⇒
# 在任何 worktree 里 REPO_ROOT 都指向主仓。同一个缺陷同时造出**四个**故障,方向还相反:
#   ① worktree 内的**绝对**路径不在主仓下 ⇒ 被当成「仓外」放行(fail-open,该拦没拦)
#   ② **相对**路径落进「按仓内处理」⇒ 查的是主仓的标记 ⇒ 主仓没标记就拒
#      (fail-closed,不该拦却拦;连往仓外写都被拦)
#   ③ 红区判定同理漏放:`REL="${FILE#$REPO_ROOT/}"` 剥不掉前缀 ⇒ REL 仍是绝对路径 ⇒
#      命中「仓库外文件不归红区管」而放行 —— **worktree 里用绝对路径写红区,两道闸同时静默放行**
#   ④ `harness:grant` 把令牌写进本 worktree 的 git 目录,而 guard 去主仓找 ⇒ **授权不被消费**
# ⇒ 一条 lane 能不能写文件、红区拦不拦得住,取决于**主仓那棵树**的状态 —— 荒唐的跨 worktree 耦合。
#
# 修法:按**被操作文件自己**的位置定位它所属的工作树;拿不到路径时按 hook 的 cwd
# (payload 的 .cwd,缺省再退到进程 cwd)。
# ⚠️ 不重蹈「git 不可用就 `|| exit 0`」的覆辙:凡定位不了一律**回落到 REPO_ROOT**
#    (= 修复前的行为),绝不因为「判不出归属」而放行。
REPO_COMMON_DIR="$(cd "$REPO_ROOT" 2>/dev/null && git rev-parse --git-common-dir 2>/dev/null)"
case "$REPO_COMMON_DIR" in
  ''|/*) ;;
  *) REPO_COMMON_DIR="$(cd "$REPO_ROOT" && cd "$REPO_COMMON_DIR" 2>/dev/null && pwd)" ;;
esac

# 输出 $1 所属工作树的根;不在本仓家族内、或 git 不可用 ⇒ 非零退出且无输出。
_worktree_root_of() {
  _d="$1"
  [ -n "$_d" ] || return 1
  [ -n "$REPO_COMMON_DIR" ] || return 1
  # 目标文件可能尚未创建(Write 新文件),向上取第一个存在的祖先目录
  while [ ! -d "$_d" ]; do
    _up="$(dirname "$_d")"
    [ "$_up" != "$_d" ] || return 1
    _d="$_up"
  done
  _top="$(git -C "$_d" rev-parse --show-toplevel 2>/dev/null)" || return 1
  [ -n "$_top" ] || return 1
  # 必须与执法层自身**同属一个仓**(比较 git-common-dir):主仓与它的每棵 worktree 都相同,
  # 别的仓 / 根本不是仓 ⇒ 本仓门禁与红区都不该管它。
  _common="$(cd "$_d" 2>/dev/null && git rev-parse --git-common-dir 2>/dev/null)" || return 1
  case "$_common" in
    /*) ;;
    *) _common="$(cd "$_d" && cd "$_common" 2>/dev/null && pwd)" || return 1 ;;
  esac
  [ "$_common" = "$REPO_COMMON_DIR" ] || return 1
  printf '%s' "$_top"
}

# $1 = 目标路径(可为空 / 相对);$2 = hook payload 里的 cwd(可为空)。结论写进两个变量:
#   CONTEXT_IN_REPO — 1 = 归本仓(主仓或其任一 worktree)管;0 = 仓外,本仓不管
#   CONTEXT_ROOT    — 归属的那棵工作树的根
resolve_write_context() {
  CONTEXT_ROOT="$REPO_ROOT"
  CONTEXT_IN_REPO=1
  case "$1" in
    /*)
      # 绝对路径:按**文件自己**的位置定位。定位不到 = 不在本仓任何工作树内 = 仓外。
      _root="$(_worktree_root_of "$1")" || { CONTEXT_IN_REPO=0; return 0; }
      ;;
    *)
      # 相对路径 / 拿不到路径:按 hook 的 cwd 定位;定位不到就沿用 REPO_ROOT 并
      # **仍按仓内处理**(保守,与修复前一致 —— 判不出归属不构成放行理由)。
      _cwd="$2"
      [ -n "$_cwd" ] || _cwd="$(pwd 2>/dev/null)"
      _root="$(_worktree_root_of "$_cwd")" || return 0
      ;;
  esac
  CONTEXT_ROOT="$_root"
}

# 仓库**外**的写入不受本仓门禁管(实测踩到:写 ~/.claude 下的 memory 文件被拦)。
# 门禁语义是「本仓状态不干净时别改本仓代码」,与仓外文件无关;拦它们纯属误伤。
# ⚠️「仓外」按**工作树归属**判,不按「是否在 REPO_ROOT 之下」—— 后者会把每一棵 worktree
#    都误判成仓外而整片放行,那正是 2026-08-24 修掉的 fail-open。
TARGET=""
HOOK_CWD=""
if command -v jq >/dev/null 2>&1; then
  INPUT="$(cat)"
  TARGET="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""')"
  HOOK_CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // ""')"
fi
resolve_write_context "$TARGET" "$HOOK_CWD"
[ "$CONTEXT_IN_REPO" = "1" ] || exit 0

MARKER_PATH="$(git -C "$CONTEXT_ROOT" rev-parse --git-path srvf-preflight.json 2>/dev/null)"
case "$MARKER_PATH" in
  /*) MARKER="$MARKER_PATH" ;;
  *)  MARKER="$CONTEXT_ROOT/$MARKER_PATH" ;;
esac

if [ ! -f "$MARKER" ]; then
  cat >&2 <<'MSG'
⛔ 开工门禁未通过,拒绝写操作。
   原因:没有本会话的 preflight 通行标记(工作树不 clean / 有 open PR / 落后 origin/main /
        依赖或 Prisma client 未就绪 —— 会话开始时的门禁输出里有具体哪一条)。

   修复:
     pnpm agent:preflight          # 看是哪一项没过并按提示修
     # fresh worktree 还需:pnpm install --frozen-lockfile && pnpm prisma:generate
   修完跑 bash .claude/hooks/preflight-gate.sh 重新判定(不必重开会话),或由维护者确认后放行。

   注:只读调研不受影响,仅写操作被拦。
   注:标记按**被写文件所属的工作树**查 —— 每棵 worktree 各有各的标记,互不顶替。
MSG
  exit 2
fi

command -v jq >/dev/null 2>&1 || exit 0
# 按**分支名**判过期,不按 HEAD sha:会话内正常提交会改 HEAD,
# 若按 sha 判,每 commit 一次就全线卡死(实测踩到)。要捕捉的是「中途换了分支」。
MARKED_BRANCH="$(jq -r '.branch // ""' "$MARKER" 2>/dev/null)"
CUR_BRANCH="$(git -C "$CONTEXT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"

if [ -n "$MARKED_BRANCH" ] && [ "$MARKED_BRANCH" != "$CUR_BRANCH" ]; then
  cat >&2 <<MSG
⛔ 开工门禁标记已过期,拒绝写操作。
   门禁判定时在分支 ${MARKED_BRANCH},当前在 ${CUR_BRANCH} —— 会话中途换过分支,
   原先「工作树 clean · 无 open PR · 未落后 origin/main」的结论已不可信。

   修复:bash .claude/hooks/preflight-gate.sh(就地重新判定并刷新标记,不必重开会话)。
MSG
  exit 2
fi

exit 0
