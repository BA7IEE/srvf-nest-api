# 统一通知派发模块评审稿(Unified Notification Dispatcher Review)— T0 修订冻结

> **状态:冻结,不回改**(2026-06-25;基线 = main `8c612ed1`,v0.31.0 刚发版;`git status` clean;0 open PR;HEAD == origin/main 已核)。
> **性质**:本文件是 GAP-005 通知模块的 **T0 修订评审冻结档**。**supersede** 原冻结 T0 [`member-notification-review.md`](member-notification-review.md)(#437,2026-06-23,只设计了站内信)的**架构**:把通知扩为「**统一多渠道 + 派发器 + producer 任务**」形态(站内 / 微信订阅 / 短信)。**不回改那份冻结档**——它留作历史,其站内信设计(`Notification` 广播 + `NotificationRead` 已读 + admin 8 端点 + app 4 端点 + 5 RBAC 码 + 310xx)被本稿**复用为统一模块的『站内』渠道**。
> **立项链**:维护者 2026-06-25 拍板「扩展为统一多渠道架构,出 T0 修订评审稿先行」(本 goal = 立项 + 授权);设计方向二条(① 统一模块 + producer 只创建任务、② 微信订阅 quota 机制)记为**输入不再问**,正文 §2/§3/§6 承接。
> **权威分层**:本文件是**修订冻结时刻**的决策依据,**非当前事实源**;落地后当前事实以 [`docs/current-state.md`](../../current-state.md) 为准,字段以 [`prisma/schema.prisma`](../../../prisma/schema.prisma) 为准,接口以 OpenAPI contract / live `/api/docs-json` 为准。
> **范式母本**:① 站内信设计 = [`member-notification-review.md`](member-notification-review.md)(原 T0,复用);② 多渠道触达基础设施 + 触达隐私口径 + cron 锁 = [`sms-verification-infra-review.md`](sms-verification-infra-review.md) / [`queue-b-otp-birthday-infra-review.md`](queue-b-otp-birthday-infra-review.md);③ 微信通道编排 + 凭证 + 原生 fetch = [`wechat-mini-login-review.md`](wechat-mini-login-review.md);④ producer 触发契约 = [`recruitment-phase4-loop-optimization-review.md`](recruitment-phase4-loop-optimization-review.md) §9;⑤ Effect 边界 = [`architecture-boundary.md §3.6`](../../architecture-boundary.md)。
> **零代码声明**:本稿**只调研 + 只出评审稿**,零代码零数据(不改 `src/**` / `prisma/**` / `test/**`;镜像 #437 / #438 docs-only 范式)。

---

## ⚠️ 待维护者拍板清单(D-N 系;本稿只给推荐,不替决)

下列是**统一架构带来的新决策**(在原 T0 残留 5 项之外;原 5 项见 §10.1)。本稿给方案 + 推荐 + 理由,**最终由维护者拍板**(可一句「按推荐」全收,或逐项调整)。**架构级骨架决策(数据模型混合形态 / 派发器 = Effect / 同步发送 / producer 同步调用)本稿代决冻结**,理由见对应章;若维护者要改这些骨架,§9 schema / §11 路线图需按新取值重算。

| # | 待拍板 | 本稿推荐 | 一句话理由 |
|---|---|---|---|
| **D-N1** | 通知触发方式(原 T0 ⑧「纯手动」是否放宽) | **放宽**:admin 手动广播 **+** producer 系统自动触发(`sourceType` 二分) | producer「只创建任务、不自建出口」是本修订的立项前提(招新 S7 / 活动 / 考勤),无系统自动则统一模块不成立 |
| **D-N2** | 微信订阅 quota 上限(每 用户×模板) | **可配上限,默认 5**(env / 常量) | 微信一次性订阅可累积但非无限;封顶防前端 ack 刷量 + 对齐微信侧累积限制 |
| **D-N3** | 微信模板管理形态 | **模板 ID 运营可配(配置表)+ 字段映射内置代码** | 模板 ID 随小程序后台变(运营改不重部署,镜像 `sms_settings.templateIdBirthday`);字段映射绑 payload 构造逻辑,留代码 |
| **D-N4** | 渠道默认编排 | **站内恒发 + 微信看 quota(机会式)+ 短信仅紧急兜底(延后切片)** | 站内零成本恒达;微信只推已订阅者;短信有真实资费,紧急召集兜底单独切片 + 显式计费确认 |
| **D-N5** | producer 接入方式(同步调用 vs 事件总线) | **同步 service 直调**(`NotificationDispatcher` 注入 producer) | 本仓无事件总线、仅 `eventPlaceholder`;直调显式简单 AI 友好;自建事件总线 = 架构级,禁作既成事实 |
| **D-N6** | 推送投递记录粒度 | **`NotificationDelivery` 按 通知×渠道×收件人**(仅推送渠道,站内不落) | 微信/短信需要 per-recipient 投递态 + 失败追踪;站内复用广播+已读不 fan-out(§2 核心张力解法) |
| **D-N7** | 推送失败重试政策 | **不自动重试**(镜像生日批 FAILED);微信失败回「补授权」信号给前端 | 与既有生日批 / SMS 失败语义一致;自动重试需要 cron/queue(触碰 R-5),延后 |
| **D-N8** | 紧急召集是否强制短信 | **否**:站内 + 微信优先,短信由 admin 显式发起(延后切片) | 强制短信 = 全员资费 + 须过 R-5(若批处理);紧急兜底保留为人工显式动作 |
| **D-N9** | 广播 vs 定向是否同表 | **同一 `Notification` 表 + `audienceType` 二分** | 定向(producer 给单个收件人)与广播(admin 给可见档)共用状态/读取/审计骨架,避免双表重复 |

> 原 T0 的产品 5 项(渠道/定向/已读/可见性/触发)中,**「渠道」与「触发」已被本修订的多渠道 + D-N1 覆盖更新**;「定向 ③ / 已读 ④ / 可见性 ⑤」**沿原 T0 推荐不变**(站内渠道复用),并入 §10.1 一并待拍板。

---

## 0. TL;DR

**一句话**:把 `notifications` 模块(现仅生日 cron)扩为**统一多渠道通知中枢**——producer(招新/活动/考勤/admin)**只创建通知记录**,**`NotificationDispatcher`(= architecture-boundary §3.6 的首个真实 Effect)统一派发**到三渠道:**站内(复用原 T0 广播+已读拉取)/ 微信订阅消息(净新建 quota 机制)/ 短信(复用 `SmsProviderRouter`,紧急兜底延后)**。通知逻辑**绝不写死在 producer**。

**核心张力解法(§2)**:站内是「广播 + 已读 pull」(原 T0 刻意不 fan-out),微信/短信是「按收件人 + 配额/计费」推送 → **混合模型**:`Notification`(广播+定向二合一)+ `NotificationRead`(站内拉取已读,不 fan-out)+ **`NotificationDelivery`(仅推送渠道按收件人落投递态/失败,站内不落)**。fan-out 只发生在推送渠道、且微信天然被 quota 限只推已订阅者。

**微信 quota 机制(§3,本修订核心,净新建)**:前端在高频按钮点击后调 `wx.requestSubscribeMessage` 拿授权 → **ack 上报后端 → (用户×模板) quota +1**;后端**真正发送时原子扣 1**、记 `NotificationDelivery`、失败(43101 未授权/无配额)→ 让前端**补授权**;**前端只拿授权 + 上报,绝不直接发消息**。能力净新建:`getAccessToken`(stable_token 缓存)+ `subscribeMessage.send`(原生 fetch,镜像 `wechat.provider`)。

**同步发送避开 cron(§8)**:派发器在 **publish / producer 动作时点同步发送**,不引第二个 `@Cron`(避开 [`queue-b R-5`](queue-b-otp-birthday-infra-review.md))、不引队列。站内 = 纯 pull 零发送;定向推送 = 单收件人亚秒;广播推送被微信 quota 天然收窄。**唯一需异步的「全员短信群发」明确延后**,真出现时单独 D 档(人话简报),**本修订不引异步基建**。

**首切片 = 站内信**(基本照原 T0 T1–T4),但**一次建成「统一模块的站内渠道」形状**(`Notification` 自带 `audienceType`/`sourceType` 前向兼容列),**不返工**;随后微信 quota、producer 接入(含招新 S7)、短信兜底逐切片。

**footprint 量级(冻结预算,§9.5;落地实跑亲核)**:新表 **4**(`notifications` / `notification_reads` / `notification_deliveries` / `wechat_subscription_quotas`;+1 待拍板 `wechat_subscribe_templates`)· 权限码 **156 → ~161**· BizCode 310xx 段 + 25xxx 微信段扩 · 字典 `notification_type`· **模块 +0**(notifications 已存在,第 28 模块,扩 controller 非新模块)· **migration 第 27 起逐切片**· **cron +0 / queue +0 / 事件总线 +0**。

---

## 1. 现状基线重核(亲核 file:line,2026-06-25)

> 本章逐条**亲核**(runner 实读,非 grep 二手),并**纠正本 goal 背景与原 T0 的过时数字**(见末尾「亲核差异」)。

### 1.1 七项现状锚点

| 核查项 | 结论 | 证据 file:line |
|---|---|---|
| **notifications 模块** | 仅生日 cron:**无 controller / 无权限码 / 无 DTO**;imports `DatabaseModule + SmsModule`,providers 仅 `BirthdayGreetingService` | [`notifications.module.ts:17-20`](../../../src/modules/notifications/notifications.module.ts);模块 CLAUDE.md 自述「零端点/零权限码/零 DTO」 |
| **本仓唯一 `@Cron`** | `@Cron('0 0 9 * * *', Asia/Shanghai)`;`runOnce()` 唯一逻辑入口(薄壳直调可测);幂等查 `sms_send_logs` 当日同模板同号 SENT;FAILED 不重试不阻断;**不进 audit** | [`birthday-greeting.service.ts:51`](../../../src/modules/notifications/birthday-greeting.service.ts)(@Cron)/ `:61`(runOnce)/ `:107-118`(幂等) |
| **统一出口策略已显式延后** | 模块源码注释:「通知/推送的统一出口策略仍待 **Effect 真出现时决议**(architecture-boundary §3.6);后续新通知类型先回评审,不在本模块自由生长」 | [`notifications.module.ts:10-12`](../../../src/modules/notifications/notifications.module.ts) |
| **wechat 模块无订阅消息发送能力** | `WechatService` 仅 `code2session`;`WechatMiniProvider` 接口**仅** `code2session`;常量仅 `jscode2session` URL(**无 access_token / subscribe-send URL**)→ `getAccessToken` / `subscribeMessage.send` **净新建** | [`wechat.service.ts:49`](../../../src/modules/wechat/wechat.service.ts);[`wechat.types.ts:46-48`](../../../src/modules/wechat/wechat.types.ts);[`wechat.constants.ts:7`](../../../src/modules/wechat/wechat.constants.ts) |
| **wechat 凭证 + 外部请求范式可复用** | `appId` + 加密 `appSecret`(单段)经 `WechatSettingsService.getActiveSettings()`(singleton + 60s 缓存)取;真实 Provider 用**原生 fetch + `AbortSignal.timeout(8s)`**,**禁含 secret 的 URL/错误原文入日志** | [`wechat-settings.service.ts:67-91`](../../../src/modules/wechat/wechat-settings.service.ts)(:34 `CACHE_TTL_MS`);[`wechat.provider.ts:53-114`](../../../src/modules/wechat/providers/wechat.provider.ts)(fetch)/ `:118-133`(requireWechatContext 取 appId+appSecret) |
| **sms 渠道可复用面** | `SmsProviderRouter.{resolve, sendVerifyCode, sendBirthdayGreeting, resolveProviderType}`;`sms_send_logs` append-only + `maskPhone`;**同号日封顶 10 + 最小间隔 60s** | [`sms-provider.router.ts:39/60/65/73`](../../../src/modules/sms/sms-provider.router.ts);[`sms.constants.ts:16-19`](../../../src/modules/sms/sms.constants.ts)(`SMS_SEND_MIN_INTERVAL_SECONDS=60`/`SMS_PHONE_DAILY_LIMIT=10`)/ `:35`(`maskPhone`);[`sms-send-logs.service.ts:27-56`](../../../src/modules/sms/sms-send-logs.service.ts)(只读列表 + rbac.can + 掩码) |
| **content 可见性纯函数(定向复用)** | `canSeeContent(ctx,c)` 单条判定 + `buildVisibilityWhere(ctx)` list where(DB 过滤保分页)+ `CallerVisibilityContext` + `ANON_VISIBILITY_CONTEXT`;**5 档 public/member/formal_member/department/management** | [`content.visibility.ts:44`](../../../src/modules/content/content.visibility.ts)(canSee)/ `:72`(buildWhere)/ `:24`(ctx)/ `:36`(anon) |
| **cron 锁 R-5(关键约束)** | `@nestjs/schedule` 解锁范围**仅生日批一个 `@Cron`**;**新增任何定时任务 = 新 D 档评审**;单实例部署前提(多实例需先加分布式锁) | [`queue-b R-5`](queue-b-otp-birthday-infra-review.md)(§2 风险表 R-5)/ §6.8(单实例);模块 CLAUDE.md「不新增第二个 @Cron」 |
| **Effect 边界 §3.6(派发器归属)** | Effect = 业务动作触发**外部/延迟副作用**;「**notification dispatch**」列为 Effect 第一例;现「**Do not** introduce an Effect class until a real side-effect path exists(短信/推送/跨系统集成)」 | [`architecture-boundary.md:145-164`](../../architecture-boundary.md)(§3.6)/ `:206`(Effect deferred 行)/ `:212`(trigger:new notification side effect) |
| **原 T0 站内信设计(复用基线)** | `Notification` 广播 + `NotificationRead` 已读 + admin 8 端点(CRUD + publish/unpublish/archive)+ app 4 端点(list/detail/mark-read/unread-count)+ 5 RBAC 码 + BizCode 310xx 5 码 + `notification_type` 字典 4 项 | [`member-notification-review.md`](member-notification-review.md) §3–§7 |

### 1.2 亲核差异(纠正本 goal 背景与原 T0 的过时数字)

| 项 | 本 goal / 原 T0 所述 | 亲核当前事实 | 影响 |
|---|---|---|---|
| 模块计数 | 原 T0:「新增 notifications **第 29 模块**」「模块 +1」 | `src/modules/` **28 个目录**,`notifications/` **已在其中**(生日批) | 扩 controller = **模块 +0**(扩既有模块,非新建);§9.5 footprint 据此修正 |
| migration 计数 | 原 T0:「**第 24 个** migration」(v0.30.0 基线) | `prisma/migrations/` **26 个**(prisma/CLAUDE.md「累计 26」一致) | 站内渠道首个 migration = **第 27 个**起 |
| 权限码基线 | 原 T0:「**155 → 160**」(v0.30.0) | v0.31.0 = **156**(招新 S3 `read.sensitive` +1) | 站内 5 码 → **156 → 161**;§9.2 据此重算 |
| BizCode 31xxx 空闲 | 原 T0:`31xxx` 空闲 | **仍空闲**(`grep -nE "code: 31[0-9]{3}"` = ZERO HITS;`310/311` 未命名);wechat = 25xxx 段(`biz-code` 头索引 :40) | §9.3 站内 310xx + 微信渠道错误扩 25xxx 成立 |
| GAP-005 台账状态 | handoff `admin-web.md:86`:「提出(已确认要做,待出 goal)」 | 本修订即「出 goal」产物 | §三 pointer:台账行更新指向本修订评审稿 |

---

## 2. 统一通知架构 + 派发器(§2;核心张力解法)

**现状**:无任何通知架构([`notifications.module.ts:17-20`](../../../src/modules/notifications/notifications.module.ts) 仅生日批);Effect 类「deferred」([`architecture-boundary.md:206`](../../architecture-boundary.md))。

**目标设计**:三层 —— **producer 层 → 通知记录层 → 派发器(Effect)→ 渠道层**。

```
┌─ producer(招新/活动/考勤/admin 撰写)
│   只创建「通知记录」(Notification 行)+ 声明目标渠道,绝不自己发
│
├─ 通知记录层
│   Notification(广播 | 定向 二合一)
│     ├─ NotificationRead       站内已读拉取(不 fan-out)
│     └─ NotificationDelivery   推送渠道 per-recipient 投递态(仅微信/短信)
│
├─ NotificationDispatcher  ◀── architecture-boundary §3.6 的首个真实 Effect
│   渠道编排(§7)+ 同步发送(§8)+ 失败记录(§3/§4)
│
└─ 渠道层
    ├─ 站内(in-app)   = 广播+已读 pull(复用原 T0,§5)
    ├─ 微信订阅(wechat) = quota 机制(§3,净新建)
    └─ 短信(sms)       = SmsProviderRouter(§4,紧急兜底延后)
```

### 2.1 关键张力解法 ★(数据模型:广播 vs per-recipient)

> goal 点名必须解决、必须给「明确可执行」方案(非「待定」)的核心张力。

**张力**:站内信原 T0 刻意是「**广播 1 行 + 已读 pull**」(数百队员**不 fan-out**,见原 T0 §2 ②:fan-out 是过度工程);但微信/短信是「**按收件人 + 配额/计费**」推送,**必须有 per-recipient 投递态 + 失败追踪**——否则无从知道「这条微信推给张三成没成」「该不该让张三补授权」。

**解法 = 混合三表,fan-out 只发生在推送渠道**:

| 表 | 形态 | 是否 fan-out | 服务谁 |
|---|---|---|---|
| `Notification`(广播+定向) | **广播**:1 行 + `visibilityCode`/`visibleOrganizationIds`(可见档定向);**定向**:1 行 + `recipientMemberId`(producer 给单个收件人) | **否**(广播 1 行;定向天然 1 行) | 所有通知的主记录 + 状态机 + 审计锚 |
| `NotificationRead`(站内已读) | `notificationId × memberId` append-once(复用原 T0) | **否**(只在某会员读过才有 1 行;feed = 广播可见 ∪ 本人定向,LEFT JOIN 取 read 标志) | **站内渠道**已读/未读红点 |
| `NotificationDelivery`(推送投递) | `notificationId × channel × 收件人ref(memberId + openid/phone)× status(pending/sent/failed/skipped)+ providerMsgId + errCode + attemptedAt` | **是,但仅推送渠道**:定向推送 = 1 行;广播推送 = N 行(紧急短信,延后+闸控) | **微信/短信**投递态 + 失败追踪 + quota 扣减留痕 |

**为何成立**:
1. **站内永不 fan-out** —— 广播 1 行靠可见性过滤覆盖「全员/部门/级别」(复用 `content.visibility`,§5),定向 1 行直挂收件人;数百队员 × 数百通知仍是线性行数,无写放大。
2. **per-recipient 只在「本就 per-recipient」的推送渠道出现** —— 微信投递成败是**每 openid 一个事实**,不落 `NotificationDelivery` 就无处记;且微信被 quota 天然收窄(只推已 ack 订阅者,远少于全员),短信广播(全员)= 唯一真 N 行场景,**显式延后 + 计费闸**(§4)。
3. **同一 `Notification` 行串起三表** —— 广播/定向共用状态机(draft→published→archived)、审计、读取面骨架(`audienceType` 二分,D-N9);避免「广播一套表、定向一套表」的重复。

**结论**:**站内保持广播+pull(不 fan-out);per-recipient 物化只在 `NotificationDelivery`、只为推送渠道、且微信场景被 quota 收窄、短信全员场景延后**。这正是 goal 要的「避免过度工程 + 让微信/短信有投递态 + 失败追踪」。

### 2.2 派发器形式化为 Effect(§3.6)

**现状**:`architecture-boundary.md:206` 标 Effect「deferred(`eventPlaceholder` 占位)」,`:164` 明文「真实副作用路径出现前不引入 Effect 类」。**本修订即该真实路径**(微信/短信推送 = 外部 API 副作用)→ `NotificationDispatcher` **正式落为首个 `*effect`/dispatcher 类**(模块内,`src/modules/notifications/`)。

**Dispatcher 应含**(§3.6「Should contain」):通知派发 / 外部 API 调用(微信/短信)/ 渠道 payload 组装 / 投递记录。**不应含**(§3.6「Should not contain」):核心状态跃迁决策(留 service/StateMachine)/ 主 DB 事务所有权(留 producer service)/ DTO 呈现。**外部 HTTP 调用一律在 producer 业务事务之外**(§6.2),不让 8s HTTP 拖住事务。

**风险/兼容**:Dispatcher 是新增类,不改任何既有 service 行为;落地需先有 characterization 覆盖(§3.6 末「characterization-tests-before-refactor」)——但这里是**新建非抽离**,以新 unit/e2e 覆盖即可。

---

## 3. 微信订阅消息 quota 机制(§3;本修订核心,净新建)

**现状**:wechat 模块**无任何发送能力**([`wechat.types.ts:46-48`](../../../src/modules/wechat/wechat.types.ts) 接口仅 `code2session`;[`wechat.constants.ts:7`](../../../src/modules/wechat/wechat.constants.ts) 仅登录 URL)。凭证(appId + 加密 appSecret)与原生 fetch 范式**已就绪可复用**([`wechat.provider.ts:53-133`](../../../src/modules/wechat/providers/wechat.provider.ts))。

**目标设计(五件套)**:

### 3.1 微信 subscribe-send 能力(净新建,镜像 `wechat.provider`)

| 能力 | 设计 | 关键点 |
|---|---|---|
| `getAccessToken()` | 调微信 **`/cgi-bin/stable_token`**(POST appid+secret)取 access_token;**进程内缓存 ~7000s**(7200s 过期前刷新),复用 `WechatSettingsService` 取 appId+appSecret | **推荐 stable_token 而非 legacy `/cgi-bin/token`**——后者新 token 使旧失效,多 token 调用方互踩;stable_token 不互斥。**单实例缓存前提**(镜像生日批 E-B12 / wechat 60s 缓存);多实例横向扩容前需共享缓存(挂边界条款,沿 R-5/E-B12) |
| `subscribeMessage.send(openid, templateId, data, page?)` | POST `/cgi-bin/message/subscribe/send?access_token=...`;**原生 fetch + `AbortSignal.timeout(8s)`**;**禁含 access_token 的 URL/错误原文入日志**(镜像 [`wechat.provider.ts:64-95`](../../../src/modules/wechat/providers/wechat.provider.ts) E-12 纪律) | 失败码语义见 §3.4;零新依赖(Node 22 全局 fetch) |

**新 Provider 接口扩展**:`WechatMiniProvider` 加 `getAccessToken` / `sendSubscribeMessage`(DevStub 返确定性假回执供 e2e;production-like 禁 DevStub 双重校验沿 [`wechat.service.ts:75-80`](../../../src/modules/wechat/wechat.service.ts) E-15)。

### 3.2 quota 模型(`wechat_subscription_quotas` 表)

```
(memberId × templateId) → availableCount Int (≥0)   @@unique([memberId, templateId])
```

- **并发安全 +1**(ack):`upsert` + `{ availableCount: { increment: 1 } }`(配 D-N2 上限:`update ... where availableCount < cap`,达上限 no-op)。
- **并发安全 -1**(发送):**条件原子扣减** `updateMany({ where: { memberId, templateId, availableCount: { gt: 0 } }, data: { availableCount: { decrement: 1 } } })`;**`count === 1` 才视为扣减成功并发送**(`count === 0` = 无配额,不发、记 skipped)。杜绝越扣为负 / 双花。
- 按 `memberId`(非 openid)存 —— openid 可换绑(招新 S4a rebind-wechat),memberId 稳定;发送时经 member→user→openid 现取。

### 3.3 ack 端点(app 侧上报授权 → quota +1)

| 端点 | 鉴权 | 入参 | 行为 |
|---|---|---|---|
| `POST /api/app/v1/notifications/subscriptions/ack` | canUseApp 闸(无码) | `{ templateIds: string[] }`(本次 `wx.requestSubscribeMessage` 用户**接受**的模板) | 逐模板 quota +1(封顶 D-N2);返各模板新 availableCount |
| `GET /api/app/v1/notifications/subscriptions/status` | canUseApp 闸(无码) | `?templateIds=` | 返各模板 availableCount,**供前端判断是否需补授权** |

- **幂等口径(诚实标注)**:微信**不给授权回执 ID**,每次 `wx.requestSubscribeMessage` 接受 = 一次真实新授权(可累积)→ ack **本质 additive、非去重幂等**;**滥刷风险**靠 D-N2 上限封顶 + **前端只在真授权后 ack** 缓解。此为微信机制固有,doc 据实记,不假装幂等。
- **前端只拿授权 + 上报,绝不直接发消息**(goal 输入②);发送权全在后端。

### 3.4 发送扣减 + 失败记录 + 补授权信号

派发器微信分支(§7),对每个目标 member:
1. 取 openid(member→user.openid;无 openid → skipped`no-openid`);
2. 原子扣减 quota(§3.2;`count===0` → skipped`no-quota` → **回「补授权」信号**);
3. 扣减成功 → `getAccessToken` → `sendSubscribeMessage` → 写 `NotificationDelivery`(sent / failed + errCode);
4. **失败码语义**:

| 微信码 | 含义 | 处理 |
|---|---|---|
| `43101` | 用户拒收/无授权额度 | delivery failed `need-resubscribe` → **前端据 status 端点提示补授权**(quota 已扣需回补?见下) |
| `40001/42001` | access_token 失效/过期 | 刷新 token **重试一次**(非业务重试,token 层);仍败 → failed |
| `40003` | openid 非法 | failed `invalid-openid`(不补授权) |
| `47003` | 模板参数不匹配 | failed `template-param`(运维/开发修模板映射) |

- **扣减与发送的一致性**:推荐「**先扣后发,发送明确失败(43101)即回补 quota +1**」(条件回补,避免无谓损耗用户授权);token 类失败(40001)重试覆盖,不回补。**回补政策列 D-N7 关联**。
- **不自动重试**(D-N7;镜像生日批 FAILED 不重试不阻断 [`birthday-greeting.service.ts:143-158`](../../../src/modules/notifications/birthday-greeting.service.ts)):一条失败记 delivery,继续下一人。

### 3.5 模板管理(notificationType ↔ 微信模板 ID + 字段映射)

- **推荐(D-N3)**:**模板 ID 运营可配** —— `wechat_subscribe_templates` 配置表(`notificationTypeCode → templateId, enabled`)或扩 `wechat_settings`(镜像 `sms_settings.templateIdBirthday` 把模板 ID 存 settings 的先例);**字段映射(payload 字段 → 微信 `data` key)内置代码**(绑 payload 构造,随类型固定)。
- 理由:模板 ID 随小程序后台审批变,运营改不该重部署;字段映射是代码契约,不该让运营碰。

**风险/兼容**:微信 token/openid/secret 属 L3 红线面 —— 全程沿 [`wechat.provider.ts`](../../../src/modules/wechat/providers/wechat.provider.ts) E-12(禁 secret URL 入日志)+ `maskOpenid`([`wechat.constants.ts:24`](../../../src/modules/wechat/wechat.constants.ts));quota 表仅 `memberId + templateId + count`,非敏感。subscribe-send 走 `srvf-auth-security`(微信 token/openid)规则。

---

## 4. 短信渠道(§4;复用 sms 基建,紧急兜底延后)

**现状**:`SmsProviderRouter` + `sms_send_logs` + 同号封顶 10/间隔 60s **已就绪**([`sms-provider.router.ts:39-78`](../../../src/modules/sms/sms-provider.router.ts);[`sms.constants.ts:16-19`](../../../src/modules/sms/sms.constants.ts));生日批已是「逐人单发 + 幂等 + FAILED 不阻断」的范式([`birthday-greeting.service.ts:105-159`](../../../src/modules/notifications/birthday-greeting.service.ts))。

**目标设计**:派发器短信分支复用 `SmsProviderRouter`(新增 `sendNotification` 或泛化 send;模板 ID 存 settings,镜像 `templateIdBirthday`);每收件人写 `NotificationDelivery` + `sms_send_logs`;**自动继承**同号日封顶 10 + 间隔 60s + `maskPhone`。

**何时走短信 / 群发计费口径(D-N4/D-N8)**:
- **推荐:短信仅「紧急召集兜底」**,且**站内 + 微信优先**,短信由 admin **显式发起**(不默认、不强制);
- **群发计费**:每收件人 = 1 条计费短信 → **全员群发 = 真实资费 + 须显式确认**(镜像原 T0 §8「群发须显式确认计费口径」);**防重发**沿同号封顶 + 同日同模板查 `sms_send_logs`(镜像生日批幂等 [`birthday-greeting.service.ts:107-118`](../../../src/modules/notifications/birthday-greeting.service.ts));
- **全员短信群发若做成批处理 = 唯一可能触碰 R-5 的场景** → **明确延后为末位切片**(§11 Slice 5),真立项时单独 D 档评审(§8)。

**风险/兼容**:短信资费 + L2 手机号面 —— 响应/日志一律 `maskPhone`;紧急召集延后保证首批零短信成本(镜像原 T0 ①推荐)。

---

## 5. 站内渠道(§5;复用原 T0 冻结设计)

**现状**:无站内信面([`notifications.module.ts`](../../../src/modules/notifications/notifications.module.ts) 零 controller)。

**目标设计 = 原 T0 [`member-notification-review.md`](member-notification-review.md) §3–§7 整体复用为「统一模块的站内渠道」**,标注复用/微调点:

| 原 T0 资产 | 复用 | 本修订微调 |
|---|---|---|
| `Notification` 主表(状态机 draft/published/archived + 可见性 4 档 + `visibleOrganizationIds` + `readCount` + pinned + publishedAt + authorUserId 无 FK)| **复用**(原 T0 §3) | **加 `audienceType`(broadcast/directed)+ `sourceType`(admin/system)前向兼容列**(D-N1/D-N9;首切片即加,定向列 `recipientMemberId` 后续 additive,§11 不返工)+ `channels` 声明目标渠道 |
| `NotificationRead`(notificationId×memberId append-once plain unique)| **复用**(原 T0 §3) | feed 查询扩为「广播可见 ∪ 本人定向」(§2.1) |
| admin 8 端点(CRUD + publish/unpublish/archive)| **复用**(原 T0 §6) | publish = 站内即时可见 + **触发派发器**派其它渠道(§7) |
| app 4 端点(list/detail/mark-read/unread-count)| **复用**(原 T0 §7) | 列表项含定向通知;`unread-count` 字面段路由须先于 `:id`(原 T0 §7 注意) |
| 可见性纯函数 | **复用** `content.visibility`(去 public = 4 档,原 T0 ⑤)| [`content.visibility.ts:44/72`](../../../src/modules/content/content.visibility.ts) |
| 5 RBAC 码 / 310xx BizCode / `notification_type` 字典 / audit 4 事件 | **复用**(原 T0 §4/§5/§2⑩)| §9 据 v0.31.0 基线重算计数 |

**关键**:首切片**一次建成统一形状**(`audienceType`/`sourceType` 列),后续微信/producer 切片只 **additive** 加列加表,**站内渠道零返工**(§11 自证)。

**风险/兼容**:站内渠道行为 = 原 T0 风险表(纯新增、无破坏、回退 = drop 表);本修订仅多 2 列 + feed 查询含定向,不改原 T0 已冻结的状态机/可见性语义。

---

## 6. producer 接入(§6;只创建任务,不自建出口)

**现状**:producer 无通知能力;招新 §9 已登记「触发点 + payload 契约,但**不自建出口/Effect**」([`recruitment-phase4-loop-optimization-review.md`](recruitment-phase4-loop-optimization-review.md) §9.2 / Q-P4-11)。

### 6.1 producer 调用方式(同步 service vs 事件)

| 方案 | 说明 | 取舍 |
|---|---|---|
| **A 同步 service 直调(✅ 推荐 D-N5)** | producer 注入 `NotificationDispatcher`,业务动作后**直调** `dispatch(notificationDraft)`;dispatcher 建 `Notification` 行 + 派渠道 | **本仓无事件总线**、仅 `eventPlaceholder`([`architecture-boundary.md:163`](../../architecture-boundary.md));直调**显式、简单、AI 友好**(对齐本仓「简单显式强约束」价值);防环靠单向依赖 |
| B 事件总线 | producer emit 事件,dispatcher 订阅 | **需自建事件总线 = 架构级既成事实,禁区明令不可**;解耦收益在本仓规模不抵新基建成本 |

→ **推荐 A**。`NotificationDispatcher` 由 `NotificationsModule` 导出,producer 模块 import(单向 `producer → notifications`)。

### 6.2 事务边界(producer 业务事务内/外)

- **`Notification` 行(站内)**:可在 producer 业务事务**内**写(与业务原子,推荐),或 commit 后写(弱一致可接受);
- **推送外部调用(微信/短信 HTTP)**:**必须在业务事务之外**(commit 后)—— 8s HTTP 不可拖住 DB 事务([`architecture-boundary.md:158`](../../architecture-boundary.md) Effect「不持有主事务」);失败记 `NotificationDelivery`,不回滚已 commit 的业务;
- **推荐**:producer 事务内写业务 + `Notification` 行 → commit → dispatcher **commit 后**派推送渠道(fire-and-forget,失败落 delivery)。

### 6.3 防环

单向 `producer → notifications`;**notifications 永不回调 producer**;dispatcher 不因「发通知」再触发新通知。

### 6.4 招新 S7 触发点挂接(承接招新 §9)

招新 §9 的 **6 触发点**作为 `sourceType='system'` 的**定向通知**接入(`recipientMemberId` = 申请人对应 member;`producerModule='recruitment'`):

| 招新触发(§9.1)| 通知形态 | 渠道倾向 | payload 要素 |
|---|---|---|---|
| 报名受理(发临时号)| 定向 system | 站内 + 微信(若 quota)| tempNo / cycleName / 下一步 |
| 转人工 / 人工结果 | 定向 system | 站内 | stage / reason(脱敏)|
| 门槛进度 / 门槛齐 | 定向 system | 站内 | todoList 完成度 |
| 综合评定 / 公示开始 | 定向 system | 站内 | stage / 公示链接 |
| 发号(已转志愿者)| 定向 system | 站内 + 微信 | memberNo / 入队入口 |
| 入队结果 | 定向 system | 站内 | 部门 / 级别 |

- **挂接 = 招新 producer 直调 dispatcher**(§6.1 A);**本修订只给契约**,招新 S7 落地时另出 per-feature goal(招新 §9.2 排期:S7 前置 = 本模块发版);
- **D-N1 放宽触发方式**正是为此:原 T0 ⑧「纯手动」放宽为 admin 手动广播 + producer 系统自动定向(招新 §9.2 已预判「可能需把触发方式 ⑧ 从纯手动放宽」)。

**风险/兼容**:producer 接入零改 producer 既有业务行为(只多一个 commit 后 dispatch 调用);防环 + 事务外推送是硬约束(实施期破坏即停)。

---

## 7. 渠道选择 / 编排 + 去重(§7)

**现状**:无编排逻辑。

**目标设计(dispatcher 渠道选择,D-N4)**:

| 渠道 | 何时发 | 去重 |
|---|---|---|
| **站内(恒发)** | 每条通知**必建** `Notification` 行(广播或定向)| 一条通知 = 一条站内记录;mark-read 幂等(原 T0 §7)|
| **微信(机会式)** | 通知声明含 wechat **且**收件人有 quota(已 ack 订阅)→ 推;无 quota → skipped + 补授权信号 | `NotificationDelivery(通知×wechat×收件人)` 唯一 → 不重复推 |
| **短信(紧急兜底)** | 仅声明含 sms(紧急召集,admin 显式;延后切片)| `NotificationDelivery(通知×sms×收件人)` + 同号封顶 |

**编排逻辑**:`Notification.channels`(如 `['in-app']` / `['in-app','wechat']`)声明目标;dispatcher 按声明逐渠道发;**同一通知多渠道不重复打扰** —— 站内 1 条 + 微信至多 1 推 + 短信至多 1 发,各渠道 `NotificationDelivery` 唯一键去重。**默认编排**:admin 广播默认 `['in-app']`(可勾微信);producer 定向按 §6.4 渠道倾向。

**风险/兼容**:渠道声明是 `Notification` 列(additive);编排纯函数可单测;无跨渠道重复(唯一键保证)。

---

## 8. cron / Effect / 防滥发(§8;同步发送避开 cron-lock)

**现状**:本仓唯一 `@Cron` = 生日批([`birthday-greeting.service.ts:51`](../../../src/modules/notifications/birthday-greeting.service.ts));R-5「新 @Cron = 新 D 档」([`queue-b R-5`](queue-b-otp-birthday-infra-review.md));单实例前提(§6.8)。

### 8.1 同步发送方案(避开 R-5;架构判断 ★)

> goal 点名要明确判断「同步发送(publish/动作时点批量发,数百量级)避开 cron-lock 是否成立」。

**方案:派发器在 publish / producer 动作时点同步发送,不引第二个 `@Cron`、不引队列。**

**成立性论证**:
1. **站内 = 纯 pull,零发送** —— publish 只写 `Notification` 行,会员拉取消费,**无任何 per-recipient 发送动作**(原 T0 ①推荐的零 cron 性质);
2. **定向推送 = 单收件人** —— producer 触发的微信/短信是**给一个 member**,1 次 HTTP(8s 上限),亚秒级,落在 producer commit 后的 Effect 内,**无批量**;
3. **广播推送被 quota 天然收窄** —— admin 广播勾微信时,只推**已 ack 订阅**的收件人(§3),实际量 ≪ 全员;数百量级里有微信 quota 的子集同步发,可接受;
4. **唯一真正的「全员同步发」= 短信全员群发** —— 这是**唯一**可能需要异步/批处理的场景,**已明确延后**(§4 / §11 Slice 5);**本修订不引入它**。

**结论:同步发送对本修订设计范围成立,无需任何异步基建,不触碰 R-5。** 仅当未来「全员短信群发」真立项,**那一个切片**单独触发 cron/queue 的 D 档评审(届时人话简报);**本修订据此不自建 cron/队列/事件总线**(禁区遵守)。

### 8.2 Effect 边界

`NotificationDispatcher` = §3.6 首个真实 Effect 类(§2.2);外部 HTTP 在事务外(§6.2);**no-cron 解锁范围不变**(仍仅生日批一个 @Cron;本模块零新 @Cron)。

### 8.3 防滥发

| 渠道 | 防滥发 |
|---|---|
| 站内 | RBAC 闸(admin 持 `notification.publish.record` 才能广播)+ 每 publish 入 audit(原 T0 ⑩);**无新限流**(原 T0 ⑨)|
| 微信 | **quota 天然限频**(只推已订阅 + 封顶 D-N2)+ 失败不重试 |
| 短信 | **既有同号封顶 10 + 间隔 60s + 同模板同日幂等**(自动继承,§4)|

**风险/兼容**:同步发送的延迟风险仅在「广播勾微信、订阅者多」时;以「订阅者子集 + 8s 单调用 + 失败落 delivery 不阻断」为界;若实测延迟超阈再评估(挂 NEXT_TASKS 观察,沿原 T0 性能观察先例)。**不引异步基建是冻结决策**,变更须维护者拍。

---

## 9. schema / RBAC / BizCode / 字典 delta(§9;冻结预算)

> 草案侧走 `srvf-prisma-change`(D 档);**本稿不落 migration / 不改 seed**。计数以 **v0.31.0 基线**(亲核 §1.2)。

### 9.1 schema 草案(逐切片;镜像原 T0 §3 + 净新增推送/quota 表)

```prisma
// 切片 1(站内):复用原 T0 两表 + 统一形状前向兼容列
model Notification {
  // ... 原 T0 §3 全部字段(title/body/notificationTypeCode/statusCode/visibilityCode/
  //     visibleOrganizationIds/readCount/pinned/publishedAt/authorUserId/软删/索引集)
  audienceType    String   @default("broadcast") // broadcast | directed(D-N9)
  sourceType      String   @default("admin")     // admin | system(D-N1)
  channels        String[] @default(["in-app"])  // 目标渠道声明(§7)
  recipientMemberId String?                       // 定向收件人(切片 3 additive;广播为 null)
  producerModule  String?                         // system 来源(recruitment/activity/...;追溯)
  reads     NotificationRead[]
  deliveries NotificationDelivery[]               // 切片 2 起
  // @@index([audienceType, recipientMemberId]) 定向 feed
}
model NotificationRead { /* 原 T0 §3 整体复用,plain unique([notificationId, memberId]) */ }

// 切片 2(微信):推送投递 + quota
model NotificationDelivery {
  id String @id @default(cuid())
  createdAt DateTime @default(now())
  notificationId String
  channel        String   // wechat | sms
  memberId       String
  recipientRef   String   // openid(掩码存?明文存掩码回显)/ phone(掩码回显)
  status         String   // pending | sent | failed | skipped
  reasonCode     String?  // no-quota / no-openid / need-resubscribe / template-param / ...
  providerMsgId  String?
  errCode        String?
  attemptedAt    DateTime?
  notification Notification @relation(fields: [notificationId], references: [id], onDelete: Restrict)
  @@index([notificationId]) @@index([memberId, channel]) @@index([status])
  @@map("notification_deliveries")
}
model WechatSubscriptionQuota {
  id String @id @default(cuid())
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  memberId       String
  templateId     String
  availableCount Int    @default(0)
  @@unique([memberId, templateId])
  @@index([memberId])
  @@map("wechat_subscription_quotas")
}
// 待拍板 D-N3:wechat_subscribe_templates(notificationTypeCode → templateId, enabled)或扩 wechat_settings
```

- FK 全 `onDelete: Restrict`(沿仓内惯例);`NotificationRead`/`NotificationDelivery` append 语义(read 无软删 plain unique;delivery 是流水,沿 `sms_send_logs` append-only);
- **migration 切片化**:切片 1 = `notifications` + `notification_reads`(**第 27**);切片 2 = `notification_deliveries` + `wechat_subscription_quotas`(+ 模板表/列);切片 3 = `Notification.recipientMemberId` 等 additive 列。**全纯新增/additive,无破坏、无回填、无 enum 迁移**。

### 9.2 RBAC(基线 156)

- **站内 5 码**(复用原 T0 §4):`notification.{read,create,update,delete,publish}.record`,全绑 biz-admin → **156 → 161**;
- **微信渠道**:ack/status 端点 = app 侧 canUseApp 闸**零码**(沿原 T0 app 面);**模板配置**(若 admin 端,D-N3)= 至多 +1 码(`notification.config.template` 或归 settings 既有码,待 §10);
- **短信兜底**(延后):紧急群发触发可复用 `notification.publish.record` 或新开 `notification.send.sms`,延后切片定;
- 守护脚本(`seed-biz-admin.e2e` 期望清单 + `docs:rbacmap:check`)逐切片 true-up(沿 content/招新计数同步惯例)。

### 9.3 BizCode(31xxx 站内段空闲已核;wechat = 25xxx 段)

| 段 | 码 | 落点 |
|---|---|---|
| **310xx**(站内,复用原 T0 §5)| 31001 NOT_FOUND / 31010 TYPE_INVALID / 31011 VISIBILITY_INVALID / 31012 VISIBLE_ORG_INVALID / 31030 INVALID_STATUS_TRANSITION | 站内 CRUD/状态机 |
| **312xx**(派发/quota,本修订新)| 如 312xx QUOTA_*(无配额扣减失败语义)/ 派发参数错 | 切片 2 |
| **25xxx**(wechat 段扩,沿 [`biz-code` 头 :40](../../../src/common/exceptions/biz-code.constant.ts))| 微信 subscribe-send 通道错误(token/send 失败,类比登录 25030/25031)| 切片 2 |

- **不开 311xx FORBIDDEN_***(权限拒绝走通用 30100,沿 baseline);
- **红区(baseline §1.1)只读核查不触碰**;落地时按切片在 `biz-code.constant.ts` + baseline 段位表加行(逐行进 PR,沿原 T0 §5.3 / #294 范式)。

### 9.4 字典

- `notification_type`(复用原 T0:activity-reminder/recruitment/emergency/general;**可按招新 §9 六触发 + 活动/考勤细化**,label 待运营,镜像 [`seed.ts:295`](../../../prisma/seed.ts) `content_type` 结构);
- **渠道 = 代码常量**(in-app/wechat/sms),**不入字典**(渠道是工程枚举,非运营可配业务字典)。

### 9.5 冻结预算表(落地实跑亲核为准)

| 维度 | 增量 | 落点 |
|---|---|---|
| 新表 | **4 必需 + 1 待拍板** | `notifications`/`notification_reads`(切片1)+ `notification_deliveries`/`wechat_subscription_quotas`(切片2)+ 模板表(D-N3 待拍板)|
| migration | **第 27 起逐切片**(切片1 一个 / 切片2 一个 / 切片3 additive)| 纯新增/additive,无破坏无回填无 enum |
| 权限码 | **156 → ~161**(站内 5)+ 至多 +1(模板配置,待拍板)| 全绑 biz-admin |
| BizCode | 310xx 站内 5(复用)+ 312xx 派发/quota + 25xxx 微信扩 | 逐切片落 |
| 字典 | `notification_type`(+items)| label 待运营 |
| 模块 | **+0**(notifications 第 28 模块已存在,扩 controller)| 亲核 §1.2 |
| controller | +2(NotificationAdmin + NotificationApp)| 微信能力扩 wechat 模块 Provider/Service |
| cron / queue / 事件总线 | **+0 / +0 / +0** | §8 同步发送 |

---

## 10. 决策清单(§10;待维护者拍板,每条带推荐)

### 10.1 原 T0 残留 5 项(沿原 T0 推荐,站内渠道复用)

| # | 待拍板 | 沿原 T0 推荐 |
|---|---|---|
| ③ 定向范围 | 复用 content 可见性 4 档(member/formal_member/department/management);活动参与者定向延后 |
| ④ 已读状态 | 做(`NotificationRead` + 未读红点)——站内信核心 |
| ⑤ 会员准入/可见性 | 复用 canUseApp + 4 档(去 public)|
| ①/⑧ 渠道/触发 | **已被本修订更新** → 见 D-N1(触发放宽)+ D-N4(多渠道编排)|

### 10.2 本修订新增(D-N 系,详见顶部 ⚠️ 清单)

D-N1 触发放宽 ✅ / D-N2 quota 上限 5 / D-N3 模板运营可配+映射内置 / D-N4 站内恒发+微信机会+短信兜底延后 / D-N5 producer 同步直调 / D-N6 delivery 仅推送渠道 per-recipient / D-N7 不自动重试+微信补授权 / D-N8 紧急不强制短信 / D-N9 广播定向同表。**每条带推荐 + 一句话理由(顶部表)**;可一句「按推荐」全收。

---

## 11. 分档实施路线图(§11;有序切片,首片 = 站内不返工)

| 切片 | 内容 | 档 | 依赖/前置 | schema | 端点 | RBAC |
|---|---|---|---|---|---|---|
| **S1**(首推)| **站内信渠道**(= 原 T0 T1–T4,但建成统一形状:`Notification` 含 `audienceType`/`sourceType`/`channels` + `NotificationRead`)| **D→C→A** | 无 | 2 表(第 27 migration)| admin 8 + app 4 | +5(站内,156→161)|
| **S2** | **微信 quota 渠道**(subscribe-send 能力 + `NotificationDelivery` + `wechat_subscription_quotas` + ack/status 端点 + 模板配置 + 派发器微信分支)| **D** | S1 | +2~3 表 | +2 app(ack/status)| 0~+1(模板配置)|
| **S3** | **producer 接入 + 派发器 Effect 正式化**(`NotificationDispatcher` Effect 类 + `Notification.recipientMemberId` additive + 招新 S7 六触发挂接)| **C/D** | S1+S2;**招新 S7 另出 goal** | additive 列 | 0(producer 内调)| 0 |
| **S4** | **活动 / 考勤 producer 触发**(活动发布提醒 / 考勤结果等定向通知)| **C** | S3 | 0 | 0 | 0 |
| **S5** | **短信兜底渠道**(紧急召集;复用 `SmsProviderRouter` + 显式计费确认 + 同号防重)| **D** | S1;**全员群发若批处理 → 单独 R-5 D 档** | 0~小 | +1 admin(显式发起)| +0~1 |

- **S1 不返工自证**:`audienceType`/`sourceType`/`channels` 首切片即加,后续定向/推送只 additive 加列加表,站内渠道状态机/可见性/已读语义零改;
- **每片实施前另出 per-feature goal**,拍板对应 D-N* 后方动工;**招新 S7 = S3 的子项,前置本模块 S1+S2 发版**(招新 §9.2 排期);
- **残余待拍板**:全员短信群发异步基建(S5 若批处理)、活动参与者定向(原 T0 ③-B)、退订/通知偏好、已读名单明细 —— 真诉求触发再立项。

---

## 12. 风险表(D 档降速)

| 项 | 结论 |
|---|---|
| 是否改 `prisma/schema.prisma` | ✅ 逐切片(S1 两表 + S2 推送/quota 表 + S3 additive 列);**纯新增/additive,无破坏无回填无 enum 迁移** |
| 是否新增 migration | ✅ 第 27 起逐切片;干净库重放 + `migrate diff` 零漂移 + seed 幂等二跑(srvf-prisma-change)|
| 是否新增 cron / 定时任务 | ❌(**§8 同步发送**;no-cron 解锁范围仍仅生日批;全员短信群发若批处理 → 单独 R-5 D 档,延后)|
| 是否新增队列 / 事件总线 | ❌(producer 同步直调 D-N5;禁作既成事实)|
| 是否引入新外部出口 | ✅ **微信 subscribe-send**(L3 token/openid 面;沿 wechat E-12 纪律 + maskOpenid)+ 短信(复用)|
| 是否影响 OpenAPI / contract | ✅ 逐切片 +端点(站内 12 + 微信 2 + 短信 1);仅新增零删改;微信 token/secret 零出参 |
| 是否影响鉴权 / Permission seed / 审计 | ✅ 权限码 156→~161;audit +N(站内 4 复用原 T0 + 推送动作是否入 audit 见 §13)|
| 是否新增 BizCode | ✅ 310xx 站内 + 312xx 派发/quota + 25xxx 微信扩;baseline §1.1 红区加行(逐切片逐行 PR)|
| 是否需要用户拍板 | ✅ **D-N1~D-N9 + 原 T0 残留**(§10);架构骨架本稿代决冻结 |
| 用户可见行为变化 | admin 多「通知管理」+ 渠道勾选;会员 app 多站内信 feed + 微信订阅提示;招新/活动节点收到定向通知。**既有生日批 / content / sms / wechat 登录 / 其余模块零行为漂移** |
| 回退 | drop 新表 + 删 Provider 能力 + seed 增量 + controller;纯新增模块,无副作用 |

**既有行为锁(实施期任一破坏 = 停 + 人话简报)**:① 生日批 cron / `sms_send_logs` / `@Cron` 唯一性零碰;② wechat 登录 `code2session` 零碰(仅扩 Provider 能力);③ content/sms/insurance/招新 既有行为零 diff;④ auth/JwtPayload/throttler/Guard 链零碰;⑤ no-cron 解锁范围不扩(零新 @Cron);⑥ 微信 token/secret/openid 零出参零明文入日志(L3)。

---

## 13. 敏感字段三问(AGENTS §18.4)

1. **业务用途**:通知正文 = 运营/系统向队员的触达文案;`NotificationDelivery` = 推送投递留痕(运营看成败 + 失败补授权);`WechatSubscriptionQuota` = 订阅授权额度。
2. **查看角色**:admin 撰写/投递面 = 持 `notification.*` 的 biz-admin(响应 openid/phone 掩码);会员读取面 = canUseApp。**L3 面 = 微信 access_token / appSecret / openid**(沿 wechat E-12:token/secret 永不入日志/出参/audit;openid `maskOpenid` 回显);**L2 = phone**(`maskPhone`)。通知正文是广播文案非 PII。**推送动作是否入 audit**:沿原 T0 ⑩ + 生日批口径——**admin 撰写/publish 入 audit;系统自动定向 + 会员阅读 + 逐条投递不入 audit**(`NotificationDelivery` 流水足够,镜像 `sms_send_logs` 不入 audit,[`queue-b §6.7`](queue-b-otp-birthday-infra-review.md))。
3. **保存期限**:`Notification` 软删保留;`NotificationRead` append-once;`NotificationDelivery`/`WechatSubscriptionQuota` 流水/状态(retention 沿 sms SOP 手动清思路,**不解锁 cron**);audit 沿既有。

---

## 14. 授权与红线(本评审 T0 修订)

- **授权(本评审稿,A 档 docs-only)**:read-only 调研全仓;**仅新增** `docs/archive/reviews/unified-notification-dispatcher-review.md` 一个文件;**允许**在 [`docs/handoff/admin-web.md`](../../handoff/admin-web.md) §4 GAP-005 台账加 1 行指针(指向本修订);走 [`process §7.1`](../../process.md) 循环。
- **本评审禁区(已遵守)**:**未**改 `src/**` / `prisma/**`(schema/migration/seed)/ `test/**` / RBAC 码 / enum / 端点;**未**跑 migration;**未**回改原 T0 冻结档([`member-notification-review.md`](member-notification-review.md));产品决策只给推荐未替决;**未**自建 cron/队列/事件总线;红区(baseline §1.1)仅只读核查未触碰;AGENTS §0 受保护文档零碰。
- **后续切片授权边界(待维护者拍板本稿后,逐切片走档)**:S1 站内(D→C→A)/ S2 微信 quota(D)/ S3 producer+Effect(C/D)/ S4 活动考勤(C)/ S5 短信兜底(D);各切片偏离 DoD / 遇未决 / 判定必须引异步基建 → [`process §4.1`](../../process.md) 人话简报停,不夹带。
- **完成**:本稿走 PR(分支保护强制);终版回传主会话元核验。

---

> **冻结声明**:本评审稿自 2026-06-25 冻结,不回改。**supersede 原 T0 [`member-notification-review.md`](member-notification-review.md) 的架构**(扩为统一多渠道 + 派发器 + producer 任务),复用其站内信设计但不回改它。**D-N1~D-N9 + 原 T0 残留**待维护者拍板(§10 / 顶部 ⚠️ 清单);拍板结果与各切片实施进展记录于 [`docs/current-state.md`](../../current-state.md) / `CHANGELOG.md` / [`NEXT_TASKS.md`](../../ai-harness/NEXT_TASKS.md),不回改本冻结档。
