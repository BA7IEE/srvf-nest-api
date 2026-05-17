# 第一版上线前总账(first-release readiness plan)

> 本文目标:列出 srvf-nest-api 第一版上线前剩余账本,区分必须做 / 建议做 / 后置做,并给出 P0 推荐执行顺序与 PR 拆分建议。
>
> **本文是规划文档,不是技术方案,不是开发任务卡**;具体方案 / 任务卡由对应 PR 评审稿落地。
>
> 撰写依据:[`docs/current-state.md`](current-state.md)(v0.12.0 当前事实)+ 代码只读盘点结论;**不重述代码已有能力**,只在第 2 节做"清单级"对账。

---

## 1. 第一版目标定义

第一版**不是**完整的 SRVF 系统。第一版目标是:

> 队内后台 / 前端可以接入真实 API;管理员能登录、能管理基础数据、队员、活动、附件;权限不会明显失控;生产环境能部署、能排错、能持续维护。

第一版**暂不追求**:装备模块 / 数据统计 / 复杂报表 / APP 数据面板 / 事件 / 任务派遣 / 排班 / 值班 / 微信小程序登录 / 多租户 / Redis / queue / cron / LLM / 向量检索(详见第 7 节)。

判断"能不能上线"的标准:
- 管理员账号能在生产环境登录、能管理用户与基础数据
- 前端联调接口契约稳定,字段不会再大改
- 上传 / 下载链路在生产 COS 上跑通(真实凭证 + 真实 bucket)
- 关键高危接口(storage-settings / users / 权限管理)有清晰的"谁能调"约束
- 出 5xx / 上传失败 / 权限拒绝时,运维 / 维护者能定位

---

## 2. 当前已具备能力(对账)

> 本节只做清单级对账,字段 / 错误码 / 路由细节回到 [`docs/v2-api-contract.md`](v2-api-contract.md) 与 [`README.md`](../README.md) §路由总览。

| 领域 | 当前已有 | 证据 |
|---|---|---|
| 登录 / JWT | username + password 登录(memberNo 回退);防账号枚举;timing 抹平;IP 5次/60秒 内存限流 | [`auth.controller.ts`](../src/modules/auth/auth.controller.ts) / [`auth.service.ts`](../src/modules/auth/auth.service.ts) |
| 本人接口 | `GET/PATCH /api/users/me`(仅 nickname / avatarKey) | [`users.controller.ts`](../src/modules/users/users.controller.ts) |
| 用户管理 | 列表 / 详情 / 创建 / 改资料 / 重置密码 / 改角色 / 改状态 / 软删,自我保护 + 最后一个 SUPER_ADMIN 保护 | 同上 |
| 字典 | dict_types + dict_items(双表)+ 父子树形 + 软删 | `src/modules/dictionaries/` |
| 组织 | 树形 + 单根上限 + last-root 保护 + nodeTypeCode 走字典 | `src/modules/organizations/` |
| 队员 / 部门归属 | `memberNo` 全局唯一不复用 + 一人一部门 partial unique | `src/modules/members/` + `src/modules/member-departments/` |
| 队员档案 / 紧急联系人 | 1:1 子资源(敏感字段)+ N:1 子资源(priority) | `src/modules/member-profiles/` + `src/modules/emergency-contacts/` |
| 证书 / 资质 | 4 态闭集 + verify / reject / qualification-flag | `src/modules/certificates/` |
| 活动 / 报名 | 状态机 4 态 + CSV 名单导出 | `src/modules/activities/` + `src/modules/activity-registrations/` |
| 考勤 | 双 model + 5 态闭集 + 终审 + previousSnapshot + 时间不重叠 | `src/modules/attendances/` |
| ContributionRule | D14 预填规则;无 CRUD,无流水表 | `src/modules/contribution-rules/` |
| audit_logs | 写入即不可改不可删;17 项 AuditLogEvent 已接入业务写路径 | `src/modules/audit-logs/` |
| RBAC 基础 | 4 表 + `RbacService.can()` + 14 条权限点 + ops-admin 内置角色 + bootstrap user_role | `src/modules/permissions/` |
| attachments 元数据 | 5 端点 + `@unique(key)` + 3 个配置表(type/mime/size) | `src/modules/attachments/` + `src/modules/attachment-configs/` |
| Storage Provider | LocalProvider + CosProvider + 动态 Router + AES-256-GCM 凭证加密 + production fail-fast | [`src/common/storage/`](../src/common/storage/) |
| Storage Settings | singleton + admin API(GET/PATCH/reset-credentials) | `storage-settings.controller.ts` |
| 健康检查 | `/api/health` / `/health/live` / `/health/ready`(DB 连通) | `src/modules/health/` |
| 工程基建 | nestjs-pino 结构化日志 + 请求 ID + helmet + 优雅关闭 + 启动强校验 | [`docs/deployment.md`](deployment.md) |
| CI / 容器 | GitHub Actions + Dockerfile 多阶段 + docker-smoke | `.github/workflows/` + `Dockerfile` |
| 测试 | Unit 13 spec / Contract zero drift / E2E 51 spec | [`docs/testing.md`](testing.md) |
| COS 上线运维清单 | bucket / IAM / CORS / lifecycle / SSE / Storage Settings 初始化 / 闭环验收 SOP | [`docs/ops/cos-production-rollout-checklist.md`](ops/cos-production-rollout-checklist.md) |

