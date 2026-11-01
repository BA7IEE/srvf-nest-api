# R5 V3 更正批次边界候选

## 2026-10-29 小规模真实测试入口已接线，尚待原环境执行

已实现 `r5-setmat-owned-fixture.ts`、专用 Jest setup/config、事务结局适配和精确表清单。
每例追加一个单人合法 publication／seal／主链提交，以及一个全新 Human V3 请求和 prepare；
实际 A/B 使用原测试身份与原权限。独立参与人避免留证库既有日累计干扰，真实发起人的
User/member 绑定不改。未调用 resetDb、权限 seed、标准 e2e globalSetup 或旧请求重放。
仅显式更正作用域内切换原 caller，真实登录走原实现。全表快照按冻结名称集合逐项比对，
含 migration 元数据，没有 196/198 常数门禁；事务回执分列入口、callback、原 Promise、
engine 和独立连接的 pg_xact_status。P2028 不推定回滚，UNKNOWN 停止新增 fixture。
该入口的 6 项数据库用例仍未在本环境运行，纯测试和类型/lint 仅证明代码接线。

原来源只读入口暴露的 OID 字符串问题已修正：新查询显式 oid::bigint；历史原始证据仅接受
严格规范的十进制 OID，不改写原始 JSON。194 行 schema 差异已经正式独立审查：21 个
CHECK、全部 398 个表级 CHECK 解析结构一致，另三条 public 声明对应显式导出模式。
来源资格入口只接受这 21 对精确定义与精确 public triplet 并重建完整原 SQL；namespace
owner/ACL、数据库 owner/default ACL 继续严格比较，编译/绑定事务另核 public comment。
原入口失败记录保留；本环境没有执行原数据库编译、安全或容量实验。

## 2026-10-29 精确基线恢复与编译接续

后续正式追加包已恢复 Git 对象 `63711eb714713f208729065aaff57de2800b968a`，
tree `15998c2aeeb3eea520f1221e6831df116dc27711`，以及原包省略的 48 个基线文件。
原 17 项候选逐项还原后再应用本轮修复，没有把 main 当候选。以下较早离线检查点中
“缺少 Git 对象／test-db.ts”的阻塞现已解除；旧失败记录保留。源码、完整 test 和
scripts 三套 TypeScript 检查均重新执行并 exit 0。lane preflight 仍因保留中的脏候选
及本地缺少 origin/main 引用失败，不等同于完整工程门禁已通过。

独立安全 patch 已正式物化、校验并集成两个新增文件：
`test/e2e/activity-os-r5-setmat-concurrency.e2e-spec.ts` 与
`test/helpers/r5-setmat-concurrency-barrier.ts`。本机重新执行 10 项纯测试通过，
6 项真实数据库用例保持 TODO/NOT_RUN。未把另一份因 Library 401 未交付的验收 helper
或其 65 项纯测试计入本候选。安全 suite 还需要合法独立 fixture、最终事务观测和冻结表
清单适配；不能直接调用会 resetDb 的 createE4Fixture 来擦除留证克隆。

SQL 附件的 `catalog-binding.py` 已实现来源与编译结果的分离核验，包括集群身份、
数据库、冻结摘要、函数体／所有者／安全模式／search_path／返回契约及集合完整性。
24 项纯反例检查通过，未生成真实目录常量。`emit-compile-overlay.py` 提供只针对获准
克隆的第一阶段编译事务生成入口；必须先核对原环境只读采集与冻结 schema，再生成。
首次编译保留目录常量 NULL，随后须用独立审阅的编译目录绑定。编译器自身的离线解析
不是 PostgreSQL 16 编译，也不是权限或并发通过。

原机器新上下文执行者已独立确认集群 `7695840193603043362`、PG16.15 与 w95/w1
留证库。该身份来自父会话转交，不代表新云可连接原数据库。已交付只读采集入口；
本机不建库、角色、凭据或远程连接。真实编译、目录绑定、安全矩阵和容量验证仍待执行。

## 2026-10-29 新环境接续：集合物化仍未验收

