#!/usr/bin/env bash
# Harness 3.0 P2b — Bash 写侧旁路拦截(PreToolUse: Bash)。
#
# 为什么必须有:redzone-guard 只看 Edit/Write/MultiEdit 的 file_path。
# 没有本脚本,一条 `sed -i '' 's/x/y/' AGENTS.md` 或 `echo x > AGENTS.md`
# 就能绕过全部红区保护 —— 拦了正门没拦后门等于没拦。
#
# 语义(fail-closed):命令里出现写侧动词时,尽力解析目标路径;
#   - 解析出的路径命中红区 → exit 2 拒绝
#   - 含写侧动词但**解析不出确定路径**(变量展开 / $(...) / eval / 管道套娃)
#     → 也拒绝,并要求改用 Edit/Write(它们会被 redzone-guard 精确判定)
# 命令解析在 shell 里天然不完备,所以宁可误拒也不漏放;正常开发命令
# (git/pnpm/docker/jq 读操作等)不含这些动词,不受影响。
#
# ⚠️ exit 1 是非阻断(会放行);阻断必须 exit 2,stderr 即回喂给模型的拒绝原因。
set -u

# 仓库根由**脚本自身位置**推导,不依赖 git ——
# 本脚本恒在 <仓库根>/.claude/hooks/ 下。原先用 git rev-parse 时,git 一旦不可用
# (容器内 worktree 的 .git 未挂载、PATH 异常等)就 `|| exit 0` **放行一切** =
# fail-open:守护在最需要它的异常环境里悄悄消失。脚本位置是恒定事实,没有这个失效模式。
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HOOK_DIR/../.." && pwd)"
GUARD="$REPO_ROOT/.claude/hooks/redzone-guard.sh"
[ -x "$GUARD" ] || exit 0

command -v jq >/dev/null 2>&1 || exit 0

# 复用 redzone-guard 判定单个路径:命中则它 exit 2。
# **不吞它的 stderr** —— 那正是「命中哪条规则 / 为什么受保护 / 如何获授权」的说明,
# 吞掉的话模型只看到「被拒了」却不知道原因,无法自我纠正。
check_path() {
  printf '{"tool_name":"Bash","tool_input":{"file_path":%s}}' "$(printf '%s' "$1" | jq -Rs .)" \
    | "$GUARD"
  return $?
}

INPUT="$(cat)"
CMD="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')"
[ -n "$CMD" ] || exit 0

