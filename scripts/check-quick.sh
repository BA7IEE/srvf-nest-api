#!/usr/bin/env bash
# agent:check:quick 并行版(Harness 3.0 P1)。
#
# 三个相互独立的检查并行执行,输出按固定顺序回放(交错输出对 AI 阅读是灾难):
#   1. lint(eslint --cache:热缓存 ~1s,冷 ~44s)
#   2. typecheck(~18s)
#   3. unit tests(~24s,jest 自身已并行,--maxWorkers=50% 限流避免与 lint 抢核)
# 实测:串行 ~85s → 并行热缓存 ~25s(被 unit 封顶)/ 冷缓存 ~45s(被 lint 封顶)。
#
# ⚠️ 口径差异(刻意设计,勿"顺手统一"):
#   本脚本用 eslint --cache 换速度;缓存只按文件自身内容与配置失效,**不追踪跨文件
#   类型依赖** —— 改了 A 的类型可能让 B 新违反 no-unsafe-*,而 B 不会被重新 lint。
#   因此 CI 与 agent:check:full / agent:check:api 恒冷跑 `pnpm lint`,是权威口径;
#   本脚本只服务 B 档快反馈循环。
#
# SRVF_CHECK_SERIAL=1 回落串行(排障用,与 Harness 2.0 行为一致)。
set -u

if [ "${SRVF_CHECK_SERIAL:-}" = "1" ]; then
  pnpm lint && pnpm typecheck && pnpm test
  exit $?
fi

LOG_DIR="tmp/check"
mkdir -p "$LOG_DIR"

pnpm lint:cached >"$LOG_DIR/lint.log" 2>&1 &
PID_LINT=$!
pnpm typecheck >"$LOG_DIR/tsc.log" 2>&1 &
PID_TSC=$!
# 直调 jest(pnpm test -- 会把 '--' 后内容当测试路径 pattern,不是 flag)
pnpm exec jest --config test/jest-unit.config.ts --maxWorkers=50% >"$LOG_DIR/unit.log" 2>&1 &
PID_UNIT=$!

wait "$PID_LINT"; RC_LINT=$?
wait "$PID_TSC"; RC_TSC=$?
wait "$PID_UNIT"; RC_UNIT=$?

echo "==================== [1/3] lint (cached; exit $RC_LINT) ===================="
cat "$LOG_DIR/lint.log"
echo "==================== [2/3] typecheck (exit $RC_TSC) ===================="
cat "$LOG_DIR/tsc.log"
echo "==================== [3/3] unit tests (exit $RC_UNIT) ===================="
cat "$LOG_DIR/unit.log"

echo ""
if [ "$RC_LINT" -ne 0 ] || [ "$RC_TSC" -ne 0 ] || [ "$RC_UNIT" -ne 0 ]; then
  echo "✗ agent:check:quick FAILED (lint=$RC_LINT typecheck=$RC_TSC unit=$RC_UNIT)"
  exit 1
fi
echo "✓ agent:check:quick 全绿 (lint / typecheck / unit;lint 为缓存口径,权威冷跑见 CI 与 agent:check:full)"
