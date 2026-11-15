# auth — 认证与会话冻结语义

负责密码/SMS/微信/企业微信登录、refresh/logout、短信重置与 identity step-up。
本人资料/改密归 users，RBAC归 permissions；UsersModule 可消费 AuthModule，禁止反向模块依赖。
详细契约见 `docs/reference/auth-jwt-refresh.md`，不据本文件的压缩措辞重新设计认证行为。

## 会话与防枚举

- JwtPayload 严格 `{sub,username}`；JwtStrategy 是鉴权阶段唯一 User 查库点，
  每请求验证 ACTIVE且未软删。不在 Guard 重查、不加 role/tokenVersion、缓存或其他 passport strategy。
- 密码登录：不存在用户名、错密码、禁用、软删统一10004与相同响应体/状态；
  每条路径一次 bcrypt.compare，未命中使用模块级固定 TIMING_DUMMY_HASH。
- refresh 仅存 sha256(raw).hex，明文仅登录/刷新响应一次。
  rotation always、family绝对有效期不延长；判定顺序 rotatedAt→revokedAt→user inactive，
  复用触发 family revoke 和 replayDetected/familyRevoked audit。
  失败统一10007，不存在 token 不写 audit；正常并发 refresh 锁等待输家不误判 replay。
- createSession 为四种登录唯一签发点；调用方传已验因子 snapshot，锁后复验才签发。
  会话写统一 lockAuthSessionUser 的参数化 User FOR UPDATE：
  上层 invariant/Member → User → refresh mutation → audit，锁后重读身份/token。
  不先锁 refresh、不另建进程/advisory/Redis session锁。
- wecom-identity 因子为独立表，User锁后再 FOR SHARE 检查
  id/userId/corpId/wecomUserId/status/revokedAt，失败36010。
- logout 用可识别未过期 row（含 rotated ancestor）定位 family，撤全部活跃未过期后继。
  未知/过期/已全撤200且零audit；只在 revokedCount>0 记 auth.logout，
  extra 恰 familyId/revokedCount；不接 reuse detection，不扩大 user-wide，不加限流。
  logout-all 撤本用户活跃未过期 refresh，沿 PasswordChangeThrottle。
- access 不主动吊销，沿自然到期和每请求用户状态校验；不加 blacklist/tokenVersion。
  本人改密同事务撤 refresh（self-password-change），旧 access 语义不变。

## SMS 与微信顺序

- 短信重置：解析用户→码预检不消费→10006检查且不烧码→原子消费→
  同事务改密、撤活跃未过期refresh（self-password-reset）、audit。
  不把10006移到预检前形成密码oracle。无效号 send-code 泛化200且零留痕；
  其余 reset 无效身份/验证码失败统一24010。成功 data:null、不自动登录。
- OTP：解析用户→verifyAndConsume(LOGIN)→createSession，复用 LoginResponseDto、
  family/lastLoginAt/auth.login.sms；无效号 send-code 泛化200零留痕，
  登录失败24010，不混10004，不改 phoneVerifiedAt、不自动注册、不混入密码登录DTO。
- 微信：code2session先行；未绑返 bindingRequired/session:null，禁用/软删25010。
  bind 冻结顺序：code2session→解析手机号→码预检→openid占用（含软删，他人25002）→
  原子消费→绑定事务+audit→createSession。占用错误仅对已证手机控制权者可达。
  真实 bind/rebind 同事务写User、撤旧refresh（self-wechat-identity-change）、audit，
  提交后签新family；已绑本人no-op。无自动注册、unionid/session_key存储或本人裸解绑。

## 企业微信 OAuth 与 proof

authorize 发 purpose绑定的 state，DB只存hash；CAS消费后事务外换身份，
未绑返回 bindingRequired/bindingTicket。bind顺序：
有效binding_required ticket→手机号→码预检→占用预检（他人36002）→消费码→绑定事务→createSession。
锁序 `WecomSettings FOR SHARE → User FOR UPDATE → WecomIdentity → WecomAuthAttempt → RefreshToken/Audit`；
锁后重验 enabled/loginEnabled，不能仅靠锁外 resolveLoginContext。
无效state/code、外部成员、跨企业userid、停用/软删逐字段同形36010；
send-code无效号泛化200零留痕。

state=sha256(browserNonce)，nonce只进 __Host-srvf_wecom_login/bind Cookie，
HttpOnly/Secure/SameSite=Lax/Path=/，与state同寿。消费同时要求body state与Cookie nonce，
先验证派生再CAS；浏览器不匹配不发UPDATE，防作废他人流程。
原始code/state/ticket不进DB/日志/audit，nonce不进DTO。
全部36010经 WecomLoginFailureGate 单出口，自请求起点150ms+0–50ms扰动；
36030/36031不归一。真实上游墙钟仍有已接受的残余差异，DEV_STUB不证明真机时序；
用分支instrumentation测出口，不用毫秒阈值E2E。

step-up action仅 PHONE_BIND/WECHAT_BIND/WECOM_BIND，factor仅 PASSWORD/SMS/WECHAT，
不以待绑定WECOM作当前身份因子。JWT secret以HKDF派生 signing.v1/snapshot.v1 两把32-byte key，
audience=srvf.identity-step-up、TTL=300s；snapshot覆盖
id/passwordHash/phone/phoneVerifiedAt/openid/status/deletedAt。
WECOM_BIND额外含单调wecomIdentityVersion与active身份指纹；
第四参数 `{identityVersion,identity}` 必填，null拒10008，防 null→bind→clear→null 旧proof复活。
其他action算法逐字节兼容，不移除computeActionSnapshot早返回。
签名/过期/audience/sub/action/snapshot统一10008，无当前phone/openid10009。

## 审计与限流

AuditMeta由controller buildAuditMeta(req)显式传，不改隐式上下文。
成功step-up仅记action/factor；登录/重置/绑定沿既有事件与掩码extra；
pre-auth bind的viaPath=pre-auth，本人面viaPath=me。
proof/snapshot/password/SMS或wx code、refresh明文/hash、完整phone/openid均不入日志/audit/示例；
redaction同时覆盖精确与通配字段。

step-up复用password-change/sms-send/sms-verify/login-wechat；
wecom族沿login-wecom IP5/60，send-code叠sms-send、bind叠sms-verify。
throttler注册与ThrottlerBizGuard按name分派须成对修改，不改变其他端点计数；
命中TOO_MANY_REQUESTS，不返X-RateLimit或Retry-After。
改签发/撤销覆盖四种登录与session并发，防枚举覆盖四场景；
改绑定覆盖step-up/占用/Cookie CAS，接口变化再跑contract。
