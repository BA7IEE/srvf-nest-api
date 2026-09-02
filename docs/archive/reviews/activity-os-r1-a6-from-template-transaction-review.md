# Activity OS R1 / A6：基于模板创建活动事务评审与授权清单

> **状态：方案 A 已由维护者于 2026-09-02 确认，实施中。** 维护者已为本刀的评审稿、`prisma/schema.prisma`、第 104 条 migration、`ROUTE_AUTHZ.md`、`harness/domain-map.json` 与 `harness/state-machines.json` 写入精确授权。该授权不包含新路由、DTO、权限码、Gate、seed、回填、生产数据或任何非本评审范围的变更；migration SQL 定稿后仍须单独完成 3b 重签。
>
> **上游合同**：Activity OS T0-A 终态合同 §5、§8、§11；原始蓝图《SRVF 活动域终态蓝图与分阶段落地方案》§7.2、§7.4、§9.2。A1 至 A5 已分别合入；A6 不重开其决策。

## 1. 结论

推荐采用**方案 A：内部 application façade + 严格 Template Definition V1 + 单事务 copy-on-create + Activity 行承载幂等结果**。

这是一条 D 档变更：它会新增持久化幂等事实和 migration，并把不可变模板定义实际变成活动草稿。A6 只交付内部写命令，不新增 HTTP 入口；Admin、App、Integration 的三个创建 API 留给 Release 2 / B6 统一接入。本刀也不改变现有普通创建、legacy resolver、A5 只读投影或任何 Gate。

## 2. 已核验事实与必须补齐的缺口

| 事实 / 缺口                                                                                                               | 证据                                                                        | A6 的处理                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Family 是稳定身份，Version 是不可变定义；Activity 必须保存显式选择                                                        | T0-A §5，第 123–136 行                                                      | 新活动写入 selectedTemplateVersionId，草稿复制模板内容，后续编辑不回写模板。                           |
| 每条写命令必须有权限、事务、幂等、校验、审计、安全 DTO                                                                    | T0-A §8，第 197–205 行                                                      | A6 提供明确的 CreateActivityFromTemplate façade，不引入通用 Command Bus。                              |
| A3 只建立 canonical/hash 与 lifecycle，明确把 definition schema、hash 复验、审计、错误码留给 A6 独立决定                  | A3 评审 §1、§4，第 11–21、40–46 行                                          | A6 以严格 Definition V1 接住这项缺口，并在每次写前重新计算 hash。                                      |
| 只有 familyId 非空的 future Version 受 A3 生命周期约束；active 行需 definition/hash/schemaVersion/effectiveFrom           | A3 评审 §1，第 12–20 行；prisma/schema.prisma ActivityTemplate              | 只接受 familyId 非空、statusCode=active、定义完整且 hash 一致的精确 Version。                          |
| A5 仅负责读取，已明确 A6 writer 必须在事务中校验可选目标；如需数据库级选择 guard，另立 D 档                               | A5 评审与 fallback resolver                                                 | 事务内锁住精确模板行后再判断；不趁机新增选择 guard。                                                   |
| 当前 Activity 没有“从模板创建”的 operationKey / requestHash；IntegrationCommandReceipt 绑定服务主体，不能挪作后台创建收据 | prisma/schema.prisma Activity；integration receipt 模型                     | 在新 Activity 行追加一组可空且全局唯一的幂等列，作为成功结果的天然锚点。                               |
| 现有 ActivityWriteService.create、ActivityDraftService.createSession / createPosition 都自己开启事务                      | src/modules/activities/activity-write.service.ts；activity-draft.service.ts | A6 不在事务里嵌套调用它们；新 façade 使用同一 transaction-bound primitive 完成活动、场次、岗位与审计。 |

## 3. 方案 A 的精确边界

### 3.1 内部命令与权限

新增一个仅供模块内调用的 CreateActivityFromTemplateCommand。它的调用方必须携带当前用户和 auditMeta；服务第一步执行现有 activity.create.record 权限校验，并复用现有 ActivityInitiationPolicy、组织校验、字典校验、活动时间与报名截止时间校验。

