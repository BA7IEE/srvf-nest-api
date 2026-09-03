# Activity OS R2 / B3 模板报名表蓝图复制与数据治理评审记录

> **状态：维护者已于 2026-09-03 确认方案 A；本稿只冻结 B3 的边界与后续授权预算。** 本决定不授权 Prisma schema、migration、测试基础设施、运行时代码、接口或生产部署。
>
> **上游约束**：[Activity OS T0-A 终态合同](activity-os-t0-terminal-review.md) §6.2；原始《SRVF 活动域终态蓝图与分阶段落地方案》§9。原始蓝图在这里仅作为业务需求来源，不能覆盖仓库红区、迁移、生产部署和维护者拍板流程。

## 1. 拟议结论

建议采用方案 A：为未来模板 Version 新增**严格的 Definition V2**，把报名表蓝图复制为
Activity 自己的 draft `RegistrationFormVersion`，并在既有 `RegistrationFormField` 上保存可追溯的
治理元数据。B3 复用现有报名表四张正式表，不再建一套 TemplateForm / FormBlueprintAnswer 等平行系统。

本仓的技术映射要先说清：蓝图中的 `ActivityTemplateVersion` 对应现在
`ActivityTemplate` 上 `familyId IS NOT NULL` 的 Version 行；它不是另一个物理模型。B3 只接受
新的 `schemaVersion = 2` Version，既有 V1 的 JSON、hash、选择逻辑和已创建活动保持原样。

方案 A 的最小可交付是：

1. V2 的 `registrationForm` 只能是 `null` 或一份严格白名单的表单定义；它只包含题目定义与治理元数据，不含答案、附件、上传会话、审核记录或任何队员档案值。
2. V2 完整保留既有八种 `typeCode`：`short_text`、`long_text`、`number`、`date`、`single_choice`、`multi_choice`、`file`、`confirmation`。题型只决定既有的输入、存储和校验形状，**不能**被误当作数据敏感级别；同一题型可因题目内容而属于不同数据级别。
3. 从模板创建活动时，在 A6 已有的同一 Activity 根事务中创建该活动的 draft Form v1；Series 复用同一 materializer，因此每一期得到自己的 Form v1，绝不共享或回指模板的 Form 行。
4. 已有的 `RegistrationFormVersion` / `RegistrationFormField` / `RegistrationFormAnswer` /
   `RegistrationUploadSession` 继续是唯一正式运行时模型。B3 只给 Field 增加元数据列，不新增答案表、预填缓存、导出表、定时清理或 AI 对象。
5. 新模板蓝图的每一题必须显式声明用途、数据级别、留存策略、掩码策略与无预填；新蓝图字段的 `exportable` 固定为 `false`。B3 不把“有一列 policy code”伪装成已经完成敏感数据合规。
6. 敏感题目没有被从终态蓝图中删除：它的创建 / 启用必须以逐题的“为何收集、谁能看且如何掩码、保存多久并由谁何时清理”作为硬前置。当前仓库尚无 Activity Form 敏感答案读面、真实掩码输出或留存清理 SOP，且 B3 不开模板写接口；因此 B3 只落下完整题型、治理元数据和复制地基，**不授权任何敏感题目进入可用 writer 或运行时读面**。这项敏感启用门槛须在后续 B3-S 补充评审中逐项闭合，不能被“ordinary-only 题型白名单”悄悄替代。
7. 从模板复制出的 Form 仍是活动负责人可编辑、且会进入既有发布审核 Form target 的正式对象。因此 B3 必须同步扩展**既有** managed Form GET / PUT 与发布变更审核的表单契约，使其能完整读写 governed definition；不能让旧的无治理字段请求把刚复制的治理信息悄悄覆盖。这个受控契约变更不新增模板管理 HTTP 写接口、不新增公开读面，也不新增 endpoint。
8. 对外公开的活动详情与报名者可见 Form 继续只返回题目展示 / 校验所需字段。治理元数据只属于 managed owner / 发布变更审核的受控面，绝不因复用 canonical Form 而泄出。

这不是缩小蓝图，而是把“八种题型的蓝图复制”与“敏感数据可用前的真实保护”分别落实：前者在 B3 实施，后者保留为不可跳过的后续关口。整个 Activity OS 不能因 B3 的结构落地就宣称敏感数据治理已完成。

