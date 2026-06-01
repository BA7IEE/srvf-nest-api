# Docker Smoke Test — v0.1.5 首轮手动报告(v0.1.6 已修复其中 logger WARN)

> **本文档定位**:这是 **v0.1.5** 镜像(HEAD `0826787`)的**第一轮手动** Docker smoke test 报告,作为历史快照保留,用于追溯首次容器层验证的执行细节与结论。
>
> **v0.1.6 已修复**本文 §6.1 记录的启动期 WARN(`[LegacyRouteConverter] Unsupported route path: "/api/*"`),根因为 `nestjs-pino` 的 `LoggerModule` 默认 `forRoutes: [{ path: '*', ... }]` 与 `app.setGlobalPrefix('/api')` 拼接;详见 `CHANGELOG.md` v0.1.6 段。v0.1.6 之后再跑 smoke 应不再出现该 WARN。
>
> **当前自动化以 [`.github/workflows/docker-smoke.yml`](../.github/workflows/docker-smoke.yml) 为准**:本文已不再是回归基线,只承担"首轮手动报告"的归档职责。后续 PR 触发的容器级回归由该 workflow 提供,触发路径覆盖 `Dockerfile` / `docker-compose.yml` / `package.json` / `pnpm-lock.yaml` / `prisma/**` / production boot 敏感路径(`src/main.ts` / `src/app.module.ts` / `src/bootstrap/**` / `src/config/**` / `src/database/**`)/ workflow 自身。
>
> **范围承诺(原始)**:本次只做只读/可回滚验证,**不改** Dockerfile / docker-compose.yml / CI / Prisma schema / 运行时代码 / 依赖版本。

---

## 1. 验证基线

| 项 | 值 |
|---|---|
| Git HEAD | `0826787` |
| Tag | `v0.1.5` |
| 镜像 tag | `u-nest-api-starter:smoke` |
| 镜像大小 | **308 MB**(node:22-alpine + prod-only deps + dist + Prisma schema/engine) |
| Postgres | `postgres:16-alpine`(`u-nest-api-postgres` 容器,docker-compose 已启动) |
| 验证用 DB | `app_smoke`(独立于 `app` / `app_test`,验证后已 dropdb) |
| 验证用 super admin | `smokeadmin / SmokeAdmin123456`(随 `app_smoke` 一并销毁) |
| 宿主机端口 | `13000 → 3000`(避开本地常用 3000) |

---

## 2. 环境前提

- macOS / Apple Silicon,Docker Desktop 已运行
- `docker compose up -d postgres` 已起 PostgreSQL,网络名 `srvf-nest-api_default`(bridge,由 `docker-compose.yml` 顶部 `name: srvf-nest-api` 声明决定)
- Node 22 + pnpm 10.14(host 侧用于跑 `prisma migrate deploy` / `prisma db seed`)
- 容器**不**自带 Prisma CLI(Dockerfile 明确把 `prisma` / `@prisma/engines` 等从镜像裁掉),migration/seed 由部署流程在镜像之外执行

---

## 3. 必需环境变量(production 模式启动)

| 变量 | 取值 | 备注 |
|---|---|---|
| `APP_ENV` | `production` | 强校验:必须 ∈ `{development, test, production, smoke}` |
| `APP_PORT` | `3000` | 容器内端口 |
| `APP_CORS_ORIGIN` | `https://app.example.com` | production 下禁止为空 / 禁止 `*` |
| `DATABASE_URL` | `postgresql://postgres:postgres@postgres:5432/app_smoke?schema=public` | 容器内通过 docker network 解析 `postgres` 服务名 |
| `JWT_SECRET` | `openssl rand -base64 48`(64 字符) | 强校验:≥32 字符 + 不等于 `.env.example` 默认值 |
| `JWT_EXPIRES_IN` | `15m` | 与 `.env.example` 一致 |
| `ENABLE_SWAGGER` | `false` | production 默认关;严格 `=== 'true'` 才开 |
| `LOG_LEVEL` | `info` | 留空亦可,production 默认 `info` |

> `LOGIN_THROTTLE_LIMIT` / `LOGIN_THROTTLE_TTL_SECONDS` 留空,使用默认 5 / 60。

---

## 4. 实际执行命令

### 4.1 Build

```bash
docker build -t u-nest-api-starter:smoke .
# → 5 stage 顺利完成,无 prisma generate 连库,镜像 308 MB
```

### 4.2 准备 DB

```bash
docker exec u-nest-api-postgres createdb -U postgres app_smoke
```

### 4.3 Migration / Seed(host 侧)

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/app_smoke?schema=public" \
  pnpm exec prisma migrate deploy
# → Applying migration `20260502100906_init` ✔

DATABASE_URL="postgresql://postgres:postgres@localhost:5432/app_smoke?schema=public" \
  pnpm exec prisma generate
# → Generated Prisma Client (v6.19.3)

