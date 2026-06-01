# SRVF API 当前状态入口

> 本文件是 AI / Claude Code / 维护者进入仓库后的**第一入口**,也是**当前事实唯一权威源**。
> 本文件只记录"当前事实";历史 release handoff / 评审稿 / 批次决议自 v0.15.0 docs 治理收口起,**统一归档于 [`archive/`](archive/) 与 [`archive/handoff/`](archive/handoff/)**;`CHANGELOG.md` 仍维护逐版本累计。
> 每次 release / handoff 合入后,**必须**优先更新本文件。

---

## 0. 文档权威源分层(冲突时按此顺序判定)

| 维度 | 权威源 |
|---|---|
| **当前事实**(版本 / open PR / HEAD / 已发能力 / surface 状态) | 本文件(`docs/current-state.md`)+ 代码 + GitHub 当前状态 |
| **长期 AI 协作铁律**(命名 / 目录 / 错误码 / Guard / 软删除 / App API 边界 / §19 决策) | [`AGENTS.md`](../AGENTS.md)(主入口)+ [`srvf-foundation-baseline.md`](srvf-foundation-baseline.md) + [`V2红线与复活路径.md`](V2红线与复活路径.md) + [`api-surface-policy.md`](api-surface-policy.md) |
| **流程制度** | [`process.md`](process.md) |
| **架构设计背景** | [`../ARCHITECTURE.md`](../ARCHITECTURE.md)(请先读其顶部"当前阶段说明") |
| **历史 handoff / 批次 / 评审稿 / Phase reviews / first-release 过程档案** | [`archive/`](archive/) — **历史证据,不再作为当前执行约束** |

**铁律**:
- 当前事实与架构蓝图冲突时,以本文件为准;`ARCHITECTURE.md` 仅作为设计背景
- `archive/**` 内文档只代表归档时刻的决议;**当前代码已演进,以 `src/**` + 本文件为准**
- `CLAUDE.md` 已收口为入口转发(≤80 行);长期铁律以 `AGENTS.md` 为准
- 遇到冲突 → **不得擅自调和、不得擅自改文件**,先向用户汇报,等拍板

---

## 1. 当前版本状态

