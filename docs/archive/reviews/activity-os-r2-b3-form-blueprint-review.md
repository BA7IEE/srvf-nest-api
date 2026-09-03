# Activity OS R2 / B3 模板报名表蓝图复制与数据治理评审记录

> **状态：草案，尚未冻结**（2026-09-03）。维护者已授权起草本评审与授权清单；这不等同于确认 B3 实施、schema / migration 或任何运行时代码。
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

这不是缩小蓝图，而是把“八种题型的蓝图复制”与“敏感数据可用前的真实保护”分别落实：前者在 B3 实施，后者保留为不可跳过的后续关口。整个 Activity OS 不能因 B3 的结构落地就宣称敏感数据治理已完成。

## 2. 已核验事实与约束

| 事实 / 风险 | 证据 | 对 B3 的约束 |
| --- | --- | --- |
| 现有四张报名表正式模型已经覆盖版本、字段、答案和上传会话 | `prisma/schema.prisma` 的 `RegistrationFormVersion`、`RegistrationFormField`、`RegistrationFormAnswer`、`RegistrationUploadSession` | 只扩展并复用；禁建第二套 Template Form、Answer 或 Upload 模型。 |
| Field 现仅有 `visibilityCode` 与 `exportable`，并无用途、分类、留存、掩码、预填来源 | `prisma/schema.prisma`；`registration-form-definition.ts` | 新元数据必须进入 canonical 定义和持久化字段，不能只挂在模板 JSON 后丢失。 |
| 现有 canonical Form hash 已被发布审核和 active Form 指针使用 | `registration-form-definition.ts`；`registration-form-version.service.ts`；`activity-publish-proposal-v2.service.ts` | 旧字段行全为空时，重建的 canonical JSON 必须逐字保持旧形状，不能因为新增 `null` 键改变旧 `schemaHash`。 |
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

每一题额外必须带完整 `governance` 对象：

| 字段 | V2 合同 | 含义 |
| --- | --- | --- |
| `purposeCode` | 受控、非空的用途码；首批候选为 `transport_logistics`、`accommodation_logistics`、`dietary_accommodation`、`equipment_clothing`、`activity_specific_note`、`file_confirmation`，没有 `other` 兜底。 | 对应活动特有信息；不得用它重收部门、等级、性别、年龄、证书、保险或训练记录。最终闭集须在 implementation 前由维护者确认。 |
| `dataClassCode` | `ordinary` 或 `sensitive`；高敏队员档案复制不属于这两类模板输入，始终禁止。 | 分级取决于题目内容而不是 `typeCode`。`sensitive` 的存在不自动给出读、导出或清理权限。 |
| `retentionPolicyCode` | 非空受控码。普通字段可采用 `activity_lifecycle`（随该活动的报名记录，不进队员主档）；敏感字段必须引用一份已批准、写明期限和清理负责人的实际 SOP。 | B3 不新增自动删除；没有 SOP 的敏感题目不能启用。 |
| `maskingPolicyCode` | 普通字段为 `none`；敏感字段必须引用已有、可执行的读面和掩码合同，不能以孤立字符串替代。 | 当前没有这种 Activity Form 敏感读面，故 B3 不开敏感题目 writer / reader。 |
| `prefillSourceCode` | 必须为 `null` | B3 不从部门、等级、性别、年龄、证书、保险、训练记录或任何其它队员档案复制 / 预填。 |

非空 V2 蓝图还必须满足：

- `exportable` 固定为 `false`；B3 不新开字段答案导出。
- `visibilityCode` 继续显式使用当前三值闭集，不能靠缺省扩大可见范围。
- 八种既有题型均可出现在蓝图；`short_text`、`long_text`、`number`、`date`、`file` 绝不因载荷形式被一概排除。医疗、饮食禁忌、紧急联系人、证件或自由敏感说明是否可用，取决于该题的实际分级和下面的敏感启用门槛。
- 新用途、预填来源、敏感分类、掩码规则、留存期限或清理动作的任何一项，都不是“加一个字符串”即可完成，必须重新说明业务用途、查看角色与掩码、保存期限及退队处置。
- `dataClassCode = sensitive` 的蓝图在 B3 基础实现中必须 fail-closed，直到补充评审同时给出该字段的用途、最小可见 / 掩码读面、留存期限、手动或自动清理动作及责任人；不得把 `activity_lifecycle` 或 `none` 套给敏感值来绕过该门槛。

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

