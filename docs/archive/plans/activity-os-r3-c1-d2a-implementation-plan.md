# C1 D2a implementation 方案 A

基线 main@fc99e8dc；承接 #1279。维护者已明确批准 D2a implementation、81 个精确路径与 app_test/app_test_w1/app_test_w98 测试范围，精确红区授权已核验。
另批准旧 D1 测试清理语句显式加入 ActivityMetricCommandReceipt，不加 CASCADE、不改行为断言。下列清单保留立项时的基线读数；其中「待确认」描述已由本段授权记录取代，不能当作未来步骤授权。

阶段性跨模型复审延后至整体完成后，尚未通过。3b/4b 已获维护者 2026-09-06 确认重签；CI、可信红区审批、合并及生产部署均须另行满足。

## 2. 已核验的起点和引用链

- #1279 已 MERGED，squash fc99e8dc8dc900a15ea162ce122d09abb89ac718；当前 main 工作区干净，无 open PR，preflight 通过；版本与 Swagger 为 0.72.0，最近 Release 为 v0.72.0。
- CHANGELOG 当前以 v0.72.0 开头，没有 Unreleased 标题；本步通过独立 changelog.d fragment 记录，不启动 release。
- docs/current-state.md §1 的生产限制不变，不能把本次代码实施、测试库验证或 PR 合并当作生产上线。
- prisma/schema.prisma:1695/1717/1736：已有 ActivityMetricDefinition / ActivityMetricSetVersion / ActivityMetricSetItem；无命令收据。
- activity-metric-definition.ts:170/223 与 activity-metric-set-definition.ts:27/76：唯一强类型解析、canonical/hash、激活引用复验入口。五类值域原样复用，不给 D1 解析器另造替身。
- rbac.service.ts:79/106/113：getUserPermissionCodes/can/judge 当前读注入的 PrismaService，无事务参数。PrismaService 本身没有隐式事务上下文，因此在事务回调里调用旧 can() 不会自动使用该事务。
- 现有 controller 结构范例：controllers/admin-activity-responsibilities.controller.ts:44，声明 rbac-global；实际判权仍归 Service。
- 新调用链：Admin 两 Controller → 对应 definition/set Service（根事务）→ rbac.can 的显式 tx 参数、领域命令函数、D1 解析器、状态机、AuditRecorder；读投影经 QueryService/Presenter。Presenter/StateMachine 不访问数据库。
- 权限定义 → permission-catalog.ts；实际 upsert 与角色映射 → prisma/seed.ts；运行时闭包镜像 → seed-permission-codes.ts。新增独立目录权限桶，不塞进自动分配的 BIZ/OPS 角色桶。
- 真源检查通过：43 模块、110 Controller、574 Endpoint、110 migration、490 BizCode、247 权限、157 审计事件、15 内置角色、2 cron。
- 现有固定 migration 总数的 E2E 共 13 份，已逐文件列入 §8，只同步 CURRENT_MIGRATION_COUNT，历史起点和行为断言不改。
- 现有 RBAC characterization：rbac.service.spec.ts 17/17 通过，尚未修改实现。它证明旧基线，不证明新增 tx 路径。

## 3. 数据、事务与权限合同

### 数据与收据

新增一条 migration，拟定精确路径：
prisma/migrations/20260905221158_activity_os_r3_c1_metric_command_receipts/migration.sql

D2a 新建 ActivityMetricCommandReceipt：id、actorUserId、operationCode、operationKey、requestHash、resultJson、createdAt，以及 definitionId/setVersionId 两个可空 Restrict FK；actor FK 同样 Restrict，关联的 User/定义/集补反向 relation。
D2 全部收据终态仍沿 #1279：模板与活动的目标 FK 在 D2b 连同真实 writer 一起补齐，不在本步开放模板或活动命令。

