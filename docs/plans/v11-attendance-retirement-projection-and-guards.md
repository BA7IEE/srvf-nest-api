# 新版参与投影与守卫迁移草案

本稿描述本地候选的下一步，不代表活动对账、meta 或通知已迁移，不代表维护者签署。旧 Sheet/GPS 控制器及旧写 provider 已从运行时移除；旧服务源码、历史迁移、旧数据和部分旧读取仍在。活动对账及月度总览关闭新版时拒绝读取，而非回退旧工时；但开启后人数、缺席和部分直方图仍依赖旧考勤，不能当作已完成迁移。月度无可见组织时仍先返回空结果。不得据此部署。

## 投影事实和拟定口径

- **权限与快照**：活动对账先按两个原有 action 对 activity ref 判权；月度先取两个 action 的可见组织交集，再与请求组织及后代取交集。无权限仍拒绝，无可见组织的月度结果仍为空。授权活动集合、报名、场次身份、正式结果、账本、正式时长和评价应在一次 `RepeatableRead` 中读取，不能把不同更正版本拼在一起。空组织、无成员、无权限和 gate 关闭的优先级须有反例。
- **身份与去重**：一条 `ActivityParticipationIdentity` 是一人一场次；先按身份保留结果，再按活动和成员合并。相同成员多场次最多计一个活动到场人次，但保留每场次状态供核对。报名头状态统计与场次身份结果分开：现场补录的报名头可能是 `pending`，同一场次身份已是 `pass`，不得把前者当作后者。
- **正式与待定分开**：正式结果锚定当前 posted version 对应的 committed result 和 committed batch。`present` 即使贡献/时长为零仍是正式到场；`absent` 为正式缺席；`leave`、`cancelled`、`early_departure_zero` 等保持独立结果，不伪装成出席或缺席。没有正式结果、开放段或无打卡是待定，不从“零行”推断缺席。多人多场次合并时只要任一正式结果为 present，成员有正式到场；在无 present 且仍有待定场次时，不能把该成员归为最终缺席。其他结果和多场次混合须保留可解释明细。`active closure` 可表示关账，但不是 posted 事实的唯一锚：普通入账可先于关账，更正提交与重新关账之间也可没有 active closure。
- **临时参与**：新版现场参与使用显式 `onsite` 来源；应从不可变报名/参与修订判断身份的来源，不能只看可覆盖的报名头或“是否存在报名”。来源缺失、存量合成头和多场次来源不一致时必须显式标记未知，不能猜成普通报名或临时参与。现有存量转换只覆盖部分 approved 数据，且合成头可写 `admin`；本候选不读取或改写旧表来伪造来源。
- **计数及比例**：原 DTO 的 `recordCount`、`approvedRecordCount` 是旧 Sheet 行数，不能直接改称身份数或账本日行数。新合同应显式区分参与身份、正式结果、已入账身份×北京日和成员人数；率的分子、分母、待定和未知均需单列。缺最终认定时不应返回貌似完整的 no-show 率。旧行为的变化须在合同及前端交接中明确，不可仅删字段或统一填零。
- **时长及直方图**：时长证明 receipt 存在时复用正式时间 selector 的 eligible 秒；没有 receipt 时的已正式入账小时按 committed 正负账本净额，不能回退旧考勤。直方图的统计单位应统一为活动×成员，合法明确零值可进 `[0,2)`；selector 没有来源行不等于零。遇缺来源、负净时长或不完整版本时应明确失败/未定，不能私自夹零。贡献积分始终取 committed credited 正负净额，不二次封顶或与旧分叠加。
- **月份**：沿现有接口以 `Activity.startAt` 的 UTC 月归组；账本按北京自然日分配并不意味着改按账本月分组。月度人数/率从同一活动级投影折叠，不能复制另一套人数口径。