## 2. 已核验事实与约束

| 事实 / 风险 | 证据 | 对 B3 的约束 |
| --- | --- | --- |
| 现有四张报名表正式模型已经覆盖版本、字段、答案和上传会话 | `prisma/schema.prisma` 的 `RegistrationFormVersion`、`RegistrationFormField`、`RegistrationFormAnswer`、`RegistrationUploadSession` | 只扩展并复用；禁建第二套 Template Form、Answer 或 Upload 模型。 |
| Field 现仅有 `visibilityCode` 与 `exportable`，并无用途、分类、留存、掩码、预填来源 | `prisma/schema.prisma`；`registration-form-definition.ts` | 新元数据必须进入 canonical 定义和持久化字段，不能只挂在模板 JSON 后丢失。 |
| 现有 canonical Form hash 已被发布审核和 active Form 指针使用 | `registration-form-definition.ts`；`registration-form-version.service.ts`；`activity-publish-proposal-v2.service.ts` | 旧字段行全为空时，重建的 canonical JSON 必须逐字保持旧形状，不能因为新增 `null` 键改变旧 `schemaHash`。 |
| managed Form GET / PUT 与发布变更审核均使用不含治理字段的 `RegistrationFormDefinitionInputDto` | `dto/app/app-registration-form.dto.ts`；`registration-form-version.service.ts:75-165`；`activity-publish-review.dto.ts:403-412` | B3 必须为受控 owner / review 面引入 governed definition 输入 / 输出；否则无治理字段的旧 payload 可替换已复制的 governed Form。 |
| 公共活动详情把数据库 Field 还原的 canonical definition 直接投给 `AppRegistrationFormDto` | `app-activities.service.ts:486-491`；`dto/app/app-activity-detail.dto.ts:208-210` | 不能把治理字段直接塞进现有 `AppRegistrationFormDto`；必须保留安全公开投影，并让 managed 面使用单独 DTO。 |
| 发布审核快照 v3、v4、v5 已包含 `registrationForm: RegistrationFormTarget \| null`，且校验时重新 canonicalize | `activity-publish-proposal-v2.service.ts:226-276,515-523,1201-1217` | 不创建新的 snapshot envelope；B3 需让既有 Form target 能解析 / hash 新的 governed definition，同时历史 snapshot 的 JSON 与 hash 原样有效。 |
| V1 明确只承载无敏感信息的活动 / 场次 / 岗位蓝图，根键只允许 `activity`、`sessions` | `src/modules/activities/activity-template-definition-v1.ts:1-10,489-502` | 不能把 `registrationForm` 偷塞进 V1；必须以 schemaVersion 2 和独立解析器表达新解释。 |
| A6 的模板选择器当前只接受 active、`schemaVersion = 1`、hash 一致的精确 Version | `src/modules/activities/activity-from-template.service.ts:483-551` | B3 必须扩展为显式 V1 / V2 分派；V1 逻辑和 hash 复验不可放宽。 |
| A6 已在同一事务中物化 Activity、Session、Position，A7 复用该 materializer | `activity-from-template.service.ts:291-414`；`activity-series.service.ts:258-350` | Form copy 必须嵌入此根事务；重放不再复制，失败时 Activity / Session / Form 一起回滚。 |
| 既有活动克隆只复制 Form definition，不复制答案、附件、会话或审核历史 | `registration-form-version.service.ts:271-288` | 模板复制遵循同一数据最小化规则，并补齐治理字段的复制。 |
| 当前 CSV export 不读取 `RegistrationFormAnswer`；报名审计仅记录 revision / 数量 / request hash，不复制答案 | `activity-registrations.service.ts:489-533`；`activity-registration-audit-recorder.ts:133-166` | B3 不得顺手把字段答案放进导出、普通 Audit 或 AI 上下文；未来答案读/导出另案。 |
| 当前 migration 总数为 107，十份现存 E2E 常量写为 107 | `docs/current-state.md`；`rg '^const CURRENT_MIGRATION_COUNT = 107;' test/e2e` | B3 如实施，将成为第 108 条 migration，并同步全部十份执行位。 |
| `prisma/CLAUDE.md` 的当前摘要仍称 B2 未合入，已与 main 的 `37253af4` 冲突 | `prisma/CLAUDE.md`；`git log -1 main` | 这是 B3 外的事实更正，不能夹带进 B3；须单独取得写集和红区授权。 |

