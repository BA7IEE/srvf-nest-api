# T63 隔离库最小运行权限

**配方与回执自测 PASS。** 对固定制品从空库执行全部 158 条迁移，按列一次装入权限，重复安装、缺列预检、完整回退与回退后拒绝均已验证。每个列权限都与该身份在成功演练中的 PostgreSQL 执行计划相符。

**隔离业务自测 PASS。** 两名普通成员走 T62 原登录路径均成功。独立 Worker 领取并提交，API 完成关账；本人两条、他人自查零条、他人点名查该成员被拒、匿名被拒。用同一操作键重复关账，返回同一条收据。请求号、库内状态变化及 T62 失败对照见[关键回执](receipts.json)。

| 运行制品 | 源码提交 | 本地整包 SHA-256 |
|---|---|---|
| API / Worker | `65bad1ccb7e6a4bb7a3cda46b49512f092d04779` | `da16d1245e234f1192225ab5e9121e9cb9ad0ae731ebc834f9aece2874aeb077` |
| H5 | `ae2e3b0ad5202a214d4dcfdc54342e52f9f270a1` | `dc6714e567f6a0999366200f8a104da02e7e3ec1b356aa9de69c169b529ed599` |
| Admin | `2626116889affe3bda3758f7ed1ce006272503bf` | `04e010d4d1dd695422eb2cdb850d9800b40dc3e1d4e39d2b761ad1e1bc1507c2` |

## 权限如何划分

[完整清单](columns.json)按数据库登录、物理表、操作及列名排列。API 为 45 个对象、68 组操作、692 个列权限；Worker 为 32 个对象、50 组操作、425 个列权限。作用域覆盖此固定版本的密码登录、单场合成活动、普通队列、正常结算、关账及所列负例。表中举例可在清单中逐列查到。

| 主体、调用路径 | 这条路径实际使用的权限 |
|---|---|
| 迁移与夹具 | 独立 PostgreSQL 16 临时集群上的 `postgres` 创建封闭测试角色，在空库执行包内 SQL，再建立合成账号、角色目录及历史考勤输入。158 条迁移的名称和校验和整体锁定。夹具完成时账本、结算运行均为空 |
| `t63_api`，登录、成员与鉴权 | 限流表 SELECT 9、INSERT 8、UPDATE 5 列。密码登录的 User 默认 ORM 投影为 18 列，续登凭证为 refresh_tokens 的 8 列 INSERT；审计及角色、组织范围读取分别列出。普通成员的业务角色均为 USER，两个账本查询账号没有角色绑定 |
| `t63_api`，封场、草稿、一审与终审 | 含职责、场次、考勤、参与身份、业务版本、审核动作及过账批次。API 也会写草稿任务；其队列 UPDATE 6 列，普通结算准备任务的领取与提交由 Worker 执行 |
| `t63_worker`，排队、领取、准备及提交 | 独立进程运行 `node dist/storage-consistency-worker.js`。队列 SELECT 26、INSERT 19、UPDATE 14 列，入队含 postingBatchId、settlementVersionId。时间清单 SELECT 13 列；分录 SELECT 6、INSERT 17 列。提交使用终审人的业务身份，数据库执行身份是 Worker。该入口同时运行存储轮询，空队列探测与行锁的列另列在 attachments、storage_objects、storage_object_operations |
| `t63_api`，账本与关账 | 本人账本分录 SELECT 正好覆盖 T49 的 13 列；过账批次在整条流程读取 5 列，其中 id、statusCode 对应 T49 的查询。关账收据 SELECT 18、INSERT 21 列，两处 currentClosureRevision 指针随事务更新。API 没有分录表 INSERT |
| 数据库触发器 | 普通路径也会执行 invoker 检查。例如草稿更新服务段时查 CorrectionPendingTimeAllocation 的 applicationId、targetSegmentRevisionId；提交时按批次探测更正清单。列清单包含这些实际投影。专属更正函数执行权、CorrectionTimeSourceProof 读取和 B130 均未启用 |

