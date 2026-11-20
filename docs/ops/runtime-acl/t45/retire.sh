set -eu
umask 077
n=$(cat name)
test "$n" = "$(basename "$PWD" | tr . -)"
case "$n" in srvf-t45-????????) ;; *) exit 80;; esac
test "$(docker network inspect -f '{{.Internal}}' "$n")" = true
for kind in api web worker pg; do
  test "$(docker inspect -f '{{range $network,$value := .NetworkSettings.Networks}}{{$network}}{{end}}' "$n-$kind")" = "$n"
done
docker stop --time 15 "$n-web" "$n-api" >/dev/null
sql(){ docker exec "$n-pg" psql -XAt -U postgres -d srvf_staging -v ON_ERROR_STOP=1 -c "$1"; }
sql "select count(*) as outstanding from notification_outbox_intents where status in ('pending','processing')" | awk '{print "outstanding="$1;if($1!=0) exit 1}'
test "$(sql 'select count(*) from audit_logs')" -gt 0
docker exec "$n-pg" pg_dump --data-only --table=public.audit_logs --no-owner --no-privileges -U postgres -d srvf_staging > synthetic-audits.sql
test -s synthetic-audits.sql
sha256sum synthetic-audits.sql
stat -c 'audit file mode=%a' synthetic-audits.sql
docker stop --time 15 "$n-pg" >/dev/null
docker rm -v "$n-web" "$n-api" "$n-worker" "$n-pg" >/dev/null
test "$(docker inspect -f '{{.State.Status}} {{.Image}}' "$n-off")" = "exited sha256:826cd1241eef6e31d3925d4af80b2d1b6830c687d2cc37b67c1123fb9a433f75"
docker rm -v "$n-off" >/dev/null
docker network rm "$n" >/dev/null
rm -- api.env pgenv password init.env ordinary/t45-user-b
rmdir ordinary
for kind in web api worker pg off; do if docker inspect "$n-$kind" >/dev/null 2>&1; then exit 1; fi; done
if docker network inspect "$n" >/dev/null 2>&1; then exit 1; fi
for f in api.env pgenv password init.env ordinary; do test ! -e "$f"; done
echo 'removed five isolated containers, tmpfs DB, network and generated login files'