- operationCode 本步只有 create/update/activate/retire_definition 和 create/update/activate/retire_set 八种。
- 唯一键为 actorUserId + operationCode + operationKey；按命令类别恰好一个 definitionId/setVersionId 非空，DB CHECK 显式防 NULL 三值漏口。
- requestHash 为规范化业务输入、操作和资源目标的 SHA-256。资源路径 ID 必须入 hash，防止同 key 跨目标错误重放；原始 key 不进 audit。
- resultJson 使用固定最小白名单 id/code/version/schemaVersion/statusCode/definitionHash，只返原命令收据，不保存自由配置、人员信息或完整请求。
- 收据不可 UPDATE/DELETE，DB trigger 保护；测试库 TRUNCATE 仍可用，不新增清理任务。
- 新表约束与 FK 名显式对齐 Prisma，长度不超过 PG 63 字符；只读 diff 必须减去基线既有漂移，不能把无关改名混入 SQL。
- D1 历史 SQL、既有 Activity/模板/提案数据不修改；不建业务目录内容 seed、不回填、不删除旧列或旧行。

### 命令执行

- 每次业务命令及重放都先核验当前 Human 身份与权限；授权失败不得返回已有收据。
- 在根事务中以显式 tx 调用 RBAC，再执行命令串行化/重放判断；不同 key 的资源编辑使用父版本行锁，锁后重读状态与 expectedDefinitionHash。
- 同 key 同输入只返回原收据，不重复业务写或审计；同 key 不同输入为明确冲突。同身份不同 key 的并发创建由唯一约束兜底，P2002 显式映射，不能伪装成原命令重放。
- 定义及集仅 draft 可编辑，激活后内容冻结；生命周期沿 D1 draft→active→retired，不新增 draft 删除/直接退役或恢复入口。
- 激活集固定 Set→按 ID 排序的 Definitions 锁序，锁后逐条核验 active、canonical/hash 与精确引用；定义退役不反向锁集，不修改历史集项。
- draft 集可为空，激活不可为空；整组替换集项必须锁父集，遵循 D1 已批准的 draft 明细替换约束，不提供删除定义/集版本的接口。
- 业务行、整组明细、收据、审计同事务成功或回滚；不得持锁等待外部服务。

### RBAC 本轮已批准的扩展

仅 rbac.service.ts 和既有对应单测增加可选 Prisma.TransactionClient 参数，贯穿 can→judge→getUserPermissionCodes；不传参数仍使用原 PrismaService。
不改变 SUPER_ADMIN 短路、GLOBAL-only、有效任期、软删 role 过滤、.self ownership 或 recordAuthzAssertion。
新 D2a 调用显式传 tx，既有调用点不批量迁移。tx 路径要证明不落回根 client；旧默认路径逐条不变。

同一事务读权限不等于所有全仓撤权操作都被同一把锁串行化；本步不声称解决全仓判权并发，不改 RoleBinding/角色权限/账号生命周期写者。新增测试分别验证事务连接使用、锁后当前事实重验与后续请求撤权生效，不能把其中一项当作三项。

### 权限与审计差值

本步仅新增 3 个 GLOBAL-only Human 权限：
- activity-metric.read.catalog：定义/集目录分页与详情；不含写。
- activity-metric.manage.definition：定义四类写命令；不隐含全目录读取或集写。
- activity-metric.manage.set：集四类写命令；不隐含定义写。

三者 servicePrincipalAllowed=false、delegatedAccessAllowed=false，普通自定义角色可经现有人工授码配置；不自动分配到任何内置角色，不新增 RoleBinding/PositionRolePolicy/Role enum。SUPER_ADMIN 只走现有 RBAC 统一短路，不能在新 Service 写角色特判。
目录元数据挂 activity-participation 下的独立 activity-metric 分组；读为 LOW/READ，管理为 HIGH/WRITE，grantPolicy=CUSTOM_ROLE_ALLOWED。只描述本步真实入口。

新增 2 个审计事件：
- activity.metric-definition.command，resourceType=activity-metric-definition，resourceId=definitionId。
- activity.metric-set.command，resourceType=activity-metric-set，resourceId=setVersionId。

