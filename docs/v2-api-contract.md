# V2 第一阶段 API 契约草案

> **回填注(2026-05-17 / v0.13.0)**:本文起源于 V2-D8 立项阶段的 API 契约**草案**。**当前 V2 第一阶段及后续批次接口已实施并随 v0.10.0 / v0.11.0 / v0.12.0 / v0.13.0 发布**,通过 OpenAPI contract snapshot(`pnpm test:contract`)+ zero drift 机制约束。**当前完整前端联调口径以 [`docs/first-release-frontend-scope.md`](first-release-frontend-scope.md) + Swagger UI(`/api/docs`)+ OpenAPI snapshot 为准**;本文保留为契约草案历史快照,字段级细节如与代码不一致**以代码 / OpenAPI 为准**。下方"初稿 / 草案 / V2-D8 立项中"等表述是文档定稿时刻的阶段状态,不再代表当前。

> 派生项目:**srvf-nest-api**
> 文档定位:**V2 第一阶段 API 契约草案**(D8-4 立项产出物)
> 阶段:**V2-D8 立项中**(2026-05-07)
> 状态:**初稿**,待 D8 立项 5 份产出物全部就位 + 用户拍板才能启动 Step 1
> 依据:`docs/archive/plans/architecture-v2-first-stage-blueprint.md §12.8-§12.11`(原 `ARCHITECTURE.md §12.8-§12.11`,commit `85cec75`,PR-6 已归档)+ `docs/archive/plans/v2-first-stage-plan.md`(原 `docs/v2-plan.md`,commit `bff9c93`,PR-5 已归档)+ `docs/v2-data-model.md`(commit `af236f2`)+ `data-model-draft.md` v0.3 D7-min(commit `4333c31`)+ baseline(commit `16876fe`)

---

## 0. 文档定位

### 0.1 本文是什么

- V2 第一阶段 API **契约级**草案:HTTP 方法 / 路径 / 入参字段类别 / 出参字段类别 / 权限角色 / 主要错误码 / OpenAPI 快照协议
- 配合 `docs/archive/plans/v2-first-stage-plan.md` Step 3-6 任务卡(原 `docs/v2-plan.md`,PR-5 已归档)+ `docs/v2-data-model.md` 数据模型 + `TASKS.md §6` 任务卡(D8-5 待产出)使用

### 0.2 本文不是什么

- **不是** Controller / Service / DTO class 代码 — 由 v2-plan Step 3-6 实施期编写
- **不是**完整 DTO class 定义 — 仅描述字段类别;具体 DTO 类成员由 Step 3-6 落地
- **不是** Swagger 装饰器代码 — 不写 `@ApiProperty` / `@ApiOperation` / `@Controller` / `@Get` 等装饰器
- **不是**完整接口实现规范 — 不写参数顺序 / 错误处理细节 / DB 事务边界等
- **不是** Prisma schema / migration — 数据层面见 `docs/v2-data-model.md`
- **不是**真实业务取值 — 真实部门名 / 等级名 / 字典内容**不进**本文(R13)
- **不是**已确认开发启动 — V2-D8 标记完成需 5 份立项产出物全部就位

### 0.3 契约状态

本契约为**草案**,接口数量与签名待 V2-D8 立项 commit 完整后 + Step 3-6 实施期可能微调。重大调整(新增 / 删除 / 改路径 / 改方法)需:

1. 在 `docs/archive/plans/v2-first-stage-plan.md`(原 v2-plan.md,PR-5 已归档)/ v2-data-model.md / 本文同步更新
2. 通过 OpenAPI 契约快照对比对比(`pnpm test:contract`)
3. 用户拍板

### 0.4 路径前缀约定

**约定**:V2 接口路径统一以 `/api/v2/` 开头作为契约草案占位,**与 v1 14 接口完全分离**(v1 接口路径为 `/api/...`,无 `v2`)。

**待确认事项**(D8 开发前最终拍板):

- 是否真的使用 `/api/v2/` 前缀,还是延续 `/api/` 不分版本(如 `/api/dictionaries`)
- NestJS 版本化机制选择:URI 路径前缀 / Header / Media Type
- 若不带 v2,需另行设计 V2 接口与 v1 14 接口的命名空间隔离方案

**本文先用 `/api/v2/` 作为契约草案占位**,避免与 v1 接口混淆;最终路径前缀在 Step 3 启动前由用户单独拍板,届时**全文统一替换**(纯文档修订,无代码影响)。

### 0.5 修订纪律

- 修订需用户拍板,**禁止** AI 自行扩张
- 修订 commit message 前缀:`v2-design: v2-api-contract <章节> <简述>`
- 修订需在附录 C 版本表显式记录
- 重大签名调整需同步 OpenAPI 契约快照(由 Step 7 收口处理)

---

## 1. 总览

### 1.1 模块清单

V2 第一阶段开发范围共 **4 个新模块** + **1 项 v1 兼容性追加**:

| # | 模块 | 接口数 | 来源章节 |
|---|---|---|---|
| 1 | `dictionaries`(`dict_types` + `dict_items`)| 13 | §2 |
| 2 | `organizations` | 7 | §3 |
| 3 | `members` | 6 | §4 |
| 4 | `member_departments` | 3 | §5 |
| — | v1 `users` 兼容性追加(无新接口)| 0 | §6 |

**第一阶段不开发**(完整延后清单见 `docs/archive/plans/architecture-v2-first-stage-blueprint.md §12.8.1`,原 `ARCHITECTURE.md §12.8.1`,PR-6 已归档):

- `member_profiles` 已在批次 1 落地(本契约草案撰写时延后,实际已合并 main;契约信息见 `SRVF/04-Schema设计/批次1_API前评审_member_profiles_emergency_contacts.md`);`attachments` / `audit_logs` / `events` / `event_participants` 仍延后,**无任何接口**

### 1.2 接口总览表

| # | 方法 | 路径 | 模块 | 简述 |
|---|---|---|---|---|
| 1 | GET | `/api/v2/dict-types` | dictionaries | 列出字典类型(分页) |
| 2 | POST | `/api/v2/dict-types` | dictionaries | 创建字典类型 |
| 3 | GET | `/api/v2/dict-types/:id` | dictionaries | 字典类型详情 |
| 4 | PATCH | `/api/v2/dict-types/:id` | dictionaries | 更新字典类型(label / sortOrder) |
| 5 | PATCH | `/api/v2/dict-types/:id/status` | dictionaries | 启停字典类型 |
| 6 | DELETE | `/api/v2/dict-types/:id` | dictionaries | 软删字典类型 |
| 7 | GET | `/api/v2/dict-items` | dictionaries | 列出字典项(分页;按 typeId 过滤) |
| 8 | POST | `/api/v2/dict-items` | dictionaries | 创建字典项 |
| 9 | GET | `/api/v2/dict-items/:id` | dictionaries | 字典项详情 |
| 10 | PATCH | `/api/v2/dict-items/:id` | dictionaries | 更新字典项(label / sortOrder) |
| 11 | PATCH | `/api/v2/dict-items/:id/status` | dictionaries | 启停字典项 |
| 12 | DELETE | `/api/v2/dict-items/:id` | dictionaries | 软删字典项 |
| 13 | GET | `/api/v2/dict-items/tree` | dictionaries | 字典项树形(按 typeId 拼接父子) |
| 14 | GET | `/api/v2/organizations` | organizations | 列出组织节点(分页) |
| 15 | GET | `/api/v2/organizations/tree` | organizations | 组织树形 |
| 16 | POST | `/api/v2/organizations` | organizations | 创建组织节点 |
| 17 | GET | `/api/v2/organizations/:id` | organizations | 组织节点详情 |
| 18 | PATCH | `/api/v2/organizations/:id` | organizations | 更新组织节点(name / sortOrder / nodeTypeCode);**禁止**改 parentId |
| 19 | PATCH | `/api/v2/organizations/:id/status` | organizations | 启停组织节点 |
| 20 | DELETE | `/api/v2/organizations/:id` | organizations | 软删组织节点 |
| 21 | GET | `/api/v2/members` | members | 列出队员(分页;支持 memberNo 精确查询) |
| 22 | POST | `/api/v2/members` | members | 创建队员(memberNo 必填) |
| 23 | GET | `/api/v2/members/:id` | members | 队员详情(返回 memberNo) |
| 24 | PATCH | `/api/v2/members/:id` | members | 更新队员(displayName / gradeCode;**禁止改 memberNo**) |
| 25 | PATCH | `/api/v2/members/:id/status` | members | 切换队员 status(ACTIVE↔INACTIVE) |
| 26 | DELETE | `/api/v2/members/:id` | members | 软删队员 |
| 27 | GET | `/api/v2/members/:memberId/department` | member_departments | 查队员当前部门归属 |
| 28 | PUT | `/api/v2/members/:memberId/department` | member_departments | 设置 / 更换队员正式部门 |
| 29 | DELETE | `/api/v2/members/:memberId/department` | member_departments | 解除当前部门归属(软删) |

