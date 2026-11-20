# T45 普通队员报名后的汇总、结算工作台与首次签到

**隔离实测通过。** 本人汇总和负责人结算工作台均从 500 恢复到 200，无管理权的队员访问工作台仍为 403。一次性测试实例按 V1.1 合同走新轨后，普通队员在有效窗口内使用实际签发的二维码签到，返回 201。事件、开放时段、本人状态和同一请求的审计全部对应。共享候选新增 GRANT 为 0。公网、队员 H5 真实报名均为 NOT_RUN。

## 验收矩阵

| 场景 | 判定 | 真实结果 |
|---|---|---|
| 默认轨，本人参与汇总 | PASS | 500/50000 → 200/0。该普通队员只有报名，已结算记录、活动数、时长、贡献及四项账本小计均为零。隔离库内无官方时长切换单例，也无该活动已过账分录。[装配前](read-baseline.jsonl) · [装配后](read-after.jsonl) |
| 默认轨，负责人工作台 | PASS | 500/50000 → 200/0。活动 ID 一致，run、closure 均为空，返回未生成结算运行、证据封印、草稿三个缺口。负责人职责来自正常发布流程。[回执](read-after.jsonl) |
| 普通队员访问他无权管理的工作台 | PASS | 默认轨基线、新轨装配后、全部撤权后均为 403/30100。首次默认轨修复后，前两项正向断言通过，脚本因第三次重复登录中断，整组 exit 1。改为同主体复用会话后，新轨三项回归一次通过，exit 0。[原基线](read-baseline.jsonl) · [完整三项](read-on-after.jsonl) |
| 新轨，本人参与汇总 | PASS | 打开测试开关后，计数切到已提交账本。只有默认轨读权时复现 500/50000；另补活动 ID 和结果修订 ID 两列后，200/0，四项账本小计仍为零。负责人工作台 200/0，普通队员 403/30100。[差额前](read-on-observe.jsonl) · [差额后](read-on-after.jsonl) |
| 已报名队员在有效窗首次签到 | PASS | 负责人签发 201/0、渲染 201 且 no-store。Chromium 在内存解码 SVG 后走同源 HTTP。最终 201/0，读回 isPresent=true。数据库有 1 条本人的 self_qr/check_in 事件和 1 个指向它的开放时段，证据版本 0 → 1。[签到与读回](punch-trial.log) · [DB 与审计](punch-committed.jsonl) |
| 失败有无半写 | PASS | 事件权限缺失、随后服务时段触发器依赖缺失，两次均 500/50000；第二次失败后事件、时段、证据版本均为 0。补齐后复用同一业务键，只有一条成功事件。reqId cmwnu41p4f49014edc35e1ca6173caa74 对应 attendance-punch.create 成功审计、相同发起人和事件。[回滚结果](punch-rollback.jsonl) · [成功事实](punch-committed.jsonl) |
| 撤权及退役 | PASS | 三包逐项回到原始有效 ACL；两个读面均复现 500，普通队员仍 403。已提交签到事实和审计保持相同。负责人作废二维码，Worker 处理 3 条内部意图，余量 0，合成审计封存为 0600。[撤权复测](read-withdrawn.jsonl) · [Worker](worker.log) · [退役](retired.log) |
| 其余边界 | NOT_RUN | H5 凭证 ADR 已交维护者，真实 H5、手机相机、公网写入均未测。签退、正式结算生成、审核、贡献过账和非空工作台版本展示也未测。 |

## 读面与首次签到的隔离权限

