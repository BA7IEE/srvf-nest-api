# SRVF App API P2-6 My Attendance Records Review

> **状态**:**草案 v0.1**(待用户拍板冻结)
> **范围**:Phase 2 P2-6 — `GET /api/app/v1/my/attendance-records` 单 endpoint 实施前评审
> **生效条件**:本评审稿用户拍板冻结后,P2-6 implementation PR 才允许立项
> **冲突优先级**:与 [`CLAUDE.md`](../CLAUDE.md) §1-§18 / [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) / [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) / [Phase 2 顶层评审稿](app-api-phase-2-review.md) / [Phase 0.5](app-permission-boundary-review.md) / [Phase 0.6](data-access-lifecycle-boundary-review.md) / [Phase 0.7](code-architecture-boundary-review.md) 冲突时本评审稿让步
> **下位关系**:本评审稿是 [Phase 2 顶层评审稿 §2 行 105](app-api-phase-2-review.md) `/my/attendance-records` 占位行的具体化;不替代顶层评审稿任何决议
> **依赖前置**:P2-1 已合入(`AppIdentityResolver` exports + canUseApp 准入闭包)
> **预估实施**:主代码 < 300 行 + e2e ~700-900 行;**C 档**

---

## 0. TL;DR(8 条)

1. **唯一 endpoint**:`GET /api/app/v1/my/attendance-records`(沿顶层 §2 行 105)。
2. **复用 `attendances.service.listMyRecords`** 不改签名(沿顶层 §3.3 + P2-5 §6.2 thin-wrap 范式)。
3. **新建 4 个文件**:`AppMyAttendanceRecordsController` + `AppMyAttendanceRecordsService` + `AppMyAttendanceRecordDto` + `ListAppMyAttendanceRecordsQueryDto`。
4. **严禁复用** admin `AttendanceRecordResponseDto`(沿 Phase 0.6 §1.3 + Phase 0.7 §2.2 + P2-5 §8.1)。
5. **字段集恰好 14 项**(沿 §5;`sheetId` / `memberId` / `member` 嵌套 / `registrationId` / `updatedAt` 全部丢;新增 5 个派生 `activity*` 字段;保留 `note` / `contributionPoints`)。
6. **0 新 BizCode / 0 schema / 0 migration / 0 新依赖**(沿顶层 §3.2 + P2-5 D-P2-5-10)。
7. **准入**:JwtAuthGuard(全局)+ `AppIdentityResolver.resolve` + `canUseApp=false` → `FORBIDDEN=40300`;**不**沿 P2-3 admin-without-member 例外。
8. **PR 拆分**:本评审稿独立 docs-only PR(A 档);P2-6 implementation 独立 C 档 PR。

---

## 1. 背景与范围

### 1.1 背景

P2-1 ~ P2-5 已合入(commits `58aac2f` / `5b5d59e` / `6603667` / `b2ab607` / `bf86b09` / `d075bae` / `b1b4a27`),App API 13 endpoint 已落地。P2-6 是 Phase 2 范围内倒数第二个 PR(P2-7 之后是 P2-8 收尾)。

### 1.2 范围

- ✅ 新建 `GET /api/app/v1/my/attendance-records`(App 视角"我的考勤记录"列表);复用 `attendances.service.listMyRecords`(签名 0 diff)
- ✅ 新建 4 物理文件(controller / app service / DTO × 2)+ 1 e2e spec;更新 contract spec 白名单 + snapshot

### 1.3 不在范围

- ❌ 不实现 `GET /api/app/v1/my/attendance-records/:id` 详情(P2-6 仅列表;若产品需要详情走 Phase 2.x 单独立项)
- ❌ 不实现 `GET /api/app/v1/my/attendance-summary`(贡献值聚合;沿 [Phase 0.6 §2.15](data-access-lifecycle-boundary-review.md) "贡献值汇总未实装聚合查询")
- ❌ 不实现"我作为考勤负责人的考勤" `/managed/attendance-sheets`(沿 [Phase 0.5 §4.3](app-permission-boundary-review.md) ⚠️ 不实现 ✅ 预留)
- ❌ 不改任何旧 path(含 `/api/v2/users/me/attendance-records`;沿顶层 §3.2)
- ❌ 不改 `attendances.service.ts` / `attendances.controller.ts` / `attendances.dto.ts` / `prisma/schema.prisma` / migration / BizCode / `users/*` / P2-1~P2-5 已落地文件(沿 §11)

---

## 2. 与 Phase 2 顶层评审稿的关系

### 2.1 引用矩阵