本段记录本轮离线推进，以下旧批次边界结果保持历史范围。接续来源为私有
`SRVF-R5-handoff-20261029.zip` version 1，SHA256
`a8cc57268510d7e0de0d686b86fa241764c9724f8a5037d671994ac33247a51c`。
包内 2,986 项摘要、2,865 个源码文件以及 8 个已跟踪／9 个未跟踪候选路径均核对通过。
逆向 patch 可还原包内的基线源码内容；基线 Git 对象 `63711eb7…` 本机缺失、远端取回
返回 `not our ref`，所以当前是已校验的源码快照，不能冒称完整基线 checkout。

已完成的候选变更：

- payloadHash 的两个时间编码按 `Date.toISOString()` 表达 astronomical year 0000；
  SQL 生成器同步修复，原 slice manifest 的 `to_char` 比较不变，year 0000 仍不相等。
- V3 服务接入集合物化入口。参数来自原锁后授权的 actor；回执必须匹配锁定的 batch、
  application 和批准的 delta，完整 N bindings 与 delta 分列。只映射已知 Prisma
  P2010/P5B01、P5C01；权限、其他约束、P2028 等错误原样传播，无重试或降级入口。
- 原数据库八具名约束及两次 segment UPDATE 的时序保持；专用 guard 与唯一
  AFTER phase trigger 已装配为未安装覆盖脚本。ACL 上限仍是已批准包
  `2fde2481cbde2f5eb016cf75933f110a0fbdc7caad455c30331fe360737fdf88`。
  目录查询增加了阶段依赖表及全部 public 函数的定义／属性摘要，但完整依赖核查和
  编译后可信绑定尚未完成。脚本在任何 DDL 之前拒绝执行，目录常量保持 NULL。

本轮证据：修改前 7 组 153 项定向单测通过；修改后 183 项通过；原 71 项来源纯对拍、
10 项接口模拟已重跑。8 组 PostgreSQL 只读标量与真实服务哈希函数对拍通过，运行目标
为新环境初始化的 postgres 库，仅证明时间表达式，未安装或执行 R5 函数／触发器。
源码类型检查、Nest build 及修改文件 lint 已执行。完整 test tsconfig 因接续包明确
省略 `test/setup/test-db.ts` 产生 140 个 TS2307，不能记为全仓类型检查通过。
Git preflight 因源码快照缺少 .git 失败，不能记为完整工程门禁通过。

阻塞：新环境未配置原环境连接地址／凭据，本机实例只有 app/postgres/template0/template1，
不存在原留证库。需要重新接入原环境或提供经支持机制配置的原库连接与可验证集群身份，
以及精确 Git bundle／省略的基线文件；OID 1971161 仅为来源记录，不能证明跨实例身份。
本轮未创建数据库、角色或业务行；未消费安全矩阵、千条组件、万条真实提交次数。
actor A/B、绕过公开函数直接 DML、9 表 id=id、晚提交子行、同隔离级别撤权／缺行竞争、
真实延迟约束回滚、完整 oracle、实际 COMMIT 与零间接 DML 均仍需本轮真实验证。
不补造原库，不重放已有请求，不增加旧业务数据迁移，不推送、合并或部署。

状态（2026-10-28 UTC）：隔离 PG 候选已编译安装，小规模真实语义、权限和回滚检查
已有通过证据。正式主链和 unchanged 通过；N=10000、Δ=1 的 V3 prepare 超过原
120 秒事务预算，已停止后续 Δ=1000/10000。完整 V3 性能验收未通过，不能部署当前工作树。
来源：main `0ac9a1dbc9c1274f63f78013f69dc1f2b20cda56`；容量候选
`63711eb714713f208729065aaff57de2800b968a`。2026-10-28 用户明确批准两窄表、来源版本、
维护触发器、最小 ACL/RLS 和八具名约束时点的隔离验证包；正式迁移与发布不在批准范围。

## 决策与证据

采用“批准项可索引表示 + 局部行约束 + 阶段根完整终检”，放弃校验结果缓存。
不重写已正确的正式 allocation 集合 guard、账本成员锁、实时基线和原子审计/outbox。
不再以每行重复完整扫描作为业务不变量，也不把移除这些扫描等同于移除完整验证。

已核实：

- `20260920090000_activity_os_r4_d7_2_allocation_guard_set` 已把正式 V3 allocation
  接入 `ptar_correction_insert_guard`，AFTER INSERT / transition table / statement 级；复用。