**接口数小计**:**29 个 V2 新接口** + 0 个 v1 兼容性追加 = **29**。

### 1.3 权限总览

V2 第一阶段沿用 v1 三角色:`USER` / `ADMIN` / `SUPER_ADMIN`。

| 角色 | V2 接口默认权限 |
|---|---|
| `USER` | **不开放** V2 管理接口(沿用 v1 §13 角色边界;若未来需要"本人查询自己的 member 信息",作为 V2.x 独立接口处理)|
| `ADMIN` | **可访问**全部 V2 第一阶段接口 |
| `SUPER_ADMIN` | **可访问**全部 V2 第一阶段接口 |

V2 第一阶段**不引入**部门级数据范围权限(沿用 `research.md §3.11` / `data-model-draft.md §3.11`);若后续需要"部门负责人只能管本部门人",通过 Service 层显式 `assertCanXxx` 实现,**不**引入 RBAC / permission 表 / casl(沿用 baseline 约束)。

V2 第一阶段**不实现**"本人改自己 member 资料"接口(沿用 v1 不做"本人改密码"原则)。

### 1.4 响应包装规则

**全部 V2 接口**(无例外)沿用 v1 `ResponseInterceptor`(对齐 baseline §3.1):

| 场景 | 响应体 | HTTP status |
|---|---|---|
| 成功(返回单对象)| `{ code: 0, message: 'ok', data: <T> }` | 200 / 201 |
| 成功(返回数组)| `{ code: 0, message: 'ok', data: <T[]> }` | 200 |
| 成功(分页)| `{ code: 0, message: 'ok', data: { items, total, page, pageSize } }` | 200 |
| 业务错误 | `{ code: <BizCode>, message: <text>, data: null }` | 由 BizCode.httpStatus 决定 |

业务代码**只 `return data`**,**禁止**手动包外层结构(沿用 baseline §3.1)。

### 1.5 分页规则

V2 列表接口**统一**使用 `PaginationQueryDto`(对齐 baseline §3.2 / v1 §4):

- 入参:`?page=<number>&pageSize=<number>` / 默认 `page=1` / `pageSize=20` / `pageSize` 最大 100
- 出参:`PageResultDto<T>` 形态 — `{ items, total, page, pageSize }`
- 默认排序:`orderBy: { sortOrder: 'asc' }` 或 `{ createdAt: 'desc' }`(各模块按业务语义决定;具体由 Step 3-6 实施时锁定)
- **禁止** `limit/offset` / `skip/take` / `cursor` / `{ list, count }` / `{ rows, total }` 等变体

### 1.6 错误码规则

V2 第一阶段所有 BizCode 沿用 baseline §1 / §6 命名规范:

- 新增 BizCode 必走流程:先说明使用场景与前端提示价值 → 用户确认后加入 → 显式声明 `httpStatus` → 模块内按数值排序
- 通用 token / 鉴权失败复用 v1 `UNAUTHORIZED = 40100`,**禁止**自创业务码
- 限流复用 V1.1 `TOO_MANY_REQUESTS = 42900`
- 业务码段位见 §附录 B
- 错误码命名遵守 baseline §6:`<RESOURCE>_NOT_FOUND` / `<RESOURCE>_<FIELD>_ALREADY_EXISTS` / `<RESOURCE>_<RULE>` / `FORBIDDEN_<ACTION>_<RESOURCE>` 等

---

## 2. dictionaries 接口契约

### 2.1 dict_types 接口列表

| # | 方法 | 路径 | 简述 |
|---|---|---|---|
| 1 | GET | `/api/v2/dict-types` | 列出字典类型(分页) |
| 2 | POST | `/api/v2/dict-types` | 创建字典类型 |
| 3 | GET | `/api/v2/dict-types/:id` | 字典类型详情 |
| 4 | PATCH | `/api/v2/dict-types/:id` | 更新字典类型(label / sortOrder) |
| 5 | PATCH | `/api/v2/dict-types/:id/status` | 启停字典类型 |
| 6 | DELETE | `/api/v2/dict-types/:id` | 软删字典类型 |

#### 接口详情速览

```
GET /api/v2/dict-types
  入参:PaginationQueryDto + ?status=ACTIVE|INACTIVE(可选过滤)
  出参:PageResultDto<DictTypeResponseDto>
  权限:ADMIN / SUPER_ADMIN
  默认排序:sortOrder ASC, createdAt DESC

POST /api/v2/dict-types
  入参:CreateDictTypeDto { code, label, sortOrder? }
  出参:DictTypeResponseDto
  权限:ADMIN / SUPER_ADMIN
  状态:201 Created
  错误码:DICT_TYPE_CODE_ALREADY_EXISTS(撞唯一约束)

GET /api/v2/dict-types/:id
  入参:IdParamDto
  出参:DictTypeResponseDto
  权限:ADMIN / SUPER_ADMIN
  错误码:DICT_TYPE_NOT_FOUND

PATCH /api/v2/dict-types/:id
  入参:UpdateDictTypeDto { label?, sortOrder? }(白名单仅这两个字段)
  出参:DictTypeResponseDto
  权限:ADMIN / SUPER_ADMIN
  备注:**禁止**通过本接口改 code(code 是业务标识,稳定)
  错误码:DICT_TYPE_NOT_FOUND

PATCH /api/v2/dict-types/:id/status
  入参:UpdateDictTypeStatusDto { status: 'ACTIVE' | 'INACTIVE' }
  出参:DictTypeResponseDto
  权限:ADMIN / SUPER_ADMIN
  错误码:DICT_TYPE_NOT_FOUND

DELETE /api/v2/dict-types/:id
  入参:IdParamDto
  出参:无 data(返回包装为 { code: 0, message: 'ok', data: null })
  权限:SUPER_ADMIN(软删属高危,提级到超级管理员)
  错误码:DICT_TYPE_NOT_FOUND / DICT_TYPE_IN_USE(若有 dict_items 引用 / 业务表引用)
```

#### DictTypeResponseDto 字段类别

| 字段名 | 类型意图 | 说明 |
|---|---|---|
| `id` | String | cuid |
| `code` | String | 类型业务标识(全局唯一) |
| `label` | String | 显示名 |
| `status` | String enum | `ACTIVE` / `INACTIVE` |
| `sortOrder` | Int | 排序权重 |
| `createdAt` | String(ISO 8601 UTC)| 创建时间 |
| `updatedAt` | String(ISO 8601 UTC)| 更新时间 |

**不返回字段**:`deletedAt`(软删除内部状态;查询接口已通过 `notDeletedWhere` 过滤)

### 2.2 dict_items 接口列表

| # | 方法 | 路径 | 简述 |
|---|---|---|---|
| 7 | GET | `/api/v2/dict-items` | 列出字典项(分页;按 typeId 过滤) |
| 8 | POST | `/api/v2/dict-items` | 创建字典项 |
| 9 | GET | `/api/v2/dict-items/:id` | 字典项详情 |
| 10 | PATCH | `/api/v2/dict-items/:id` | 更新字典项(label / sortOrder) |
| 11 | PATCH | `/api/v2/dict-items/:id/status` | 启停字典项 |
| 12 | DELETE | `/api/v2/dict-items/:id` | 软删字典项 |
| 13 | GET | `/api/v2/dict-items/tree` | 字典项树形 |

#### 接口详情速览

```
GET /api/v2/dict-items
  入参:PaginationQueryDto + ?typeId=<id>(必填)+ ?parentId=<id>(可选,过滤同级)+ ?status=...
  出参:PageResultDto<DictItemResponseDto>
  权限:ADMIN / SUPER_ADMIN

POST /api/v2/dict-items
  入参:CreateDictItemDto { typeId, code, label, parentId?, sortOrder? }
  出参:DictItemResponseDto
  权限:ADMIN / SUPER_ADMIN
  错误码:DICT_TYPE_NOT_FOUND(typeId 不存在)/ DICT_ITEM_CODE_ALREADY_EXISTS(在同 typeId 下 code 重复)/ DICT_ITEM_PARENT_TYPE_MISMATCH(parentId 跨 type)/ DICT_ITEM_PARENT_CYCLE(自环)

GET /api/v2/dict-items/:id
  入参:IdParamDto
  出参:DictItemResponseDto
  权限:ADMIN / SUPER_ADMIN
  错误码:DICT_ITEM_NOT_FOUND

PATCH /api/v2/dict-items/:id
  入参:UpdateDictItemDto { label?, sortOrder? }(白名单仅这两个字段)
  出参:DictItemResponseDto
  权限:ADMIN / SUPER_ADMIN
  备注:**禁止**通过本接口改 typeId / code / parentId
  错误码:DICT_ITEM_NOT_FOUND

PATCH /api/v2/dict-items/:id/status
  入参:UpdateDictItemStatusDto { status }
  出参:DictItemResponseDto
  权限:ADMIN / SUPER_ADMIN
  错误码:DICT_ITEM_NOT_FOUND

DELETE /api/v2/dict-items/:id
  入参:IdParamDto
  出参:null
  权限:SUPER_ADMIN
  备注:对应 §2.5 软删语义(`research.md §6.5` 优先启停不物理删)
  错误码:DICT_ITEM_NOT_FOUND / DICT_ITEM_IN_USE(若有业务表引用此 code)

GET /api/v2/dict-items/tree
  入参:?typeId=<id>(必填)+ ?status=ACTIVE(默认仅返回 active)
  出参:DictItemTreeNodeDto[](嵌套结构,每节点含 children?)
  权限:ADMIN / SUPER_ADMIN
  错误码:DICT_TYPE_NOT_FOUND
```