| 顶层段落 | 本评审稿对应 |
|---|---|
| [`phase-2-review.md §2 行 105`](app-api-phase-2-review.md)(P2-6 行) | §4 endpoint 契约具体化 |
| [`phase-2-review.md §2.2 行 128`](app-api-phase-2-review.md)("thin-wrap + 新 Presenter") | §7 物理布局 + §6 mapper |
| [`phase-2-review.md §3.2 / §3.3`](app-api-phase-2-review.md)(Phase 2 不动 schema / 不拆大 service) | §11 禁止修改清单 |
| [`phase-2-review.md §5 行 266`](app-api-phase-2-review.md)(AppMyAttendanceRecordDto = AppSelf, L0 + L1) | §5 字段集 |
| [`phase-2-review.md §6 行 348`](app-api-phase-2-review.md)(准入:JwtAuthGuard + memberId 必填 + Member.status=ACTIVE) | §8 准入规则 |
| [`phase-2-review.md §8.1 行 429`](app-api-phase-2-review.md)(P2-6 C 档 / 依赖 P2-1 / < 300 行) | §14 PR 拆分 |
| [`phase-2-review.md §9 行 608`](app-api-phase-2-review.md)("P2-1 / P2-6 / P2-7 由用户决议是否需独立评审稿") | 本评审稿存在依据 |

### 2.2 引用同步要求

本评审稿任何字段集 / 准入规则 / 路径 / 命名调整,**必须**与顶层评审稿对齐;冲突时**以顶层评审稿为准**,本评审稿让步。

---

## 3. 已锁决策表

| ID | 决策 | 依据 |
|---|---|---|
| **D-P2-6-1** | 唯一 endpoint = `GET /api/app/v1/my/attendance-records`(无详情 / 无写) | 顶层 §2 行 105 + §1.3 不在范围 |
| **D-P2-6-2** | thin-wrap `attendances.service.listMyRecords`,**不**改签名 | 顶层 §3.3 + P2-5 §6.2 范式 |
| **D-P2-6-3** | 新建 4 物理文件(controller / app service / 2 DTO),物理隔离于 `dto/app/` | 顶层 §7 + Phase 0.7 §2.2 |
| **D-P2-6-4** | **严禁**复用 / 继承 / Pick / Omit / IntersectionType / PartialType / OmitType / Mapped Types admin `AttendanceRecordResponseDto` | Phase 0.6 §1.3 + Phase 0.7 §2.2 + P2-5 D-P2-5-6 |
| **D-P2-6-5** | 字段集**恰好 14 项**(详 §5);snapshot 强 freeze | P2-5 §8 字段恰好范式 |
| **D-P2-6-6** | 派生 5 个 `activity*` 字段(`activityId` / `activityTitle` / `activityStartAt` / `activityEndAt` / `activityCoverImageUrl`);沿 §7.4 默认方案(AppMy service 内 2 次 IN 批量查询 sheet + activity);**禁止** N+1;**不**改 `attendances.service.ts` | P2-5 [`app-my-registrations.service.ts:76-80`](../src/modules/activity-registrations/app-my-registrations.service.ts) + §11.1 |
| **D-P2-6-7** | **不返** `sheetId` / `memberId` / `member` 嵌套 / `registrationId` / `updatedAt` | P2-5 §16.B.2 默认锁 + §5 字段表 |
| **D-P2-6-8** | **保留** `note`(本人对自己被备注可见,沿 [Phase 0.6 §2.14 / §2.16](data-access-lifecycle-boundary-review.md))+ `contributionPoints`(本人贡献值完整可见,沿 §2.15) | §5 字段表 |
| **D-P2-6-9** | Query DTO 严格 3 字段(`page` / `pageSize` via `PaginationQueryDto` + 可选 `activityId`);`forbidNonWhitelisted` 兜底 | P2-5 §8.2.4 范式 |
| **D-P2-6-10** | **0 新 BizCode**;canUseApp=false 统一 `FORBIDDEN=40300` | 顶层 §4.3 + P2-5 D-P2-5-10 |
| **D-P2-6-11** | **0 schema / 0 migration / 0 新依赖** | 顶层 §3.2 |
| **D-P2-6-12** | **不**沿 D-P2-3-1 admin-without-member 例外(严格仅 `/me/password` 适用) | P2-5 §7.4 + 顶层 §6.2 |
| **D-P2-6-13** | admin-as-member 走 linked-member self perspective;**禁止** role 短路 / scope=all | [`CLAUDE.md §19.7 D-5.2`](../CLAUDE.md) |
| **D-P2-6-14** | 私有静态 mapper 内嵌薄壳 service(沿 P2-5 P0/P1 过渡;**不**抽独立 Presenter class) | Phase 0.7 §7.2 + P2-5 §6.4 |
| **D-P2-6-15** | 旧 `/api/v2/users/me/attendance-records` 行为**逐字不变**(path stability) | 顶层 §3.2 + §5 line 529 path stability |
| **D-P2-6-16** | 纯只读 endpoint,**不写 audit**(沿批次 6 Q1=A;P2-5a 同范式) | P2-5a 实施未新增 audit |

---

## 4. Endpoint 契约

```
GET /api/app/v1/my/attendance-records?page=1&pageSize=20&activityId=...

Auth:         JwtAuthGuard(全局;无 @Roles,无 @Public)
Throttle:     默认(不专门限流)
Scope:        self(由薄壳 service + 既有 listMyRecords 双层锁定)
Response:     PageResultDto<AppMyAttendanceRecordDto>
Tag:          'Mobile - My Attendance'
```

