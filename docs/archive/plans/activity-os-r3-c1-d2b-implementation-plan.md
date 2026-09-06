# Activity OS R3 / C1 D2b：实施与授权清单（方案 A，待实施拍板）

> 2026-09-06。维护者已确认「C1 D2a 台账更正方案 A；起草 C1 D2b 实施与授权清单」。
> 本文起草已授权，**D2b implementation 尚未授权**。本文不是执行指令、红区令牌、合并或生产授权。
> 调查基点：main `48aae003beb4a7b44c34cce9191ea66faae2cbdc`，版本 0.72.0。
> C1 D2 总体方案 A 已批准（#1279）；D2a 已随 #1280 合入。旧冻结稿保留当时状态，不回改。
> 本次 PR 是 A 档 docs-only；未来实施为 D 档，单条 schema lane、单个 implementation PR。整体跨模型复审仍延后，不记为通过或永久豁免。

## 1. 人话简报

让获授权真人维护全局 Template V3，并在草稿活动中明确选择指标集，或明确声明不要求指标。
快速、专业、紧急创建及 Series/clone 都必须接住该事实；只做一条创建链不算交付。
D2b 不写成果值、不接新提案 v7、不移除 Readiness 指标 blocker；D2c 完成前不能宣布 C1 完成或进入 C2。

推荐方案 A：在已有 D1/D2a 模型上 additive 扩展选择与收据，新增 V3 分支及最小管理入口。
旧 V1/V2、v2–v6、八种目录命令和旧创建请求继续保持原合同。
方案 B：新建另一套选择/模板收据与独立授权算法；重复持久化协议和判权真相，不推荐。
本文将同事务 scoped 判权的真实依赖列入预算，不以只有 GLOBAL 的 D2a runner 代替活动 scope 判定。

| 风险项 | 本次 docs-only / 未来 D2b |
|---|---|
| schema | 本次无；未来 Activity 四列、集版本复合 unique、收据两列与 FK |
| migration | 本次无；未来拟新增一条，第 112 条以实施现场实际计数为准，不改历史 SQL |
| seed | 本次无；未来仅两条 Human 模板权限，不分配内建角色、不写正式业务内容 |
| 现有数据 | 新增列默认保持旧活动 unconfigured；旧收据原样保留，无回填或旧数据重解释 |
| 不可逆 | 不删表列或业务行；新格式写入后回退须保留兼容读者，不能仅回滚到 V1/V2 二进制 |
| API / contract | 新增 12 operations / 9 paths；两种创建 DTO 增可选字段，旧请求响应不改 |
| 鉴权 / audit | scoped Authz 的最小 tx 透传、两权限、两审计事件；不改变三源判权政策 |
| BizCode | 拟新增 9 个活动域错误，见 §7；不是本次已分配 |
| 需要拍板 | D2b implementation、精确红区及测试库；实际 3b/4b、可信审批、合并、生产各自独立 |

## 2. 已核验事实与入口