命令输入固定为：

| 字段                                            | 规则                                                         |
| ----------------------------------------------- | ------------------------------------------------------------ |
| templateVersionId                               | 必填；精确选择一条 Version，不按 activityTypeCode 猜“最新”。 |
| title、organizationId、startAt、endAt、location | 必填；沿现有活动创建的长度、时间、组织与根组织限制。         |
| registrationDeadline、initiatorMemberId         | 可选；沿现有创建语义校验，不从模板隐式取得负责人。           |
| operationKey                                    | 必填，字符串长度 8 至 128；用于本命令的持久化幂等。          |

本刀**不**新建 controller、请求 DTO、Swagger、route、权限码、RBAC map 或 Gate。外部入口、返回 DTO 及路由合同由 B6 单独立项；A6 的调用结果只复用当前安全的 Activity response 映射。

### 3.2 事务、锁与模板选择

单一事务按下列顺序执行：

1. 先按 createFromTemplateOperationKey 查既有成功结果。相同 requestHash 直接返回同一 Activity；hash 不同立即失败，不再检查模板当前状态。这样重试即使发生在模板退休后也不会制造第二个活动。
2. 首次执行时，对 templateVersionId 对应的 ActivityTemplate 行作参数化 SELECT FOR UPDATE，随后检查：familyId 非空、statusCode 为 active、schemaVersion / definitionJson / definitionHash / effectiveFrom 齐全，definitionJson 为 object，且用 A3 canonicalizer 复算出的 hash 与存储值相同。
3. 不以 Family.statusCode 作为新判断条件。A2 的 Family 状态仍是 inventory，尚无可用的 lifecycle 语义。
4. effectiveFrom / effectiveTo 在 A6 只作 Version 的既有不可变元数据与结构校验，不凭本机时间发明“当前可用”筛选规则。ListAvailableActivityTemplates 的时间可见性口径留给未来读面切片先评审后实现。
5. 校验通过后，在同一事务内写 Activity、ActivitySession、ActivitySessionPosition 和审计；其中 Activity 记录 selectedTemplateVersionId、operationKey 与 requestHash。
6. 若并发插入撞上唯一键，捕获 P2002 后重新读取唯一键锚点：hash 一致则返回既有结果，hash 不同则报操作键冲突。不得把唯一键异常泄露为 500。

模板退休与创建竞争时，两侧都以同一 Version 行锁串行：先退休则创建失败；先创建并提交则退休只影响后续创建，绝不改写已创建草稿。

### 3.3 Definition V1：允许复制的非敏感蓝图

模板定义不是任意 JSON。A6 只识别 schemaVersion=1 的严格白名单；未知字段、错误类型、越界数字、重复 code / name、无效枚举和不满足时序关系的定义一律失败，不静默丢字段。

| 区域              | Definition V1 允许的内容                                                                                                                                                                                                                    | 复制结果                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| activity          | allocationModeCode、description、capacity、genderRequirementCode、registrationNotes、isPublicRegistration、requiresInsurance、registrationModeCode、visibilityCode、defaultLocationRequired、defaultCheckInRadiusMeters、archiveWaitingDays | 写入新 Activity 的同名可编辑草稿字段；activityTypeCode 取被锁 Version 的 activityTypeCode。 |
| sessions          | code、name、相对活动开始的 startOffsetMinutes / endOffsetMinutes、locationText、capacity、四个签到签退窗口偏移、preparationStartOffsetMinutes、locationRequired、radiusMeters、lateGraceMinutes、earlyLeaveThresholdMinutes、sortOrder      | 物化为 ActivitySession；模板中一律使用偏移量，不保存绝对日期。                              |
| session positions | code、name、attendanceRoleCode、capacity、相对活动开始的可选起止偏移、genderRequirementCode、可选 locationRequired / radiusMeters、description、equipmentNotes、sortOrder                                                                   | 物化为 ActivitySessionPosition；岗位时段不得超出所属场次。                                  |

具体约束如下：

