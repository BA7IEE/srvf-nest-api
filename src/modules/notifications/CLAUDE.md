# notifications — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);生日冻结评审稿 [`/docs/archive/reviews/queue-b-otp-birthday-infra-review.md §6`](../../../docs/archive/reviews/queue-b-otp-birthday-infra-review.md);到期提醒冻结评审稿 [`/docs/archive/reviews/expiry-reminder-attendance-reopen-v0.47.0-review.md`](../../../docs/archive/reviews/expiry-reminder-attendance-reopen-v0.47.0-review.md);运维送审 SOP [`/docs/ops/sms-production-rollout-checklist.md`](../../../docs/ops/sms-production-rollout-checklist.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## Scope

本模块自 2026-06-25 由「生日批单服务」扩为**统一通知中枢**(GAP-005;冻结评审稿 [`/docs/archive/reviews/unified-notification-dispatcher-review.md`](../../../docs/archive/reviews/unified-notification-dispatcher-review.md))。当前并存关注点:

- **生日祝福短信 job**(G-7 首个落地点;2026-06-11 B 队列 goal F5):每日 09:00(Asia/Shanghai)`@Cron` 只选取当日生日活跃队员并按「日期 + member」写 durable outbox intent;独立 worker 执行时才解析 `User.phone`、调用 [`/src/modules/sms/`](../sms/)`SmsProviderRouter.sendBirthdayGreeting` 并落 `sms_send_logs`;本仓两个 `@Cron` 之一。
- **到期提醒 job**(v0.47.0):每日 09:00(Asia/Shanghai)第二个 `@Cron`;证书 60 天提醒 + 到期 `verified→expired`、个人保险 30 天、队保单 30 天的 marker / 状态 / audit 与 outbox intent 同事务落库;独立 worker 后续执行站内与微信 Effect,marker + 状态条件更新保证二跑幂等。
- **统一通知 S1 站内信渠道**(2026-06-25):admin 撰写/发布面(`NotificationAdminController` 8 端点)+ 会员 app 拉取面(`NotificationAppController` 4 端点);`Notification` 广播 + `NotificationRead` 已读;**站内 = pull 零发送**;可见性**复用 `content.visibility`**(去 public = 4 档)。
- **统一通知 S2 微信订阅 quota 渠道**(2026-06-25):admin 勾微信渠道 → publish 事务内写 durable outbox intent,独立 worker 事务外派发(`NotificationWechatDispatchService`);quota ack/status(`NotificationSubscriptionService`)+ 模板配置(`WechatSubscribeTemplateService` + `NotificationWechatTemplateAdminController`);`NotificationDelivery` 投递态 + `WechatSubscriptionQuota` 配额 + `WechatSubscribeTemplate` 模板;发送能力 additive 在 `wechat/` 模块。
- **统一通知 S3 producer 接入 + 派发器 Effect 正式化**(2026-06-25;D-Outbox 2026-07-18 收口):`NotificationDispatcher`(architecture-boundary §3.6 **首个真实 Effect**)由独立 outbox worker 调用，建立已发布定向行并执行站内/微信 Effect；招新发号与入队 producer 只在业务事务内 enqueue `notification.targeted@1`。`Notification.recipientMemberId` + feed `buildFeedWhere` 仍保证广播可见 ∪ 本人定向，定向他人 31001 防枚举。
- **统一通知 S4 活动·考勤 producer 定向触发**(2026-06-25):报名审批(`approve`/`reject` → 报名本人)/ 活动取消(`cancel` → 遍历仍在册报名者 fan-out)/ 考勤终审(`finalApprove` → sheet 内逐 record 本人)三处 producer 在各自业务事务 **commit 后、事务外、`try-catch` 永不抛**直调 S3 `dispatchTargeted`(`activity-reminder` 类型,**仅站内**,微信 opt-in 延后);**0 schema / 0 端点 / 0 RBAC 码**(纯 producer 接入,复用 S3 派发器)。
- **durable outbox 核心**(2026-07-18):`NotificationOutboxIntent` 由业务事务同写;独立 `notification-outbox-worker` 进程以 PostgreSQL `FOR UPDATE SKIP LOCKED` claim、lease/fencing、指数退避、最多 8 次与 dead letter 驱动 Effect。微信广播 child 按 publish root 留独立 generation 历史，手写 partial unique 保证同 notification/member 同时至多一条 pending/processing，terminal 后释放重试槽。payload/eventKey 禁手机号、openid、token、secret、credential、signed URL 和 provider 原始报文;未知 type/version 直接 dead 且零 Effect。notifications-owned producer + 招新发号/入队已接入；participation producer 仍保留 commit 后直调边界，待后续独立 PR。
- **统一通知 S5 短信兜底渠道**(2026-06-27):`NotificationSmsDispatchService` —— **admin 显式发起紧急召集短信**(`POST admin/v1/notifications/:id/send-sms`,新码 `notification.send.sms`;**计费确认必需** confirmed=true 才真发 / false 仅预览受众计数);confirmed=true 先做 channel readiness，再以随机 generation 为逐收件人预留 processing intent，并由 partial unique 保证同 notification/member 单 active；同事务写 `deliveryState=reserved` audit,提交后请求仅执行自己 fence 的 child 首轮并追加 `deliveryState=first-attempt` audit。临时 skip terminal 后释放槽位，下一次 confirmation 可新发；只有 `NotificationDelivery SENT` 是跨 generation 永久去重事实。失败 child 独立 nack 重试,HTTP 与首轮 audit 都不代表最终态。
- **不负责**:验证码(`SmsCodeService`)/ wechat·sms settings 管理(各自模块)/ 报名前 5 触发(申请人非队员,维持查询 pull;openid 推送路另立项)/ 真·全员短信批处理异步(延后,未立项)/ 退订偏好(未立项)。

