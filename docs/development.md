# 开发指南

> 本文聚焦"日常开发要怎么做",不重复 [`README.md`](../README.md) 的快速启动步骤。
> **本文只指路,不再 inline 维护具体路由表 / 字段表 / 模块树**;以下指针为长期权威源,本文与权威源冲突时一律以权威源为准。

---

## 0. 开工前先读

| 想知道的事 | 权威源 |
|---|---|
| **当前版本 / 已落地能力 / open PR / surface 状态 / 当前债务** | [`current-state.md`](current-state.md) |
| **AI 协作铁律**(命名 / 错误码 / Guard / 鉴权 / 密码 / refresh token / 软删除 / RBAC / App API 边界 / §19 决策) | [`AGENTS.md`](../AGENTS.md) |
| **架构入口与阶段说明** | [`ARCHITECTURE.md`](../ARCHITECTURE.md) |
| **完整路由 / endpoint 清单** | Swagger UI `/api/docs` + [`test/contract/openapi.contract-spec.ts`](../test/contract/openapi.contract-spec.ts) `EXPECTED_ROUTES` |
| **完整环境变量字段** | [`.env.example`](../.env.example) + [`src/config/`](../src/config/) |
| **安全策略 / 升级路径** | [`security.md`](security.md) |
| **PR 五档分级 / D 档降速 / release SOP** | [`process.md`](process.md) |

历史 v1 / V1.1 / V2 设计期蓝图与过程档案已归档至 [`archive/legacy/`](archive/legacy/) / [`archive/plans/`](archive/plans/) / [`archive/reviews/`](archive/reviews/) / [`archive/batches/`](archive/batches/),**不再作为当前执行约束**。

---

## 1. 项目结构

仓库根目录顶层(只列**长期固定**的入口,具体文件以仓库为准):

```
.
├── AGENTS.md / CLAUDE.md     # AI 协作铁律入口(CLAUDE.md 已收口为入口转发)
├── ARCHITECTURE.md           # 架构入口
├── README.md                 # 项目快速概览
├── docker-compose.yml        # 本地 PostgreSQL
├── Dockerfile                # 多阶段生产镜像
├── package.json              # 当前版本号权威源
├── prisma/                   # schema.prisma + migrations/ + seed.ts
├── docs/                     # 见 docs/README.md 文档地图
├── test/                     # e2e + contract
└── src/                      # 应用代码(详见下)
```

`src/` 顶层目录职责:

| 目录 | 职责 |
|---|---|
| `src/main.ts` / `src/app.module.ts` | 应用入口 + 模块注册 + 全局 Guard 注册 |
| `src/bootstrap/` | 启动期纯函数(global setup / swagger / logger / throttle / request-id) |
| `src/config/` | `app.config.ts` / `database.config.ts` / `jwt.config.ts` 等;env 读取与启动强校验落在这里 |
| `src/common/` | 跨模块基础件:decorators / dto / exceptions / filters / guards / interceptors / storage(含 Provider 路由) |
| `src/database/` | `PrismaService` + `DatabaseModule` |
| `src/modules/` | **业务模块权威位置**(平铺,**禁止**嵌套 `system/` / `business/` / `core/` 子目录) |

**业务模块以 `src/modules/` 实际目录为准**(以 `ls -d src/modules/*/` 当下结果为权威清单);本文不再 inline 维护模块树。模块结构基线与已解锁例外(surface-specific Controller / DTO 子目录 / 6 类职责类抽离)沿 [`AGENTS.md §2`](../AGENTS.md) + [`api-surface-policy.md`](api-surface-policy.md) + [`architecture-boundary.md`](architecture-boundary.md)。

---

## 2. 路由总览

**完整路由 / endpoint 清单的权威源**:

- 在线浏览:Swagger UI `/api/docs`(开发环境默认开;生产需 `ENABLE_SWAGGER=true`)
- 在仓代码:[`test/contract/openapi.contract-spec.ts`](../test/contract/openapi.contract-spec.ts) 中的 `EXPECTED_ROUTES` 常量(当前覆盖 78+ endpoint)
- OpenAPI snapshot 走 `pnpm test:contract` 回归

