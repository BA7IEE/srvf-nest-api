# notifications — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);生日冻结评审稿 [`/docs/archive/reviews/queue-b-otp-birthday-infra-review.md §6`](../../../docs/archive/reviews/queue-b-otp-birthday-infra-review.md);到期提醒冻结评审稿 [`/docs/archive/reviews/expiry-reminder-attendance-reopen-v0.47.0-review.md`](../../../docs/archive/reviews/expiry-reminder-attendance-reopen-v0.47.0-review.md);运维送审 SOP [`/docs/ops/sms-production-rollout-checklist.md`](../../../docs/ops/sms-production-rollout-checklist.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## Scope

**统一通知中枢**(2026-06-25 由「生日批单服务」扩容而来)。四条渠道 + 两个 cron:

| 面 | 承载 | 关键点 |
|---|---|---|
| 站内信 | `NotificationAdminController` 8 端点 + `NotificationAppController` 4 端点 | **pull 零发送**;可见性复用 `content.visibility`(去 public = 4 档) |
| 微信订阅 | `NotificationWechatDispatchService` + quota / 模板配置 | 有 quota ∩ 可见才发;发送能力 additive 在 `wechat/` |
| 短信兜底 | `NotificationSmsDispatchService` | **仅 admin 显式 `confirmed=true` 触发**,预览零发送零计费 |
| 定向业务通知 | producer 在业务事务内 enqueue outbox intent | 均**仅站内**,0 schema / 0 端点 / 0 RBAC 码 |
| 两个 `@Cron` | 生日祝福(09:00)+ 到期提醒(v0.47.0,09:00) | 都是薄壳,只入队;外发由独立 worker 执行 |

**durable outbox 是全模块的执行底座**:业务事务同写 `NotificationOutboxIntent`,
独立 `notification-outbox-worker` 进程(**不是第三个定时器**)以 PostgreSQL
`FOR UPDATE SKIP LOCKED` claim + lease/fencing 驱动 Effect,provider 恒在事务外。

> 业务负责人于 2026-07-27 最终确认 **Decision 15.1=B / Decision 15.2=B**：management 仅认 SUPER_ADMIN 或明确 GLOBAL read grant，Role.ADMIN 不自动放行；department 认 PRIMARY/SECONDARY/TEMPORARY/SUPPORT 四类当前有效 Membership，且 Organization 必须 ACTIVE、未软删。App pull、SMS/WeChat 根受众与 WeChat Effect 前最终复核同义。

- **不负责**:验证码(`SmsCodeService`)/ wechat·sms settings 管理(各自模块)/ 报名前 5 触发(申请人非队员,维持查询 pull;openid 推送路另立项)/ 真·全员短信批处理异步(延后,未立项)/ 退订偏好(未立项)。

> **模块沿革**(S1→S5 各期怎么长出来的、durable outbox 与 G2 generation fence 的完整设计叙述)
> 已移至 [`/docs/archive/module-notes/notifications.md`](../../../docs/archive/module-notes/notifications.md) ——
> 那段 5.9k 字符对**要改代码的人**没有约束力,却在每次触碰本目录时全额注入。
> **叙事搬走了,规则没搬**:原文里嵌在叙事中的不变量已逐条落在下面 `Local facts` 与 `Risk points`。
> 设计权威源仍是冻结评审稿 [`unified-notification-dispatcher-review.md`](../../../docs/archive/reviews/unified-notification-dispatcher-review.md)。

## Local facts

- 招新发号与入队 producer 在各自业务 transaction 内 enqueue `notification.targeted@1`；worker commit 后执行 Effect。producer 不再 commit 后 best-effort 直调 dispatcher，enqueue 失败必须使业务回滚。
- 报名审批、候补递补与自助取消 producer 同样在业务 transaction 内 enqueue；同一状态版本复用稳定 eventKey，reopen 后新审核生成新 eventKey。自助取消只接收 `memberNo/displayName` 安全快照用于正文，任一字段不可用即匿名兜底，禁止用 Member/User 内部 ID 补位；gate=true 缺 ACTIVE owner 时不入队且只记安全告警，禁止回退 publisher。
- 活动发布广播、改期、取消、发布审核结果与 Activity/岗位扩容递补同样在业务 transaction 内 enqueue；审核 change 收件人只认审核时当前 ACTIVE owner，缺失时不入队且记安全告警，禁止回退 publisher。
- 责任委托/结束与 owner 移交同样在 assignment、RoleBinding、audit 的业务 transaction 内 enqueue；移交分别快照旧/新 owner，两个 intent 任一失败都回滚完整移交。
- 考勤 `firstReturn`/`finalReturn`/`finalApprove` 同样在 Sheet 状态、audit 的业务 transaction 内 enqueue；退回收件人从 active attendance assignment/提交人解析，终审逐 record snapshot；milestone payload 只含稳定 5 分门槛正文，aggregate=`team_join_application`，同 application+threshold 重放必须完整同内容。enqueue 失败整体回滚，worker/provider 失败不得重放业务写。
- membership audience / 定向归属组织只接受当前有效 PRIMARY(`ACTIVE + startedAt<=now + endedAt=null + 未软删`)；本口径不改变 durable Outbox 的 enqueue 位置与事务顺序。
- department 广播是独立读取可见档：App pull、SMS/WeChat 根受众与 WeChat 最终复核均接受当前有效 PRIMARY/SECONDARY/TEMPORARY/SUPPORT；不改变上一条 directed/membership audience 的 PRIMARY 语义。
- 通知派发普通日志只记录固定 `event`、闭集 `operation`、后端映射的 `safeErrorCategory/safeErrorCode`、`retryable` 与必要稳定 ID；未知错误固定 `unexpected-error/code=null`。禁止 message/stack/cause、destinationRef、手机号、openid、object key、provider URL、secret/token/Authorization；持久化 delivery/outbox/sms_send_logs 诊断语义不因此改变。