**关键现状判断**(决定后续优先级):

- 双轨权限并存:**只有 attachments 一个业务模块真正接入 `rbac.can()`**,其余 18 个业务模块仍走 `@Roles(Role.SUPER_ADMIN, Role.ADMIN)`(沿 [`docs/current-state.md §4`](current-state.md))
- 没有 refresh token / logout;**本人改密接口 `PUT /api/users/me/password` 已落地于 #117**(沿 [`security.md` 已落地策略表](security.md) + [P0-D 评审稿](first-release-p0d-change-my-password-review.md))
- 上传 / 下载代码全栈就绪,但**真实 COS 生产链路未做端到端验收**(代码 + 运维清单都有,缺执行)
- v1 14 接口契约 zero drift,V2 86 接口 contract snapshot 也 zero drift;前端可对接的契约面是稳定的

---

## 3. 第一版剩余账本

### 3.1 P0 — 必须做(不做就不能稳定上线)

#### P0-A 第一版前端联调范围清单

**为什么是 P0**:当前约 100+ 个接口已稳定,但"第一版前端到底接哪些接口"没有明文。前端不可能一开始全部接;先定一个最小闭环。

**内容**:
- 前端"第一版要接的接口清单"(预计 30-50 个,而非全量)
- 哪些字段确认稳定 / 哪些字段"用着可能调"
- 上传流程图(upload-url → 前端直传 → confirm-upload → 取 accessUrl)
- 不在第一版接的接口列表(给前端"看着也别接")

**直接开发?**:**docs-only**。本文档可以由 AI 主导起草,前端 review。

#### P0-B 真实文件上传 / 下载闭环验收 ✅(测试 bucket)

**状态**:测试 COS bucket(`ap-guangzhou`)5 步闭环验收 **2026-05-17 已通过**(沿 [`handoff/v0.13.0.md §5.5`](handoff/v0.13.0.md));未发现需要修改代码的问题;代码层 attachments / storage / Provider / audit / 信息泄漏防御全部符合 v0.13.0 评审稿;**代码层附件链路可进入第一版前端联调**。**生产 bucket 验收**(独立凭证 / bucket / `STORAGE_ENCRYPTION_KEY` + ops SOP §1-§9 全套)归 **P0-H 部署演练** 范畴,**仍待执行**;本次**不**视为 P0-H 完成。

**为什么是 P0**(保留作为档案):代码 + 运维清单都有,但**没人在真实生产 COS 上跑过端到端**。前端联调的第一个"卡点"很可能就是上传失败找不到原因。

**内容**:
- 按 [`docs/ops/cos-production-rollout-checklist.md §9`](ops/cos-production-rollout-checklist.md) 在真实生产 COS bucket 跑一次小文件端到端
- 验收 5 步:upload-url → PUT → confirm-upload → accessUrl 真实下载 → DELETE
- 验收过程中**可能**发现:CORS 配错 / signed URL header 漂移 / MIME 白名单缺值 / size 配置过小 / ownerType 配置遗漏 / Provider 启动顺序问题
- 验收发现的问题**才**开代码 PR;**不要预先改代码**

**直接开发?**:**先 Ops 演练,后开 PR**。运维清单已经在仓库里,只欠真实环境跑一次。

#### P0-C 初始化配置 / bootstrap SOP ✅

**状态**:已由 PR #113 落地为 [`docs/first-release-bootstrap-sop.md`](first-release-bootstrap-sop.md)(2026-05-17;702 行,docs-only;覆盖 dev / staging / prod 三档环境前置 / 数据库初始化 / seed 落地内容 / RBAC 初始状态 / 14 个字典 type 清单 / 组织树初始 / 附件配置初始 / 测试账号矩阵创建路径 / 前端联调前置检查 / 5 分钟 dry-run / 13 行失败排查表)。

**为什么是 P0**:当前 `README.md` 只写了本地起服务,生产环境从空数据库到"队员能登录"需要的步骤分散在 7 个文档里。换一个人来部署一定会卡。

