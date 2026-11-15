# 测试纪律(reference · 触碰才读)

> 按需细则；协作规则见根 [AGENTS.md](../../AGENTS.md)。历史来源保存在 `harness-v3-final` 标签。
> 机器锁定:CI 全量(agent:check:full)。

## 16. 测试策略

- v1 初始搭建不强制 E2E,不阻塞骨架
- `auth` / `users` 稳定后优先引入 E2E
- E2E 必须断言统一响应格式;错误响应必须**同时断言 HTTP status code 与 `BizCode.httpStatus` 一致**
- 登录失败必须覆盖**防账号枚举四场景**(`username` 不存在 / `password` 错 / 已禁用 / 已软删除),响应体与 HTTP status 完全相同
- E2E 优先覆盖:登录、JWT 鉴权、用户 CRUD、角色边界、软删除、禁用用户、最后一个 SUPER_ADMIN 保护、唯一约束冲突

## 16.1 并行纪律(Harness 3.0 P1;约束收紧,非放宽)

- **查 `pg_locks` / `pg_stat_activity` 必须按当前库或自身 pid 收敛**(`AND datname = current_database()` / `AND lock.database = (SELECT oid FROM pg_database WHERE datname = current_database())` / `pid = pg_backend_pid()`)。这两个是实例级视图；模板克隆的 worker 库可有相同表 OID，不收敛会把其他 worker 的锁当成自己的屏障。旧 harness 静态自测已退役，新增并发测试须验证此隔离条件。
- 新 e2e **不得依赖跨 spec 残留状态**(每 spec 自建 fixture;resetDb 是全库擦除,并行下顺序不可预期)
- **不得写入固定共享路径**:本地文件走 config 的 `storage.localRoot`(已按 worker 派生 `tmp/storage-w<N>`)或 `mkdtemp(os.tmpdir())`
- **不得在 spec 内 inline 破坏性 SQL 打非当前库**;`docker exec psql -d <库>` 类操作必须用 `deriveTestDbName()` 定位本 worker 库
- afterAll 必须 `app.close()`(纪律不变;检测由 `test:e2e:leaks` 串行线承接,禁 `forceExit`)
