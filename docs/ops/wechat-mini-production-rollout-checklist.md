# SRVF API — 微信小程序登录真实通道上线运维清单

> **状态**:系统侧已全部就位("正确但休眠",2026-06-12 goal P1-8 T1-T3 落地;冻结评审稿
> [`wechat-mini-login-review.md`](../archive/reviews/wechat-mini-login-review.md));
> 真实可用只差本清单的运维侧动作 + 小程序前端(后者不在本清单范围)。
> 镜像 [`cos-production-rollout-checklist.md`](./cos-production-rollout-checklist.md) /
> [`sms-production-rollout-checklist.md`](./sms-production-rollout-checklist.md) 范式。

---

## 0. 用法说明

### 0.1 谁在读

- **运维 / 维护者**:§2-§5 逐步执行(注册小程序 → 拿凭证 → admin API 录入 → 验收)
- **部署侧**:§1.1 确认系统侧前置已就位(env / migration / seed)

### 0.2 怎么读

按顺序执行,每节末尾有「✅ 完成判据」;全部判据满足 = 微信登录真实可用。
**安全红线**:AppSecret 是 L3 凭证——只经 §4 的 admin API 录入(AES-256-GCM 加密落库,永不回显);
**禁止**写进 .env / 配置文件 / 聊天记录 / 工单。

---

## 1. 前置门槛

### 1.1 系统侧已就位(必读,部署侧确认)

- [ ] 版本 ≥ 含微信 goal 的 release(migration `20260612091522_add_wechat_mini_login_infra` 已 deploy;`prisma migrate status` 无 pending)
- [ ] seed 已跑(权限码 121,含 `wechat-setting.*` 3 条 + `user.wechat.clear`)
- [ ] 生产 env 已注入 `WECHAT_ENCRYPTION_KEY`(≥32 字符,推荐 `openssl rand -base64 32`;**与 STORAGE/SMS 两把 key 不同值**;缺失时 production 启动 fail-fast,这是预期保护)
- [ ] 可选 env:`LOGIN_WECHAT_THROTTLE_LIMIT` / `_TTL_SECONDS`(留空默认 IP 5 次/60 秒)

### 1.2 运维侧准备

- [ ] 一个可管理微信小程序的微信账号(企业主体优先;个人主体亦可登录但能力受限)
- [ ] SUPER_ADMIN 账号(§4 录凭证仅 SUPER_ADMIN 可调)

---

## 2. 注册微信小程序

1. 访问 <https://mp.weixin.qq.com> → 立即注册 → 小程序;按主体类型完成认证
2. 登录小程序后台 → 「开发」→「开发管理」→「开发设置」:
   - 记录 **AppID(小程序 ID)**(形如 `wx` 开头 18 位;非 secret,可明文传递)
   - 生成 / 重置 **AppSecret(小程序密钥)**(**L3:只在生成当下复制一次,直接进入 §4 录入,不落任何中间介质**)
3. 「开发设置」→「服务器域名」:本功能服务端只**出站**调用 `api.weixin.qq.com`,无需配置业务域名即可跑通登录;小程序前端上线时再按前端需要配置 request 合法域名(指向本 API 的公网域名)

**✅ 完成判据**:拿到 AppID;AppSecret 已生成且仅存在于剪贴板/即将录入的窗口期。

---

## 3. (推荐)先用 DevStub 验全链

> 生产禁 DEV_STUB(写入与运行时双重校验),本节在 **staging / 本地** 做,验证系统侧链路无关真实凭证。

1. staging:`PATCH /api/system/v1/wechat-settings` `{"providerType":"DEV_STUB","enabled":true}`(ops-admin 可调)
2. `POST /api/auth/v1/login-wechat` `{"code":"任意串"}` → 应返 `{bindingRequired:true, session:null}`
3. 走绑定:`POST /api/auth/v1/wechat-bind/send-code` `{phone:"<已绑手机的队员号>"}` →(DevStub 短信固定码 888888)→ `POST /api/auth/v1/wechat-bind` `{code:"任意串", phone, smsCode:"888888"}` → 应返 JWT
4. 复跑第 2 步同一 code → 应返 `bindingRequired:false` + session

**✅ 完成判据**:上述 4 步全通(等价于 CI e2e `auth-wechat` 组覆盖面)。

---

## 4. admin API 录入凭证(维护者 / SUPER_ADMIN)

> 顺序:先录 AppID(PATCH,ops-admin 可),再录 AppSecret(reset-credentials,**仅 SUPER_ADMIN**)。