| 代码锚点（均相对调查基点） | 已有能力 / D2b 后果 |
|---|---|
| `prisma/schema.prisma` 的 ActivityMetricCommandReceipt | 仅 definitionId/setVersionId；111 SQL 只允许八操作、schemaVersion=1 的六字段结果 |
| `activity-metric-command.ts:16,33,106` | 旧八操作 runner/解析器已有锁后重验；保持旧分支，不给活动选择套 GLOBAL-only 权限 |
| `activity-from-template.service.ts:278,315,325,579` | B6/Series 共用根事务物化，当前仅 V1/V2；新增 V3 显式分发，旧 hash 分支不动 |
| `activity-template-definition-v2.ts:64` | V2 复用 V1 和 governed 表单纯函数；V3 独立白名单，不能扩大旧解析器 |
| `activity-creation-command.ts`；professional/emergency writer | command 显式映射与 hash；新字段缺省须完全不进入旧 hash |
| `activity-series.service.ts:336`；`activity-lifecycle.service.ts:330,473` | Series 复用模板物化；clone 有独立创建事务，不能只改模板 service 就称两者接通 |
| `activity-access.service.ts:199,358` | 当前 scoped 授权和草稿属主检查已有口径，但 assertCanOrThrow 没有 tx 参数 |
| `authz/authz.service.ts:229,337,584`；`resource-resolver.service.ts:54` | explain/can、三源 grant、角色含码、资源祖先链当前通过独立 PrismaService 读 |
| `permissions/rbac.service.ts:211`；`users/app-identity.resolver.ts:34` | 角色含码与 App Member 解析未接受 tx；只改上层签名会形成伪同事务 |
| `activity-initiation-policy.ts:29,52` | 组织/Member 已可传 client，但 override/cross-org 权限仍走默认客户端，需显式透传 |
| `activity-publish-proposal-v2.service.ts:236,1546,1700` | v6 metricSetPointer 仍固定 null；D2b 不改它 |
| `activity-publish-readiness.service.ts` | 指标 blocker 仍在；本步不提前宣称可发布 |
| [#1280](https://github.com/BA7IEE/srvf-nest-api/pull/1280) | 111 migrations、250 权限、Audit 159/154；18 checks 及合并后 main CI 全通过 |

CHANGELOG 当前首个版本节为 v0.72.0，无 Unreleased 标题；后续功能碎片尚未发版，本步不借机 release。
行号只定位候选；实施时按上述符号及引用链复核。蓝图是需求来源，不是数据库或生产授权。

## 3. 数据与收据合同

### 3.1 Activity 选择三态

| 对外状态 | 持久化与修改规则 |
|---|---|
| unconfigured | metricRequirementCode / selectedMetricSetVersionId / selectedMetricSetDefinitionHash 全 NULL，revision=0；旧活动和省略新字段的创建保留此态 |
| not_required | code=not_required，两个指针 NULL；必须由显式真人命令或精确 V3 模板产生 |
| required | code=required，setVersionId 和 64 位小写 hash 全非空；指向同一精确集版本 |

新增 `metricSelectionRevision Int @default(0)`，非负；显式初选/模板配置物化记 1。
草稿 PUT 每次新的成功命令（即使选择内容相同）revision+1；同 key 重放不增加。
不提供“重置为 unconfigured”命令。revision 使用正整数范围，溢出拒绝，不复用或回绕。

新输入 `metricSelection` 精确两键：`metricRequirementCode` 与 `metricSetPointer`；
not_required 的 pointer 显式为 null，required 的 pointer 为 §3.2 五键对象。
模板与两种创建使用该相同领域形状，Admin/App DTO 仍独立定义；不接受 unconfigured、未知键或省略 pointer。

集版本增加 `@@unique([id, definitionHash])`；Activity 使用两列真实 Restrict FK，
不以字符串 hash、应用层查到过或只锚 id 代替同版本证明。CHECK 用 IS TRUE 显式封住 NULL 三值逻辑。
旧业务列、旧模板、旧 Activity 请求与旧收据不得 UPDATE/回填；新增列默认不是业务内容初始化。

### 3.2 扩展已有领域收据，不改旧八操作合同

在 ActivityMetricCommandReceipt 增 nullable `templateVersionId`、`activityId` 两个目标列与 Restrict FK。
操作闭集扩为 13：原 8 + create/update/activate/retire_template_version + select_metric_set。
四类目标仍恰好一个非空；未知操作、交叉目标、多目标、缺目标均拒绝。
同一条新 migration 替换 target/result CHECK，并完整保留旧八操作谓词；111 SQL 文件不改。
现有唯一键、requestHash/key 规则及 append-only trigger 不放宽，旧八操作结果解析器不泛化。

| 新收据族 | 精确结果白名单 |
|---|---|
| template version 四操作 | id、code、version、schemaVersion（恒 3）、statusCode、definitionHash；id 等于 templateVersionId，状态与操作一致 |
| select_metric_set | activityId、metricRequirementCode、metricSetPointer、metricSelectionRevision；activityId 等于 FK，revision 为正整数，mode 仅 not_required/required |
| required 的 pointer | id、code、version、schemaVersion（恒 1）、definitionHash 五键；其余模式 pointer=null |

SQL 与应用解析器均验证键集合、类型、ID 目标、状态与 hash；不得只检 JSON 是 object。
最小结果不带题干、配置全文、名单、答案、附件 URL、凭据或 operationKey。
不得让扩展 CHECK 接受旧操作配新目标/新结果；旧收据迁移前后逐字不变，旧幂等仍可重放。

模板 Family 首建与首个 V3、收据、审计同事务；收据锚 Version，无半成品 Family。
初始选择由现有创建/Series 重放协议或 clone 事务拥有，不为内部物化再造外部命令 key。
相同 key 在新主体权限或目标资格失效后不能绕过当前准入；历史重放返回原结果，不强行要求旧集仍可新选。

### 3.3 migration 与停机边界

拟定路径：
`prisma/migrations/20260906114906_activity_os_r3_c1_metric_selection_template_v3/migration.sql`。
当前仅列入预算，文件不存在；一条 SQL 事务覆盖所有新增列、索引、FK、CHECK 调整。
不拆第二条 migration、不修改已合入 110/111；需要拆分或碰历史 SQL 时重新报告。
FK/index/constraint 显式命名且不超过 PostgreSQL 63 bytes。
既有 19 个 schema drift SQL 块不属于本步修复；只读 diff 按基点对照，新增漂移必须为零。

## 4. Template V3 与五条物化链

V3 根只允许 activity、sessions、registrationForm、metricSelection。
前三项由 V2→V1 与表单纯函数解释；新 metricSelection 只允许 not_required 或 required 精确指针。
保持 V1/V2 parser/canonical/hash 逐字行为；V3 用同一 envelope 算法但 schemaVersion=3，不能覆盖旧版本。
指标集及每个定义 active、配置解析合法、集闭包 hash 重算一致才可新选；历史解释可接受 retired。
模板有效期沿 A6 已拍板的元数据结构口径（合法日期、from 非空、to>from），不暗加本机时间 Gate。
“可新选”不宣称已实现独立的时间可见性策略，旧 A6 时间规则不在本步重开。

Human 管理只覆盖全局 Family：scopeTypeCode=global、ownerOrganizationId=NULL、statusCode=active。
首次请求带 code/name/categoryCode/activityTypeCode/version、完整 V3；Family 与 Version code 对齐。
已有 Family 新版本须带 familyId 和显式 version；不得 max(version)+1、移动归属、覆盖旧 Version。
draft V3 可整份编辑与激活/退役；身份及激活后的内容沿 A3 冻结。
激活必须复验分类/业务类型、窗口、完整配置、表单治理及指标引用；敏感题目仍逐题审批后启用，
本步不新增审批表/允许列表，不把解析器能解析敏感元数据当作已获使用批准。

复制来源是显式 `copyFromVersionId + expectedSourceDefinitionHash`，只读可见全局 Family 的 V1/V2/V3，
禁止把 legacy familyId=NULL 或组织模板偷偷纳入治理。
创建选择两种互斥形状：完整 V3 definition，或精确来源 + 显式 metricSelection。
来源 V1 映射 registrationForm=null，V2/V3 保留原表单；来源内容只读，服务端组装新 V3 并重新算 hash。
两种形状均不支持自由 JSON patch；来源、Family、版本、完整语义与指针参与请求 hash。

| 物化链 | 必须为真的结果 |
|---|---|
| A6 from-template / B6 quick | V3 同根事务复制选择，保留 selectedTemplateVersionId；V1/V2 仍 unconfigured；旧 key 重放不重新物化 |
| B6 professional | 新可选 metricSelection 显式提供才参与新 hash、同事务验证/写入；缺省旧 hash 与响应逐字不变 |
| B6 emergency | 同上；缺省允许 unconfigured。选择不是成果完成，七项事后义务及紧急起源正式发布禁令不变 |
| A7 Series | 新 revision 验证精确 V3；每个新实例复验并冻结选择，重放不修改既有实例，旧 revision/已生成实例不跟随目录变化 |
| 普通 clone | 从当前来源选择复制到新 draft；unconfigured 保留，已配置选择重验可新选并从 revision=1 起；不复制成果/审核/收据，不新增 clone 幂等协议 |

统一锁序：命令 advisory 锁 → 已存在的 Activity 或 Template 根锁 → 指标集锁 → 按 ID 排序的定义锁。
Series 原父锁在外层，仍经现有模板物化入口；clone 先锁 source Activity。
新建 Family 竞争由精确唯一键/P2002 处理；读取复制来源按 ID 稳定排序锁模板，不能形成反向锁序。
等待任一业务锁后，在同一 tx 中重新读当前身份和权限，不使用锁前 user/Member/grant 快照替代。
模板/集退役与新实例物化用 PostgreSQL 真竞态验证；退役不级联删除选择，也不影响历史解释。

## 5. 权限、可见性、事务真实闭包

新增两码：`activity-template.read.catalog`（LOW）和 `activity-template.manage.version`（HIGH）。
均 Human/GLOBAL、CUSTOM_ROLE_ALLOWED，Service/Delegated eligibility=false；read/write 不互相隐含。
只允许既有真人自定义角色配置，seed 不加 RolePermission、内建角色、RoleBinding 或 PositionRolePolicy。
权限预计 250→252；审计新增 `activity.metric-selection.command` 和
`activity.template-version.command`，预计 159→161 / active 154→156。字典仍 30/277。
这些是预算，不预签；实施后重新核对 seed 指纹与实际 3b/4b。
新事件的 resourceType 分别固定为 `activity`、`activity-template-version`，resourceId 分别锚 Activity、Version；
沿既有 AuditRecorder 写入，不创建新的审计资源模型或目录查询面。

活动 PUT：当前 Human 身份 + Activity scope 的 activity.update.record + 既有 managed 责任/草稿属主规则，
不因为是 Admin 或持有模板管理码直通；App 每次还要 ACTIVE Member，缺 member 不可进入。
Admin GET 沿现有活动可见性，App GET 沿 managed 目标可见性；不把全局目录读权变成活动读权。
先权限/可见性再展示不存在信息，延续现有 30100/403 与 404 顺序；新模块不重开旧管理员例外。
锁后检查 draft、expected revision、无 pending publish review；非 draft 不能通过本接口修改。
已发布变更只留 D2c 的 v7 正式审核链，旧 PATCH/直发/提案不接受本步新字段。

拟定的最小 tx 扩展，须随 implementation 一并拍板：

- AuthzService.can/explain 可选 tx；其调用的 collectGrants、loadOrgActiveStates 全链使用同一 client。
- ResourceResolverService.resolve 及调用到的资源/祖先链查询可选 tx，递归委派不掉回默认 PrismaService。
- RbacService.getRoleIdsWithPermission 增可选 tx；无 ref 分支调用已有 rbac.judge(...tx)。
- ActivityAccessService.assertCanOrThrow、ActivityInitiationPolicy 的 override/cross-org 判权透传 tx。
- AppIdentityResolver.resolve 增可选 tx；先复用 User 属主 loadActiveUserIdentityInTx 得到当前 user，再解析 Member。
- 默认参数为空时旧三源、任期、scope、ActionConstraint、reason、SUPER_ADMIN 和无 ref 降级语义不变；
  不全仓批改消费者，不新建事务/缓存/隐式锁，不改 explain/effective-permission HTTP 面。
- 旧 Authz/RBAC/资源解析/身份 characterization 必须先过；新 tx 用例验证所有 delegate 来自 caller tx，
  并覆盖等待锁时撤权、角色软删、Member 禁用、发起人/组织状态变化。只给最外层一个 tx 参数不算完成。

审计只记 actor、目标、operation、前后状态/revision/hash、固定来源码与规范化 request metadata。
初始配置的来源由模板指针或创建/clone 同事务的最小 selection 审计留下；重放不重复审计。
不得在审计中写选择配置全文、复制源题干、结果值或 operationKey。

## 6. 12 个新增操作与 DTO 矩阵

Admin/Application DTO 分开定义，不 extends/Pick/Omit Admin DTO；领域纯函数可共用。
统一全局 JWT、结构化声明、IdParamDto 等价参数校验与 ApiWrapped 响应，不新增 Guard/alias/surface。
两种创建 DTO 仅新增可选 metricSelection，显式 null/非法形状拒绝；缺省不生成新 hash 字段。
旧创建响应不扩字段，新选择结果从专用 GET 读取。

| 方法 / canonical path | 输入与输出 | 判权 / 操作 |
|---|---|---|
| GET /api/admin/v1/activity-template-versions | page/pageSize、familyId/status/schema 过滤；Family/Version 白名单摘要 | template.read.catalog |
| GET /api/admin/v1/activity-template-versions/:id | V3 详情；来源 V1/V2 只读且按 schema 分型，不返回 legacy/组织 Family | 同上 |
| POST /api/admin/v1/activity-template-versions | operationKey、Family/version、完整 V3 或复制形状；六字段收据，201 | template.manage.version；create_template_version |
| PUT /api/admin/v1/activity-template-versions/:id/draft | operationKey、expectedDefinitionHash、完整 V3，200 | 同上；update_template_version |
| POST /api/admin/v1/activity-template-versions/:id/activate | operationKey、expectedDefinitionHash，200 | 同上；activate_template_version |
| POST /api/admin/v1/activity-template-versions/:id/retire | 同上 | 同上；retire_template_version |
| GET /api/app/v1/my/managed-activities/metric-set-options | organizationId、page/pageSize；仅可新选集的五字段指针/name | app-member + 现有可发起该组织资格，不返 draft/原始权限码 |
| GET /api/app/v1/my/managed-activities/template-version-options | 同上；可新选全局 V1/V2/V3 摘要，V3 的指标引用必须可新选 | 同上，非全局目录读权 |
| GET /api/app/v1/my/managed-activities/:activityId/metric-selection | 三态、revision、历史指针解释、可新选标志 | app-member + managed 目标可见性 |
| PUT 同一路径 | operationKey、expectedRevision、显式选择；四字段收据，200 | managed + activity.update.record scoped；select_metric_set |
| GET /api/admin/v1/activities/:id/metric-selection | 同语义独立 Admin DTO | 既有 Activity 可见性 |
| PUT 同一路径 | 同语义独立 Admin DTO，200 | Activity scope + managed 规则；select_metric_set |

列表默认 1/20、上限 100，createdAt DESC/id DESC；过滤可新选资格必须先于分页/count，
不能分页后滤掉无效项却仍报未过滤的 total。集项/定义闭包有 D1 上限，禁止全库拉取或无界循环。
静态 options 路由必须先于已有 :activityId 捕获，真 HTTP 测试确认无路径冲突。
新增三个 Controller：Admin 模板、Admin 选择、App managed 指标。现有路由保持原 method/path/tag/权限，
创建控制器仅补新增错误声明；Open/Integration/System 不增加入口。

## 7. 拟新增错误码（实施前再次验号）

| Symbol / 数字 | message / HTTP | 用途 |
|---|---|---|
| ACTIVITY_METRIC_SELECTION_INVALID / 20174 | 活动指标选择无效 / 400 | 模式、指针与 revision 形状错误 |
| ACTIVITY_METRIC_SELECTION_STALE / 20175 | 活动指标选择已变化，请刷新后重试 / 409 | expectedRevision 冲突 |
| ACTIVITY_METRIC_SELECTION_COMMAND_CONFLICT / 20176 | 此操作标识已用于其他指标选择 / 409 | 同 key 异请求 |
| ACTIVITY_METRIC_SELECTION_RECEIPT_INVALID / 20177 | 活动指标选择收据无效 / 409 | 持久收据不合法，停止重试 |
| ACTIVITY_TEMPLATE_DEFINITION_INVALID / 20178 | 模板定义无效 / 400 | 新 V3 完整定义错误 |
| ACTIVITY_TEMPLATE_VERSION_NOT_FOUND / 20179 | 模板版本不存在 / 404 | 已授权后仍无目标 |
| ACTIVITY_TEMPLATE_VERSION_ALREADY_EXISTS / 20180 | 模板族或版本已存在 / 409 | 精确 Family/code/version P2002 |
| ACTIVITY_TEMPLATE_VERSION_STALE / 20181 | 模板版本已变化，请刷新后重试 / 409 | expected hash 冲突 |
| ACTIVITY_TEMPLATE_COMMAND_CONFLICT / 20182 | 此操作标识已用于其他模板命令 / 409 | 新模板命令幂等冲突 |

复用 20172 表示指标引用不可新选、20171 表示目录 lifecycle 非法、20173 表示模板六字段收据损坏；
活动非 draft、待审、不可见、身份/权限拒绝复用各自既有错误，不新造认证码。
旧 A6 模板不可选错误不改。P2002 只按已知唯一约束精确转换，不把任意数据库故障包装成冲突。
本次未写 BizCode；九个数字在调查基点未占用，未来有并发占号须上报新表，不盲挪号。

## 8. 精确实施写集预算（不是本次 docs-only 写集）

当前已逐项核验 80 个现有路径存在、44 个新增路径不存在，共 124。
每个路径只允许本稿说明的局部用途，不是对整个模块的任意改动许可。
新增 1 条 migration；已有 14 份 migration E2E 只允许同步当前计数，不改变行为断言/清理口径。
源码/单测只能实现本文合同；contract/OpenAPI/client 按逐行差值生成。
permissions 管辖基线只加两条新码，holders 仅精确两码人工授予例外，guards 自测只改对应 250→252 计数。
domain-map/state-machines 只更新本步模型归属/hash/真实 writer；不升级/放宽架构债基线。
Authz/身份新增 spec 专门覆盖 tx；无授权改变旧 e2e 断言。D2a 八操作实现与 parser 不在写集。
3b/4b 签字文件虽然列入后续差值写集，仍须维护者另行明确重签后才能写；不是预签。
本冻结稿不在实施写集内，合入后不回改；实施证据记录在 PR 和获批当前台账。

### 8.1 现有路径

```text
prisma/schema.prisma
prisma/seed.ts
prisma/CLAUDE.md
src/modules/activities/activities.module.ts
src/modules/activities/CLAUDE.md
src/modules/activities/activity-from-template.service.ts
src/modules/activities/activity-from-template.service.spec.ts
src/modules/activities/activity-creation.service.ts
src/modules/activities/activity-creation.service.spec.ts
src/modules/activities/activity-creation-command.ts
src/modules/activities/activity-creation-professional.ts
src/modules/activities/activity-creation-emergency.ts
src/modules/activities/activity-creation-dto.spec.ts
src/modules/activities/activity-series.service.ts
src/modules/activities/activity-lifecycle.service.ts
src/modules/activities/activity-access.service.ts
src/modules/activities/activity-initiation-policy.ts
src/modules/activities/activity-initiation-policy.spec.ts
src/modules/activities/controllers/app-managed-activity-creation.controller.ts
src/modules/activities/dto/app/app-managed-activity-creation.dto.ts
src/modules/activities/dto/app/app-managed-activity-creation-professional.dto.ts
src/modules/authz/authz.service.ts
src/modules/authz/resource-resolver.service.ts
src/modules/authz/CLAUDE.md
src/modules/permissions/rbac.service.ts
src/modules/permissions/rbac.service.spec.ts
src/modules/permissions/permission-catalog.ts
src/modules/permissions/seed-permission-codes.ts
src/modules/permissions/permission-code-holders.spec.ts
src/modules/permissions/CLAUDE.md
src/modules/users/app-identity.resolver.ts
src/modules/users/CLAUDE.md
src/modules/audit-logs/audit-logs.types.ts
src/common/exceptions/biz-code.constant.ts
harness/domain-map.json
harness/state-machines.json
harness/permission-surface-baseline.json
scripts/harness-guards.selftest.ts
test/contract/openapi.contract-spec.ts
test/contract/__snapshots__/openapi.contract-spec.ts.snap
docs/current-state.md
CODEMAP.md
docs/ai-harness/ROUTE_AUTHZ.md
docs/ai-harness/RBAC_MAP.md
docs/ai-harness/AUDIT_EVENT_REGISTRY.md
docs/ai-harness/STATE_MACHINE_INVENTORY.md
docs/ai-harness/FROZEN_DRAFTS.md
docs/ai-harness/NEXT_TASKS.md
docs/ai-harness/CUTOVER_SIGNOFF.md
docs/handoff/openapi.json
docs/handoff/admin-web.md
docs/handoff/miniapp.md
docs/ops/activity-metric-catalogue-rollout.md
test/e2e/activity-os-r3-c1-d2a-metric-command-receipt-migration.e2e-spec.ts
test/e2e/activity-v11-batch4-allocation-mode-migration.e2e-spec.ts
test/e2e/activity-v11-batch4-allocation-command-replay-migration.e2e-spec.ts
test/e2e/activity-v11-batch4-allocation-determinism-migration.e2e-spec.ts
test/e2e/activity-os-r2-b3-form-blueprint-governance.e2e-spec.ts
test/e2e/insurance-evidence-registration-revision-migration.e2e-spec.ts
test/e2e/activity-v11-batch4-qualification-contract-migration.e2e-spec.ts
test/e2e/activity-os-r2-b1-place-schema-constraints.e2e-spec.ts
test/e2e/activity-v11-batch4-allocation-candidate-position-anchor-migration.e2e-spec.ts
test/e2e/activity-os-r1-a3-template-definition-lifecycle-guards.e2e-spec.ts
test/e2e/activity-os-r1-a4-explicit-template-version-pointer.e2e-spec.ts
test/e2e/activity-os-r3-c1-metric-definition-set.e2e-spec.ts
test/e2e/activity-os-r2-b6-creation-data-foundation.e2e-spec.ts
test/e2e/activity-os-r2-b2-coordinate-projection-schema-constraints.e2e-spec.ts
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
```

### 8.2 新增路径

```text
prisma/migrations/20260906114906_activity_os_r3_c1_metric_selection_template_v3/migration.sql
src/modules/activities/activity-metric-selection.ts
src/modules/activities/activity-metric-selection.spec.ts
src/modules/activities/activity-metric-selection-access.ts
src/modules/activities/activity-metric-selection-access.spec.ts
src/modules/activities/activity-metric-selection.service.ts
src/modules/activities/activity-metric-selection.service.spec.ts
src/modules/activities/activity-metric-selection-query.service.ts
src/modules/activities/activity-metric-selection-query.service.spec.ts
src/modules/activities/activity-metric-selection-presenter.ts
src/modules/activities/activity-metric-selection-presenter.spec.ts
src/modules/activities/activity-metric-selection-audit-recorder.ts
src/modules/activities/activity-metric-selection-audit-recorder.spec.ts
src/modules/activities/activity-template-definition-v3.ts
src/modules/activities/activity-template-definition-v3.spec.ts
src/modules/activities/activity-template-version-command.ts
src/modules/activities/activity-template-version-command.spec.ts
src/modules/activities/activity-template-version.service.ts
src/modules/activities/activity-template-version.service.spec.ts
src/modules/activities/activity-template-version-query.service.ts
src/modules/activities/activity-template-version-query.service.spec.ts
src/modules/activities/activity-template-version-presenter.ts
src/modules/activities/activity-template-version-presenter.spec.ts
src/modules/activities/activity-template-version-audit-recorder.ts
src/modules/activities/activity-template-version-audit-recorder.spec.ts
src/modules/activities/controllers/admin-activity-template-versions.controller.ts
src/modules/activities/controllers/admin-activity-metric-selection.controller.ts
src/modules/activities/controllers/app-managed-activity-metrics.controller.ts
src/modules/activities/dto/admin/activity-template-version.dto.ts
src/modules/activities/dto/admin/activity-metric-selection.dto.ts
src/modules/activities/dto/app/app-activity-metric-selection.dto.ts
src/modules/activities/dto/app/app-activity-metric-options.dto.ts
src/modules/activities/dto/admin/activity-template-definition-v3.dto.ts
src/modules/authz/authz-transaction.spec.ts
src/modules/authz/resource-resolver-transaction.spec.ts
src/modules/users/app-identity-transaction.spec.ts
test/e2e/activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2b-template-catalogue.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2b-metric-selection.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2b-creation-compatibility.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2b-selection-concurrency.e2e-spec.ts
test/e2e/activity-os-r3-c1-d2b-authz-transaction.e2e-spec.ts
docs/ops/activity-metric-selection-template-rollout.md
changelog.d/activity-os-r3-c1-d2b.added.md
```

## 9. 探针、测试库与验收

本次没有任何数据库授权。未来建议测试库仅 app_test、app_test_w1、app_test_w98：
app_test 只 deploy 已审查新 migration，不重建模板；w1 为定向 E2E/contract 的串行克隆；
w98 为本步独立冷回放和 111→112 非空 rehearsal 后回收。它们的重建会不可恢复地清除测试数据，
须维护者当次明确同意；旧 D2a 同名授权不能直接当成本步授权。
禁止 migrate dev/reset/db push/force-reset、生产数据、任意额外库。其它历史 migration 全量交给 CI。

| 探针 / DoD | 必须提交的直接证据 |
|---|---|
| P0 旧行为基线 | 先跑旧 Authz 三源/ref/no-ref、资源解析、App managed、B6、A6/Series/clone characterization；先记录结果再改编排 |
| P1 SQL | 空库全部 replay；111→112 含非空 Activity、旧八类收据的 rehearsal；旧业务列/结果字节不变，seed 二跑 |
| P2 DB 反例 | 三态 NULL 组合、伪 id-hash、负 revision、四目标互斥、十三操作/结果分型、FK、append-only；每种变异独立断言 |
| P3 Human V3 闭环 | 经真实 HTTP 从空新目录建定义→集→Family/V3→激活→创建活动；不用直接 SQL 预造正式目录替代入口 |
| P4 选择 | Admin/App 准入、scoped/managed、三态、pending review、非 draft、旧 key 重放/异请求、坏 hash；失败无部分写 |
| P5 创建兼容 | 旧请求/hash/收据响应零变化；V3、professional/emergency 初选、unconfigured、not_required；Series/clone 全接入 |
| P6 真竞态 | 集/定义/模板退役与新选/物化；选择 revision 冲突；等待锁中 User/Member/role/grant/组织失效；权限事务 delegate 真实闭合 |
| P7 旧审查边界 | v2–v6 和 Readiness 原行为通过；D2b 字段不由旧 PATCH/applier 侧写，不宣称整体发布语义完成 |
| P8 收口 | 本地 quick、build、定向 E2E/contract、12 docs 检查与 FROZEN 派生闸；依赖枢纽影响面执行 agent:check:full 的完整验收要求（按已批准 D2 评审与 process §3，由 PR CI 冷跑全量），精确写集 diff、3b/4b、可信审批、明确合并授权 |

本地不跑全仓 E2E；contract 与 E2E 不并行占用 w1，guards/hooks/replay 串行以免争抢授权文件。
真实并发屏障必须限定当前库或自身 PID；等待超时先查原句柄，不把超时当失败后自动重起。
冷 lint 允许沿现行 CI 使用 NODE_OPTIONS=--max-old-space-size=6144，不改依赖/CI 配置。
未通过与既有 todo 如实列出，不删除测试或放宽断言来交差。

## 10. 授权与交付边界

本次 docs-only 只写六个文件：本稿新增、FROZEN_DRAFTS 的 C1 状态/本稿登记/派生读数、
NEXT_TASKS 的 P1-33、prisma/CLAUDE 当前摘要、Admin handoff 的 D2a 状态、目录 SOP 当前状态。
不修改任何旧冻结稿、业务代码、schema/SQL/seed/contract、配置或测试；不发 release。

本稿合入后，维护者如认可全部实施合同（包括 tx 闭包）可确认：
`确认 C1 D2b implementation 方案 A（按本清单精确写集；不含 D2c、生产或合并）`。
随后以该 docs PR 合入后的最新 main 为开工基线，复核代码仍对应调查事实及以下精确授权命令。
本稿的调查 commit 不是要求从旧 main 开分支；不得跳过当前 preflight。

调查基点由真实 judge 对 124 路径逐项判定，命中 16 条红区/执法层路径。下列命令仅供
**批准 implementation 后由维护者执行**，不因列入文档而取得授权；本次 AI 不运行。

```sh
cd /Users/dengwang/Documents/coding/srvf-nest-api
pnpm harness:grant 'prisma/schema.prisma' --reason 'C1 D2b implementation 方案 A；本稿及当次确认'
pnpm harness:grant 'prisma/seed.ts' --reason 'C1 D2b implementation 方案 A；本稿及当次确认'
pnpm harness:grant 'prisma/migrations/20260906114906_activity_os_r3_c1_metric_selection_template_v3/migration.sql' --reason 'C1 D2b implementation 方案 A；本稿及当次确认'
pnpm harness:grant 'src/modules/authz/authz.service.ts' --reason 'C1 D2b implementation 方案 A；仅 tx 透传'
pnpm harness:grant 'src/modules/authz/resource-resolver.service.ts' --reason 'C1 D2b implementation 方案 A；仅 tx 透传'
pnpm harness:grant 'src/modules/authz/CLAUDE.md' --reason 'C1 D2b implementation 方案 A；仅 tx 当前事实'
pnpm harness:grant 'src/modules/authz/authz-transaction.spec.ts' --reason 'C1 D2b implementation 方案 A；新 tx 测试'
pnpm harness:grant 'src/modules/authz/resource-resolver-transaction.spec.ts' --reason 'C1 D2b implementation 方案 A；新 tx 测试'
pnpm harness:grant 'src/modules/permissions/permission-catalog.ts' --reason 'C1 D2b implementation 方案 A；仅两条模板权限'
pnpm harness:grant 'harness/domain-map.json' --reason 'C1 D2b implementation 方案 A；新增模型归属，不放宽债基线'
pnpm harness:grant 'harness/state-machines.json' --reason 'C1 D2b implementation 方案 A；真实 writer 与 hash'
pnpm harness:grant 'harness/permission-surface-baseline.json' --reason 'C1 D2b implementation 方案 A；仅两条新码管辖'
pnpm harness:grant 'scripts/harness-guards.selftest.ts' --reason 'C1 D2b implementation 方案 A；仅权限 250→252 计数'
pnpm harness:grant 'test/contract/openapi.contract-spec.ts' --reason 'C1 D2b implementation 方案 A；新接口白名单，不放宽旧断言'
pnpm harness:grant 'test/contract/__snapshots__/openapi.contract-spec.ts.snap' --reason 'C1 D2b implementation 方案 A；仅已审查契约差值'
pnpm harness:grant 'docs/ai-harness/ROUTE_AUTHZ.md' --reason 'C1 D2b implementation 方案 A；新接口派生声明'
```

先按 §8 的真实路径逐项运行红区判据并消费真实 grant file，不能把 --hook 的 exit 0/HIT 或
harness:needs 的“请授权”提示当作已授权；不发 prisma/**、harness/** 等宽授权。
本次不发放或消耗 D2b 令牌，不执行上述模板命令。

独立待办：测试库实时同意；SQL 实际差值 3b；权限/seed/Audit 实际差值 4b；可信红区审批；每个 PR 合并。
跨模型复审按维护者决定统一延后，但不是免审；本步也不启动无人值守模型调用。
D2b/V3 只完成选择与模板语义，D2c/v7 完成前不得作为可独立生产发布的闭环。
新格式回退停新写并保留兼容读者、版本与收据，不清库；正式内容/人员授码/前端发布/生产另批。

## 11. 本次未做

未实施 D2b/D2c；未创建 112 migration、V3、活动选择、模板权限/审计、正式目录内容。
未改旧代码或断言，未跑数据库，未重签或代批任何权限，未启动模型复审、Gate、生产或 release。
C1 总体和全蓝图均未完成。D2b 尚待 implementation 拍板，不能把本文当已授权无人值守 goal。
