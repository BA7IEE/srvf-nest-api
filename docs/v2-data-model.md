# V2 第一阶段正式数据模型说明

> **回填注(2026-05-23 / G1-PR-B 治理刷新,v0.15.0+ 口径)**:本文起源于 V2-D8 立项阶段(2026-05-07)的**数据模型 draft**。**V2 第一阶段 4 模型(`dict_types` / `dict_items` / `organizations` / `members` / `member_departments`)+ `users.memberId` 追加早已实装并随 v0.10.0 ~ v0.12.0 发布**;此后批次 1(`member_profiles` / `emergency_contacts`)/ 批次 2(`certificates`)/ 批次 3A(`activities` / `activity_registrations`)/ 批次 3B + 4-A + 4-B(`attendance_sheets` / `attendance_records` / `contribution_rules`)/ 批次 6(`audit_logs`)/ V2.x C-6 RBAC 四表(`rbac_roles` / `permissions` / `role_permissions` / `user_roles`)/ V2.x C-7 `attachments` + 配置三表(`attachment_type_configs` / `attachment_mime_configs` / `attachment_size_limit_configs`)/ V2.x C-7.5 `storage_settings` / P0-E `refresh_tokens` 等均已落地,详见 [`docs/current-state.md §2`](current-state.md) 与 [`../prisma/schema.prisma`](../prisma/schema.prisma)(25+ model)。**当前字段 / 类型 / 可空性 / 约束 / 索引的事实权威源以 [`../prisma/schema.prisma`](../prisma/schema.prisma) 为准**;本文保留为 V2-D8 立项时刻的 draft 历史快照,正文(含 §0 文档定位 / §1 模型清单"不开发" / §9 BizCode 段位映射"V2.x 复活" / §11 "不覆盖的模型"等)中"**V2-D8 立项中 / 初稿 / 待 D8 立项 5 份产出物全部就位 / 待用户拍板才能启动 Step 1 / 不覆盖 `member_profiles` / `attachments` / `audit_logs`**"等表述属于**文档定稿时刻的阶段状态,不代表当前事实**;字段级细节如与代码不一致**以 `prisma/schema.prisma` 为准**。

> 派生项目:**srvf-nest-api**
> 文档定位:**V2 第一阶段正式数据模型说明**(D8-3 立项产出物)
> 阶段:**V2-D8 立项中**(2026-05-07)
> 状态:**初稿**,待 D8 立项 5 份产出物全部就位 + 用户拍板才能启动 Step 1
> 依据:`docs/archive/plans/architecture-v2-first-stage-blueprint.md §12.8-§12.11`(原 `ARCHITECTURE.md §12.8-§12.11`,commit `85cec75`,PR-6 已归档)+ `docs/archive/plans/v2-first-stage-plan.md`(原 `docs/v2-plan.md`,commit `bff9c93`,PR-5 已归档)+ `data-model-draft.md` v0.3 D7-min 决议(commit `4333c31`)+ baseline(commit `16876fe`)

---

## 0. 文档定位

### 0.1 这份文件是什么

- V2 第一阶段**正式数据模型说明**:覆盖 4 个 V2 新模型 + 1 项 v1 兼容性追加
- 字段级粒度:字段名 + 类型意图 + 可空性 + 用途 + 来源
- 索引与约束意图:全文用**形态级**描述,**不**写 Prisma DSL / SQL
- 配合 `docs/archive/plans/v2-first-stage-plan.md` Step 1 任务卡(原 `docs/v2-plan.md`,PR-5 已归档)+ `docs/v2-api-contract.md`(D8-4 待产出)+ `TASKS.md §6` 任务卡(D8-5 待产出)使用

### 0.2 这份文件不是什么

- **不是**完整 Prisma schema — schema 实施由 v2-plan Step 1 承载;本文用 Prisma 类型名描述意图,**不**写完整 model 块
- **不是** migration SQL — migration 由 Step 1 实施期生成;本文不写任何 SQL 语句
- **不是** controller / service / dto 代码 — 由 v2-plan Step 3-6 实施期编写
- **不是** API 契约 — 接口契约草案由 `docs/v2-api-contract.md` 承载
- **不是**真实业务取值 — 真实成员 PII(姓名 / 身份证 / 手机号)+ 真实编号样例(memberNo)**不进**本文(R13;2026-06-21 收窄,非敏感分类字典取值已可内置 seed,见 [`V2红线与复活路径.md` A-9](V2红线与复活路径.md))
- **不是**已确认开发启动 — V2-D8 标记完成需 5 份立项产出物全部就位

### 0.3 严守的边界

继承 `docs/archive/plans/architecture-v2-first-stage-blueprint.md §12.8.4`(原 `ARCHITECTURE.md §12.8.4`,PR-6 已归档)+ `docs/archive/plans/v2-first-stage-plan.md §0.3`(原 `v2-plan.md §0.3`,PR-5 已归档):

- ❌ 不写 Prisma DSL(`@id` / `@default` / `@relation` / `@@unique` / `@@map` 等装饰器)
- ❌ 不写完整 Prisma `model Xxx { ... }` 块
- ❌ 不写 migration SQL(`CREATE TABLE` / `ALTER TABLE` 等)
- ❌ 不写真实成员 PII(姓名 / 身份证 / 手机号)+ 真实编号样例(memberNo)(R13 收窄,2026-06-21;非敏感分类字典取值已可内置 seed,见 `V2红线与复活路径.md` A-9)
- ❌ 不覆盖 5 个延后模型(`member_profiles` / `attachments` / `audit_logs` / `events` / `event_participants`)
- ❌ 不写 controller / service / dto class / API 路径

### 0.4 修订纪律

- 修订需用户拍板,**禁止** AI 自行扩张
- 修订 commit message 前缀:`v2-design: v2-data-model <章节> <简述>`
- 修订需在附录 B 版本表显式记录

---

## 1. 模型清单总览

V2 第一阶段开发范围由 D7-min 决议锁定为 **4 个新模型 + 1 项 v1 兼容性追加**:

| # | 模型 | 来源章节 | BizCode 段位 | 软删除 |
|---|---|---|---|---|
| 1 | `dict_types` | §2 | `120xx + 121xx` 共享 | 启停 + `deletedAt` |
| 2 | `dict_items` | §3 | `120xx + 121xx` 共享 | 启停 + 防御性 `deletedAt` |
| 3 | `organizations` | §4 | `110xx + 111xx` | 启停 + `deletedAt` |
| 4 | `members` | §5 | `150xx + 151xx` | `deletedAt`(不挂启停字段;status 表达在/离队) |
| 5 | `member_departments` | §6 | `170xx + 171xx` | `deletedAt`(单归属约束在 `deletedAt = null` 范围内) |
| — | v1 `users` 表追加 `memberId` 可空外键 | §7 | 复用 v1 `100xx + 101xx` | 沿用 v1 |

