# 部署指南

> V1.1 起仅交付应用镜像本身;`docker-compose.yml` 仅供本地起 PostgreSQL,生产部署形态由部署环境决定。
> **多实例检查清单(2026-06-11 B 队列起;2026-07-18 D-Throttle 把第 2 项改为已支持)**:当前部署形态仍是单实例；横向扩成多副本前必须逐项核对下列 7 项，不能因限流已共享就推断其余进程内任务/缓存也已具备多实例一致性:
>
> 1. **生日/到期通知任务(已支持多实例 durable enqueue)**:两个进程级 `@Cron` 仍会在每个应用副本 09:00 Asia/Shanghai 触发，但只向 PostgreSQL outbox enqueue；稳定 eventKey unique 使多副本同一业务意图只保留一行。marker/证书状态/audit 与 intent 同事务，独立 worker 用 `FOR UPDATE SKIP LOCKED` + lease/fencing 竞争领取。provider 调用为 at-least-once，effect 成功后、ack 前崩溃可能重复触达；下游模板与运营文案须容忍重复。
> 2. **10 个 PostgreSQL shared 限流器(已支持多实例)**:`@nestjs/throttler@6.5.0` 的 login(`default`)/ password-change / refresh / sms-send / sms-verify / password-reset / login-sms / login-wechat / recruitment / content-public 全部注入 [`PostgresqlThrottlerStorage`](../src/bootstrap/postgresql-throttler-storage.ts)。`(throttlerName,key)` 唯一行在同一事务内原子更新，副本间共享一份 IP 配额；阈值、TTL、blockDuration、包生成的 hash key、42900 与无 header 行为不变。数据库/storage 异常严格走 50000，绝不回退进程内 Map；无 Redis、无第 3 个 cron。
> 3. **RBAC 权限解析(已支持多实例即时一致)**:`RbacService` 每次判权都从 PostgreSQL 解析当前在期 GLOBAL USER RoleBinding → RolePermission → Permission,不保留跨请求权限缓存；grant/revoke、role-permission 变更与角色软删在任一实例提交后,其他实例下一次请求直接读取当前 DB 事实。`POST /api/system/v1/rbac/reload` 的 endpoint、三档入参与 `{reloaded:true}` 响应保持兼容,内部无需清理状态。用户禁用 / 软删仍由 JwtStrategy 每请求查库校验 `status` / `deletedAt`,职责不变。
> 4. **storage-settings(多实例 live-read；enabled 生命周期尚未全链闭合)**:[`storage-settings.service.ts`](../src/modules/storage/storage-settings.service.ts) 每次调用直读 PostgreSQL 当前已提交 singleton；写事务提交后任一实例的下一次读取无需 wait/restart/reload/invalidate，即可获得新 provider/bucket/region/credentials，当前 Effect 只使用一份已解析参数快照。pinned locator 仍固定 provider/bucket/region，并在下一 Effect 使用当前凭证。**现存边界保持不变**:`getCurrentLocator()` 与 production bootstrap 检查 `enabled`，但 legacy non-pinned `StorageProvider` 调用尚未统一执行 `enabled=false`；这是后续 Storage 生命周期 D 切片，不能把本项解读为“全局开关已关闭所有存储 Effect”。
> 5. **sms-settings(已支持多实例即时切换)**:[`sms-settings.service.ts`](../src/modules/sms/sms-settings.service.ts) 每次调用直读 PostgreSQL；[`SmsProviderRouter.resolveRoute()`](../src/modules/sms/sms-provider.router.ts) 把一次读取绑定为短生命周期 route。配置提交只影响下一 route，已开始发送继续使用原快照，避免验证码/provider/evidence 撕裂。
> 6. **wechat-settings + access token(已支持多实例即时切换)**:[`wechat-settings.service.ts`](../src/modules/wechat/wechat-settings.service.ts) 每次调用直读 PostgreSQL；一次 delivery 固定同一配置快照。进程内 access token cache 按不透明 configuration generation 隔离，AppID/密文凭证代次变化后下一操作不会命中旧 token；同一 delivery 的 token-invalid refresh/retry 不跨代混用。
> 7. **realname-settings(已支持多实例即时切换)**:[`realname-settings.service.ts`](../src/modules/realname/realname-settings.service.ts) 每次调用直读 PostgreSQL；单次 OCR 的 provider/credentials/region 绑定同一快照，配置提交只影响下一 Effect。

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
| 登录接口限流 | `POST /api/auth/v1/login` 走 `@nestjs/throttler` PostgreSQL shared storage,默认 IP 维度 5 次 / 60 秒，多实例共用一份额度。命中后返回 HTTP 429 + `{ code: 42900, message: "请求过于频繁，请稍后再试", data: null }`,**不在响应体或响应头中暴露阈值、剩余配额、重置时间**(包括 `Retry-After`)；DB/storage 异常 fail-closed 为 50000 |
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