- `20260912090000_activity_os_r4_d3_time_allocation_revision` 的
  `ptar_parent_complete_guard` 检查 command receipt，不是逐行完整来源展开；保留。
- `correction_pending_segment_guard` 每个尝试行展开 approved segments；
  `cpta_insert_guard` 每行展开 approved allocations。后者两条 INSERT 的客户端事件累计
  **91,458 ms**，属于 **prepare**，不是 commit，也不是该函数独占 CPU 计时。
- 原 segment 诊断 8,736 行的四条 INSERT 累计 104,820 ms；原型索引后五条事件累计
  2,586 ms，但 V3 prepare 仍超 120 秒。合成 segment 测试的原 lifecycle 屏障
  24,373 ms／23,760 ms；不能据此声称真实 V3 完整终检已经测完。
- 既有 `activity-os-r4-d7-time-correction.e2e-spec.ts` 的 2,000 人用例只改一段：
  **N=10,000，Δ=1**。当前 native capacity helper 原输入是 **Δ=10,000**。

旧失败原始回执继续保留于云任务证据目录：`v3-prepare-hotspot-summary.json`、
`actual-v3-timing-summary.json`、`benchmark-result.json`；不改写为 PASS。

## 唯一推荐结构与明确差额

最小持久结构候选为两个关系，不引入通用 receipt 平台：

1. `CorrectionApprovedInputItem`：复用已实验的来源派生索引思路，含
   request/source revision、kind(segment/allocation)、ordinal、原始 JSON、索引键；
   重复项保留，不给匹配键加唯一约束。批准 JSON 始终权威；源版本由数据库产生，
   维护触发器只从实际源行取值，不提供 caller 传 JSON/token 的高权限填充入口。
   畸形/超长项保持原 matcher 回退，不能在源写入时新增业务错误。
2. `CorrectionWritePhase`：每 application 分 prepare／commit 两阶段；开始时插入 OPEN，
   写完封为 SEALED。服务器绑定 application、batch、事务身份和阶段，不接受调用者
   自报“已通过”。创建阶段即排队完整 deferred 校验；OPEN 不能提交，SEALED 后不能
   再改本阶段事实，每次终检实际读取数据。prepare 与 commit 分开，commit 回滚不删除
   先前已提交的 pending。它是写入生命周期记录，不是缓存验证结论。

现有 application 只表示 preparing/committed，prepare 后仍 preparing；准备收据在
allocation/proof 写入前已存在，commit 收据又在物化后产生。不能直接把这些字段冒充
已经覆盖整阶段的封口。采用一张窄阶段表比复用 timestamp/无意义状态 UPDATE 更明确。

保留原 BEFORE pending 行 guard 的链路、索引匹配和不可变/删除约束；包括最终被
ON CONFLICT DO NOTHING 丢弃的尝试行。纯 AFTER 集合 guard 看不到这些行，不能单独替换。
新索引只是批准输入的关系表示，不是“以前校验过所以略过”。完整来源 proof 的原 JSON
和 EXCEPT ALL 终检继续复用；当前不另建一套完整来源模型。

阶段边界候选覆盖：application/request、pending segment、准备/清理 receipt、pending allocation、
evidence、source proof、binding、time correction manifest、posting batch；这 11 张表是两个
现有 lifecycle checker 的直接读取闭包，**不是全部账本工作流**。其他现行外键、manifest、
formal materialization、ledger、成员/日锁约束继续执行。必须明确合法写入口与每表
INSERT/UPDATE/DELETE/TRUNCATE 的阶段规则，禁止只约束 Service 而放任直接 SQL。

已核对的仓内写入口：`AttendanceCorrectionWriteService` 创建/更新 request 与 application；
`CorrectionApplicationService.prepareV3PendingSegments/preparePendingSegments` 写段和准备收据；
`CorrectionTimeAllocationService.prepare/createProof/materialize` 写 pending allocation、evidence、
proof、binding 与正式 allocation；`ParticipationTimeCorrectionService.prepare/createCommitReceipt`
写 manifest 与 commit receipt；`LedgerPostingService` 提交 batch。operator 函数
`cleanup_correction_pending_segment` 另有受控删除路径。共享 batch 还被 preparation/review/
legacy conversion 使用，阶段规则必须按实际 V3 application 绑定，不能全表施加新协议。
正式 segment、allocation、command receipt 的现行 guard 只加所需阶段资格检查；原集合
校验不重写。slice/evidence 等子项仍由原锚点与完整配对约束负责，不宣称 11 表就是全链。