**第一阶段不开发**(完整延后清单见 `docs/archive/plans/architecture-v2-first-stage-blueprint.md §12.8.1`,原 `ARCHITECTURE.md §12.8.1`,PR-6 已归档):

- `member_profiles` / `attachments` / `audit_logs` / `events` / `event_participants`

---

## 2. `dict_types`

### 2.1 解决的问题

承载 V2 字典的**类型层**(对应 `data-model-draft.md` v0.3 §3.1.10 D-1 双表方案的上层);第一阶段仅 2 类语义:**节点类别**(`organizations.nodeTypeCode` 引用)+ **队员等级**(`members.gradeCode` 引用)。

**业务真实取值不进 git history**(沿用 R13);seed 仅 neutral-demo 占位(对应 `docs/archive/plans/v2-first-stage-plan.md §2.2 Step 2`,原 `v2-plan.md §2.2 Step 2`,PR-5 已归档)。

### 2.2 字段说明

| 字段名 | 类型意图 | 是否可空 | 说明 | 来源 |
|---|---|---|---|---|
| `id` | String / cuid | 否 | 主键 | baseline §2.1 |
| `code` | String | 否 | 类型业务标识(全局唯一);业务字段名隐含 type 语义(例如 `nodeTypeCode` 自然指向 type=节点类别) | data-model-draft v0.3 §3.1.10 D-1 |
| `label` | String | 否 | 类型显示名(运营可读) | — |
| `status` | enum(`ACTIVE` / `INACTIVE`) | 否 | 启停状态 | baseline §2.2.3 |
| `sortOrder` | Int | 否 | 排序权重(默认 0) | — |
| `createdAt` | DateTime | 否 | 创建时间 | baseline §2.1 |
| `updatedAt` | DateTime | 否 | 更新时间 | baseline §2.1 |
| `deletedAt` | DateTime | 是 | 软删除标记;`null` 表示未删除 | baseline §10 |

### 2.3 约束与索引意图

- **唯一约束**:`code` **全局唯一**(在 `deletedAt = null` 范围内;实施时优先用 Prisma 条件性唯一索引,若不支持降级到全局唯一 + 业务规则保证软删后 code 不复用)
- **索引**:`status`(用于按启停过滤);`createdAt`(用于默认排序)
- **必填项**:`code` / `label` / `status` 不允许空字符串(DTO 层 `@MinLength(1)` 校验)

### 2.4 与其他模型的关系

- **被 `dict_items.typeId` 外键引用**(1:N 关系):一个 `dict_type` 含多个 `dict_items`
- **被业务表通过 `<concept>Code` 字符串引用**(非外键级):
  - `organizations.nodeTypeCode` → 隐含 `type code = '节点类别'` 下的 dict_items.code
  - `members.gradeCode` → 隐含 `type code = '队员等级'` 下的 dict_items.code

> 注:业务表通过**字段名隐含 type 语义**(D-2 候选 A `<concept>Code`),引用层不显式存 typeId,只存 items.code

### 2.5 软删除与启停策略

- **启停**:`status` 切换 `ACTIVE` ↔ `INACTIVE`(运营暂停某类字典使用);软删除前的常规操作
- **软删除**:`deletedAt` 标记;字典类型一旦投入业务使用**不轻易删**;V2 第一阶段允许软删未投入使用的占位类型
- **物理删除**:**禁止**(沿用 baseline §10 软删显式封装)
- **唯一性预检查**:对齐 v1 §10 — 创建 / 更新前用 `findUnique` 包含软删记录,**不**用 `notDeletedWhere`(防止软删后 code 被复用导致约束冲突)

---

## 3. `dict_items`

### 3.1 解决的问题

承载 V2 字典的**项目层**(对应 D-1 双表方案的下层);每个 `dict_item` 隶属一个 `dict_type`;支持 `parentId` 自引用父子树形(对应 D-3 `parentId` 自引用)。

第一阶段实际 items 内容:仅 neutral-demo 占位(`docs/archive/plans/v2-first-stage-plan.md §2.2`,原 `v2-plan.md §2.2`,PR-5 已归档);真实业务取值由运营在部署后通过运营后台 / 私有 seed 录入。

### 3.2 字段说明

| 字段名 | 类型意图 | 是否可空 | 说明 | 来源 |
|---|---|---|---|---|
| `id` | String / cuid | 否 | 主键 | baseline §2.1 |
| `typeId` | String | 否 | 类型外键(指向 `dict_types.id`) | data-model-draft §3.1.10 |
| `code` | String | 否 | items 业务标识;在同一 type 范围内唯一(被业务表通过 `<concept>Code` 字段引用) | D-2 候选 A |
| `label` | String | 否 | items 显示名(运营可读) | — |
| `parentId` | String | 是 | 父级自引用(`null` = 顶层 item)| D-3 父子树形 |
| `sortOrder` | Int | 否 | 同级排序权重(默认 0) | — |
| `status` | enum(`ACTIVE` / `INACTIVE`) | 否 | 启停状态 | baseline §2.2.3 |
| `createdAt` | DateTime | 否 | 创建时间 | baseline §2.1 |
| `updatedAt` | DateTime | 否 | 更新时间 | baseline §2.1 |
| `deletedAt` | DateTime | 是 | 软删除标记(防御性留置;**优先用启停而非软删**)| `research.md §6.5` |

### 3.3 约束与索引意图

- **唯一约束**:`(typeId, code)` 在 `deletedAt = null` 范围内唯一(同一 type 下 code 不重复;不同 type 的 code 可重复)
- **外键约束**:`typeId` → `dict_types.id`(强约束,`onDelete: Restrict` 意图;实施时由 Prisma 关系定义)
- **自引用约束**:`parentId` → `dict_items.id`(可空;`onDelete: SetNull` 或 `Restrict` 由 Step 1 实施时决定,默认 `Restrict` 防止误删父级)
- **索引**:`typeId`(列表查询)/ `parentId`(树形查询)/ `status` / `createdAt`
- **业务校验(service 层)**:
  - `parentId` 自引用不能形成环(创建 / 更新时校验,V2 仅 2 层不会触发,但兜底)
  - `parentId` 必须与本 item 同 typeId(子项不跨 type)