## 3. 方案 A 的精确合同

### 3.1 Template Definition V2

Definition V2 的根形状固定如下。`activity`、`sessions` 的 V1 语义不变；V2 不修改或重解释
V1 的同名字段。

```text
{
  activity: <现有 V1 activity 定义>,
  sessions: <现有 V1 sessions 定义>,
  registrationForm: null | { fields: [...] }
}
```

`registrationForm` 为 `null` 表示该模板不创建自定义报名表。非空蓝图只允许现有八种
`typeCode`：`short_text`、`long_text`、`number`、`date`、`single_choice`、`multi_choice`、`file`、
`confirmation`；每一种继续复用既有 Form runtime 的校验、存储形状和闭集约束。B3 不新增第九种题型。
未知键、任意脚本、表达式、SQL、条件跳转、动态题型一律 fail-closed。

V2 的非空 `registrationForm` 是**全表 governed mode**：每一题都必须带完整 `governance`
对象，不能在同一份 definition 中混入 legacy Field。共享 canonicalizer 仍须识别全表 legacy
mode，专供既有 Form 与其旧 hash；但 V2 蓝图本身绝不能生成 legacy mode。

每一题额外必须带完整 `governance` 对象：

| 字段 | V2 合同 | 含义 |
| --- | --- | --- |
| `purposeCode` | 受控、非空用途码，仅为 `transport_logistics`、`accommodation_logistics`、`dietary_accommodation`、`equipment_clothing`、`activity_specific_note`、`file_confirmation`；没有 `other` 兜底。 | 对应活动特有信息；不得用它重收部门、等级、性别、年龄、证书、保险或训练记录。 |
| `dataClassCode` | `ordinary` 或 `sensitive`；高敏队员档案复制不属于这两类模板输入，始终禁止。 | 分级取决于题目内容而不是 `typeCode`。`sensitive` 的存在不自动给出读、导出或清理权限。 |
| `retentionPolicyCode` | 非空受控码。普通字段可采用 `activity_lifecycle`（随该活动的报名记录，不进队员主档）；敏感字段必须引用一份已批准、写明期限和清理负责人的实际 SOP。 | B3 不新增自动删除；没有 SOP 的敏感题目不能启用。 |
| `maskingPolicyCode` | 普通字段为 `none`；敏感字段必须引用已有、可执行的读面和掩码合同，不能以孤立字符串替代。 | 当前没有这种 Activity Form 敏感读面，故 B3 不开敏感题目 writer / reader。 |
| `prefillSourceCode` | 必须为 `null` | B3 不从部门、等级、性别、年龄、证书、保险、训练记录或任何其它队员档案复制 / 预填。 |

非空 V2 蓝图还必须满足：

- `exportable` 固定为 `false`；B3 不新开字段答案导出。
- `visibilityCode` 继续显式使用当前三值闭集，不能靠缺省扩大可见范围。
- 八种既有题型均可出现在蓝图；`short_text`、`long_text`、`number`、`date`、`file` 绝不因载荷形式被一概排除。医疗、饮食禁忌、紧急联系人、证件或自由敏感说明是否可用，取决于该题的实际分级和下面的敏感启用门槛。
- 新用途、预填来源、敏感分类、掩码规则、留存期限或清理动作的任何一项，都不是“加一个字符串”即可完成，必须重新说明业务用途、查看角色与掩码、保存期限及退队处置。
- `dataClassCode = sensitive` 保留在 grammar 中，不能借 B3 删除终态分类；但 B3 的 template materialize、managed PUT 与发布变更审核都必须 fail-closed，直到补充评审同时给出该字段的用途、最小可见 / 掩码读面、留存期限、手动或自动清理动作及责任人。不得把 `activity_lifecycle` 或 `none` 套给敏感值来绕过该门槛。

