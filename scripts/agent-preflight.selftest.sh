#!/usr/bin/env bash
# agent-preflight.selftest.sh — preflight lane 闸回归自测(第五轮 review R5-08)
#
# 固化冻结报告 full-repo-fifth-review-v0.57.0.md §2.2/§5 R5-08 的绕过样例:
#   - `SRVF_LANE=0 pnpm agent:preflight` 曾进入 lane 模式(任意非空值降级 open-PR 硬判)
#   - 裸 `--lane` 曾无名即进入 lane 模式
# 以及新增的 bump 特征硬拒(package.json + apply-swagger.ts 同时脏 → lane 模式拒)。
#
# 运行:`bash scripts/agent-preflight.selftest.sh`(exit 0 全过 / exit 1 有失败)。
# 参数/环境校验用例直接跑真仓(校验先于任何 git 检查,确定性早退);
# 门禁/bump 用例在临时 git 仓内跑(不触真仓;结束即删)。

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/agent-preflight.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAILED=0

# expect NAME EXPECTED_RC MARKER CMD...(MARKER 为空串则只查退出码)
expect() {
  local name="$1" want_rc="$2" marker="$3"
  shift 3
  local out rc=0
  set +e
  out="$("$@" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq "$want_rc" ] && { [ -z "$marker" ] || printf '%s' "$out" | grep -qF "$marker"; }; then
    PASS=$((PASS + 1))
    echo "✓ $name"
  else
    FAILED=$((FAILED + 1))
    echo "✗ $name(rc=$rc 期望 $want_rc;marker='${marker}')"
    printf '%s\n' "$out" | sed 's/^/    /' | head -8
  fi
}

# --- 参数 / 环境校验(确定性早退,可在真仓直接跑) ---
expect "R5-08 裸 --lane 无名 exit 1" 1 "显式 lane 名" \
  env -u SRVF_LANE bash "$SCRIPT" --lane
expect "R5-08 SRVF_LANE=0 exit 1(报告实跑样例)" 1 "显式 lane 名" \
  env SRVF_LANE=0 bash "$SCRIPT"
expect "R5-08 SRVF_LANE=false exit 1" 1 "显式 lane 名" \
  env SRVF_LANE=false bash "$SCRIPT"
expect "R5-08 --lane=空值 exit 1" 1 "显式 lane 名" \
  env -u SRVF_LANE bash "$SCRIPT" --lane=
expect "R5-08 未知参数 exit 1" 1 "未知参数" \
  env -u SRVF_LANE bash "$SCRIPT" --lan

# --- 门禁行为(临时 git 仓;无 origin/main、gh 不可用 → 两判跳过,验证 clean/lane/bump 判) ---
REPO="$TMP/repo"
mkdir -p "$REPO/src/bootstrap"
(
  cd "$REPO"
  git init -q
  git config user.email selftest@local
  git config user.name selftest
  printf '{\n  "version": "0.0.1"\n}\n' > package.json
  printf "setVersion('0.0.1')\n" > src/bootstrap/apply-swagger.ts
  git add -A
  git commit -qm init
)

in_repo() { # CMD... 在临时仓 cwd 下执行
  (cd "$REPO" && "$@")
}

expect "global 模式 clean 仓通过(行为回归)" 0 "硬门禁通过" \
  in_repo env -u SRVF_LANE bash "$SCRIPT"
expect "lane 模式带名 clean 仓通过 + banner 带 lane 名" 0 "lane=test-lane" \
  in_repo env -u SRVF_LANE bash "$SCRIPT" --lane test-lane
expect "--lane=<name> 等号形态通过" 0 "lane=lane-g" \
  in_repo env -u SRVF_LANE bash "$SCRIPT" --lane=lane-g
expect "SRVF_LANE=<合法名> 通过" 0 "lane=review-x" \
  in_repo env SRVF_LANE=review-x bash "$SCRIPT"
expect "裸 --lane + SRVF_LANE=<合法名> 从环境取名" 0 "lane=env-lane" \
  in_repo env SRVF_LANE=env-lane bash "$SCRIPT" --lane

# global 模式不得出现 lane banner
set +e
GLOBAL_OUT="$(in_repo env -u SRVF_LANE bash "$SCRIPT" 2>&1)"
set -e
if printf '%s' "$GLOBAL_OUT" | grep -q "lane 模式"; then
  FAILED=$((FAILED + 1))
  echo "✗ global 模式误显 lane banner"
else
  PASS=$((PASS + 1))
  echo "✓ global 模式无 lane banner"
fi

# bump 特征:package.json + apply-swagger.ts 同时脏 → lane 模式硬拒
printf '{\n  "version": "0.0.2"\n}\n' > "$REPO/package.json"
printf "setVersion('0.0.2')\n" > "$REPO/src/bootstrap/apply-swagger.ts"
expect "R5-08 lane 模式 bump 特征硬拒" 1 "检测到 E 档 bump 特征" \
  in_repo env -u SRVF_LANE bash "$SCRIPT" --lane test-lane
expect "global 模式 bump 改动只按 dirty 拒(无 bump 特征文案)" 1 "工作树非 clean" \
  in_repo env -u SRVF_LANE bash "$SCRIPT"

# 仅 package.json 单独脏:lane 模式按 dirty 拒,但不得误报 bump 特征
(cd "$REPO" && git checkout -q -- src/bootstrap/apply-swagger.ts)
set +e
ONLY_PKG_OUT="$(in_repo env -u SRVF_LANE bash "$SCRIPT" --lane test-lane 2>&1)"
ONLY_PKG_RC=$?
set -e
if [ "$ONLY_PKG_RC" -eq 1 ] && ! printf '%s' "$ONLY_PKG_OUT" | grep -q "检测到 E 档 bump 特征"; then
  PASS=$((PASS + 1))
  echo "✓ 仅 package.json 脏不误报 bump 特征(仍按 dirty 拒)"
else
  FAILED=$((FAILED + 1))
  echo "✗ 仅 package.json 脏误报 bump 特征或退出码异常(rc=$ONLY_PKG_RC)"
  printf '%s\n' "$ONLY_PKG_OUT" | sed 's/^/    /' | head -8
fi

echo ""
echo "$PASS passed, $FAILED failed"
[ "$FAILED" -eq 0 ] || exit 1