### 3.4 父子树形说明

- **支持层级深度**:V2 第一阶段无显式上限;实际业务最多 2 层(对应未来 events 类型的"大类 + 子类",联动 `data-model-draft.md §3.1.10 D-3`)
- **不支持改父级**:V2 第一阶段 `parentId` 创建后通过 service 层规则**禁止修改**;若需调整树形,采用"软删旧 + 创建新"模式
- **物化路径 / 闭包表**:**不引入**(深度 2 层 + 不可改父级前提下,邻接表足够)
- **根节点判定**:`parentId IS NULL` 即顶层 item

### 3.5 与其他模型的关系

- **`dict_types`**(N:1)— 通过 `typeId` 外键
- **`organizations.nodeTypeCode`**(N:M 隐式)— 通过 `code` 字符串引用,V2 仅承载"节点类别"type
- **`members.gradeCode`**(N:M 隐式)— 通过 `code` 字符串引用,V2 仅承载"队员等级"type

### 3.6 软删除与启停策略

- **优先启停**:`status` 切换;字典 items 投入业务使用后**不物理删除**(`research.md §6.5`)
- **`deletedAt` 防御性留置**:仅运营场景下确实要软删时使用
- **历史业务数据保护**:即便 items 被软删,历史业务数据(已存的 `gradeCode = 'XXX'`)仍可解析(因 `findUnique` 在 service 层包含软删记录)

### 3.7 字典 seed 内置策略与防误删守卫(2026-06-21 goal「字典内置」)

R13 收窄(见 [`V2红线与复活路径.md` A-9](V2红线与复活路径.md))后,`prisma/seed.ts` 按字典性质分三类内置 + 两类占位:

| 类别 | 例 | seed 内置 | code 契约 | 项级防误删 |
|---|---|---|---|---|
| **闭集**(状态 / 角色机)| `cert_status` / `activity_status` / `registration_status` / `attendance_sheet_status` / `attendance_status` / `attendance_role` | 真实闭集值 | 业务状态机依赖,长期契约 | ✅ 受保护 |
| **国标参照** | `gender` / `blood_type` / `marital_status` / `political_status` / `document_type` / `education` / `ethnicity`(56 民族)/ `emergency_relation` | 真实 GB 标准值 | 英文 / 拼音 snake_case,长期契约 | ✅ 受保护 |
| **队内内置** | `member_grade`(9 项)/ `activity_type`(9 父 + 28 子) | 队内真实分类 | 中文生成稳定 snake_case,长期契约 | ✅ 受保护 |
| **占位 / 开放分类** | `node_type`(组织树另起 goal)/ `work_nature`(本次未给值)/ `cert_type` / `cert_sub_type` / `content_type`(待运营细化) | 占位 demo / 初始集 | — | ❌ 项可由运营增删改 |

**防误删守卫**(`dictionaries.service.ts`;service 常量,无 schema flag / 无 migration):

- **不变量 ①**:全部 seed 内置类型禁止【类型】软删(`SYSTEM_PROTECTED_DICT_TYPES`;含占位类型)→ `DICT_TYPE_SYSTEM_PROTECTED`(12003)。
- **不变量 ②**:闭集 + 国标 + 队内内置类型下的【项】禁止软删(`ITEM_PROTECTED_DICT_TYPES`)→ `DICT_ITEM_SYSTEM_PROTECTED`(12015);改 code 本就不可能(`UpdateDictItemDto` 白名单仅 label / sortOrder)。
- **不变量 ③**:运营自建的非内置类型及其项 CRUD 行为不变(不在集合即放行)。
- **不变量 ④**:所有类型 / 项 label / sortOrder / status 切换保持可改(守卫只封 delete)。
- 与 `DICT_TYPE_IN_USE` / `DICT_ITEM_IN_USE` 引用检查**并存**:守卫是额外闸,不依赖当前是否被引用。
- 守卫 code 集合须与 `prisma/seed.ts`(`V2_DICT_SEED` + `seedActivityTypeHierarchy`)同步;新增 seed 内置类型时同步登记(漏登只是少一层保护,非破坏性)。

**幂等**:seed `upsert` + `update: {}` 不覆盖运营运行时手改;真实 label 仅干净库首次 seed 生效(模板期可接受)。

---

## 4. `organizations`

### 4.1 解决的问题

提供"组织树"形态(对应 `data-model-draft.md` v0.3 §3.2.10);单根树 / 3 层不写死;**不**预设具体节点(由运营在部署后录入)。

V2 第一阶段支持:新增 / 编辑 / 停用,**不可改父级**(D7-min O-1)。

### 4.2 字段说明

| 字段名 | 类型意图 | 是否可空 | 说明 | 来源 |
|---|---|---|---|---|
| `id` | String / cuid | 否 | 主键 | baseline §2.1 |
| `name` | String | 否 | 节点名(`@MaxLength(50)` 或运营评估后定值) | — |
| `parentId` | String | 是 | 父级自引用(`null` = 根节点) | data-model-draft §3.2.10 |
| `nodeTypeCode` | String | 否 | 引用 `dict_items.code`(隐含 `type code = '节点类别'`) | data-model-draft §3.2.10 O-2 |
| `sortOrder` | Int | 否 | 同级排序权重(默认 0) | — |
| `status` | enum(`ACTIVE` / `INACTIVE`) | 否 | 启停状态 | baseline §2.2.3 |
| `createdAt` | DateTime | 否 | 创建时间 | baseline §2.1 |
| `updatedAt` | DateTime | 否 | 更新时间 | baseline §2.1 |
| `deletedAt` | DateTime | 是 | 软删除标记 | baseline §10 |

**禁止字段(本阶段)**:负责人 / 简介 / 联系方式 / 内部编号 / 起止时间(临时编组用);全部延后到 V2.x。

### 4.3 约束与索引意图

- **自引用约束**:`parentId` → `organizations.id`(可空;`onDelete: Restrict` 防止误删带子节点的父级)
- **业务校验(service 层)**:
  - `parentId` 自引用不能形成环(创建 / 更新时校验)
  - V2 第一阶段**不可改父级**:更新时若 `parentId` 与现值不同 → 抛错(BizCode `ORGANIZATION_PARENT_IMMUTABLE` 类)
  - **单根树**:全表 `parentId IS NULL` 的活跃记录 ≤ 1(V2 第一阶段);可由 service 层校验,或加部分唯一索引(实施时评估 Prisma 支持)
  - `nodeTypeCode` 必须存在于 `dict_items` 中且 `dict_items.typeId` 对应 type code = '节点类别' 且 `status = ACTIVE`
