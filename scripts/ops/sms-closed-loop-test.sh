#!/usr/bin/env bash
# 短信闭环测试 —— 证明「这套系统能用腾讯云短信」。
#
# 与 COS 那支不同,短信**无法全自动** —— 验证码要真手机收。
# 所以是半自动:脚本发起 → 你读手机输码 → 脚本验证并核对发送留痕。
#
# 用法:  ./sms-closed-loop-test.sh https://your-domain <super-admin-username> [手机号]
#
# 🔴 手机号不写进脚本、不进仓库 —— 仓库红线 A-9(R13):
#    真实成员 PII(姓名 / 身份证号 / 手机号)不进 git history。
#    不给第三个参数时会提示你输入。
set -euo pipefail

BASE="${1:?用法: $0 <base-url> <username> [phone]}"
USERNAME="${2:?用法: $0 <base-url> <username> [phone]}"
PHONE="${3:-}"

[ "${BASH_VERSINFO[0]:-0}" -ge 4 ] || { echo "需要 bash 4+(当前 ${BASH_VERSION})"; exit 1; }
command -v jq   >/dev/null || { echo "需要 jq";   exit 1; }
command -v curl >/dev/null || { echo "需要 curl"; exit 1; }

if [ -z "$PHONE" ]; then read -rp "接收短信的手机号(11 位): " PHONE; fi
[[ "$PHONE" =~ ^1[3-9][0-9]{9}$ ]] || { echo "手机号格式不对(需 11 位大陆号码)"; exit 1; }
MASKED="${PHONE:0:3}****${PHONE:7:4}"

read -rsp "SUPER_ADMIN 密码: " PASSWORD; echo

PASS=0; FAIL=0
ok(){  printf '  ✅ %s\n' "$1"; PASS=$((PASS+1)); }
bad(){ printf '  ❌ %s\n' "$1"; FAIL=$((FAIL+1)); }
die(){ printf '\n💥 %s\n' "$1"; exit 1; }

echo; echo "目标手机号:$MASKED(全程只显示掩码)"

echo; echo "── 0. 登录 ──"
LOGIN=$(curl -sS -X POST "$BASE/api/auth/v1/login" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg u "$USERNAME" --arg p "$PASSWORD" '{username:$u,password:$p}')")
TOKEN=$(echo "$LOGIN" | jq -r '.data.accessToken // empty')
[ -n "$TOKEN" ] || die "登录失败:$(echo "$LOGIN" | jq -c '{code,message}')"
ok "登录成功"
AUTH=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')

echo; echo "── 1. 先看通道配好了没(不发短信,纯读)──"
SET=$(curl -sS "$BASE/api/system/v1/sms-settings" "${AUTH[@]}")
PT=$(echo "$SET"  | jq -r '.data.providerType // "—"')
EN=$(echo "$SET"  | jq -r '.data.enabled // false')
CS=$(echo "$SET"  | jq -r '.data.credentialStatus // "—"')
TV=$(echo "$SET"  | jq -r '.data.templateIdVerifyCode // "—"')
TN=$(echo "$SET"  | jq -r '.data.templateIdNotification // "—"')
printf '     providerType=%s  enabled=%s  credentialStatus=%s\n' "$PT" "$EN" "$CS"
printf '     templateIdVerifyCode=%s  templateIdNotification=%s\n' "$TV" "$TN"
[ "$PT" = "TENCENT_SMS" ] && ok "providerType=TENCENT_SMS" || bad "providerType=$PT(应为 TENCENT_SMS;DEV_STUB 在 production 被禁)"
[ "$EN" = "true" ]        && ok "enabled=true"             || bad "enabled=$EN"
[ "$CS" = "CONFIGURED" ]  && ok "凭据已配置"                 || bad "credentialStatus=$CS"
[ "$TV" != "—" ] && [ "$TV" != "null" ] && ok "验证码模板已录入" || bad "templateIdVerifyCode 未录入 —— 后续必失败"
[ "$TN" != "—" ] && [ "$TN" != "null" ] && ok "通知模板已录入"   || bad "templateIdNotification 未录入(紧急召集兜底不可用)"
[ "$FAIL" -eq 0 ] || die "通道未配好,先按 docs/ops/sms-production-rollout-checklist.md §5 录入"