运行时 canonicalizer 要把这两种形状分开处理：legacy Field 不附加任何治理键，故它的旧
canonical JSON 和 `schemaHash` 不变；governed Field 则把完整 governance 对象纳入 canonical JSON
与 hash。不能以“补五个 null”或“给旧行默认 ordinary”方式静默改写已激活 Form 的指纹。

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
- 后续活动发布仍只由既有 `RegistrationFormVersionService.applyPublishedTarget` 激活并冻结，B3 不提前改 Publish Snapshot v2-v5 或 B5 的 v6 工作。

Template Version 的 hash 本身继续由 A3 的 envelope `{ definition, schemaVersion }` 计算。V2 的
hash 与 V1 不同；已有 V1 Version 仍按旧 parser、旧 hash、旧 materializer 行为运行，不能被 V2
解析器“兼容性修复”后悄悄改变。

### 3.4 数据边界

B3 的治理元数据是**定义与持久化合同**，不是尚不存在的敏感数据处理系统。具体来说：

- 不新增模板管理 HTTP 写接口、App / Admin DTO、Swagger、路由、权限码、Gate 或 seed；
- 不改现有 managed registration-form API 的 legacy 输入 / 输出合同；它仍不能被当作创建 B3 V2 模板蓝图的旁路；
- 不新增答案查询、答案 CSV 字段、导出权限、普通 Audit payload、日志答案、AI 输入、缓存、cron 或 queue；
- 不读 / 复制 Member 的部门、等级、性别、年龄、证书、保险、训练或任何高敏档案字段；
- 不改变 legacy Form、历史 active Form、在途 Publish Review 和 v2-v5 snapshot 的解释。

敏感题目的后续 B3-S 关口必须同时交付逐题用途、可见角色、真实掩码输出、保存期限、退队处理和手动 / 自动清理责任；届时才可启用相应 `dataClassCode` / `retentionPolicyCode` / `maskingPolicyCode` 组合及读写路径。不能把 `sensitive`、`masked` 或 `30d` 这样的字符串先落库，再把它们当作已经落实的保护。这个关口是总蓝图的未完成项，不随 B3 基础 PR 悄悄消失。

## 4. 方案比较

| 方案 | 内容 | 结论 |
| --- | --- | --- |
| A（推荐） | 新建严格 Definition V2；完整保留八种既有题型；复用现有 Form 模型并在同一事务 copy；Field 元数据 all-or-none；V1 / 旧 hash 原样兼容；无预填、不可导出；敏感题目按逐题治理门槛 fail-closed。 | 完成 B3 的蓝图复制和治理地基，不把“禁止某些题型”伪装为数据治理，也不虚报敏感处理已完成。 |
| B | 给 V1 根对象可选加 `registrationForm`，或在解析器里忽略未知键。 | 会改变 V1 的解释边界，且容易让旧 hash / writer 在不知情时承载新语义。 |
| C | 新建 TemplateForm、TemplateField、TemplateAnswer 等平行表，再在创建时同步。 | 复制生命周期、hash、权限和数据清理真相，违背复用现有正式能力的冻结合同。 |
| D | 直接允许敏感字段、预填、文件 / 自由文本，并只用 policy code 自证合规。 | 题型本身并不违规；但当前没有批准的敏感读面掩码、留存清理或档案访问合同，直接启用敏感内容属于越权和虚假保护。 |
| E | 顺手添加模板管理 API、答案读面 / CSV、B5 Snapshot v6、B4 Readiness、B6 创建 API 或 AI。 | 跨越多个后续业务轴，破坏逐刀验证和授权边界。 |

## 5. 风险、验证与 migration rehearsal