# ── 误伤治理 ①:只扫「命令位」,先剥掉 heredoc 正文与引号内容 ──────────────
# 实测踩到:`git commit -m "$(cat <<EOF ... 禁止 sed -i ... EOF)"` 会被判成要执行 sed。
# 那是**描述性文本**,不是命令。引号/heredoc 内的词本就不在命令位,剥掉在语义上正确。
# 为什么值得专门治:误伤比漏放更能摧毁守护的可信度 —— 一旦人习惯了「守护老是瞎拦」,
# 真拦住时也会被当噪音绕过去,防线就名存实亡。
strip_noise() {
  printf '%s\n' "$1" | awk '
    BEGIN { in_h = 0 }
    {
      line = $0
      if (in_h) { d2 = delim; sub(/^[[:space:]]*/, "", line); if (line == d2) in_h = 0; next }
      if (match(line, /<<-?[[:space:]]*['"'"'"]?[A-Za-z_][A-Za-z0-9_]*['"'"'"]?/)) {
        d = substr(line, RSTART, RLENGTH)
        sub(/^<<-?[[:space:]]*/, "", d); gsub(/['"'"'"]/, "", d)
        delim = d; in_h = 1
        sub(/<<-?[[:space:]]*['"'"'"]?[A-Za-z_][A-Za-z0-9_]*['"'"'"]?.*$/, "", line)
      }
      print line
    }
  ' | sed "s/'[^']*'/QUOTED/g; s/\"[^\"]*\"/QUOTED/g"
}
# ── 漏放治理 ①:解释器旁路(2026-07-29 实测,作者自己走过去了)───────────────
# 上面剥 heredoc 与引号是为了治误伤,但它同时开了一个洞:
#   python3 - <<'PY'
#   open('.github/workflows/ci.yml','w').write(...)
#   PY
# 正文被剥掉后,命令位只剩 `python3 -`,不含任何写侧动词 → 直接放行。
# `node -e "fs.writeFileSync('AGENTS.md',...)"` 同理(引号内容被剥)。
# 这不是理论风险:本守护落地当晚,作者就用 python heredoc 写进了未授权的红区文件,
# 而 hook 全程沉默 —— `sed -i` 那条正门拦得好好的,后门却一直开着。
#
# 判定:命令**把代码喂给解释器**(heredoc 或 -e/-c/-p 内联)时,不看命令位,
# 直接在**未剥离的原文**里找红区路径;命中即拒。
# 这里刻意不做「读 vs 写」的区分 —— 解释器正文对 shell 是不透明的,任何试图从
# 字符串里推断意图的做法都会漏。要读受保护文件请用 Read/Grep,要写请用 Write/Edit,
# 两者都会被精确判定。代价是偶尔多拦一次只读脚本,收益是这条后门彻底关上。
#
# 边界:`npx tsx scripts/x.ts` / `node dist/main.js` 这类**跑磁盘上的文件**不触发 ——
# 那些文件本身的改动早已被正门守住,再拦一次只会制造误伤。
# 判定必须限定在**命令位**,且解释器与喂码方式(`<<` 或 -e/-c)出现在**同一行**。
# 否则立刻反向误伤:一条 `git commit -F - <<MSG … MSG` 的正文里只要出现
# "ts-node" / "node -e" 这类字样,就会被当成在跑解释器 —— 本次提交自己踩到了。
# 「描述文本 ≠ 命令位」是本文件上方两条误伤治理的同一课,这里第三次学。
RAW_CMD="$CMD"
INTERP_RE='(python3?|node|ruby|perl|php|deno|osascript|tsx|ts-node)'
# 分隔符集里**刻意不含反引号**:本仓提交信息与文档大量使用 markdown `code` 反引号,
# 把它当命令位会让「正文里写了 `node -e`」的提交全被拦。反引号命令替换在本仓从未使用
# (一律 $(...),而 `(` 在集内),这个取舍换来的是守护不会天天误伤。
# ── 误伤治理 ③:只扫「解释器的代码区」,不扫整条命令 ────────────────────────
# 首版在检测到解释器后扫**整条命令原文**找红区路径。实测 5 次误伤,全是同一形态:
#   · `git commit -F - <<MSG` 的提交信息里**描述**了红区路径,同命令内另有 python heredoc
#   · 只读的 `find … -name <裸文件名>` 分析命令
#   · 想跑一下 `pnpm harness:replay`(命令里出现脚本路径)
# 真正要拦的从来只是**喂给解释器的那段正文**;命令里别处出现的路径是描述,不是执行。
# 「描述文本 ≠ 执行位」在本文件已经是第四次学 —— 这次把范围收到位:
#   heredoc → 从解释器行到它的终止符;-e/-c → 仅该行本身(内联代码就在行内)。
# 收窄不得开出漏放:阳性用例(heredoc 正文写红区 / -e 内联写红区)必须仍被拦,
# 由 harness-hooks.selftest 的正反两组用例同时锁死。
INTERP_CODE="$(printf '%s\n' "$RAW_CMD" | awk -v re="(^[[:space:]]*|[;&|(][[:space:]]*)([A-Za-z0-9_./-]*/)?${INTERP_RE}[[:space:]].*(<<|-[ecpEn]([[:space:]]|\$))" '
  BEGIN { inh = 0 }
  {
    line = $0
    if (inh) {
      t = line; sub(/^[[:space:]]*/, "", t)
      if (t == delim) { inh = 0 } else { print line }
      next
    }
    if (match(line, re)) {
      # 只取**从解释器起**到行尾,不要整行 —— 否则同一行里排在解释器**前面**的
      # 无关命令(如 `cat <受保护路径> | head; node -e "…"`)也会被圈进代码区,
      # 又变回误伤。实测第 6 条误伤回归用例就是这个形态。
      #
      # 已知残留(如实写明,不假装精确):排在解释器**后面**的子命令仍会被圈进来 ——
      # shell 的引号与分隔符在 awk 里无法可靠切分。这一侧刻意留保守:
      # **它只会多拦,不会漏放**,而漏放才是致命的那一种(INC-15 的代价)。
      print substr(line, RSTART)
      if (match(line, /<<-?[[:space:]]*['"'"'"]?[A-Za-z_][A-Za-z0-9_]*['"'"'"]?/)) {
        d = substr(line, RSTART, RLENGTH)
        sub(/^<<-?[[:space:]]*/, "", d); gsub(/['"'"'"]/, "", d)
        delim = d; inh = 1
      }
    }
  }')"

if [ -n "$INTERP_CODE" ]; then
  for tok in $(printf '%s' "$INTERP_CODE" \
      | grep -oE '[A-Za-z0-9_.@/-]+\.(md|ts|tsx|json|jsonc|ya?ml|prisma|mjs|cjs|sh|env)' \
      | sort -u); do
    if ! check_path "$tok"; then
      cat >&2 <<MSG
   ↑ 触发者:解释器内联代码(heredoc 或 -e/-c)中出现了受保护路径。
   shell 看不透解释器正文,无法区分这是读还是写,故一律拒绝(fail-closed)。
   读受保护文件 → 用 Read / Grep;改受保护文件 → 用 Write / Edit(会被精确判定并给出授权指引)。
MSG
      exit 2
    fi
  done
fi

CMD="$(strip_noise "$CMD")"
[ -n "$(printf '%s' "$CMD" | tr -d '[:space:]')" ] || exit 0

# ── 写侧动词:**单一来源** ────────────────────────────────────────────────
# 下面逐子命令的红区判定与上方的开工门禁预检**共用这一个函数**。
# 若两处各写一份 case 模式,漂移时会出现「门禁那侧认为不是写、红区这侧认为是写」
# ——门禁被静默跳过而**毫无症状**。做成函数是为了让漂移在结构上不可能发生。
has_write_verb() {
  case "$1" in
    *"sed -i"*|*"perl -i"*|*" tee "*|*"cp "*|*"mv "*|*"patch "*|\
    *"git checkout -- "*|*"git restore"*|*"git apply"*|*"install -m"*|*"truncate "*) return 0 ;;
  esac
  return 1
}

has_redirect_write() {
  printf '%s' "$1" | grep -qE '[^0-9>&]>>?[[:space:]]*[^[:space:]|&;>]' || return 1
  # 排除 >/dev/... 与 >&N
  printf '%s' "$1" | grep -qE '[^0-9>&]>>?[[:space:]]*(/dev/|&)' && return 1
  return 0
}

# ── P1-31:开工门禁的 Bash 半边 ───────────────────────────────────────────
# 缺陷(2026-08-22 收口):`preflight-required.sh` 只挂在 Edit|Write|MultiEdit 上,
# Bash 侧**从不校验开工门禁通行标记** ⇒ 一条 `python3 <<'PY' … PY` 写文件
# 完全绕过「依赖/生成物陈旧、落后 origin/main、中途换分支」这些前提检查。
# **同一个写操作走 Edit 被拦、走 Bash 放行** —— 判定不一致本身就是缺陷,
# 而 bypass 模式恰恰要求优先用 Bash,所以这条旁路是**默认路径**不是边角。
#
# ⚠️ **复用而非复制**:这里直接调 `preflight-required.sh` 本体(喂一个不含
# file_path 的 JSON,它会落到标记校验那一段),**不重写一份判定**。
# 复制一份的话,两份对「什么算门禁过」的理解会各自漂移,而漂移时
# 「一侧放行一侧拦」没有任何症状 —— 那正是本条缺陷自己的形态。
#
# ⚠️ **只对写侧命令生效**:只读命令(cat / grep / git log …)照旧放行。
# 门禁自己的文案就是「只读调研可继续,写操作会被拦下」,Bash 侧必须同口径。
#
# ⚠️ 次序与 Edit 侧一致:**先门禁、后红区**。门禁不过时红区结论本身也不可信
# (可能落后 main、令牌是别的分支留下的)。
if [ -n "$INTERP_CODE" ] || has_write_verb "$CMD" || has_redirect_write "$CMD"; then
  PREFLIGHT="$REPO_ROOT/.claude/hooks/preflight-required.sh"
  if [ -x "$PREFLIGHT" ]; then
    if ! printf '{"tool_name":"Bash","tool_input":{}}' | "$PREFLIGHT"; then
      echo "   ↑ 触发者:Bash 写侧命令(解释器内联 / 重定向 / sed -i 等)。" >&2
      echo "     开工门禁对 Edit 与 Bash **同口径** —— 换用 Bash 不能绕过它。" >&2
      exit 2
    fi
  fi
fi

# 复用 redzone-guard 判定单个路径:命中则它 exit 2。
# **不吞它的 stderr** —— 那正是「命中哪条规则 / 为什么受保护 / 如何获授权」的说明,
# 吞掉的话模型只看到「被拒了」却不知道原因,无法自我纠正。
check_path() {
  printf '{"tool_name":"Bash","tool_input":{"file_path":%s}}' "$(printf '%s' "$1" | jq -Rs .)" \
    | "$GUARD"
  return $?
}

# 逐子命令处理(&& || ; | 分隔),避免复合命令里漏判后半段
printf '%s\n' "$CMD" | tr ';&|' '\n' | while IFS= read -r part; do
  [ -n "$part" ] || continue

  # 1) 重定向写:> path / >> path(排除 >&2 / >/dev/null 等)
  redirect_target="$(printf '%s' "$part" | sed -n 's/.*[^0-9>]>>\{0,1\}[[:space:]]*\([^[:space:]|&;]*\).*/\1/p')"
  case "$redirect_target" in
    ''|/dev/*|\&*) ;;
    *)
      if ! check_path "$redirect_target"; then
        echo "   ↑ 触发者:shell 重定向写入(> / >>)。请改用 Write/Edit 工具,它们会给出精确的红区判定。" >&2
        exit 2
      fi
      ;;
  esac

  # 2) 原地修改 / 复制 / 移动 / 打补丁 / 恢复类动词
  # ⚠️ 判定走 `has_write_verb`(定义在上方)—— 与开工门禁预检**共用同一份动词表**,
  #    在此内联一份 case 会让两处漂移,而漂移时门禁被静默跳过且毫无症状。
  if has_write_verb "$part"; then
      # ── 误伤治理 ②:cp / mv / install 只判**目标**(最后一个参数),不判来源 ─────
      # 实测踩到:`cp .claude/hooks/x.sh tmp/backup.sh` 被拦 —— 但从受保护路径**读出**
      # 是无害的(等价于 cat > 别处),真正要拦的是写入受保护路径。
      # 其余动词(sed -i / tee / patch / git restore)的路径参数本身就是写入目标,全判。
      verb_scans_target_only=0
      case "$part" in
        *"cp "*|*"mv "*|*"install -m"*) verb_scans_target_only=1 ;;
      esac
      if [ "$verb_scans_target_only" = "1" ]; then
        last_tok=""
        for tok in $part; do
          case "$tok" in -*|'') continue ;; esac
          last_tok="$tok"
        done
        if [ -n "$last_tok" ]; then
          if ! check_path "$last_tok"; then
            echo "   ↑ 触发者:Bash 写侧命令写入受保护路径。请改用 Write/Edit 工具。" >&2
            exit 2
          fi
        fi
        continue
      fi

      # 尽力取出看起来像仓内路径的参数
      found_any=0
      for tok in $part; do
        case "$tok" in
          -*|/dev/*|'') continue ;;
        esac
        # 仓内相对路径(含扩展名或已知目录前缀)才判
        case "$tok" in
          */*|*.md|*.ts|*.json|*.yml|*.yaml|*.prisma|*.mjs|*.sh)
            found_any=1
            if ! check_path "$tok"; then
              echo "   ↑ 触发者:Bash 写侧命令(sed -i / tee / cp / mv / git restore / patch 等)。请改用 Write/Edit 工具。" >&2
              exit 2
            fi
            ;;
        esac
      done
      if [ "$found_any" = "0" ]; then
        cat >&2 <<MSG
⛔ 拒绝:命令含写侧动词但解析不出确定的目标路径,无法判断是否触碰红区(fail-closed)。
   命令片段:${part}
   请改用 Write / Edit / MultiEdit 工具执行文件修改 —— 它们会被精确判定;
   若确属必要的批量操作,请出人话简报请维护者拍板。
MSG
        exit 2
      fi
  fi
done

# 上面 while 处于管道末段 = 子 shell:其中的 exit 2 结束的是子 shell,
# 但子 shell 的退出码就是整条管道的退出码,故这里显式取回。
# 只认 2(阻断);其余一律 0 —— 避免子 shell 里最后一条 case 未匹配之类的
# 偶然非零状态被当成 hook 错误刷进 transcript。
STATUS=$?
[ "$STATUS" = "2" ] && exit 2
exit 0
