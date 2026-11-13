# 本地资源审计与生命周期治理方案

2026-10-02，Asia/Shanghai。状态：调查与方案，尚未实施治理。未停止、删除任何资源。此报告不是完整验收：已读取主要运行入口、公共测试底座及定向迁移测试；尚未逐行覆盖全部测试、迁移和业务运行代码。

## 当前资源

全机快照：256 containers，8 running，248 stopped，333 volumes，26 networks，38 个不同 image ID。Compose ls 返回 4 个项目；不代表全部历史 Compose 资源。其他 Agent 正在工作，数量会变化。

本仓可确认独占的容器、卷、网络：未发现。明确使用但不能认定独占的资源：

|资源|现状与识别依据|分类|
|---|---|---|
|u-nest-api-postgres，b9eaed5415e4|postgres:16-alpine；创建 2026-09-28T04:04:11Z；本次启动 2026-10-02T12:52:05Z；运行；restart=no；宿主 IPv4/IPv6 5432|A/E：持久开发、共享归属待确认|
|u-nest-api-starter_postgres_data|上述容器挂载到 /var/lib/postgresql/data；Compose 标签 project=u-nest-api-starter、volume=postgres_data|A：保留；删除会丢数据库|
|u-nest-api-starter_default|Compose 网络，上述容器正在连接|A/E：保留|
|postgres:16-alpine，721873c34ceb|约 412 MB，上述容器使用|B：可重新拉取，但共享，保留|
|app、app_membersv2_dev|约 21 MB、11 MB，查询时无连接|A/E：用途及恢复能力待确认|
|app_test|约 24 MB，测试底座保留的模板库|A：保留|
|app_test*_wN|底座派生 worker 库；查询时没有这些库|C：正常结束应删除，当前不存在不证明异常退出无泄漏|
|dist、node_modules/.cache|约 25 MB、904 KB|B：可构建/生成，本轮不删|
|tmp/storage|含 recruitment、身份证 portrait/crop、attachments 目录|E：可能含真实开发附件，不可按 tmp 名删除|
|tmp/storage-w98|有 attachments 子目录|C/E：疑似测试残留，未逐文件确认，不删|
|tmp/wiki-gen/backup、tmp/check|备份、检查日志|E/B：可能有恢复或失败证据，保留|

整个 tmp 约 87 MB。卷内部路径为 /var/lib/docker/volumes/u-nest-api-starter_postgres_data/_data，位于 Docker/OrbStack 数据存储内，并非仓库目录。

容器全部 Compose 标签中的工作目录与配置指向 `/Users/dengwang/Documents/VibeCoding/u-nest-api-starter`，服务 postgres，project=u-nest-api-starter。本仓声明 project=srvf-nest-api，却沿用同一个 container_name。这是需要维护者认领的归属差异，不能直接 compose up 重建、改名或 down -v。

lsof cwd 快照约 37 个候选进程，主要为 Codex/MCP 辅助进程，也包含共享 OrbStack 和审计自身。cwd 不等于所有权。监听快照未发现可确认的本仓 API/worker；5432 为共享容器，9222 为共享 Chrome。进程即时退出导致一次 ps 读取失败，不能报成稳定数量或零残留。未发现本仓使用 Playwright、MySQL、Redis 的直接依赖；这不代表全机没有。

## 必须保留与清理决策

保留上述共享数据库、卷、网络、开发库、模板库、未知附件和备份。没有证据充分、可由本仓单独停止或删除的现有 Docker 资源。D 类历史残留：没有足够证据认领条目。其他项目容器、卷、网络、镜像全部不动；包括 dangling image，也不能以标签为空认定安全。

共享容器需要重启时，先确认其他使用者，再用 docker start u-nest-api-postgres；不要用本仓 Compose 替换旧配置。备份方案是维护者逐库认领后 pg_dump 自定义格式，另保存角色信息，核验退出码与文件，在隔离临时实例做 pg_restore 验证。当前未制作或验证备份，不能承诺可恢复。

## 生命周期缺口与证据