DATABASE_URL="postgresql://postgres:postgres@localhost:5432/app_smoke?schema=public" \
APP_ENV=development \
SUPER_ADMIN_USERNAME=smokeadmin \
SUPER_ADMIN_PASSWORD=SmokeAdmin123456 \
SUPER_ADMIN_EMAIL= \
  pnpm exec prisma db seed
# 第一次:Created super admin smokeadmin
# 第二次:User 'smokeadmin' already exists; skipping  ← 幂等 ✔
```

### 4.4 启动容器

```bash
docker run -d --name u-nest-api-smoke \
  --network srvf-nest-api_default \
  -p 13000:3000 \
  -e APP_ENV=production \
  -e APP_PORT=3000 \
  -e APP_CORS_ORIGIN=https://app.example.com \
  -e DATABASE_URL="postgresql://postgres:postgres@postgres:5432/app_smoke?schema=public" \
  -e JWT_SECRET="$(openssl rand -base64 48)" \
  -e JWT_EXPIRES_IN=15m \
  -e ENABLE_SWAGGER=false \
  -e LOG_LEVEL=info \
  u-nest-api-starter:smoke
```

容器启动日志:

- `ConfigModule` / `TerminusModule` / `HealthModule` / `UsersModule` / `ThrottlerModule` / `JwtModule` / `LoggerModule` / `AppModule` / `AuthModule` 全部 initialized
- 路由全部 mapped:`/api/system/v1/health`、`/api/system/v1/health/live`、`/api/system/v1/health/ready`、`/api/auth/v1/login`、`/api/users/*`
- `Nest application successfully started`

---

## 5. API smoke check 结果

| 接口 | HTTP | 响应体(摘) | 结论 |
|---|---|---|---|
| `GET /api/system/v1/health` | 200 | `{code:0, data:{status:"ok"}}` | ✔ 健康根端点(等同 /live) |
| `GET /api/system/v1/health/live` | 200 | `{code:0, data:{status:"ok"}}` | ✔ K8s liveness |
| `GET /api/system/v1/health/ready` | 200 | `{code:0, data:{status:"ok", db:"up"}}` | ✔ DB 连通 |
| `GET /api/docs` | 404 | — | ✔ production + `ENABLE_SWAGGER=false` 预期关闭 |
| `GET /api/docs-json` | 404 | — | ✔ 同上 |
| `POST /api/auth/v1/login`(正确) | 200 | `{code:0, data:{accessToken, tokenType:"Bearer", expiresIn:"15m"}}` | ✔ |
| `POST /api/auth/v1/login`(错密码) | 401 | `{code:10004, message:"账号或密码错误"}` | ✔ §8 防枚举 |
| `POST /api/auth/v1/login`(用户不存在) | 401 | `{code:10004, message:"账号或密码错误"}` | ✔ 与错密码完全相同 |
| `GET /api/users/me`(带 token) | 200 | 含 `lastLoginAt`、不含 `passwordHash` | ✔ §11 `userSafeSelect` |
| `GET /api/users/me`(无 token) | 401 | `{code:40100, message:"未登录或登录已失效"}` | ✔ §8 两阶段错误码区分 |

### 容器侧观察

| 项 | 结果 |
|---|---|
| 进程身份 | `uid=1000(node)`,**非 root** ✔ |
| PID 1 | `node`(无额外 init),可直接收 SIGTERM ✔ |
| Helmet 响应头 | `Strict-Transport-Security`、`Content-Security-Policy`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN` 等齐全 ✔ |
| `X-Powered-By` | **未出现**(已禁用) ✔ |
| 请求日志 | `x-request-id` 透传 + 进结构化日志的 `reqId` ✔ |
| 敏感字段 | `authorization: "[REDACTED]"`,登录请求 body 未落日志 ✔ |
| 登录后日志 | 自动带上 `userId` ✔ |
| 优雅关闭 | `docker stop -t 10` → exit 0,远早于超时 ✔ |

---

## 6. 发现的问题

### 6.1 启动期 WARN — `nestjs-pino` LoggerModule 默认 `forRoutes` 与 path-to-regexp v8 legacy wildcard 冲突(已在 v0.1.6 修复)

启动日志中出现:

```text
[LegacyRouteConverter] Unsupported route path: "/api/*". In previous versions, the symbols ?, *, and + were used to denote optional or repeating path parameters. The latest version of "path-to-regexp" now requires the use of named parameters. ... Attempting to auto-convert...
```

> v0.1.5 报告时初步判断与 Swagger 静态资源 / fallback route 有关,**该判断不准确**。v0.1.6 定位到真实根因并修复,以下为更正后的描述。

- **真实根因**:`nestjs-pino` 的 `LoggerModule.configure()` 默认 `forRoutes: [{ path: '*', method: ALL }]`;与 `app.setGlobalPrefix('/api')` 拼接后变成 `/api/*`,触发 NestJS 11 + path-to-regexp v8 的 `LegacyRouteConverter` 自动转写并 warn。LoggerModule 注册 `pino-http` 与 `bindLoggerMiddleware` 两个 middleware,因此 WARN 重复一次(共两条),与 Swagger 无关
- **当前后果**:无功能影响,NestJS 自动转写为 `/api/*path`,语义不变
- **修复**:v0.1.6 在 [src/bootstrap/logger-options.ts](../src/bootstrap/logger-options.ts) 显式声明 `forRoutes: [{ path: '*path', method: RequestMethod.ALL }]`,使用 path-to-regexp v8 命名 wildcard 跳过 legacy 转换路径,与 `LegacyRouteConverter` 错误信息推荐写法一致。语义不变,仍匹配全部以 `/api` 开头的请求;无 API / Prisma schema / 依赖 / Dockerfile / CI 变化
- **后续 smoke 复测**:基于 v0.1.6 及之后镜像启动应**不再出现该 WARN**;若仍出现需检查是否引入了新的 `path: '*'` 形式 middleware 注册

### 6.2 docker-compose 不再单独维护应用服务(已知设计,非问题)

- 当前 `docker-compose.yml` **只启** `postgres`,**不**包含应用服务定义,与 `Dockerfile` 文末"生产迁移原则"一致(应用容器由部署环境 / K8s 决定)
- 本地若想"`compose up` 一键起全套",需要本人维护 override compose,不在 V1.1 范围

### 6.3 Prisma seed 输出有一行 `undefined`(轻微噪声)

- `pnpm exec prisma migrate deploy` 第一行输出 `undefined`(Prisma CLI 自身的 informational print)
- 不影响功能,不影响幂等;**不在范围内修**

---

## 7. 是否建议把 smoke test 纳入 CI

**建议:第二轮纳入,先做最小自动化版本。**

理由:
- 当前 v0.1.5 镜像确实可跑,但 V1.4 已经做过 Prisma 6.x → `prisma.config.ts` 这种"看似只动配置实则可能影响 CLI 行为"的变更;再发生一次类似事件没有 smoke test 兜底,就只能依赖人工跑本文档命令
- Prisma 7 升级在即(选项 A),升级期 smoke test 是关键回归网
- CI 已有 `pnpm test:e2e` 覆盖 NestJS 层面契约,**容器层面**没有任何回归保护,正是最薄弱处

### 推荐最小实现方案(第二轮交付物)

新增 `.github/workflows/docker-smoke.yml`,与现有 ci.yml 解耦,只在以下情况触发:

- `push` 到 `main`
- `pull_request` 影响 `Dockerfile` / `docker-compose.yml` / `prisma/**` / `.github/workflows/docker-smoke.yml` / `package.json` / `pnpm-lock.yaml`

job 步骤:

1. checkout
2. 起 service container `postgres:16-alpine`(GitHub Actions `services:` 字段,与 ci.yml 一致)
3. `docker build -t u-nest-api-starter:ci .`(无 cache 时 ~3-4 分钟,可加 `actions/cache` 缓存 buildx layer)
4. host 侧 `pnpm install --frozen-lockfile && pnpm exec prisma migrate deploy && pnpm exec prisma db seed`(注入 CI 专用 super admin 凭据)
5. `docker run -d --name app ... u-nest-api-starter:ci`(production 模式,DATABASE_URL 走 service container hostname)
6. `curl --retry 10 --retry-delay 2 --retry-connrefused` 探测 `/api/system/v1/health` → 200
7. 断言:
   - `GET /api/system/v1/health/ready` → 200 + `db:"up"`
   - `POST /api/auth/v1/login`(对) → 200 + 含 `accessToken`
   - `POST /api/auth/v1/login`(错) → 401 + `code:10004`
   - `GET /api/docs` → 404(production)
   - `docker exec app id` → `uid=1000`
8. `docker stop -t 10 app && [ $(docker inspect app --format '{{.State.ExitCode}}') = 0 ]` 断言优雅关闭
9. 失败时 `docker logs app` 上传 artifact

### CI 化时**不要**做的事

- 不要在 CI 里跑 Prisma 7 试验镜像(那是独立任务,见 docs/v1.4-prisma7-evaluation.md)
- 不要在镜像 ENTRYPOINT 里加 `prisma migrate deploy`(会破坏 Dockerfile 文末"生产迁移原则")
- 不要把 smoke job 设成必过 required check —— 第一周观察稳定后再升级

---

## 8. 第一轮结论

- ✔ Dockerfile build 通过
- ✔ 镜像可在 production 模式下启动并连库
- ✔ Migration / Seed 在镜像外执行,seed 幂等
- ✔ 全部预期接口契约符合 §4 / §5 / §8
- ✔ 非 root + Helmet + 结构化日志 + requestId + 敏感字段 redact + 优雅关闭全部生效
- ⚠ 一个不阻塞功能的 path-to-regexp WARN(§6.1),根因为 `nestjs-pino` LoggerModule 默认 `forRoutes: '*'` 与全局前缀 `/api` 拼接成 `/api/*`,**已在 v0.1.6 修复**
- 建议第二轮把 smoke 自动化进 CI(§7)
