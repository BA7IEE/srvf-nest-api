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
  echo "redzone-guard: 缺少 jq,无法解析红区清单 —— 拒绝写操作(fail-closed)。请先安装 jq。" >&2
  exit 2
}

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

# glob 匹配:** 跨目录,* 单层。用 bash case 的模式匹配(3.2 可用)
matches_glob() {
  # $1 = 路径, $2 = glob
  local path="$1" glob="$2"
  case "$glob" in
    *'**'*)
      # a/** → 前缀匹配;a/**/b.ts → 前缀 + 后缀
      local prefix="${glob%%\*\**}"
      local suffix="${glob##*\*\*}"
      suffix="${suffix#/}"
      case "$path" in
        "$prefix"*)
          [ -z "$suffix" ] && return 0
          case "$path" in *"$suffix") return 0 ;; esac
          ;;
      esac
      return 1
      ;;
    *)
      case "$path" in $glob) return 0 ;; esac
      return 1
      ;;
  esac
}

# 找出命中的条目(红区 + 裁判保护),返回 "id|why|allowCreate"
HIT_ID=""; HIT_WHY=""; HIT_ALLOW_CREATE=""; HIT_KIND=""
while IFS='	' read -r kind id glob why allow_create; do
  [ -n "$glob" ] || continue
  if matches_glob "$REL" "$glob"; then
    HIT_KIND="$kind"; HIT_ID="$id"; HIT_WHY="$why"; HIT_ALLOW_CREATE="$allow_create"
    break
  fi
done <<EOF
$(jq -r '
  (.redzone[]   | . as $e | $e.globs[] | ["redzone",  $e.id, ., $e.why, ($e.allowCreate // false | tostring)] | @tsv),
  (.selfGuard[] | . as $e | $e.globs[] | ["selfGuard", $e.id, ., $e.why, "false"] | @tsv)
' "$REDZONE_JSON")
EOF

[ -n "$HIT_ID" ] || exit 0   # 未命中红区 → 放行

# archive:允许新建文件,禁改既有文件
if [ "$HIT_ALLOW_CREATE" = "true" ] && [ ! -e "$REPO_ROOT/$REL" ]; then
  exit 0
fi

# 授权令牌:{"grants":[{"glob":"...","reason":"...","ts":"..."}]}
GRANT_PATH="$(git -C "$REPO_ROOT" rev-parse --git-path srvf-redzone-grant.json 2>/dev/null)"
case "$GRANT_PATH" in
  /*) GRANT_FILE="$GRANT_PATH" ;;          # worktree:绝对路径
  *)  GRANT_FILE="$REPO_ROOT/$GRANT_PATH" ;; # 主仓:相对仓库根
esac
if [ -f "$GRANT_FILE" ]; then
  while IFS= read -r g; do
    [ -n "$g" ] || continue
    if matches_glob "$REL" "$g"; then exit 0; fi
  done <<EOF
$(jq -r '.grants[]?.glob // empty' "$GRANT_FILE" 2>/dev/null)
EOF
fi

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