extra 仅 operation、code/version、前后 hash/status 和规范化请求来源；不记录 definition/configuration 全文、PII、Token、签名 URL 或 operationKey。
预计权限 247→250、事件总计 157→159；两事件有真实产出者时活跃 152→154。最终必须以代码和检测结果复算，再请维护者重签 4b，不预写成已签。模板的另 2 个权限及另 2 个事件在 D2b，未从 C1 终态删去。

## 4. 精确新增 HTTP / DTO 矩阵

两个独立 Admin Controller。下表路径共同前缀 /api/admin/v1。
共同入口为 Human JWT 与结构化 RequiresPermission（rbac-global、GLOBAL）；无 Public/局部 Guard/新限流器，无 App/Integration/Open 新路由。

| 方法与路径 | 顶层 DTO / 出参 | 权限 | 操作 / 成功状态 |
|---|---|---|---|
| GET /activity-metric-definitions | AdminListActivityMetricDefinitionsQueryDto → PageResultDto<AdminActivityMetricDefinitionResponseDto> | read.catalog | 只读 / 200 |
| GET /activity-metric-definitions/:id | IdParamDto → AdminActivityMetricDefinitionResponseDto | read.catalog | 只读 / 200 |
| POST /activity-metric-definitions | AdminCreateActivityMetricDefinitionDto → AdminActivityMetricCommandResponseDto | manage.definition | create_definition / 201 |
| PUT /activity-metric-definitions/:id/draft | AdminUpdateActivityMetricDefinitionDto → 同上 | manage.definition | update_definition / 200 |
| POST /activity-metric-definitions/:id/activate | AdminActivityMetricVersionCommandDto → 同上 | manage.definition | activate_definition / 200 |
| POST /activity-metric-definitions/:id/retire | AdminActivityMetricVersionCommandDto → 同上 | manage.definition | retire_definition / 200 |
| GET /activity-metric-sets | AdminListActivityMetricSetsQueryDto → PageResultDto<AdminActivityMetricSetResponseDto> | read.catalog | 只读 / 200 |
| GET /activity-metric-sets/:id | IdParamDto → AdminActivityMetricSetResponseDto | read.catalog | 只读 / 200 |
| POST /activity-metric-sets | AdminCreateActivityMetricSetDto → AdminActivityMetricCommandResponseDto | manage.set | create_set / 201 |
| PUT /activity-metric-sets/:id/draft | AdminUpdateActivityMetricSetDto → 同上 | manage.set | update_set / 200 |
| POST /activity-metric-sets/:id/activate | AdminActivityMetricVersionCommandDto → 同上 | manage.set | activate_set / 200 |
| POST /activity-metric-sets/:id/retire | AdminActivityMetricVersionCommandDto → 同上 | manage.set | retire_set / 200 |

表内权限省略共同 activity-metric. 前缀。
列表沿 PaginationQueryDto 的 page/pageSize=1/20、最大 100，筛选 code/statusCode，定义列表可按 kindCode；稳定 createdAt DESC,id DESC。不能整取无上界。
所有 :id 使用 IdParamDto。创建 DTO 为 operationKey + 完整 definition；draft 更新额外带 expectedDefinitionHash；activate/retire 为 operationKey + expectedDefinitionHash。
operationKey 为非空、已去首尾空白字符串，最多 128 字符；hash 为 64 位小写十六进制。definition 内身份不可由更新改变。
Definition V1 与 Set V1 嵌套字段逐项显式声明，使用 D1 五种 configuration 值域；不接任意 JSON 扩展或运行脚本。详情可解释 draft/active/retired，不返 Prisma 原对象、actor relation 或收据内部键。
Swagger tags 分别为 Admin - Activity Metric Definitions / Admin - Activity Metric Sets；响应使用集中 Wrapped/Page 装饰器，命令显式 HttpCode(200)。
旧 574 个端点 path/method/DTO/行为不变，预计新总数 586；这是新 API 契约，不是 tag-only 变化。

## 5. 新增 BizCode 预算

