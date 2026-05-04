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
| [`docs/development.md`](./docs/development.md) | 项目结构 / 路由总览 / 环境变量 / 排错 |
| [`docs/testing.md`](./docs/testing.md) | E2E 测试运行与覆盖范围 |
| [`docs/deployment.md`](./docs/deployment.md) | Docker 镜像、生产部署、迁移流程 |
| [`docs/security.md`](./docs/security.md) | 已落地安全策略、软删除策略、token 吊销升级路径 |

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
