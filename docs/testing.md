# 测试指南

E2E 跑在独立的 `app_test` 物理库,与开发库 `app` 完全隔离,**不污染开发数据**。配置由 [`.env.test`](../.env.test) 驱动,Jest globalSetup 与 setupFiles 双层加载并强制 `override: true`,防止 shell 中已 export 的 `DATABASE_URL` 误打开发库。

> 测试数量属于高频变化信息。本文不维护固定 spec / case 总数;
> 当前数量以 `find test/e2e -name '*.ts'`、`pnpm test:e2e` 输出末尾汇总、CI 结果,以及 [`docs/current-state.md`](current-state.md) §2 "测试与契约" 段为准。

E2E **并行执行**(Harness 3.0 P1;默认 `maxWorkers: 50%`,CI 由 `JEST_MAX_WORKERS` 显式指定),并行安全由三层隔离保证:

1. **per-worker 派生测试库**:globalSetup 对模板库(主仓 `app_test`;linked worktree `app_test_<slug>_<hash6>`)migrate deploy 一次,再按 `CREATE DATABASE ... TEMPLATE` 克隆出 `<模板名>_w<N>`,每个 jest worker 连自己的克隆库;globalTeardown 回收克隆库、保留模板。孤儿库用 `pnpm db:test:prune` 按 git worktree 白名单差集回收(默认 dry-run,`--force` 才删)。
2. **per-worker 本地存储目录**:`tmp/storage-w<N>`(setup-files 派生),attachment/content 类 spec 的文件断言互不干扰。
3. **显式连接预算**:`.env.test` 的 `connection_limit=5&pool_timeout=20` + Postgres `max_connections=200`。

**句柄泄漏检测**(原 `detectOpenHandles` 与并行互斥,已分两条线;**禁 `forceExit`、afterAll 必须 `app.close()` 的纪律不变**):

| 线 | 何时跑 | 判据 | 性质 |
|---|---|---|---|
| 并行主线(`ci.yml` slow job) | 每个 PR | grep `A worker process has failed to exit gracefully` | **告警注解**,不阻塞 |
| 串行线(`nightly-e2e-leaks.yml` / 本地 `pnpm test:e2e:leaks`) | 每日 02:00 + 手动 | grep `Jest has detected the following ... open handle` + 超时兜底 | **硬失败**(权威判据) |
| ↑ 同上,**按域 2 分片**(2026-08-19 起) | 同上 | 逐片各判各报;另加「实收 suite 数 == 清单预算数」防静默漏跑 | **任一片红 ⇒ 整条线红** |