本文只保留**典型调用示例**,不再 inline 维护完整表:

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` / `/api/health/live` / `/api/health/ready` | 三层健康检查(全部 `@Public()`) |
| `POST` | `/api/auth/login` | `username + password` 登录,返回 `accessToken` + `refreshToken` + `refreshExpiresAt`;**默认 IP 5 次 / 60 秒** |
| `POST` | `/api/auth/refresh` | rotation always + family revoke + absolute expiration;失败统一 `REFRESH_TOKEN_INVALID=10007`;独立 throttler `refresh` 30 / 60 |
| `POST` | `/api/auth/logout` | 幂等;只撤销当前 refresh token;**不限流**;**不**吊销 access |
| `POST` | `/api/auth/logout-all` | 撤销该用户全部未过期 refresh;返 `{ revokedCount }`;复用 `password-change` throttler 5 / 60 |
| `GET` / `PATCH` | `/api/users/me` | 本人资料(`PATCH` 严格白名单 `nickname` / `avatarKey`) |
| `PUT` | `/api/users/me/password` | 本人改密(P0-D);独立 throttler `password-change` 5 / 60;`OLD_PASSWORD_INVALID=10005` / `NEW_PASSWORD_SAME_AS_OLD=10006` |
| `GET` | `/api/app/v1/me` / `/api/app/v1/me/capabilities` / `/api/app/v1/my/registrations` 等 | **v0.15.0 新增 App API surface**(15 endpoint);完整清单见 `EXPECTED_ROUTES` |
| `GET` | `/api/docs` | Swagger UI |

> **铁律**:
> - 新移动端能力**只能**落 `/api/app/v1/*` surface(沿 [`api-surface-policy.md`](api-surface-policy.md));禁止扩到 `/api/users/me/*`
> - Admin Legacy `/api/v2/*` 长期保留,新 PC 管理后台 endpoint 默认落此 surface
> - 鉴权细则(JWT payload zero drift / refresh token 安全策略 / 联动撤销 4 场景)详 [`AGENTS.md §8 / §9`](../AGENTS.md) + [`security.md`](security.md)

---

## 3. 认证示例

```bash
# 1. 登录拿 access + refresh
RESP=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"ChangeMe123456"}')
TOKEN=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['accessToken'])")

# 2. 用 access token 访问受保护接口
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/users/me
```

成功响应统一 `{ "code": 0, "message": "ok", "data": ... }`,错误响应 `{ "code": <BizCode>, "message": <提示>, "data": null }`(沿 [`AGENTS.md §4 / §5`](../AGENTS.md))。

`refresh` / `logout` / `logout-all` 语义(rotation always / family revoke / absolute expiration / 联动撤销 4 场景 / `JwtStrategy.validate` 每请求查库)详 [`AGENTS.md §9 P0-E 子节`](../AGENTS.md) + [`security.md`](security.md) `Token 吊销升级路径`。

---

## 4. 环境变量

**完整字段与默认值权威源**:

- 模板:[`.env.example`](../.env.example)(每次新增 env 必须同步)
- 读取与校验:[`src/config/`](../src/config/)(`app.config.ts` / `jwt.config.ts` 等;启动强校验落在 `*.config.ts` 与 `prisma/seed.ts`)
- 安全相关环境变量约束(JWT_SECRET 长度 / 生产 fail-fast / cors 等)详 [`security.md`](security.md) `已落地策略` 表

本文不再 inline 维护完整字段表;按职责类别速览即可:

| 类别 | 代表字段(完整列表见 `.env.example`) |
|---|---|
| Database | `DATABASE_URL` |
| Application | `APP_PORT` / `APP_ENV` / `APP_CORS_ORIGIN` / `ENABLE_SWAGGER` |
| JWT(access + refresh) | `JWT_SECRET` / `JWT_EXPIRES_IN`(15m) / `JWT_REFRESH_EXPIRES_IN`(90d) |
| Throttler 三实例(物理隔离) | `LOGIN_THROTTLE_*` / `PASSWORD_CHANGE_THROTTLE_*` / `REFRESH_THROTTLE_*` |
| RBAC | `RBAC_CACHE_TTL_SECONDS` / `RBAC_INITIAL_OPS_ADMIN_USER_ID` |
| Storage / COS | `STORAGE_ENCRYPTION_KEY` / `STORAGE_LOCAL_ROOT` 等(详 [`ops/cos-production-rollout-checklist.md`](ops/cos-production-rollout-checklist.md)) |
| Seed / 日志 | `SUPER_ADMIN_*` / `LOG_LEVEL` |

新增 env 务必同时改 `.env.example` + 对应 `src/config/*.config.ts` 读取与校验,避免 drift。

---

## 5. 排错

- **启动时抛 `JWT_SECRET 长度不足` / `APP_CORS_ORIGIN 不能为空` / `SUPER_ADMIN_PASSWORD` 默认值不允许等**:`.env` 缺字段或值不符合启动强校验,按提示修;`APP_ENV=production` 下强校验比 development 更严。
- **`pnpm prisma:migrate` 报连接错误**:确认 `docker compose ps` 中 PostgreSQL 容器 `healthy`(`docker-compose.yml` 中容器名以仓库当下为准)。
- **`/api/docs` 返回 404**:检查 `APP_ENV` 与 `ENABLE_SWAGGER`,生产环境必须显式 `ENABLE_SWAGGER=true` 才注册 Swagger。
- **`pnpm prisma:seed` 提示 `already exists; skipping`**:这是预期行为(seed 幂等,不会覆盖已存在用户)。
- **OpenAPI snapshot drift / contract 失败**:先跑 `pnpm test:contract`,看 `test/contract/openapi.contract-spec.ts` 的 `EXPECTED_ROUTES` 与 OpenAPI snapshot 是哪一侧 drift;若是新 endpoint 落地,需同步两侧。
- **e2e / CI 失败**:先看具体 `*.e2e-spec.ts` 的失败用例;请求链路问题用响应头 `x-request-id` 串日志(沿 `src/bootstrap/request-id.ts`)。
- **更深入的安全 / 部署 / 测试 SOP**:见 [`security.md`](security.md) / [`deployment.md`](deployment.md) / [`testing.md`](testing.md)。