### D-INSURANCE v3 PR3 single gate 上线与回退 SOP（本次未部署）

> 本节只定义未来 production cutover；代码/PR 交付不表示已 release、deploy 或 enable。维护者“旧客户端都没上线”的确认不等于旧 server=0，后者必须在实际维护窗重新验证。

1. **先铺同一 PR3 binary、显式 false**：所有新实例必须显式设置 `INSURANCE_ENFORCEMENT_ENABLED=false`；production 缺失/空值/非法值会启动 fail-fast。确认健康检查、数据库连接及保险 focused smoke 全绿，期间不得启动 true 实例承接流量。
2. **停相关写并排空**：暂停 App 自购保险 PATCH/DELETE、Activity 报名、Team Join final join 与 Cycle 保险 flag 更新入口；等待所有 in-flight 事务结束。下线全部旧 binary，按实例/连接/流量证据确认旧 server=0，不能用客户端未上线代替。
3. **建立全绿 true 池后原子切流**：以同一 PR3 binary、显式 true 启动完整新池，先在不承接用户写流量时完成 readiness；随后一次性把流量从已排空的 false 池切到全绿 true 池。任何时刻都禁止 true/false 或旧/新 binary 混合承接相关写。
4. **切后验证再恢复写**：确认缺失/null/空白 expectedVersion→40000 且零写/审计、stale→26011、活动 26030、入队 26031、成功路径恰一 evidence 与 rollback smoke 后，才恢复相关写并持续观察错误率、锁等待与 40P01。
5. **回退只回同 binary false**：异常时再次停相关写，排空 true 事务；用同一 PR3 binary 的显式 false 完整替换/切回，确认所有承流实例同档且无 true/旧 binary 后才恢复写。不得在相关写继续流入时改档，也不得用 true/false 混跑作为渐进回退。

### D-Throttle 部署、观测与回退

1. **先 migration，后应用副本**：先审查并执行 `20260718090000_postgresql_throttler_buckets`，确认 migration 总数 56、无 pending；再启动使用 PostgreSQL storage 的应用。表未就绪时启动新代码会按设计 fail-closed 为 50000。
2. **发布观察**：持续看 throttler increment latency p50/p95/p99、`throttler_buckets` row-lock wait、hot-key 等待、连接池占用/timeout、DB CPU、HTTP 429 与 500 比例、表行数/增长率。429 比例变化须与真实流量和阈值核对，不能用本地 fallback“止血”。
3. **运行中故障语义**：PostgreSQL/storage 报错时业务 handler 不执行；所有副本继续 fail-closed。禁止动态切回每进程 Map，否则会静默恢复多实例额度穿透。
4. **回退**：increment p99、锁等待、DB CPU/连接池或 429 比例异常时，先停止/替换新部署并缩到单实例，再显式恢复上一应用版本；回退完成前保持 fail-closed。additive `throttler_buckets` 表保留，不做 down migration、不立即 `DROP`。
5. **retention**：过期桶只按 [`postgresql-throttler-retention-sop.md`](ops/postgresql-throttler-retention-sop.md) 在维护窗手工小批清理；零自动 cron。

### D-Outbox 部署、观测与回退

1. **先 migration，再应用与 worker**：先审查并执行 `20260718210000_notification_outbox_intents`，确认 migration 总数 58、无 pending；再部署应用，最后至少启动一个独立 `pnpm start:notification-outbox-worker` 进程。worker 与 API 使用同一 `DATABASE_URL` 及既有 SMS/WeChat 配置，但不监听 HTTP、不 import `AppModule`/`ScheduleModule`。
2. **可用性底线**：API 已开始写 outbox 而 worker 未运行时不会丢 intent，但通知会积压。上线探针至少覆盖 pending oldest age、processing lease 超时、attempts 分布、dead 增长率、claim/ack/nack latency、provider 成功率和数据库连接池。
3. **交付语义**：worker 在 provider 事务外发送；admin SMS 的 `sms_send_logs SENT` 与 `NotificationDelivery sent` 同一短事务提交后才 ack，微信成功证据同样先落库再 ack。provider accepted 到本地证据事务 commit 前、或证据已提交但 ack 前崩溃仍属于明确的 at-least-once 窗口，不宣称 exactly-once。微信 quota 的条件扣减与 `preparedAt` 同短事务只执行一次。
4. **回退**：异常时先停止 worker，再回退 API；保留 outbox 表和 pending/dead 证据。不得把 intent 手工改成 succeeded、不得修改 `_prisma_migrations`、不得切进程内 fallback。
5. **retention**：succeeded 30 天、dead 90 天后只按 [`notification-outbox-retention-sop.md`](ops/notification-outbox-retention-sop.md) 人工小批清理；零自动清理、cron 仍恰好 2。

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