- 活动、场次、岗位使用已有字典与业务校验；所有时间都必须落在活动或所属场次内，结束必须晚于开始，窗口之间必须符合当前场次规则。
- V1 明确排除 Place / 经纬度，而现有 `ActivitySession` 在 `locationRequired=true` 时必须同时有坐标。因此 A6 对场次 / 岗位的 `locationRequired=true` 或非空 radius fail-closed，不伪造坐标、不落无效草稿；可编辑草稿可在地点切片 B1/B2 落地后补齐真实地点与定位策略。
- 场次和岗位编号、名称在各自既有唯一范围内不能重复；容量、定位半径、迟到 / 早退阈值、归档等待天数沿现有范围校验。
- sessions 可以是空数组：草稿允许不完整，B4 Readiness 将来负责阻止不完整草稿发布。
- 创建结果是可编辑的草稿，不会随模板后续变更而改变；发布时仍由既有快照链解析最终值。

以下内容明确排除，既不进入 Definition V1，也不由 A6 复制：registrationSchema、报名表 blueprint / 字段 / 答案、资格规则及规则集、content、附件、Place / 经纬度 / 地点预设、负责人 / leaderMemberId、资源与通知配置、metrics、facets、任何 policy pointer、旧 ActivityPosition 与 commonPositionTemplates。报名表归 B3，地点归 B1/B2，Readiness 与 snapshot 分别归 B4/B5，外部 API 归 B6。排除项中可能含个人信息或权限含义，不能以“先占位”越过后续评审。

### 3.4 幂等持久化与错误形状

推荐在 Activity 追加以下两列，均为可空以保持既有行零改写：

| 列                             | 约束与用途                                     |
| ------------------------------ | ---------------------------------------------- |
| createFromTemplateOperationKey | 单列 unique；一条成功创建的全局重放锚点。      |
| createFromTemplateRequestHash  | 与 operationKey 配对保存 canonical 请求 hash。 |

requestHash 覆盖操作类型、调用者身份、operationKey、精确 templateVersionId、已复验的 definitionHash，以及命令的全部可变输入（包括规范化后的可选字段）。相同 key 但任何输入、调用者或模板定义 hash 不同，必须拒绝，不能返回旧活动。

新增两枚活动域业务错误的**符号名**：

- ACTIVITY_TEMPLATE_VERSION_NOT_SELECTABLE：不存在、legacy、非 active、定义结构不完整或 hash 不一致，统一为不可选择，避免泄露内部模板状态。
- ACTIVITY_CREATE_FROM_TEMPLATE_OPERATION_KEY_CONFLICT：同一 operationKey 绑定了不同 canonical 请求。

具体 20xxx 数值在实现前重新扫描 BizCode 常量后顺序分配并由单测钉住，不占用或改写既有码。

### 3.5 审计与回滚

在同一事务、所有实体写入后，ActivityAuditRecorder 新增专用 logCreateFromTemplate。沿现有 activity.publish 审计总类，before 为空、after 为现有 Activity 安全快照，extra 只记录：

- operation: create_from_template；
- templateVersionId；
- definitionHash；
- nextStatusCode: draft。

不记录原始 definitionJson、表单 / 人员数据、原始 operationKey、完整请求体或任何敏感字段。幂等重放不新增审计行。任何校验、场次 / 岗位创建或审计失败都回滚整个事务，不留下半成品 Activity。

## 4. 方案比较

| 方案        | 内容                                                                     | 结论                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| A（推荐）   | Activity 行存 operationKey + requestHash；严格 Definition V1；单事务复制 | 成功结果与幂等锚点同处，保持 additive、零回填，能够覆盖并发重放。                                                                    |
| B（不采用） | 新建泛化 command receipt 表                                              | 当前没有后台命令的统一归属和生命周期；IntegrationCommandReceipt 绑定服务主体，复用会篡改其安全边界。应在真正出现跨域需求时另立设计。 |
| C（不采用） | 只在内存或请求时间窗防重                                                 | 进程重启、并发与网络重试都会失效，违反 T0-A 的写命令幂等合同。                                                                       |
| D（不采用） | 将模板全部业务字段、表单、地点、资格规则一次性复制                       | 横跨 B1 至 B5，且会把敏感数据、权限与快照语义提前混入 A6。                                                                           |

