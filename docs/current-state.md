# SRVF API 当前状态入口

> 本文件是 AI / Claude Code / 维护者进入仓库后的**第一入口**。
> 本文件只记录"当前状态",历史过程请看 [`docs/handoff/`](handoff/) 与 [`CHANGELOG.md`](../CHANGELOG.md)。
> 每次 release / handoff / release 后回填后,**必须**优先更新本文件。冲突时本文件代表"当前事实",架构铁律仍以 [`ARCHITECTURE.md`](../ARCHITECTURE.md) 为准。

---

## 1. 当前版本状态

| 项 | 当前值 |
|---|---|
| 当前版本 | **v0.14.0**(P0-E refresh token / logout / logout-all 完整闭环;release 收口已完成 2026-05-17T19:16:06Z);**v0.14.0 之后 main 已累计 P0-F RBAC 收紧、Phase 1A Swagger Tag 重命名、App API Phase 2 P2-0 ~ P2-7;尚未发 v0.15.0** |
| `package.json#version` | `0.14.0`(v0.14.0 之后未 bump) |
| Swagger `setVersion(...)` | `0.14.0`(v0.14.0 之后未 bump) |
| 最新 git tag | `v0.14.0`(2026-05-17T19:16:06Z;指向 `72763f5` = PR #130 handoff squash commit) |
| GitHub Latest Release | `v0.14.0`(标 Latest;publishedAt 2026-05-17T19:16:06Z;Notes 自 `CHANGELOG.md ## v0.14.0 - 2026-05-18` 段抽取) |
| `main` HEAD | **`a327c7b`** `feat(app): add App my-certificates endpoint (P2-7) (#160)`(App API Phase 2 P2-7 落地,2026-05-20) |
| open PR | **0**(本 P2-8 docs-only PR 合并后) |
| 工作树状态 | clean |
| 最新 handoff | [`docs/handoff/v0.14.0.md`](handoff/v0.14.0.md)(v0.14.0 历史快照,不回改;v0.14.0 之后无 release,无新 handoff) |
| Unreleased 累计 | **非空**:P0-F RBAC 收紧 4 PR(#132 / #134 / #136 / #138 / #140;含 #133 / #135 / #137 / #139 评审稿)+ Phase 0/1 边界评审稿(#141)+ Phase 1A Swagger Tag 重命名(#142)+ App API Phase 2 完整 9-PR 串 P2-0 ~ P2-7(#143 ~ #160);**等 P2-8 docs-only 合入后** Unreleased 完成回填,**仍不打 v0.15.0**(本 PR 不到 release 节奏)|

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

---

## 2. 当前系统已具备能力

> 仅做"清单级"罗列,字段 / 接口 / 错误码细节请回到 [`docs/v2-api-contract.md`](v2-api-contract.md) 与 [`CHANGELOG.md`](../CHANGELOG.md)。

- **v1 基础能力**:NestJS + Prisma + PostgreSQL + JWT 登录 + 三层 `Role` + 用户 CRUD + 软删除 + 统一返回格式 + Swagger 100%(沿 [ARCHITECTURE.md §1-§10](../ARCHITECTURE.md))
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
- **v0.14.0 之后 Unreleased 累计能力**(尚未发 v0.15.0):
  - **P0-F RBAC 收紧 4 PR**(评审稿 + 实施):管理面(`rbac/*` 接入 `rbac.can()`,#132)/ 配置面(`config/*` PR-2 + PR-2A + PR-2B,#133 / #134 / #135 / #136)/ 用户管理面(`users/*` 接入 `rbac.can()`,#137 / #138)/ 审计日志面(`audit-logs/*` 接入,#139 / #140);完成"Guard `@Roles(...)` + Service `rbac.can()`" 双轨在管理面的统一收紧
  - **Phase 0/1 客户端边界评审 + Phase 1A Swagger Tag 重命名**(#141 评审 / #142 重命名):Swagger Tag 向 `surface-module` 分类体系收敛(App / Admin / System / Public 4 surface × module);**0 endpoint 变更**(仅 `@ApiTags` 重命名);Phase 1B path alias `/api/auth/v1/*` + `/api/public/v1/*` **本期未启动**
  - **App API Phase 2 完整 9-PR 串 P2-0 ~ P2-7 全部合入**(#143 ~ #160;沿 [`docs/app-api-phase-2-review.md`](app-api-phase-2-review.md)):**15 个新 endpoint** 全部落地,5 个新 Controller(均以 `@Controller('app/v1/...')` 前缀,沿 [Phase 0.5 §10.2 D-4](app-permission-boundary-review.md) `/me/*` 与 `/my/*` 物理分离):
    - **身份 / 账号 / 能力**(P2-1):`GET /api/app/v1/me` / `GET /api/app/v1/me/account` / `GET /api/app/v1/me/capabilities`(暴露 product-level capability 而非 raw RBAC permission code,沿 D-5.3)
    - **个人资料**(P2-2):`GET /api/app/v1/me/profile` / `PATCH /api/app/v1/me/profile`(白名单严格 2 字段 `nickname` + `avatarKey`;身份证号默认掩码后 4 位)
    - **本人改密**(P2-3):`PUT /api/app/v1/me/password`(继承 P0-D / P0-E 全套铁律:`@PasswordChangeThrottle()` / 10005 / 10006 / 联动撤 refresh / audit `password.change.self`)
    - **活动**(P2-4):`GET /api/app/v1/activities/available`(可参加列表)/ `GET /api/app/v1/activities/{id}`(App 视角详情 DTO)
    - **本人报名**(P2-5):`GET /api/app/v1/my/registrations` / `GET /api/app/v1/my/registrations/{id}` / `GET /api/app/v1/my/activities`(P2-5a 只读)+ `POST /api/app/v1/my/registrations` / `PATCH /api/app/v1/my/registrations/{id}/cancel`(P2-5b 写)
    - **本人考勤**(P2-6):`GET /api/app/v1/my/attendance-records`
    - **本人证书**(P2-7):`GET /api/app/v1/my/certificates`
  - **App API DTO 严格 Mobile 隔离**:Phase 2 全部 DTO 均新建 `dto/app/` 子目录承载(沿 [Phase 0.7 §2.2](code-architecture-boundary-review.md) / [Phase 0.6 §6.1](data-access-lifecycle-boundary-review.md));**禁止** `extends` / `Pick` / `Omit` / `IntersectionType` / `PartialType` / `OmitType` 一个 Admin DTO 构造 App DTO;App API where 子句永远用 `currentUser.memberId` 锁定本人(`scope = self`);**永不返回 L3 字段**(`passwordHash` / `refreshToken` / `tokenHash` / `secretKey*` / `secretId*` / 完整 signed URL)
  - **App API 准入语义**(沿 [`docs/app-permission-boundary-review.md §10.2`](app-permission-boundary-review.md) D-5):仅 `User.memberId != null && User.status=ACTIVE && User.deletedAt IS NULL && Member.status=ACTIVE` 的正式队员可用 App;候选 / 临时编号志愿者本期**不**支持;Admin 兼队员走 linked-member self perspective,**不**扩大字段可见性
- **测试与契约**:
  - Unit / E2E 实数以最近 main 合入 PR(#160)CI 记录为准,本 P2-8 docs-only PR **未重跑**
  - E2E spec 总数自 v0.14.0 的 55 spec 增至 **63 spec**(Phase 2 新增 **8 个 App API e2e spec**:`app-me` / `app-me-password` / `app-activities-available` / `app-activities-detail` / `app-my-registrations-read` / `app-my-registrations-write` / `app-my-attendance-records` / `app-my-certificates`)
  - Contract OpenAPI snapshot 已覆盖 **15 个 `/api/app/v1/*` 端点**(沿 [`test/contract/openapi.contract-spec.ts`](../test/contract/openapi.contract-spec.ts) `EXPECTED_ROUTES`)
  - `ci.yml` 全套 + `docker-smoke.yml` 真实启动回归继续生效,env 锁定值与 v0.14.0 一致(`JWT_EXPIRES_IN=15m` + `JWT_REFRESH_EXPIRES_IN=90d`)

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
- **不**把历史评审稿(`docs/批次*.md`)当作"当前事实"— 它们是各批次冻结时刻的决策依据

---

## 4. 当前最大风险 / 债务

| 等级 | 债务 | 处理建议 |
|---|---|---|
| P0 | 缺少"当前状态入口" | ✅ 本文件已建立;后续每次 release / handoff 合入后必须回填 |
| P0 | handoff 同时承担"历史快照"与"当前事实",内部前后不一致(`v0.12.0` handoff §0 已打 tag、§6/§10/§11 仍写"未打") | handoff 一律视为**历史快照,合入后不回改**;当前事实以本文件为准 |
| P0 | 权限体系双轨并存(Guard `@Roles(...)` + Service `rbac.can()`);P0-F 之后**管理面已收紧**(rbac / config / users / audit-logs 4 PR 接入 `rbac.can()`,#132 / #134 / #136 / #138 / #140);**业务模块**(attachments 之外)RBAC 全面接入仍归 Slow-4 范围 | 管理面收紧已完成;业务面等用户拍板 Slow-3 后再启动 Slow-4 |
| P0 | release 后 docs 回填无明确 checklist | 已沉淀进 [`docs/process.md §5`](process.md) |
| P0 | `FINAL_REPORT.md` 在根目录顶层但内容是 v0.1.3 时代 | 后续单独 docs PR 加段头或归档,**本 PR 不动** |
| P0 | 第一版前端联调包待齐备 | ✅ P0-A 起步包(#110)+ ✅ P0-G BizCode 翻译表(#111)+ ✅ P0-C bootstrap SOP(#113)+ ✅ P0-D 本人自助改密(评审稿 #115 / 铁律修订 #116 / 代码实现 #117 / 状态回填 #118)+ ✅ P0-B 测试 COS 闭环验收(#125)+ ✅ **P0-E refresh token / logout / logout-all**(评审稿 + 铁律解锁 + 2 hotfix #126 / 代码实现 #127 / 状态回填 #128)+ ✅ **P0-F RBAC 收紧 4 PR**(#132 / #134 / #136 / #138 / #140;含 #133 / #135 / #137 / #139 评审稿;管理面 / 配置面 / 用户管理面 / 审计日志面全部接入 `rbac.can()`)全部落地;**v0.14.0 release 收口已完成**(#129 bump + #130 handoff + tag `v0.14.0` 指向 `72763f5` + GitHub Release Latest 已发布,2026-05-17T19:16:06Z);v0.13.0 release 收口在前已完成(#119 CHANGELOG + #120 bump + #121 handoff + tag/Release 已发布,2026-05-17);**仍待立项**:P0-H 部署演练(prod COS bucket / IAM / 真实凭证)/ P0-I 排错 SOP;运营 / 运维侧 SOP 执行(字典 items 录入 + 三张附件配置表 + 测试账号矩阵创建)仍待运维侧 |
| P1 | docs/ 体系庞大(根 6 大文档 + docs/ 30+ 文件) | 长期逐步归档(`docs/v1.3-plan.md` / `v1.4-prisma7-evaluation.md` / `srvf-foundation-data-model-draft.md` 等老草案) |
| P1 | `docs/V2红线与复活路径.md` 顶部"基线版本 v0.7.0"严重滞后于实际 v0.12.0 | 改为滚动维护或明示最后核对版本 |
| P1 | `TASKS.md` 单文件 1742 行,V1.1 历史与 V2.x 当前混排 | 已加范围说明,长期可拆 |
| P2 | `attendances.service.ts` 1413 行(单文件) | 后续功能变更前评估拆分,本期不动 |
| P2 | Contract snapshot 单文件 958 KB,review 困难 | 接受;PR review 时用 diff 工具看 |
| P3 | `common/storage/` 已承载完整 module + controller(超出原 "common = 跨模块基础设施" 语义) | 长期可迁到 `src/modules/storage/`;本期不动 |

---

## 5. 新任务开工前必须检查

> **门禁**:任何一项不满足,**不开新功能**,先与维护者对齐。

- [ ] `git status --short` 工作树 clean
- [ ] `git branch --show-current` 在期望分支(`main` 或 `claude/*` worktree)
- [ ] `gh pr list --state open` 输出为空(open PR = 0)
- [ ] `package.json#version` 与 Swagger `setVersion(...)` 与最新 tag 三方一致
- [ ] 最新 [`docs/handoff/`](handoff/) 文件存在,且本文件 §1 表已反映该 release
- [ ] [`CHANGELOG.md`](../CHANGELOG.md) `## Unreleased` 段不残留与上次 release 重复的未释放变更
- [ ] 本次任务是否涉及 **D 档**(schema / migration / 权限 / 安全 / 存储 / audit / 不可逆变更);若是,先按 [`docs/process.md §4`](process.md) 降速
- [ ] 本次任务是否需要用户拍板(C / D / E 档);若是,先回到对话等用户确认,**不动代码**

详细流程见 [`docs/process.md §2`](process.md)。

---

## 6. 文档阅读顺序

> 不要一次读完所有文档。按"最少必要"读到能完成当前任务为止。

1. **`docs/current-state.md`**(本文件)— 当前事实
2. **用户当前任务说明** — 决定下一步动作
3. [`README.md`](../README.md) — 项目快速概览 / 路由总览 / 必读文档表
4. [`ARCHITECTURE.md`](../ARCHITECTURE.md) — v1 / V1.1 / V2 §12 完整蓝图(铁律最高优先级)
5. [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md) — AI 协作铁律(§1-§18)
6. [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) — V2 基线规范(13 项 A 档)
7. [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) — V2 五档红线(A/B/C/D/E)
8. **仅在相关时**:
   - 对应批次评审稿 `docs/批次*.md`(冻结决议)
   - 历史 handoff `docs/handoff/v*.md`(release 时刻快照;**最新入口** [`v0.14.0.md`](handoff/v0.14.0.md);上一版 [`v0.13.0.md`](handoff/v0.13.0.md))
   - 运行 SOP:[`development.md`](development.md) / [`testing.md`](testing.md) / [`deployment.md`](deployment.md) / [`security.md`](security.md) / [`ops/cos-production-rollout-checklist.md`](ops/cos-production-rollout-checklist.md)
   - 第一版联调前置 SOP:[`first-release-bootstrap-sop.md`](first-release-bootstrap-sop.md)(zero-to-login 串行清单;P0-C 落地于 #113)
   - 第一版 P0-D 评审稿:[`first-release-p0d-change-my-password-review.md`](first-release-p0d-change-my-password-review.md)(本人自助改密;v0.13.0 已按评审稿全部落地)

---

## 7. 冲突处理原则

| 维度 | 权威源 |
|---|---|
| **当前事实**(版本 / open PR / HEAD / 已发能力) | 代码、GitHub 当前状态、本文件(`docs/current-state.md`) |
| **架构铁律**(v1 §1-§16、V1.1 §17、V2 §18) | [`ARCHITECTURE.md`](../ARCHITECTURE.md) > [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md) > [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) > [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) > 单批次评审稿 |
| **历史过程**(为什么这么做) | [`docs/handoff/v*.md`](handoff/) + [`CHANGELOG.md`](../CHANGELOG.md) |
| **冻结批次决议**(D6 / D7 / Q-* 等) | 对应 `docs/批次*.md`(冻结后不回改) |

**铁律**:遇到冲突 → **不得擅自调和、不得擅自改文件**,先向用户汇报,等拍板。