本地 SQL 已装配 14 个直接写 gate（上述 11 表及 3 个正式物化关系），并在数据库
preflight 核对其关系、函数、事件类型与启用状态。正式 draft 段创建时尚无 effectiveBatchId，
用 pending allocation 的唯一 targetSegmentRevisionId 绑定；旧段 supersede 查本次替换
application，不能要求历史已封口的 application 重新 OPEN。这是代码层面的接线修正，
不是已经证明全部直接 SQL 和跨版本更正合法性的 PG 结果。

需要小规模 PG 证明的目标：封口后的所有合法与直接 SQL 写入都被原不可变约束或新阶段守卫
覆盖；批准 JSON 变化不能给已有 application 偷换输入；源版本变化必须拒绝旧阶段而非
重建索引后视为已认可。具体允许变更的阶段与旧 SQL 异常时点差额须随 DDL 冻结，
本地设计尚不能作为这两项已经安全的证明。

原 8 个具名约束不是无变化配套：
`correction_application_preparation_receipt_required`、`correction_pending_lifecycle_check`、
`correction_preparation_lifecycle_check`、`correction_cleanup_lifecycle_check`、
`cpta_lifecycle_guard`、`cptae_lifecycle_guard`、`ctsp_lifecycle_proof_guard`、
`ctsp_lifecycle_batch_guard` 的事件根需从明细收敛到阶段根。
必须保留具名强制检查入口，明确 OPEN 时 IMMEDIATE 拒绝、SEALED 时完整检查；不能声称
保留名字就等于保留旧每行排队/异常时点。V1/V2 与 operator cleanup 默认仍走原语义；
其 2,000 段清理上限不是本轮自动升限项。

当前候选保留旧明细触发事件以维持 V1/V2/cleanup 入口；V3 的旧回调只检查本事务
SEALED 阶段义务，不存储“校验已通过”。阶段表八个具名终检分别重新执行原始检查：
四次段/收据计数，四次完整 ctsp 检查。因此重型检查次数固定，但轻量明细事件仍随行数
增长，不能声称数据库只执行八个触发事件。分类读取同源版本的受保护原始 header，
缺失时才回退源 JSON，避免新 gate 又逐行展开整份批准文档。

## 权限和实现范围

需要单独明确的数据库操作包：前向 migration 154、新增两表、source revision/私有 sequence、
限定源关系的维护函数/触发器、阶段边界与终检接线，以及新对象最小 ACL/RLS。
拟名 `20261029000000_correction_batch_validation_boundary/migration.sql`，当前未创建。
受限 owner 只维护派生项，不持有原源表、不授予调用者该 owner；原 INVOKER guard 的
源可见性、列读取权限和 RLS 不得被高权限维护函数替代。
本轮不创建角色、不发 grant、不假设运行账号已经与 owner 分离。源码未提供真实运行账号
和有效 ACL/RLS 的完整证明；这是数据库接线前必须补齐的事实，不是让用户猜角色名。
如果需要新的持久角色或更广源读取权限，必须列具体差额，不能自动扩大本包。

后续正式写集最小核心：

- `prisma/schema.prisma` 和上述单个前向 migration；历史迁移不改。
- `src/modules/activities/correction-application.service.ts`：在现有锁内打开/封口阶段，
  调整 `readPreparedSegmentCount` 的实际触发器检查；不改事务边界。
- `src/modules/activities/correction-time-allocation.service.ts`：仅必要的阶段绑定与批量输入接线；
  保留现行 formal materialize、binding 批量写入和 proof 内容。
- 对应 service 单测；新增 `test/e2e/activity-correction-batch-boundary.e2e-spec.ts`；
  既有 D7 更正及 native capacity 夹具/验收入口；必要 handoff、changelog、迁移 pins 与生成物。
  机械配套必须在真正 DDL 内容固定后由现有工具精确展开，不提前虚报文件总数。

本轮实际普通本地写集共 11 路径：

