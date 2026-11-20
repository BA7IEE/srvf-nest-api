#!/usr/bin/env bash
# Rehearse on a NEW private-socket PostgreSQL only. Arguments: source checkout, output directory.
set -euo pipefail
umask 077
here=$(cd "$(dirname "$0")" && pwd)
source_tree=$(cd "${1:?pass the fixed backend checkout}" && pwd)
mkdir -p "${2:?pass an output directory}"
out=$(cd "$2" && pwd)
python3 "$here/witness.py" "$source_tree" --check-source
pg_image=sha256:6a2e324ebe59af6031c4c1cd96c1d5072c2ebc36563d2196365e43b8297c062d
tools_image=sha256:38a341827d92292c26d9adc0b461c4bfa531500a583fb5d58a24551f4d4da9da
label=$(python3 -c 'import uuid;print(uuid.uuid4().hex)')
name="srvf-ledger-witness-$label"
socket="$name-socket"
container=
cleanup(){
  if [[ -n "$container" ]]; then docker rm -fv "$container" >/dev/null; fi
  if [[ $(docker volume inspect -f '{{index .Labels "srvf.ledger.trial"}}' "$socket" 2>/dev/null) == "$label" ]]; then
    docker volume rm "$socket" >/dev/null
  fi
}
trap cleanup EXIT
docker volume create --label "srvf.ledger.trial=$label" "$socket" >/dev/null
container=$(POSTGRES_PASSWORD="$(openssl rand -hex 32)" docker run -d --network none --name "$name" --label "srvf.ledger.trial=$label" \
  --tmpfs /var/lib/postgresql/data:rw --mount "type=volume,src=$socket,dst=/var/run/postgresql" \
  -e POSTGRES_DB=app_test -e POSTGRES_HOST_AUTH_METHOD=reject \
  -e POSTGRES_INITDB_ARGS='--auth-local=trust --auth-host=reject' \
  -e POSTGRES_PASSWORD "$pg_image" -c listen_addresses='')
for _ in {1..60}; do
  if docker exec "$container" pg_isready -q -U postgres -d app_test && \
     [[ $(docker exec "$container" cat /proc/1/comm) == postgres ]]; then break; fi
  sleep 1
done
docker exec -i "$container" psql -Xq -v ON_ERROR_STOP=1 -U postgres -d app_test \
  < "$source_tree/test/fixtures/r5-ci-sealed-roles.sql" >"$out/migration-setup.log" 2>&1
docker run --rm --network none --mount "type=volume,src=$socket,dst=/var/run/postgresql" \
  --mount "type=bind,src=$source_tree/prisma,dst=/trial/prisma,readonly" \
  -e 'DATABASE_URL=postgresql://postgres@localhost/app_test?host=/var/run/postgresql' \
  "$tools_image" /app/node_modules/.bin/prisma migrate deploy --schema /trial/prisma/schema.prisma \
  >"$out/migrate.log" 2>&1
python3 "$here/witness.py" "$source_tree" --container "$container" --label "$label" >"$out/result.new"
mv "$out/result.new" "$out/result.json"
