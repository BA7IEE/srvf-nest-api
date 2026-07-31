- **企业微信通道层与配置面(2026-08-01;企业微信接入 T2,冻结稿 [`wecom-integration-t0-terminal-review.md`](docs/archive/reviews/wecom-integration-t0-terminal-review.md) §4.1 / §6.1 / §7 / §11)**:第 37 个模块 `src/modules/wecom/**`;settings 四端点上线,**默认全部开关 false**,登录与消息链路本刀不通(OAuth 与绑定在 T3,消息在 T5B 且被 Outbox 生产部署硬门锁着)。

  **四端点**(Endpoint 438 → **442**):
  - `GET /api/system/v1/wecom-settings` —— 不存在返 `data:null`;`corpId` 只回显**掩码**
  - `PATCH` —— upsert;`loginEnabled`/`messageEnabled=true` 必须 `enabled=true`;`webBaseUrl` 仅 origin(production 强制 HTTPS);`corpId` 仅在 active identity=0 时可改,否则 **36020**
  - `POST /reset-credentials` —— **仅 SUPER_ADMIN 短路**,码不绑 ops-admin
  - `POST /test-connection` —— 只读诊断,强制跳过 token 缓存取新 token → `agent/get` 核对 `agentid` 与 `close`

  **凭证边界(§5.5 L3)**:`WECOM_ENCRYPTION_KEY` 是**独立密钥**(D-WC-12),与 STORAGE / SMS / WECHAT / REALNAME 四把 key 互不复用且派生 salt 各异 —— 企业微信与微信小程序**不共域**,共用密钥会把"换掉小程序凭证"和"换掉企业微信凭证"绑成同一次运维动作。单测有执行位:两模块用同一份 env key 值,密文仍互相解不开。CorpSecret 明文与密文**永不**进响应 / Audit / 日志;`update` audit 只记 `changedFields`(连 `corpId` 的 value 都不写),`reset` audit **不传 before/after/extra**。

  **`test-connection` 只返计数,不返任何成员 / 部门 / 标签 ID**(§6.1 第 4 条)。诊断接口回一份 ID 列表就等于把通讯录做成了导出端点,而"不接通讯录"是 §0.3 的硬禁区;计数够回答"配没配对",ID 不是诊断必需 —— 类型层兜底:`WecomAgentSnapshot` 里根本没有存放 ID 的字段。该端点**不写 audit**。

  **Provider 日志纪律(§7.1 规则 2)**:`gettoken` 的 `corpsecret` 在 query string 里,`agent/get` / `message/send` 的 `access_token` 同样在 query 里。因此 Provider **绝不**冒泡 fetch 原始 error —— Node fetch 的 `TypeError.cause` 会带上完整 URL。对外可见的字符串只含固定端点名、errcode 与归一化标签。只按 `errcode` 分类,**不依赖 errmsg**(上游可随时改的展示文案)。

  **Permission +4**(权限码 222 → **226**):`wecom-setting.{read.singleton,update.singleton,test.connection,reset.credentials}`;前三条绑 ops-admin(96 → **99**),`reset.credentials` **不绑**(沿 storage/sms/wechat D2=A)。**BizCode +3**(306 → **309**):`36020` / `36030` / `36031`;`36002` / `36010` / `36011` 属 T3,段位已排好但不提前占码。**AuditLogEvent +2**(130 → **132**):`wecom-setting.update` / `wecom-setting.reset-credentials`;另四条身份类事件由 T3-T4 的消费方同 PR 落,不预埋无人写入的事件名。**Cron 恒 2**。

  **第 11 个 throttler 只落骨架**:新增 `login-wecom-throttle.decorator.ts` 与 `app.config` 的 limit/ttl;**实例注册与 guard 接线留到 T3**。二者必须成对改动 —— guard 靠**逐 throttler 的 name 判断跳过**,只注册实例不接 guard 会让 `login-wecom` 对所有已限流端点多计一道数,那是真行为变更;而 T2 没有任何 pre-auth 企业微信端点可挂,提前接线也没有用例能实测它。

  **DTO 白名单**:`UpdateWecomSettingsDto` 八个字段全部用 `@OmittableOnly()` 而非 `@IsOptional()`(第 18 条棘轮 `srvf/no-nullable-is-optional` 当场拦下了初版)—— 这些字段业务上没有"清空"语义,显式 `null` 必须稳定 400 而不是穿过契约层。同时拒收 `corpSecret` / `corpSecretEncrypted` / `credentialConfigured` / `callbackToken` / `encodingAesKey`(§0.3:第一版连回调 Token 与 EncodingAESKey 的字段位都不开)。

  **fail-closed**:`enabled=false` / settings 缺失 / 凭证 missing 或 invalid / `corpId` 或 `agentId` 缺失 / production-like 下 DEV_STUB —— 一律 36030。e2e 用阳性对照证明这些拒绝确实来自 `enabled` 闸:同一份配置只把 `enabled` 从 false 翻成 true 就通。
