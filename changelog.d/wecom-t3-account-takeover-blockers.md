### Security

- **企业微信 OAuth `state` 现绑定发起授权的浏览器**(P1-27 第一刀 B1)。`login-wecom/authorize` 与
  `wecom-bind/authorize` 额外下发 `HttpOnly + Secure + SameSite=Lax` 的 `__Host-` Cookie,
  `state` 由该 nonce 派生;`POST auth/v1/login-wecom` 与 `PUT app/v1/me/wecom` 必须同时携带匹配 Cookie。
  修复登录 CSRF 及其可升级出的**完整账号接管**(攻击者未绑定的企业微信身份被受害者用自己的手机号 + 短信码绑到本人账号)。
  🔴 **破坏性变更 —— 前端必须适配**:这四个端点的请求需带 `credentials: 'include'`;
  改法与部署前提见 [`docs/handoff/miniapp.md` §1.3.1](../docs/handoff/miniapp.md)。
- **新增单调身份代际 `User.wecomIdentityVersion`**(P1-27 第一刀 B2;第 70 个 migration,additive)。
  `WECOM_BIND` step-up proof 的 snapshot 纳入该代际,修复 ABA 回环:
  `无绑定 → 绑定 → 管理员清除 → 无绑定` 之后,无绑定态签发的旧 proof 不再复活(现返 `10008`)。
  bind / rebind 与撤销原语(admin clear / 软删 / 队员账号重开)同事务递增;
  同目标 no-op 与幂等空转不递增。该列不进任何响应、Audit 或日志。
- **`36010` 耗时归一**(P1-27 第一刀 B3)。企业微信登录的全部 `36010` 分支收进单一出口,
  补齐有界最小响应时长 + 小扰动。修复前实测「`state` 无效」比其余分支快约一半,
  构成"我方认不认这个 state"的计时 oracle。

### Fixed

- `login-wecom` 中非发起浏览器的失败**不再消费** `state` —— 修复浏览器绑定的同时不引入
  "拿到 state 即可作废他人登录流程"的 DoS。