#### DictItemResponseDto 字段类别

| 字段名 | 类型意图 | 说明 |
|---|---|---|
| `id` | String | cuid |
| `typeId` | String | 类型外键 |
| `code` | String | items 业务标识(在 type 范围内唯一) |
| `label` | String | 显示名 |
| `parentId` | String? | 父级自引用(`null` = 顶层) |
| `sortOrder` | Int | 排序权重 |
| `status` | String enum | ACTIVE / INACTIVE |
| `createdAt` | String(ISO 8601 UTC)| — |
| `updatedAt` | String(ISO 8601 UTC)| — |

**不返回字段**:`deletedAt`

### 2.3 父子树形查询

`GET /api/v2/dict-items/tree`:

- 输入:`typeId`(必填)
- 输出:嵌套树结构(每节点含 `children: DictItemTreeNodeDto[]`,空数组表示叶子)
- 算法:service 层先按 typeId 拉取全量 items(filter `deletedAt = null`),内存中按 `parentId` 拼接树
- 性能:V2 第一阶段字典 items 数量级低(单 type 数十条),内存拼接足够;若未来量级膨胀,作为 V2.x 优化项
- 排序:同级按 `sortOrder ASC, createdAt DESC`

### 2.4 启停 / 软删语义

| 操作 | 字段变化 | 业务影响 |
|---|---|---|
| 启停(PATCH /:id/status)| `status: ACTIVE ↔ INACTIVE` | INACTIVE items 不出现在默认列表;但已有业务引用(如 `members.gradeCode`)不受影响 |
| 软删(DELETE /:id)| `deletedAt` 设为当前时间 | items 在所有查询中过滤掉;但 service 层 `findUnique` 仍可读到(防止 code 被复用)|

**对应红线**(`research.md §6.5`):字典 items 优先启停,不物理删;`deletedAt` 防御性留置。

### 2.5 主要错误码

| 错误码 | 段位 | message | httpStatus |
|---|---|---|---|
| `DICT_TYPE_NOT_FOUND` | 120xx | 字典类型不存在 | 404 |
| `DICT_TYPE_CODE_ALREADY_EXISTS` | 120xx | 字典类型 code 已存在 | 409 |
| `DICT_TYPE_IN_USE` | 120xx | 字典类型仍有项目引用,不能删除 | 409 |
| `DICT_ITEM_NOT_FOUND` | 120xx | 字典项不存在 | 404 |
| `DICT_ITEM_CODE_ALREADY_EXISTS` | 120xx | 同类型下字典项 code 已存在 | 409 |
| `DICT_ITEM_PARENT_TYPE_MISMATCH` | 120xx | 字典项父级跨类型 | 400 |
| `DICT_ITEM_PARENT_CYCLE` | 120xx | 字典项父级形成环 | 400 |
| `DICT_ITEM_PARENT_IMMUTABLE` | 120xx | 字典项父级不允许修改 | 400 |
| `DICT_ITEM_IN_USE` | 120xx | 字典项仍被业务表引用,不能删除 | 409 |
| `FORBIDDEN_MANAGE_DICTIONARY` | 121xx | 无权管理字典 | 403 |

具体编号由 Step 3 实施时分配;命名 / message / httpStatus 在本文锁定。

### 2.6 权限矩阵

| 接口 | USER | ADMIN | SUPER_ADMIN |
|---|---|---|---|
| GET 类(查询)| ❌ | ✅ | ✅ |
| POST / PATCH 类(创建 / 更新 / 启停)| ❌ | ✅ | ✅ |
| DELETE(软删)| ❌ | ❌ | ✅ |
| GET /tree | ❌ | ✅ | ✅ |

USER 角色不开放任何 V2 字典管理接口;若未来需要"队员查询字典"作为前端展示,作为 V2.x 单独接口处理(USER 可读但不可写)。

---

## 3. organizations 接口契约

### 3.1 接口列表

| # | 方法 | 路径 | 简述 |
|---|---|---|---|
| 14 | GET | `/api/v2/organizations` | 列出组织节点(分页) |
| 15 | GET | `/api/v2/organizations/tree` | 组织树形 |
| 16 | POST | `/api/v2/organizations` | 创建组织节点 |
| 17 | GET | `/api/v2/organizations/:id` | 组织节点详情 |
| 18 | PATCH | `/api/v2/organizations/:id` | 更新组织节点(name / sortOrder / nodeTypeCode);**禁止**改 parentId |
| 19 | PATCH | `/api/v2/organizations/:id/status` | 启停组织节点 |
| 20 | DELETE | `/api/v2/organizations/:id` | 软删组织节点 |

#### 接口详情速览

```
GET /api/v2/organizations
  入参:PaginationQueryDto + ?parentId=<id>|null + ?nodeTypeCode=<code> + ?status=...
  出参:PageResultDto<OrganizationResponseDto>
  权限:ADMIN / SUPER_ADMIN

GET /api/v2/organizations/tree
  入参:?status=ACTIVE(默认仅返回 active)
  出参:OrganizationTreeNodeDto[](从根节点开始的嵌套树)
  权限:ADMIN / SUPER_ADMIN

POST /api/v2/organizations
  入参:CreateOrganizationDto { name, parentId?, nodeTypeCode, sortOrder? }
  出参:OrganizationResponseDto
  权限:ADMIN / SUPER_ADMIN
  状态:201 Created
  错误码:ORGANIZATION_PARENT_NOT_FOUND(parentId 不存在)/ ORGANIZATION_NODE_TYPE_INVALID(nodeTypeCode 不在节点类别字典中)/ ORGANIZATION_PARENT_CYCLE(理论上 POST 不会有环,但兜底)

GET /api/v2/organizations/:id
  入参:IdParamDto
  出参:OrganizationResponseDto
  权限:ADMIN / SUPER_ADMIN
  错误码:ORGANIZATION_NOT_FOUND

PATCH /api/v2/organizations/:id
  入参:UpdateOrganizationDto { name?, sortOrder?, nodeTypeCode? }(白名单**仅**三字段;**不**含 parentId)
  出参:OrganizationResponseDto
  权限:ADMIN / SUPER_ADMIN
  备注:**任何 parentId 修改尝试** → 400 ORGANIZATION_PARENT_CHANGE_FORBIDDEN
  错误码:ORGANIZATION_NOT_FOUND / ORGANIZATION_NODE_TYPE_INVALID / ORGANIZATION_PARENT_CHANGE_FORBIDDEN

PATCH /api/v2/organizations/:id/status
  入参:UpdateOrganizationStatusDto { status }
  出参:OrganizationResponseDto
  权限:ADMIN / SUPER_ADMIN
  错误码:ORGANIZATION_NOT_FOUND

DELETE /api/v2/organizations/:id
  入参:IdParamDto
  出参:null
  权限:SUPER_ADMIN(高危,提级)
  错误码:ORGANIZATION_NOT_FOUND / ORGANIZATION_HAS_CHILDREN(有 active 子节点)/ ORGANIZATION_HAS_MEMBERS(有 active 成员归属)
```

#### OrganizationResponseDto 字段类别

| 字段名 | 类型意图 | 说明 |
|---|---|---|
| `id` | String | cuid |
| `name` | String | 节点名 |
| `parentId` | String? | 父级自引用 |
| `nodeTypeCode` | String | 引用 dict_items.code(type='节点类别') |
| `sortOrder` | Int | 排序权重 |
| `status` | String enum | ACTIVE / INACTIVE |
| `createdAt` | String(ISO 8601 UTC)| — |
| `updatedAt` | String(ISO 8601 UTC)| — |

**不返回字段**:`deletedAt`

#### OrganizationTreeNodeDto 字段类别

同 OrganizationResponseDto + `children: OrganizationTreeNodeDto[]`(嵌套)

### 3.2 树形查询

`GET /api/v2/organizations/tree`:

- 算法:service 层拉取全量 active organizations(filter `deletedAt = null`),内存拼接树
- 排序:同级按 `sortOrder ASC, createdAt DESC`
- 性能:V2 第一阶段组织节点 ≤ 100 量级,内存拼接足够