**响应包装**:沿 `ResponseInterceptor` 三层 `{ code: 0, message: 'ok', data: { items, total, page, pageSize } }`(沿 [`CLAUDE.md §4`](../CLAUDE.md))。

**排序**:`orderBy: { checkInAt: 'desc' }`(沿既有 `listMyRecords` [line 1399](../src/modules/attendances/attendances.service.ts);本评审稿**不改**)。

**过滤铁律**:沿既有 service 现状,**只返**:
- `Sheet.statusCode = 'approved'`(终审通过)
- `Sheet.deletedAt IS NULL`
- `Record.memberId = currentUser.memberId`
- `Record.deletedAt IS NULL`

---

## 5. `AppMyAttendanceRecordDto` 字段集(D-P2-6-5 + D-P2-6-7 + D-P2-6-8)

### 5.1 字段表(恰好 14 项)

| # | 字段 | 类型 | 等级 | 来源 | 决议 |
|---|---|---|---|---|---|
| 1 | `id` | `string` | L0 | `AttendanceRecord.id` | ✅ 保留(主键) |
| 2 | `activityId` | `string` | L0 | **派生** join `Sheet.activityId` | ✅ **新增**(替代 sheetId 给前端跳转) |
| 3 | `activityTitle` | `string` | L0 | **派生** join `Activity.title` | ✅ **新增**(列表 UX) |
| 4 | `activityStartAt` | `Date` | L0 | **派生** join `Activity.startAt` | ✅ **新增**(列表 UX) |
| 5 | `activityEndAt` | `Date` | L0 | **派生** join `Activity.endAt` | ✅ **新增**(列表 UX) |
| 6 | `activityCoverImageUrl` | `string \| null` | L0 | **派生** join `Activity.coverImageUrl` | ✅ **新增**(列表 UX) |
| 7 | `roleCode` | `string` | L0 | `AttendanceRecord.roleCode` | ✅ 保留(字典 `attendance_role`) |
| 8 | `checkInAt` | `Date` | L0 | `AttendanceRecord.checkInAt` | ✅ 保留 |
| 9 | `checkOutAt` | `Date` | L0 | `AttendanceRecord.checkOutAt` | ✅ 保留 |
| 10 | `serviceHours` | `string` | L0 | `AttendanceRecord.serviceHours.toString()`(Decimal → string) | ✅ 保留 |
| 11 | `attendanceStatusCode` | `string` | L0 | `AttendanceRecord.attendanceStatusCode` | ✅ 保留(字典 `attendance_status`) |
| 12 | `note` | `string \| null` | L1(对本人) | `AttendanceRecord.note` | ✅ 保留(D-P2-6-8;本人对自己被备注可见) |
| 13 | `contributionPoints` | `string \| null` | L0(对本人) | `AttendanceRecord.contributionPoints?.toString() ?? null` | ✅ 保留(D-P2-6-8;本人贡献值完整可见) |
| 14 | `createdAt` | `Date` | L0 | `AttendanceRecord.createdAt` | ✅ 保留(排序参考) |

### 5.2 字段丢弃列表(D-P2-6-7;snapshot 触发即拒合并)

| 字段 | 丢弃理由 |
|---|---|
| `sheetId` | App 不暴露 sheet 内部结构;前端跳转用 `activityId`(D-P2-6-6 派生) |
| `memberId` | 本人已知 via `/me/account.linkedMemberId`(沿 P2-5 §16.B.2 默认锁) |
| `member` 嵌套(`{id, memberNo, displayName}`) | AppSelf scope 下所有 record 都属 currentUser,嵌套冗余;`memberNo` 是 L1 本人侧不必反复返(本人已知) |
| `registrationId` | 内部跨表关联键;App 无业务用途 |
| `updatedAt` | admin housekeeping(沿 P2-5 §16.B.2 默认锁) |

### 5.3 绝对禁止返回(snapshot 触发即拒合并)

- ❌ `passwordHash` / `refreshToken` / `tokenHash` / `accessToken`(L3 Credential)
- ❌ `member.mobile` / `member.documentNumber` / `member.medicalNotes` / `member.bloodTypeCode`(L2;admin 也未在本接口返)
- ❌ 任何 Sheet 级 admin 字段(`submitterUserId` / `reviewerUserId` / `reviewNote` / `finalReviewerUserId` / `finalReviewNote` / `previousSnapshot` / `version`)
- ❌ 任何 audit context(`requestId` / `ip` / `ua`)

### 5.4 物理文件

- `src/modules/attendances/dto/app/app-my-attendance-record.dto.ts`(**独立 class**;**不** `extends` / Pick / Omit 任何 admin DTO);每字段 `@ApiProperty({ description })` 或 `@ApiPropertyOptional({ nullable: true })`;出参 DTO 不需 `class-validator`(沿 [`UserResponseDto`](../src/modules/users/dto/user-response.dto.ts) 范式)

---

## 6. `ListAppMyAttendanceRecordsQueryDto` 字段集(D-P2-6-9)