- **索引**:`parentId`(树形查询)/ `nodeTypeCode`(按类别筛选)/ `status` / `createdAt`

### 4.4 父子树形说明

- **单根树**:V2 第一阶段顶层仅 1 个根节点;`parentId IS NULL` 的活跃记录视为根
- **支持层级**:形态上不写死层级数;实际业务约 3 层(D5 Q1.1)
- **不支持改父级**:对应 D7-min O-1;若需调整树形,采用"软删旧 + 创建新"模式
- **节点撤销**:`status = INACTIVE` 暂停业务使用;`deletedAt` 设值为软删除(子节点因外键 `Restrict` 必须先处理)
- **不承载临时编组**:对应 D7-min O-4;V2 第一阶段不引入起止时间字段

### 4.5 与 dict_items 的关系

- **`nodeTypeCode` 字符串引用**:V2 第一阶段所有 organizations 节点的 nodeTypeCode 必须在 dict_items 中存在(type='节点类别')
- **service 层校验**:创建 / 更新 organizations 前查 dict_items 验证 code 存在 + status=ACTIVE;不存在 → 抛 `ORGANIZATION_NODE_TYPE_INVALID` 类错误码

### 4.6 软删除与启停策略

- **启停**:`status = ACTIVE` ↔ `INACTIVE`;停用后节点不再可用于新归属(member_departments)/ 新建子节点;但已有归属 / 子节点不受影响
- **软删除**:`deletedAt` 设值;子节点 / 归属记录因外键 `Restrict` 必须先处理(service 层先检查依赖)
- **物理删除**:**禁止**(沿用 baseline §10)
- **撤销策略选择**(运营层面):
  - 暂停业务但保留可见 → `status = INACTIVE`
  - 不再使用且无业务依赖 → `deletedAt` 软删

---

## 5. `members`

### 5.1 解决的问题

承载队员主表(对应 `data-model-draft.md` v0.3 §3.3.10);与 v1 `users`(登录身份)**强制解耦**(`research.md §6.1`)。

V2 第一阶段**最小骨架**:身份基础 + 启停 + 时间戳 + 字典关联;**任何敏感字段全部禁止**(`member_profiles` 已延后)。

### 5.2 字段说明

| 字段名 | 类型意图 | 是否可空 | 说明 | 来源 |
|---|---|---|---|---|
| `id` | String / cuid | 否 | 主键(**独立 cuid,不复用 `users.id`**)| data-model-draft §3.3.10 M-1 |
| `memberNo` | String | 否 | 队员业务唯一编号 — 救援队入队时人工分配的固定编号;**非敏感**但**高价值**业务标识;创建必填,**禁止 PATCH 修改**;**全局唯一**(不因软删释放) | memberNo 决议(2026-05-08) |
| `displayName` | String | 否 | 称呼 / 显示名(业务可读;**不**写真实姓名 — 由运营在系统内录入) | — |
| `gradeCode` | String | 是 | 引用 `dict_items.code`(隐含 `type code = '队员等级'`)| data-model-draft §3.3.10 M-4 |
| `status` | enum(`ACTIVE` / `INACTIVE`) | 否 | 在队 / 离队状态;最小集 | data-model-draft §3.3.10 M-5 |
| `createdAt` | DateTime | 否 | 创建时间 | baseline §2.1 |
| `updatedAt` | DateTime | 否 | 更新时间 | baseline §2.1 |
| `deletedAt` | DateTime | 是 | 软删除标记 | baseline §10 |

### 5.3 约束与索引意图

- **唯一约束**:`memberNo` **全局唯一**(不在 `deletedAt = null` 范围内,而是包含软删记录的全表唯一)— 确保历史 memberNo 永久绑定历史身份,不复用导致档案歧义
- **业务校验(service 层)**:
  - `memberNo` 创建时必填(DTO 层 `@MinLength(1)`);`trim()` 后保存;长度 1-32(DTO 层 `@MaxLength(32)`);允许字母 / 数字 / 连字符(DTO 层 `@Matches(/^[A-Za-z0-9-]+$/)`);**不**写死真实编号规则,**不**把真实编号样例写进代码
  - `memberNo` 唯一性预检查必须用 `findUnique`(包含软删记录;沿用 `docs/srvf-foundation-baseline.md §10` / `CLAUDE.md §10` 唯一性预检查纪律)— 防止"软删后旧 memberNo 复活创建" 撞约束
  - `gradeCode` 若提供,必须存在于 `dict_items` 中且 type code = '队员等级' 且 `status = ACTIVE`
  - `displayName` 不允许空字符串(DTO 层 `@MinLength(1)`)
- **索引**:`memberNo`(精确查找 + 登录回退查找路径热点)/ `gradeCode`(按等级筛选)/ `status`(按在队 / 离队筛选)/ `createdAt`
- **`displayName` 不强制唯一**:同名队员业务可接受(与 memberNo 的角色分工:`memberNo` 是身份,`displayName` 是称呼)

### 5.4 与 users 的关系

- **解耦红线**(`research.md §6.1`):
  - members 与 users **不**共享 id
  - 一个 user 可能没有对应 member(SUPER_ADMIN / IT 顾问 等)
  - 一个 member 可能没有对应 user(线下队员)
  - 关联关系由 v1 `users.memberId` 可空外键承载(详见 §7)
- **关联方向**:由 `users.memberId` 持有外键,**不**由 `members.userId` 持有;原因:与 v1 兼容性优先(M-2 候选 A)

### 5.5 与 dict_items 的关系

- **`gradeCode` 字符串引用**:V2 第一阶段所有 members 的 gradeCode(若有)必须在 dict_items 中存在(type='队员等级')
- **service 层校验**:同 organizations.nodeTypeCode

### 5.6 软删除与启停策略

- **状态机**:
  - `ACTIVE`(在队)
  - `INACTIVE`(离队 / 退队)
  - 软删 `deletedAt`(整档案逻辑删除,**离队 / 退队后档案完整保留**对应 D5 Q7 ①)