已用全表正对照核验 490 个数字，活动现用最大值 20163，下列号码当前未占用。实施前再次复核；若被其他提交占用，停止更新清单，不静默换号。

| 符号 | code | HTTP | message / 前端用途 |
|---|---:|---:|---|
| ACTIVITY_METRIC_DEFINITION_INVALID | 20164 | 400 | 指标定义无效；提示检查类型、值域或配置 |
| ACTIVITY_METRIC_SET_INVALID | 20165 | 400 | 指标集配置无效；提示检查集项或空集激活 |
| ACTIVITY_METRIC_DEFINITION_NOT_FOUND | 20166 | 404 | 指标定义不存在；有权限后才查询目标 |
| ACTIVITY_METRIC_SET_NOT_FOUND | 20167 | 404 | 指标集不存在；有权限后才查询目标 |
| ACTIVITY_METRIC_VERSION_ALREADY_EXISTS | 20168 | 409 | 指标版本已存在；显式选择新版本号 |
| ACTIVITY_METRIC_COMMAND_CONFLICT | 20169 | 409 | 命令标识已用于不同请求；换新命令标识 |
| ACTIVITY_METRIC_VERSION_STALE | 20170 | 409 | 指标版本已变化，请刷新后重试 |
| ACTIVITY_METRIC_STATUS_INVALID | 20171 | 409 | 当前指标状态不允许此操作 |
| ACTIVITY_METRIC_REFERENCE_UNAVAILABLE | 20172 | 409 | 引用的指标定义不可用，请重新选择 |
| ACTIVITY_METRIC_RECEIPT_INVALID | 20173 | 409 | 指标命令收据校验失败；停止重试并人工排查 |

实现中的 message 取表中分号前固定短句，分号后是用途解释，不作为 wire message。
认证/权限失败仍用 40100/30100，不新增 token 错误，不复用无关模板错误。
数据库连接失败及未知异常保留 500，不把所有异常都变为上述 409。TypeError 只在 D1 解析调用边界映射，不捕获整条业务链后吞掉程序错误。

## 6. 风险表与不做边界

| 项 | 结论 |
|---|---|
| 是否修改 prisma/schema.prisma | 是，仅领域收据及真实反向关系，不加 Activity 指标选择字段 |
| 是否新增/改动 migration | 新增上述一条；绝不改任何已合入 SQL |
| 是否修改 prisma/seed.ts | 是，仅三权限的独立 upsert 桶和闭包接线，既有角色映射零扩权 |
| 是否影响现有数据 | 不回填、删除或重解释；测试库会产生临时数据并按获批范围清理 |
| 是否不可逆 | 新写收据/审计不可改删；回退保留数据，不能以删表作为回退 |
| 是否影响 OpenAPI / contract snapshot | 是，12 新端点与显式 DTO；旧端点零漂移 |
| 是否影响鉴权/Permission seed/审计 | 是；RBAC 可选 tx 不改默认规则，新增 3 权限/2 事件 |
| 是否需要新增 BizCode | 是，上述 10 个 |
| 是否需要用户拍板 | 方案与 RBAC 扩展已批，完整 implementation、精确写集与测试库操作待本清单确认 |

禁止：D2b 活动选择、模板 V3 与模板 writer、B6/Series/clone 接入；D2c v7/Readiness；C2/C3 成果值；生产部署/内容初始化；Gate、auth、authz、全局 Guard/Filter/Interceptor、CI 配置、依赖或现有裁判逻辑变更。
不变更任何历史业务 E2E 断言；13 处 CURRENT_MIGRATION_COUNT 是本清单明确列出的计数联动，旧起点、EXPECTED_PRISMA_CURRENT_DIFF 和断言强度不变。
state-machines 只登记本步真实 writer/错误码/迁移边及新 digest，不借机把现有条目升级为 governed。

## 7. 测试数据库操作申请

精确容器：u-nest-api-postgres；只使用本机测试环境，不读取/输出 secret。
本次只读观测：容器 healthy；app_test 存在且连接数 0；app_test_w1、app_test_w98 不存在；现有 E2E 没有占用 scratch worker 98。执行前重新检查，不把此快照当永久许可。