## Local facts

- 招新发号与入队 producer 在各自业务 transaction 内 enqueue `notification.targeted@1`；worker commit 后执行 Effect。producer 不再 commit 后 best-effort 直调 dispatcher，enqueue 失败必须使业务回滚。
- membership audience / 定向归属组织只接受当前有效 PRIMARY(`ACTIVE + startedAt<=now + endedAt=null + 未软删`)；本口径不改变 durable Outbox 的 enqueue 位置与事务顺序。

- **本仓恰好两个 `@Cron`**:生日批 + v0.47.0 到期提醒;`ScheduleModule.forRoot()` 在 `app.module.ts` 全局装配。第三个 cron / interval / timeout 仍须独立 D 档评审
- **选取六条件**(评审稿 E-B5,全部同时满足):`MemberProfile.birthDate` 月日=今天(固定 UTC+8 日界)/ profile 未软删 / Member ACTIVE 未软删 / User 存在 / `User.phone` 非空 / User ACTIVE 未软删;**仅发 `User.phone`**(拍板⑤,`MemberProfile.mobile` 永不使用);2/29 仅闰年当天发(不顺延)
- **幂等防重发**(E-B6):生日 cron 的 eventKey 固定为「北京时间日期 + memberId」;outbox unique 防重复 intent,handler 仍以 `sms_send_logs` SENT 记录防重复触达;所有跨进程正确性均以 PostgreSQL 为准
- **失败语义**(D-Outbox):provider/临时 DB 失败由 intent 退避重试,最多 8 次后 dead;通道整体不可用(settings 缺失 / templateIdBirthday 空 / production-like DEV_STUB)同样只 nack/retry、耗尽后 dead，不在 cron 事务内外发
- **不进 `audit_logs`**(E-B8,运营触达);应用日志一律 `maskPhone`;首版模板**零变量**(`TemplateParamSet=[]`)
- **`runOnce()` 是两个 job 的唯一扫描/入队入口**(`@Cron` 都是薄壳);外发只由独立 worker handler 执行,e2e / unit 不等真实定时
- **worker 不是第三个定时器**:`src/notification-outbox-worker.ts` 用独立 Nest application context 启动,不 import `AppModule` / `ScheduleModule`,不注册 decorator cron;轮询等待只属于该进程消费循环
- **docker-smoke 锚行**:`NotificationsModule.onModuleInit` 输出 `Birthday greeting cron registered (09:00 Asia/Shanghai)`,smoke workflow grep 该行;改文案必须同步 [`/.github/workflows/docker-smoke.yml`](../../../.github/workflows/docker-smoke.yml)

