# Activity OS Release 4 / D4：Time Bucket 与结算工作台精确实施计划

> **状态（2026-09-12）**：与[评审稿](activity-os-r4-d4-time-bucket-settlement-workbench-review.md)同批起草的候选精确计划；尚未获得方案或 implementation 授权，不是可以直接执行的 Goal。本轮仅 7 个文档，允许验证后提交、推送、创建 Draft PR，不合并、不实施、不操作数据库、不启用 Gate。

## 1. 起点、目标与交付边界

起点为 main `921a6bf3fac66067e5232768d5c5d32bf92765fc`。D3 [#1323](https://github.com/BA7IEE/srvf-nest-api/pull/1323) 已合并，18 项 PR 检查及可信审批通过；[合并后 CI](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34677507039) 在该 SHA 上成功。基线为 161 模型／120 migration／625 端点／263 权限／168 审计总计、163 活跃。

目标：真人负责人可基于唯一参与事实和冻结政策，查看阻塞、认定区间、生成四类结算桶、显式提交冻结的分类版本；审核者按当前权限读取其来源。D4 不产生 Time Ledger、贡献分、证明、旧小时投影或自动切换。

实施必须先确认评审 §3 六项决策。下文是完整的推荐合同，不把混合政策、未知自动值或 draft 来源扩展藏在“实现细节”里。若不接受其中一项，应在这两份文档一起改定，不能实施时自行择优。

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

SQL 预算采用可测的增量上限：相同有效用户和 scope 夹具，D4 读页额外查询不超过 12，prepare 额外查询不超过 24，分类 submit 相对原 submit 额外查询不超过 12；所有授权查询也计入端到端实测总数并报告，不用“通用开销”隐藏 N+1。以 1 / 100 / 2000 identity 及上限数据对比，query 数不得随人数线性增长。D3 单源命令仍按既有授权链验证；不能靠加全局超时、缓存身份或删授权查询过预算。

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

## 8. 未来 implementation 精确写集（101 路径）

以下均为未来候选预算，不是本轮 docs-only 的写权限。新增路径只有本节明确命名的新文件；既有文件限前述职责，不授权全目录。开工重跑精确路径 needs；任一符号／生成闭包超出本表应合并成一份补充简报，不能顺手修改。

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

生成客户端 13 个路径中仅 App 的类型／调用可能有语义增量，其余仅对应生成器实际摘要或共享引用变化；无变化的文件不制造 diff。治理文件只登记已实现新类、权限、路由和 immutable kindCode 的 L1 inventory / not-derived 分类，不新增状态边、不放宽规则；既有 D3 recognitionModeCode 登记不改。CUTOVER_SIGNOFF 仅在维护者核准实际读数后重签，不能拿未来预算填成已验收。

明确排除：D3 旧 migration、SettlementDraftService 生产代码、旧 controller／DTO、Storage 实现、users/authz/organizations 生产代码、全局 Guard、Gate、main.ts、app.module.ts、package/lock/Jest/test setup、workflow、既有审核状态机、账本／贡献／证明／画像、任何业务数据删除与回填。

## 9. 授权与一次性命令包

### 9.1 当前已授权，且仅此范围

本次 7 路径：D3 review、D3 implementation plan、FROZEN_DRAFTS、NEXT_TASKS、本文、D4 review、`changelog.d/activity-os-r4-d3-closeout-d4-plan.md`。已逐路径运行 harness:needs：7 个均不在机器红区。允许文档验证后提交、推送、创建 docs-only Draft PR；不包含 Ready、合并、D4 implementation、数据库、生产或 Gate。

### 9.2 将来可一次确认的实施用语（尚未批准）

> 确认 D4 完整方案 A，包括封印草稿认定、同桶单一政策且混合版本阻塞、自动值可空及人工理由、8 个 Human App 路由、显式分类提交、持续留存和规模边界；按本计划 101 个精确路径实施，含已列旧测试兼容及派生文档。允许 app_test_w98 隔离验证及测试夹具重建；验证后提交、推送、创建 PR。不合并、不操作生产、不启用 Gate、不删除业务数据。

这段是供维护者将来选择的确认文本，不是当前授权。若基线已前进，须先重新对拍路径、计数及迁移名再确认；不自行把第 121 条改成别的序号。

### 9.3 维护者红区命令（实施批准后再执行）

本轮对未来 101 路径的只读 harness:needs 预算为 **13 个红区、88 个非红区**；“非红区”不表示业务已授权。下面逐个精确路径授权，不采用工具建议的宽泛 prisma/\*\*。

下面的实施目录／分支是未来约定，当前没有创建。实施获批后由助手创建并完成依赖／生成物／preflight，再向维护者回显实际路径和 HEAD；确认与下列一致后才运行。命令加目录及分支核验，不能在当前 docs-only 工作树照抄发令牌。

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

若按此候选完整实现：模型 161→165、migration 120→121、端点 625→633、权限 263→265、Audit 168/163→169/164。原 recognize 码扩展业务描述，不增加第三枚码；旧 API 数量和既有字段不减。以上仅预算，现阶段不得刷新 current-state、prisma 摘要或签字表成这些读数。

3b 必须以实际第 121 条 SQL hash 和迁移验证证据单独重签；4b 必须以实际 seed digest、265 权限、169/164 审计对拍后单独确认。若出现真实语义门 finding，先给出复现与具体申报建议；不自行宣称误报，也不更改比较器。

## 10. 连续推进顺序与暂停条件

实施批准后在同一 Goal 内连续完成 P0–P7、已列明兼容修复、派生更新与授权内 PR 流程，不把正常编译／测试失败、同一写集内补测或文档更新变成二次审批。先数据与认定证明，再桶／查询，再显式提交，串行集成；不同时开第二条 schema lane。

只有实质业务决策变化、越出 101 路径、旧行为断言差异、隔离库边界无法保证、基线合同冲突、签字／可信审批或 Ready／合并需新权限时暂停，并一次说清需要维护者做什么。当前阶段性跨模型复审按维护者要求延后，不能借此省掉自检、CI，也不记为已有独立复审结论。

## 11. 本次未做

本轮没有实施 §3–§10，未新增 schema/migration/API/DTO/权限／审计，未操作任何数据库、Gate 或业务数据；未部署、合并或开展跨模型复审。候选计划只是待确认的可评审材料，D4-D8 和后续 Release 未完成。旧紧急创建 500 根因仍未定位，D3 main CI 通过不等于该历史问题已经修复。