### durable outbox 不变量(从原 Scope 叙事中提取,一条未删)

- **锁序固定**:provider permission 走 `Notification parent(FOR SHARE)` → `outbox intent(FOR UPDATE)` → `Member(FOR UPDATE)` → shared organization topology → `User` → `RoleBinding` → `RbacRole` → `Permission` → `RolePermission`(后五类均 `FOR SHARE`)。同代 child 可共享 parent;update/unpublish 等 writer 仍等待全部 permission 提交。
- **generation fence**:admin `draft→published` 在 Notification 根行锁内原子 `publishGeneration +1`,只生产带 generation 的 v2 root/child/admin-SMS;v1 admin root/child/SMS 直接 terminal dead。切换期只允许「尚未 prepare + 对应 published system-directed + directed audience + 同 member + 含 wechat channel」的 v1 child 留存;`preparedAt != null && preparedTemplateId == null` **永远 fail-closed**。
- **lease/heartbeat**:每条 intent JIT claim;稳定 `lockedAt` 下的 heartbeat 与 provider 最终 Effect 紧邻的 `beforeEffect` guard **共享单一在途 renew**。WeChat cache hit 不执行 guard;cache miss 的 stable-token fetch、首次订阅发送、token-invalid force-refresh、第二次订阅发送**各自在真实 fetch 紧前独立 guard**。**sticky lease failure 后不再启动新 provider,也不 ack/nack/dead。**
- **退款条件(极窄)**:只有**同进程同 attempt 正向 reservation 返回的 capability**,可在 final permission 拒绝且 provider 尚未开始时原子精确退款。旧 attempt / 崩溃 / provider 结果未知 —— **一律不得退款**。WeChat 首次 quota reservation 与 `preparedAt + preparedTemplateId` 同短事务,重领只消费持久模板,半状态 terminal fail-closed。
- **交付语义**:provider 返回到本地 evidence commit 之间是 **at-least-once 歧义窗口,不宣称 exactly-once**。跨代 active WeChat child 令新 root 在停止 heartbeat 后**无损 defer**(恢复 attempt、`max(active lease, now)+BASE`),不 ack/nack/dead。只有 `NotificationDelivery SENT` 是跨 generation 的永久去重事实。
- **v2 WeChat child 重验**:同一事务内重验 live parent/generation/lease + recipient 的 active Member/User、四类 effective membership + active Organization、四档 visibility;management GLOBAL RBAC 全程只用**同一 transaction client**,openid 只取 User shared-lock 快照;Effect 只用锁内快照,provider 仍在事务外。pre-permission `quota=0` 只记 `no-quota` 且 `recipientRef='-'`,**不伪造尚未读取的 destination evidence**。
- **payload 禁字段**:outbox `payload` / `eventKey` 禁手机号、openid、token、secret、credential、signed URL 与 provider 原始报文;envelope 与 payload 的通知 ID / 会员 ID 必须一致。
- **关停顺序**:`OnModuleDestroy` 先 stop 新 claim、唤醒空闲等待,再 drain 在途 attempt/heartbeat。worker 单轮 lease/DB 异常只记安全 errorClass 并退避续跑。
- **admin SMS 抢领语义**:另一 worker 已抢领时首轮显式计 `failed`(**不是 skipped**),durable final 仍由持 lease 的 worker 推进。