- scripts/check-quick.sh:29–45：四组后台任务并发，固定 tmp/check 日志，没有 trap 或进程树回收。中断时无显式回收保证，同 checkout 并发可能覆盖日志；未现场制造 orphan。
- test/setup/global-setup.ts:65–90：逐个建 worker 库，没有创建阶段失败补偿；旧 storage 只在下一轮开跑时删。第 N 个创建失败可能留下前面库。
- test/setup/global-teardown.ts:6–9、22–25：代码明确承认崩溃/Ctrl-C 会残留；逐项删除首次失败会跳过后续；没有结束时清本轮存储。下次同名重建不等于本次零残留。
- test/jest-e2e.config.ts:7：默认按 CPU 核数，最多 8 worker；环境变量可扩大。global-setup.ts:52 接受至 99 worker。没有共享机内存预算检查。
- test/jest-unit.config.ts：无项目 maxWorkers 上限；quick 使用 50% 并与其他检查并发。
- docker-compose.yml:13：配置 restart=unless-stopped；当前实机容器 restart=no。重建后存在随引擎启动的风险，不能说当前容器正在自动重启。
- test/e2e/activity-os-r5-e3-d3-signature-migration.e2e-spec.ts:70–124 与 activity-os-r5-e3-d3-reconciliation.e2e-spec.ts:19–73：docker exec -i psql 长驻租约子进程，有获取超时和正常 afterAll/finally 释放。kill 宿主 Docker CLI 不证明容器内 psql 消失；中断和释放超时须实测，暂列风险，不定性已泄漏。

已有保障：checkout 派生 worker 名、目标库校验、重建前连接检查、journey 默认串行、迁移临时目录 finally、D3 afterAll finally；不能为了格式重写正确路径。Docker smoke CI 有 always cleanup，但吞清理错误，未验证零残留。其他 CI 未搜到显式 compose down，托管 runner 生命周期不能等同本机长期泄漏。

## 风险

sysctl vm.swapusage：总 7168 MiB，使用 6486.19 MiB，剩余 681.81 MiB。memory_pressure 报 system-wide free percentage 41%；不能解释成可用物理内存 41% 或无压力。本轮不启动重型测试，也不能仅凭快照归因 watchdog panic。

主要风险：共享库误删、tmp 附件误删、固定容器名及 5432 冲突、quick 多任务叠加、worker 异常退出残留。同 checkout 的连接检查不等于原子运行锁；预检和创建间仍可能竞态。峰值内存未测。

## 推荐实施包（待红区授权）

方案 A：保留现有共享持久库，先治理本仓入口、临时数据库/目录与子进程。方案 B：新建本仓独立持久库，备份恢复验证后迁移全部引用；当前不推荐直接做 B。回退为逐文件撤销本任务改动，现有数据不迁移、不删除。

预期写集：

- docker-compose.yml：本地 restart=no，名称和卷迁移暂不做。
- scripts/check-quick.sh：默认串行、单 worker；独立 run 日志；EXIT/INT/TERM 回收本轮进程树，保留原退出码。
- test/jest-unit.config.ts、test/jest-e2e.config.ts：本地默认 1 worker，保留 CI 显式 2 worker，验证参数。
- test/setup/global-setup.ts、test/setup/global-teardown.ts：本轮登记、部分失败补偿、逐项清理并汇总错误、仅清本轮临时存储。
- 新 scripts/local-resource-run.ts 与 package.json：统一监督入口、同 checkout 锁、总超时、内存/Swap 预检、零残留检查，防止直接入口绕过。
- 新生命周期测试：部分 setup、失败、timeout、INT/TERM、cleanup 失败、并发冲突；断言不影响他人资源，不改既有业务断言。
- README.md、docs/development/local-resource-lifecycle.md：长期操作规范与入口。
- .github/workflows/ci.yml、nightly-e2e-leaks.yml、docker-smoke.yml：显式 always cleanup、清理失败报告；CI 改动按 D 档立项。

现有授权理由属于历史 E3 任务，不能继承。Compose、检查脚本、Jest 配置、package、test/setup、workflows 属于红区，必须维护者亲自 harness:grant。本轮未自行授权。实施前还须读取 testing-discipline，按 CI 修改完成 D 档流程。

目标链路：压力预检/运行锁 → 登记本轮目标 → 创建 → 有界执行 → PASS/FAIL/exception/timeout/INT/TERM 统一清理 → 检查本轮库/目录/子进程零残留 → 清理失败令运行失败并留证据。

SIGKILL、重启、kernel panic 无法由 trap/finally 捕获；通过持久运行登记与下次启动检查补偿，核实 owner 与无人使用后再回收。不能承诺任意中断均当场清净。临时资源必须稳定 srvf-test/e2e/migration/restore 前缀、run 标签、restart=no；临时 Compose down -v 只能针对本轮独立 project。持久卷不得进入清理清单。

## 本次未做

停止、删除、prune、备份恢复、migration、故障注入、重型测试、代码治理、红区自授权、生产配置修改、其他项目修改、PR/合并。未完成全部运行相关文件逐项覆盖及修复验收，不能称完整治理已完成。
