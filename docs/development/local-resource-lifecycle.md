# 共享开发机资源生命周期

本地机器为多个项目/Agent 共享的 16 GB Mac。稳定性优先于测试速度。

本次不修改 hosted CI workflow；CI 保留原有显式 E2E worker 设置及数据库底座回收模式，监督进程总预算为 70 分钟。本轮数据库登记闭环用于本地入口，不能把 CI 的进程登记归零解释成 CI 数据库归零。

## 启动与关闭

使用 package 入口：`pnpm test`、`pnpm test:e2e`、`pnpm test:contract`、`pnpm test:journeys`、`pnpm agent:check:quick`。它们由 `scripts/local-resource-run.mjs` 监督，固定串行，默认总超时 15 分钟。watch 不受支持；不得用直接 Jest、覆盖配置、修改环境标志绕过监督入口。

macOS 启动前核验 Swap 与 memory_pressure：Swap ≥ 4 GiB、pressure 报的 system-wide free percentage <20%，或读数无法解析时拒绝启动。该压力百分比不等于可用物理内存百分比。没有“强制执行”开关；等待或重启至干净环境后继续，不能停止他人任务。

Ctrl-C、SIGTERM、超时、失败与正常结束走同一个 finally。监督器先回收本轮进程组（包括 pnpm/Jest 孙进程），再回收登记资源，并核验进程组、测试数据库、测试目录及带本轮标识的 D3 psql 会话消失。任何回收/核验失败令运行失败，保留登记与锁供人工判断；不吞掉错误。

## 持久数据与临时资源

现有 u-nest-api-postgres、u-nest-api-starter_postgres_data 为共享持久资源，不能按本仓独占停止/重建/删除。app、app_membersv2_dev、模板 app_test 及未知附件保留。开发 Compose 的 restart 已改为 no；本次未重建或改变现有容器策略。

当前真实测试借用上述持久实例，只创建 worker 临时数据库及目录；不会创建临时 Docker container、network 或 volume。登记只认领启动时不存在的目标；发现已有目标拒绝继续，不自动回收历史残留。D3 w98 也先登记，再获取租约。已有 tmp/storage-w98 需要维护者核实后处理，本任务不删除。

不得直接删除 tmp/storage、备份目录或历史卷。临时资源都必须有稳定 srvf-test/e2e/migration/restore 前缀与 run 归属；未来增加临时 PostgreSQL container 必须 --rm、restart=no，并把真实 container ID 加入登记与验证逻辑后才能接入。未来临时 Compose 必须独立 project 并 finally down；只有本轮临时卷允许 down -v。当前监督器不支持登记 container/Compose/volume，禁止把这些资源直接接到测试后误称已受监督。

## 登记与异常恢复

`tmp/resource-runs/active` 为原子 checkout 运行锁；每次在同目录下建独立 srvf-test-* 登记，含资源名称、容器 ID 和进程 PID，不含凭据。成功核验后删除本轮登记和锁。遇到已有锁直接停止，不根据 PID 不存在就自动删；PID 可复用，锁可能包含尚未回收的数据。

SIGKILL、宿主机重启、kernel panic 无法运行 finally。保留的登记由维护者确认资源归属、使用情况与恢复价值后处理，禁止按通配符自动删除。当前数据库名仍沿用 checkout/worker 派生，所有参与者必须走监督入口；直接调用底座或外部绕过者不受本锁保护。独立开发 worktree 的 storage-wN 位于自己的 checkout。

SRVF_KEEP_TEST_DBS 不会阻止受监督入口的 cleanup。数据库清理绑定登记的 container ID；同名容器被替换时拒绝删库。D3 psql application_name 使用本轮 owner PID；监督进程存活期间该 PID 不会被其他进程复用。仅按该标识终止本轮会话。

## 干净环境最小验收

1. `node --test --test-concurrency=1 scripts/local-resource-run.test.mjs`：无数据库轻量回归。
2. `pnpm test -- test/setup/test-run-scope.spec.ts`：既有底座范围回归。
3. `pnpm agent:check:quick`：串行 lint/typecheck/unit/harness。
4. 维护者核实目标库/目录不存在后，显式设置既有 SRVF_TEST_RUN_SCOPE，只运行一个小型定向真实 E2E。结束查询登记与目标库/目录零残留。
5. 对同一个定向测试分别验证失败、超时、SIGINT、SIGTERM、setup 部分失败；随后确认本轮资源零残留、持久库及卷不变。D3 定向验证还应确认租约会话归零；先解决已存在的 w98 目录，不能自动清历史数据。

不要跑全量本地 E2E。轻量 fake Docker 适配器的通过只证明 cleanup 编排，不代表真实 PostgreSQL、租约或 Docker 验收。

## 本轮验证状态

12 个 Node 轻量测试通过：PASS/FAIL/启动异常/timeout/INT/TERM/孙进程回收/回收失败/checkout 锁/压力拒绝；数据库与会话清理为 fake Docker 适配器。Shell、JavaScript、改动 TypeScript 的语法检查通过。完整 typecheck、lint、既有 Jest 回归、真实 PostgreSQL/D3 中断验证：NOT_RUN。真实 E2E 入口实测被 Swap 保护拦截，未创建数据库或 Docker 资源。