### 3.3 新增 / 编辑 / 停用

| 操作 | 业务规则 |
|---|---|
| 新增 | `parentId` 可空(顶层根节点,V2 单根树仅 1 个);`nodeTypeCode` 必须存在于"节点类别"字典且 status=ACTIVE |
| 编辑 | 仅允许改 `name` / `sortOrder` / `nodeTypeCode`;**不允许**改 `parentId`(下文详述) |
| 启停 | `PATCH /:id/status`;INACTIVE 节点不参与新归属(member_departments 创建时校验) |
| 软删 | `DELETE`;前置:无 active 子节点 + 无 active 成员归属 |

### 3.4 禁止改父级

V2 第一阶段**严格禁止**通过 API 修改 `organizations.parentId`(对应 D7-min O-1):

- `PATCH /api/v2/organizations/:id` DTO **白名单**不含 `parentId`(`forbidNonWhitelisted: true` 自动拦截)
- 即使前端误传 `parentId`,DTO 拒绝 + 返回 400(由 v1 全局 ValidationPipe 处理)
- 若需调整组织树形,采用"软删旧 + 创建新"模式(由运营人工执行,V2 第一阶段不提供"批量重构组织树"功能)

### 3.5 主要错误码

| 错误码 | 段位 | message | httpStatus |
|---|---|---|---|
| `ORGANIZATION_NOT_FOUND` | 110xx | 组织节点不存在 | 404 |
| `ORGANIZATION_PARENT_NOT_FOUND` | 110xx | 父级组织节点不存在 | 404 |
| `ORGANIZATION_NODE_TYPE_INVALID` | 110xx | 节点类别字典 code 不存在或已停用 | 400 |
| `ORGANIZATION_PARENT_CYCLE` | 110xx | 组织节点父级形成环 | 400 |
| `ORGANIZATION_PARENT_CHANGE_FORBIDDEN` | 110xx | 不允许修改组织节点父级 | 400 |
| `ORGANIZATION_HAS_CHILDREN` | 110xx | 组织节点存在子节点,不能删除 | 409 |
| `ORGANIZATION_HAS_MEMBERS` | 110xx | 组织节点存在成员归属,不能删除 | 409 |
| `LAST_ROOT_ORGANIZATION_PROTECTED` | 111xx | 系统必须保留至少一个活跃根节点 | 409 |
| `FORBIDDEN_MANAGE_ORGANIZATION` | 111xx | 无权管理组织节点 | 403 |

具体编号由 Step 4 实施时分配。

### 3.6 权限矩阵

| 接口 | USER | ADMIN | SUPER_ADMIN |
|---|---|---|---|
| GET 类(列表 / 详情 / 树形)| ❌ | ✅ | ✅ |
| POST(创建)| ❌ | ✅ | ✅ |
| PATCH(更新 / 启停)| ❌ | ✅ | ✅ |
| DELETE(软删)| ❌ | ❌ | ✅ |

---

## 4. members 接口契约

### 4.1 接口列表

| # | 方法 | 路径 | 简述 |
|---|---|---|---|
| 21 | GET | `/api/v2/members` | 列出队员(分页;支持 `?memberNo=<exact>` 精确查询) |
| 22 | POST | `/api/v2/members` | 创建队员(`memberNo` 必填) |
| 23 | GET | `/api/v2/members/:id` | 队员详情(返回 `memberNo`) |
| 24 | PATCH | `/api/v2/members/:id` | 更新队员(displayName / gradeCode;**禁止改 memberNo**) |
| 25 | PATCH | `/api/v2/members/:id/status` | 切换队员 status(ACTIVE↔INACTIVE) |
| 26 | DELETE | `/api/v2/members/:id` | 软删队员 |

#### 接口详情速览

```
GET /api/v2/members
  入参:PaginationQueryDto + ?memberNo=<exact> + ?gradeCode=<code> + ?status=...
  出参:PageResultDto<MemberResponseDto>
  权限:ADMIN / SUPER_ADMIN
  备注:
    - memberNo 走精确查询(完整匹配),不做模糊搜索 — 业务上编号是身份,精确即可
    - **不**支持按部门查询(部门归属走 member_departments;若需要"按部门查队员"作为运营场景,作为 V2.x 单独优化或在 organization 接口加子接口)

POST /api/v2/members
  入参:CreateMemberDto { memberNo, displayName, gradeCode? }
  出参:MemberResponseDto
  权限:ADMIN / SUPER_ADMIN
  状态:201 Created
  备注:
    - memberNo **必填**;trim 后保存;长度 1-32;允许字母 / 数字 / 连字符;真实编号规则不写死,真实编号样例不进 git
    - memberNo 全局唯一(包含软删记录);撞约束抛 MEMBER_NO_ALREADY_EXISTS
    - 本接口**不**接收任何敏感字段(身份证 / 紧急联系人 / 医疗 / 出生日期 / 住址 / 性别 / 联系方式 等);DTO 白名单严格拒绝
  错误码:MEMBER_NO_ALREADY_EXISTS / MEMBER_GRADE_CODE_INVALID(若 gradeCode 提供但不存在)

GET /api/v2/members/:id
  入参:IdParamDto
  出参:MemberResponseDto(含 memberNo)
  权限:ADMIN / SUPER_ADMIN
  错误码:MEMBER_NOT_FOUND

PATCH /api/v2/members/:id
  入参:UpdateMemberDto { displayName?, gradeCode? }(白名单**仅**这两个字段)
  出参:MemberResponseDto
  权限:ADMIN / SUPER_ADMIN
  备注:
    - **禁止**改 memberNo(白名单不含;若误传 → 400 由 forbidNonWhitelisted 自动拒绝)— memberNo 是稳定身份标识,本期不开发"改编号"接口;真出现改编号场景留 V2.x
    - **禁止**通过本接口改 status(走 PATCH /:id/status);**禁止**任何敏感字段;**禁止**改 organizationId(主表无此字段)
  错误码:MEMBER_NOT_FOUND / MEMBER_GRADE_CODE_INVALID

PATCH /api/v2/members/:id/status
  入参:UpdateMemberStatusDto { status: 'ACTIVE' | 'INACTIVE' }
  出参:MemberResponseDto
  权限:ADMIN / SUPER_ADMIN
  备注:切换为 INACTIVE 不自动解除部门归属(由运营人工 DELETE /:memberId/department)
  错误码:MEMBER_NOT_FOUND

DELETE /api/v2/members/:id
  入参:IdParamDto
  出参:null
  权限:SUPER_ADMIN
  备注:对应"档案彻底无效"场景,**不**作为离队的常规操作(常规离队走 PATCH /:id/status → INACTIVE,档案完整保留)
  错误码:MEMBER_NOT_FOUND / MEMBER_HAS_ACTIVE_DEPARTMENT(有未解除的部门归属)/ MEMBER_HAS_LINKED_USER(有 v1 user 绑定)
```

#### MemberResponseDto 字段类别

| 字段名 | 类型意图 | 说明 |
|---|---|---|
| `id` | String | cuid(独立,**不**复用 users.id) |
| `memberNo` | String | 队员业务唯一编号(必返;非敏感、高价值业务标识) |
| `displayName` | String | 称呼 / 显示名 |
| `gradeCode` | String? | 等级字典 code(可空) |
| `status` | String enum | ACTIVE / INACTIVE |
| `createdAt` | String(ISO 8601 UTC)| — |
| `updatedAt` | String(ISO 8601 UTC)| — |

**不返回字段**:`deletedAt`(软删除内部状态)

### 4.2 成员创建 / 更新 / 查询

#### 创建

- 必填:`memberNo`(业务唯一编号)+ `displayName`(显示名)
- 可选:`gradeCode`(若提供,必须在"队员等级"字典中存在且 status=ACTIVE)
- 不接收:`status`(默认 ACTIVE)/ `id`(系统生成)/ 任何敏感字段

`memberNo` 校验:

- DTO 层:`@IsString()` + `@MinLength(1)` + `@MaxLength(32)` + `@Matches(/^[A-Za-z0-9-]+$/)`(允许字母 / 数字 / 连字符)
- 入库前:`trim()`(保留原大小写,**不**强制 `toLowerCase()` — 与 v1 `username` 规则不同)
- 唯一性:`findUnique` 包含软删记录预检查(防止撞软删历史 memberNo);撞约束 → `MEMBER_NO_ALREADY_EXISTS`(409)
- **真实编号规则 / 真实编号样例不进代码 / seed / 测试 fixture**(沿用 R13 红线)

#### 更新(PATCH /:id)

- 仅允许改 `displayName` / `gradeCode`
- **禁止改 memberNo**:UpdateMemberDto 白名单**不含** memberNo;若误传 → 400(`forbidNonWhitelisted: true` 全局拒绝)
- 状态切换走独立接口(`PATCH /:id/status`)
- 任何敏感字段尝试 → 400(全局 ValidationPipe `forbidNonWhitelisted` 自动拒绝)
- **本期不开发"改编号"独立接口**;真出现改编号场景作为 V2.x 单独评估