这样做不是否认饮食禁忌、支持需求或文件确认场景，而是禁止在没有读面、掩码和清理执行位时把它们错误归为普通数据。普通的活动特有说明、确认、尺码、出行 / 住宿安排及不含敏感内容的文件确认仍可按题目实际内容使用全部八种既有题型。

### 3.2 Field 持久化与 hash 兼容

第 108 条 migration 只在 `RegistrationFormField` 上新增以下五个可空列：

```text
purposeCode
dataClassCode
retentionPolicyCode
maskingPolicyCode
prefillSourceCode
```

它不设默认值、不回填、不删除、不重命名、不解释旧数据。数据库约束必须使用二值、全量的
all-or-none 形状：

- 五列全为 `NULL`：仅表示 migration 前的 legacy Field，允许继续读取、报名和按原 hash 审批；
- 前四列同时非空且 `prefillSourceCode IS NULL`：表示新的 governed Field；
- 任一部分填写、非空 prefill 或不成对的治理形状：一律以具名 CHECK 拒绝；具体 code 闭集由 V2 parser / service 作为唯一解释位验证，不能在模板 JSON、Prisma 映射和 SQL 各抄一份不同目录。

运行时 canonicalizer 要把**definition-level** 的两种形状分开处理：所有 Field 都为 legacy 时，
不附加任何治理键，故旧 canonical JSON 和 `schemaHash` 不变；所有 Field 都为 governed 时，才把
每题完整 governance 对象纳入 canonical JSON 与 hash。一个 definition 混用两种 Field 必须
fail-closed。不能以“补五个 null”或“给旧行默认 ordinary”方式静默改写已激活 Form 的指纹。

### 3.3 Copy-on-create 与生命周期

创建路径固定为：

```text
锁定并校验精确 Template Version / hash
  → 创建 Activity、Session、Position
  → 从 V2 registrationForm 创建该 Activity 的 RegistrationFormVersion(v1, draft)
  → 记录现有 create-from-template 最小审计锚
```

所有步骤都位于 A6 已有的同一个事务内。Form copy 只写 definition 和治理元数据：

- 初始版本恒为该 Activity 的 `version = 1`、`statusCode = draft`、`schemaHash = null`；
- 只能由 `RegistrationFormVersionService` 新增一个接收 `tx`、目标 Activity 与已 canonical 的 V2 definition 的内部 materialize 入口落库；`ActivityFromTemplateService` 注入并调用它，不能手写 `tx.registrationFormVersion.create`，也不能调用会自开事务、带 managed 权限 / audit 语义的 `putManaged`；
- 该入口复用现有版本 / 字段建模原语，但不复制 source Activity，不触碰答案、上传会话、附件或审核历史；create-from-template 仍只保留既有最小审计锚；
- 绝不复制 `RegistrationFormAnswer`、附件、`RegistrationUploadSession`、审核历史、原始 token 或队员档案；
- A6 的 operationKey 重放优先返回既有 Activity，不能生成第二份 Form；
- A7 的每个 Series occurrence 都走同一 materializer，因此每个 Activity 持有独立的 Form v1；
- 后续活动发布仍只由既有 `RegistrationFormVersionService.applyPublishedTarget` 激活并冻结。B3 不创建或重写 Publish Snapshot envelope，不提前动 B5 的 v6；但 v3-v5 已有的 `registrationForm` target 必须能承载新 governed definition 并按其 canonical hash 校验。历史 v3-v5 JSON、hash 与在途审核单一律按 legacy shape 原样解析，v2 也不改变。

Template Version 的 hash 本身继续由 A3 的 envelope `{ definition, schemaVersion }` 计算。V2 的
hash 与 V1 不同；已有 V1 Version 仍按旧 parser、旧 hash、旧 materializer 行为运行，不能被 V2
解析器“兼容性修复”后悄悄改变。

### 3.4 受控外部契约与数据边界

B3 的治理元数据是**定义与持久化合同**，不是尚不存在的敏感数据处理系统。因为从模板复制的
Form 仍由负责人维护且会进入发布审核，治理信息不能只停在内部模型：否则既有无治理 payload 会
把它覆盖，或 canonical definition 会被误投到公开 App 面。方案 A 因此有以下**受控的既有接口
契约变更**，并以这组变更作为 D 档实现范围的一部分。

#### Managed 与发布变更审核面

