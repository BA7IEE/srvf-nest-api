# notifications — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);冻结评审稿 [`/docs/archive/reviews/queue-b-otp-birthday-infra-review.md §6`](../../../docs/archive/reviews/queue-b-otp-birthday-infra-review.md);运维送审 SOP [`/docs/ops/sms-production-rollout-checklist.md`](../../../docs/ops/sms-production-rollout-checklist.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## Scope

本模块自 2026-06-25 由「生日批单服务」扩为**统一通知中枢**(GAP-005;冻结评审稿 [`/docs/archive/reviews/unified-notification-dispatcher-review.md`](../../../docs/archive/reviews/unified-notification-dispatcher-review.md))。三个并存关注点:

- **生日祝福短信 job**(G-7 首个落地点;2026-06-11 B 队列 goal F5):每日 09:00(Asia/Shanghai)`@Cron`,选取当日生日活跃队员经 [`/src/modules/sms/`](../sms/)`SmsProviderRouter.sendBirthdayGreeting` 逐个单发;**本仓唯一 `@Cron`**,流水落 `sms_send_logs`。
- **统一通知 S1 站内信渠道**(2026-06-25):admin 撰写/发布面(`NotificationAdminController` 8 端点)+ 会员 app 拉取面(`NotificationAppController` 4 端点);`Notification` 广播 + `NotificationRead` 已读;**站内 = pull 零发送**;可见性**复用 `content.visibility`**(去 public = 4 档)。
- **统一通知 S2 微信订阅 quota 渠道**(2026-06-25):admin 勾微信渠道 → publish **事务外**同步派发(`NotificationWechatDispatchService`);quota ack/status(`NotificationSubscriptionService`)+ 模板配置(`WechatSubscribeTemplateService` + `NotificationWechatTemplateAdminController`);`NotificationDelivery` 投递态 + `WechatSubscriptionQuota` 配额 + `WechatSubscribeTemplate` 模板;发送能力 additive 在 `wechat/` 模块。
- **不负责**:验证码(`SmsCodeService`)/ wechat·sms settings 管理(各自模块)/ producer 定向(S3)/ 短信兜底(S5)/ 退订偏好(未立项)。

## Local facts

- **本仓唯一 `@Cron`**:no-cron 铁律升级路径 2026-06-11 正式触发(评审稿拍板④),解锁范围**仅生日批**;`ScheduleModule.forRoot()` 在 `app.module.ts` 全局装配
- **选取六条件**(评审稿 E-B5,全部同时满足):`MemberProfile.birthDate` 月日=今天(固定 UTC+8 日界)/ profile 未软删 / Member ACTIVE 未软删 / User 存在 / `User.phone` 非空 / User ACTIVE 未软删;**仅发 `User.phone`**(拍板⑤,`MemberProfile.mobile` 永不使用);2/29 仅闰年当天发(不顺延)
- **幂等防重发**(E-B6):发前查 `sms_send_logs`{同号 + templateKey=`birthday-greeting` + SENT + 当日 UTC+8};重启不重发(以 DB 为准);FAILED 不挡同日重跑(FAILED ≠ 已触达)
- **失败语义**(E-B7):单条失败写 FAILED 行不重试不阻断;通道整体不可用(settings 缺失 / templateIdBirthday 空 / production-like DEV_STUB)→ 整批跳过零行
- **不进 `audit_logs`**(E-B8,运营触达);应用日志一律 `maskPhone`;首版模板**零变量**(`TemplateParamSet=[]`)
- **`runOnce()` 是唯一逻辑入口**(`@Cron` 为薄壳);e2e / unit 直调 `runOnce`,不等真实定时
- **docker-smoke 锚行**:`NotificationsModule.onModuleInit` 输出 `Birthday greeting cron registered (09:00 Asia/Shanghai)`,smoke workflow grep 该行;改文案必须同步 [`/.github/workflows/docker-smoke.yml`](../../../.github/workflows/docker-smoke.yml)

## Risk points (不要做)

- ❌ **不**在本模块新增第二个 `@Cron` / interval / timeout(解锁范围仅生日批;新定时任务 = 新 D 档评审,评审稿 R-5)
- ❌ **不**把 retention 清理做成定时任务(拍板③:永走 [`/docs/ops/sms-data-retention-sop.md`](../../../docs/ops/sms-data-retention-sop.md) 手动 SOP)
- ❌ **不**改发 `MemberProfile.mobile` / 不加模板变量(姓名等)/ 不做群发、退订、农历生日、2-29 顺延(goal 禁止域;需变更先回评审)
- ❌ **不**给生日批写 audit_logs / 不在日志输出完整手机号
- ❌ **不**在多实例部署下直接复用本 job(无分布式锁会双发;扩容前先加锁,评审稿 E-B12)
- ❌ **不**绕过幂等查重直接发送;不把幂等状态搬进内存(重启即重发)

### S1/S2 通知渠道(2026-06-25)

- ❌ **不**把微信/短信外部 HTTP 放进 publish DB 事务(§6.2:8s HTTP 绝不拖事务;派发在 `transition` 事务 commit **之后**调用)。
- ❌ **不**为 quota 扣减用「读后写」(竞态双花);**只**用条件原子 `updateMany({where:{availableCount:{gt:0}}, decrement})`,`count===1` 才发、`count===0` 记 skipped no-quota。
- ❌ **不**让 access_token / appSecret / openid 明文入日志 / URL / 出参 / audit(L3;沿 `wechat.provider` E-12 + `maskOpenid`;`NotificationDelivery.recipientRef` 存掩码 openid)。
- ❌ **不**引 cron / queue / 事件总线 / Effect 类(同步发送,§8;派发器 Effect 正式化 = S3;碰 R-5 = 新 D 档)。
- ❌ **不**对非订阅会员 fan-out(候选 = 有 quota ∩ 可见;§2.1 收窄)。
- ❌ **不**碰 S1 站内状态机 / 可见性 / 已读语义(微信是 additive 分支);不碰 birthday cron / wechat 登录 code2session(仅 additive 扩 Provider 发送能力)。
- ⚠️ ack **非去重幂等**(微信无授权回执 ID;additive 累积,靠 D-N2 封顶 5 + 前端只在真授权后上报缓解);doc 据实记不假装幂等。
- ⚠️ 微信模板 `templateId` + 字段映射(`notification.wechat-data.ts` 的 thing/time key)**须运维按真实小程序模板核对**(默认 templateId=null = 该类型不发)。

## Validation

- `pnpm test -- birthday` — 生日批:选取六条件 / 2-29 / 日界 / 失败继续 / 前置跳过(mock prisma + router)
- `pnpm test -- wechat.provider wechat.service notification.wechat-data notification-subscription` — S2 单测:stable_token 缓存 / sendSubscribeMessage errcode + E-12 / token 刷新重试 / 字段映射截断 / quota 封顶
- `pnpm test:e2e -- notifications-birthday notifications-admin notifications-app notifications-wechat` — 直调 / 全链:生日 + S1 站内信 + S2 微信(ack 封顶 / 三态 / 43101 回补 / 并发不越扣 / 模板 admin)
- 改启动锚行文案 → 必须同步 docker-smoke workflow 并跑该 workflow
