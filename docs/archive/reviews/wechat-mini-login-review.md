# SRVF 微信小程序登录基础设施评审稿(WeChat Mini-Program Login Review)

> **冻结时间**:2026-06-12(T0;goal「微信小程序登录基础设施」)。
> **性质**:本稿是该 goal 的 D 档评审稿(process §4 ⑤),合入后**不回改**;实施(T1-T4)与本稿漂移时,停下重审而非顺手改稿。
> **立项凭据**:维护者 2026-06-12 goal 文本(立项 + 拍板,process §7.1);§9 升级路径解锁记录见本稿 §13。
> **范式声明**:本功能**全程镜像已建的 SMS/手机号基础设施**(冻结评审稿 [`sms-verification-infra-review.md`](./sms-verification-infra-review.md) / [`password-reset-by-sms-review.md`](./password-reset-by-sms-review.md) / [`queue-b-otp-birthday-infra-review.md`](./queue-b-otp-birthday-infra-review.md));本稿只展开镜像映射与**差异点**,不重述被镜像范式的完整论证。

---

## 0. TL;DR

- **做什么**:微信小程序 openid 绑定 + 登录的后端全链:`wechat_settings` 凭证单例表(AES-256-GCM)+ `src/modules/wechat/` 通道层(DevStub / 真实 `code2session` 双 Provider)+ `auth/v1` 三个 pre-auth 公开端点(登录 / 绑定发码 / 绑定)+ `app/v1/me/wechat` 查询与换绑 + `admin/v1` 清除。
- **绑定锚点 = 手机短信**(拍板①):队员先持有已绑手机号的账号,凭 `WECHAT_BIND` 用途短信验证码把 openid 绑到该账号;复用 `SmsCodeService` 零改动。
- **"正确但休眠"**:DevStub 跑通全链 e2e;真实可用还差 ① 注册小程序拿 AppID/AppSecret(运维)② 小程序前端。二者列入本期不做(§12)。
- **安全核心**:appSecret L3 加密永不回显;session_key 不存储即弃;openid 非 L3 但**不滥回显**(响应/audit 一律掩码,不入 pino 日志/snapshot 示例);防枚举沿 login-sms 范式(泛化 200 + 统一错误码);会话签发走 `AuthService.createSession` 单一代码路径,密码登录契约零变化。

---

## 1. 决策汇总表

### 1.1 维护者拍板项(2026-06-12,goal 原文为凭据)

| # | 决策 | 内容 |
|---|---|---|
| D-W1 | **绑定锚点 = 手机短信** | 首次绑定(pre-auth)必须验「手机号 + SMS 验证码」证明账号归属,复用 `SmsCodeService`(新增 `SmsPurpose.WECHAT_BIND`);**不**采用微信手机号快捷授权(getPhoneNumber)作锚点 |
| D-W2 | **字段 = openid only** | `User +openid String? @unique` 一个字段;**不**存 unionid / session_key / 绑定时间戳(最小字段集) |
| D-W3 | **解绑 = 镜像手机** | 解除绑定唯一路径 = admin 清除(`DELETE admin/v1/users/:id/wechat`,幂等);**无本人裸解绑**;已登录换绑(`PUT me/wechat`)无需再验手机(JWT 已证身份) |
| D-W4 | **范围 = 完整** | pre-auth 登录 + 首绑全链 + authed 查询/换绑 + admin 清除 + 凭证设置三端点一次建全(非最小试点) |
| D-W5 | **§9 解锁** | ARCHITECTURE §9「第一个小程序产品要接」触发条件满足(队员近期要用微信小程序),解锁微信登录;本 goal 即评审授权(详见 §13) |
| D-W6 | **D 档已拍板项** | migration / 新权限码 seed / docker-smoke env 一行 / 4 audit 事件 / `WECHAT_ENCRYPTION_KEY`(goal §2 原文) |

### 1.2 工程细节代决项(本稿固化;实施不得再漂移)