- 为现有 managed registration-form GET / PUT 引入单独的 governed Form input / output DTO 族；现有
  路由、权限、鉴权声明和 `null` 表示主动移除 Form 的语义不变。GET 只向有既有 managed 权限的
  owner 返回治理元数据，PUT 才可提交它。
- managed non-null input 与 `ChangeReviewDto.registrationForm` 都只接受两种全表形状：全部字段均
  无 governance 的 legacy definition，或全部字段均含完整 governance 的 governed definition；
  混用一律拒绝。新复制的 Form 一定属于后者。
- legacy-shaped non-null PUT / 变更审核输入继续可用于 legacy Form，以保留旧客户端与旧表单；但它
  不能替换任何 governed draft / active Form。试图省略 governance 覆盖 governed Form 必须在写前
  fail-closed，保留原 Form 与其 hash。负责人的显式 `form: null` 仍是现有的、可审计的主动 retirement
  命令，不能被误写成“兼容性覆盖”。
- `dataClassCode = sensitive` 在 B3 基础实现的 managed PUT、变更审核和 template materialize 中均
  拒绝；只有 B3-S 把逐题 SOP、读面、掩码和清理责任一并落地后，才可开放对应组合。

#### 公开投影与发布快照

- `AppRegistrationFormDto`、`AppActivityDetailDto.registrationForm` 及报名者可见的 Form 投影继续
  只含题目展示 / 校验字段；它们必须显式剥离 `purposeCode`、`dataClassCode`、
  `retentionPolicyCode`、`maskingPolicyCode`、`prefillSourceCode`，不能直接返回 governed canonical
  definition。
- 新 governed Form 在既有 v3-v5 `registrationForm` slot 内以完整 canonical definition 与新 hash
  保存和校验；这不是 v6，也不是对 snapshot envelope 的改版。旧 v3-v5 snapshot 仍使用没有治理键的
  legacy definition，其已签 hash 不变；hash 不匹配或混合形状一律拒绝。
- existing clone-from-source、draft / active target 比较和 applyPublishedTarget 都必须经同一个
  canonicalizer，确保治理字段既不会丢失，也不会被服务端私自补默认值。

仍然明确不做：

- 不新增模板管理 HTTP 写接口、公开 endpoint、权限码、Gate、RBAC seed、Answer 读面或答案 CSV；
- 不新增答案查询、普通 Audit payload 中的答案、日志答案、AI 输入、缓存、cron、queue、预填或附件写入；
- 不读 / 复制 Member 的部门、等级、性别、年龄、证书、保险、训练或任何高敏档案字段；
- 不修改 legacy Form、历史 active Form、历史 / 在途 v2-v5 snapshot 的既有解释或已签 hash。

敏感题目的后续 B3-S 关口必须同时交付逐题用途、可见角色、真实掩码输出、保存期限、退队处理和手动 / 自动清理责任；届时才可启用相应 `dataClassCode` / `retentionPolicyCode` / `maskingPolicyCode` 组合及读写路径。不能把 `sensitive`、`masked` 或 `30d` 这样的字符串先落库，再把它们当作已经落实的保护。这个关口是总蓝图的未完成项，不随 B3 基础 PR 悄悄消失。

## 4. 方案比较

| 方案 | 内容 | 结论 |
| --- | --- | --- |
| A（推荐） | 新建严格 Definition V2；完整保留八种既有题型；复用现有 Form 模型并在同一事务 copy；Field 元数据 all-or-none；managed / 发布变更审核使用 governed DTO；公开 App 投影剥离治理字段；既有 v3-v5 Form slot 支持新 governed hash、旧 hash 原样兼容；无预填、不可导出；敏感题目按逐题治理门槛 fail-closed。 | 完成 B3 的蓝图复制和治理地基，不把“禁止某些题型”伪装为数据治理，也不虚报敏感处理已完成。 |
| B | 给 V1 根对象可选加 `registrationForm`，或在解析器里忽略未知键。 | 会改变 V1 的解释边界，且容易让旧 hash / writer 在不知情时承载新语义。 |
| C | 新建 TemplateForm、TemplateField、TemplateAnswer 等平行表，再在创建时同步。 | 复制生命周期、hash、权限和数据清理真相，违背复用现有正式能力的冻结合同。 |
| D | 直接允许敏感字段、预填、文件 / 自由文本，并只用 policy code 自证合规。 | 题型本身并不违规；但当前没有批准的敏感读面掩码、留存清理或档案访问合同，直接启用敏感内容属于越权和虚假保护。 |
| E | 顺手添加模板管理 API、答案读面 / CSV、B5 Snapshot v6、B4 Readiness、B6 创建 API 或 AI。 | 跨越多个后续业务轴，破坏逐刀验证和授权边界。 |

