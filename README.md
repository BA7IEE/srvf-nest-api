# srvf-api

> 深圳公益救援队(SRVF)系统 API — NestJS + Prisma + PostgreSQL。

承载内容:队员档案、任务派遣、训练 / 出勤、装备、值班排班等公益救援队内部管理能力。

> **Derived from [`u-nest-api-starter`](https://github.com/BA7IEE/u-nest-api-starter) `v0.1.6`** (派生日期 2026-05-04)。
> 模板提供的所有规范文档(`ARCHITECTURE.md` / `CLAUDE.md` / `AGENTS.md`)与工程基础设施(认证 / 用户 / 健康检查 / 错误码 / 日志 / 限流)继续生效;SRVF 业务模块在 `src/modules/` 下平铺新增,不修改模板已锁定的 `auth/` 与 `users/` 路由契约。
>
> 工程基础设施(Docker 容器名、CI workflow、测试数据库脚本)沿用模板的 `u-nest-api-*` 命名,这是稳定的工程契约,**不要改名**。

---

## 必读文档(改代码前请先读)

| 文档 | 作用 |
|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | v1 蓝图,数据模型 / 接口清单 / 命名铁律 / 升级路径,**所有规则的唯一来源** |
| [`CLAUDE.md`](./CLAUDE.md) | Claude Code 协作铁律(从 ARCHITECTURE.md §7 抽取) |
| [`AGENTS.md`](./AGENTS.md) | 通用 AI Agent 协作铁律(与 CLAUDE.md 内容同步) |
| [`docs/srvf-foundation-baseline.md`](./docs/srvf-foundation-baseline.md) | **V2 派生项目基线规范**(BizCode 段位 / 命名 / DTO / 软删除 / 验收门槛 13 项);改 V2 代码 / 写 V2 草案前必读 |
| [`docs/v2-plan.md`](./docs/v2-plan.md) | V2 第一阶段开发执行计划(Step 1-7) |
| [`docs/v2-data-model.md`](./docs/v2-data-model.md) | V2 第一阶段数据模型说明(4 模型 + `users.memberId`) |
| [`docs/v2-api-contract.md`](./docs/v2-api-contract.md) | V2 第一阶段接口契约(29 接口) |
| [`docs/development.md`](./docs/development.md) | 项目结构 / 路由总览 / 环境变量 / 排错 |
| [`docs/testing.md`](./docs/testing.md) | E2E 测试运行与覆盖范围 |
| [`docs/deployment.md`](./docs/deployment.md) | Docker 镜像、生产部署、迁移流程 |
| [`docs/security.md`](./docs/security.md) | 已落地安全策略、软删除策略、token 吊销升级路径 |
| [`docs/handoff/v0.4.0.md`](./docs/handoff/v0.4.0.md) | v0.4.0 阶段交接说明(下一会话启动入口) |

冲突时**以 `ARCHITECTURE.md` 为准**。除非用户明确要求,AI 不得修改 `ARCHITECTURE.md`。

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

V2 第一阶段开发已完成,等待维护者按需 release / tag。新增 72 个接口(原 70 + 批次 4-B 终审 2),**v1 14 接口契约严格 zero drift**(`LoginDto` / `UserResponseDto` 不漂移)。

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

`member_profiles` / `emergency_contacts`(批次 1)+ `certificates`(批次 2)+ `activities` / `activity_registrations`(批次 3A)+ **`attendance_sheets` / `attendance_records`(批次 3B)**+ **`ContributionRule` schema + AttendanceSheet 终审 3 字段(批次 4-A)**+ **终审 / D14 ContributionRule 预填 / D11 Activity.completed 推动(批次 4-B)**已全部落地(详见上表)。批次 3 schema 含 4 model 已 commit(`31c8187`);批次 3A API(`6a9339b`)+ 批次 3B API(`5dbd230`)+ 批次 4-A schema(`2190803`)+ 批次 4-B service/API(`6812db9`)接续交付,**累计 86 接口** contract zero drift(86 = v1 14 + V2 first stage 29 + 批次 1 7 + 批次 2 8 + 批次 3A 17 + 批次 3B 9 + 批次 4-B 2)。V2.x 复活路径仍延后(不在本阶段):`attachments` / `audit_logs` / `events` / `event_participants`;`ContributionRule` CRUD 接口、`contribution_points` 流水表、APD 部门部长 / 副部长专属权限均不在批次 4 范围。

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
