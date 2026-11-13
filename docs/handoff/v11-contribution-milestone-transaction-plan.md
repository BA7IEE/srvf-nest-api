# 新版结算入队达标通知：待审事务方案

状态：**设计候选，尚未接线、授权或在真实数据库验证**。旧终审入口已关闭，新版结算成功目前不产生该通知。本文件不授予 migration、数据库权限、上线或消息发送授权。

## 事实与目标

旧通知的键为 `team-join-contribution-met:{applicationId}:5`；每位成员取最近一条未删除的 joining 申请，按 `createdAt desc, id desc` 选定，其 cycle 的北京日截止口径及门槛沿用 `team-join-progress.ts`。新版只计算 committed ledger credited 净额，包含冲回与重记。首次跨越 5 分时应与账本生效原子地登记一次入队通知意图；同一申请后来冲回再达标不得产生第二个意图。

outbox 的唯一键仅在对应记录保留时有效。`docs/ops/notification-outbox-retention-sop.md` 允许删除终态记录；旧 targeted handler 使用随机 intent ID 生成 Notification ID，旧 intent 被删除后无法仅凭现存 Notification 可靠反查 applicationId／eventKey。`AuditLog` 对当前边界角色并非普遍不可变且没有相应唯一约束，也不能当作已经可信的永久收据。不能从账本积分、时间或“预计无历史数据”推断历史通知是否发出。

## 候选持久收据与原子边界

需单独审查的持久事实可以以 `(teamJoinApplicationId, threshold)` 唯一约束为逻辑键，记录 memberId、语义及载荷版本／规范摘要、首次 postingBatchId 和创建时间。收据永久或至少在经批准的业务去重期内不可删除、不可更新；它只证明首次意图与一次提交共同落库，**不证明消息已投递**。方案必须同时处理消息 dead 后的恢复，不能因收据存在而静默掩盖未送达。

拟议共同事务入口是 `LedgerPostingService.commitBatchProtocol`：普通结算经 `commitBatch`，普通及 Human correction 经调用方持有的 `commitBatchWithin(tx)`。普通 HTTP、普通 worker 和 Human 私有依赖图均需独立检查接线。保持 Activity → run → version → batch → 锁预算 → 排序的 member advisory → day-state 既有次序。在这些锁后、批次变为 committed 前按申请轮次批量读取 before；批次及更正完整生效后，在**同一客户端与事务**读取最终 after。只对 `before < 5 && after >= 5` 的申请尝试插入收据；首次插入后调用 `enqueueMany(..., tx)`，同键收据冲突时读取并核对申请、成员、阈值及语义，不能吞掉冲突、权限或 outbox 错误。任何失败都必须让账本、收据、outbox 和 correction 后续鉴权／seal 一起回滚；已提交重放不得重复触发。legacy conversion 是否应通知必须先明确产品语义，不得默认由普通提交路径带入。

已有同键 outbox 的迁移期情况须核对 envelope、状态和业务归属，并用行锁或等价数据库协议处理与 retention 并发；仅能证明记录存在，不能证明已投递。已物理清理旧 intent 的申请应归为 **unknown**，通过经审阅的明确迁移、人工判定或业务批准的例外处理；不能自动回填为未通知。所有旧写方切换及在途事务须纳入方案，避免新收据与旧生产者并发各自落意图；仅凭申请 `createdAt` 不足以证明切换先后。

## 权限与护栏待审

静态代码显示 Human scope-on 使用受控 P 客户端及 C 业务角色，普通 API／scope-off 使用 N；实际登录角色、PUBLIC、继承、默认 ACL、RLS、owner 和线上数据均未核实。migration 155 列出 C 对 ledger 和 outbox 的部分权限，但未找到申请／轮次表的显式 C 授权：这并不等于证明运行时一定拒绝。候选至少需读取申请 `(id, memberId, cycleId, statusCode, deletedAt, createdAt)`、轮次 `(id, year)`，以及经审阅的收据 `SELECT/INSERT`；业务角色不应获得收据 UPDATE／DELETE／TRUNCATE。

代码允许 U 切换至 C，直接把收据 INSERT 授给 C 不足以防 U 伪造“已通知”。如需抵抗该威胁，须另行设计并审查按真实 session 身份限制的窄权限边界、不可变约束及表／函数 catalog pin；不能自行切高权连接或假设新 definer/RLS 已安全。schema、migration、权限及受信 catalog 属受保护范围，需按正式授权和审查流程实施。

## 验收矩阵（均待执行）

1. 纯逻辑／事务 mock：零值、负净额、刚好跨 5、冲回再跨、跨轮次、不同申请；同 key 同内容幂等、冲突内容拒绝；空值和不可读快照拒绝。receipt／outbox／最后鉴权／seal 各失败都向调用方传播，不吞错。
2. 全新隔离 PG 双池：同成员不同活动并发跨阈值；申请创建／变更／final join 与结算双向 barrier；断言锁后 before/after、唯一收据及全部副作用原子回滚。覆盖北京 3/31–4/1、跨年、更正冲回重记、committed replay 和资格被撤销。
3. 分别覆盖 pending、processing、dead、succeeded 与 retention／恢复交错；清除已成功 intent 后再次跨线仍不重复产生通知；旧 intent 已清理而通知随机 ID 无法关联时显式保持 unknown。
4. 用真正 N、P、C、U 登录验证最小权限、U→C 伪造及改删尝试、PUBLIC／继承／默认 ACL／RLS／owner 与 catalog pin；测试普通结算、Human 同步／worker、scope-on/off、更正和提交结果不确定后的对账。500／2000 人时核查询数、锁预算和项目事务时限。

上述 mock、数据库、权限和并发用例目前均未因本方案而运行。任何 future 实现必须在固定提交上重新给出可复核结果；不能用旧 CI 或 mock 声称它们通过。
