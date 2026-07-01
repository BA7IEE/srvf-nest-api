# CODEMAP — 源码模块导航

> 给 AI 的**源码地图**。文档地图请读 [`docs/README.md`](docs/README.md);当前事实读 [`docs/current-state.md`](docs/current-state.md);长期铁律读 [`AGENTS.md`](AGENTS.md)。
> 本文件**不**列 HTTP endpoint(那是 Swagger `/api/docs` 与 [`README.md`](README.md) 路由总览的事),**不**复制 `AGENTS.md` 规则。

**体量级别**:`S` <500 行 / `M` 500–1500 / `L` 1500–2500 / `⚠G` god-service(service 单文件 >700 行)

---

## src/modules/(31 个业务模块,平铺,**禁止嵌套 system/business/core 子目录**)

| 路径 | 体量 | 职责 | 主要风险 / 本地铁律 | 本地约束 |
|---|---|---|---|---|
| `activities/` | L (2393L) | 活动主资源,4 态状态机(`activity-state-machine.ts`) | service 607L 偏厚;participation 上下文核心 | [`CLAUDE.md`](src/modules/activities/CLAUDE.md) · [`docs/participation-bounded-context.md`](docs/participation-bounded-context.md) |
| `activity-registrations/` | L (2590L) | 活动报名,4 态 + partial unique + CSV export + 跨轴只读(2026-06-23) | service 924L(+跨活动横扫 + 队员履历 2 只读方法,沿 §4 体量观察);Mixed Controller P1-C step 3 已拆完;`controllers/admin-registrations.controller.ts` 跨轴只读 2 class | [`CLAUDE.md`](src/modules/activity-registrations/CLAUDE.md) · [`docs/api-surface-policy.md §5.1`](docs/api-surface-policy.md) |
| `ai/` | S (placeholder) | LLM / 向量占位 | **本期不实现**;README 占位 | [`AGENTS.md §1 C`](AGENTS.md) |
| `attachment-configs/` | L (2175L) | 附件配置三表(type / mime / size) | **不合表、不抽 facade、override-with-default** | [`docs/attachment-config-boundary.md`](docs/attachment-config-boundary.md) |
| `attachments/` | ⚠G (service 826L) | 多态附件主模块 + RBAC 业务面首批接入 | accessUrl / signed URL 永不返回;L3 字段隔离 | [`CLAUDE.md`](src/modules/attachments/CLAUDE.md) · [`docs/attachment-config-boundary.md`](docs/attachment-config-boundary.md) |
| `attendances/` | ⚠G (service 1285L) | 考勤主表 5 态(含终审)+ contribution 计算 + 跨轴只读(2026-06-23) | 5 个边界类已抽离(state-machine / audit-recorder / time-overlap-policy / contribution-calculator / presenter #280);P1-4 拆分系列 2026-06-10 调研收口,余量为事务编排本职,⚠G 仅体量观察(沿 current-state §4);+跨活动单据横扫 + 队员考勤记录/贡献汇总 3 只读方法(贡献复用 team-join 封顶核);App 端点在 `controllers/app-my-attendance-records.controller.ts`,跨轴只读队员面在 `controllers/admin-member-attendance.controller.ts` | [`CLAUDE.md`](src/modules/attendances/CLAUDE.md) · [`docs/participation-bounded-context.md`](docs/participation-bounded-context.md) |
| `audit-logs/` | M (594L) | 写入即不可改不可删(A-1 红线) | 各业务写路径已全接入 `AuditLogEvent` | [`AGENTS.md §9`](AGENTS.md) |
| `auth/` | M (1678L) | 登录 / refresh / logout / logout-all / 找回密码 + OTP 登录 + 微信登录与绑定(pre-auth 平铺三 service;2026-06-12 亲核计数) | **不引入 `LocalStrategy`**;`username+password` 在 service 内手写;找回密码 / OTP / 微信三套防枚举·防侧写一致性禁破坏;`createSession` 唯一签发点(三种登录共用) | [`CLAUDE.md`](src/modules/auth/CLAUDE.md) · [`AGENTS.md §1 永久铁律`](AGENTS.md) · [`docs/security.md`](docs/security.md) |
| `certificates/` | M (1410L) | 证书 N:1 + 4 态闭集 + verify/reject | service 556L (large-service watch);**不**属 participation 上下文(独立 member-qualifications) | [`docs/participation-bounded-context.md`](docs/participation-bounded-context.md)(明确排除) |
| `content/` | M (2115L,T4) | CMS 内容发布(第 28 模块):admin 面(T2)内容 CRUD + 状态机 draft/published/archived(立即生效无 cron)+ 封面双指针 + 附件经 `AttachmentsService`(content-image/content-file)+ 正文 `attachment:<id>` 占位读时改写 + viewCount(详情不增);open 面(T3,`open/v1/contents` @Public + 第 10 throttler content-public)+ app 面(T4,`app/v1/contents` canUseApp 准入 + 5 档可见性 public/member/formal_member/department/management)读取面 list/detail(详情不可见 → 404 防枚举 + viewCount 自增) | service 577L;判权 R 模式 `content.*.record` 5 码(admin);读取面 open=公开无码 / app=canUseApp 准入无码,可见性纯函数 `content.visibility.ts`(21 单测);附件写路径走 `AttachmentsService` rbac(`attachment.{upload,delete}.content-*`),content 读取面自签且仅过文章可见级后返(范围例外 a);读者出参零 authorUserId / 零 visibleOrganizationIds | [`docs/archive/reviews/content-module-review.md`](docs/archive/reviews/content-module-review.md)(冻结评审稿) |
| `contribution-rules/` | M (914L) | D14 预填规则 | **无 CRUD 流水表** | [`docs/participation-bounded-context.md`](docs/participation-bounded-context.md) |
| `dictionaries/` | M (1057L) | 字典双表 + 父子树 + 系统内置防误删守卫(W3) | service 504L(large-service watch);同 surface 双 controller(**非 surface Mixed**) | [`docs/api-surface-policy.md §5.1`](docs/api-surface-policy.md) |
| `emergency-contacts/` | S (571L) | N:1 紧急联系人 | 子资源 | — |
| `health/` | S (137L) | 健康检查(live / ready) | **模块结构例外**:只有 module + controller,**无 service** | [`AGENTS.md §2`](AGENTS.md) |
| `insurances/` | M (1551L) | 自购保险(App self-scope)+ 队保单 + 覆盖名单 + 报名门槛查询 | 覆盖名单 partial unique 在 migration 直写;`InsuranceRequirementService` 是唯一跨模块出口(activity-registration 单向依赖) | [`docs/archive/reviews/insurance-module-review.md`](docs/archive/reviews/insurance-module-review.md) |
| `member-departments/` | S (329L) | 一人一部门 partial unique | partial unique 在 schema 显式 | — |
| `member-profiles/` | M (1258L) | 1:1 子资源,含敏感字段(身份证默认掩码后 4 位) | **L3 字段不外暴**;白名单严格 | [`docs/security.md`](docs/security.md) |
| `members/` | S (501L) | 全局 `memberNo` **不复用** | memberNo 唯一性铁律 | [`docs/srvf-foundation-baseline.md`](docs/srvf-foundation-baseline.md) |
| `notifications/` | M | 生日祝福短信 job(G-7;本仓唯一 `@Cron`,09:00 Asia/Shanghai)+ **统一通知模块 S1 站内信渠道**(admin 撰写/发布 8 端点 + 会员站内信拉取 4 端点;镜像 content 状态机 + 可见性〔复用 content.visibility 去 public = 4 档〕+ NotificationRead 已读 + readCount)| no-cron 解锁范围仅生日批(站内 = 纯 pull 零 cron);统一形状列 audienceType/sourceType/channels 前向兼容(S1 仅 broadcast/admin/in-app;微信 quota / 短信兜底 / producer 定向 = S2-S5 additive);可见性复用 content.visibility 无第二套 | [`CLAUDE.md`](src/modules/notifications/CLAUDE.md) · [`docs/archive/reviews/unified-notification-dispatcher-review.md`](docs/archive/reviews/unified-notification-dispatcher-review.md) |
| `organizations/` | M (654L) | 组织树 | 树形结构 | — |
| `permissions/` | L (2213L) | RBAC 4 表 + `RbacService.can()` + `RbacCacheService` | `rbac.*` 14 条权限点;**`rbac/me/permissions` 方法级 Mixed 暂不拆 (P1-A)** | [`CLAUDE.md`](src/modules/permissions/CLAUDE.md) · [`AGENTS.md §8 / §13`](AGENTS.md) · [`docs/api-surface-policy.md §5.1`](docs/api-surface-policy.md) |
| `positions/` | S | 职务定义 + 职务规则配置面(终态 scoped-authz PR3):`OrganizationPosition` + `OrganizationPositionRule` CRUD;seed 6 领导职务 + 30 默认规则(R4/R6/R8);两 controller(positions 5 + position-rules 4)+ R 模式 8 码 `position.*.definition` / `position-rule.*.record` | **纯配置定义,绝不进任何判权路径**(消费它的 policy=PR7 / assignment=PR4 / authz=PR8);删除守卫:职务被规则引用禁删(32003) | [`docs/reviews/org-position-scoped-authz-terminal-design-review.md`](docs/reviews/org-position-scoped-authz-terminal-design-review.md)(冻结评审稿 §3.2/§3.3/§7.2) |
| `position-assignments/` | S | 任职双轴管理面(终态 scoped-authz PR4):`OrganizationPositionAssignment` 双轴 CRUD + 撤销 + 历史链;单 `PositionAssignmentsController`(`@Controller('admin/v1')` 跨 org/member/flat 3 根,5 路由)+ R 模式 4 码 `position-assignment.{read,create,revoke}.record` / `.read.history`;任命 5 校验(职务适配/单人独占/兼任/requireMembership〔读 closure 祖先集〕/任期);任命·撤销写 audit(`position_assignment`) | **任职 = 数据 + 任命校验,绝不进任何判权路径**(判权=PR8;RoleBinding=PR6);partial unique `(org,position,member) WHERE active` P2002→32021 | [`docs/reviews/org-position-scoped-authz-terminal-design-review.md`](docs/reviews/org-position-scoped-authz-terminal-design-review.md)(冻结评审稿 §3.4/§7.3) |
| `supervision-assignments/` | S | 分管管理面(终态 scoped-authz PR5):`OrganizationSupervisionAssignment`(与职务**正交**)CRUD + 分管范围/被谁分管查询;单 `SupervisionAssignmentsController`(`@Controller('admin/v1')` 跨 flat/member/org 3 根,6 路由)+ R 模式 4 码 `supervision-assignment.{read,create,update,revoke}.record`(三读端点共用 read.record);建校验(supervisor/org 存在+active/防重/任期,**不校验持职务**);supervision-scope(TREE 经 closure 展开后代/EXACT 仅该节点)+ supervisors(直接 DIRECT + 祖先 TREE 继承 INHERITED);建·撤销写 audit(`supervision_assignment`) | **分管 = 数据 + 展示,绝不进任何判权路径**(判权=PR8;RoleBinding=PR6);scope/supervisors 读 closure 仅展示非 judge;partial unique `(supervisor,org) WHERE active` P2002→33002 | [`docs/reviews/org-position-scoped-authz-terminal-design-review.md`](docs/reviews/org-position-scoped-authz-terminal-design-review.md)(冻结评审稿 §3.5/§7.4) |
| `role-bindings/` | S | 带 scope 的角色绑定管理面(终态 scoped-authz PR6):`RoleBinding`(principal × role × scope × 任期)CRUD;单 `RoleBindingsController`(`@Controller('admin/v1')`,4 路由 列/建/改/软删)+ R 模式 4 码 `role-binding.{read,create,update,delete}.record`;建校验(scope↔字段一致 34003/principal↔类型一致 34004〔多态无 FK,按 principalType 校验存在〕/role·org·activity 存在/任期 34005/防重 P2002→34002);建·软删写 audit(`role_binding`;伞 extra.viaPath ∈ {role-binding,user-role});USER 主体变更失效其权限缓存 | **🔴 UserRole→`RoleBinding(USER,GLOBAL)` 无损升级 = 判权唯一读源;RbacService 只读 GLOBAL,scoped 各型入库即止、绝不进判权路径**(判权=PR8);partial unique 全 scope 维度 `WHERE active` **NULLS NOT DISTINCT** P2002→34002;UserRole 表冻结零读写 | [`docs/reviews/org-position-scoped-authz-terminal-design-review.md`](docs/reviews/org-position-scoped-authz-terminal-design-review.md)(冻结评审稿 §3.6/§7.5/§8.2) |
| `realname/` | M (1087L) | 实名核验通道层(realname-settings 三端点 / 双 Provider / verify 编排 + 原生 fetch TC3 签名 8s + 27xxx 映射边界;招新一期 T2) | secretId/secretKey 两段 AES-256-GCM 永不回显;真通道休眠(DevStub 全验,腾讯云凭证待运维);姓名/身份证号不入日志;production-like 禁 DEV_STUB;providers/ 子目录为 AGENTS §2 已解锁例外(第四例) | [`docs/archive/reviews/recruitment-phase1-review.md`](docs/archive/reviews/recruitment-phase1-review.md)(冻结评审稿) |
| `recruitment/` | L (源 5264L) | 招新前段(T3)+ 二期(后段)+ S1–S3 + **S4a(H5 + 手机身份链)**:公开报名(`open/v1` multipart 提交 + 查询 + **H5 发码/验码/手机查询②/自助换微信换手机**)+ admin 轮次/报名管理 + 临时编号原子发号 + 实名核验编排 + 进度模型/工作台 stats/RBAC 敏感分级;**两层身份铁律**:临时编号绑 application,**不**进 members | 姓名/身份证号/手机仅入库不回显明文;证件照走 storage 短 TTL signed-URL + L3 不入日志;S4a 报名前会话表 `recruitment_identity_sessions` 承载 token(sha256 入库 + consumedAt 一次性,**不进报名表/不占容量去重统计**);`recruitment-identity.service.ts`(386L)复用 SmsCodeService(RECRUITMENT_BIND);**god-service 拆分(2026-06-28,纯重构零行为变更):`recruitment-applications.service.ts` 1248L→646L(公开 submit/recognize/query + 人工 resolve〔共享发号 FM-C〕),抽出 `recruitment-applications.presenter.ts`(纯视图/脱敏/CSV)+ `recruitment-applications-query.service.ts`(admin 读面)+ `recruitment-application-review.service.ts`(标门槛/批量/评定);沿 architecture-boundary §3.1/§3.2/§4** | [`docs/archive/reviews/recruitment-phase1-review.md`](docs/archive/reviews/recruitment-phase1-review.md) · [`recruitment-phase4-loop-optimization-review.md`](docs/archive/reviews/recruitment-phase4-loop-optimization-review.md)(冻结评审稿) |
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
| `migrations/` | 36 个 migration(2026-05-02 init → 2026-07-01 终态 scoped-authz PR5 分管:净新表 organization_supervision_assignments〔与职务正交;+2 枚举 SupervisionScopeMode{EXACT,TREE}/SupervisionStatus{ACTIVE,ENDED,REVOKED} + 4 索引 + 2 FK Restrict〔supervisorMemberId→Member/organizationId→Organization〕+ 末尾手写 partial unique (supervisorMemberId,organizationId) WHERE deletedAt IS NULL AND status='ACTIVE'〕,纯加空表无回填无不可逆(分管由 API 产生,不 seed);前一为 2026-07-01 终态 scoped-authz PR4 任职:净新表 organization_position_assignments〔+枚举 AssignmentStatus + 6 索引 + 3 FK Restrict + 末尾手写 partial unique (organizationId,positionId,memberId) WHERE deletedAt IS NULL AND status='ACTIVE'〕,纯加空表无回填无不可逆;前一为 2026-07-01 终态 scoped-authz PR3 职务定义:净新两空表 organization_positions + organization_position_rules〔+2 枚举 PositionCategory/PolicyStatus + 索引 + FK Restrict + 普通唯一〕,纯加空表无回填无不可逆(6 领导职务 + 30 默认规则由 seed 幂等 upsert);前一为 2026-07-01 终态 scoped-authz PR2 Membership:净新表 member_organization_memberships〔+2 枚举 MembershipType/MembershipStatus + 2 手写 partial unique〕 + 回填 active MemberDepartment→PRIMARY membership〔复用 id、startedAt=createdAt〕,纯加可逆;前一为 2026-07-01 终态 scoped-authz PR1 组织基座:organization_closure 闭包表〔WITH RECURSIVE 回填现有树〕 + Organization 两 additive 可空列 establishmentStatusCode?/groupFunctionCode?〔纯加无 enum 无回填无不可逆〕;再前为 2026-06-29 招新实名 OCR 鉴伪版充分利用:recruitment_applications +6 列〔ocrAddress/ocrNation/ocrAuthority/ocrValidDate + idCardCropImageKey/idCardPortraitImageKey;全可空 TEXT additive,无 enum 无不可逆无回填〕;再前为 2026-06-27 统一通知 S5 sms_settings.templateIdNotification 1 列 / S3 notifications.recipientMemberId 1 列 / S2 三表 / S1 两表) | **禁止** `prisma migrate dev` / `reset` / `db push` 自动跑 | [`CLAUDE.md`](prisma/CLAUDE.md) · [`AGENTS.md §0`](AGENTS.md) |
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
