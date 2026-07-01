# RBAC_MAP — 权限体系地图与对照表

> **性质**:derived 地图,非规则源。权限**事实**权威源:权限码与绑定 → [`prisma/seed.ts`](../../prisma/seed.ts);判权实现 → [`src/modules/permissions/rbac.service.ts`](../../src/modules/permissions/rbac.service.ts);铁律 → [`AGENTS.md §8 / §13`](../../AGENTS.md)。
> 数据快照:2026-06-11,**Slow-4 权限双轨收口完成**(goal #314-#317,冻结评审稿 [`slow4-rbac-business-face-review.md`](../archive/reviews/slow4-rbac-business-face-review.md)):117 码 / 内置角色 ×3 / **全仓活跃 `@Roles` = 0**(原 G 模式 44 处全摘;RolesGuard 机制保留 Guard 链);`docs:rbacmap:check` 0 FAIL / 0 WARN(seed↔代码双向对齐)。**任何权限事实的变更本身是 D 档**(评审稿 + 用户拍板),本文件只能事后 true-up。
> 2026-06-11 B 队列收口戳(goal #322-#328):**权限事实零变化**(117 码 / 绑定 / 内置角色不动);endpoint 157→**159**(OTP 登录两公开端点 `[public]`,零新权限码;生日批零端点);`docs:rbacmap:check` 仍 0 FAIL / 0 WARN。
> 2026-06-12 v0.22.0 收口戳(goal「会议延期窗口」G2/G3 #345/#346):**权限事实零变化**(117 码 / 绑定 / 内置角色不动);endpoint **159** 不变(进程崩溃兜底 + SDK 超时均零新端点);`docs:rbacmap:check` 仍 0 FAIL / 0 WARN。
> 2026-06-12 微信小程序登录 T2 戳(goal P1-8,冻结评审稿 [`wechat-mini-login-review.md §3.4`](../archive/reviews/wechat-mini-login-review.md)):权限码 117→**121**(wechat-setting 3 + user.wechat.clear;`wechat-setting.reset.credentials` 不绑 ops-admin 镜像 D2=A);ops-admin 58→**61**;endpoint 159→**162**(wechat-settings 三端点);`user.wechat.clear` 端点 T3 实装,T2 期间孤码 **WARN 预期**(镜像 user.phone.clear 先例)。
> 2026-06-12 微信小程序登录 T3 戳(同 goal):**权限码零变化**(121 不动);endpoint 162→**168**(auth/v1 三公开端点 `[public]` + me/wechat 两端点 `[auth]` + admin 清除 `[rbac: user.wechat.clear]` 实装,**T2 孤码 WARN 清零**);BizCode +4(25xxx 段)与 audit +4 不属本表;`docs:rbacmap:check` 0 FAIL / 0 WARN。
> 2026-06-13 保险模块 T1 戳(goal「保险模块」,冻结评审稿 [`insurance-module-review.md §3.4`](../archive/reviews/insurance-module-review.md)):权限码 121→**128**(team-insurance-policy 6 + member-insurance 1,全绑 biz-admin 无例外 E-6);biz-admin 35→**42**;ops-admin 61 / member 9 零变化;endpoint **168** 不变(T2 +14 端点实装);7 新码 T2 实装前孤码 **WARN 预期**(镜像 wechat T2 先例);App 自助 `app/v1/me/insurances` 走 self-scope **无 RBAC 码**。
> 2026-06-13 保险模块 T2 戳(同 goal):**权限码零变化**(128 不动);endpoint 168→**182**(队保单 9 `[rbac:]` + admin 查队员保险 1 `[rbac: member-insurance.read.other]` + App 自助 4 `[auth]`);controller 35→**38**;**T1 孤码 WARN 清零**;BizCode +5(260xx 段,26030 门槛随 T3)与 audit +8 DB +1 placeholder 不属本表;`docs:rbacmap:check` 0 FAIL / 0 WARN。
> 2026-06-13 保险模块 T3 戳(同 goal):**权限事实零变化**(128 码 / 绑定 / 内置角色不动);endpoint **182** 不变(`requiresInsurance` 仅活动 DTO 字段新增 + 报名 create 双路径门槛断言,零新端点);BizCode +1(26030 `INSURANCE_REQUIRED`)与 baseline §1.1 红区行不属本表;`docs:rbacmap:check` 0 FAIL / 0 WARN。
> 2026-06-18 招新一期 T1 戳(goal「招新一期(招新前段)」,冻结评审稿 [`recruitment-phase1-review.md §3.4`](../archive/reviews/recruitment-phase1-review.md)):权限码 128→**136**(realname-setting 3〔`reset.credentials` 不绑 ops-admin 镜像 D2=A〕+ recruitment-cycle 3 + recruitment-application 2,后 5 全绑 biz-admin 无例外 E-R-19);biz-admin 42→**47**;ops-admin 61→**63**;member 9 零变化;**8 新码端点 T2/T3 实装前孤码 WARN 预期**(镜像保险 T1 先例);endpoint **183** 不变(T1 仅 schema/migration/seed)。**controller 38→39 true-up**:此数为 #372 `GET /api/admin/v1/me`(`AdminMeController`)合入后**既存漂移**、非本 T1 新增(T1 零新 controller),沿 §6 规则 6「先报告再 true-up」随本 PR 校正。BizCode 27/28xxx 段与 audit 不属本表。
> 2026-06-18 招新一期 T2 戳(同 goal):**权限事实零变化**(136 码 / 绑定 / 内置角色不动);endpoint 183→**186**(realname-settings 三端点 `[rbac: realname-setting.*]`);controller 39→**40**(`RealnameSettingsController`);**T1 期 realname 3 码孤码 WARN 清零**(端点实装);BizCode 27xxx(27030/27031)+ baseline §1.1 `270xx` 红区行随本 T2 PR(评审稿 §11 归属微调:27xxx 随 realname 模块走,self-contained 可测);recruitment 5 码仍孤码(T3 清零)。`docs:rbacmap:check` 0 FAIL / 5 WARN(预期)。
>
> 2026-06-18 招新一期 T3 戳(同 goal,收口):**权限事实零变化**(136 码 / 绑定 / 内置角色不动);endpoint 186→**196**(open/v1 公开报名 2 `[public]` + admin/v1 轮次 4〔`recruitment-cycle.*`〕+ admin/v1 报名 4〔`recruitment-application.*`〕);controller 40→**43**(`RecruitmentPublicController`〔open/v1 首用,@Public 无码〕 + `RecruitmentCyclesController` + `RecruitmentApplicationsAdminController`);**recruitment 5 码孤码 WARN 清零**(T1 预留端点 T3 实装);**`open/v1` 首用**——api-surface-policy §0「预留→首用」解锁,第 5 canonical 前缀(`scripts/check-rbac-map.ts` + `test/contract/openapi.contract-spec.ts` 的 `CANONICAL_PREFIXES` 同步);BizCode 28xxx(280xx 段)+ baseline §1.1 行随本 T3 PR;audit +5 DB union + 2 placeholder 不属本表。`docs:rbacmap:check` 0 FAIL / 0 WARN。
>
> 2026-06-19 招新二期 T1 戳(goal「招新 phase 2(招新后段)」,冻结评审稿 [`recruitment-phase2-review.md §3.4`](../archive/reviews/recruitment-phase2-review.md)):权限码 136→**139**(recruitment-application +3:`mark.threshold` / `evaluate.assessment` / `promote.member`,全绑 biz-admin 无例外 E-R2-11);biz-admin 47→**50**;ops-admin 63 / member 9 零变化;endpoint **196** 不变(T1 仅 schema/migration/seed);**3 新码端点 T2/T3 实装前孤码 WARN 预期**(镜像招新一期 T1 先例);BizCode 28041-28043 + audit +3 DB union 不属本表(随 T2/T3 PR)。
>
> 2026-06-19 招新二期 T2 戳(同 goal):**权限事实零变化**(139 码 / 绑定 / 内置角色不动);endpoint 196→**199**(admin 标门槛 `PATCH .../applications/{id}/thresholds` + 综合评定 `POST .../applications/{id}/evaluate` + 公示名单 `GET .../cycles/{id}/publicity-list`〔复用 `recruitment-application.read.record`〕);controller 43 不变(扩既有 2 controller);**`mark.threshold` / `evaluate.assessment` 2 码孤码 WARN 清零**(`promote.member` 仍孤码,T3 清零);BizCode 28041 + audit +2 DB union(`mark-threshold` / `evaluate`)随本 T2 PR。`docs:rbacmap:check` 0 FAIL / 1 WARN(预期)。
>
> 2026-06-19 招新二期 T3 戳(同 goal,收口):**权限事实零变化**(139 码 / 绑定 / 内置角色不动);endpoint 199→**200**(一键发号 `POST .../cycles/{id}/promote`〔建 User+Member;`recruitment-application.promote.member`〕);controller 43 不变(扩既有 cycles controller);**`promote.member` 孤码 WARN 清零 → 招新二期 3 码全实装**(`docs:rbacmap:check` **0 FAIL / 0 WARN**);BizCode 28042(发号唯一冲突)/ 28043(流水撞 999)+ audit +1 DB union(`promote`)随本 T3 PR;**首次在 members/users 落地写**(promote 单事务建 User+Member+profile+contacts,**直连 prisma 不复用 service**,两层身份:无部门无级别)。
>
> 2026-06-19/20 招新三期(入队:志愿者→队员)T1-T4 戳(goal「招新 phase 3(入队)」,冻结评审稿 [`recruitment-phase3-review.md`](../archive/reviews/recruitment-phase3-review.md);PR #391/#392/#393/#394,T5 收尾本 PR):权限码 139→**146**(team-join-cycle 3〔read/create/update〕+ team-join-application 4〔read / mark.gate / evaluate.assessment / join.member〕,全绑 biz-admin 无例外);biz-admin 50→**57**;ops-admin 63 / member 9 零变化;**自助 `app/v1/me/team-join/*` self-scope 零权限码**(镜像 insurances me)。controller 43→**46**(+3:`TeamJoinCyclesController` + `TeamJoinApplicationsAdminController` + `TeamJoinApplicationsAppController`〔app self-scope `[auth]` 无码〕;一键入队 `/join` 扩既有 admin controller 不新增 class)。endpoint 200→**212**(admin 9〔轮次 CRUD 4 + 报名 list/detail/标 gate/综合评估/一键入队 5〕+ app self 3〔发起/查进度/改候选,`[auth]`〕)。BizCode **282xx**(28201/28202/28203/28210/28230/28240/28241/28242)+ audit +6 DB union(`team-join-cycle.{create,update}` / `team-join-application.{submit,mark-gate,evaluate,join}`)不属本表(随各 PR)。`docs:rbacmap:check` **0 FAIL / 0 WARN**(各 PR 间码随 controller 实装、无孤码;T5 本 PR 计数 true-up 收口)。
>
> 2026-06-21 CMS 内容发布模块(第 28 模块)T1 戳(goal「内容发布模块」,冻结评审稿 [`content-module-review.md`](../archive/reviews/content-module-review.md)):权限码 146→**155**(content.* 5〔`content.{read,create,update,delete,publish}.record`〕+ attachment.content-* 4〔`attachment.{upload,delete}.content-image|content-file`,内容写路径 coarse,α 决议〕,**全绑 biz-admin**);biz-admin 57→**66**;ops-admin 63 / member 9 零变化。**演进 Slow-4 §6「biz-admin 不含 attachment.* 码」不变式 → 仅含 CMS content-* 4 码**(`seed-biz-admin.e2e` 同步 true-up)。T1 仅 schema/migration/seed,**controller / endpoint 不变**(content 三 controller + 16 端点随 T2-T4);BizCode 290xx +5 + audit +4 随 T2。`docs:rbacmap:check` **0 FAIL / 5 WARN 预期**(content.* 5 码 T2/T4 controller 实装前孤码;attachment.content-* 4 码由动态前缀覆盖不孤)。
>
> 2026-06-21 CMS 内容发布模块 T2 戳(同 goal):**权限事实零变化**(155 码 / 绑定 / 内置角色不动);controller 46→**47**(`ContentAdminController`,`admin/v1/contents`);endpoint +12 admin(建/列/详/改/软删 + 状态机 publish/unpublish/archive + 附件 upload-url/confirm/删 + 封面)。**content.* 5 码孤码 WARN 清零**(T2 service `rbac.can` 字面量引用);附件写端点后缀走 `[rbac: attachment.upload.*]`/`[rbac: attachment.delete.*]` 通配族 + confirm `[auth]`。BizCode 290xx 已于 T1 落库(本 T2 仅引用);audit `content.{create,update,delete,publish}` 已于 T1 入 union(本 T2 实际写)。`docs:rbacmap:check` **0 FAIL / 0 WARN**。app/open 面(T3/T4)后续追加。
>
> 2026-06-21 CMS 内容发布模块 T3/T4 戳(同 goal,读取面收口):**权限事实零变化**(155 码 / 绑定 / 内置角色不动;open/app 读取面**零新权限码**——public + canUseApp self-scope);controller 47→**49**(+`ContentPublicController`〔open/v1/contents,@Public 无码 `[public]`,第 10 throttler `content-public` 60/60s〕 + `ContentAppController`〔app/v1/contents,canUseApp 准入 + 5 档可见性,无码 `[auth]`〕)。endpoint +4(open 2〔列表/详情,仅 published+public 防枚举〕 + app 2〔列表/详情,5 档可见性过滤 + viewCount 自增〕)。**5 档可见性**(public / member / formal_member / department / management)纯函数 `content.visibility.ts` 21 单测;读者出参零 authorUserId / 零 visibleOrganizationIds;签名 URL 为范围例外 a(`attachments/CLAUDE.md` 已 true-up)仅过可见级后返。`docs:rbacmap:check` **0 FAIL / 0 WARN**。
>
> 2026-06-23 队员/审批跨轴只读查询戳(goal「队员/审批『跨轴只读查询』补全」,支撑前端任务驱动后台 · 交接层 GAP-001 Tier2 / GAP-002 Tier3):**权限事实零变化**(155 码 / 绑定 / 内置角色不动——5 端点全复用现成 read 码,**零新码**);controller 49→**52**(+3:`AdminRegistrationsController`〔admin/v1/registrations〕 + `AdminMemberRegistrationsController`〔admin/v1/members/:memberId/registrations〕 + `AdminMemberAttendanceController`〔admin/v1/members/:memberId,attendance-records + contribution-summary 2 端点〕;跨活动考勤单据横扫为既有 `AttendanceSheetsResourceController` 加根 @Get,**不新增 class**)。endpoint +5(Tier2 跨活动横扫 registrations + attendance-sheets〔`[rbac: activity-registration.read.record]` / `[rbac: attendance.read.sheet]`〕;Tier3 队员 360 registrations + attendance-records + contribution-summary)。贡献值汇总实时算不落库,复用 team-join `computeCappedContribution` 封顶核(approved sheet + 北京日封顶 1.5,生涯累计无 cutoff;**禁裸 SUM**);MEMBER_NOT_FOUND 守卫镜像 admin-member-insurances。零 BizCode / 零 migration / 零 schema 列 / 零 audit event(纯读)。`docs:rbacmap:check` **0 FAIL / 0 WARN**。
>
> 2026-06-24 招新闭环优化 S3 戳(goal「招新闭环优化 S3 — RBAC 敏感字段分级」,冻结评审稿 [`recruitment-phase4-loop-optimization-review.md §11`](../archive/reviews/recruitment-phase4-loop-optimization-review.md) / Q-P4-10):权限码 155→**156**(recruitment-application +1:`read.sensitive` 敏感查看,从 `read.record` 切出,全绑 biz-admin 无例外);biz-admin 66→**67**;ops-admin 63 / member 9 零变化;endpoint **200** 不变 / controller **52** 不变(既有端点判权细化,零新端点/类)。`read.record` 语义收窄(脱敏列表 + 脱敏详情 + 公示名单 + 工作台 stats);`read.sensitive` 实装即用(详情明文证件号/手机闸 + 证件照 signed-URL),**0 孤码**。**§11.2 迁移:现 biz-admin 持 read.record,拆分后由 `BIZ_ADMIN_PERMISSION_SEED` 自动补挂 read.sensitive → 明文行为不回退;15+1 码现全绑 biz-admin 无其他角色,本切片对现有用户零行为变化(分级仅对将来细分角色生效)**。零 schema / 零 migration;改 RBAC 契约 → 同 PR 更新 `docs/handoff` admin-web 能力图 + 前端对接指南。`docs:rbacmap:check` **0 FAIL / 0 WARN**。
>
> 2026-06-25 统一通知模块 S1 站内信渠道戳(goal「GAP-005 统一通知模块 S1 — 站内信渠道」,冻结评审稿 [`unified-notification-dispatcher-review.md §5/§9/§11`](../archive/reviews/unified-notification-dispatcher-review.md) supersede [`member-notification-review.md`](../archive/reviews/member-notification-review.md)):权限码 156→**161**(notification +5:`notification.{read,create,update,delete,publish}.record`,全绑 biz-admin 无例外,**实装即用 0 孤码**);biz-admin 67→**72**;ops-admin 63 / member 9 零变化;controller 52→**54**(+`NotificationAdminController`〔admin/v1/notifications,R 模式 `rbac.can` **无 @RequirePermissions**〕 + `NotificationAppController`〔app/v1/notifications,canUseApp 准入 + 4 档可见性无码 `[auth]`〕);endpoint +12(admin 8 CRUD + 状态机 publish/unpublish/archive;app 4 list/unread-count/detail/mark-read)。可见性**复用** content.visibility(去 public = 4 档,零第二套);状态机镜像 content;BizCode 310xx 5 码;audit `notification.{create,update,delete,publish}` 4 事件(publish 伞盖三跃迁)。统一形状列 audienceType/sourceType/channels 本切片即加(S1 仅 broadcast/admin/in-app),微信 quota / 短信兜底 / producer 定向 = S2-S5 additive 不返工。第 27 migration(notifications + notification_reads 两表)。改 RBAC 契约 → 同 PR 更新 `docs/handoff` admin-web 能力图 + 前端对接指南。`docs:rbacmap:check` **0 FAIL / 0 WARN**。
>
> 2026-06-25 统一通知模块 S2 微信订阅 quota 渠道戳(goal「GAP-005 统一通知模块 S2 — 微信订阅 quota 渠道」,冻结评审稿 [`unified-notification-dispatcher-review.md §3/§7/§9`](../archive/reviews/unified-notification-dispatcher-review.md)):权限码 161→**162**(notification +1:`notification.update.template` 微信模板配置写权,运营可配 D-N3,全绑 biz-admin 无例外,**实装即用 0 孤码**;读模板配置复用 `notification.read.record` 不另开 read 码,§9.2「至多 +1」预算);biz-admin 72→**73**;ops-admin 63 / member 9 零变化;controller 54→**55**(+`NotificationWechatTemplateAdminController`〔admin/v1/notification-wechat-templates,R 模式 `rbac.can` **无 @RequirePermissions**;独立 base path 避与 notifications/:id 冲突〕);endpoint +4(app/v1/notifications/subscriptions 2:ack/status,canUseApp 准入无码 `[auth]`;admin/v1/notification-wechat-templates 2:list〔read.record〕/ upsert〔update.template〕)。微信派发 = publish 事务外同步分支(`NotificationDelivery` 记账,§6.2 HTTP 事务外;零新端点);quota +1 封顶(D-N2 默认 5)/ 条件原子 -1;BizCode **零新增**(发送失败落 delivery errCode 非 API 异常,ack/status 格式校验走通用 400);第 28 migration(notification_deliveries + wechat_subscription_quotas + wechat_subscribe_templates 三表)。L3:微信 access_token / appSecret / openid 零出参零明文入日志(沿 wechat E-12 + maskOpenid)。改 RBAC 契约 → 同 PR 更新 `docs/handoff` admin-web 能力图 + 前端对接指南。`docs:rbacmap:check` **0 FAIL / 0 WARN**。

> 2026-06-27 统一通知模块 S5 短信兜底渠道戳(goal「GAP-005 统一通知模块 S5 — 短信兜底渠道」,冻结评审稿 [`unified-notification-dispatcher-review.md §4/§8.3/§9`](../archive/reviews/unified-notification-dispatcher-review.md)):权限码 162→**163**(notification +1:`notification.send.sms` 短信发起成本动作单独 gating,计费确认必需 D-N4,全绑 biz-admin 无例外,**实装即用 0 孤码**);biz-admin 73→**74**;ops-admin 63 / member 9 零变化;controller **55** 不变(扩既有 `NotificationAdminController`,零新 class);endpoint +1 → **260**(`POST admin/v1/notifications/:id/send-sms`;R 模式 `notification.send.sms` 无 @RequirePermissions)。短信派发 = admin 显式 confirmed=true 触发的事务外同步分支(`NotificationSmsDispatchService` 复用 `SmsProviderRouter.sendNotification` additive + `NotificationDelivery`/`sms_send_logs` 记账,§6.2 HTTP 事务外;**短信永不随 publish 自动发**);防滥发继承同号封顶 10/间隔 60s/同日同模板幂等(查 `sms_send_logs`)+ FAILED 逐人不阻断;BizCode +1(310xx 段 31013 `NOTIFICATION_SMS_NOT_SENDABLE` 须已发布且声明短信渠道;通道未配置走既有 24030;confirmed 缺失走通用 400);audit 复用 `notification.publish` 伞事件 `operation='send-sms'` + 收件人计数(**无新增 audit 串**;§13.2 admin 入 audit / 逐条投递不入 audit)。第 30 migration(`sms_settings.templateIdNotification` 1 列 additive)。L2:手机号一律 `maskPhone`(delivery/日志/审计零明文)。改 RBAC 契约 → 同 PR 更新 `docs/handoff` admin-web 能力图 + 前端对接指南。`docs:rbacmap:check` **0 FAIL / 0 WARN**。

> 2026-07-01 终态 scoped-authz PR1 组织基座戳(goal「终态 scoped-authz 落地序列【首刀 PR1 — 组织基座】」,冻结评审稿 [`org-position-scoped-authz-terminal-design-review.md §3.8/§8.3/§11`](../reviews/org-position-scoped-authz-terminal-design-review.md)):权限码 163→**164**(org +1:`org.move.node` reparent 重挂父级,绑 ops-admin 沿 org.*.node 现绑,**实装即用 0 孤码**);ops-admin 63→**64**;biz-admin 74 / member 9 零变化;controller **55** 不变(扩既有 `OrganizationsController`,零新 class);endpoint +1 → **261**(`POST admin/v1/organizations/:id/move`;R 模式 service 层 `rbac.can('org.move.node')` 无 @Roles)。复活两死 BizCode(`ORGANIZATION_PARENT_CYCLE` 11012 环检测〔closure 判定目标父=自身/后代〕/ `ORGANIZATION_PARENT_CHANGE_FORBIDDEN` 11013 受限位置〔禁改根节点父级,守单根上限〕);move 事务内重算受影响子树 closure(删旧祖先→子树边、按新父插入,PK 兜底防重)。第 32 migration(新表 `organization_closure` 闭包表 + WITH RECURSIVE 从现有 parentId 树一次性回填〔含 depth-0 自身行〕+ `Organization` 两 additive 可空列 `establishmentStatusCode?`/`groupFunctionCode?` R1/R3,纯加性、无破坏、无不可逆);`node_type` 字典 +`group` 一值 + 新字典 `org_establishment_status`(闭集 formal/provisional,登记 SYSTEM+ITEM 防误删)+ 留口字典 `group_function`(空 items,沿 `join_source` 自由串候选惯例不登记)。**closure 只建 + 维护、本刀绝不被任何模块读作授权**(AuthzService 是 PR8);两 additive 列 schema-only、不进 DTO / OpenAPI / 现有读路径。行为锁:现有组织 CRUD / getTree / 单根上限 / 软删护栏(HAS_CHILDREN/HAS_MEMBERS/LAST_ROOT)逐字不变。landing 序列 PR1/12,不单独发版。`docs:rbacmap:check` **0 FAIL / 0 WARN**。

---

## 1. 双轨架构现状(一句话版)

三层 `Role` enum(SUPER_ADMIN > ADMIN > USER,Guard 链全局注册:`ThrottlerBizGuard → JwtAuthGuard → RolesGuard`)是**身份层**;判权**单轨**走 RBAC 4 表(`RbacRole` / `Permission` / `RolePermission` / `UserRole`,Service 层 `rbac.can()`):

- **管理面 / 配置面 / System surface:已收紧**(v0.15.0 P0-F)——controller 不标 `@Roles`,入口仅要求登录,每个写读路径在 Service 层 `rbac.can('<code>')` 判权,SUPER_ADMIN 短路通过。
- **业务面:已收口**(2026-06-11 Slow-4,goal #314-#317)——原 G 模式 7 模块 44 端点全部摘 `@Roles`:42 端点 Service 层判权(`biz-admin` 承载 ADMIN 业务权限,Slow-3 决议;`member.delete.record` 仅 SA 短路),activities 列表/详情 2 端点无码仅登录(`[auth]`,Q-A7 过滤留 service)。**全仓活跃 `@Roles` = 0**;`RolesGuard` 机制与装饰器保留 Guard 链(防御性兜底),新 endpoint 不再标 `@Roles`。
- **App surface:不走 RBAC**——仅 JwtAuthGuard + Service 层 `where: { memberId: currentUser.memberId }` self-scope + 准入语义(`memberId != null && User.ACTIVE && Member.ACTIVE`);capabilities 返回产品级能力而非 raw permission code(D-5.3)。
- **没有 `@Permissions` 装饰器 / PermissionsGuard**(已核实不存在)。判权唯一服务入口 = `RbacService.can()`;`RbacCacheService` 是权限解析缓存(TTL 1800s,三档失效),不是身份缓存。

## 2. controller × 鉴权模式对照(55 个 controller class)

### 2.1 R 模式 — Service 层 `rbac.can()`(管理面,已收紧)

| controller(路径前缀) | 权限码域 |
|---|---|
| `system/v1/permissions` | `rbac.permission.*`(4) |
| `system/v1/roles` | `rbac.role.*`(4) |
| `system/v1/roles/:id/permissions` | `rbac.role-permission.*`(2) |
| `system/v1/users/:userId/roles` | `rbac.user-role.*`(3) |
| `system/v1/rbac`(reload) | `rbac.config.reload`(1);`GET me/permissions` 仅登录(方法级 Mixed 存量) |
| `admin/v1/users` | `user.*`(9;其中 `user.update.role` 不绑 ops-admin,仅 SA 短路 = D1=A 拍板;`user.phone.clear` 为 SMS T3 清号端点;`user.wechat.clear` 为 WECHAT T3 清除端点)|
| `system/v1/audit-logs` | `audit-log.read.entry`(1) |
| `system/v1/dict-types` + `dict-items` | `dict.*.type` / `dict.*.item`(8) |
| `admin/v1/organizations` | `org.*.node`(4) |
| `admin/v1/members/:id/department` | `member-department.*.current`(3) |
| `system/v1/contribution-rules` | `contribution.*.rule`(4) |
| `system/v1/attachment-{type,mime,size-limit}-configs` | `attachment-config.*`(12) |
| `system/v1/storage-settings` | `storage-setting.*`(3;`reset.credentials` 不绑 ops-admin = D2=A 拍板) |
| `system/v1/sms-settings` | `sms-setting.*`(3;`reset.credentials` 不绑 ops-admin,镜像 D2=A;SMS T2)|
| `system/v1/sms-send-logs` | `sms-send-log.read.list`(1;响应手机号一律掩码;SMS T2)|
| `system/v1/wechat-settings` | `wechat-setting.*`(3;`reset.credentials` 不绑 ops-admin,镜像 D2=A;WECHAT T2)|
| `system/v1/realname-settings` | `realname-setting.*`(3;`reset.credentials` 不绑 ops-admin,镜像 D2=A;招新 T2)|
| `admin/v1/attachments`(业务面首批) | `attachment.*`(20:member/certificate 各 8 含 `.self`/`.other`,activity 4) |
| `admin/v1/members`(Slow-4 T2) | `member.*`(5;DELETE = `member.delete.record` 仅 SA 短路不绑 biz-admin) |
| `admin/v1/members/:memberId/profile`(Slow-4 T2) | `member-profile.*.record`(3) |
| `admin/v1/members/:memberId/emergency-contacts`(Slow-4 T2) | `emergency-contact.*.record`(4) |
| `admin/v1/members/:memberId/certificates`(Slow-4 T2) | `certificate.*.record`(6;list/detail/qualification-flag 共用 read) |
| `admin/v1/activities`(Slow-4 T3) | `activity.*.record`(5,仅 5 个写端点;**列表/详情无码仅登录 `[auth]`**) |
| `admin/v1/activities/:activityId/registrations`(Slow-4 T3) | `activity-registration.*.record`(5;list/export 共用 read) |
| `admin/v1/registrations`(跨轴只读 2026-06-23) | `activity-registration.read.record`(1;跨活动报名横扫,审批工作台,复用 read 零新码) |
| `admin/v1/members/:memberId/registrations`(跨轴只读 2026-06-23) | `activity-registration.read.record`(1;某队员报名履历,队员 360,复用 read;MEMBER_NOT_FOUND 守卫) |
| `admin/v1/…attendance-sheets`(2 个 Admin class;Slow-4 T3;跨轴只读 2026-06-23 加根 @Get) | `attendance.*.sheet`(8;list/detail/review-detail/跨活动根 list 共用 read;终审两码独立,ADMIN 级沿 P1-5 方案 A) |
| `admin/v1/members/:memberId`(attendance 派生跨轴只读 2026-06-23) | `attendance.read.sheet`(1 码 2 端点:考勤记录 attendance-records + 贡献值汇总 contribution-summary;贡献值实时算复用 team-join 封顶核;MEMBER_NOT_FOUND 守卫) |
| `admin/v1/team-insurance-policies`(保险 T2) | `team-insurance-policy.*`(6;list/detail/覆盖名单共用 read;add/remove 覆盖名单两码独立) |
| `admin/v1/members/:memberId/insurances`(保险 T2) | `member-insurance.read.other`(1;数组无分页镜像 certificates;本人侧走 App self-scope 无码) |
| `admin/v1/recruitment/cycles`(招新 T3) | `recruitment-cycle.*.record`(3;list/detail 共用 read;开/关轮 + 容量/通知模板走 update) |
| `admin/v1/recruitment/applications`(招新 T3;二期 T2;闭环优化 S3) | `recruitment-application.*`(5;list/脱敏详情共用 `read.record`;详情明文证件号·手机 + 证件照 signed-URL `read.sensitive`〔S3 §11〕;人工待核 `resolve.manual`;标门槛 `mark.threshold`;综合评定 `evaluate.assessment`)|
| `admin/v1/team-join/cycles`(招新三期入队 T2) | `team-join-cycle.*.record`(3;list/detail 共用 read;开/关轮 + 轮次名走 update) |
| `admin/v1/team-join/applications`(招新三期入队 T2/T4) | `team-join-application.*`(4;list/detail 共用 `read.record`;标 gate `mark.gate`;综合评估 `evaluate.assessment`;一键入队 `join.member`〔T4 设部门+级别 level-1〕)|
| `admin/v1/contents`(CMS 内容 T2) | `content.*.record`(5;list/detail 共用 `read.record`;状态机 publish/unpublish/archive 共用 `publish.record`;封面 set/clear 走 `update.record`)。附件端点 upload-url/confirm/删 经 `AttachmentsService` 写路径判 `attachment.{upload,delete}.content-image\|content-file`〔`[rbac: attachment.upload.*]`/`[rbac: attachment.delete.*]` 通配族〕;confirm 仅 JWT + token〔`[auth]`〕|
| `admin/v1/notifications`(统一通知 S1 站内信渠道 + S5 短信兜底) | `notification.*.record`(5;list/detail 共用 `read.record`;状态机 publish/unpublish/archive 共用 `publish.record`;create/update/delete 各一)+ **S5** `notification.send.sms`(`POST :id/send-sms` 显式发起短信兜底)。**无 @RequirePermissions**,R 模式 service `rbac.can`(镜像 content);可见性复用 content.visibility(去 public = 4 档);BizCode 310xx 6 码(S5 +31013 `NOTIFICATION_SMS_NOT_SENDABLE`);audit `notification.{create,update,delete,publish}` 4 事件(publish 伞盖 publish/unpublish/archive/**send-sms** 四跃迁/动作)。**S2:** create/update 加 `channels` 勾选(可含 wechat/sms);publish 含 wechat → 事务外微信派发。**S5:** channels 可声明 `sms`;短信**永不随 publish 自动发**,仅 `send-sms` 端点 confirmed=true 触发(计费确认),逐可见有手机者经 `SmsProviderRouter` 单发 + `NotificationDelivery`/`sms_send_logs` 记账(maskPhone),防滥发继承同号封顶/间隔/同日同模板幂等 |
| `admin/v1/notification-wechat-templates`(统一通知 S2 微信模板配置) | list = `notification.read.record`(复用)/ upsert(`PUT /:typeCode`)= `notification.update.template`。**无 @RequirePermissions**,R 模式 service `rbac.can`;运营可配 notificationTypeCode→templateId(D-N3),独立 base path 避与 notifications/:id 冲突 |
| `app/v1/notifications/subscriptions`(统一通知 S2 微信订阅 quota) | **无码**(canUseApp 准入 `[auth]`):ack(`POST subscriptions/ack` quota +1 封顶)/ status(`GET subscriptions/status` 查剩余配额);字面段 subscriptions/* 声明于 :id 之前 |

### 2.1b A 模式 — `@Public` 无账号公开端点(招新 T3 首用)

| controller(路径前缀) | 鉴权 |
|---|---|
| `open/v1/recruitment`(招新 T3;公开报名提交/查询) | `@Public` 跳过 JwtAuthGuard;无 rbac 码;按 IP 走第 9 throttler `recruitment`(10/3600);敏感字段仅入库不回显 |
| `open/v1/contents`(CMS T3;公开内容列表/详情) | `@Public` 跳过 JwtAuthGuard;无 rbac 码;按 IP 走第 10 throttler `content-public`(60/60s 读取适配);仅 published+public 可见,详情非 public → 404 防枚举;读者出参零 authorUserId / 零 visibleOrganizationIds;签名 URL 为范围例外 a 仅过可见级后返 |

> `open/v1` = **第 5 canonical 前缀**(api-surface-policy §0「预留→首用」T3 解锁;无账号自助报名 surface,小程序前端直连)。`auth/v1` 的 `@Public` 登录端点同属无码,但归 auth 域既有计列;此处登记招新公开 surface + CMS 公开内容读取面。

### 2.2 G 模式 — Guard `@Roles`(已清零)

**2026-06-11 Slow-4 T2/T3(#316/#317)后不存在 G 模式 controller**:原 7 模块 44 处 `@Roles`(历史计数"48 处"系本表笔误,亲核 true-up 见评审稿 D-S4-1)全部迁入上方 R 模式或无码化;迁移前逐端点形态冻结于评审稿 §3 映射表。

### 2.3 A 模式 — App surface(32 endpoint,JwtAuthGuard + 准入;SMS T3 +me/phone 两端点、WECHAT T3 +me/wechat 两端点均沿 me/password 账号级豁免;保险 T2 +me/insurances 4 端点 CRUD;招新三期入队 T3 +me/team-join 3 端点;CMS T4 +contents 2 端点可见性闸;统一通知 S1 +notifications 4 端点站内信拉取〔list/unread-count/detail/mark-read〕)

`app/v1/me`(7,含 GET/PUT me/wechat〔openid 一律掩码回显〕)/ `app/v1/me/insurances`(4,自购保险自助 CRUD,保险 T2;26001 防侧信道)/ `app/v1/me/team-join`(3,入队自助:发起申请/查进度/改候选部门,招新三期 T3;准入 AppIdentityResolver canUseApp=false→403,锁 currentUser.memberId 防 IDOR)/ `app/v1/activities`(2)/ `app/v1/my`×3 class(registrations 5 + attendance-records 1 + certificates 1)+ `app/v1/me/password`(继承 P0-D/P0-E 全套铁律)+ `app/v1/contents`(2,CMS 内容会员读取面 T4;准入 canUseApp=false→403,**非 self-scope 而是 5 档可见性闸**〔public/member/formal_member/department/management〕,详情不可见 → 404 防枚举,viewCount 自增)+ `app/v1/notifications`(4,统一通知 S1 站内信拉取:list/unread-count/detail/mark-read;准入 canUseApp=false→403,**4 档可见性闸**〔复用 content.visibility 去 public〕,详情/mark-read 不可见 → 404 防枚举;mark-read 幂等 upsert + readCount 原子 +1;**unread-count 字面段声明于 :id 之前**;读者出参零 authorUserId/visibleOrganizationIds/statusCode/readCount)。**永不返回 L3 字段**(`passwordHash` / `refreshToken` / `tokenHash` / `secretKey*` / `secretId*` / `appSecret*` / `session_key` / 完整 signed URL;**例外 a**:content-* 签名 URL 仅在过文章可见级后于 open/v1+app/v1 内容读取面返回,见 `attachments/CLAUDE.md`)。

### 2.4 P 模式 — `@Public`

`auth/v1`:login / refresh / logout(logout-all 走 JWT)/ password-reset×2 / login-sms×2 / **login-wechat + wechat-bind×2(WECHAT T3,第 8 throttler 'login-wechat' 5/60)**;`system/v1/health`:live / ready。

## 3. 权限码全集(164 条,seed 幂等 upsert)

| 域 | 条数 | 码 |
|---|---|---|
| rbac meta | 14 | `rbac.permission.{read,create,update,delete}` / `rbac.role.{read,create,update,delete}` / `rbac.role-permission.{create,delete}` / `rbac.user-role.{read,create,delete}` / `rbac.config.reload` |
| 字典 | 8 | `dict.{read,create,update,delete}.{type,item}` |
| 组织 | 5 | `org.{read,create,update,delete}.node` / `org.move.node`(终态 scoped-authz PR1 reparent 重挂父级;绑 ops-admin) |
| 队员部门 | 3 | `member-department.{read,set,clear}.current` |
| 贡献规则 | 4 | `contribution.{read,create,update,delete}.rule` |
| 附件配置 | 12 | `attachment-config.{read,create,update,delete}.{type,mime,size-limit}` |
| 存储设置 | 3 | `storage-setting.{read,update}.singleton` / `storage-setting.reset.credentials` |
| 短信设置 | 3 | `sms-setting.{read,update}.singleton` / `sms-setting.reset.credentials`(SMS T2,评审稿 §3.4)|
| 短信日志 | 1 | `sms-send-log.read.list`(SMS T2)|
| 微信设置 | 3 | `wechat-setting.{read,update}.singleton` / `wechat-setting.reset.credentials`(WECHAT T2,评审稿 §3.4)|
| 用户管理 | 9 | `user.{read,create,update,delete}.account` / `user.reset.password` / `user.update.role` / `user.update.status` / `user.phone.clear`(SMS T2 seed,T3 端点已实装)/ `user.wechat.clear`(WECHAT T2 seed,T3 端点实装前孤码 WARN 预期)|
| 审计 | 1 | `audit-log.read.entry` |
| 附件业务 | 20 | `attachment.{upload,view,update,delete}.member.{self,other}`(8)/ `…certificate.{self,other}`(8)/ `…activity`(4) |
| 队员(Slow-4 T1) | 5 | `member.{read,create,update,delete}.record` / `member.update.status` |
| 队员扩展档案(Slow-4 T1) | 3 | `member-profile.{read,create,update}.record` |
| 紧急联系人(Slow-4 T1) | 4 | `emergency-contact.{read,create,update,delete}.record` |
| 证书(Slow-4 T1) | 6 | `certificate.{read,create,update,delete}.record` / `certificate.{verify,reject}.record` |
| 活动(Slow-4 T1) | 5 | `activity.{create,update,delete}.record` / `activity.{publish,cancel}.record`(列表/详情无码,仅登录) |
| 活动报名(Slow-4 T1) | 5 | `activity-registration.{read,create}.record` / `activity-registration.{approve,reject,cancel}.record` |
| 考勤(Slow-4 T1) | 8 | `attendance.{create,read,update,delete}.sheet` / `attendance.{approve,reject,final-approve,final-reject}.sheet` |
| 队保单(保险 T1) | 6 | `team-insurance-policy.{read,create,update,delete}.record` / `team-insurance-policy.{add,remove}.member`(T2 端点实装前孤码 WARN 预期) |
| 队员自购保险(保险 T1) | 1 | `member-insurance.read.other`(admin 查队员保险;App 本人侧 self-scope 无码;T2 实装) |
| 实名核验设置(招新 T1) | 3 | `realname-setting.{read,update}.singleton` / `realname-setting.reset.credentials`(`reset` 不绑 ops-admin 镜像 D2=A;T2 端点实装前孤码 WARN 预期) |
| 招新轮次(招新 T1;T3 实装) | 3 | `recruitment-cycle.{read,create,update}.record`(`admin/v1/recruitment/cycles`;孤码 T3 清零) |
| 招新报名(招新一期 T1→T3;二期 T1→T2/T3;闭环优化 S3) | 6 | `recruitment-application.read.record`(普通查看:脱敏列表 + 脱敏详情 + 公示名单 + 工作台 stats 共用)/ `recruitment-application.read.sensitive`(敏感查看:详情明文证件号·手机 + 证件照 signed-URL;S3 §11.1 从 read.record 切出,全绑 biz-admin)/ `recruitment-application.resolve.manual`(人工待核 resolve)/ `recruitment-application.mark.threshold`(标门槛)/ `recruitment-application.evaluate.assessment`(综合评定/淘汰)/ `recruitment-application.promote.member`(一键发号建 User+Member);`admin/v1/recruitment/*` |
| 入队轮(招新三期入队 T2) | 3 | `team-join-cycle.{read,create,update}.record`(`admin/v1/team-join/cycles`;list/detail 共用 read;至多一个 open 轮) |
| 入队申请(招新三期入队 T2/T4) | 4 | `team-join-application.read.record`(列表/详情共用)/ `team-join-application.mark.gate`(标 gate)/ `team-join-application.evaluate.assessment`(综合评估/淘汰)/ `team-join-application.join.member`(一键入队 = 设部门 + 级别 level-1,T4);`admin/v1/team-join/applications`;自助 `app/v1/me/team-join/*` 发起/查进度/改候选 **self-scope 无码** |
| 内容发布(CMS T1 seed;T2 admin 实装) | 5 | `content.{read,create,update,delete,publish}.record`(`admin/v1/contents`;list/detail 共用 read;状态机 publish/unpublish/archive 共用 publish;封面 set/clear 走 update;app/open 读零码 T3/T4;**T2 controller 实装后孤码 WARN 清零**) |
| 内容附件(CMS T1;content-image/file 写) | 4 | `attachment.{upload,delete}.content-image` / `attachment.{upload,delete}.content-file`(内容写路径 coarse,α;全绑 biz-admin;读路径 content 自签 + 文章可见级无码;由 `attachment.{upload,delete}.` 动态前缀覆盖不孤) |
| 统一通知 S1 站内信渠道(2026-06-25) | 5 | `notification.{read,create,update,delete,publish}.record`(`admin/v1/notifications`;list/detail 共用 read;状态机 publish/unpublish/archive 共用 publish;create/update/delete 各一;app 会员读取面零码 = canUseApp 闸 + 4 档可见性;全绑 biz-admin;**实装即用 0 孤码**)|
| 统一通知 S2 微信订阅 quota 渠道(2026-06-25) | 1 | `notification.update.template`(`admin/v1/notification-wechat-templates` upsert;微信模板配置写权,运营可配 D-N3;读复用 `notification.read.record`;app 订阅 ack/status 零码 = canUseApp 闸;全绑 biz-admin;**实装即用 0 孤码**)|
| 统一通知 S5 短信兜底渠道(2026-06-27) | 1 | `notification.send.sms`(`admin/v1/notifications/:id/send-sms`;显式发起短信兜底〔紧急召集〕成本动作单独 gating,计费确认必需 confirmed=true;全绑 biz-admin;**实装即用 0 孤码**)|

内置角色:`ops-admin`(绑 64 条:全集过滤 `user.update.role` + `storage-setting.reset.credentials` + `sms-setting.reset.credentials` + `wechat-setting.reset.credentials` + `realname-setting.reset.credentials`,五者仅 SUPER_ADMIN 短路可用——**这是已拍板设计 D1=A / D2=A 及 SMS E-3 / WECHAT §3.4 / 招新 E-R-19 镜像,不是缺口**;终态 scoped-authz PR1 `org.move.node` 绑入 63→64)+ `member`(占位,绑 9 条 attachment self 权限)+ **`biz-admin`(Slow-4 + 保险 T1 + 招新一/二/三期入队 + 招新闭环 S3 + CMS content + 统一通知 S1/S2/S5,绑 74 条 = 75 业务面码过滤 `member.delete.record`〔仅 SA 短路,D1=A 镜像〕;attachment 存量 20 码〔member/certificate/activity〕不绑,CMS content-* 4 码 + notification 7 码〔S1 5 + S2 `update.template` 1 + S5 `send.sms` 1〕绑入〔α / 统一通知 S1 §9.2 + S2 §9.2 + S5 §9.2;演进 Slow-4 §6「biz-admin 不含 attachment.* 码」不变式 = 仅含 CMS content-* 4 码〕;seed 幂等补挂「每个非软删 ADMIN 持有 biz-admin」+ 强校验;运行时新建 ADMIN 走既有 user-roles 端点显式授予)**。seed 与代码调用对齐口径:管理面码 T2/T3 实装前为孤码 WARN,其余无"代码用码未 seed"。

## 4. 保护不变式(改 users / permissions 前必读)

| 不变式 | 实现位置 | 铁律 |
|---|---|---|
| 自我保护 | `users.service.ts` `assertCanManageUser`(删/禁/改角色拒绝 self) | AGENTS §13 |
| 最后一个活跃 SUPER_ADMIN ≥ 1 | 同上,**事务内计数 + 更新** | AGENTS §12/§13;**禁止** AI 增加"SA 互不可操作"校验 |
| 最后一个 ops-admin 持有者 ≥ 1 | `user-roles.service.ts` revoke 路径 | seed bootstrap 强校验呼应 |
| ADMIN 只能管 USER | `assertCanManageUser` 统一入口;**禁止** service 内散落 `role ===` 比较(已核实 0 处) | AGENTS §13 |
| 身份有效性不缓存 | `JwtStrategy.validate` 每请求查库(`deletedAt + status`) | AGENTS §8;RbacCache 是唯一例外(权限解析缓存) |
| 防账号枚举 | 登录四场景统一 10004 + dummy bcrypt timing 防御 | AGENTS §8 |
| Guard 全局注册 | `app.module.ts` APP_GUARD ×3,顺序固定;**全仓 0 处 `@UseGuards`**(已核实) | AGENTS §8 |

## 5. 缺口与冻结存量(AI 不得"顺手修")

| 项 | 状态 | 谁拍板 |
|---|---|---|
| 7 个业务模块接入 `rbac.can()`(Slow-4) | ✅ 已完成(2026-06-11 goal #314-#317;Slow-3 决议 = `biz-admin` 承载全量业务权限) | 已决 |
| `rbac.controller.ts` `GET me/permissions` 方法级 Mixed | 存量冻结(P1-A 不拆),返回 raw code 仅限该 system 端点;App 端能力走 `me/capabilities` | 用户 |
| `dictionaries.controller.ts` 同文件双 controller | 非 surface Mixed,存量冻结不扩展 | 用户 |
| Swagger 不体现权限码要求 | ✅ 已闭环(2026-06-10 P2-2 #287):全部 148 endpoint summary 统一鉴权后缀(`[rbac:]`/`[roles:]`/`[public]`/`[auth]`),`docs:rbacmap:check` 检查项 G(#288)锁后缀↔装饰器/seed 一致性 | 已决;后缀惯例变更走 A/B 档 + 检查项 G 同步 |
| 部门级权限(部长/终审 finalReviewer 细粒度) | ✅ 已拍板(2026-06-10 方案 A):维持 ADMIN 级终审,`finalReviewerUserId` 仅审计记录;细分挂 Slow-3 子议题,未立项不实现(详 [`participation-bounded-context.md §4`](../participation-bounded-context.md)) | 已决;重开走 Slow-3 |

## 6. AI 硬规则(权限相关)

1. 改 `Role` enum / `Permission` seed / `RolePermission` 绑定 / Guard / `JwtStrategy` / throttler → **必然 D 档**:只读调研 → 风险表 → 方案 A/B → 用户拍板 → 评审稿冻结 → 再实施([`process.md §4`](../process.md))。
2. Slow-4 已完成(G 模式清零);**禁止**自行新增权限码 / 调整角色绑定 / 给端点重新挂 `@Roles`(均为 D 档,沿规则 1)。
3. **禁止**绕过 / 弱化:`assertCanManageUser`、最后 SA/ops-admin 保护、防枚举四场景一致性、`@Public` 与 `@Roles` 互斥。
4. 新管理面 endpoint 默认模式 = R 模式(沿既有模块范式);新 App endpoint 默认 self-scope,**禁止**用 `role` 短路 scope。
5. 错误码:权限拒绝只允许既有 `UNAUTHORIZED(40100)` / `FORBIDDEN(40300)` / RBAC 拒绝码(30100 段)/ 业务护栏码;**禁止**自创 token 类 100xx 码(AGENTS §5)。
6. 本文件对照表与代码不一致时:以代码为准,**先报告再 true-up**,不得据本表"纠正"代码。

## 7. 漂移检查与重新生成口径

**首选自动检查**(NEXT_TASKS P1-1 已落地;0 FAIL 才算本表与事实一致):

```bash
pnpm docs:rbacmap:check   # seed 码↔本表计数 / controller 数↔本表 / 4 canonical 前缀 / 直调码必在 seed / 孤码 WARN / summary 鉴权后缀一致(P2-2)
```

手工重新生成口径(true-up 改表时用):

```bash
# 权限码全集(seed)
grep -oE "code: '[a-z][a-z-]*\.[a-z.-]+'" prisma/seed.ts | sort -u   # + 常量声明 PR_3B_USER_UPDATE_ROLE_CODE
# controller 前缀清单
grep -rE "^@Controller\(" src --include="*.ts" -h | sort | uniq -c
# 模块鉴权模式
grep -rl "this\.rbac" src/modules --include="*.service.ts"
grep -rc "@Roles(" src/modules/<module> --include="*.controller.ts"
```
