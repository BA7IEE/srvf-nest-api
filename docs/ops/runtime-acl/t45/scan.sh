set -eu
cd /private/tmp/srvf-t45
r=$(cat remote)
id=$(cat activity)
case "$1" in check-in|check-out) ;; *) exit 64;; esac
scp -q -o BatchMode=yes -o StrictHostKeyChecking=yes scan.cjs /private/tmp/srvf-t43/mobile/node_modules/jsqr/dist/jsQR.js "srvf:$r/browser/"
ssh -o StrictHostKeyChecking=yes -o BatchMode=yes srvf "cd '$r' && n=\$(cat name) && test \"\$(docker network inspect -f '{{.Internal}}' \"\$n\")\" = true && docker run --rm --network container:\$n-web --shm-size=256m -e NODE_PATH=/trial-deps -e CHROMIUM_EXECUTABLE=/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell -e PUNCH_ACTION='$1' -e ACTIVITY_ID='$id' -v /usr/bin/node:/usr/local/bin/node:ro -v '$r/browser:/trial:ro' -v '$r/password:/fixture/password:ro' -v '$r/ordinary:/ordinary:ro' -v /var/tmp/srvf-t36.aCjuBCxk/browser/playwright-core:/trial-deps/playwright-core:ro srvf-test-playwright-official:1.64.1-amd64 node /trial/scan.cjs"
