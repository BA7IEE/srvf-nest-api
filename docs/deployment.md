# 部署指南

> V1.1 起仅交付应用镜像本身;`docker-compose.yml` 仅供本地起 PostgreSQL,生产部署形态由部署环境决定。
> **单实例前提(2026-06-11 B 队列起;2026-06-12 核实轮补全为完整 checklist,同日微信 goal +第 6 处;2026-06-20 #399 F17/F19 true-up:+第 7 处 realname-settings 缓存、限流器 8→9〔+recruitment〕;2026-07-04 pre-go-live readiness B-1 true-up:限流器 9→10〔补 content-public,2026-06-21 CMS 内容模块引入时漏同步〕)**:当前部署形态 = 单实例,下列 7 处进程内 / 内存状态在单实例下均按设计工作,**无需动作**;它们同时构成**横向扩成多副本前必须逐项处理的 checklist**:
>
> 1. **生日祝福定时任务(扩容前必须处理)**:`@nestjs/schedule` 进程级 `@Cron`,每日 09:00 Asia/Shanghai(全仓唯一定时任务;`ScheduleModule.forRoot()` 在 [`app.module.ts`](../src/app.module.ts),job 在 [`birthday-greeting.service.ts`](../src/modules/notifications/birthday-greeting.service.ts);[`queue-b 评审稿 §6.8`](archive/reviews/queue-b-otp-birthday-infra-review.md))。多副本 → 每副本各自触发,同一天重复发送(双副本即双发)→ 扩容前必须先为该 job 加分布式锁(DB advisory lock / 任务表)。
> 2. **10 个内存限流器(扩容前必须处理)**:`@nestjs/throttler` 内存 storage、不引 Redis([`throttle-options.ts`](../src/bootstrap/throttle-options.ts);login(`default`)/ password-change / refresh / sms-send / sms-verify / password-reset / login-sms / login-wechat(2026-06-12 微信 goal +)/ recruitment(2026-06-18 招新一期 +,IP 10/3600)/ content-public(2026-06-21 CMS 内容模块 +,IP 60/60)共 10 个实例,均 IP 维度计数)。多副本 → 各实例独立计数,有效阈值 ≈ 配置值 × 副本数放宽。注:SMS 发码另有 PostgreSQL DB 层第二道防线(同号 60s 间隔 + 同号自然日上限 + phone+purpose 单活码):`SmsCodeService.issue` 在同一事务内固定按 phone → phone+purpose 获取 transaction advisory lock 后重读并写入,因此手机维度规则可跨实例串行;被放宽的仍只是 IP 维度桶(login / sms-send 等)→ 扩容前换共享 storage(如 Redis throttler storage)。
> 3. **RBAC 权限缓存(扩容前评估 TTL)**:`RbacCacheService` 进程内 Map + TTL(默认 1800 秒,`RBAC_CACHE_TTL_SECONDS` 可调);`POST /api/system/v1/rbac/reload` 与全部 invalidate 入口只清**本进程** Map。单实例:授权变更 invalidate 即时生效,TTL 仅兜底;多副本:RBAC 权限点变更在其他实例最多滞后一个 TTL。边界:**用户禁用 / 软删不受本缓存影响、无滞后**(JwtStrategy 每请求查库校验 `status` / `deletedAt`,与本缓存无关),受滞后影响的只有权限点变更 → 扩容前缩短 TTL 或引入跨实例失效广播。
> 4. **storage-settings 60 秒进程内缓存(影响小,知悉即可)**:[`storage-settings.service.ts`](../src/modules/storage/storage-settings.service.ts) `CACHE_TTL_MS = 60_000`。多副本 → 存储(COS)配置变更在其他实例最多滞后 60s 生效 → 一般可接受;需要更快收敛时缩短 TTL 或改共享缓存。
> 5. **sms-settings 60 秒进程内缓存(影响小,知悉即可)**:[`sms-settings.service.ts`](../src/modules/sms/sms-settings.service.ts) 同款 `CACHE_TTL_MS = 60_000`。多副本 → SMS 配置(通道开关 / 模板 ID 等)变更最多滞后 60s → 同上,一般可接受。
> 6. **wechat-settings 60 秒进程内缓存(影响小,知悉即可;2026-06-12 微信 goal +)**:[`wechat-settings.service.ts`](../src/modules/wechat/wechat-settings.service.ts) 同款 `CACHE_TTL_MS = 60_000`(wechat 评审稿 E-27)。多副本 → 微信配置(通道开关 / AppID / 凭证)变更最多滞后 60s → 同上,一般可接受。
> 7. **realname-settings 60 秒进程内缓存(影响小,知悉即可;2026-06-18 招新一期 +)**:[`realname-settings.service.ts`](../src/modules/realname/realname-settings.service.ts) 同款 `CACHE_TTL_MS = 60_000`。多副本 → 实名核验通道配置(provider 开关 / 凭证)变更最多滞后 60s → 同上,一般可接受。

---

## V1.1 已落地的工程能力

V1.1 在 v1 业务接口与数据模型不变的前提下补齐基础工程能力。规范定义见 [`ARCHITECTURE.md`](../ARCHITECTURE.md) §11、[`AGENTS.md`](../AGENTS.md) §17、[`CLAUDE.md`](../CLAUDE.md) §17;任务清单与验收标准见 [`TASKS.md`](../TASKS.md)。

| 能力 | 说明 |
|---|---|
| GitHub Actions CI | 每次 push / PR 自动跑 `lint` + `typecheck` + `pnpm test:e2e`(基于 docker-compose 启动 `postgres:16-alpine`) |
| 结构化日志 | `nestjs-pino` 输出 JSON,生产 stdout 直出;非生产由 `pino-pretty` 美化(`pino-pretty` 是 dev 依赖,生产镜像 runner 阶段不包含)。敏感字段日志显示为 `[REDACTED]`,清单详见 [`security.md`](./security.md) |
| 请求 ID `x-request-id` | 客户端可传入沿用,缺失时由 `cuid()` 生成;同时回写响应头并自动出现在每条日志的 `reqId` 字段中(不写入响应体、不进 JWT payload) |
| 优雅关闭 | `app.enableShutdownHooks()` + `PrismaService.onModuleDestroy()`,SIGTERM / SIGINT 时等待 in-flight 请求并干净断开 Prisma 连接 |
| 健康检查分层 | `/api/system/v1/health`(根端点,等同 /live)/ `/api/system/v1/health/live`(进程存活)/ `/api/system/v1/health/ready`(基于 `@nestjs/terminus` 的 DB 连通探测);三端点均走统一响应包装(Route B 终态前缀,原 `/api/health*` 已删除) |
| helmet HTTP 安全头 | 默认开启 helmet,Swagger UI 路径 `/api/docs` 局部禁用 CSP 以保留交互能力 |
| 登录接口限流 | `POST /api/auth/v1/login` 走 `@nestjs/throttler` 内存 storage,默认 IP 维度 5 次 / 60 秒。命中后返回 HTTP 429 + `{ code: 42900, message: "请求过于频繁，请稍后再试", data: null }`,**不在响应体或响应头中暴露阈值、剩余配额、重置时间**(包括 `Retry-After`) |
| Dockerfile 多阶段构建 | `deps` → `builder` → `runner` 三阶段,基于 `node:22-alpine`,以非 root 用户(`uid=1000 node`)运行;镜像内不包含 `.env*` / `.git` / `test/` / `.planning/` / 项目协作文档(由 [`.dockerignore`](../.dockerignore) 保证) |

V1.1 / V1.2 **没有**做的事(沿用 [`ARCHITECTURE.md`](../ARCHITECTURE.md) §9 升级条件):未引入 Redis / BullMQ / 队列;未接入 OpenTelemetry / Sentry / APM / Prometheus;未实现 RBAC / refresh token / 多租户 / 文件上传 Provider / LLM;未持久化审计日志;未交付 `docker-compose.prod.yml` / K8s manifests / 镜像推送脚本。

---

## Docker 镜像

### 构建

```bash
docker build -t u-nest-api-starter:v1.2 .
```

### 运行(最小示例)

生产镜像面向 `APP_ENV=production` 运行:runner 阶段已裁掉 devDependencies(包括 `pino-pretty`),因此若以 `APP_ENV=development` 启动,会在初始化日志模块时因加载不到 `pino-pretty` 而启动失败。生产部署使用下面的 production 配置:

```bash
docker run --rm -p 3000:3000 \
  -e APP_PORT=3000 \
  -e APP_ENV=production \
  -e DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/app?schema=public' \
  -e JWT_SECRET="$(openssl rand -base64 48)" \
  -e JWT_EXPIRES_IN=15m \
  -e APP_CORS_ORIGIN=https://app.example.com \
  -e ENABLE_SWAGGER=false \
  u-nest-api-starter:v1.2
```

启动强校验在 `APP_ENV=production` 下会拒绝:`JWT_SECRET` 等于 `.env.example` 默认值、`APP_CORS_ORIGIN` 为空或 `*`、`SUPER_ADMIN_PASSWORD` 等于默认值(seed 时)、`SUPER_ADMIN_USERNAME=admin`(seed 时)。完整字段以 [`.env.example`](../.env.example) 为准。

> **生产长期运行必须配置自动重启**(2026-06-12 增量审计⑩;前提 = 进程兜底 #345:`uncaughtException` / `unhandledRejection` 经 pino 记完整上下文后 `exit(1)`——单实例部署下进程退出即全站不可用,无自动重启则停摆等人工):上面示例的 `--rm` 仅作最小演示(与 `--restart` 互斥),长期运行改用 `docker run -d --restart unless-stopped ...`,或 systemd 单元 `Restart=always`,或编排平台等价物(K8s `restartPolicy` 默认 `Always`)。崩溃可观测性(fatal/error 日志)与自动复活二者都到位,#345 的兜底语义才完整。

---

## 生产数据库迁移原则

- 生产环境**只允许** `prisma migrate deploy`(已审查、已提交的 migration),仓库内的等价入口为 `pnpm prisma:deploy`;**禁止** `prisma migrate dev`
- 应用 runner 镜像默认只负责运行已构建的 NestJS 应用;**不会**在启动时自动执行 migration:Dockerfile 中没有 entrypoint 触发 `migrate deploy`,`CMD` 只跑 `node dist/main.js`
- migration 必须由部署流程**显式**触发(CI/CD pipeline 独立步骤、K8s `Job` / `initContainer` / Helm pre-upgrade hook、平台一次性 migration job 等),并在应用副本启动**之前**完成
- 应用 runner 镜像不保证包含 Prisma CLI(runner 阶段已裁掉 devDependencies)。如需在容器环境执行迁移,应使用 CI/CD 的源码工作区(直接 `pnpm prisma:deploy`),或单独构建 migrator 镜像
- 不在容器启动时自动 migrate 的原因:连库失败会触发反复重启(K8s rollback 行为不可控);多副本同时启动会让多个 `migrate deploy` 并发,Prisma migration_lock 不保证安全。详见 [`Dockerfile`](../Dockerfile) 文末注释

---

## 数据备份与恢复

> 本仓库不交付具体备份实现——托管数据库与自建实例的备份手段差异很大,选型属于部署环境决策,不在应用代码职责范围内(与本文件顶部"生产部署形态由部署环境决定"同一原则)。下面只登记**上线前必须为真**的底线,不锁定具体机制。

上线前必须确认:

- **自动备份已开启**,且备份频率与保留期已知(参考基线:至少每日一次全量,保留 ≥ 7–30 天,具体视数据变更速率与合规要求由维护者决定)
- **至少完整演练过一次恢复**:把某次备份实际还原到一个可用实例并核对数据,而不是只看备份任务显示"成功"——未演练过的备份不能视为已具备恢复能力
- **重大不可逆变更(如 DROP 表 / 批量数据回填类 migration)执行前手动打一次快照**,即便自动备份已开启也建议如此,避免变更窗口与常规备份周期错开导致的空窗期

可选机制(任选其一或组合,按实际托管环境决定,不是本仓库强制的一种):

- 托管 PostgreSQL(如云厂商 RDS/云数据库)自带的自动快照 / PITR(point-in-time recovery)
- 自建 Postgres:`pg_dump` 或 `pg_basebackup` 走 cron,产物异地存放(不与数据库同一台宿主机 / 同一块磁盘)
- 数据卷快照(宿主机 LVM snapshot、云盘快照等),需确认对 Postgres 数据目录是崩溃一致的(crash-consistent),或搭配 `pg_start_backup`/`pg_stop_backup` 语义使用

具体选型、频率、保留期、演练节奏由维护者按实际托管环境决定并归档;本节只登记"必须为真"的底线,不替代维护者的选型判断。

---

## Branch protection / required checks

仓库内 `.github/workflows/` 目前提供两条 CI 流水线:[`ci.yml`](../.github/workflows/ci.yml) 与 [`docker-smoke.yml`](../.github/workflows/docker-smoke.yml)。建议在 GitHub branch protection 中按下表配置 required checks(具体勾选在仓库 Settings → Branches 中操作,代码仓库本身不持有该配置):

| Check | 来源 workflow / job | 建议状态 | 理由 |
|---|---|---|---|
| `Lint / Typecheck / E2E` | `ci.yml` 的 `test` job | **required** | 覆盖 lint / typecheck / build / `prisma:deploy` / unit / contract / e2e,是模板核心契约护栏 |
| `Docker image build` | `ci.yml` 的 `docker-build` job | **required** | 验证多阶段 Dockerfile 在 CI 环境可成功构建出生产镜像 |
| `Container boot + API smoke + graceful shutdown` | `docker-smoke.yml` 的 `docker-smoke` job | **non-required**(当前阶段建议) | 容器启动级 smoke,受 runner / docker / network 时序影响更高,失败更可能是基础设施抖动而非代码缺陷 |

### 为什么 Docker Smoke 当前建议 non-required

- 该 workflow 在 `pull_request` 触发时启动 docker compose、build 镜像、跑容器、轮询健康检查,链路长,任何一环受 GitHub Actions runner 资源 / Docker daemon 状态 / 网络抖动影响都会失败
- 它是**早期告警**而非代码契约:真实回归在 `ci.yml` 的 e2e 与 contract 测试已覆盖
- 失败时维护者应**人工查看** dump 出的 `docker logs` / `/tmp/smoke-*.json`,判断是基础设施问题还是真实回归;不默认阻塞所有 PR

### 什么时候考虑提升为 required

满足任一条件即可考虑把 Docker Smoke 提升为 required check:

- 在 main 上**连续观察 ≥ 4 周**未出现假阳性(失败原因均为真实代码问题,非 runner 抖动)
- 即将进入正式生产部署前的最后一轮加固(把容器层契约也并入合并门槛)
- 引入了会显著放大容器启动差异的变更(切换 base image、调整 entrypoint、引入新启动期依赖等)

提升时同步更新本节描述,并在 [`docker-smoke-test.md`](./docker-smoke-test.md) 的"自动化 workflow"指引中标注。