echo; echo "── 2. 身份加强验证(绑手机要求 step-up)──"
SU=$(curl -sS -X POST "$BASE/api/auth/v1/step-up/password" "${AUTH[@]}" \
  -d "$(jq -nc --arg p "$PASSWORD" '{action:"PHONE_BIND",password:$p}')")
unset PASSWORD
STEPUP=$(echo "$SU" | jq -r '.data.stepUpToken // empty')
[ -n "$STEPUP" ] || die "step-up 失败:$(echo "$SU" | jq -c '{code,message}')"
ok "step-up 通过(5 分钟有效,下面要在这个窗口内做完)"

echo; echo "── 3. 【真发短信】向 $MASKED 发验证码 ──"
SEND=$(curl -sS -X POST "$BASE/api/app/v1/me/phone/send-code" "${AUTH[@]}" \
  -d "$(jq -nc --arg ph "$PHONE" '{phone:$ph}')")
SCODE=$(echo "$SEND" | jq -r '.code // -1')
if [ "$SCODE" = "0" ]; then
  ok "发送指令已受理(有效期 $(echo "$SEND" | jq -r '.data.expiresInSeconds // "?"') 秒)"
else
  bad "发送被拒:$(echo "$SEND" | jq -c '{code,message}')"
  echo "     24030=通道未配置 · 24031=腾讯云拒发(签名/模板/权限)· 24120/24121=防刷"
  die "发送失败,后续无意义"
fi

echo; echo "── 4. 你的手机应该收到短信了 ──"
read -rp "  输入收到的验证码(收不到就直接回车,我帮你查留痕定位): " CODE

if [ -n "$CODE" ]; then
  echo; echo "── 5. 验证码回验(证明这条码真能用)──"
  BIND=$(curl -sS -X PUT "$BASE/api/app/v1/me/phone" "${AUTH[@]}" \
    -d "$(jq -nc --arg ph "$PHONE" --arg c "$CODE" --arg t "$STEPUP" \
          '{phone:$ph,code:$c,stepUpToken:$t}')")
  BCODE=$(echo "$BIND" | jq -r '.code // -1')
  if [ "$BCODE" = "0" ]; then
    ok "验证码校验通过,手机号已绑定到该账号"
    echo "     ⇒ 发码→收码→回验 整条链闭合"
  else
    bad "回验失败:$(echo "$BIND" | jq -c '{code,message}')"
  fi
else
  bad "没收到短信 —— 见下方留痕,判断是「没发出去」还是「发了但没到」"
fi

echo; echo "── 6. 发送留痕(不管收没收到都要看)──"
LOGS=$(curl -sS "$BASE/api/system/v1/sms-send-logs?page=1&pageSize=5" "${AUTH[@]}")
echo "$LOGS" | jq -r '.data.items[]? | "     \(.createdAt // "?")  \(.templateKey // "?")  \(.status // "?")  msgId=\(.providerMsgId // "—")  \(.phoneMasked // .phone // "?")  \(.errCode // "")"' 2>/dev/null | head -5
TOP=$(echo "$LOGS" | jq -r '.data.items[0].status // "—"')
MSGID=$(echo "$LOGS" | jq -r '.data.items[0].providerMsgId // ""')
[ "$TOP" = "SENT" ] && ok "最新一条 status=SENT" || bad "最新一条 status=$TOP"
[ -n "$MSGID" ] && [ "$MSGID" != "null" ] && ok "providerMsgId 非空(腾讯云确实受理了)" || bad "providerMsgId 为空 —— 请求没到腾讯云"
echo "$LOGS" | jq -e '.data.items[0] | (.phoneMasked // .phone) | test("\\*")' >/dev/null 2>&1 \
  && ok "留痕里手机号是掩码(未明文落库)" || bad "⚠️ 留痕里手机号疑似明文 —— 停下取证"

echo; echo "════════ 结果 ════════"
printf '  通过 %d 项 · 失败 %d 项\n' "$PASS" "$FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo "  ✅ 验证码链路闭合:配置 → 发送 → 腾讯云受理 → 真机收到 → 回验通过 → 留痕正确。"
  echo
  echo "  ⏭  还差一条:**通知模板(紧急召集兜底)** 未在本脚本覆盖 ——"
  echo "     它要真发一条紧急召集才算验过。见 sms-production-rollout-checklist.md 验收第 4 条,"
  echo "     那条明确写了「不能靠等它自己触发」。"
  exit 0
else
  echo "  ❌ 未闭合 —— 不得声称「短信通道真实可用」。"
  exit 1
fi
