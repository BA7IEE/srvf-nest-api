# Changelog

本仓库版本号在 `package.json#version` 与 Swagger `setVersion(...)` 同步维护;tag 由维护者按需打。

## Unreleased

### V2 Batch 3 Schema(activities + attendances 共享 schema;2026-05-10)
- `31c8187` chore(prisma): add v2 batch3 activities attendances schema (#9) —
  Activity / ActivityRegistration / AttendanceSheet / AttendanceRecord **4 model** 一次入库
  (共享 schema,3A / 3B PR 不再动 schema)+ User / Organization / Member 9 反向 relation
  (沿批次 1 / 批次 2 R2 范式)+ partial unique index
  `activity_registrations_activity_member_active_unique`
  (`WHERE deleted_at IS NULL AND statusCode != 'cancelled'`,手工 SQL 追加)+
  显式 `@db.Decimal` 注解(`AttendanceRecord.serviceHours / contributionPoints` `Decimal(5,2)`,
  `Activity.locationLongitude / locationLatitude` `Decimal(10,7)`)+ 5 个闭集字典 seed
  (`activity_status` 4 态 / `registration_status` 4 态 / `attendance_sheet_status` 3 态 /
  `attendance_status` 3 态 / `attendance_role` 7 项)+ `activity_type` 2 级树占位(3 父 + 4 子;
  `seedActivityTypeHierarchy`)+ `reset-db.ts` TRUNCATE 顺序更新(孙→子→父依赖)+
  `AuditEvent` union 追加批次 3 8 项(`activity.publish` / `registration.create` /
  `registration.review` / `attendance-sheet.{submit,edit,delete,read.other,review}`)+
  新增 `BusinessEvent` union(`attendance.recorded`;3A 暂不调用,留 3B)

### V2 Batch 3A API(activities + activity-registrations + CSV export;2026-05-11)
- `6a9339b` feat(activities): add v2 batch3A activities and registrations (#10) —
  **17 接口**(activities 7 + registrations 管理端 6 + 队员端 4;
  Q-A3 USER 自助 `POST /api/v2/users/me/activities/:activityId/registration` 与
  ADMIN 代报名 `POST /api/v2/activities/:activityId/registrations` 拆开)+
  **118 e2e**(activities 57 + registrations 61)+
  **13 BizCode**(activities `200xx` 9 个 + registrations `210xx` 4 个;不开 `FORBIDDEN_*`
  模块码;USER 越权一律 404 沿 §1.7 风格)+
  AuditEvent 3 类调用(`activity.publish` / `registration.create` / `registration.review`)+
  Q-A6 CSV 名单导出走 `StreamableFile`(`ResponseInterceptor` 已通过 `instanceof` 自动跳过,
  **未改 interceptor**;默认 `scope=pass` 仅返审核通过 / 可选 `scope=all` 返全部;
  XLSX 直接 400;**不落 export_logs / 不生成 AttendanceRecord;副作用 0**)+
  Q-A12 cancelled Activity 拒改(`update` / `publish` 抛 20030;`delete` 允许,沿 D3)+
  Q-A7 USER + ADMIN `activities` 同路由 service 按 Role 过滤(USER 列表强制
  `statusCode ∈ {published, completed}` 并忽略入参 `statusCode`;USER detail
  draft/cancelled → 404)+ partial unique 防重复报名(`取消后允许重报`)+
  capacity 仅统计 `pass`(`cancelled` 自动释放名额)

### Boundaries / Validation(Unreleased 累计)
- v1 14 接口 + V2 first stage 29 + 批次 1 7 + 批次 2 8 + 批次 3A 17 接口 schema + paths
  **zero drift**;累计 **75 接口** 进入 contract snapshot 保护范围
- 批次 3 schema(commit `31c8187`)已含 4 model + partial unique + 反向 relation;
  3A / 3B 共享同一份 schema,**3A PR 未动 schema / migration / seed / reset-db**
- 3A PR 未引入新依赖(CSV 用手写 `escapeCsvField`,UTF-8 BOM 字节 `EF BB BF` 注入)
- 3A 验收(merge 时本地 + CI 全绿):
  - `pnpm test` unit **452** / 4 suites
  - `pnpm test:e2e` **523** / 29 suites(原 405 + 批次 3A 118)
  - `pnpm test:contract` **136** + 2 snapshots(累计 75 接口 contract zero drift)
  - `pnpm lint` 0 warnings / `pnpm typecheck` PASS / `pnpm build` PASS
  - CI 3 jobs 全绿(Lint/Typecheck/E2E 2m37s + Docker build 2m15s + Container smoke 1m25s)
- **不在 3A 范围**(留 3B 独立 PR 或永久不做):
  - `attendances` 模块所有路由(POST attendance-sheets / GET review-detail / approve /
    reject / edit / delete / `/api/v2/users/me/attendance-records`)
  - `BusinessEvent('attendance.recorded')` 调用(3A 仅在 audit-placeholder 落 union,
    实际触发留 3B)
  - `GET /api/v2/users/me/service-hours`(Q-A5 永久不做,统计留后续数据模块)
  - `PATCH /api/v2/activities/:id/complete`(Q-A11 不实装;`completed` 留字典占位)
  - rejected Sheet "clone for retry" 路径(Q-A4 不实装,前端组装)
  - 独立 `AttendanceRecord` 查询路径(Q-A9 不暴露;通过 Sheet `review-detail` 提供)
  - 220xx / 221xx attendances BizCode 段位(本批次未占用,留 3B 一次性追加)

## v0.3.0 - 2026-05-10

V2 第一阶段在 v0.2.0 基础数据底座之上,完成 SRVF 业务批次 1 + 批次 2,共新增 15 接口
(累计 V2 第一阶段 44 接口),**v1 14 接口 schema + paths 严格 zero drift**。

### V2 Batch 1(member_profiles + emergency_contacts;2026-05-10)
- `dbfca6a` chore(prisma): add batch 1 member profile schema —
  MemberProfile(40 字段,1:1 with Member)+ EmergencyContact(8 字段,N:1)+ 6 个字典 seed
- `5d540ce` feat(v2-batch-1): add member-profiles + emergency-contacts modules (#2) —
  7 接口(3 profile + 4 emergency-contact)+ 57 e2e + 10 BizCode(160xx / 190xx)+ AuditEvent 6 项
- `32b03c8` docs(v2-batch-1): correct stale post-merge claims (#4)

### V2 Batch 2(certificates;2026-05-10)
- `8c86aac` chore(prisma): add v2 batch 2 certificates schema (#5) —
  Certificate(18 字段,N:1 + 3 ON DELETE Restrict FK;状态机闭集 4 态)+ 3 个字典 seed
- `ce56018` feat(certificates): add v2 batch 2 certificates module (#6) —
  8 接口(嵌套子资源 + verify / reject / qualification-flag 动作)+ 66 e2e +
  5 BizCode(180xx / 181xx)+ AuditEvent 10 项
- `74f72b4` docs(v2-batch-2): sync facts after schema + API merge (#7)

### CI / Testing
- `6637733` ci: fix docker smoke compose network name (#3)
- `2fdf1fc` test(e2e): stabilize supertest server lifecycle
- `4f4283d` chore: clean up v0.2.0 release housekeeping

### Docs
- `e68c177` docs: add SRVF business docs pointer

### Boundaries / Validation
- v1 14 接口 + V2 first stage 29 接口 + 批次 1 7 接口 schema + paths **zero drift**
- 全部新接口 ADMIN / SUPER_ADMIN 兜底;**未开放** USER 自助路由
- 软删走 `deletedAt`;禁用 hard delete;FK 全部 ON DELETE Restrict
- DTO 严格白名单 + 全局 `ValidationPipe`(forbidNonWhitelisted)+ 统一响应包装 + `BizException`
- AuditEvent union 严格锁死(批次 1 / 批次 2 共 16 项,含 4 项占位)
- 未实装:attachments / audit_logs 表 / RBAC 表 / 60 天提醒任务 / 自动失效 job /
  applicants / activities / attendances / honors / USER 自助路由
- 验收(release 前 main 上 commit `74f72b4` 全量回归):
  - `pnpm test` unit **387**
  - `pnpm test:e2e` **405** / 27 suites(v1 162 + 批次 1 57 + V2 first stage 120 + 批次 2 66;零退化)
  - `pnpm test:contract` **107 + 2 snapshots**(v1 14 + V2 first stage 29 + 批次 1 7 + 批次 2 8 = 58 接口 contract zero drift)
  - `pnpm lint` 0 warnings / `pnpm typecheck` PASS / `pnpm build` PASS

## v0.2.0 - 2026-05-09

### V2 First Stage (srvf-foundation Step 1-7) — 2026-05-08

V2-D8 第一阶段开发已完成,等待维护者按需 release / tag。基础数据底座 4 模型 + v1 兼容性追加 + auth memberNo 登录回退 全部交付,共 29 个新接口。

#### Schema + Seed(Step 1-2)
- `36c0837` chore(prisma): add V2 foundation schema (4 models + users.memberId)
- `53c9a03` chore(seed): add V2 neutral demo dictionary seeds

#### 业务模块(Step 3-6,共 29 接口)
- `33dbd69` feat(dictionaries) — `dict_types` + `dict_items` 双表 13 接口(父子树形 / 启停 / 软删显式封装)
- `da54cf3` feat(organizations) — 树形 7 接口(单根上限 + last-root 保护 + `nodeTypeCode` 走字典)
- `1baa6c6` feat(members) — `memberNo` 全局唯一不复用 6 接口(严禁敏感字段;`gradeCode` 字典校验)
- `c8bc4fd` feat(auth) — `memberNo` 登录回退(`LoginDto` schema **零漂移**;`PrismaService` 直读 member 表;Timing dummy bcrypt 强制扩展;统一抛 `LOGIN_FAILED` 防账号枚举)
- `54a14e0` feat(member-departments) — 一人一部门 3 接口(partial unique `WHERE deletedAt IS NULL` + PUT 幂等 + 软删旧 + 创建新单事务)

#### V2 第一阶段铁律
- v1 14 接口 schema + paths **严格 zero drift**(`LoginDto` / `LoginResponseDto` / `UserResponseDto` 不变)
- 4 个新模块 schema + paths 在 OpenAPI 快照中锁定(31 schemas + 25 paths)
- 字典 / 组织 / 队员 / 归属 全部走软删显式封装(`notDeletedWhere` helper;详情查询禁 `findUnique`)
- 4 个新 enum status 由 Prisma 控制(`DictTypeStatus` / `DictItemStatus` / `OrganizationStatus` / `MemberStatus`)
- BizCode 4 段位:`110xx` organizations / `120xx` dictionaries / `150xx` members / `170xx` member-departments
- 引用约束 + 软删 全部包在 `prisma.$transaction` 原子完成

#### 验收(Step 7 收口)
- `pnpm lint` / `pnpm typecheck` / `pnpm test`(312)/ `pnpm test:e2e`(24 suites / 282 tests;两次稳定,v1 162 零退化)/ `pnpm test:contract`(78 + 2 snapshots)/ `pnpm build`(首次跑过,`dist/` 生成)
- B 档:`pnpm start:dev` / `/api/docs` 200 / `/api/health/live`/`/ready` 200 + `db: up` / `/api/docs-json` v1 10 + V2 15 paths(dict 7 + org 4 + members 3 + member-dept 1)/ v1 admin 登录 200 / V2 各模块贯通流(GET dict-types / GET org tree / GET members / PUT 部门 / GET 部门 / DELETE 部门)/ SIGTERM 优雅关闭

#### V2.x 复活路径(已延后,不在本阶段)
- `member_profiles` / `attachments` / `audit_logs` / `events` / `event_participants`

#### 不在本阶段范围
- 一人多部门 / `isPrimary` / `joinedAt` / `endedAt` / 进出原因 / 部门变更历史 / RBAC / Redis / 队列 / 文件上传 Provider / LLM / pgvector / 多租户

#### 后续 housekeeping(已记录,非阻塞)
- e2e 间歇性 v1 `auth-login.e2e-spec.ts` `'nonexistentuser'` 收到 HTTP 404 而非 401(LOGIN_FAILED)现象;Step 7 两次重跑稳定 282/282;根因可能是 `ThrottlerStorage` 跨 spec 累计或 NestJS 路由初始化 race;独立 task 跟进
- `ORGANIZATION_ROOT_ALREADY_EXISTS` message 措辞优化候选(当前"活跃根节点" vs 实现 `deletedAt=null` 不区分 status,语义略有歧义)

### Docs
- 模板 freeze 文档收口:`README.md` 顶部新增一行说明,声明 `Template baseline: v0.1.6`、`main` 分支进入 template-freeze 模式(仅允许 docs / CI 触发路径变更),新业务模块应在派生项目(例如 `u-rescue-api`)中开发,不在本模板仓库继续堆叠。中英混排,方便 AI 与开源用户理解
- `docs/docker-smoke-test.md` 标题与开头说明改为 "v0.1.5 首轮手动报告(v0.1.6 已修复其中 logger WARN)",显式声明本文档定位为历史快照、v0.1.6 已修复 §6.1 的 WARN、当前自动化以 `.github/workflows/docker-smoke.yml` 为准并列出最新触发路径。smoke 结果本身一行未动
- `docs/deployment.md` 末尾新增 "Branch protection / required checks" 章节:列出建议的 required checks(`Lint / Typecheck / E2E`、`Docker image build`),说明 Docker Smoke 当前建议 non-required(容器启动级 smoke,受 runner / docker / network 时序影响更高,失败应人工查看而非默认阻塞所有 PR),并给出后续提升为 required 的触发条件(连续观察 ≥4 周无假阳性 / 进入正式生产部署前 / 引入显著放大启动差异的变更)
- `README.md` "常用命令"段补充 `pnpm test`(unit:不启动 Nest、不连数据库)与 `pnpm test:contract`(OpenAPI 契约快照,锁 14 接口 schema)两条护栏命令的简短说明,原"E2E 测试"段重命名为"测试(三档)",`pnpm test:e2e` 与 `pnpm db:test:init` / `pnpm db:test:reset` 的语义保持不变;补齐意图是避免新用户只跑 e2e 而忽略 unit / contract 两层快速反馈。仅 README 文案补充,无 API / Prisma schema / 依赖 / Dockerfile / docker-compose.yml / CI workflow / `src/**` 变更
- `docs/docker-smoke-test.md` §6.1 修正启动期 WARN(`[LegacyRouteConverter] Unsupported route path: "/api/*"`)的根因描述。v0.1.5 报告时初步判断与 Swagger 静态资源 / fallback route 有关,**该判断不准确**;v0.1.6 已定位真实根因为 `nestjs-pino` 的 `LoggerModule.configure()` 默认 `forRoutes: [{ path: '*', method: ALL }]` 与 `app.setGlobalPrefix('/api')` 拼接成 `/api/*`,触发 NestJS 11 + path-to-regexp v8 的 `LegacyRouteConverter`,因为 LoggerModule 注册两个 middleware 所以 WARN 重复一次。已在 `src/bootstrap/logger-options.ts` 中通过显式 `forRoutes: [{ path: '*path', method: RequestMethod.ALL }]` 修复。文档同步更新结论行(§9 摘要)标注"已在 v0.1.6 修复",并指明 v0.1.6 之后 smoke 复测应不再出现该 WARN。仅文档修正,smoke test 结果与判定不变,无 API / Prisma schema / 依赖 / Dockerfile / CI / src 变化

### Changed
- `.github/workflows/docker-smoke.yml` 的 `pull_request.paths` 在原 `Dockerfile` / `package.json` / `pnpm-lock.yaml` / `prisma/**` / 自身之外,先后两次扩展:(1) 增加 `docker-compose.yml`(Docker Smoke workflow 依赖其中的 Postgres service / `container_name: u-nest-api-postgres` / 网络名 `u-nest-api-starter_default`,原 paths 未覆盖会导致 `docker-compose.yml` 变更不触发 smoke);(2) 增加 production boot 敏感路径 `src/main.ts` / `src/app.module.ts` / `src/bootstrap/**` / `src/config/**` / `src/database/**`(Docker Smoke 依赖容器在 production 模式下的真实启动行为:config validation、global prefix、logger 初始化、Prisma graceful shutdown)。**不**纳入整个 `src/**`,业务模块改动仍走 `ci.yml` 的 e2e。该 workflow 仍是 non-required check

### Added
- 新增 `.github/workflows/docker-smoke.yml`,作为对 `docs/docker-smoke-test.md` §7 第二轮自动化的最小落地。独立于 `ci.yml`,触发范围限定 `Dockerfile` / `package.json` / `pnpm-lock.yaml` / `prisma/**` / 该 workflow 自身,只在 `pull_request` 触发,不绑 `push: main`。job 串行覆盖:`docker compose up -d postgres` → 创建独立 `app_smoke` DB → host 侧 `pnpm prisma:generate` / `pnpm prisma:deploy` / `pnpm prisma:seed`(跑两次验证幂等)→ `docker build` 生产镜像 → 以 `APP_ENV=production` + `ENABLE_SWAGGER=false` 启动 app 容器(加入 `u-nest-api-starter_default` 网络,host 端口 `13000` → 容器 `3000`)→ 轮询 `/api/health/live` ready → smoke 检查 `/api/health` `/api/health/live` `/api/health/ready` `/api/docs`(404)`/api/docs-json`(404)、登录正确凭据 / 用户不存在 / 错密码三场景(用户不存在与错密码响应体用 `jq -S | diff` 强制完全一致)、`/api/users/me` 无 token / 带 token(断言不含 `passwordHash`)→ `docker stop -t 10` 后断言 exit code = 0 验证 graceful shutdown。`JWT_SECRET` / `SUPER_ADMIN_PASSWORD` 由 step 内 `openssl rand` 临时生成 + `::add-mask::`,不进 GitHub Secrets。失败时统一 dump `docker ps -a` / app container logs / postgres logs 尾部 / `/tmp/smoke-*.json` 响应体;`if: always()` 清理 app container 与 docker compose。**non-required check**(不进 branch protection),失败不阻塞合并,只作早期告警

### Not changed
- `.github/workflows/ci.yml` / `Dockerfile` / `docker-compose.yml` / `prisma/schema.prisma` / `package.json` / `pnpm-lock.yaml` / `src/**` / `docs/docker-smoke-test.md` 一行未动
- 14 个业务接口路径 / 方法 / 入参 / 出参 / 权限标注 / HTTP status / 错误码 / 响应体格式与 v0.1.6 完全一致
- 依赖版本未变更,未引入新依赖

## v0.1.6 - 2026-05-03

Docker smoke test documentation and startup warning cleanup.

### Added
- 新增 `docs/docker-smoke-test.md`,记录基于 v0.1.5 镜像 (HEAD `0826787`) 的第一轮手动 Docker smoke test:production 模式启动、独立 `app_smoke` DB、`prisma migrate deploy` + `prisma db seed`(幂等)、`/api/health` / `/api/health/live` / `/api/health/ready`、production 下 Swagger 关闭(404)、登录三场景统一错误码、`/api/users/me`、非 root + helmet + 优雅关闭 (exit 0) 全部验证通过。文档同时给出第二轮自动化进 CI 的最小方案建议(独立 `.github/workflows/docker-smoke.yml`,只在影响 Dockerfile / Prisma / lockfile 的 PR 触发,非 required check)

### Fixed
- 启动期消除 `[LegacyRouteConverter] Unsupported route path: "/api/*"` WARN(原本打两次)。根因:`nestjs-pino` 的 `LoggerModule.configure()` 默认 `forRoutes: [{ path: '*', method: ALL }]`,与 `app.setGlobalPrefix('/api')` 拼接后变成 `/api/*`,触发 NestJS 11 / path-to-regexp v8 的 legacy 路由自动转换并 warn(LoggerModule 注册 pino-http + bindLoggerMiddleware 两个 middleware,因此 warn 重复一次)。修复:在 `src/bootstrap/logger-options.ts` 显式声明 `forRoutes: [{ path: '*path', method: RequestMethod.ALL }]`,使用 path-to-regexp v8 命名 wildcard 跳过 legacy 转换路径,与 `LegacyRouteConverter` 错误信息推荐写法一致。语义不变,仍匹配全部以 `/api` 开头的请求;无 API / Prisma schema / 依赖 / Dockerfile / CI 变化

### Not changed
- 14 个业务接口路径 / 方法 / 入参 / 出参 / 权限标注 / HTTP status / 错误码 / 响应体格式与 v0.1.5 完全一致
- `prisma/schema.prisma` 与已存在 migration 不变
- 依赖版本未变更,`pnpm-lock.yaml` 未变化
- Dockerfile / `.github/workflows/ci.yml` / 其他 `src/**/*.ts` 未动

## v0.1.5 - 2026-05-03

V1.4 template maintenance — zero lint warnings, Prisma 7 upgrade evaluation, and prisma.config.ts migration.

V1.4-1 Lint 严格模式 — 不新增功能,不改 API / Prisma schema / 依赖版本;只把 `test/` 中遗留的 128 个 `@typescript-eslint/no-unsafe-argument` warning 收敛到 0,并在 `pnpm lint` 启用 `--max-warnings 0` 严格模式,封堵后续 lint 漂移。

### Added
- 新增 `test/helpers/http-server.ts`,提供 `httpServer(app: INestApplication): App` helper,把 `app.getHttpServer()` 的 `any` 返回值集中收敛为 supertest 的 `App` 类型;test 调用点统一改为 `request(httpServer(app))`,消除 125 处 `no-unsafe-argument` warning

### Changed
- `test/**/*.ts` 中所有 `request(app.getHttpServer())` 调用改为 `request(httpServer(app))`,涉及 19 个 e2e spec、`test/contract/openapi.contract-spec.ts`、`test/fixtures/auth.fixture.ts`、`test/helpers/call-endpoint.ts`
- `Object.keys(res.body.data)` 三处改为 `Object.keys(res.body.data as object)`(`users-me` / `users-admin-crud` / `users-admin-list`),在调用点显式收紧 supertest `Response.body: any` 的类型,消除 4 处 `no-unsafe-argument` warning
- `package.json#scripts.lint` 加上 `--max-warnings 0`,本地与 CI 共用同一入口;`.github/workflows/ci.yml` 的 `Lint` 步骤新增注释说明严格模式来源,避免未来误删 flag
- `docs/v1.3-plan.md` §6 标记 `[done — V1.4-1]`
- V1.4-2 Prisma 7 升级评估:新增 `docs/v1.4-prisma7-evaluation.md`,基于 Prisma 官方升级指南与本仓库源码 / Dockerfile / CI 触点,系统评估 Prisma 6.19.3 → 7.x 的影响面、风险矩阵、推荐升级步骤、回滚方案,以及拆分 PR 建议;结论:**当前不建议升级**(`prisma-client-js` → `prisma-client` generator 迁移会联动改写 Dockerfile §80-§150 的 prod 子集裁剪逻辑,投入产出比低,7.x 仍兼容 deprecated generator);唯一可考虑现在做的最小化收敛是 `package.json#prisma` → `prisma.config.ts` 迁移(独立任务,不在本评估内执行)。本任务**不升级依赖**、不改运行时代码、不动 Dockerfile / CI / Prisma schema
- V1.4-3 Prisma 配置迁移到 `prisma.config.ts`(对应评估文档 §6.1 / §7 PR A):新增 `prisma.config.ts`(`defineConfig({ migrations: { seed: 'tsx prisma/seed.ts' } })`),删除 `package.json#prisma` 配置块;为还原 Prisma CLI 检测到 `prisma.config.ts` 后**关闭**自动 `.env` 加载的副作用,在 config 顶部 `import 'dotenv/config'`(`dotenv` 已是 devDependency,无新增依赖,lockfile 无漂移)。仍在 Prisma 6.19.3,**不升级 prisma / @prisma/client**,**不改 schema.prisma**(datasource / generator 仍是 schema 内事实源),不改 Dockerfile / CI / 运行时代码。验证:`pnpm prisma:generate` / `prisma:deploy` / `prisma:seed`(含幂等)三命令均输出 `Loaded Prisma config from prisma.config.ts.` 并按预期完成

### Not changed
- 14 个业务接口路径 / 方法 / 入参 / 出参 / 权限标注 / HTTP status / 错误码 / 响应体格式与 v0.1.4 完全一致
- `prisma/schema.prisma` 与已存在 migration 不变
- 依赖版本未变更(未升级 Prisma 6 → 7,未引入新依赖)
- `pnpm-lock.yaml` 未变化(V1.4-3 使用的 `dotenv` 已是 devDependency)
- 业务模块未新增,RBAC / refresh token / 文件上传 Provider 仍未实现
- `eslint.config.mjs` 规则未调整(未对 `test/**/*.ts` 关闭 `no-unsafe-argument`,而是从源头补类型)
- Prisma Client generator 仍是 `prisma-client-js`(deprecated 但兼容,未迁到 `prisma-client`)
- Dockerfile / `.github/workflows/ci.yml` / `src/**/*.ts` / `prisma/seed.ts` 一行未动

## v0.1.4 - 2026-05-03

V1.3 Contract Hardening — 不新增业务功能,不修改 API 响应格式,不改 Prisma schema;只把"模板的契约面"(API schema、错误码 ↔ HTTP status、权限策略)从"E2E 顺带覆盖"升级为"独立断言 + 自动化 CI 护栏"。

V1.3 子任务一览:

- **V1.3-1** users.policy 单测矩阵(3×3 角色 × 4 函数 = 36 个判定点),`UsersService.findOne()` 拆出 `canViewUser` 语义
- **V1.3-2** BizCode 元属性单测断言(key 命名 / code 段位 / message / httpStatus 全量遍历)
- **V1.3-3** OpenAPI 快照测试(14 路由白名单 + 11 核心 DTO + `paths` / `components.schemas` 两段快照)
- **V1.3-4** 错误响应 Swagger schema 显式化(`ApiBizErrorResponse` 装饰器 + 14 路由错误码 schema 全量补全)
- **V1.3-5** CI 跑 unit + contract tests(`pnpm test` / `pnpm test:contract` 进 `Lint / Typecheck / E2E` job)

### Added
- V1.3-1 Contract Hardening:新增 `src/modules/users/users.policy.spec.ts`,以 `it.each` 表格化覆盖 `canViewUser` / `canManageUser` / `canCreateRole` / `canChangeRole` 的 3×3 角色矩阵(36 个判定点)
- 新增 `test/jest-unit.config.ts` 与 `pnpm test` 脚本(只跑 `src/**/*.spec.ts`,不启动 NestJS / 不连库),与 `pnpm test:e2e` 解耦
- `tsconfig.json` 排除 `src/**/*.spec.ts`,避免 spec 文件被 `nest build` 打入 `dist/`
- V1.3-2 Contract Hardening:新增 `src/common/exceptions/biz-code.constant.spec.ts`,`Object.entries(BizCode)` 遍历断言每个条目的 key(大写 SNAKE_CASE)、`code`(正整数 + 全局唯一 + 落在已分段范围内)、`message`(非空 string + 已 trim)、`httpStatus`(合法 `HttpStatus` 枚举值);避免新增 BizCode 漏掉基本约束
- V1.3-3 Contract Hardening:新增 `test/contract/openapi.contract-spec.ts` + Jest 原生快照,从 `/api/docs-json` 抓取 OpenAPI v3 文档并锁定:14 个业务接口 + 3 个健康检查 + auth/login 共 14 条路由的存在性、HTTP 方法集合与白名单一致(防漏增 / 漏删)、核心 11 个 DTO schema 仍存在、`paths` 与 `components.schemas` 两段快照保护字段级漂移
- 新增 `test/jest-contract.config.ts` 与 `pnpm test:contract` 脚本(复用 e2e 的 globalSetup,串行执行,与 `pnpm test:e2e` 解耦),首次快照已入 git;后续 schema 变更需显式 `pnpm test:contract -u` 在 PR diff 中 review
- V1.3-4 Contract Hardening:新增 `ApiBizErrorResponse(...bizCodes)` 装饰器(`src/common/decorators/api-response.decorator.ts`),按 `httpStatus` 自动分组、合并相同 status 下的多个业务码到一条 `@ApiResponse`,响应 schema 结构与 `AllExceptionsFilter` 真实输出 `{ code, message, data: null }` 一致,`code.enum` 列出全部可能业务码、`description` 列出每个 code 的语义
- 给所有 controller 方法补全错误响应 Swagger 装饰器:`auth/login`(400/401/429,替换原裸 `@ApiResponse`)、`health/ready`(500)、`users/me` 系列(401 / 400)、`users` 管理系列(覆盖 400/401/403/404/409 + `FORBIDDEN_ROLE_OPERATION`/`CANNOT_OPERATE_SELF`/`LAST_SUPER_ADMIN_PROTECTED`/`USER_NOT_FOUND`/`USERNAME_ALREADY_EXISTS`/`EMAIL_ALREADY_EXISTS` 等业务码)
- 同步刷新 `test/contract/__snapshots__/openapi.contract-spec.ts.snap`,新增的错误响应 schema 进入快照保护范围
- V1.3-5 Contract Hardening:`.github/workflows/ci.yml` 在 `Lint / Typecheck / E2E` job 内新增 `Run unit tests`(`pnpm test`)与 `Run contract tests`(`pnpm test:contract`)两步,顺序为 lint → typecheck → build → db setup → prisma:deploy → unit → contract → e2e。补全 V1.3-1(`users.policy.spec.ts`)/ V1.3-2(`biz-code.constant.spec.ts`)/ V1.3-3 + V1.3-4(OpenAPI 契约快照含错误响应 schema)在 CI 内的真实护栏覆盖

### Changed
- 同步项目版本号到 `0.1.4`(`package.json#version` + Swagger `setVersion('0.1.4')`)
- `UsersService.findOne()` 改为通过新增的 `assertCanViewUser` 走 `canViewUser` 策略;管理 / 删除 / 重置密码 / 改角色 / 改状态等"修改类"操作继续走 `canManageUser`。当前两者判定相同,仅区分语义,API 行为不变

### Not changed
- 14 个业务接口路径 / 方法 / 入参 / 出参 / 权限标注 / HTTP status / 错误码 / 响应体格式与 v0.1.3 完全一致
- `prisma/schema.prisma` 与已存在 migration 不变
- 业务模块未新增,RBAC / refresh token / 文件上传 Provider 仍未实现

## v0.1.3 - 2026-05-03

V1.2 模板收敛 — 不新增业务功能,不修改 API 响应格式,不做破坏性数据库变更;只提升长期可维护性、AI 二开稳定性和文档可读性。

### Changed
- 同步项目版本号到 `0.1.3`(`package.json#version`、Swagger `setVersion('0.1.3')`)
- 拆分 `src/app.module.ts`:logger / request-id / throttle 配置抽到 `src/bootstrap/`(`logger-options.ts` / `request-id.ts` / `throttle-options.ts`),`AppModule` 仅保留模块注册与全局 Guard 注册
- 新增 `src/modules/users/users.policy.ts`:集中 `canViewUser` / `canManageUser` / `canCreateRole` / `canChangeRole` 4 个纯函数;`UsersService` 不再散落角色判断,SUPER_ADMIN 结构性不变式(自我保护、最后一个 SUPER_ADMIN 保护)仍由 service 内事务保障
- 拆分 `README.md`:复杂内容迁移到 `docs/development.md` / `docs/testing.md` / `docs/deployment.md` / `docs/security.md`,`README.md` 仅保留项目定位、快速启动、路由总览、常用命令、文档入口
- `docs/security.md` 显式记录:当前版本支持软删除但不提供 restore 接口、误删恢复需 DBA 人工处理、未来 restore 接口契约预定义为 `PATCH /api/users/:id/restore`(仅 SUPER_ADMIN);token 吊销不实现 refresh token / Redis blacklist,仅记录未来 `tokenVersion` 升级路径
- 新增 `FINAL_REPORT.md`:本轮变更文件 / 原因 / 验收 / 遗留风险 / 建议 commit 命令
- 新增 `docs/v1.3-plan.md`:V1.3 Contract Hardening Plan(仅文档,不执行)

### Not changed
- API 响应格式、HTTP status、错误码、Swagger schema 与 v0.1.2 完全一致
- `prisma/schema.prisma` 与已存在 migration 不变
- 14 个业务接口路径 / 方法 / 入参 / 出参 / 权限标注与 v0.1.2 完全一致
- `.env.example` / `Dockerfile` / `.dockerignore` / `docker-compose.yml` / `.github/workflows/` 未触碰
- E2E 全量 19 spec / 162 用例继续通过(本机 ~15.6s)

## v0.1.2 - 2026-05-03

V1.1.1 工程收口修补 — 不引入新业务,不重构架构,只对 V1.1 之后暴露的版本一致性、生产迁移命令、CI 闭环、lint/typecheck 覆盖范围、README 残留表述做最小修补,并作为 patch release 正式发布。

### Fixed
- 同步项目版本号到 `0.1.2`(`package.json#version`、Swagger `setVersion('0.1.2')`),与本次 `v0.1.2` patch release 对齐
- 新增 `pnpm prisma:deploy` 脚本,作为生产数据库迁移固定入口(等价 `prisma migrate deploy`);保留 `pnpm prisma:migrate` 作为开发态入口
- CI 在 `typecheck` 之后、E2E 之前新增 `pnpm build` 步骤,显式验证 `tsconfig.build.json` 与 nest 构建产物链路
- CI 新增独立 `docker-build` job,验证多阶段 `Dockerfile` 在 CI 环境可成功构建出生产镜像(不做容器启动 / smoke test)
- CI 在数据库初始化之后、E2E 之前显式跑一次 `pnpm prisma:deploy`,验证生产迁移命令可执行(已迁移环境下为 no-op)
- `pnpm lint` 覆盖范围扩展为 `src/**/*.ts` + `test/**/*.ts` + `prisma/**/*.ts`
- `pnpm typecheck` 在原有 `tsconfig.json` 基础上追加 `test/tsconfig.test.json`,让测试代码也进入类型检查
- ESLint 显式 `project` 列表覆盖 `src` / `test` / `prisma` 三处源码;新增 `prisma/tsconfig.eslint.json` 仅供 ESLint 解析使用,不进入运行时构建链路;规则写入 `ARCHITECTURE.md` §11.7
- README 修正 V1.1 之后已不再准确的表述(Docker 用途、生产迁移策略、`prisma:deploy` 入口、runner 镜像不含 Prisma CLI 的说明)
- 新增 `CHANGELOG.md` 跟踪发布历史

## v0.1.1

- V1.1 engineering hardening
- Added GitHub Actions CI(lint / typecheck / E2E,基于 `docker compose` 启动 `postgres:16-alpine`)
- Added 多阶段 Dockerfile(`deps` → `builder` → `runner`,`node:22-alpine`,以非 root 用户运行)
- 接入结构化日志(`nestjs-pino`)与请求 ID(`x-request-id`,`cuid()` 兜底生成),敏感字段日志显示为 `[REDACTED]`
- 优雅关闭(`app.enableShutdownHooks()` + `PrismaService.onModuleDestroy()`)
- 健康检查分层(`/api/health` / `/api/health/live` / `/api/health/ready`,基于 `@nestjs/terminus`)
- helmet HTTP 安全头(Swagger UI 局部禁用 CSP)
- 登录接口限流(`@nestjs/throttler` 内存 storage,默认 IP 维度 5 次 / 60 秒)
- 扩展 E2E 覆盖(当前 19 spec / 162 用例)

## v0.1.0

- v1 基础闭环:NestJS + Prisma + PostgreSQL + Docker Compose + Swagger + JWT 登录 + 用户 CRUD + 简单角色权限 + 统一异常与返回格式
