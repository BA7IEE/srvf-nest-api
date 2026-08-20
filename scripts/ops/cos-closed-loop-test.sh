#!/usr/bin/env bash
# COS 闭环测试 —— 证明「这套系统能用 COS」,不是「COS 能用」。
#
# 走的是应用的真实上传链路(模式 B:签名直传),不是拿 COS SDK 直接传 ——
# 后者只能证明桶和密钥没问题,证明不了应用这条链通。
#
# 用法:  ./cos-closed-loop-test.sh https://your-domain  <super-admin-username>
# 密码从 stdin 读,不走命令行参数(避免进 shell history / ps)。
set -euo pipefail

BASE="${1:?用法: $0 <base-url> <username>}"
USERNAME="${2:?用法: $0 <base-url> <username>}"

# mapfile 需要 bash 4+;macOS 自带 bash 3.2 会静默少读 header 导致 COS 403
[ "${BASH_VERSINFO[0]:-0}" -ge 4 ] || { echo "需要 bash 4+(当前 ${BASH_VERSION});在服务器上跑,别在 macOS 自带 bash 跑"; exit 1; }
command -v jq   >/dev/null || { echo "需要 jq";   exit 1; }
command -v curl >/dev/null || { echo "需要 curl"; exit 1; }

read -rsp "SUPER_ADMIN 密码: " PASSWORD; echo

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
ok(){   printf '  ✅ %s\n' "$1"; PASS=$((PASS+1)); }
bad(){  printf '  ❌ %s\n' "$1"; FAIL=$((FAIL+1)); }
die(){  printf '\n💥 %s\n' "$1"; exit 1; }

# 测试用 1x1 PNG(真实合法 PNG,能过服务端 magic-byte 签名校验)
base64 -d > "$WORK/probe.png" <<'B64'
iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==
B64
SIZE=$(wc -c < "$WORK/probe.png" | tr -d ' ')
echo "探针文件: ${SIZE} 字节"

echo; echo "── 0. 登录 ──"
LOGIN=$(curl -sS -X POST "$BASE/api/auth/v1/login" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg u "$USERNAME" --arg p "$PASSWORD" '{username:$u,password:$p}')")
unset PASSWORD
TOKEN=$(echo "$LOGIN" | jq -r '.data.accessToken // empty')
[ -n "$TOKEN" ] || die "登录失败:$(echo "$LOGIN" | jq -c '{code,message}')"
ok "登录成功(token 不回显)"
AUTH=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')

echo; echo "── 1. 建一条测试内容(附件需要真实 owner)──"
CONTENT=$(curl -sS -X POST "$BASE/api/admin/v1/contents" "${AUTH[@]}" \
  -d '{"title":"[COS闭环测试] 可删除","body":"自动化探针产生,测完自动删除。","contentTypeCode":"announcement","visibilityCode":"management"}')
CONTENT_ID=$(echo "$CONTENT" | jq -r '.data.id // empty')
[ -n "$CONTENT_ID" ] || die "建内容失败:$(echo "$CONTENT" | jq -c '{code,message}')"
ok "内容已建 id=$CONTENT_ID"

cleanup_content(){ curl -sS -X DELETE "$BASE/api/admin/v1/contents/$CONTENT_ID" "${AUTH[@]}" >/dev/null 2>&1 || true; }
trap 'cleanup_content; rm -rf "$WORK"' EXIT

echo; echo "── 2. 申请签名上传 URL ──"
UP=$(curl -sS -X POST "$BASE/api/admin/v1/attachments/upload-url" "${AUTH[@]}" \
  -d "$(jq -nc --arg oid "$CONTENT_ID" --argjson sz "$SIZE" \
        '{ownerType:"content-image",ownerId:$oid,originalName:"probe.png",mime:"image/png",sizeBytes:$sz}')")
UPLOAD_URL=$(echo "$UP" | jq -r '.data.uploadUrl // empty')
UPLOAD_TOKEN=$(echo "$UP" | jq -r '.data.uploadToken // empty')
UPLOAD_METHOD=$(echo "$UP" | jq -r '.data.uploadMethod // "PUT"')
OBJ_KEY=$(echo "$UP" | jq -r '.data.key // empty')
[ -n "$UPLOAD_URL" ] && [ -n "$UPLOAD_TOKEN" ] || die "签 URL 失败:$(echo "$UP" | jq -c '{code,message}')"
ok "已签发 upload URL(key=${OBJ_KEY})"
echo "     ⇒ 签名用到了 COS 凭据 —— 签得出来说明凭据可解密且地域/桶名格式正确。"

