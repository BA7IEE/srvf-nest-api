# notifications 模块沿革(归档)

> 从 `src/modules/notifications/` 的模块规则文件原样搬出(Harness 3.0 P5,2026-07-29)。
>
> **搬出的理由**:模块规则文件会在触碰该目录**任一文件**时被**全文注入**上下文 ——
> 读 15 行代码,整份 14,569 字符就进来了。而其中 `Scope` 一节(5,867 字符)基本是
> 「这个模块从 S1 到 S5 是怎么长出来的」编年史:对**现在要改代码的人**没有约束力,
> 对**想知道为什么是这样**的人才有价值。前者每次触碰都在付费,后者一年查不了几次。
>
> **搬的是叙事,不是规则。** 原文里嵌在叙事中的正确性不变量(锁序 / 退款条件 /
> at-least-once 边界 / payload 禁字段等)已逐条提取进模块规则文件的 `Local facts`,
> **一条没删**。本文件保留完整原文,供追溯「当时为什么这么定」。
>
> 归档层规则:按当时事实冻结,**不是当前事实**(AGENTS §0「不主动读」)。
> 当前口径以 `src/**` 代码与模块规则文件为准。

---

## 原 `## Scope` 全文(逐字)

本模块自 2026-06-25 由「生日批单服务」扩为**统一通知中枢**(GAP-005;冻结评审稿 [`/docs/archive/reviews/unified-notification-dispatcher-review.md`](../reviews/unified-notification-dispatcher-review.md))。当前并存关注点:

- **生日祝福短信 job**(G-7 首个落地点;2026-06-11 B 队列 goal F5):每日 09:00(Asia/Shanghai)`@Cron` 只选取当日生日活跃队员并按「日期 + member」写 durable outbox intent;独立 worker 执行时才解析 `User.phone`、调用 `SmsProviderRouter.sendBirthdayGreeting` 并落 `sms_send_logs`;本仓两个 `@Cron` 之一。
- **到期提醒 job**(v0.47.0):每日 09:00(Asia/Shanghai)第二个 `@Cron`;证书 60 天提醒 + 到期 `verified→expired`、个人保险 30 天、队保单 30 天的 marker / 状态 / audit 与 outbox intent 同事务落库;独立 worker 后续执行站内与微信 Effect,marker + 状态条件更新保证二跑幂等。
- **统一通知 S1 站内信渠道**(2026-06-25):admin 撰写/发布面(`NotificationAdminController` 8 端点)+ 会员 app 拉取面(`NotificationAppController` 4 端点);`Notification` 广播 + `NotificationRead` 已读;**站内 = pull 零发送**;可见性**复用 `content.visibility`**(去 public = 4 档)。`formal_member` 由 ACTIVE Member + 共享 `isFormalMemberGradeCode()` 决定；department 明确认 PRIMARY/SECONDARY/TEMPORARY/SUPPORT 四类当前有效任职；management 仅认 SUPER_ADMIN 或当前有效 GLOBAL `notification.read.record`，Role.ADMIN 不天然放行；feed/detail/mark-read/unread 与 SMS/WeChat 广播共用该真值，directed 仍只认收件人本人。
- **统一通知 S2 微信订阅 quota 渠道**(2026-06-25):admin 勾微信渠道 → publish 事务内写 durable outbox intent,独立 worker 事务外派发(`NotificationWechatDispatchService`);quota ack/status(`NotificationSubscriptionService`)+ 模板配置(`WechatSubscribeTemplateService` + `NotificationWechatTemplateAdminController`);`NotificationDelivery` 投递态 + `WechatSubscriptionQuota` 配额 + `WechatSubscribeTemplate` 模板;发送能力 additive 在 `wechat/` 模块。
- **统一通知 S3 producer 接入 + 派发器 Effect 正式化**(2026-06-25;D-Outbox 2026-07-18 收口):独立 outbox worker 调用 `NotificationOutboxHandlers` 建立已发布定向行并执行站内/微信 Effect；`NotificationDispatcher` 保留模块内兼容实现但不再跨模块导出。招新发号与入队 producer 只在业务事务内 enqueue `notification.targeted@1`。`Notification.recipientMemberId` + feed `buildFeedWhere` 仍保证广播可见 ∪ 本人定向，定向他人 31001 防枚举。
- **统一通知 S4 活动·考勤 producer 定向触发**(2026-06-25;L1-L4 durable/PR-M2a 2026-07-27;PR-M2b 2026-07-27):报名审批/递补/自助取消、活动发布/改期/取消/审核结果/扩容递补、责任委托/结束/owner 移交及考勤退回/终审均在业务事务内 enqueue 既有 outbox event，worker commit 后执行 Effect；自助取消正文只展示取消队员的 `displayName（memberNo）`，安全标签不可用时固定匿名提示，不向用户界面暴露 `Member.id`。责任制 gate=true 的报名自助取消及 change 审核结果仍只认当前 ACTIVE owner，禁止回退 publisher，gate=false 报名兼容才回退 publisher；registration cancel 的 eventKey / aggregate / destination 与 durable outbox 语义不变。考勤退回收件人只认 active `canManageAttendance` assignment 与提交人 member 快照；终审结果按 record 发送，入队贡献达标按正式 capped before/after 跨 5 判断并以 application+threshold 稳定 key 最多一次，禁止 `after-rawDelta`。定向业务通知均仅站内，0 schema / 0 端点 / 0 RBAC 码。
- **durable outbox 核心**(2026-07-18;G2 generation fence 2026-07-20):`NotificationOutboxIntent` 由业务事务同写;独立 `notification-outbox-worker` 进程以 PostgreSQL `FOR UPDATE SKIP LOCKED` claim、lease/fencing、指数退避、最多 8 次与 dead letter 驱动 Effect。每条 intent JIT claim,稳定 `lockedAt` 下的 heartbeat 与 provider 最终 Effect 紧邻 `beforeEffect` guard 共享单一在途 renew;WeChat cache hit 不执行 guard,cache miss 的 stable-token fetch、首次订阅发送、token-invalid force-refresh、第二次订阅发送各自在真实 fetch 紧前独立 guard。sticky lease failure 后不再启动新 provider,也不 ack/nack/dead。admin draft→published 在 Notification 根行锁内原子 `publishGeneration +1`,只生产带 generation 的 v2 root/child/admin-SMS;provider permission 固定锁序 Notification parent(`FOR SHARE`)→outbox intent(`FOR UPDATE`)→Member(`FOR UPDATE`)→shared organization topology→User→RoleBinding→RbacRole→Permission→RolePermission(后五类均 `FOR SHARE`);同代 child 可共享 parent,update/unpublish 等 writer 仍等待全部 permission 提交。v2 WeChat child 在同一事务内重验 live parent/generation/lease 与 recipient 的 active Member/User、四类 effective membership+active Organization、四档 visibility,management GLOBAL RBAC 全程只用同一 transaction client,openid 也只取 User shared-lock 快照;Effect 只用锁内快照且 provider 仍在事务外。v2 pre-permission quota=0 只记 `no-quota` 且 recipientRef=`-`,不伪造尚未读取的 destination evidence。WeChat 首次 quota reservation 与 `preparedAt + preparedTemplateId` 同短事务,重领只消费持久模板且半状态 terminal fail-closed;只有同进程同 attempt 正向 reservation 返回的 capability 可在 final permission 拒绝、provider 未开始时原子精确退款,旧 attempt/崩溃/provider 结果未知均不得退款。切换时只允许尚未 prepare、对应 published system-directed、directed audience、同 member、含 wechat channel 的 v1 child 留存;G2 运行中形成 complete 双 marker 的同类 v1 child 可安全重领,`preparedAt!=null + preparedTemplateId=null` 永远 fail-closed。v1 admin root/child/SMS 直接 terminal dead。outbox envelope/payload 的重复通知/会员 ID 必须一致。跨代 active WeChat child 令新 root 在停止 heartbeat 后无损 defer(恢复 attempt、`max(active lease, now)+BASE`),不 ack/nack/dead。provider 返回到本地 evidence commit 前仍是 at-least-once 歧义,不宣称 exactly-once。worker 单轮 lease/DB 异常只记安全 errorClass 并退避续跑;`OnModuleDestroy` 先 stop 新 claim、唤醒空闲等待,再 drain 在途 attempt/heartbeat。payload/eventKey 禁手机号、openid、token、secret、credential、signed URL 和 provider 原始报文。notifications-owned producer、招新发号/入队及 participation L1-L4 已全部接入。
- **统一通知 S5 短信兜底渠道**(2026-06-27;G2 2026-07-20):`NotificationSmsDispatchService` —— **admin 显式发起紧急召集短信**(`POST admin/v1/notifications/:id/send-sms`,新码 `notification.send.sms`;**计费确认必需** confirmed=true 才真发 / false 仅预览受众计数)。预览与确认都先锁 Notification 并重验 admin+broadcast+published+sms；confirmed=true readiness 后在同一根行锁事务里按随机 request UUID 建逐收件人 v2 intent，payload 另绑定整数 `publishGeneration`，两者不得混作同一概念。worker provider permission 再按 parent→intent 锁序重验 generation；撤回/归档/删除/Effect PATCH 若先赢锁则 provider=0，permission 先赢则本 attempt 可完成。另一 worker 已抢领时首轮显式计 failed(不是 skipped)，durable final 仍由持 lease worker 推进；只有 `NotificationDelivery SENT` 是跨 generation 永久去重事实。
