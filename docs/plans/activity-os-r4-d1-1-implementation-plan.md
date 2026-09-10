# Activity OS D1-1 精确实施计划与授权清单

> **#1310 CI补验**：首轮CI的E2E分片2仅新foundation套件失败，30项均为42P01（TimePolicy不存在）；其他4个E2E分片及Fast checks/Harness/事故回放通过。CI日志显示起始曾应用118迁移，但本套件执行时worker缺表，具体前序破坏源未最终定位。仅在已授权的新foundation测试增加本套件migrate deploy准备前置，保留全部断言、不改SQL/生产代码/CI规则。本地仅w98从空库迁移再执行30项通过；此结果不代替更新后完整CI。

> **提交前本地验收**：lint/typecheck/build、356套7938项单测（5项既有todo）、w98新增32项/旧迁移105项/contract1036项及2快照均通过；签字、文档、OpenAPI、客户端和边界元数据检查通过。事故回放实际触发14/14、结构断言12/12通过。quick首次收尾的Harness与并行事故回放临时文件清理相撞而ENOENT；随后单独完整harness:selftest返回0，未修改检查规则。全量E2E仍由PR CI验收，整体跨模型复审仍未完成；不把局部结果写成全仓CI已通过。

> **2026-09-10 收尾授权已补齐**：维护者明确允许仅刷新 `docs/ai-harness/ROUTE_AUTHZ.md` 两处生成摘要，并确认重签3b（D1-1，第118条migration）。实际写集为原38路径加该生成文档，共39路径；612条路由与权限声明不变。已按真实SQL摘要更新签字登记。下方“待确认”是此前检查记录，不再表示缺少本项授权；验证后提交推送开PR的原授权继续有效，不授权合并、生产、Gate或业务数据删除。

> **2026-09-10 实施进行中**：维护者已批准按 #1309 的38路径完整实施、仅app_test_w98隔离验证及测试夹具重建、验证后提交推送开PR；不合并、不生产、不Gate、不删除业务数据。四项精确grant已核验。三模型、第118条SQL、纯解析/hash与生命周期及16份旧计数适配已实现；schema validate/generate、lint、typecheck、build通过。3套54项单测（含旧canonical）、clock 26项、w98新增SQL约束/双连接并发30项、冷回放/117→118非空升级2项、三套既有迁移兼容105项、contract 1036项/2快照均通过。全量单测复跑及Harness收尾尚未完成，不声明全绿。未调用migrate dev/reset/db push；仅重建已授权w98测试库并migrate deploy，未碰共享app_test。

> **收尾待确认项**：ROUTE_AUTHZ.md 未列入原38路径；只读试算发现新增纯函数也进入生成器的全src摘要，两处inputDigest需刷新，612路由及全部声明无差异，authz-assertion-patterns.json亦无差异。当前未修改该文件，等待只扩这一份生成文档的授权。3b尚未重签：第118条SQL SHA-256为 `39442e60fdbb47f8f6e4ae28baf746d81a860920c4f51ed1d02ef0d5d0491f4e`；117条历史SQL无改动。尚未提交、推送或创建实施PR。

> **后续验证**：全量单测复跑356套全部通过，7938项通过、5项既有todo。初轮Harness的3项失败中，状态机§10.4统计已按68条同步；另外2项均指向上述ROUTE_AUTHZ摘要过期，待获准刷新后重跑，不修改检查规则。

> **2026-09-10 计划确认**：维护者已确认本精确计划，允许补充 changelog、提交、推送并创建计划 PR；不合并、不实施。字段、38路径及验证预算获计划确认，不等于实施或数据库授权。下方“待批准/不提交”保留为起草时记录。本次文档提交仅包含本计划、D1评审稿及 `changelog.d/activity-os-r4-d1-1-plan.md`。

