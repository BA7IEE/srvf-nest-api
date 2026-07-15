# SRVF 活动评价 T0 评审稿

> **状态**：FROZEN（2026-07-16）  
> **档位**：D 档功能串，F0～F4 串行  
> **立项基线**：v0.53.0 / `818bb20d` / 0 open PR  
> **已有依据**：活动模块 29 问审计刀 6 第三件 goal-objective（2026-07-15）  
> **目标**：关闭审计项 #1（活动结束后无评价 / 反馈 / 满意度）

本稿只展开 goal 已拍板的 E1～E4、工程代决、授权、禁区与 DoD，不新增本期范围。实施若发现
本稿与 live 代码、`AGENTS.md`、baseline、API surface policy 或 participation bounded-context
冲突，必须按 `docs/process.md §4.1` 停止并提交人话简报，不得自行调和。

## 0. TL;DR

1. 仅 approved Sheet 内有未软删 `AttendanceRecord` 的本人可评价；pass 报名、候补、临时参加但
   未录考勤、pending/rejected Sheet 内记录均不构成资格。
2. 评价为 `rating` 1～5 整数 + 可选 `comment`（≤500 字）；同人同活动窗口内 PUT upsert。
3. 活动必须 `statusCode='completed'`；窗口基线用既有 `Activity.endAt + N 天`，不新增
   `completedAt`。`N=ATTENDANCE_FEEDBACK_WINDOW_DAYS`，默认 30，范围 1～365。
4. App 只读写本人评价，不返回他人评价或活动均分；Admin 可见评价人实名、列表和聚合。
5. App GET 定稿为恒 200：`{ feedback: null | {...}, canSubmit, windowClosesAt }`。无评价时仍能
   返回按钮态与倒计时，不以 404 丢失渲染所需状态。
6. 新建独立 `activity-feedbacks` 模块；不 import `AttendancesService`，资格只读 Prisma；不增厚
   activities / activity-registrations / attendances 三个 god-service。
7. 管理面两端点复用 `attendance.read.sheet` + activity ref，0 新权限码；评价不进 AuditLog，
   0 新 `AuditLogEvent`。
8. `participation-summary` additive 增加 `feedback: { count, avgRating }`；不改既有度量字段语义，
   不动跨活动 `participation-overview`。
9. 目标足迹：endpoint 350→354、migration 52→53、module 35→36、controller 71→73；permission
   206、AuditLogEvent 113、cron 2、内置角色 9 恒定。
10. 本 goal 不 bump 版本、不 tag、不发版；评价不影响贡献值、报名、考勤、候补、打卡或结算。

## 1. 冻结范围与阶段

| 阶段 | 交付 | 硬边界 |
|---|---|---|
| F0 | 本冻结稿 | 单文件 docs PR；只展开既定决议 |
| F1 | `activity_feedbacks` 空表、唯一 migration #53、schema / CODEMAP / prisma CLAUDE 计数 true-up | additive、无回填、无 enum、无 seed、无既有表字段变更 |
| F2 | App PUT + GET、准入 / 窗口 / 资格 / upsert、配置、单测 | App self-scope；独立 App DTO；不改既有 App 活动 DTO |
| F3 | Admin 列表 + 聚合、`participation-summary.feedback` 接入 | 复用 `attendance.read.sheet`；禁 N+1；不改既有度量语义 |
| F4 | e2e 全矩阵、contract/snapshot、handoff、CHANGELOG Unreleased、current-state、终态地图与 gates | 不补做版本 bump / tag / Release |

阶段按 F0 → F4 串行。前一 PR 合入 `main`、同步远端、工作树 clean、0 open PR 后再启动下一阶段。
F1～F4 的实现、契约、handoff 与地图义务必须落在对应事实首次出现的 PR，不把应随代码交付的
内容全部拖到最后补缴。

### 1.1 本期明确不做

- 多维度评分、匿名评价、公开评价墙、活动均分 App 展示。
- 跨活动评价横扫 / 排行 / 趋势端点，`participation-overview` 评价聚合。
- 评价提醒、通知、cron、queue、outbox、业务 event。
- 评价修改历史、管理员代评 / 改评 / 删除、App 删除评价。
- 新权限码、角色、AuditLogEvent、AuditLog 写入、新依赖。
- 新增 `Activity.completedAt` 或其它既有表业务列。
- 修改贡献值、报名、候补、打卡、考勤、结算路径。
- 使用 `evaluation` 或其它近义模块命名；本模块统一使用 `feedback`，评分字段仅用 `rating`。
- `prisma migrate reset`、`prisma migrate deploy`、`prisma db push`，以及任何面向 `app` / 生产库的迁移写。