T44 诊断用同一请求号分别关联到 ActivityTimeCutoverReceipt 和 ActivitySettlementClosureRevision，两笔请求号为 cmwntdhpb80abf991a3e405b75dd725a8 与 cmwntitqt25986f4041c6ca7aaf20f44a。本人汇总还并行读取已提交、在途账本，本轮实际 SQL 与逐列实验补齐了 ParticipationLedgerEntry 的证据。[T44 证据](https://github.com/BA7IEE/srvf-nest-api/tree/860533d1425d5f7c38dddf8641bc8df2f98ffa3a/docs/ops/runtime-acl/t44) · [本人汇总](https://github.com/BA7IEE/srvf-nest-api/blob/713d3416830d897852929731ff7f9b638038ab7c/src/modules/attendances/participation-summary-query.service.ts#L69) · [工作台](https://github.com/BA7IEE/srvf-nest-api/blob/713d3416830d897852929731ff7f9b638038ab7c/src/modules/activities/activity-settlement-http.service.ts#L398)

| 子项 | 相对隔离基线实际新增 | 逐项验证 |
|---|---|---|
| 默认轨两条读面 | **22 SELECT**。ActivityTimeCutoverReceipt 10 列，当前 Prisma 即使探测单例是否存在也取全部标量；ParticipationLedgerEntry 5 列，ActivitySettlementClosureRevision 7 列。LedgerPostingBatch 和 EvidenceSeal 相关权限已有 | [22/22](read-witness.jsonl) |
| V1.1 汇总 | **2 SELECT**。ParticipationLedgerEntry.activityId、resultRevisionId 参与活动数和账本日结果数的去重 | [2/2](ledger-on-witness.jsonl) |
| V1.1 首次签到 | **78 项列权**。AttendancePunchEvent SELECT 30、INSERT 26；ParticipantServiceSegmentRevision INSERT 18；ActivityEvidenceState UPDATE 2；CorrectionPendingTimeAllocation SELECT 2 | [78/78](punch-witness.jsonl) · [精确列名](punch-contract.json) |

完整业务请求均由非所有者应用角色执行。逐列证据使用 PostgreSQL 16 EXPLAIN GENERIC_PLAN，只规划、不执行数据写入；完整装配成功，回滚事务中单独撤掉每项均得到 42501。签到包 76 项对应真实应用 SQL，另两项对应触发器内部真实分支的等价参数化查询。保留了每个见证查询的 SHA256。最小集只覆盖此版 SQL、这份初始基线和实际经过的分支。[读面实验](prove-reads.py) · [签到实验](prove-punch.py)

普通服务时段 INSERT 会执行 R5 的 SECURITY INVOKER 触发器，凭 targetSegmentRevisionId 查询 applicationId。这两列只授 SELECT；更正待处理行数为 0。随后的 DB 对账确认运行身份非所有者，未加入两个受信角色，对该表无写权。触发器沿用原实现。共享身份若获签到列权，该身份的其他进程也能读打卡位置、事件或更正关联标识，须由正式部署契约单独评估。[迁移中的普通插入分支](https://github.com/BA7IEE/srvf-nest-api/blob/713d3416830d897852929731ff7f9b638038ab7c/prisma/migrations/20261031223000_r5_correction_set_materialization/migration.sql#L1221) · [角色证据](punch-committed.jsonl)

## 开关、版本和范围

默认关闭的 V1.1 写闸在服务端验码之前拒绝请求，T44 的 503/20153 符合合同。仓库定向签到测试在创建测试应用之前显式开启该项。T45 仅在一次性 APP_ENV=test 栈采用相同配置；先停原实例，再启动唯一写入者。产生新轨事实后直接退役，未重新启动旧写轨。业务代码、共享开关、公网路由均未改。[门禁源码](https://github.com/BA7IEE/srvf-nest-api/blob/713d3416830d897852929731ff7f9b638038ab7c/src/common/activity-workflow/activity-workflow.gate.ts#L104) · [冻结版本测试约定](https://github.com/BA7IEE/srvf-nest-api/blob/713d3416830d897852929731ff7f9b638038ab7c/test/e2e/activity-batch5-punch-runtime.e2e-spec.ts#L35) · [实测开关](gate-on.jsonl)

T44 的 tmpfs 和测试账号已退役。本次新建一名普通报名队员，以一次真实报名提供签到前置，未重跑五类指标交叉及报名幂等、取消全链。工具登录曾遇 429/42900，保留限流，等窗口过去后正常登录。版本、CI、退出码和配对回退分别见附件。[GATE](GATE.md) · [PAIR](PAIR.md) · [执行命令](COMMANDS.md)
