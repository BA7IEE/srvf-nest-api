# notifications — 执行与受众边界

负责站内 pull、微信订阅、显式短信兜底、企业微信及定向业务通知。
验证码/渠道配置归各自模块；报名前非会员通知仍走查询 pull，不增加通知偏好或全员短信任务。
业务规格见 `docs/archive/reviews/unified-notification-dispatcher-review.md`；
发布现场见 `docs/ops/wecom-message-channel-rollout.md`（均相对仓库根）。

## 事务与 durable outbox

- producer 在业务事务内写不可变 intent，enqueue 失败使业务回滚；worker/provider 重试不重放业务写。
  招新/入队、报名审批/候补/取消、活动发布/改期/取消/审核/扩容、责任移交、考勤审核均沿此边界。
  责任 assignment、RoleBinding、audit 和新旧 owner 两个 intent 必须同事务。
- 稳定状态版本复用 eventKey，reopen 后的新审核产生新 key。活动结果收件人只认当前 ACTIVE owner，
  缺失时安全告警、不入队、不回退 publisher。自助取消正文只有 memberNo/displayName 安全快照，
  缺任一字段即匿名，不用内部 ID 补位。考勤终审逐 record snapshot；
  milestone 为 team_join_application 的固定 5 分门槛，同 application+threshold 重放须完整同内容。
- worker 独立进程、PG `FOR UPDATE SKIP LOCKED` claim/lease/fence，provider 恒在事务外。
  不 import AppModule/ScheduleModule、不新增 cron/queue/内存幂等。
- permission 锁序：
  `Notification FOR SHARE → intent FOR UPDATE → Member FOR UPDATE → organization topology →
  User → RoleBinding → RbacRole → Permission → RolePermission`（后五类 FOR SHARE）。
  parent writer 等待所有 permission 事务；同代 child 可共享 parent。
- draft→published 在根锁内原子 `publishGeneration +1`，新 admin root/child/SMS 只用 v2。
  v1 admin intent terminal dead；切换期 v1 child 仅接受未 prepare、published system-directed、
  directed audience、同 member 且有 wechat channel。`preparedAt != null && preparedTemplateId == null` 拒绝。
- 每 intent JIT claim，稳定 lockedAt；heartbeat 与 beforeEffect 共用单一在途 renew。
  微信 cache hit 不 guard，cache miss token fetch、首次 send、强制刷新和第二次 send 各在真实 fetch 前 guard。
  sticky lease failure 后不启动新 provider、不 ack/nack/dead。
- quota 首次 reservation 与 preparedAt/preparedTemplateId 同短事务；重领只用持久模板，半状态拒绝。
  退款仅限同进程同 attempt 正向 reservation capability，最终 permission 拒绝且 provider 尚未开始；
  旧 attempt、崩溃或结果未知均不退款。
- provider 返回到 evidence commit 为 at-least-once 歧义窗口，不宣称 exactly-once。
  跨代 active 微信 child 使新 root 停 heartbeat 后无损 defer：恢复 attempt，延至 max(active lease,now)+BASE。
  只有 NotificationDelivery SENT 是跨 generation 永久去重事实。
- payload/eventKey 不含 phone/openid/token/secret/credential/signed URL/provider 原文；
  envelope/payload 的 notification/member ID 一致。关停先停 claim/唤醒 idle，再 drain attempt/heartbeat。
  lease/DB 异常安全分类、退避续跑；未知 type/version 零 Effect。

## 受众与可见性

- Decision 15.1=B、Decision 15.2=B（业务负责人最终确认：2026-07-27）：
  management 仅 SUPER_ADMIN 或显式 GLOBAL read grant，Role.ADMIN 不直通；
  department 接受 PRIMARY/SECONDARY/TEMPORARY/SUPPORT 当前有效任职，Organization ACTIVE 且未软删。
  App pull、SMS/WeChat 根受众和 Effect 最终复核同义。
- directed/membership audience 的归属组织仍只认当前 PRIMARY：
  ACTIVE、startedAt<=now、endedAt=null、未软删；不与 department 广播四类资格混用。
- 唯一受众原语为 `notification-recipient-authorization.service.ts` 的
  `authorizeBroadcastRecipients` / `authorizeRecipientForEffect`，新渠道必须复用。
  它们是函数，不为手工构造的消费方擅加 Injectable 依赖；地址由调用方 loadActiveUsers 注入。
- canSeeContent 只判断 status；读侧 buildVisibilityWhere、推送侧 authorizeAdminNotificationEffect
  才检查软删，新渠道不能漏用。广播根按 Member 取候选，无 ACTIVE User 者仍可进入地址为空的候选；
  最终闸再拒绝/跳过，不将两阶段规则合并。
