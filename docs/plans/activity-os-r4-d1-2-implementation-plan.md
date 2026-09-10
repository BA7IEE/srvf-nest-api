# Activity OS D1-2 精确实施计划与授权清单

> **计划已确认，允许发出计划PR**：维护者已明确确认本精确计划，允许补充changelog、提交、推送并创建计划PR，包含本轮七份文档；不合并、不实施。本轮实际写集为七份文档加 `changelog.d/activity-os-r4-d1-2-plan.md`，共八路径。下方“仅起草/待确认/无changelog”及未提交记录保留为起草时点；58路径的实施、数据库验证与未来grant仍未授权，不能执行。

> 2026-09-10，基点 main `04699ace81ff6bfcb3dda9fc7e70e141b15735e7`。维护者仅授权D1-1台账更正和本计划起草。以下是待确认方案，不是实施、数据库、提交或合并许可。

## 1. 当前事实与交付边界

[D1-1 #1310](https://github.com/BA7IEE/srvf-nest-api/pull/1310) 已合并，18项PR检查通过，[main CI34474531083](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34474531083)在上述SHA通过。154模型、118迁移、612端点、119 Controller、258权限码、165审计事件总计/160活跃。D1-1仅数据地基及纯规则，没有可用目录HTTP；[D1方向稿](activity-os-r4-d1-time-policy-review.md)仍未整体完成。

推荐方案A：本刀完整交付Human管理目录的创建政策、创建不可变版本、激活、退役、分页及详情，连同当前权限、幂等、审计、真实HTTP验证和客户端。方案B只做查询会留下无法治理版本的目录，故不推荐。

不接模板V4、提案V8、四层政策选择、Readiness、发布冻结；这些归D1-3。不做D2–D8参与归一、秒数计算、shadow或入账；不改旧V2–V7。无schema/migration，无生产回填，无业务数据删除，无新Gate或既有Gate启用。不提供改名、编辑版本、恢复退役或DELETE入口。

## 2. 已核验复用链与风险

- `activity-time-policy-definition.ts` 的parse/fingerprint及既有canonical/hash为唯一语义输入工具；不复制排序、hash或JSON语法。
- `activity-time-policy-state-machine.ts` 的draft→active→retired为唯一生命周期，不修改其规则。
- `ActivityMetricCommand`提供事务收据编排参考，但不能照抄其授权：`RbacService.can()`有SUPER_ADMIN短路。
- `RbacService.getUserPermissionCodes(userId, undefined, tx)`只读当前有效GLOBAL RoleBinding，无SA特判；`ActivityMetricRuleBindingService`已有can加显式码的组合。本刀所有读写均使用该组合，保留可观测的rbac-can断言，不改RBAC核心、断言识别器或全局Guard。
- `loadActiveUserIdentityInTx`由Users属主导出，锁后重读User有效身份，不信任JWT中的旧role/status。此处是Admin目录，不引入App必须绑定Member的准入规则；账户停用/软删或GLOBAL绑定失效必须拒绝，不暗改Users属主合同。
- `permission-catalog.ts`→`prisma/seed.ts`→权限地图/角色持有人测试；`audit-logs.types.ts`→审计登记表；Controller/DTO→contract→OpenAPI→13个客户端文件。
- `activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts`有当前seed权限258断言，提前列入仅258→260适配；118迁移不变，不改历史升级目标和业务断言。

主要风险：误借SA捷径、锁等待后沿用旧资格、同key并发重复审计、历史重放被当前状态污染、生成客户端误动其他surface。分别以真实拒绝/并发测试、闭合响应、逐行生成diff验收。异常回退为回退新增应用入口的提交，不删D1-1三表、不撤历史记录、不改业务数据。

## 3. 八条Human API合同

统一前缀 `/api/admin/v1/activity-time-policies`，一个Controller。所有路由默认Human，Service/Delegated拒绝；不新增Integration入口或机器eligibility。

| 方法与相对路径 | 权限 | 输入/输出 |
|---|---|---|
| GET / | activity-time-policy.read.catalog | page/pageSize、可选精确code；政策分页 |
| GET /:id | 同上 | 政策详情，不内嵌无界版本数组 |
| GET /:id/versions | 同上 | page/pageSize、可选statusCode；该政策版本摘要分页 |
| GET /:id/versions/:versionId | 同上 | 同链版本详情，含完整强类型definition |
| POST / | activity-time-policy.manage.version | operationKey、code、name；201原始命令收据 |
| POST /:id/versions | 同上 | operationKey、schemaVersion=1、evaluatorVersion=1、definition、effectiveFrom/effectiveUntil；201收据 |
| POST /:id/versions/:versionId/activate | 同上 | operationKey、expectedDefinitionHash、expectedStatusCode=draft；200收据 |
| POST /:id/versions/:versionId/retire | 同上 | operationKey、expectedDefinitionHash、expectedStatusCode=active；200收据 |

单id复用IdParamDto；双id使用本刀显式嵌套路径DTO，不裸取Param字符串。普通分页复用仓内约定，page正整数、pageSize默认20/最大100；稳定排序政策createdAt desc/id desc，版本version desc/id desc；读到不存在政策或跨政策versionId统一专用404，先授权再查目标。

政策DTO仅id/code/name/createdAt/updatedAt。版本摘要仅id/policyId/version/schemaVersion/evaluatorVersion/definitionHash/effectiveFrom/effectiveUntil/statusCode/activatedAt/retiredAt/createdAt/updatedAt；详情额外definition。时间输出ISO UTC毫秒。列表不返definition，不做逐条附加查询或无界include。

输入DTO均显式class，不用Mapped Types；定义嵌套结构按D1-1闭合grammar建立DTO及Swagger，class实例转普通对象后送既有解析器。code/name/key/32KiB定义/64映射/时间区间等预算不放宽。语法错误400；客户端不传版本号、hash、生命周期时间或actor。createdAt与activatedAt/retiredAt由事务内命令时间确定，不覆盖请求生效区间。

收据响应精确沿D1-1七键：schemaVersion、operationCode、policyId、versionId、definitionHash、resultStatusCode、createdAt；create_policy后三项中的versionId/hash/status为null。不得加入actor、key、requestHash、政策定义或任意数据库字段。全局包装器保持不变。

## 4. 权限与留存决策（随方案确认，不默认为已授权）

新增两码均CUSTOM_ROLE_ALLOWED，GLOBAL实际绑定，servicePrincipalAllowed=false、delegatedAccessAllowed=false。不自动分配内建角色；维护者通过既有角色管理显式授权。持有人测试仅增加两条具名人工授码例外及精确预期列表，不做前缀豁免。manage不隐含read，读写分别判码；SUPER_ADMIN无显式码同样403。

每次先读当前有效User，调用rbac.can并确认getUserPermissionCodes包含目标码，均使用同一个tx；获取幂等锁、政策锁、版本锁后再次按当下时间查资格。撤权、绑定过期/软删、角色软删、账户停用后的重放也拒绝。不存在缓存或跨请求权限快照；不声称持有业务锁能阻止其他事务撤权，保证的是每个等待点后的当前资格重验。

数据用途是永久保存规则及治理历史；普通目录DTO不展示操作者身份，操作者仅沿既有审计权限查看。D1-1收据actor引用及政策/版本/收据永久保留；退队不删除历史资产。本刀无新个人敏感字段，不保存人工认定理由、附件或人员事实。

## 5. 原子命令、并发与重放

独立TimePolicyCommand负责资格、输入/hash、幂等锁、收据验证；Service负责锁内业务编排；QueryService只读；Presenter/纯状态机不查库；AuditRecorder只写本域事件。Module仅注册本刀Controller/providers，不改app.module.ts。

顺序固定：事务内授权→事务级advisory锁（专用namespace、actorId、operationCode、operationKey）→重验资格→读取同actor/op/key收据。重放验证requestHash及七键形状/外层同链锚，返回原resultJson；不会因版本后来退役改写原成功响应，也不再写审计。重放不重新执行首次状态前置，但仍检查当前访问资格及不可变引用一致性。非法存量收据fail-close，不自动修复。

无收据：create_policy唯一code插入；其余先TimePolicy行FOR UPDATE→重验资格→查政策。create_version在政策锁内分配max(version)+1（单政策有索引的最大值读取），禁止超过Int上限；纯解析/fingerprint结果持久化，始终draft。激活/退役再锁同链TimePolicyVersion→重验资格→验证expectedHash/status及存储定义hash→调用既有状态机。状态写、单条审计、不可变收据同tx提交；任一步失败全部回滚。

不同政策无全局串行锁；不同key但同政策版本竞争被政策行锁串行化。同key不同payload冲突，hash包含操作、路径policy/version目标及所有业务输入，不含key/审计时间；canonical复用既有工具。唯一冲突只翻译确切policy code重复，不能把全部P2002当业务重复。锁超时、数据库不可用沿既有基础设施错误处理，不自动重试、不返回原始SQL/连接信息。

建议预算为ReadCommitted、maxWait=2000ms、timeout=5000ms，等待超时即整单失败；这是待实测预算，不是性能结论。事务内不做HTTP/对象存储/文件IO。每次授权最多3次查询（当前User、can、显式码），写命令最多4个授权点；含锁、目标、写/审计/收据的应用SQL目标上限30次，不含BEGIN/COMMIT。读分页目标上限5次，详情4次。必须记录真实计数与锁等待，不能为满足预算省授权；若实际超限，先解释属主内部查询，不擅自放宽预算。

## 6. 错误、审计与预期计数

新增专用BizCode，候选号20197–20204（实施前再查重，不重编号旧码）：
- ACTIVITY_TIME_POLICY_INVALID / 20197 / 400：输入或定义无效。
- ACTIVITY_TIME_POLICY_NOT_FOUND / 20198 / 404：政策或同链版本不存在。
- ACTIVITY_TIME_POLICY_CODE_EXISTS / 20199 / 409：code已存在。
- ACTIVITY_TIME_POLICY_STALE / 20200 / 409：expectedHash或expectedStatus不符。
- ACTIVITY_TIME_POLICY_STATUS_INVALID / 20201 / 409：非法生命周期动作。
- ACTIVITY_TIME_POLICY_COMMAND_CONFLICT / 20202 / 409：同key不同请求。
- ACTIVITY_TIME_POLICY_RECEIPT_INVALID / 20203 / 409：存储收据/不可变锚不一致。
- ACTIVITY_TIME_POLICY_VERSION_LIMIT / 20204 / 409：版本号耗尽。

未认证/当前User失效沿UNAUTHORIZED，无显式权限沿RBAC_FORBIDDEN，机器主体沿既有PRINCIPAL_KIND_FORBIDDEN。普通DTO校验沿BAD_REQUEST，不复用指标错误伪装政策错误。

新增一个事件 `activity.time-policy.command`，resourceType=`activity-time-policy`、resourceId=policyId；extra仅operationCode、versionId、beforeHash/afterHash、beforeStatus/afterStatus。操作者与请求元数据由既有AuditLogs接口传入，禁止definition、name自由文本、operationKey/requestHash或凭证。读取及幂等重放无新事件。

预计154模型/118迁移不变，612→620端点、119→120 Controller、258→260权限、165→166审计总计/160→161活跃、523→531 BizCode；其余计数由生成器读取，不为凑数字改规则。状态机仍原inventory级别，不伪报治理升级。本刀不重签3b；实际完成后请求4b（260权限、166总计/161活跃），不能预签。

## 7. 精确实施写集（58路径，待批准）

下列是未来实施白名单，不是本轮实际修改。新增文件按完整文件实现，既有文件只做对应接线、精确登记或派生更新。发现新路径先汇报，不借此修改裁判规则。

```text
src/modules/activities/activity-time-policy-command.ts
src/modules/activities/activity-time-policy-command.spec.ts
src/modules/activities/activity-time-policy.service.ts
src/modules/activities/activity-time-policy.service.spec.ts
src/modules/activities/activity-time-policy-catalogue-query.service.ts
src/modules/activities/activity-time-policy-catalogue-query.service.spec.ts
src/modules/activities/activity-time-policy-presenter.ts
src/modules/activities/activity-time-policy-presenter.spec.ts
src/modules/activities/activity-time-policy-audit-recorder.ts
src/modules/activities/activity-time-policy-audit-recorder.spec.ts
src/modules/activities/controllers/admin-activity-time-policies.controller.ts
src/modules/activities/dto/admin/activity-time-policy.dto.ts
src/modules/activities/dto/admin/activity-time-policy-command.dto.ts
src/modules/activities/activities.module.ts
src/modules/permissions/permission-catalog.ts
src/modules/permissions/permission-code-holders.spec.ts
prisma/seed.ts
src/modules/audit-logs/audit-logs.types.ts
src/common/exceptions/biz-code.constant.ts
src/common/exceptions/biz-code.constant.spec.ts
test/e2e/activity-os-r4-d1-2-time-policy-catalogue.e2e-spec.ts
test/e2e/activity-os-r4-d1-2-time-policy-concurrency.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts
test/contract/openapi.contract-spec.ts
test/contract/__snapshots__/openapi.contract-spec.ts.snap
harness/domain-map.json
harness/state-machines.json
harness/authz-assertion-patterns.json
harness/authz-implication-graph.json
harness/permission-surface-baseline.json
docs/current-state.md
CODEMAP.md
docs/ai-harness/RBAC_MAP.md
docs/ai-harness/ROUTE_AUTHZ.md
docs/ai-harness/AUDIT_EVENT_REGISTRY.md
docs/ai-harness/STATE_MACHINE_INVENTORY.md
docs/ai-harness/CUTOVER_SIGNOFF.md
docs/ai-harness/FROZEN_DRAFTS.md
docs/ai-harness/NEXT_TASKS.md
src/modules/activities/CLAUDE.md
docs/plans/activity-os-r4-d1-time-policy-review.md
docs/plans/activity-os-r4-d1-2-implementation-plan.md
docs/handoff/admin-web.md
docs/handoff/openapi.json
docs/handoff/clients/admin/client.ts
docs/handoff/clients/admin/types.ts
docs/handoff/clients/app/client.ts
docs/handoff/clients/app/types.ts
docs/handoff/clients/auth/client.ts
docs/handoff/clients/auth/types.ts
docs/handoff/clients/system/client.ts
docs/handoff/clients/system/types.ts
docs/handoff/clients/open/client.ts
docs/handoff/clients/open/types.ts
docs/handoff/clients/integration/client.ts
docs/handoff/clients/integration/types.ts
docs/handoff/clients/shared/types.ts
changelog.d/activity-os-r4-d1-2-implementation.md
```

限定说明：
- 1–13为新增生产/单测文件，14为Module接线；复用现有纯定义/状态机/Users/RBAC，不修改其文件。
- permission-catalog与seed只建两码并接入真实seed事实闭包，不自动建RoleBinding、不动既有角色权利；持有人例外必须与上述人工授码决策一同确认。
- 旧C1 D2b迁移测试仅当前权限258→260，历史迁移/数据断言不变；其他既有E2E不在本刀写集。
- contract仅八路由、显式DTO/错误及612→620；快照必须逐行解释，不盲目-u。
- harness五JSON只登记本刀真实边界/判权事实及生成摘要，不改守护语义、不添豁免。若现有仪器无法识别实际授权链，先复现报告，不绕过。
- Admin两客户端有实际新API/types，其余11份只允许必要生成摘要/共享类型联动，不能修改其他surface语义；无差异不制造修改。
- current-state/CODEMAP/RBAC_MAP/ROUTE_AUTHZ/状态机读数只从真实代码生成；不手改生成地图。changelog和台账只记录实际完成结果；无需刷新prisma摘要，因为模型/迁移不变。

## 8. 验证探针与完成标准

本地实施前重跑preflight，核main未前进及红区令牌；先运行既有time-policy纯函数、RBAC及metric-rule-binding表征测试，行为变化立即报告。

新增真实HTTP验收覆盖八接口；draft定义持久化/hash、分页边界/稳定序/历史退役可读、非法JSON/重复映射/超32KiB/非法UTC、生效区间、未知schema/evaluator、不可编辑/删除、跨政策versionId拒绝。显式两码分别验收；无码SA、普通无权、读写不互通、过期GLOBAL、仅组织scope、停用User、Service/Delegated均负例。

并发使用两个真实连接/HTTP请求和可控锁屏障，不靠sleep猜时机：同key同输入只一条业务写/收据/审计；异输入冲突；异key同时建版本不撞号；激活/退役竞争守生命周期；锁等待时撤权/停用后拒绝；成功后退役再重放仍原收据；伪造收据锚拒绝；审计失败整体回滚；测SQL数及超时回滚。

未来仅申请app_test_w98隔离验证与测试夹具重建，连接前核host及精确库名，禁止共享app_test与生产。不自动migrate dev/reset/db push；仅已审SQL的migrate deploy。D1-1三表不可DELETE，测试按已批准的隔离库重建处理，不能增加业务清理函数或停触发器。当前文档轮不启动任何数据库验证。

本地quick、build、harness:selftest、harness:replay、两套新增定向E2E、受影响权限/目录回归及contract；旧C1计数测试保留其历史升级验证。全量E2E只由PR CI跑；共用测试库的运行串行，Harness与replay避免临时文件清理互撞。OpenAPI、13客户端、边界、权限图、审计、计数、签字全部检查；PR全量与main合并后结果分开记。整体跨模型复审仍待用户此前要求的整体阶段，不写成已通过。

DoD：八接口可用且严格Human显式GLOBAL、事务负例/幂等竞争通过、零旧契约漂移、58路径内真实diff、118历史SQL不变、生成检查与PR CI通过。只有届时可报D1-2完成；不等于D1整体完成。

## 9. 一次列齐的授权（当前不用执行）

本轮实际仅七份文档：本稿、D1-1计划、D1方向稿、NEXT_TASKS、FROZEN_DRAFTS、activities/CLAUDE.md、prisma/CLAUDE.md。无changelog、提交、推送或PR。

计划发出阶段可一次确认：**确认D1-2精确计划；允许补充changelog、提交、推送并创建计划PR，包含本轮七份文档；不合并、不实施。** 计划changelog候选 `changelog.d/activity-os-r4-d1-2-plan.md`（不与实施changelog混用）。

之后实施阶段须明确确认本稿58路径、两码人工授予且SA不短路、八接口/八错误/单事件、锁与性能预算、仅旧测试当前计数258→260、w98隔离验证和测试夹具重建、验证后提交推送开PR；不合并、不操作生产、不启用Gate、不删除业务数据。不是现在请求提前实施。

58个精确路径已逐个送入harness:needs，10个受保护/48个无需令牌。工具只做预算，不证明令牌存在。下列只供未来维护者批准实施后执行，AI不得自发grant：

```bash
cd /Users/dengwang/Documents/coding/srvf-nest-api
pnpm harness:grant 'src/modules/permissions/permission-catalog.ts' --reason "维护者确认D1-2精确计划58路径完整实施方案A"
pnpm harness:grant 'prisma/seed.ts' --reason "维护者确认D1-2精确计划58路径完整实施方案A"
pnpm harness:grant 'harness/authz-assertion-patterns.json' --reason "维护者确认D1-2精确计划58路径完整实施方案A"
pnpm harness:grant 'harness/authz-implication-graph.json' --reason "维护者确认D1-2精确计划58路径完整实施方案A"
pnpm harness:grant 'harness/domain-map.json' --reason "维护者确认D1-2精确计划58路径完整实施方案A"
pnpm harness:grant 'harness/permission-surface-baseline.json' --reason "维护者确认D1-2精确计划58路径完整实施方案A"
pnpm harness:grant 'harness/state-machines.json' --reason "维护者确认D1-2精确计划58路径完整实施方案A"
pnpm harness:grant 'test/contract/__snapshots__/openapi.contract-spec.ts.snap' --reason "维护者确认D1-2精确计划58路径完整实施方案A"
pnpm harness:grant 'test/contract/openapi.contract-spec.ts' --reason "维护者确认D1-2精确计划58路径完整实施方案A"
pnpm harness:grant 'docs/ai-harness/ROUTE_AUTHZ.md' --reason "维护者确认D1-2精确计划58路径完整实施方案A"
```

执行前若计划合并SHA或main变化，重新检查精确写集/红区命中；不得沿用已过期授权。4b在真实实现与计数核验后单独确认，不为本轮草稿提前签字。

## 10. 本次未做

本轮文档检查：git diff --check、docs:counts:check、docs:codemap:check、docs:rbacmap:check、docs:readtax:check、docs:migcount:check通过。CODEMAP保留既有两类WARN（两份未引用CLAUDE与25个大Service候选），未顺手整改。58路径无重复，既有42路径全部存在，新增16路径均为本刀代码/测试/实施changelog；20197–20204在当前BizCode无占用。此处新增路径统计不含本稿（本稿本轮已创建）。PR #1310及main CI已再次只读核验，不以本轮文档检查代替未来实施测试。

未实施代码/测试/数据库；未改schema、旧SQL、权限、审计或Gate；未删除业务数据；未提交、推送、开PR或合并；未启动跨模型评审。计划中的验证均为待执行项，不冒充已通过。