### 6.1 字段表(恰好 3 项)

| # | 字段 | 类型 | 校验 | 来源 |
|---|---|---|---|---|
| 1 | `page` | `number` | `IsInt + Min(1)` | `extends PaginationQueryDto`(跨模块公共 DTO,**唯一允许 extends**) |
| 2 | `pageSize` | `number` | `IsInt + Min(1) + Max(100)` | 同上 |
| 3 | `activityId` | `string?`(可选) | `IsOptional + IsString + MaxLength(64)` | 本 DTO 自定义 |

### 6.2 严禁字段

`forbidNonWhitelisted: true` 兜底;**禁止**:
- `memberId`(本人查本人,后端从 currentUser.id 推导)
- `userId` / `sheetId` / `registrationId`(admin housekeeping)
- `statusCode`(沿既有 `listMyRecords` 现状:只返 approved sheet 内 records,无需 sheet status filter;若要 record 级 attendanceStatusCode filter,留 Phase 2.x 单独立项)
- `roleCode` / `dateFrom` / `dateTo` / `sortBy`(Phase 2.x)

### 6.3 物理文件

- `src/modules/attendances/dto/app/list-app-my-attendance-records-query.dto.ts`
- `extends PaginationQueryDto`(沿 [P2-5 query DTO](../src/modules/activity-registrations/dto/app/list-app-my-registrations-query.dto.ts) 范式;`PaginationQueryDto` 来自 `common/dto/pagination.dto.ts` 跨模块公共,非 admin 模块 DTO,不违反 D-P2-6-4 铁律)

---

## 7. Controller / Service / Module 物理布局

### 7.1 文件清单(D-P2-6-3 + D-P2-6-14)

| 层 | 物理路径 | 职责 | 预估行数 |
|---|---|---|---|
| Mobile Controller | `src/modules/attendances/controllers/app-my-attendance-records.controller.ts` | thin;`@CurrentUser()` + `@Query()` → 委派 service | ~55 |
| App Service(薄壳) | `src/modules/attendances/app-my-attendance-records.service.ts` | 1) `assertCanUseAppOrThrow` 2) thin-wrap `AttendancesService.listMyRecords`(签名 0 diff) 3) AppMy service 内 IN 批量查 `AttendanceSheet` + `Activity`(沿 P2-5a 范式;不动 `attendances.service.ts`) 4) 私有静态 mapper | ~135 |
| 输出 DTO | `src/modules/attendances/dto/app/app-my-attendance-record.dto.ts` | 字段集 14 项(§5) | ~75 |
| Query DTO | `src/modules/attendances/dto/app/list-app-my-attendance-records-query.dto.ts` | 字段 3 项(§6) | ~25 |
| Module | `src/modules/attendances/attendances.module.ts`(**修改**) | imports +`UsersModule` / controllers +`AppMyAttendanceRecordsController` / providers +`AppMyAttendanceRecordsService` | +5 行 diff |

### 7.2 Controller 顶层标记

```ts
@ApiTags('Mobile - My Attendance')
@ApiBearerAuth()
@Controller('app/v1/my')
export class AppMyAttendanceRecordsController { ... }
```

- **不**挂 `@Roles`(沿 P2-2 / P2-3 / P2-4 / P2-5 范式;App 不用 Role 短路)
- **不**挂 `@Public`(全部要登录)
- **不**挂限流装饰器(default throttler)

### 7.3 私有 mapper 范式(沿 P2-5 §6.4)

入参:既有 `AttendanceRecordResponseDto`(含 `sheetId` / `serviceHours: string` / `contributionPoints: string \| null`,**三处稳定输出**:[dto:371](../src/modules/attendances/attendances.dto.ts) declaration / [service:140](../src/modules/attendances/attendances.service.ts) select / [service:223](../src/modules/attendances/attendances.service.ts) mapper)+ §7.4 自查的两份 Map:

```ts
private static toAppDto(
  row: AttendanceRecordResponseDto,
  activityIdBySheetId: Map<string, string>,
  activityById: Map<string, ActivityForListJoinRow>,
): AppMyAttendanceRecordDto {
  const activityId = activityIdBySheetId.get(row.sheetId) ?? '';
  const act = activityById.get(activityId);
  return {
    id: row.id,
    activityId,
    activityTitle: act?.title ?? '',
    activityStartAt: act?.startAt ?? row.checkInAt,
    activityEndAt: act?.endAt ?? row.checkOutAt,
    activityCoverImageUrl: act?.coverImageUrl ?? null,
    roleCode: row.roleCode,
    checkInAt: row.checkInAt,
    checkOutAt: row.checkOutAt,
    serviceHours: row.serviceHours,
    attendanceStatusCode: row.attendanceStatusCode,
    note: row.note,
    contributionPoints: row.contributionPoints,
    createdAt: row.createdAt,
  };
}
```

### 7.4 派生字段 join 策略(D-P2-6-6;沿 §11.1 不改 `attendances.service.ts`)