## 5. 风险、验证与 migration rehearsal

| 风险 | 必须证明的处理 |
| --- | --- |
| V1 或历史 active Form 的 schemaHash 因新增列漂移 | 单测给出 B3 前已知 canonical JSON / hash，读取五列全 NULL 的 persisted Field 后必须逐字相等；v2-v5 proposal / approval characterization 维持原断言。 |
| 一份 Form 混用 legacy / governed Field，或历史 Field 被隐式补 `null` / `ordinary` | canonicalizer 单测覆盖纯 legacy、纯 governed、混用和部分治理列；只有前两种可通过，legacy canonical JSON / hash 必须与 B3 前固定样本逐字一致。 |
| 107 → 108 在已有 Form 数据库上误写或半应用 | 独立 scratch 库先重放至 107、插入 legacy Form / Field / Answer，再应用 108；断言五列均 NULL、旧行字节语义不变。另建非法 SQL 场景，逐条断言 SQLSTATE `23514`、精确约束名、migration 仍为 107 且无部分 DDL。 |
| V2 模板的 JSON / hash 被篡改或 V1 被误当 V2 | 单测分别验证 V1、V2、未知 schemaVersion、未知键、null / 非法 registrationForm 和 hash 不匹配；A6 选择器必须 fail-closed。 |
| 八种题型因“保守”被漏掉，或题型被错误当作敏感级别 | V2 parser / canonical / copy 单测必须逐一覆盖现有八种 `typeCode`；同一题型的 ordinary / sensitive 判定只由治理对象决定。敏感组合在 B3 基础实现中必须因未具备 SOP 与读面而拒绝。 |
| Activity 创建成功却漏复制 Form，或 Form 写失败留下半个 Activity | 从模板 E2E 覆盖有 Form / 无 Form、强制 Form 写失败时整根事务回滚、operationKey 重放不加第二个 Form、Activity 与 Form 均为一对一的版本起点。 |
| Template 后续变化影响既有 Activity | 用两份不同 V2 Version 创建两个活动，验证每个活动持有自己的 draft Form；冻结 / 退役模板后，旧 Activity 的 Form 不变。 |
| Series 走旁路或共享一个 Form | A7 定向 E2E 生成多期，逐期断言 formVersion 的 activityId 各自独立、均为 v1 draft，且无 Answer / UploadSession。 |
| old managed PUT / publish-review input 遗漏 governance，覆盖已复制的 Form | managed draft PUT 与 published change-review E2E 分别构造 governed Form 后提交 legacy-shaped non-null definition；必须写前拒绝且原 version / hash / Field governance 不变。legacy Form 的同形请求仍按原行为成功；显式 `null` retirement 单独覆盖。 |
| governance metadata 被公开活动详情或报名者 Form 泄露 | `app-activities-detail` 与 Form runtime E2E、DTO / OpenAPI contract 断言公共响应没有五个治理键；managed owner GET 则能完整 round-trip ordinary governed definition。 |
| 新 governed Form 进入现有发布审核后无法签名 / 审批，或为修复而重写历史 snapshot | 当前 v5 proposal 覆盖 governed Form target 的 canonical hash、签名、审批 / apply；v3、v4、v5 的解析 / 校验 fixture 也须覆盖 governed target。B3 前序列化 snapshot fixture 的 JSON / hash 必须原样有效，v2 不改。 |
| 治理元数据被泄入 Audit、CSV、日志、AI 或 profile copy | 对 create-from-template audit、CSV 查询 / presenter、Form copy 输入和 Prisma 写集作定向断言；禁止出现答案文本、附件内容、member profile 查询或 prefill writer。 |
| 敏感 policy code 被误认为已有清理保障 | B3 的负向测试必须证明：没有已登记敏感 SOP / reader-mask 合同的定义不能被 materialize；普通 `activity_lifecycle` 不能用于敏感字段。 |
| migration 计数与派生文档过期 | 现存十份 `CURRENT_MIGRATION_COUNT` 从 107 同步为 108；最后一次写入后运行 docs 刷新与所有生成物检查，不能把 `docs:refresh` 当作检查本身。 |