#### 查询

- 列表支持按 `memberNo`(精确匹配)/ `gradeCode` / `status` 过滤
- 详情返回 `MemberResponseDto`(必返 memberNo;无敏感字段)

### 4.3 gradeCode 字典校验

- 创建 / 更新 members 时,若 `gradeCode` 提供,**必须**通过 service 层校验:
  - 存在于 `dict_items` 表中
  - 所属 `dict_type.code = '队员等级'`(运营约定的 type code)
  - `status = ACTIVE`
- 校验失败 → 抛 `MEMBER_GRADE_CODE_INVALID`(BizCode 段位 150xx)

### 4.4 status 规则

| 状态 | 含义 | 业务效应 |
|---|---|---|
| `ACTIVE` | 在队 | 可被部门归属;计入活跃成员 |
| `INACTIVE` | 离队 / 退队 | 档案保留;不在默认列表(若需要查询离队成员通过 `?status=INACTIVE` 过滤);**不**自动解除部门归属(运营人工解除) |

**离队不等于软删**:status=INACTIVE 时档案完整保留(对应 D5 Q7 ① "完整保留档案,包括身份证 / 联系方式 / 医疗 等敏感字段")。

V2 第一阶段 members 主表**不**包含敏感字段(全部延后到 `member_profiles`);因此"完整保留"的语义在 V2 第一阶段是"保留 displayName + gradeCode + status";真实敏感字段保留语义留给 V2.x。

### 4.5 与 v1 users.memberId 的衔接

V2 members 与 v1 users 通过 `users.memberId` 可空外键关联(详见 `docs/v2-data-model.md §7`):

| 操作 | 对 v1 users 的影响 |
|---|---|
| POST `/api/v2/members`(创建队员)| **不**自动创建 v1 user;不绑定 |
| PATCH `/api/v2/members/:id`(更新队员)| 不影响 v1 user(不读不写 user 表) |
| PATCH `/api/v2/members/:id/status` 改 INACTIVE | 不自动解绑 v1 user(`users.memberId` 关联保留) |
| DELETE `/api/v2/members/:id`(软删队员)| 若有 v1 user 绑定 → **抛 MEMBER_HAS_LINKED_USER**(防止悬空外键);需先解绑 |

**v1 user 与 V2 member 的绑定 / 解绑接口**:V2 第一阶段**不在 members 模块**提供;预计作为 V2.x 独立接口(由 v1 users 模块扩展或独立"绑定管理"接口)。**当前手段**:运营通过数据库直接修改 `users.memberId` 字段(开发期),或留待 V2.x 提供 API。

### 4.6 明确不返回 / 不接收的敏感字段

V2 第一阶段 members 接口**严格禁止**接收 / 返回以下敏感字段(对应 `data-model-draft.md` v0.3 §3.3.10 M-6):

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

**实施层防御**:

1. DTO `forbidNonWhitelisted: true`(全局 ValidationPipe)— 非白名单字段直接 400
2. service 层 `userSafeSelect` 类似机制(`memberSafeSelect`)— 永不读取 / 返回敏感字段
3. baseline §8.2 屏蔽清单已预扩展(commit `3c61dfa`);若误落表自动屏蔽日志输出

### 4.7 主要错误码

| 错误码 | 段位 | message | httpStatus |
|---|---|---|---|
| `MEMBER_NOT_FOUND` | 150xx | 队员不存在 | 404 |
| `MEMBER_NO_ALREADY_EXISTS` | 150xx | 队员编号已存在 | 409 |
| `MEMBER_GRADE_CODE_INVALID` | 150xx | 队员等级字典 code 不存在或已停用 | 400 |
| `MEMBER_HAS_ACTIVE_DEPARTMENT` | 150xx | 队员仍有部门归属,不能删除 | 409 |
| `MEMBER_HAS_LINKED_USER` | 150xx | 队员已被 user 绑定,不能删除 | 409 |
| `FORBIDDEN_MANAGE_MEMBER` | 151xx | 无权管理队员 | 403 |

具体编号由 Step 5 实施时分配。

**注意**:登录账号枚举相关失败场景(输入值在 username / memberNo 两条路径下均未命中 / memberNo 命中但未绑 user / 账号禁用或软删 / 密码错)统一抛 v1 `LOGIN_FAILED = 10004`,**禁止**为 memberNo 路径自创新业务码(否则前端能据错误码差异枚举哪些 memberNo 已发放);详见 §6.6.3 失败场景表。

### 4.8 权限矩阵

| 接口 | USER | ADMIN | SUPER_ADMIN |
|---|---|---|---|
| GET 类(列表 / 详情)| ❌ | ✅ | ✅ |
| POST(创建)| ❌ | ✅ | ✅ |
| PATCH(更新 / 状态切换)| ❌ | ✅ | ✅ |
| DELETE(软删,高危)| ❌ | ❌ | ✅ |

> 备注:USER 默认不开放 V2 members 接口(沿用 §1.3);若未来需要"队员查自己档案"作为前端展示,作为 V2.x 单独接口(`GET /api/v2/members/me`)处理。

---

## 5. member_departments 接口契约

### 5.1 接口列表

| # | 方法 | 路径 | 简述 |
|---|---|---|---|
| 27 | GET | `/api/v2/members/:memberId/department` | 查队员当前部门归属 |
| 28 | PUT | `/api/v2/members/:memberId/department` | 设置 / 更换队员正式部门 |
| 29 | DELETE | `/api/v2/members/:memberId/department` | 解除当前部门归属(软删) |

**接口路径风格**:嵌套在 `members/:memberId/` 下作为子资源(语义上"队员的部门");**不**单独建 `/api/v2/member-departments/` 模块路径。

#### 接口详情速览

```
GET /api/v2/members/:memberId/department
  入参:memberId 路径参数
  出参:MemberDepartmentResponseDto | null(若该 member 无 active 归属)
  权限:ADMIN / SUPER_ADMIN
  错误码:MEMBER_NOT_FOUND

PUT /api/v2/members/:memberId/department
  入参:memberId 路径参数 + SetMemberDepartmentDto { organizationId }
  出参:MemberDepartmentResponseDto
  权限:ADMIN / SUPER_ADMIN
  状态:200(更换)或 201(新建);本契约统一返回 200 OK
  语义:**幂等设置**;若 member 已有 active 归属:
    - 若目标 organizationId 与现归属相同 → 直接返回(无副作用)
    - 若目标 organizationId 不同 → 软删旧归属 + 创建新归属(单事务)
  错误码:MEMBER_NOT_FOUND / ORGANIZATION_NOT_FOUND / MEMBER_INACTIVE / ORGANIZATION_INACTIVE / MEMBER_DEPARTMENT_ALREADY_EXISTS(理论上不应发生,因为 PUT 是幂等设置;但若并发下撞唯一约束,本错误码兜底)

DELETE /api/v2/members/:memberId/department
  入参:memberId 路径参数
  出参:null
  权限:ADMIN / SUPER_ADMIN
  语义:解除当前 active 归属(软删中间表行)
  错误码:MEMBER_NOT_FOUND / MEMBER_DEPARTMENT_NOT_FOUND(若该 member 无 active 归属)
```

#### MemberDepartmentResponseDto 字段类别

| 字段名 | 类型意图 | 说明 |
|---|---|---|
| `id` | String | cuid 代理键 |
| `memberId` | String | 队员外键 |
| `organizationId` | String | 组织节点外键 |
| `createdAt` | String(ISO 8601 UTC)| 归属生效时间 |
| `updatedAt` | String(ISO 8601 UTC)| — |

**不返回字段**:`deletedAt`

### 5.2 设置 / 更换正式部门

`PUT /api/v2/members/:memberId/department` 是**幂等设置语义**:

1. 校验 `memberId` 存在且 status=ACTIVE
2. 校验 `organizationId` 存在且 status=ACTIVE
3. 查询该 member 的 active 归属:
   - 不存在 → 创建新归属
   - 已存在且与目标 organizationId 相同 → 直接返回现归属(幂等)
   - 已存在但与目标 organizationId 不同 → **单事务**软删旧归属 + 创建新归属

**事务保证**:第 3 步的"软删旧 + 创建新"必须在同一 `prisma.$transaction` 内,避免并发下撞唯一约束(对应 baseline §10 / data-model-draft.md §6.5)。

**单归属约束实施**(对应 `data-model-draft.md §6.3` MD-4):

- 优先用 Prisma 条件性唯一索引(部分索引带 WHERE 子句),Prisma 6 支持
- 降级:全局唯一约束 + 业务规则保证(每次创建前先 service 层 check,加事务保护)

### 5.3 单归属唯一约束

V2 第一阶段**业务规则**(对应 `data-model-draft.md` v0.3 §3.5.10 / §6.5):