待维护者确认的范围：
1. app_test：作为既有测试模板，仅允许 migrate deploy 已审查的本步 migration；不 DROP/reset 模板库。
2. app_test_w1：串行定向 E2E/contract 的 worker 克隆，允许按现有 test/setup 创建/重建、写测试 fixture、TRUNCATE 和回收。重建会销毁该测试克隆的所有数据。
3. app_test_w98：本步 migration 专用 scratch，允许空库历史重放、人工构造的非空库升级演练、seed 幂等二跑、CHECK/FK/append-only 正反例与变异演练；允许只对此库 DROP/CREATE 回收，里面的测试数据不能恢复。
4. 配套 test/setup 的测试临时存储目录清理须先确认没有其他测试任务使用；只处理测试生成物，不触用户资料。

新 migration spec 使用现有 deriveWorkerTestDbName(98) 与 dropWorkerDatabase/安全断言，不绕过目标校验；变异只写隔离临时 migration 副本，仓库既有 SQL 不变。
严禁自动执行 prisma migrate dev/reset/db push 或其绕过变体；严禁强杀未知连接。目标有其他连接或测试任务正在使用则暂停。
不通过改 .env.test 改库；不对 app、生产或其他 scratch 库执行写入。普通定向测试只开 1 worker，旧 13 份迁移全量重放交给 PR CI，不在本机触发它们的其他 scratch 库。

## 8. 精确写集白名单

这是最多允许触碰的 81 个路径，不要求为了凑数修改无关文件。55 个现有路径均已验证存在，26 个新增路径均已验证不存在。
13 个客户端文件由同一输入 digest 联动，不代表向其他 surface 新增业务入口；13 个既有 E2E 仅更新当前 migration 计数。
派生文件只刷新相应生成段；FROZEN/NEXT 仅 C1 与派生读数；prisma/CLAUDE 仅当前摘要，不更改历史长记。
CUTOVER_SIGNOFF 仅在本步实际差值算清且维护者另行明确重签 3b/4b 后写相应签字，不预签。
完整机器清单同目录 write-set.json；新增后果路径必须先报告，不把广域目录视作授权。

### 现有文件（55）

- prisma/schema.prisma
- prisma/seed.ts
- prisma/CLAUDE.md
- src/modules/activities/activities.module.ts
- src/modules/activities/CLAUDE.md
- src/modules/permissions/permission-catalog.ts
- src/modules/permissions/seed-permission-codes.ts
- src/modules/permissions/rbac.service.ts
- src/modules/permissions/rbac.service.spec.ts
- src/modules/permissions/CLAUDE.md
- src/modules/audit-logs/audit-logs.types.ts
- src/common/exceptions/biz-code.constant.ts
- src/common/exceptions/biz-code.constant.spec.ts
- test/contract/openapi.contract-spec.ts
- test/contract/__snapshots__/openapi.contract-spec.ts.snap
- harness/domain-map.json
- harness/state-machines.json
- harness/authz-assertion-patterns.json
- docs/current-state.md
- CODEMAP.md
- docs/ai-harness/RBAC_MAP.md
- docs/ai-harness/ROUTE_AUTHZ.md
- docs/ai-harness/AUDIT_EVENT_REGISTRY.md
- docs/ai-harness/STATE_MACHINE_INVENTORY.md
- docs/ai-harness/FROZEN_DRAFTS.md
- docs/ai-harness/NEXT_TASKS.md
- docs/ai-harness/CUTOVER_SIGNOFF.md
- docs/handoff/admin-web.md
- docs/handoff/openapi.json
- docs/handoff/clients/admin/client.ts
- docs/handoff/clients/admin/types.ts
- docs/handoff/clients/app/client.ts
- docs/handoff/clients/app/types.ts
- docs/handoff/clients/auth/client.ts
- docs/handoff/clients/auth/types.ts
- docs/handoff/clients/system/client.ts
- docs/handoff/clients/system/types.ts
- docs/handoff/clients/open/client.ts
- docs/handoff/clients/open/types.ts
- docs/handoff/clients/integration/client.ts
- docs/handoff/clients/integration/types.ts
- docs/handoff/clients/shared/types.ts
- test/e2e/activity-v11-batch4-allocation-mode-migration.e2e-spec.ts
- test/e2e/activity-v11-batch4-allocation-command-replay-migration.e2e-spec.ts
- test/e2e/activity-v11-batch4-allocation-determinism-migration.e2e-spec.ts
- test/e2e/activity-os-r2-b3-form-blueprint-governance.e2e-spec.ts
- test/e2e/insurance-evidence-registration-revision-migration.e2e-spec.ts
- test/e2e/activity-v11-batch4-qualification-contract-migration.e2e-spec.ts
- test/e2e/activity-os-r2-b1-place-schema-constraints.e2e-spec.ts
- test/e2e/activity-v11-batch4-allocation-candidate-position-anchor-migration.e2e-spec.ts
- test/e2e/activity-os-r1-a3-template-definition-lifecycle-guards.e2e-spec.ts
- test/e2e/activity-os-r1-a4-explicit-template-version-pointer.e2e-spec.ts
- test/e2e/activity-os-r3-c1-metric-definition-set.e2e-spec.ts
- test/e2e/activity-os-r2-b6-creation-data-foundation.e2e-spec.ts
- test/e2e/activity-os-r2-b2-coordinate-projection-schema-constraints.e2e-spec.ts

