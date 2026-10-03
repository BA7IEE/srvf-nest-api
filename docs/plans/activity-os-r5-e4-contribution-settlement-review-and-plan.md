# Activity OS R5 / E4 贡献政策接入结算：评审与精确实施计划

> 2026-10-03，**方案 A 待审、未实施**。本轮只授权 E3 当前状态更正、E4 文档验证和 Draft PR。
> 本文候选写集、命令和 Goal 均不是已发放授权；E3 授权、shadow 证据及本 PR 合入不自动授权 E4，更不授权 E5 上线。

## 1. 当前事实与交付边界

- 基线 main `f19191b43060a5e67ff32ac36cf4c97edd29d5d0`；[#1378](https://github.com/BA7IEE/srvf-nest-api/pull/1378) 已合入，[同 SHA main CI 37100521877](https://github.com/BA7IEE/srvf-nest-api/actions/runs/37100521877) completed/success，五个 Contract + E2E 分片与聚合通过。push 上 report-only 红区 job 跳过，不把 skipped 写成 passed；PR 的 trusted 审批另已通过。
- E1 政策版本／选择、E2 隔离转换能力、E3 离线比较／不可变来源与映射证明／复核窗口和逐项签字已在仓内交付。E3 当前验收见[既有评审稿 §32](activity-os-r5-e3-contribution-shadow-review-and-plan.md#32-e3-当前状态收口2026-10-03)。
- **仓内能力不是实际业务验收**：31 类真实映射继续 hold；未部署、未登记真实窗口或签字、shadow／Gate 未开启，D8-OPS 未执行。E4、E5 均未实施。
- 当前 136 条 migration、194 个 Prisma model、273 个权限码、178 个审计事件（173 活跃）。这些是本次代码基线读数，不是未来验收承诺；SQL 定稿与真实生成计数后再签字。
- 历史 D7 收据 28.812 秒、七秒 P2028 未复现根因和 w86 原现场原因继续 UNKNOWN；本轮 main 绿只证明该 SHA 的该次验收，不关闭历史根因。

蓝图 Release 5 的分工是 E3 shadow、E4 结算接线、E5 正式切换／旧规则只读。蓝图是需求来源，不是授权入口。E4 推荐完成默认关闭的新结算全链，E5 仍单独决定正式启用。

## 2. 只读引用链核对

| 现有事实                                                                          | 代码锚点                                                                                                                                      | E4 影响                                                                  |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 发布快照 V9 固定贡献政策选择；历史 V1–V8 为空                                     | `prisma/schema.prisma` / ActivityRuleSnapshot、ActivityContributionPolicySelectionRevision、Item；`activity-contribution-policy-selection.ts` | 从不可变发布快照解析最终活动／场次／岗位选择，不能查“当前最新”顶替       |
| 政策 evaluator V1 是角色 × 类别 × 秒数分档，存在明确 defaultResult                | `activity-contribution-policy-definition.ts` / evaluateContributionPolicy、prepareContributionPolicyVersion                                   | 复用原 evaluator 与 canonical/hash；不改定义，不臆造表达式或模板专属算法 |
| 草稿贡献仍由旧 activityType × role 规则预填                                       | `settlement-draft.service.ts` / applyContributionPoints；attendances ContributionCalculator                                                   | legacy 路径保留；native 不伪装成旧预填完成                               |
| D4 prepare 冻结分类来源和桶；submit 同事务复制到提交版本                          | `activity-time-settlement.service.ts` / prepare、submit；`settlement-submit.service.ts` / submitTimeSettlementInTx                            | 在已有事务内增加贡献证明，不另外提前提交时长或账本                       |
| V1 内容 hash 与 D4 V2 hash 是不同域                                               | `settlement-content-hash.ts` / computeSettlementContentHash、computeTimeSettlementContentHash                                                 | native 使用明确 V3 hash 域，V1/V2 重放不得重算                           |
| 贡献分录读认定值、按北京日分配并每日封顶                                          | `ledger-preparation.service.ts` / readResultRevisions、applyDailyCap、writeLedgerEntries；`ledger-day-allocation.ts`                          | 保留 recognized = credited + cappedOut，不能裸 SUM 或按活动时区封顶      |
| D7 更正经 CorrectionApplication 和 LedgerPostingBatch，锁后完整性由数据库守卫兜底 | `correction-application.service.ts`、`participation-time-correction.service.ts`、`ledger-posting.service.ts`                                  | 更正继承原政策／计算制度，旧分录冲销和新分录同批次提交                   |

本轮只读文件／GitHub，不连接任何业务库或测试库。activities 无模块 AGENTS.md；沿根规则与现有职责边界。四个接线服务分别 602／912／938／3,129 行，CODEMAP 的 activities 为 XL ⚠G；不以行数为由抽离旧逻辑。新增职责只承载新贡献能力，不做多边界存量重构；改编排前先跑现有 characterization。

## 3. 推荐方案 A：一包接完，默认关闭

### 3.1 制度与启用边界

- 在新草稿版本创建时固定 `contributionRegimeCode = legacy | policy_v1`，数据库默认 legacy。旧版本不回填 native，后续 worker、prepare、submit、审核及更正读已固定制度，不靠当时环境重新选择。
- E4 的独立配置 `ACTIVITY_E4_CONTRIBUTION_SETTLEMENT_MODE` 仅允许 off／fixture；缺省 off，fixture 只允许 APP_ENV=test，production／smoke／development 设 fixture 均拒绝启动。不复用 E3 shadow、不改 v1.1 Gate、不提供 active 值。E5 如需 active，必须另行评审扩展及生产授权。
- off 下新普通命令维持旧制度；已存在 policy_v1 的只读／合法幂等回执可读取原结果，off 下新写拒绝，不能偷偷降级 legacy。
- fixture 模式只能在具名隔离测试配置中启用；生产不可被环境误填打开。本期没有 CLI 强制选制度、没有客户端制度参数、没有真实旧规则转换。
- policy_v1 仅用于尚无提交／入账历史的新 run；历史 legacy run 及其更正始终 legacy。native 更正继承基准版本的制度与政策版本，不顺带开放换政策。
- 新制度先产生待计算草稿；贡献未 prepare 的状态显式 pending，不以 0 或旧规则建议值伪装正式认定。D4 来源齐备后 prepare 计算；submit 在同事务创建认定结果与贡献证明。旧 draft 结果行不原地改写。

### 3.2 必须由维护者拍板的业务口径（本稿推荐，不当成已经批准）

1. **一次评价的单位**：同一 participation identity／场次、同一最终政策版本、同一时间类别合并认定秒数后评价一次，不按服务段／日／slice 重复发固定分。多个类别结果相加；类别缺失、来源未准备好均阻塞，不把未知当 0。
2. **独立于服务小时**：训练／组织等非志愿类别可以贡献大于 0、志愿服务小时为 0；志愿服务有小时也可按明确政策输出 0。not_required 明确输出 0 及解释，missing／unresolved 不等于 not_required。现有缺勤／early_departure_zero 维持 0，pending 不提交。
3. **数值与人工调整**：复用 V1 每项 0–999.99 定义及整数秒输入；合计超出现有 Decimal(5,2) 上限就拒绝，不截断、不开大列。native 贡献值由证明导出，不接受客户端手写覆盖；如确需人工特殊奖励须另议，legacy 原人工认定保持不变。
4. **跨日口径**：评价先按上述单位一次计算，再按该单位真实认定时间覆盖的北京自然日秒数，沿既有确定性最大余额／稳定平局规则分摊到分；各日合计必须等于认定值，随后每日封顶。0 秒且非零分无可证业务日期时阻塞，不凭 createdAt 分摊；0 秒且 0 分可形成零项证明，不造账。

### 3.3 事实来源与政策选择

按发布快照中的最终 resolvedConfig／selection item 解析，不自行重新定义层级优先顺序；岗位、场次、活动、成员、身份、段、时间分配必须同活动同版本。角色取冻结的参与身份事实，不读取今天的任意角色替代。整秒输入只来自已确认分类 slice／来源，不能把旧两位 serviceHours 反推精确秒数。类别仍沿现有四值闭集。

policy_v1 要求 V9 贡献选择与可验证分类时间来源；历史无选择只可保持 legacy。固定 policyId／versionId／definitionHash／evaluatorVersion 和 selectionRevisionId／hash、ruleSnapshotId／hash。提交校验已审批引用及被冻结生效事实，不按今日 retired 状态重算历史；首次引用无批准证据拒绝。E3 比较 equal 或无缺口签字不替代 E4 该来源／政策链验证。

### 3.4 方案对比与回退

方案 A（推荐）是独立默认关闭制度、不可变证明及完整接线；能一次验收原子性和更正，代价是两表、V3合同与兼容测试。方案 B 只替换旧 calculator 或只写应用层摘要，改动少，但无法证明输入/政策同链、会混淆历史重放，因此不推荐；若暂不承担完整包，应保持旧制度并延后 E4，而不是半接新分值。

回退先恢复 off、停止新 native 写，保持历史只读与原回执，不删证明、不回滚已提交账本、不重新解释旧版本。代码 revert 只能回到仍能读取 native 证据的兼容版本；数据库 migration 不执行 down。隔离验证失败只按具名测试夹具回收；未来生产已入账后的恢复是 E5 独立审查事项。

## 4. 数据合同与第137条 SQL 候选

**两张新表**，活动域所有；新 migration 候选路径在 §8，序号依实施时 main 再核验，禁止改第1–136条 SQL。无旧表业务 DML、回填、删改或重算。

### 4.1 ActivitySettlementContributionRevision

字段：id／createdAt（数据库时间）；activityId、settlementRunId、settlementVersionId、timeRevisionId；revision；kindCode=draft／submitted／correction；previousContributionRevisionId、sourceDraftContributionRevisionId（按 kind 配对可空）；schemaVersion=1、regimeCode=policy_v1；evidenceSealId、evidenceRevision、populationRevision、workflowRevision、draftContentHash；ruleSnapshotId／hash、selectionRevisionId／hash；sourceSetHash、evaluationSetHash、recognizedPointsTotal Decimal(18,2)、evaluationCount；operationKey、requestHash、createdByUserId（沿现有 actor FK 范式）。该根合计覆盖多人，用宽精度；既有逐人认定列仍保持 Decimal(5,2)，不把多人总分错误限制为999.99。

draft 固定原草稿，submitted 固定新提交版本并指向 draft；correction 固定实际更正的新版本与前驱。operationKey 绑定 actor／operation 的既有命令域，不做另一个客户端命令。revision 唯一于 run；(id, activityId, settlementVersionId, timeRevisionId) 为同链被引用锚；相同内容可复用，合法重放返回同一证据。不新增可自由更新的生命周期字段；kind 是不可变类型不是状态机。

### 4.2 ParticipantContributionEvaluation

字段：id／createdAt（数据库时间）；contributionRevisionId、activityId、settlementVersionId、participationIdentityId、memberId、sessionId；ruleSnapshotId、selectionItemId；policyId、policyVersionId、definitionHash、evaluatorVersion（not_required 时政策四元组全 NULL，否则全非空）；mode=policy／not_required；attendanceRoleCode、timeCategoryCode；durationSeconds（非负整数）；sourceRefsJson、sourceFingerprint；calculatedPoints Decimal(5,2)、recognizedPoints Decimal(5,2)、explanationCode；beijingDayPointsJson、evaluationHash。native 不支持人工覆盖，因此 recognizedPoints=calculatedPoints。

增加非空 evaluationUnitKey，canonical 编码 identity／场次／policy四元组／冻结角色／类别，唯一 (contributionRevisionId, participationIdentityId, evaluationUnitKey)，避免不同selection item指向同政策时被重复评价。selectionItemId为该组排序最小的真实来源代表，sourceRefsJson同时固定并校验全组selection item引用，不能丢弃其余来源；not_required 用独立mode域编码且保留真实选择。源引用含具体 allocation revision／slice、来源段及冻结 hash，不接受裸合计秒数；JSON 字段有闭集、沿原D4来源容量和 canonical 顺序。零项 revision 合法但须与真实零参与集一致。

### 4.3 现有列与 SQL 守卫

AttendanceSettlementVersion 仅加 contributionRegimeCode，默认 legacy、创建后不变；追加新关系与被引用复合 unique，不改原状态／锁顺序。ActivitySettlementTimeRevision 等现有来源只加关系或必要同链复合 unique，不改事实列、旧 hash 或时长语义。

- 全部新 FK 为 RESTRICT、同活动／同版本复合锚；政策 FK 对齐 id＋policyId＋definitionHash＋evaluatorVersion。不靠 Prisma 单列 id 假装同链。
- CHECK 固定 kind／regime／schema／mode、政策四元组成组 NULL、非负秒数、两位 points、SHA-256 格式及 kind 前驱规则；来源/结果身份与 member／session 同链。
- 两表禁止 UPDATE／DELETE／TRUNCATE；受控测试清理在既有 helper 中禁用具名守卫并恢复检查，不能关生产守卫、用未限定 CASCADE 或终止连接。
- 评价集合守卫按实际集合复算 source／evaluation canonical hash、来源秒数、政策 evaluator 输出、北京日分摊及总数／总值。零集合、漏项、重复、跨活动、篡改 defaultResult／解释、溢出、未知 JSON 字段都 fail-closed。
- 原提交／最终 LedgerPostingBatch committed 时，同事务最终集合检查验证 policy_v1 认定行和证明一一对应；legacy 不创建新证明但保留原完整约束。不能因“应用层校验过”跳过 DB 守卫。
- 新集合写采用参数化单语句／集合触发器与有键查询，不用逐行全量扫描；约束时点必须在 submit、commit 原子提交前。既有冲突跳过行仍要求最终集合完整，不能把 count 输入数当实际插入数。
- 不增加 SECURITY DEFINER 任意写入口、DB 角色、ACL 或 runtime 权限。确需受限执行函数时先呈报具体执行面并另签 4b，不能让此条自动扩权。
- SQL 正文、索引计划和测试必须实施后给出实际摘要；本稿没有预签 SQL，也没有声称迁移可执行。

## 5. 全链接线、hash、封顶与更正

`生成并固定制度 → D4分类来源 → E4 prepare证明 → submit V3冻结 → 原一审／终审 → LedgerPostingBatch原子入账 → 原关账／版本读取 → 同制度更正冲销＋新账`。

1. generation／batch job 固定 regime；native 草稿的贡献 pending 不冒充 legacy 有效规则。旧规则 calculator、默认草稿和原 blocker 原样保留。
2. D4 prepare 的原事务内，用已有分类来源构建贡献 draft revision；两次 prepare 同内容可复用，不同 operationKey 保留各自原审计，重放不重复写。仍执行锁后资格复核；失败回滚整个 prepare，不留下“时长准备成功、贡献未成功”的半成品。
3. submit 先检验原 seal／三个 revision／draft hash／time proof，再校验新 contribution proof；一次事务复制时间与贡献证明、写政策认定结果。V3 域包含原 V1 hash、D4 bucket/source hash、贡献 selection/source/evaluation hash与 regime；V1/V2 验签函数及重放保持不动。
4. original calculated/recognized 字段在 native 新提交结果中来自已冻结评价，readResultRevisions 因而读取正式同一真值；不另加可绕过封顶的正积分表。prepared→committed 可见性、成员／北京日 locks、day-state CAS、credited/cappedOut 与现有事务都保留。
5. 训练等 0 volunteer hours 的积分必须从自己的分类认定日分配，不能错误套用“没有志愿服务日则无积分”条件。service_credit 与 contribution_credit 分开，正反例覆盖两个方向独立。
6. 审核比较、审核详情及提交时均展示同一 V3 锚；policy_v1 缺证明拒绝，不能补默认分；审核人分离／两轮权限复核／已冻结版本依原约束。
7. native 更正固定 base 政策／制度，按真实更正时间事实生成新评价证明；时间不变时复用同内容证据，变更时重新评价并冲销原 contribution_credit／重建封顶。新旧两组与 time correction 同批次原子提交。客户端手填 native points 与跨制度更正拒绝，V1/V2／直接旧提交／重放保留原路径。
8. commit 保持原七秒、prepare 原三十秒及其他既有五秒边界；不通过调超时、固定 sleep、模拟 DB 守卫或拆原子性做绿。失败先有界阶段/查询/计划证据，首个满额瓶颈未达标先呈报，不猜测重跑。

## 6. 访问面、审计与前端契约

**不新增端点、controller、权限码或角色默认授予。** 沿既有 Human 调用面及 scoped／GLOBAL 原判权；SP／delegation 不扩展。采用原 E4 涉及写／读权限的具体验证，不用开关、前端按钮或 SUPER_ADMIN 代替 service 判权。

| 既有端点                                                                      | 原 surface／声明                                                                                                              | 建议变化                                                                                                                                         |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET `/api/app/v1/my/managed-activities/:activityId/time-settlement`           | Mobile - Managed Activity Time Settlement；activity.time-settlement.read，app-member、authz-scoped，responsibility／org-scope | 独立 App DTO 增可选 contributionProof 摘要（regime、revisionId／hash、policyVersionId、解释码、认定值／pending）；不返政策完整配置或他人域外数据 |
| GET `/api/admin/v1/attendance-settlements/:settlementVersionId/review-detail` | Admin - Attendance Settlements；attendance.read.sheet，rbac-global                                                            | 独立 Admin DTO 增同版本证明及逐项解释，不借此读 E3 原审计或真实签字详情                                                                          |
| 既有 prepare／submit／first/final review／更正命令                            | 当前 controller、路由声明与 service 锁后复核不变                                                                              | 入参及路径／方法／tag 不变；仅测试模式可形成 native V3；不借 additive DTO 谎称无业务语义变化                                                     |

JWT／route 声明保留，无 @Public 或新限流。读取证据不代表取得政策管理权限。新的解释码只说明计算来源，不含 L3、连接串、原审计 payload 或 signed URL。legacy 的可选证明字段缺省省略，不强行变 required、不改变旧字段意义；App 不派生 Admin。分页明细仍遵循现有限额，不返回满额来源大 JSON。

复用已有 prepare／submit／review／correction 审计事件，只添加受限 V3 hash／revision／regime 摘要；事件名、旧载荷和重放语义保持。预计权限273、审计178／173、字典30类277项和 seed 不变，但访问说明与数据库执行面仍须真实复核后重签4b；不写死未来摘要。

OpenAPI 两份快照、offline openapi 与13 client生成文件必须同 PR 更新并逐行可解释；原 EXPECTED_ROUTES 零增删。miniapp／admin-web 补 pending→prepare→submit、解释、旧端兼容提示；契约回执表仅登记后端候选，不冒充前端编译／发布回执。纯 tag-only=false（additive 字段＋native 行为），不冒称零契约漂移。

## 7. 风险表与验证顺序

| 风险                 | 正向证据                                                         | 反例／失败边界                                                                   |
| -------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 制度误切／部署误开   | off 下旧 HTTP 全链和 V1/V2 checksum 不变；fixture 仅 test        | production/smoke/development fixture、历史 run 变 native、off 下新 native 写拒绝 |
| 重复计分／政策漂移   | 分段重排同 hash；同 identity/category 合并只评价一次             | 跨活动/version、漏 slice、改默认结果/解释、retired 历史重算、未知选择拒绝        |
| 贡献与志愿小时被误绑 | training 0小时有分、volunteer 有小时0分                          | 不能将 non_creditable 当“贡献恒为0”，必须按明确政策定义                          |
| 跨日／封顶           | 北京跨午夜、多个活动、分摊分位、稳定顺序、credited+cappedOut守恒 | 无来源日期却非零、溢出、按活动时区或裸SUM拒绝                                    |
| 权限及资格竞态       | 原 scoped/GLOBAL、锁后身份/绑定/权限再读                         | 移除权限、成员失效、跨活动读、SP/delegation拒绝；不默认授予15内建角色            |
| 重放／故障原子性     | 原 operationKey 同 actor 重放同proof；受控阶段故障全回滚         | 同键异payload、缺证／陈旧 proof、复制部分失败、commit失败不得半入账              |
| 更正后守恒           | 原批次冲销＋新贡献日分摊，与时间一起提交                         | 跨制度、客户端伪造points、并发更正／封顶冲突、基准缺证拒绝                       |
| SQL性能／集合守卫    | 真实触发器、真实锁、实际集合计数／计划                           | 逐行N+1、关守卫、加超时／sleep均不验收                                           |

实施验证队列（本轮不运行）：

1. 无写前查 main／PR／授权精确覆盖；既有 contribution-policy、draft、submit、D4、D6、D7、daily-cap characterization 先跑。D7满额历史 UNKNOWN 不随本功能顺手改。
2. schema/generate、两表＋136→137 migration：w98空库冷回放、非空升级、全部旧SQL checksum、旧历史目标不改、新表空及默认legacy/off；直接SQL负例和守卫恢复证明。
3. 原 evaluator 对拍、默认分／阈值／整秒、同源分段稳定hash、not_required／missing、定向unit及权限竞态。
4. w98 真实完整 D4→E4→submit→双审核→prepare ledger→commit→读取→D7更正；保留原断言、新 native 用例追加，不把 legacy 夹具改成 native 来消除失败。
5. 满额先跑原2,000身份链，包含10,000来源绑定，并覆盖D4完整10,000段／50,000 slice／8,000桶／40,000来源上限；不扩大D4容量。8,192账本规模链是既有legacy回归，不冒称原D4能接受8,192身份。新贡献新增应用层业务查询的候选上限：prepare≤12、submit≤12、更正prepare/apply≤20、commit≤4、只读摘要≤3；采用集合查询／写入，无逐条N+1。原D4整体prepare≤400／submit≤950／页读≤120及其他既有总预算不提高，七秒／三十秒不变。这些是待维护者接受的验收上限，不是已测结果；未来实施须给出结构推导、实际Prisma查询数及DB函数内部计划，不以隐藏函数内部SQL冒称便宜。
6. quick、相关surface E2E、contract、生成物/readtax/counts/codemap/两台账/边界自检；实际3b/4b定稿重签后才交付Draft。PR CI冷跑执行 agent:check:full的全量口径（五分片均验）；本地只有w98，固定其他scratch旧测试不擅自跑，交CI。
7. 同SHA PR CI完成后再呈报Ready/合并，不自动决定；main验收／部署／业务映射／前端／E5切换分别登记。跨模型整体复审沿维护者已有暂停安排，不自行启无限工具评审。

### DoD

- [ ] 两表及默认legacy制度约束、V3 hash、全部负例和受控恢复真实验收。
- [ ] native全链、封顶、更正、关账原路径完整，不以“计算器可调用”代替接线完成。
- [ ] off下所有既有行为、历史schema/hash/replay/权限/审计事件不漂移。
- [ ] 正反向独立时长／贡献、阈值、跨日、零／缺证、并发／权限撤销／重放／故障全覆盖。
- [ ] 真实满额原2,000/10,000及D4最大来源链、legacy8,192链、新增查询上限与原总预算／七秒通过，失败先报告。
- [ ] 同PR交接、两contract快照及13client生成物逐行解释，计数和台账准确。
- [ ] 实际SQL与执行面3b/4b已签，Draft全量CI结果如实登记；生产/业务验收不冒称完成。

## 8. 精确候选写集（134个去重路径，不含本次文档提交许可）

未写通配符；新文件标“新建”。本清单是未来实施上限，不要求没有变化的文件制造空diff。不改门禁裁决或架构债基线；现有checker仅登记下述具名不可变配置的inventory，正反例同行。旧迁移测试只允许当前冷回放总数136→137、受控夹具加两表／恢复守卫；所有历史升级目标、断言和超时保留。

```text
prisma/schema.prisma
prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql  # 新建
src/config/app.config.ts
src/config/app.config.spec.ts
.env.example
src/modules/activities/activity-contribution-settlement.service.ts  # 新建
src/modules/activities/activity-contribution-settlement.service.spec.ts  # 新建
src/modules/activities/activity-contribution-settlement-query.service.ts  # 新建
src/modules/activities/activity-contribution-settlement-query.service.spec.ts  # 新建
src/modules/activities/activity-contribution-settlement-policy.ts  # 新建
src/modules/activities/activity-contribution-settlement-policy.spec.ts  # 新建
src/modules/activities/activity-contribution-settlement-presenter.ts  # 新建
src/modules/activities/activity-contribution-settlement-presenter.spec.ts  # 新建
src/modules/activities/settlement-draft.service.ts
src/modules/activities/settlement-draft.service.spec.ts
src/modules/activities/settlement-draft-batch.service.ts
src/modules/activities/settlement-draft-batch.service.spec.ts
src/modules/activities/activity-time-settlement.service.ts
src/modules/activities/activity-time-settlement.service.spec.ts
src/modules/activities/activity-time-settlement-query.service.ts
src/modules/activities/activity-time-settlement-query.service.spec.ts
src/modules/activities/activity-time-settlement.presenter.ts
src/modules/activities/activity-time-settlement.presenter.spec.ts
src/modules/activities/activity-settlement-http.service.ts
src/modules/activities/activity-settlement-http.service.spec.ts
src/modules/activities/ledger-posting.service.ts
src/modules/activities/ledger-posting.service.spec.ts
src/modules/activities/participation-time-correction.service.ts
src/modules/activities/participation-time-correction.service.spec.ts
src/modules/activities/correction-time-allocation.service.ts
src/modules/activities/correction-time-allocation.service.spec.ts
src/modules/activities/settlement-submit.service.ts
src/modules/activities/settlement-review.service.ts
src/modules/activities/ledger-preparation.service.ts
src/modules/activities/ledger-day-allocation.ts
src/modules/activities/ledger-day-allocation.spec.ts
src/modules/activities/settlement-content-hash.ts
src/modules/activities/settlement-content-hash.spec.ts
src/modules/activities/settlement-submission-validator.ts
src/modules/activities/settlement-submission-validator.spec.ts
src/modules/activities/correction-application.service.ts
src/modules/activities/activity-time-settlement-audit-recorder.ts
src/modules/activities/activity-time-settlement-audit-recorder.spec.ts
src/modules/activities/activities.module.ts
src/modules/activities/dto/app/app-activity-time-settlement.dto.ts
src/modules/activities/dto/app/app-settlement-workbench.dto.ts
src/modules/activities/dto/admin/admin-settlement-read.dto.ts
src/common/datetime/clock-authority.spec.ts
test/e2e/activity-os-r5-e4-contribution-settlement.e2e-spec.ts  # 新建
test/e2e/activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts  # 新建
test/e2e/activity-os-r5-e4-contribution-settlement-concurrency.e2e-spec.ts  # 新建
test/e2e/activity-os-r5-e4-contribution-settlement-correction.e2e-spec.ts  # 新建
test/e2e/activity-os-r5-e4-contribution-settlement-scale.e2e-spec.ts  # 新建
test/e2e/activity-os-r5-e4-contribution-settlement-http.e2e-spec.ts  # 新建
test/e2e/activity-settlement-submit.e2e-spec.ts
test/e2e/activity-settlement-review.e2e-spec.ts
test/e2e/activity-ledger-posting.e2e-spec.ts
test/e2e/activity-ledger-posting-concurrency.e2e-spec.ts
test/e2e/activity-settlement-correction.e2e-spec.ts
test/e2e/activity-os-r4-d4-time-bucket-settlement.e2e-spec.ts
test/e2e/activity-os-r4-d6-time-ledger.e2e-spec.ts
test/e2e/activity-os-r4-d7-time-correction.e2e-spec.ts
test/e2e/activity-os-r5-e1-3-contribution-policy-history-compatibility.e2e-spec.ts
test/helpers/activity-contribution-policy.fixture.ts
test/helpers/audit-logs-cleanup.ts
test/setup/time-ledger-fixture-cleanup.ts
test/setup/reset-db.ts
test/e2e/activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts
test/e2e/activity-os-r4-d1-1-time-policy-migration.e2e-spec.ts
test/e2e/activity-v11-batch4-allocation-determinism-migration.e2e-spec.ts
test/e2e/activity-os-r5-e3-contribution-shadow-source-proof.e2e-spec.ts
test/e2e/activity-os-r4-d3-time-allocation-revision-migration.e2e-spec.ts
test/e2e/activity-v11-batch4-allocation-mode-migration.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2a-metric-command-receipt-migration.e2e-spec.ts
test/e2e/activity-os-r2-b1-place-schema-constraints.e2e-spec.ts
test/e2e/activity-os-r5-e1-3-contribution-policy-selection-migration.e2e-spec.ts
test/e2e/activity-v11-batch4-qualification-contract-migration.e2e-spec.ts
test/e2e/activity-v11-batch4-allocation-candidate-position-anchor-migration.e2e-spec.ts
test/e2e/activity-os-r4-d1-3-selection-migration.e2e-spec.ts
test/e2e/activity-os-r4-d6-time-ledger-migration.e2e-spec.ts
test/e2e/activity-os-r4-d8-proof-cutover-migration.e2e-spec.ts
test/e2e/activity-os-r5-e1-contribution-policy-migration.e2e-spec.ts
test/e2e/activity-os-r4-d7-time-correction-migration.e2e-spec.ts
test/e2e/activity-os-r2-b2-coordinate-projection-schema-constraints.e2e-spec.ts
test/e2e/activity-os-r5-e2-contribution-rule-migration.e2e-spec.ts
test/e2e/insurance-evidence-registration-revision-migration.e2e-spec.ts
test/e2e/activity-os-r4-d7-2-fact-correction-migration.e2e-spec.ts
test/e2e/activity-os-r5-e3-d3-signature-migration.e2e-spec.ts
test/e2e/activity-v11-batch4-allocation-command-replay-migration.e2e-spec.ts
test/e2e/activity-os-r5-e3-contribution-shadow-mapping-proof.e2e-spec.ts
test/e2e/activity-os-r1-a3-template-definition-lifecycle-guards.e2e-spec.ts
test/e2e/activity-os-r1-a4-explicit-template-version-pointer.e2e-spec.ts
test/e2e/activity-os-r2-b3-form-blueprint-governance.e2e-spec.ts
test/e2e/activity-os-r2-b6-creation-data-foundation.e2e-spec.ts
test/e2e/activity-os-r3-c1-metric-definition-set.e2e-spec.ts
test/e2e/activity-os-r3-c2-outcome-value-revision.e2e-spec.ts
test/contract/openapi.contract-spec.ts
test/contract/__snapshots__/openapi.contract-spec.ts.snap
scripts/check-boundaries.ts
scripts/harness-guards.selftest.ts
harness/domain-map.json
harness/state-machines.json
harness/authz-assertion-patterns.json
CODEMAP.md
docs/current-state.md
prisma/CLAUDE.md
src/modules/activities/CLAUDE.md
docs/ai-harness/ROUTE_AUTHZ.md
docs/ai-harness/STATE_MACHINE_INVENTORY.md
docs/ai-harness/CUTOVER_SIGNOFF.md
docs/ai-harness/NEXT_TASKS.md
docs/ai-harness/FROZEN_DRAFTS.md
docs/reference/config-env.md
docs/ops/server-deployment-runbook.md
docs/ops/activity-contribution-settlement.md  # 新建
docs/plans/activity-os-r5-e4-contribution-settlement-review-and-plan.md  # 新建
changelog.d/activity-os-r5-e4-contribution-settlement.md  # 新建
docs/handoff/admin-web.md
docs/handoff/miniapp.md
docs/handoff/contract-version-registry.md
docs/handoff/openapi.json
docs/handoff/clients/shared/types.ts
docs/handoff/clients/admin/types.ts
docs/handoff/clients/admin/client.ts
docs/handoff/clients/app/types.ts
docs/handoff/clients/app/client.ts
docs/handoff/clients/auth/types.ts
docs/handoff/clients/auth/client.ts
docs/handoff/clients/system/types.ts
docs/handoff/clients/system/client.ts
docs/handoff/clients/open/types.ts
docs/handoff/clients/open/client.ts
docs/handoff/clients/integration/types.ts
docs/handoff/clients/integration/client.ts
```

- migration路径为本稿拟定命名；实施时若并发已占第137条或命名冲突，先报告更正，不能偷偷另起SQL。
- 四个新职责是新功能的事务编排／读查询／纯规则／展示，不从旧大服务搬多类存量逻辑；现有Service只做明确接线。
- domain-map登记两表归activities；state-machines只登记不可变kind/regime inventory并刷新摘要，不新造状态机。现有check-boundaries对kindCode只识别旧D4具名模型，故精确扩展ActivitySettlementContributionRevision.kindCode/regimeCode和AttendanceSettlementVersion.contributionRegimeCode，selftest补必须发现与其他同名字段仍不泛化的正反例；不改stateLikeString/status-predicate规则、债基线或裁决。authz patterns/ROUTE_AUTHZ/CODEMAP只运行既有生成器刷新。
- 时钟测试仅登记两张新表createdAt；三个fixture清理helper仅具名新表和守卫，保持旧版本缺表跳过及共享库lease保护。
- 旧迁移候选由当前136字面命中再逐项核对得出；不能用搜索结果代替引用链。已有D3的135→136标题保留，仅“全部成功文件当前数”改137。
- permission/seed/审计目录无需数量变更，未列入写集；若新增错误码／审计事件／权限或SQL执行面需要额外文件，先报告一次完整扩写，不自行写入。

## 9. 完整授权清单及维护者命令（待本计划拍板）

请一次确认：§3业务口径、§4数据与SQL方向、§5接线及§6读面增量、§8候选上限、隔离DB验证及Draft交付；SQL／访问／DB执行面实际摘要定稿后另签3b/4b。计划合入不算实施授权。

**推荐实施授权话术（现在未收到）**：

> 确认E4完整方案A及本稿§3–8候选写集和查询上限；允许仅app_test_w98隔离验证与测试夹具重建，包含默认关闭的test fixture模式、新增两表与具名守卫受控清理、现有读面可选字段及既有生成物；保留全部旧断言／历史回放目标、原五秒／七秒／三十秒预算。首个满额瓶颈未达标先报告。SQL和执行面定稿另签3b/4b；验证和签字通过后允许提交推送并创建Draft PR。不Ready、不合并、不操作生产、不转换或登记真实映射、不启用shadow/Gate/active、不删除或重算旧业务数据。

红区grant只能维护者执行；harness:needs是预算不等于授权。实施前在实际执行工作树核对以下每项，再由维护者按命名路径grant（无权限时先列缺项，AI不得代执行）：

```sh
cd /Users/dengwang/Documents/coding/srvf-nest-api-delivery-flow-pilot
pnpm harness:needs prisma/schema.prisma prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql src/config/app.config.ts src/config/app.config.spec.ts test/setup/reset-db.ts test/setup/time-ledger-fixture-cleanup.ts test/contract/openapi.contract-spec.ts test/contract/__snapshots__/openapi.contract-spec.ts.snap harness/domain-map.json harness/state-machines.json harness/authz-assertion-patterns.json docs/ai-harness/CUTOVER_SIGNOFF.md
```

本轮实际把完整134路径送入 needs 核验，12路径命中红区，其余122不命中；逐项与红区机读源对拍。不采用工具建议的宽 `prisma/**`，改为下列精确授权。此为维护者未来确认实施包后执行的命令，**本轮未发放、不应现在执行**；非红区也不等于业务授权。

```sh
cd /Users/dengwang/Documents/coding/srvf-nest-api-delivery-flow-pilot
pnpm harness:grant 'prisma/schema.prisma' --reason "维护者确认E4完整方案A；评审稿§3-9精确写集"
pnpm harness:grant 'prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql' --reason "维护者确认E4完整方案A；评审稿§3-9精确写集"
pnpm harness:grant 'harness/authz-assertion-patterns.json' --reason "维护者确认E4完整方案A；评审稿§3-9精确写集"
pnpm harness:grant 'harness/domain-map.json' --reason "维护者确认E4完整方案A；评审稿§3-9精确写集"
pnpm harness:grant 'harness/state-machines.json' --reason "维护者确认E4完整方案A；评审稿§3-9精确写集"
pnpm harness:grant 'test/contract/__snapshots__/openapi.contract-spec.ts.snap' --reason "维护者确认E4完整方案A；评审稿§3-9精确写集"
pnpm harness:grant 'test/contract/openapi.contract-spec.ts' --reason "维护者确认E4完整方案A；评审稿§3-9精确写集"
pnpm harness:grant 'test/setup/reset-db.ts' --reason "维护者确认E4完整方案A；评审稿§3-9精确写集"
pnpm harness:grant 'test/setup/time-ledger-fixture-cleanup.ts' --reason "维护者确认E4完整方案A；评审稿§3-9精确写集"
pnpm harness:grant 'docs/ai-harness/ROUTE_AUTHZ.md' --reason "维护者确认E4完整方案A；评审稿§3-9精确写集"
pnpm harness:grant 'scripts/check-boundaries.ts' --reason "维护者确认E4完整方案A；仅具名不可变配置inventory登记"
pnpm harness:grant 'scripts/harness-guards.selftest.ts' --reason "维护者确认E4完整方案A；仅具名不可变配置inventory正反例"
```

实施开工前重核当前规则、实际worktree和缺失授权；不擅自追加路径或改变reason为自批。第137条实际SQL、273权限/178总173活跃审计及新的数据库执行面摘要待定稿后分别另签3b/4b；不把已存在的E3签字借用到E4。

## 10. 可交执行会话的 Goal（模板，未启动实施）

```text
目标：按本稿方案A完成E4默认关闭的政策贡献结算全链，绝不提前E5切换。
DoD：§7全部项；旧制度V1/V2完整兼容，新制度只test fixture，真实集合守卫与原业务预算。
探针队列：开工与characterization→136→137冷/非空升级→纯评价与负例→原2,000身份/10,000来源完整链→原8,192账本/并发→quick/定向/contract/生成物→3b/4b→Draft全量CI。
写集：§8的134个命名路径上限；只提交本lane，保留既有tool包与所有其他用户改动。
授权：维护者明确完整方案+缺失redzone精确grant+w98隔离操作+最终3b/4b后才实施/交付；docs-only PR本身不给权限。
禁止域：真实业务库、生产、E2真实转换/映射/签字、E3 shadow、v1.1/D8 Gate或OPS、active模式、旧SQL重写、删/回填/重算、断言放宽、自动Ready/合并、强推或清理其他工作树。
停止条件：候选查询上限未批准、首个满额瓶颈未达标、引用/权限/DDL实际超过写集或规则互冲，一次呈报具体证据和完整补充方案；范围内可连续补测修复，不以审批为借口逐文件停顿。
```

复核点：旧端off完全兼容；真实DB证明而非布尔缓存；贡献和志愿小时真正独立；Draft/CI/生产/业务验收四个状态分开。

## 11. 本轮 docs-only 验收与未做

本轮仅六文档：本计划、E3评审稿、NEXT_TASKS、FROZEN_DRAFTS、current-state及plan changelog。只验证文档／生成物只读检查与差异；不运行DB相关contract/E2E，不借quick触发夹具清理。验证结果及Draft链接以实际执行后补记，不预报通过。

本轮档位A；未来134路径实施包为D档（schema/migration、V3行为与additive DTO合同），须本计划与完整业务方向获批后实施。已通过readtax、counts、CODEMAP、RBAC_MAP、冻结台账、NEXT_TASKS及diff检查；readtax体积、CODEMAP存量体量／未引用CLAUDE提示和台账工具射程限制保留，不改预算或规则。后续最后文本校验／精确提交范围再复核；本次代码与契约没有变化，不将未运行的contract/E2E/quick写成通过。

**本次未做**：E4代码／schema／migration／接口/DTO/生成契约实施、测试库及真实库查询、业务转换／批准／签字、上线／开关、D8-OPS、E5、整体跨模型评审、Ready／合并。所有现有未提交工具文件、主仓改动、分支和工作树保留。