- 微信 v2 child 同事务复核 parent/generation/lease、Member/User、任职/组织、visibility 与 GLOBAL RBAC，
  全程同一 tx client，openid 只取 shared-lock User 快照。pre-permission quota=0 记 no-quota，
  recipientRef='-'，不伪造 destination evidence。
- 广播 feed 必须 `audienceType=broadcast`；定向只限 recipientMemberId=本人，他人 31001。
  系统定向直接 published/system/authorUserId=null，不走 admin 状态机、不写运营 audit；
  dispatcher 不反向 import/callback producer。

## 渠道特殊规则

- SMS 只允许 admin 显式 confirmed=true；预览零发送零计费、缺字段400，publish 不自动发送 SMS。
  每 recipient 独立 pending child；provider accepted 后 sms_send_logs SENT 与 delivery sent 同短事务，
  任一失败外抛给 worker nack。已被别的 worker claim 的首轮计 failed，不算 skipped；通道关闭不 ack。
  空通知模板 confirmed 发送返24030，真实模板须零变量且过审；
  沿 sms.constants 的同号每日10次/间隔60s和同日同模板幂等，不另设阈值。
- 微信只向 quota∩可见候选 fan-out；扣 quota 用条件原子 updateMany/decrement，count=1 才发。
  ack 是 additive、非去重幂等，封顶5；模板 ID/thing/time 映射须真机核对，null 模板不发送。
  不改变已有 code2session、验证码或生日 provider 行为。
- wecom 与 wechat 的身份键、事件、active-slot partial unique、reason/错误码分离。
  publish 先查 readiness，不可用不建 root；Effect 锁后复读 settings，关闭则 skipped/channel-disabled，
  不迟到补发。共同实体锁序必须 `settings → User → identity`；
  settings 在 T5A 前取锁，但通道开关判定仍在资格之后，失效资格不能多留 delivery。
- wecom 一次 resolveMessageContext 取得 provider/corpId/generation/webBaseUrl，
  最终锁后校验代际与 corpId，不一致 config-changed、不发送不记账、交下次 attempt；
  identity 用同 corpId，提交后只用该 provider，不再 resolveRoute。wecomUserId 只来自锁内快照。
- wecom 失败只按 WECOM_ERROR_KIND：network/timeout/http-5xx/system-busy/token-invalid 退避；
  rate-limited/provider-contract/http-4xx dead 待人工 replay；
  config-fatal/invalid-response/upstream-rejected terminal ack。
  errcode=0 也查 invaliduser/unlicenseduser；81013 不记 SENT。
  四个名单字段：缺席/空串为空，字符串解析，其他类型 INVALID_RESPONSE；
  errcode 非0时 invalidparty/invalidtag 也要检查。
- 系统定向重发唯一入口 replayDirectedWecomDelivery：新 child/key；SENT 和 active attempt 拒绝。
  默认仅 dead 且最后 reason 为 rate-limited/provider-contract-error；
  never-attempted、channel-disabled、recipient-unlicensed 不重发。
  overrideReason 只绕历史 reason，其他闸不绕。admin 广播仍 unpublish+publish。
  HTTP 入口只判权/参数/审计，不复制原语判据；恒200，outcome 闭集须同步 DTO/contract/runbook。
  每次通过判权调用都记 notification.publish + operation=replay-wecom + overrideReason，
  不记录身份/深链/凭证。暂态失败 delivery 不占 intent.id，否则重试会被幂等入口吞掉。
  开 messageEnabled 前必须排空旧 worker fleet。

## 两个 cron

生日与到期提醒均09:00、runOnce 扫描入队，独立 worker 外发，不新增调度器或 retention cron。
生日按 UTC+8 月日：profile 未删、Member ACTIVE未删、User 存在且 ACTIVE未删、User.phone 非空；
只发 User.phone，不发 profile.mobile；2/29 不顺延，零变量，不写 audit_logs。
eventKey=北京日期+memberId，PG unique 防重复 intent，sms_send_logs SENT 防重复触达。
provider/临时DB/缺配置/production-like DEV_STUB 均 nack/retry，最多8次后 dead。
启动日志 `Birthday greeting cron registered (09:00 Asia/Shanghai)` 是 docker-smoke 锚点。
普通日志只用闭集 operation/safeErrorCategory/safeErrorCode/retryable/必要稳定ID，
未知错误 unexpected-error/code=null；不输出 message/stack/cause、地址、对象键或 provider URL。

改动按需跑 outbox、recipient-authorization、各渠道与相关 producer 的单测/定向 E2E；
受众改动先跑 `notification-recipient-authorization.e2e-spec.ts`，锁序跑 wecom-lock-order-concurrency。
历史沿革从 `harness-v3-final` 取回，不在本文件追加每次 PR 状态。
