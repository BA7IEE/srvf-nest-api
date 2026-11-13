#!/usr/bin/env bash
# Shared 16 GB machine: one stage and one Jest worker at a time.
# Cold lint remains the CI authority; quick retains cached lint.
set -eu
if [ -z "${SRVF_RESOURCE_MANIFEST:-}" ]; then
  exec node scripts/local-resource-run.mjs quick "$@"
fi
# The supervisor owns the process group, including pnpm grandchildren.
trap 'exit 130' INT
trap 'exit 143' TERM
trap ':' EXIT
pnpm lint:cached
pnpm exec tsx scripts/harness-guards.selftest.ts
pnpm exec tsx scripts/harness-eslint.selftest.ts
pnpm typecheck
pnpm exec jest --config test/jest-unit.config.ts --runInBand