**默认方案**(沿 P2-5a [`app-my-registrations.service.ts:76-87`](../src/modules/activity-registrations/app-my-registrations.service.ts) 范式;**0 service 改动**):既有 `listMyRecords` 返回 `AttendanceRecordResponseDto` 含 `sheetId`(§7.3 三处稳定)但**不**含 `sheet.activityId`;AppMy service 通过 `PrismaService` 自查 `AttendanceSheet` + `Activity` 表补齐派生字段。

```ts
// 1) thin-wrap listMyRecords(签名 0 diff)
const records = await this.attendances.listMyRecords(query, currentUser);

// 2) AppMy 内单次 IN 拿 sheetId → activityId
const sheetIds = [...new Set(records.items.map(r => r.sheetId))];
const sheets = await this.prisma.attendanceSheet.findMany({
  where: { id: { in: sheetIds } },
  select: { id: true, activityId: true },
});
const activityIdBySheetId = new Map(sheets.map(s => [s.id, s.activityId]));

// 3) AppMy 内单次 IN 拿 Activity 派生字段
const activityIds = [...new Set([...activityIdBySheetId.values()])];
const activities = await this.prisma.activity.findMany({
  where: { id: { in: activityIds } },
  select: { id: true, title: true, startAt: true, endAt: true, coverImageUrl: true },
});
const activityById = new Map(activities.map(a => [a.id, a]));

// 4) 私有 mapper 转 App DTO(沿 §7.3)
const items = records.items.map(r =>
  AppMyAttendanceRecordsService.toAppDto(r, activityIdBySheetId, activityById)
);
```

**总 DB 调用** = `listMyRecords` 内部 `$transaction([findMany, count])`(2)+ sheet IN(1)+ activity IN(1)= **4 次批量查询,无 N+1**。

**铁律**:❌ **禁**改 `attendances.service.ts`(沿 §11.1)/ **禁**新增 `listMyRecordsRaw(...)` 或任何 method(沿 D-P2-6-2)/ **禁**复刻 `listMyRecords` 内 where 子句(双权威源漂移);✅ **允许** AppMy 通过 `PrismaService` 自查 `AttendanceSheet` + `Activity`(沿 P2-5a 范式)。

**例外退路**(必须用户拍板,**禁**自行决定):如 implementation 发现 thin-wrap + AppMy 自查**无法**支撑 §5.1(因 `sheetId` 三处稳定,理论不应发生),**必须**:①立刻暂停回到对话汇报缺口 ②**不**擅改既有文件 ③由用户拍板是否新开 v0.2 解锁 `listMyRecordsRaw(...)` 或调整字段集 ④v0.2 冻结前**禁**任何 implementation 代码动作。

---

## 8. 准入规则

### 8.1 硬约束(沿 P2-5 §7.1 + AppIdentityResolver)

| 顺序 | 检查 | 不通过响应 |
|---|---|---|
| 1 | JwtAuthGuard 全局 | 401 `UNAUTHORIZED=40100`(token 无效 / 过期 / 用户 DISABLED / 软删) |
| 2 | `AppIdentityResolver.resolve(currentUser)` → `canUseApp === true && member !== null` | `FORBIDDEN=40300` |

### 8.2 拒绝路径(D-P2-6-10 + D-P2-6-12 + D-P2-6-13)

| 场景 | reason | 响应 |
|---|---|---|
| memberId === null(USER 未绑 + Admin 未绑) | `MEMBER_NOT_LINKED` | `FORBIDDEN=40300` |
| member 不存在 / 软删 | `MEMBER_DELETED` | `FORBIDDEN=40300` |
| member.status !== ACTIVE | `MEMBER_INACTIVE` | `FORBIDDEN=40300` |
| canUseApp=true(含 admin-as-member) | — | 200 + linked-member self perspective(沿 D-P2-6-13) |

**铁律**:
- ❌ **禁止**沿 D-P2-3-1 admin-without-member 例外(严格仅 `/me/password` 适用)
- ❌ **禁止**因 role=ADMIN 扩大 scope(沿 D-5.2)
- ❌ **禁止**从 body / query 接收 `memberId`(DTO 严格白名单)
- ❌ **禁止**返回不同的 reason 字段细分给前端(`reason` 仅用于 `/me/capabilities`;本 endpoint 统一 `FORBIDDEN`)

---

## 9. OpenAPI Contract 变更

### 9.1 EXPECTED_ROUTES(+1)

[`test/contract/openapi.contract-spec.ts`](../test/contract/openapi.contract-spec.ts) `EXPECTED_ROUTES` 在 P2-5b 段后追加:

```ts
// Phase 2 P2-6(2026-05-2X):App /api/app/v1/my/attendance-records
// 沿 docs/app-api-p2-6-attendance-records-review.md §4 endpoint 契约 + §5 字段集恰好 14;
// 复用 attendances.service.listMyRecords(沿 D-P2-6-2 thin-wrap);
// 0 新 BizCode / 0 schema / 0 migration;旧 /api/v2/users/me/attendance-records 行为逐字不变。
['get', '/api/app/v1/my/attendance-records'],
```

