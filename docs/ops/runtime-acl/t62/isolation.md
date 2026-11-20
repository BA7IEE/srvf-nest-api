# T62 隔离自测回执

**普通身份下的结算过账链未通过。** 本次用固定三包，在一个 Docker internal 网络内启动 HTTPS 入口、API、单个 Worker 和独立 PostgreSQL，全程无发布端口。静态挂载分别为 Admin `/`、H5 `/h5/`，同源 `/api/` 转发到导入的 API 镜像。只信入口的 /32 地址，入口覆盖客户端来源头。在另一个容器内校验测试证书后发请求。所有 PASS、FAIL、NOT_RUN 均为实现者自测。

| 检查 | 结果 | 本批观测 |
|---|---|---|
| 三包及路由 | PASS | Admin 310/310、H5 40/40 个 HTTP 响应体与清单逐字节摘要一致；两端首页不同。运行容器内 dist 实有 3133 项，全部与 T61 清单一致 |
| API 连接隔离库 | PASS | live、ready 均 200/0，ready 返回 db=up。API 进程池在目标库有活动连接 |
| 156→158 兼容与迁移重跑 | PASS | 全部已应用 SQL 摘要与包相符，第二次 deploy 待执行数为 0，两函数保持迁移后值 |
| 单实例 Worker 身份与入口 | PASS | API 与 Worker 使用同一镜像、各自的非属主数据库登录；Worker 启动活动循环，并连接目标库 |
| 匿名账本、跨源登录 | PASS | 匿名 401/40100，跨源 403/40300，均无业务数据 |
| 同源空会话退出两次 | PASS | 两次均 200/0，返回失效的 Secure、HttpOnly Cookie |
| 两个有效普通账号登录 | FAIL | A 走同源 H5 登录，B 走标准登录，均为 500/50000；同秒同一 API 池 PID 对 throttler_buckets 报权限错误 |
| 普通 Worker 领取 | FAIL | 标记任务保持 pending；Worker 多次轮询对 ActivityBatchJob 报权限错误，未取得租约 |
| 失败后数据一致性 | PASS（限观察窗口） | 同一任务、租约、尝试次数、批次和分录计数前后一致 |
| 终审生成、过账、关账、本人/他人账本、业务重试及防重 | NOT_RUN | 成员未取得会话，Worker 未取得租约。未发生过账、退避接管或重复提交；零分录不能验证幂等 |

## 请求号

取服务端响应头 `x-request-id`。本机原始逐次记录在 `/private/tmp/srvf-t62-iso/evidence/http.jsonl`。

| 场景 | HTTP / 业务码 | reqId |
|---|---|---|
| 存活 | 200 / 0 | `cmwoyuw6f915ba7ca981542733cb37936` |
| 就绪（db=up） | 200 / 0 | `cmwoyuw6l25f3be16052f6cb69f3d72bf` |
| 匿名账本 | 401 / 40100 | `cmwoyuw6s2bd49f630689591cc482d66f` |
| 跨源 H5 登录 | 403 / 40300 | `cmwoyuw7if691ef01f7a018237cb654f5` |
| 成员 A 同源 H5 登录 | 500 / 50000 | `cmwoyuw848950a4b36cf81e6769b1deeb` |
| 成员 B 标准登录 | 500 / 50000 | `cmwoyuw9710f92719f238a88987256f03` |
| 空会话退出 1 | 200 / 0 | `cmwoyx2tx3a6e7ec7e92040895a1ddd6a` |
| 空会话退出 2 | 200 / 0 | `cmwoyx2uedb2bd80d8ed0bc387c352f7e` |

## 数据库、身份及失败现场

