# CODEMAP — 源码模块导航

> 给 AI 的**源码地图**。文档地图请读 [`docs/README.md`](docs/README.md);当前事实读 [`docs/current-state.md`](docs/current-state.md);长期铁律读 [`AGENTS.md`](AGENTS.md)。
> 本文件**不**列 HTTP endpoint(那是 Swagger `/api/docs` 与 [`README.md`](README.md) 路由总览的事),**不**复制 `AGENTS.md` 规则。

**体量级别**:`S` <500 行 / `M` 500–1500 / `L` 1500–2500 / `⚠G` god-service(service 单文件 >700 行)

---

## src/modules/(27 个业务模块,平铺,**禁止嵌套 system/business/core 子目录**)

| 路径 | 体量 | 职责 | 主要风险 / 本地铁律 | 本地约束 |
|---|---|---|---|---|
| `activities/` | L (2393L) | 活动主资源,4 态状态机(`activity-state-machine.ts`) | service 607L 偏厚;participation 上下文核心 | [`CLAUDE.md`](src/modules/activities/CLAUDE.md) · [`docs/participation-bounded-context.md`](docs/participation-bounded-context.md) |
| `activity-registrations/` | L (2354L) | 活动报名,4 态 + partial unique + CSV export | service 750L;Mixed Controller P1-C step 3 已拆完 | [`CLAUDE.md`](src/modules/activity-registrations/CLAUDE.md) · [`docs/api-surface-policy.md §5.1`](docs/api-surface-policy.md) |
| `ai/` | S (placeholder) | LLM / 向量占位 | **本期不实现**;README 占位 | [`AGENTS.md §1 C`](AGENTS.md) |
| `attachment-configs/` | L (2175L) | 附件配置三表(type / mime / size) | **不合表、不抽 facade、override-with-default** | [`docs/attachment-config-boundary.md`](docs/attachment-config-boundary.md) |
| `attachments/` | ⚠G (service 826L) | 多态附件主模块 + RBAC 业务面首批接入 | accessUrl / signed URL 永不返回;L3 字段隔离 | [`CLAUDE.md`](src/modules/attachments/CLAUDE.md) · [`docs/attachment-config-boundary.md`](docs/attachment-config-boundary.md) |
| `attendances/` | ⚠G (service 1100L) | 考勤主表 5 态(含终审)+ contribution 计算 | 5 个边界类已抽离(state-machine / audit-recorder / time-overlap-policy / contribution-calculator / presenter #280);P1-4 拆分系列 2026-06-10 调研收口,余量为事务编排本职,⚠G 仅体量观察(沿 current-state §4);App 端点在 `controllers/app-my-attendance-records.controller.ts` | [`CLAUDE.md`](src/modules/attendances/CLAUDE.md) · [`docs/participation-bounded-context.md`](docs/participation-bounded-context.md) |
| `audit-logs/` | M (594L) | 写入即不可改不可删(A-1 红线) | 各业务写路径已全接入 `AuditLogEvent` | [`AGENTS.md §9`](AGENTS.md) |
| `auth/` | M (1678L) | 登录 / refresh / logout / logout-all / 找回密码 + OTP 登录 + 微信登录与绑定(pre-auth 平铺三 service;2026-06-12 亲核计数) | **不引入 `LocalStrategy`**;`username+password` 在 service 内手写;找回密码 / OTP / 微信三套防枚举·防侧写一致性禁破坏;`createSession` 唯一签发点(三种登录共用) | [`CLAUDE.md`](src/modules/auth/CLAUDE.md) · [`AGENTS.md §1 永久铁律`](AGENTS.md) · [`docs/security.md`](docs/security.md) |
| `certificates/` | M (1410L) | 证书 N:1 + 4 态闭集 + verify/reject | service 556L (large-service watch);**不**属 participation 上下文(独立 member-qualifications) | [`docs/participation-bounded-context.md`](docs/participation-bounded-context.md)(明确排除) |
| `contribution-rules/` | M (914L) | D14 预填规则 | **无 CRUD 流水表** | [`docs/participation-bounded-context.md`](docs/participation-bounded-context.md) |
| `dictionaries/` | M (968L) | 字典双表 + 父子树 | 同 surface 双 controller(**非 surface Mixed**) | [`docs/api-surface-policy.md §5.1`](docs/api-surface-policy.md) |
| `emergency-contacts/` | S (571L) | N:1 紧急联系人 | 子资源 | — |
| `health/` | S (137L) | 健康检查(live / ready) | **模块结构例外**:只有 module + controller,**无 service** | [`AGENTS.md §2`](AGENTS.md) |
| `insurances/` | M (1551L) | 自购保险(App self-scope)+ 队保单 + 覆盖名单 + 报名门槛查询 | 覆盖名单 partial unique 在 migration 直写;`InsuranceRequirementService` 是唯一跨模块出口(activity-registration 单向依赖) | [`docs/archive/reviews/insurance-module-review.md`](docs/archive/reviews/insurance-module-review.md) |
| `member-departments/` | S (329L) | 一人一部门 partial unique | partial unique 在 schema 显式 | — |
| `member-profiles/` | M (1258L) | 1:1 子资源,含敏感字段(身份证默认掩码后 4 位) | **L3 字段不外暴**;白名单严格 | [`docs/security.md`](docs/security.md) |
| `members/` | S (501L) | 全局 `memberNo` **不复用** | memberNo 唯一性铁律 | [`docs/srvf-foundation-baseline.md`](docs/srvf-foundation-baseline.md) |
| `notifications/` | S (219L) | 生日祝福短信 job(G-7 首个落地点;本仓唯一 `@Cron`,09:00 Asia/Shanghai) | no-cron 解锁范围仅生日批(新定时任务 = 新 D 档评审);仅发 `User.phone`;幂等查 send_logs 当日 SENT;不进 audit;单实例前提(多实例需先加锁) | [`CLAUDE.md`](src/modules/notifications/CLAUDE.md) · [`docs/archive/reviews/queue-b-otp-birthday-infra-review.md §6`](docs/archive/reviews/queue-b-otp-birthday-infra-review.md) |
| `organizations/` | M (654L) | 组织树 | 树形结构 | — |
| `permissions/` | L (2213L) | RBAC 4 表 + `RbacService.can()` + `RbacCacheService` | `rbac.*` 14 条权限点;**`rbac/me/permissions` 方法级 Mixed 暂不拆 (P1-A)** | [`CLAUDE.md`](src/modules/permissions/CLAUDE.md) · [`AGENTS.md §8 / §13`](AGENTS.md) · [`docs/api-surface-policy.md §5.1`](docs/api-surface-policy.md) |
| `realname/` | M (1087L) | 实名核验通道层(realname-settings 三端点 / 双 Provider / verify 编排 + 原生 fetch TC3 签名 8s + 27xxx 映射边界;招新一期 T2) | secretId/secretKey 两段 AES-256-GCM 永不回显;真通道休眠(DevStub 全验,腾讯云凭证待运维);姓名/身份证号不入日志;production-like 禁 DEV_STUB;providers/ 子目录为 AGENTS §2 已解锁例外(第四例) | [`docs/archive/reviews/recruitment-phase1-review.md`](docs/archive/reviews/recruitment-phase1-review.md)(冻结评审稿) |
| `recruitment/` | M (1462L) | 招新一期(招新前段;T3):公开报名(`open/v1` 首用 multipart 提交 + 查询)+ admin 轮次/报名管理 + 临时编号原子发号 + 实名核验编排(消费 realname/wechat/storage)+ 通知展示;**两层身份铁律**:临时编号绑 application,**不**进 members | 姓名/身份证号/手机仅入库不回显明文;证件照走 storage 短 TTL signed-URL + L3 不入日志;失败者脱敏留存按手动 SQL SOP(不接 cron);付费实名核验为免费校验后最后一道闸;service 最大 492L(未触 god-service 线) | [`docs/archive/reviews/recruitment-phase1-review.md`](docs/archive/reviews/recruitment-phase1-review.md)(冻结评审稿) |
| `sms/` | M (1437L) | SMS 通道层(settings/send-logs/双 Provider/动态路由)+ 验证码签发/校验/防刷 | 凭证 AES-256-GCM 永不回显;明文码不入库·不入日志·不入响应(DevStub debug 例外);production-like 禁 DEV_STUB;providers/ 子目录为 AGENTS §2 已解锁例外 | [`docs/archive/reviews/sms-verification-infra-review.md`](docs/archive/reviews/sms-verification-infra-review.md)(冻结评审稿) |
| `team-join/` | M (1756L,T2-T4) | 招新三期(入队:志愿者→队员;T2-T4 全):入队轮 CRUD + 标 gate(8 通用 + 4 条件性专业队;完成日→有效期〔本轮按北京日历日〕;dept-assessment 可延长期)+ 综合评估单一人工闸 + 贡献值只读汇总(approved sheet,checkInAt<入队年 3-31)+ app 自助面(发起/查进度/改候选,self-scope 防 IDOR)+ **一键入队**(`TeamJoinEnrollmentService` 单事务设部门 + level-1,直连 prisma 防环);状态机 joining→pending_evaluation→approved→joined/rejected;**两层身份**:入队才赋部门 + 级别 level-1 | gate 全过 + 贡献值≥5 自动推进;专业队 = node_type code 约定识别 + 入队强制对应 gate;贡献值直读 attendance_records 只读汇总 Decimal 精度;`team-join-progress.ts` contribution/gate/presenter admin·app·enrollment 共用零分叉;evaluationExtendedUntil 跨轮入队消费 | [`docs/archive/reviews/recruitment-phase3-review.md`](docs/archive/reviews/recruitment-phase3-review.md)(冻结评审稿) |
| `wechat/` | M (948L) | 微信小程序通道层(wechat-settings 三端点 / 双 Provider / code2session 原生 fetch 8s + 25xxx 映射边界) | appSecret AES-256-GCM 永不回显;session_key 不存储即弃;openid 不滥回显(掩码);wx code / 含 secret 的 URL 不入日志;production-like 禁 DEV_STUB;providers/ 子目录为 AGENTS §2 已解锁例外(第三例) | [`docs/archive/reviews/wechat-mini-login-review.md`](docs/archive/reviews/wechat-mini-login-review.md)(冻结评审稿) |
| `storage/` | L (1720L) | LocalStorageProvider + CosStorageProvider + 动态 Router + AES-256-GCM | 2026-06-11 自 `src/common/` 旧址全量迁入(B 队列评审稿 §3,纯搬迁零行为,snapshot 零 diff);providers/ 子目录沿 AGENTS §2 已解锁例外 | [`CLAUDE.md`](src/modules/storage/CLAUDE.md) · [`docs/archive/reviews/queue-b-otp-birthday-infra-review.md`](docs/archive/reviews/queue-b-otp-birthday-infra-review.md) |
| `users/` | L (2385L) | 用户 CRUD + `/me*` + 改密 + refresh 联动撤销 + me/phone 绑定换绑 + me/wechat 绑定换绑 + admin 清号/清微信 | service 832L(2026-06-12 wechat T3 +3 方法跨入 god-service 观察线,与 attendances/attachments/registrations 同列 §4 体量观察,口径 source-only);Mixed Controller P1-C step 1 已拆完;P0-D / P0-E 全套铁律;phone / openid 占用均含软删(沿 username/email 不复用) | [`AGENTS.md §9`](AGENTS.md) · [`docs/security.md`](docs/security.md) |

> 已存在的 module/common-local CLAUDE.md 均应在本表行内引用,避免 AI 导航漂移(可由 `pnpm docs:codemap:check` 检出)。

---

## src/common/(基础设施,**禁止跨模块 utils grab-bag**)

| 路径 | 体量 | 职责 | 主要风险 |
|---|---|---|---|
| `audit/` | S (147L) | `AuditLogEvent` 事件总线 | A-1 写入即不可改 |
| `decorators/` | S (242L) | `@Roles` / `@CurrentUser` / `@PasswordChangeThrottle` 等 | 与 Guard 配套,不单独使用 |
| `dto/` | S (74L) | 跨模块共享 DTO(列表分页基类等) | **禁止**业务 DTO 入此目录 |
| `event/` | S (26L) | 应用事件基础 | — |
| `exceptions/` | M (947L) | BizCode 常量 + 业务异常类 | **`biz-code.constant.ts` 是 BizCode 唯一权威源**;新增段位前先查 [`AGENTS.md §9`](AGENTS.md) |
| `filters/` | S (86L) | 全局异常过滤器 + 统一返回 | 错误响应 schema 不动 |
| `guards/` | S (181L) | `JwtAuthGuard` / `RolesGuard` | Guard `@Roles(...)` + Service `rbac.can()` 双轨 |
| `interceptors/` | S (40L) | 统一返回包装等 | — |
| `prisma/` | S (22L) | PrismaService 注入 | **不**使用全局软删中间件 / client extension |

---

## prisma/

| 路径 | 职责 | 主要风险 / 本地铁律 | 本地约束 |
|---|---|---|---|
| `schema.prisma` | **数据模型唯一权威源**(字段 / 类型 / 约束 / 索引) | 修改前必先说明影响面 | [`CLAUDE.md`](prisma/CLAUDE.md) |
| `migrations/` | 21 个 migration(2026-05-02 init → 2026-06-19 add team-join phase3) | **禁止** `prisma migrate dev` / `reset` / `db push` 自动跑 | [`CLAUDE.md`](prisma/CLAUDE.md) · [`AGENTS.md §0`](AGENTS.md) |
| `seed.ts` | 默认 super admin + bootstrap user_role | 生产环境强校验启动(`SUPER_ADMIN_*` / `JWT_SECRET` / `APP_CORS_ORIGIN`) | [`docs/deployment.md`](docs/deployment.md) |

---

## src/bootstrap/(应用启动装配)

`apply-global-setup.ts` / `apply-swagger.ts` / `logger-options.ts` / `request-id.ts` / `throttle-options.ts` — `main.ts` 与 `test/setup/test-app.ts` **共用**这些文件,避免双份装配漂移。改其中任何一个之前先确认两边都被覆盖。

例外:`apply-crash-handlers.ts`(2026-06-12 #345)**仅 `main.ts` 注册**、test 入口刻意不注册——进程崩溃路径可观测性兜底(uncaughtException / unhandledRejection),与优雅关闭(`enableShutdownHooks`)职责互不重叠,边界见该文件头注释。

---

## test/

| 路径 | 职责 |
|---|---|
| `contract/` | OpenAPI snapshot + `EXPECTED_ROUTES`(接口契约权威源) |
| `e2e/` | E2E spec(v0.15.0 时 78 spec) |
| `fixtures/` / `helpers/` / `setup/` | 测试工具 |
| `jest-unit.config.ts` / `jest-e2e.config.ts` / `jest-contract.config.ts` | 三套独立 jest 配置 |

---

**冲突处理**:本表与代码冲突 → 以 `src/**` 与 `docs/current-state.md` 为准,本文件需回头修正;**不得**用本表否决 [`AGENTS.md`](AGENTS.md) 与 [`docs/api-surface-policy.md`](docs/api-surface-policy.md)。
