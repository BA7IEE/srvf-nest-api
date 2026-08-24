#!/usr/bin/env bash
# Harness 3.0 P2b — 红区写前拦截(PreToolUse: Edit|Write|MultiEdit|NotebookEdit)。
#
# 语义:命中 harness/redzone.json 的路径 → 拒绝,除非本 worktree 存在有效授权令牌。
# 这把 AGENTS §3「红区非用户授权不动」从「模型自觉遵守的散文」变成物理拦截。
#
# ⚠️ 契约要点(实查官方文档,不可凭直觉):
#   - exit 1 是**非阻断**错误(会放行!);只有 **exit 2** 才阻断,且 stderr 回喂给模型当拒绝原因
#   - stdin 是 JSON:tool_input.file_path(Edit/Write/MultiEdit)、notebook_path(NotebookEdit)
#   - 本脚本自身在 redzone.json 的 selfGuard 内 —— 模型改不了自己的约束
#
# 授权:用户跑 `pnpm harness:grant <glob> --reason "..."` 生成令牌到
#   $(git rev-parse --git-path srvf-redzone-grant.json)(每 worktree 独立、不入库)。
# 令牌路径由本脚本硬编码,不接受任何来自 tool_input 的覆盖。
#
# 兼容:macOS bash 3.2(禁 declare -A / ${var^^} 等 bash 4 语法)。
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

REDZONE_JSON="$REPO_ROOT/harness/redzone.json"
[ -f "$REDZONE_JSON" ] || exit 0   # 清单不存在 = 本仓未启用红区执法,静默放行

command -v jq >/dev/null 2>&1 || {
  echo "redzone-guard: 缺少 jq,无法解析 hook 输入 —— 拒绝写操作(fail-closed)。请先安装 jq。" >&2
  exit 2
}

# 判定一律交给 scripts/check-redzone.ts --hook(2026-07-29 跨模型评审 finding 5)。
# 本脚本原先用 bash `case` 自己实现了一套 glob 语义,与 TS 侧**一致地错**:
# `src/` + `**` + `*throttler*` 被当成字面后缀比较,实测匹配不到任何文件 ——
# 而 37 条 parity 用例只证明了「两把刻错的尺子读数相同」。
# 现在 shell 侧退化成纯 I/O:取路径 → 调那一个判定 → 按结果拼人话消息。
JUDGE="$REPO_ROOT/scripts/check-redzone.ts"
TSX="$REPO_ROOT/node_modules/.bin/tsx"
if [ ! -f "$JUDGE" ] || [ ! -x "$TSX" ]; then
  cat >&2 <<'MSG'
⛔ 红区判定不可用(缺 scripts/check-redzone.ts 或 node_modules/.bin/tsx)——
   拒绝写操作(fail-closed)。「判不了」不等于「没触碰」。
   fresh worktree 请先跑:pnpm install --frozen-lockfile && pnpm prisma:generate
MSG
  exit 2
fi

INPUT="$(cat)"
TOOL="$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')"
FILE="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""')"
HOOK_CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // ""')"
[ -n "$FILE" ] || exit 0   # 拿不到路径的工具形态:交给 CI 侧兜底,不在此误拦

# 目标归哪棵工作树管 —— 相对化与令牌**全部按它来**,不再按 REPO_ROOT。
# 原先按 REPO_ROOT 相对化:worktree 内的绝对路径剥不掉主仓前缀 ⇒ REL 仍是绝对路径 ⇒
# 命中下面那条「仓库外文件不归红区管」而放行 —— 红区在每一棵 worktree 里**整片失效**
# (2026-08-24 实测:worktree 内 prisma/schema.prisma 与 AGENTS.md 无授权也放行)。
resolve_write_context "$FILE" "$HOOK_CWD"
[ "$CONTEXT_IN_REPO" = "1" ] || exit 0   # 仓外 / 别的仓的文件:不归本仓红区管

