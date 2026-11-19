set -eu
n=$(cat name)
case "$n" in srvf-t45-*) ;; *) exit 80;; esac
test "$(docker network inspect -f '{{.Internal}}' "$n")" = true
img=$(docker inspect --format '{{.Image}}' "$n-api")
sql(){ docker exec "$n-pg" psql -X -U postgres -d srvf_staging -At -v ON_ERROR_STOP=1 -c 'select "eventType",status,attempts,count(*), count("sentAt"),count("completedAt"),"lastErrorCode" from notification_outbox_intents group by 1,2,3,7 order by 1,2'; }
echo BEFORE
sql
docker run -d --network "$n" --name "$n-worker" --env-file api.env -e ACTIVITY_V11_WORKFLOW_ENABLED=true "$img" node dist/notification-outbox-worker >/dev/null
sleep 10
docker inspect --format 'WORKER {{.State.Status}} {{.Image}} {{json .Config.Cmd}}' "$n-worker"
echo AFTER
sql
docker logs "$n-worker" 2>&1 | grep -Eo '42501|P2010|P2021|permission denied for table [[:alnum:]_]+|worker loop started|worker started|P2022|P1010|[a-zA-Z_]+ loop started' | sort | uniq -c || true
docker stop --time 15 "$n-worker" >/dev/null
docker inspect --format 'STOP {{.State.Status}} {{.State.ExitCode}}' "$n-worker"
