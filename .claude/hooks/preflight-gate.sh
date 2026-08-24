#!/usr/bin/env bash
# Harness 3.0 P2b — 开工门禁(SessionStart: startup|clear)。
#
# ⚠️ SessionStart **不能阻断**(官方明文:它的 exit 2 只在 transcript 显示为 hook error,
# 模型看不到、会话照常开始)。所以门禁必须是双件套:
#   件一(本脚本):跑 agent-preflight,把结论写成通行标记 + 用 additionalContext 注入给模型
#   件二(preflight-required.sh,PreToolUse):首次写操作前校验标记,缺失/失效则 exit 2
# 这把「AI 记得跑 preflight」变成「不跑就不能写」——process §2 里最容易被跳过的一条。
#
# 只在 startup / clear 上跑:resume / compact / fork 不重跑(会话中途重判既慢又易误报)。
# 本脚本恒 exit 0:门禁失败不该让会话开不起来(只读调研、看文档都该允许),
# 真正的拦截发生在写操作那一刻。
set -u

# 仓库根由脚本自身位置推导(同其余 hook,不依赖 git 可用性)
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

# ⚠️ 必须**先读 stdin、先定位工作树,再 cd** —— SessionStart 事件没有 file_path,
# 归属只能靠 payload 的 `.cwd`(缺省退到进程 cwd);cd 过去之后再取就永远是 REPO_ROOT。
# 原实现直接 `cd "$REPO_ROOT"`,于是在任何 worktree 里开会话,门禁体检的是**主仓**那棵树、
# 标记也写进主仓的 git 目录 —— 本 worktree 明明干净却永远拿不到标记,
# 而主仓的状态反倒决定了本 lane 能不能写文件(2026-08-24 实证:一条 lane 因此完全写不进任何文件)。
INPUT="$(cat 2>/dev/null || echo '{}')"
HOOK_CWD=""
if command -v jq >/dev/null 2>&1; then
  SOURCE="$(printf '%s' "$INPUT" | jq -r '.source // "startup"')"
  HOOK_CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // ""')"
else
  SOURCE="startup"
fi
resolve_write_context "" "$HOOK_CWD"
cd "$CONTEXT_ROOT" || exit 0

MARKER_PATH="$(git rev-parse --git-path srvf-preflight.json 2>/dev/null)"
case "$MARKER_PATH" in
  /*) MARKER="$MARKER_PATH" ;;
  *)  MARKER="$CONTEXT_ROOT/$MARKER_PATH" ;;
esac

emit() {
  # SessionStart 的 stdout 会直接进模型上下文(官方:该事件 stdout 作为 context)
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg ctx "$1" \
      '{hookSpecificOutput:{hookEventName:"SessionStart", additionalContext:$ctx}}'
  else
    printf '%s\n' "$1"
  fi
}

# 环境卫生:reused worktree 的陈旧 Prisma client 会爆几百个 unsafe-* 假错
# (memory 有案:曾让会话怀疑自己的 diff、浪费多轮排查)。这里只检测 + 提示,
# **不自动执行 install**(会话启动时静默装依赖违背「只读门禁」的定位)。
#
# ⚠️ 生成物位置必须按 pnpm 实况判:pnpm 下**没有** node_modules/.prisma/,
# 生成物在 node_modules/.pnpm/@prisma+client@*/node_modules/.prisma/client/
# (内含 schema.prisma 副本,可作「已生成」的可靠标志)。
# 按 npm 布局写 `-d node_modules/.prisma/client` 会恒误报「未生成」,
# 让门禁在健康仓库上永远失败 —— 这类误报会训练出「无视门禁」的习惯,比没有门禁更糟。
ENV_NOTE=""
GENERATED_SCHEMA="$(ls -d node_modules/.pnpm/@prisma+client@*/node_modules/.prisma/client/schema.prisma 2>/dev/null | head -1)"
if [ ! -d node_modules ]; then
  ENV_NOTE="⚠️ node_modules 缺失 → 先跑:pnpm install --frozen-lockfile && pnpm prisma:generate"
elif [ -z "$GENERATED_SCHEMA" ]; then
  ENV_NOTE="⚠️ Prisma client 未生成 → 先跑:pnpm prisma:generate(否则 typecheck 报几百个 unsafe-* 假错)"
elif [ prisma/schema.prisma -nt "$GENERATED_SCHEMA" ]; then
  ENV_NOTE="⚠️ schema.prisma 比生成物新 → 先跑:pnpm prisma:generate"
fi

# ⚠️ 用 -f 而非 -x:本脚本以 `bash <path>` 显式调用,执行位无关。
# 原先写 -x 而该脚本恰为 644 → 条件恒假 → **整个检查被跳过而 RC 保持 0 → 假报通过**。
# 这是最恶劣的一类失效:门禁在没真检查的情况下宣布「已检查、通过」。
# 因此:脚本缺失 = 无法验证 = 按未通过处理(fail-closed),绝不静默当成通过。
PREFLIGHT_OUT=""
PREFLIGHT_RC=0
if [ -z "$ENV_NOTE" ]; then
  if [ -f scripts/agent-preflight.sh ]; then
    PREFLIGHT_OUT="$(bash scripts/agent-preflight.sh 2>&1)" || PREFLIGHT_RC=$?
  else
    PREFLIGHT_RC=127
    PREFLIGHT_OUT="scripts/agent-preflight.sh 不存在 —— 无法验证开工条件(fail-closed)"
  fi
