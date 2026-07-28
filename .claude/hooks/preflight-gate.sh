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
cd "$REPO_ROOT" || exit 0

INPUT="$(cat 2>/dev/null || echo '{}')"
if command -v jq >/dev/null 2>&1; then
  SOURCE="$(printf '%s' "$INPUT" | jq -r '.source // "startup"')"
else
  SOURCE="startup"
fi

MARKER_PATH="$(git rev-parse --git-path srvf-preflight.json 2>/dev/null)"
case "$MARKER_PATH" in
  /*) MARKER="$MARKER_PATH" ;;
  *)  MARKER="$REPO_ROOT/$MARKER_PATH" ;;
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

PREFLIGHT_OUT=""
PREFLIGHT_RC=0
if [ -x scripts/agent-preflight.sh ] && [ -z "$ENV_NOTE" ]; then
  PREFLIGHT_OUT="$(bash scripts/agent-preflight.sh 2>&1)" || PREFLIGHT_RC=$?
fi

HEAD_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ "$PREFLIGHT_RC" = "0" ] && [ -z "$ENV_NOTE" ]; then
  printf '{"status":"pass","ts":"%s","head":"%s","source":"%s"}\n' "$NOW" "$HEAD_SHA" "$SOURCE" > "$MARKER"
  emit "开工门禁:✅ 通过(工作树 clean · 无 open PR · 未落后 origin/main;HEAD=${HEAD_SHA})。红区写操作仍需 pnpm harness:grant 授权。"
else
  rm -f "$MARKER"
  REASON="${ENV_NOTE:-$(printf '%s' "$PREFLIGHT_OUT" | tail -3)}"
  emit "开工门禁:❌ 未通过 —— 只读调研可继续,**写操作会被拦下**。
${REASON}
修复后重跑 pnpm agent:preflight(或重开会话)。若确需在未过门禁时写入,请先向维护者说明原因。"
fi

exit 0