最低验证顺序：

1. `prisma validate`、generate、lint、typecheck、B3 纯函数 / service 单测；
2. B3 PostgreSQL E2E：108 冷库 replay、107 非空升级、非法约束 fail-closed、V2 copy 与事务回滚；
3. A6 from-template、A7 Series、既有 Form runtime / registration command / upload、managed PUT、public detail 与发布变更审核相关 E2E；
4. `test:contract` 的预期只限 managed Form / publish-review DTO 与既有 endpoint 的 OpenAPI 引用调整；snapshot diff 必须逐行解释，公共 `AppRegistrationFormDto` 不得新增治理字段，不能用盲目更新快照掩盖；
5. PR CI 的 `agent:check:full` 作为全量结论。本地不跑全量 E2E；没有 Docker 时只报 quick，contract / E2E 留 CI。

任何环境均不运行 `prisma migrate dev`、`prisma migrate reset` 或 `prisma db push`；不对生产或真实数据环境执行 migration。

## 6. 写集与授权预算

### 6.1 本次已获授权

本 review PR 只允许：

- `docs/archive/reviews/activity-os-r2-b3-form-blueprint-review.md`：新增本评审稿；维护者已在本 worktree 发放精确 archive 新增授权；
- `docs/ai-harness/FROZEN_DRAFTS.md`：登记新增冻结施工依据。

这份起草授权不授权 schema、migration、源码、测试、生成物、GitHub 合并或生产动作。

### 6.2 B3 implementation 前仍须维护者确认的写集

下列是预算而非已授权清单。review PR 合入后，implementation worktree 必须按真实 diff 逐文件执行
`harness:needs`，由维护者重新发放精确令牌。

该 implementation 因为包含第 108 条 migration，按 `docs/process.md` §3 是 D 档；managed / 发布
变更 DTO 属于其中的 C 档 API 行为维度，不会把整个变更降级。必须沿 D 档评审、立项、redzone
授权和 contract diff 逐行复核流程执行。

| 预期路径 | 用途 |
| --- | --- |
| `prisma/schema.prisma` | 只为 `RegistrationFormField` 增加五个 nullable governance 列与准确说明。 |
| `prisma/migrations/YYYYMMDDHHMMSS_activity_os_r2_b3_form_blueprint_governance/migration.sql` | 第 108 条 migration；纯 additive、all-or-none CHECK、无 DML / default / backfill / seed / 删除。 |
| `src/modules/activities/activity-template-definition-v2.ts` 及单测 | V2 的严格 parser 与 V1 不可变兼容。 |
| `src/modules/activities/activity-from-template.service.ts`、`activity-from-template.service.spec.ts` | V1 / V2 显式分派，并在现有根事务中仅调用 Form service 的内部 materialize 入口。 |
| `src/modules/activities/registration-form-definition.ts`、`registration-form-version.service.ts`、`registration-form-version.service.spec.ts` | definition-level governed / legacy canonical 兼容、元数据持久化、owner-safe DTO 投影，以及只接受 caller `tx` 的 template-draft materialize 入口。 |
| `src/modules/activities/dto/app/app-registration-form.dto.ts`、`controllers/app-managed-activities.controller.ts` | 为既有 managed GET / PUT 引入 governed DTO，保留 `AppRegistrationFormDto` 的公开安全投影；不新增路由。 |
| `src/modules/activities/app-activities.service.ts`、`activity-publish-review.dto.ts`、`activity-publish-proposal-v2.service.ts` 及其单测 | 公共详情显式剥离治理字段；publish-review 输入防止 legacy 覆盖；既有 v3-v5 Form target 对新 governed definition canonicalize / hash，历史 target 不漂移。 |
| `src/modules/activities/activity-lifecycle.service.ts` 及其单测 | 既有 clone-from-source 经共享 canonicalizer 后仍完整保留 governed 字段，且不复制答案 / 上传。 |
| `test/e2e/activity-os-r2-b3-form-blueprint-governance.e2e-spec.ts` | 108 replay、非空库 rehearsal、约束、copy / rollback / no-leak 证明。 |
| `test/e2e/activity-batch4-form-runtime.e2e-spec.ts`、`test/e2e/app-activities-detail.e2e-spec.ts`、`test/e2e/activity-batch3-2-publish-review.e2e-spec.ts` | managed governed round-trip、legacy overwrite 拒绝、公共投影不泄露、v3-v5 publish review 兼容。 |
| `test/contract/openapi.contract-spec.ts`、`test/contract/__snapshots__/openapi.contract-spec.ts.snap` | 经逐行审阅后登记既有 managed / publish-review 契约的必要 DTO 引用变化；禁止以 snapshot 更新掩盖公开投影泄露。 |
| `docs/handoff/openapi.json`、`docs/handoff/clients/app/client.ts`、`docs/handoff/clients/app/types.ts` | 与受控 API 契约同 PR 由 `docs:openapi`、`docs:feclient` 派生；以生成物 diff 核对 managed Form 新字段仅出现在 App managed surface。 |
| 十份现存 migration-count E2E | 将 `CURRENT_MIGRATION_COUNT` 从 107 同步到 108，不改任何历史 baseline 常量。 |
| `CODEMAP.md`、`docs/current-state.md`、`harness/domain-map.json`、`harness/state-machines.json`、`docs/ai-harness/CUTOVER_SIGNOFF.md` | 仅在生成器或第 108 条 migration 3b 登记实际要求时最小更新。 |