**内容**:
- 一份"从零到第一个真实账号能登录"的串行 SOP,合并 `.env` / migrate / seed / Storage Settings / reset-credentials / 测试账号 / CORS / 域名 / 反向代理这些散点
- 至少给出:dev / staging / prod 三个环境各自的最小动作清单
- 显式列出哪些 env 是"装机一次性"(JWT_SECRET / STORAGE_ENCRYPTION_KEY)、哪些是"会变"(CORS / DATABASE_URL)
- 字典 type 必须先建的清单;具体业务取值由业务方线下确认,禁止 AI 编造。
- 测试账号矩阵:SUPER_ADMIN / ADMIN / 普通队员 / 带 member 角色用户至少各 1 个。

**直接开发?**:**docs-only**。可能引用现有 [`deployment.md`](deployment.md) / [`security.md`](security.md) / [`ops/cos-production-rollout-checklist.md`](ops/cos-production-rollout-checklist.md),做"导航 + 串行清单"层。

#### P0-D 账号安全:修改密码 ✅

**状态**:已由 #115 评审稿 + #116 铁律修订(`CLAUDE.md` / `AGENTS.md` §1 + §9 + §11 + §17.3)+ #117 代码实现(`PUT /api/users/me/password` + `ChangeMyPasswordDto` + `OLD_PASSWORD_INVALID=10005` / `NEW_PASSWORD_SAME_AS_OLD=10006` + `@PasswordChangeThrottle` 独立 throttler + `password.change.self` audit + 事务原子写)落地;严格按 [P0-D 评审稿 §5 / §7](first-release-p0d-change-my-password-review.md) 全部覆盖。

**为什么是 P0**(保留作为档案):第一版上线前**没有任何"改密码"接口**(包括管理员和本人)。管理员能"重置他人密码"但不能"改自己的密码"。第一版上线后:
- 默认 super admin 密码 `ChangeMe123456` 必须能改
- 真实管理员账号要能改密码而不依赖数据库直改
- 普通用户(未来)有自助改密诉求

**关键判断**(已落实):
- 第一版补了 **`PUT /api/users/me/password`**(本人改密码,需 oldPassword;沿 P0-D 评审稿)
- "首次登录强制改密"作为单独功能 → **仍归 P1**(需 schema 字段与登录流程改造)
- 改密后是否吊销旧 token? → **仍不吊销**,与管理员重置一致;tokenVersion / refresh token / token revoke 仍归 **P0-E** 统一处理

**仍不做**(沿评审稿 §4):忘记密码 / 邮箱找回(归 P2)/ refresh token / tokenVersion / 主动吊销旧 token / user-member 绑定能力(归 P0-E / P1 / P2 / 另立项)。

#### P0-E refresh token / logout / 登录续期策略 ✅