### 9.2 EXPECTED_SCHEMAS(+1)

`EXPECTED_SCHEMAS` 数组追加(P2-5b 段后):

```ts
// Phase 2 P2-6:App /api/app/v1/my/attendance-records 出参 DTO
// 字段集恰好 14(沿 §5.1);独立 class,**禁止**继承 / Pick / Omit / Mapped Types
// admin AttendanceRecordResponseDto(沿 D-P2-6-4 + Phase 0.7 §2.2)。
'AppMyAttendanceRecordDto',
```

### 9.3 Query DTO 不进 schemas

`ListAppMyAttendanceRecordsQueryDto` 是 `@Query()` DTO,被 NestJS Swagger 内联为 parameters,**不**注册到 `components.schemas`(沿 P2-5 [openapi.contract-spec.ts:612-614](../test/contract/openapi.contract-spec.ts) 注释惯例)。

### 9.4 Snapshot 重生

`pnpm test:contract -u` 重新生成 `test/contract/__snapshots__/openapi.contract-spec.ts.snap`。预期 snapshot diff:
- 新增 1 个 path key `/api/app/v1/my/attendance-records`
- 新增 1 个 schema `AppMyAttendanceRecordDto`
- **0 修改** 既有 path / schema

---

## 10. 测试策略

### 10.1 e2e spec 文件

- **新建**:`test/e2e/app-my-attendance-records.e2e-spec.ts`
- **预估**:~700-900 行(沿 [P2-5a `app-my-registrations-read.e2e-spec.ts` 912 行](../test/e2e/app-my-registrations-read.e2e-spec.ts) 范式)

### 10.2 必备用例矩阵

| # | 类别 | 用例 |
|---|---|---|
| 1 | 字段集 | `200 + Object.keys().length === 14 + 字段名集合恰好等于 §5.1 表` |
| 2 | 字段集 | 不含 `sheetId` / `memberId` / `member` / `registrationId` / `updatedAt` / `passwordHash` 等(逐项断言) |
| 3 | 派生字段 | `activityTitle / startAt / endAt / coverImageUrl` 来自 Activity 表;coverImageUrl 可 null |
| 4 | 仅 approved sheet | pending / `rejected`(一级)/ `final_rejected`(终审)/ `pending_final_review` → 列表不返;`approved`(终审通过)→ 出现 |
| 5 | 软删 record / sheet | record 软删 / sheet 软删 → 不返(沿 `notDeletedWhere` + `sheet.deletedAt=null`) |
| 6 | `?activityId=` filter | 仅返该活动 records;`?activityId=不存在` → items=[] / total=0 |
| 7 | query 边界 | `pageSize=101` / `page<1` / unknown query(`?sheetId=` / `?memberId=`)→ 400 `BAD_REQUEST`(`forbidNonWhitelisted`) |
| 8 | scope-self | USER A 看不到 USER B 的 records;admin-as-member 走 self perspective,看不到他人 |
| 9 | admin-without-member / Member.INACTIVE / Member 软删 | 403 `FORBIDDEN`(不沿 D-P2-3-1 例外) |
| 10 | User.DISABLED | 401 `UNAUTHORIZED`(JwtStrategy 全局拦截) |
| 11 | empty-list / 分页 / 排序 | 本人无 record → items=[] / total=0;`total / page / pageSize` 边界正确;`orderBy: { checkInAt: 'desc' }` |
| 12 | 未登录 | 401 |
| 13 | path stability / N+1 防御 | 旧 `GET /api/v2/users/me/attendance-records` 字面不变(D-P2-6-15 反向断言);同活动多 records → 同一 IN 查询(难打点可省,由 code review 把关) |

### 10.3 测试 fixture

沿 [`test/e2e/attendances.e2e-spec.ts`](../test/e2e/attendances.e2e-spec.ts) 复用既有 helpers(`loginAs` / `seed dictionary` / `seed activity` / `seed member` / `submit sheet` / `approve` / `finalApprove`)。

---

## 11. 禁止修改清单

### 11.1 严禁修改文件

