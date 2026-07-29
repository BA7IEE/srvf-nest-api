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
[ -n "$FILE" ] || exit 0   # 拿不到路径的工具形态:交给 CI 侧兜底,不在此误拦

# 统一成相对仓库根的路径(hook 的 cwd 不保证等于仓库根)
case "$FILE" in
  /*) REL="${FILE#$REPO_ROOT/}" ;;
  *)  REL="$FILE" ;;
esac
# 仍是绝对路径 = 仓库外文件,不归红区管
case "$REL" in /*) exit 0 ;; esac

# 授权令牌路径:{"grants":[{"glob":"...","reason":"...","ts":"..."}]}
# 由本脚本硬编码识别,不接受任何来自 tool_input 的覆盖;内容由判定侧解析。
GRANT_PATH="$(git -C "$REPO_ROOT" rev-parse --git-path srvf-redzone-grant.json 2>/dev/null)"
case "$GRANT_PATH" in
  /*) GRANT_FILE="$GRANT_PATH" ;;          # worktree:绝对路径
  *)  GRANT_FILE="$REPO_ROOT/$GRANT_PATH" ;; # 主仓:相对仓库根
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