- `src/modules/activities/correction-application.service.ts`：V3 创建 application 后 begin prepare、
  最后审计前 seal；commit 在 replay 分支后 begin、状态转换后且最后审计前 seal。V1/V2
  不接新协议，原事务边界、预算与账本协议不改。
- `src/modules/activities/correction-write-phase.ts` 及 `.spec.ts`：参数化调用数据库协议，
  检查返回的 application/phase/state/batch/protocolVersion。缺 SQL 或错误回执直接失败，
  不以客户端布尔开关提供安全保证，不自动回退为未受保护的写入。
- `test/helpers/correction-batch-boundary-candidate.sql`：仅安装于本次新隔离库的 SQL 候选。
  执行绑定新隔离库名/OID/两角色；拒绝 OID1713092，拒绝含旧 request 的库。
  installer 不创建角色；runtime 必须与表/函数 owner 分离，无高权限、schema CREATE、
  enforcement 表 TRIGGER/TRUNCATE 或索引写权限。已验证隔离 V3 caller 资格，未证明部署角色资格。
- `test/helpers/correction-batch-boundary-contract.ts` 与
  `src/modules/activities/correction-batch-boundary-contract.spec.ts`：固定 11 表、8 名约束、
  23 类故障目标和 3 个 N/Δ 形状；装配检查只证明列举与接线，不能代替真实 PG 矩阵。
- `test/helpers/native-capacity-change-shape.ts` 及默认 unit 入口下对应 `.spec.ts`：
  固定 2000 身份/每人 5 个不相交 20 秒段，按完整桶计算部分更正输入；拒绝不符夹具。
- `test/helpers/native-capacity-corrections.cases.ts`：同一 `timeChanged(1 | 1000 | 10000)`
  入口，每个完整 fixture 只消费一种形状。只改变选中段及对应 allocations，其余来源
  仍纳入 10000 bindings / 50000 slices；Δ=1 已运行并失败，另两种没有运行。
- `test/helpers/correction-pending-set-candidate.sql` 与本文：保留独立集合匹配参考和边界说明。

固定夹具输入的分类桶 floor 预算分别为 199996、196000、190000 秒；只用于构造批准
输入和独立期望，最终仍须原 frozen oracle 验证。默认全变化入口保留原 10000 pending、
190000 秒、20000 segment revisions / 30000 allocation revisions / 150000 physical slices
的严格数字断言。增加部分形状不放宽原满额验收。

本地类型检查、lint 与纯单元已通过，真实 PG 结果见下节。隔离角色验证不代表生产角色
配置；未安装候选 SQL 的原 153 库缺少服务接线所需函数，不能直接部署这份工作树。

## 本次隔离验证结果

固定 SQL SHA256：`283a1626d54032142c63407773e42f27c7a2e03095a75efd2f7a19d43239a03b`。
运行前 11 文件清单与摘要保存在 `frozen-before-full.json`；本文的结果更新发生在运行后，
不改变本次运行绑定的 SQL 或 TypeScript。

- 小规模：原匹配与候选匹配 31 项差分；ACL/RLS、嵌套、savepoint、八具名约束、
  漏封口/封口后写入、真实 prepare/commit 回滚与重放、后续真实 V3、并发锁冲突均有实际回执。
  错误 receipt 数量在真实 SEALED 后被具名终检拒绝并回滚。此前设置缺权限、临时驱动摘要
  错误和提前被旧 guard 拒绝的探针原文保留，不合并为全绿。V1 初始化/主链使用测试 owner，
  V3 由独立普通测试 caller 执行；没有据此证明未来部署账户权限。
- 原有完整纯单元 10598 passed、4 个既有 TODO；本次 SQL 投影修正后受影响 49 项通过。
- 满额正式主链：PASS，446955 ms；unchanged：PASS，126387 ms，标准 7 秒 commit 实测
  2941 ms，重放不重复记账。各按原独立 600 秒阶段封套，不能称合计小于 600 秒。
- V3：N=10000、Δ=1，真实 Human 提交/批准成功；prepare P2028，预算 120000 ms，
  报错事务年龄 147687 ms、客户端 prepare 墙钟 147730 ms。commit 和较大两档均未运行。