### 新增文件（26）

- prisma/migrations/20260905221158_activity_os_r3_c1_metric_command_receipts/migration.sql
- src/modules/activities/controllers/admin-activity-metric-definitions.controller.ts
- src/modules/activities/controllers/admin-activity-metric-sets.controller.ts
- src/modules/activities/dto/admin/activity-metric-definition.dto.ts
- src/modules/activities/dto/admin/activity-metric-set.dto.ts
- src/modules/activities/dto/admin/activity-metric-command.dto.ts
- src/modules/activities/activity-metric-definition.service.ts
- src/modules/activities/activity-metric-definition.service.spec.ts
- src/modules/activities/activity-metric-set.service.ts
- src/modules/activities/activity-metric-set.service.spec.ts
- src/modules/activities/activity-metric-catalogue-query.service.ts
- src/modules/activities/activity-metric-catalogue-query.service.spec.ts
- src/modules/activities/activity-metric-presenter.ts
- src/modules/activities/activity-metric-presenter.spec.ts
- src/modules/activities/activity-metric-state-machine.ts
- src/modules/activities/activity-metric-state-machine.spec.ts
- src/modules/activities/activity-metric-audit-recorder.ts
- src/modules/activities/activity-metric-audit-recorder.spec.ts
- src/modules/activities/activity-metric-command.ts
- src/modules/activities/activity-metric-command.spec.ts
- test/e2e/activity-os-r3-c1-d2a-metric-catalogue.e2e-spec.ts
- test/e2e/activity-os-r3-c1-d2a-metric-catalogue-concurrency.e2e-spec.ts
- test/e2e/activity-os-r3-c1-d2a-metric-command-receipt-migration.e2e-spec.ts
- docs/ops/activity-metric-catalogue-rollout.md
- docs/archive/plans/activity-os-r3-c1-d2a-implementation-plan.md
- changelog.d/activity-os-r3-c1-d2a.added.md

## 9. 可下发目标正文

下列目标仅在维护者确认本清单并完成红区/测试库授权后生效，可复制给当前 goal 会话运行；不是新建任务指令。

