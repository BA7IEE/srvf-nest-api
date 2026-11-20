#!/usr/bin/env bash
# The normal psql environment supplies the connection. No ACL changes.
set -euo pipefail
if [[ $# != 2 ]]; then
  echo 'Usage: check-ledger.sh DATABASE RUNTIME_ROLE' >&2
  exit 2
fi
here=$(cd "$(dirname "$0")" && pwd)
exec psql -XAtq --dbname="$1" -v "expected_database=$1" -v "runtime_role=$2" \
  -v "contract=$(cat "$here/ledger-contract.json")" -f "$here/preflight.sql"