| 文件 / 区域 | 理由 |
|---|---|
| `prisma/schema.prisma` / `prisma/migrations/*` | D-P2-6-11(0 schema / 0 migration) |
| `src/modules/attendances/attendances.service.ts` | D-P2-6-2 + §7.4;**完全禁修改**(0 diff;含**禁止**新增 `listMyRecordsRaw` 或任何 method);若 implementation 发现 thin-wrap + AppMy 自查仍不足,**必须**暂停回到对话另立 v0.2 评审稿,**禁止**自行解锁 |
| `src/modules/attendances/attendances.controller.ts` | 旧 3 controller 含 `/v2/users/me/attendance-records` legacy path 必须逐字不变(D-P2-6-15) |
| `src/modules/attendances/attendances.dto.ts` | admin DTO 不动(D-P2-6-4 DTO 隔离) |
| `src/modules/users/*`(含 `app-identity.resolver.ts` / `app-capability.service.ts` / `users.module.ts` / 其余) | P2-1 已冻结;`AppIdentityResolver` 已 exports |
| `src/modules/activity-registrations/*` / `src/modules/activities/*` | P2-4 / P2-5 已落地,不动 |
| `src/bootstrap/apply-swagger.ts` / `apply-global-setup.ts` | 顶层 §3.2 |
| `package.json` / `pnpm-lock.yaml` | 0 新依赖 |
| 所有 `/api/v2/*` 现有路径 / Phase 1A Swagger Tag / `/api/auth/*` 现状 | Phase 3 方案 C + 顶层 §3.2 |
| `Role` / `UserStatus` / `MemberStatus` enum / Permission seed / RbacRole | 顶层 §3.2 |
| `CLAUDE.md` / `AGENTS.md` | 本评审稿 docs-only;铁律修订归独立 PR |
| `docs/current-state.md` / `CHANGELOG.md` | 本 PR 不动;P2-8 收尾或后续 PR 回填 |

### 11.2 BizCode 锁死

- ✅ **复用** `UNAUTHORIZED=40100` / `FORBIDDEN=40300` / `BAD_REQUEST=40000` / `INTERNAL_ERROR=50000`
- ❌ **不新增**任何 BizCode(沿 D-P2-6-10)
- ❌ **不开** `MEMBER_NOT_FOUND` 暴露给 App 用户(沿 P2-5 §9.1 既有铁律;由 AppIdentityResolver 前置拦截后统一 FORBIDDEN)

---

## 12. BizCode 复用矩阵

| 场景 | BizCode | HTTP | 触发位置 |
|---|---|---|---|
| 未登录 / token 无效 / 过期 / 用户 DISABLED / 软删 | `UNAUTHORIZED=40100` | 401 | `JwtStrategy.validate` |
| canUseApp=false(memberId=null / member 软删 / INACTIVE) | `FORBIDDEN=40300` | 403 | 薄壳 service `assertCanUseAppOrThrow` |
| `pageSize > 100` / `page < 1` | `BAD_REQUEST=40000` | 400 | DTO `class-validator` |
| 未声明 query 字段 | `BAD_REQUEST=40000` | 400 | 全局 `forbidNonWhitelisted: true` |
| `activityId` 类型不合法 / 超长 | `BAD_REQUEST=40000` | 400 | DTO `IsString + MaxLength` |
| 服务异常 | `INTERNAL_ERROR=50000` | 500 | `AllExceptionsFilter` |

---

## 13. 风险表 Top 10

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | 误复用 / 继承 admin `AttendanceRecordResponseDto`(`extends` / `Pick` / `Omit` / Mapped Types) | **高** | DTO 物理独立 class;e2e 字段集严格 `Object.keys().length===14` 断言;snapshot diff review;代码 review 强查 `import .*AttendanceRecordResponseDto` 不出现在 App 文件 |
| R2 | 误改 `attendances.service.ts`(改既有签名 / 新增 `listMyRecordsRaw` / 任何 diff) | **高** | 沿 D-P2-6-2 + §7.4 + §11.1 完全禁修改;PR review 强查 `attendances.service.ts` **整文件 0 diff**;新增 method 必须先暂停回到对话另立 v0.2 |
| R3 | 误碰旧 `/v2/users/me/attendance-records` 行为 | **高** | PR review 强查 `attendances.controller.ts` 0 diff;e2e 23 用例反向断言旧 path |
| R4 | 跳过 `AppIdentityResolver` 直接用 `currentUser.memberId` 短路 | **高** | 薄壳 service 入口 `assertCanUseAppOrThrow` 强约束;e2e 15+16+17 三用例(admin-without-member / INACTIVE / 软删) |
| R5 | 误返 L2 字段(`member.mobile` / `member.documentNumber`) | **高** | mapper 严格白名单 14 字段;snapshot freeze;e2e 用例 2 反向断言 |
| R6 | 派生 `activity*` join 走 N+1 查询;或为拿 `sheet.activityId` 擅自改 `attendances.service.ts` | **高** | 沿 §7.4 默认:AppMy service 内 2 次 IN 批量查 sheet + activity(P2-5a 范式);0 service diff;若发现出参不足**必须**暂停回到对话,**禁止**自行新增 `listMyRecordsRaw` |
| R7 | 误返 `member` 嵌套 `{id, memberNo, displayName}` | 中 | snapshot freeze 字段集 14;e2e 用例 2 反向断言无 `member` 字段 |
| R8 | 误新增 BizCode(`MEMBER_NOT_FOUND` / `NO_ATTENDANCE_RECORDS`)| 中 | sealed by D-P2-6-10;PR review 强查 `biz-code.constant.ts` diff = 0 |
| R9 | 忘记更新 `EXPECTED_ROUTES` / `EXPECTED_SCHEMAS` 白名单 | 中 | `pnpm test:contract` 全量路由集 vs 白名单完全相等断言会拒掉;另 snapshot 触发 fail |
| R10 | diff > 300 行(突破顶层 §8.1 P2-6 < 300 行软上限) | 低 | e2e ~700-900 行不计入 PR 主代码;主代码(controller + service + DTO × 2 + module diff)< 300 行 |
| R11 | admin-as-member 边界:linked-admin 拿到自己的记录 ≠ 其它管理记录(意外 scope 扩大) | 中 | service 入口锁 `memberId = currentUser.memberId`;e2e 用例 14 强校验 |
| R12 | 派生 `activityCoverImageUrl` 误返完整 signed URL(L3)而非裸 URL | 低 | sealed:`Activity.coverImageUrl` schema 本身是裸 URL 字符串,非 signed URL |

