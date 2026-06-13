# SRVF API 当前状态入口

> **第一入口,当前事实唯一权威源**(权威分层见 process §6 / 根 CLAUDE.md §1)。历史档案在 `archive/`,逐版本变更在 [`CHANGELOG.md`](../CHANGELOG.md);release 合入后**必须**优先回填本文件。
> **铁律**:事实与蓝图冲突以本文件为准;遇冲突**不擅自调和、不擅自改文件**,先报告等拍板。

## 1. 当前版本状态

| 项 | 当前值 |
|---|---|
| 版本(三方一致) | **v0.24.0**(2026-06-13;package.json = Swagger = tag;tag 指向 `c438840c` 标 Latest;要点见 CHANGELOG) |
| `main` HEAD | `c438840c`(#370 handoff;tag v0.24.0 与 HEAD 同点,本行为滚动快照) |
| open PR / 工作树 / Unreleased | **0**(本 PR 前)/ clean / **1**(本 PR:`GET /api/admin/v1/me` 只读身份 bootstrap;v0.24.0 已折叠 5 条:保险 #365/#366/#367 + 微信 review #360/#361) |
| 最新 handoff | [`archive/handoff/v0.24.0.md`](archive/handoff/v0.24.0.md)(不回改) |

## 2. 当前系统已具备能力

> 清单级;事实权威:字段 = [`schema.prisma`](../prisma/schema.prisma);接口 = `/api/docs` + [`EXPECTED_ROUTES`](../test/contract/openapi.contract-spec.ts) + snapshot;BizCode = `biz-code.constant.ts` + CHANGELOG。

- **v1 + V1.1 底座**:NestJS + Prisma + PostgreSQL + JWT + 三层 Role + 软删除 + 统一返回 + Swagger 100%;pino 日志 + 请求 ID + helmet + 限流 + 健康检查 + 优雅关闭 + CI
- **V2 模型全量**:dictionaries / organizations / members(`memberNo` 不复用)/ member_departments / member_profiles / emergency_contacts / certificates / activities / activity_registrations(+CSV)/ attendance_sheets+records(5 态含终审)/ contribution_rules(D14)/ audit_logs(A-1 不可改删)
- **token 体系**(v0.13/14,**行为冻结**):App 本人改密(不吊销 access,D-4)+ refresh / logout / logout-all(rotation always / family revoke / 90d absolute / 联动撤销 5 场景〔2026-06-11 +`self-password-reset`〕/ JWT 15m / payload 仅 `{sub,username}`)
- **RBAC 单轨(P0-F + Slow-4 收口)**:4 表 + `rbac.can()` + **121 码**(2026-06-11 Slow-4 +36;2026-06-12 微信 T2 +4)+ 内置角色 ops-admin(绑 61)/ member(绑 9)/ **biz-admin(绑 35,Slow-3 决议「ADMIN 内置角色边界 = 全量业务权限」承载;seed 幂等补挂每个非软删 ADMIN)**;**权限双轨收口完成**(2026-06-11 goal #314-#317,冻结评审稿 [`archive/reviews/slow4-rbac-business-face-review.md`](archive/reviews/slow4-rbac-business-face-review.md)):业务面 7 模块 44 端点摘 `@Roles`(**全仓活跃 `@Roles` = 0**,RolesGuard 机制保留),42 端点 Service 层判权 + activities 列表/详情 2 端点仅登录;`member.delete.record` 仅 SA(D1=A 镜像);零行为漂移由 7 个权限边界 spec(52 例)锁定
- **attachments + storage**:多态附件 + 配置三表(不合表不抽 facade)+ 业务面 `rbac.can()` 首批(20 码);Local / COS Provider + AES-256-GCM + fail-fast
- **SMS 基础设施**(2026-06-10,goal T0-T4;冻结评审稿 [`archive/reviews/sms-verification-infra-review.md`](archive/reviews/sms-verification-infra-review.md)):通道层(`sms/` 模块,DevStub/腾讯云双 Provider 动态路由 + settings/send-logs 4 端点 + `SMS_ENCRYPTION_KEY` AES-256-GCM)+ 验证码服务(6 位/5min/单活码/错 5 次作废/防刷三层/明文三不)+ 手机号绑定(`me/phone` 发码+验绑换绑 + admin 清号;phone 唯一含软删占用);purpose 三值 `PHONE_BIND` + `PASSWORD_RESET` + `LOGIN`(2026-06-11 B 队列 +LOGIN);BizCode 24xxx 段 6 码;权限码 76→**81**;AuditLogEvent +3(手机号一律掩码);**真实通道未开通**(运维接力 SOP:[`ops/sms-production-rollout-checklist.md`](ops/sms-production-rollout-checklist.md),**两模板一批送审:验证码 + 生日祝福**);消费者三项(找回密码 / OTP 登录 / 生日祝福)均已落地
- **找回密码(SMS 验证码重置,pre-auth)**(2026-06-11,goal T0-T3;冻结评审稿 [`archive/reviews/password-reset-by-sms-review.md`](archive/reviews/password-reset-by-sms-review.md)):`auth/v1` 两公开端点(`password-reset/send-code` + `password-reset`,`@PasswordResetThrottle()` 第 6 throttler 实例 IP 3/60s);**防枚举**(四种无效号码场景同泛化 200 零留痕 + reset 一切失败统一 24010 + 零新增 BizCode/权限码);10006 不烧码可同码重试;重置后效 = 同事务改密 + 联动撤销第 5 场景 `'self-password-reset'` + audit `password.reset.by-sms`(掩码);access 沿 D-4 不吊销;AuditLogEvent +1(`password.reset.by-sms`,union 共 30 项);**DevStub 已全验,真实短信仍只卡腾讯云审核**(运维接力同上行)
- **OTP(验证码)登录(pre-auth,密码登录的并行方式)**(2026-06-11,B 队列 goal F4 #325/#326;冻结评审稿 [`archive/reviews/queue-b-otp-birthday-infra-review.md`](archive/reviews/queue-b-otp-birthday-infra-review.md) §5):`auth/v1` 两公开端点(`login-sms/send-code` + `login-sms`,`@LoginSmsThrottle()` **第 7 throttler 实例** IP 5/60s);**防枚举沿找回密码范式**(四无效场景泛化 200 零留痕 + 登录一切失败统一 24010,不用 10004;零新增 BizCode/权限码);**会话签发与密码登录同构**(`AuthService.createSession` 单一代码路径:同 LoginResponseDto / 同 refresh family / lastLoginAt 同步);audit `auth.login.sms`(union 共 **31** 项,掩码);**AGENTS §8 登录契约行已解锁改写**(密码登录契约零变化,既有 e2e 断言零修改);不更新 phoneVerifiedAt / 不自动注册 / 无二要素
- **生日祝福短信(notifications 模块,G-7 首个落地点;本仓唯一定时任务)**(2026-06-11,B 队列 goal F5 #327/#328;评审稿 §6):`@nestjs/schedule` 锁 6.1.3 + `ScheduleModule.forRoot()`(**no-cron 升级路径已正式触发,解锁范围仅生日批**);每日 09:00 Asia/Shanghai 选取「`MemberProfile.birthDate` 月日=今天(UTC+8 日界)+ profile 未软删 + Member ACTIVE + User 绑 phone 且 ACTIVE」逐个单发(**仅 `User.phone`**;2/29 仅闰年发);**幂等防重发**(查 send_logs 当日同模板同号 SENT;重启不重发);失败记 FAILED 不重试不阻断;不进 audit_logs;`SmsSettings +templateIdBirthday`(零变量模板);零新端点/零权限码;**单实例部署前提**(多实例需先加锁;全部 5 处进程内耦合的横向扩容 checklist 见 [`deployment.md`](deployment.md) 顶部注记);docker-smoke 含启动锚行验证;**SMS 数据 retention 手动 SQL SOP** 同期收口([`ops/sms-data-retention-sop.md`](ops/sms-data-retention-sop.md):90 天/1 年,不解锁 cron 清理)
- **微信小程序登录基础设施(openid 绑定 + 登录;"正确但休眠")**(2026-06-12,goal P1-8 T0-T4 #352-#356;冻结评审稿 [`archive/reviews/wechat-mini-login-review.md`](archive/reviews/wechat-mini-login-review.md);**ARCHITECTURE §9「第一个小程序产品要接」升级路径正式解锁**):**通道层**(`wechat/` 第 23 模块:`wechat_settings` 单例表〔providerType `DEV_STUB|WECHAT`〕+ `WECHAT_ENCRYPTION_KEY` AES-256-GCM 独立 key·独立 salt + `system/v1/wechat-settings` 三端点〔reset 仅 SA〕+ 双 Provider——DevStub 确定性假 openid / 真实 `code2session` **原生 fetch 8s 零新依赖**,session_key 解析即弃);**认证三公开端点**(`auth/v1`:`login-wechat`〔已绑 `createSession` 同构签发 / 未绑 `bindingRequired:true`;第三个独立认证端点,密码登录契约零变化〕+ `wechat-bind{,/send-code}`〔绑定锚点 = 手机短信 `SmsPurpose.WECHAT_BIND`,七步校验顺序冻结,防枚举沿 login-sms 泛化 200 + 统一 24010〕,`@LoginWechatThrottle()` **第 8 throttler** 5/60);**authed**(`GET/PUT app/v1/me/wechat` 查询/换绑一体,openid 一律掩码回显,沿 me/phone 账号级豁免)+ admin 清除(幂等,解绑唯一路径);`User.openid` 唯一含软删占用;BizCode **25xxx 段 4 码**(25002/25010/25030/25031;25001/251xx 不开)+ 权限码 +4(117→**121**,ops-admin 58→**61**)+ AuditLogEvent +4(union 共 **35**,openid 一律掩码);**真实可用待二事**(运维注册小程序录 AppID/AppSecret 沿 [`ops/wechat-mini-production-rollout-checklist.md`](ops/wechat-mini-production-rollout-checklist.md);小程序前端未启动);DevStub 全链 e2e 已验(登录两路/绑定全链/防枚举一致性/限流/幂等)
- **保险模块(自购自助 + 队统一保单 + 活动报名门槛;顶层设计 §8 保险域首落地)**(2026-06-13,goal T0-T4 #363/#365/#366/#367;冻结评审稿 [`archive/reviews/insurance-module-review.md`](archive/reviews/insurance-module-review.md)):**三表**(`member_insurances`〔自购:保险公司/保单号/到期必填+起保可选,`coverageEnd` 是有效性唯一依据,自报即可 v1 无核验〕/ `team_insurance_policies`〔队统一保单一张=一条〕/ `team_insurance_coverages`〔保单×队员 join,partial unique (policyId,memberId) WHERE deletedAt IS NULL〕)+ `Activity.requiresInsurance @default(false)`(默认 false=迁移安全);**第 24 模块 `insurances/` 14 端点**:App 自助 `app/v1/me/insurances` ×4(**self-scope 锁 memberId 不接 RBAC**,防 IDOR 26001 防侧信道)/ 队保单 `admin/v1/team-insurance-policies` ×9(CRUD+覆盖名单单加/**全体在册一键加幂等仅 ACTIVE**/移除;保单软删不级联覆盖行)/ admin 查队员保险 ×1(`member-insurance.read.other`);**报名门槛**:`requiresInsurance=true` 时报名 create **双路径**(admin 代报名+自助)事务内校验「自购有效 **或** 队保单覆盖,任一即可」(北京日粒度含等号,快照不回溯),否则 `INSURANCE_REQUIRED=26030`;BizCode **26xxx 段 6 码**(261xx 不开)+ 权限码 +7 全绑 biz-admin(121→**128**,自助侧零码)+ AuditLogEvent +8(union 共 **43**)+ placeholder +1(29);baseline §1.1 红区加段(goal 授权);**v1 不做**(评审稿 §10):理赔/到期主动提醒/核验工作流/**保单图 attachments 接线**(ownerType 语义已预留,enum 分支+8 权限码单独立项)/App activities DTO 暴露 requiresInsurance;真实保险数据待业务侧录入
- **进程硬化两件(2026-06-12,goal「会议延期窗口·无等待工作一次收清」G2/G3,#345/#346)**:① 崩溃路径可观测性兜底(`src/bootstrap/apply-crash-handlers.ts`,仅 main.ts 注册:uncaughtException 记 fatal 后 exit(1) / unhandledRejection 记日志后 re-throw 保持 Node 默认崩溃结局;经 pino 沿 redact 清单;**不碰 SIGTERM/优雅关闭**);② 外部 SDK 请求超时上限(腾讯云 SMS `reqTimeout` 8s + COS `Timeout` 8000ms,超时沿既有错误路径语义零变化;**正确但当前休眠**——SMS/COS 真通道均未接,配置就位由两 provider spec 构造断言锁定)
- **App API Phase 2**(15 端点):`me`×3 / profile×2 / password / activities×2 / `my/*`×7;DTO 隔离 `dto/app/` 禁派生;self-scope;**永不返回 L3**;准入双 ACTIVE(D-5)
- **Admin surface 本人身份**(2026-06-14,goal「Admin surface 本人身份端点」#372):`GET /api/admin/v1/me` 只读身份 bootstrap(`AdminMeController` 单一 `Admin - Me` tag + 独立 `AdminMeResponseDto` 字段集恰好 9 = User 本体身份;入口仅 `JwtAuthGuard` 不挂 `@Roles`,任意登录用户返本人;**不内联角色/权限**——权限仍走 `system/v1/rbac/me/permissions`;不返 member 业务字段 / raw permission code / L3;零 prisma/BizCode/audit)
- **Route B 终态**(2026-06-01):全仓仅 4 前缀,零 v2 / 零裸前缀 / 零 legacy,contract 断言锁定(§2.1)
- **P2-2 鉴权后缀**(v0.17.0 落地 148;现 **183** endpoint,2026-06-14 亲核 EXPECTED_ROUTES = 实际路由数;旧值 168 系保险模块前快照,含保险 T2 +14 与本 PR `admin/v1/me` +1)summary 带 `[rbac:]/[roles:]/[public]/[auth]`,检查项 G 锁一致性(Slow-4 后 `[roles:]` 计 0,形态保留供机制兜底)
- **测试与契约**:e2e **93 suites / 1861 tests** + unit **40 spec / 1396 tests**(2026-06-14 `admin/v1/me` true-up 亲核:e2e +admin-me 9〔本 PR〕;2026-06-13 保险 goal true-up 亲核:e2e +app-me-insurances 11 / team-insurance-policies 10 / insurance-gate 10〔含微信 review 收口 #360-#361 增量〕;unit 增量主要为 BizCode/audit union 参数化用例随 +6 码 +9 事件展开)+ contract **183 路由**白名单(168→182 保险 T2 + 182→183 本 PR `admin/v1/me`,均仅新增);CI 全链 + docker-smoke(含生日 cron 启动锚行 + `WECHAT_ENCRYPTION_KEY` 注入)

## 2.1 当前 API surface 状态

4 前缀(边界规则见 [`api-surface-policy.md`](api-surface-policy.md),迁移过程见 `api-surface-migration-plan.md`):**App** `/api/app/v1/*`(移动端只能落此,DTO 独立 `dto/app/`)| **Admin** `/api/admin/v1/*` | **Auth** `/api/auth/v1/*` | **System** `/api/system/v1/*`(D-1)| **Open** 预留不实现不占用。
**铁律**:❌ 不再新增 Mixed Controller(存量仅 rbac `me/permissions` 方法级 + dictionaries 同 surface 双 class,冻结);❌ App 永不返回 L3 字段(`passwordHash` / `*token*` / `secret*` / 完整 signed URL)。

## 3. 当前明确未做 / 暂不启动

> 这些事项**不**由 AI 自行启动,需要用户拍板。

- **Slow-3 主决议已拍板,Slow-4 已完成**(2026-06-11 goal「权限双轨收口」#314-#317;冻结评审稿 [`archive/reviews/slow4-rbac-business-face-review.md`](archive/reviews/slow4-rbac-business-face-review.md)):ADMIN 内置角色边界 = 全量业务权限,由 `biz-admin` 承载(绑 35;`member.delete.record` 仅 SA;attachment 存量 20 码不绑);业务面 7 模块 44 端点已全部接入 `rbac.can()`,全仓活跃 `@Roles` = 0。**仍挂起的 Slow-3 子议题**:考勤终审部门级细分(2026-06-10 方案 A 沿用:维持 ADMIN 级终审〔现 = 持 biz-admin 的 ADMIN 或 SA〕,`finalReviewerUserId` 仅审计记录;"部长"职务无数据模型承载;重开需单独立项,详 [`participation-bounded-context.md §4`](participation-bounded-context.md))— **不**自动启动
- **不**自动启动 Slow-5(B8 入队同意书正文 / Q8 退队清理 N 值)— 等业务方提供
- **不**自动启动 Slow-7(uploadToken 重放黑名单 / 失败回滚 Provider 文件 / test-connection / multipart / STS / 跨 Provider 迁移)— 等真实使用反馈
- **不**自动启动 L-3(Storage Settings 配置变更 audit_logs)— 等用户授权
- **不**自动启动 `events` / `event_participants` / `member_profiles 扩展敏感字段` 等延后模型(沿 [`docs/V2红线与复活路径.md §4.3`](V2红线与复活路径.md))
- **不**自动引入 LLM / vector / Redis / queue(沿 [ARCHITECTURE.md §9](../ARCHITECTURE.md) 升级路径);**cron 已按升级路径解锁,范围仅生日批**(2026-06-11 B 队列拍板④,冻结评审稿 [`archive/reviews/queue-b-otp-birthday-infra-review.md`](archive/reviews/queue-b-otp-birthday-infra-review.md) R-5:`@nestjs/schedule` 仅承载 notifications 生日 job 一个 `@Cron`;**新增任何定时任务 = 新 D 档评审**;数据清理不解锁,沿 retention 手动 SOP)
- **不**自动启动新 schema / migration / Permission seed / Role 扩展(A-3 / A-4 红线)
- **不**自动接入运维侧真实 COS(bucket / IAM / CORS / lifecycle / SSE-COS / 真实凭证录入)— 由队组织运维侧执行,系统侧 SOP 见 [`docs/ops/cos-production-rollout-checklist.md`](ops/cos-production-rollout-checklist.md)
- **不**自动接入运维侧真实微信小程序(注册小程序 / AppID·AppSecret 录入 / 真实微信验收)— 由维护者运维侧执行,系统侧 SOP 见 [`docs/ops/wechat-mini-production-rollout-checklist.md`](ops/wechat-mini-production-rollout-checklist.md);小程序前端未启动,招新自助走小程序 meeting-gated(均沿 wechat 评审稿 §12)
- **不**自动启动保险模块后续(理赔记录 / 到期主动提醒〔新定时任务 = 新 D 档评审,cron 解锁范围仍仅生日批〕/ 保险核验工作流 / **保单图 attachments 接线**〔`AttachmentOwnerType` enum 分支 + `attachment.*.member-insurance.{self,other}` 8 权限码 + 配置三表行〕/ App activities DTO 暴露 `requiresInsurance`)— 评审稿 [`insurance-module-review.md §10`](archive/reviews/insurance-module-review.md) + NEXT_TASKS P1-10,业务/前端真实诉求触发再立项
- **不**自动回改历史 handoff(沿 [`docs/V2红线与复活路径.md §5.1`](V2红线与复活路径.md))
- **不**把历史评审稿([`docs/archive/batches/`](archive/batches/) / [`docs/archive/reviews/`](archive/reviews/))当作"当前事实"— 它们是各批次冻结时刻的决策依据
- **Route B 全量迁移已完成**(2026-06-01;取代原"Phase 1B 暂缓 / 方案 C")— 见 [`api-surface-migration-plan.md`](api-surface-migration-plan.md) + [`AGENTS.md §21 D-9`](../AGENTS.md);**Phase 0 映射已签字冻结**(2026-06-01;[§3](api-surface-migration-plan.md) 全 156 路由 `tag→surface` + 终态验收基线 + 8 个 legacy mobile-like 端点纳入 Phase 4 删除);**Phase 1 alias 已完成**(1a auth+health 7 + 1b system 56 + 1c admin 70 = 133 非-app 路由双挂,contract 423 + e2e 双路径绿,老路径零回归);**Phase 2 完成**(老前缀 OpenAPI 标 `deprecated`、新前缀 canonical);**Phase 3 deprecation 窗口豁免**(无生产消费者,用户 2026-06-01 确认 → 直接 Phase 4);**Phase 4 removal 完成**(4a auth+health / 4b system / 4c admin / 4d `/api/users/me*` / 4e attachments / 4d2 registrations-me + attendances-me-records legacy + 主 spec 队员流迁 `app/v1/my` + 移除 apply-swagger deprecation 后处理 + 终态 contract 断言;contract 280 + full e2e 72 suites/1664 绿);**🎉 Route B 终态达成:全仓 API 只剩 `admin/v1` + `app/v1` + `auth/v1` + `system/v1`,零 `v2` / 零裸 `auth`·`health`·`users` / 零 legacy**(终态由 contract"全部路由仅落 4 canonical 前缀"断言锁定);`/api/open/v1/*` 仍仅预留。**A 档收尾已完成**:src/ 注释 / 模块 CLAUDE.md / contract-spec header(#269)+ docs 活文档(cos runbook / current-state / api-surface-policy §0+§5/§6 / development / security / docker-smoke / participation / attachment-config)均已 true-up 到终态;历史 v2 设计档(`v2-api-contract.md` / `V2红线与复活路径.md`)按设计意图保留
- **P1-C(Mixed Controller 物理拆分)已被 Route B 全量迁移收口**:原 `controllers/*-legacy.controller.ts`(users / attachments / activity-registrations / attendances)已于 Phase 4 删除,队员自助流在 `/api/app/v1/me*` / `/api/app/v1/my/*`;god-service 现状见 §4 P2 行(P1-4 拆分系列已于 2026-06-10 调研收口)
- **不**自动拆分 `attendances.service.ts`(1123 行,P1-4 第一刀 #280 后)/ `attachments.service.ts`(827 行)/ `activity-registrations.service.ts`(768 行)等 god-service — **P1-4 拆分系列已于 2026-06-10 调研收口**(用户逐项拍板):三模块均已达 [`architecture-boundary.md`](architecture-boundary.md) 政策下的合理形态(详见 §4 P2 行),重新开拆需出现 §6 新触发条件并单独立项
- **不**自动引入 repository / `*.repository.ts` 抽象层 — service 直连 Prisma 沿用
- **不**在无 contract 审批 / 单独立项的情况下改 controller path / 改 OpenAPI snapshot;Route B 全量迁移已于 2026-06-01 完成(终态 4 前缀),新 endpoint 一律落 `admin/v1` / `app/v1` / `auth/v1` / `system/v1`(沿 [`api-surface-policy.md §0`](api-surface-policy.md))

## 4. 当前最大风险 / 债务(仅 open 项)

| 等级 | 债务 | 处理建议 |
|---|---|---|
| P1 | 前端联调包剩运维侧 P0-H 演练 + P0-I 排错 SOP | 运维侧立项;系统侧无动作 |
| P2 | god-service 体量观察:attendances 1123L / **users 832L(2026-06-12 微信 T3 +me/wechat 三方法跨入观察线)** / attachments 827L / activity-registrations 768L(P1-4 收口 = 合理终态;体量 source-only 口径,排除 spec;2026-06-12 亲核) | 重开需 architecture-boundary §6 新触发 + 单独立项 |
| P2 | service 单测占比 ~11.8%(26/221 实测) | 刻意策略(e2e 为主,见 §2 测试行) |
| P2 | Mixed Controller 存量 2 处(见 §2.1) | 冻结仅兼容;详 api-surface-policy §5.1 |
| P2 | contract snapshot ~1MB / 35,777 行 | 已接受;review 用 diff,勿整读 |
| P3 | SMS 两表 retention 依赖维护者手动执行(系统侧无自动清理,刻意) | 沿 [`ops/sms-data-retention-sop.md`](ops/sms-data-retention-sop.md)(2026-06-11 P2-6 收口:季度例行 + 报警线;不解锁 cron) |
| P3 | 保险到期无自动提醒(刻意:cron 解锁范围仅生日批;临近到期靠管理员人工查看 coverageEnd) | 提醒诉求出现单独立项(新定时任务 = 新 D 档评审,沿 R-5);字段已留,见 [`archive/reviews/insurance-module-review.md §10`](archive/reviews/insurance-module-review.md) |

## 5. 新任务开工前必须检查

门禁见 [`process.md §2`](process.md),任一不满足不开新功能。速记:`pnpm agent:preflight` 全过 / handoff 与 §1 一致 / Unreleased 无残留 / D 档降速(process §4)/ 拍板未到不动代码 / fresh worktree 先 install + prisma:generate。

## 6. 文档阅读顺序

1. **必读三件套**:本文件 → [`ai-harness/README.md`](ai-harness/README.md)(速查 / 三档 / 分区)→ [`process.md §2/§3`](process.md)(门禁 + 五档)
2. [`AGENTS.md`](../AGENTS.md) **按任务主题选读**(节号见 ai-harness 单页)
3. **按需**:[baseline](srvf-foundation-baseline.md) / [V2 红线](V2红线与复活路径.md) / `ARCHITECTURE.md`(先读顶部说明)/ api-surface-policy
4. **仅在相关时**:运行 SOP(development / testing / deployment / security / ops)与边界图(participation-bounded-context / attachment-config-boundary / architecture-boundary),均在 docs/ 下;权限地图([RBAC_MAP](ai-harness/RBAC_MAP.md));`archive/`(只作证据)
