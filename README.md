# srvf-api

> 深圳公益救援队(SRVF)系统 API — NestJS + Prisma + PostgreSQL。

承载内容:队员档案、任务派遣、训练 / 出勤、装备、值班排班等公益救援队内部管理能力。

> **Derived from [`u-nest-api-starter`](https://github.com/BA7IEE/u-nest-api-starter) `v0.1.6`** (派生日期 2026-05-04)。
> 长期 AI 协作规则以 [`AGENTS.md`](./AGENTS.md) 为主入口;[`CLAUDE.md`](./CLAUDE.md) 仅作为 Claude Code 转发入口。架构背景以 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 为准(请先读其顶部"§0 当前阶段说明"),**当前事实以 [`docs/current-state.md`](./docs/current-state.md) 为准**。模板沉淀的工程基础设施(认证 / 用户 / 健康检查 / 错误码 / 日志 / 限流)继续生效;SRVF 业务模块在 `src/modules/` 下平铺新增,不修改模板已锁定的 `auth/` 与 `users/` 路由契约。
>
> 工程基础设施(Docker 容器名、CI workflow、测试数据库脚本)沿用模板的 `u-nest-api-*` 命名,这是稳定的工程契约,**不要改名**。

---

## 文档地图(2026-05-21 治理收口后)

| 文档 | 作用 | 权威等级 |
|---|---|---|
| [`docs/current-state.md`](./docs/current-state.md) | **当前事实唯一入口**:版本、open PR、最新 release、surface 状态、当前债务 | 当前事实 |
| [`AGENTS.md`](./AGENTS.md) | **长期 AI 协作铁律主入口**:命名 / 目录 / 错误码 / Guard / 软删除 / RBAC / refresh token / App API 边界 / §19 决策 | 长期铁律 |
| [`CLAUDE.md`](./CLAUDE.md) | Claude Code 入口转发(≤80 行;不复制 `AGENTS.md` 全文) | 入口转发 |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | v1 / V1.1 / V2 架构蓝图与设计背景;**请先读顶部"当前阶段说明"** | 设计背景 |
| [`docs/process.md`](./docs/process.md) | 开发流程与协作制度:开工 checklist、PR 五档分级、release 收口、AI 协作纪律 | 流程制度 |
| [`docs/api-surface-policy.md`](./docs/api-surface-policy.md) | API surface 长期边界:Mobile App / Admin Legacy / Root Legacy 三层 + 新增 / 迁移规则 | 长期铁律 |
| [`docs/srvf-foundation-baseline.md`](./docs/srvf-foundation-baseline.md) | V2 派生项目基线规范(13 项 A 档) | 长期铁律 |
| [`docs/V2红线与复活路径.md`](./docs/V2红线与复活路径.md) | V2 五档红线(A/B/C/D/E)与解锁触发条件 | 长期铁律 |
| [`docs/security.md`](./docs/security.md) / [`docs/deployment.md`](./docs/deployment.md) / [`docs/development.md`](./docs/development.md) / [`docs/testing.md`](./docs/testing.md) | 安全 / 部署 / 排错 / 测试 SOP | 运行指引 |
| [`docs/archive/`](./docs/archive/) | 历史 handoff / 评审稿 / 批次 / first-release 过程档案 | 历史证据 |

详细分层与冲突处理见 [`docs/README.md`](./docs/README.md)。

**冲突处理**:当前事实 > 长期铁律 > 流程 > 设计背景 > 历史证据。历史 handoff、批次评审稿、Phase reviews 已统一归档至 `docs/archive/**`,**不再作为当前执行约束**。除非用户明确要求,AI 不得修改 `ARCHITECTURE.md`。

---

## 环境要求

- **Node.js** ≥ 22 LTS
- **pnpm** 10.14.0(已在 `package.json#packageManager` 钉版本,**禁止使用 npm / yarn / bun**)
- **Docker**:本地开发用 `docker-compose.yml` 起 PostgreSQL;生产构建用多阶段 [`Dockerfile`](./Dockerfile)

---

## 快速启动

```bash
# 1. 复制 env 模板
cp .env.example .env

# 2. 起 PostgreSQL 容器(只起 DB,应用本身跑在宿主机)
docker compose up -d

# 3. 安装依赖
pnpm install

# 4. 应用 Prisma migration(首次会自动 generate Prisma Client)
pnpm prisma:migrate

# 5. 写入默认 super admin
pnpm prisma:seed

# 6. 启动开发服务(watch 模式)
pnpm start:dev
```

服务起来后,浏览器打开 <http://localhost:3000/api/docs> 即可看到 Swagger UI,在线调试所有接口。

---

## 默认账号

| 字段 | 值 |
|---|---|
| username | `admin` |
| password | `ChangeMe123456` |
| role | `SUPER_ADMIN` |

**⚠ 仅供本地开发使用。** 生产部署前必须修改 `SUPER_ADMIN_USERNAME` / `SUPER_ADMIN_PASSWORD` / `JWT_SECRET` / `APP_CORS_ORIGIN`,启动时会做强校验,任一不满足直接抛错退出。详见 [`docs/deployment.md`](./docs/deployment.md)。

---

## 路由总览

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `GET` | `/api/health` | 公开 | 服务健康检查(向后兼容) |
| `GET` | `/api/health/live` | 公开 | K8s liveness — 进程存活 |
| `GET` | `/api/health/ready` | 公开 | K8s readiness — DB 连通 |
| `POST` | `/api/auth/login` | 公开 | `username + password` 登录,返回 JWT;**默认 IP 维度限流 5 次 / 60 秒** |
| `GET` `PATCH` | `/api/users/me` | 登录 | 本人资料读取 / 修改(仅 nickname / avatarKey) |
| `GET` `POST` | `/api/users` | super admin / admin | 用户列表(分页) / 创建用户 |
| `GET` `PATCH` `DELETE` | `/api/users/:id` | super admin / admin | 详情 / 改资料 / 软删除 |
| `PUT` | `/api/users/:id/password` | super admin / admin | 重置用户密码 |
| `PATCH` | `/api/users/:id/role` | **super admin only** | 修改用户角色 |
| `PATCH` | `/api/users/:id/status` | super admin / admin | 启用/禁用用户 |
| `GET` | `/api/docs` | 开发环境默认开启 | Swagger UI(生产需 `ENABLE_SWAGGER=true`) |

完整字段、错误码归属与示例详见 [`docs/development.md`](./docs/development.md) 与 [`ARCHITECTURE.md`](./ARCHITECTURE.md) §6。

### V2 第一阶段(srvf-foundation)

V2 第一阶段开发已完成并随 v0.13.0 发布;v0.14.0(P0-E refresh / logout 闭环)与 v0.15.0(P0-F RBAC 收紧 + App API Phase 2 完整 15 endpoint)随后续 release 落地。完整起步包 / P1 后接 / 暂不接的历史口径见 [`docs/archive/plans/first-release-frontend-scope.md`](./docs/archive/plans/first-release-frontend-scope.md);**当前事实以 [`docs/current-state.md`](./docs/current-state.md) §2 为准**,不在 README 维护详细路由表。本表下方按模块列出 V2 第一阶段已实装接口,**v1 14 接口契约严格 zero drift**(`LoginDto` / `UserResponseDto` 不漂移)。

| 模块 | 路径前缀 | 接口数 | 关键能力 |
|---|---|---|---|
| dictionaries | `/api/v2/dict-types` + `/api/v2/dict-items` | 13 | 双表字典 + 父子树形 + 软删显式封装 |
| organizations | `/api/v2/organizations` | 7 | 组织树形 + 单根上限 + last-root 保护 + nodeTypeCode 走字典 |
| members | `/api/v2/members` | 6 | `memberNo` 全局唯一不复用 + `gradeCode` 字典校验 + 严禁敏感字段 |
| member-departments | `/api/v2/members/:memberId/department` | 3 | 一人一部门 + partial unique index + PUT 幂等 |
| member-profiles(批次 1) | `/api/v2/members/:memberId/profile` | 3 | 1:1 子资源 + 5 字典字段校验 + auditPlaceholder hook |
| emergency-contacts(批次 1) | `/api/v2/members/:memberId/emergency-contacts` | 4 | N:1 子资源 + priority ASC 排序 + 软删 + auditPlaceholder hook |
| certificates(批次 2) | `/api/v2/members/:memberId/certificates` | 8 | N:1 + 4 态闭集状态机(pending/verified/expired/rejected)+ verify/reject/qualification-flag 动作 + 列表精简 + 跨 member 校验 |
| activities(批次 3A) | `/api/v2/activities` | 7 | 活动状态机(draft/published/cancelled/completed)+ Q-A7 USER 与 ADMIN 同路由 service 按 Role 过滤 + Q-A12 cancelled 拒改 + 经纬度 `Decimal(10,7)` |
| activity-registrations(批次 3A) | `/api/v2/activities/:activityId/registrations` + `/api/v2/users/me/activities/:activityId/registration` + `/api/v2/users/me/registrations` | 10 | Q-A3 USER 自助 vs ADMIN 代报名拆开 + 4 态闭集(pending/pass/reject/cancelled)+ capacity 仅统计 pass + partial unique 取消后允许重报 + Q-A6 CSV 名单导出(StreamableFile,scope=pass 默认/scope=all 可选,不做 XLSX,0 副作用)|
| attendances(批次 3B + 批次 4-B) | `/api/v2/activities/:activityId/attendance-sheets` + `/api/v2/attendance-sheets/:id`(含 `/review-detail` / `/approve` / `/reject` / `/final-approve` / `/final-reject`)+ `/api/v2/users/me/attendance-records` | 11 | Sheet + Record 双 model;**5 态闭集**(pending / pending_final_review / approved / rejected / final_rejected;**approved 语义升级为"终审通过"**,沿批次 4-B / D-S6)+ APD 完整审核视图(R25 Activity+Sheet+Records[含 Member])+ 编辑 pending 后端生成 previousSnapshot+version+1(D38 / R28 / Q-S16 完整快照)+ 同 memberId 跨 Sheet/Activity 时间不重叠[左闭右开,R16 / Q-S15]+ serviceHours 未传自动计算 / <=0 / 超跨度三档校验(D14 / D45 / D46 / D51)+ registrationId 跨表校验 activity 一致(R23)+ approve 前 contributionPoints 必填(R31)+ **批次 4-B 升级**:`attendance.recorded` 触发位置从 `approve` 移到 `final-approve`(Q-S13 / D-S7;final-reject / approve / reject / submit / edit / delete 均不触发)+ **D14 ContributionRule 预填**(POST 时按 `(activityType, attendanceRole, durationMinutes)` 匹配规则预填 contributionPoints;调用方传值不覆盖;无匹配规则保持 null;dailyCap 默认 1.5;不暴露 CRUD,不引流水表)+ **D11 Activity.completed 推动**(首张 Sheet 提交时事务内 Activity `published → completed`,单向不可逆;reject / final-reject 不回退;completed 语义 = "已进入考勤提交阶段",不代表全部终审通过)+ pending_final_review / final_rejected 不可 edit / softDelete(22030 / 22043)+ finalReviewNote 终审驳回必填(22046)+ /me 仅 approved Sheet 内 records(Q-A14;approved 已升级为终审通过)+ 终审权限当前沿 ADMIN / SUPER_ADMIN(沿 D-S2 不开 22044,APD 部门部长 / 副部长细分权限留后续 RBAC 批次)|
| auth memberNo 登录回退 | `POST /api/auth/login`(契约不变) | — | `username` 字段服务端语义扩展为 username 或 memberNo |

完整字段、错误码、权限矩阵详见 [`docs/v2-api-contract.md`](./docs/v2-api-contract.md);在线调试见 `/api/docs` Swagger UI。

`member_profiles` / `emergency_contacts`(批次 1)+ `certificates`(批次 2)+ `activities` / `activity_registrations`(批次 3A)+ **`attendance_sheets` / `attendance_records`(批次 3B)**+ **`ContributionRule` schema + AttendanceSheet 终审 3 字段(批次 4-A)**+ **终审 / D14 ContributionRule 预填 / D11 Activity.completed 推动(批次 4-B)**已全部落地(详见上表)。批次 3 schema 含 4 model 已 commit(`31c8187`);批次 3A API(`6a9339b`)+ 批次 3B API(`5dbd230`)+ 批次 4-A schema(`2190803`)+ 批次 4-B service/API(`6812db9`)接续交付。**当前 V2.x 复活路径与当前解锁状态以 [`docs/current-state.md`](./docs/current-state.md) 与 [`docs/V2红线与复活路径.md`](./docs/V2红线与复活路径.md) 为准**;READ ME 不再维护批次级累计接口数与逐版本快照。

---

## 常用命令

```bash
# 开发
pnpm start:dev         # watch 模式启动
pnpm build             # 编译到 dist/
pnpm start:prod        # 跑编译后的产物

# 代码质量
pnpm lint              # ESLint(覆盖 src / test / prisma)
pnpm typecheck         # tsc --noEmit
pnpm format            # prettier --write

# Prisma
pnpm prisma:migrate    # 开发环境:应用 migration(可能生成新 migration 文件)
pnpm prisma:deploy     # 生产环境:仅应用已审查、已提交的 migration
pnpm prisma:seed       # 写入默认 super admin(幂等)
pnpm prisma:studio     # 图形化数据库 GUI

# 测试(三档,均为护栏,合并前都应通过)
pnpm test              # unit:不启动 Nest、不连数据库,纯函数 / 类单测,毫秒级反馈
pnpm test:contract     # contract:OpenAPI 契约快照,锁住 14 个接口的 schema,防止误改入参 / 出参 / 错误码
pnpm test:e2e          # e2e:端到端 API 测试,启动真实 Nest + 真实 Postgres(app_test 库)

# E2E 测试库管理
pnpm db:test:init      # 在 Postgres 容器里幂等创建 app_test 测试库(首次)
pnpm db:test:reset     # 出现脏数据时重置 app_test
```

`pnpm test:e2e` 详细说明见 [`docs/testing.md`](./docs/testing.md);Docker / 生产部署 / 迁移策略见 [`docs/deployment.md`](./docs/deployment.md)。