**状态**:已由 P0-E 评审稿 v1(#126)+ CLAUDE.md / AGENTS.md 铁律解锁(同 #126 合并)+ 代码实现 PR #127(squash merge commit `25f03fb`,2026-05-18)落地;严格按 [P0-E 评审稿 v1 §3-§9](first-release-p0e-refresh-token-review.md) 9 条已决策实施。

**已落地内容**:
- **新增 3 个 API 端点**:`POST /api/auth/refresh`(rotation always + family revoke + absolute expiration)/ `POST /api/auth/logout`(幂等;只撤销当前 row)/ `POST /api/auth/logout-all`(撤销该 user 全部未过期未撤销 refresh,返 `{ revokedCount }`)
- **扩展 `POST /api/auth/login`**:`LoginResponseDto` 新增 `refreshToken` + `refreshExpiresAt`(字段集恰好 5 项;`LoginDto` 入参 schema 严格 zero drift)
- **TTL 锁定**:`JWT_EXPIRES_IN=15m`(由原 7d 收敛)/ `JWT_REFRESH_EXPIRES_IN=90d`(family **absolute expiration**;rotation 后新 refresh token 继承同一 `refreshExpiresAt` 不延长;**禁止** sliding expiration;达到时刻后必须重新登录)
- **新增 schema**:`refresh_tokens` 表(`tokenHash @unique` 只存 sha256 hash,明文绝不入库;migration `20260517165220_add_refresh_tokens`)
- **联动撤销 4 场景**(同事务原子):本人改密 `self-password-change` / 管理员重置 `admin-password-reset`(顺手补 audit `password.reset.by-admin`)/ 用户禁用 `admin-disable` / 用户软删 `admin-delete`
- **access token 仍不主动吊销**(沿 D-4):依赖 15m TTL 自然过期 + `JwtStrategy.validate` 每请求查库阻断 DISABLED / 软删 user;e2e §7.5 反向锁定断言(改密后旧 access 仍可调 `/me`)保留
- **JWT payload 严格 zero drift**:仍 `{ sub, username }`;**不**做 `tokenVersion`(沿 D-4)
- **新增 1 BizCode**:`REFRESH_TOKEN_INVALID = 10007`(HTTP 401;**不**拆 EXPIRED/REVOKED/REPLAY)
- **新增 5 audit event**:`auth.login` / `auth.refresh` / `auth.logout` / `auth.logout-all` / `password.reset.by-admin`
- **新增独立 throttler** `refresh`(30/60 IP;与 `default` / `password-change` 物理隔离)

**仍不做**(沿 P0-E v1 D-9):`tokenVersion` 字段 / access token blacklist / refresh_tokens 查询接口 / 已登录设备列表 UI / 单设备管理 / device fingerprint / Redis / Queue / Cron / 完整 OAuth tree / httpOnly cookie / 改 `LoginDto` 入参 / 微信小程序 OAuth。

**为什么 refresh TTL 90d**(沿评审稿 §3.5 D-5):本系统是深圳救援队内部管理系统,使用频次比公网 SaaS 低,30d 会让低频用户(月度 / 季度参与活动的志愿队员)频繁触发 absolute expiration 误以为账号失效;90d 把"必须重登"周期对齐到季度心智;**仍坚守** absolute expiration(沿 OWASP)+ rotation always + family revoke + 联动撤销四防线。

#### P0-F 关键业务接口权限最小闭环

**为什么是 P0**:当前**只有 attachments 一个模块接入 rbac.can()**,其余 18 个业务模块走 `@Roles(Role.SUPER_ADMIN, Role.ADMIN)`(沿 [`current-state.md §4`](current-state.md))。第一版上线时:
- `storage-settings` 三个端点目前是 `SUPER_ADMIN, ADMIN`;但凭证录入应该是 SUPER_ADMIN-only?
- `audit-logs` 是否对 ADMIN 完全可读?
- `members` / `member-profiles` / `emergency-contacts` 涉敏数据是否对所有 ADMIN 开放?

**关键判断**:
- 第一版**不做**全量 RBAC 接入(那是 Slow-4,79 接口工作量);
- 但**必须**对几个明显高危的端点做"权限收紧"评审:storage-settings 凭证 / 14 个 RBAC CRUD / audit_logs / 敏感字段读
- 如果业务上 "ADMIN 边界"还没定义清楚([`current-state.md §3`](current-state.md) 已经把 Slow-3 列为待用户拍板),那第一版**默认延续当前的 ADMIN 全权**,但用一份"风险公示"说明边界

**直接开发?**:**必须先 D 档评审**(评审稿:列出 18 个非 attachments 模块的当前 `@Roles` 标注 + 第一版要不要收紧 + 哪些必须收紧 + 哪些可以延后);**禁止**自行扩散接入 rbac.can()。

#### P0-G 前端 BizCode / API 契约冻结 ✅

**状态**:已由 PR #111 落地为 [`docs/first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md)(2026-05-17;P0-G 撰写时覆盖 122 条 BizCode 全量;经 P0-D PR-3 #117 新增 10005 / 10006 后,经 P0-D PR-4 同步本文为 124 条);上传 / 下载流程图沿用 [`first-release-frontend-scope.md §7`](first-release-frontend-scope.md),本 PR 不重复。

**为什么是 P0**:接口契约虽然 zero drift,但"前端要知道每个 BizCode 怎么翻"是另一回事。如果不冻结,前端会做出与后端不一致的提示。

**内容**:
- BizCode 段位说明(`4xxxx` 通用 / `100xx` users / `110xx` orgs / `120xx` certs / 等)与对前端的语义
- 错误响应统一格式说明(`{ code, message, data: null }` + HTTP status)
- 分页 / 字典 / 软删除等"前端要懂的后端约定"
- 上传 / 下载流程的契约文档(前端要看到的不是 OpenAPI,是流程图)

**直接开发?**:**docs-only**。AI 可主导,前端 review。

#### P0-H 部署演练

**为什么是 P0**:Dockerfile / docker-smoke / migration / seed / 启动强校验都有,但**没人在生产目标机器跑过一次**。第一版上线前必须演练一次。

**内容**:
- 选定生产目标(自建 VPS / K8s / 平台?)
- 完整跑一遍:镜像构建 → DB migration → seed → 起服务 → health/ready → 真实账号登录 → 调一个 V2 接口
- 演练发现的问题(网络 / 防火墙 / DNS / HTTPS / 反代 / 时区 / 日志收集)登记到 [`docs/deployment.md`](deployment.md)

**直接开发?**:**Ops 演练为主**。可能引出极小代码改动(例如启动日志输出某个字段),但不应有大改动。

#### P0-I 最小监控 / 日志 / 排错 SOP

**为什么是 P0**:nestjs-pino + requestId 已经有,但"出问题怎么查"没有 SOP。第一版上线后第一次报 500 时,如果维护者不知道去哪看,体感会很差。

**内容**:
- 出 5xx → 哪里看日志 / 怎么用 requestId 串起来
- 上传失败 → 4 类失败(MIME 黑名单 / size 超限 / Provider 凭证错 / CORS 错)各自的日志特征
- DB 失败 → migration 没跑 / 连接池 / 慢查询怎么辨别
- CORS 失败 → 域名 / 协议 / preflight 三类
- 不做 Sentry / APM(沿 [`ARCHITECTURE.md §9`](../ARCHITECTURE.md) 升级路径);第一版只靠 pino + log file

**直接开发?**:**docs-only**,可能在 [`deployment.md`](deployment.md) 加一节"排错 SOP"。

### 3.2 P1 — 建议做(不做也能试运行,但体验或运维会差)

| 事项 | 为什么 |
|---|---|
| 队员 / 用户批量导入 | 真实救援队 200+ 人,手工逐个创建几小时;但第一版可以靠"先导入 5 个核心人,后续陆续录"应付 |
| 字典初始化清单 | dictionaries 是数据底座,但 V2 设计明确"真实字典内容不进公共仓库历史"(沿 [`srvf-foundation-research.md`](srvf-foundation-research.md) §5.1 / R13)。第一版至少需要一份"哪些 dict_type 必须先建"的清单 |
| 测试账号矩阵 | super admin / admin / 普通队员各 1 个,方便前端联调切换 |
| 前端错误码翻译表 | 见 P0-G;若 P0-G 已含,本项消解 |
| 附件 ownerType / ownerId 前端使用规范 | 前端在哪种业务场景下用哪种 ownerType 容易踩坑;给一份"业务 → ownerType"对照表 |
| audit_logs 后台查询最小说明 | 已经有 audit_logs 写入,但前端要看的话需要明确"用哪个接口、看哪些字段、谁能看" |
| CORS / HTTPS / 域名最终确认 | P0-H 部署演练副产物;若 P0-H 已含,本项消解 |
| 个人资料 / 头像 / 队员绑定体验 | 当前 `users` 与 `members` 是两个独立表,前端"我是谁"的体验需要走 user → member 关联;关联接口未实现 |

### 3.3 P2 — 暂不做(后置)

| 事项 | 暂不做原因 | 何时再做 |
|---|---|---|
| 装备模块 | 不在第一版业务目标;装备登记 / 借还 / 盘点是独立子系统 | 队组织提出装备管理诉求 + 业务方案稳定后立项 |
| 数据统计 | 第一版只跑核心 CRUD;统计依赖完整数据底座 | 队员 / 活动数据沉淀 ≥ 3 个月,有真实统计诉求 |
| 复杂报表 | 同上 | 同上 |
| APP 数据面板 | 第一版不上 APP;Web 后台足够 | 队组织决定上 APP + 设计稿定稿 |
| 事件 / 任务派遣 | events / event_participants 已被 V2 设计明文延后(沿 [`V2红线与复活路径.md §4`](V2红线与复活路径.md) C-11) | 救援任务管理诉求清晰 + 通用化失败回退方案确认 |
| 排班 / 值班 | 不在 V2 第一阶段范围 | 出现具体值班场景 + 业务规则确认 |
| 复杂部门权限 | 当前 ADMIN 全权;部门部长 / 副部长细分权限 v1 / V1.1 / V2 都明文不做(沿 Slow-3 待用户拍板) | 用户拍板 Slow-3 + 启动 Slow-4 接入 79 接口 |
| Contribution 流水表 | 当前只有 ContributionRule 预填规则,无 CRUD,无流水表(沿 `contribution-rules` 模块说明) | 出现"按月对账"诉求 + 设计审计兼容方案 |
| 大屏 | 不在第一版范围 | 队组织活动展示需求 |
| 微信小程序登录 | v1 明文不做(沿 [`CLAUDE.md §1`](../CLAUDE.md))| 小程序产品立项 + OAuth 评审 |
| 多租户 | v1 明文不做 | 出现"多个救援队公用一套系统"诉求 |
| Redis / queue / cron | 沿 [`ARCHITECTURE.md §9`](../ARCHITECTURE.md) 升级路径,QPS / 队列 / 定时任务诉求出现才做 | 真实流量压力或异步任务诉求 |
| LLM / vector | v1 / V2 明文不做 | 出现具体 AI 应用场景 + 业务方拍板 |

---

## 4. P0 推荐执行顺序

| # | 名称 | 类型 | 先评审? | 建议 PR 数 | 为什么排这里 |
|---|---|---|---|---|---|
| 1 | P0-A 前端联调范围清单 ✅(#110) | Docs-only | ❌ | 1 | 没有它,后续工作都没方向;前端先看到"要接什么",才有反馈 |
| 2 | P0-G 前端 BizCode / 契约冻结 ✅(#111) | Docs-only | ❌ | 1 | 紧接 A,前端开始联调前必须有 |
| 3 | P0-B 上传下载闭环验收 ✅(测试 bucket 2026-05-17) | Ops演练 + 可能 Mixed | ❌(运维清单已就位) | 0(纯演练;本次无修复 PR) | 测试 bucket 通过(沿 [`handoff/v0.13.0.md §5.5`](handoff/v0.13.0.md));生产 bucket 验收归 P0-H |
| 4 | P0-C 初始化 / bootstrap SOP | Docs-only | ❌ | 1 | B 演练副产物可同步落到 C |
| 5 | P0-H 部署演练 | Ops演练 + 可能 Mixed | ❌ | 0(纯演练)+ ≤1 修复 PR | 同 B,执行前置;C 写好 SOP 后再演练更顺 |
| 6 | P0-I 排错 SOP | Docs-only | ❌ | 1 | H 演练副产物可同步落到 I |
| 7 | P0-D 修改密码 ✅(#115 评审稿 / #116 铁律修订 / #117 代码实现 / 本 PR 状态回填)| D档评审 → Code → Docs | ✅ | 1 评审 + 1 铁律 + 1 代码 + 1 回填(已完成)| 单点改动,影响面可控,先评审再实现;沿 [P0-D 评审稿](first-release-p0d-change-my-password-review.md) 4-PR 串行 |
| 8 | P0-E refresh token / logout ✅(#126 评审稿 + 铁律解锁 / #127 代码实现 / 本 PR 状态回填)| D档评审 → Code → Docs | ✅(已落地)| 1 评审 + 1 代码 + 1 回填(已完成)| 3 新接口 + LoginResponseDto +2 字段 + 1 新表 + 1 新 BizCode + 5 新 audit + 联动撤销 4 场景;沿 [P0-E 评审稿](first-release-p0e-refresh-token-review.md) 9 决策 |
| 9 | P0-F 权限最小闭环 | D档评审 | ✅(可能只评审不开发) | 1 评审 + (0-3) 代码 | 涉及面最广,评审可能得出"第一版默认延续 ADMIN 全权"结论;有结论再决定要不要做 |

**整体节奏建议**:
- 前 6 项可以**串行无评审推进**(全部 docs-only + 2-3 次 Ops 演练)
- 后 3 项必须**先出评审稿,等用户拍板**;评审稿不通过就不开代码 PR
- 不并发推进 D 档评审与代码 PR

---

## 5. P0 事项 PR 拆分建议

| P0 项 | 推荐 PR | 内容 | 禁止范围 | 验收标准 |
|---|---|---|---|---|
| P0-A ✅ | `docs(first-release): frontend integration scope`(#110) | 前端要接的接口清单 + 不接的列表 + 上传流程图 | 不动 src/* | ✅ 已落地(2026-05-16) |
| P0-G ✅ | `docs(first-release): bizcode mapping for frontend`(#111) | BizCode 翻译表 + 错误响应说明 + 前后端约定 | 不动 src/*;**不**新增 BizCode | ✅ 已落地(2026-05-17;P0-G 撰写时覆盖 122 条;P0-D PR-3 新增 10005 / 10006 后实数 124,P0-D PR-4 同步本文) |
| P0-B ✅(测试 bucket) | (0 PR;仅 Ops 演练)— 本次测试 bucket 验收**无代码 bug**,**无需** `fix(storage): ...` | 测试 bucket 验收记录入 [`handoff/v0.13.0.md §5.5`](handoff/v0.13.0.md);生产 bucket 验收记录留 P0-H | **演练**不动 src/*;本次确认**无修复 PR** | 5 步闭环全部 ✅(沿 ops §9.7;2026-05-17 测试 bucket 通过)|
| P0-C ✅ | `docs(first-release): add bootstrap SOP`(#113) | 从零部署到第一个账号能登录的串行 SOP — [`docs/first-release-bootstrap-sop.md`](first-release-bootstrap-sop.md) | 不动 src/* | ✅ 已落地(2026-05-17;702 行;dev/staging/prod 三档;含 14 dict_type 清单 + 测试账号矩阵路径 + 5 分钟 dry-run)|
| P0-H | (0 PR;仅 Ops 演练)+ 视情况 `docs(deployment): ...` | 部署演练记录入 [`deployment.md`](deployment.md) 附录 | **演练**不动 src/* | 真实环境从空机器到 health/ready 200 |
| P0-I | `docs(deployment): troubleshooting sop` | 5 类典型故障的排错路径 | 不动 src/* | 维护者按文档能定位 P0-B / P0-H 演练中的所有问题 |
| P0-D ✅ | (评审)`docs(review): change-my-password review`(#115)+ (铁律)`docs(p0d): allow self-service password change`(#116)+ (代码)`feat(users): add self-service password change`(#117)+ (回填)本 PR | 评审稿先冻结(密码策略 / 错误码 / 是否吊销 token / 防爆破 / 审计);铁律修订 `CLAUDE.md` / `AGENTS.md`;代码 PR 严格按评审范围实施;状态回填同步文档 | **评审 / 铁律 / 回填 PR** 不动 src/*;**代码 PR** 严格按评审范围实施;不夹带 schema 变更;不夹带 token 吊销 | ✅ 评审通过 + 代码 PR contract 零漂移(snapshot diff 仅新增,无删除) |
| P0-E ✅ | (评审 + 铁律 + hotfix)`docs(p0e): define refresh token and logout strategy`(#126)+ (代码)`feat(auth): add refresh token + logout + logout-all`(#127)+ (回填)本 PR | 评审稿 v1 9 条决策(LoginResponseDto +2 / 3 新接口 / 联动撤销 4 场景 / 不做 tokenVersion / access 15m + refresh 90d absolute / 10007 / refresh throttler / 5 audit / 不做 D-9 清单)→ 代码实施(34 文件 +2269/-88)→ 状态回填 | **评审 / 回填 PR** 不动 src/*;**代码 PR** 严格按评审范围实施 | ✅ 评审通过 + 用户拍板 + 代码 PR contract 仅新增(v1 14 路由 schema 零漂移);CI 全绿;55 e2e spec / 1291 用例 |
| P0-F | (评审)`docs(review): minimum rbac closure` + (视拍板)代码 PR | 评审稿列 18 个非 attachments 模块当前 `@Roles` + 第一版收紧建议 | **评审 PR** 不动 src/*;**禁止** AI 自行扩散 rbac.can() | 评审通过 + 用户拍板;不引发 Slow-3 / Slow-4 提前启动 |

**特别要求**:

- **refresh token**:必须标为 D 档评审先行。原因:v1 / V1.1 / V2 早期均明文不做(沿 [`security.md`](security.md) / [`v2-api-contract.md`](v2-api-contract.md) §1.3 / [`current-state.md`](current-state.md));涉及 token 存储 / revoke / logout / 前端登录流程,可能改 auth 契约。**禁止**直接开发。
- **RBAC 关键接口**:必须标为 D 档评审先行。原因:现有是 F3(Guard 入口)/ F4(Service 判权)双轨;attachments 已接 rbac.can();其它模块多为 @Roles。需要先定义第一版角色矩阵;**禁止**直接全系统接 RBAC(那是 Slow-4 79 接口工作量)。
- **上传下载闭环 ✅(测试 bucket)**:可以先做"验收文档 + curl 流程",不要先改代码。只有验收发现缺口才开代码 PR。**2026-05-17 测试 COS bucket 验收已完成,5 步闭环全部通过,无代码缺陷**(沿 [`handoff/v0.13.0.md §5.5`](handoff/v0.13.0.md));**生产 bucket 验收**待 P0-H 部署演练同步推进。
- **修改密码 ✅**:已按 P0-D 评审稿(#115)→ 铁律修订(#116)→ 代码实现(#117)→ 状态回填(本 PR)四步骤落地。涉及的密码策略、错误码(10005 / 10006)、是否吊销 token(沿用现状不吊销)、防爆破(独立 throttler `password-change` 5/60)、审计(`password.change.self`)全部按评审稿覆盖。

---

## 6. D 档事项清单

| 事项 | 为什么是 D 档 | 不能直接开发的原因 | 评审产物 |
|---|---|---|---|
| refresh token / logout | 安全 + 影响 auth 契约 + 可能改 schema | 历史明文不做;方向未定 | 评审稿:三选一对比 + schema 变更评估 + 前端配合度评估 |
| RBAC 关键业务接口最小闭环 | 影响 18 个业务模块 + 双轨切换 | 没有"第一版角色矩阵";可能引发 Slow-3 / Slow-4 提前启动 | 评审稿:18 模块现状表 + 收紧建议 + 第一版边界 |
| 修改密码 ✅(本人自助改密;首次改密策略仍归 P1)| 密码策略 + 是否吊销 token + 审计 + 防爆破 | 涉及前后端契约 + 安全策略 | ✅ 已产物:[P0-D 评审稿](first-release-p0d-change-my-password-review.md)(DTO / 错误码 / 限流 / 审计事件 / 不触发 token revoke) |
| production COS 真实上线 | 凭证 + 真实数据 + 不可逆 | 凭证错误 / CORS 错配可能引发数据全量泄漏 | 已有 [`ops/cos-production-rollout-checklist.md`](ops/cos-production-rollout-checklist.md);演练前再做一次 review |
| storage-settings 权限收紧 | 凭证读写权限 | 当前是 `SUPER_ADMIN, ADMIN`;ADMIN 边界未定义 | 含在 P0-F 评审稿内 |
| schema / migration 相关 | 不可逆;沿 [`process.md §3-4`](process.md) D 档铁律 | 任何 schema 变更必须 D 档 | 对应批次评审稿 |
| 权限 seed 变更 | 影响 14 条 Permission code + RolePermission 映射 | 沿 [`current-state.md §3`](current-state.md) Slow-3 未拍板 | 含在 P0-F 评审稿内 |
| token revoke / session 表 | 涉及新表 + 新写路径 + 安全 | 含在 P0-E refresh token 评审内 | 同 P0-E |

---

## 7. 第一版暂不做

> 完整清单见第 3.3 节。这里只列"AI 容易顺手补"的项,以防越权。

| 事项 | AI 容易"顺手做"的诱惑 | 何时再做 |
|---|---|---|
| 装备模块 | 看到没有就想建模 | 队组织提诉求 + 业务方案稳定 |
| 数据统计 / 复杂报表 / 大屏 | 看到 audit_logs 想加查询面板 | 数据沉淀 ≥ 3 个月 |
| APP 数据面板 | 看到没有就想"反正要做" | 队组织决定上 APP |
| 事件 / 派遣 / 排班 | V2 设计已明文延后 | 业务规则确认 |
| 复杂部门权限 | 看到 RBAC 想全量接入 | 用户拍板 Slow-3 / Slow-4 |
| Contribution 流水表 | 看到 ContributionRule 想"补全" | 出现按月对账诉求 |
| 微信小程序登录 / 多租户 | v1 明文不做 | 出现具体产品诉求 |
| Redis / queue / cron / LLM / vector | 看到日志 / 限流接入,想"早晚要装" | [`ARCHITECTURE.md §9`](../ARCHITECTURE.md) 升级条件触发 |

---

## 8. 最终建议

**1. 现在能不能直接对接前端?**

**能,但前提是先做完 P0-A + P0-G**(前端要接的范围 + BizCode 翻译)。代码契约本身已经 zero drift,前端真正缺的是"接什么、字段怎么翻、上传怎么走"的文档级共识。

**2. 如果要对接,最小还差哪 3 件?**

- **P0-A** 前端联调范围清单(没有它,前端不知道接什么)
- **P0-G** BizCode / 契约冻结(没有它,前端会做出与后端不一致的提示)
- **P0-B** 上传下载闭环验收 ✅(测试 bucket 2026-05-17 通过;**生产 bucket** 验收归 P0-H 部署演练,仍待执行)

**3. 哪些必须先评审,不能直接开发?**

- **P0-D 修改密码 ✅**:已落地于 #115 评审稿 / #116 铁律修订 / #117 代码实现 / 本 PR 状态回填
- **P0-E refresh token / logout ✅**:已落地于 #126 评审稿 + 铁律解锁 / #127 代码实现 / 本 PR 状态回填(access 15m + refresh 90d absolute expiration + rotation always + family revoke + 联动撤销 4 场景)
- **P0-F RBAC 关键接口最小闭环**:影响 18 个模块,涉及 Slow-3 / Slow-4,必须评审

**4. 哪些可以第一版后置?**

- 装备模块、数据统计、复杂报表、APP 数据面板、事件 / 派遣、排班、微信小程序登录、多租户、Redis / queue / cron、LLM / vector、Contribution 流水表、复杂部门权限、大屏(见第 7 节)

**5. 推荐下一条 PR 是什么?**

**`docs(first-release): add readiness plan`**(即本 PR)

理由:本文档是后续所有工作的导航;有了它再决定下一条 PR 是 P0-A(前端联调清单)还是 P0-D 评审稿。**不要**直接开发 refresh token / RBAC / 上传下载代码 PR。

---

> **前端联调包定义**:P0-A 前端联调范围清单 + P0-G API 契约 / BizCode 约定 + P0-C 内的字典清单与测试账号矩阵 + 上传 / 下载流程图,共同构成第一版"前端联调包"。前端在联调包齐备前不宜大规模接入。

---

## 附录:本文不承载

- 接口契约细节 → [`v2-api-contract.md`](v2-api-contract.md)
- 数据模型 → [`v2-data-model.md`](v2-data-model.md) + [`prisma/schema.prisma`](../prisma/schema.prisma)
- 部署 SOP → [`deployment.md`](deployment.md) + [`ops/cos-production-rollout-checklist.md`](ops/cos-production-rollout-checklist.md)
- 安全策略 → [`security.md`](security.md)
- 测试策略 → [`testing.md`](testing.md)
- 当前状态 → [`current-state.md`](current-state.md)
- AI 协作流程 → [`process.md`](process.md)

冲突时,**架构铁律优先**(沿 [`process.md §6`](process.md) 冲突优先级);本文让步。