独立库 `t62_lab` 来自本机已正常关停的项目测试库 `app_test_srvf_contribution_milestone_7eb3c9`。从只读的源卷冷复制，在副本创建目标库。源容器保持原退出状态。新库中的成员账号、活动、队列、批次和分录等抽样业务表起始为空。使用 PostgreSQL 16.15，以 `postgres` 运行迁移，Prisma 工具镜像 ID 为 `sha256:42ef97a91877bf9ef0e865a01648ecabfc91c2e7ad2990f58745680890b43e00`。提供给工具的 schema 和 SQL 均取自本批导入的运行包。

| 本次应用的迁移 | SQL 文件 SHA-256 |
|---|---|
| `20261120073000_settlement_deferred_correction_guard` | `38867d6ba7ebf72a2ca652c064bdbe8ffc674fba8c3b56d292d806cba1183d82` |
| `20261120073100_settlement_correction_proof_lookup` | `c5ba4ff229d717f52ed46d9d2c30585976f08a1196a955f10032629bc2517bd7` |

已有 156 条校验和匹配，迁移后 158/158，无部分执行或回滚记录。两只函数保留原 OID、属主 postgres、invoker 及原 ACL；函数体变化摘要和二次 deploy 结果在 `functions-{before,after,repeat}.tsv`、`migration-checks.json`、`migration-repeat.txt`。

API 池 `t62_api`（192.168.183.4，PID 180）与 Worker 池 `t62_worker`（192.168.183.5，PID 120、203）均连接 `t62_lab`。分别从运行容器用相同连接配置查询，session_user 与 current_user 一致，均无角色成员关系、SUPERUSER、BYPASSRLS、schema CREATE 或业务表所有权。观察连接单独记录实际进程池。两主体对队列 SELECT/UPDATE 各为 0/26 列，对队列的 postingBatchId、settlementVersionId INSERT 为 0/2；对时间清单 SELECT 为 0/13，对过账批次 SELECT 为 0/20，对分录 SELECT/INSERT 为 0/18。两者直查队列都收到 SQLSTATE 42501。完整逐表计数在 `identity-{api,worker}.json`，连接关联在 `runtime.json`、`process-pools.tsv`。

在副本用夹具建两名普通 USER，分别关联不同成员。另按程序的 reconciliation 队列结构放入一笔可领取的合成活动任务，仅用于验证队列可达性。实际 Worker 的活动循环在五秒内记录九次 drain 失败。PG 日志中 Worker PID 203 被 ActivityBatchJob 拒绝，API PID 180 在两次正常登录期间被 throttler_buckets 拒绝。任务 `cmwoyu0an0003nv01da5c44y7` 在 UTC 12:39:02 至 12:40:30 始终 pending，attempts=0、leaseGeneration=0、leaseOwner=null，队列 1、批次 0、分录 0。失败发生在领取前。采样见 `worker-polls.txt`、`db-errors.txt`、`queue-{before,after}.json`。本批没有执行 GRANT 或启用 B130。

旧 T54 使用其隔离 ACL，历史样本有 Worker 领取提交、本人两条、他人零条及匿名拒绝。已从固定提交读取 journey.json 并与本机副本比对，SHA-256 为 `75333bfaf530ad16034d08adfbbe5b6ca30e12f7b5b7f151c1db2a165fb90c68`。该库已退役，本批可用冷副本没有旧 Worker 登录及业务 ACL。要复测本批过账链，所缺输入是已预置普通 API/Worker 运行权限的可丢弃测试库副本。公网、生产、真机和浏览器端完整交互均未验。[T54 原始回执](https://github.com/BA7IEE/srvf-nest-api/blob/416ad53e9c15b7e6f25286e91c268e76ed1c3d4e/docs/ops/runtime-acl/t54/journey.json) · [T58 部署决策](../t58/deployment-decision.md)

本机证据目录为 `/private/tmp/srvf-t62-iso/evidence/`。同机持久卷 `srvf-release-artifacts-t62` 的 `evidence/` 保存脱敏回执和 SHA256SUMS。已回收本次四个容器、专属内网及临时数据库卷，制品卷保留。见 `retirement.json`。