- pending segment/allocation INSERT 为 6/10 ms，仅代表 Δ=1。8000 行评价 INSERT 为
  40301 ms，其同步 statement guard 包含完整贡献校验；随后显式完整校验为 41404 ms。
  最后 ready UPDATE 缺少完成事件；单次现场仅见 active、无等待，不能拆分内部函数耗时。
  新 phase seal 及八个 phase 终检尚未到达，不能把此次超时归因于它们。
- 失败后只读核实：两 committed 批次、12000 账本行、2000 个 version=2 日状态保留；
  V3 请求仍 approved，application/pending/proof/phase/manifest/新贡献根均为零；连接、
  事务和锁为零。本次大规模失败前未采集完整 198 表指纹，因此是结构性回滚证据，不能
  声称与小规模故障注入相同的全表前后逐字相等证明。

证据：云任务 `batch-boundary-candidate-20261028` 下 `small-pg-summary.json`、
`sealed-count-negative-result.json`、`full-delta1/full-result.json`、
`full-delta1/timing-summary.json`、`full-delta1/postfailure-readback.json`。
失败库 OID1796070、小规模库 OID1789089 与两个 NOLOGIN 实验角色暂留取证，清理未完成；
原保留库 OID1713092 未连接。没有正式迁移、推送、合并、部署或重启旧缓存复核。

### 本次失败后的全路径校正

此前成本模型只处理 pending 匹配和 CTSP 明细事件，把 E4 当作可直接复用的已有校验，
没有核算满来源 V3 分支的真实成本。这是设计遗漏；本次尚不能证明候选引入了 E4 回归。
失败库中的 E4 函数正文已与受信 migration 146/153 和原 statement/posting guard 逐一核对。

| 正常成功路径            | 必经检查                                                                       | 次数与实际证据                                          |
| ----------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| prepare 读基础根        | `e4_assert_complete(base)`                                                     | 1；此次 1183 ms，基础为 unchanged 分支                  |
| prepare 插入 8000 评价  | statement guard → `e4_assert_complete(new,FALSE)`                              | 1；INSERT 包含 guard 共 40301 ms                        |
| prepare 读账本日行      | `assertVersionInTx` → `e4_assert_complete(new,TRUE)`                           | 1；此次 41404 ms                                        |
| prepare ready 更新      | `e4_native_posting_guard` → complete + ledger complete                         | 各 1；未完成，内部耗时未知                              |
| prepare COMMIT 尾部     | 新贡献根 INSERT、新版本 INSERT、新版本 contentHash UPDATE 的 E4 deferred guard | complete 共 3；本次未到达                               |
| prepare/commit 阶段尾部 | 八个新 phase 约束                                                              | 各阶段 4 次 pending lifecycle + 4 次 CTSP；不是 8 次 E4 |
| commit 成员锁内         | service `assertVersionInTx(version,batch)`                                     | complete + ledger complete 各 1；尚未运行               |
| commit committed 更新   | `e4_native_posting_guard`                                                      | complete + ledger complete 各 1；尚未运行               |

因此新根 prepare 共 6 次 E4 complete，commit 共 2 次；正常 commit 当前写集不会额外排队
E4 root/version deferred 事件。prepare 时排队的事件不跨事务进入 commit。
设每次完整重算成本为 F、其他阶段工作为 A/B，必须同时满足 `6F+A<120s` 和 `2F+B<15s`。
这只是成本约束；不能用此次 41.4 秒乘次数冒充未执行阶段的实测。即使不计其他工作，
commit 的必要条件已是每次小于 7.5 秒；目前没有证据证明该条件能满足。

完整重算依次包括两份 D7 proof 文档的规范化/哈希、10000 来源/50000 切片到 8000 桶的
来源配对、按评价单位聚合与规则求值、8000 评价双向完整比较、根摘要及版本结果核验。
V3 source_ref 带 `correctionSource`，不能命中目前仅接受九个平坦字段的规范化快路径。
correction 分支仍把 JSON bucket 集合放在 lateral 配对中；没有内部执行计划，不能据文本
宣称已实际执行 50000×8000 次循环，也不能给这些子步骤分摊 40 秒。

