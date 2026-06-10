# SRVF API 当前状态入口

> **第一入口,当前事实唯一权威源**(权威分层见 process §6 / 根 CLAUDE.md §1)。历史档案在 `archive/`,逐版本变更在 [`CHANGELOG.md`](../CHANGELOG.md);release 合入后**必须**优先回填本文件。
> **铁律**:事实与蓝图冲突以本文件为准;遇冲突**不擅自调和、不擅自改文件**,先报告等拍板。

## 1. 当前版本状态

| 项 | 当前值 |
|---|---|
| 版本(三方一致) | **v0.18.0**(2026-06-11;package.json = Swagger = tag;tag 指向 `8d9fd01` 标 Latest;要点见 CHANGELOG) |
| `main` HEAD | `8d9fd01`(v0.18.0 handoff,#305;滞后属固有现象) |
| open PR / 工作树 / Unreleased | **0**(本 PR 前)/ clean / **空**(v0.18.0 已收口) |
| 最新 handoff | [`archive/handoff/v0.18.0.md`](archive/handoff/v0.18.0.md)(不回改) |

## 2. 当前系统已具备能力

> 清单级;事实权威:字段 = [`schema.prisma`](../prisma/schema.prisma);接口 = `/api/docs` + [`EXPECTED_ROUTES`](../test/contract/openapi.contract-spec.ts) + snapshot;BizCode = `biz-code.constant.ts` + CHANGELOG。

- **v1 + V1.1 底座**:NestJS + Prisma + PostgreSQL + JWT + 三层 Role + 软删除 + 统一返回 + Swagger 100%;pino 日志 + 请求 ID + helmet + 限流 + 健康检查 + 优雅关闭 + CI
- **V2 模型全量**:dictionaries / organizations / members(`memberNo` 不复用)/ member_departments / member_profiles / emergency_contacts / certificates / activities / activity_registrations(+CSV)/ attendance_sheets+records(5 态含终审)/ contribution_rules(D14)/ audit_logs(A-1 不可改删)
- **token 体系**(v0.13/14,**行为冻结**):App 本人改密(不吊销 access,D-4)+ refresh / logout / logout-all(rotation always / family revoke / 90d absolute / 联动撤销 4 场景 / JWT 15m / payload 仅 `{sub,username}`)
- **RBAC + P0-F**:4 表 + `rbac.can()` + **81 码**(2026-06-10 SMS +5)+ ops-admin(绑 58);管理面四域(rbac / config / users / audit-logs)已 Service 层判权
- **attachments + storage**:多态附件 + 配置三表(不合表不抽 facade)+ 业务面 `rbac.can()` 首批(20 码);Local / COS Provider + AES-256-GCM + fail-fast
- **SMS 基础设施**(2026-06-10,goal T0-T4;冻结评审稿 [`archive/reviews/sms-verification-infra-review.md`](archive/reviews/sms-verification-infra-review.md)):通道层(`sms/` 模块,DevStub/腾讯云双 Provider 动态路由 + settings/send-logs 4 端点 + `SMS_ENCRYPTION_KEY` AES-256-GCM)+ 验证码服务(6 位/5min/单活码/错 5 次作废/防刷三层/明文三不)+ 手机号绑定(`me/phone` 发码+验绑换绑 + admin 清号;phone 唯一含软删占用);**purpose 仅 PHONE_BIND**;BizCode 24xxx 段 6 码;权限码 76→**81**;AuditLogEvent +3(手机号一律掩码);**真实通道未开通**(运维接力 SOP:[`ops/sms-production-rollout-checklist.md`](ops/sms-production-rollout-checklist.md));找回密码/OTP 登录/通知挂 [`ai-harness/NEXT_TASKS.md`](ai-harness/NEXT_TASKS.md) P1-7
- **App API Phase 2**(15 端点):`me`×3 / profile×2 / password / activities×2 / `my/*`×7;DTO 隔离 `dto/app/` 禁派生;self-scope;**永不返回 L3**;准入双 ACTIVE(D-5)
- **Route B 终态**(2026-06-01):全仓仅 4 前缀,零 v2 / 零裸前缀 / 零 legacy,contract 断言锁定(§2.1)
- **P2-2 鉴权后缀**(v0.17.0 落地 148;SMS 后 **155** endpoint)summary 带 `[rbac:]/[roles:]/[public]/[auth]`,检查项 G 锁一致性
- **测试与契约**:e2e **75 suites / 1706 tests** + unit 30 spec(6 characterization 全覆盖)+ contract **155 路由**白名单;CI 全链 + docker-smoke

## 2.1 当前 API surface 状态

4 前缀(边界规则见 [`api-surface-policy.md`](api-surface-policy.md),迁移过程见 `api-surface-migration-plan.md`):**App** `/api/app/v1/*`(移动端只能落此,DTO 独立 `dto/app/`)| **Admin** `/api/admin/v1/*` | **Auth** `/api/auth/v1/*` | **System** `/api/system/v1/*`(D-1)| **Open** 预留不实现不占用。
**铁律**:❌ 不再新增 Mixed Controller(存量仅 rbac `me/permissions` 方法级 + dictionaries 同 surface 双 class,冻结);❌ App 永不返回 L3 字段(`passwordHash` / `*token*` / `secret*` / 完整 signed URL)。

## 3. 当前明确未做 / 暂不启动

> 这些事项**不**由 AI 自行启动,需要用户拍板。

- **不**自动启动 Slow-3(ADMIN 内置角色 / ADMIN 默认附件权限边界)— 等业务方对"业务管理员边界"补充澄清;**2026-06-10 新增子议题**:考勤终审部门级细分(方案 A 拍板:维持 ADMIN 级终审,`finalReviewerUserId` 仅审计记录;"部长"职务无数据模型承载,细分随 Slow-3 一并决议,详 [`participation-bounded-context.md §4`](participation-bounded-context.md))
- **不**自动启动 Slow-4(业务面 attachments 之外的 V2 接口细粒度 `rbac.can()` 接入;**14 个 RBAC CRUD + 管理面已于 P0-F / v0.15.0 完成**,见 §4 P1 行)— 强依赖 Slow-3 决议
- **不**自动启动 Slow-5(B8 入队同意书正文 / Q8 退队清理 N 值)— 等业务方提供
- **不**自动启动 Slow-7(uploadToken 重放黑名单 / 失败回滚 Provider 文件 / test-connection / multipart / STS / 跨 Provider 迁移)— 等真实使用反馈
- **不**自动启动 L-3(Storage Settings 配置变更 audit_logs)— 等用户授权
- **不**自动启动 `events` / `event_participants` / `member_profiles 扩展敏感字段` 等延后模型(沿 [`docs/V2红线与复活路径.md §4.3`](V2红线与复活路径.md))
- **不**自动引入 LLM / vector / Redis / queue / cron(沿 [ARCHITECTURE.md §9](../ARCHITECTURE.md) 升级路径)
- **不**自动启动新 schema / migration / Permission seed / Role 扩展(A-3 / A-4 红线)
- **不**自动接入运维侧真实 COS(bucket / IAM / CORS / lifecycle / SSE-COS / 真实凭证录入)— 由队组织运维侧执行,系统侧 SOP 见 [`docs/ops/cos-production-rollout-checklist.md`](ops/cos-production-rollout-checklist.md)
- **不**自动回改历史 handoff(沿 [`docs/V2红线与复活路径.md §5.1`](V2红线与复活路径.md))
- **不**把历史评审稿([`docs/archive/batches/`](archive/batches/) / [`docs/archive/reviews/`](archive/reviews/))当作"当前事实"— 它们是各批次冻结时刻的决策依据
- **Route B 全量迁移已完成**(2026-06-01;取代原"Phase 1B 暂缓 / 方案 C")— 见 [`api-surface-migration-plan.md`](api-surface-migration-plan.md) + [`AGENTS.md §21 D-9`](../AGENTS.md);**Phase 0 映射已签字冻结**(2026-06-01;[§3](api-surface-migration-plan.md) 全 156 路由 `tag→surface` + 终态验收基线 + 8 个 legacy mobile-like 端点纳入 Phase 4 删除);**Phase 1 alias 已完成**(1a auth+health 7 + 1b system 56 + 1c admin 70 = 133 非-app 路由双挂,contract 423 + e2e 双路径绿,老路径零回归);**Phase 2 完成**(老前缀 OpenAPI 标 `deprecated`、新前缀 canonical);**Phase 3 deprecation 窗口豁免**(无生产消费者,用户 2026-06-01 确认 → 直接 Phase 4);**Phase 4 removal 完成**(4a auth+health / 4b system / 4c admin / 4d `/api/users/me*` / 4e attachments / 4d2 registrations-me + attendances-me-records legacy + 主 spec 队员流迁 `app/v1/my` + 移除 apply-swagger deprecation 后处理 + 终态 contract 断言;contract 280 + full e2e 72 suites/1664 绿);**🎉 Route B 终态达成:全仓 API 只剩 `admin/v1` + `app/v1` + `auth/v1` + `system/v1`,零 `v2` / 零裸 `auth`·`health`·`users` / 零 legacy**(终态由 contract"全部路由仅落 4 canonical 前缀"断言锁定);`/api/open/v1/*` 仍仅预留。**A 档收尾已完成**:src/ 注释 / 模块 CLAUDE.md / contract-spec header(#269)+ docs 活文档(cos runbook / current-state / api-surface-policy §0+§5/§6 / development / security / docker-smoke / participation / attachment-config)均已 true-up 到终态;历史 v2 设计档(`v2-api-contract.md` / `V2红线与复活路径.md`)按设计意图保留
- **P1-C(Mixed Controller 物理拆分)已被 Route B 全量迁移收口**:原 `controllers/*-legacy.controller.ts`(users / attachments / activity-registrations / attendances)已于 Phase 4 删除,队员自助流在 `/api/app/v1/me*` / `/api/app/v1/my/*`;god-service 现状见 §4 P2 行(P1-4 拆分系列已于 2026-06-10 调研收口)
- **不**自动拆分 `attendances.service.ts`(1100 行,P1-4 第一刀 #280 后)/ `attachments.service.ts`(827 行)/ `activity-registrations.service.ts`(750 行)等 god-service — **P1-4 拆分系列已于 2026-06-10 调研收口**(用户逐项拍板):三模块均已达 [`architecture-boundary.md`](architecture-boundary.md) 政策下的合理形态(详见 §4 P2 行),重新开拆需出现 §6 新触发条件并单独立项
- **不**自动引入 repository / `*.repository.ts` 抽象层 — service 直连 Prisma 沿用
- **不**在无 contract 审批 / 单独立项的情况下改 controller path / 改 OpenAPI snapshot;Route B 全量迁移已于 2026-06-01 完成(终态 4 前缀),新 endpoint 一律落 `admin/v1` / `app/v1` / `auth/v1` / `system/v1`(沿 [`api-surface-policy.md §0`](api-surface-policy.md))

## 4. 当前最大风险 / 债务(仅 open 项)

| 等级 | 债务 | 处理建议 |
|---|---|---|
| P1 | 权限双轨:管理面已收紧(P0-F),业务面 7 个 G 模式模块(48 处 `@Roles`)归 Slow-4 | 等 Slow-3 决议;AI 禁自行接入 |
| P1 | 前端联调包剩运维侧 P0-H 演练 + P0-I 排错 SOP | 运维侧立项;系统侧无动作 |
| P2 | god-service 体量观察:attendances 1100L / attachments 827L / activity-registrations 750L(P1-4 收口 = 合理终态;体量 source-only 口径,排除 spec) | 重开需 architecture-boundary §6 新触发 + 单独立项 |
| P2 | service 单测占比 ~11.8%(26/221 实测) | 刻意策略(e2e 为主,见 §2 测试行) |
| P2 | Mixed Controller 存量 2 处(见 §2.1) | 冻结仅兼容;详 api-surface-policy §5.1 |
| P2 | contract snapshot ~1MB / 35,777 行 | 已接受;review 用 diff,勿整读 |
| P3 | `common/storage/` 超出 common 语义 | 长期可迁 `src/modules/storage/`;本期不动 |
| P3 | `sms_verification_codes` / `sms_send_logs` 只增不减(本期拍板不做 retention) | 挂 [`NEXT_TASKS P2-6`](ai-harness/NEXT_TASKS.md);届时单独立项(物理删数据 = D 档) |

## 5. 新任务开工前必须检查

门禁见 [`process.md §2`](process.md),任一不满足不开新功能。速记:`pnpm agent:preflight` 全过 / handoff 与 §1 一致 / Unreleased 无残留 / D 档降速(process §4)/ 拍板未到不动代码 / fresh worktree 先 install + prisma:generate。

## 6. 文档阅读顺序

1. **必读三件套**:本文件 → [`ai-harness/README.md`](ai-harness/README.md)(速查 / 三档 / 分区)→ [`process.md §2/§3`](process.md)(门禁 + 五档)
2. [`AGENTS.md`](../AGENTS.md) **按任务主题选读**(节号见 ai-harness 单页)
3. **按需**:[baseline](srvf-foundation-baseline.md) / [V2 红线](V2红线与复活路径.md) / `ARCHITECTURE.md`(先读顶部说明)/ api-surface-policy
4. **仅在相关时**:运行 SOP(development / testing / deployment / security / ops)与边界图(participation-bounded-context / attachment-config-boundary / architecture-boundary),均在 docs/ 下;权限地图([RBAC_MAP](ai-harness/RBAC_MAP.md));`archive/`(只作证据)
