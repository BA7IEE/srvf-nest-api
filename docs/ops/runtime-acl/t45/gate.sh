set -eu
n=$(cat name)
test "$n" = "$(basename "$PWD" | tr . -)"
case "$PWD" in /var/tmp/srvf-t45.????????) ;; *) exit 80;; esac
test "$(docker network inspect -f '{{.Internal}}' "$n")" = true
test "$(docker inspect -f '{{.Image}}' "$n-api")" = sha256:826cd1241eef6e31d3925d4af80b2d1b6830c687d2cc37b67c1123fb9a433f75
test "$(docker exec "$n-pg" psql -XAtq -U postgres -d srvf_staging -c 'SELECT system_identifier FROM pg_control_system()')" = "$(cat cid)"
checkenv='if(process.env.APP_ENV!=="test"||process.env.ACTIVITY_V11_WORKFLOW_ENABLED!==process.argv[1])process.exit(1); console.log(JSON.stringify({app_env:"test",v11:process.argv[1]}))'
case "$1" in
  test-on)
    docker exec "$n-api" node -e "$checkenv" false
    test "$(docker network inspect -f '{{len .Containers}}' "$n")" = 3
    docker stop "$n-web" "$n-api" >/dev/null
    docker rename "$n-api" "$n-off"
    docker run -d --name "$n-api" --network "$n" --network-alias api --env-file api.env -e ACTIVITY_V11_WORKFLOW_ENABLED=true sha256:826cd1241eef6e31d3925d4af80b2d1b6830c687d2cc37b67c1123fb9a433f75 >/dev/null
    expected=true ;;
  *) exit 64;;
esac
docker start "$n-web" >/dev/null
for i in $(seq 1 45); do
 if docker exec "$n-web" curl -fsS -o /dev/null http://127.0.0.1:8080/api/system/v1/health/ready 2>/dev/null; then
 docker exec "$n-api" node -e "$checkenv" "$expected"; exit 0; fi
 sleep 1
done
exit 1