- **离队处理**:`status = INACTIVE`;**不**软删档案;**不**清理任何字段(D5 Q7 ① "完整保留");`memberNo` 仍然占位,无法被新队员复用
- **离队后 v1 user 关联**:`users.memberId` 关联保留;不强制解绑;运营可手动解绑或保留(由业务规则决定)
- **软删时机**:**仅**在档案彻底无效(例如档案误录后清除)时使用 `deletedAt`;不作为离队的常规处理
- **`memberNo` 软删后唯一性**:**全局唯一,永不复用** — 软删 member 的 memberNo 仍占据全局唯一索引位;新建 member 撞旧 memberNo 抛 `MEMBER_NO_ALREADY_EXISTS`(150xx 段位,409)。这是**有意选择**:救援队"编号即身份印记",历史溯源价值高于编号回收
- **物理删除**:**禁止**(沿用 baseline §10)

### 5.7 明确禁止的敏感字段

> **memberNo 不在禁止清单**:`memberNo` 是非敏感、高价值业务标识(类似 v1 `users.username` 的角色但归属 members 域),允许进入 members 主表 + API 出入参 + 日志(不进 V1.1 §17.4 屏蔽清单)。本节仅约束**敏感字段**清单。

V2 第一阶段 members 主表**禁止**包含以下字段(全部延后到 V2.x `member_profiles`,合规材料补齐后启动):

| 字段类别 | 禁止字段示例 |
|---|---|
| 身份证 | idCard / idCardNumber / idNumber / nationalId |
| 联系方式 | phone / mobile / phoneNumber / tel / wechat / wechatId / openId / unionId |
| 紧急联系人 | emergencyContact / emergencyContactName / emergencyContactPhone / emergencyContactRelation |
| 医疗 | medicalInfo / medicalHistory / medicalNotes / allergies / chronicDiseases / bloodType |
| 地址 | address / homeAddress / residenceAddress |
| 出生 / 身份信息 | dateOfBirth / dob / birthDate / 性别 |
| 财务 | bankAccount / bankCard / cardNumber / cvv |
| 凭证 | certificateNo / licenseNo / policyNo |

**v1.1 baseline §8.2 已预扩展屏蔽清单**(commit `3c61dfa` 落地);若未来落表自动屏蔽日志输出。

---

## 6. `member_departments`

### 6.1 解决的问题

承载队员↔部门归属关系(对应 `data-model-draft.md` v0.3 §3.5.10);路径 B(中间表保留 + 单归属约束)。

V2 第一阶段**业务规则**:一人一个正式部门;多部门归属**不**作为业务能力(D7-min MD-6)。

保留中间表是为**未来扩展余地**,而**非**当前业务支持多部门(沿用 D7-min MD-1)。

### 6.2 字段说明

| 字段名 | 类型意图 | 是否可空 | 说明 | 来源 |
|---|---|---|---|---|
| `id` | String / cuid | 否 | 代理主键(**不用复合主键**)| data-model-draft §3.5.10 MD-3 |
| `memberId` | String | 否 | 队员外键(指向 `members.id`)| — |
| `organizationId` | String | 否 | 组织节点外键(指向 `organizations.id`)| — |
| `createdAt` | DateTime | 否 | 创建时间 | baseline §2.1 |
| `updatedAt` | DateTime | 否 | 更新时间 | baseline §2.1 |
| `deletedAt` | DateTime | 是 | 软删除标记 | baseline §10 |

**禁止字段(本阶段)**(对应 D7-min MD-5):

- `isPrimary`(一人一部门前提下冗余)
- `joinedAt` / `endedAt`(D5 Q18 ② "不保留部门归属变更历史")
- 进出原因(走字典 / 自由文本均不引入)
- 跨部门角色 / 跨部门等级(默认全队统一)

### 6.3 约束与索引意图

- **唯一约束**:`(memberId)` 在 `deletedAt = null` 范围内唯一(部分唯一索引)— 对应 D7-min MD-4
  - **优先实施**:Prisma 条件性唯一索引(部分索引带 WHERE 子句),Prisma 6 已支持
  - **降级路径**:若 Prisma 版本不支持,降级到全局唯一约束 + 业务规则保证软删覆盖语义(service 层在创建前先检查并软删旧记录)
- **外键约束**:
  - `memberId` → `members.id`(`onDelete: Restrict`,防止误删带归属的成员)
  - `organizationId` → `organizations.id`(`onDelete: Restrict`,防止误删带成员的部门)
- **索引**:`memberId`(查队员当前部门)/ `organizationId`(查部门成员列表)/ `createdAt`

### 6.4 与 members / organizations 的关系

- **`memberId` → `members.id`**(N:1):队员可有 0 或 1 条 active 归属
- **`organizationId` → `organizations.id`**(N:1):部门可有 0..N 条 active 归属(成员列表)
- **联动 organizations 状态**:
  - 部门 `INACTIVE` / 软删后,关联记录**保留**(不联动;由 service 层在新建归属时校验目标部门 status)
  - 部门 `INACTIVE` 时,**禁止**新建归属;但已有归属可保留(运营人工处理)

### 6.5 单归属规则

V2 第一阶段**业务规则**(对应 D7-min MD-2 / MD-6):

- 一个 `member` 在 `member_departments` 中**最多有 1 条** `deletedAt = null` 的活跃记录
- 想转部门:**先**软删旧归属(设 `deletedAt`)→ **再**创建新归属
- service 层在创建归属前:
  1. 检查目标 member 状态 = ACTIVE
  2. 检查目标 organization 状态 = ACTIVE
  3. 检查目标 nodeTypeCode 类别合法(运营约定哪些 nodeType 可挂队员;若未约定则不限制)
  4. 检查 member 当前是否已有 active 归属 → 有则抛 `MEMBER_DEPARTMENT_ALREADY_EXISTS`(BizCode 段位 `170xx`)

### 6.6 软删除策略

- **创建新归属时**:旧归属(若存在)**先**软删 → 再创建新归属(避免唯一约束冲突)
- **离队 / 退队**(member status → INACTIVE):归属记录**不**自动软删(由 service 层显式调用)
- **物理删除**:**禁止**

---

## 7. `users.memberId` 可空外键追加

### 7.1 变更意图

实施 `data-model-draft.md` v0.3 §3.3.10 M-2 + §4.2.6 决议:在 v1 `users` 表追加可空 `memberId` 字段,作为 v1 user 与 V2 member 的关联点。

### 7.2 v1 兼容性红线(对齐 `docs/archive/plans/architecture-v2-first-stage-blueprint.md §12.8.2`,原 `ARCHITECTURE.md §12.8.2`,PR-6 已归档)