## 5. 明确不做

- 不建立真实模板数据，不回填、迁移或重解释历史 Activity / legacy template；
- 不修改 A5 fallback / read projection、既有普通创建合同、existing resolver 或发布快照合同；
- 不新增第三个 cron、队列、Redis、缓存、LLM、通用 Command Bus；
- 不把 effective interval 擅自解释为“现在可选”，不替 Family invent lifecycle；
- 不新增数据库级模板选择 guard；若将来需要，必须单独按 D 档评审；
- 不输出或记录任何 secret、signed URL、报名答案或其他敏感内容。

## 6. 验证、迁移与回退

实施后必须至少完成：

1. 纯函数 / service 单测：Definition V1 的 canonical/hash 复验、未知字段拒绝、偏移和时间边界、字典与定位规则、空 sessions 草稿、同 key 同请求重放、同 key 不同请求拒绝、P2002 并发收敛、审计不泄露输入。
2. PostgreSQL E2E：active future Version 创建出显式 selectedTemplateVersionId 和完整复制草稿；draft / retired / legacy / hash 不一致全部零写入；模板退休与创建的行锁竞态符合上述顺序；失败任一点回滚无 Activity / Session / Position / Audit 残留；既有普通创建行为不变。
3. migration rehearsal：只为两列和 unique 索引执行 expand migration；不回填、不开 data migration，不运行 prisma migrate dev、reset 或 db push；先审查生成 SQL，再由维护者完成 migration 重签。
4. 受影响验证：pnpm agent:check:full、定向 unit / E2E、pnpm test:contract、派生文档检查与 CI 冷跑。无 Docker 时只能报告 quick 结果，contract / E2E 留给 CI，不得伪称全绿。
5. 回退：代码部署前可回退；一旦 migration 已在环境应用，保留 additive 列与索引，不以 DROP 回滚。

## 7. 授权清单与下一步

维护者已执行的实施授权如下：

```
cd /Users/dengwang/Documents/coding/srvf-nest-api-activity-os-r1-a6-from-template-transaction
pnpm harness:grant 'docs/archive/reviews/activity-os-r1-a6-from-template-transaction-review.md' --reason "Activity OS R1 A6 方案 A 已确认：冻结评审记录改为已拍板并登记实施范围"
pnpm harness:grant 'prisma/schema.prisma' --reason "Activity OS R1 A6 方案 A 已确认：为从模板创建活动增加幂等键与请求摘要字段"
pnpm harness:grant 'prisma/migrations/20260902143000_activity_os_r1_a6_from_template_transaction/migration.sql' --reason "Activity OS R1 A6 方案 A 已确认：第104条 migration，仅新增两列和唯一索引，不回填、不删改数据"
pnpm harness:grant 'docs/ai-harness/ROUTE_AUTHZ.md' --reason "Activity OS R1 A6 方案 A 已确认：刷新取证指纹，不新增路由或权限语义"
pnpm harness:grant 'harness/domain-map.json' --reason "Activity OS R1 A6 方案 A 已确认：同步活动域模块映射"
pnpm harness:grant 'harness/state-machines.json' --reason "Activity OS R1 A6 方案 A 已确认：仅同步 schema 摘要，不变更状态机语义"
```

`20260902143000_activity_os_r1_a6_from_template_transaction` 是本刀唯一允许新建的 migration 目录，编号为第 104 条。它只可追加两列和唯一索引；SQL 审查完成后，维护者必须另行确认“重签 3b（A6，第104条 migration）”，才能改写 `CUTOVER_SIGNOFF.md`。

## 8. 维护者决策

维护者已确认：

> 确认 A6 方案 A

实施完成后，先提交 migration SQL 供逐行审查与 3b 重签；重签前不得声称 migration 已获签署，也不得改写签署记录。
