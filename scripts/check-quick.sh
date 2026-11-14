#!/usr/bin/env bash
# Cached lint is quick feedback; CI runs cold lint to catch cross-file changes.
set -u

if [ "${SRVF_CHECK_SERIAL:-}" = "1" ]; then
  pnpm lint && pnpm typecheck && pnpm test
  exit $?
fi

mkdir -p tmp/check
LOG_DIR=$(mktemp -d tmp/check/quick.XXXXXX)
pnpm lint:cached >"$LOG_DIR/lint.log" 2>&1 &
PID_LINT=$!
pnpm typecheck >"$LOG_DIR/types.log" 2>&1 &
PID_TYPES=$!
pnpm exec jest --config test/jest-unit.config.ts --maxWorkers=50% >"$LOG_DIR/unit.log" 2>&1 &
PID_UNIT=$!

wait "$PID_LINT"; RC_LINT=$?
wait "$PID_TYPES"; RC_TYPES=$?
wait "$PID_UNIT"; RC_UNIT=$?
cat "$LOG_DIR/lint.log" "$LOG_DIR/types.log" "$LOG_DIR/unit.log"
echo "lint=$RC_LINT typecheck=$RC_TYPES unit=$RC_UNIT; logs: $LOG_DIR"
if [ "$RC_LINT" -ne 0 ] || [ "$RC_TYPES" -ne 0 ] || [ "$RC_UNIT" -ne 0 ]; then
  exit 1
fi