| # | 决定 | 镜像源 / 差异说明 |
|---|---|---|
| E-1 | 模块位置 `src/modules/wechat/`,`providers/` 子目录例外解锁(仅限本模块本子目录) | 镜像 `sms/` / `storage/` 形态;AGENTS §2 例外记录见 §5 |
| E-2 | `code2session` 走**原生 fetch + AbortController 8s 超时**,零新依赖 | 差异:SMS 用腾讯云 SDK;微信端点是单一 HTTPS GET,不引 SDK(沿 #346 外部请求 8s 上限先例) |
| E-3 | `WechatSettings` 单例表镜像 `SmsSettings`:providerType(`DEV_STUB\|WECHAT`)/ enabled / appId(明文,非 secret,镜像 sdkAppId 地位)/ appSecretEncrypted / credentialConfigured / remarks / updatedBy;singleton 不在 DB 层强制(>1 行 WARN 取最早) | 差异:凭证仅 **appSecret 一段**加密(SMS 是 secretId+secretKey 两段) |
| E-4 | `WechatCryptoService` 逐行镜像 `sms-crypto.service`:AES-256-GCM + scrypt 派生 + **独立 salt** `srvf-wechat-key-derivation-salt-v1`(三把 env key 即使误配同值密文互不可解);刻意不抽公共基类 | 镜像 sms-crypto(其与 storage-crypto 的关系声明同样适用) |
| E-5 | `WECHAT_ENCRYPTION_KEY` 独立 env:production/smoke 启动 fail-fast,≥32 字符,dev/test 留空允许(crypto 不可用);`.env.example` + docker-smoke 各加一行 | 镜像 `SMS_ENCRYPTION_KEY`(D-SMS-8) |
| E-6 | wechat-settings 三端点(GET / PATCH / POST reset-credentials)镜像 sms-settings:PATCH upsert 缺省 DEV_STUB + production-like 拒 DEV_STUB(写入口第①重);reset-credentials upsert 缺省 WECHAT(录凭证=真实通道)、**仅 SUPER_ADMIN 短路**(码不绑 ops-admin);响应永不含 appSecret 明文/密文;credentialStatus 三态合成(configured/missing/invalid) | 镜像 sms-settings E-13/E-14/E-15 |
| E-7 | `WechatSettings` 变更**不写 audit_logs**(pino 仅记动作 + actorUserId) | 沿 L-3 挂起(D-SMS-9 同款) |
| E-8 | **无 send-logs 对应物**:code2session 是免费查询类 API,无资费无触达,不建日志表、不留流水 | 显式差异:SMS 因真实资费建 `sms_send_logs`;微信无此需求 |
| E-9 | **不设独立 provider router 文件**:`WechatService` 内联 resolve(settings → provider;缺失/未启用/凭证未配/appId 缺失/production-like DEV_STUB → `WechatChannelUnavailableError`,**不静默 fallback**) | 差异:SMS 单独 `sms-provider.router.ts` 因多方法多调用方;微信仅 `code2session` 一个方法,独立 router 是仪式感(差异显式登记) |
| E-10 | DevStub:非 production-like 按 code 返**确定性假 openid** `dev-openid-${code}`;不调外部、不模拟失败/延迟;production-like 写入口 + 运行时**双重禁用** | 镜像 DEV_STUB 固定码 888888 范式(E-15/E-29 同款双重校验);确定性映射让 e2e 可造多个"微信用户" |
| E-11 | 真实 Provider errcode 映射:`40029`(invalid js_code)/ `40163`(code been used)→ `WechatCodeInvalidError` → 25010;其余非 0 errcode(含 -1 系统繁忙 / 40013 / 40125 / 45011)+ HTTP 非 200 + 超时 + 网络错误 + 响应缺 openid → `WechatApiError` → 25031;settings 层不可用 → 25030 | 镜像 SmsChannelUnavailable/SmsProviderSendError 双域错误 → BizCode 映射边界 |
| E-12 | **session_key 即弃**:code2session 响应解析后只取 openid,session_key / unionid 不入任何持久化、变量不外传、不入日志;**请求 URL 含 secret,禁止整 URL 入日志/错误信息** | L3 红线展开见 §6 / §8 |
| E-13 | `maskOpenid`:长度 ≤ 8 整体 `***`;否则前 4 + `****` + 后 4;放 `wechat.constants.ts`,响应(GET me/wechat)与 audit detail 的唯一掩码实现 | 镜像 `maskPhone`(E-21 同款防御:不泄露片段) |
| E-14 | 认证服务文件归属:auth 模块平铺新文件 `login-wechat.service.ts`(登录 + 绑定发码 + 绑定三方法);**不**进 auth.service.ts(P0-E 冻结,文件零 diff 最强证据)、不进 users.service.ts;`AuthModule` 新增 import `WechatModule` | 镜像 login-sms.service.ts / password-reset.service.ts 先例(E-O1/E-1) |
| E-15 | 会话签发:`AuthService.createSession` event union 扩展第三值 `'auth.login.wechat'`(**仅类型行 + 注释 diff,签发逻辑零改**);同 LoginResponseDto / 同 refresh family / lastLoginAt 同步 | 镜像 E-O6;行为锁 = auth 既有 e2e 断言零修改全绿 |
| E-16 | `login-wechat` 响应形态:单 DTO `WechatLoginResponseDto { bindingRequired: boolean; session: LoginResponseDto \| null }`——已绑 `{bindingRequired:false, session:{...}}`,未绑 `{bindingRequired:true, session:null}`(HTTP 均 200);未绑响应**不含** openid/ticket 任何服务端临时态,绑定时小程序重新 `wx.login()` 取新 code(无感) | 无既有镜像,本稿冻结;无状态设计,不引入服务端 pending-bind 缓存 |
| E-17 | 限流:**第 8 个独立 throttler 实例 `login-wechat`**(IP 5/60 默认,env `LOGIN_WECHAT_THROTTLE_LIMIT/_TTL_SECONDS`),三个 pre-auth 端点共用装饰器 `@LoginWechatThrottle()`(端点×IP 各自计数);`GET/PUT me/wechat` 与 admin 清除**不挂限流**(登录态 + wx code 单次有效天然限频,无可爆破 secret;沿"禁止顺手加限流"纪律) | 镜像 login-sms 第 7 实例 5/60(E-O3;登录场景较 password-reset 3/60 放宽一档的同款理由) |
| E-18 | `me/wechat` 两端点准入:沿 `me/phone` 账号级豁免先例(E-5)——**不**调 appIdentity/assertCanUseApp,admin 无 member 也可绑;豁免仅限这两个端点,禁止外溢 | 镜像 sms 评审稿 E-5 |
| E-19 | `User.openid @unique` **含软删占用**(沿 phone/username 不复用范式);占用预检 `findUnique`;P2002 兜底(target 数组含 `openid`)→ 25002 | 镜像 E-7 / §7.8 |
| E-20 | admin 清除:`rbac.can('user.wechat.clear')` + `assertCanManageUser` 既有护栏;软删用户统一 USER_NOT_FOUND;**幂等**(目标无 openid → 200 不报错,仅实际清除时写 audit) | 逐行镜像 `clearUserPhone`(E-19) |
| E-21 | BizCode 段位 **25xxx**(baseline §1.1 下一可用段,T0 亲核:24xxx 已被 sms 占用,`250xx-290xx` 未规划预留首段);开 4 码不开 2 类,清单见 §3.3;baseline §1.1 段位表加行随 T3 PR(红区,goal 唯一授权) | 镜像 24xxx 收口范式(E-25) |
| E-22 | 权限码 +4(`wechat-setting.read.singleton` / `.update.singleton` / `.reset.credentials` / `user.wechat.clear`),全部随 **T2** seed 落地(`user.wechat.clear` 端点 T3 实装,T2 期间孤码 rbacmap **WARN 预期非 FAIL**);ops-admin 绑 3(reset 不绑);117→121,ops-admin 58→61;RBAC_MAP 同 PR true-up | 镜像 SMS T2 +5 码先例(§3.4) |
| E-23 | audit 4 事件(union 31→35),命名沿 kebab-case 既有范式;openid 在 detail/extra **一律掩码**;禁明文 code / session_key / appSecret 任何形态;`wechat.bind.self` 双写入路径用 `extra.viaPath ∈ {'pre-auth','me'}` 区分(沿 registration.create viaPath 范式) | 清单见 §3.5 |
| E-24 | 绑定流程产生**两条 audit**(绑定事务内 `wechat.bind/rebind.self` + createSession 事务内 `auth.login.wechat`);两事务串行,"绑定已提交而签发失败"的窄窗口接受(客户端走 login-wechat 已绑路重登) | 沿 E-8"已消费但外层失败"同款接受理由 |
| E-25 | DTO 归属:auth 四个 DTO 进 `auth.dto.ts`(LoginWechatDto / WechatLoginResponseDto / SendWechatBindCodeDto / WechatBindDto);App 出参 `AppMeWechatDto { bound: boolean; openidMasked: string \| null }` 进 `users/dto/app/app-me-wechat.dto.ts`(App DTO 禁派生);wx code 校验 `@IsString @MinLength(1) @MaxLength(128)`(微信 code 为不透明短串);phone 沿 `MAINLAND_PHONE_PATTERN`;smsCode 沿既有 6 位码校验 | 镜像 app-me-phone.dto 范式 |
| E-26 | controller 层显式 safeDto 重组(禁透传 raw body),沿 §9.4 范式 | 镜像 app-me / auth controller 现状 |
| E-27 | `WechatSettings` 读取层 60s 进程内缓存 + 写后 invalidate(单实例部署前提,沿 deployment.md 横向扩容 checklist 既有第 6 处登记进 T4) | 镜像 sms-settings CACHE_TTL_MS |
| E-28 | e2e 对 25010/25031 不经 DevStub 覆盖(DevStub 不模拟失败),由 `wechat.provider.spec`(mock fetch)单测锁定 errcode 映射;25030 由 e2e 可达(settings 缺失/禁用) | 镜像"真实通道行为由 tencent-sms.provider.spec mock 覆盖"声明 |
| E-29 | `SmsCodeService` / sms 模块**文件零 diff**(`WECHAT_BIND` 是 enum 新值,经 purpose 参数透传) | 行为锁,见 §9 |
| E-30 | CODEMAP.md 模块行 +1(wechat,20→21)随 T2 PR true-up;wechat 模块**不**建模块级 CLAUDE.md(sms 同样没有,9 个存量名单不扩) | 沿 codemap check 守护 |

---

## 2. 风险表(D 档降速 ②)

| 项 | 结论 |
|---|---|
| 是否修改 `prisma/schema.prisma` | ✅ T1:User +openid / SmsPurpose +WECHAT_BIND / +WechatSettings +WechatProviderType |
| 是否新增 migration | ✅ T1 一个 migration(含 enum ADD VALUE;沿 #325 SmsPurpose+LOGIN 先例) |
| 是否修改 `prisma/seed.ts` | ✅ T2:权限码 +4 + ops-admin 绑定 +3(幂等 upsert 范式不变) |
| 是否影响现有数据 | ❌ 纯新增列(可空)+ 新表 + enum 新值;零回填零改写 |
| 是否不可逆 | enum value 增加在 PG 不可简单回收(沿 LOGIN 先例接受);其余可逆 |
| 是否影响 OpenAPI / contract snapshot | ✅ 仅新增 9 端点(T2 +3 → 162;T3 +6 → 168);diff 逐行可解释;零 L3 字段 |
| 是否影响鉴权 / Permission seed / 审计 | ✅ 全在授权清单内:第三认证端点 / +4 权限码 / +4 audit 事件;JwtPayload、refresh 语义、密码登录契约零变化 |
| 是否需要新增 BizCode | ✅ 25xxx 段 4 码(§3.3);baseline §1.1 加行(红区,goal 授权) |
| 是否需要用户拍板 | 已拍板(goal = 立项 + 拍板凭据;§1.1 六项);本稿为 ⑤ 评审稿冻结 |

---

## 3. 五张清单

### 3.1 字段清单(schema;T1 落地)

```prisma
// User 模型追加(紧跟 phone / phoneVerifiedAt 之后):
// 微信小程序 openid(账号级身份字段;wechat-mini-login 评审稿 D-W2/E-19):
// @unique 全局唯一含软删占用(沿 phone/username 不复用范式;预检查 findUnique 含软删);
// admin 清除置 null;不存 unionid / session_key / 绑定时间戳(D-W2 最小字段集)。
openid String? @unique

// SmsPurpose 追加一值:
WECHAT_BIND // 微信 openid 绑定锚点(pre-auth;wechat-mini-login 评审稿 D-W1)

// 新表 + 新 enum(镜像 SmsSettings;差异:凭证仅 appSecret 一段):
model WechatSettings {
  id String @id @default(cuid())

  // 通道选型(E-6/E-10;production-like 禁 DEV_STUB,写入与运行时双重校验)
  providerType WechatProviderType
  enabled      Boolean            @default(true)

  // 小程序运行参数(非 secret,明文;DEV_STUB 下闲置)
  appId String? // 微信小程序 AppID(镜像 sdkAppId 地位)

  // 凭证(加密存储;明文永不入库;响应永不回显——密文也不回显)
  appSecretEncrypted   String?
  credentialConfigured Boolean @default(false)

  // 元信息(沿 SmsSettings 范式;updatedBy 不建外键)
  remarks   String?
  updatedBy String?
  updatedAt DateTime @updatedAt
  createdAt DateTime @default(now())

  @@map("wechat_settings")
}

enum WechatProviderType {
  DEV_STUB // 非生产联调通道:确定性假 openid(E-10;production-like 不可达)
  WECHAT
}
```

### 3.2 端点清单(9 个;T2 = ①-③,T3 = ④-⑨)

| # | 端点 | 鉴权后缀 | 限流 | 说明 |
|---|---|---|---|---|
| ① | `GET /api/system/v1/wechat-settings` | `[rbac: wechat-setting.read.singleton]` | — | 不存在返 `data:null`;永不回显凭证 |
| ② | `PATCH /api/system/v1/wechat-settings` | `[rbac: wechat-setting.update.singleton]` | — | upsert 缺省 DEV_STUB;production-like 拒 DEV_STUB;拒凭证字段(DTO 白名单) |
| ③ | `POST /api/system/v1/wechat-settings/reset-credentials` | `[rbac: wechat-setting.reset.credentials]` | — | **仅 SA 短路**;`{appSecret}` AES-256-GCM 落库;upsert 缺省 WECHAT |
| ④ | `POST /api/auth/v1/login-wechat` | `[public]` | `@LoginWechatThrottle()` | `{code}`→code2session→已绑 createSession / 未绑 `bindingRequired:true`(E-16) |
| ⑤ | `POST /api/auth/v1/wechat-bind/send-code` | `[public]` | `@LoginWechatThrottle()` | `{phone}`→`SmsCodeService.issue(WECHAT_BIND)`;四无效场景泛化 200 零留痕 |
| ⑥ | `POST /api/auth/v1/wechat-bind` | `[public]` | `@LoginWechatThrottle()` | `{code,phone,smsCode}`→校验链 §4.3→绑定+JWT |
| ⑦ | `GET /api/app/v1/me/wechat` | `[auth]` | — | `{bound, openidMasked}`;准入沿 me/phone 豁免(E-18) |
| ⑧ | `PUT /api/app/v1/me/wechat` | `[auth]` | — | `{code}` 绑定/换绑一体,无需再验手机(D-W3);幂等同 openid |
| ⑨ | `DELETE /api/admin/v1/users/:id/wechat` | `[rbac: user.wechat.clear]` | — | 镜像手机清号:幂等 + assertCanManageUser(E-20) |

contract `EXPECTED_ROUTES`:159 → T2 162 → T3 **168**(逐 PR 显式登记)。

### 3.3 错误码清单(BizCode 25xxx 新段;T3 落地;baseline §1.1 加行沿 E-21)

| 常量 | code | HTTP | message | 触发点 |
|---|---|---|---|---|
| `WECHAT_ALREADY_BOUND` | 25002 | 409 CONFLICT | 该微信已绑定其他账号 | bind ④ / PUT me/wechat ② 占用检查;P2002 兜底 |
| `WECHAT_CODE_INVALID` | 25010 | 400 BAD_REQUEST | 微信登录凭证无效或已过期 | code2session 40029/40163;login-wechat 命中账号非 ACTIVE/软删(防侧写统一,§4.2) |
| `WECHAT_CHANNEL_NOT_CONFIGURED` | 25030 | 503 SERVICE_UNAVAILABLE | 微信登录服务未配置或未启用 | settings 缺失/未启用/凭证未配/appId 缺失/production-like DEV_STUB |
| `WECHAT_API_FAILED` | 25031 | 502 BAD_GATEWAY | 微信服务调用失败,请稍后重试 | 其余 errcode / HTTP 非 200 / 超时 / 网络错误 / 缺 openid(E-11) |

**不开的码**(沿 22042/22044 登记范式):
- `25001 WECHAT_NOT_BOUND`:零 throw 路径(login 未绑走 `bindingRequired:true`;admin 清除幂等;GET me/wechat 返状态对象);未来出现真实触发路径再实装
- `251xx FORBIDDEN_*`:权限拒绝走通用 30100 / 40100 / 40300(RBAC_MAP §6 规则 5)
- 绑定/登录中"手机号无效"不开新码:统一 `SMS_CODE_INVALID=24010`(沿 login-sms 防枚举体系,§4.3)

### 3.4 权限码清单(seed +4,117→121;T2 落地;RBAC_MAP 同 PR 同步)

| code | module/action/resourceType | ops-admin |
|---|---|---|
| `wechat-setting.read.singleton` | wechat-setting / read / singleton | ✅ |
| `wechat-setting.update.singleton` | wechat-setting / update / singleton | ✅ |
| `wechat-setting.reset.credentials` | wechat-setting / reset / credentials | ❌(镜像 storage/sms D2=A,仅 SA 短路) |
| `user.wechat.clear` | user / clear / wechat | ✅(端点 T3 实装;T2 期间孤码 WARN 预期) |

ops-admin 绑定 58→61;biz-admin / member 零变化。

### 3.5 审计事件清单(AuditLogEvent +4,31→35;T3 落地)

| 事件 | 写入点 | detail/extra 纪律 |
|---|---|---|
| `auth.login.wechat` | `createSession`(login-wechat 已绑路 + wechat-bind 末步) | extra `{familyId, openid: maskOpenid}`;禁明文 code/token |
| `wechat.bind.self` | 首绑(bind 事务内;pre-auth 与 PUT me/wechat 双路径) | after.openid 掩码;extra `{viaPath: 'pre-auth'\|'me'}`,pre-auth 路径另含 `{phone: maskPhone, codeId}` |
| `wechat.rebind.self` | 换绑(同上双路径,按 before.openid 非空区分) | before/after.openid 掩码;extra 同上 |
| `wechat.clear.by-admin` | `clearUserWechat`(仅实际清除时写) | before.openid 掩码 |

---

## 4. 认证与绑定流程冻结(校验顺序;实施不得调换)

### 4.1 通用:code2session

`WechatService.code2session(code)`:resolve settings(E-9,失败 → 25030)→ provider 调用(DevStub:`dev-openid-${code}`;真实:GET `https://api.weixin.qq.com/sns/jscode2session` + 8s AbortController)→ errcode 映射(E-11)→ 返 `{ openid }`(session_key/unionid 即弃,E-12)。

### 4.2 `POST login-wechat {code}`

① code2session → openid(失败 25010/25030/25031;不触账号信息,无 oracle)
② `findUnique({where:{openid}})`(含软删行)——无行 → **200 `{bindingRequired:true, session:null}`**;有行但 `deletedAt!==null || status!==ACTIVE` → **统一 25010**(与 code 无效同码同形,镜像 login-sms"四无效场景统一 24010"范式:不为禁用/软删开可区分响应)
③ `createSession(user, meta, 'auth.login.wechat', {openid: maskOpenid})` → `{bindingRequired:false, session:{...}}`

> `bindingRequired:true` 不构成枚举面:openid 必须经持有微信账号的 wx.login code 换取,攻击者无法探测任意他人 openid。

### 4.3 `POST wechat-bind/send-code {phone}` 与 `POST wechat-bind {code, phone, smsCode}`

**send-code**:`resolveActiveUserByPhone`(逐字沿 login-sms E-O2 口径:不经 notDeletedWhere,取行后判 ACTIVE)——四无效场景(不存在/未绑定/禁用/软删)返回与有效号**完全相同**泛化 200 `{expiresInSeconds:300}`(不发码不留痕);有效号 `smsCode.issue({phone, purpose: WECHAT_BIND, userId, ip})`(同号 60s 间隔/日 10 条跨 purpose 共享天然生效;限频/通道错误 24120/24121/24030/24031 照常抛,残余侧信道沿 R-1 接受)。

**bind** 校验顺序冻结:
① code2session → openid(25010/25030/25031;放最前:失败不烧 SMS 码——SMS 码有资费 + 60s 间隔,wx code 重取无感)
② `resolveActiveUserByPhone(phone)`——null → **统一 24010**(与码无效同码同形,镜像 E-O5)
③ `smsCode.assertValid(WECHAT_BIND)` 码预检不消费(错码 attempts+1 → 24010)
④ openid 占用 `findUnique`:occupied 为他人(含软删占用)→ **25002**;= 本人 → 幂等(跳过 ⑥ 的 update 与 bind audit);null → 首绑/换绑
   —— ④ 必须在 ③ 之后:25002 是"openid↔账号绑定关系"oracle,仅对已证手机号控制权者可达(镜像 password-reset E-5"10006 在码预检后"排序原则)
⑤ `smsCode.verifyAndConsume(WECHAT_BIND)` 原子消费(并发重放单赢家 → 24010)
⑥ 事务:`user.update({openid})` + audit `wechat.bind.self` / `wechat.rebind.self`(按该账号 before.openid 区分;viaPath='pre-auth';P2002 兜底 → 25002)
⑦ `createSession('auth.login.wechat')` → LoginResponseDto(经 E-16 包裹?**否**——bind 成功必然有会话,直接返 `LoginResponseDto`,不复用 WechatLoginResponseDto)

> ⑥⑦ 两事务串行,窄窗口接受(E-24)。bind 可覆盖该账号既有 openid(换微信场景;手机控制权已证,镜像 phone 绑/换绑一体语义)。

### 4.4 `GET/PUT me/wechat`(authed)与 admin 清除

- **GET**:取本人(notDeletedWhere)→ `{bound: openid!==null, openidMasked}`。
- **PUT `{code}`**:① code2session ② 占用检查(=self 幂等返当前状态不写 audit;他人 → 25002)③ 取本人 before ④ 事务 update + audit(bind/rebind by before;viaPath='me')⑤ 返 `AppMeWechatDto`。无需 SMS(D-W3);准入沿 E-18 豁免。
- **DELETE admin**:沿 E-20 逐行镜像 `clearUserPhone`(`user.wechat.clear` + assertCanManageUser + 幂等 + audit `wechat.clear.by-admin`)。

---

## 5. 模块位置与 AGENTS §2 providers/ 子目录例外解锁记录

```
src/modules/wechat/
  wechat.module.ts              // exports WechatService, WechatSettingsService
  wechat.service.ts             // resolve(E-9 内联 router)+ code2session + 域错误→BizCode 映射边界
  wechat-settings.controller.ts // 端点 ①-③
  wechat-settings.service.ts    // 镜像 sms-settings.service(60s 缓存 / rbac.can / 三态合成)
  wechat-crypto.service.ts      // 镜像 sms-crypto(独立 salt,E-4)
  wechat.dto.ts                 // settings 三 DTO
  wechat.types.ts               // WechatCredentialStatus / Resolved / Provider 接口 / 三个域错误
  wechat.constants.ts           // maskOpenid / WECHAT_DEV_STUB_OPENID_PREFIX / API 常量
  providers/
    dev-stub.provider.ts
    wechat.provider.ts          // 原生 fetch + 8s;含 spec(mock fetch)
```

`providers/` 子目录:AGENTS §2 模块结构例外,经本 goal 拍板解锁,**仅限本模块本子目录**(镜像 `modules/sms/providers/` / `modules/storage/providers/` 既有两例;第三例,不构成默认范式)。
认证侧文件:`src/modules/auth/login-wechat.service.ts`(E-14)+ auth.controller 三端点 + `common/decorators/login-wechat-throttle.decorator.ts`(第 8 实例,E-17)。
me 侧:users.service 三方法(`getMyWechat` / `bindMyWechat` / `clearUserWechat`)+ app-me.controller 两端点 + users.controller 一端点;`UsersModule` 新增 import `WechatModule`。

## 6. 安全边界(E-5/E-12 展开)

- **appSecret = L3**:AES-256-GCM 加密落库;明文/密文均永不入响应、pino 日志、audit、OpenAPI 示例、snapshot、e2e fixture 断言;reset-credentials 响应仅返 credentialStatus。
- **session_key = L3 且不存储**:解析即弃(E-12);全链零出现。
- **openid 非 L3 但不滥回显**:DB 存明文(查询锚点必须);响应仅 `GET me/wechat` 掩码后回显;audit 一律掩码;**不入 pino 日志**(含 debug;DevStub debug 例外不适用——假 openid 本身无敏感性,但同样不输出,避免范式漂移)、不入 snapshot 示例。
- **wx code**:一次性凭证,不入日志/audit/响应。
- **请求 URL 含 appid+secret**:provider 内禁止把 URL / fetch error 原文(可能内嵌 URL)直接 log;错误日志仅 errcode/errmsg/HTTP status。
- `WECHAT_ENCRYPTION_KEY`:production/smoke fail-fast(app.config,镜像 parseSmsEncryptionKey);dev/test 留空 → reset-credentials 抛 crypto 不可用(500),DevStub 联调不受影响。

## 7. 换绑 / 解绑 / 占用语义(D-W3 展开)

镜像手机号(sms 评审稿 §7):openid 全局唯一**含软删占用**;解除绑定唯一路径 = admin 清除(幂等);无本人裸解绑;换绑两路径——pre-auth `wechat-bind`(验手机锚点,可覆盖旧 openid)与 authed `PUT me/wechat`(JWT 已证身份,免再验);软删账号占用的 openid 在 bind ④ 表现为 25002(占用语义与 phone E-7 一致,且仅对已证手机控制权者可达)。

## 8. 敏感字段三问(AGENTS §18.4)

| 字段 | 业务用途 | 查看角色与掩码 | 保存期限 |
|---|---|---|---|
| `User.openid` | 微信登录身份映射(查询锚点) | 本人 GET me/wechat(掩码)+ audit detail(掩码,SA/授权角色);非 L3 但不滥回显 | 绑定期间;admin 清除即置 null |
| `WechatSettings.appSecretEncrypted` | code2session 调用凭证 | **任何角色不可见**(明文密文均不回显);L3 | 至下次 reset 覆盖;无导出路径 |
| session_key | 不使用 | 不存储、零出现 | 0(即弃) |

## 9. 既有行为锁(实施期间任何一条破坏 = 停下报告)

1. 密码登录 / OTP 登录 / refresh / logout 契约零变化;**auth 既有 e2e 断言零修改全绿**。
2. `auth.service.ts` diff 仅 createSession event union 类型行 + 注释(E-15);`JwtPayload` zero drift。
3. sms 模块全部文件零 diff(E-29);`me/phone` 与 admin 清号行为零变化。
4. 既有 7 个 throttler 实例配置零变化(第 8 实例纯新增)。
5. RolesGuard / @Public 机制零变化;新 endpoint 不标 @Roles(判权下沉 service,RBAC_MAP §6)。
6. contract snapshot 仅新增 9 端点相关条目;既有条目零漂移。

## 10. 测试计划

- **unit**:`wechat-crypto.service.spec`(镜像 sms-crypto.spec:roundtrip/篡改/key 缺失)/ `providers/dev-stub.provider.spec`(确定性 openid)/ `providers/wechat.provider.spec`(mock fetch:成功 / 40029→CodeInvalid / 40163→CodeInvalid / -1→ApiError / HTTP 500→ApiError / AbortError 超时→ApiError / 缺 openid→ApiError;断言禁 URL 入错误信息)。
- **e2e**:`wechat-settings.e2e-spec`(三端点 RBAC 边界〔reset 仅 SA,ADMIN+ops-admin 30100〕/ 凭证永不回显 / upsert 缺省 / DTO 白名单拒凭证字段);`auth-wechat.e2e-spec`(DevStub 驱动:login 已绑/未绑两路 + createSession 同构断言〔同 LoginResponseDto 形状,refresh 可用〕/ 首绑全链 send-code→bind→JWT / 防枚举一致性〔send-code 四无效场景与有效号响应逐字段相等;bind 无效号=码无效=24010 同形〕/ 25002 已绑他账号 / PUT me/wechat 换绑+幂等 / GET me/wechat 掩码形状 / admin 清除+幂等+RBAC / 限流 42900 / audit 断言〔掩码,无明文〕)。
- **回归**:auth-\*.e2e 全量零修改全绿;users / app-me e2e 全绿;`docs:codemap:check` + `docs:rbacmap:check` 0 FAIL。

## 11. 任务队列与探针(顺序硬约束;goal §3 原文固化)

| 阶段 | 内容 | 档位 | 探针(未满足才做) |
|---|---|---|---|
| T0 | 本稿冻结 + NEXT_TASKS 登记 | A | `docs/archive/reviews/wechat-mini-login-review.md` 不存在 |
| T1 | schema migration(§3.1)+ 干净库 deploy 重放 + seed 幂等二跑 | D | schema 无 openid/WECHAT_BIND/WechatSettings |
| T2 | wechat 模块 + 设置三端点 + 权限码 +4 + WECHAT_ENCRYPTION_KEY(env/.env.example/docker-smoke)+ CODEMAP/RBAC_MAP | D | `src/modules/wechat/` 不存在 |
| T3 | 认证三公开端点 + me 两端点 + admin 清除 + BizCode 4 + audit 4 + 第 8 throttler + AGENTS/baseline 红区 + e2e | C/D | `login-wechat` 路由不存在 |
| T4 | CHANGELOG / current-state / ARCHITECTURE §9 / ops checklist / NEXT_TASKS 收口 | A | 文档未 true-up |

## 12. 本期不做(终版报告必列)

- unionid / session_key 存储(即弃,E-12);微信手机号快捷授权(getPhoneNumber)锚点——D-W1 已拍板 SMS 锚点,未来真实需求出现单独评审
- 本人裸解绑(D-W3)
- 真实 AppID / AppSecret 注册与录入、真实微信验收(运维接力,SOP 见 T4 ops checklist)
- 小程序前端;招新自助走小程序(meeting-gated)
- 密码登录契约任何改动;openid 无账号自动注册;OTP/微信二要素
- wechat 侧 send-logs / 调用流水表(E-8)
- WechatSettings 变更 audit(沿 L-3 挂起,E-7)
- 多实例分布式锁(60s 缓存沿单实例前提,E-27)

## 13. §9 解锁记录与红区改动计划

**解锁事实**:维护者 2026-06-12 拍板「队员近期要用微信小程序」→ [`ARCHITECTURE.md §9`](../../../ARCHITECTURE.md) 升级路径表「第一个小程序产品要接 → 加微信登录策略」触发条件**满足**;本 goal 即该解锁的评审授权(评审解锁制,AGENTS §1 B 清单)。落地形态与 §9 表格建议路径(`auth/strategies/wechat-mini.strategy.ts`)的差异:**不引入 passport strategy**(AGENTS §8「不引入 LocalStrategy」同源纪律;沿 login-sms 既有范式用 @Public 端点 + 平铺 service),T4 标注解锁时一并注记实际落地形态。

**红区改动计划**(逐行 before/after 进对应 PR 描述,沿 #294 范式):

| 文件 / 位置 | 改动 | 随哪个 PR |
|---|---|---|
| `AGENTS.md` §8「登录」(现 :243 附近) | 追加一行:微信登录为**第三个独立认证端点** `POST /api/auth/v1/login-wechat`(2026-06-12 解锁,沿 login-sms 范式,冻结评审稿=本稿;绑定锚点=手机短信;密码登录契约零变化) | T3 |
| `AGENTS.md` §9 不做清单(现 :376) | `❌ refresh token 失败码细分 / 微信小程序 / OAuth 第三方登录` → 移除「微信小程序」并注记已解锁指向 §8 | T3 |
| `AGENTS.md` §1 B 清单(现 :71) | 「微信登录 / 小程序登录(业务明确需要时单独评审)」→ 解锁注记(沿 cron 解锁同款写法);**说明**:goal 红区授权原文为 §8/§9,本行是同文档同主题一致性收口(不收口则 §1 与 §8 自相矛盾),沿 cron 先例,PR 描述显式标注 | T3 |
| `docs/srvf-foundation-baseline.md` §1.1 | 段位表加行:`250xx + 251xx` = `wechat`(4 BizCode,统一防枚举沿既有原则,不开细分;预留段相应缩为 `260xx-290xx`) | T3 |
| `ARCHITECTURE.md` §9(:171 表行 + :181 未解锁清单) | 表行标「✅ 已解锁(2026-06-12,本稿;实际落地 `src/modules/wechat/` + auth 平铺 service,非 passport strategy)」;:181 仍未解锁清单移除「微信小程序登录」 | T4 |

---

> 实施(T1-T4)以本稿为准;与 goal 原文冲突时 goal 优先;新发现问题按 process §4.1 人话简报上报,不顺手修。
