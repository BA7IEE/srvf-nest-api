# 正式参与时长切换运维说明（D8）

## 1. 本文的权限边界

本文说明 D8-1 代码提供的只读预检和单次切换命令，以及 D8-2 官方消费者的验收边界；它不是生产执行授权。代码合并、部署、
v1.1 Gate 启用、结算只读窗口和 D8 正式切换是五个分开的决策。AI 不得因为本文存在就执行
`--execute`，也不得替维护者开关、部署、生产迁移或删除收据。

D8-1 已进入 main，只建立切换事实、统一真相选择器和正式证明。当前 D8-2 候选把官方统计、直方图和
新关账接到该选择器，但在 D8-2 合并并部署同一 exact main SHA 之前仍禁止写入切换收据。

## 2. 不可逆事实

- `ActivityTimeCutoverReceipt` 全库只能有一行，ID 固定为 `activity-time-v1`。
- `ParticipationTimeCutoverBinding` 只能由数据库在普通 `LedgerPostingBatch` commit 触发链中生成。
- 两表都禁止 UPDATE、DELETE 和 TRUNCATE；不提供回切、修改 `cutoverAt` 或手工补 binding 的工具。
- 切换前根账永久走旧制度，切换后根账永久走分类制度；后续 correction 继承根账归属。
- 旧数据不回填、不重分类、不删除。历史已认定服务时长在证明里显式标为
  `legacy_recognized_service`，不冒充 `volunteer_service`。

## 3. 只读预检

默认命令不写数据：

```bash
pnpm exec tsx scripts/activity-time-cutover.ts --check-only
```

输出只含脱敏状态和计数：

- `status=blocked`：仍有阻断项，禁止执行。
- `status=ready`：机器条件当下满足，仍不等于已获生产授权。
- `status=already_cut_over`：收据已存在；核对返回的可验证收据，不再生成新 operation key。
- `v11Enabled` 和 `maintenanceWindowOpen` 必须都是 `true`。
- `preparingOrReadyBatchCount` 必须为 0。
- `pendingOrProcessingPrepareJobCount` 必须为 0。

预检是某一时刻的快照。真执行会再在排他事务围栏内重查 Gate、actor、未完成 batch/job 和单例收据；
不得以预检通过替代锁内复核。

## 4. D8-OPS 正式窗口的硬前置

必须全部满足，少一项都不执行：

1. D8-1 和 D8-2 都已合入，且同一 exact main SHA 的 PR CI、合并后 main CI 和部署证据完整。
2. v1.1 Gate 已在更早、独立的窗口启用并稳定；本窗口不同时开 v1.1。
3. 当前 fleet 全部运行同一 `deployedMainSha`，不存在不识别 cutover receipt 的旧二进制。
4. D5 shadow、D6/D7 满额、migration、权限、审计、业务抽样和总复审证据已归档，并对证据包求出
   64 位小写十六进制 `evidenceBundleHash`。
5. 结算维护窗已设为只读，worker 已排空；没有 preparing/ready posting batch 或 pending/processing
   `settlement_prepare` job。
6. actor 是当前 ACTIVE 人类用户，且持有既有 GLOBAL `activity.settlement-final-review.record`；
   角色名、超级管理员标识或过期绑定均不替代该明示授权。
7. 维护者已对 exact deployed SHA、证据摘要、actor、operation key 和本次不可逆操作单独签字。

## 5. 正式执行形状（只供已授权窗口）

```bash
pnpm exec tsx scripts/activity-time-cutover.ts --execute \
  --actor-user-id '<ACTIVE user id>' \
  --operation-key '<one stable operation key>' \
  --deployed-main-sha '<40 lower-hex exact deployed SHA>' \
  --evidence-bundle-hash '<64 lower-hex evidence digest>'
```

- 首次成功返回收据，并在同事务写入 `activity.time-cutover.command` 审计。
- 同 actor、同 operation key、同 deployed SHA 和同 evidence hash 的精确重放返回原收据并标记
  `replayed=true`，不重复写审计。
- 收据已存在却换 key、actor 或证据的请求是冲突，不会覆盖原事实。
- CLI 不修改环境变量、Gate 或数据库配置。

## 6. 执行后验收

1. 立即以同版本重跑 `--check-only`，确认 `already_cut_over` 且收据内容哈希验证通过。
2. 在保持只读窗的情况下抽验 App self 和 Admin scoped/GLOBAL 证明，核对合计、历史标签、分页无关
   `proofSetHash` 和越权拒绝。
3. 核对 D8-2 接线的官方统计与证明 eligible 合计一致，原始参与账本、贡献值和历史 closure 未改口径。
4. 提交一笔受控的切换后普通根账，确认同事务出现唯一 binding；不用手工 SQL 补 binding。
5. 完成证据归档后再退出只读窗。

D8-2 的兼容边界固定如下：收据不存在时沿用原统计和关账口径；收据存在后，成员累计、逐活动、月度总览、
直方图和**新建** closure 使用统一 selector 的 eligible 秒数。贡献、报名、到场、no-show、反馈、原始
`participation-ledger` 和既有 immutable closure 不切换。任一链不完整返回具名失败，不回退旧账伪造结果。

## 7. 失败与事故处置

- 收据尚未写入：保持只读，查明 blocker，重新归档证据并单独审批；不用固定 sleep、删 batch、
  改数据或关闭触发器强行通过。
- 收据已写入：它是不可逆事实。故障时保持只读并前向修复；禁止删收据、改 `cutoverAt`、关 v1.1
  来伪造回切，也禁止回滚到不识别收据的旧二进制。
- 任何数据修复、重投影或业务回填都是新的高风险任务，需要精确写集和实时授权；本 runbook 不授权。

## 8. 本次未做

D8-2 候选没有执行生产 migration、切换、部署、Gate 修改、历史回填、重分类或业务数据删除，也没有
Ready 或合并。D8-OPS 真实窗口仍待后续独立授权与交付。