- 一个 `member` 在 `member_departments` 中**最多有 1 条** `deletedAt = null` 的活跃记录
- 数据库层兜底:部分唯一索引(条件性)
- 业务层防御:`PUT` 接口幂等语义;并发下兜底错误码 `MEMBER_DEPARTMENT_ALREADY_EXISTS`

### 5.4 主要错误码

| 错误码 | 段位 | message | httpStatus |
|---|---|---|---|
| `MEMBER_DEPARTMENT_NOT_FOUND` | 170xx | 队员当前无部门归属 | 404 |
| `MEMBER_DEPARTMENT_ALREADY_EXISTS` | 170xx | 队员已有活跃部门归属(并发兜底) | 409 |
| `MEMBER_INACTIVE` | 170xx | 队员状态非活跃,不能挂部门 | 409 |
| `ORGANIZATION_INACTIVE` | 170xx | 组织节点状态非活跃,不能挂队员 | 409 |
| `FORBIDDEN_MANAGE_MEMBER_DEPARTMENT` | 171xx | 无权管理队员部门归属 | 403 |
| (复用 §4.7)`MEMBER_NOT_FOUND` | 150xx | 队员不存在 | 404 |
| (复用 §3.5)`ORGANIZATION_NOT_FOUND` | 110xx | 组织节点不存在 | 404 |

具体编号由 Step 6 实施时分配。

### 5.5 权限矩阵

| 接口 | USER | ADMIN | SUPER_ADMIN |
|---|---|---|---|
| GET(查询当前归属)| ❌ | ✅ | ✅ |
| PUT(设置 / 更换)| ❌ | ✅ | ✅ |
| DELETE(解除归属)| ❌ | ✅ | ✅ |

> 备注:DELETE 不需要提级到 SUPER_ADMIN(归属解除是日常运营操作;真正高危的是软删 member 本身,那个走 §4 的 SUPER_ADMIN 权限)。

---

## 6. v1 users 接口兼容性

### 6.1 v1 14 接口不变

V2 第一阶段**不修改** v1 §6 已交付的 14 个接口的:

| 维度 | 红线 |
|---|---|
| 路径 | `/api/auth/login` / `/api/users/me` / `/api/users/:id` 等全部不变 |
| HTTP 方法 | 不变 |
| 入参 DTO 字段集 | 不变 |
| 出参 DTO 字段集 | 不变(`memberId` **不**进必返字段) |
| 错误码 | 不变 |
| 权限标注 | 不变 |
| 响应包装 | 不变 |

### 6.2 UserResponseDto 不新增必返字段

| 字段 | 状态 | 说明 |
|---|---|---|
| 现有 v1 字段(id / username / email / nickname / avatarKey / role / status / lastLoginAt / createdAt / updatedAt)| **保留不变** | v1 13 个核心字段(具体清单以 `docs/archive/legacy/architecture-v1-blueprint.md §6`,原 `ARCHITECTURE.md §6`,PR-6 已归档 为准)全部保留 |
| `memberId` | **不**进必返字段 | 默认**不**返回;若 Step 5 实施时决定可选返回(用于前端关联展示),需:1. 在本节显式声明;2. 更新 OpenAPI 契约快照;3. 标 `nullable: true` |
| `members.*` 字段 | **禁止倒灌** | 任何 V2 members 字段(displayName / gradeCode / status 等)**禁止**倒灌进 v1 UserResponseDto(沿用 `research.md §5.6`) |

**默认决策**:V2 第一阶段 v1 UserResponseDto **不新增任何字段**;`memberId` 留待 V2.x 评估是否可选返回。

### 6.3 users.memberId 写入边界

V2 第一阶段对 `users.memberId` 字段的写入:

| 写入场景 | 实施方式 |
|---|---|
| 数据库迁移 | Step 1 加可空外键字段(默认 NULL) |
| Prisma model | Step 1 在 User model 追加可空 `memberId` 字段(unique 约束 + 关系到 Member;具体 DSL 由 Step 1 任务卡确认) |
| 现有 v1 user 数据 | `memberId = NULL`(已存在的 user 不强制绑) |
| 新创建 v1 user | `users.service.ts` create 方法**不强制**传 memberId;默认 NULL |
| 更新 v1 user | v1 `PATCH /api/users/:id` 入参 DTO **不**新增 memberId 字段(白名单不含)|
| 创建 V2 member 时绑 user | **不**在 members POST 接口实现;留待 V2.x |

V2 第一阶段**没有**任何接口允许设置 / 更新 `users.memberId`。开发期 / 部署期通过数据库直改字段(运营手段),作为 V2.x 之前的过渡方案。

### 6.4 SUPER_ADMIN seed 兼容性

`prisma/seed.ts` 创建 SUPER_ADMIN 的逻辑**完全不动**(对应 `docs/v2-data-model.md §7.4`):

- `SUPER_ADMIN_USERNAME` / `SUPER_ADMIN_PASSWORD` / `SUPER_ADMIN_EMAIL` 等环境变量读取 / bcrypt 哈希 / 创建逻辑保留
- SUPER_ADMIN.memberId 默认 `null`(不绑 member)
- Step 2 seed 仅追加字典 neutral-demo;**不**修改 SUPER_ADMIN 创建逻辑

### 6.5 OpenAPI 快照兼容性

V1.3 已建立 `test/contract/openapi.contract-spec.ts` 快照机制:

| 维度 | V2 第一阶段要求 |
|---|---|
| v1 14 接口 schema | 在快照中**保持不变**;若发生变化 = §6.1 红线违反 |
| v1 `LoginDto` schema | **零漂移硬约束**(memberNo 登录回退**仅**在服务端实现,HTTP 层契约不变;详见 §6.6) |
| V2 新接口 schema | 由 Step 3-7 各自实施期更新快照(`pnpm test:contract -u`)|
| 快照 diff 审阅 | 每个 commit 中,quickly inspect snapshot diff 确认仅含**新增** V2 接口 / 不含 v1 接口变动 |
| Step 7 收口验收 | `pnpm test:contract` 通过 + v1 部分 0 漂移 |

### 6.6 v1 登录路径 memberNo 回退查找(memberNo 决议,2026-05-08)

V2 第一阶段对 v1 `POST /api/auth/login` 路径的**唯一服务端语义扩展**,严守 `docs/archive/plans/architecture-v2-first-stage-blueprint.md §12.8.2.3 / §12.8.2.4`(原 `ARCHITECTURE.md §12.8.2.3 / §12.8.2.4`,PR-6 已归档)受限放开条款。

#### 6.6.1 路径与契约不变

| 维度 | 状态 | 说明 |
|---|---|---|
| HTTP 路径 | **不变** | `POST /api/auth/login` |
| HTTP 方法 | **不变** | POST |
| 入参 schema | **不变** | `LoginDto { username, password }` 字段名 / 类型 / 校验装饰器全保留 |
| 出参 schema | **不变** | 沿用 v1 登录响应 |
| 错误码 | **不变** | `LOGIN_FAILED = 10004` |
| 响应包装 | **不变** | `{ code, message, data }` 三字段 |
| Swagger / OpenAPI 快照 | **零漂移** | v1 `LoginDto` schema 在 `test/contract/__snapshots__/` 中保持现状;Step 5 commit 后 `pnpm test:contract` 必须证明 v1 部分 0 字段差异 |
| 前端登录入口 | **单一** | 不新增 `/api/v2/auth/login`;前端无需做"用户类型判断";一律向 v1 路径提交 |

#### 6.6.2 服务端查找路径扩展

`auth.service.ts` 内部查找路径(伪逻辑,**仅描述意图**,不写实现):

```
1. 取请求体 username 字段值 → trim() + toLowerCase()(沿用 v1 现有归一化)
2. 按 v1 现有规则查 users.username → 命中:走原有 bcrypt.compare → 沿用 v1 路径
3. 未命中:按 trim 后原值在 members 表精确匹配 memberNo
   → 命中 member:通过 users.memberId 反查对应 user → 命中:走 bcrypt.compare
   → member 未命中 / member 找到但 memberId 为 null / 反查的 user 不存在或异常:
     一律视为登录失败(不区分原因)
4. 任一路径未到 bcrypt.compare 步骤:**强制**跑一次 dummy bcrypt.compare(沿用 v1 §8 timing 防御)
5. 失败统一抛 BizException(BizCode.LOGIN_FAILED) — code 10004,HTTP 401,响应体不变
```

#### 6.6.3 账号枚举防护失败场景

下表所有失败场景**必须**响应**完全一致**(响应体 / HTTP status / message / 耗时均不可区分):