| 维度 | 红线 |
|---|---|
| 新增字段 | **仅追加** `memberId`(可空,unique);**不改**已有字段 |
| 已有字段 | v1 `users` 已有所有字段(`username` / `email` / `passwordHash` / `nickname` / `avatarKey` / `role` / `status` / `lastLoginAt` / `createdAt` / `updatedAt` / `deletedAt` 等)**完全保留**,类型 / 默认值 / 约束不变 |
| 已有索引 | v1 `users` 所有索引(`username` 唯一 / `email` 唯一 / `deletedAt` 等)**完全保留** |
| 已有外键 | v1 `users` 表无外键(独立表);本次追加 `memberId` 外键 → `members.id` 是**首个**外键 |
| 接口契约 | v1 14 接口路径 / HTTP 方法 / 入参 DTO / 出参 DTO / 错误码 / 权限标注 全部不变(详见 §7.3) |
| seed 兼容性 | v1 `seed.ts` 创建 SUPER_ADMIN 不强制绑 member;`memberId` 默认 `null`(详见 §7.4) |

### 7.3 UserResponseDto 约束

| 维度 | 规则 |
|---|---|
| **必返字段**:**不**新增 | v1 `UserResponseDto` 字段集**不变**;`memberId` **不进**必返字段 |
| **可选返回**:由开发任务决定 | `memberId` 是否作为可选返回字段(用 `?` 标记 / `nullable: true` Swagger 标注),由 `docs/archive/plans/v2-first-stage-plan.md §2.5 Step 5`(原 `v2-plan.md §2.5 Step 5`,PR-5 已归档)实施时**显式决定**;**默认不返回** |
| OpenAPI 契约快照 | v1 `UserResponseDto` schema 在快照中保持不变;若 Step 5 决定可选返回,V2 step 在快照中显式更新 |
| 倒灌禁止 | `members.*` 字段**禁止**倒灌进 `UserResponseDto`(沿用 `research.md §5.6` 红线);如需返回 member 信息,通过独立 `MemberResponseDto` 响应 |

### 7.4 seed 兼容性

| 维度 | 规则 |
|---|---|
| SUPER_ADMIN 创建 | v1 `seed.ts` 创建 SUPER_ADMIN 的逻辑**完全不动**(`SUPER_ADMIN_USERNAME` / `SUPER_ADMIN_PASSWORD` / `SUPER_ADMIN_EMAIL` 等环境变量读取 / bcrypt 哈希 / 创建逻辑均保留) |
| SUPER_ADMIN.memberId | 默认 `null`(不绑 member);若运营后续要绑,通过运营后台或独立接口操作 |
| seed 新增内容 | 仅追加字典 neutral-demo seed(`docs/archive/plans/v2-first-stage-plan.md §2.2 Step 2`,原 `v2-plan.md §2.2 Step 2`,PR-5 已归档);**不**新增 organizations / members / member_departments seed |

### 7.5 字段说明(仅追加部分)

| 字段名 | 类型意图 | 是否可空 | 说明 | 来源 |
|---|---|---|---|---|
| `memberId` | String | **是** | 关联到 `members.id`;不强制绑定;一个 user 至多绑一个 member | data-model-draft §3.3.10 M-2 / §4.2.6 |

### 7.6 约束与索引意图

- **唯一约束**:`memberId` 全局唯一(在 `deletedAt = null` 范围内由 v1 软删语义保障)— 一个 member 至多被一个 user 引用
- **外键约束**:`memberId` → `members.id`(`onDelete: SetNull`,member 软删后 user 自动解绑;实施时评估;若 member 不允许物理删除则 `Restrict` 也可)
- **索引**:`memberId`(用于按 member 反查 user)

---

## 8. 跨模型规则

### 8.1 通用字段

所有 V2 新模型共享以下通用字段(对齐 baseline §2.1):

| 字段名 | 类型意图 | 是否可空 | 备注 |
|---|---|---|---|
| `id` | String / cuid | 否 | 主键;cuid 由应用层生成,**不**用数据库自增 |
| `createdAt` | DateTime | 否 | 创建时间;Prisma 自动填充 |
| `updatedAt` | DateTime | 否 | 更新时间;Prisma 自动填充 |
| `deletedAt` | DateTime | 是 | 软删除标记;`null` 表示未删除 |

`audit_logs` 例外(已延后,但若 V2.x 启动时遵守):无 `updatedAt` / 无 `deletedAt`(沿用 `data-model-draft.md` v0.3 §3.7.10)。

### 8.2 字典引用统一 `<concept>Code`

V2 全模块统一(对应 D-2 候选 A,锁定):

- 字典引用字段命名:`<concept>Code` 字符串字段
- 例:`organizations.nodeTypeCode` / `members.gradeCode`
- **禁止** `<concept>ItemId` 关联外键 / 混合引用(违反 baseline §2.2.5)
- **禁止**直接存 `(typeCode, itemCode)` 复合字段(冗余且不简洁)
- **隐含 type 语义**:字段名(如 `nodeTypeCode`)隐含 type code(`'节点类别'`);引用层不存 typeId

**校验责任**(service 层):

- 创建 / 更新业务记录前,先 `findUnique` 查 `dict_items` 中 (type=对应类型, code=输入值, status=ACTIVE) 的记录;不存在 → 抛对应错误码

### 8.3 软删除规则

V2 第一阶段所有模型沿用 baseline §10:

- 字段:`deletedAt: DateTime?`
- 不引入 Prisma 全局软删除中间件 / client extension / BaseRepository / 装饰器 / Pipe / Guard / Interceptor 等隐式自动过滤
- 显式调用 `notDeletedWhere` helper(commit `d8fd444` 已就位)
- 唯一性预检查用 `findUnique` 包含软删记录(防止软删后 code / 唯一字段被复用导致约束冲突)
- 各表软删策略详情见各模型 §X.6 节

### 8.4 启停 status 规则

V2 第一阶段所有模型若有启停语义,**统一**用 `status` enum 字段(对齐 baseline §2.2.3):

| 模型 | status enum 值域 |
|---|---|
| `dict_types` | `ACTIVE` / `INACTIVE` |
| `dict_items` | `ACTIVE` / `INACTIVE` |
| `organizations` | `ACTIVE` / `INACTIVE` |
| `members` | `ACTIVE`(在队)/ `INACTIVE`(离队 / 退队)|
| `member_departments` | **不挂** status 字段;通过 `deletedAt` 区分 active 与历史 |

- **禁止** `isActive` / `isEnabled` / `enabled` 等多名字混用(对齐 baseline §2.2.3)
- enum 命名遵守 baseline §2.2(全大写 SNAKE_CASE)
- enum 在 Prisma schema 中作为 enum 定义,从 `@prisma/client` 导出 type 与 service 层使用

