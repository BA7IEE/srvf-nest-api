#!/bin/sh
# Run on srvf. This check only compares bytes and reads runtime/image identity.
set -eu
trial=/var/tmp/srvf-t38.AtEsQ0kX
candidate=srvf-dp-acceptance-runtime-api-1
panel=1Panel-openresty-grND
conf=/opt/1panel/www/conf.d/dp.srvf.team.conf
oldweb=/opt/1panel/www/sites/dp.srvf.team/releases/b7f3dac00a860e32c0cbc220f29da0755bce024b/webroot
oldapi=sha256:1eb4e3ca321b141bca0c9c032e919f8665179f843dc623349fcd765ee6c89ffb
api=sha256:826cd1241eef6e31d3925d4af80b2d1b6830c687d2cc37b67c1123fb9a433f75
rev(){ docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1"; }
sum(){ sha256sum "$1" | cut -d ' ' -f 1; }
test "$(hostname)" = VM-0-17-ubuntu
test "$(sum "$conf")" = 86cacf43aefd1dab3fefc67d25ea81d6f81f700a43d81c34d26ee6bb13f958fc
test "$(stat -c '%a' "$trial/pre-t38-dp.conf")" = 600
cmp -s "$conf" "$trial/pre-t38-dp.conf"
test "$(docker inspect -f '{{.Image}}' "$candidate")" = "$oldapi"
test "$(rev "$oldapi")" = 108feebb84b85c7e4955c5af8bbfc016702e4529
test "$(rev "$api")" = 713d3416830d897852929731ff7f9b638038ab7c
test "$(sum "$oldweb/index.html")" = ae73cbd7964b002e705a9ce22c882fd2e5ec5a7f689ab510d21961b9ea3a1253
test "$(sum "$oldweb/static/js/index-B9y9s-Nz.js")" = 28cd1e9ad7eb6c5ae7dc28d3c364b8f61671729c503ee8bfa228b3c5dc8b86fd
test "$(sum "$trial/release.sha256")" = c8fd30a91ef5e37032afb47ceb188bf6b75c203bd37de894c07b4f82571cbb2d
test "$(sum "$trial/final-web/index.html")" = 2625b6268ba53103ca78a943a70aace4398d86edbe7985cc4a3ecc2de232712d
(cd "$trial/final-web" && sha256sum --quiet -c ../release.sha256)
upstream=$(awk '$1=="proxy_pass" { print $2 }' "$conf" | sort -u)
test "$(awk '$1=="proxy_pass"{n++}END{print n+0}' "$conf")" -eq 4
addresses=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}' "$candidate")
matched=false
for address in $addresses; do
    if test "$upstream" = "http://$address:3000;"; then matched=true; fi
done
test "$matched" = true
docker exec "$panel" /usr/local/openresty/bin/openresty -t
printf '%s\n' "Current candidate and all four upstreams verified; rollback config matches byte-for-byte." "Retained image and complete new static manifest verified."
