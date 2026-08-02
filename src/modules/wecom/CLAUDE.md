# modules/wecom — 本地铁律(2026-08-01 建;T2 通道层落地 + W 批次收口)

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);冻结评审稿读 [`/docs/archive/reviews/wecom-integration-t0-terminal-review.md`](../../../docs/archive/reviews/wecom-integration-t0-terminal-review.md)(下称"冻结稿");架构边界读 [`/docs/architecture-boundary.md`](../../../docs/architecture-boundary.md);安全章节读 [`/docs/security.md`](../../../docs/security.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## Scope

- **配置 singleton** `wecom_settings`(第 68 migration 的 `ON ((true))` unique 在 DB 层保证至多一行)+ `WecomSettingsService`(每次直读 PostgreSQL 当前已提交事实,无跨请求缓存)
- **admin 四端点** `system/v1/wecom-settings`:`GET` / `PATCH` / `POST reset-credentials` / `POST test-connection`;入口仅 `JwtAuthGuard`,判权全在 Service 内 `rbac.can()`
- **双 Provider**:`WecomRealProvider`(真实企业微信,原生 fetch 零新依赖)/ `DevStubWecomProvider`(非生产联调,确定性假 wecomUserId)
- **通道编排** `WecomService`:`resolveRoute()` fail-closed 闸门链 + 域错误 → BizCode 映射边界(`WecomChannelUnavailableError` → 36030 / `WecomApiError` → 36031;36010 归 T3)
- **凭证加密** `WecomCryptoService`(AES-256-GCM,`WECOM_ENCRYPTION_KEY` **独立密钥,与小程序不共域**)
- **OAuth 一次性凭证台账** `WecomAuthAttemptService`(T3,2026-08-02):`wecom_auth_attempts` 的**唯一**写入点。state / binding ticket 只存 SHA-256,OAuth code 连 hash 都不存;消费一律走 `updateMany` CAS(判 + 写在一条 SQL 内),`count===1` 才是赢家
- **登录链路闸门** `WecomService.resolveLoginContext / getAuthorizeContext / exchangeOAuthCode`(T3):在总闸之上再加二级闸 `loginEnabled`,并强制 `corpId`(DEV_STUB 也不例外 —— corpId 是身份键的一半)
- **不负责**:微信小程序(在 [`/src/modules/wechat/`](../wechat/) —— 与本模块**严格分家**,身份键是 `corpId + wecomUserId` 而非 `openid`,不并表不混码不混渠道);`wecom_identities` 的**写**(绑定归 auth 的 `login-wecom.service` 与 users 的 `user-wecom-binding.service`;**撤销**归 users 的 [`wecom-identity-revoke.ts`](../users/wecom-identity-revoke.ts) 单一原语,T4 起由 `clearUserWecom` / `users.softDelete` / `members.reopenAccount` 三处共用 —— 它的入参是两个 userId,故也落在 users,本模块对 User 无感知);消息 outbox 与投递记账(T5B)

## T3 / T5B 开工前置 —— 三条出生检查(2026-08-01 W 批次收口,**动手前先读完**)

整批评审在 T2 第一版里抓到的 3 条 P1,**没有一条是新形状**:两条是仓库已经清过三轮的老形状在新模块里重生,一条是"用本地默认值冒充上游事实"。下面三条是它们的执行位,T3(OAuth)与 T5B(消息)**不要再挖同一个坑**。

### ① 配置快照一律无状态传递(禁实例字段)

凡"从 DB 读一份配置快照、供**本请求**使用"的路径,一律用 `prepare(settings)` 返回**绑定不可变 ctx 的新对象**;**禁止** `this.settings = settings` 这类实例字段。

- **为什么**:Provider 是 `@Injectable` **单例**。写实例字段 = 并发请求互串配置快照。T2 实测(`wecom.service.spec.ts`):两个并发 `resolveRoute()` 之后,请求 A 的路由拿着请求 B 的 CorpID + CorpSecret 去换 token,且两者被 token cache 合并成**同一次**上游请求。
- **执行位**:`WecomRealProvider` **刻意不 `implements WecomProvider`**,唯一公开入口是 `prepare(settings): WecomProvider`。于是"未 prepare 就调用"是**编译错误**,不是运行时错误。
  ⚠️ T3 / T5B **不要**给这个类补回实例方法(`getAccessToken()` / `exchangeOAuthCode()` 之类)来"图方便" —— 那等于把编译期防线降级回运行时,而且立刻重新打开实例字段的口子。要新能力就往 `prepare()` 返回的对象里加一个 `xxxWithContext(ctx, …)`。
- **同款范式**:`cos.provider` / `wechat.provider` / `tencent-realname.provider` 全仓一致。T2 第一版的 `return this;` 曾是**全 `src/` 唯一一处**。

### ② 写路径一律"锁后复读"(S1 形状)

singleton 行的任何 read-modify-write:**先取 id → `FOR UPDATE` → 锁后重读完整行 → 用锁后行 + dto 算终态 → 校验组合不变量 → 写**。

- **为什么**:锁**前**读到的值,在拿到锁的那一刻可能已经被别的事务改掉。T2 实测(`test/e2e/wecom-settings-concurrency.e2e-spec.ts`):两个并发 `PATCH` 各自用锁前快照判断,合起来写出 `enabled=false + loginEnabled=true` —— 一个自相矛盾却"两边都保存成功"的配置。
- 三个开关是**跨字段组合不变量**(二级闸 `loginEnabled` / `messageEnabled` 为 true 必须 `enabled=true`),这类不变量必须在**锁后**的终态上判,不能各判各的。
- T3 给 `wecom_identities` 加写路径时同样适用:先锁再读,别把"两条 active partial unique"当唯一防线 —— 唯一索引挡得住重复行,挡不住跨行不变量。
- 形状表见 [`/docs/archive/reviews/concurrency-write-path-audit.md`](../../../docs/archive/reviews/concurrency-write-path-audit.md) §6(S1–S7)。

### ③ 上游事实不得用本地配置补(严格协议解析)

解析企业微信回执时,协议字段(`errcode` / `agentid` / `close` / `userid` / `access_token` / `expires_in` …)**缺失或类型不对一律 fail-closed 到 36031**;**禁止** `readNumber(body, key, 默认值)` 这类兜底。

- **为什么**:T2 第一版 `errcode` 缺失默认 0(= 成功)、`agentid` 缺失回填**本地配置的 agentId**、`close` 缺失默认 0(= 应用已启用)。三条叠加的结果是:上游返回 `{}`,`test-connection` 回答"一切正常",而 `agentMatched` 变成**自己和自己比**,恒 true。
- **唯一例外**:列表类字段(`allow_userinfos` / `allow_partys` / `allow_tags`)**整个键缺席**记 0 —— 缺席 = 空列表,这是协议读法。但键**出现了而结构不对**(不是对象 / 内层不是数组)⇒ 36031,**不得静默计 0**(否则诊断会把"读不懂"报成"没有人可见")。
- 反面判据留在 `providers/wecom.provider.spec.ts` 的六组畸形响应用例里 —— 加新端点时照抄那一段。

## Local facts

- **命名铁律**(冻结稿开头):`WeCom`/`wecom` = 企业微信;`Wechat`/`wechat` **专指**微信小程序。二者不得混写、混表、混错误码、混通知渠道。`wecom.constants.ts` 与 `wechat.constants.ts` **刻意不共用任何常量**,连数值恰好相同的 8000ms 超时也各自声明(共用即耦合,一方调参会静默改另一方)
- **三个开关**:`enabled`(总闸)/ `loginEnabled` / `messageEnabled`(二级闸)。二级闸为 true 必须 `enabled=true`(见上文 ②);`enabled=false` 时一切 Effect fail-closed
- **`corpId` 变更闸**:仅当 `corpId` 对应的 active identity 计数为 0 时可改,否则 36020。判定读的是 identity 计数,必须在 settings 行锁**之内**(换 CorpID = 所有既有绑定静默失配,且两条 active partial unique 按 corpId 分域,换了之后旧行不再互斥)
- **`webBaseUrl` 仅 origin**:拒 path/query/fragment 是**防开放重定向** —— OAuth callback path 由代码固定拼接;允许配置里带 path,配置面就成了改回跳目标的入口。production-like 强制 HTTPS
- **`configurationGeneration`** = 10 个 effect 字段的 SHA-256 opaque hash,**不含 `remarks`**(改一句备注不该让全进程 token 作废)。仅供进程内等值比较,不入日志 / audit / response / error
- **token cache 是模块级 `Map`**,键 = `corpId : agentId : configurationGeneration`。配置一变自然不命中旧条目,无需手动 invalidate;多实例各自缓存合法(缓存丢失只增加取 token 请求,不影响正确性)。⚠️ 它是**进程级**缓存不是**请求级**状态 —— 与上文 ① 不矛盾,判别标准是"键里带不带 generation"
- **`credentialStatus` 三档**:`missing`(未配置或密文列为 null)/ `configured`(解密成功)/ `invalid`(密文在但解不开 = `WECOM_ENCRYPTION_KEY` 被轮换或密文被篡改)。第一版**不支持 key rotation**,落到 `invalid` 即 fail-closed,刻意不做"自动重加密"
- **production-like 禁 `DEV_STUB` 两重**:第①重在 `WecomSettingsService.updateSettings` 写入口,第②重在 `WecomService.resolveRoute` 运行时。**不静默 fallback 到 stub** —— 登录链路上那等于假身份进生产
- **singleton 并发首配**:DB unique 兜底 + P2002 后重跑同一事务映射到既有单行,**不新增 BizCode**(沿 wechat / storage 同款)
- **`errcode` 分类只看码不看 `errmsg`**:`errmsg` 是上游可随时改的展示文案,拿它做分支等于把业务逻辑挂在别人的文案上
- **判权**:`wecom-setting.reset.credentials` **不绑 ops-admin**(冻结稿 §11.1),仅 SUPER_ADMIN 经 `RbacService.can` 短路通过;其余三码绑 ops-admin。此处仅记录当前事实,**不得**在 docs-only PR 中改变权限策略

## Risk points(不要做)

- ❌ **不**把 CorpSecret 明文 / 密文、`access_token`、OAuth `code`、**完整 URL**、fetch 原始 error 写入日志 / audit / 错误信息 / OpenAPI 示例 / 文档示例。`gettoken` 的 `corpsecret` 与 `message/send`、`agent/get` 的 `access_token` 都在 **query string** 里,Node fetch 的 `TypeError.cause` 会带上完整 URL —— 所以**禁止冒泡原始 error**,只保留归一化标签
- ❌ **不**给 `wecom-settings` 的任何响应回显凭证;`corpId` 只出**掩码**;`update` audit 只记 `changedFields`,`reset` audit **不传 before/after/extra**(连"改的是 corpSecret 这个字段"都不写)
- ❌ **不**让可见范围的成员 / 部门 / 标签 **ID** 穿过 service 边界(`WecomAgentSnapshot` 里根本没有存放 ID 的字段 —— 类型系统兜底,不靠自觉)。`test-connection` 是连通性诊断,不是通讯录导出接口
- ❌ **不**给 `WecomRealProvider` 补实例字段或实例方法(见 ①);**不**给协议解析加默认值(见 ③);**不**在写路径上用锁前快照做判断(见 ②)
- ❌ **不**对 `errcode` 做盲重试:`-1` 系统繁忙最多 3 次;`45009` 限流**不重试**(官方拦截窗口内重试只会延长拦截);配置类错误(40001/40013/40056/50001/…)是终态,重试解决不了"Secret 错了"
- ❌ **不**把 `wecom` 与 `wechat` 的表 / 码 / 常量 / 通知渠道并到一起,**不**把企业微信身份写进 `User.openid`
- ❌ **不**把 `returnPath` 的开放重定向判据放宽(`isSafeWecomReturnPath` 是整条企业微信登录链**唯一**的防线,放宽它没有任何别的检查会红);**不**把控制字符判据写成含真实控制字节的正则字面量(那会让整个文件在 grep / diff 眼里变成二进制,评审时整段不可见 —— 本刀初版踩过,现用数值比较);**不**把 token-like query key 判据改回"带分隔符的正则"(漏 `refreshToken` 这类 camelCase)或"纯子串包含"(误杀 `keyword`)—— 现用逐段精确匹配
- ❌ **不**在绑定事务里省掉锁后复判 `enabled` / `loginEnabled`:pre-auth bind 路径**不调** `resolveLoginContext`(换身份发生在 login 那一步),少了这一判,运维关掉开关之后任何手握未过期 binding ticket 的人仍能建身份**并拿到会话**(e2e 实测)
- ❌ 改凭证 / 加密 / 判权 / 并发锁序 **不是 docs-only**,按 D 档降速

## Validation

- `pnpm lint` + `pnpm typecheck`
- `pnpm test` — 覆盖 `wecom-crypto.service.spec.ts` / `providers/wecom.provider.spec.ts`(含六组畸形响应)/ `wecom.service.spec.ts`(并发 resolveRoute)
- `pnpm test:e2e` — 覆盖 `wecom-settings.e2e-spec.ts`(权限 / 开关 / 白名单 / corpId 闸 / 凭证不泄露 / fail-closed)、`wecom-settings-concurrency.e2e-spec.ts`(真双连接锁后复读)、`wecom-schema.e2e-spec.ts`。**并发用例必须跑全量**:屏障靠 per-worker 派生库隔离,单 spec 跑法拿不到同样的调度
- 改 DTO 字段 / endpoint path / Swagger schema / 错误码 → 必须再跑 `pnpm test:contract`