> 2026-09-10，基点 main `d8bf3ee6`。[#1308](https://github.com/BA7IEE/srvf-nest-api/pull/1308) 已合并，D1 方案 A 方向已确认。本轮仅授权起草本计划；下述字段、SQL约束、38路径与命令是待批准实施方案，不是执行许可。当前不提交、不推送、不创建计划PR、不实施、不操作数据库。

## 1. 本刀交付与不交付

建议方案 A：新增 TimePolicy、TimePolicyVersion、TimePolicyCommandReceipt 三模型及第118条 expand migration；新增强类型政策解析/hash封装、纯生命周期判断和数据库约束测试。三表作为同一个政策目录地基，不拆出缺少保留/重放约束的临时存储。

D1-1完成只代表数据地基通过。目录HTTP与当前Human权限/审计原子命令在D1-2；模板V4、提案V8、四层选择、Readiness与发布冻结在D1-3。本刀不接Controller/Module/provider，不给生产增加可调用写入口，不计算任何人的时长。

不做会怎样：后续目录命令缺少不可变版本和可核验引用锚。最坏情况是新SQL影响旧数据或触发器允许非法变更；迁移须BEGIN/COMMIT原子执行，失败全部回滚，成功后的回退仅停用后续新入口，不删表、不删历史数据。本刀新增表空表起步，不回填旧活动。

方案 B 为只建政策/版本、收据后补：本次更少，但会把完整目录持久化合同延后。推荐 A；不声称本次实现了HTTP幂等或业务权限。

## 2. 现场依据与影响链

- schema当前151模型、117迁移；`ActivityMetricDefinition`（schema:1715）和`ActivityMetricCommandReceipt`（2065）提供目录/收据既有形状，但不可把指标命令或事件用来处理时长政策。
- `activity-template-definition.ts:145–176` 已提供closed JSON canonical和SHA-256。仅调用导出函数，不移动或修改旧hash工具。
- `activity-template-definition-v1.ts:23,317` 的attendanceRoleCode为1–64字符。政策以attendanceRoleCode作映射键，不按岗位显示名，也不按跨场次不唯一的position code。
- `scripts/check-boundaries.ts:396` 输入含schema，故domain-map与state-machines摘要必须联动。新增生命周期登记inventory，不伪报governed。
- `scripts/generate-fe-client.ts:441` 的摘要仅覆盖generatorVersion/surfaces/contract；本刀不改OpenAPI，13个client不应变化。
- 16份全量回放断言已按常量与裸字面量交叉扫描，精确清单为§7第9–24项。C3-1通过临时目录固定115→116、C3-2固定116→117、C2 D2固定113→114，不能把历史终点改成118。
- 新政策表不引用Activity/Metric/Outcome/Member，只有收据actor引用User，故旧业务清理无需一律加新表；新增测试自己清理自己的fixture，旧测试若有实际新依赖再报告，不能为假想失败改所有清理SQL。

本轮不改现有业务行为、端点612、权限258、Audit events165总计/160活跃；不重签4b。实施验证后才请求3b第118条重签，不预签。

## 3. 精确数据合同（待批准）

所有id为String/cuid，createdAt为DateTime @default(now())审计时间；业务生效/状态时间由命令传入UTC，不用默认now猜生效日。所有FK使用Restrict/Restrict，无级联删除。

### 3.1 TimePolicy

字段：id、code String、name String、createdAt、updatedAt @updatedAt；关系versions和commandReceipts。code唯一且不可改，ASCII `^[a-z][a-z0-9_]{0,63}$`；name 1–120字符，trim后必须等于原值。名称可改但不参与语义hash；D1-2未提供改名命令前没有运行时改名入口。禁止DELETE，禁止修改id/createdAt/code。不加软删、状态、人员备注或业务数据清理字段。

### 3.2 TimePolicyVersion

字段：id、policyId、version Int、schemaVersion Int、definitionJson Json、definitionHash String、evaluatorVersion Int、effectiveFrom DateTime、effectiveUntil DateTime?、statusCode String、activatedAt DateTime?、retiredAt DateTime?、createdAt、updatedAt @updatedAt。
关系policy及commandReceipts；唯一(policyId,version)，复合唯一(id,policyId,definitionHash)，索引(policyId,statusCode)。

version范围1–2147483647；schemaVersion=1、evaluatorVersion=1；hash为64位小写十六进制；生效区间UTC左闭右开，until为空或严格大于from。允许不同版本生效区间重叠，因为消费者必须显式固定版本；不实现“按时间找最新”。

INSERT只能draft，activatedAt/retiredAt为空。UPDATE仅允许：
- draft→active：activatedAt非空，retiredAt为空；
- active→retired：保留activatedAt，retiredAt非空且不早于activatedAt；
- 无业务改变的updatedAt更新可保留；状态/时间的其他变化拒绝。

不可更改id/policyId/version/schemaVersion/definitionJson/hash/evaluatorVersion/effectiveFrom/effectiveUntil/createdAt。draft内容也不可改，修订新增版本；禁止DELETE、复活或原地修改生效期。不得要求activatedAt早于effectiveFrom（允许明确选择尚覆盖活动区间的已开始版本）。

### 3.3 TimePolicyCommandReceipt

字段：id、actorUserId、operationCode、operationKey、requestHash、policyId、versionId String?、definitionHash String?、resultJson Json、createdAt。User只追加反向关系timePolicyCommandReceipts，不改其身份/权限字段与行为。
唯一(actorUserId,operationCode,operationKey)；policy FK；(versionId,policyId,definitionHash)复合FK指向版本复合唯一；actor FK。索引policyId及versionId。

operationCode闭集create_policy/create_version/activate_version/retire_version。operationKey为1–128字符且非空白、无控制字符；requestHash为小写SHA-256。create_policy必须versionId/hash同时为空，其他必须同时非空。全部行不可UPDATE/DELETE。

resultJson闭合键：schemaVersion=1、operationCode、policyId、versionId、definitionHash、resultStatusCode、createdAt；版本相关字段在create_policy时为null，其余与外层精确一致。resultStatusCode分别null/draft/active/retired。createdAt是ISO UTC毫秒文本，表示这次命令的结果时间，不作为生命周期比较基准。禁止返回actor/operationKey、任意definition、附件或业务人员数据。

本刀用SQL测试证明唯一性、引用同链、不可变和JSON形状；不把“收据存在”冒充权限或审计。同key同payload重放/不同payload冲突和重放时当前身份复判由D1-2真实命令验收，本刀不新增可绕权限的通用repository。

### 3.4 数据库职责与命名

migration路径固定候选 `prisma/migrations/20260910100000_activity_os_r4_d1_time_policy_foundation/migration.sql`，实施前核验仍为第118条；若main已前进则重核，不占用错误编号。

约束命名采用短前缀tp_/tpv_/tpr_，全部ASCII且<=63字节。需具名：
- tp_code_key、tp_code_check、tp_name_check、tp_identity_guard；
- tpv_policy_fk、tpv_policy_version_key、tpv_id_policy_hash_key、tpv_policy_status_idx、tpv_version_check、tpv_hash_check、tpv_interval_check、tpv_status_check、tpv_definition_shape_check、tpv_immutable_guard；
- tpr_actor_fk、tpr_policy_fk、tpr_version_anchor_fk、tpr_command_key、tpr_policy_idx、tpr_version_idx、tpr_shape_check、tpr_result_check、tpr_immutable_guard。

guard为触发器名，对应函数名加_fn。identity/immutable守卫拒绝DELETE并核UPDATE旧新值；SQL错误使用23514、FK23503、唯一23505，无新API BizCode。Prisma关系map与SQL真实名称逐项对拍，避免重复隐式FK。

DB强制标量范围、生命周期、同链、JSON根对象/固定顶层键和基本类型；完整嵌套语法与canonical/hash由纯解析器处理。明确不声称数据库能复算JS canonical/hash或验证来源事实。D1-2唯一写入口必须先解析与计算hash再入库，D1-3读历史时验证hash；直接SQL篡改hash与定义同时匹配不属于本刀能证明的真实性。

## 4. Definition v1 闭合语法

默认类别与映射类别闭集C=volunteer_service/training/organization/non_creditable。普通新政策拒绝legacy_unclassified，它只属于将来的历史治理。

根键恰为defaultCategory、roleMappings、allowSplit、specialIntervals、rounding、evidence、manualAdjustment。全部必填、禁止未知键/undefined/稀疏数组/NaN/浮点整数/循环引用/非普通JSON对象，UTF-8 canonical定义预算<=32768字节。

- defaultCategory∈C，allowSplit为boolean。
- roleMappings数组0–64项，每项仅attendanceRoleCode（1–64字符，trim恒等，无控制字符）、category∈C。键不得重复，顺序无业务语义；hash前按attendanceRoleCode的JS字典序排序，不用localeCompare。这是固定角色语义映射，不能猜成岗位显示名。D1纯解析不查词表，未知业务role由D1-3发布解析拒绝。
- specialIntervals仅preparation/duty/travel三个必填键。每值为判别联合：{mode:"exclude"}；{mode:"category",category:C}；{mode:"manual"}。exclude仍保留事实。manual必须manualAdjustment.enabled=true；category需要真实区间及证据，不按计划时间生成秒数。
- rounding仅{mode:"floor",quantumSeconds:整数1–3600}。量子1代表不截断整数秒；不足量子得0。仅在同一参与身份/类别汇总真实互斥区间后一次floor；D1只存规则，不实现实际分配或ledger。
- evidence仅{requiredSources:数组,requireManualRecognition:boolean}；来源闭集punch_event/service_segment/attachment，数组0–3项、无重复，按固定枚举顺序canonical。requiredSources表示全部要求而非任选其一；空数组只代表无额外来源要求，永远不免除真实参与区间。requireManualRecognition=true要求manualAdjustment.enabled=true。
- manualAdjustment判别联合：{enabled:false}或{enabled:true,reasonRequired:true,evidenceRequired:boolean}。不存具体人员理由。enabled=true不授予认定权限、不放宽实际区间/总量/互斥约束。
- allowSplit=false时一个真实参与段只能一个类别；若角色/特殊区间判定产生多个类别，未来D3必须拒绝自动分配并提示人工处理，不择一忽略。manual也不能绕过allowSplit或修改实际区间。

hash输入使用既有computeActivityTemplateDefinitionHash({schemaVersion:1,definition:envelope})；envelope固定{definition:规范化定义,evaluatorVersion:1,effectiveFrom:UTC毫秒文本,effectiveUntil:UTC毫秒文本或null}。外层schemaVersion绑定语法；policyId/version/name/status/审计时间不参与hash，同语义可共享hash。生效时间输入只收严格ISO UTC毫秒格式并校验日期回环，不接受本地时区/自动纠错日期。不得改变既有hash函数或旧模板hash。

纯函数导出parseTimePolicyDefinition、fingerprintTimePolicyVersion、parseTimePolicyVersionReference、canTransitionTimePolicyVersion；引用仅{policyId,versionId,definitionHash}，id长度1–64。解析失败为本模块纯错误，不产生新HTTP语义。固定schema/evaluator矩阵仅(1,1)，未知版本fail-closed；不注册未实现解释器。evaluatorVersion在本刀仅为未来解释算法合同锚，未实现成员秒数计算。

示例（空映射不是缺省值，显式表示无角色覆盖）：
```json
{"defaultCategory":"volunteer_service","roleMappings":[],"allowSplit":false,"specialIntervals":{"preparation":{"mode":"exclude"},"duty":{"mode":"category","category":"organization"},"travel":{"mode":"exclude"}},"rounding":{"mode":"floor","quantumSeconds":1},"evidence":{"requiredSources":["service_segment"],"requireManualRecognition":false},"manualAdjustment":{"enabled":false}}
```

## 5. 留存、隐私与访问

三张表及收据永久保留，不设TTL、清理函数或CLI。User退队/禁用撤销未来访问，不删除收据；actorUserId用途仅为幂等归属与审计追溯，不给普通App DTO暴露，未来查看沿受控目录/审计权限。name不是个人资料，自由备注/身份证/附件内容不入表。本刀没有HTTP，所以不存在已落地的管理权限；不得用测试数据库可写来声称管理员功能完成。

## 6. 验证与迁移纪律

实施批准后仅建议使用app_test_w98：允许建立/重建隔离测试库及该库测试夹具；不碰共享app_test、其他worker、生产或真实业务数据。不得自动执行prisma migrate dev/reset/db push。复用现有测试库派生与连接校验；运行前必须打印脱敏库名并确认恰为app_test_w98，非此库立即退出，不打印URL/密码。

新增E2E应串行运行且仅一个worker；沿现有可验证方式设置worker=98，不假设shell变量会覆盖Jest自行分配。实施时先读测试纪律并核对实际runner；若命令不能证明目标w98则不运行，不扩大授权。临时迁移目录用mkdtemp，不删仓库文件；重建仅限已授权测试夹具。

探针队列（未满足才实现，不把清单当测试结果）：
1. 单元：所有类别/联合分支、空及64项映射、65拒绝、重复/未知键/坏日期/错误hash格式/32KiB边界；排列归一hash一致、生效/evaluator改变hash变化，旧canonical单测仍通过。
2. 生命周期：draft→active→retired合法；跳跃/复活/改语义/改审计锚/DELETE拒绝，SQL与纯状态机一致；updatedAt无业务更新正向对照。
3. DB同链：合法receipt成功；错policy/version/hash三种交叉组合各自23503；operation/result不一致、JSON错误、空白key各自拒绝；SQL异常整笔事务回滚。
4. 并发：两个独立连接同(policyId,version)和同receipt key竞争仅一条；不同政策同版本合法。只验DB唯一性，不把它当D1-2服务重放。
5. 升级：空库118冷回放；带合法旧Activity/Metric/Outcome/结算事实的117→118升级前后完整投影相等；旧117条SQL checksum逐条不变；第二次deploy无变更。新表数量以实际三张验，不用空库证明存量保留。
6. 历史：16处全量计数仅117→118；C2/C3固定历史升级及其断言不改；定向执行受影响迁移spec，失败先判真实依赖，不批量清库。
7. 无业务接线：OpenAPI/snapshot/client无diff，端点/权限/审计不变；TIME_POLICY_UNREPRESENTABLE仍按原逻辑，旧快照hash不变。
8. quick、build、contract及定向E2E、docs所有相关闸、metadata和signoff检查分别留命令/退出码。全量E2E留PR CI；PR与main CI分开。实际SQL经审查后才请求3b签字，不改判据或放宽旧断言。

## 7. Implementation 精确写集（38路径，待批准）

只允许下面路径，清单不是当前写许可。第9–24项仅当前回放计数/对应标题，保留所有历史升级、断言结构与业务前置。第25项仅登记新增三表createdAt审计字段，不放宽时钟断言。metadata仅新增政策条目/摘要，不改裁判；current-state仅派生计数；CUTOVER_SIGNOFF仅实际验证并获重签后更新3b。

1. `prisma/schema.prisma`
2. `prisma/migrations/20260910100000_activity_os_r4_d1_time_policy_foundation/migration.sql`
3. `src/modules/activities/activity-time-policy-definition.ts`
4. `src/modules/activities/activity-time-policy-definition.spec.ts`
5. `src/modules/activities/activity-time-policy-state-machine.ts`
6. `src/modules/activities/activity-time-policy-state-machine.spec.ts`
7. `test/e2e/activity-os-r4-d1-1-time-policy-foundation.e2e-spec.ts`
8. `test/e2e/activity-os-r4-d1-1-time-policy-migration.e2e-spec.ts`
9. `test/e2e/activity-os-r2-b2-coordinate-projection-schema-constraints.e2e-spec.ts`
10. `test/e2e/activity-v11-batch4-allocation-candidate-position-anchor-migration.e2e-spec.ts`
11. `test/e2e/activity-v11-batch4-allocation-determinism-migration.e2e-spec.ts`
12. `test/e2e/activity-os-r1-a4-explicit-template-version-pointer.e2e-spec.ts`
13. `test/e2e/activity-v11-batch4-allocation-command-replay-migration.e2e-spec.ts`
14. `test/e2e/activity-v11-batch4-allocation-mode-migration.e2e-spec.ts`
15. `test/e2e/activity-os-r3-c1-d2a-metric-command-receipt-migration.e2e-spec.ts`
16. `test/e2e/insurance-evidence-registration-revision-migration.e2e-spec.ts`
17. `test/e2e/activity-v11-batch4-qualification-contract-migration.e2e-spec.ts`
18. `test/e2e/activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts`
19. `test/e2e/activity-os-r2-b3-form-blueprint-governance.e2e-spec.ts`
20. `test/e2e/activity-os-r3-c2-outcome-value-revision.e2e-spec.ts`
21. `test/e2e/activity-os-r1-a3-template-definition-lifecycle-guards.e2e-spec.ts`
22. `test/e2e/activity-os-r2-b1-place-schema-constraints.e2e-spec.ts`
23. `test/e2e/activity-os-r3-c1-metric-definition-set.e2e-spec.ts`
24. `test/e2e/activity-os-r2-b6-creation-data-foundation.e2e-spec.ts`
25. `src/common/datetime/clock-authority.spec.ts`
26. `harness/domain-map.json`
27. `harness/state-machines.json`
28. `docs/ai-harness/STATE_MACHINE_INVENTORY.md`
29. `prisma/CLAUDE.md`
30. `src/modules/activities/CLAUDE.md`
31. `docs/current-state.md`
32. `CODEMAP.md`
33. `docs/ai-harness/FROZEN_DRAFTS.md`
34. `docs/ai-harness/NEXT_TASKS.md`
35. `docs/ai-harness/CUTOVER_SIGNOFF.md`
36. `docs/plans/activity-os-r4-d1-1-implementation-plan.md`
37. `docs/plans/activity-os-r4-d1-time-policy-review.md`
38. `changelog.d/activity-os-r4-d1-1-implementation.md`

本批不改seed、permission、audit、BizCode、auth、Storage、app/module、控制器、OpenAPI、clients、CI/scripts裁判或archive。若某个未列后果确实需要修改，集中汇报差异，不顺手扩写。

## 8. 集中授权命令（现在不要执行）

本轮实际只写本计划及D1评审稿的合并/下一阶段状态。下一步建议先确认此计划并允许补changelog、提交推送、创建计划PR；计划PR合并后再确认完整实施包及隔离库范围。不能把批准“方向”解释成批准本稿全部数值与合同。

38路径已逐文件运行harness:needs，4个文件需红区授权。工具给出的宽glob不采用；届时维护者在以下仓库目录逐条执行精确路径（AI不得代发）：

```bash
cd /Users/dengwang/Documents/coding/srvf-nest-api
pnpm harness:grant 'prisma/schema.prisma' --reason 'D1-1 精确计划批准后实施；仅政策三模型'
pnpm harness:grant 'prisma/migrations/20260910100000_activity_os_r4_d1_time_policy_foundation/migration.sql' --reason 'D1-1 第118条 expand migration，须核验main序号'
pnpm harness:grant 'harness/domain-map.json' --reason 'D1-1 schema派生摘要，不修改规则'
pnpm harness:grant 'harness/state-machines.json' --reason 'D1-1 政策生命周期inventory登记及摘要，不修改规则'
```

本组只解决红区写许可，不授权数据库、合并或生产。实施授权建议一次包含：本稿完整方案A/38路径/16份旧计数适配/仅app_test_w98验证与测试夹具重建/验证后提交推送开PR；不合并、不生产、不Gate、不删除业务数据。3b必须等实际SQL审查后另确认，不能预填hash。

## 9. 合并证据及本次未做

#1308于2026-09-10T09:28:15Z合入main d8bf3ee618e3470699e1220fa0e52e1eb0fd0acd；PR检查9通过4规则跳过，无失败。与批准head0195e495树一致（577b1fe285be655293af23a1061244ee8a7088d2）；patch-equivalence无差异；远端旧分支已不存在、本地主工作树干净后新建计划分支。[main CI 34460810984](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34460810984) 已独立核验 completed/success，不以PR绿代替。

本次未做：三模型/SQL/解析器/测试实施，数据库与业务数据操作，提交推送/创建计划PR，生产/Gate，整体跨模型复审。第118条和所有探针仍是计划，不是已验证实现。