## 2. 产品与生命周期决策 E1～E4

### 2.1 E1：评价资格是真到场者

资格谓词固定为：

```text
exists AttendanceRecord
  where activityId = target activity（经 AttendanceSheet 关联）
    and memberId = current linked member
    and AttendanceRecord.deletedAt IS NULL
    and AttendanceSheet.deletedAt IS NULL
    and AttendanceSheet.statusCode = 'approved'
```

- 不要求 `registrationId` 非空；Admin 录入的临时参加者只要最终形成 approved 考勤记录，也是真到场者。
- pass 报名但无考勤、waitlisted、pending/reject/cancelled 报名均不能单独形成资格。
- pending / pending_final_review / rejected / final_rejected Sheet 内记录不算资格。
- 同一成员有多条 approved 记录时仍只有一个评价资格；资格查询使用存在性查询，一次完成，不逐 Sheet 查询。

### 2.2 E2：1～5 星总分 + 可选文字

App PUT body 精确白名单：

| 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| `rating` | integer | 是 | `@IsInt()` + `@Min(1)` + `@Max(5)` |
| `comment` | string | 否 | `@IsString()` + `@MaxLength(500)`；不额外 trim / 空串归一化 |

`rating=0/6` 与 `comment` 501 字由 DTO + 全局 ValidationPipe 返回通用 40000；不新增 rating 专码。

### 2.3 E3：Admin 实名，App 仅本人

- DB 存 `memberId`，Admin 列表返回评价人的 `memberNo/displayName`。
- App 所有 where 子句锁 `AppIdentityResolver` 返回的本人 `member.id`；后台角色不扩大 App scope。
- App GET/PUT 不接受 `memberId`，不返回他人评价、评价人数、均分、直方图或评价率。
- Admin 列表与汇总必须先通过 `attendance.read.sheet` + `{ type: 'activity', id }` 判权；不新增权限码。

### 2.4 E4：completed 后按 endAt 计 30 天窗口

窗口公式：

```text
windowClosesAt = Activity.endAt + ATTENDANCE_FEEDBACK_WINDOW_DAYS * 24h
canSubmit = statusCode === 'completed'
         && now <= windowClosesAt
         && hasApprovedAttendance
```

- 边界 `now === windowClosesAt` 仍可提交；`now > windowClosesAt` 关闭。
- `Activity` 没有 `completedAt`；本期明确不新增该列。`endAt` 是稳定活动事实，避免人工 complete
  操作时点漂移，构成本 goal 相对“completed 时刻 + 30 天”的冻结偏离。
- 活动只有 `statusCode='completed'` 才开放评价；即使 `endAt + N 天` 尚未到，draft/published/cancelled
  也拒绝写。
- 已有评价的修改与首次提交使用完全相同的状态、窗口、资格闸；窗口关闭后不可再修改。

## 3. API surface 与精确响应

### 3.1 App（2 个）

| Method | Path | 语义 |
|---|---|---|
| PUT | `/api/app/v1/my/activities/:activityId/feedback` | 窗口内创建或更新本人评价 |
| GET | `/api/app/v1/my/activities/:activityId/feedback` | 恒 200 返回本人评价与按钮态 |

两端点只走全局 JwtAuthGuard + `AppIdentityResolver`；不新增 `@Roles` 或 Guard。

PUT 成功响应与 GET 共用 App 自有响应形态：

```text
{
  feedback: null | {
    rating: 1..5,
    comment: string | null,
    createdAt: ISO-8601 UTC,
    updatedAt: ISO-8601 UTC
  },
  canSubmit: boolean,
  windowClosesAt: ISO-8601 UTC
}
```

PUT 成功时 `feedback` 必不为 null、`canSubmit=true`。GET 对活动存在但尚无本人评价返回
`feedback:null`，仍返回按当前状态 / 窗口 / 资格计算的 `canSubmit` 与 `windowClosesAt`。

**404-vs-200 定稿**：选择恒 200。理由是 endpoint 同时承担评价详情与前端入口状态查询；无评价并非
资源级异常，且 404 无法在统一错误响应中携带 `canSubmit/windowClosesAt`。活动本身不存在仍复用
`ACTIVITY_NOT_FOUND=20001` 返回 404。