```text
目标：在 #1279 已批准的 C1 D2 方案 A 下，完整实现 D2a 指标定义/指标集 Human 管理闭环及命令收据，包含已批准的 RBAC 可选事务参数扩展。不得将“表存在/部分 CRUD 通过”当作 D2a 完成；D2a 不等于 C1 全部完成。

DoD 与探针队列（未满足才做）：
P0 基线：确认 main/PR/工作区与该清单基点一致；D1 解析器、RBAC 旧行为与受影响审计行为基线通过。已获批准范围内按 process §7.1 幂等续做。
P1 数据：一条 additive migration 可在空库重放、非空人工 fixture 升级后保持旧行不变；收据八操作闭集、目标 shape、Restrict FK、唯一键及不可改删由真实 PG 正反例证明。seed 两次只建立三权限且不改变任何既有 RolePermission/RoleBinding/PositionRolePolicy，不初始化正式指标内容。
P2 Human 闭环：12 路由通过真实 HTTP 完成五类型定义的创建、编辑、激活、退役及集的整组维护；无权限、机器身份、未知字段、无效 hash/引用/状态、分页边界分别有用例，响应严格符合 DTO 与 HTTP/BizCode 合同。
P3 原子性：同 key 同输入重放零额外写/审计，异输入拒绝；不同 key 并发创建唯一占用可解释；编辑/激活/退役及引用锁等待的真实 PG 竞态通过，事务失败不留部分收据或审计。
P4 RBAC：显式 tx 真用于权限查询，未传 tx 的旧调用行为逐条不变，撤权后下次请求及重放拒绝；保留 GLOBAL/任期/软删/SUPER_ADMIN/.self 既有语义，不新增权限缓存。
P5 交付：OpenAPI/客户端/权限地图/审计登记/状态机及计数同步，旧 574 路由零漂移；handoff 给出目录初始化、可达性与停止新写/回退 SOP；本地 quick、contract 与定向 E2E 通过，全量由 PR CI 冷跑裁决。
P6 收口：真实差值经维护者 3b/4b 签字、可信红区审批后才满足合并条件；PR 合并仍需明确授权。维护者已将阶段性跨模型复审延后，本步不调用模型，统一复审待办不得冒称通过。

授权：仅本清单第 8 节 81 个路径及第 7 节精确测试目标；红区令牌必须由维护者本人发放并核验。D 档实施按 process §4；合并清理按 §5.4；超范围或需改变旧行为断言则按 §4.1 停下汇报。
禁止：改旧 migration、测试断言放宽、全局鉴权或 CI 裁判逻辑、生产数据/部署/Gate、D2b/D2c 与成果值、自动模型调用；不执行 prisma migrate dev/reset/db push。
完成证据：提供 PR/head/CI 链接、实际文件差异、SQL/seed 幂等与并发证据、旧行为回归、签字和未完成事项。C1 保持 open，D2b/D2c 不写成完成。
```

跑完回传的核验点：
- 真正经 Human API 从空目录创建并激活完整指标集，而非 fixture 预灌结果。
- 事务、幂等及权限拒绝的真实反例，不只检查代码包含某字符串。
- 实际新权限/审计/路由/migration 与本清单一致，旧端点和角色映射未扩大。
- main/PR/CI、签字与数据库目标可复查；本次未做项写明。

## 当前实施证据

维护者补充批准治理联动方案 A：写集再加 `harness/permission-surface-baseline.json`（仅新增三码）、
`scripts/harness-guards.selftest.ts`（权限计数 247→250）、
`src/modules/permissions/permission-code-holders.spec.ts`（三码精确人工授码例外及反向自证）。
不得扩大其他权限豁免，不自动向内建角色授码。两项新增红区授权已于 2026-09-05 核验。