最小下一候选是仅改 `e4_source_rows` 与 `e4_assert_complete` 内部查询：来源桶一次展开
后做保留重复的关系连接，正常 V3 文档采用严格形状的等价规范化，其他输入仍走原逻辑。
所有触发次数、原错误/NULL/重复语义、完整差集、权限、事务和预算保留；不能只优化当前
INSERT 而忽略 prepare 尾部和 commit。该候选尚未实现或验证，收益为 UNKNOWN。

直接把 E4 归并进现有 phase **不是零契约变化的接线修复**：14 个 gate 没有覆盖贡献根、
评价、settlement version/result、day、ledger 六类表；前两类 version/result 创建还发生在
begin phase 前。它会改变 evaluation 语句结束检查、ready/committed 更新前检查和原 E4
deferred 时点，不在此前八约束调整的已验范围。不得只删除重复调用或宣称原两窄表已覆盖。

## 成本模型和固定验证顺序

N 为完整来源，Δ 为实际修改段数，E 为本次证据行，S 为切片，R 为排队终检次数。
现有准备存在 O(Δ²) 批准项匹配和 O(R×(N+Δ+E)) 重复终检；R 至少随 Δ 增长。
N=Δ=10,000 时仅来源遍历就可能累计至少 10^8 个元素。
120 秒除以 10,000 次只余每次 12 ms，尚未留读取、写入、锁和完整屏障成本。
不能靠一处常数优化保证达标。

目标为批准项一次建立、局部 O(Δ log Δ) 查键、明细事件的 O(R log Δ) 阶段资格检查，
加固定数量阶段终检 O(N+Δ+E+S)，排序/EXCEPT ALL 可能增加 log 因子；这是设计目标，尚无实测。
畸形回退可较慢但必须拒绝正确，不能因此扩大成功路径预算。

| 阶段                     | 保持的时限/不变量                               |
| ------------------------ | ----------------------------------------------- |
| V3 prepare               | 原交互事务 120 秒；失败回到 prepare 前状态      |
| Human V2/V3 commit       | 15 秒；失败回到 commit 前状态，保留成功 prepare |
| unchanged V1             | 共享标准 7 秒，不能用 Human 档替换              |
| 普通 policy_v1 E4 commit | 现行具名 60 秒，不能误称全部账本 7 秒           |
| 成员锁/准入              | 每次取锁 4 秒、10 槽，锁序及锁内复核不改        |
| 正式摘要/最终 oracle     | 3 查询/5 秒；oracle SQL 30 秒                   |

验证顺序：

1. 固定 N/Δ 输入与非触库单测、类型/lint；冻结 SQL 候选和语义风险。
2. 仅在已获准隔离库：小规模 PG 原/候选差分及阶段故障矩阵。包括冲突忽略行、重复键、
   NULL/缺键/转换错误、直接 SQL、源变更、来源/目标删除、savepoint、嵌套、并发、
   各具名 IMMEDIATE、漏封口/封口后写入、prepare/commit 分别回滚、权限与 RLS。
   先证明合法成功集合相同；明确技术错误差额，不能修改 expected 迎合结果。
3. 固定 N=10,000，Δ=1／1,000／10,000，各一条真实 Human V3 主链。
   所有形状记录真实身份数、pending 数、完整 N 来源、bindings、oracle、账本/audit/outbox
   与重放/回滚证据；不得用小 Δ 代表全修改。正式主链与 unchanged 前驱沿真实入口。
4. 每阶段保留原预算；此前拆段恢复不能冒充原单封套 600 秒通过。
   三次重复/形状仅为可选稳定性验证，未经决定不扩为固定必跑。
5. 绑定最终树的 CI/Smoke/Trusted/audit 后才谈交付。完整 nightly 与延期四功能
   不自动加入这次仓内硬门；未完成 V3 也不能被 limited500 标签掩盖。

首个语义差异、越权、无法保证原子性或真实阶段超时即停止后续重测，保存原记录并定位。
禁止抬预算、减数据、删 oracle 或循环刷绿。新结构未写生产，不需要回滚生产；未来失败
候选用新隔离库保留，不降级既有证据库。新空库仍完整执行历史 migration 链后应用 154。
工作量依据是两表/一个前向迁移、两处编排、上述小规模故障矩阵和三个真实规模形状；
ACL 绑定、具名约束兼容和完整 V3 新耗时未证实，不能据此承诺日期。
