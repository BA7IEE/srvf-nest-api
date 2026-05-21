# 《批次 5-A ContributionRule CRUD API 前评审稿》(D6 v1.1)

> **本版变更**:v1.0 → v1.1,5 点修订(详见 §16);**评审通过,本稿归档**。
> **文档定位**:V2 第一阶段批次 5-A 评审收口稿(D6),沿 batch 1/2/3/4 评审稿命名习惯。
> **归档版本**:v1.1。
> **冲突优先级**:`ARCHITECTURE.md` > `CLAUDE.md`(v1 §1-§16 → V1.1 §17 → V2 §18)> `docs/srvf-foundation-baseline.md` > 本评审稿 > 任务卡。
> **前置文档**:本批次 D5 立项草案、D6 v1.0(评审讨论历史,不入档)。

---

## 0. 元信息

| 项 | 值 |
|---|---|
| 批次 | 5-A ContributionRule CRUD |
| 立项基准版本 | v0.5.0 + PR #22(main HEAD `9e60ec2`) |
| 目标版本 | v0.6.0 |
| 前置批次 | batch 4-A schema(`2190803` PR #18)+ batch 4-B service / API(`6812db9` PR #19) |
| schema 影响 | **0**(batch 4-A 已落地;含 partial unique `contribution_rules_active_unique` + 审计字段 `createdByUserId` / `updatedByUserId` / `deletedByUserId`) |
| migration 影响 | **0** |
| 新增模块 | `src/modules/contribution-rules/`(独立平铺) |
| 新增模块文件 | **5 个**(主体 4 文件 + `contribution-rules.select.ts` 安全字段 select 辅助文件;沿 v1 `users.select.ts` 范式) |
| 新增 BizCode 段位 | `230xx`(独立段) |
| 新增接口数 | 5 |
| 累计接口数 | 86 → **91** |

---

## 1. 评审通过条件(与本稿生效条件)

本稿 §2 / §3 / §4 / §5 / §6 / §7 / §8 / §9 / §10 / §11 / §12 锁定的所有项,**实施 PR 不得偏离**;偏离即不可合并。`docs/srvf-foundation-baseline.md §14` A 档 13 项规范全部生效,本稿是其在 5-A 上的具体化。

---

## 2. 决议表

> 决议状态分四档:
> - `[已锁定]` — 本批次必做,实施 PR 不得偏离
> - `[本批次不做]` — 5-A 不做,**不预判未来**;若后续运营强需求,作为独立批次评审立项后再做
> - `[后续批次]` — 5-A 不做,已识别为后续明确批次(如 5-B / audit_logs 复活)
> - `[永久不做]` — `ARCHITECTURE.md` / handoff §7.1 锁定,**不会复活**

### 2.1 业务决议(8 项)

| # | 决议 | 状态 | 备注 |
|---|---|---|---|
| **B1** | 规则规模 < 100 条设计;保留分页;默认 `pageSize=20`,上限 100(沿 v1 §4) | `[已锁定]` | 索引沿 batch 4-A schema 6 个 index,不补 |
| **B2** | `durationThreshold = NULL` 多条 ACTIVE:**create / update 时直接拒绝**,抛 `CONTRIBUTION_RULE_ACTIVE_DUPLICATE`(23002) | `[已锁定]` | service 层 count(同事务内,含 NULL 维度);DB partial unique 不约束 NULL 多条,**业务约束唯一兜底** |
| **B3** | PATCH 禁止修改 `activityTypeCode` / `attendanceRoleCode` / `durationThreshold`;改维度必须**停用旧规则后新建** | `[已锁定]` | 工程实现见 §3.4 + §4.2 |
| **B4** | `pointsAbove != null` 时必须严格 `pointsAbove > pointsBelow`(**不是 `>=`**),否则抛 `CONTRIBUTION_RULE_POINTS_INVALID`(23010) | `[已锁定]` | 同条规则下"超档位"分值必须严格高于"档内"分值 |
| **B5** | `dailyCap` 存 `null`(请求 `null` / omit 等价落 NULL);attendance 预填**继续沿** `DEFAULT_DAILY_CAP = 1.5` 兜底 | `[已锁定]` | `src/modules/attendances/attendances.service.ts:587` 不动;响应保留 `null`,不预先 fallback |
| **B6** | 不做 `effectiveFrom` / `effectiveTo` / 规则版本号 | `[本批次不做]` | 后续若有需要,作为独立 schema 批次立项 |
| **B7** | **5-A 不做** `dryRun` / 试算接口;后续如运营强需求,**作为独立批次评审立项后再做** | `[本批次不做]` | **v1.1 修订**:由 `[永久不做]` 降级为 `[本批次不做]`;触发条件 = 运营强需求 + 独立评审 |
| **B8** | 规则修改**只影响新提交** AttendanceSheet;**不重算**历史 / pending / pending_final_review / rejected / final_rejected Sheet | `[已锁定]` | 沿 batch 4-B "submit 时同事务内预填,之后不再读" 语义;无重算路径 |

### 2.2 工程决议(8 项)

| # | 决议 | 状态 | 备注 |
|---|---|---|---|
| **E1** | 路径前缀 `/api/v2/contribution-rules`(连字符复数,与 `activity-registrations` / `attendance-sheets` 一致) | `[已锁定]` |  |
| **E2** | 模块独立平铺 `src/modules/contribution-rules/`;**主体 4 文件铁律(沿 v1 §2)** + **允许新增 `contribution-rules.select.ts` 作为安全字段 select 辅助文件**(沿 v1 §8 `users.select.ts` / batch 2 既有范式)| `[已锁定]` | **v1.1 修订**:消除 v1.0 与"4 文件铁律"的字面冲突;5-A 模块共 **5 个文件**,select.ts 不是新业务文件,而是 v1 §11 既有"集中安全字段"机制的延续 |
| **E3** | BizCode 使用独立 `230xx` 段(实体级)+ `231xx` 段(权限 / 操作 / 完整性,本批次不开任何码,**段位预留**)| `[已锁定]` | baseline §1.1 v0.4 "未规划模块从 230xx 起" → v0.5 收口段位归属为 `contribution_rules` |
| **E4** | 权限沿用 `@Roles(Role.SUPER_ADMIN, Role.ADMIN)`,所有 5 接口一致 | `[已锁定]` | APD 部门部长 / 副部长细分留 5-B |
| **E5** | 软删除写 `deletedAt = new Date()` + `deletedByUserId = currentUser.id`(**ContributionRule schema 已在 batch 4-A 包含 `deletedByUserId` 字段**,见 `prisma/schema.prisma:673`);`status` 不强制改 INACTIVE;**注意:`AttendanceRecord` 的软删字段集与 `ContributionRule` 不同,5-A 不复用 / 不混淆 / 不抽公共工具** | `[已锁定]` | **v1.1 修订**:显式说明 schema 已含 `deletedByUserId`,且与 `AttendanceRecord` 软删字段集解耦 |
| **E6** | audit 沿 `auditPlaceholder`,**不落 `audit_logs` 表**;hook 3 个写操作(create / update / delete);list / detail **不 hook**(规则是配置数据,非个人敏感信息,沿 batch 3 写操作 hook 范式)| `[已锁定]` | 新增 AuditEvent union 项:`contribution-rule.create` / `.update` / `.delete` |
| **E7** | 响应只暴露 `createdByUserId` / `updatedByUserId`(字符串),**不暴露**用户摘要(nickname / role / username) | `[已锁定]` | 前端按 id 关联查询;沿 v1 §11 严格类型分离 |
| **E8** | 5-A **不开** `23030 CONTRIBUTION_RULE_KEY_FIELDS_NOT_EDITABLE`;PATCH 禁改字段交给 `UpdateContributionRuleDto` 白名单 + 全局 `ValidationPipe forbidNonWhitelisted` 拦截 → 走通用 `BAD_REQUEST` / 40000 | `[已锁定]` | 简化 service 层;DTO 白名单是第一道防线(沿 baseline §4.2) |

### 2.3 本批次必须包含(7 项)

| # | 必做项 | 状态 |
|---|---|---|
| **M1** | ContributionRule 5 个 CRUD 接口(GET list / GET :id / POST / PATCH / DELETE) | `[已锁定]` |
| **M2** | create / update 的 ACTIVE 唯一性 **service 层兜底**,包括 `durationThreshold = NULL`(同事务 count + 抛 23002) | `[已锁定]` |
| **M3** | Prisma P2002 unique 冲突**显式捕获并转** `CONTRIBUTION_RULE_ACTIVE_DUPLICATE`(23002)(沿 v1 §5 / batch 2 P2002 范式) | `[已锁定]` |
| **M4** | `activityTypeCode` / `attendanceRoleCode` 字典 active 校验(沿 `src/modules/activities/activities.service.ts:310` 范式) | `[已锁定]` |
| **M5** | `contributionPoints: null` 显式入参 e2e 补测,**写入** `test/e2e/attendances.e2e-spec.ts`(P2-1 缺口收口;沿 PR #22 范式) | `[已锁定]` |
| **M6** | OpenAPI contract snapshot 更新,含新增 5 paths + 4 schemas | `[已锁定]` |
| **M7** | CHANGELOG / docs / `bump version` **后续独立 PR**,**不在实现 PR 中混入**(沿 v0.3 / v0.4 / v0.5 三 PR 节奏) | `[已锁定]` |

### 2.4 本批次禁止(10 项)

| # | 禁做项 | 状态 | 备注 |
|---|---|---|---|
| **F1** | 不改 `prisma/schema.prisma` | `[本批次不做]` |  |
| **F2** | 不新增 migration | `[本批次不做]` |  |
| **F3** | 不做 APD 部门部长 / 副部长权限细分 | `[后续批次]` | 5-B |
| **F4** | **5-A 不做** `dryRun` / 试算接口;后续如运营强需求,**作为独立批次评审立项后再做** | `[本批次不做]` | **v1.1 修订**:由 `[永久不做]` 降级,与 B7 同步 |
| **F5** | **5-A 不做** 批量重算 attendance Sheet;**默认不做**;后续若需要,**作为独立批次评审立项后再做** | `[本批次不做]` | **v1.1 修订**:由 `[永久不做]` 降级 |
| **F6** | 不做 `contribution_points` 独立流水表 / cron-job | `[永久不做]` | handoff §7.1 / D49 / R32;**保持** |
| **F7** | 不做 `audit_logs` 落库 | `[后续批次]` | 独立形态评审 |
| **F8** | 不改 attendance 状态机(5 态闭集不动)| `[本批次不做]` |  |
| **F9** | 不改 `attendance.recorded` 触发点(仍仅 final-approve)| `[本批次不做]` |  |
| **F10** | 不改 v1 14 接口 + batch 1/2/3/4 已落地接口的 schema + paths | `[已锁定]` | 零漂移铁律 |

### 2.5 v1.1 状态调整说明

**为什么 dryRun / 批量重算 从 `[永久不做]` 降级为 `[本批次不做]`?**

- `[永久不做]` 是 handoff §7.1 锁定的"不会复活"项,改动需走 `ARCHITECTURE.md §9` 升级路径
- dryRun / 批量重算的"该不该做"取决于**运营实际工作流**,不是技术架构边界;运营若反馈"管理后台需要试算/批量重算"时,应当能通过独立批次评审立项
- 因此降级为 `[本批次不做]` + 触发条件"运营强需求 + 独立评审",更准确反映可演进性

**为什么 contribution_points 流水表保持 `[永久不做]`?**

- 流水表 / cron-job 是**技术架构**层面的"延后实现路径",handoff §7.1 / `ARCHITECTURE.md §9` 锁定;复活需走架构升级路径
- 用户在本轮明确"contribution_points 独立流水表仍保持永久不做"

**两者差异**:dryRun / 批量重算是**接口形态**(运营可见),contribution_points 流水表是**数据架构**(后端持久化策略);前者运营场景驱动,后者架构演进驱动。

---

## 3. API 契约最终形态(锁定)

### 3.1 路径与方法

| 方法 | 路径 | Controller 方法 | Roles | HTTP 成功状态 |
|---|---|---|---|---|
| GET | `/api/v2/contribution-rules` | `list` | `SUPER_ADMIN, ADMIN` | 200 |
| GET | `/api/v2/contribution-rules/:id` | `findOne` | `SUPER_ADMIN, ADMIN` | 200 |
| POST | `/api/v2/contribution-rules` | `create` | `SUPER_ADMIN, ADMIN` | 201 |
| PATCH | `/api/v2/contribution-rules/:id` | `update` | `SUPER_ADMIN, ADMIN` | 200 |
| DELETE | `/api/v2/contribution-rules/:id` | `softDelete` | `SUPER_ADMIN, ADMIN` | 204 |

**Swagger 装饰器锁定**:
- 每方法 `@ApiOperation({ summary })` + `@ApiBearerAuth()`
- list 用 `@ApiWrappedPageResponse(ContributionRuleResponseDto)` + 类上 `@ApiExtraModels(ContributionRuleResponseDto, PageResultDto)`
- detail / create / update 用 `@ApiWrappedOkResponse(ContributionRuleResponseDto)`
- delete 无返回数据,沿 batch 2 certificates softDelete 范式

### 3.2 入参 DTO 锁定

#### `CreateContributionRuleDto`

```
activityTypeCode    : string             @IsString @IsNotEmpty @MaxLength(64)
attendanceRoleCode  : string             @IsString @IsNotEmpty @MaxLength(64)
durationThreshold?  : number | null      @IsOptional @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01)
pointsBelow         : number             @IsNumber({ maxDecimalPlaces: 2 }) @Min(0)
pointsAbove?        : number | null      @IsOptional @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0)
dailyCap?           : number | null      @IsOptional @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01)
status?             : 'ACTIVE' | 'INACTIVE'  @IsOptional @IsEnum  (默认 ACTIVE)
remark?             : string             @IsOptional @IsString @MaxLength(500)
```

**字段语义校验注意**:
- 字段层 `@IsOptional` 是"可省略",`@ValidateIf((_, v) => v !== null)` 是"显式 null 跳过类型检查"(沿 PR #22 `contributionPoints` 三态范式),Swagger 标 `nullable: true`
- `durationThreshold = 0` 拒(`@Min(0.01)`,沿 attendance `serviceHours` 范式)

#### `UpdateContributionRuleDto`(白名单**仅以下 5 字段**)

```
pointsBelow?        : number             @IsOptional @IsNumber({ maxDecimalPlaces: 2 }) @Min(0)
pointsAbove?        : number | null      @IsOptional @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0)
dailyCap?           : number | null      @IsOptional @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01)
status?             : 'ACTIVE' | 'INACTIVE'  @IsOptional @IsEnum
remark?             : string | null      @IsOptional @ValidateIf((_, v) => v !== null) @IsString @MaxLength(500)
```

**关键**:`activityTypeCode` / `attendanceRoleCode` / `durationThreshold` **不在白名单**;调用方传入这三个字段任意一个 → 全局 `ValidationPipe forbidNonWhitelisted` 抛 BAD_REQUEST(40000;HTTP 400)。**5-A 不开 23030**(决议 E8)。

#### `ContributionRuleQueryDto` extends `PaginationQueryDto`

```
activityTypeCode?   : string             @IsOptional @IsString @MaxLength(64)
attendanceRoleCode? : string             @IsOptional @IsString @MaxLength(64)
status?             : 'ACTIVE' | 'INACTIVE'  @IsOptional @IsEnum
```

继承 `page` / `pageSize`;**不**暴露 `includeDeleted` / `deletedAt` 过滤(沿 v1 §10 软删后不开恢复接口)。

#### `IdParamDto`

复用 `src/common/dto/id-param.dto.ts`;**不新建**。

### 3.3 出参 DTO 锁定

#### `ContributionRuleResponseDto`

```
id                  : string
activityTypeCode    : string
attendanceRoleCode  : string
durationThreshold   : number | null      (Decimal → Number 序列化;null 显式 nullable: true)
pointsBelow         : number
pointsAbove         : number | null
dailyCap            : number | null
status              : 'ACTIVE' | 'INACTIVE'
remark              : string | null
createdAt           : string             (ISO 8601)
updatedAt           : string             (ISO 8601)
createdByUserId     : string | null
updatedByUserId     : string | null
```

**绝对不暴露**:`deletedAt` / `deletedByUserId`(沿 v1 §11);用户摘要(nickname / role / username)(决议 E7)。

**Decimal → Number 序列化**:沿 batch 3 attendance `serviceHours` / batch 4-A `pointsBelow` 范式,在 service `toResponseDto` 转换层做 `Number(decimal)`;DTO 字段类型用 `number`,Swagger 标 `type: 'number'`。

#### 集中 `contributionRuleSafeSelect`

新建 `src/modules/contribution-rules/contribution-rules.select.ts`(沿 v1 `users.select.ts` 范式),集中列出对外字段,**不含** `deletedAt` / `deletedByUserId`;service 内部所有 SELECT 走该 select。**该文件不是新业务文件,而是 v1 §11 "DTO 与 Prisma 类型严格分离 + 集中安全字段 select" 既有机制的延续**(决议 E2)。

---

## 4. Service 行为契约(锁定)

### 4.1 create 完整流程

```
async create(dto: CreateContributionRuleDto, currentUser: CurrentUser): Promise<ContributionRuleResponseDto>
  归一化 dto.status ?? 'ACTIVE'
  在 prisma.$transaction 内:
    1. 字典 active 校验
       - DictionariesService 复用 batch 3 activities 范式
       - activity_type / dto.activityTypeCode 不 active → CONTRIBUTION_RULE_ACTIVITY_TYPE_INVALID (23011)
       - attendance_role / dto.attendanceRoleCode 不 active → CONTRIBUTION_RULE_ROLE_CODE_INVALID (23012)
    2. 字段语义校验
       - dto.pointsAbove !== null && dto.pointsAbove !== undefined:
         - dto.durationThreshold === null || undefined → CONTRIBUTION_RULE_POINTS_INVALID (23010)
         - dto.pointsAbove <= dto.pointsBelow              → CONTRIBUTION_RULE_POINTS_INVALID (23010)
    3. ACTIVE 唯一性兜底(决议 B2):
       仅当 normalizedStatus === 'ACTIVE' 时执行
       count = tx.contributionRule.count({
         where: {
           activityTypeCode: dto.activityTypeCode,
           attendanceRoleCode: dto.attendanceRoleCode,
           durationThreshold: dto.durationThreshold ?? null,  // 显式 NULL 维度比较
           status: 'ACTIVE',
           deletedAt: null,
         }
       })
       count >= 1 → CONTRIBUTION_RULE_ACTIVE_DUPLICATE (23002)
    4. 落库:
       data 含 createdByUserId = currentUser.id
       捕获 PrismaClientKnownRequestError.code === 'P2002' → 转 23002(并发兜底,决议 M3)
    5. auditPlaceholder('contribution-rule.create', { actorUserId, ruleId, activityTypeCode, attendanceRoleCode, durationThreshold, status })
  返回 toResponseDto(created)
```

### 4.2 update 完整流程

```
async update(id: string, dto: UpdateContributionRuleDto, currentUser: CurrentUser): Promise<ContributionRuleResponseDto>
  在 prisma.$transaction 内:
    1. existing = tx.contributionRule.findFirst({ where: notDeletedWhere({ id }) })
       不存在 → CONTRIBUTION_RULE_NOT_FOUND (23001)
    2. 字段语义校验(B4):
       merged.pointsBelow = dto.pointsBelow ?? existing.pointsBelow
       merged.pointsAbove = (dto.pointsAbove === undefined) ? existing.pointsAbove : dto.pointsAbove
       merged.pointsAbove !== null:
         - existing.durationThreshold === null → CONTRIBUTION_RULE_POINTS_INVALID (23010)
         - merged.pointsAbove <= merged.pointsBelow → 23010
    3. ACTIVE 唯一性兜底(决议 B2):
       仅当 (dto.status === 'ACTIVE') OR (dto.status === undefined && existing.status === 'ACTIVE') 时执行
       即"更新后状态为 ACTIVE"才查重
       count = tx.contributionRule.count({
         where: {
           activityTypeCode: existing.activityTypeCode,
           attendanceRoleCode: existing.attendanceRoleCode,
           durationThreshold: existing.durationThreshold,
           status: 'ACTIVE',
           deletedAt: null,
           NOT: { id },  // 排除自身
         }
       })
       count >= 1 → CONTRIBUTION_RULE_ACTIVE_DUPLICATE (23002)
    4. update:
       data 含 updatedByUserId = currentUser.id
       捕获 P2002 → 转 23002
    5. auditPlaceholder('contribution-rule.update', { actorUserId, ruleId, changedFields: keys(dto) })
  返回 toResponseDto(updated)
```

**关键**:
- update 不动 `activityTypeCode` / `attendanceRoleCode` / `durationThreshold`(决议 B3 + E8;DTO 白名单已挡)
- `status` ACTIVE → INACTIVE 不查重(关闭即释放唯一性约束)
- `status` INACTIVE → ACTIVE 必须查重(可能撞既有 ACTIVE)
- 仅传 `pointsBelow` / `pointsAbove` / `dailyCap` / `remark` 不查重(维度不变,本身是当前 ACTIVE 命中,自身被 `NOT: { id }` 排除)

### 4.3 softDelete 完整流程

```
async softDelete(id: string, currentUser: CurrentUser): Promise<void>
  在 prisma.$transaction 内:
    1. existing = tx.contributionRule.findFirst({ where: notDeletedWhere({ id }) })
       不存在 → CONTRIBUTION_RULE_NOT_FOUND (23001)
    2. update:
       data: {
         deletedAt: new Date(),
         deletedByUserId: currentUser.id,   // schema 已在 batch 4-A 包含该字段
       }
       status 字段不动(决议 E5)
    3. auditPlaceholder('contribution-rule.delete', { actorUserId, ruleId })
```

**Schema 字段来源对照**(避免与 AttendanceRecord 软删字段集混淆):

| 模型 | 软删字段集 | 5-A 是否复用 |
|---|---|---|
| `ContributionRule`(batch 4-A) | `deletedAt`(DateTime?)+ `deletedByUserId`(String?,FK User)| ✅ 5-A 写入 |
| `AttendanceRecord`(batch 3B) | 软删字段集与 `ContributionRule` **不同**;5-A 不读 / 不写 / 不抽公共工具 | ❌ |
| `AttendanceSheet`(batch 3B / 4-A) | 沿其自身既有字段集 | ❌ |

**5-A 不抽公共软删 helper**;沿 batch 2 certificates / batch 3 attendances 既有"每模块独立 softDelete 写入"范式。

**不抛**:删除最后一条 / 历史 attendance 引用 → 沿 batch 4-B `22048` 不抛错路径,删除规则后该维度无匹配预填,落 null;不开"最后一条保护"。

### 4.4 list / findOne

```
async list(query: ContributionRuleQueryDto): Promise<PageResultDto<ContributionRuleResponseDto>>
  where = notDeletedWhere({
    ...(query.activityTypeCode && { activityTypeCode: query.activityTypeCode }),
    ...(query.attendanceRoleCode && { attendanceRoleCode: query.attendanceRoleCode }),
    ...(query.status && { status: query.status }),
  })
  skip = (page - 1) * pageSize, take = pageSize
  orderBy = [
    { activityTypeCode: 'asc' },     // 主排序 1(契约保证)
    { attendanceRoleCode: 'asc' },   // 主排序 2(契约保证)
    { durationThreshold: 'asc' },    // 辅助排序;NULL 在前/后由 PG 默认行为决定,**不作契约保证**
    { createdAt: 'asc' },            // 兜底稳定排序(契约保证)
  ]
  prisma.contributionRule.findMany + count 并行
  返回 PageResultDto
  不 hook audit(决议 E6)

async findOne(id: string): Promise<ContributionRuleResponseDto>
  rule = findFirst({ where: notDeletedWhere({ id }) })
  不存在 → CONTRIBUTION_RULE_NOT_FOUND (23001)
  不 hook audit(决议 E6)
```

**排序契约范围**(v1.1 修订):

- **契约保证**:`(activityTypeCode ASC, attendanceRoleCode ASC, ...内部稳定, createdAt ASC)` 同 `activityTypeCode + attendanceRoleCode` 维度下分页稳定
- **辅助排序,不作契约保证**:`durationThreshold` 内 NULL 与非 NULL 的相对位置(PG 默认 `NULLS LAST` 用 ASC,但本稿**不锁定**该行为为对外契约)
- e2e 重点断言**分页、过滤、软删不可见、基础稳定排序(`activityTypeCode + attendanceRoleCode` 维度内不跳序)**;**不**断言 `durationThreshold = NULL` 的具体顺位(详见 §7.1 list-1)

### 4.5 唯一性兜底语义(决议 B2 锁定)

| 场景 | DB partial unique 兜底 | service `count` 兜底 |
|---|---|---|
| `durationThreshold = 1.0` 多条 ACTIVE | ✅ P2002 | ✅ 23002(优先路径) |
| `durationThreshold = NULL` 多条 ACTIVE | ❌(PG NULL 行为) | ✅ **23002(唯一兜底来源)** |
| 软删后 `(typeCode, roleCode, threshold)` 再插一条 ACTIVE | ✅ 允许(WHERE deletedAt IS NULL 过滤) | ✅ count = 0,允许 |
| INACTIVE 重复 | ✅ 允许(WHERE status='ACTIVE' 过滤) | ✅ count = 0,允许 |

**所有 P2002 兜底场景都先经 service count,顺序保证 23002 优先,P2002 仅在并发 race 兜底**。

### 4.6 字典校验复用

复用 batch 3 `src/modules/activities/activities.service.ts:310` 范式:

- 字典常量 `DICT_TYPE_ACTIVITY_TYPE = 'activity_type'` / `DICT_TYPE_ATTENDANCE_ROLE = 'attendance_role'` 在 service 内部 const 化(沿 attendance / activity 范式)
- 字典查询走 `DictionariesService` 既有 active 校验方法
- 不新建公共校验工具(沿 v1 §2 不跨模块公共目录)

### 4.7 auditPlaceholder hook(决议 E6 锁定)

新增 `AuditEvent` union 项(`src/common/audit/audit-placeholder.ts`):

```
// batch 5-A 新增 3 项(沿 batch 2 / batch 3 写操作 hook 范式):
//   contribution-rule.create  实装
//   contribution-rule.update  实装
//   contribution-rule.delete  实装
// list / findOne 不 hook(规则是配置数据,非个人敏感信息)
| 'contribution-rule.create'
| 'contribution-rule.update'
| 'contribution-rule.delete'
```

context 字段约定:

| 事件 | context 字段 |
|---|---|
| `contribution-rule.create` | `actorUserId` / `ruleId` / `activityTypeCode` / `attendanceRoleCode` / `durationThreshold` / `status` |
| `contribution-rule.update` | `actorUserId` / `ruleId` / `changedFields: string[]` |
| `contribution-rule.delete` | `actorUserId` / `ruleId` |

`auditPlaceholder` 实现仍是 pino log,**不落 `audit_logs` 表**(决议 E6 + F7)。

---

## 5. BizCode 锁定(`230xx` 段位,紧凑版)

`src/common/exceptions/biz-code.constant.ts` 新增段位(沿 baseline §1.3 段位内部细分约定):

| BizCode | code | message | httpStatus | 触发场景 |
|---|---|---|---|---|
| `CONTRIBUTION_RULE_NOT_FOUND` | **23001** | 贡献值规则不存在 | 404 | GET `:id` / PATCH `:id` / DELETE `:id` 不存在(含软删) |
| `CONTRIBUTION_RULE_ACTIVE_DUPLICATE` | **23002** | 该维度已存在生效中的规则 | 409 | service count ≥ 1;Prisma P2002 兜底 |
| `CONTRIBUTION_RULE_POINTS_INVALID` | **23010** | 分值字段组合非法 | 400 | `pointsAbove != null && durationThreshold == null` 或 `pointsAbove <= pointsBelow` |
| `CONTRIBUTION_RULE_ACTIVITY_TYPE_INVALID` | **23011** | 活动类型字典 code 不存在或已停用 | 400 | dict 校验失败 |
| `CONTRIBUTION_RULE_ROLE_CODE_INVALID` | **23012** | 考勤角色字典 code 不存在或已停用 | 400 | dict 校验失败 |

**子段使用说明**(baseline §1.3 对齐):

- `23001` 资源不存在(`XX001` 子段)
- `23002` 唯一约束冲突(`XX002~XX009` 子段第一码;5-A 仅 1 码)
- `23010` / `23011` / `23012` 业务级输入校验(`XX010~XX029` 子段;**紧凑使用,沿 v1.1 修订**)
- `23030~23099` 资源状态非法 / 引用约束 — 5-A **不开任何码**(决议 E8 不开 23030)
- `231xx` 权限 / 操作 / 完整性 — 5-A **不开任何码**(权限走通用 `40300`,沿 baseline)

**不开的码(本批次明确不开)**:

- `23004~23009`:无单字段唯一约束,不开
- `23030 CONTRIBUTION_RULE_KEY_FIELDS_NOT_EDITABLE`:决议 E8,PATCH 禁改字段交给 ValidationPipe
- `23101~23104 FORBIDDEN_*`:沿 baseline,权限不足走通用 `40300`
- `23102 CANNOT_OPERATE_SELF`:规则非用户,不适用
- `23103 LAST_RULE_PROTECTED`:无最后一条规则保护需求(沿 batch 4-B `22048` 不抛错路径)

---

## 6. 权限矩阵(锁定)

| 角色 | GET list | GET :id | POST | PATCH | DELETE |
|---|---|---|---|---|---|
| 未登录 | 401 (`40100`) | 401 | 401 | 401 | 401 |
| `USER` | 403 (`40300`) | 403 | 403 | 403 | 403 |
| `ADMIN` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `SUPER_ADMIN` | ✅ | ✅ | ✅ | ✅ | ✅ |

- Guard 层 `@Roles(Role.SUPER_ADMIN, Role.ADMIN)` 统一(决议 E4)
- service 层**不再加** `assertCanManageContributionRule`(沿 batch 2 certificates / batch 3 activities 范式;5-B 引入新角色时再补)
- USER 越权 → 通用 `40300`,**不走 404**(规则是配置数据非个人数据,无 `§1.7 USER 越权 → 404` 风格)

---

## 7. e2e 覆盖矩阵(锁定)

### 7.1 contribution-rules e2e 覆盖矩阵(新建 `test/e2e/contribution-rules.e2e-spec.ts`)

| 用例 | 覆盖目标 | 期望 |
|---|---|---|
| **list-1** | list 默认分页 + 基础稳定排序 | 200 + items 按 `activityTypeCode ASC` / `attendanceRoleCode ASC` 主排序;**同维度内**不跳序、不漏页;**不**断言 `durationThreshold = NULL` 与非 NULL 的相对顺位(v1.1 修订)|
| **list-2** | list 过滤 `activityTypeCode` 命中 | 200 + items 全部命中 |
| **list-3** | list 过滤 `attendanceRoleCode` 命中 | 200 |
| **list-4** | list 过滤 `status='INACTIVE'` 命中 | 200 |
| **list-5** | list 不暴露 `deletedAt` / 软删数据不可见 | 200 + 软删条不在 items |
| **list-6** | list pageSize 上限 100 | pageSize=200 → 400 (ValidationPipe) |
| **list-7**(新增辅助)| list 分页边界:第二页接续第一页(同维度内无跳序) | 200 + 拼接两页后排序仍然单调 |
| **detail-1** | detail 命中 | 200 |
| **detail-2** | detail 不存在 | 404 + `23001` |
| **detail-3** | detail 已软删 | 404 + `23001` |
| **create-1** | create 全字段 | 201 + 响应包含 createdByUserId |
| **create-2** | create 仅必填字段(durationThreshold / pointsAbove / dailyCap / status / remark 全 omit)| 201 + dailyCap / pointsAbove / durationThreshold null,status='ACTIVE' |
| **create-3** | create 显式 `durationThreshold: null`(无档位规则)| 201 + durationThreshold null |
| **create-4** | create 显式 `pointsAbove: null`(无超档位分值)| 201 |
| **create-5** | create 同维度第二条 ACTIVE → `23002` | 409 + `23002` |
| **create-6** | create **`durationThreshold = NULL` 多条 ACTIVE → `23002`**(P1-3 核心覆盖) | 409 + `23002` |
| **create-7** | create 同维度 INACTIVE 重复 → 允许 | 201(不命中唯一性) |
| **create-8** | create 同维度 ACTIVE 已软删 → 允许 | 201(deletedAt 过滤) |
| **create-9** | create `activityTypeCode` 不存在 → `23011` | 400 + `23011` |
| **create-10** | create `activityTypeCode` 已停用 → `23011` | 400 + `23011` |
| **create-11** | create `attendanceRoleCode` 不存在 → `23012` | 400 + `23012` |
| **create-12** | create `attendanceRoleCode` 已停用 → `23012` | 400 + `23012` |
| **create-13** | create `pointsAbove != null && durationThreshold == null` → `23010` | 400 + `23010` |
| **create-14** | create `pointsAbove <= pointsBelow` → `23010` | 400 + `23010` |
| **create-15** | create `pointsAbove === pointsBelow` 边界 → `23010`(严格 `>`,B4) | 400 + `23010` |
| **create-16** | create `pointsBelow < 0` → ValidationPipe 400 (40000) | 400 |
| **create-17** | create `durationThreshold = 0` → ValidationPipe 400 | 400 |
| **update-1** | update 改 pointsBelow | 200 + updatedByUserId 命中 |
| **update-2** | update 改 status ACTIVE → INACTIVE | 200(不查重) |
| **update-3** | update 改 status INACTIVE → ACTIVE,无冲突 | 200 |
| **update-4** | update 改 status INACTIVE → ACTIVE,撞既有 ACTIVE → `23002` | 409 + `23002` |
| **update-5** | update 显式 `pointsAbove: null` | 200 + pointsAbove null |
| **update-6** | update 同维度规则,改 pointsBelow 但 pointsAbove 派生不一致 → `23010` | 400 + `23010` |
| **update-7** | update 传 `activityTypeCode` → ValidationPipe 400(决议 E8) | 400 + 40000 |
| **update-8** | update 传 `attendanceRoleCode` → 400 + 40000 | 400 |
| **update-9** | update 传 `durationThreshold` → 400 + 40000 | 400 |
| **update-10** | update 不存在 | 404 + `23001` |
| **delete-1** | softDelete 命中 → 204;之后 GET 404;**且 schema 已含 `deletedByUserId`** | 204 + 后续 404 |
| **delete-2** | softDelete 已软删 → `23001` | 404 + `23001` |
| **delete-3** | softDelete 不存在 | 404 + `23001` |
| **delete-4** | softDelete 后,attendance submit 该维度 → 预填走 `22048` 不抛错路径(contributionPoints null) | 跨模块回归 |
| **perm-1** | USER 调用 list / detail / POST / PATCH / DELETE | 全部 403 + `40300` |
| **perm-2** | 未登录 | 全部 401 + `40100` |
| **audit-1**(可选)| create / update / delete 触发 auditPlaceholder log(覆盖 hook 存在性,可不强测 log 内容)| 沿 batch 2 / 3 e2e audit 测法 |

**预估用例数**:~40-45 条。

**e2e 排序断言策略(v1.1 修订要点)**:

- ✅ 断言主排序键 `activityTypeCode` / `attendanceRoleCode` 单调
- ✅ 断言软删条目不可见
- ✅ 断言分页(`page=1 / 2`)拼接稳定
- ❌ **不**断言 `durationThreshold = NULL` 与非 NULL 谁在前谁在后
- ❌ **不**写硬契约依赖 `NULLS LAST` / `NULLS FIRST`(避免 PG 升级或 orderBy 调整时 e2e 误退化)

### 7.2 attendance e2e 补测(决议 M5)

`test/e2e/attendances.e2e-spec.ts` 补 **1 条 + 对照 1 条**:

| 用例 | 覆盖目标 | 期望 |
|---|---|---|
| **attendance-null-1** | POST attendance-sheet `record.contributionPoints = null` 显式入参 + 命中规则 → service **跳过预填**,落库 null | 201 + `record.contributionPoints === null` |
| **attendance-null-2**(对照)| POST attendance-sheet `record.contributionPoints` omit + 命中规则 → 预填生效 | 201 + `record.contributionPoints === rule.pointsBelow` |

`attendance-null-2` 若 `test/e2e/attendances.e2e-spec.ts:1767` 附近已有等价用例,**复核确认即可**,**不重复添加**;若已有用例覆盖"未命中规则保持 null",该对照 sub-case 单独补。

### 7.3 跨模块回归(零退化铁律)

- v0.5.0 + PR #22 既有 **617 e2e**(616 + PR #22 +1)全部继续通过
- contract snapshot v1 14 + V2 72 接口 schema + paths 零漂移
- batch 4-B `applyContributionRulePrefill` 行为不退化(`NULL durationThreshold ASC 取首条` 退化为"唯一一条"是正向收紧,不算漂移)

### 7.4 数字预估

| 维度 | v0.5.0 + PR #22 | 5-A 后 |
|---|---|---|
| `pnpm test:e2e` | 617 / 30 suites | **~660-665 / 31 suites** |
| `pnpm test`(unit) | 532 | **~545-555** |
| `pnpm test:contract` | 158 + 2 snapshots | **~163 + 2 snapshots**(snapshot 数不变,新增 paths/schemas 在既有 snapshot 内) |

---

## 8. Contract Snapshot 预期变化(锁定)

### 8.1 新增 schemas

- `CreateContributionRuleDto`
- `UpdateContributionRuleDto`
- `ContributionRuleResponseDto`
- `ContributionRuleQueryDto`(沿 batch 3 `AttendanceSheetQueryDto` 范式是否进 schemas — 评审实施时对照锁定,沿现有惯例)

### 8.2 新增 paths

- `GET /api/v2/contribution-rules`
- `GET /api/v2/contribution-rules/{id}`
- `POST /api/v2/contribution-rules`
- `PATCH /api/v2/contribution-rules/{id}`
- `DELETE /api/v2/contribution-rules/{id}`

### 8.3 既有 schemas / paths 漂移

- **零漂移**(F10);PR #22 已收紧的 `statusCode` enum / `contributionPoints` nullable 不再动

### 8.4 累计

| 维度 | 当前 | 5-A 后 |
|---|---|---|
| v1 接口 | 14 | 14(零漂移) |
| V2 接口 | 72 | **77**(+5) |
| 累计接口 | 86 | **91** |

---

## 9. 与既有铁律的对照检查

| 铁律来源 | 检查项 | 5-A 状态 |
|---|---|---|
| **v1 §1** | 不引入 Redis / 队列 / refresh token / RBAC / 文件上传 / LLM | ✅ |
| **v1 §2** | **业务模块主体 4 文件铁律** + 不跨模块公共目录 + 不建 `*.entity.ts` | ✅ `src/modules/contribution-rules/` 主体 4 文件 |
| **v1 §8 / §11** | 集中安全字段 select 辅助文件(沿 `users.select.ts` 范式)| ✅ `contribution-rules.select.ts`(决议 E2;与 v1 §2 4 文件铁律**不冲突**,沿既有 `userSafeSelect` 机制) |
| **v1 §3** | 命名(`createdAt` / `cuid()` / Role/UserStatus 从 @prisma/client 导入)| ✅ |
| **v1 §4** | 统一响应包装 + 分页 `PaginationQueryDto` / `PageResultDto` | ✅ |
| **v1 §5** | `BizException` 三字段 + 集中维护 + P2002 数组 target | ✅ §5 BizCode 锁定 |
| **v1 §6** | Swagger 100%(`@ApiOperation` / `@ApiProperty` / `@ApiBearerAuth` / `@ApiWrappedPageResponse` 等)| ✅ §3.1 |
| **v1 §7** | 全局 ValidationPipe + 不重复局部配置 | ✅ |
| **v1 §8** | Guard 全局注册;`@Roles` 在 controller 方法标注 | ✅ §6 |
| **v1 §10** | 软删走 `deletedAt`;`notDeletedWhere` 过滤;**不开恢复接口**;`findById` 软删返 NOT_FOUND | ✅ §4 |
| **v1 §11** | DTO 与 Prisma 类型严格分离;`*.select.ts` 集中字段;DTO 白名单第一道防线 | ✅ §3.2 / §3.3 |
| **v1 §12** | `prisma.$transaction` 用于多写 / 先检查再写入 / 维护不变式 | ✅ §4.1 / §4.2 / §4.3 |
| **V1.1 §17** | 不引入 Redis 限流 / refresh / APM / Tracing / metrics | ✅ |
| **V2 §18** | 调研期约束;D6 评审稿是开发解除的前置 | ✅ 本稿即 D6 v1.1 |
| **baseline 13 项 A 档** | 段位 / 命名 / 响应 / DTO 白名单 / 模块结构 / 错误码 / 配置归属 / 日志屏蔽 / Guard / 软删除 / v1 兼容 / 时区 / 验收门槛 | ✅ 全部覆盖 |

---

## 10. 风险与回滚策略

### 10.1 风险盘点(评审收口后版本)

| 风险 | 等级 | 缓解 |
|---|---|---|
| **R1** create / update 唯一性 service 兜底与 DB partial unique race | 低 | service count 先于 P2002;并发场景 P2002 转 23002 兜底;运营手动场景并发概率极低 |
| **R2** Decimal → Number 序列化精度丢失 | 低 | Decimal(5,2) 最大 999.99,Number 精度足够;沿 batch 3 attendance `serviceHours` / batch 4-A `pointsBelow` 既有范式 |
| **R3** Update 字段语义校验路径分支多(pointsBelow 单改 / pointsAbove 单改 / status 单改 / 组合改) | 中 | §4.2 显式 merged 计算 + e2e 矩阵覆盖(update-1 ~ update-9) |
| **R4** Audit 事件 union 新增 3 项与 `auditPlaceholder` 现有调用方零冲突 | 低 | 仅 union 扩展,既有调用方不动 |
| **R5** Batch 4-B `applyContributionRulePrefill` 行为意外漂移 | 低 | 不动 attendance 模块代码;e2e §7.3 强保零退化 |
| **R6** PATCH 入参漏白名单(如新加字段忘了加 `@IsOptional`) | 低 | DTO 白名单 + 全局 `forbidNonWhitelisted` 双重防护;e2e update-7/8/9 覆盖 |
| **R7** Decimal 入参精度问题(`@IsNumber({ maxDecimalPlaces: 2 })`) | 低 | class-validator 既有装饰器,沿 batch 4-A `pointsBelow` 范式 |
| **R8** `status` ACTIVE → INACTIVE → 再 ACTIVE 的"状态翻转"场景下唯一性兜底 | 低 | §4.2 update 流程明确"更新后状态为 ACTIVE 才查重";e2e update-2 / update-3 / update-4 覆盖 |
| **R9** `softDelete` 误用 `AttendanceRecord` 软删字段集(类型相近导致复制错位)| 低 | **v1.1 §4.3 schema 字段来源对照表显式锁定**;5-A 不抽公共 helper;沿"每模块独立 softDelete 写入"范式 |
| **R10** e2e 误把 `durationThreshold NULL` 排序当硬契约 | 低 | **v1.1 §4.4 / §7.1 list-1 显式不断言**;PG 升级或 orderBy 调整时 e2e 不退化 |

### 10.2 回滚策略

| 触发 | 回滚 |
|---|---|
| 5-A PR merge 后 e2e flaky | revert merge commit;**0 schema 影响** |
| 5-A 上线后规则维护引入非预期重复 | service + DB partial unique 双兜底;最坏 attendance 预填走 null,APD 现场填入 |
| 字段语义校验过严导致运营录入卡壳 | 沿 v0.6.x 微调 BizCode 23010 字段语义,不动 schema |
| auditPlaceholder hook 引入运行时异常 | hook 是同步 pino log,异常概率极低;如果出问题,union 移除 3 项 + 业务代码删 3 行 hook 调用 |

**回滚成本**:0 migration → 纯代码 revert → 0 数据迁移代价。

---

## 11. 验收门槛(沿 baseline §14)

### 11.1 A 档(每 PR 必跑)

1. `pnpm lint`(0 warnings,`--max-warnings 0`)
2. `pnpm typecheck`(`src/` + `test/` 双 tsconfig)
3. `pnpm test`(unit ~545-555)
4. `pnpm test:e2e`(~660-665 / 31 suites)
5. `pnpm test:contract`(~163 + 2 snapshots;**snapshot 必须主动更新**)
6. `pnpm build`(dist/ 生成)
7. v1 14 + V2 72 既有接口 schema + paths 零漂移
8. 决议表 33 项(B1-B8 / E1-E8 / M1-M7 / F1-F10)逐项满足

### 11.2 B 档(本批次涉及 HTTP 行为 / Controller / Swagger,追加)

启动服务,逐项确认:

- `/api/docs` 能正常打开,Swagger UI 完整可用
- `GET /api/health` 仍按 v1 契约返回(向后兼容)
- 5 个 ContributionRule 接口在 Swagger UI 可见 + 标 🔒(`@ApiBearerAuth`)
- 5 个接口典型成功路径与典型错误路径(404 / 409 / 400 / 403)在 Swagger UI 试调通过

### 11.3 验收清单(D6 评审稿生效后,实施 PR 自检)

- [ ] **模块主体 4 文件**(`contribution-rules.module.ts` / `.controller.ts` / `.service.ts` / `.dto.ts`)+ **1 个安全字段 select 辅助文件**(`contribution-rules.select.ts`);**模块共 5 个文件**(v1.1 修订,统一表述)
- [ ] `contribution-rules.select.ts` 集中维护对外字段(不含 `deletedAt` / `deletedByUserId`)
- [ ] DTO 白名单 5 个 PATCH 字段;不含 `activityTypeCode` / `attendanceRoleCode` / `durationThreshold`
- [ ] Service 4 个写路径全部走 `prisma.$transaction`
- [ ] `softDelete` 写 `deletedAt + deletedByUserId`(schema 已含,沿 batch 4-A;**不复用 AttendanceRecord 软删字段集**)
- [ ] `notDeletedWhere` 在所有 find / count 中
- [ ] BizCode `230xx` 段 **5 个码:23001 / 23002 / 23010 / 23011 / 23012**(v1.1 紧凑版);**不开** `23030` / `23101+`
- [ ] `AuditEvent` union 新增 3 项;hook 3 个写操作;list / detail 不 hook
- [ ] e2e 矩阵 ~40 条 + attendance 补测 1-2 条;**不断言** `durationThreshold = NULL` 排序顺位
- [ ] OpenAPI snapshot 含新增 5 paths + 4 schemas;既有零漂移
- [ ] Swagger 100% 覆盖(`@ApiOperation` / `@ApiProperty` / `@ApiBearerAuth` / `@ApiExtraModels`)
- [ ] `@ApiWrappedPageResponse(ContributionRuleResponseDto)` 用于 list
- [ ] `prisma/schema.prisma` 未改;`prisma/migrations/` 未新增
- [ ] `package.json` 未新增依赖

---

## 12. 落地节奏(PR 拆分,沿 v0.3/v0.4/v0.5 范式)

| PR | 类型 | 主题 | 内容 |
|---|---|---|---|
| **PR #1** | `feat` | `feat(contribution-rules): add v2 batch5-A contribution rule CRUD` | 新模块 5 文件(主体 4 + select.ts)+ BizCode 230xx 5 个 + `AuditEvent` union +3 + e2e 矩阵 + attendance e2e 补测 + contract snapshot |
| **PR #2** | `docs` | `docs(v2-batch-5a): record contribution rule CRUD landing` | CHANGELOG Unreleased + handoff 增量 + baseline §1.1 v0.5 段位收口(`230xx` 归属 `contribution_rules`) |
| **PR #3** | `chore` | `chore: bump version to 0.6.0` | `package.json#version` 0.5.0 → 0.6.0 + `src/bootstrap/apply-swagger.ts:20` `setVersion('0.5.0' → '0.6.0')` |

**版本与 tag**:PR #3 merge 后,维护者手动打 `v0.6.0` tag + GitHub Release(沿 v0.5.0 节奏;AI 不擅自 tag / release)。

**PR 拆分铁律**(决议 M7):
- 实现 PR 不混 docs;docs PR 不混代码;version PR 不混 docs
- PR #1 内可含必要的 CHANGELOG `Unreleased` 段最小条目(沿 batch 4-B PR 范式),完整 docs 收口仍走 PR #2

---

## 13. 与 batch 4-B 的衔接(对照表)

| 维度 | batch 4-B(v0.4.0 / v0.5.0)| batch 5-A(v0.6.0)|
|---|---|---|
| ContributionRule schema | batch 4-A 落地(`2190803`)| **不动** |
| Partial unique | batch 4-A 落地(`contribution_rules_active_unique`)| **不动** |
| 审计字段(`deletedByUserId` 等) | batch 4-A 已包含 | **5-A softDelete 使用,不新增**(v1.1 §4.3 显式说明) |
| `applyContributionRulePrefill` 路径 | `src/modules/attendances/attendances.service.ts:563` 实装 | **不动** |
| `DEFAULT_DAILY_CAP = 1.5` 常量 | `src/modules/attendances/attendances.service.ts:587` | **不动** |
| `NULL durationThreshold ASC 取首条` 兜底 | `src/modules/attendances/attendances.service.ts:619` `TODO(批次 4.x 或后续)` | **保留代码,但语义退化为"唯一一条"**;TODO 注释可在 PR #1 同步移除(由 service 兜底唯一性收紧) |
| `BizCode 22048 CONTRIBUTION_RULE_NOT_FOUND` 不开 | 沿 D-S11,预填命中失败保持 null,不抛错 | **保持不开**(5-A 的 23001 是"按 id 不存在",语义完全不冲突)|
| 三态 `contributionPoints` 入参语义 | PR #22 收紧 + DTO 文档化 | **e2e 补测显式 null 路径**(决议 M5) |
| attendance.recorded 触发点 | final-approve 触发 | **不动**(F9) |
| Attendance 5 态状态机 | 锁定 | **不动**(F8) |

---

## 14. 评审签收

**状态**:**完全通过**(2026-05-12 用户审阅 D6 v1.1 后拍板)。

**归档版本**:本稿即 `docs/批次5-A_贡献值规则CRUD_API前评审.md v1.1`,5-A 进入实施阶段(PR #1 可开工)。

**评审稿不替代实施 PR**;实施 PR 仍需:
- 严格遵循本稿决议(33 项)
- 经维护者代码审查
- 走 baseline §14 A 档(必跑)+ B 档(本批次涉及 HTTP / Controller / Swagger,追加)

---

## 15. 附录:本稿与 D5 立项草案的差异(沿 v1.0)

| 维度 | D5 立项草案(`[当前倾向]`)| D6 v1.1 评审稿(`[已锁定]`)| 差异原因 |
|---|---|---|---|
| `pointsAbove > pointsBelow` 严格性 | `[待确认]` | `>` 严格(B4)| 用户拍板 |
| NULL durationThreshold 兜底 | 倾向"拒绝"(B2 三选项之一)| 拒绝 + 23002 | 用户拍板 |
| PATCH 三元组禁改 | `[当前倾向]` 禁改 | 禁改 + 不开 23030(交给 ValidationPipe)| 用户拍板 + E8 简化 |
| dailyCap fallback | 倾向后端保留 null | 后端 null + 预填仍 1.5 | 用户拍板 |
| 路径 / 模块归属 / 段位 | `[当前倾向]` 平铺 / 独立 / 230xx | 全部锁定 | 用户拍板 E1/E2/E3 |
| audit hook 范围 | `[当前倾向]` 写操作 hook | 锁定 3 个写操作 + list/detail 不 hook | 用户拍板 E6 |
| 用户摘要暴露 | `[当前倾向]` 仅 id | 仅 id | 用户拍板 E7 |
| 23030 是否开 | `[当前倾向]` 开 | **不开**(E8 拍板)| 用户拍板 |
| BizCode 编号选择 | `23001/23002/23010-23012/23030` | **`23001/23002/23010/23011/23012`(v1.1 紧凑版)**| 用户 v1.1 拍板紧凑使用 |
| effectiveFrom/To / 版本号 | `[待确认]` | `[本批次不做]` | 用户拍板 B6 |
| dryRun | `[当前倾向]` 不做 | **`[本批次不做]` + 后续运营强需求可独立评审**(v1.1 修订)| 用户 v1.1 修订 |

---

## 16. 本稿与 D6 v1.0 的修订差异(v1.0 → v1.1)

| # | 修订点 | v1.0 | v1.1 | 影响章节 |
|---|---|---|---|---|
| **R1** | 模块文件数与 4 文件铁律的字面冲突 | 既说"4 文件铁律",又新建 `contribution-rules.select.ts`,字面互斥 | 统一表述为"**主体 4 文件 + 允许 `contribution-rules.select.ts` 作为安全字段 select 辅助文件**";模块共 5 个文件;说明 select.ts 沿 v1 §8 / §11 既有 `userSafeSelect` 范式,不是新业务文件,与 v1 §2 4 文件铁律精神不冲突 | §0 元信息 / §2.2 E2 / §3.3 / §9 / §11.3 |
| **R2** | softDelete 字段来源说明 | 仅写"`deletedAt + deletedByUserId`",未说明 schema 字段来源,潜在与 `AttendanceRecord` 软删字段混淆风险 | §2.2 E5 决议处显式说明"**ContributionRule schema 已在 batch 4-A 包含 `deletedByUserId`**"(`prisma/schema.prisma:673`);§4.3 新增**字段来源对照表**(`ContributionRule` vs `AttendanceRecord` vs `AttendanceSheet`),显式声明"5-A 不复用 / 不抽公共工具";§13 衔接表新增"审计字段"行 | §2.2 E5 / §4.3 / §13 |
| **R3** | BizCode 编号紧凑版 | `23001 / 23002 / 23012 / 23013 / 23014`(留 23010/23011 备选)| **`23001 / 23002 / 23010 / 23011 / 23012`(紧凑使用)**;仍不开 `23030` / `231xx` | §5 BizCode 表 / §7.1 e2e 矩阵(create-9/10/11/12/13/14/15 + update-6 全部更新)/ §10.2 / §11.3 / §15 附录 |
| **R4** | list 排序 e2e 不强断言 NULL 排序 | list-1 期望"按 `(typeCode, roleCode, threshold ASC NULLS LAST?, createdAt)` 排序",`NULLS LAST?` 表述潜在硬契约误读 | §4.4 显式标注"`durationThreshold` 是**辅助排序**,NULL 在前/后由 PG 默认行为决定,**不作契约保证**";§7.1 list-1 期望重写为"主排序 + 同维度内不跳序";**新增 list-7** "分页拼接稳定" 用例;§10.1 新增 **R10** 风险项(防 e2e 误把 NULL 排序当硬契约) | §4.4 / §7.1 list-1 + 新增 list-7 / §10.1 R10 |
| **R5** | dryRun / 批量重算 状态调整 | dryRun = `[永久不做]`;批量重算 = `[永久不做]` | **dryRun**(B7 / F4)= `[本批次不做]` + "后续如运营强需求,作为独立批次评审立项后再做";**批量重算**(F5)= `[本批次不做]` + "默认不做,除非后续独立评审";**contribution_points 流水表**(F6)= **保持** `[永久不做]`(handoff §7.1 / `ARCHITECTURE.md §9` 升级路径锁定);§2.5 新增"v1.1 状态调整说明"解释架构层 vs 接口层差异 | §2.1 B7 / §2.4 F4 / F5 / F6 / §2.5(新增)/ §15 附录 |

**v1.1 修订原则**:本次修订**全部为表述层 / 编号层 / 范围层调整**,**不改动**业务语义、技术架构、e2e 覆盖目标。实施 PR 仍按 v1.1 锁定项执行。

---

**评审通过签收日期**:2026-05-12
**归档版本**:v1.1
**下一步**:5-A 实施 PR(`feat(contribution-rules): add v2 batch5-A contribution rule CRUD`)按本稿决议开工。
