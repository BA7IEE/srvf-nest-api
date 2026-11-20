#!/usr/bin/env bash
# Run from a private upload directory with schema, dist, SQL and the generated fixture.
set -euo pipefail
umask 077
trial=$(pwd -P)
[[ "$trial" == /var/tmp/srvf-t52.* ]]
pg=sha256:6a2e324ebe59af6031c4c1cd96c1d5072c2ebc36563d2196365e43b8297c062d
tools=sha256:38a341827d92292c26d9adc0b461c4bfa531500a583fb5d58a24551f4d4da9da
base=sha256:1eb4e3ca321b141bca0c9c032e919f8665179f843dc623349fcd765ee6c89ffb
label=$(python3 -c 'import uuid;print(uuid.uuid4().hex)')
name="srvf-t52-$label"
socket="$name-socket"
cleanup(){
  if [[ $(docker inspect -f '{{index .Config.Labels "srvf.t52"}}' "$name" 2>/dev/null) == "$label" ]]; then docker rm -fv "$name" >/dev/null; fi
  if [[ $(docker volume inspect -f '{{index .Labels "srvf.t52"}}' "$socket" 2>/dev/null) == "$label" ]]; then docker volume rm "$socket" >/dev/null; fi
  if docker container inspect "$name" >/dev/null 2>&1 || docker volume inspect "$socket" >/dev/null 2>&1; then return 1; fi
  echo '{"private_pg_and_socket_removed":true}'
}
trap 's=$?; cleanup || exit 1; exit "$s"' EXIT
docker volume create --label "srvf.t52=$label" "$socket" >/dev/null
mount=(--mount "type=volume,src=$socket,dst=/var/run/postgresql")
POSTGRES_PASSWORD=$(openssl rand -hex 32) docker run -d --network none --name "$name" --label "srvf.t52=$label" --tmpfs /var/lib/postgresql/data:rw "${mount[@]}" -v "$trial/contract:/trial/contract:ro" -e POSTGRES_DB=app_test -e POSTGRES_HOST_AUTH_METHOD=reject -e POSTGRES_INITDB_ARGS='--auth-local=trust --auth-host=reject' -e POSTGRES_PASSWORD "$pg" -c listen_addresses='' >/dev/null
for _ in {1..60}; do
  if docker exec "$name" pg_isready -q -U postgres -d app_test && [[ $(docker exec "$name" cat /proc/1/comm) == postgres ]]; then break; fi
  sleep 1
done
sql(){ docker exec -i "$name" psql -XAtq -v ON_ERROR_STOP=1 -U postgres -d app_test "$@"; }
sql < sealed.sql > migrate-setup.log
docker run --rm --network none "${mount[@]}" -v "$trial/prisma:/trial/prisma:ro" -e 'DATABASE_URL=postgresql://postgres@localhost/app_test?host=/var/run/postgresql' "$tools" /app/node_modules/.bin/prisma migrate deploy --schema /trial/prisma/schema.prisma > migrate.log
node_job(){ local role=$1; shift; docker run --rm -i --network none "${mount[@]}" -v "$trial/dist:/app/dist:ro" -v "$trial/reader.cjs:/app/t52-reader.cjs:ro" -v "$trial/fixture.cjs:/app/t52-fixture.cjs:ro" -e "DATABASE_URL=postgresql://$role@localhost/app_test?host=/var/run/postgresql" --entrypoint node "$base" "$@"; }
node_job postgres /app/t52-fixture.cjs >fixtures.json
sql -c 'CREATE ROLE t52_ledger_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; GRANT SELECT ("id","statusCode") ON public."LedgerPostingBatch" TO t52_ledger_reader;'
check(){
  local expected=$1 code=0
  docker exec -e PGUSER=t52_ledger_reader "$name" bash /trial/contract/check-ledger.sh app_test t52_ledger_reader >last-check.json 2>preflight.err || code=$?
  [[ "$expected" == "$code" ]]
  python3 - "$code" <<'PY'
import json,sys
j=json.load(open('last-check.json')); missing=sum(not c['select'] for c in j['rows'])
want=int(sys.argv[1]); assert j['observer_is_runtime'] and j['column_count']==15 and j['database_connect'] and j['schema_usage'] and missing==({0:0,3:13}[want]);print(json.dumps(dict(preflight_exit=want,missing=missing,runtime_observed=True)))
PY
}
check 3
columns=$(python3 -c 'import json;print(",".join(chr(34)+c+chr(34) for c in json.load(open("contract/ledger-contract.json"))["ParticipationLedgerEntry"]["SELECT"]))')
sql -c "GRANT SELECT ($columns) ON public.\"ParticipationLedgerEntry\" TO t52_ledger_reader"
check 0
node_job t52_ledger_reader /app/t52-reader.cjs <fixtures.json
sql -c "REVOKE SELECT ($columns) ON public.\"ParticipationLedgerEntry\" FROM t52_ledger_reader"
check 3
node_job t52_ledger_reader /app/t52-reader.cjs revoked <fixtures.json
[[ $(sql -c 'SELECT count(*) FROM public."ParticipationLedgerEntry"') == 6 ]]
echo '{"synthetic_entries_after_revoke":6,"assertion_exit":0}'