需要先以明确的新 DTO 表达待定、非到场结果和来源未知，再迁移两个活动读面及 meta；不得在旧 DTO 无法表达时把未知变零。需要实际隔离 PG/HTTP 覆盖更正准备/生效、无 closure 的 posted 版本、合法零行、冲回重记、同人成员多场次、现场来源、开放/作废/早退段、无组织、跨范围、并发读和 UTC/月及北京日边界。当前这些验证均 NOT_RUN。

## 新版达标通知的事务设计及权限缺口

普通提交、Human 更正及后台更正应共用 `LedgerPostingService.commitBatchProtocol`。在既有 member advisory 锁后、批次 committed 前读取申请轮次和 cutoff 内 credited before；状态切换后同一事务读取 after；仅 `before < 5 <= after` 写同事务幂等 outbox。`applicationId + threshold` 必须复用既有稳定事件键和同一 payload；已 committed 重放不得重复构造，历史转换不发送。候选成员取全部本批次成员，不能按总 delta 过滤：跨 cutoff 的冲回和重记总和为零仍可能跨门槛。不得在代码测试中发送通知。

当前仓内角色迁移未显示 Human C 角色能读取入队申请/轮次；实际 ACL 未连接验证。C 又可由 U `SET ROLE`，直接增加整表或列权限会扩大跨人敏感数据范围。应先由维护者审查最小列或受控只读方案、Human catalog 封存和反向授权测试，再在 HTTP Activities、普通 worker 和 Human scoped 三张 DI 图中安装同一 producer；不能切换管理员连接或吞权限错误。新增查询及 `enqueueMany` 对原 7/15/60 秒、500/2000 等容量的影响及真实 bind 数必须重新测量，旧规模证据不自动适用。

## 可授权的 C3/C8 维护范围

- `scripts/check-activity-workflow-gate.ts` 属红区。C3 应从实际生产代码与注册/导出图发现每个可调用入口，逐个做有效变异并报告身份，不再只变异固定四文件。C8 除旧 `attendanceRecord` 结算字段外，还须识别 committed ledger、official-time、closure、owner 读接口、端口及敏感 raw SQL，并按入口和可达调用路径判断真实 Gate 是否支配读取；无法证明的动态调用/SQL 应明确报告，不当作通过。
- 反向测试应分别覆盖新增无闸读者、从旧源换到每一种新版源、无闸分支、死代码中的闸、假 receiver、丢弃返回值、私有 helper 同时被有闸和无闸入口调用、跨文件及间接绕调。既有 legitimate 写链反对照和真实鉴权顺序必须保留；针对不同读面的精确源、入口、调用链断言应保持，不用固定数量或放宽旧断言凑绿。
- `src/common/activity-workflow/activity-workflow-gate.criteria.spec.ts` 的现有旧形状断言与上述守卫应在获准的一组变更里同步维护，不先改测试掩盖守卫缺失。`scripts/cutover-check.ts` 若改 6b 的读面身份与源码摘要采集，也是独立红区；其签字摘要只能锚定证据，不能代替维护者审阅。
- 维护者可先分别预算精确路径：`pnpm harness:needs scripts/check-activity-workflow-gate.ts` 与 `pnpm harness:needs scripts/cutover-check.ts`；如审查批准，由维护者本人对需要修改的精确路径运行 `pnpm harness:grant '<精确路径>' --reason '<实际批准出处>'`。Codex 不自发 grant。受保护的 `test/contract/openapi.contract-spec.ts` 和其 snapshot 必须一并按真实 30 条退役路由差异审查及授权更新；`ROUTE_AUTHZ.md` 与 `harness/authz-assertion-patterns.json` 也需经授权生成。
- 现有 6b 记录的 C3/C8 为 4/6，当前机器为 5/3；这反映闭包和扫描定义均变化，不可只改数字。需保留历史签字及差异，待新版发现面、反向用例、真实 PG/HTTP 证据由维护者审阅后真实签署；signoff 通过也不代表完整 cutover 获批。