| 项 | 当前值 |
|---|---|
| 当前版本 | **v0.15.0**(P0-F 管理面 RBAC 收紧 + Phase 1A Swagger Tag 重命名 + App API Phase 2 完整 15 endpoint;release 收口已完成 2026-05-20T17:07:09Z) |
| `package.json#version` | `0.15.0` |
| Swagger `setVersion(...)` | `0.15.0` |
| 最新 git tag | `v0.15.0`(2026-05-20T17:07:09Z;指向 `089499d` = PR #163 handoff squash commit) |
| GitHub Latest Release | `v0.15.0`(标 Latest;publishedAt 2026-05-20T17:07:09Z;Notes 自 `CHANGELOG.md ## v0.15.0 - 2026-05-20` 段抽取) |
| `main` HEAD | **`88b9e26`** `test(certificates): add service characterization spec (#251)`(post-v0.15.0 docs 治理 + 架构边界抽离串 + Governance-1A 串 + **P1-C controller 物理拆分收口**(attendances step 4 = #236 / 状态回填 #237)+ **CODEMAP drift check 脚本**(#238)/ **CODEMAP 首批 drift 修复**(#239)/ **`srvf-god-service-refactor` skill**(#240)/ **`activity-registrations.service.spec.ts`**(#241)/ **current-state + CODEMAP 回填**(#242)/ **`attachments.service.spec.ts` service-level characterization spec**(#243)/ **`srvf-release-closeout` skill**(#244)/ **current-state 回填**(#245)/ **`activities.service.spec.ts` service-level characterization spec**(#246)/ **`attendances.service.spec.ts` service-level characterization spec**(#247)/ **current-state true-up #246-#247**(#248)/ **fresh-worktree preflight + migration 计数修正**(#249)/ **RBAC 模块历史注释 true-up**(#250)/ **current-state + CODEMAP true-up**(#252)/ **`users.service.spec.ts` service-level characterization spec**(#253)/ **`certificates.service.spec.ts` service-level characterization spec**(#251)均已落地;v0.15.0 release tag 仍指向 `089499d` = PR #163 handoff squash commit,2026-06-01 核对) |
| open PR | **0**(本入口刷新 PR 合并前) |
| 工作树状态 | clean |
| 最新 handoff | [`docs/archive/handoff/v0.15.0.md`](archive/handoff/v0.15.0.md)(v0.15.0 release closeout index;上一版 [`v0.14.0.md`](archive/handoff/v0.14.0.md));自 v0.15.0 docs 治理收口起,handoff 统一归档于 `archive/handoff/`,历史快照不回改 |
| Unreleased 累计 | **post-v0.15.0 已累计多轮治理、characterization、state-machine / audit-recorder 抽离与 drift cleanup PR**;当前 HEAD 以本表为准,完整历史以 GitHub PR / git log 为准;**均不构成 minor bump 触发条件**。 |

> **复核命令**(任何会话开工前都可以一行跑完):
>
> ```bash
> git rev-parse --short HEAD && \
> grep '"version"' package.json && \
> grep 'setVersion' src/bootstrap/apply-swagger.ts && \
> gh pr list --state open && \
> gh release list --limit 1 && \
> git status --short
> ```

> **下一步建议**:Governance-1A 已于 2026-05-21 落地为 PR #165(文档权威源收口 + 过程档案归档 + CLAUDE.md 转发化 + `api-surface-policy.md` 新增);之后陆续合入 PR-1 ~ PR-6(#204-#209 docs 治理压缩)+ #210(AGENTS.md 压缩与死链修)+ #211(current-state HEAD refresh + 入口表死链修)+ #212(CLAUDE.md 项目背景 v1 范围裁剪)+ attendances / activities / activity-registrations / attachments 的 characterization tests + state machine / audit recorder 抽离串(沿 [`architecture-boundary.md`](architecture-boundary.md))。**P1-A 决策锁已落地**(沿 [`api-surface-policy.md §5-§8`](api-surface-policy.md));**P1-B characterization tests 4 个 god-service(attendances / activities / activity-registrations / attachments)已覆盖**;**P1-C step 1/2/3/4 已完成**([`users.controller.ts`](../src/modules/users/users.controller.ts) `/me*` 三端点 / [`attachments.controller.ts`](../src/modules/attachments/attachments.controller.ts) `me/uploaded` / [`activity-registrations.controller.ts`](../src/modules/activity-registrations/activity-registrations.controller.ts) 同文件 Mobile class / [`attendances.controller.ts`](../src/modules/attendances/attendances.controller.ts) 同文件 `AttendanceRecordsMeController` 已分别迁出至 `controllers/*-legacy.controller.ts`;`attendances` step 4 见 PR #236,merge commit `bfb93b9`,主 controller 仅剩 2 个 Admin class,endpoint / OpenAPI snapshot zero drift;详 [`api-surface-policy.md §5.1 / §7 P1-C`](api-surface-policy.md));API surface P1-C same-file controller physical split 已收口,后续若继续推进应另行评估 docs-only 状态刷新、CODEMAP 漂移检查或 service-level characterization tests,**不**借此 deprecate `/api/v2/users/me/attendance-records` / 拆 `attendances.service.ts` / 启动 Phase 1B alias / 改 OpenAPI snapshot;**API surface 全量迁移(Route B)已于 2026-06-01 立项冻结**(取代原"Phase 1B 暂缓 / 方案 C";详 [`api-surface-migration-plan.md`](api-surface-migration-plan.md) + [`AGENTS.md §21 D-9`](../AGENTS.md);代码零改动,分阶段单独立项)。 **post-#237 治理 / characterization / harness 串**:CODEMAP drift check 脚本(#238)/ CODEMAP 首批 drift 修复(#239)/ `srvf-god-service-refactor` skill(#240)/ `activity-registrations.service.spec.ts`(#241)/ current-state + CODEMAP 回填(#242)/ `attachments.service.spec.ts` service-level characterization spec(#243)/ `srvf-release-closeout` skill(#244)/ current-state 回填(#245)/ `activities.service.spec.ts` service-level characterization spec(#246)/ `attendances.service.spec.ts` service-level characterization spec(#247)均已落地。**当前下一步建议**:(1)4 个 god-service service-level characterization spec **已全部覆盖**(`activity-registrations` #241 / `attachments` #243 / `activities` #246 / `attendances` #247);`certificates`(556L)/ `users`(544L)均**低于 god-service 700L 阈值**(large-service watch);二者 service-level characterization spec 均已用户拍板并合并(`certificates` #251 / `users` #253),**6 个 god/large-service service spec 全覆盖**;(2)`srvf-release-closeout` skill 已可投入后续 release / merge 收口实战;(3)§1 `main` HEAD 随后续 PR 自然滞后属固有现象,本轮 A 档 docs-only re-sync 已追平至 `88b9e26` / #251(含 #252 true-up + #253 users spec);(4)模块体量括注采用 source-only 口径(排除 `*.spec.ts`),test-only spec PR(#241 / #243 / #246 / #247 / #251 / #253)不改动其数字;`CODEMAP.md` 的 migration 计数已于 #252 修正为 12(末位 `add_refresh_tokens`);`pnpm docs:codemap:check` 当前 0 FAIL。

---

## 2. 当前系统已具备能力

> 仅做"清单级"罗列。**当前字段 / 接口 / 错误码事实权威源**:字段 / 类型 / 约束 / 索引以 [`../prisma/schema.prisma`](../prisma/schema.prisma) 为准;接口路径 / DTO / 权限矩阵以 Swagger UI(`/api/docs`)+ [`../test/contract/openapi.contract-spec.ts`](../test/contract/openapi.contract-spec.ts) `EXPECTED_ROUTES` + OpenAPI snapshot 为准;BizCode 编号 / message / httpStatus 以 [`../src/common/exceptions/biz-code.constant.ts`](../src/common/exceptions/biz-code.constant.ts) 常量与 [`../CHANGELOG.md`](../CHANGELOG.md) 累计为准。[`docs/v2-api-contract.md`](v2-api-contract.md) 仅作为 V2-D8 立项时刻 draft 参考,**不再作为当前字段 / 接口 / 错误码的执行依据**。

- **v1 基础能力**:NestJS + Prisma + PostgreSQL + JWT 登录 + 三层 `Role` + 用户 CRUD + 软删除 + 统一返回格式 + Swagger 100%(沿 [docs/archive/legacy/architecture-v1-blueprint.md §1-§10](archive/legacy/architecture-v1-blueprint.md);原 `ARCHITECTURE.md §1-§10`,PR-6 已归档)
- **V1.1 工程加固**:`nestjs-pino` 结构化日志 + 请求 ID + helmet + 登录限流 + 健康检查分层 + 优雅关闭 + Dockerfile 多阶段 + GitHub Actions CI(沿 [ARCHITECTURE.md §11](../ARCHITECTURE.md))
- **V2 数据底座**:`dictionaries`(双表 + 父子树)/ `organizations`(树)/ `members`(全局 `memberNo` 不复用)/ `member_departments`(一人一部门 partial unique)
- **V2 批次 1**:`member_profiles`(1:1 子资源,含敏感字段)/ `emergency_contacts`(N:1 子资源)
- **V2 批次 2**:`certificates`(N:1 + 4 态闭集 + verify/reject)
- **V2 批次 3A**:`activities`(状态机 4 态)/ `activity_registrations`(4 态 + partial unique + CSV export)
- **V2 批次 3B / 4-A / 4-B**:`attendance_sheets`(5 态;含终审)/ `attendance_records` / `contribution_rules`(D14 预填规则;无 CRUD 流水表)
- **V2 批次 6**:`audit_logs` 写入即不可改不可删(A-1 红线);`AuditLogEvent` 各业务写路径已全部接入(含 P0-D 本人改密 `password.change.self`,#117)
- **v0.13.0 P0-D 本人自助改密**:`PUT /api/users/me/password`(`ChangeMyPasswordDto { oldPassword, newPassword }`)+ 2 BizCode(`OLD_PASSWORD_INVALID=10005` / `NEW_PASSWORD_SAME_AS_OLD=10006`)+ 独立 throttler `password-change`(IP 5次/60秒,与登录限流物理隔离)+ audit `password.change.self`;**不主动吊销 access token**(沿 D-4);P0-E PR-3 落地后**联动撤销 refresh token**(`self-password-change`)
- **v0.14.0 P0-E refresh token / logout / logout-all**(#127 代码 + #128 状态回填 + #129 bump + #130 handoff + tag/Release 已发布 2026-05-17T19:16:06Z):新增 3 个 API 端点(`POST /api/auth/refresh` rotation always + family revoke + absolute expiration / `POST /api/auth/logout` 幂等 / `POST /api/auth/logout-all` 撤销该 user 全部 refresh)+ `LoginResponseDto` 扩 `refreshToken` + `refreshExpiresAt` 字段(`LoginDto` 入参 zero drift)+ **新表** `refresh_tokens`(`tokenHash @unique` 只存 sha256 hash + family 关联 + replacedById 链;migration `20260517165220_add_refresh_tokens`)+ `JWT_EXPIRES_IN=15m`(由 7d 收敛)/ `JWT_REFRESH_EXPIRES_IN=90d`(family absolute expiration 不滑动)+ 新 BizCode `REFRESH_TOKEN_INVALID=10007`(失败 4 子原因统一码)+ 独立 throttler `refresh`(IP 30/60)+ 联动撤销 4 场景(本人改密 / 管理员重置 / 用户禁用 / 用户软删 → `updateMany` 同事务)+ 新 5 audit event(`auth.login` / `auth.refresh` / `auth.logout` / `auth.logout-all` / `password.reset.by-admin`);**access token 仍不主动吊销**(沿 D-4 + 15m TTL + JwtStrategy 每请求查库);**JWT payload 严格 zero drift** `{ sub, username }`;**不**做 tokenVersion / access blacklist / Redis / refresh 查询接口 / 设备列表(沿 D-9)
- **V2.x C-6 RBAC**:`RbacRole` / `Permission` / `RolePermission` / `UserRole` 4 表 + `RbacService.can()` + 14 条 `rbac.*` 权限点 + `ops-admin` 内置角色 + bootstrap user_role
- **V2.x C-7 attachments**:多态附件主模块(`@unique` key 已加)+ 配置三表(type / mime / size)+ 业务级 `rbac.can()` 首个业务模块接入(管理面已 P0-F 收紧;业务面除本模块外仍归 Slow-4;详 §3 / §4)
- **V2.x C-7.5 storage**:`StorageSettings` singleton + `LocalStorageProvider` + `CosStorageProvider` + 动态 Router + AES-256-GCM 凭证加密 + 后台 admin API + production fail-fast hook + `APP_ENV=smoke` 专用 CI 形态
- **v0.15.0 已发布能力**(release 收口已完成 2026-05-20T17:07:09Z;tag `v0.15.0` 指向 `089499d` = PR #163 handoff squash commit;GitHub Release Latest = `v0.15.0`):
  - **P0-F RBAC 收紧 4 PR**(评审稿 + 实施):管理面(`rbac/*` 接入 `rbac.can()`,#132)/ 配置面(`config/*` PR-2 + PR-2A + PR-2B,#133 / #134 / #135 / #136)/ 用户管理面(`users/*` 接入 `rbac.can()`,#137 / #138)/ 审计日志面(`audit-logs/*` 接入,#139 / #140);完成"Guard `@Roles(...)` + Service `rbac.can()`" 双轨在管理面的统一收紧
  - **Phase 0/1 客户端边界评审 + Phase 1A Swagger Tag 重命名**(#141 评审 / #142 重命名):Swagger Tag 向 `surface-module` 分类体系收敛(App / Admin / System / Public 4 surface × module);**0 endpoint 变更**(仅 `@ApiTags` 重命名);Phase 1B path alias `/api/auth/v1/*` + `/api/public/v1/*` **本期未启动**
  - **App API Phase 2 完整 9-PR 串 P2-0 ~ P2-8 全部合入**(#143 ~ #161;沿 [`docs/archive/reviews/app-api-phase-2-review.md`](archive/reviews/app-api-phase-2-review.md);P2-8 #161 = docs closeout):**15 个新 endpoint** 全部落地,5 个新 Controller(均以 `@Controller('app/v1/...')` 前缀,沿 [Phase 0.5 §10.2 D-4](archive/reviews/app-permission-boundary-review.md) `/me/*` 与 `/my/*` 物理分离):
    - **身份 / 账号 / 能力**(P2-1):`GET /api/app/v1/me` / `GET /api/app/v1/me/account` / `GET /api/app/v1/me/capabilities`(暴露 product-level capability 而非 raw RBAC permission code,沿 D-5.3)
    - **个人资料**(P2-2):`GET /api/app/v1/me/profile` / `PATCH /api/app/v1/me/profile`(白名单严格 2 字段 `nickname` + `avatarKey`;身份证号默认掩码后 4 位)
    - **本人改密**(P2-3):`PUT /api/app/v1/me/password`(继承 P0-D / P0-E 全套铁律:`@PasswordChangeThrottle()` / 10005 / 10006 / 联动撤 refresh / audit `password.change.self`)
    - **活动**(P2-4):`GET /api/app/v1/activities/available`(可参加列表)/ `GET /api/app/v1/activities/{id}`(App 视角详情 DTO)
    - **本人报名**(P2-5):`GET /api/app/v1/my/registrations` / `GET /api/app/v1/my/registrations/{id}` / `GET /api/app/v1/my/activities`(P2-5a 只读)+ `POST /api/app/v1/my/registrations` / `PATCH /api/app/v1/my/registrations/{id}/cancel`(P2-5b 写)
    - **本人考勤**(P2-6):`GET /api/app/v1/my/attendance-records`
    - **本人证书**(P2-7):`GET /api/app/v1/my/certificates`
  - **App API DTO 严格 Mobile 隔离**:Phase 2 全部 DTO 均新建 `dto/app/` 子目录承载(沿 [Phase 0.7 §2.2](archive/reviews/code-architecture-boundary-review.md) / [Phase 0.6 §6.1](archive/reviews/data-access-lifecycle-boundary-review.md));**禁止** `extends` / `Pick` / `Omit` / `IntersectionType` / `PartialType` / `OmitType` 一个 Admin DTO 构造 App DTO;App API where 子句永远用 `currentUser.memberId` 锁定本人(`scope = self`);**永不返回 L3 字段**(`passwordHash` / `refreshToken` / `tokenHash` / `secretKey*` / `secretId*` / 完整 signed URL)
  - **App API 准入语义**(沿 [`docs/archive/reviews/app-permission-boundary-review.md §10.2`](archive/reviews/app-permission-boundary-review.md) D-5):仅 `User.memberId != null && User.status=ACTIVE && User.deletedAt IS NULL && Member.status=ACTIVE` 的正式队员可用 App;候选 / 临时编号志愿者本期**不**支持;Admin 兼队员走 linked-member self perspective,**不**扩大字段可见性
- **测试与契约**:
  - Unit / E2E 实数以最近 main 合入 PR(#160)CI 记录为准,本 P2-8 docs-only PR **未重跑**
  - E2E spec 总数自 v0.14.0 的 55 spec 增至 **78 spec**(其中 Phase 2 新增 **8 个 App API e2e spec**:`app-me` / `app-me-password` / `app-activities-available` / `app-activities-detail` / `app-my-registrations-read` / `app-my-registrations-write` / `app-my-attendance-records` / `app-my-certificates`;v0.15.0 后续累计 characterization / state-transition / legacy split 相关 spec 共 15 个,沿 #196 / #199 / #202 等 PR 合入)
  - Contract OpenAPI snapshot 已覆盖 **15 个 `/api/app/v1/*` 端点**(沿 [`test/contract/openapi.contract-spec.ts`](../test/contract/openapi.contract-spec.ts) `EXPECTED_ROUTES`)
  - `ci.yml` 全套 + `docker-smoke.yml` 真实启动回归继续生效,env 锁定值与 v0.14.0 一致(`JWT_EXPIRES_IN=15m` + `JWT_REFRESH_EXPIRES_IN=90d`)

---

## 2.1 当前 API surface 状态

> 详细 surface 长期边界与新增 / 迁移规则见 [`api-surface-policy.md`](api-surface-policy.md)。
> ⚠️ **2026-06-01 方向变更(Route B 立项冻结)**:用户拍板重开 [`AGENTS.md §19.7 D-2`](../AGENTS.md),放弃"方案 C(v2 长期保留)",改为**按客户端/场景四分的全量物理迁移**(`/api/admin/v1` + `/api/app/v1` + `/api/auth/v1` + `/api/system/v1`,预留 `/api/open/v1`)。**立项已冻结但代码零改动**——下表是迁移前现状;目标形态与分阶段计划见 [`api-surface-policy.md §0`](api-surface-policy.md) + [`api-surface-migration-plan.md`](api-surface-migration-plan.md) + [`AGENTS.md §21 D-9`](../AGENTS.md)。迁移每阶段 D 档、单独立项、串行、**AI 不自动启动**。

| Surface(现状) | 当前前缀 | 目标前缀(Route B) | 新增能力策略(2026-06-01 起) |
|---|---|---|---|
| **App** | `/api/app/v1/*` | `/api/app/v1/*`(不迁移) | 新移动端 endpoint **只能**落此;DTO 必须独立定义于 `dto/app/`,禁止派生 Admin DTO |
| **Admin** | `/api/v2/*` + `/api/users/*` | `/api/admin/v1/*` | 新管理面 endpoint 落 `/api/admin/v1/*`;**不再向 `/api/v2/*` 新增** |
| **Auth** | `/api/auth/*` | `/api/auth/v1/*` | 新认证 endpoint 落 `/api/auth/v1/*`;存量 alias 迁移 |
| **System** | `/api/health/*` + v2 中 ops/配置类 | `/api/system/v1/*` | 新 ops/系统 endpoint 落 `/api/system/v1/*`(承接 D-1 contribution-rules) |
| **Open** | — | `/api/open/v1/*`(预留) | 本期不实现、不占用 |

**铁律**:
- ❌ **不再新增 Mixed Controller**(class-level `@ApiTags('Admin - X')` + 方法级追加 `Mobile - X`);v0.15.0 之前已落地的 6 项存量已大部分清零(沿 [`api-surface-policy.md §5.1`](api-surface-policy.md)):`users.controller.ts` / `attachments.controller.ts` / `activity-registrations.controller.ts` / `attendances.controller.ts` 四项**已完成 P1-C step 1/2/3/4 物理拆分**(原 Mobile class 或方法级 Mobile tag 已迁出至独立 `controllers/*-legacy.controller.ts`,主 controller 不再 surface Mixed;`attendances` 拆分见 PR #236,merge commit `bfb93b9`,`AttendanceRecordsMeController` 迁至 `controllers/attendances-me-records-legacy.controller.ts`);`permissions/rbac.controller.ts` `me/permissions` 单方法仍 method-level Mixed(P1-A 暂不拆,沿 §5.1 项 5);`dictionaries.controller.ts` 为**非 surface Mixed**(同 surface 双 class,文件结构问题)
- ❌ 旧 mobile-like endpoint(`/api/users/me/*`)**只维护兼容、不扩展**;新移动端能力进 `/api/app/v1/*`
- ❌ App API **永远不返回** L3 字段(`passwordHash` / `refreshToken` / `tokenHash` / `secretKey*` / `secretId*` / 完整 signed URL)

---

## 3. 当前明确未做 / 暂不启动

> 这些事项**不**由 AI 自行启动,需要用户拍板。

- **不**自动启动 Slow-3(ADMIN 内置角色 / ADMIN 默认附件权限边界)— 等业务方对"业务管理员边界"补充澄清
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
- **Route B 全量迁移已立项冻结**(2026-06-01;取代原"Phase 1B 暂缓 / 方案 C")— 见 [`api-surface-migration-plan.md`](api-surface-migration-plan.md) + [`AGENTS.md §21 D-9`](../AGENTS.md);**Phase 0 映射已签字冻结**(2026-06-01;[§3](api-surface-migration-plan.md) 全 156 路由 `tag→surface` + 终态验收基线 + 8 个 legacy mobile-like 端点纳入 Phase 4 删除);**Phase 1 alias 已完成**(1a auth+health 7 + 1b system 56 + 1c admin 70 = 133 非-app 路由双挂,contract 423 + e2e 双路径绿,老路径零回归);**Phase 2 完成**(老前缀 OpenAPI 标 `deprecated`、新前缀 canonical);**Phase 3 deprecation 窗口豁免**(无生产消费者,用户 2026-06-01 确认 → 直接 Phase 4);**Phase 4 removal 进行中**(4a:auth+health 老路径已删,收为单一前缀 `auth/v1` + `system/v1/health`,full e2e 1800 绿;余 system/admin/orphan 切片),**每阶段 D 档、串行、AI 不自动启动**;`/api/open/v1/*` 仅预留不实现
- **P1-C step 4 已完成**(PR #236,merge commit `bfb93b9`):`attendances.controller.ts` 原 `AttendanceRecordsMeController` 已迁至 `controllers/attendances-me-records-legacy.controller.ts`,主 controller 仅剩 2 个 Admin class;endpoint / OpenAPI snapshot zero drift;**不**借此 deprecate `/api/v2/users/me/attendance-records` / 改 `attendances.service.ts` / 改 DTO / 改 OpenAPI snapshot / 启动 Phase 1B alias(全部需要单独立项);`users.controller.ts` / `attachments.controller.ts` / `activity-registrations.controller.ts` 三项 P1-C step 1/2/3 同样已完成
- **不**自动拆分 `attendances.service.ts`(1157 行)/ `attachments.service.ts`(826 行)/ `activity-registrations.service.ts`(750 行)等 god-service — characterization tests 已落地一批(沿 [`architecture-boundary.md §5`](architecture-boundary.md));拆 service 行为本身仍需单独立项
- **不**自动引入 repository / `*.repository.ts` 抽象层 — service 直连 Prisma 沿用
- **不**在未立项 Phase 的情况下改 controller path / 动 `/api/v2/*` / 改 OpenAPI snapshot;Route B 迁移按 [`api-surface-migration-plan.md §6`](api-surface-migration-plan.md) 分阶段推进,**每阶段单独立项后**才动对应代码

---

## 4. 当前最大风险 / 债务

| 等级 | 债务 | 处理建议 |
|---|---|---|
| P0 | 缺少"当前状态入口" | ✅ 本文件已建立;后续每次 release / handoff 合入后必须回填 |
| P0 | handoff 同时承担"历史快照"与"当前事实",内部前后不一致(`v0.12.0` handoff §0 已打 tag、§6/§10/§11 仍写"未打") | handoff 一律视为**历史快照,合入后不回改**;当前事实以本文件为准 |
| P1 | 权限体系双轨并存(Guard `@Roles(...)` + Service `rbac.can()`);**管理面已通过 P0-F / v0.15.0 收紧**(rbac / config / users / audit-logs 4 PR 接入 `rbac.can()`,#132 / #134 / #136 / #138 / #140;原 P0 已闭环);**剩余业务面**(attachments 之外)细粒度权限接入仍归 Slow-4 范围 | 管理面双轨收口已完成;业务面 RBAC 接入等业务方拍板 Slow-3(ADMIN 内置角色边界)后再启动 Slow-4 |
| P1 | 第一版前端联调包仅剩运维侧 P0-H / P0-I | **P0-A ~ P0-G 已全部落地并随 v0.13.0 / v0.14.0 / v0.15.0 发布**:P0-A 起步包(#110)/ P0-G BizCode 翻译表(#111)/ P0-C bootstrap SOP(#113)/ P0-D 本人自助改密(#115-#118)/ P0-B 测试 COS 闭环验收(#125)/ P0-E refresh token / logout / logout-all(#126-#128)/ P0-F RBAC 收紧 4 PR(#132-#140);**剩余**:P0-H 部署演练 + P0-I 排错 SOP — 由运维侧立项,系统侧本节无新增动作 |
| P1 | docs/ 体系庞大(根 6 大文档 + docs/ 50+ 文件);治理仍持续 | ✅ 2026-05-21 治理收口 PR 已将 49 份历史 handoff / 评审稿 / 批次 / first-release 过程档案 / FINAL_REPORT 迁至 [`archive/`](archive/);✅ PR-4(2026-05-22)将 `srvf-foundation-research.md` / `srvf-foundation-data-model-draft.md` / `srvf-foundation-interview-brief.md` 3 个 V2 设计期产物归档至 [`archive/plans/v2-design-phase/`](archive/plans/v2-design-phase/);✅ PR-5(#208)将 `docs/v2-plan.md` 归档至 [`archive/plans/v2-first-stage-plan.md`](archive/plans/v2-first-stage-plan.md);✅ PR-6(#209)将 `ARCHITECTURE.md` 顶层入口重写(1547→294 行),设计期蓝图按章节归档至 [`archive/legacy/architecture-v1-blueprint.md`](archive/legacy/architecture-v1-blueprint.md) / [`archive/legacy/architecture-v1-1-hardening.md`](archive/legacy/architecture-v1-1-hardening.md) / [`archive/plans/architecture-v2-first-stage-blueprint.md`](archive/plans/architecture-v2-first-stage-blueprint.md);✅ **G1-PR-C(#217)** `docs/srvf-business-docs.md` 硬编码本机路径泛化 + G-10 双仓库协作规则占位;✅ **G1-PR-D(#218)** `TASKS.md` 入口化 + V2 第一阶段与 V2.x 批次历史全文归档至 [`archive/legacy/tasks-v2-first-stage-historical.md`](archive/legacy/tasks-v2-first-stage-historical.md);**后续治理串**(G1-7 development/security cross-check / G2 顶层规则缺口 / Phase G3 业务 RCT)沿 [`system-foundation-governance.md §6`](system-foundation-governance.md) 路线图推进 |
| P1 | `TASKS.md` 历史体量与 V1.1 / V2.x 任务混排(原始单文件历史任务堆积) | ✅ G1-PR-D(#218)已闭环:根目录 `TASKS.md` 已入口化为 **166 行入口索引**;V2 第一阶段 Step 1-7 + V2.x C-6 RBAC / C-7 attachments / C-7.5 Provider / §10 后续任务 全文已 verbatim 归档至 [`archive/legacy/tasks-v2-first-stage-historical.md`](archive/legacy/tasks-v2-first-stage-historical.md);根目录保留 §6/§7/§8/§9/§10 章节锚点供 active(V2 红线 / v2-api-contract 等)+ frozen handoff(v0.9.0/v0.10.0/v0.11.0/v0.12.0)历史引用解析 |
| P2 | `attendances.service.ts` 1157 行(单文件;state-machine + audit-recorder + time-overlap-policy + contribution-calculator 已抽离) | `attendances.service.spec.ts` service-level characterization spec 已补(#247,沿 [`architecture-boundary.md §5`](architecture-boundary.md));后续 Presenter / QueryService 边界拆分需单独立项,本期不动 |
| P2 | `attachments.service.ts` 826 行 / `activity-registrations.service.ts` 750 行 / `activities.service.ts` 607 行 | audit-recorder / state-machine 已抽离;`activity-registrations`(#241)+ `attachments`(#243)+ `activities`(#246)均已补 service-level characterization spec;后续 Presenter / QueryService 边界拆分需单独立项,本期不动 |
| P2 | service 单测仍偏少(`src/` 内 **20** 个 `*.spec.ts` / 213 个源文件 ≈ 9.4%) | E2E 78 spec 覆盖回归;4 个 god-service + 2 个 large-service(`certificates` #251 / `users` #253)service spec **均已覆盖** |
| P2 | Mixed Controller 存量(`permissions/rbac.controller.ts` `me/permissions` 方法级 Mobile - Capabilities(P1-A 暂不拆)/ `dictionaries.controller.ts` 同 surface 双 controller(非 surface Mixed);`users.controller.ts` / `attachments.controller.ts` / `activity-registrations.controller.ts` / `attendances.controller.ts` 四项 P1-C step 1/2/3/4 已完成) | 仅兼容,不再新增;剩余 mixed / method-level 状态以 [`api-surface-policy.md §5.1 / §7`](api-surface-policy.md) 当前表为准 |
| P2 | Contract snapshot 单文件约 1,083,564 字节 / 37,517 行(~1058 KB),review 困难 | 接受;PR review 时用 diff 工具看 |
| P3 | `common/storage/` 已承载完整 module + controller(超出原 "common = 跨模块基础设施" 语义) | 长期可迁到 `src/modules/storage/`;本期不动 |

---

## 5. 新任务开工前必须检查

> **门禁**:任何一项不满足,**不开新功能**,先与维护者对齐。

- [ ] `git status --short` 工作树 clean
- [ ] `git branch --show-current` 在期望分支(`main` 或 `claude/*` worktree)
- [ ] `gh pr list --state open` 输出为空(open PR = 0)
- [ ] `package.json#version` 与 Swagger `setVersion(...)` 与最新 tag 三方一致
- [ ] 最新 [`docs/archive/handoff/`](archive/handoff/) 文件存在,且本文件 §1 表已反映该 release
- [ ] [`CHANGELOG.md`](../CHANGELOG.md) `## Unreleased` 段不残留与上次 release 重复的未释放变更
- [ ] 本次任务是否涉及 **D 档**(schema / migration / 权限 / 安全 / 存储 / audit / 不可逆变更);若是,先按 [`docs/process.md §4`](process.md) 降速
- [ ] 本次任务是否需要用户拍板(C / D / E 档);若是,先回到对话等用户确认,**不动代码**

> **fresh worktree 前置**(新建 worktree / 新克隆后,首次运行任何 `typecheck` / `lint` / `test` 之前必做):
>
> ```bash
> pnpm install --frozen-lockfile   # worktree 不共享 node_modules,需各自安装依赖
> pnpm prisma generate             # 生成 Prisma Client
> ```
>
> 未生成 Prisma Client 时,`pnpm typecheck` 会报大量 `@prisma/client has no exported member 'Role'` / `'UserStatus'` 之类**假错误**——这不是代码错误,而是环境准备不足。先跑上面两条,再判断红绿。

详细流程见 [`docs/process.md §2`](process.md)。

---

## 6. 文档阅读顺序

> 不要一次读完所有文档。按"最少必要"读到能完成当前任务为止。

1. **`docs/current-state.md`**(本文件)— 当前事实
2. **用户当前任务说明** — 决定下一步动作
3. [`README.md`](../README.md) — 项目快速概览 / 路由总览 / 文档地图
4. [`AGENTS.md`](../AGENTS.md) — **长期 AI 协作铁律主入口**(§0-§19;`CLAUDE.md` 已收口为入口转发)
5. [`docs/process.md`](process.md) — 开发流程与 PR 五档分级
6. [`docs/api-surface-policy.md`](api-surface-policy.md) — API surface 长期边界
7. [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — 架构设计背景(请先读顶部"当前阶段说明")
8. [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) — V2 基线规范(13 项 A 档)
9. [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) — V2 五档红线(A/B/C/D/E)
10. **仅在相关时**:
    - 运行 SOP:[`development.md`](development.md) / [`testing.md`](testing.md) / [`deployment.md`](deployment.md) / [`security.md`](security.md) / [`ops/cos-production-rollout-checklist.md`](ops/cos-production-rollout-checklist.md)
    - 业务上下文边界图:[`participation-bounded-context.md`](participation-bounded-context.md)(activities / activity-registrations / attendances / contribution-rules 4 模块的状态链条与跨模块耦合;**不**含 certificates)
    - 附件配置三表边界:[`attachment-config-boundary.md`](attachment-config-boundary.md)(`AttachmentTypeConfig` / `AttachmentMimeConfig` / `AttachmentSizeLimitConfig` 的 override-with-default 模式、运行时读点、不合表/不抽 facade 的理由)
    - 架构边界 / service 抽离:[`architecture-boundary.md`](architecture-boundary.md)(Presenter / QueryService / PolicyService / StateMachine / AuditRecorder / Effect 6 类抽离决策与触发条件;承接 `AGENTS.md §19.7 D-7`)
    - 历史 handoff:[`archive/handoff/v0.15.0.md`](archive/handoff/v0.15.0.md)(最新)/ [`v0.14.0.md`](archive/handoff/v0.14.0.md) / 更早版本均在 [`archive/handoff/`](archive/handoff/)
    - 历史评审稿 / 批次决议:[`archive/reviews/`](archive/reviews/) / [`archive/batches/`](archive/batches/)
    - 历史阶段计划:[`archive/plans/`](archive/plans/)(含 `first-release-bootstrap-sop.md` / `first-release-p0d-change-my-password-review.md` 在 `archive/reviews/`)

`archive/**` 内文档**只代表归档时刻的决议**,不再作为当前执行约束。

---

## 7. 冲突处理原则

> 简表;权威分层与铁律见本文件 §0。

| 维度 | 权威源 |
|---|---|
| **当前事实**(版本 / open PR / HEAD / 已发能力 / surface 状态) | 代码 + GitHub 当前状态 + 本文件 |
| **长期 AI 协作铁律**(命名 / 目录 / 错误码 / Guard / 软删除 / App API 边界 / §19 决策) | [`AGENTS.md`](../AGENTS.md) > [`srvf-foundation-baseline.md`](srvf-foundation-baseline.md) > [`V2红线与复活路径.md`](V2红线与复活路径.md) > [`api-surface-policy.md`](api-surface-policy.md) |
| **流程制度** | [`process.md`](process.md) |
| **架构设计背景** | [`../ARCHITECTURE.md`](../ARCHITECTURE.md)(请先读顶部"当前阶段说明") |
| **历史证据**(release 历史 / 评审决议 / 批次决议) | [`archive/handoff/v*.md`](archive/handoff/) + [`archive/reviews/`](archive/reviews/) + [`archive/batches/`](archive/batches/) + [`../CHANGELOG.md`](../CHANGELOG.md) |

**铁律**:遇到冲突 → **不得擅自调和、不得擅自改文件**,先向用户汇报,等拍板。
