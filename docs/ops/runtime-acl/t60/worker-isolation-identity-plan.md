# 普通过账 Worker 的隔离验配方案

**状态为待演练。** T58 核到旧 API 容器有两条 `srvf_dp_acceptance_runtime` 数据库连接，采集连接为 `postgres`。当时队列没有待领任务或有效租约，只找到已退出的预检容器。在线 Worker 的登录、镜像和运行结果均为 **UNKNOWN**。本轮没有启动消费者或连接数据库。[T58 部署决策](https://github.com/BA7IEE/srvf-nest-api/blob/dcc7694258fc6dce1b1976158fd7bfdebaaaf1a1/docs/ops/runtime-acl/t58/deployment-decision.md) · [数据库采样](https://github.com/BA7IEE/srvf-nest-api/blob/dcc7694258fc6dce1b1976158fd7bfdebaaaf1a1/docs/ops/runtime-acl/t58/database.json)

## 先定目标、进程和数据库身份

拟用无公网入口的独立内网栈，独立库、网络、队列和存储命名空间，仅放一项合成活动、两名普通成员及所需审批人。只给选定成员产生分录。外部投递关闭，网络只放行演练所需目标。旧 Worker、宿主机调度器及其他消费者均不能接入此队列。固定 HTTPS 域名，反代覆盖来源头，应用仅信实际直连代理的最小地址范围。

| 主体 | 隔离验配时的身份与证据 |
|---|---|
| API | 普通非对象所有者登录，使用本批镜像默认入口 `node dist/main.js`。核连接来源和 DB 身份。保存普通成员 HTTP 请求号与返回结果。 |
| 普通 Worker | 拟选同一镜像、单独凭据的非所有者登录，单实例运行 `node dist/storage-consistency-worker.js`（无参数）。同时运行存储循环和活动队列循环，存储侧也须只有隔离数据。固定镜像 ID、OCI revision、dist 清单、argv 和进程启动时刻。 |
| 迁移主体 | 单独受控登录，记录目标库、`session_user`、`current_user`、两只函数属主与可替换权限。审批窗口内才可对演练目标执行对应迁移，API/Worker 均无 DDL 职责。 |

`node dist/notification-outbox-worker.js` 的普通模式也会启动活动队列循环，首轮仅选上表一项。存储入口的 `--once` 只跑存储；`--human-correction-only` 属于受保护的更正流程。按固定树核对普通模式的配置、活动工作流显式开关和外发设置，活动工作流演练值为 `ACTIVITY_V11_WORKFLOW_ENABLED=true`。记录开关值及脱敏配置摘要。只看 API 健康页、Worker 进程存活或预检退出 0，均不能确认领取和提交。[存储入口](https://github.com/BA7IEE/srvf-nest-api/blob/65bad1ccb7e6a4bb7a3cda46b49512f092d04779/src/storage-consistency-worker.ts) · [活动消费者运维说明](https://github.com/BA7IEE/srvf-nest-api/blob/65bad1ccb7e6a4bb7a3cda46b49512f092d04779/docs/ops/activity-batch-worker-runbook.md)

在演练目标分别从 API 与 Worker 实际连接池取只读身份回执，记录 `current_database()`、`session_user`、`current_user`、`pg_backend_pid()`、`application_name`。用独立观察连接将 PID、DB 登录、进程来源和镜像关联，确认两者指向预期隔离库且登录不同。对实际有效角色核对角色继承、对象属主、SUPERUSER、BYPASSRLS、schema CREATE 和逐列权限。保留结果和请求号，不记录连接串或令牌。身份、继承权限或队列边界不明即停在启动前。

## DB 直连与成员 API 分开验

| 问题 | T58 基线 | 隔离收货判据 |
|---|---|---|
| API DB 登录可直接读什么 | `LedgerPostingBatch` 指定列 SELECT 2/2，`ParticipationLedgerEntry` 指定列 0/13。分录表未开 RLS，策略数 0。 | 用该角色直连，在合成数据上核逐列权限及可见成员、活动、过账状态。将来若放开这 13 列，直连可跨成员和活动读，也不限定已过账。 |
| 普通成员通过 API 可见什么 | T54 隔离曾测到本人 HTTP 200 / 业务码 0 / 两条，另一成员 200 / 0 / 零条，匿名 401 / 40100。该证据属于 T54 隔离数据。 | 对同一活动，用两名成员各自会话及匿名调用 `GET /api/app/v1/my/participation-ledger`。本人仅见预期新增，另一成员零条、匿名拒绝。按身份保存 HTTP 状态、业务码、行数及请求号摘要。接口按当前登录成员过滤；DB 可见范围本身不能证明 API 越权。 |
| 过账、关账各缺什么 | T58 用 **API 登录** 对照 `ParticipationTimeLedgerManifest` SELECT 0/13、`ActivityBatchJob` 的 `postingBatchId` 与 `settlementVersionId` INSERT 0/2。T54 的独立 Worker 登录在共享库不存在。API 关账收据 SELECT 0/11、INSERT 0/21，活动与结算运行的关账指针 UPDATE 各 0/1。 | 使用实际隔离 Worker 登录核它自己的取活、租约、清单读和写回，再用实际 API 登录核关账。权限不足记录角色、对象、列、操作及错误码，留给数据负责人单独决定。上述计数不能移植为 Worker 权限或通用授权表。 |

T54 仅撤去隔离临时新增的六列后，账本明细变为 500/50000，汇总仍为 200，分录保留。此结果说明列权会影响接口可用性。共享 13 列与 B130 各自另决策，本计划不含授权动作。[T54 隔离请求及撤权回执](https://github.com/BA7IEE/srvf-nest-api/blob/416ad53e9c15b7e6f25286e91c268e76ed1c3d4e/docs/ops/runtime-acl/t54/journey.json)

## 按一次活动收证

1. **固定基线。** 记录三仓版本及本地制品摘要、目标库标识、角色、函数 owner/ACL/摘要、当前迁移与备份时点。T58 当时为 156/156，目标源码为 158，差额为 `20261120073000_settlement_deferred_correction_guard` 和 `20261120073100_settlement_correction_proof_lookup`。在独立库验证恢复并核对账本、审计与权限。基线漂移、部分迁移或恢复未验证，暂停验配。
2. **放一笔正常任务。** 明确旧消费者已排空、两侧外发关闭。若演练栈需迁移，由迁移负责人按 T58 顺序在隔离目标处理，复核两函数 invoker 和新摘要。走正常业务终审生成带唯一活动标记的过账任务，先记录任务、批次、活动及基线计数，再让单实例普通 Worker 领取。用队列和审计回执串起领取时的 `leaseOwner`、`leaseGeneration`、`leaseExpiresAt`、`attempts`、批次提交、一次关账及本人新增。核对终审人作为业务 actor、Worker 登录作为数据库执行者，两者均有来源。
3. **单独验失败与恢复。** 另用一个可丢弃的标记任务，记录可重试失败后的状态、退避和领取次数；让隔离测试中的租约到期，以同一镜像的替代实例接管，确认 generation 递增、旧租约失效、无重复过账和审计业务效果。该树普通活动任务的租约为 5 分钟，重试退避 30 秒，上限 5 次。把这次重试的多次领取与正常样本的一次领取分开计数。[活动队列实现](https://github.com/BA7IEE/srvf-nest-api/blob/65bad1ccb7e6a4bb7a3cda46b49512f092d04779/src/modules/activities/activity-batch.worker.ts)
4. **停止与回退。** 若出现非隔离目标、身份串用、外发、双消费者、租约失效后仍写入、重复分录或跨成员 API 读回，停止隔离投放并保留证据。排空后才可演练切回成套旧 API/Worker/静态包和代理配置。还原两函数会恢复旧终审 42501，已提交的账本、审计、撤销和幂等收据要保留。记录通过项、失败项和未测项；生产、共享扩权、公网和真机仍各自待决策。
