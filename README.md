# srvf-api

> 深圳公益救援队(SRVF)系统 API — NestJS + Prisma + PostgreSQL。

承载内容:队员档案、任务派遣、训练 / 出勤、装备、值班排班等公益救援队内部管理能力。

> **Derived from [`u-nest-api-starter`](https://github.com/BA7IEE/u-nest-api-starter) `v0.1.6`**(派生日期 2026-05-04)。
> 模板沉淀的工程基础设施(认证 / 用户 / 健康检查 / 错误码 / 日志 / 限流)继续生效;SRVF 业务模块在 `src/modules/` 下平铺新增。
> 工程基础设施(Docker 容器名、CI workflow、测试数据库脚本)沿用模板的 `u-nest-api-*` 命名,这是稳定的工程契约,**不要改名**。

---

## 文档入口 / 阅读协议

> 本 README 只保留「怎么把项目跑起来」。所有**会随版本变化的事实**(版本号、模块清单、端点、权限码、当前债务)都由下面的权威源维护,README 不再复制——避免二次漂移。

| 我想看 | 去哪看 |
|---|---|
| **当前事实**(版本 / 模块 / 端点 / surface 状态 / 债务)——唯一权威源 | [`docs/current-state.md`](./docs/current-state.md) |
| **完整接口 / 字段 / 错误码 / 权限矩阵** | 运行时 `/api/docs`(Swagger UI)+ `/api/docs-json` |
| **文档总索引**(baseline / V2 红线 / security / deployment / testing / handoff 等) | [`docs/README.md`](./docs/README.md) |
| **长期 AI 协作铁律**主入口 | [`AGENTS.md`](./AGENTS.md)(Claude Code 另读 [`CLAUDE.md`](./CLAUDE.md)) |
| **架构背景与设计蓝图** | [`ARCHITECTURE.md`](./ARCHITECTURE.md)(先读顶部「§0 当前阶段说明」;除非用户明确要求,AI 不修改此文件) |
| **API surface 长期边界** | [`docs/api-surface-policy.md`](./docs/api-surface-policy.md) |

**恒读三件套**(每会话开工必读):[`AGENTS.md`](./AGENTS.md) → [`docs/current-state.md`](./docs/current-state.md) → [`docs/process.md §2/§3`](./docs/process.md)(Claude Code 另读 `CLAUDE.md`)。

**冲突处理**:当前事实 > 长期铁律 > 流程 > 设计背景 > 历史证据。历史 handoff / 评审稿 / 批次已归档至 [`docs/archive/**`](./docs/archive/),**不再作为当前执行约束**。

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

## API 总览

> 全仓 API 落在 **5 个 canonical surface 前缀**(Route B 终态):`/api/admin/v1`(管理面)· `/api/app/v1`(移动端队员自助)· `/api/auth/v1`(认证)· `/api/system/v1`(系统 / ops)· `/api/open/v1`(预留)。长期边界见 [`docs/api-surface-policy.md`](./docs/api-surface-policy.md);**完整端点、字段、错误码、权限矩阵一律以 `/api/docs` 与 [`docs/current-state.md`](./docs/current-state.md) 为准,README 不维护路由表**。

装好后可用这几个稳定入口做冒烟自检:

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/system/v1/health`(`/live` · `/ready`) | 服务健康检查 / K8s 存活 · 就绪探针,公开 |
| `POST` | `/api/auth/v1/login` | `username`(或 `memberNo`)+ `password` 登录,返回 JWT;带 IP 维度登录限流(阈值见 [`docs/security.md`](./docs/security.md)) |
| `GET` | `/api/docs` | Swagger UI(生产需 `ENABLE_SWAGGER=true`) |

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
pnpm test:contract     # contract:OpenAPI 契约快照,锁住 EXPECTED_ROUTES 的 schema,防止误改入参 / 出参 / 错误码
pnpm test:e2e          # e2e:端到端 API 测试,启动真实 Nest + 真实 Postgres(app_test 库)

# E2E 测试库管理
pnpm db:test:init      # 在 Postgres 容器里幂等创建 app_test 测试库(首次)
pnpm db:test:reset     # 出现脏数据时重置 app_test
```

`pnpm test:e2e` 详细说明见 [`docs/testing.md`](./docs/testing.md);Docker / 生产部署 / 迁移策略见 [`docs/deployment.md`](./docs/deployment.md)。