1. `PATCH /api/system/v1/wechat-settings`

   ```json
   { "providerType": "WECHAT", "enabled": true, "appId": "wx****************", "remarks": "生产小程序 <名称>" }
   ```

2. `POST /api/system/v1/wechat-settings/reset-credentials`

   ```json
   { "appSecret": "<§2 复制的密钥>" }
   ```

   - 期待响应:`credentialStatus: "configured"`,且响应**不含** appSecret 任何形态(L3 红线;含明文即重大故障,立即上报)
3. `GET /api/system/v1/wechat-settings` 复核:`providerType=WECHAT / enabled=true / appId 正确 / credentialStatus=configured`
4. 录入后在小程序后台**不再**重置 AppSecret(重置会使已录密钥失效 → `credentialStatus` 仍 configured 但 code2session 返 40125 → 接口 25031;需重走本节)

**✅ 完成判据**:GET 复核三字段正确;`credentialStatus=configured`。

---

## 5. 真实发送验收(需小程序前端或开发者工具)

> 真实 `wx.login()` code 只能产自该 AppID 的小程序运行时——用微信开发者工具(导入该 AppID 的任意空白工程)即可拿到真 code,不必等正式前端。

1. 开发者工具 console:`wx.login({ success: r => console.log(r.code) })` 取 code(5 分钟内用掉)
2. `POST /api/auth/v1/login-wechat` `{code}` → 期待 `{bindingRequired:true}`(该微信尚未绑定)
3. 走绑定三步(同 §3 步 3,smsCode 用真实短信或 staging DevStub 策略按当前 SMS 通道状态)→ 期待 JWT
4. 重新 `wx.login()` 取新 code → `login-wechat` → 期待 `bindingRequired:false` + session;用 accessToken 调 `GET /api/app/v1/me/wechat` → `bound:true` + openid 掩码
5. 验收负向:同一 code 重放 `login-wechat` → 25010(微信 40163 code 已使用)

**✅ 完成判据**:2-5 全通 → 微信登录真实通道上线完成。

---

## 6. 排错速查

| 现象 | 码 | 排查 |
|---|---|---|
| 微信登录服务未配置或未启用 | 25030 | settings 行缺失 / enabled=false / appId 空 / credentialStatus≠configured;production 配 DEV_STUB 也落此 |
| 微信登录凭证无效或已过期 | 25010 | code 过期(5 分钟)/ 已使用(40163)/ 伪造(40029);**绑定的账号被禁用或软删也统一本码**(防侧写,先查目标账号状态) |
| 微信服务调用失败 | 25031 | 看服务端 warn 日志 errcode:40013=AppID 错 / 40125=AppSecret 错(§4 步 4)/ -1=微信系统繁忙重试 / FETCH_ERROR·TimeoutError=出网不通(检查服务器出站 443 到 api.weixin.qq.com) |
| 该微信已绑定其他账号 | 25002 | openid 已被占用(含软删账号占用);**活跃持有者**:先 `DELETE /api/admin/v1/users/:id/wechat` 清除原绑定;**软删持有者:该端点返 404(USER_NOT_FOUND),需 DB 介入,见表下注** |
| 验证码错误或已失效 | 24010 | 绑定锚点短信侧:号码无效(四场景统一)/ 码错/过期/超次;沿 SMS 排错(sms checklist §7) |
| 请求过于频繁 | 42900 | 第 8 throttler `login-wechat` IP 5/60 命中;正常重试间隔即可 |

> **软删占用的 DB 介入步骤**(2026-06-12 增量审计⑦:`clearUserWechat` 镜像 phone 沿 §7.8,经 `notDeletedWhere` 查目标——软删持有者对该 API 不可见也不可清;且 openid 全链掩码,无法经任何 API 反查持有账号):
>
> ```sql
> -- 1. 定位软删且仍占用 openid 的行(典型场景:队员旧账号软删后,换新账号重绑撞 25002)
> SELECT id, username, phone, "deletedAt" FROM "User" WHERE openid IS NOT NULL AND "deletedAt" IS NOT NULL;
> -- 2. 结合队员身份人工确认后释放占用(沿 security.md 软删恢复同级 DB 手术纪律;操作记入变更记录)
> UPDATE "User" SET openid = NULL WHERE id = '<上一步确认的 id>';
> ```
>
> 释放后队员重走绑定流程即可。本注记是运维出路成文,**不**改变 E-19「openid 占用含软删、不复用」语义,也不引入 restore / 软删自动清绑。

安全提醒:服务端日志**永不**含 AppSecret / session_key / wx code / 完整 openid;若在任何日志看到这四者之一,按安全事件处理并上报。
