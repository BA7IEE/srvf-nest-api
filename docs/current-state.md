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
| `main` HEAD | **`8b2378e`** `docs: compress AGENTS governance rules and fix stale references (#210)`(post-v0.15.0 docs 治理 + 架构边界抽离串累计落地;v0.15.0 release tag 仍指向 `089499d` = PR #163 handoff squash commit,2026-05-22 核对) |
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

> **下一步建议**:Governance-1A 已于 2026-05-21 落地为 PR #165(文档权威源收口 + 过程档案归档 + CLAUDE.md 转发化 + `api-surface-policy.md` 新增);之后陆续合入 PR-1 ~ PR-6(#204-#209 docs 治理压缩)+ #210(AGENTS.md 压缩与死链修)+ attendances / activities / activity-registrations / attachments 的 characterization tests + state machine / audit recorder 抽离串(沿 [`architecture-boundary.md`](architecture-boundary.md))。**P1-A 决策锁已落地**(沿 [`api-surface-policy.md §5-§8`](api-surface-policy.md));**P1-B characterization tests 4 个 god-service(attendances / activities / activity-registrations / attachments)已覆盖**;**P1-C Mixed Controller 物理拆分仍未启动**(第一优先目标 [`users.controller.ts`](../src/modules/users/users.controller.ts) 三个 `/me*` 端点迁出未做,沿 [`api-surface-policy.md §7 P1-C`](api-surface-policy.md));**Phase 1B path alias**(`/api/auth/v1/*` + `/api/public/v1/*`)**继续暂缓**(沿 [`api-surface-policy.md §7 P1-D`](api-surface-policy.md))。

---

## 2. 当前系统已具备能力

> 仅做"清单级"罗列,字段 / 接口 / 错误码细节请回到 [`docs/v2-api-contract.md`](v2-api-contract.md) 与 [`CHANGELOG.md`](../CHANGELOG.md)。

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
- **V2.x C-7 attachments**:多态附件主模块(`@unique` key 已加)+ 配置三表(type / mime / size)+ 业务级 `rbac.can()` 首批接入(目前唯一)
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
  - E2E spec 总数自 v0.14.0 的 55 spec 增至 **63 spec**(Phase 2 新增 **8 个 App API e2e spec**:`app-me` / `app-me-password` / `app-activities-available` / `app-activities-detail` / `app-my-registrations-read` / `app-my-registrations-write` / `app-my-attendance-records` / `app-my-certificates`)
  - Contract OpenAPI snapshot 已覆盖 **15 个 `/api/app/v1/*` 端点**(沿 [`test/contract/openapi.contract-spec.ts`](../test/contract/openapi.contract-spec.ts) `EXPECTED_ROUTES`)
  - `ci.yml` 全套 + `docker-smoke.yml` 真实启动回归继续生效,env 锁定值与 v0.14.0 一致(`JWT_EXPIRES_IN=15m` + `JWT_REFRESH_EXPIRES_IN=90d`)

---

## 2.1 当前 API surface 状态

> 详细 surface 长期边界与新增 / 迁移规则见 [`api-surface-policy.md`](api-surface-policy.md)。

| Surface | 路径前缀 | 状态 | 新增能力策略 |
|---|---|---|---|
| **Mobile App** | `/api/app/v1/*` | 新增唯一入口 | 新移动端 endpoint **只能**落在此 surface;DTO 必须独立定义于 `dto/app/`,禁止派生 Admin DTO |
| **Admin Legacy** | `/api/v2/*` | 长期保留,不强制迁移 | 新 PC 管理后台 endpoint 默认落在此 surface;**不**强制为已有 v2 endpoint 添加版本别名 |
| **Root Legacy** | `/api/auth/*` / `/api/users/*` / `/api/health/*` | 兼容入口长期保留 | 仅维护 v1 / P0-D / P0-E 已锁定行为;**不**扩展新字段;**不**新增 Mobile-only 方法到此 controller |
| **Public / Auth path alias** | (与 Root Legacy 重合,无独立前缀) | Phase 1B 暂缓 | `/api/auth/v1/*` + `/api/public/v1/*` **不**启动 |

**铁律**:
- ❌ **不再新增 Mixed Controller**(class-level `@ApiTags('Admin - X')` + 方法级追加 `Mobile - X`);现存 6 处作为存量保留(沿 [`api-surface-policy.md §5.1`](api-surface-policy.md):`users` / `attendances` / `activity-registrations` / `attachments` / `permissions/rbac` 5 处为 surface Mixed;`dictionaries.controller.ts` 经 P1-A 修正为**非 surface Mixed**,仅同 surface 同文件双 class,作为文件结构问题保留)
- ❌ 旧 mobile-like endpoint(`/api/users/me/*`)**只维护兼容、不扩展**;新移动端能力进 `/api/app/v1/*`
- ❌ App API **永远不返回** L3 字段(`passwordHash` / `refreshToken` / `tokenHash` / `secretKey*` / `secretId*` / 完整 signed URL)

---

## 3. 当前明确未做 / 暂不启动

> 这些事项**不**由 AI 自行启动,需要用户拍板。

- **不**自动启动 Slow-3(ADMIN 内置角色 / ADMIN 默认附件权限边界)— 等业务方对"业务管理员边界"补充澄清
- **不**自动启动 Slow-4(14 RBAC CRUD + 79 V2 接口全面接入 `rbac.can()`)— 强依赖 Slow-3 决议
- **不**自动启动 Slow-5(B8 入队同意书正文 / Q8 退队清理 N 值)— 等业务方提供
- **不**自动启动 Slow-7(uploadToken 重放黑名单 / 失败回滚 Provider 文件 / test-connection / multipart / STS / 跨 Provider 迁移)— 等真实使用反馈
- **不**自动启动 L-3(Storage Settings 配置变更 audit_logs)— 等用户授权
- **不**自动启动 `events` / `event_participants` / `member_profiles 扩展敏感字段` 等延后模型(沿 [`docs/V2红线与复活路径.md §4.3`](V2红线与复活路径.md))
- **不**自动引入 LLM / vector / Redis / queue / cron(沿 [ARCHITECTURE.md §9](../ARCHITECTURE.md) 升级路径)
- **不**自动启动新 schema / migration / Permission seed / Role 扩展(A-3 / A-4 红线)
- **不**自动接入运维侧真实 COS(bucket / IAM / CORS / lifecycle / SSE-COS / 真实凭证录入)— 由队组织运维侧执行,系统侧 SOP 见 [`docs/ops/cos-production-rollout-checklist.md`](ops/cos-production-rollout-checklist.md)
- **不**自动回改历史 handoff(沿 [`docs/V2红线与复活路径.md §5.1`](V2红线与复活路径.md))
- **不**把历史评审稿([`docs/archive/batches/`](archive/batches/) / [`docs/archive/reviews/`](archive/reviews/))当作"当前事实"— 它们是各批次冻结时刻的决策依据
- **不**自动启动 **Phase 1B path alias**(`/api/auth/v1/*` + `/api/public/v1/*`)— Governance-1A 已完成,Phase 1B 仍暂缓等业务方 / 运维侧拍板
- **不**自动启动 Mixed Controller 物理拆分(`users.controller.ts` `/me` 三端点拆出到独立 Mobile Controller)— 走独立立项
- **不**自动拆分 `attendances.service.ts`(1413 行)/ `attachments.service.ts`(885 行)/ `activity-registrations.service.ts`(808 行)等 god-service — 拆前**必须先补 characterization tests**
- **不**自动引入 repository / `*.repository.ts` 抽象层 — service 直连 Prisma 沿用
- **不**自动改 controller path / 不动 `/api/v2/*` / 不改 OpenAPI snapshot

---

## 4. 当前最大风险 / 债务

| 等级 | 债务 | 处理建议 |
|---|---|---|
| P0 | 缺少"当前状态入口" | ✅ 本文件已建立;后续每次 release / handoff 合入后必须回填 |
| P0 | handoff 同时承担"历史快照"与"当前事实",内部前后不一致(`v0.12.0` handoff §0 已打 tag、§6/§10/§11 仍写"未打") | handoff 一律视为**历史快照,合入后不回改**;当前事实以本文件为准 |
| P0 | 权限体系双轨并存(Guard `@Roles(...)` + Service `rbac.can()`);P0-F 之后**管理面已收紧**(rbac / config / users / audit-logs 4 PR 接入 `rbac.can()`,#132 / #134 / #136 / #138 / #140);**业务模块**(attachments 之外)RBAC 全面接入仍归 Slow-4 范围 | 管理面收紧已完成;业务面等用户拍板 Slow-3 后再启动 Slow-4 |
| P0 | release 后 docs 回填无明确 checklist | 已沉淀进 [`docs/process.md §5`](process.md) |
| P0 | `FINAL_REPORT.md` 在根目录顶层但内容是 v0.1.3 时代 | ✅ 已于 2026-05-21 治理收口 PR 迁至 [`archive/legacy/FINAL_REPORT.md`](archive/legacy/FINAL_REPORT.md) |
| P0 | 第一版前端联调包待齐备 | ✅ P0-A 起步包(#110)+ ✅ P0-G BizCode 翻译表(#111)+ ✅ P0-C bootstrap SOP(#113)+ ✅ P0-D 本人自助改密(#115 / #116 / #117 / #118)+ ✅ P0-B 测试 COS 闭环验收(#125)+ ✅ P0-E refresh token / logout / logout-all(#126 / #127 / #128)+ ✅ P0-F RBAC 收紧 4 PR(#132 ~ #140)全部落地;**v0.15.0 release 收口已完成**(#162 bump + #163 handoff + tag `v0.15.0` 指向 `089499d` + GitHub Release Latest 已发布 2026-05-20T17:07:09Z;v0.15.0 入口刷新由本 PR 完成);v0.14.0 release 收口在前已完成(2026-05-17T19:16:06Z);v0.13.0 release 收口在前已完成(2026-05-17);**仍待立项**:P0-H 部署演练 / P0-I 排错 SOP;运营 / 运维侧 SOP 执行仍待运维侧;**状态**:Governance-1A 已落地(PR #165 squash commit `23362e8`,2026-05-21);残留文档瑕疵进入 follow-up |
| P1 | docs/ 体系庞大(根 6 大文档 + docs/ 50+ 文件) | ✅ 2026-05-21 治理收口 PR 已将 49 份历史 handoff / 评审稿 / 批次 / first-release 过程档案 / FINAL_REPORT 迁至 [`archive/`](archive/);✅ PR-4(2026-05-22)将 `srvf-foundation-research.md` / `srvf-foundation-data-model-draft.md` / `srvf-foundation-interview-brief.md` 3 个 V2 设计期产物归档至 [`archive/plans/v2-design-phase/`](archive/plans/v2-design-phase/) |
| P1 | `docs/V2红线与复活路径.md` 顶部"基线版本 v0.7.0"严重滞后于实际 v0.12.0 | 改为滚动维护或明示最后核对版本 |
| P1 | `TASKS.md` 单文件 1742 行,V1.1 历史与 V2.x 当前混排 | 已加范围说明,长期可拆 |
| P2 | `attendances.service.ts` 1413 行(单文件) | **拆前必须先补 characterization tests**;后续按 StateMachine / Policy / Calculator 边界评估拆分,本期不动 |
| P2 | `attachments.service.ts` 885 行 / `activity-registrations.service.ts` 808 行 / `activities.service.ts` 656 行 | 核心 service 缺 `*.service.spec.ts` 单测;建议先补 service spec,再做任何重构 |
| P2 | service 单测偏少(`src/` 内仅 14 个 `*.spec.ts` / 196 个源文件 ≈ 7%) | E2E 63 spec 覆盖回归,但单元层缺位;建议为 god-service 优先补 spec |
| P2 | Mixed Controller 存量(`users.controller.ts` `/me` 三端点 / `activity-registrations.controller.ts` 同文件双 `@Controller` / `dictionaries.controller.ts` 同文件双 `@Controller`) | 仅兼容,不再新增;物理拆分走独立立项 |
| P2 | Contract snapshot 单文件 958 KB,review 困难 | 接受;PR review 时用 diff 工具看 |
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