# uploadHeaders 必须原样带上 —— COS 签名对 header 敏感,漏了会 403
mapfile -t HDRS < <(echo "$UP" | jq -r '.data.uploadHeaders // {} | to_entries[] | "-H\n\(.key): \(.value)"')

echo; echo "── 3. 【COS PUT】直传对象 ──"
PUT_CODE=$(curl -sS -o "$WORK/put.out" -w '%{http_code}' -X "$UPLOAD_METHOD" \
  "${HDRS[@]}" --data-binary "@$WORK/probe.png" "$UPLOAD_URL")
case "$PUT_CODE" in
  200|201|204) ok "COS 直传返回 $PUT_CODE —— 对象已真实写入腾讯云" ;;
  *) bad "COS 直传返回 $PUT_CODE"; head -c 400 "$WORK/put.out"; die "PUT 失败,后续无意义" ;;
esac

echo; echo "── 4. 【COS HEAD】确认上传(服务端回查对象)──"
CONF=$(curl -sS -X POST "$BASE/api/admin/v1/attachments/confirm-upload" "${AUTH[@]}" \
  -d "$(jq -nc --arg t "$UPLOAD_TOKEN" '{uploadToken:$t}')")
ATT_ID=$(echo "$CONF" | jq -r '.data.id // empty')
[ -n "$ATT_ID" ] || die "confirm 失败:$(echo "$CONF" | jq -c '{code,message}')"
ok "confirm 通过 id=$ATT_ID"
echo "     ⇒ 服务端对 COS 做了 HEAD 并校验 size + 文件签名。"
echo "       对象若不在云端、大小对不上或不是真 PNG,这一步就会红。"

echo; echo "── 5. 【COS GET】取签名短链并下载回来比对字节 ──"
DETAIL=$(curl -sS "$BASE/api/admin/v1/contents/$CONTENT_ID" "${AUTH[@]}")
DL=$(echo "$DETAIL" | jq -r --arg id "$ATT_ID" '.data.attachments[]? | select(.id==$id) | .url // empty')
[ -n "$DL" ] && [ "$DL" != "null" ] || die "详情里没拿到签名短链:$(echo "$DETAIL" | jq -c '.data.attachments')"
ok "已取得签名下载短链"
DL_CODE=$(curl -sS -o "$WORK/back.png" -w '%{http_code}' "$DL")
[ "$DL_CODE" = "200" ] || { bad "下载返回 $DL_CODE"; die "下载失败"; }
if cmp -s "$WORK/probe.png" "$WORK/back.png"; then
  ok "下载字节与上传**完全一致**($(wc -c < "$WORK/back.png" | tr -d ' ') 字节)—— 读写闭环成立"
else
  bad "下载回来的字节与上传的不一致 —— 内容被改写或取到了别的对象"
fi

echo; echo "── 6. 【COS DELETE】删除并证明真的没了 ──"
DEL_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/admin/v1/attachments/$ATT_ID" "${AUTH[@]}")
case "$DEL_CODE" in 200|204) ok "删除接口返回 $DEL_CODE" ;; *) bad "删除返回 $DEL_CODE" ;; esac

sleep 2
GONE=$(curl -sS -o /dev/null -w '%{http_code}' "$DL" || echo 000)
if [ "$GONE" = "200" ]; then
  bad "删除后旧短链仍能取到对象(HTTP 200)—— 对象未真正从 COS 删除"
else
  ok "删除后旧短链返回 $GONE —— 对象确已从 COS 移除"
fi

echo; echo "════════ 结果 ════════"
printf '  通过 %d 项 · 失败 %d 项\n' "$PASS" "$FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo "  ✅ COS 闭环成立:PUT / HEAD / signed GET(含字节比对)/ DELETE 四个动作全部真实发生。"
  exit 0
else
  echo "  ❌ 闭环未成立 —— 不得声称「对象存储真实可用」。"
  exit 1
fi