| # | 场景 | 响应 | 备注 |
|---|---|---|---|
| 1 | 输入值在 username 与 memberNo 两条查找路径下均未命中 | `LOGIN_FAILED` 401 | 两条查库都跑 + dummy bcrypt;**禁止** username 路径未命中就早返回 |
| 2 | memberNo 命中 member,但 member 未绑定 user(`users.memberId` 反查为 null) | `LOGIN_FAILED` 401 | **关键防御** — 不暴露"编号存在但无账号";依然跑 dummy bcrypt |
| 3 | 命中 user 但账号已禁用(`status = DISABLED`)/ 已软删(`deletedAt != null`) | `LOGIN_FAILED` 401 | 沿用 v1 |
| 4 | 命中 user 但 `bcrypt.compare(password)` 失败 | `LOGIN_FAILED` 401 | 沿用 v1 |

**响应耗时一致性硬约束**:无论命中哪条路径,**至少跑一次 `bcrypt.compare`**(命中路径用真 hash,未命中路径用预生成的模块级 dummy hash);Timing 差异在 e2e 中应**不可统计区分**。

#### 6.6.4 实现层依赖关系铁律

- `auth.service` **必须**通过注入的 `PrismaService` 直读 `member` 表(`this.prisma.member.findUnique({ where: { memberNo: <trim 后值> } })`)
- **禁止** import `MembersModule` / `MembersService` 或任何 V2 业务层符号
- **禁止** import V2 BizCode 段位常量(`MEMBER_NO_ALREADY_EXISTS` 等)— auth.service 抛错统一用 v1 已有的 `LOGIN_FAILED` / `UNAUTHORIZED`
- `auth.module.ts` 不引入 V2 模块依赖
- 这是为避免 v1 → V2 模块循环依赖;违反此条 = `docs/archive/plans/architecture-v2-first-stage-blueprint.md §12.8.2.4`(原 `ARCHITECTURE.md §12.8.2.4`,PR-6 已归档)红线破口

#### 6.6.5 e2e 验收硬要求

Step 5 实施 `feat(auth): support memberNo login fallback` commit 时,e2e 必须覆盖:

- ✅ 现有 v1 username 登录路径**零退化**(沿用既有 137+ 用例)
- ✅ memberNo 登录成功路径(member 已绑 user + 密码正确 → 200 + JWT)
- ✅ 账号枚举相关失败场景(§6.6.3 表全部 4 行)防护(响应体 / HTTP status 完全一致)
- ✅ memberNo trim 后查找(前后空格被吃掉)
- ✅ memberNo 大小写敏感(与 username 的 `toLowerCase()` 行为不同 — 同一字符串大小写不同视为两个不同 memberNo;真实编号样例不进 e2e 测试 fixture,改用 `<placeholder-upper>` / `<placeholder-lower>` 抽象占位)
- ✅ memberNo 命中但 member 已软删 → 视作未命中,走 dummy bcrypt 路径
- ✅ memberNo 命中但 user 已禁用 / 已软删 → 沿用 v1 同样表现
- ✅ Timing 抽样:账号枚举相关失败场景响应耗时无统计显著差异(粗粒度 e2e,不要求严格 ms 级)
- ✅ OpenAPI 契约快照证明 v1 `LoginDto` schema 零漂移

---

## 7. 跨模块接口规范

### 7.1 DTO 白名单

V2 第一阶段所有入参 DTO**严格**遵守 baseline §4 + v1 §11 + V2 baseline §4:

- `forbidNonWhitelisted: true`(全局 ValidationPipe)
- DTO 字段范围**显式列出**;非白名单字段直接 400
- `UpdateXxxDto` **禁止**包含 `id` / `password` / `passwordHash` / `status` / `deletedAt` / 软删除标记 / 角色 / 系统级状态 字段
- 状态切换 / 软删 / 启停 等敏感操作**走专属接口**(沿用 baseline §4.4)

### 7.2 Swagger / OpenAPI 包装

V2 第一阶段所有接口**100% 覆盖** Swagger(对齐 baseline §3.4):

- 每个 Controller 方法必须有接口摘要(对应 baseline §3.4 ApiOperation 装饰器)
- 每个 DTO 字段必须有字段描述(对应 baseline §3.4 ApiProperty 装饰器)
- 鉴权方法必须标注 BearerAuth(对应 baseline §3.4)
- 响应类型用三装饰器(对应 baseline §3.4):
  - 单对象 → ApiWrappedOkResponse
  - 数组 → ApiWrappedArrayResponse
  - 分页 → ApiWrappedPageResponse
- **禁止**裸 ApiOkResponse(必须用三装饰器之一)

具体装饰器代码由 Step 3-6 实施时编写;本文仅按规范引用装饰器名,不写装饰器调用代码。

### 7.3 统一错误响应

V2 错误响应**严格**沿用 v1 `AllExceptionsFilter`(对齐 baseline §3.3):

- `BizException` → 读 `httpStatus`,响应 `{ code, message, data: null }` + 对应 HTTP status
- NestJS `HttpException` → 沿用其 HTTP status,`code` 用通用 BizCode
- 未知异常 → HTTP 500,`code` 用 `INTERNAL_ERROR`,生产环境不暴露 `error.message`

### 7.4 Guard 链

V2 第一阶段**不**引入第三个 Guard(对齐 baseline §9):

- 沿用 v1 `JwtAuthGuard` → `RolesGuard` 链(`APP_GUARD` 全局注册顺序固定)
- V2 接口默认要登录(未标 `@Public()`);角色控制通过 `@Roles(Role.ADMIN, Role.SUPER_ADMIN)` 等装饰器
- 部门级数据范围权限通过 Service 层 `assertCanXxx` 显式判断,**不**通过 Guard 层(沿用 `data-model-draft.md §3.11` 红线)

### 7.5 软删除查询规则

V2 第一阶段所有列表 / 详情查询**默认**过滤软删记录(对齐 baseline §10):

- service 层用 `notDeletedWhere` helper(commit `d8fd444` 已就位)
- 唯一性预检查用 `findUnique`(包含软删)— 防止 code 被复用导致约束冲突
- "管理员看回收站"功能 V2 第一阶段**不**提供;若需要,作为 V2.x 单独接口

### 7.6 requestId / logger 规则

V2 第一阶段沿用 V1.1 已建立的 `nestjs-pino` + `requestId` 机制:

- 每请求自动 `x-request-id` 头 + 日志条目 `reqId` 字段
- 日志屏蔽清单已预扩展(commit `3c61dfa`),敏感字段命中自动 `[REDACTED]`
- V2 接口**禁止** `console.log`(沿用 V1.1 §11.2);用 `Logger` 注入

---

## 8. OpenAPI 契约快照协议

### 8.1 V2 接口加入快照的时机

| Step | 加入快照的内容 |
|---|---|
| Step 3 dictionaries | 13 个接口的 schema |
| Step 4 organizations | 7 个接口的 schema |
| Step 5 members | 6 个接口的 schema |
| Step 6 member_departments | 3 个接口的 schema |
| Step 7 收口 | 全量回归 + 锁定快照 |

每个 Step 实施期通过 `pnpm test:contract -u` 更新快照;commit 时**显式**审阅 snapshot diff。

### 8.2 v1 接口快照不得漂移

v1 14 接口 schema 在快照中**保持不变**:

- v1 路径 / HTTP 方法 / 入参 / 出参 / 错误码 schema 不能因 V2 改动而漂移
- 每个 V2 commit 的 snapshot diff 必须仅含**新增** V2 接口 / 不含 v1 接口字段变化
- 若发现 v1 schema 漂移 = §6.1 红线违反;commit 撤回 + 修正

### 8.3 快照更新流程

```
Step 3-7 实施期每次接口改动后:
  1. pnpm test:contract       # 检查当前快照状态
  2. (若有 V2 新接口) pnpm test:contract -u   # 更新快照
  3. git diff test/contract/__snapshots__/    # 审阅 diff
  4. 确认 diff 仅含新增 V2 / 不含 v1 漂移
  5. git add + commit(snapshot 与代码同 commit)
```

### 8.4 contract test 验收要求

每个 Step 完成前**必须**:

- `pnpm test:contract` 通过(快照已更新 / v1 不漂移)
- snapshot 文件已 commit(避免遗忘)
- Step 7 收口时,完整 14 (v1) + 29 (V2) = 43 个接口的 schema 全部锁定

---

## 9. 不在本契约范围

### 9.1 不开发的接口

以下接口**完全不在**本文范围(对应 D7-min 决议延后到 V2.x):

- `member_profiles` 任何接口(敏感字段管理,合规未补)
- `attachments` 任何接口(附件元数据 / 上传 Provider)
- `audit_logs` 任何接口(审计基础设施)
- `events` 任何接口(活动事件)
- `event_participants` 任何接口(参与状态)

### 9.2 不实施的能力

- ❌ 部门级数据范围权限(沿用 `research.md §3.11`)
- ❌ "本人改自己 member 资料"接口
- ❌ 文件上传 / 下载接口
- ❌ 字典 / 组织树拖拽调整接口
- ❌ 批量导入 / 导出接口
- ❌ "队员关联 user" / "user 解绑 member" 接口(V2.x 评估)
- ❌ 完整状态机 / 流程引擎(请假 / 报名 / 审批 等)
- ❌ 通知 / 消息推送接口
- ❌ 导出 Excel / PDF 接口

