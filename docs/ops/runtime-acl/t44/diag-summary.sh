set -eu
n=$(cat name)
test "$n" = srvf-t44-PO1zLrSh
test "$(docker network inspect -f '{{.Internal}}' "$n")" = true
img=$(docker inspect -f '{{.Image}}' "$n-api")
chmod 0444 diagfilter.cjs
docker run -d --name "$n-diag" --network "$n" --network-alias probe --env-file api.env -e NODE_OPTIONS=--require=/app/t44-filter.cjs -v "$PWD/diagfilter.cjs:/app/t44-filter.cjs:ro" "$img" >/dev/null
trap 'docker stop --time 10 "$n-diag" >/dev/null && docker rm "$n-diag" >/dev/null' EXIT
for i in $(seq 1 35); do docker exec "$n-web" curl -fsS -o /dev/null http://probe:3000/api/system/v1/health/ready 2>/dev/null && break; sleep 1; done
start=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)
docker run --rm --network "$n" -v "$PWD/summary-one.cjs:/trial/one.cjs:ro" -v "$PWD/ordinary:/ordinary:ro" --entrypoint node srvf-staging-tools:108feebb /trial/one.cjs
docker logs "$n-diag" 2>&1 | grep '^T44ERR '
docker logs --since "$start" "$n-pg" 2>&1 | grep -Eo 'permission denied for (table|relation) [A-Za-z0-9_]+' | sort | uniq -c