# 统一成相对**所属工作树根**的路径(hook 的 cwd 不保证等于该根)。
# ⚠️ 绝对路径必须先解掉路径中的符号链接再剥前缀:CONTEXT_ROOT 来自
# `git rev-parse --show-toplevel`,那是**物理路径**;而 tool_input 给的可能是等价的
# 符号链接路径(macOS 的 /tmp → /private/tmp、/var → /private/var 都是常态)。
# 不解就剥不掉前缀,进而落到下面那条 fail-closed —— 变成**误伤**。
# 目标目录可能尚不存在(新建文件、甚至新建整个子目录),所以要**逐级上溯**到第一个
# 存在的祖先目录再取物理路径,把上溯途中的段落原样接回去。
case "$FILE" in
  /*)
    FILE_DIR="$(dirname "$FILE")"
    FILE_TAIL="$(basename "$FILE")"
    FILE_DIR_ABS=""
    while : ; do
      if [ -d "$FILE_DIR" ]; then
        FILE_DIR_ABS="$(cd "$FILE_DIR" 2>/dev/null && pwd -P)"
        break
      fi
      FILE_UP="$(dirname "$FILE_DIR")"
      [ "$FILE_UP" != "$FILE_DIR" ] || break
      FILE_TAIL="$(basename "$FILE_DIR")/$FILE_TAIL"
      FILE_DIR="$FILE_UP"
    done
    if [ -n "$FILE_DIR_ABS" ]; then
      REL="$FILE_DIR_ABS/$FILE_TAIL"
    else
      REL="$FILE"
    fi
    REL="${REL#$CONTEXT_ROOT/}"
    ;;
  *)  REL="$FILE" ;;
esac
# 判属本仓工作树、却仍剥不掉前缀 ⇒ 归属判得出、相对化判不出。
# ⚠️ 这里**不能** exit 0:放行正是本次修掉的漏放形态。与本文件其余两处同口径 ——
#    「判不了」不等于「没触碰」,一律 fail-closed。
case "$REL" in
  /*)
    echo "⛔ 红区判定异常:${FILE} 判属工作树 ${CONTEXT_ROOT} 却无法相对化 —— 拒绝写操作(fail-closed)。" >&2
    exit 2
    ;;
esac

# 授权令牌路径:{"grants":[{"glob":"...","reason":"...","ts":"..."}]}
# 由本脚本硬编码识别,不接受任何来自 tool_input 的覆盖;内容由判定侧解析。
# ⚠️ 必须按**目标所属的工作树**取:`harness:grant` 把令牌写进那棵树自己的 git 目录
# ($(git rev-parse --git-path …)),按 REPO_ROOT 取会跑去主仓找一个根本不存在的令牌 ⇒
# 维护者发下来的授权**全程不被消费**(2026-08-24 实测:已授权文件走相对路径仍被拒)。
GRANT_PATH="$(git -C "$CONTEXT_ROOT" rev-parse --git-path srvf-redzone-grant.json 2>/dev/null)"
case "$GRANT_PATH" in
  /*) GRANT_FILE="$GRANT_PATH" ;;               # worktree:绝对路径
  *)  GRANT_FILE="$CONTEXT_ROOT/$GRANT_PATH" ;; # 主仓:相对仓库根
esac

# 唯一判定入口。红区/执法层分类、archive 的 allowCreate、授权令牌匹配 —— 全在里面。
VERDICT="$("$TSX" "$JUDGE" --hook "$REL" --grant-file "$GRANT_FILE" 2>/dev/null)"
JUDGE_STATUS=$?
if [ "$JUDGE_STATUS" != "0" ]; then
  echo "⛔ 红区判定异常(exit $JUDGE_STATUS)—— 拒绝写操作(fail-closed)。「判不了」不等于「没触碰」。" >&2
  exit 2
fi

case "$VERDICT" in
  '')       exit 0 ;;   # 未命中 → 放行
  GRANTED*) exit 0 ;;   # 命中但本 worktree 已获授权 → 放行
esac

HIT_KIND="$(printf '%s' "$VERDICT" | cut -f2)"
HIT_ID="$(printf '%s' "$VERDICT" | cut -f3)"
HIT_WHY="$(printf '%s' "$VERDICT" | cut -f4)"

if [ "$HIT_KIND" = "selfGuard" ]; then
  LABEL="执法层(裁判保护)"
  EXTRA="改动执法层还需 CI 的 harness-review 环境审批(维护者在 PR 页面点批准)。"
else
  LABEL="红区"
  EXTRA="按 process §4.1 出人话简报请维护者拍板后再动。"
fi

cat >&2 <<MSG
⛔ ${LABEL}路径,拒绝 ${TOOL}:${REL}
   命中规则:${HIT_ID}
   为什么受保护:${HIT_WHY}

   ${EXTRA}
   获得授权后,由**维护者**执行:
     pnpm harness:grant '${REL}' --reason "<拍板出处>"
   授权仅对本 worktree 会话有效(令牌不入库),完成后请用 pnpm harness:grant --clear 撤销。
MSG
exit 2