## Risk points (不要做)

- ❌ **不**在本模块新增第三个 `@Cron` / interval / timeout(v0.47.0 只解锁第二个到期扫描;后续新定时任务 = 新 D 档评审)
- ❌ **不**把 retention 清理做成定时任务(拍板③:永走 [`/docs/ops/sms-data-retention-sop.md`](../../../docs/ops/sms-data-retention-sop.md) 手动 SOP)
- ❌ **不**改发 `MemberProfile.mobile` / 不加模板变量(姓名等)/ 不做群发、退订、农历生日、2-29 顺延(goal 禁止域;需变更先回评审)
- ❌ **不**给生日批写 audit_logs / 不在日志输出完整手机号
- ❌ **不**绕过 durable intent 让 notifications-owned cron/publish/admin SMS 直接调用 provider;不把 claim/幂等/lease 状态搬进内存

### S1/S2 通知渠道(2026-06-25)

- ❌ **不**把微信/短信外部 HTTP 放进 publish DB 事务(§6.2:8s HTTP 绝不拖事务;事务内只写 immutable intent,provider 由 worker 在事务外调用)。
- ❌ **不**为 quota 扣减用「读后写」(竞态双花);**只**用条件原子 `updateMany({where:{availableCount:{gt:0}}, decrement})`,`count===1` 才发、`count===0` 记 skipped no-quota。
- ❌ **不**让 access_token / appSecret / openid 明文入日志 / URL / 出参 / audit(L3;沿 `wechat.provider` E-12 + `maskOpenid`;`NotificationDelivery.recipientRef` 存掩码 openid)。
- ❌ **不**引第三个 cron / Redis / BullMQ / 外部 queue / 事件总线;durable outbox 是已拍板的 PostgreSQL 事务边界,worker handler 只承载既有通知 Effect。
- ❌ **不**对非订阅会员 fan-out(候选 = 有 quota ∩ 可见;§2.1 收窄)。
- ❌ **不**碰 S1 站内状态机 / 可见性 / 已读语义(微信是 additive 分支);不碰 birthday cron / wechat 登录 code2session(仅 additive 扩 Provider 发送能力)。
- ⚠️ ack **非去重幂等**(微信无授权回执 ID;additive 累积,靠 D-N2 封顶 5 + 前端只在真授权后上报缓解);doc 据实记不假装幂等。
- ⚠️ 微信模板 `templateId` + 字段映射(`notification.wechat-data.ts` 的 thing/time key)**须运维按真实小程序模板核对**(默认 templateId=null = 该类型不发)。

### S3 producer 接入 + 派发器 Effect(2026-06-25)

- ❌ **不**让 `NotificationDispatcher` import / 回调招新或 team-join(**防环**:producer → notifications **单向**;通知绝不反向触发业务)。
- ❌ 招新 promote / 入队**不**再 commit 后直调 `dispatchTargeted`；必须在业务 transaction 内 enqueue `notification.targeted@1`，enqueue 失败整体回滚，外部 Effect 只由 worker 在事务外执行。
- ❌ **不**给定向 feed 的广播分支去掉 `audienceType=broadcast` 收窄 —— 定向行 `visibilityCode='member'`,不收窄会借广播 member 可见档泄漏给他人(越权);定向仅 `recipientMemberId=本人`可见,他人 `31001` 防枚举。
- ❌ 系统定向通知**不**走 admin 状态机(直接建 published / sourceType=system / authorUserId=null;不污染 admin CRUD 路径,不入 audit,§13)。
- ⚠️ **报名前 5 触发不做**(申请人非队员,S1/S2 够不着):报名受理/转人工/门槛/评定/公示维持**查询进度 pull**;openid 非会员推送路 = 另立项。

### S5 短信兜底渠道(2026-06-27)