以 T49 的 13+2 列、T53 的过账写入和 T54 的 Worker 入队、时间清单及关账差额起步，逐项对照固定包的 SQL、ORM 返回字段和库内触发器。正式配方为静态清单。成功运行另外采集 PG16 的 RTEPERMISSIONINFO，分登录核对 SELECT / INSERT / UPDATE 位图，保留 SQL 模板摘要，忽略由引用表属主执行的外键内部检查。像 count(*) 或行锁这样只要求任一列的操作，选一个现有列即可。Prisma 的默认返回列、SQL 的星号投影可能覆盖当前全部列；授权逐列枚举，新增列不会自动获得权限。调试复现中使用过、成功路径未触及的两项 API 队列 UPDATE 列已从定稿移除。[T49 列合同](../t49/ledger-contract.json) · [T53 材料](https://github.com/BA7IEE/srvf-nest-api/tree/5f8f2e4336b4e2d3abdb40c577585fe0dfce9b30/docs/ops/runtime-acl/t53) · [T54 业务回执](https://github.com/BA7IEE/srvf-nest-api/blob/416ad53e9c15b7e6f25286e91c268e76ed1c3d4e/docs/ops/runtime-acl/t54/journey.json)

## 从干净库复现

需要 Python 3.9 以上、Docker、Git、支持 `-addext` 的 OpenSSL、含固定 API 提交的源码仓，以及 T62 本机卷 `srvf-release-artifacts-t62`。另需本机已有的 PG16、Node 探针、Prisma 工具镜像，精确标识在 [replay.py](fixture/replay.py) 顶部。固定 API 镜像从卷内校验过的 OCI tar 导入，arm64 主机需能运行 linux/amd64。工作流使用独立 internal 网络、内存 PGDATA 和临时密码，结束后回收本次栈。磁盘上仅保留指定目录里的脱敏回执。[T62 卷取件说明](../t62/README.md)

从本目录运行，`$source_dir` 指向含固定提交的 API 源码仓，`$new_evidence_dir` 为新的输出目录。

```sh
python3 fixture/replay.py --source "$source_dir" --evidence "$new_evidence_dir"
```

如需在同形状的专属试验栈中单独执行权限步骤，用建库时记录的 `system_identifier` 和容器名。setup、preflight、rollback 均在单一事务中核对目标、角色、权限和迁移摘要。setup 接受空集或完全匹配的状态；如已有零散权限则原样退出，便于查明来源。rollback 撤回清单内列权，可重复执行。

```sh
python3 acl.py setup     --container "$pg_container" --cluster-id "$recorded_id"
python3 acl.py preflight --container "$pg_container" --cluster-id "$recorded_id"
python3 acl.py rollback  --container "$pg_container" --cluster-id "$recorded_id"
```

运行身份需 CONNECT 和 public schema USAGE，禁止 schema CREATE、库级 CREATE/TEMP、业务对象所有权、角色成员关系、SUPERUSER、BYPASSRLS 和转授。preflight 比较 public 各业务表的实际有效列权，包括 PUBLIC，并检查表级 DML、序列权限及受保护的更正函数。回退前后复核了业务行、收据和账本总数。普通成员的 HTTP 可见范围单独以请求验证；有列权的 DB 直连具有不同的数据可见范围。

## 验证范围

固定包同源 HTTPS 逐项读取 Admin 310、H5 40 个文件；API ready 接通隔离库。合成场次打卡相隔 2340 秒，预期为 0.65 小时、1.5 分。持久审计按两个登录和六个写步骤逐项关联服务端 reqId 与业务 actor。独立的 invoker 观察触发器只向本库日志写事务号、DB 身份及状态变化，另外用最终提交的数据行复核。Worker 的准备分录和批次生效发生在不同事务，探针等到任务成功且批次 committed 后才关账。[验配脚本](fixture/replay.py) · [历史失败锚点](../t62/isolation.md)

按相同 operationKey 重放关账，八个检查仍通过，收据 ID 一致，库内保持一条关账记录。租约超时接管、多实例并发重领、生产数据、浏览器真机和公网均为 NOT_RUN。本机完整回执在 `/private/tmp/srvf-t63-acl/evidence/delivery/`，关键部分已随 PR 登记。共享库权限没有改动；如果另行考虑共享，只能先比对目标库现有登录、对象属主、列可见范围及最小差额，尤其是 User、refresh_tokens、审计默认投影和分录 13 列。本次隔离结论不构成共享授权。
