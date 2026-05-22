# SRVF 基础数据底座 — V2 基线规范

> 派生项目:**srvf-nest-api**
> 文档定位:V2 派生项目的"**基线规范**" — 锁定**不依赖业务调研**的通用约定,作为后续所有 V2 草案 / 开发的**隐含约束**。
> 阶段:**V2 设计阶段**(`docs/archive/plans/architecture-v2-first-stage-blueprint.md §12`,原 `ARCHITECTURE.md §12`,PR-6 已归档 / `CLAUDE.md §18` / `AGENTS.md §18`)。
> **不引入** schema / migration / 模块代码 / 新依赖 — 因此**不需要** D6/D7 gates。
> **解除条件**:任何修订需用户拍板,commit message 前缀 `v2-design:`。

---

## 0. 文档定位

### 0.1 这份文件是什么

- V2 派生项目通用约定的"**单一来源 (single source of truth)**":命名、错误码、响应格式、模块结构、配置归属、日志屏蔽、Guard、软删除、兼容性、时区、验收门槛
- 一旦冻结,V2 所有草案文档 / 开发任务卡 / 模块代码**默认遵守**本规范,**无需逐项重述**
- 与 v1 / V1.1 的关系:**增量而非替代**。v1 已锁的项不重抄,只标"沿用";V2 新增的项显式列出

### 0.2 这份文件不是什么

- **不是** schema 设计 — schema 当前以 `prisma/schema.prisma` + `docs/v2-data-model.md` 为权威源(历史草案 `srvf-foundation-data-model-draft.md` 已归档于 `docs/archive/plans/v2-design-phase/`)
- **不是** API 契约 — API 路径 / 入参出参由具体模块开发阶段交付
- **不是**实施计划 — 实施顺序由 `TASKS.md` 承载

### 0.3 与 V2 三档分类的关系

`docs/archive/plans/v2-design-phase/srvf-foundation-research.md §5`(原 `docs/srvf-foundation-research.md`,PR-4 已归档)把 V2 基建分三档:

- **A 档**(完全不依赖调研)→ **本文件**承载
- **B 档**(形态稳但字段待定)→ 后续草案承载,但其**通用基建**(时间字段、软删、命名)沿用本文件
- **C 档**(形态本身待研究)→ 走完整 D5 → D6 → D7 流程

### 0.4 修订纪律

- 修订需用户拍板,**禁止** AI 自行扩张
- 修订 commit message 前缀:`v2-design: baseline <章节> <简述>`
- 修订需在附录 A 版本表显式记录

---

## 1. V2 模块 BizCode 段位分配

### 1.1 总段位映射

| 段位 | 模块 | 容量 | 状态 |
|---|---|---|---|
| `100xx` + `101xx` | `auth` + `users` | 200 | v1 已锁,不动 |
| `110xx` + `111xx` | `organizations` | 200 | **V2 基线预留** |
| `120xx` + `121xx` | `dictionaries` | 200 | **V2 基线预留** |
| `130xx` + `131xx` | `attachments` | 200 | **V2 基线预留** |
| `140xx` + `141xx` | `audit_logs` | 200 | **批次 6 已实装**(v0.6.x post-release,2026-05-12;`140xx` 段 1 BizCode + `141xx` 段 1 BizCode,**不开** `14002+` / `14010+` / `14102+`)|
| `150xx` + `151xx` | `members` | 200 | **V2 基线预留** |
| `160xx` + `161xx` | `member_profiles` | 200 | **V2 基线预留** |
| `170xx` + `171xx` | `member_departments` | 200 | **V2 基线预留** |
| `180xx` + `181xx` | `certificates` | 200 | **批次 2 已实装**(v0.3.0,2026-05-10)|
| `190xx` + `191xx` | `emergency_contacts` | 200 | **批次 1 已使用**(原预留 `event_participants`,batch 1 启动时让出) |
| `200xx` + `201xx` | `activities` | 200 | **批次 3 已实装**(v0.4.0,2026-05-11)|
| `210xx` + `211xx` | `activity_registrations` | 200 | **批次 3 已实装**(v0.4.0,2026-05-11)|
| `220xx` + `221xx` | `attendances` | 200 | **批次 3 + 批次 4-A 已实装**(v0.4.0 14 BizCode + v0.4.0 post-release 批次 4-A 追加 3 BizCode = 17;沿批次 3B 段位补,**不新开模块码**)|
| `230xx` + `231xx` | `contribution_rules` | 200 | **批次 5-A 已实装**(v0.5.0 post-release,2026-05-12;`230xx` 段 5 BizCode,**不开** `23030` / `231xx`)|
| `240xx`-`290xx` | 未规划模块预留 | — | 训练 / 装备 / 财务 / 通知等真到时候分配(中间留缓冲) |
| `300xx` + `301xx` | `permissions`(C-6 RBAC) | 200 | **C-6 D7 v0.2 局部收口段位预留**(2026-05-14 用户拍板;详见 [docs/批次8_RBAC_API前评审.md §12](批次8_RBAC_API前评审.md);**段位预留 ≠ 段位实装**,实装由 C-6 RBAC V2.x 立项后实施 PR 完成)|
| `310xx` 起 | 未规划模块预留 | — | RBAC 之后未规划模块 |

**状态说明**:

- **V2 基线预留**:形态级几乎确定会进入 V2(参见 `research.md §2`),段位预留不会浪费;具体字段集仍待 D6/D7
- **批次 2 已实装**(v0.3.0,2026-05-10):批次 2 schema + API 前评审锁定 `certificates` 占用 `180xx + 181xx` 段位,v0.3.0 release 时 5 个 BizCode 实装落地(`18001` / `18010` / `18011` / `18030` / `18101`;详见 `CHANGELOG.md` v0.3.0 段)
- **批次 3 已实装**(v0.4.0,2026-05-11):批次 3 schema 前评审收口时锁定 `activities` / `activity_registrations` / `attendances` 三段(评审稿 §7.2),v0.4.0 release 时全部 27 个 BizCode 实装落地(`200xx` 9 / `210xx` 4 / `220xx` 14;详见 `CHANGELOG.md` v0.4.0 段)
- **批次 4-A 已实装**(v0.4.0 post-release,2026-05-11):批次 4-A schema PR(`2190803` PR #18)在 `220xx` attendances 段**补充** 3 个 BizCode(`22043` `ATTENDANCE_SHEET_FINAL_REJECTED_NOT_EDITABLE` / `22045` `ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID` / `22046` `ATTENDANCE_SHEET_FINAL_REVIEW_NOTE_REQUIRED`),配合 `AttendanceSheet` 5 态状态机扩展;**沿 batch 3B 段位**(`220xx`),**不新开模块码**;APD 部门部长 / 副部长专属权限沿 D-S2 **不开** `22044` `FORBIDDEN_*`,权限不足走通用 `40300`
- **批次 5-A 已实装**(v0.5.0 post-release,2026-05-12):批次 5-A 实施 PR(`cfa396d` PR #24)新开 `230xx` `contribution_rules` 模块段位,5 个 BizCode 实装落地(`23001` `CONTRIBUTION_RULE_NOT_FOUND` / `23002` `CONTRIBUTION_RULE_ACTIVE_DUPLICATE` / `23010` `CONTRIBUTION_RULE_POINTS_INVALID` / `23011` `CONTRIBUTION_RULE_ACTIVITY_TYPE_INVALID` / `23012` `CONTRIBUTION_RULE_ROLE_CODE_INVALID`);**不开** `23030` `CONTRIBUTION_RULE_KEY_FIELDS_NOT_EDITABLE`(沿 D6 v1.1 E8,PATCH 维度禁改交给 `UpdateContributionRuleDto` 白名单 + ValidationPipe `forbidNonWhitelisted` 拦截 → 通用 `BAD_REQUEST` / 40000);**不开** `23101~23104` `FORBIDDEN_*`(沿 baseline,权限不足走通用 `FORBIDDEN` / 40300;APD 部门部长 / 副部长细分权限留 5-B);未规划模块从 `240xx` 起
- **批次 6 已实装**(v0.6.x post-release,2026-05-12):批次 6 实施 PR #1(`9aac9d0` PR #29)+ PR #2(`aeb2ea8` PR #30)新开 `140xx + 141xx` `audit_logs` 模块段位,2 个 BizCode 实装落地(`14001` `AUDIT_LOG_NOT_FOUND` / `14101` `FORBIDDEN_AUDIT_LOG_READ`);**不开** `14002+`(`audit_logs` 写入后不可改不可删 / 无唯一约束 / 无 P2002 场景)/ `14010+`(`AuditLogQueryDto` 由 ValidationPipe 兜底走 `BAD_REQUEST` / 40000)/ `14102+`(沿 baseline,USER 越权由 Guard 拒绝走通用 `FORBIDDEN` / 40300;`14101` 仅用于 service 层"已通过 Guard、但 detail 越级"场景,详见 D6 v1.1 §6.4 / D-D 决议);**审计行为约束**(沿 D6 v1.1 §3 / 业务确认稿 Q1-Q5):不记查看行为 / 不做失败操作审计 / 不审计 `audit_logs` 自身 / `auditPlaceholder` 28 项 union 与 `AuditLogEvent` 6 项 union 物理隔离(D2),后续批次按需迁出
- **C-6 D7 v0.2 局部收口段位预留**(2026-05-14):D7-RBAC 评审稿 v0.2 局部收口锁定 `300xx + 301xx` 为 `permissions`(RBAC)模块预留段位;**避开 `140xx + 141xx`**(已被 audit_logs 占用,不可与 RBAC 共用);**中间留 `240xx-290xx`** 给未来未规划业务模块(训练 / 装备 / 财务 / 通知等);RBAC 是项目骨架级模块,值得占独立段位空间;**段位预留 ≠ 段位实装**,本次仅 baseline 段位锁定,RBAC 4 model + ~14 个 BizCode 实装由 C-6 RBAC V2.x 立项后实施 PR 完成(预估 9 个 PR);详见 [docs/批次8_RBAC_API前评审.md §12](批次8_RBAC_API前评审.md)
- **V2 候选预留**:研究文档 §2.6 / §4.6 显式给出"通用化失败回退三档"(最小骨架 / 延后参与表 / 整体砍掉),启用与否由 D5/D6 决议;若决议为"砍掉",对应段位释放给后续未规划模块
- **历史命名废弃**:`events` / `event_participants` 不会以原模块名复活(批次 2 / 批次 3 已按业务语义拆分落地为 `certificates` / `activities` / `activity_registrations` / `attendances`);但 BizCode 段位维度**不存在废弃保留**——所有段位要么已实装,要么基线预留,要么 V2 候选预留,要么未规划预留

**段位预留 ≠ 必须独立 NestJS module**:本节只锁错误码段位;具体 module 边界(例如 `member_profiles` / `member_departments` 是独立 module 还是 `members` 的子目录)由 D6 草案 / D7 评审决议。段位预留是"如果该业务确实独立成模块时,错误码占哪一段",不是"必须独立成模块"。

### 1.2 通用 HTTP 级错误段位(沿用 v1 §5)

`4xxxx` / `5xxxx` 段不为 V2 模块新设;以下错误码继续复用 v1 已定义的:

- `UNAUTHORIZED = 40100`(token 无效 / 过期 / 用户被禁 / 用户被软删)
- `FORBIDDEN = 40300`(通用无权)
- `NOT_FOUND = 40400`(资源类不存在,业务级用模块自有的 `XX001`)
- `BAD_REQUEST = 40000`(ValidationPipe 默认输出)
- `INTERNAL_ERROR = 50000`
- `TOO_MANY_REQUESTS = 42900`(V1.1 已加,沿用)

V2 模块**不得**为"token / 鉴权失败"自创业务码(沿用 v1 §5 纪律)。

### 1.3 每模块 200 段位的内部细分约定

每模块的 `XX0xx`(100 个号)+ `XX1xx`(100 个号)按如下子段使用:

#### `XX0xx` 段 — 实体级错误

| 子段 | 用途 | 示例 |
|---|---|---|
| `XX001` | 资源不存在 | `ORGANIZATION_NOT_FOUND = 11001` |
| `XX002 ~ XX009` | 唯一约束冲突(逐个字段一码) | `ORGANIZATION_NAME_ALREADY_EXISTS = 11002` |
| `XX010 ~ XX029` | 业务级输入校验(超出 ValidationPipe 默认) | `ORGANIZATION_PARENT_CYCLE = 11010` |
| `XX030 ~ XX099` | 资源状态非法 / 引用约束 / 其他实体级 | `ORGANIZATION_HAS_CHILDREN = 11030` |

#### `XX1xx` 段 — 权限 / 操作 / 完整性

| 子段 | 用途 | 示例 |
|---|---|---|
| `XX101` | 通用权限拒绝 | `FORBIDDEN_ORGANIZATION_OPERATION = 11101` |
| `XX102` | 自我保护(操作目标 = 当前用户 / 当前实体) | `CANNOT_OPERATE_SELF` 类 |
| `XX103 ~ XX119` | 系统约束保护 | `LAST_ROOT_ORGANIZATION_PROTECTED = 11103` |
| `XX120 ~ XX199` | 操作冲突 / 跨实体完整性 | `ORGANIZATION_IN_USE_BY_MEMBERS = 11120` |

### 1.4 新增 BizCode 必走流程

继承 v1 §5 / `CLAUDE.md §5`:

1. 先说明使用场景与前端提示价值
2. 用户确认后加入对应模块 `XX0xx` / `XX1xx` 段
3. 显式声明 `httpStatus`(三字段对象 `{ code, message, httpStatus }`)
4. 对应模块的 `BizCode` 常量按数值排序

**禁止** AI 自行新增 BizCode。

---

## 2. V2 通用命名约定

### 2.1 完全继承 v1(不重述,只标沿用)

以下沿用 `CLAUDE.md §3`,V2 模块**禁止**变更:

- 时间字段:`createdAt` / `updatedAt` / `deletedAt`(类型 `Date | null`)
- 主键:`cuid()` 字符串,字段名 `id`
- 文件标识:`key`(**不**用 `path` / `filename` / `url`)
- 软删除标记:`deletedAt: Date | null`(**不**引入 `isDeleted` 布尔)
- 密码字段:Prisma model 与 service 内部用 `passwordHash`,DTO 用 `password` / `newPassword`
- 角色 / 状态:从 `@prisma/client` 导入,**禁止**手写
- 错误抛出:`throw new BizException(BizCode.XXX)`,**禁止**裸 `new Error(...)`

### 2.2 V2 新增命名约定

以下是 V2 在 v1 之上**新增**的约定:

#### 2.2.1 外键字段名

- 单关联外键:`<relation>Id`(例:`organizationId` / `parentId` / `uploaderUserId` / `targetMemberId`)
- 多态外键(若 §4.9 选定):`<relation>Type` + `<relation>Id`(例:`ownerType` + `ownerId`)
- **禁止**:`org_id` 蛇形命名;`organization` 不带 Id 后缀

#### 2.2.2 多对多中间表表名

- 格式:`<a>_<b>s`,**优先按业务语义命名**(读得懂"这张表表达什么关系");命名一旦在草案确认,**后续同类关系必须保持一致**,**禁止**同一项目里多种命名风格混用
- 示例:`member_departments` 表达"队员的部门归属"(语义在前);若按字母序应是 `department_members`,但业务语义不通顺,故**业务序优先**
- **禁止**:CamelCase 表名;复数化不一致(`MemberDepartment` / `member_department`)
- **禁止**:中间表命名风格在同一项目内不一致(例如同时存在业务序 `member_departments` 与字母序 `attachment_members`)— 草案首次确认后即冻结风格

#### 2.2.2.1 organizations vs department 命名澄清

- **`organizations`** 是**技术模型名**(主表 / Prisma model / src/modules/ 目录名),覆盖**所有**组织树节点(包括但不限于"部门",也包括小组、横向编组、临时编组等)
- **`department`** 是**业务语义别名**,**仅**在已确认的业务命名上下文中使用,例如:
  - 中间表 `member_departments`(队员的部门归属)
  - 业务字段 `primaryDepartmentId`(主部门外键,若 §4.5 决策需要)
  - 业务接口 / 文案中的"部门"表达
- **禁止**:在同一模型中混用 `organizations` / `departments` 两套主表名(例如新建 `departments` 表与 `organizations` 表并存)
- **禁止**:把 `department` 当作 Prisma model 名;如真有"部门类型节点"需要区分,通过 `organizations` 表加 `nodeType` 字段(走字典)区分,**不**拆表

#### 2.2.3 启停标记字段名

字典 items / 组织节点等支持"启停"的实体,启停字段统一命名:

- 字段名:`status`(`enum` 类型),取值由对应模块定义(草案阶段决策)
- **禁止**:`isActive` / `isEnabled` / `enabled` 多个字段名混用 — 每个表只用 `status` 一个字段表达启停语义
- 例外:已有 v1 `users.status` 沿用,V2 新模块对齐

#### 2.2.4 布尔字段命名

- 前缀 `is` 或 `has`(例:`isPrimary` / `hasAttachments`)
- **禁止**:无前缀布尔(`primary: bool`);双重否定(`notDeleted: bool`)

#### 2.2.5 字段名与字典关联

字段引用字典 item 时,字段名格式:

- `<concept>Code`(若引用 `dict_items.code`,字符串)
- 或 `<concept>ItemId`(若引用 `dict_items.id`)
- 草案阶段决策具体引用方式;一旦决策,V2 全模块统一

### 2.3 输入归一化纪律(继承 v1 §3)

- `username` / `email` 类**唯一约束字段**:**入库前**和**所有查询前**必须 `trim()` + `toLowerCase()`
- V2 新增类似字段(若有,如 `idCard` / `phoneNumber`)是否归一化由对应模块草案决策,但**必须**在草案中显式回答

---

## 3. V2 响应包装 / 异常 / Swagger(完全继承 v1)

V2 模块**完全继承**以下 v1 / V1.1 约定,本节仅做要点提示,不重抄完整规范。

### 3.1 ResponseInterceptor(沿用 v1 §4)

- 所有接口经全局 `ResponseInterceptor` 包装为 `{ code: 0, message: 'ok', data }`
- 业务代码**只 `return data`**,**禁止**手动包外层结构
- 跳过路径列表(`/api/docs` 前缀 / `/favicon.ico` / `/metrics` / 文件下载流):**V2 不扩展**;若 V2 引入新流式响应接口,加入跳过路径需在草案中显式说明

### 3.2 分页(沿用 v1 §4)

- 入参 `PaginationQueryDto`(`page` / `pageSize`,默认 `page=1` / `pageSize=20`,`pageSize` 最大 100)
- 出参 `PageResultDto<T>`(`items` / `total` / `page` / `pageSize`)
- **禁止** `limit/offset` / `skip/take` / `cursor` / `{ list, count }` / `{ rows, total }` 等变体
- 默认排序 `orderBy: { createdAt: 'desc' }`(各模块如有更合适的默认序,在草案中显式声明)

### 3.3 AllExceptionsFilter(沿用 v1 §5)

- `BizException` → 读 `httpStatus`,响应 `{ code, message, data: null }`
- NestJS `HttpException` → HTTP status 沿用,`code` 用通用 BizCode
- 未知异常 → HTTP 500 / `INTERNAL_ERROR`,生产环境不暴露 `error.message`
- HTTP status 始终保持语义,**禁止**为"统一"返回 200

### 3.4 Swagger 100% 覆盖(沿用 v1 §6)

- 每个 Controller 方法必须 `@ApiOperation({ summary })`
- 每个 DTO 字段必须 `@ApiProperty({ description })`
- 鉴权方法必须 `@ApiBearerAuth()`
- 响应类型必须用三装饰器之一:`@ApiWrappedOkResponse` / `@ApiWrappedArrayResponse` / `@ApiWrappedPageResponse`,**禁止**裸 `@ApiOkResponse({ type: Dto })`
- 三装饰器集中在 `common/decorators/api-response.decorator.ts`,V2 不另起

---

## 4. V2 入参 DTO 字段白名单纪律

### 4.1 全局 ValidationPipe(沿用 v1 §7)

`main.ts` 已注册:

```typescript
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
}));
```

V2 模块**禁止**重复注册局部 `ValidationPipe`,**禁止**关闭以上任一选项。

### 4.2 DTO 自身白名单是第一道防线(继承 v1 §11)

`forbidNonWhitelisted` 是兜底,DTO 字段范围是第一道防线。V2 模块所有入参 DTO 必须遵守:

- **`UpdateXxxProfileDto`**:仅允许业务方明确"本人可改"的字段
- **`UpdateXxxDto`**:**禁止**包含 `id` / `password` / `passwordHash` / `status` / `deletedAt` / 软删除标记 / 角色 / 系统级状态 等敏感字段;这些字段必须走专属接口
- **`CreateXxxDto`**:外部可传字段必须经业务层校验(如 v1 `CreateUserDto.role` 不直接透传 Prisma)
- **`<Domain>QueryDto`**:列表查询参数,排序字段 / 过滤字段必须 ≤ 草案显式枚举,**禁止**接受任意字符串作为 `orderBy`

### 4.3 路径参数校验(沿用 v1 §11)

所有 `:id` 路径参数通过 `IdParamDto` 校验:

- `@IsString()` + `@Length(8, 64)`
- **禁止** `@Param('id', ParseIntPipe)` / `@IsInt()`
- **禁止**写死 cuid 正则(优先长度校验)

### 4.4 V2 新增类:**敏感操作必须独立接口**

继承 v1 §13 模式,V2 模块对实体的"敏感操作"必须**专属接口**,**禁止**夹带在通用 `PATCH /:id` 中:

| 敏感操作 | 必须独立接口示例 |
|---|---|
| 改角色 / 改权限 | `PATCH /api/<resource>/:id/role` |
| 改状态 / 启停 | `PATCH /api/<resource>/:id/status` |
| 重置密码 / 改密码 | `PUT /api/<resource>/:id/password`(若该资源有密码) |
| 软删除 / 撤销 | `DELETE /api/<resource>/:id` |
| 移动父级(若支持) | `PATCH /api/<resource>/:id/parent` |

V2 草案设计 controller 时,凡是符合"敏感操作"语义的,必须按本节模式独立接口。

---

## 5. V2 模块结构

### 5.1 4 文件铁律(沿用 v1 §2)

业务模块固定 4 文件:

```
src/modules/<name>/
├── <name>.module.ts
├── <name>.controller.ts
├── <name>.service.ts
└── <name>.dto.ts
```

例外:

- `health/`(已存在):`health.module.ts` + `health.controller.ts`
- 单个 dto 文件超 300 行:允许拆**模块内** `dto/` 目录,**禁止**跨模块公共 `dto/`

V2 新模块:平铺加在 `src/modules/` 下,**禁止**嵌套 `system/` / `business/` / `core/` 等子目录。

### 5.2 禁止的事

- **禁止** `*.entity.ts` — 本项目不是 TypeORM 项目,Prisma 类型由 `@prisma/client` 提供
- **禁止**跨模块共享 helper(每个模块自包含;真有跨模块需求走 `src/common/`)
- **禁止**在模块文件之外直接 import Prisma model 类型(只能 import 业务 DTO);Service 内部 import Prisma 类型仅供内部使用

### 5.3 命名规范

- 模块目录 / 文件:小写连字符(`member-departments/`)
- 类名:PascalCase(`MemberDepartmentsModule` / `MemberDepartmentsService`)
- DTO 文件后缀:`.dto.ts`,导出多个 DTO 类
- Service / Controller 方法名:动词开头,语义化

---

## 6. V2 错误码命名规范

### 6.1 命名模式(继承 v1 §5,V2 标准化)

| 场景 | 命名模式 | 示例 |
|---|---|---|
| 资源不存在 | `<RESOURCE>_NOT_FOUND` | `MEMBER_NOT_FOUND` |
| 唯一约束(具体字段) | `<RESOURCE>_<FIELD>_ALREADY_EXISTS` | `MEMBER_USERNAME_ALREADY_EXISTS` |
| 唯一约束(整体冲突) | `<RESOURCE>_ALREADY_EXISTS` | `MEMBER_DEPARTMENT_ALREADY_EXISTS` |
| 业务级输入校验失败 | `<RESOURCE>_<RULE>` | `ORGANIZATION_PARENT_CYCLE` |
| 资源状态非法 | `<RESOURCE>_<STATE>_INVALID` | `MEMBER_STATUS_INVALID` |
| 引用约束(被依赖) | `<RESOURCE>_IN_USE` / `<RESOURCE>_HAS_<DEPENDENT>` | `ORGANIZATION_HAS_MEMBERS` |
| 通用权限拒绝 | `FORBIDDEN_<ACTION>_<RESOURCE>` | `FORBIDDEN_MANAGE_MEMBER` |
| 自我保护 | `CANNOT_<ACTION>_SELF` | `CANNOT_DELETE_SELF` |
| 系统约束保护 | `LAST_<X>_PROTECTED` / `<INVARIANT>_PROTECTED` | `LAST_ROOT_ORGANIZATION_PROTECTED` |
| 操作冲突 | `<RESOURCE>_OPERATION_CONFLICT` | `MEMBER_DEPARTMENT_OPERATION_CONFLICT` |

### 6.2 通用 message 风格

- 中文,12-30 字之间
- 直接陈述事实,**禁止**带操作建议("请重试" / "请联系管理员"由前端添加)
- **禁止**暴露内部细节(数据库表名、字段名、SQL 错误)

### 6.3 错误码使用红线

- 通用 token / 鉴权失败 → 复用 `UNAUTHORIZED = 40100`,**禁止**自创业务码(沿用 v1)
- 限流 → 复用 `TOO_MANY_REQUESTS = 42900`(V1.1 已加)
- ValidationPipe 自动产生的 400 → 走 `BAD_REQUEST = 40000`,业务代码不重复定义同语义码

---

## 7. V2 配置归属规则(沿用 v1 §14)

### 7.1 既有归属表(不重述,见 `CLAUDE.md §14`)

`APP_*` / `DATABASE_URL` / `JWT_*` / `LOG_LEVEL` / `LOGIN_THROTTLE_*` / `SUPER_ADMIN_*` 已锁,V2 不动。

### 7.2 V2 新增配置归属决策模板

任何 V2 新增环境变量必须先回答归属:

| 配置语义 | 归属 |
|---|---|
| 应用级开关(全局生效,与具体业务无关) | `src/config/app.config.ts` |
| 数据库连接相关 | `src/config/database.config.ts` |
| JWT 相关 | `src/config/jwt.config.ts` |
| 模块特有(且仅该模块读取) | `src/config/<module>.config.ts`(新建) |
| Seed / 启动一次性 | **不进 config**,seed 内 `process.env` 直读(对齐 `SUPER_ADMIN_*` 模式) |

### 7.3 业务代码不直读 process.env(沿用)

- 业务代码与 service **不直接** `process.env.XXX`
- 通过对应 `*.config.ts` 注入
- 例外:`SUPER_ADMIN_*` / 未来类似的"仅 seed 一次性使用"配置

### 7.4 启动强校验(沿用)

V2 新增配置必须同步:

- 加进 `.env.example`(带注释说明用途)
- 加进启动强校验(任一不满足直接抛错退出,**禁止**用 fallback 默认值兜底)
- 区分 `APP_ENV`(业务判断)与 `NODE_ENV`(框架内部),**禁止**混用

---

## 8. V2 日志屏蔽清单预扩展

### 8.1 V1.1 已锁清单(继承)

`password` / `newPassword` / `passwordHash` / `authorization` / `cookie` / `token` / `accessToken` / `refreshToken` / `secret` 命中字段日志中显示为 `[REDACTED]`(沿用 V1.1 §17.4)。

### 8.2 V2 预扩展清单(本规范新增)

V2 模块即便对应字段尚未确定要不要落表,**屏蔽规则提前加无害**(对应 `research.md §4.3` 数据最小化原则的"防御性"实现):

#### 个人身份证类

- `idCard` / `idCardNumber` / `idNumber` / `nationalId`

#### 联系方式类

- `phone` / `phoneNumber` / `mobile` / `mobileNumber` / `tel`
- `emergencyContact` / `emergencyContactName` / `emergencyContactPhone` / `emergencyContactRelation`

#### 医疗健康类

- `medicalInfo` / `medicalHistory` / `medicalNotes`
- `allergies` / `chronicDiseases` / `bloodType`
- `remarksSensitive`(任何明确标注为"敏感备注"的字段)

#### 财务类(虽 v1 / V2 都不存,防御性加)

- `bankAccount` / `bankCard` / `bankCardNumber` / `cardNumber`
- `creditCard` / `cvv`

#### 地址类

- `homeAddress` / `address` / `residenceAddress`

#### 出生 / 身份信息类

- `dateOfBirth` / `dob` / `birthDate`

#### 第三方账号 / 凭证标识类

- `wechat` / `wechatId` / `openId` / `unionId`
- `certificateNo` / `licenseNo` / `policyNo`(证书号 / 执照号 / 保单号)

#### 通配规则

- 任何字段名包含子串 `secret` / `credential` / `private` / `pwd`(大小写不敏感)→ 屏蔽

### 8.3 屏蔽实现方式(继承)

- 走 `nestjs-pino` 的 `redact` 配置(V1.1 §17.4 已建立的位置)
- 屏蔽显示为 `[REDACTED]`,**禁止**仅做长度截断
- 嵌套对象路径用 `**` 通配:例如 `*.idCard` / `req.body.password`

### 8.4 字段一旦真的落表,本节如何演进?

本节是 V2 **默认屏蔽基线**,行为定义如下:

- **字段不存在时**:屏蔽规则不生效,不会出错(`nestjs-pino` 的 `redact` 路径未命中即跳过)
- **字段一旦落表**:屏蔽**自动生效**,无需修改业务代码
- **后续新增敏感字段时**:**必须同步补充本节清单**,且与字段进入 schema 的 commit 同批次(或先于该 commit)— 避免出现"字段已落表但屏蔽规则尚未补"的窗口期

修订纪律(对应 §0.4 / §14.3):

- 任何 V2 草案 / 开发任务**新增**敏感字段(尤其引入新类别,如生物特征 / 位置轨迹 / 图像内容描述等)→ 同任务卡内必须把本节列入修订项
- 任何**重命名**已屏蔽字段 → 同任务必须更新本节(避免重命名后绕开屏蔽)
- 任何**删除**字段 → 本节对应条目**保留**(防御性留置,避免后续误恢复字段时漏屏蔽)

**禁止**把"屏蔽规则修订"延后到字段落表之后的独立 commit。

---

## 9. V2 Guard 注册延续

### 9.1 全局 Guard 顺序不变(沿用 v1 §8)

```typescript
providers: [
  { provide: APP_GUARD, useClass: JwtAuthGuard },   // 1. 验登录
  { provide: APP_GUARD, useClass: RolesGuard },     // 2. 验角色
]
```

V2 **不引入**第三个 Guard。理由:

- 部门级数据范围权限(如"部门负责人只能管本部门人")**显式**在 Service 内 `assertCanXxx` 实现,**不**通过 Guard 层
- 这是 `research.md §3.11` / `CLAUDE.md §18.2` 锁定的红线

### 9.2 装饰器使用纪律

继承 v1 §8:

- 未标 `@Public()` 默认要登录
- `@Public()` 与 `@Roles(...)` 互斥
- `@Roles(...)` 但 `request.user` 为空 → 拒绝访问(抛 `BizException(BizCode.UNAUTHORIZED)`)
- `JwtAuthGuard` 通过 `Reflector` 识别 `@Public()`(实现已锁,V2 不动)

### 9.3 V2 新模块 Controller 标注约定

| 接口语义 | 装饰器 | 备注 |
|---|---|---|
| 公开接口(无需登录) | `@Public()` | V2 仅 `/api/health` 系列继续公开,V2 业务接口默认不公开 |
| 需登录但任意角色可访问 | (默认,无需装饰) | |
| 需特定角色 | `@Roles(Role.SUPER_ADMIN, Role.ADMIN)` | 角色枚举从 `@prisma/client` 导入 |
| 本人专属接口 | (默认 + Service 内校验 `userId === currentUser.id`) | 不通过 Guard 层 |
| 部门 / 资源数据范围 | (默认 + Service 内 `assertCanXxx`) | 不通过 Guard 层 |

---

## 10. V2 软删除显式封装(不引入 Prisma 中间件)

### 10.1 红线(沿用 v1 §10 + `research.md §6.5`)

- **不**引入 Prisma 全局软删除中间件
- **不**引入 Prisma client extension 实现自动软删
- 软删除 = `update({ deletedAt: new Date() })`;查询 = `findFirst({ where: { ..., deletedAt: null } })`
- 业务详情查询**禁止** `prisma.<model>.findUnique()`(忽略软删过滤),统一 `findFirst({ where: notDeletedWhere(...) })`
- 唯一性预检查**必须** `findUnique`(包含软删记录),理由见 v1 §10

### 10.2 helper 位置与形态(V2 新增决策)

#### 10.2.1 位置与形态

```
src/common/prisma/soft-delete.util.ts
  └── 仅导出纯函数,例如:
      export const notDeletedWhere = <T>(where?: T): T & { deletedAt: null }
```

#### 10.2.2 形态铁律(只允许什么 / 禁止什么)

**允许**:

- ✅ 纯函数 helper(无 `this` / 无状态 / 无副作用)
- ✅ 多个独立 helper 函数(`notDeletedWhere` / `softDeleteUpdate` 等),每个都是纯函数
- ✅ Service 内**显式**调用(`where: notDeletedWhere({ id })`)

**禁止**(顺手做反模式清单):

- ❌ `BaseRepository` / `BaseService` / `SoftDeleteRepository` 等基类抽象
- ❌ `@Injectable()` Service(任何 NestJS provider 形式)
- ❌ Prisma `middleware`(`prisma.$use(...)`)
- ❌ Prisma `client extension`(`prisma.$extends(...)`)
- ❌ 修改 `PrismaService` 在内部"自动注入" `deletedAt: null` 过滤
- ❌ 装饰器自动改写(`@SoftDelete` 注解)
- ❌ 拦截器 / Guard / Pipe 自动加软删条件
- ❌ 任何形式的"隐式自动过滤"— 所有软删过滤必须在 service 代码里**肉眼可见**

#### 10.2.3 为什么这么严格

继承 v1 §10 与 `research.md §6.5` 的核心原则:**软删过滤必须显式**。一旦引入隐式自动过滤(无论中间件、扩展、基类还是装饰器),都会出现以下风险:

- "管理员看回收站"等需要绕过软删的场景必须开口子,口子越多越混乱
- 唯一性预检查(必须 `findUnique` 包含软删记录)与默认过滤行为冲突
- 后续 AI 维护时"为什么这条记录查不到"难以定位
- Prisma 升级时中间件 / 扩展 API 可能 breaking change,业务代码受连带影响

显式调用 `notDeletedWhere(...)` 虽然啰嗦,但**啰嗦换可读**。

#### 10.2.4 实现时机

V2 第一个使用软删的模块(预计 `organizations` 或 `dictionaries`)开发时落地;落地内容仅 1 个 `.util.ts` 文件 + 单元测试(可选,因为是纯函数,逻辑简单)。

### 10.3 各表软删策略原则(草案逐表评估,本节仅给原则)

| 表类别 | 默认策略 |
|---|---|
| 业务核心表(members / organizations / events) | 软删除([当前倾向]) |
| 关系中间表(member_departments / event_participants) | 视语义而定,草案决策 |
| 字典 items(dict_items) | **不**物理删,优先用 `status` 启停标记;`deletedAt` 字段是否保留由草案决策 |
| 审计日志(audit_logs) | **绝不**软删,**也不允许**任何删除 |
| 附件元数据(attachments) | 视归属对象生命周期联动,草案决策 |

### 10.4 v1 软删纪律的延续

- `seed` / 创建 / 更新的唯一性预检查**必须** `findUnique`(包含软删记录),**禁止** `findFirst + notDeletedWhere`(理由见 v1 §10)
- 访问已软删资源的详情 / 修改 / 删除接口,统一返回"资源不存在"(`<RESOURCE>_NOT_FOUND`),**不**单独提示"已删除"

---

## 11. V2 不破坏 v1 14 接口的兼容性白名单

### 11.1 兼容性铁律

V2 **不修改** `docs/archive/legacy/architecture-v1-blueprint.md §6`(原 `ARCHITECTURE.md §6`,PR-6 已归档)已交付的 14 个 v1 接口的:

- 路径(URL)
- HTTP 方法
- 入参 DTO 字段集(可新增可选字段,但**禁止**删除 / 重命名 / 改类型)
- 出参 DTO 字段集(**禁止**删除 / 重命名 / 改类型)
- 权限标注(`@Public` / `@Roles`)
- 错误码语义

### 11.2 v1 14 接口清单(权威源 = `docs/archive/legacy/architecture-v1-blueprint.md §6`,原 `ARCHITECTURE.md §6`,PR-6 已归档)

V2 文档不重复罗列字段集,以 `docs/archive/legacy/architecture-v1-blueprint.md §6`(原 `ARCHITECTURE.md §6`,PR-6 已归档)为单一权威源。V2 任何修改 `auth/` / `users/` / `health/` 模块的动作,必须先回到该归档 §6 比对兼容性。

### 11.3 V2 与 v1 集成的允许动作

- ✅ 在 v1 接口出参 DTO 新增**可选**字段(标 `nullable`),不影响现有客户端
- ✅ 在 v1 数据表新增**可空**外键(如 `users.memberId` 候选)
- ✅ 新增 v1 模块的扩展接口(路径在 v1 接口之外)

### 11.4 V2 与 v1 集成的禁止动作

- ❌ 删除 / 重命名 / 改类型 v1 已交付字段
- ❌ 修改 v1 接口的 HTTP 方法或路径
- ❌ 在 v1 出参中新增**必返**字段(可能破坏旧客户端 schema 校验)
- ❌ 把 V2 字段(如 `members.*`)倒灌进 v1 `UserResponseDto`
- ❌ 修改 v1 的全局 ResponseInterceptor / AllExceptionsFilter / Guard 行为

### 11.5 OpenAPI 契约快照保护

V1.3 已建立 `test/contract/openapi.contract-spec.ts` 快照测试。V2 任何修改可能影响 v1 14 接口的动作,必须:

1. 先确认是否真有必要修改 v1 接口(默认应当被否决,走 §11.4 红线)
2. 若必要,显式在 PR 中说明并更新快照
3. 用户拍板后才能合并

---

## 12. V2 时区 / Date 处理(沿用 v1)

### 12.1 全栈时区策略

| 层级 | 时区策略 |
|---|---|
| 数据库(PostgreSQL) | 存 UTC,字段类型 `timestamptz`(Prisma `DateTime` 默认行为) |
| 应用层(NestJS service) | 用 JS `Date` 对象,内部按 UTC 处理 |
| API 响应(JSON 序列化) | ISO 8601 with `Z` 后缀(UTC),例 `2026-05-07T08:30:00.000Z` |
| 前端展示层 | 负责本地时区转换(后端**不**预先转) |

### 12.2 禁止项

- ❌ 后端按"中国时区 / UTC+8"提前转换
- ❌ 数据库字段类型用 `timestamp without time zone`
- ❌ API 响应用本地时间字符串(`2026-05-07 16:30:00`)
- ❌ 各模块自行决定时区策略(必须全局统一)

### 12.3 接收时间入参

- API 入参时间字段必须接受 ISO 8601 格式
- ValidationPipe + class-transformer 自动转 `Date`
- **禁止**接受多种格式(如同时支持 `2026-05-07` 和 `2026/05/07`)

---

## 13. V2 任务验收门槛

### 13.1 类比 V1.1 §17.10 的两档制

V2 模块开发任务完成后,按以下两档逐项验证再报告完成:

#### A 档 — 基础验收(每个任务都必须跑)

1. `pnpm lint` 通过
2. `pnpm typecheck` 通过
3. `pnpm test:e2e` 全部通过(含 v1 / V1.1 已有用例)
4. `pnpm test:contract` 通过(若任务影响 OpenAPI schema,显式更新快照)
5. 该任务自身验收标准全部满足
6. 没有引入未在任务卡声明的新依赖

#### B 档 — 手工验证(涉及 HTTP 行为 / 全局中间件 / 拦截器 / Guard / Controller / Swagger 时,在 A 档基础上追加)

启动服务,逐项确认:

- `/api/docs` 能正常打开,Swagger UI 完整可用
- `GET /api/health` / `/api/health/live` / `/api/health/ready` 仍按 v1 / V1.1 契约返回(向后兼容)
- 本任务**新增或影响的接口**能按预期返回,覆盖典型成功路径与典型错误路径
- 涉及敏感字段的接口,日志中字段显示为 `[REDACTED]`(对照 §8 屏蔽清单)

### 13.2 档位归属说明(V2 特化)

| 任务类型 | 档位 |
|---|---|
| 新增业务模块(controller / service / DTO) | A + B |
| Schema 变更(新表 / 改表) | A + B(B 档需验 v1 接口未受影响) |
| Seed 改动 | A + B(B 档需验 seed 幂等) |
| **纯文档变更** | **见 §13.3 — 不强制跑 lint/typecheck/e2e/contract** |
| 测试用例新增 / 修改 | A 档全跑 |
| CI / Docker 改动 | A 档全跑 + smoke 验证(若有) |

任一未通过 → **不算完成,不能 commit,不能向用户报告"任务完成"**(沿用 V1.1 §17.10 末尾纪律,**仅文档变更场景例外,见 §13.3**)。

### 13.3 纯文档变更的特殊处理

**判定准则**(必须**全部满足**才算"纯文档变更"):

- `git diff --name-only` 输出**只**包含 `docs/*.md` 或仓库**根目录**的 `.md` 文件(`README.md` / `CHANGELOG.md` / `CLAUDE.md` / `AGENTS.md` / `ARCHITECTURE.md` / `TASKS.md` 等)
- **不**触碰 `src/**`
- **不**触碰 `prisma/**`(包括 `schema.prisma` / `migrations/` / `seed.ts`)
- **不**触碰 `package.json` / `pnpm-lock.yaml`
- **不**触碰 `.github/workflows/**`
- **不**触碰 `Dockerfile` / `docker-compose.yml` / `.dockerignore`
- **不**触碰任何 `*.config.ts` / `tsconfig*.json` / `eslint.config.*` / `.prettierrc` / 其它配置文件
- **不**新增或修改 `.env.example` / `.env.test` 等环境样板

**满足上述全部条件** → 验收只需:

1. 跑 `git diff --stat` / `git status` 自查,确认变更范围
2. 文档内部引用链接可达(若是新增文档,引用 `docs/*.md` 的相对路径正确;引用 `ARCHITECTURE.md §X` 等章节号实际存在)
3. **不强制**跑 `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm test:e2e` / `pnpm test:contract` / `pnpm build`

**任一条件不满足**(例如同 commit 还动了 `package.json` / `src/main.ts` / `prisma/schema.prisma`)→ **立即不再视为纯文档变更**,按 §13.2 表格中对应任务类型走完整 A 档(必要时加 B 档)。

#### 边缘情况

- 同 commit 既动文档又动 `src/**`:**不**适用本节,按"新增业务模块"或对应任务类型走 A+B 档
- 仅修改 `*.md` 中的 markdown link / typo / 排版:适用本节
- 仅修改 `.env.example` 中的注释行(不改变量):**不**适用本节(`.env.example` 触碰本身可能影响启动强校验对照表),按 A 档跑
- 修改 `docs/` 下非 `.md` 文件(如附图):若仓库后续引入此场景,需先在本节列出处理规则,目前**不**适用本节

---

## 14. 与 V2 草案 / 开发阶段的关系

### 14.1 草案文档的隐含约束

`docs/v2-data-model.md` / `docs/v2-api-contract.md` 等开发级文档(以及历史计划 `docs/archive/plans/v2-first-stage-plan.md`,原 `docs/v2-plan.md`,PR-5 已归档;历史草案 `docs/archive/plans/v2-design-phase/srvf-foundation-data-model-draft.md`,PR-4 已归档):

- **默认遵守**本规范,**无需逐项重述**
- 草案中可显式援引"基线规范 §X.Y",但不重抄具体内容
- 与本规范冲突的草案内容视作越权,需先回到本规范评审

### 14.2 开发任务卡的隐含约束

`TASKS.md` V2 开发任务卡(D8 通过后另起):

- 默认遵守本规范的所有铁律(命名、错误码、响应、Swagger、配置、日志屏蔽、Guard、软删除、兼容性、时区、验收门槛)
- 任务卡**无需**为每条铁律单独列验收点,只列任务**自身**的额外验收点
- 任务执行过程中违反本规范任一项 → 视作越权,必须暂停并向用户说明

### 14.3 修订纪律

- 本规范任何修订需用户拍板
- 修订 commit message 前缀:`v2-design: baseline <章节> <简述>`
- 修订需在附录 A 显式记录版本与变更
- 修订**不**自动追溯已发布的 v1 / V1.1 / V2 已交付模块,只对**修订后**新动作生效;若需追溯,作为独立任务单独立项

### 14.4 与 v1 / V1.1 铁律的优先级

冲突时:

1. v1 §1-§10 / `CLAUDE.md §1-§17` 最高优先级
2. V1.1 §11 / `CLAUDE.md §17` 次之
3. 本基线规范第三
4. 草案文档第四
5. 开发任务卡最低

发现冲突且本规范在更高优先级范围内,**禁止** AI 自行调和,必须暂停说明。

---

## 附录 A:本文件版本

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-05-07 | 初版,A 档 13 项 + 与草案 / 开发阶段关系章节 |
| v0.2 | 2026-05-11 | §1.1 批次 3 段位收口(v0.4.0 release 同步):`180xx` `events` 槽位**废弃保留**(不再启用,不释放);新增 `activities` `200xx/201xx` / `activity_registrations` `210xx/211xx` / `attendances` `220xx/221xx`(均已在 v0.4.0 实装落地,27 BizCode 全部就位);未规划模块从 `230xx` 起 |
| v0.3 | 2026-05-11 | §1.1 修正 `certificates` 段位归属:批次 2(v0.3.0,2026-05-10)已实装的 `certificates` 占用 `180xx + 181xx`(5 BizCode:`18001` / `18010` / `18011` / `18030` / `18101`,详见 `CHANGELOG.md` v0.3.0 段与 [src/common/exceptions/biz-code.constant.ts](../src/common/exceptions/biz-code.constant.ts) 模块内注释);v0.2 修订时**误将该槽位标记为 `events` 废弃保留**,本次更正为 `certificates` 已实装,并新增"批次 2 已实装"状态说明;`events` / `event_participants` 命名废弃语义保留为"历史命名废弃"状态条目,但 BizCode 段位维度**不存在废弃保留**——所有段位要么已实装,要么基线预留 / V2 候选预留 / 未规划预留 |
| v0.4 | 2026-05-12 | §1.1 批次 4-A 段位补充(v0.4.0 post-release,**未 bump version**):`220xx` `attendances` 段位由批次 3B 14 BizCode 扩展为 17(沿段位补 `22043` / `22045` / `22046`,**不新开模块码**),配合 `AttendanceSheet` 5 态状态机(`pending` / `pending_final_review` / `approved` / `rejected` / `final_rejected`)+ APD 终审 + ContributionRule 系统预填;沿 D-S2 **不开** `22044` `FORBIDDEN_*`(APD 部门部长 / 副部长专属权限留后续 RBAC 批次);未规划模块仍从 `230xx` 起 |
| v0.5 | 2026-05-12 | §1.1 批次 5-A 段位收口(v0.5.0 post-release,**未 bump version**):新开 `230xx` + `231xx` `contribution_rules` 模块段位,`230xx` 实装 5 BizCode(`23001` / `23002` / `23010` / `23011` / `23012`);**不开** `23030` `KEY_FIELDS_NOT_EDITABLE`(PATCH 维度禁改交给 DTO 白名单 + ValidationPipe `forbidNonWhitelisted` 拦截抛 40000;沿 D6 v1.1 §2.2 E8);**不开** `23101~23104` `FORBIDDEN_*`(沿 baseline 风格,Guard 拒绝走通用 40300);**不开** `23103` `LAST_RULE_PROTECTED`(无最后一条规则保护需求,沿 batch 4-B `22048` 不抛错路径);本批次 schema 影响 0(batch 4-A 已落地完整 model + partial unique + 审计字段);未规划模块从 `240xx` 起 |
| v0.6 | 2026-05-14 | §1.1 C-6 D7 v0.2 局部收口段位预留(沿 [`docs/批次8_RBAC_API前评审.md`](批次8_RBAC_API前评审.md) v0.2 局部收口稿同步;v0.8.1 handoff §10 启动后 Fast-1 任务):新增 `300xx + 301xx` `permissions`(C-6 RBAC)模块段位预留,**避开 `140xx + 141xx`**(已被 audit_logs 批次 6 v0.7.0 占用,不可与 RBAC 共用);**中间留 `240xx-290xx`** 给未来未规划业务模块(训练 / 装备 / 财务 / 通知等);RBAC 是项目骨架级模块,值得占独立段位空间;原"`240xx` 起 未规划模块预留" 拆分为 "`240xx-290xx` 未规划" + "`300xx + 301xx` permissions" + "`310xx` 起 未规划";**段位预留 ≠ 段位实装**,本次仅 baseline 段位锁定,RBAC 4 model + ~14 个 BizCode 实装由 C-6 RBAC V2.x 立项后实施 PR 完成(预估 9 个 PR);本次纯文档变更,沿 baseline §13.3:**不改 schema / migration / 代码 / 测试 / version / tag / release** |

---

## 附录 B:本规范覆盖的"A 档 13 项"溯源

对照 `docs/archive/plans/v2-design-phase/srvf-foundation-research.md` §5(原 `docs/srvf-foundation-research.md`,PR-4 已归档)与本对话设计的 A 档清单:

| A 档项 | 本文档章节 |
|---|---|
| A1 BizCode 段位分配 | §1 |
| A2 通用命名约定 | §2 |
| A3 响应包装 / 异常 / Swagger | §3 |
| A4 入参 DTO 字段白名单纪律 | §4 |
| A5 模块结构 | §5 |
| A6 错误码命名规范 | §6 |
| A7 配置归属规则 | §7 |
| A8 日志屏蔽清单预扩展 | §8 |
| A9 Guard 注册延续 | §9 |
| A10 软删除显式封装 | §10 |
| A11 不破坏 v1 14 接口的兼容性白名单 | §11 |
| A12 时区 / Date 处理 | §12 |
| A13 任务验收门槛 | §13 |
