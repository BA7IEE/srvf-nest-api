# 测试纪律(reference · 触碰才读)

> Harness 2.0 细则层:承接 harness v1 `AGENTS.md` §16 **原文逐字搬家(零放宽;唯一机械改写=相对链接前缀)**;恒读入口与速查见根 [`AGENTS.md`](../../AGENTS.md),原文快照 [`archive/harness-v1/AGENTS.md`](../archive/harness-v1/AGENTS.md)。
> 机器锁定:CI 全量(agent:check:full)。

## 16. 测试策略

- v1 初始搭建不强制 E2E,不阻塞骨架
- `auth` / `users` 稳定后优先引入 E2E
- E2E 必须断言统一响应格式;错误响应必须**同时断言 HTTP status code 与 `BizCode.httpStatus` 一致**
- 登录失败必须覆盖**防账号枚举四场景**(`username` 不存在 / `password` 错 / 已禁用 / 已软删除),响应体与 HTTP status 完全相同
- E2E 优先覆盖:登录、JWT 鉴权、用户 CRUD、角色边界、软删除、禁用用户、最后一个 SUPER_ADMIN 保护、唯一约束冲突

## 16.1 并行纪律(Harness 3.0 P1;约束收紧,非放宽)

- **查 `pg_locks` / `pg_stat_activity` 必须按当前库或自身 pid 收敛**(`AND datname = current_database()` / `AND lock.database = (SELECT oid FROM pg_database WHERE datname = current_database())` / `pid = pg_backend_pid()`)。理由:这两个是**实例级**视图,而 per-worker 测试库由 `CREATE DATABASE ... TEMPLATE` 克隆,各 worker 库里同一张表的 `pg_class.oid` **完全相同** —— 不收敛的并发屏障会把别的 worker 的锁计入,提前放行、把真并发测试悄悄降级成串行(假绿)。由 `scripts/harness-guards.selftest.ts` 静态守护
- 新 e2e **不得依赖跨 spec 残留状态**(每 spec 自建 fixture;resetDb 是全库擦除,并行下顺序不可预期)
- **不得写入固定共享路径**:本地文件走 config 的 `storage.localRoot`(已按 worker 派生 `tmp/storage-w<N>`)或 `mkdtemp(os.tmpdir())`
- **不得在 spec 内 inline 破坏性 SQL 打非当前库**;`docker exec psql -d <库>` 类操作必须用 `deriveTestDbName()` 定位本 worker 库
- afterAll 必须 `app.close()`(纪律不变;检测由 `test:e2e:leaks` 串行线承接,禁 `forceExit`)