- 工作分支 codex/activity-os-r3-c1-d2a；D2a 尚未合并，不等于 C1 完成。
- 2026-09-06 身份接口接线前：HTTP 15 项、并发 5 项、收据 migration 34 项通过；含 110→111 非空升级、seed 二跑、独立 CHECK/FK/append-only 正反例。旧 RBAC/角色/审计编排/活动权限边界另有 83 项通过。
- 接线前 quick 全绿：307 suites / 7157 tests（既有 5 todo），guards 543 / eslint 138 自测通过；冷 lint 使用与当前 CI 相同的 NODE_OPTIONS=--max-old-space-size=6144 后通过，build 通过，未改 CI 配置。
- 完整 contract 996 tests / 2 snapshots 通过；按顶层块逐字比较，旧 446 paths / 719 schemas 均零变化，仅新增 10 个 path（12 operations）及 17 个 schema。
- 只读 Prisma diff：app_test 的 111 条迁移分别对照 HEAD/current schema，原有 19 个差异 SQL 块完全相同，新增漂移为 0；未执行 diff SQL，不混入旧 FK/index 名称更正。
- 两组守护自测曾错误并行，发生本地授权文件恢复竞争；业务文件未丢失。串行重跑 hooks 68/68，事故回放真触发 14/14、结构断言 12/12。维护者于 2026-09-06 恢复原 13 项精确红区授权，此后 guards/hooks/replay 串行，contract/E2E 也串行。

### 身份属主接口扩展（2026-09-06 已批准）

维护者明确确认「确认 C1 D2a 身份属主接口方案 A，扩展清单中的三个 users 文件；已恢复授权」。
写集增加且仅增加：
- src/modules/users/user-active-identity.query.ts
- src/modules/users/user-active-identity.query.spec.ts
- src/modules/users/CLAUDE.md

总写集上限为 87 个路径。起因是新 ActivityMetricCommand.assertAccess 直接读取 User 被架构债棘轮拒绝，
不是存量债；不改任何架构债基线。原语显式使用 caller tx，只读 ACTIVE/未软删身份的五个安全字段；
命令协调器锁后仍重读并照旧 rbac.can(...tx)，不新建事务、不取隐式锁，不改旧 User API 或权限规则。
接线后本地验证（2026-09-06）：
- 新属主原语与命令收据单测 15/15；完整 quick 通过，308 suites / 7160 tests，既有 5 todo 保留。
- HTTP/真实并发 23/23，新增禁用、软删、降级三种锁等待中身份失效后拒绝旧收据重放的 PostgreSQL 正反例；收据 migration 与既有 RBAC/角色/审计/活动权限回归 117/117。
- 完整 contract 996/996、2/2 snapshots；旧路径与旧 schema 再次深比较零变化。docs:refresh 二次幂等、FROZEN 派生读数同步。
- 冷 lint（NODE_OPTIONS=--max-old-space-size=6144）与 build 通过；guards/eslint/hooks 串行自测通过，hooks 68/68，事故回放真触发 14/14、结构断言 12/12。
- 架构 metadata/debt/new-debt/ids 四闸通过；新增架构违规为 0，基线未改。14 份 migration 计数声明均为 111，原 13 份只发生已授权计数与 D1 清理语句变化。
- 权限说明绑定及审计登记检查通过：250 个权限码，159 个审计事件总计 / 154 活跃。权限管辖面历史基线条目均未改，仅新增三码。
- 重签前 cutover:check:signoff 实跑拒绝 3b/4b 旧对拍：migration-total=111；seed-sha256-12=76f7d81e6d82；Audit 159/154。当时未替维护者重签。

### 3b/4b 重签（2026-09-06 已批准）

维护者明确确认「确认重签 3b（C1 D2a，第111条 migration）」及「确认重签 4b（C1 D2a：权限码250；Audit events 159总计、154活跃）」。
据此只更新 CUTOVER_SIGNOFF 的 3b/4b 当前理由、日期、依据与对拍，保留此前签字历史：migration-total=111、seed-sha256-12=76f7d81e6d82、字典 30 types / 277 items、Audit 159 总计 / 154 活跃。该确认不包含合并或生产部署。
重签后 `pnpm cutover:check:signoff` 通过：71/71 正对照、10 条签字逐项对拍一致；`docs:counts:check`、`docs:readtax:check` 及冻结台账 6 项测试通过。签字检查通过不等于满足开闸条件。

本次仍未完成：PR CI 冷跑、可信红区审批、合并与后续台账收口；阶段性跨模型复审按维护者决定延后，整体复审仍未通过。C1、D2b/D2c 与生产边界不变。