### 8.5 排序字段规则

V2 第一阶段需要"运营自定义顺序"的字段引入 `sortOrder: Int`(默认 0):

- `dict_types.sortOrder`
- `dict_items.sortOrder`(同级排序)
- `organizations.sortOrder`(同级排序)
- `members.sortOrder` — **不引入**(默认按 createdAt 降序;运营无自定义顺序需求)
- `member_departments.sortOrder` — **不引入**

排序规则:`sortOrder ASC`(数值小的在前)→ 同值按 `createdAt DESC`(新创建的在前)。

### 8.6 时间字段规则

- 全栈 UTC(对齐 baseline §12)
- Prisma `DateTime` 类型(底层映射 PostgreSQL `timestamptz`)
- 应用层用 JS `Date` 对象
- API 响应序列化为 ISO 8601 with `Z` 后缀
- 前端展示层负责本地时区转换
- **禁止**后端按"中国时区"提前转换

---

## 9. BizCode 段位映射

V2 第一阶段 BizCode 段位分配(对齐 baseline §1.1):

| 模块 | 段位 | 容量 | 状态 |
|---|---|---|---|
| `dictionaries`(`dict_types` + `dict_items` 共享)| `120xx + 121xx` | 200 | V2 第一阶段开发 |
| `organizations` | `110xx + 111xx` | 200 | V2 第一阶段开发 |
| `members` | `150xx + 151xx` | 200 | V2 第一阶段开发 |
| `member_departments` | `170xx + 171xx` | 200 | V2 第一阶段开发 |
| `member_profiles` | `160xx + 161xx` | 200 | V2.x 复活时使用 |
| `attachments` | `130xx + 131xx` | 200 | V2.x 复活时使用 |
| `audit_logs` | `140xx + 141xx` | 200 | V2.x 复活时使用 |
| `events` | `180xx + 181xx` | 200 | V2.x 复活时使用 |
| `event_participants` | `190xx + 191xx` | 200 | V2.x 复活时使用 |

每模块 200 号段内的细分(对齐 baseline §1.3):

- `XX0xx` — 实体级错误(NOT_FOUND / ALREADY_EXISTS / 业务校验 / 资源状态非法 / 引用约束)
- `XX1xx` — 权限 / 操作 / 完整性

**新增 BizCode 必走流程**(对齐 baseline §1.4):

1. 先说明使用场景与前端提示价值
2. 用户确认后加入对应模块段位
3. 显式声明 `httpStatus`(三字段对象 `{ code, message, httpStatus }`)
4. 模块内的 BizCode 常量按数值排序

V2 第一阶段预期使用的 BizCode 类型(具体编号由 Step 3-6 实施时分配):

- `<RESOURCE>_NOT_FOUND`(资源不存在)
- `<RESOURCE>_<FIELD>_ALREADY_EXISTS`(唯一冲突)
- `<RESOURCE>_<RULE>`(业务级输入校验,如 `ORGANIZATION_PARENT_CYCLE` / `ORGANIZATION_PARENT_IMMUTABLE`)
- `<RESOURCE>_HAS_<DEPENDENT>`(引用约束,如 `ORGANIZATION_HAS_MEMBERS` / `DICT_ITEM_IN_USE`)
- `MEMBER_NO_ALREADY_EXISTS`(150xx 段位,409 — memberNo 全局唯一冲突;包含撞软删历史 memberNo)
- `MEMBER_DEPARTMENT_ALREADY_EXISTS`(单归属约束撞)
- `FORBIDDEN_<ACTION>_<RESOURCE>`(权限拒绝)
- `LOGIN_FAILED = 10004`:登录账号枚举相关失败场景统一抛(输入值在 `username` / `memberNo` 两条查找路径下均未命中 / `memberNo` 命中但未绑定 user / 账号禁用或软删 / 密码错);**复用** v1 已有错误码,**禁止**为 memberNo 路径自创新业务码(避免账号枚举);详见 `docs/v2-api-contract.md §6.6.3` 失败场景表

---

## 10. schema 实现注意事项

### 10.1 Prisma model 命名

- 模型类名:PascalCase(`DictType` / `DictItem` / `Organization` / `Member` / `MemberDepartment`)
- 表名:Prisma 默认按模型名复数(`dict_types` / `dict_items` / `organizations` / `members` / `member_departments`);若 Prisma 默认行为不符合预期,可显式 mapping(本节**不**写具体 mapping 装饰器)
- 关系命名:遵守 baseline §2.2.1(`<relation>Id` 单关联外键)

### 10.2 Enum 定义位置

- V2 新增 enum:在 `prisma/schema.prisma` 中定义(`OrganizationStatus` / `MemberStatus` / `DictTypeStatus` / `DictItemStatus` 等;实施时评估是否合并为一个通用 `Status` enum)
- 从 `@prisma/client` 导入 type 与 service 层使用(对齐 v1 §3 命名铁律)
- enum 命名遵守 baseline §2.2(全大写 SNAKE_CASE);若 enum 跨模型共用,命名为通用名(`Status`);若按模型命名,以模型名为前缀

### 10.3 关系定义

- 一对多:Prisma `@relation` 关系定义(详细 DSL 由 Step 1 实施);本节描述意图:
  - `dict_types` 1 — N `dict_items`(`dict_items.typeId` 持有外键)
  - `dict_items` 自引用 `parentId`
  - `organizations` 自引用 `parentId`
  - `users` 1 — 0..1 `members`(`users.memberId` 持有外键)
  - `members` 1 — 0..1 `member_departments`(active);1 — N `member_departments`(含历史)
  - `organizations` 1 — 0..N `member_departments`

### 10.4 索引策略

实施时优先建立:

- 单字段唯一约束(对应 §2-§7 各 §X.3 节标注)
- 部分唯一索引(条件性约束,WHERE `deletedAt IS NULL`)— Prisma 6 已支持;若版本不支持降级
- 普通索引:外键字段(查询 hot path)+ status / createdAt(常用过滤 / 排序)

### 10.5 Migration 命名

migration 文件按现有 `prisma/migrations/` 时间戳风格命名;本批 V2 第一阶段的 migration 命名建议:`<timestamp>_v2_foundation` 或拆分多个(若 Step 1 内部按子 commit 拆分):
- `<timestamp>_v2_dictionaries`
- `<timestamp>_v2_organizations`
- `<timestamp>_v2_members_and_users_member_id`
- `<timestamp>_v2_member_departments`

具体由 v2-plan §2.1 Step 1 实施时决定(单 migration vs 多 migration)。