十份 migration-count 执行位为：

- `test/e2e/activity-os-r1-a3-template-definition-lifecycle-guards.e2e-spec.ts`
- `test/e2e/activity-os-r1-a4-explicit-template-version-pointer.e2e-spec.ts`
- `test/e2e/activity-os-r2-b1-place-schema-constraints.e2e-spec.ts`
- `test/e2e/activity-os-r2-b2-coordinate-projection-schema-constraints.e2e-spec.ts`
- `test/e2e/activity-v11-batch4-allocation-candidate-position-anchor-migration.e2e-spec.ts`
- `test/e2e/activity-v11-batch4-allocation-command-replay-migration.e2e-spec.ts`
- `test/e2e/activity-v11-batch4-allocation-determinism-migration.e2e-spec.ts`
- `test/e2e/activity-v11-batch4-allocation-mode-migration.e2e-spec.ts`
- `test/e2e/activity-v11-batch4-qualification-contract-migration.e2e-spec.ts`
- `test/e2e/insurance-evidence-registration-revision-migration.e2e-spec.ts`

仅申请表中列出的**既有** controller / DTO / Swagger / OpenAPI 契约调整；不申请新 endpoint、权限码、
RBAC seed、AuditLogEvent、全局 Gate、answer 读面 / CSV、附件写入、Member / Profile、AI、cron、
queue、缓存、旧 migration 修改、`prisma/CLAUDE.md` 的独立事实更正或生产 deploy。敏感题目启用所需
SOP、读面 / 掩码和清理执行位也不在本写集；若真实 diff 需要其中任一项，必须暂停并重新报批。

## 7. 维护者决策记录与下一次确认

维护者已于 2026-09-03 确认：

> 确认 B3 方案 A（八种既有题型；managed 治理契约；v3-v5 表单兼容；敏感题目逐题审批后启用）

此决定确认了上述 V2、全表 governed / legacy canonical 兼容、受控 managed / 发布变更审核契约、
公开 App 投影不泄露治理元数据、既有 v3-v5 Form target 兼容、旧 hash 不漂移、无预填 / 无导出和
敏感题目逐题审批后启用的边界，并允许完成这份 review PR 的收口；它不授权 B3 implementation。

实际 schema、migration、测试或运行时代码仍须在 review PR 独立合入后，按真实 diff 重新申请授权；
第 108 条 migration SQL 逐行审查完成后，还须单独确认：

> 确认重签 3b（B3，第 108 条 migration）

任何 B4 至 B7 内容均不随本决定带入。
