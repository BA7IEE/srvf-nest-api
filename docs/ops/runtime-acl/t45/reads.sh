set -eu
n=$(cat name)
test "$n" = "$(basename "$PWD" | tr . -)"
test "$(docker network inspect -f '{{.Internal}}' "$n")" = true
case "$1" in baseline|success|observe) ;; *) exit 2;; esac
docker run --rm --network container:"$n-web" -e EXPECT="$1" -e ACTIVITY_ID="$(cat activity)" -v "$PWD/reads.cjs:/trial/reads.cjs:ro" -v "$PWD/ordinary:/ordinary:ro" -v "$PWD/password:/fixture/password:ro" --entrypoint node srvf-staging-tools:108feebb /trial/reads.cjs