### 3.2 Admin（2 个）

| Method | Path | 语义 |
|---|---|---|
| GET | `/api/admin/v1/activities/:activityId/feedbacks` | 分页评价列表 |
| GET | `/api/admin/v1/activities/:activityId/feedback-summary` | 评价聚合 |

列表沿统一 `PaginationQueryDto`，默认 `updatedAt DESC, id DESC`，item 精确包含：

```text
memberNo / displayName / rating / comment / createdAt / updatedAt
```

汇总精确包含：

```text
count: number
avgRating: number | null       # 非空时四舍五入保留 2 位；0 条为 null
ratingDistribution: [
  { rating: 1, count: number },
  ...,
  { rating: 5, count: number }
]
feedbackRate: number           # count / approved 考勤 distinct member 数，0～1，四位小数；分母 0 时为 0
```

直方图固定返回 1～5 五桶，零桶也显式返回；评价率分子是未软删评价人数，分母是该活动 approved
Sheet 内未软删 AttendanceRecord 的 distinct member 数，与 E1 资格口径一致。

### 3.3 DTO / Controller 隔离

- App DTO 位于 `src/modules/activity-feedbacks/dto/app/`，不得从 Admin DTO 派生或复用 class。
- 两个独立 controller 分别承载 App 与 Admin surface；不新增 Mixed Controller。
- 新模块通过 `ActivityFeedbacksModule` 注册进 `AppModule`；不把 endpoint 塞入 activities / attendances controller。

## 4. App PUT 闸序与错误码

### 4.1 固定闸序

1. JwtAuthGuard。
2. `AppIdentityResolver`：必须 `canUseApp=true` 且 linked active Member；否则通用 `FORBIDDEN=40300`。
3. 查 live Activity；不存在复用 `ACTIVITY_NOT_FOUND=20001`。
4. Activity 必须 `statusCode='completed'`；否则 `ACTIVITY_FEEDBACK_ACTIVITY_NOT_COMPLETED=35030`。
5. `now <= endAt + N 天`；否则 `ACTIVITY_FEEDBACK_WINDOW_CLOSED=35031`。
6. 本人必须有 E1 approved-only 考勤；否则 `ACTIVITY_FEEDBACK_ATTENDANCE_REQUIRED=35032`。
7. 查本人 live feedback；存在则 update，不存在则 create。
8. create 并发撞 partial unique 的 P2002 兜底转 `ACTIVITY_FEEDBACK_ALREADY_EXISTS=35002`；绝不泄露 Prisma 错误。

非 completed 选择新码而不是 404：调用者已通过 App 身份且 activityId 存在，前端需要区分“尚未完结”
与“窗口已关闭 / 未到场”三种按钮提示；该差异不扩大 App 数据 scope。

### 4.2 新 BizCode（4 个）

| 常量 | code | HTTP | 前端提示价值 |
|---|---:|---:|---|
| `ACTIVITY_FEEDBACK_ALREADY_EXISTS` | 35002 | 409 | 并发 create 被 DB partial unique 兜底，提示刷新后重试修改 |
| `ACTIVITY_FEEDBACK_ACTIVITY_NOT_COMPLETED` | 35030 | 409 | 区分活动尚未完结 |
| `ACTIVITY_FEEDBACK_WINDOW_CLOSED` | 35031 | 409 | 区分 30 天评价窗口已关闭 |
| `ACTIVITY_FEEDBACK_ATTENDANCE_REQUIRED` | 35032 | 409 | 区分没有 approved 到场记录 |

段位使用当前实际 BizCode 索引在 role-bindings `34xxx` 之后的下一未规划 `35xxx`；权限拒绝仍复用
`RBAC_FORBIDDEN=30100`，DTO 校验仍复用 40000。实施时同步更新 BizCode 文件头总数与段位索引。

## 5. Schema 与 migration 决策

### 5.1 新模型

Prisma model：`ActivityFeedback`；物理表：`activity_feedbacks`（`@@map`）。

| 字段 | Prisma / DB | NULL | 语义 |
|---|---|---|---|
| `id` | String / TEXT | 否 | cuid 主键 |
| `createdAt` | DateTime / TIMESTAMP(3) | 否 | `now()` |
| `updatedAt` | DateTime / TIMESTAMP(3) | 否 | `@updatedAt` |
| `deletedAt` | DateTime / TIMESTAMP(3) | 是 | 预留；本期无删除入口 |
| `activityId` | String / TEXT | 否 | FK → Activity，Restrict |
| `memberId` | String / TEXT | 否 | FK → Member，Restrict |
| `rating` | Int / INTEGER | 否 | 业务层校验 1～5；不建 enum |
| `comment` | String / TEXT | 是 | 可选评价文字，DTO ≤500 |