---

## 11. 不在本模型说明范围

### 11.1 不覆盖的模型

以下模型**完全不在**本文范围(对应 D7-min 决议延后到 V2.x):

- `member_profiles`(任何敏感字段 — 身份证 / 紧急联系人 / 医疗 / 出生日期 / 住址 / 性别 / 第三方账号 / 凭证标识 等)
- `attachments`(附件元数据 / 上传 Provider)
- `audit_logs`(审计基础设施 / 任何接入)
- `events`(活动事件)
- `event_participants`(参与状态)

V2.x 复活触发条件见 [`docs/V2红线与复活路径.md §4.3`](V2红线与复活路径.md)。

### 11.2 不写入的内容

- ❌ 真实成员 PII(姓名 / 身份证 / 手机号)+ 真实编号规则 / 样例(memberNo)— R13 红线(2026-06-21 收窄;权威源 `V2红线与复活路径.md` A-9)
- ℹ️ 非敏感分类字典取值(国标参照 gender / blood_type / … / ethnicity + 队内 member_grade 级别名 / activity_type 活动类别)已内置 `prisma/seed.ts` seed;node_type / work_nature 仍占位(组织树另起 goal)
- ❌ 完整 Prisma `model {}` 块
- ❌ Migration SQL
- ❌ Controller / Service / DTO class 完整代码
- ❌ API 路径 / Swagger 装饰器
- ❌ 上传 Provider 实装
- ❌ RBAC / permission 表 / casl
- ❌ Redis / 队列 / 定时任务
- ❌ 字典缓存策略

---

## 附录 A:模型关系文字图

```
┌──────────────────────┐
│ users (v1)           │
│ - id                 │
│ - 已有所有字段        │
│ - memberId? (新追加)  │──── 0..1 ───┐
└──────────────────────┘             │
                                     ▼
                          ┌──────────────────────┐
                          │ members              │
                          │ - id (独立 cuid)     │
                          │ - memberNo (全局唯一)│
                          │ - displayName        │
                          │ - gradeCode? ────────┼──── N..1 ───┐
                          │ - status             │             │
                          └──────────────────────┘             │
                                  │                            │
                                  │ 1                          │
                                  │                            │
                                  ▼                            │
                          ┌──────────────────────┐             │
                          │ member_departments   │             │
                          │ - id                 │             │
                          │ - memberId           │             │
                          │ - organizationId ────┼──── N..1 ───┼──┐
                          │ - (memberId) 唯一    │             │  │
                          │   在 deletedAt=null  │             │  │
                          └──────────────────────┘             │  │
                                                               │  │
                          ┌──────────────────────┐             │  │
                          │ organizations        │ ◄───────────┼──┘
                          │ - id                 │             │
                          │ - name               │             │
                          │ - parentId? ─────────┐             │
                          │ - nodeTypeCode ──────┼─────────────┤
                          │ - status             │ │           │
                          └──────────────────────┘ │           │
                                  ▲                │           │
                                  └────────────────┘           │
                                  自引用                        │
                                                               │
                          ┌──────────────────────┐             │
                          │ dict_items           │ ◄───────────┘
                          │ - id                 │ (通过 code 字符串引用,非外键)
                          │ - typeId ────────────┐
                          │ - code               │
                          │ - parentId? ─────────┤
                          │ - status             │ │
                          └──────────────────────┘ │
                                  ▲ │              │
                                  │ │ 自引用        │
                                  └─┘              │
                                                   │
                          ┌──────────────────────┐ │
                          │ dict_types           │ │
                          │ - id                 │ ◄
                          │ - code (全局唯一)    │
                          │ - status             │
                          └──────────────────────┘
```

**关键关系**:

| 关系 | 类型 | 持有外键 |
|---|---|---|
| users → members | 0..1 | `users.memberId` |
| members → dict_items(等级) | N..1 字符串引用 | `members.gradeCode`(非外键) |
| organizations → dict_items(节点类别) | N..1 字符串引用 | `organizations.nodeTypeCode`(非外键) |
| organizations → organizations | 自引用 0..1 | `organizations.parentId` |
| dict_items → dict_types | N..1 | `dict_items.typeId`(外键) |
| dict_items → dict_items | 自引用 0..1 | `dict_items.parentId` |
| member_departments → members | N..1 | `member_departments.memberId`(外键) |
| member_departments → organizations | N..1 | `member_departments.organizationId`(外键) |

---

## 附录 B:版本表

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-05-07 | 初版,V2-D8 立项 D8-3 产出物;覆盖 4 模型 + `users.memberId` 追加 + 跨模型规则 + BizCode 段位映射 + schema 实现注意事项 + 模型关系文字图 |
| v0.2 | 2026-05-08 | memberNo 决议(Q1=A / Q2=B-1 / Q3-Q9):§5.2 字段表加 memberNo / §5.3 全局唯一约束 + 弱约束校验 / §5.6 软删后 memberNo 永不复用 / §5.7 明确 memberNo 不属敏感 / §9 BizCode 加 MEMBER_NO_ALREADY_EXISTS + 登录账号枚举相关失败场景统一 LOGIN_FAILED / 附录 A 模型图加 memberNo |
| v0.3 | 2026-05-23 | G1-PR-B 治理刷新:头部追加 v0.15.0+ 治理回填声明 — 明确本文为 V2-D8 立项时刻 draft 历史快照,V2 第一阶段 4 模型 + `users.memberId` 追加 + 批次 1/2/3A/3B/4-A/4-B/6 + RBAC 四表 + attachments 三表 + storage_settings + refresh_tokens 已实装;字段 / 类型 / 约束 / 索引事实权威源以 `prisma/schema.prisma` 为准;正文(含 §0 阶段状态 / §1 模型清单 / §9 BizCode 段位映射 / §11 "不覆盖的模型")中"V2-D8 立项中 / 初稿 / 待 Step 1 启动 / 不覆盖 `member_profiles` / `attachments` / `audit_logs`"等表述属文档定稿时刻状态,**不代表当前事实**;正文未逐行重写,保留为历史 draft 快照 |

---

> **本文是 D8-3 立项产出物**;V2-D8 标记完成需 5 份立项产出物全部就位(对应 `docs/archive/plans/architecture-v2-first-stage-blueprint.md §12.11.1`,原 `ARCHITECTURE.md §12.11.1`,PR-6 已归档)。
> Step 1 启动需 V2-D8 ✅ + 用户单独拍板;**禁止**绕过 D8 直接进入开发。
