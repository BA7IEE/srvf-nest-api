# AGENTS Historical Design-Period Rules

> **Status**: archived historical material.
> **Source**: sections moved verbatim from [`AGENTS.md`](../../../AGENTS.md) at commit `b2c0d55` (PR #192 `docs: clarify AGENTS policy drift`).
> These sections are retained for traceability only and **are not the current execution authority**.
> Current rules are in [`AGENTS.md`](../../../AGENTS.md) and active docs linked from `AGENTS.md` / [`docs/current-state.md`](../../current-state.md).
>
> **Paths**: original sections referenced repo-root-relative paths such as `docs/process.md`. Those strings are preserved verbatim below — they no longer resolve as Markdown links from this nested archive location, but the textual references are still meaningful when read from repo root.
>
> **Not archived here** (remain authoritative in `AGENTS.md`):
> - `§16` testing strategy
> - `§18.4` / `§18.4.1` sensitive-field discipline + baseline-read requirement (preserved in compressed form)
> - `§19.7` D-1 ~ D-8 locked architectural decisions (preserved verbatim)

---

## Archived §15 实施顺序

按 `ARCHITECTURE.md` 附录执行,逐步推进:

1. 项目初始化(`pnpm` + NestJS CLI + tsconfig / eslint / prettier)
2. Docker Compose 起 PostgreSQL
3. Prisma 接入(schema + 第一次 migration + `PrismaService`)
4. 公共基础件(全局 `/api` 前缀、CORS、异常过滤器、响应拦截器、`BizException`、`@Public` / `@CurrentUser` / `@Roles`)
5. `health/`(`GET /api/health` + `@Public()`)
6. Swagger 接入
7. `auth/` 登录
8. `users/` 模块(本人 + 管理员接口、分页、`userSafeSelect`、`notDeletedWhere`、自我保护 + 最后一个 SUPER_ADMIN 保护)
9. `prisma/seed.ts`
10. `common/storage/` 接口落地(只 interface + types,不实现 Provider)
11. `modules/ai/README.md` 占位
12. `CLAUDE.md` + `AGENTS.md`(本文件)
13. `README.md`

---

## Archived §17 V1.1 AI 执行规则

> **SRVF v0.13.0 注**:本节是母模板 V1.1 工程加固阶段历史段,SRVF 当前已进入 v0.13.0。后续 schema / API / 业务模块变更**以 [`docs/process.md`](docs/process.md) / [`docs/current-state.md`](docs/current-state.md) / 最新 handoff / 对应评审稿为准**,不再以本节直接判断。工程加固技术选型铁律(pino / throttler / helmet / terminus 等)仍生效。

> 本节是 V1.1 工程加固阶段的 AI 协作铁律,与 `ARCHITECTURE.md` §11 同步。**修改 V1.1 相关代码前,必须先读完 `ARCHITECTURE.md` §11 和 `TASKS.md`**。
> V1.1 与 v1 铁律冲突时,**以 v1 铁律为准**(§1-§16 全部保留生效)。

### 17.1 V1.1 阶段判定与必读

进入 V1.1 工程加固任何任务前必须做完以下三步:

1. 读 `ARCHITECTURE.md` §11(V1.1 Engineering Hardening 范围与禁止项)
2. 读 `TASKS.md`(V1.1 任务清单 + 依赖顺序 + 验收标准)
3. 在 `TASKS.md` 找到当前任务编号,确认其前置任务已经完成

未完成上述三步直接动手 → 视为擅自实现,需要回滚。

### 17.2 V1.1 允许项(必须按 §11.2 选型)

| 能力 | 必须使用的库 | 不允许的替代方案 |
|---|---|---|
| 结构化日志 | `nestjs-pino` + `pino` | winston / bunyan / 自写 logger / `console.log` |
| 限流 | `@nestjs/throttler` 内存 storage | Redis storage / 自写 rate limiter / 在 service 里 `setTimeout` |
| 安全头 | `helmet` | `cors` 中间件配置头 / 自写中间件 |
| 健康检查升级 | `@nestjs/terminus` | 自写 controller / 直接查 `prisma.$queryRaw('SELECT 1')` |
| 优雅关闭 | NestJS `app.enableShutdownHooks()` + `OnModuleDestroy` | `process.on('SIGTERM', ...)` 自写 handler |
| 请求 ID | `nestjs-pino` 内置 genReqId,或自写中间件用 `cuid()` | `uuid` / 自增计数器 / Math.random |
| CI | GitHub Actions | CircleCI / Jenkins / Travis / 本地脚本替代 |
| 容器化 | Dockerfile 多阶段构建 | 单阶段构建 / Buildpacks / 直接打包 dist |

选型一旦在 `TASKS.md` 中确认,后续 AI **不得擅自改换**。

### 17.3 V1.1 禁止项(全部沿用 v1 + 追加)

V1.1 阶段**仍然不做**(等价于 §1 v1 不做的事 + ARCHITECTURE.md §11.3):

- 不引入 Redis(包括限流 Redis storage、用户状态缓存、JWT 黑名单)
- 不引入 BullMQ / 任务队列 / 定时任务
- 不做操作日志 / 审计日志的**数据库持久化**
- 不接入 OpenTelemetry / Tracing / Sentry / Datadog / APM
- 不暴露 `/metrics` 端点(若未来需要,必须同步加入 `ResponseInterceptor` 跳过列表)
- 不做微信登录 / RBAC / 多租户 / 文件上传 Provider / pgvector / LLM(本人自助改密 `PUT /api/users/me/password` 由 P0-D 评审稿冻结后开放,铁律见 §9;**refresh token / logout / logout-all** 由 P0-E 评审稿 v1 冻结后开放,铁律见 §9 P0-E 子节;**两者均不通过** V1.1 工程加固通道实现)
- 不修改 `prisma/schema.prisma`(不加日志字段、不加请求统计字段)
- 不修改 `src/modules/auth/` 与 `src/modules/users/` 的业务路由、入参、出参、HTTP 方法、权限标注
- 不修改 §6 接口清单的任何已有接口
- 不为日志 / 限流 / helmet 单建 `*.config.ts`,统一归 `src/config/app.config.ts`

发现需求与禁止项冲突时,**必须暂停并说明**;不得"先实现再回滚"。

### 17.4 与 v1 铁律的复用约束

V1.1 新增能力**必须**复用 v1 已建立的基础设施:

- **错误处理**:限流命中、健康检查 ready 失败等异常必须经 `BizException` + `AllExceptionsFilter`,响应体仍是 `{ code, message, data: null }`,HTTP status 由 BizCode `httpStatus` 决定;**禁止**直接 `throw new HttpException(...)` 绕过统一错误码
- **响应格式**:`/api/health` / `/api/health/live` / `/api/health/ready` 三个端点继续走 `ResponseInterceptor` 包装,**不得**为对齐 `@nestjs/terminus` 原生输出绕过包装;Swagger 装饰器使用 `@ApiWrappedOkResponse(...)` 而非裸 `@ApiOkResponse`
- **错误码段位**:`TOO_MANY_REQUESTS = 42900` 落在 `4xxxx` 通用 HTTP 段,**不**占用业务模块的 `100xx` / `110xx` 段位;`message` 固定为 `请求过于频繁，请稍后再试`,**不暴露阈值数字、剩余配额、重置时间**
- **配置归属**:`LOG_LEVEL` / `LOGIN_THROTTLE_LIMIT` / `LOGIN_THROTTLE_TTL_SECONDS` 全部归 `src/config/app.config.ts`,启动强校验,默认值在 `app.config.ts` 内统一处理,业务代码不直读 `process.env.XXX`
- **日志屏蔽清单**:`password` / `newPassword` / `passwordHash` / `authorization` / `cookie` / `token` / `accessToken` / `refreshToken` / `secret` 命中字段在日志中**必须显示为 `[REDACTED]`**,不能仅做长度截断;v1 已有的 `userSafeSelect` 不能因为日志接入而被绕过——日志屏蔽是兜底,DTO 白名单仍是第一道防线
- **限流作用范围**:`@nestjs/throttler` 当前**只**作用于 `POST /api/auth/login`,**不**全局开启,**不**对其他业务接口加限流;若未来需扩展,必须先更新 `TASKS.md` 与 `ARCHITECTURE.md` §11.2

### 17.5 健康检查三端点契约

V1.1 完成后,健康检查端点契约固定为:

| 端点 | 检查内容 | 响应 |
|---|---|---|
| `GET /api/health` | 进程存活(向后兼容入口,实现等同 `/live`) | `{ code: 0, message: 'ok', data: { status: 'ok' } }` |
| `GET /api/health/live` | 进程存活(K8s liveness probe) | `{ code: 0, message: 'ok', data: { status: 'ok' } }` |
| `GET /api/health/ready` | DB 连通(`@nestjs/terminus` 的 `PrismaHealthIndicator` 或等价 `SELECT 1`) | 成功:`{ code: 0, message: 'ok', data: { status: 'ok', db: 'up' } }`;失败:**HTTP 500** + `{ code: 50000, message: '服务器内部错误', data: null }` |

铁律:

- 三端点都必须 `@Public()`,都走统一响应包装
- 三端点都必须有 `@ApiOperation({ summary })` + 包装响应装饰器
- `/api/health/ready` DB 连通失败时,**必须**抛 `BizException(BizCode.INTERNAL_ERROR)`,由 `AllExceptionsFilter` 按 `BizCode.INTERNAL_ERROR.httpStatus` 输出 **HTTP 500**;**禁止**直接 `throw new ServiceUnavailableException()` 绕过统一错误处理
- v1 已有的 `/api/health` E2E 必须继续通过,**不能**因升级 `@nestjs/terminus` 而破坏向后兼容

**关于 ready 失败 HTTP status 的最终决策(方案 A,优先级以 `ARCHITECTURE.md` §11.4 为最高)**:

- `ARCHITECTURE.md` §11.4 规定"HTTP status 由 `BizCode` 的 `httpStatus` 决定";`BizCode.INTERNAL_ERROR.httpStatus` 是 **500**,因此 ready 失败实际响应为 HTTP 500 + `code: 50000`,这是**有意为之**,不是 K8s 标准的 503 readiness 语义
- V1.1 阶段**不**新增 `BizCode.SERVICE_UNAVAILABLE`、**不**修改 `AllExceptionsFilter`、**不**对 ready 路径做特判;以最小改动半径与最高文档优先级为准
- AI 代理**不得**在 15.5 范围内自行新增 `BizCode.SERVICE_UNAVAILABLE` 或在 `AllExceptionsFilter` 内对 ready 路径做特殊映射;若未来确需标准 HTTP 503,作为独立任务在 V1.2+ 启动,届时同步更新本节、`CLAUDE.md` §17.5、`TASKS.md` §15.5 三处描述
- K8s readiness probe 对 5xx 一律视作 unready,500 与 503 在容器编排层面行为一致,生产可用性不受影响

### 17.6 优雅关闭契约

`PrismaService` 必须实现 `OnModuleDestroy`:

```typescript
async onModuleDestroy() {
  await this.$disconnect();
}
```

`main.ts` 必须 `app.enableShutdownHooks()`。

铁律:

- 不要在 `main.ts` 自写 `process.on('SIGTERM', ...)`;NestJS 已经处理
- 不要 `process.exit(0)` 强制退出;让 NestJS lifecycle hook 走完
- 关闭顺序由 NestJS 控制:HTTP 停接 → 等 in-flight 请求 → `OnModuleDestroy` → `OnApplicationShutdown`

### 17.7 限流契约

- 仅 `POST /api/auth/login` 走限流
- 限流 storage **必须**是 `@nestjs/throttler` 内存 storage(默认),**禁止**配置 Redis storage
- 限流参数从 `app.config.ts` 注入,**不**硬编码在装饰器里
- 超限抛 `BizException(BizCode.TOO_MANY_REQUESTS)`,经 `AllExceptionsFilter` 返回 HTTP 429 + 统一响应体
- 限流命中后**不返回** `Retry-After` 头,**也不返回** `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset` 头;阈值数字、剩余配额、重置时间**一律不暴露**到响应体或响应头(包括日志的 message 字段)

### 17.8 V1.1 禁止"顺手做"清单

进入 V1.1 后 AI 容易"顺手"扩展的反模式,**全部禁止**:

| 反模式 | 为什么禁止 |
|---|---|
| "既然接了 pino,顺手把请求 body 全打日志" | 日志膨胀 + 敏感数据泄漏风险;只打必要字段(method、url、status、duration、requestId、userId) |
| "既然接了 throttler,顺手对所有接口加限流" | 限流参数未经业务评估,容易把正常用户挡掉 |
| "既然接了 terminus,顺手加 Redis / 外部 API 健康检查" | V1.1 不引入 Redis,也不依赖外部 API |
| "既然有 Dockerfile,顺手写 docker-compose.prod.yml" | 用户明确要求 V1.1 不修改 docker-compose.yml,且生产 compose 需要按真实部署环境定制 |
| "既然有 CI,顺手加发布到 npm / Docker Hub 的 job" | 发布流程超出 V1.1 范围,需要单独评估凭据管理与版本号策略 |
| "既然有日志,顺手把 BizException 写一条 ERROR 级日志" | BizException 是预期业务错误(如登录失败、用户已存在),应是 INFO 或 WARN;ERROR 留给未捕获异常和 5xx,否则告警噪音爆炸 |
| "既然有限流,顺手在 service 里加二次防护" | 防护重复,且 service 层难以正确实现 IP 维度限流;限流统一交给 `@nestjs/throttler` |
| "既然有请求 ID,顺手把它塞进 JWT payload" | JWT 是签发时确定的,请求 ID 是每请求生成的,语义不匹配 |

### 17.9 V1.1 阶段验收门槛

每个 V1.1 任务完成后,**必须**按以下两档逐项验证:

#### A 档 — 基础验收(每个任务都必须跑)

1. `pnpm lint` 通过
2. `pnpm typecheck` 通过
3. `pnpm test:e2e` 全部通过(含 v1 已有的 137 用例)
4. 该任务自身在 `TASKS.md` 列出的验收标准全部满足
5. 不得引入新的依赖到 `package.json`,除非该依赖已在 `TASKS.md` 对应任务中显式声明

#### B 档 — 手工验证(仅当任务涉及 HTTP 行为、全局中间件、拦截器、Guard、Controller、Swagger 时,在 A 档基础上追加)

启动服务,逐项确认:

- `/api/docs` 能正常打开,Swagger UI 完整可用
- `GET /api/health` 仍按 v1 契约返回(向后兼容,响应体为 `{ code: 0, message: 'ok', data: { status: 'ok' } }`)
- 本任务**新增或影响的接口**能按预期返回,覆盖典型成功路径与典型错误路径

#### 档位归属说明

- **必须跑 B 档**的任务示例:接入 `nestjs-pino`(影响全局日志中间件)、请求 ID 中间件、健康检查升级(新增 controller / 改 Swagger)、helmet(全局响应头)、登录限流(影响 Guard / Controller / Swagger 错误响应)
- **只跑 A 档即可**的任务示例:GitHub Actions CI 流水线(不动运行时)、Dockerfile 镜像构建(交付物层面变更,运行时行为不变)、优雅关闭(改 lifecycle 但 HTTP 契约不变;若改动确实可能影响请求收尾,可补 B 档观察一次)

任一未通过 → 不算完成,不能 commit。

### 17.10 边界声明

V1.1 完成后,**不要**自动触发 §9 升级路径。任何"日志接进来了顺手接 APM""限流接进来了顺手上 Redis""健康检查接进来了顺手暴露 metrics"的延伸,都需要重新评估业务诉求并经用户明确确认,而不是 AI 自行判定。

---

## Archived §18 V2 调研 / 设计阶段约束(历史部分)

> Includes original `## 18.` heading + intro context block + §18.1 / §18.2 / §18.3 / §18.5 / §18.6 / §18.7.
> **§18.4 / §18.4.1 remain active in `AGENTS.md`** (preserved in compressed form) as the authoritative source for sensitive-field discipline and the baseline-read requirement; they are **not** archived here.

### §18 顶部状态说明(归档时刻原文)

> **SRVF v0.13.0 注**:本节是 SRVF V2 早期调研期约束;当前已进入开发期(批次 5-A / 6 / 7 / 8 + P0-* 已落地),"禁止 schema / migration / 新模块"设计期禁令**不再作为当前直接禁令**。§18.4 / §18.4.1 敏感信息字段治理要求(业务用途 + 查看角色 + 保存期限三问)**仍有效**。

> **状态**:**仅调研与设计阶段**,**不是开发执行约束**。
> **生效范围**:仅 `srvf-nest-api` 派生项目;不回流 `u-nest-api-starter` 模板仓。
> **与 v1 / V1.1 的关系**:与 §1-§17 同时生效;冲突以 §1-§17 为准。
> **解除条件**:`docs/srvf-foundation-research.md` + `docs/srvf-foundation-data-model-draft.md` 评审通过,且 `ARCHITECTURE.md §12` 升级为带 schema 锁定的开发蓝图。
> **边界依据**:本节所有"不做""暂不做""禁止"项,以 [`docs/srvf-foundation-research.md`](./docs/srvf-foundation-research.md) §3 / §6 为权威源,本节不重复罗列具体清单,只锁"调研/设计阶段的行为铁律"。
> **适用对象**:**任何** AI agent / 自动化工具 / 助手类程序 — 不限于 Claude Code,涵盖 Cursor / Cline / Aider / Continue / Copilot 等同类工具,以及未来可能接入的任意 agent 框架。

### 18.1 调研期硬禁止(行为级)

V2 调研 / 设计阶段,**禁止**以下任意一项动作,即使"看起来顺手就能做":

- 禁止运行 `prisma migrate dev` / `prisma migrate deploy` / `prisma db push`
- 禁止修改 `prisma/schema.prisma`(包括添加注释、调整字段顺序、加 `@@map` 等任何写入)
- 禁止修改 `prisma/seed.ts`(包括为 V2 字典 / 组织 / 队员预留 seed 代码骨架)
- 禁止新建 `src/modules/<业务>/` 任何目录与文件(members / organizations / dictionaries / attachments / audit-logs / events / event-participants / member-profiles / member-departments 等一律不建)
- 禁止新建 `src/common/<新基建>/`(audit / dict / 任何新 Provider 实装目录)
- 禁止安装新依赖(包括看似"早晚要装"的 `@nestjs/event-emitter` / 任何字典缓存库)
- 禁止修改 `package.json` / `pnpm-lock.yaml`
- 禁止修改 `Dockerfile` / `docker-compose.yml` / `.github/workflows/*`
- 禁止编写 V2 相关 unit / E2E / contract / smoke 测试草案
- 禁止修改 v1 已交付的任何 `src/` 文件(auth / users / health / config / common / database / bootstrap)
- 禁止生成 OpenAPI 契约快照变更

### 18.2 设计期内容禁止(草案表达级)

V2 草案文档 / 评审讨论中,**禁止**以下表达:

- 禁止把深圳救援队**真实**部门名(如"水域""山地""绳索""通信"等具体节点)写进任何文档或 seed 示例
- 禁止预先写死队员等级的具体取值
- 禁止预先写死活动类型 / 事件类型的具体取值
- 禁止预先写死证书 / 资质 / 装备类别的具体取值
- 禁止把 `users` 与 `members` 合并为一张表的设计(违反研究文档 §6.1)
- 禁止把"紧急联系人 / 医疗信息 / 装备 / 证件附件"等扩展字段堆入 `members` 主表(违反研究文档 §6.2)
- 禁止把 v1 系统级枚举(`Role` / `UserStatus`)或软删除标记字典化(违反研究文档 §6.3)
- 禁止用 JSON 数组 / 逗号分隔字符串 / `department1` `department2` 并列字段表达多对多(违反研究文档 §6.4)
- 禁止在草案文档中画"最终 ER 图"或写完整 Prisma DSL
- 禁止在敏感信息字段上跳过研究文档 §4.3 的"业务用途 / 查看角色 / 保存期限"三问就纳入 V2 草案
- 禁止在 V2 草案里"顺手"实现研究文档 §3 任一暂不做项

### 18.3 设计期表达要求(措辞级)

- 每个候选模型必须显式列出"待确认清单",空清单视作未完成
- 每个跨模型模式(字典 / 软删 / 审计 / 附件归属)必须列出**至少一个备选方案与回退条件**,不留单选独裁
- "已确认 / 当前倾向 / 待调研 / 暂不做"四档标签强制使用,**禁止**模糊措辞("应该""可能""差不多""一般来说")
- "倾向方案"**不等于**"已拍板",草案措辞必须区分;一段话同时出现"倾向"与"将实现"视作越权
- 涉及 `events` / `event_participants` 时必须援引研究文档 §2.6 的"通用化失败回退三档"(最小骨架 / 延后参与表 / 整体砍掉),不得强行通用化做大宽表

### 18.5 通用 agent 工具调用约束

不同 agent 工具链有不同动作原语,但 V2 调研期对工具调用的约束按"动作语义"统一:

| 动作语义 | V2 调研期允许? | 备注 |
|---|---|---|
| 读文件 / 列目录 / 搜索 / 查 Git 历史 | ✅ 允许 | 用于调研既有代码与历史决策 |
| 写文档(`docs/*.md` / `*.md` 顶层文档) | ✅ 允许 | 仅本节列出的 4 处文档 + 研究 / 草案文档 |
| 写代码(`src/**` / `prisma/**` / `test/**` 等) | ❌ 禁止 | 含新建空文件 / 占位目录 |
| 修改依赖(`package.json` / lockfile) | ❌ 禁止 | 含 `--dry-run` 类预演也禁止 |
| 运行 prisma 任何写命令(migrate / db push / seed) | ❌ 禁止 | `prisma generate` 同样禁止以避免隐式同步 |
| 运行测试 / lint / typecheck | ✅ 只读式允许 | 不允许带 `--write` / `--fix` 类自动修复 |
| 调用外部网络 / 拉取文档 | ✅ 允许 | 调研用途;结论必须落到文档 |
| 提交 commit / push 远程 | ⚠️ 仅含文档变更才允许 | commit 内容混入代码 / schema / 依赖即视作越权 |

### 18.6 V2 调研期"顺手做"反模式清单

| 反模式 | 为什么禁止 |
|---|---|
| 写 research / draft 时顺手补一个最小 `members` 表 | 违反 §18.1;草案是形态讨论,不是 schema 落地 |
| 看到 v1 `users` 缺 `memberId` → 顺手加可空外键 | 违反研究文档 §5.6;关联方案是 [当前倾向] 候选,未拍板 |
| 调研字典模式时顺手装字典缓存 / i18n 包 | 违反 §18.1 + 研究文档 §3.12 |
| 讨论审计时顺手在 `PrismaService` 加全局 hook | 违反 §18.1;审计写入策略是 [待调研] |
| 觉得"反正要做" → 先建 `src/modules/dictionaries/` 占位 | 违反 §18.1;占位目录是隐性范围扩张 |
| 草案里画"最终版" Prisma schema 块 | 违反 §18.2;草案不是 schema |
| 把"水域 / 山地 / 绳索"作为字典示例值写进文档 | 违反 §18.2 + 研究文档 §5.1 / R13 |
| 把"紧急联系人 / 医疗信息"加进 `members` 字段草案 | 违反 §18.2 + 研究文档 §6.2 / §4.3 |

### 18.7 解除时机与边界声明

V2 调研 / 设计阶段完成 → **不自动**进入开发阶段。开发阶段的执行铁律(类比 §1-§17)在草案评审通过后**另起新章节**(`ARCHITECTURE.md §12.7+` / 本文 §19+)落地,**不**通过修订本节(§18)实现。本节(§18)在开发阶段开始后保留作为"V2 调研期历史约束"不删除,但效力被新章节覆盖。

---

## Archived §19.1-§19.6 API Client Boundary 设计期约束

> Includes original `## 19.` heading + intro context block + §19.1 / §19.2 / §19.3 / §19.4 / §19.5 / §19.6.
> **§19.7 D-1 ~ D-8 remain active in `AGENTS.md`** as the authoritative source for the locked architectural decisions; they are **not** archived here.

### §19 顶部状态说明(归档时刻原文)

> **状态**:**设计期 v0**(2026-05-19 起)。
> **生效范围**:仅 `srvf-nest-api`;不回流 `u-nest-api-starter`。
> **配套设计文档**:[`docs/api-client-boundary.md`](docs/api-client-boundary.md)(顶层规范)+ [`docs/archive/reviews/api-client-boundary-inventory.md`](docs/archive/reviews/api-client-boundary-inventory.md)(现状盘点)+ [`docs/archive/plans/api-client-boundary-migration-plan.md`](docs/archive/plans/api-client-boundary-migration-plan.md)(分阶段路线)。
> **与既有规则关系**:本节是**纯增补**,**不修改** §1-§18 任何既有规则语义。冲突时本节让步给 §1-§18 + baseline + V2 红线;冲突顺序见 §18.4.1 / [`docs/srvf-foundation-baseline.md §14.4`](docs/srvf-foundation-baseline.md)。
> **解除条件**:三份设计文档评审通过且后续 Phase 1+ 任务在 [`docs/process.md`](docs/process.md) 流程内**单独立项**后,本节作为正式蓝图引用。
> **`CLAUDE.md` 状态**:`CLAUDE.md` 自 v0.15.0 起已收口为入口 / 路由文件(≤80 行),不再镜像 §19 内容;长期铁律以本 `AGENTS.md` 与其链接的 active docs([`docs/api-client-boundary.md`](docs/api-client-boundary.md) / [`docs/api-surface-policy.md`](docs/api-surface-policy.md))为准。

### 19.1 客户端边界设计期硬禁止(行为级)

本设计期(Phase 0)**禁止**以下任意一项动作,即使"看起来顺手就能做":

- ❌ 修改任何 `*.controller.ts` 的 `@Controller(...)` 前缀
- ❌ 修改任何 controller 的 HTTP method 装饰器 path 参数
- ❌ 新增 / 修改 / 删除任何 HTTP endpoint
- ❌ 新增 `app-*.controller.ts` / `admin-*.controller.ts` / `system-*.controller.ts`
- ❌ 修改任何 `@ApiTags(...)` / `@Roles(...)` / `@Public()` / `@RequirePermission(...)`
- ❌ 修改任何入参 DTO / 响应 DTO 字段
- ❌ 新增 `dto/app/` / `dto/admin/` / `dto/internal/` 目录与文件
- ❌ 移动 controller 文件物理位置(如 `src/common/storage/` → `src/system/storage/`)
- ❌ 修改 `prisma/schema.prisma` / 生成 migration / 执行 `prisma migrate dev`(沿 §0 + §18.1)
- ❌ 安装新依赖 / 修改 `package.json` / `pnpm-lock.yaml`
- ❌ 修改 `apply-swagger.ts` / `apply-global-setup.ts` 等 bootstrap 文件
- ❌ 编写本设计期相关 unit / E2E / contract / smoke 测试代码
- ❌ 修改 `CHANGELOG.md` / `docs/current-state.md` / `docs/handoff/*` 写"v0.15.0 计划做 client boundary 改造"等任何前瞻性内容

### 19.2 客户端边界设计期允许的动作(动作级白名单)

不同 AI Agent 工具链有不同动作原语,但本设计期对工具调用的约束按"动作语义"统一:

| 动作语义 | 允许? | 备注 |
|---|---|---|
| 读 `*.controller.ts` / `*.dto.ts` / `*.service.ts` / `src/bootstrap/*` | ✅ | 调研用途 |
| 读 / 写 `docs/api-client-boundary*.md` | ✅ | 本设计期核心产物 |
| 读 / 增补 `CLAUDE.md §19+` / `AGENTS.md §19+` | ✅ | 仅增补,不修改 §1-§18 |
| 修改 `CLAUDE.md` / `AGENTS.md` §1-§18 任何字符 | ❌ | 沿 §18 不动既有规则 |
| 写代码(`src/**` / `prisma/**` / `test/**`) | ❌ | 含新建空文件 / 占位目录 |
| 修改依赖(`package.json` / lockfile) | ❌ | 含 `--dry-run` 类预演也禁止 |
| 运行 prisma 任何写命令(migrate / db push / seed) | ❌ | `prisma generate` 同样禁止以避免隐式同步 |
| 运行 `find` / `grep` / `git log` / `git diff` | ✅ | 只读盘点 |
| 运行 `pnpm lint` / `pnpm typecheck` / `pnpm test:*` | ✅ | 只读式验收,不允许 `--write` / `--fix` |
| 调用外部网络 / 拉取文档 | ✅ | 调研用途;结论必须落到文档 |
| 提交 commit / push 远程 | ⚠️ | 仅 `docs/api-client-boundary*.md` + 本节 §19+ 增补;混入其它视作越权 |

### 19.3 与既有铁律的关系(冲突时让步表)

| 维度 | 优先级 |
|---|---|
| v1 §1-§16 / V1.1 §17 / V2 §18 | **最高**;本节让步 |
| `docs/srvf-foundation-baseline.md` 13 项基线 | **第二**;本节让步 |
| `docs/V2红线与复活路径.md` 五档红线 A/B/C/D/E | **第三**;本节让步 |
| 各批次评审稿(`docs/批次*.md` / `docs/first-release-*.md`)| **第四**;本节让步 |
| 本节(§19 API Client Boundary 设计期约束) | **第五**;让步给上方 |
| 设计文档(`docs/api-client-boundary*.md`) | 同上 |

**冲突铁律**:发现本节(§19)与上方任意一档冲突 → **必须暂停说明**,不擅自调和。

### 19.4 客户端边界设计期 Agent 工具链约束

- **TodoList / 任务记录**:任务内容只能是"读 / 写 / 评审 / 提问 / 文档增补"类动作;**禁止**出现"实现 controller / 改 path / 改 DTO / 新增 endpoint"等执行词
- **Plan / 计划模式**:任何**疑似越界**到代码改动的动作(改 controller / 新增 endpoint / 拆 DTO)**必须**先出 Plan 经用户确认,且默认应当被否决到 Phase 1+ 立项
- **Sub-agent / 调研代理**:允许做只读调研,产出必须落到 [`docs/archive/reviews/api-client-boundary-inventory.md`](docs/archive/reviews/api-client-boundary-inventory.md) 或对话总结,**不得**直接产出代码
- **Skill / 内置技能**:本设计期不调用任何会修改仓库代码的 skill
- **Commit**:本设计期每次 commit 仅含 `docs/api-client-boundary*.md` + `CLAUDE.md §19+` + `AGENTS.md §19+` 增补;**禁止**把文档与代码 / schema / 依赖变更混进同一 commit;commit message 前缀建议 `docs(boundary): <章节> <简述>`

### 19.5 客户端边界设计期"顺手做"反模式清单

| 反模式 | 为什么禁止 |
|---|---|
| 写规范文档时顺手新建一个 `src/modules/xxx/controllers/app-*.controller.ts` 空文件 | 违反 §19.1;占位文件是隐性范围扩张 |
| 看到 `UserResponseDto` 含 `lastLoginAt` → 顺手 omit 出 `AppMyUserResponseDto` | 违反 §19.1 + §18.1;DTO 拆分是 Phase 5 范围 |
| 看到 `/api/users/me` 与 `/api/v2/users/me/*` 双前缀不统一 → 顺手统一改一个 | 违反 §19.1;路径迁移是 Phase 2+ 范围 |
| 看到 `activities` `list` 含 `@Roles(USER)` → 顺手改 `@Roles(SUPER_ADMIN, ADMIN)` "收紧" | 违反 §19.1 + §1 v1 不做清单;权限收紧是 Phase 5 范围 |
| 写盘点表时顺手"修正"某个 `@ApiOperation` summary 文案 | 违反 §19.1;非设计期产物变更 |
| 顺手在 `apply-swagger.ts` 加 `/api-docs/app` 拆分 | 违反 §19.1;多份 Swagger 是 Phase 1 末期或 Phase 4 范围 |
| 在草案文档里画"App 视角 `MemberDto`" 字段全表 | 违反 §19.1 间接;字段级 DTO 设计是 Phase 2 评审稿范围,设计期 v0 只锁顶层规范 |
| 看到 P0-E refresh token `/api/auth/login` 没在 `/v1` 前缀下 → 顺手加双 path 别名 | 违反 §19.1;双写 path 是 Phase 1 范围 |

### 19.6 解除时机与边界声明

设计期 v0(Phase 0)完成 → **不自动**进入 Phase 1+ 任何代码改造阶段。
Phase 1+ 任务必须**单独立项**、**单独评审稿**、**单独 PR**(沿 [`docs/archive/plans/api-client-boundary-migration-plan.md §1 + §10`](docs/archive/plans/api-client-boundary-migration-plan.md))。

Phase 1+ 开始后,本节(§19)**继续生效**作为"客户端边界长期约束";后续若需新增"客户端边界执行铁律"(类比 v1 §1-§17 / V1.1 §17),应**新增** §20+,**不**修订本节(§19)。

---

> End of archived material.
> §19.7 D-1 ~ D-8 (locked architectural decisions) remain in [`AGENTS.md`](../../../AGENTS.md) and have **not** been archived.
> §16 (testing strategy) is **not** archived; see [`AGENTS.md`](../../../AGENTS.md) §16 and [`docs/testing.md`](../../testing.md).
> §18.4 / §18.4.1 (sensitive-field discipline / baseline-read requirement) are preserved in compressed form in `AGENTS.md` §18.