| 风险 | 必须证明的处理 |
| --- | --- |
| V1 或历史 active Form 的 schemaHash 因新增列漂移 | 单测给出 B3 前已知 canonical JSON / hash，读取五列全 NULL 的 persisted Field 后必须逐字相等；v2-v5 proposal / approval characterization 维持原断言。 |
| 107 → 108 在已有 Form 数据库上误写或半应用 | 独立 scratch 库先重放至 107、插入 legacy Form / Field / Answer，再应用 108；断言五列均 NULL、旧行字节语义不变。另建非法 SQL 场景，逐条断言 SQLSTATE `23514`、精确约束名、migration 仍为 107 且无部分 DDL。 |
| V2 模板的 JSON / hash 被篡改或 V1 被误当 V2 | 单测分别验证 V1、V2、未知 schemaVersion、未知键、null / 非法 registrationForm 和 hash 不匹配；A6 选择器必须 fail-closed。 |
| 八种题型因“保守”被漏掉，或题型被错误当作敏感级别 | V2 parser / canonical / copy 单测必须逐一覆盖现有八种 `typeCode`；同一题型的 ordinary / sensitive 判定只由治理对象决定。敏感组合在 B3 基础实现中必须因未具备 SOP 与读面而拒绝。 |
| Activity 创建成功却漏复制 Form，或 Form 写失败留下半个 Activity | 从模板 E2E 覆盖有 Form / 无 Form、强制 Form 写失败时整根事务回滚、operationKey 重放不加第二个 Form、Activity 与 Form 均为一对一的版本起点。 |
| Template 后续变化影响既有 Activity | 用两份不同 V2 Version 创建两个活动，验证每个活动持有自己的 draft Form；冻结 / 退役模板后，旧 Activity 的 Form 不变。 |
| Series 走旁路或共享一个 Form | A7 定向 E2E 生成多期，逐期断言 formVersion 的 activityId 各自独立、均为 v1 draft，且无 Answer / UploadSession。 |
| 治理元数据被泄入 Audit、CSV、日志、AI 或 profile copy | 对 create-from-template audit、CSV 查询 / presenter、Form copy 输入和 Prisma 写集作定向断言；禁止出现答案文本、附件内容、member profile 查询或 prefill writer。 |
| 敏感 policy code 被误认为已有清理保障 | B3 的负向测试必须证明：没有已登记敏感 SOP / reader-mask 合同的定义不能被 materialize；普通 `activity_lifecycle` 不能用于敏感字段。 |
| migration 计数与派生文档过期 | 现存十份 `CURRENT_MIGRATION_COUNT` 从 107 同步为 108；最后一次写入后运行 docs 刷新与所有生成物检查，不能把 `docs:refresh` 当作检查本身。 |

最低验证顺序：

1. `prisma validate`、generate、lint、typecheck、B3 纯函数 / service 单测；
2. B3 PostgreSQL E2E：108 冷库 replay、107 非空升级、非法约束 fail-closed、V2 copy 与事务回滚；
3. A6 from-template、A7 Series、既有 Form runtime / registration command / upload 相关 E2E；
4. `test:contract` 必须零 snapshot 漂移；若出现差异先停下逐行说明，不能用更新快照掩盖；
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

| 预期路径 | 用途 |
| --- | --- |
| `prisma/schema.prisma` | 只为 `RegistrationFormField` 增加五个 nullable governance 列与准确说明。 |
| `prisma/migrations/YYYYMMDDHHMMSS_activity_os_r2_b3_form_blueprint_governance/migration.sql` | 第 108 条 migration；纯 additive、all-or-none CHECK、无 DML / default / backfill / seed / 删除。 |
| `src/modules/activities/activity-template-definition-v2.ts` 及单测 | V2 的严格 parser 与 V1 不可变兼容。 |
| `src/modules/activities/activity-from-template.service.ts`、`activity-from-template.service.spec.ts` | V1 / V2 显式分派，并在现有根事务中仅调用 Form service 的内部 materialize 入口。 |
| `src/modules/activities/registration-form-definition.ts`、`registration-form-version.service.ts`、`registration-form-version.service.spec.ts` | governed / legacy canonical 兼容、元数据持久化，以及只接受 caller `tx` 的 template-draft materialize 入口。 |
| `test/e2e/activity-os-r2-b3-form-blueprint-governance.e2e-spec.ts` | 108 replay、非空库 rehearsal、约束、copy / rollback / no-leak 证明。 |
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

不申请 `controller`、DTO、Swagger、OpenAPI snapshot、权限码、RBAC seed、AuditLogEvent、全局
Gate、answer 读面 / CSV、附件写入、Member / Profile、AI、cron、queue、缓存、旧 migration 修改、
`prisma/CLAUDE.md` 的独立事实更正或生产 deploy。敏感题目启用所需 SOP、读面 / 掩码和清理执行位也
不在本写集；若真实 diff 需要其中任一项，必须暂停并重新报批。

## 7. 维护者下一次确认

维护者已确认的只有：

> 确认起草 B3 评审与授权清单（方案 A）

这允许形成并评审本稿，不确认方案 A 的实施。维护者随后回复的“确认 B3 方案 A”针对的是上一版
ordinary-only 文字；该文字已被本稿以上述八题型和敏感启用门槛的事实更正取代，不能把旧确认外推为
新范围授权。

若同意上述 V2、完整八种既有题型、无预填 / 无导出、旧 hash 不漂移，以及“敏感题目须另有逐题
用途 / 可见及掩码 / 留存清理批准才可启用”的边界，请明确回复：

> 确认 B3 方案 A（八种既有题型；敏感题目逐题审批后启用）

之后仍须为 B3 implementation 单独批准真实写集。第 108 条 migration SQL 逐行审核后，还须单独确认：

> 确认重签 3b（B3，第 108 条 migration）

任何 B4 至 B7 内容均不随本决定带入。
