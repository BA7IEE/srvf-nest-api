#!/bin/sh
set -eu
static=/var/tmp/srvf-t41.a8QKt5qN/final-static
expected=9f44857d0e930bf2cda08703f31c9a2c1a57a6c66e8659c2aabf171fc1b10d1b
expected_image=sha256:826cd1241eef6e31d3925d4af80b2d1b6830c687d2cc37b67c1123fb9a433f75
test "$(hostname)" = VM-0-17-ubuntu
test "$(sha256sum "$static.manifest" | cut -d' ' -f1)" = "$expected"
(cd "$static" && sha256sum --quiet -c ../final-static.manifest)
revision=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$expected_image")
test "$revision" = 713d3416830d897852929731ff7f9b638038ab7c
echo "verified manifest=$expected api=$expected_image revision=$revision"