### 9.3 不允许的破口

- ❌ 在 V2 接口中接收 / 返回任何敏感字段(身份证 / 紧急联系人 / 医疗 / 出生日期 / 住址 等)
- ❌ 修改 v1 14 接口的契约(任何路径 / DTO / 错误码变化均视作破口)
- ❌ 在 v1 `UserResponseDto` 出参中**新增必返**字段
- ❌ 把 `members.*` 字段倒灌进 v1 DTO
- ❌ 引入 RBAC / permission 表 / casl 权限框架
- ❌ 字典 / 组织树缓存(沿用 v1 §1 不主动加缓存)
- ❌ 真实部门名 / 等级名 / 字典 items 取值进 git history(R13)
- ❌ 跳过 OpenAPI 契约快照验证

---

## 附录 A:接口清单总表

| # | 方法 | 路径 | 模块 | 权限 | 主要错误码 |
|---|---|---|---|---|---|
| 1 | GET | `/api/v2/dict-types` | dictionaries | ADMIN+ | — |
| 2 | POST | `/api/v2/dict-types` | dictionaries | ADMIN+ | DICT_TYPE_CODE_ALREADY_EXISTS |
| 3 | GET | `/api/v2/dict-types/:id` | dictionaries | ADMIN+ | DICT_TYPE_NOT_FOUND |
| 4 | PATCH | `/api/v2/dict-types/:id` | dictionaries | ADMIN+ | DICT_TYPE_NOT_FOUND |
| 5 | PATCH | `/api/v2/dict-types/:id/status` | dictionaries | ADMIN+ | DICT_TYPE_NOT_FOUND |
| 6 | DELETE | `/api/v2/dict-types/:id` | dictionaries | SUPER_ADMIN | DICT_TYPE_IN_USE |
| 7 | GET | `/api/v2/dict-items` | dictionaries | ADMIN+ | — |
| 8 | POST | `/api/v2/dict-items` | dictionaries | ADMIN+ | DICT_ITEM_CODE_ALREADY_EXISTS / DICT_ITEM_PARENT_TYPE_MISMATCH |
| 9 | GET | `/api/v2/dict-items/:id` | dictionaries | ADMIN+ | DICT_ITEM_NOT_FOUND |
| 10 | PATCH | `/api/v2/dict-items/:id` | dictionaries | ADMIN+ | DICT_ITEM_NOT_FOUND |
| 11 | PATCH | `/api/v2/dict-items/:id/status` | dictionaries | ADMIN+ | DICT_ITEM_NOT_FOUND |
| 12 | DELETE | `/api/v2/dict-items/:id` | dictionaries | SUPER_ADMIN | DICT_ITEM_IN_USE |
| 13 | GET | `/api/v2/dict-items/tree` | dictionaries | ADMIN+ | DICT_TYPE_NOT_FOUND |
| 14 | GET | `/api/v2/organizations` | organizations | ADMIN+ | — |
| 15 | GET | `/api/v2/organizations/tree` | organizations | ADMIN+ | — |
| 16 | POST | `/api/v2/organizations` | organizations | ADMIN+ | ORGANIZATION_NODE_TYPE_INVALID |
| 17 | GET | `/api/v2/organizations/:id` | organizations | ADMIN+ | ORGANIZATION_NOT_FOUND |
| 18 | PATCH | `/api/v2/organizations/:id` | organizations | ADMIN+ | ORGANIZATION_PARENT_CHANGE_FORBIDDEN |
| 19 | PATCH | `/api/v2/organizations/:id/status` | organizations | ADMIN+ | ORGANIZATION_NOT_FOUND |
| 20 | DELETE | `/api/v2/organizations/:id` | organizations | SUPER_ADMIN | ORGANIZATION_HAS_CHILDREN / ORGANIZATION_HAS_MEMBERS |
| 21 | GET | `/api/v2/members` | members | ADMIN+ | — |
| 22 | POST | `/api/v2/members` | members | ADMIN+ | MEMBER_NO_ALREADY_EXISTS / MEMBER_GRADE_CODE_INVALID |
| 23 | GET | `/api/v2/members/:id` | members | ADMIN+ | MEMBER_NOT_FOUND |
| 24 | PATCH | `/api/v2/members/:id` | members | ADMIN+ | MEMBER_NOT_FOUND |
| 25 | PATCH | `/api/v2/members/:id/status` | members | ADMIN+ | MEMBER_NOT_FOUND |
| 26 | DELETE | `/api/v2/members/:id` | members | SUPER_ADMIN | MEMBER_HAS_ACTIVE_DEPARTMENT / MEMBER_HAS_LINKED_USER |
| 27 | GET | `/api/v2/members/:memberId/department` | member_departments | ADMIN+ | MEMBER_NOT_FOUND / MEMBER_DEPARTMENT_NOT_FOUND |
| 28 | PUT | `/api/v2/members/:memberId/department` | member_departments | ADMIN+ | MEMBER_INACTIVE / ORGANIZATION_INACTIVE |
| 29 | DELETE | `/api/v2/members/:memberId/department` | member_departments | ADMIN+ | MEMBER_DEPARTMENT_NOT_FOUND |

**总计**:**29 个 V2 新接口**(权限 "ADMIN+" 表示 ADMIN / SUPER_ADMIN 均可)。

---

## 附录 B:错误码段位速查

按 baseline §1.1:

| 段位 | 模块 | 容量 | V2 第一阶段使用 |
|---|---|---|---|
| `100xx` + `101xx` | `auth` + `users`(v1)| 200 | 沿用 v1,无新增 |
| `110xx` + `111xx` | `organizations` | 200 | ✅ V2 第一阶段使用 |
| `120xx` + `121xx` | `dictionaries`(`dict_types` + `dict_items` 共享)| 200 | ✅ V2 第一阶段使用 |
| `130xx` + `131xx` | `attachments` | 200 | ⏸️ V2.x 复活时使用 |
| `140xx` + `141xx` | `audit_logs` | 200 | ⏸️ V2.x 复活时使用 |
| `150xx` + `151xx` | `members` | 200 | ✅ V2 第一阶段使用 |
| `160xx` + `161xx` | `member_profiles` | 200 | ⏸️ V2.x 复活时使用 |
| `170xx` + `171xx` | `member_departments` | 200 | ✅ V2 第一阶段使用 |
| `180xx` + `181xx` | `events` | 200 | ⏸️ V2.x 复活时使用 |
| `190xx` + `191xx` | `event_participants` | 200 | ⏸️ V2.x 复活时使用 |

每模块 200 号段内细分(对齐 baseline §1.3):

- `XX0xx` — 实体级(NOT_FOUND / ALREADY_EXISTS / VALIDATION / 状态非法 / 引用约束)
- `XX1xx` — 权限 / 操作 / 完整性

通用 HTTP 级错误码沿用 v1(`UNAUTHORIZED = 40100` / `FORBIDDEN = 40300` / `NOT_FOUND = 40400` / `BAD_REQUEST = 40000` / `INTERNAL_ERROR = 50000` / `TOO_MANY_REQUESTS = 42900`)。

---

## 附录 C:版本表

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-05-07 | 初版,V2-D8 立项 D8-4 产出物;29 个 V2 第一阶段接口契约草案 + v1 兼容性 + 跨模块规范 + OpenAPI 快照协议 + 错误码段位速查 |
| v0.2 | 2026-05-08 | memberNo 决议(Q1=A / Q2=B-1 / Q3-Q9):§1.2 / §4.1 接口总览补 memberNo 提示 / §4.1 详情速览加 memberNo 入参 / §4.2 创建/更新/查询小节加 memberNo 校验 / §4.6 字段表加 memberNo / §4.7 加 MEMBER_NO_ALREADY_EXISTS + 登录账号枚举相关失败场景统一 LOGIN_FAILED 注解 / §6.5 加 v1 LoginDto 零漂移硬约束 / **新增 §6.6 v1 登录路径 memberNo 回退查找**(§6.6.3 失败场景表 4 行)/ 附录 A 总表错误码追加 |

---

> **本文是 D8-4 立项产出物**;V2-D8 标记完成需 5 份立项产出物全部就位(对应 `docs/archive/plans/architecture-v2-first-stage-blueprint.md §12.11.1`,原 `ARCHITECTURE.md §12.11.1`,PR-6 已归档)。
> Step 1 启动需 V2-D8 ✅ + 用户单独拍板;**禁止**绕过 D8 直接进入开发。
> 路径前缀 `/api/v2/` 为契约草案占位;最终路径前缀(是否真带 `/v2/`)在 Step 3 启动前由用户单独拍板,届时全文统一替换(纯文档修订)。