`Activity` / `Member` 只新增 Prisma 反向 relation，不新增业务字段，不改变既有关系行为。

### 5.2 索引与约束

普通单列索引：

```text
activityId / memberId / deletedAt / createdAt / rating
```

手写 partial unique：

```sql
CREATE UNIQUE INDEX "activity_feedbacks_activity_member_active_unique"
ON "activity_feedbacks" ("activityId", "memberId")
WHERE "deletedAt" IS NULL;
```

两条 FK 均 `ON DELETE RESTRICT ON UPDATE CASCADE`，不加 `registrationId`：资格锚点是 approved
考勤记录，报名不是必需事实。migration #53 只创建空表、索引、唯一约束与 FK；无回填、无数据删除、
无 enum、无 seed、无不可逆业务数据变化。

### 5.3 Upsert 与并发

- Prisma DSL 无法表达 partial unique，因此不把 `(activityId,memberId)` 声明为普通 `@@unique`。
- 正常路径为 `findFirst(deletedAt:null)` 后 update/create；窗口内重复 PUT 始终更新同一 live 行，
  `createdAt` 不变、`updatedAt` 更新。
- 并发首次 PUT 允许一个 create 成功、另一个被 DB 唯一约束拒绝并转 35002；终态恰一条 live 行。
- 本期不为“两个并发首次 PUT 都返回 200”引入活动级大锁、advisory lock 或重试循环；DB 唯一约束是
  不变量收口，客户端收到 35002 后 GET/重试 PUT 即进入正常 update 路径。

## 6. 模块与架构边界

新目录：`src/modules/activity-feedbacks/`，最小结构：

```text
activity-feedbacks.module.ts
activity-feedbacks.service.ts
activity-feedbacks-query.service.ts
controllers/app-activity-feedbacks.controller.ts
controllers/admin-activity-feedbacks.controller.ts
dto/app/activity-feedback.dto.ts
activity-feedback.dto.ts
CLAUDE.md
```

- `ActivityFeedbacksService`：App 写编排与本人 GET；事务 owner；直接读 Activity / AttendanceRecord / Feedback。
- `ActivityFeedbacksQueryService`：Admin list / summary 与供 activity participation-summary 复用的只读聚合；
  不做写、不做 audit；沿 architecture-boundary QueryService 触发条件。
- Admin controller 调 query service；App controller 调 application service。
- `ActivitiesModule` 仅 import `ActivityFeedbacksModule`，`ActivityParticipationQueryService` 仅调用其导出的
  aggregate 方法；不修改 `ActivitiesService` 主文件。
- 新模块不 import `AttendancesService` / `ActivityRegistrationsService` / `ActivitiesService`；跨 participation
  表只读 Prisma，避免兄弟 service 环和 god-service 增厚。

## 7. participation-summary additive 接入

`GET /api/admin/v1/activities/:activityId/participation-summary` 现有 DTO 尾部 additive 增加：

```text
feedback: {
  count: number,
  avgRating: number | null   # 非空时 2 位；0 条为 null
}
```

- 既有 registration / attendee / no-show / attendanceRate / hours / contribution / durationHistogram 字段、
  算法、权限与 HTTP 行为逐字不变。
- 新字段复用 `ActivityFeedbacksQueryService.aggregateForActivity`，不在现有 QueryService 复制统计逻辑。
- `feedback.count/avgRating` 必须与同活动 `feedback-summary` 的 `count/avgRating` 自洽。
- 不把评价率或直方图塞入 participation-summary；完整统计只在 feedback-summary。

## 8. 查询预算（正常路径）

以下只计业务 Prisma 查询；JwtAuth、`AppIdentityResolver`、`authz.explain` / `rbac.can` 自身查询单列，
不伪装进业务查询数。P2002 异常兜底不计入正常路径。