- **本仓恰好两个 `@Cron`**:生日批 + v0.47.0 到期提醒;`ScheduleModule.forRoot()` 在 `app.module.ts` 全局装配。第三个 cron / 独立业务调度 interval/timeout 仍须独立 D 档评审；随单 intent 启停并等待在途续租的 outbox lease heartbeat 是本 D 档已拍板的 worker 正确性循环，不是新调度器
- **选取六条件**(评审稿 E-B5,全部同时满足):`MemberProfile.birthDate` 月日=今天(固定 UTC+8 日界)/ profile 未软删 / Member ACTIVE 未软删 / User 存在 / `User.phone` 非空 / User ACTIVE 未软删;**仅发 `User.phone`**(拍板⑤,`MemberProfile.mobile` 永不使用);2/29 仅闰年当天发(不顺延)
- **幂等防重发**(E-B6):生日 cron 的 eventKey 固定为「北京时间日期 + memberId」;outbox unique 防重复 intent,handler 仍以 `sms_send_logs` SENT 记录防重复触达;所有跨进程正确性均以 PostgreSQL 为准
- **失败语义**(D-Outbox):provider/临时 DB 失败由 intent 退避重试,最多 8 次后 dead;通道整体不可用(settings 缺失 / templateIdBirthday 空 / production-like DEV_STUB)同样只 nack/retry、耗尽后 dead，不在 cron 事务内外发
- **不进 `audit_logs`**(E-B8,运营触达);应用日志一律 `maskPhone`;首版模板**零变量**(`TemplateParamSet=[]`)
- **`runOnce()` 是两个 job 的唯一扫描/入队入口**(`@Cron` 都是薄壳);外发只由独立 worker handler 执行,e2e / unit 不等真实定时
- **worker 不是第三个定时器**:`src/notification-outbox-worker.ts` 用独立 Nest application context 启动,不 import `AppModule` / `ScheduleModule`,不注册 decorator cron;轮询等待只属于该进程消费循环
- **docker-smoke 锚行**:`NotificationsModule.onModuleInit` 输出 `Birthday greeting cron registered (09:00 Asia/Shanghai)`,smoke workflow grep 该行;改文案必须同步 [`/.github/workflows/docker-smoke.yml`](../../../.github/workflows/docker-smoke.yml)

## Risk points (不要做)

- ❌ **不**在本模块新增第三个 `@Cron` / 独立业务调度 interval / timeout(v0.47.0 只解锁第二个到期扫描;后续新定时任务 = 新 D 档评审；仅允许本轮随 intent 生命周期启停、停止时等待在途 renew 的 lease heartbeat)
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
- ❌ 报名审批 / 候补递补 / 自助取消**不**再 commit 后直调 `dispatchTargeted`；业务写、audit 与 intent 必须同事务，provider 重试不得重放业务写。
- ❌ **不**给定向 feed 的广播分支去掉 `audienceType=broadcast` 收窄 —— 定向行 `visibilityCode='member'`,不收窄会借广播 member 可见档泄漏给他人(越权);定向仅 `recipientMemberId=本人`可见,他人 `31001` 防枚举。
- ❌ 系统定向通知**不**走 admin 状态机(直接建 published / sourceType=system / authorUserId=null;不污染 admin CRUD 路径,不入 audit,§13)。
- ⚠️ **报名前 5 触发不做**(申请人非队员,S1/S2 够不着):报名受理/转人工/门槛/评定/公示维持**查询进度 pull**;openid 非会员推送路 = 另立项。

### S5 短信兜底渠道(2026-06-27)

- ❌ **不**让短信随 publish 自动发 / 不默认 / 不强制(站内+微信优先;**短信只由 admin 显式 confirmed=true 端点触发**,成本动作显式 gating;`NotificationService.publish` 绝不调短信派发)。
- ❌ **不**在无 `confirmed=true` 时发任何短信(预览 confirmed=false 零发送零计费;缺 confirmed 走通用 400)——防误触发资费。
- ❌ **不**改 `SmsProviderRouter` / 两 provider 的 `sendVerifyCode` / `sendBirthdayGreeting` 既有发送(行为锁;S5 仅 **additive** `sendNotification`)。
- ❌ 外部 SMS API **在任何 DB 事务之外**;每收件人一个 pending child，claim 后才进入 Effect；provider accepted 后 `sms_send_logs SENT` + `NotificationDelivery sent` 在同一短事务提交，任一步失败都外抛给 worker nack。worker 在 Effect 前续租并以稳定 `lockedAt` fence 做单路 heartbeat；admin `dispatchRecipient` 必须在 `router.sendNotification` 紧邻处执行同一 `beforeEffect` guard。续租失败绝不 ack/nack/dead，也不再启动尚未开始的 provider；已经在途/accepted 后丢 lease 仍保留 at-least-once 窗口，不宣称取消或 exactly-once；通道关闭不 ack。
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
- `pnpm exec jest --config test/jest-e2e.config.ts --runInBand --no-cache --runTestsByPath test/e2e/notifications-sms.e2e-spec.ts` — S5 全链:RBAC + 31001/31013 闸 + confirmed 缺失 400 + 预览不发 + 确认逐人 send_log/delivery/maskPhone/audit + 同日幂等 + re-trigger 去重 + 仅可见有手机者 + 24030
- `pnpm test -- notification-outbox birthday-greeting expiry-reminder` — durable outbox:payload 安全 / enqueue 内容幂等 / claim lease / fencing / retry·dead / 未知 type-version 零 Effect + 两 cron 只入队
- `pnpm exec jest --config test/jest-e2e.config.ts --runInBand --no-cache --runTestsByPath test/e2e/notification-outbox.e2e-spec.ts` — 独立 worker + 真 PostgreSQL 并发 claim / 崩溃租约回收 / Effect 幂等 / admin SMS 首轮非最终(精确 path 可避免 worktree 绝对路径被 Jest regex 误展开；须在静态 migration review P0-P3=0 后运行派生测试库)
- 改启动锚行文案 → 必须同步 docker-smoke workflow 并跑该 workflow