- ❌ **不**让短信随 publish 自动发 / 不默认 / 不强制(站内+微信优先;**短信只由 admin 显式 confirmed=true 端点触发**,成本动作显式 gating;`NotificationService.publish` 绝不调短信派发)。
- ❌ **不**在无 `confirmed=true` 时发任何短信(预览 confirmed=false 零发送零计费;缺 confirmed 走通用 400)——防误触发资费。
- ❌ **不**改 `SmsProviderRouter` / 两 provider 的 `sendVerifyCode` / `sendBirthdayGreeting` 既有发送(行为锁;S5 仅 **additive** `sendNotification`)。
- ❌ 外部 SMS API **在任何 DB 事务之外**;每收件人一个 reserved child,provider accepted 后 `sms_send_logs SENT` + `NotificationDelivery sent` 在同一短事务提交；任一步失败都外抛给 worker nack。provider accepted 到本地事务 commit 前的进程崩溃仍是不可消除的 at-least-once 窗口，不宣称 exactly-once；通道关闭不 ack。
- ❌ **不**引第三个 cron / Redis / BullMQ / 外部 queue / 事件总线;admin SMS 只复用 PostgreSQL outbox 的同一 worker,不再另建异步基建。
- ❌ **不**输出明文手机号(响应/日志/审计一律 `maskPhone`;`NotificationDelivery.recipientRef` 存掩码;audit 仅收件人计数无明文)。
- ⚠️ 短信模板 `sms_settings.templateIdNotification` **须运维填真实零变量模板 ID 并先过审**(空 = 该渠道未配置,confirmed 发送返 24030;DevStub 忽略其值但须非空,对齐生日批口径)。
- ⚠️ 防滥发**继承同号封顶 10/间隔 60s**(查 `sms_send_logs`,跨模板)+ **同日同模板幂等**(一日一兜底 nudge,镜像生日批);改阈值改既有 `sms.constants` 常量(勿在本模块另立第二套)。

## Validation

- `pnpm test -- birthday` — 生日批:选取六条件 / 2-29 / 日界 / 失败继续 / 前置跳过(mock prisma + router)
- `pnpm test -- wechat.provider wechat.service notification.wechat-data notification-subscription` — S2 单测:stable_token 缓存 / sendSubscribeMessage errcode + E-12 / token 刷新重试 / 字段映射截断 / quota 封顶
- `pnpm test -- notification-dispatcher recruitment-promotion` — S3 单测:定向行形态 + 渠道编排 + 发号 intent 与业务同事务 + enqueue 失败整体回滚
- `pnpm test:e2e -- notifications-birthday notifications-admin notifications-app notifications-wechat notifications-directed` — 直调 / 全链:生日 + S1 站内信 + S2 微信 + S3 定向(收件人可见 / **他人 404 防枚举** / 微信 sent·no-quota·no-template)
- `pnpm test:e2e -- recruitment.e2e team-join.e2e` — S3 producer:同事务 intent / batch 中途失败整批回滚 / 重复请求与 worker drain 零重复 Effect
- `pnpm test -- notification-sms-dispatch dev-stub.provider tencent-sms.provider` — S5 单测:通道未就绪 / 仅可见有手机者 / 同日同模板幂等·日封顶·间隔继承 / re-trigger 去重 / FAILED 不阻断 / maskPhone / 预览不发 / provider `sendNotification` + 行为锁
- `pnpm test:e2e -- notifications-sms` — S5 全链:RBAC + 31001/31013 闸 + confirmed 缺失 400 + 预览不发 + 确认逐人 send_log/delivery/maskPhone/audit + 同日幂等 + re-trigger 去重 + 仅可见有手机者 + 24030
- `pnpm test -- notification-outbox birthday-greeting expiry-reminder` — durable outbox:payload 安全 / enqueue 内容幂等 / claim lease / fencing / retry·dead / 未知 type-version 零 Effect + 两 cron 只入队
- `pnpm test:e2e -- notification-outbox` — 独立 worker + 真 PostgreSQL 并发 claim / 崩溃租约回收 / Effect 幂等 / admin SMS 首轮非最终(须在静态 migration review P0-P3=0 后运行派生测试库)
- 改启动锚行文案 → 必须同步 docker-smoke workflow 并跑该 workflow
