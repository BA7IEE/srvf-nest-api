# Activity OS Release 4 / D4：Time Bucket 与结算工作台精确实施计划

> **草稿依赖独立交付（2026-09-13，未合并）**：维护者已授权保留全部现有改动，在122路径内先草稿依赖、后D4分别验证、提交并创建两个关联Draft PR。本候选基于 #1325 / `eef0bbe4`，仅补大规模草稿后台执行链及必要兼容测试、说明；schema、migration、权限和HTTP合同保持D3基线（120条迁移、263权限、625端点）。D4实现留在下游PR，未计入本候选验收。7c已按摘要 `e53f7b4cedc8` 重签；D4的3b/4b仅随下游实现登记。未合并、不操作生产、不启用Gate、不删除业务数据。下方较早阶段状态为历史记录，以本条为本候选边界。

> **证据归属**：下文16.7及后续运行记录来自拆分前联合工作树，保留失败、修复及签字历史，不作为本依赖候选独立验证结果。独立结果另行追加；本PR中的D4章节仅是已批准计划及历史证据，不含D4生产代码、迁移或接口。

> **状态（2026-09-12）**：方案 A 与 101 路径 implementation 已获维护者明确授权。计划 [#1325](https://github.com/BA7IEE/srvf-nest-api/pull/1325) 已合并；本轮从 main `eef0bbe4eb46dbb546da7e460a9e3e72fa3447cc` 独立实施。仅允许 `app_test_w98` 隔离验证及测试夹具重建，验证后提交、推送、创建 PR；不合并、不操作生产、不启用 Gate、不删除业务数据。3b/4b 仍须按实际读数由维护者重签。

## 0. 草稿依赖独立候选验收（2026-09-13）

独立候选从 `eef0bbe4` 导出，独立依赖副本和 Prisma 生成物；实际改动27路径，均在已批准122路径内。除§16的草稿依赖及三项追加授权外，`harness/domain-map.json`仅刷新该候选模块接线产生的摘要。schema、120条历史migration、seed、权限目录、contract、OpenAPI及客户端与基线逐字一致，D4新表／第121条migration／接口不在本候选。

- `prisma:generate`、完整typecheck、build、6GiB配置下的原lint命令通过；未修改内存配置或检查规则。
- `dependency-unit-configured.json`：378组／8227通过／0失败／5既有todo，154.950秒。首次裸Jest漏带仓库配置导致测试未执行，原失败报告`dependency-unit.json`保留；按原`pnpm test`配置复跑，不改断言。
- `app_test_w98`独立重建后120条migration冷回放通过；`dependency-batch.json`完整56项通过，395.802秒，覆盖真实HTTP／worker、授权锁等待、双worker竞争、子进程SIGKILL回滚恢复、重试取消、五档资源规模。
- `dependency-compat.json`旧草稿、封印及并发、HTTP边界、任务读面、自动提交、导入、过期与账本9组124项全部通过，60.248秒；保留全部旧断言。
- `dependency-contract.json`1049项／2快照通过，22.997秒；OpenAPI、客户端、权限地图、计数、CODEMAP、授权摘要及冻结台账检查通过，7c和其他既有签字对拍通过。CODEMAP既有2条报告级警告保留。
- 完整`harness:selftest`退出0；`harness:replay`真触发14/14、结构断言12/12分别通过，INC-02／INC-12未覆盖和INC-13既有接受项原样保留。

报告保留在本机`/tmp/srvf-draft-split.HfqIUC/`。以上为独立候选本地证据，不是全量E2E CI或生产验收。验证后按已授权顺序创建依赖Draft PR，再创建以该依赖为base的D4 Draft PR；不Ready、不合并、不部署、不启用Gate、不删除业务数据。下文联合工作树的历史探针和失败记录保留，不混入本候选通过计数。

## 1. 起点、目标与交付边界

> 补充授权现已落实：原101+1共102路径，查询总次数120／400／950及 kindCode 精确识别／正反例已批准。metadata、完整 Harness、并发／计数6项、串行完整 typecheck及改动 E2E 的 ESLint 均通过；原增量预算失败仅保留历史证据，不再是待审批项。D4 整体验收及最终重签未完成。

起点为 main `921a6bf3fac66067e5232768d5c5d32bf92765fc`。D3 [#1323](https://github.com/BA7IEE/srvf-nest-api/pull/1323) 已合并，18 项 PR 检查及可信审批通过；[合并后 CI](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34677507039) 在该 SHA 上成功。基线为 161 模型／120 migration／625 端点／263 权限／168 审计总计、163 活跃。

目标：真人负责人可基于唯一参与事实和冻结政策，查看阻塞、认定区间、生成四类结算桶、显式提交冻结的分类版本；审核者按当前权限读取其来源。D4 不产生 Time Ledger、贡献分、证明、旧小时投影或自动切换。

维护者已确认评审 §3 六项决策及本完整实施包。下文为本轮实施合同；范围外新问题仍须报告，不自行更换聚合、留存或 draft 来源规则。

## 2. 可签收的 DoD

1. 原 D3 V1 仍只接受 committed 段；有封印的结算 draft 只能经新命令、完整证明和新 SQL guard 进入同一认定链。旧迁移 120 校验和不变。
2. 同一活动内，同成员的参与区间不存在重复计算；所有原始认定在源段内且互斥。四类先聚合再按唯一冻结政策取整，混合政策明确拒绝。
3. 自动值与认定值分别可追溯；自动值未知保持 null；差异或未知时理由不为空。任何入口都不能直接填无来源的 recognizedSeconds。
4. 不可变草稿修订及正式副本同链、完整、可回放；正式桶绑定新建的正式 Settlement Version，不原地修改草稿或历史桶。
5. 8 个 Human App 路由落实当前身份、显式组织、实际责任／审核资格、最小字段；写命令与重放均在锁后重新授权，AI／Integration 无入口。
6. 不选择新分类提交时，旧接口的状态码、错误顺序、DTO、contentHash、小时／贡献结果、审核和入账行为全部不变。新提交不绕过原有状态闸、分离审核、通知和审计事务。
7. SQL 同链反例、事务／并发、真实 HTTP、旧行为 characterization、空库回放和非空升级均验证；不删旧测试、不放宽断言、不改变裁判规则。
8. 验证后才记录实际计数及签字依据；提交、推送、创建 PR、可信审批、Ready、合并、main CI 与生产验收分别记录，不能互相代替。

## 3. 完整数据合同

### 3.1 四个新模型与现有 D3 的窄扩展

| 模型                                  | 字段与唯一性                                                                                                                                                                                                                                                                                                                                                                                                 | 完整性要求                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ActivitySettlementTimeRevision        | id、activityId、settlementRunId、settlementVersionId、revision、previousTimeRevisionId、kindCode（draft / submitted，行创建后不变）、sourceDraftTimeRevisionId、evidenceSealId、evidenceRevision、populationRevision、workflowRevision、draftContentHash、sourceSetHash、bucketContentHash、bucketCount、sourceCount、createdAt、createdByUserId。run/revision 唯一；submitted 对 settlementVersionId 唯一。 | draft 只锚定当前草稿；submitted 只锚定新正式版本，必须关联同活动、同 run 的原分类草稿。previous 链连续且同 run；所有指纹与子行数量一致。                            |
| ParticipantSettlementTimeBucket       | id、timeRevisionId、activityId、participationIdentityId、categoryCode、calculatedSeconds（可空）、recognizedSeconds、adjustmentReason（可空 Json，结构见下）、timePolicyVersionId、definitionHash、evaluatorVersion、quantumSeconds（无有效来源时四项为空）、rawCalculatedMilliseconds（可空）、rawRecognizedMilliseconds。timeRevision/identity/category 唯一。                                             | 每个结算 population identity 恰好四行；只能四种正式类别。秒为非负有界整数，原始毫秒用 BigInt 精确保存；无有效来源的零桶必须可证明，不可借空政策锚绕过有效来源验证。 |
| ParticipantSettlementTimeBucketSource | id、bucketId、timeRevisionId、activityId、allocationRevisionId、sourceSegmentId、sourceSegmentRevision、rawCalculatedMilliseconds（可空）、rawRecognizedMilliseconds。bucket/allocation 唯一。                                                                                                                                                                                                               | 每个有效来源在对应 identity 的四桶各有一条来源行，允许分类量为零；版本、源段、identity、policy/hash 与父桶一致；毫秒数必须由源认定与冻结政策推导。                  |
| ActivitySettlementTimeCommandReceipt  | id、actorUserId、activityId、operationCode（prepare_time_settlement / submit_time_settlement）、operationKey、requestHash、timeRevisionId、resultJson、createdAt。actor/operation/key 唯一。                                                                                                                                                                                                                 | 与输出 revision 同事务、同活动；返回安全固定结果。不存在独立可变“当前结果”缓存。                                                                                    |

四表均 append-only，无 updatedAt／deletedAt，外键 Restrict。数据库用复合唯一靶点、复合 FK 和延迟完整性触发器闭合 activity → run → settlement version、identity → activity、bucket → revision、source → allocation → source segment；不以多个裸单列 FK 冒充同链证明。

`adjustmentReason` 的 Json 合同为按 allocationRevisionId 排序、去重的 `{ allocationRevisionId, manualReason }` 数组，仅从已持久化的人工认定复制；每条理由仍按 D3 的非空／长度／控制字符校验。自动值未知或与认定值不同则必须非空；没有新“替操作者写理由”的流程。summary/list 不返回自由文本，获 read 权限的来源详情才显示关联理由。

现有 ParticipantTimeAllocationRevision 拟添加六个可空证明字段：settlementDraftVersionId、settlementEvidenceSealId、settlementEvidenceRevision、settlementPopulationRevision、settlementWorkflowRevision、settlementDraftContentHash。必须同时全空或全非空，复合锚验证同 activity/run/seal；已有行全空，不回填。证明全空时原 committed-only 规则逐字保留；全非空时新 guard 还须证明 run 正在 drafting、当前 draft/version、active seal 及计数一致，源段为当前 valid 闭合 draft。不能仅凭调用参数宣称已封印。

D3 既有 slice/evidence/receipt 表继续是唯一认定子链。新命令 `recognize_settlement_time_allocation` 使用独立请求哈希域及 receipt operation；原 V1 operation、parser、manifest、resultJson、审计结果及重放不变。迁移 121 扩展 receipt 和父子完整性 guard，使“有草稿证明 + 新 operation”与“无草稿证明 + 原 operation”一一匹配；不能给任意旧命令附一个可空字段便开放 draft。

### 3.2 取数、自动基线与聚合

唯一输入为 D2 Facade 当前参与事实、D3 最新适用认定及各认定冻结的 V8 RuleSnapshot / selection / policy。不得读取旧 serviceHours、贡献分、成果或当前目录默认值补数。

- 源集合包含当前 population 和全部当前段的 ID、revision、状态、结果、起止时间、identity 及适用认定 ID/hash，排序后计算 sourceSetHash。封印／population／workflow／旧草稿内容 hash 一并固定，防止“数量相同而内容已换”。
- 当前 valid 闭合段必须有本次有效证明下的最新认定，不能自动退回较早 revision。开放段、待决事实、旧 V2–V7 无政策锚、失效认定均阻塞。已合法作废／替换／早退零值的段不贡献时长，但保留排除原因并进入来源集合指纹。
- 同活动同 member 的不同段／identity 先检查半开区间是否重叠，重叠即拒绝，不擅自做 union、去重或决定哪一段优先。跨活动互斥不在本批承诺范围。
- 自动基线使用 D3 已有自动解释纯函数，对同一源段和冻结政策重算；若政策要求人工或特殊区间使自动解释不可用，则该源的 calculated 为 null。manual 的 recognized 从已确认切片取得；automatic 的两者相同。不读旧自动 revision 冒充当前源的基线。
- 每桶所有有效来源须有相同 timePolicyVersionId、definitionHash、evaluatorVersion、quantumSeconds。任一不同即 POLICY_MIXED；不把同量子但不同政策版本也悄悄合并。
- 累加精确整数毫秒，最后一次计算 `floor(sumMilliseconds / (quantumSeconds * 1000)) * quantumSeconds`。拒绝溢出；不逐片／逐段取整，不用浮点小时往返。calculated 有一个未知源则整桶保持 null，不把“已知部分之和”标成总自动值。
- 无有效来源的 identity 仅在没有开放／待决／缺认定问题时产生四个零桶；原因固定为 no_valid_segment，policy 相关列为空、来源行为空。其余四分类桶均有冻结政策锚，零量也不省略。

差异理由来自实际人工修订，理由和 evidence 仍由 D3 既有活动附件归属、Storage 锁及删除保护约束。本批不增加附件 owner，也不修改 Storage 生产代码。

### 3.3 不可变与敏感字段三问

保存用途是解释一次分类结算及后续审核、对账，不是新增成员画像。身份只存现有 ID，不复制姓名、手机号、证件号、附件 URL／对象 key、JWT 或任何 secret。理由沿用已有人工认定字段，不引入新敏感采集。

查看只限经本批明确许可的负责人／审核者；列表隐藏自由文本，详情仍重新判权。退队／账号失效立即失去访问资格，但不删除历史证据。按维护者“不删除业务数据”的决定，所有修订、理由、证据引用和收据持续保留；不新增 TTL、cron、清理函数或清理 CLI。这是本次工程留存边界，不作法律合规结论。

## 4. 写入流程与兼容合同

### 4.1 三个显式命令

三个新写入口均调用既有 `ActivityWorkflowGate.assertV11WriteAllowed()`，继承闸关闭及只读维护时的拒绝，包括写命令重放；不新增开关、不读取散落 env、不修改 Gate 文件。历史桶查询仍须当前授权，但不因只读维护态而改回旧事实。实施测试只在隔离夹具配置中覆盖开／关／只读四态，不操作运行实例的 Gate。

1. **认定**：新 HTTP 命令只处理一个当前源段，沿用 D3 自动／人工入参及证据上限，另要求 expectedDraftVersion、expectedEvidenceSealId 与三个 revision 锚。新增 D3 窄内部方法接收调用方 tx；不将它接到旧 recognize 的默认分支。当前草稿证明在该事务内取得，不能由前端自报可信内容 hash。
2. **prepare**：入参 operationKey、expectedDraftVersion、expectedEvidenceSealId、expectedTimeRevision；不允许外部传秒数、policy 或任意 source 列表。锁后构造完整来源集合、检查认定和聚合，追加 draft time revision、四类桶、来源行、receipt、最小审计，任一失败全部回滚。
3. **submit**：新入口入参 operationKey、timeRevisionId、expectedDraftVersion、expectedEvidenceSealId、expectedBucketContentHash。必须持 prepare 及既有 settlement-submit 权限。在现有 submit 的 Activity → Run 事务中重查来源 fence，创建新正式 Settlement Version 后复制对应正式 time revision／桶／来源；数量和 hash 不符即全部回滚。不得先提交旧版本再另起事务补桶。

新 prepare 与 submit 同键同 payload 返回原安全结果，异 payload 明确冲突；重放依然先校验当前身份和访问权，但不以当前业务状态否认已经成功的历史操作。认定的新旧 operation key 命名空间隔离，不能抢占原 D3 收据；新分类 submit 与旧 submit 使用不同请求域和内部关联 key，不让同文本客户端 key 发生跨命令重放。

### 4.2 正式提交与审核

SettlementSubmitService 只抽出需要共享的同事务核心，新方法显式传入分类上下文；原 submit 调用不传新上下文，不多查新表、不改变拒绝优先级。修改编排前先跑旧结算 characterization，发生旧行为差异立即停。

旧 contentHash schemaVersion 1 及其 canonical payload 完整保留。新增分类提交 hash 使用单独版本／域，把原结算内容和已验证 bucketContentHash、sourceSetHash 固定在同一指纹；时间元数据、operationKey、actor 和 requestHash 不进入业务内容 hash。正式桶以新的正式父 ID 保存，但业务指纹不包含复制时新生成的行 ID，所以草稿与正式业务内容可逐字对拍。

现有一审／终审只比对提交时 contentHash，不重新计算政策或小时数；其人员分离、状态顺序和通知保持不变。新工作台按该版本读取冻结桶，让审核者能下钻新指纹的依据。审核通过仍不写新 Time Ledger；旧贡献／入账只消费原有结果，D4 不改变它们。退回后按既有流程生成新草稿，再认定／prepare／submit；保留所有旧分类行，不原地改旧桶。

D5 才评审 shadow 与差异验收，D6 才评审正式分类账本及兼容投影，D7 才处理账本更正／冲回，D8 才涉及证明与切换。不能在 D4 里新增旧 serviceHours 同步器。

## 5. HTTP、权限与安全输出

候选统一前缀为 `/api/app/v1/my/managed-activities/:activityId/time-settlement`，共 8 个新路由，旧路由零改变。

| 方法与后缀                             | 用途与结果                                                                         | 权限                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------- |
| GET 根路径                             | 当前 run/draft、最新分类 revision 摘要、readiness 和阻塞分类计数；不输出全体人员。 | time-settlement.read                                    |
| GET /sources                           | 当前参与来源分页，含认定缺口与合法排除原因。                                       | time-settlement.read                                    |
| GET /allocations/:allocationRevisionId | 单个认定、原始区间、冻结政策、理由与证据 ID；最大 500 slices / 500 evidence。      | time-settlement.read                                    |
| GET /revisions/:timeRevisionId/buckets | 指定历史／当前版本的桶分页；不实时重算。                                           | time-settlement.read                                    |
| GET /revisions/:timeRevisionId/sources | 桶来源分页，可按 bucketId 过滤；理由与政策锚可追溯。                               | time-settlement.read                                    |
| POST /allocations                      | 新封印草稿认定命令；显式 HTTP 200，重放相同。                                      | 既有 time-allocation.recognize                          |
| POST /prepare                          | 新建分类草稿完整 revision；显式 HTTP 200。                                         | time-settlement.prepare                                 |
| POST /submit                           | 原结算事务中的显式分类提交；显式 HTTP 200。                                        | time-settlement.prepare 且既有 settlement-submit.record |

权限全名均加 `activity.`。新增 `activity.time-settlement.read`、`activity.time-settlement.prepare` 两码；metadata、seed 闭包、runtime holder、显式 scope 与派生登记一并覆盖，零内建角色默认授予。已有 recognize 码业务说明只补“有证明的封印草稿”这个获批扩展，不扩大到任意 draft。

所有访问必须为有效 App member，当前 User/Member 状态、deletedAt、显式组织范围、活动组织资格都成立。写操作还须当前活动负责人；read 允许符合上述 scope 且为当前负责人，或具有该活动既有一审／终审实际资格者；审核角色称号或 Admin 身份本身不放行。read 与 prepare 互不蕴含，旧目录 read/select 也不蕴含新权限。声明装饰器不能替代 Service 层 Authz/RBAC；复用现有公开属主原语，不改 users/authz/organizations 的业务语义。

App DTO 独立定义，禁止派生 Admin。分页沿用 page/pageSize 和包装响应，不新增 size/current 等别名。新 BizCode 候选为 20218–20225：输入非法、引用不可见、版本过期、命令冲突、来源未就绪、政策混合、区间重叠、规模超限；实施开工先核验未占用。复用既有 App 准入／权限错误，不在新码中泄露跨活动资源是否存在。

新增一个审计事件 `activity.time-settlement.command`，只记录命令类型、活动／版本 ID、结果计数、重放标记与请求追踪元数据；不记人工理由、附件 URL、完整 payload 或 key/hash 凭证。D3 新认定沿用其既有事件并显式区分 operation，不伪造第二个认定审计真相。

## 6. 事务、并发与规模

写链统一顺序：在 tx 中验当前资格 → actor/operation/key advisory lock → 重验 → Activity 锁 → Run 锁 → 重验 → receipt 重放判断 → 读取并锁定当前 draft/seal/source/冻结政策 → 重验 → 校验／写入／审计。需要 Attachment 时沿用 D3 的既有 owner/storage 锁顺序，不另造 Storage 锁。新 D3 tx 方法不得嵌套 Prisma transaction，也不得在取得 Activity 锁前先读来源并据此写入。

持有活动锁仍不代表身份不会变：每次可能等待的授权敏感锁后须重新从当前库读取；在提交新事实前再次复核身份、组织权限和责任。重放也不能用旧 receipt 中的 actor role 代替当前授权。Read query 的 scope、数据读取和返回前复验同属一个受控事务，列表不返回跨活动数据。

批量 prepare 必须集合查询 allocation/slices/policies 和批量写入，不能循环每个成员／源段调用 D3 command 或发数据库查询。沿用 D2 2000 identity／10000 段上限；新增整批 50000 个 allocation slice 上限、最多 8000 桶／40000 来源行，超出明确拒绝，不截断成功。这些为候选产品边界，须随方案一并确认。

SQL 预算按维护者 2026-09-12 确认的 D4 补充方案 A，采用包含全部 Service 授权查询的总次数上限：读页 120、prepare 400、分类 submit 950。原计划增量 12／24／12 的失败证据保留在 §12，不冒称原预算通过。以 1 / 100 / 2000 identity 及上限数据对比，query 数不得随人数线性增长，不用“通用开销”隐藏 N+1。D3 单源命令仍按既有授权链验证；不能靠加全局超时、缓存身份或删必要授权查询过预算。新上限须实测验证，不因批准而自动通过。

原 submit 的事务超时与错误顺序不改。新 prepare 的事务预算先采用 30 秒，SQL 与内存探针不满足时报告范围内优化或方案补充，不擅自提高全局 timeout。所有秒数使用边界明确的整数，数据库 BigInt 原始毫秒以十进制文本安全展示，禁止 JSON 序列化时变成不精确浮点。

## 7. 迁移、兼容测试与验证队列

候选第 121 条迁移路径为 `prisma/migrations/20260913090000_activity_os_r4_d4_time_bucket_settlement/migration.sql`。仅 expand、约束与 guard 函数扩展；原 120 条 SQL 不改，特别保留 D3 migration 的 SHA-256 `caee91d1e8f2d1dae5e79d7789cd3473e886f23693ec200fd057f6a23d71ca54`。不回填、不删除、不改旧段状态；无需清理 CLI。

当前源码已点验 18 份旧 E2E 的 120 计数，其中 D3 migration 同时保留 119→120 历史升级。另把 C2 D1 的当前全链标题／字符串计数和 D1-1 foundation 的显式 TRUNCATE 纳入精确写集。允许变化仅如下：当前链总数／对应标题 120→121；固定历史锚按 migration 名找边界；B1–D3 各历史升级与 checksum 仍保持；seed 当前计数 263→265；测试清理列表显式加入四个新表及相关父表，不用 CASCADE。SQL 旧 schema 夹具必须在其历史 schema 上执行，不能用最新 Prisma 客户端强读新增列。除此之外，任何既有行为断言变化另行报告。

| 顺序 | 探针与观测点                                                                                                                                                         | 通过条件                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| P0   | preflight、主干漂移、精确写集、harness:needs、当前 SQL／权限／路由占号、默认测试初始化调用链。                                                                       | 基线可重现、未误用旧令牌；先核验工具有正向命中，不以异常零读数自证。             |
| P1   | D3 原 V1 与旧 settlement draft/submit/review 的 characterization，D1 policy、D2 reader、旧 contentHash 单测。                                                        | 未改代码前建立基线；新接线缺省时所有状态／错误／DTO／hash 断言原样通过。         |
| P2   | 纯解析、自动基线未知、人工理由、整数精度、两段 59 秒聚合按 60 秒量子得 60 秒、混合版本、跨 identity 重叠、零桶及所有容量边界。                                       | 正反用例各自测试，不用实现本身生成期望值。                                       |
| P3   | 第 121 条空库回放、120→121 非空升级、旧 D3 committed 行保留、新 draft 证明 SQL 正反例、operation/证明错配、孤儿父子、跨活动/identity/版本、篡改量子/hash/理由/计数。 | 原 120 条 checksum 不变；SQL 不靠 Service 才能拒绝错链、缺子行和不可变行修改。   |
| P4   | 真实 HTTP 获取源→认定→prepare→submit→按版本读桶／理由；无有效源零桶，混合政策和缺认定阻塞；旧结算回归。                                                              | 真 PG 状态、receipt、audit、formal version 同链；旧结果小时和贡献值不变。        |
| P5   | 同键同体／异体、同源 CAS、prepare/submit 竞争、draft 再生成、seal 失效、段更正、人工 revision 变更、等待中停用用户/成员/撤权/换负责人、附件删除竞争、审计末步失败。  | 锁后裁决正确、无半写、无多重正式副本、无越权重放；旧历史保留。                   |
| P6   | 1/100/2000 identity、50000 slice 上限及 +1，查询计数、内存／超时、分页权限、L3 字段扫描。                                                                            | 集合查询、容量明确、不静默截断、不输出凭证／PII 或自由文本到列表／审计。         |
| P7   | typecheck、lint、build、全仓 unit、contract、全量 E2E、Harness、派生／语义门、旧迁移回放。                                                                           | 本地与 CI 分开举证；snapshot 逐行解释，只新增 8 路由，不盲目更新；无未解释红项。 |

实施如获批，数据库边界仅建议 `app_test_w98`，串行验证及测试夹具重建，不得扩到 app_test、w1 或其他 worker。不得自动运行 migrate dev/reset/db push。D3 曾误用默认 global setup 触碰其它测试库，该范围偏差记录继续保留，不能复用这个错误入口。

涉及权限与结算编排，按仓规必须完成 full 级覆盖。默认 `pnpm agent:check:full` 的 contract/e2e 初始化可能创建 app_test/w1，因此不能原样在仅 w98 授权下启动。可运行其无数据库检查段；数据库段须先证明隔离 runner 只触及 w98，保留既有测试护栏、不改 test/setup 或 Jest 配置。没有可验证隔离入口时，本地停止数据库段并明确交 CI，不能冒称本地 full；CI 全量仍是硬前置。本计划不提供任何现在就可执行的重建命令，也未执行数据库探针。

## 8. implementation 精确写集（原 101 路径 + 已批准补充 1 路径）

以下 101 路径已获 implementation 授权，开工精确 needs 结果为 13 红区／88 普通路径，维护者已在独立工作树发放对应 13 项令牌。新增路径只有本节明确命名的新文件；既有文件限前述职责，不授权全目录。任一符号／生成闭包超出本表应合并成一份补充简报，不能顺手修改。

### 数据合同（4 新模型；D3 来源证明扩展）

1. `prisma/schema.prisma`
2. `prisma/migrations/20260913090000_activity_os_r4_d4_time_bucket_settlement/migration.sql`

### D4 新服务及逐项单测

3. `src/modules/activities/activity-time-settlement-command.ts`
4. `src/modules/activities/activity-time-settlement-command.spec.ts`
5. `src/modules/activities/activity-time-settlement-policy.ts`
6. `src/modules/activities/activity-time-settlement-policy.spec.ts`
7. `src/modules/activities/activity-time-settlement-access.service.ts`
8. `src/modules/activities/activity-time-settlement-access.service.spec.ts`
9. `src/modules/activities/activity-time-settlement.service.ts`
10. `src/modules/activities/activity-time-settlement.service.spec.ts`
11. `src/modules/activities/activity-time-settlement-query.service.ts`
12. `src/modules/activities/activity-time-settlement-query.service.spec.ts`
13. `src/modules/activities/activity-time-settlement.presenter.ts`
14. `src/modules/activities/activity-time-settlement.presenter.spec.ts`
15. `src/modules/activities/activity-time-settlement-audit-recorder.ts`
16. `src/modules/activities/activity-time-settlement-audit-recorder.spec.ts`

### D3 显式新命令；原 V1 合同不变

17. `src/modules/activities/activity-time-allocation-command.ts`
18. `src/modules/activities/activity-time-allocation-command.spec.ts`
19. `src/modules/activities/activity-time-allocation.service.ts`
20. `src/modules/activities/activity-time-allocation.service.spec.ts`
21. `src/modules/activities/activity-time-allocation-access.service.ts`
22. `src/modules/activities/activity-time-allocation-access.service.spec.ts`
23. `src/modules/activities/activity-time-allocation-audit-recorder.ts`
24. `src/modules/activities/activity-time-allocation-audit-recorder.spec.ts`

### HTTP、模块与显式新提交路径

25. `src/modules/activities/controllers/app-managed-activity-time-settlement.controller.ts`
26. `src/modules/activities/dto/app/app-activity-time-settlement.dto.ts`
27. `src/modules/activities/activities.module.ts`
28. `src/modules/activities/settlement-submit.service.ts`
29. `src/modules/activities/settlement-content-hash.ts`
30. `src/modules/activities/settlement-content-hash.spec.ts`

### 权限、审计、错误与时间登记

31. `src/modules/permissions/permission-catalog.ts`
32. `src/modules/permissions/seed-permission-codes.ts`
33. `src/modules/permissions/permission-code-holders.spec.ts`
34. `prisma/seed.ts`
35. `src/modules/audit-logs/audit-logs.types.ts`
36. `src/modules/audit-logs/audit-event-registry.spec.ts`
37. `src/common/exceptions/biz-code.constant.ts`
38. `src/common/exceptions/biz-code.constant.spec.ts`
39. `src/common/datetime/clock-authority.spec.ts`

### D4 新 E2E 与 D3 新边界回归

40. `test/e2e/activity-os-r4-d4-time-bucket-settlement.e2e-spec.ts`
41. `test/e2e/activity-os-r4-d4-time-bucket-concurrency.e2e-spec.ts`
42. `test/e2e/activity-os-r4-d4-time-bucket-migration.e2e-spec.ts`
43. `test/e2e/activity-os-r4-d3-time-allocation-revision.e2e-spec.ts`

### 既有测试兼容闭包（仅当前回放计数、显式清理；历史断言不变）

44. `test/e2e/activity-os-r1-a3-template-definition-lifecycle-guards.e2e-spec.ts`
45. `test/e2e/activity-os-r1-a4-explicit-template-version-pointer.e2e-spec.ts`
46. `test/e2e/activity-os-r2-b1-place-schema-constraints.e2e-spec.ts`
47. `test/e2e/activity-os-r2-b2-coordinate-projection-schema-constraints.e2e-spec.ts`
48. `test/e2e/activity-os-r2-b3-form-blueprint-governance.e2e-spec.ts`
49. `test/e2e/activity-os-r2-b6-creation-data-foundation.e2e-spec.ts`
50. `test/e2e/activity-os-r3-c1-d2a-metric-command-receipt-migration.e2e-spec.ts`
51. `test/e2e/activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts`
52. `test/e2e/activity-os-r3-c1-metric-definition-set.e2e-spec.ts`
53. `test/e2e/activity-os-r3-c2-outcome-value-revision.e2e-spec.ts`
54. `test/e2e/activity-os-r4-d1-1-time-policy-migration.e2e-spec.ts`
55. `test/e2e/activity-os-r4-d1-3-selection-migration.e2e-spec.ts`
56. `test/e2e/activity-os-r4-d3-time-allocation-revision-migration.e2e-spec.ts`
57. `test/e2e/activity-v11-batch4-allocation-candidate-position-anchor-migration.e2e-spec.ts`
58. `test/e2e/activity-v11-batch4-allocation-command-replay-migration.e2e-spec.ts`
59. `test/e2e/activity-v11-batch4-allocation-determinism-migration.e2e-spec.ts`
60. `test/e2e/activity-v11-batch4-allocation-mode-migration.e2e-spec.ts`
61. `test/e2e/activity-v11-batch4-qualification-contract-migration.e2e-spec.ts`
62. `test/e2e/insurance-evidence-registration-revision-migration.e2e-spec.ts`
63. `test/e2e/activity-os-r4-d1-1-time-policy-foundation.e2e-spec.ts`

### 契约、交接与生成客户端（禁止手改生成物）

64. `test/contract/openapi.contract-spec.ts`
65. `test/contract/__snapshots__/openapi.contract-spec.ts.snap`
66. `docs/handoff/openapi.json`
67. `docs/handoff/admin-web.md`
68. `docs/handoff/miniapp.md`
69. `docs/handoff/clients/app/client.ts`
70. `docs/handoff/clients/app/types.ts`
71. `docs/handoff/clients/admin/client.ts`
72. `docs/handoff/clients/admin/types.ts`
73. `docs/handoff/clients/auth/client.ts`
74. `docs/handoff/clients/auth/types.ts`
75. `docs/handoff/clients/system/client.ts`
76. `docs/handoff/clients/system/types.ts`
77. `docs/handoff/clients/open/client.ts`
78. `docs/handoff/clients/open/types.ts`
79. `docs/handoff/clients/integration/client.ts`
80. `docs/handoff/clients/integration/types.ts`
81. `docs/handoff/clients/shared/types.ts`

### 治理登记（不改变裁判规则）

82. `scripts/harness-guards.selftest.ts`
83. `harness/domain-map.json`
84. `harness/authz-assertion-patterns.json`
85. `harness/authz-implication-graph.json`
86. `harness/permission-surface-baseline.json`
87. `harness/state-machines.json`

### 事实摘要、签字及本阶段文档

88. `docs/current-state.md`
89. `CODEMAP.md`
90. `docs/ai-harness/RBAC_MAP.md`
91. `docs/ai-harness/ROUTE_AUTHZ.md`
92. `docs/ai-harness/AUDIT_EVENT_REGISTRY.md`
93. `docs/ai-harness/STATE_MACHINE_INVENTORY.md`
94. `docs/ai-harness/CUTOVER_SIGNOFF.md`
95. `docs/ai-harness/FROZEN_DRAFTS.md`
96. `docs/ai-harness/NEXT_TASKS.md`
97. `src/modules/activities/CLAUDE.md`
98. `prisma/CLAUDE.md`
99. `docs/plans/activity-os-r4-d4-time-bucket-settlement-workbench-review.md`
100.  `docs/plans/activity-os-r4-d4-time-bucket-settlement-workbench-implementation-plan.md`
101.  `changelog.d/activity-os-r4-d4-time-bucket-settlement-implementation.md`
102.  `scripts/check-boundaries.ts`

第 102 路径由维护者 D4 补充方案 A 精确批准，仅识别 `ActivitySettlementTimeRevision.kindCode` 的配置登记；原 101 路径的编号保持不变，`scripts/harness-guards.selftest.ts` 另获对应正反例用途授权。当前写集为原 101 + 1，共 102 路径，不扩展其他检查规则。

生成客户端 13 个路径中仅 App 的类型／调用可能有语义增量，其余仅对应生成器实际摘要或共享引用变化；无变化的文件不制造 diff。治理文件只登记已实现新类、权限、路由和 immutable kindCode 的 L1 inventory / not-derived 分类，不新增状态边、不放宽规则；既有 D3 recognitionModeCode 登记不改。CUTOVER_SIGNOFF 仅在维护者核准实际读数后重签，不能拿未来预算填成已验收。

明确排除：D3 旧 migration、SettlementDraftService 生产代码、旧 controller／DTO、Storage 实现、users/authz/organizations 生产代码、全局 Guard、Gate、main.ts、app.module.ts、package/lock/Jest/test setup、workflow、既有审核状态机、账本／贡献／证明／画像、任何业务数据删除与回填。

## 9. 授权与一次性命令包

### 9.1 #1325 文档阶段的历史授权

原 docs-only PR 的 7 路径：D3 review、D3 implementation plan、FROZEN_DRAFTS、NEXT_TASKS、本文、D4 review、`changelog.d/activity-os-r4-d3-closeout-d4-plan.md`。该阶段已完成并经维护者另行批准合并 #1325。当前 implementation 授权以页首和 §8 的 101 路径为准，不能再把这段历史的“不实施”误读成当前范围。

### 9.2 实施授权记录（已批准）

> 确认 D4 完整方案 A，包括封印草稿认定、同桶单一政策且混合版本阻塞、自动值可空及人工理由、8 个 Human App 路由、显式分类提交、持续留存和规模边界；按本计划 101 个精确路径实施，含已列旧测试兼容及派生文档。允许 app_test_w98 隔离验证及测试夹具重建；验证后提交、推送、创建 PR。不合并、不操作生产、不启用 Gate、不删除业务数据。

维护者在 #1325 合并后明确确认“D4 implementation 方案 A，按 #1325 的 101 路径计划执行”，并批准 w98 隔离验证、测试夹具重建和验证后的提交／推送／开 PR。当前基线已对拍为 `eef0bbe4eb46dbb546da7e460a9e3e72fa3447cc`；第 121 条迁移名称未更改。不包含 Ready、合并、生产、Gate 或业务数据删除。

### 9.3 维护者红区命令（对应令牌已核验）

本轮对 101 个精确路径的只读 harness:needs 实测为 **13 个红区、88 个非红区**；“非红区”不表示额外业务已授权。下面保留维护者的精确命令，不采用宽泛 prisma/\*\*。

实施目录和分支已按下方路径建立，依赖／Prisma 生成物／preflight 已通过；13 项维护者令牌已在该 worktree 的 Git 私有目录核验，AI 没有执行 grant。不得在别的工作树照抄发令牌。

```bash
(
  cd /Users/dengwang/Documents/coding/srvf-nest-api-r4-d4-implementation || exit 1
  test "$(git branch --show-current)" = "codex/activity-os-r4-d4-implementation" || exit 1
  pnpm harness:grant 'prisma/schema.prisma' --reason '维护者确认 D4 完整方案 A 及精确计划 §3–§10；仅本阶段写集' || exit 1
  pnpm harness:grant 'prisma/migrations/20260913090000_activity_os_r4_d4_time_bucket_settlement/migration.sql' --reason '维护者确认 D4 完整方案 A 及精确计划 §3–§10；仅本阶段写集' || exit 1
  pnpm harness:grant 'prisma/seed.ts' --reason '维护者确认 D4 完整方案 A 及精确计划 §3–§10；仅本阶段写集' || exit 1
  pnpm harness:grant 'src/modules/permissions/permission-catalog.ts' --reason '维护者确认 D4 完整方案 A 及精确计划 §3–§10；仅本阶段写集' || exit 1
  pnpm harness:grant 'harness/authz-assertion-patterns.json' --reason '维护者确认 D4 完整方案 A 及精确计划 §3–§10；仅本阶段写集' || exit 1
  pnpm harness:grant 'harness/authz-implication-graph.json' --reason '维护者确认 D4 完整方案 A 及精确计划 §3–§10；仅本阶段写集' || exit 1
  pnpm harness:grant 'harness/domain-map.json' --reason '维护者确认 D4 完整方案 A 及精确计划 §3–§10；仅本阶段写集' || exit 1
  pnpm harness:grant 'harness/permission-surface-baseline.json' --reason '维护者确认 D4 完整方案 A 及精确计划 §3–§10；仅本阶段写集' || exit 1
  pnpm harness:grant 'harness/state-machines.json' --reason '维护者确认 D4 完整方案 A 及精确计划 §3–§10；仅本阶段写集' || exit 1
  pnpm harness:grant 'scripts/harness-guards.selftest.ts' --reason '维护者确认 D4 完整方案 A 及精确计划 §3–§10；仅本阶段写集' || exit 1
  pnpm harness:grant 'test/contract/__snapshots__/openapi.contract-spec.ts.snap' --reason '维护者确认 D4 完整方案 A 及精确计划 §3–§10；仅本阶段写集' || exit 1
  pnpm harness:grant 'test/contract/openapi.contract-spec.ts' --reason '维护者确认 D4 完整方案 A 及精确计划 §3–§10；仅本阶段写集' || exit 1
  pnpm harness:grant 'docs/ai-harness/ROUTE_AUTHZ.md' --reason '维护者确认 D4 完整方案 A 及精确计划 §3–§10；仅本阶段写集' || exit 1
)
```

AI 不执行 grant。令牌不授予实施清单外写入，更不授予 Ready、合并或生产。后续可信审批与 3b/4b 仍由维护者决定；可以一次报齐，不逐文件拆问。

### 9.4 数字与签字预算

计划阶段预算为：模型 161→165、migration 120→121、端点 625→633、权限 263→265、Audit 168/163→169/164。实施授权后已按代码、生成器与隔离库核验为上述读数，故本轮批准写集内的事实摘要已刷新，并明确标注未提交、未验收。原 recognize 码扩展业务描述，不增加第三枚码；旧 API 数量和既有字段不减。事实计数不等于签字或验收，CUTOVER_SIGNOFF 仍保留上一阶段，不能由 AI 代签。

3b 必须以实际第 121 条 SQL hash 和迁移验证证据单独重签；4b 必须以实际 seed digest、265 权限、169/164 审计对拍后单独确认。若出现真实语义门 finding，先给出复现与具体申报建议；不自行宣称误报，也不更改比较器。

## 10. 连续推进顺序与暂停条件

实施批准后在同一 Goal 内连续完成 P0–P7、已列明兼容修复、派生更新与授权内 PR 流程，不把正常编译／测试失败、同一写集内补测或文档更新变成二次审批。先数据与认定证明，再桶／查询，再显式提交，串行集成；不同时开第二条 schema lane。

只有实质业务决策变化、越出 101 路径、旧行为断言差异、隔离库边界无法保证、基线合同冲突、签字／可信审批或 Ready／合并需新权限时暂停，并一次说清需要维护者做什么。当前阶段性跨模型复审按维护者要求延后，不能借此省掉自检、CI，也不记为已有独立复审结论。

## 11. 本次未做

本轮 implementation 尚未完成；未提交、推送、创建 PR、重签 3b/4b、Ready、合并或部署，未操作生产、Gate 或删除业务数据。查询预算与 kindCode 精确识别补充已批准，本组复验通过；P0–P7 完整收口、有效源上限数据库规模、各角色及历史版本 HTTP 授权矩阵、全量 E2E／CI、整体跨模型复审仍未完成。D5–D8 及后续 Release 未实施，旧紧急创建 500 根因未定位。

## 12. implementation 阶段证据与查询预算差异（2026-09-12，未提交）

实现目录：`/Users/dengwang/Documents/coding/srvf-nest-api-r4-d4-implementation`，分支 `codex/activity-os-r4-d4-implementation`。隔离探针位于 `/tmp/srvf-r4-d4-validation.fm5MlW`，执行副本仅使用获批 app_test_w98，保留原测试转换、setup 与守护，避免默认生命周期额外初始化 app_test／w1。补充后实际改动为93个批准路径，未越出原101+1共102路径；检查器只有 §13 批准的精确识别增量。

- Prisma schema 校验／生成通过。D4 migration E2E 两项通过：第 121 条在 `app_test_w98` 空库完整 deploy；非空 120→121 升级保留旧 D3 父子行、来源、收据与服务段，六个新增证明列保持 null，升级后旧命令仍可执行。原 120 条 SQL 未改；未运行 migrate dev/reset/db push。
- `activity-os-r4-d4-time-bucket-settlement.e2e-spec.ts` 七项通过：真实 HTTP 认定→prepare→正式提交→冻结下钻；旧小时及贡献分保持；人工认定自动基线未知保持 null 且四桶留存理由；明确缺席且无来源生成四个零桶；重复命令和末步审计失败整笔回滚。补充直接 SQL 验证含合法正例、20 种伪造、8 类父子表更新／删除拒绝、13 种 D3 草稿证明／操作不匹配；伪造样本重算 hash，避免仅因旧 hash 错误而误报保护有效。
- 原 `activity-settlement-submit.e2e-spec.ts` 45 项回归保持原断言并通过。
- `activity-os-r4-d4-time-bucket-concurrency.e2e-spec.ts` 的同键／异键 CAS、真实锁等待期间停用用户／成员、撤权／撤负责人五项通过。规模项 1／100／2000 人均完成 prepare、分页和新旧 submit，次数不随人数增长；但仍在原计划的“分类 submit 增量 ≤12”断言处失败。
- 20 份获批旧 E2E 仅适配当前链计数／当前回放标题、明确新表清理前置和 D3 历史迁移位置；历史升级目标与业务断言保留。可保证只用 w98 的 D1-1 migration、D1-3 selection migration、D3 allocation migration、D1-1 foundation 四组共 38 项通过。其他含固定 w82–w97／第二影子库的旧迁移测试未在本地越权执行，仍须 CI 验证。
- 新 presenter＋query＋service 三组 88 项通过；新 command＋V2 hash＋audit 三组此前 89 项通过，access＋policy 此前 60 项通过。全仓 unit 初跑的 3 组登记不同步失败已更正并复验；最终重新执行完整 unit，**383 组全部通过，8420 项通过、5 项既有 TODO**，耗时 78.729 秒。报告为 `/tmp/srvf-r4-d4-validation.fm5MlW/d4-final-unit-results.json`；不把既有 TODO 记作已验证行为。
- build、完整 typecheck（含测试与脚本）及全仓 lint 通过。lint 首次在默认约 4GB Node 堆上 OOM；仅以本地 `NODE_OPTIONS=--max-old-space-size=8192` 重跑通过，没有修改 CI、配置或检查规则。
- OpenAPI、13 份客户端、ROUTE_AUTHZ／权限绑定 baseline、RBAC_MAP、事实计数及 CODEMAP 已按实际闭包生成；除 App 类型／调用外，其余客户端仅生成摘要变更。最终契约测试 **1060 项、2 份快照全部通过**。旧 486 个 OpenAPI paths 和 843 个 schema 的结构逐项比对保持不变，快照中这 1329 个旧块的文本也逐块相同；新增 8 路径／24 个 DTO，不以整文件 diff 行数代替结构比对。比对脚本为 `/tmp/srvf-r4-d4-validation.fm5MlW/verify-contract-scope.cjs`。
- `docs:authz:check`、`docs:readtax:check`、`docs:counts:check`、`docs:rbacmap:check`、migration 计数与权限绑定检查通过。原 Harness 的5个失败已处理：2个生成物不同步已刷新，3个 kindCode 覆盖冲突按获批补充修复。最新完整 `pnpm harness:selftest` 三段串联退出0，含5个新增精确识别正反例；ESLint自测138通过／0失败／5既有缺口，hooks自测68通过／0失败。未改变任何已知缺口的定性。

SQL 是 Prisma engine 的实际 query 事件计数，只排除 BEGIN／COMMIT／ROLLBACK／SET TRANSACTION；所有 Service 当前身份、成员、显式范围、资源、组织资格和责任复核均计入，不打印 SQL 参数或凭证。它不声称覆盖 HTTP Guard 在进入 Service 前的查询，也不把数据库函数内 SQL 误称成网络往返数。

| 同一普通成员、组织范围及无有效源夹具 | prepare 总 SQL | 历史桶页总 SQL | 分类 submit 总 SQL | 原 submit 总 SQL | prepare 耗时 |
| ------------------------------------ | -------------: | -------------: | -----------------: | ---------------: | -----------: |
| 1 identity                           |            334 |             40 |                805 |               18 |       373 ms |
| 100 identities                       |            334 |             40 |                805 |               18 |       288 ms |
| 2000 identities／8000 桶             |            334 |             40 |                805 |               18 |      1550 ms |

补充的有认定源及人工理由夹具（SUPER_ADMIN 但仍要求显式组织授权）实测：prepare 244，其中 16 次完整复核产生 208 SQL；桶页 28，其中两次复核 26 SQL；分类 submit 535，其中 23 次复核 483 SQL。该组不能替代上表的普通成员路径，亦未冒充 50000 slices 的完整数据库规模证据。

**补充建议 A（申请记录，现已批准）**：先在既有写集内消除没有安全作用的重复读取；保留每个可能等待的敏感锁后的当前资格复核、最终复核、不缓存身份、全部业务断言、prepare 30 秒及人数增长时 SQL 次数不增长约束。把含授权查询的 Service 测量上限明确为读页 120、prepare 400、分类 submit 950；原 submit 保持原样，不以旧实现的无调用方鉴权内部方法 18 条作为新 App 完整安全链必须只加 12 条的基线。新上限仍须在普通成员、负责人／审核者、显式组织范围及有效源规模上逐项验证，超出仍失败。

以上为原预算差异及申请时证据；维护者随后明确批准，现已更新 §6 和本组计数断言，复验见 §13。不简化判权、不改 Gate、不增加全局超时；检查器新增路径来自同次独立明确授权。本阶段仍有完整有效源规模和角色矩阵等待办，不能把本组通过冒充全部完成。

## 13. 补充方案 A 授权与实施记录

> **已批准并实施中（2026-09-12）**：维护者明确确认“D4 补充方案 A：查询预算120／400／950；精确扩展 kindCode 检查器及对应正反例，其他边界不变”。当前工作树两项精确令牌已核验，时间分别为 08:56:22Z、08:56:23Z。下文“待批准／尚未实施”为申请时的历史记录，不再阻止该范围实施。扫描器现已仅补配置字段发现，未改 statusPredicateFields、其他 kindCode 或 lifecycle 规则；metadata 实测 71 项、零错误，完整自测和预算复验进行中。

补充后的并发及计数 E2E 已复跑，6 项全部通过（28.844 秒），报告为 `/tmp/srvf-r4-d4-validation.fm5MlW/d4-supplement-concurrency.json`。普通成员、显式组织授权，1／100／2000 人的读页／prepare／submit 均为 40／334／805 次，旧 submit 仍为 18；prepare 分别约 929／388／2976 毫秒，未触及 30 秒上限。这证明本组新总次数上限和非逐人增长约束，不替代 50000 个有效 slice、完整角色／历史版本矩阵和 CI。

检查器只新增 7 行、替换 1 行配置字段发现，不修改其他识别、治理升格、状态边或规则出口。五个新自测分别验证精确登记正例、漏登记、换成真实的 `ActivityMetricDefinition.kindCode`、同模型错误字段名、额外泛化其他模型；全部调用隔离副本中的真实扫描器，未复制扫描逻辑。首次并行 typecheck 遇到自测临时 `src/__harness-authz-r8-probes` 被清理而报 TS6053，须等守护完成后串行复验，不改编译规则。

**事实**：§8 要求把 `ActivitySettlementTimeRevision.kindCode` 登记为不可变配置，L1 inventory／not-derived。已完成该登记，但 `scripts/check-boundaries.ts` 的 `stateLikeString` 只发现 status／state／stage／phase／lifecycle／mode 命名，不发现 kindCode。2026-09-12 只读 metadata 实测 165 模型、70 个被发现的字符串字段，唯一错误为 `coverage mismatch: expected 70, got 71`。未删除新登记、改字段名或修改扫描规则来制造通过。

**建议 A，尚未实施**：在 `scripts/check-boundaries.ts` 仅显式识别 `ActivitySettlementTimeRevision.kindCode` 这一模型／字段组合，保留全部既有命名规则。扩展已经在 §8 的 `scripts/harness-guards.selftest.ts`，新增该精确组合的正例及其他模型 kindCode、漏登记等反例，保留所有 coverage／governed／状态边约束。原先该 selftest 仅获准做权限计数 263→265 的兼容更新；本补充另行申请正反例测试的用途授权，不视作原授权自动包含。

若维护者批准，精确写集为原 101 路径 **增加 1 个** `scripts/check-boundaries.ts`，合计 102；selftest 不另增加路径。拒绝泛化到全仓任意 kindCode，拒绝放宽失败判定或改门禁豁免。测试用临时夹具与真实代码使用同一扫描路径。

对上述两个精确路径运行 `pnpm harness:needs` 实测均属红区。工具建议的 `scripts/**` 是匹配规则，不采用为授权写集；下面仍只授权两个文件。

可一次确认：

> 确认 D4 补充方案 A：查询预算读页120、prepare400、submit950；扩展 scripts/check-boundaries.ts 仅识别 ActivitySettlementTimeRevision.kindCode，并扩展 scripts/harness-guards.selftest.ts 的对应正反例；保留必要授权复核、prepare 30 秒、规模约束及其他既有边界。验证后按原授权提交、推送、创建 PR，不合并。

维护者确认后，在本轮实施目录执行以下精确红区授权（AI 不代跑）：

```bash
cd /Users/dengwang/Documents/coding/srvf-nest-api-r4-d4-implementation
pnpm harness:grant 'scripts/check-boundaries.ts' --reason '维护者确认 D4 补充方案 A：仅精确识别 ActivitySettlementTimeRevision.kindCode，保留全部既有守护'
pnpm harness:grant 'scripts/harness-guards.selftest.ts' --reason '维护者确认 D4 补充方案 A：仅补 kindCode 精确识别正反例并保留 D4 已授权计数适配'
```

以上不包含自签 3b／4b；待最终 SQL hash、seed digest 和验证证据稳定后另以实际读数请求维护者重签。尚未批准的建议不成为已通过的验收标准，也不赋予合并、生产、Gate 或业务数据删除权限。

## 14. 历史版本资格与真实 HTTP Gate 补验（2026-09-12）

本轮在既有 102 路径内继续 P4／P6：新 HTTP 正例证明当前审核者能读历史桶、来源、认定；在同一 run 追加由该审核者创建的较新版本夹具后，原历史请求错误返回 404／20219。定位为 QueryService 首次 `authorize` 未传目标版本，误取最高版本并触发该新版本的自审否决；最终复核虽指定旧版本，但此前已提前拒绝。

修复仅在新 D4 QueryService：事务内先查询同活动、指定不可变记录的版本 ID，再把该 ID 传入首次完整资格校验；详情查询和返回前复核均保留。定位只选 ID，不在资格通过前输出明细；目标不存在时沿原授权优先错误顺序。无草稿证明的旧 D3 认定不伪造历史版本，沿原资格语义；未改 App 准入、组织范围、Authz／users 属主、路由、DTO、权限码、schema 或 migration。

- 历史桶、来源、认定三项独立 HTTP 用例通过，均含初始正例、追加较新自提交版本后的有权旧版本读取、当前版本自审拒绝、撤权后历史拒绝。追加版本是隔离数据库夹具，不冒充完整“更换负责人再重提”的业务流程验收。
- 四种 enabled／readonlyMaintenance 组合使用隔离测试应用注入的真实配置及 Gate 类，未 mock Gate。三种写命令的既有收据重放按实际状态放行或拒绝；有权历史在四态均可读，五张相关表的行数不变。未操作运行实例或生产 Gate。
- 最终两个 D4 E2E 文件串行回归 **20 项全部通过**，34.942 秒，报告 `/tmp/srvf-r4-d4-validation.fm5MlW/d4-history-gate-regression.json`。当前 Query／Service 单元回归73项通过；完整 typecheck及改动文件 ESLint通过。OpenAPI check证明结构无变化，权限声明派生文档随源码刷新。
- 单独计数复验：普通成员 1／100／2000 人均为读页 **41**、prepare **334**、submit **805**、旧 submit **18**；prepare 约316／312／1345毫秒。分页增加的一次查询是目标版本定位，仍满足获批总次数和不随人数增长约束。§12／§13 的40次是修复前历史读数。
- 按交接技能同步两端历史资格说明，未手改生成客户端或契约快照；当前仍为93个批准路径改动，无写集外路径。

本次未做：50000个有效 slice／40000个来源行的完整数据库上限与超限、其余角色／锁等待矩阵、最终全量检查及CI、3b／4b、提交／推送／PR尚未完成；不合并、不操作生产、不启用 Gate、不删除业务数据，不把本轮20项回归视为整个D4完成。

## 15. 满额有效来源探针发现的旧草稿依赖缺口（待维护者裁决）

2026-09-12，在已授权 E2E 文件加入真实满额探针：先建立 2000 个 identity 与 10000 个有效、同成员不重叠的服务段，再调用真实封印与旧草稿生成；后续拟创建 50000 个合法 allocation slice，验证 8000 桶／40000 来源及 SQL 预算。没有在封印后补人口、伪造封印计数、绕过数据库约束或放宽生产上限。

实际执行在旧 `SettlementDraftService.generate` 提前失败：`assertSyncPathAllowed` 明确拒绝超过 500 人的同步生成，未进入 D4 allocation、prepare、submit。报告 `/tmp/srvf-r4-d4-validation.fm5MlW/d4-max-sources.json`：1 项失败、14 项未选择，11.035 秒。此失败不代表 D4 满额查询超预算，也不能写成上限验收已通过；新增探针仍为红色，不提交为通过版本。

只读引用链核验：

- `src/modules/activities/settlement-draft.service.ts:84` 同步上限 500；`:859` 调用准入检查。
- `src/modules/activities/settlement-draft-dispatch.service.ts:136` 将超过 500 人分流为 pending 任务，payload action 为 `settlement_draft_generate`。
- `src/modules/activities/activity-batch.worker.ts:407` 领取谓词只包含账本准备、reconciliation、现场 bulk punch 和 import execute，不领取该草稿生成 action；全文引用查询也未找到该 action 的执行消费者。不能把“已入队”当作“已生成”。

这暴露了完整入口容量与本计划 P6 2000 人验收之间的依赖缺口。上述旧草稿生成／调度／worker 不在当前 102 路径中，未修改。建议先明确补齐大规模草稿执行链的精确方案与授权，不将 500 简单改成 2000，不用直接写旧草稿夹具冒充完整流程成功。既有 D4 组件规模结果与真实完整入口验收必须分开记录。

本轮新增测试通过全量 `pnpm typecheck`；完整满额链未通过、50000 slice 与 +1 尚未跑到。没有提交、推送、创建 PR、重签、合并、生产操作、启用 Gate 或删除业务数据。

## 16. 大规模草稿执行链补齐方案 A 与精确授权清单（已获实施授权）

### 16.1 授权状态及一句话结论

**最新授权覆盖说明（2026-09-12）**：维护者已确认“第16节方案 A、29路径及验收清单；允许实施和 app_test_w98 隔离验证及测试夹具重建。其余边界不变”。下文“候选／仅文档／待确认”保留为起草时的历史语境，由本记录覆盖实施状态；不是扩大写集。原D4 102路径与本节29路径去重后为119路径，隔离验证同步器按该联合白名单检查，禁止越界复制。7c、提交、推送、PR及合并仍未授权。

本次继续在 `codex/activity-os-r4-d4-implementation` 工作树实现，保留原D4全部改动；补齐核心service/dispatch/worker原先与HEAD一致，可按补齐独立审阅，module、clock登记和文档等交叠改动在未来获准提交前按hunk隔离，不声称现有脏树是独立PR基线。没有执行stash、清理、提交或修改门禁。

维护者本轮仅授权“起草大规模草稿执行链补齐方案及精确授权清单，仅文档，不实施”。本节是候选方案，不是已经批准的 implementation，也不是可直接下发的已冻结 goal。本轮只修改本计划文件；保留全部既有 D4 未提交改动，不操作数据库、不提交、不推送、不创建 PR。

推荐补上既有后台任务的执行端，保留 **500 人以内同步、超过 500 人走后台**；共用原草稿计算与 hash 规则，不将 500 简单改成 2000。补齐后再跑完整 D4 满额链。最坏情况是生成超时、旧任务误执行或结果重复；用有界事务、严格任务识别、当前资格和租约围栏防止半份结果。不能满足本节验收时保留失败证据，不开 Gate。

这是涉及后台授权与并发写入的 D 档候选。方案 B 是保持原功能不变，将真实 2000 人全链验收明确标为未完成；它不满足本次完整落地目标，不推荐。分块暂存、多轮合并另需数据模型与发布协议评审，不在方案 A 中临场追加。

### 16.2 当前证据与边界

- 本地 HEAD 为 `eef0bbe4`（#1325），版本 0.72.0；本轮 preflight 查到相对本地 origin/main 落后 0，无远程 fetch 证明，不冒称远程最新。GitHub open PR 为无关草稿 #1324；不操作该 PR。
- preflight 因既有脏工作树和 open PR 退出 1。本轮按维护者对当前依赖文档的明确授权继续，不声称 preflight 全绿，不清空改动或修改门禁。实施启动前仍须核对工作树、依赖和授权。
- §15 的失败发生在同步入口，还未执行 50000 slices 的创建及 D4 prepare。该测试不会仅改成“预期拒绝”便算满额验收完成。
- HTTP 调用链为 `ActivitySettlementHttpService.generate`（:316）→ `SettlementDraftDispatchService.generate` → 同步生成或 pending job；后台执行链当前缺失。
- `SettlementDraftService.persistSegments`（:589）已有整批读取，但段插入（:692）和结果插入（:984）仍逐行执行。后台补齐须批量化这些写入，不能只把同一慢事务搬进 worker。
- `AuthzService.explain`（:252）假设 JWT 已验证身份，不能把旧任务内的 actor 快照直接当作当前身份。后台必须使用 User 属主 `loadActiveUserIdentityInTx` 加 App 准入原语，再调用既有授权逻辑。
- `ActivityBatchJob` / `ActivityBatchJobItem` 已有租约、尝试次数、指针和计数，可复用；本补齐不新增表、列、migration、权限码、审计 event、路由或 DTO。

### 16.3 候选数据合同和运行规则

**容量与算法**

- 同步 `generate` 继续拒绝 >500 个 identity 或 distinct member；现有同步行为断言全部保留。
- 新后台执行支持至多 2000 identity、10000 个当前投影段，与 D4 容量对齐；超过上限明确失败，不截断。为限制事件链内存，候选后台读取上限为 **40000 个该活动相关 punch event**，读上限加一检测超限；这是新增产品边界，须随方案 A 明确确认，不将其伪装成既有规则。
- 生成核心仅抽取到既有 service 的事务内方法，共用投影、贡献计算、未决项处理、contentHash 和 revision 规则；不复制另一套算法。SQL 分批上限建议每批 500 行，以参数数量再约束，零逐成员数据库查询。
- 原同步事务配置不放宽。后台单次生成采用独立有界事务：候选最长 30 秒、等待连接最长 5 秒；不改变全局超时。满额成功须实测，若无法达到则回到方案评审，不能自动加超时或改分块暂存。

**任务身份与输入**

- 沿用 `jobTypeCode=bulk_proxy` 和 `payload.action=settlement_draft_generate`，精确 action 分派，不能接管 B6 现场任务。
- 新异步任务采用 `payloadVersion=2`，保存 activityId、executionMode、populationSize、actorUserId、actorMemberId、evidenceSealId 及 evidence/population/workflow revision。来自服务端当前事实，不接受客户端伪造；不保存 JWT、姓名、联系方式、事件原文或明细结果。
- operationKey、requestHash 继续沿既有输入归一化规则；同键同请求返回同一任务，不因后来封印变化偷偷生成新任务；异键是否生成新版本仍由原 contentHash 规则决定。
- 入队绑定的封印或 revision 已变，执行时失败关闭；用户须重新发起新 operationKey。不得静默切到另一封印。
- 既有 v1 async 任务缺少上述锚点：不猜测、不自动升级为 v2，不执行其业务；识别后以脱敏“旧任务缺少执行凭据，需重新发起”终止该任务。v1 sync 的既有回放不变。该历史任务处理语义须随本方案确认，测试使用隔离夹具，不操作实际业务任务。

**资格与事务**

- 按任务创建时绑定的 user/member 执行，重读当前 User.ACTIVE、未软删和 Member.ACTIVE；绑定成员变化或消失即拒绝。重试人不自动替代原执行人，避免借重试转移权限。
- 复用 `activity.settlement-generate.record` 的既有 Authz 行为与责任／组织范围，不套用 D4 新权限、不新增角色默认授予；不将旧 token 中的 SUPER_ADMIN 当作现任资格。
- 业务锁序保持 Activity 根 → job → settlement run，与取消的 Activity → job 顺序兼容；不得先持 job 再等待 Activity。身份／责任／授权的锁后复核必须使用同一 tx；等待后重新检查当前资格，不采用缓存。
- 租约由现有 worker 领取；执行事务中核验 job 状态、leaseOwner、leaseGeneration、leaseExpiresAt、action 和 activity 同链。失租者不更新业务、不改新持有者计数。
- 段、版本、结果、原草稿审计、job/item 成功状态及 resultReference 必须在同一个事务提交。不能“草稿已生成，任务回执再另开事务写”；崩溃重试不得多生成一版或重复审计。
- 取消先拿锁并提交则不执行；生成先获得锁并完成，则取消等待后按既有成功终态拒绝。撤权已提交后不得再凭旧资格生成。需分别用真实锁等待证明，而非只断言源码里有锁。
- 业务确定性拒绝（资格失效、封印变化、容量超限、旧任务无凭据）记录 failed item 与安全错误码；临时数据库错误按现有退避和尝试上限恢复；围栏丢失不写失败回执；耗尽尝试必须留下与 job 计数一致的失败 item，不能产生不可重试的悬空 processing item。
- 复用既有任务重试／取消端点和 DTO；旧任务重试仍不补凭据。Gate 关闭／只读维护时不得写新的业务草稿；控制面的领取与退避按既有 worker 规则，不将 Gate 视作永久业务失败。
- resultReference 和 job.settlementVersionId 指向生成的同活动版本，itemKey 仍为 generate，total=1；成功计数1、失败计数0。失败／取消／重放必须核对 item 与 job 汇总一致。
- 所有历史业务数据继续留存，不引入清理、暂存删除、批量回填或数据迁移。

### 16.4 精确候选实施写集

下表 **29 路径**是本依赖补齐的候选写集，包含与 D4 重叠的路径；**不是在现有 102 路径上简单加 29**，也尚未追加到原获批清单。本轮实际写集只有本计划文件。表中新增文件可以创建，既有文件不得借机全面重构。

| 编号 | 路径                                                                                   | 唯一用途                                                                                  |
| ---- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| B01  | `src/modules/activities/settlement-draft.service.ts`                                   | 保留同步 500 上限；抽取共用的事务内生成核心，批量写入段和结果，供受围栏保护的后台调用     |
| B02  | `src/modules/activities/settlement-draft.service.spec.ts`                              | 旧算法、hash、幂等、未决项、500 上限 characterization，新增批量等价断言                   |
| B03  | `src/modules/activities/settlement-draft-dispatch.service.ts`                          | 新增后台 payload v2 的封印和 actor 锚点；保留同步与 operationKey 回放                     |
| B04  | `src/modules/activities/settlement-draft-dispatch.service.spec.ts`                     | 新旧 payload、同步边界、回放、同键冲突测试                                                |
| B05  | `src/modules/activities/settlement-draft-batch.service.ts`                             | 新增后台处理器：当前资格、封印、租约复核，业务与任务回执同事务                            |
| B06  | `src/modules/activities/settlement-draft-batch.service.spec.ts`                        | 新增处理器正反例、失败分流、脱敏错误、取消与租约丢失测试                                  |
| B07  | `src/modules/activities/activity-batch.worker.ts`                                      | 精确接入草稿 action 的领取、执行、退避、过期恢复；其他 action 不变                        |
| B08  | `src/modules/activities/activity-batch.worker.spec.ts`                                 | 补 action 隔离、抢占、失租、缺处理器及故障恢复单测                                        |
| B09  | `src/modules/activities/activity-batch-worker.module.ts`                               | 在既有 worker 依赖图注册处理器和必要 provider，不新增进程                                 |
| B10  | `src/modules/activities/activity-batch-worker-registration.spec.ts`                    | 证明两个既有 worker context 真能装配草稿处理器                                            |
| B11  | `src/modules/activities/activities.module.ts`                                          | 仅注册或导出本补齐链所需 provider，避免循环依赖和错误实例                                 |
| B12  | `src/modules/activities/app-my-activity-batch-jobs.service.spec.ts`                    | 新增现有任务读面、重试与取消的草稿任务兼容单测                                            |
| B13  | `src/modules/activities/CLAUDE.md`                                                     | 模块说明更新，不宣称部署或 Gate 放行                                                      |
| B14  | `src/common/datetime/clock-authority.spec.ts`                                          | 仅登记本处理器复用的 job/item 时间写点，不改时间权威规则或旧断言                          |
| B15  | `test/e2e/activity-settlement-draft.e2e-spec.ts`                                       | 原草稿 characterization；仅增加案例，不改变原断言                                         |
| B16  | `test/e2e/activity-batch2-8b-settlement-http-boundary.e2e-spec.ts`                     | 真实 HTTP 的 500/501 分流与既有权限拒绝；仅增加案例                                       |
| B17  | `test/e2e/activity-batch6-batch-job-read-surface.e2e-spec.ts`                          | 既有任务 detail/items/retry/cancel 契约回归；仅增加案例                                   |
| B18  | `test/e2e/activity-settlement-draft-batch.e2e-spec.ts`                                 | 新增真实 PostgreSQL/worker 大规模生成、竞争、回滚、重试、取消 E2E                         |
| B19  | `test/e2e/activity-os-r4-d4-time-bucket-settlement.e2e-spec.ts`                        | D4 满额夹具改走真实 dispatch/worker，并以生成后的实际当前段构造 allocations，保留满额断言 |
| B20  | `docs/plans/activity-os-r4-d4-time-bucket-settlement-workbench-implementation-plan.md` | 补齐评审、实施证据及原 D4 依赖状态                                                        |
| B21  | `docs/handoff/miniapp.md`                                                              | 说明异步返回、轮询、失败和手动重试；不改客户端类型                                        |
| B22  | `docs/handoff/admin-web.md`                                                            | 说明既有任务读面及大规模草稿限制；不新增 Admin 入口                                       |
| B23  | `docs/ops/activity-batch-worker-runbook.md`                                            | 补草稿 action 运维恢复说明，保留既有健康检查决策与盲区                                    |
| B24  | `docs/ai-harness/NEXT_TASKS.md`                                                        | 登记依赖、未完成项及验收证据，不提前结清 D4                                               |
| B25  | `docs/ai-harness/FROZEN_DRAFTS.md`                                                     | 登记提案/实施状态，不擅自改变冻结业务合同                                                 |
| B26  | `docs/ai-harness/ROUTE_AUTHZ.md`                                                       | 仅运行生成器刷新 source 摘要与既有 action 调用证据，禁止手改权限                          |
| B27  | `CODEMAP.md`                                                                           | 新增文件后的派生地图刷新                                                                  |
| B28  | `changelog.d/activity-settlement-draft-batch.md`                                       | 独立记录本补齐变更及兼容边界                                                              |
| B29  | `docs/ai-harness/CUTOVER_SIGNOFF.md`                                                   | 仅在维护者实际重签 7c 后更新该项证据；不得预签或重写其他签字                              |

以上包含新建的 batch service/spec、任务读面 spec、batch E2E 与 changelog；不是声称这些文件已存在。其余候选路径须在实施前再次逐个核验。不授权修改 Authz/User/Member/Organization 属主生产代码、worker 进程入口、schema、迁移、权限、snapshot、配置、脚本裁判或 Gate。若现有属主原语无法满足锁后资格合同，停止说明具体缺口，不用跨模块深引或改门禁绕过。

### 16.5 一次列齐的验收清单（尚未执行）

| 探针           | 必须证明的结果                                                                                                                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 旧行为      | 原草稿单测/E2E characterization；500 同步成功、501 同步拒绝；投影、贡献、hash、未决项、旧版本留存均等价。                                                                                                                   |
| G2 真实入口    | 501 与2000人口，经真实 HTTP 入队 → 真实 worker → 真实草稿结果；不是手工写最终 draft 或 mock worker。                                                                                                                        |
| G3 满额链      | 2000 identity／10000有效段 → 50000合法slice → 8000桶／40000来源 → D4 prepare、分页、submit；使用生成后的实际当前段ID，不能沿用可能已被 superseded 的预置段。                                                                |
| G4 上限与仪器  | identity2001、投影段10001、事件40001、当前slice50001各自独立用例拒绝；核验业务表/回执无部分提交。含正向控制，不能首个失败遮蔽其他断言。                                                                                     |
| G5 查询与资源  | 普通USER真实授权路径；D4读页/prepare/submit总SQL≤120/400/950，prepare<30秒；后台另外记录500/501/2000档SQL、RSS及耗时，证明仅按批次数增长、无逐人/逐段SQL。后台满额事务≤30秒，峰值RSS候选≤512MiB；计量不得扣除必要授权查询。 |
| G6 幂等和崩溃  | 同键重放、异键同内容、提交前故障、提交后响应丢失；相同内容复用一个版本，不同请求各留操作审计，同一任务重放/故障恢复不重复记审计，任务指针可查（维护者确认口径）。 |
| G7 两个 worker | 同任务抢占、租约过期重领、旧持有者迟到、进程重启、处理器缺失；其他任务 action 不受影响。                                                                                                                                    |
| G8 当前资格    | 入队后停用User/Member、成员绑定变化、撤责任、撤权限、组织失效；等待锁前后分别触发，不得沿用入队身份快照放行。                                                                                                               |
| G9 输入漂移    | seal被撤销/替换、evidence/population/workflow变化、run已提交，均失败且无半份结果；新key可在新事实下重新发起。                                                                                                               |
| G10 任务控制   | 取消先/后赢锁、failed项重试、重试人≠创建人、失败计数守恒、v1 async缺凭据、v1 sync回放、四种Gate组合；错误不含SQL/堆栈/敏感原值。                                                                                            |
| G11 装配与兼容 | 两个既有 worker Nest context 均能装配处理器且无错误实例/循环依赖；原bulk/import/reconciliation/ledger回归；原任务列表字段和API snapshot零语义漂移。                                                                         |

本地实施验证只可在获准后使用 `app_test_w98`；不沿默认初始化脚本触碰 app_test 或其他worker库，不自动执行 prisma migrate reset/dev/db push。先 quick/typecheck/build 和定向 E2E；全量 E2E 由未来获准 PR 的 CI 冷跑。当前红色满额测试保持验收目标，不能删掉、skip 或改成弱断言。

G6口径追加确认：维护者明确批准“不同请求各留审计，同一任务重放不重复；相同内容复用版本”。此确认覆盖§16.8末尾的待拍板状态，但保留先前失败报告作为历史证据。仅修订本验收表及新增的异键测试：第一次操作审计为1、第二次为2，两个请求分别重放后仍为2且版本始终为1；不改生产生成器或删除任何审计。

G6确认后定向验收：`batch-g6-confirmed.json`在app_test_w98中4项通过、17项未选择，22.106秒，覆盖同键重放、异键同内容及双方重放、提交前写入故障回滚重试、提交后响应丢失与新worker context恢复。ESLint和diff空白检查通过。未选择的17项不是本轮失败，也不计入本轮通过数量；不替代其余G1–G11验收或真实操作系统进程强杀测试。未提交、推送、开PR、合并、重签、操作生产、启用Gate或删除业务数据。

G11旧action兼容复验：`batch-g11-legacy-actions.json`共58项，52通过、6失败（32.153秒）；ledger-posting 28、staff-import-offline 17、expiry/reconciliation 6全部通过，auto-commit套件1通过/6失败。失败不能归为全绿或直接放宽断言。该旧套件只在beforeAll清库，前两个用例遗留501人口的pending草稿任务；此前worker不领取此action，现在会先领取它，`drainUntilClaimed`却把任意首次领取当成目标账本任务。排除这两个草稿前置后，原B-02围栏四项单独运行全部通过（`batch-g11-fence-isolated.json`，4通过/3未选择，9.713秒），没有改其代码或断言。

G11建议精确追加写集，仅`test/e2e/activity-batch2-8a-auto-commit.e2e-spec.ts`：在前两个大规模草稿夹具完成原durable/replay断言后，用真实worker明确消费并核对对应jobId及业务结果，再进入原账本时序；必要时仅在该文件补齐草稿夹具已有授权资格前置。不把“两轮”改成“一轮”、不泛化忽略未知任务、不删除任务/审计、不改变原B-02断言或生产worker。当前120路径不含此文件；`harness:needs`确认非红区，但仍待维护者明确扩展固定写集，无需终端grant。未实施该适配，保留上述失败证据。

G11追加授权已确认：维护者允许适配`activity-batch2-8a-auto-commit.e2e-spec.ts`，真实消费并核验前置草稿任务、保留全部原断言、不改生产代码，使用app_test_w98验证。此确认覆盖上段待授权状态；联合精确写集由120变为121路径。适配仅在两个501人口前置用例完成原断言后真实消费指定jobId，核验成功计数、item结果指针及唯一501人口版本；不让无关任务领取冒充账本成功，不删除夹具任务或审计。

G11适配结果：首次只补消费时原账本/围栏5项通过，两个新增草稿成功断言失败；w98任务错误码均为30100，沿组织属主原语定位到旧夹具parentId为空（根组织不能承载活动）。仅在获批旧测试文件建立测试根→活动子组织及三条闭包关系，未改生产资格检查。`batch-g11-adapted-regression.json`四组58项全部通过（34.078秒）：自动提交7、导入/现场批处理17、到期对账6、账本28。两轮领取及全部原B-02成功/拒绝断言原样保留，没有删除任务或审计。实际104路径均在121路径联合写集内；不代表其余G1–G11全部完成或CI已通过。

G10四态真实Gate验收：新增测试先真实HTTP入队，再在该测试应用的内存配置中分别设置enabled×readonlyMaintenance四种组合；不mock Gate判决、不改生产环境或配置文件。唯一可写组合产生一个版本/审计；其余三态保留pending且failed=0、版本/审计均0、准确错误码和空结果指针，真实HTTP任务详情仍可读取。finally恢复原配置；三种被阻断任务在恢复可写并推进测试退避时间后均只生成一份结果与审计。`batch-g10-gate-matrix.json`4通过/21未选择，18.724秒，ESLint通过。仅覆盖首轮阻断与恢复，不代替长时间维护窗耗尽重试、取消赢锁或不同重试人验收。

G10取消顺序验收：新增“生成持有真实Activity锁时发起HTTP取消”用例，在生成事务内只暂停等待，不mock生成结果；用当前w98的pg_blocking_pids确认取消实际等待该生成事务，释放后真实生成成功、取消按原ACTIVITY_STATUS_INVALID的HTTP/BizCode拒绝。job/item保持succeeded、指针同链、版本/审计各1。与既有取消先完成→worker不领取→版本0的用例合跑，`batch-g10-cancel-order.json`2通过/24未选择，11.281秒。测试finally释放屏障并等待两方结束，原5秒取消事务与30秒生成事务不变；没有修改生产锁序或取消行为。

G10不同重试人验收：新增两项真实HTTP/worker对照。把活动责任赋予普通USER审核人，停用原创建人后真实执行失败；审核人通过既有retry-failed端点重试，job的createdByUserId及payload均逐值不变。原创建人仍停用时再次失败、业务版本/审计0；仅恢复原创建人资格的正对照完成一次生成，版本/审计各1，job/item成功与失败计数一致。`batch-g10-retry-identity.json`2通过/26未选择，11.337秒，ESLint通过。不把“能重试”当作替换执行身份授权；未修改生产资格、重试逻辑或权限码。

G7处理器不可用恢复：在独立测试Nest worker图中将草稿处理器注入为空，保留真实数据库领取与围栏逻辑。首次使用undefined覆盖未生效，`batch-g7-handler-recovery.json`按“必须拒绝”的断言失败（任务正常执行），该报告不算故障恢复证据；改用null并先断言实际注入为空后，worker按SettlementDraftHandlerUnavailable拒绝，job保留processing租约，版本/审计0。仅推进该w98测试任务的租约后，完整worker重领，generation加1、attempts为2、job/item成功、版本/审计各1。`batch-g7-handler-recovery-verified.json`1通过/28未选择，7.039秒。该证据是依赖不可用注入及租约恢复，不冒称真实生产进程崩溃或操作系统重启。

后台组合复验：`batch-g6-g11-combined.json`该新后台spec全部29项通过，135.004秒；不是只选择最新故障注入单例。覆盖已写入该spec的竞争、前后提交故障、异键审计、身份变化、租约、取消、四态Gate、不同重试人和两个worker图等；ESLint、测试typecheck与diff检查通过。报告文件名中的G6–G11不代表全部分项验收完成，容量独立上限、资源峰值及其他未补矩阵仍开放。未提交、推送、开PR、合并、重签、操作生产或删除业务数据。

G4事件读取独立边界：新建40000/40001两组历史重建夹具，501人口且全为无对应签到的历史签退事件，投影段数0，防止人口或10000段上限先行遮蔽事件读取限制。此夹具在测试中直接装载事件，不宣称经当前命令合法接收或重新封存。真实worker在40000条时生成待定草稿，40001条时按SETTLEMENT_DRAFT_POPULATION_TOO_LARGE拒绝，版本/业务审计/投影段0、任务失败指针空；均精确核验事件和人口计数。`batch-g4-event-limit.json`2通过/29未选择，20.653秒，ESLint通过。证明事件读取上限，不替代真实封存、合法满额链及10001段/50001切片独立边界。

G4投影段独立边界：新增10000/10001闭合事件对重建夹具，501身份、20000/20002事件；各身份按小时分隔、每段31分钟，段之间不重叠。直接装载的隔离重建输入不替代封存命令验收。真实worker在10000时持久化恰好10000段、版本/审计各1；10001时以容量错误拒绝，段/版本/审计均0、失败item结果指针空。`batch-g4-segment-limit.json`2通过/31未选择，18.158秒，ESLint通过。人口和事件均未到上限，因此本探针没有以其他容量闸替代段上限；50001切片及资源峰值仍待独立验收。

G4切片独立边界：将原满额测试的输入构造抽为本文件共用helper，原50000切片的成功、SQL预算和正式提交断言保持不变；新反例仅把一个分配从5片细分为6片，仍为2000身份/10000段，总50001片，每个分配均在500片合同内，manifest/hash/父计数/收据一致，数据库全部约束保持开启。两组都从真实封存→HTTP异步草稿→worker生成当前段，再创建完整分配。`d4-g4-slice-limits.json`两项通过（116.669秒），满额prepare11077ms、SQL340/41/811。新增反例真实HTTP prepare按ACTIVITY_TIME_SETTLEMENT_SCALE_LIMIT拒绝，timeRevision/bucket/source均0；追加命令收据与该命令审计均0后，`d4-g4-slice-rejection-complete.json`单独复验1通过/15未选择（45.546秒）。ESLint与测试typecheck通过；资源峰值和尚未补齐的其他矩阵仍开放，不宣称全阶段完成。

G5独立进程人口档测量：新增编译后worker子进程探针，启动实际NotificationOutboxWorkerModule依赖图，以同类PrismaService开启query事件计数，未mock业务处理器；连接前精确限制localhost/app_test_w98，连接后复核current_database。统计整个drainOnce的全部SQL（含授权及BEGIN/COMMIT等控制语句），RSS取子进程resourceUsage的生命周期最大值（包含Nest测试装配开销，不含父Jest），不是用前后内存差代替峰值。`batch-g5-worker-population-resources.json`两项通过（15.897秒）：501人口51条SQL/127.485ms/237273088字节峰值，2000人口51条SQL/129.557ms/244039680字节峰值，均低于30秒/512MiB。此两档无打卡证据、生成待定草稿，说明人口读取没有逐人SQL，但不能证明10000段/40000事件满负载峰值或批量写增长；500同步基线与满事件负载测量仍待完成。build与ESLint通过，未改生产开关或业务代码。

G5测量入口兼容修正：只读检查发现CI的E2E作业不继承fast作业的dist，且使用不同worker隔离库。探针已改为本spec内单独编译到mkdtemp目录，afterAll仅清理该编译产物；无需CI改动或已有dist。父测试先执行仓库assertTestDatabaseUrl，子进程复核期望库名及本地主机、连库后再次核对；本地仍只运行w98，不放宽其他数据库权限。重新测量`batch-g5-self-contained-resources.json`2通过（32.59秒，含独立编译准备）：501人口51SQL/144.483ms/236535808字节峰值，2000人口51SQL/150.904ms/243007488字节峰值。编译器峰值与父Jest不计入worker峰值，测量时仍包含worker完整装配开销。这里的“兼容”是消除已知dist/固定库名依赖，并非宣称远程CI已验收。

G5增加满段写入负载：独立编译worker的资源矩阵新增2000人口/20000签到签退事件/10000闭合段，事件对按身份分散、各段31分钟且不重叠，测试直接装载重建输入，不替代生产封存入口。`batch-g5-segment-resources.json`三档通过（总42.557秒）：501/0段为51SQL、117.744ms、238223360字节；2000/0段为51SQL、163.771ms、242368512字节；2000/10000段为76SQL、1270.108ms、305233920字节。最后一档核验真实持久段数10000、版本与业务审计各1；全部SQL含事务和授权，没有扣减。满事件40000及500同步基线、不同事件链分布仍未由本结果覆盖，不能据此宣布整个资源矩阵完成。

G8普通成员独立验证：新增三项真实HTTP入队→worker用例，明确actor为Role.USER；有效负责人成功，入队后撤责任（同事务结束责任记录及既有授权投影绑定）、组织INACTIVE分别拒绝30100，版本/生成审计均为0且任务结果指针为空。历史共享夹具缺生成权限及负责人授权投影，先前三轮在入队/夹具准备失败；接入既有ActivityResponsibilityGrantProjector后正向和组织拒绝通过，撤责任夹具又被ended_at_check拦截，补齐既有endedAt/endedByUserId合同后`batch-g8-ordinary-verified.json`三项通过（15.359秒，36项未选择）。未修改生产代码、共享helper、旧断言或数据库约束。最终ESLint、test typecheck、diff检查通过。此前完整36项在`batch-current-full-36.json`全部通过（196.834秒）；当前新增后的39项尚未组合重跑，撤权限与锁等待矩阵仍待补齐，不能标记G8整体完成。

G8锁等待补证：新增Role.USER真实任务在Activity行锁等待期间的五个独立失效用例（User停用、Member失效、成员解绑、活动负责人授权绑定结束、组织失效）。屏障以当前库pg_stat_activity及确切阻塞pid确认真实等待；失效变更完成后释放锁，五项均得到30100/failed，任务计数守恒、版本/生成审计为0、结果指针为空。结束授权绑定用例同时确认负责人记录仍active，隔离“责任仍在但授权已失效”维度。`batch-g8-ordinary-lock-matrix.json`八项通过（含上一轮三项普通成员正反向，36项未选择，36.029秒）；ESLint、test typecheck、diff检查通过。仅新增测试与本段记录，不改生产。当前套件44项尚未组合重跑；仍不把部分锁等待矩阵冒充G8完整验收。

G8组合回归与G9替代封印：`batch-current-full-44.json`当前44项完整通过（230.283秒），覆盖G8新增与既有容量、资源、幂等、恢复用例共同运行。随后新增G9独立探针，改变隔离夹具evidenceRevision并调用真实EvidenceSealService生成新封印，旧seal被真实服务标记superseded；旧job以SETTLEMENT_DRAFT_EVIDENCE_SEAL_STALE失败，版本/生成审计为0且指针空；新operationKey经HTTP入队、worker生成唯一引用新seal的版本和一份生成审计，旧失败job/items逐值不变。`batch-g9-reseal-new-key.json`1通过/44未选择（7.263秒），新增探针ESLint、test typecheck、diff检查通过。当前总45项未再次组合运行；run已提交拒绝等剩余G9项仍待补，不把本次局部结果宣告为D4整体完成。

G9真实送审后拒绝重生成：新增501人口经真实worker生成草稿、HTTP逐项登记缺席零值、入队另一个生成任务、HTTP送审成功，再由worker处理排队任务的用例。首次未处理未决项时送审正确拒绝20056（`batch-g9-submitted-run.json`，1失败，7.411秒），没有改送审校验；补真实编辑前置后送审成功，后台旧任务以SETTLEMENT_DRAFT_RUN_STATUS_INVALID失败。最终进一步逐值比较送审前后run、两版本及1002条草稿/提交结果，均不变，生成审计仍1份。与四种输入漂移、替代封印新键恢复合跑`batch-g9-input-state-matrix.json`六项通过（40项未选择，35.166秒）；ESLint、test typecheck、diff通过。当前总46项尚未组合重跑，不涉及生产状态操作、Gate、提交或PR。

D4完整三组复验：`d4-current-three-suites.json`三套24项全部通过（155.035秒），包括当前分类结算、并发及迁移测试，不再仅引用增量两项结果。运维SOP按B23补齐草稿action、失败恢复、旧v1异步凭据缺失、原执行人绑定、新键/新事实及不可改库绕过的边界，保持原健康检查决策与7c待重签；changelog同步登记。当前实际105路径均在121路径联合写集内，diff检查通过。未实施生产恢复、进程重启、部署、开闸、签字或PR操作。

G5满事件资源档：在已存在三档旁增加2000人口/10000闭合段/40000事件（其中20000额外无配对签退）的独立编译worker测量，重建输入不冒充新封印验收。`batch-g5-full-event-resources.json`四项全部通过（43未选择，55.575秒）：501空事件51SQL/186.883ms/236814336B，2000空事件51SQL/139.825ms/243302400B，2000/20000配对事件/10000段76SQL/1271.549ms/310411264B，满40000事件71SQL/1253.476ms/362872832B。所有档仍含全部事务/授权SQL、30秒和512MiB上限不变。满事件档SQL反而少，不能据此泛化“更多数据更快”；测后只读确认当前库app_test_w98的事件40000、段10000、结果行0。生成器对事件链异常保持pending而不写正式结果，因此该档不是结果行满额写入的性能证明。500同步基线、其他事件链分布及最终组合仍待补齐。当前47项，ESLint、test typecheck、diff通过，无生产代码变更。

G5同步500基线已补：将人口/封印夹具准备与入队拆开，500档在独立编译进程内构建真实HTTP AppModule、复用applyGlobalSetup/applySwagger并请求generate，确认outcome=draft与v1同步成功收据；不伪造500异步任务。计量标记sync-http（含HTTP鉴权/全局处理/同步生成）与worker-drain（含领取、事务和执行授权）两种范围，二者不能直接据SQL数作效率排名。`batch-g5-sync-http-and-worker.json`五档通过（43未选择，59.003秒）：500同步37SQL/190.321ms/279248896B；501后台51SQL/104.776ms/237338624B；2000空事件后台51SQL/154.866ms/244203520B；2000/10000段配对事件76SQL/1339.754ms/298303488B；40000事件71SQL/1190.176ms/373571584B。30秒/512MiB与全部原断言保留，当前48项；编译与格式检查通过。其他事件分布、真正进程崩溃、最终组合与CI仍不可由本资源表替代。

G7真实子进程崩溃：新增独立编译worker子进程，在真实generateInTransaction已写出版本且事务内核验可见后，自发SIGKILL（只杀测试自己的pid）；父测试同时核验退出信号及FAULT_AFTER_WRITES标记，未把普通异常当作硬杀。数据库保留processing领取收据、未提交版本/生成审计回滚为0；只将该w98夹具leaseExpiresAt推进至过期，随后另一个新进程真实领取并成功，attempts=2、leaseGeneration+1、版本/生成审计各1。`batch-g7-real-process-crash.json`1通过/48未选择（29.695秒）；ESLint、test typecheck、diff通过。当前49项尚未全组复跑。证明范围是本地测试进程事务中断恢复，不是生产节点重启、网络分区或OOM部署演练，未改变租约常量、应用入口或生产代码。

维护者已确认文档更正“任务成功后刷新结算工作台”，并允许补齐交接、不改接口：纠正runbook §5.5此前误称detail/items可查看结果引用的文字，按既有AppMyActivityBatchJob DTO不返回resultReference的合同处理；两份handoff说明outcome分支、当前责任读面、成功刷新既有settlement工作台、人工重试及新键边界，不新增任何字段或Admin旁路。该确认解除此前文档冲突暂停；不是字段扩展、生产操作或PR授权。最新完整草稿套件`batch-current-full-49.json`49项通过（329.993秒），`current-final-contract.json`1060项和2份snapshot通过（3.833秒），counts/codemap/rbacmap检查通过，CODEMAP的2类警告仍保留，不能宣称清零。本轮仅文档更正，不重复将同份测试计为新增验收。

G8时点矩阵补齐：六种普通成员资格变化（User停用、Member失效、成员解绑、授权绑定结束、责任撤销、组织失效）分别在worker开始前及真实等待Activity锁期间触发，共12项；保留此前普通成员成功对照及两项拒绝用例。`batch-g8-before-and-lock-matrix.json`15项通过、41项未选择（61.909秒），全部在app_test_w98运行。等待场景仍通过当前库和确切阻塞pid确认，失败后仍断言30100、失败计数、空结果指针及零版本/生成审计；授权结束场景保留责任仍active的独立断言。ESLint、test typecheck、diff及CODEMAP检查通过（既有2类WARN保留）。当前套件增至56项，尚未全量组合重跑；不能将上一轮49项完整通过写成当前56项全过。本次未修改生产代码、接口或门禁。

当前56项组合复验：`batch-current-full-56.json`完整56/56通过（292.712秒），未选择/失败均为0；本轮没有改该E2E源码。五档独立进程资源读数依次为500同步37SQL/179.451ms/276332544B、501后台51SQL/141.350ms/237125632B、2000空段51SQL/141.681ms/241860608B、2000人口10000成对段76SQL/1248.584ms/298762240B、另含20000孤立checkout的40000事件档71SQL/1243.310ms/375078912B。最后一档异常链包含未决项，不能据此宣称更大完整结果写入更快。

B12专用单测补齐进行中：新增计划内`app-my-activity-batch-jobs.service.spec.ts`，`batch-read-controls-unit.json`11/11通过（0.578秒），证明五类状态的既有安全返回字段/控制提示、当前责任查询条件、不选内部结果指针或payload、三类失败状态重试仅回退失败项并同额扣计数、取消使用事务时钟，以及当前责任丢失时两种写命令均拒绝。此处用受控Prisma替身检查真实Service编排与查询参数，不替代此前真实HTTP/PostgreSQL资格和锁等待证据；列表分页、items及更完整拒绝矩阵仍须继续核对。另`d4-batch-current-units.json`既有11组229项通过（3.31秒），与新增11项分别计数；src/test typecheck、ESLint、diff及CODEMAP检查通过（2类既有WARN保留）。B08/B10计划逐项对照、最终检查、3b/4b/7c实际重签和提交PR授权仍未完成，不宣布整包完成。

B08/B12补证与全仓单测：任务读面增加分页计数/查询同范围、items安全投影和越权不读items四项，专用单测15/15通过（`batch-read-list-controls-unit.json`，0.646秒）；worker新增成功/失败回执、失租、未预期异常和缺处理器五项分发单测，均不进入账本收尾。三组组合`batch-dispatch-read-registration-unit.json`29/29通过（0.953秒），src typecheck、ESLint、diff及CODEMAP通过（既有2类WARN保留）。分发单测用Prisma替身，不作为真实SQL抢占证明；B10两个真实worker context装配并各自完成任务，仍由完整56项E2E中的两项提供证据，现有registration单测只证明入口结构。

全仓单测`d4-current-all-unit.json`385组中384通过、1失败；8458项中8452通过、1失败、5todo（86.107秒）。唯一失败为`activity-batch-lease-fence.spec.ts:287`：新增sweepDead CTE对子项的UPDATE缺少持有者围栏，也未登记受限例外。独立`batch-lease-guard-repro.json`稳定复现1失败/10通过（0.509秒）。既有清道夫job写点有例外，但不能擅自将它扩展到item写点。源码中item更新只引用同语句先按精确action、async、processing、尝试用尽及过期条件UPDATE并RETURNING的job，且限定generate和非succeeded项；这是待核验的受限清道夫路径，不据此直接宣布误报或放宽检查器。

待维护者确认的精确补充方案A：扩展`src/modules/activities/activity-batch-lease-fence.spec.ts`，仅为上述过期清道夫同语句job→item链增加受限识别及理由；增加正向控制和删除过期/尝试上限/任务action或async限定、切断RETURNING关联、取消成功项保护等反例，保留全部旧围栏断言，不做函数级无条件豁免。不修改生产SQL、schema、接口或门禁规则文件；若反例不能稳定拒绝则不采用。该文件不在当前121路径联合写集，`harness:needs`确认无需终端红区grant，但仍须维护者明确范围及判断规则批准，拍板前不修改。对比方案B为重做生产清道夫算法，影响更大且当前无运行时缺陷证据，不推荐。五项既有todo保留（AC-013/017/020/025、ADV-010），不混入本轮更改。新增测试均在既有写集内；未提交、推送、PR、合并、重签、启用Gate或操作生产。

待授权期间的独立检查：首次`pnpm lint && pnpm typecheck && pnpm build`在lint阶段触及Node默认约4GiB堆上限，退出134，后两项没有执行，不能记通过。只读核对既有`.github/workflows/ci.yml:180`为`NODE_OPTIONS=--max-old-space-size=6144`，本地按同一环境配置重跑原命令，lint、src/test/scripts三套typecheck及Nest build全部通过、最终退出0；没有修改CI、package.json或门禁规则。counts和rbacmap检查同时通过（265权限/633接口/121迁移），diff空白检查通过。该结果不改变全仓单测仍有1失败及5todo的事实，也不代表已获准适配围栏检查器；该清单外测试文件保持未改。

维护者已明确批准“租约围栏检查适配方案A，扩展上述测试文件”，解除前述等待。联合精确写集由121扩为122，仅新增`src/modules/activities/activity-batch-lease-fence.spec.ts`；本地验证副本的逐路径同步清单随之精确增加该文件，不使用通配符。适配保留所有旧断言，不给sweepDead整个方法豁免：只有当前worker文件、该方法、item写点和固定完整SQL合同一致时，才产生带理由的专用例外标记，且仍明确fenced=false，不冒称持有者围栏。规范化仅折叠引号外空白；改变条件、参数、RETURNING关联、成功项保护、SET内容、上下文或追加裸写均失去标记。不是通用SQL安全分析器，也不修改生产SQL。

适配验证：`batch-lease-guard-adapted.json`31/31通过（0.492秒），含旧11项和新增20项正反例；新增反例覆盖删除/反转过期条件、删除尝试上限或换参数、删action/async/processing限制、换RETURNING来源、切断同次job关联、移除成功项与generate保护、OR绕过、修改写入内容/字符串/注释、附加裸写和其他上下文，均恢复未获豁免判定。随后`d4-current-all-unit-guard-adapted.json`全仓385/385组通过，8473项通过、0失败、5项既有todo（74.555秒），替代上段全仓1失败的当前状态；保留原失败报告供追溯。ESLint、src typecheck、diff及CODEMAP通过（2类旧WARN保留）。本轮仅测试适配与证据登记；没有重签3b/4b/7c、提交/推送/PR/合并、操作生产或启用Gate，整体Release未完成。

交付守护复核：当前`pnpm harness:selftest`完整三段检查退出0；结束后逐路径同步核验108个实际变更均在122路径授权联合写集内，未混入临时探针。`pnpm harness:replay`退出0，真触发14/14、结构断言12/12分别通过，失败0；INC-02/INC-12未覆盖及INC-13已接受项照实保留，不将结构断言当成执行保障。

待实际重签的核验依据：第121条migration SQL SHA-256为`c86dfd72b0d68a01669991694cf1544e85fdcd78a33c96548dc562ceb337187b`；权限265、Audit events169总计/164活跃；worker runbook SHA-256为`e53f7b4cedc8d6343e6e6fdd7d44a96b990be739c3fe944f3ea0f609e6ddc230`（7c短摘要`e53f7b4cedc8`）。用当前文件与HEAD逐段对比，runbook §2、§6逐字未变，新增大规模草稿恢复说明不重开既有健康检查风险接受，但内容摘要变化仍须维护者重签7c。尚未修改CUTOVER_SIGNOFF，不以计划记载代替签字。

提交边界复核：原D4 102路径与依赖29路径相交12个路径，分别为activities.module.ts、activities/CLAUDE.md、clock-authority.spec.ts、D4主链E2E、实施计划、miniapp/admin-web交接、NEXT_TASKS/FROZEN_DRAFTS/ROUTE_AUTHZ、CODEMAP及CUTOVER_SIGNOFF。不得简单按文件分组当成独立可交付PR；未commit/stash、推送或创建PR，依赖与D4的提交隔离还需按内容与独立验收核对。当前三项重签与依赖包PR授权尚未获得，不宣告Release完成。

依赖提交隔离的只读定位：`activities.module.ts`内草稿依赖仅新增SettlementDraftBatchService的import/provider，与D4的四个Service及Controller登记是不同hunk；`clock-authority.spec.ts`中后台退避时钟登记与D4两行审计时间说明也是不同hunk。后台E2E引用既有D1-3 fixture；草稿处理器/调度/生成器的当前import与类型检查未发现直接引用D4分类结算模型。由此可形成“先草稿依赖，后D4分类结算”的拆分候选，而不是改成混合PR或将整份重叠文件归给依赖。该结论仅定位候选边界，不证明候选独立构建、历史schema兼容或CI已通过；共享D4满额E2E应留后续D4验收，派生文档和签字必须按每个候选真源分别核算。未创建分支、暂存、提交或改写原工作树，三项重签及PR权限仍待确认。

2026-09-13维护者已明确批准D4三项重签：3b第121条、4b权限265/审计169总计164活跃、7c摘要e53f7b4cedc8及既有租约恢复代偿/盲区。已更新CUTOVER_SIGNOFF中这三项的当前理由、依据、日期和对拍，保留历史签字叙事；4b同步使用机器现读seed摘要03f30502685b，字典仍30/277。`pnpm cutover:check:signoff`从上述三项旧值导致的5处矛盾转为退出0，71/71正对照、16个读数非退化、10条签字完整且逐条一致；不把签字登记可信等同全量cutover通过。冻结稿台账检查及diff通过。runbook摘要未改变，其中签前“待重签”由签字登记本轮说明覆盖，不反复修改runbook造成签字自行过期。三项签字等待已解除；提交隔离、PR授权、CI、合并、生产及Gate边界仍未解除。

### 16.6 授权、签字及交付边界

本轮逐路径 `harness:needs` 静态预算：前28路径为1红区/27非红区，加 `CUTOVER_SIGNOFF.md`（非红区）后，29路径共 **1红区/28非红区**。这不读取令牌，不意味着29路径已经获得实施许可。

当前无需维护者执行命令。后续实施方案批准后，若确需刷新 ROUTE_AUTHZ，由维护者在实际实施 worktree 执行以下精确命令；AI 不执行 grant：

```bash
cd /Users/dengwang/Documents/coding/srvf-nest-api-r4-d4-implementation || exit 1
test "$(git branch --show-current)" = "codex/activity-os-r4-d4-implementation" || exit 1
pnpm harness:grant 'docs/ai-harness/ROUTE_AUTHZ.md' --reason '维护者确认 D4 大规模草稿补齐方案 A §16；仅刷新派生授权证据'
```

若后续选择独立 worktree，必须先给出已核验的新绝对路径和对应授权命令，不把当前 worktree 令牌视作跨目录有效。

**签字提前提示**：更新既有 worker runbook 会改变 `worker-runbook-sha256-12`，按 `CUTOVER_SIGNOFF.md` §7c 必须由维护者重新确认 **7c**；“仅文档”或本次方案批准都不等于该签字。本补齐不重开 AGENTS §3 基础设施冻结或既有“不另设健康探测”决策，不新增 cron/进程/Redis/外部队列/心跳表，不改既有盲区口径。D4自身尚欠的3b/4b也不因本节自动满足。

建议下一步确认语句：

> 确认大规模草稿补齐方案 A 的数据合同、29路径及验收清单；允许后续按该清单实施并使用 app_test_w98 隔离验证和测试夹具重建，不操作生产、不启用 Gate、不删除业务数据。提交、推送、创建 PR、7c重签及合并另行确认。

本节候选已覆盖产品边界，但并不预授权新的 PR 或解除 D 档分 PR 要求。实施前需明确依赖PR与现有未提交D4改动的隔离基线；推荐依赖补齐独立提交/PR，D4按依赖顺序集成，不把本地脏树当作已发布基线。不能安全拆分时报告准确相交路径，不擅自stash、丢弃或混档提交。

本次未做：没有实现后台处理器，没有修改任何代码、数据库或实际任务，没有重签7c或其他签字，没有提交/推送/PR/合并。§15缺口尚未修复，D4完整容量验收仍未通过。

### 16.7 首轮实施证据（进行中，不代表整包完成）

- 修改前：原草稿/调度/worker单测18项通过；真实w98旧草稿E2E37项通过，报告 `batch-draft-baseline.json`。
- 共用生成核心已抽取为调用方tx方法；同步上限500保留；后台支持绑定封印的2000人口/10000投影段/40000事件上限；段和结果按500行批量写入。修改后原37项E2E通过，报告 `batch-draft-core-regression.json`，未删除或放宽旧断言。
- 新异步任务写payload v2；处理器在Activity→job→run锁序内执行，生成结果、原审计与任务成功回执同事务；worker按精确action接入，使用既有进程和租约机制。旧v1 async拒绝、失租、Gate退避等9项新增单测与时间权威26项检查合计35项通过；该单测组不替代真实竞争验证。
- 满额夹具现已通过真实HTTP入队与worker生成2000人草稿。相邻事件原有同毫秒排序歧义已用1ms间隔消除；生成后按真实当前段的ID和revision构造allocation，不使用被superseded的预置行。真实w98已写入10000个allocation、50000个slice；随后D4 prepare失败，详见下项，不冒称完整链通过。
- `batch-d4-max.json` 终态：1失败、14未选择，总352.885秒。D4写入 `ActivitySettlementTimeCommandReceipt` 阶段，数据库语句持续执行；Prisma返回30秒事务已过期（实耗276259毫秒）。只读 `pg_stat_activity` 限定w98，确认长语句为该收据INSERT；并未据此断言某一条内部SQL已被完整性能定位。失败后w98的timeRevision/bucket/source/receipt四表计数均0，说明本次业务事务整体回滚；不是缺少有效来源导致的空跑。未增加超时、削弱数据库约束或删改断言。后台草稿补齐与D4收据校验性能是两个不同验收项，后者仍红。
- 新增 `activity-settlement-draft-batch.e2e-spec.ts` 七项真实w98验证通过（39.312秒）：501人口HTTP→worker成功、同key回放不增版本、无事件不自动判缺勤、入队后User/Member停用与成员解绑拒绝、封印凭据不符拒绝、旧v1异步拒绝、旧租约不回写。其中501成功/回放/未决项同属一个用例；不将断言数量当作独立用例数量。报告 `batch-worker-e2e.json`。
- 后续追加三项w98验证通过（`batch-worker-recovery.json`，17.312秒）：2001人口拒绝且无版本残留；租约耗尽后dead job与failed item同额，既有HTTP retry-failed后真实worker成功；既有HTTP cancel先完成后不领取、不生成，detail可见cancelled。
- 两个真实生产形状的worker application context分别装配并完成任务：NotificationOutboxWorkerModule、StorageConsistencyWorkerModule均从其ActivityBatchWorkerModule精确取实例，验证数据库守护后真实领取并生成（`batch-worker-contexts.json`，2项通过、12.871秒）。未启动长期run循环或生产进程，不替代两worker同时争抢及处理中崩溃测试。
- 收口复跑：新12项后台E2E与旧37项草稿E2E串行合跑，**49项通过**，71.723秒，报告 `batch-combined-regression.json`。全量typecheck及本轮变更代码定向ESLint通过；CODEMAP、ROUTE_AUTHZ已生成并校验，事实计数检查通过。119路径联合写集核验：实际变更102路径，清单外0。上述结果不包含D4满额失败用例，不冒称全量E2E/CI全绿。
- 性能定位补充：`d4-profile-max.json` 1失败、14未选择，354.667秒；收据函数1次调用285012ms，其中自身277892ms，桶hash6273ms、来源文档284ms。函数统计仅在app_test_w98临时启用，探针结束已恢复数据库原设置；该证据排除了“全部耗时都在JSON哈希”的猜测，但仍需内部执行计划确认。未改SQL合同或放宽30秒验收上限。
- 内部执行计划已定位（`d4-explain-max.json`，1失败/14未选择，359.343秒）：来源完整性检查38941.899ms，`pstbs_revision_idx` 每次取4行并过滤39996行、重复10000次；桶总额检查255445.320ms，`totals` 聚合实际循环8000次。该计划来自真实满额事务，不是空表EXPLAIN估算；记录仅保留函数/索引、次数和耗时，不输出业务原值。六项auto_explain数据库级临时设置均在探针结束恢复；原设置无覆盖项。下一步拟在原D4获批第121条未提交SQL内等价改为一次集合聚合复用，保留全部同链、数量、金额、理由、hash和不可变性断言；当前还没有实施该优化，不以定位代替修复验收。
- 新增临时错误重试/耗尽与错误脱敏两项单测，后台处理器11项与时间权威26项合计37项通过；新三项真实竞争/事务故障/锁等待资格探针已编写，另行登记运行结果。测试类型检查及两份新测试的定向ESLint通过。
- `batch-worker-races.json`：3项通过、12项未选择，29.28秒。两个独立Nest context的worker同时领取仅一方成功，版本/草稿审计各1；真实生成后注入提交前故障，版本与审计均回滚为0，后续重试均只生成1份；通过pg_blocking_pids确认worker确实等待Activity锁后停用User，释放锁后失败且无版本/审计。该3项不替代其余撤权/组织漂移/取消后赢锁矩阵。诊断配置恢复复核为`app_test_w98|track_functions=none|数据库级覆盖项=0`。
- 尚未完成：全部G1–G11矩阵、真实故障/并发/恢复的新增探针验收、运行文档/派生证据、完整检查、7c和D4原有重签。worker双context独立装配已由上述2项证明，但不等同双worker竞争证明。没有提交、推送、PR、合并、生产/Gate操作或删除业务数据。

### 16.8 D4 SQL等价优化与新发现的冷库前置缺口

**追加授权**：维护者已明确确认“扩展evidence-seal.service.ts，仅等价优化countUnprocessedEventEffects；保持5秒预算和既有行为，其余边界不变”。本段下方“尚未授权”是发现时点记录，由此覆盖；精确联合写集现为120路径，只增加这一个服务文件，不增加测试/配置/权限路径。同步器按120个精确路径核对，不使用通配符放行。

- 延续原D4第121条migration精确授权，未增加模型、索引、权限或接口，旧120条SQL逐文件与HEAD比较完全相同。来源计数改为一次MATERIALIZED聚合及非空ID集合判断；桶金额/理由聚合以EXCEPT比较，保留NULL等价、空桶零值、未知自动基线及JSON理由顺序语义。原正反例不删不放宽；追加有效摘要/合法零计数却缺整组来源的独立拒绝探针。
- 两轮修改后均在无连接的app_test_w98执行已授权重建，121条migrate deploy冷回放通过，仅重建可复现测试夹具。没有使用migrate reset/dev/db push，也没有业务数据清理。
- 仅MATERIALIZED的第一版仍失败：`d4-materialized-max-repeat.json`事务耗时74586ms。第二版集合对拍后，`d4-set-compare-max-repeat.json`的满额用例通过：真实HTTP入队→worker→2000人口草稿→10000有效段/50000切片→8000桶/40000来源→prepare/page/submit；prepare14507ms，总SQL340/41/811，均满足30000ms及400/120/950上限。这份报告中另一个新增反例因先命中既有整4数量约束而失败，随后调整测试夹具为缺整组来源，目标约束和预期拒绝不放宽；后续报告单独登记。
- 冷库缺口独立保留：`d4-materialized-max.json`与`d4-set-compare-full.json`分别在`EvidenceSealService.countUnprocessedEventEffects`超时（10673ms/11002ms，既有事务上限5000ms），发生在D4调用之前。后一报告其余14项D4行为/数据库正反例通过。同配置后续可进入D4并通过，不代表冷库前置问题已修复；本轮没有手动ANALYZE来隐藏它，也没有增加任何超时。
- 该封印方法位于当前119路径之外。建议精确扩展仅`src/modules/activities/evidence-seal.service.ts`：只优化`countUnprocessedEventEffects`的等价查询，保持活动锁、有效/失效事件语义、错误顺序、权限、5秒预算及其他方法不变；不改schema/migration/index/Gate。使用既有`activity-evidence-seal.e2e-spec.ts`与并发测试只读回归，加本计划已有D4满额冷库探针验收；不修改这些旧测试断言。此项尚未获授权、尚未实施。原提交/推送/PR/签字/生产边界均不扩大。
- 本轮最终定向复验：`d4-set-compare-final-full.json`完整15项通过，83.726秒；满额prepare16777ms、总SQL340/42/811。新增缺整组来源反例以合法零计数和重算摘要成功到达并命中`astcr_source_ready_guard`，不是依赖数量形状约束提前拦截。`d4-set-compare-upgrade-races.json`另8项通过，38.186秒，覆盖真实锁等待/规模计数及121条校验和冷回放、120→121非空旧D3完整链保留。两组共23项，不代表全量E2E或CI。定向ESLint、测试typecheck与diff空白检查通过，旧120条migration与HEAD逐字一致。
- `harness:needs`对建议新增的封印服务路径确认不属红区，不需要终端grant命令；但固定写集扩展仍须维护者明确确认，不能把“非红区”当成已授权。尚未提交、推送、创建PR、重签、合并、操作生产、启用Gate或删除业务数据。
- 追加授权后的实施：仅将封印方法内`NOT EXISTS(A OR B)`拆为两个`NOT EXISTS`取AND，将`EXISTS(A OR B)`拆为两个`EXISTS`取OR，保留可空引用、superseded筛选、八步顺序和5秒事务配置。修改前`seal-baseline.json`旧行为19项通过，并发用例在beforeAll初始化阶段30秒超时（尚未调用封印），不隐藏基线失败。
- 新封印方法使冷库成功进入D4，但`seal-optimized-cold-max.json`在收据阶段仍耗时65663ms；随后的只读执行计划采集确认`source_facts`与切片聚合的冷态关联产生799980000行过滤、耗时55269.455ms。临时auto_explain六项配置通过EXIT清理恢复，不改长期数据库配置。随后仅在获批第121条SQL中改为按allocation索引取该来源类别的区间和：前置每allocation恰好4来源保证切片访问总量有界，没有逐成员应用层SQL循环，未知/零/金额/理由等条件不变。
- `d4-indexed-slice-cold-max.json`：在重新创建w98、121条冷回放后**首跑通过**，1项通过/14未选择，57.468秒；真实满额prepare12177ms、总SQL340/41/811，完成正式提交。未手动ANALYZE或预热、未增加5秒/30秒预算。只重建可复现测试夹具，不删除业务数据。冷态结果不替代尚未完成的资源峰值、全部授权/恢复矩阵和最终CI。
- 新增4项真实输入漂移探针（evidence/population/workflow/active seal），修改真实当前事实而不篡改任务payload，核验失败计数及草稿/审计无残留；运行结果随后登记。
- `seal-batch-compatibility.json`六组85项全部通过，291.121秒：原封印19项、真实双实例封印并发1项、旧草稿37项、新后台19项及既有结算HTTP边界/任务读面9项。并发初始化的先前超时仍作为基线记录保留，没有修改其hook、超时或断言；本次相同代码下真实并发用例通过。新增4项真实输入漂移全部通过。定向6组单元测试另61项通过；全量typecheck、三份变更TS的ESLint与diff检查通过。未提交、推送、开PR、合并或重签。
- `seal-d4-final-regression.json`：最新封印等价查询及冷态SQL修复下，D4主链、并发/规模、迁移三组共23项全部通过，110.273秒；覆盖满额正式提交、数据库独立拒绝、真实锁等待及历史升级/当前链回放。与上述85项兼容回归分别计数，不代表全仓E2E或全部G1–G11完成。5秒封印预算、30秒prepare预算和原行为断言均未放宽。
- 补充收口：build通过；`seal-final-contract.json`在w98隔离配置下1060项、2份snapshot全部通过，13.345秒。CODEMAP、ROUTE_AUTHZ及counts检查通过，120路径核验实际变更103、清单外0。守护自检出现metadata正例失败；独立`check-boundaries.ts --metadata`确认唯一错误为domain-map的inputDigest过期，当前应为`sha256:a4943b89d73dacdfbf059bcfae385d80d1a6f78965f4e976558121cca79cdd94`；state-machines摘要与当前计算一致，不需修改。只读`harness:grant --list`显示当前无红区授权，因此尚未刷新domain-map，不修改任何守护规则或声明全绿；仅需维护者恢复该精确路径的摘要刷新授权。
- 上述授权判断更正：前次读取发生在守护自检运行期间；`scripts/harness-guards.selftest.ts`的F4三方比对会临时将授权文件移至`.parity-bak`，并在finally恢复。自检结束后复核原D4精确授权仍有效，时间戳未更新，不是维护者授权过期。无需重新授权；仅刷新已授权domain-map的inputDigest，metadata重新通过。前次自检最终544通过、4失败，均不得抹去；刷新后的整组复验另行登记。没有修改测试、门禁规则或授权工具。
- 刷新后`pnpm docs:boundaries:check && pnpm harness:selftest`完整退出0，先前4项metadata失败已消除；字面规则与hook自检分别138/68项通过，已知守护缺口仍按工具原样保留，不声称全部绕过面关闭。自检会在真实工作树临时建立探针文件，运行期间同步器拒绝将它们混入120路径；待进程结束再核对，实际103路径、清单外0，无需扩展写集。
- G6新增提交后响应丢失探针：真实`SettlementDraftBatchService.process`事务完成后才向调用方注入错误；另建worker Nest context，不再领取已成功任务，真实HTTP同键回放保持原job/item全字段、一个版本和一份审计。`batch-postcommit-response.json`1项通过、19未选择，19.815秒。只证明提交后的调用边界故障与新context恢复，不冒称操作系统强杀/真实网络断线测试。新测试ESLint通过，原断言未改。
- G6合同冲突，待维护者拍板：`batch-distinct-key-g6.json`在w98真实HTTP两次不同operationKey、相同内容生成后，两个任务成功且指向同一版本；版本数1断言通过，审计数按G6的1断言失败，实测2（1失败、20未选择，6.583秒）。HEAD原生成器已在contentHash复用分支后无条件记录每次生成审计，并非本轮新增；G1又要求保留旧行为。建议明确“一份审计”限于同一任务重放/故障恢复；不同operationKey视为两次独立操作，各保留审计，但复用同一内容版本。尚未批准，不修改生产代码、不删除审计、不放宽失败断言；该新失败探针保留为差异证据。若维护者选择不同请求号也只留一份审计，须另明确旧同步生成审计行为的变更范围，不能在当前等价补齐内默改。
