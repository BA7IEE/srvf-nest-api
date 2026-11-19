set -eu
case "$PWD" in /var/tmp/srvf-t41.????????) ;; *) exit 80;; esac
n=$(cat name)
test "$n" = "$(basename "$PWD" | tr . -)"
test "$(docker network inspect -f '{{.Internal}}' "$n")" = true
test "$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$n-pg")" = "$n"
cid=$(docker exec "$n-pg" psql -XAt -U postgres -d srvf_staging -c 'SELECT system_identifier FROM pg_control_system()')
docker run --rm --network "$n" --env-file init.env -e ISOLATED_CLUSTER="$cid" -e TRIAL_ACTIVITY="$1" -v "$PWD/occupancy.cjs:/app/occupancy.cjs:ro" srvf-staging-tools:108feebb node /app/occupancy.cjs