为什么夜间线要分片(2026-08-19,issue #1080):套件长到 290 个 spec 后,单进程串行跑满 75m 内层上限仍未跑完(08-17 那晚是贴着线过的:4345s / 4500s,余量 3.1%)。历次「放宽 timeout」只是还利息,故改按**域**切两片(`scripts/e2e-shard-plan.mjs`),同域 spec 仍连续跑在同一进程里 —— 这一点是刻意的:`--detectOpenHandles` 的价值就在单进程连续跑时能看见 spec 之间累积出来的句柄,`jest --shard` 那种哈希均分会把同族泄漏的两端拆散。片数取 2 而非 3/4:activity 族单族是不可再分的地板(按 2026-08-19 实测反推约 23 分钟,而 3 片的均分目标才 19 分钟),切更细省不下多少时间却持续削弱检出能力。实测两片 32分41秒 / 25分7秒,墙钟 33 分钟。**保住**:单 spec 泄漏(100%,每个 spec 都在某片进程内被检)与同域跨 spec 泄漏;**放弃**:跨域跨 spec 交互泄漏,以及整套内存累积→OOM 的灵敏度(每片只累积约一半)——怀疑内存累积时,手动跑一次不带 `--testPathPatterns` 的全量串行才是权威判据。

为什么主线只给告警:2026-07-28 实测,本仓并行跑**恒**打出 worker 强杀警告,而同一套件串行 + `detectOpenHandles` 跑完(1641s,195/195 绿)**零个开放句柄报告** —— 该警告的来源是 jest worker 关闭时序(Prisma 引擎子进程等),基线即非零,设成硬失败会让 CI 永久红且毫无鉴别力。真正的泄漏判据因此放在夜间串行线(当前基线干净,任何新增句柄都会让它变红)。

**新 e2e 并行纪律**(约束收紧,非放宽):不得依赖跨 spec 残留状态;不得写入固定共享路径(用 config 的 `localRoot` 或 `mkdtemp`);查 `pg_locks` / `pg_stat_activity` 必须按当前库或自身 pid 收敛(见 [`testing-discipline §16.1`](reference/testing-discipline.md));不得在 spec 内 inline 破坏性 SQL 打非当前库;不要同时跑两条 jest 命令(`test:e2e` 与 `test:contract` 争抢 `_w1` 克隆库 —— 现在会**明确报错**而非静默互擦)。

**跑 e2e 时不要并发跑其他重负载**(另一个 jest、`agent:check:quick`、大型构建):每个 worker 都要启动完整 Nest app,CPU 争抢会把 `beforeAll` 顶到 30s `testTimeout` 之上,表现为一批 suite 集体超时(**不是** flaky 断言,也**不应**靠抬 testTimeout 掩盖 —— 那会同时掩盖真实性能回归)。若确实需要在低配机器上跑,降并发:`JEST_MAX_WORKERS=2 pnpm test:e2e`。排查失败时用 `SRVF_KEEP_TEST_DBS=1` 保留 worker 库验尸。

---

## 准备与运行

```bash
# 1. 起 PostgreSQL 容器(若尚未起)
docker compose up -d

# 2. 首次跑测试前,创建 app_test 库(幂等,已存在则跳过)
pnpm db:test:init

# 3. 跑 E2E(并行;单 spec:pnpm test:e2e -- <spec名>,位置参数是路径 pattern)
pnpm test:e2e

# 只重跑上次失败的 suite(串行,消除并行噪声;依赖 jest cache)
pnpm test:e2e:failed

# 串行 + 句柄泄漏检测(夜间 CI 同款;发版前可手动跑)
pnpm test:e2e:leaks

# watch 模式
pnpm test:e2e:watch

# 出现脏数据时重置模板库(护栏:DATABASE_URL 不含 'app_test' 拒绝执行)
pnpm db:test:reset

# 回收孤儿派生库(默认 dry-run;--force 执行删除)
pnpm db:test:prune
```

任何破坏性操作(`TRUNCATE`、`prisma migrate deploy`、`prisma migrate reset`)在执行前都会断言 `DATABASE_URL` 包含 `app_test` 子串,不通过立即抛错。详见 [`test/setup/test-db.ts`](../test/setup/test-db.ts)。

---

## 覆盖范围一览

> 下表为早期代表性 spec 列举(v0.7 / v0.8 时代锁定),**非全集**;当前完整 spec 清单以 `find test/e2e -name '*.ts'` 实际输出为准。

| spec 文件 | 覆盖内容 |
|---|---|
| [`health`](../test/e2e/health.e2e-spec.ts) | 健康检查响应包装 |
| [`response-format`](../test/e2e/response-format.e2e-spec.ts) / [`swagger`](../test/e2e/swagger.e2e-spec.ts) / [`bizcode-http-status`](../test/e2e/bizcode-http-status.e2e-spec.ts) | 横切:统一响应格式 / Swagger 跳过包装 / BizCode httpStatus 一致性 |
| [`auth-login`](../test/e2e/auth-login.e2e-spec.ts) / [`auth-jwt-guard`](../test/e2e/auth-jwt-guard.e2e-spec.ts) | 登录正反路径(含防账号枚举四场景一致性)+ JWT 鉴权失效全部分支 |
| [`app-me`](../test/e2e/app-me.e2e-spec.ts) / [`app-me-password`](../test/e2e/app-me-password.e2e-spec.ts) | App 本人接口 `/api/app/v1/me*`(资料白名单 + 本人改密铁律;Route B Phase 4 删除 `/api/users/me*` 后,原 `users-me` spec 由此二者承接) |
| [`users-admin-list`](../test/e2e/users-admin-list.e2e-spec.ts) / [`users-admin-crud`](../test/e2e/users-admin-crud.e2e-spec.ts) / [`users-role-boundary`](../test/e2e/users-role-boundary.e2e-spec.ts) | 管理接口分页 / CRUD 基础路径 / 跨角色边界 |
| [`users-self-protection`](../test/e2e/users-self-protection.e2e-spec.ts) / [`users-last-super-admin`](../test/e2e/users-last-super-admin.e2e-spec.ts) / [`users-soft-delete`](../test/e2e/users-soft-delete.e2e-spec.ts) / [`users-password-reset`](../test/e2e/users-password-reset.e2e-spec.ts) | 自我保护 / SUPER_ADMIN 互操作正向回归 / 软删副作用矩阵 / 密码重置完整流程 |
| [`seed`](../test/e2e/seed.e2e-spec.ts) | `prisma/seed.ts` 子进程行为 + production 强校验 |

---

## 编写新 E2E 的约束

- E2E 必须断言统一响应格式;错误响应必须**同时断言 HTTP status code 与 `BizCode.httpStatus` 一致**
- 登录失败必须覆盖防账号枚举四场景(`username` 不存在 / `password` 错 / 已禁用 / 已软删除),响应体与 HTTP status 完全相同
- 任何破坏性 SQL 与 migration 命令统一通过 [`test/setup/test-db.ts`](../test/setup/test-db.ts) 调度,禁止在 spec 内 inline 执行,以保证 `app_test` 子串护栏始终命中

详见 [`reference/testing-discipline.md`](reference/testing-discipline.md)(承接 harness-v1 `AGENTS.md §16`)。