fi

HEAD_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ── 硬条件 vs 咨询条件(语义修正)──────────────────────────────────────────
# process §2 的三硬判是「**开工前**别在这些状态下**开新功能**」,不是「每次写文件都查」。
# 原实现把三条一律升为「拦写」,结果是:你正在做的任务本身会产生 open PR、
# 开发中工作树当然是脏的 → 连续开发从第二次写入起全线卡死(实测踩到,作者被锁死)。
# 一个让正常开发无法进行的门禁,只会被绕过 —— 误伤到那个程度,防线已经失效。
#
# 因此按「不修就会写出错误代码」来分:
#   硬条件(拦写):依赖/生成物陈旧(会爆几百个假错)、落后 origin/main(在过时基础上改)
#   咨询条件(只提示):工作树脏、有 open PR —— 都是连续推进的常态,由 §2 在开新任务时人判
# 仓库既有的 lane 模式(--lane)本就把 open-PR 降为研判,这里与之语义对齐。
BLOCKING_REASON=""
ADVISORY=""
if [ -n "$ENV_NOTE" ]; then
  BLOCKING_REASON="$ENV_NOTE"
elif [ "$PREFLIGHT_RC" != "0" ]; then
  # 只认「✗ 开头的判定行」:脚本尾部的说明文字里含「未落后 origin/main」,
  # 松匹配会把说明当成判定结果(实测踩到)。
  BEHIND_LINE="$(printf '%s' "$PREFLIGHT_OUT" | grep '✗' | grep '落后 origin/main' | head -1)"
  # 合并进行中(MERGE_HEAD 存在)时,HEAD 仍指向合并前的提交,**按定义必然显示落后**。
  # 此时拦写会把人锁在解冲突这一步之外 —— 而解冲突正是门禁要求的那个补救动作本身。
  # 实测踩到:替 P3 分支对齐 main 时冲突未提交,门禁报「落后 1 个提交」并拒绝一切写,
  # 连修门禁自己都做不到(与 P2b「开工前检查误用成每次写检查」同一类死锁)。
  if [ -n "$BEHIND_LINE" ] && [ -f "$(git rev-parse --git-path MERGE_HEAD 2>/dev/null)" ]; then
    ADVISORY_MERGE="⚠️ 合并进行中(有未解决的冲突或未提交的合并)—— 「落后 origin/main」是该状态的必然表象,已不拦写;请先完成这次合并"
    BEHIND_LINE=""
  fi
  if [ -n "$BEHIND_LINE" ]; then
    BLOCKING_REASON="$BEHIND_LINE"
  elif [ "$PREFLIGHT_RC" = "127" ]; then
    BLOCKING_REASON="$PREFLIGHT_OUT"
  fi
  ADVISORY="$(printf '%s' "$PREFLIGHT_OUT" | grep '✗' | grep -v '落后 origin/main' | head -3)"
  # 合并进行中的提示不能丢:降级不等于沉默,否则「为什么不拦了」无迹可循。
  [ -n "${ADVISORY_MERGE:-}" ] && ADVISORY="$(printf '%s\n%s' "$ADVISORY_MERGE" "$ADVISORY")"
fi

if [ -z "$BLOCKING_REASON" ]; then
  # 记**分支名**而非 HEAD sha:会话内正常提交会改 HEAD,若按 sha 判过期,
  # 每 commit 一次全线卡死(实测踩到)。要捕捉的是「中途换分支」,分支名才是对的信号。
  printf '{"status":"pass","ts":"%s","branch":"%s","head":"%s","source":"%s"}\n' \
    "$NOW" "$BRANCH" "$HEAD_SHA" "$SOURCE" > "$MARKER"
  if [ -n "$ADVISORY" ]; then
    emit "开工门禁:✅ 可写(环境就绪 · 未落后 origin/main;${BRANCH}@${HEAD_SHA})。
⚠️ 但以下状态请自行研判 —— 按 process §2,处于这些状态时**不应开新功能**(继续当前任务可以):
${ADVISORY}
红区写操作仍需 pnpm harness:grant 授权。"
  else
    emit "开工门禁:✅ 全过(工作树 clean · 无 open PR · 未落后 origin/main;${BRANCH}@${HEAD_SHA})。红区写操作仍需 pnpm harness:grant 授权。"
  fi
else
  rm -f "$MARKER"
  emit "开工门禁:❌ 未通过 —— 只读调研可继续,**写操作会被拦下**。
${BLOCKING_REASON}
这是会让你写出错误代码的条件(不是流程提醒),必须先修。修完重跑 pnpm agent:preflight 或重开会话。"
fi