---

## 14. PR 拆分

### 14.1 本评审稿 docs-only PR(A 档)

- **范围**:本评审稿 1 文件
- **diff**:仅新增 1 个 `docs/app-api-p2-6-attendance-records-review.md`
- **0 src / 0 prisma / 0 migration / 0 test / 0 package.json / 0 workflow / 0 .env.example 变更**
- **不动**:`CLAUDE.md` / `AGENTS.md` / `docs/current-state.md` / `CHANGELOG.md` / Phase 2 顶层评审稿 / P2-1~P2-5 评审稿
- **commit message**:`docs(app): add P2-6 App attendance-records implementation review`
- **PR title**:同上
- **验收**:A 档(`pnpm lint` / `pnpm typecheck` 不需要,纯 docs)

### 14.2 P2-6 implementation PR(C 档,后续独立立项)

- **范围**:1 endpoint + 4 新文件 + 2 修改文件(module + contract spec)+ 1 e2e + 1 snapshot 更新
- **依赖前置**:本评审稿合入后才允许立项
- **commit message**:`feat(app): add App my-attendance-records endpoint (P2-6)`
- **PR title**:同上
- **验收**:A 档全套 + B 档手工验证(详 §15)

### 14.3 不混档铁律

❌ **禁止**把评审稿与 implementation 揉进同一 PR(沿 [P2-5 §4.4](app-api-p2-5-registrations-review.md))
❌ **禁止**在 implementation PR 内"顺手"扩字段(沿 §5 字段集冻结)
❌ **禁止**在 implementation PR 内顺手做 P2-7 / Phase 1B / P2-8 任何工作

---

## 15. 实施前置 / 命令清单(P2-6 implementation PR 用)

### 15.1 必跑命令

| 档 | 命令 | 必跑时机 |
|---|---|---|
| A | `pnpm lint` | 提 PR 前 |
| A | `pnpm typecheck` | 提 PR 前 |
| A | `pnpm test`(unit) | 提 PR 前 |
| A | `pnpm test:contract -u` | 修 DTO / Controller 后 |
| A | `pnpm test:contract` | 提 PR 前 |
| A | `pnpm test:e2e` | 提 PR 前 |
| B | 启服务后访 `/api/docs` 检查新 endpoint 显示在 `Mobile - My Attendance` Tag | 手工验证 |
| B | `curl -H "Authorization: Bearer …" .../my/attendance-records` 命中本人 200 / 他人 scope-self 200 仅本人 / DISABLED 401 / admin-without-member 403 | 手工抽测 |

### 15.2 禁止命令

- ❌ `pnpm prisma migrate dev` / `migrate deploy` / `db push`(沿 D-P2-6-11)
- ❌ `pnpm add` / `pnpm remove` 任何依赖

### 15.3 前置 grep 复核

implementation PR 启动前在新代码搜:
- `grep -n "AttendanceRecordResponseDto" src/modules/attendances/app-my-attendance-records.service.ts src/modules/attendances/controllers/app-my-attendance-records.controller.ts src/modules/attendances/dto/app/`(必须无命中)
- `grep -nE "extends|Pick<|Omit<|IntersectionType|PartialType|OmitType" src/modules/attendances/dto/app/`(必须仅 `extends PaginationQueryDto`)
- `grep -n "@Roles" src/modules/attendances/controllers/app-my-attendance-records.controller.ts`(必须无命中)
- `grep -n "memberId" src/modules/attendances/dto/app/app-my-attendance-record.dto.ts`(必须无命中)

---

## 16. 元信息

**状态机**:草案 v0.1(本文件)✅ → 用户拍板冻结 ⏳ → docs-only PR 合入 ⏳ → implementation PR 立项 ⏳ → P2-6 完成(e2e 全绿)⏳。

**冻结后修订**:沿 [`docs/process.md §6`](process.md),评审稿冻结后**不回改**;implementation 发现需修订必须先回对话说明,经用户同意后另开 v0.2,本文件保留 v0.1。

**撰写边界**:本评审稿**不**修改顶层 Phase 2 / P2-1~P2-5 评审稿 / Phase 0.5~0.7 评审稿 / [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md) / [`docs/current-state.md`](current-state.md) / [`CHANGELOG.md`](../CHANGELOG.md);current-state / CHANGELOG 回填留 implementation PR 或 P2-8 收尾。

---

**草案 v0.1 完。等待用户拍板。**
