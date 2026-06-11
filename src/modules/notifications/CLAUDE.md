# notifications — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);冻结评审稿 [`/docs/archive/reviews/queue-b-otp-birthday-infra-review.md §6`](../../../docs/archive/reviews/queue-b-otp-birthday-infra-review.md);运维送审 SOP [`/docs/ops/sms-production-rollout-checklist.md`](../../../docs/ops/sms-production-rollout-checklist.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## Scope

- **生日祝福短信 job**(G-7 通知/短信/推送首个落地点;2026-06-11 B 队列 goal F5):每日 09:00(Asia/Shanghai)`@Cron`,选取当日生日的活跃队员,经 [`/src/modules/sms/`](../sms/)`SmsProviderRouter.sendBirthdayGreeting` 逐个单发
- **零端点 / 零权限码 / 零 DTO**;发送流水落 `sms_send_logs`(templateKey=`birthday-greeting`)
- **不负责**:验证码(`SmsCodeService`)/ settings 管理(sms 模块)/ 群发 / 退订 / 活动通知(未立项)

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

## Validation

- `pnpm test -- birthday` — 选取六条件 / 2-29 / 日界 / 失败继续 / 前置跳过(mock prisma + router)
- `pnpm test:e2e -- notifications-birthday` — 直调 runOnce:六类造数 / 幂等二跑 / 流水字段
- 改启动锚行文案 → 必须同步 docker-smoke workflow 并跑该 workflow