| 路径 | 固定业务查询 | 写 | N+1 证明 |
|---|---:|---:|---|
| App PUT | 3：Activity 1 + approved 资格 exists 1 + live feedback 1 | create/update 1 | 与 Sheet/Record 数无关 |
| Admin 列表 | 3：Activity exists 1 + page items 1 + count 1 | 0 | member 摘要随 items relation select 批量取，不逐 item 查 |
| feedback-summary | 4：Activity exists 1 + feedback aggregate 1 + rating groupBy 1 + approved distinct members 1 | 0 | 固定 5 桶内存补零，不逐 rating/member 查 |
| participation-summary | 4：原 activity + registrations + records 共 3，新增 feedback aggregate 1 | 0 | 与 registration/record/feedback 数无关 |

App GET 固定 3 次业务查询（Activity + approved 资格 exists + 本人 feedback），用于准确返回 canSubmit；
它同样与 Sheet / Record 数量无关。

## 9. 验收矩阵

至少覆盖：

- pass 报名但没来、waitlisted、无关队员均因无 approved 考勤被 35032 拒绝。
- pending / pending_final_review / rejected / final_rejected Sheet 内记录不构成资格。
- approved Sheet 内未软删记录可评；临时参加者只要有 approved record 也可评。
- draft/published/cancelled 活动返 35030；completed 活动才进入窗口闸。
- `now === endAt+N天` 可评；`endAt+N天+1ms`（或更晚）返 35031。
- PUT 两次只保留一条 live 行，后值覆盖前值，`createdAt` 不变、`updatedAt` 前进。
- 并发首次 PUT 同人同活动终态只留一行；败者为 35002 或已进入 update 路径，绝不 500/P2002 泄漏。
- rating 0/6 拒、1/5 成功；comment 501 字拒。
- App GET 无评价恒 200 + `feedback:null`；本人只能看到本人，不能侧读他人评价或均分。
- Admin 列表分页、实名 memberNo/displayName、排序与软删过滤正确。
- summary 的 count / 两位均分 / 1～5 五桶 / approved distinct-member 评价率正确；分母 0 时 rate=0。
- participation-summary.feedback 与 feedback-summary 的 count/avgRating 一致；既有字段 snapshot 不漂移。
- 0 AuditLog 写、0 新权限、0 cron、0角色；既有报名/候补/打卡/考勤/贡献/结算 e2e 回归绿。

最终必须通过 `pnpm agent:check:full`、`pnpm docs:rbacmap:check`、
`pnpm docs:codemap:check`，逐行解释 contract snapshot diff，并完成 53 migrations 干净库重放。

## 10. Footprint 与迁移回退

| 项 | 基线 | 终态 |
|---|---:|---:|
| Endpoint | 350 | 354 |
| Prisma migration | 52 | 53 |
| Nest module | 35 | 36 |
| Controller | 71 | 73 |
| Permission code | 206 | 206 |
| AuditLogEvent | 113 | 113 |
| Cron | 2 | 2 |
| 内置角色 | 9 | 9 |
| BizCode | 240 | 244（本稿锁定 4 个） |

migration 为纯 additive 空表；若 F1 尚未合入，回退为撤销 schema relation/model 与删除新 migration。
合入并在环境执行后不手工回滚 migration；若必须停用功能，只回滚模块注册 / 路由代码并保留空表，
后续另立 D 档 migration 处理。禁止直接 drop 表或改历史 migration。

## 11. Handoff

### 11.1 miniapp

- completed 活动详情/我的活动增加“评价”入口；先 GET feedback 获取 `canSubmit/windowClosesAt`。
- `feedback:null + canSubmit=true` 显示提交；已有 feedback + canSubmit=true 显示修改；canSubmit=false
  只读展示已有评价或隐藏提交按钮。
- 按 35030 / 35031 / 35032 区分“活动未完结 / 窗口已关闭 / 无到场记录”；35002 时刷新 GET 后重试。
- 只展示本人 rating/comment/timestamps；不设计他人评价、均分或评价人数 UI。

### 11.2 admin-web

- 活动详情增加评价列表分页与评价汇总卡；列表展示 memberNo/displayName、星级、文字与时间。
- 汇总卡展示评价人数、两位均分、1～5 星五桶直方图、0～1 四位评价率。
- activity participation-summary 读取新增 `feedback.count/avgRating`；既有字段保持兼容。

## 12. 本期不做与下一接口

本期不做版本 bump、tag、GitHub Release、跨活动评价分析、提醒通知、评价审计、评价删除/历史、
评价影响结算、任何新权限/角色/cron/依赖，也不修改 `AGENTS.md`。

审计刀 6 第四件预留为“岗位 / 时段”能力，必须另行 goal / 评审；本 goal 不预建 schema、端点、DTO、
枚举或权限占位。
