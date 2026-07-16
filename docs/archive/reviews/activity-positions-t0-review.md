# SRVF 活动岗位与时段 T0 评审稿

> **状态**：FROZEN（2026-07-16）
> **档位**：D 档功能串，F0～F5 串行
> **立项基线**：v0.54.0 / `621a1d2f` / 0 open PR
> **已有依据**：活动模块 29 问审计刀 6 第四件 goal-objective（2026-07-16）+ 维护者四项定稿修正
> **目标**：关闭审计项 #2（活动发布时不可配置岗位 / 时段）并完成审计刀 6 收官

本稿只展开 goal 已拍板的 P1～P4、工程代决、四项定稿修正、行为白名单、授权、禁区与 DoD，
不新增本期决策。实施若发现本稿与 live 代码、`AGENTS.md`、baseline、API surface policy、
architecture boundary 或 participation bounded-context 冲突，必须按 `docs/process.md §4.1` 停止并
提交人话简报，不得自行调和。

## 0. TL;DR

1. 新增 activities 模块内的 `ActivityPosition`，物理表 `activity_positions`；不新增 NestJS module。
2. `ActivityRegistration` additive 增加 `activityPositionId String?`；存量报名全为 null，不回填。
3. 一人一活动一条有效报名的 partial unique 逐字不动；想换岗只能取消原报名后重新报名。
4. 活动存在岗位时，名额真相源改为岗位；活动 `capacity` 不再参与判闸，读侧派生岗位名额总和。
5. 候补、approve 容量复核、取消递补与岗位扩容递补均按 `(activityId, activityPositionId)` 隔离；
   无岗位活动继续使用活动级队列与 `Activity.capacity`。
6. 岗位绑定 `attendance_role`；考勤草稿自动带出岗位角色，既有 ContributionRule 查找与计算零改动。
7. 岗位可带独立时间窗；有岗位报名的打卡与考勤记录按岗位窗 ± 既有容差，无岗位报名沿活动窗。
8. Admin 5 endpoint + App 1 endpoint，`EXPECTED_ROUTES` 354→360；0 新权限码，读 login-only，写复用
   `activity.update.record` + activity ref。
9. 岗位维度 reconciliation / participation-summary / participation-overview 本期明确不做；度量口径不变。
10. 目标足迹：migration 53→54、endpoint 354→360、module 36、permission 206、AuditLogEvent 113、
    cron 2、字典类型与字典项数量均不增加；本 goal 不 bump、不 tag、不 release。

## 1. 冻结范围与阶段

| 阶段 | 交付                                                                           | 硬边界                                                                 |
| ---- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| F0   | 本冻结稿                                                                       | 单文件 docs PR；只展开既定决议                                         |
| F1   | `ActivityPosition` + `ActivityRegistration.activityPositionId` + migration #54 | additive、无回填、partial unique 手写、报名既有 partial unique 零 diff |
| F2   | Admin 岗位 POST / GET list / GET detail / PATCH / DELETE + 校验与单测          | 5 endpoint；读 login-only；写复用 `activity.update.record`             |
| F3   | 三路报名接线、岗位容量 / 候补 / 性别闸、App 岗位列表、Admin 报名列表岗位列     | 锁序不变；activity-position queue 隔离；并发 e2e                       |
| F4   | 打卡 / 考勤记录 / 草稿 roleCode 接线                                           | policy 纯函数签名不变；ContributionRule 零改动                         |
| F5   | e2e 全矩阵、contract/snapshot、handoff、CHANGELOG、current-state 与终态 gates  | 不 bump / tag / Release                                                |

阶段按 F0 → F5 串行。前一 PR 合入 `main`、同步远端、工作树 clean、0 open PR 后再启动下一阶段。
实现、测试、契约、handoff 与模块本地文档义务必须落在对应事实首次出现的 PR，不把所有 true-up
拖到最后补缴。

### 1.1 维护者四项定稿修正

以下四项覆盖原 goal 中对应笔误或未闭合选择；其它 goal 内容不变：

1. **命名统一**：全链一律 `activityPositionId`。原 goal 中 `positionId` 作废。唯一保留的短词是
   URL 资源路径段字面量 `positions`；路由参数仍为 `:activityPositionId`。
2. **端点补齐**：Admin 5 个（含 GET detail）+ App 1 个，合计 +6，354→360。原 F2
   “Admin 4 端点”作废。
3. **读权限**：三个读端点（Admin 两个 GET + App 一个 GET）复用活动读的 login-only 口径，
   0 新权限码；写复用
   `activity.update.record` + `{ type: 'activity', id: activityId }`。
4. **度量分组延期**：岗位维度 reconciliation / participation-summary / participation-overview 本期不做。

### 1.2 本期明确不做

- 不改 `activity_registrations_activity_member_active_unique` 的列、谓词、索引名或 SQL 字面。
- 不开放换岗 endpoint；不允许同一活动同时存在两个岗位的有效报名。
- 不新增 `Activity` 列，不给岗位增加 `requiresInsurance`；保险仍是活动级门槛。
- 不新增字典类型 / 字典项；`attendance_role` 与 `gender_requirement` 复用现有闭集。
- 不改 ContributionRule 表、DTO、CRUD、匹配键或 contribution calculator。
- 不改评价资格、no-show、到场率、时长、评价、结算或其它度量口径。
- 不做岗位维度 reconciliation / participation-summary / participation-overview 分组。
- 不新增 notification / cron / queue / outbox / dependency / NestJS module / Permission code。
- 不新增 AuditLogEvent；全仓终态仍为 113。
- 不改 `organization_positions`、组织职务 DTO / service / route / schema / seed。
- 不改变 Activity → Registration 固定锁序，不引第二把行锁，不改 approve 的 `FOR UPDATE` 锁对象。
- 不开放 `waitlisted → pass` 直通；递补仍只进入 pending，继续走人工 approve。
- 不执行 `prisma migrate reset` / `prisma migrate deploy` / `prisma db push`。
- 不做版本 bump、tag、GitHub Release 或 release handoff。

## 2. 命名边界（活动岗位 vs 组织职务）

### 2.1 活动岗位唯一命名

| 层                     | 冻结命名                                  |
| ---------------------- | ----------------------------------------- |
| Prisma model           | `ActivityPosition`                        |
| 物理表                 | `activity_positions`                      |
| 报名 FK                | `ActivityRegistration.activityPositionId` |
| Prisma relation        | `activityPosition`                        |
| Activity 反向 relation | `activityPositions`                       |
| service / helper 参数  | `activityPositionId`                      |
| DTO 字段               | `activityPositionId` / `activityPosition` |
| 路由参数               | `:activityPositionId`                     |
| URL 资源路径段         | `positions`（唯一允许的短字面）           |

`organization_positions` 表示组织职务（队长 / 部长等 scoped-authz 身份），与本期活动岗位没有关系。
`organization_positions` 及其 relation / assignment / policy 全部零改动。

### 2.2 终态自查

全仓 grep 必须证明：除 URL 路径段字面量 `positions` 与既有组织职务代码外，本期新增 / 修改代码中
不得出现裸 `positionId` 或以裸 `position` 指代活动岗位。测试 fixture / DTO / helper / Prisma select
同样使用全称。

## 3. 产品决策 P1～P4

### 3.1 P1：同一活动一人至多一个岗位

既有唯一不变量逐字保留：

```sql
CREATE UNIQUE INDEX "activity_registrations_activity_member_active_unique"
ON "ActivityRegistration" ("activityId", "memberId")
WHERE "deletedAt" IS NULL AND "statusCode" != 'cancelled';
```

- `activityPositionId` **不进入**唯一键。
- 同一队员先报 A 岗后再报 B 岗，仍返回 `ACTIVITY_REGISTRATION_ALREADY_EXISTS=21002`。
- 换岗路径固定为取消原报名 → 新建另一岗位报名；不增加原地换岗动作。
- no-show、参与次数、到场率、评价资格等一人一活动前提不变。

### 3.2 P2：岗位绑定考勤角色

- 每个岗位 `attendanceRoleCode` 必填，必须命中 active `attendance_role` 字典项（现有 7 项闭集）。
- 有岗位报名进入 `attendance-sheet-draft` 时，草稿 record 的 `roleCode` 使用岗位
  `attendanceRoleCode`；无岗位报名继续使用 `'member'`。
- 既有提交路径仍以 `AttendanceRecord.roleCode` 参与
  `activityTypeCode × attendanceRoleCode × durationThreshold` 规则查找。
- 不修改 ContributionRule 或 calculator；P2 通过草稿默认值接入既有规则，而不是新建第二套计算。

### 3.3 P3：岗位独立时段

- `startAt/endAt` 二者要么都为 null，要么都提供。
- 都提供时必须 `startAt < endAt`，且 `activity.startAt <= startAt < endAt <= activity.endAt`。
- 岗位时段均为 null 时，有岗位报名的有效时间窗退回活动时间窗。
- 有非空岗位时段时，打卡 policy 与考勤 record 时间窗使用岗位时段 ± 既有容差。
- `registrationId=null` 的临时参加记录没有岗位锚点，继续使用活动时间窗。

### 3.4 P4：有岗位时名额真相源在岗位

读侧有效 capacity 规则：

```text
live positions = ActivityPosition WHERE activityId=? AND deletedAt IS NULL

live positions 为空：effectiveCapacity = Activity.capacity
live positions 非空且任一 capacity=null：effectiveCapacity = null（整体不限）
live positions 非空且全部 capacity 为数值：effectiveCapacity = sum(activityPosition.capacity)
```

- 有岗位活动中，`Activity.capacity` 仍保留为既有列，但不参与报名、approve、候补、缩容或递补判闸。
- 有岗位活动 PATCH `Activity.capacity` 不触发递补；对外 `capacity` 仍按岗位派生值展示。
- 无岗位活动完全沿旧：`Activity.capacity` 继续控制分流、approve、缩容守卫与扩容递补。

## 4. Schema 与 migration #54

### 4.1 `ActivityPosition`

物理表固定为 `activity_positions`，Prisma model 使用一次性 `@@map("activity_positions")`：

| 字段                    | Prisma / DB             | NULL / default        | 语义                               |
| ----------------------- | ----------------------- | --------------------- | ---------------------------------- |
| `id`                    | String / TEXT           | NOT NULL / cuid       | 主键                               |
| `createdAt`             | DateTime / TIMESTAMP(3) | NOT NULL / now        | 创建时间                           |
| `updatedAt`             | DateTime / TIMESTAMP(3) | NOT NULL / @updatedAt | 更新时间                           |
| `deletedAt`             | DateTime / TIMESTAMP(3) | NULL                  | 软删除                             |
| `activityId`            | String / TEXT           | NOT NULL              | FK → Activity，Restrict            |
| `name`                  | String / TEXT           | NOT NULL              | 岗位名；DTO ≤64                    |
| `attendanceRoleCode`    | String / TEXT           | NOT NULL              | `attendance_role` 字典 code；非 FK |
| `capacity`              | Int / INTEGER           | NULL                  | null=不限；数值 ≥1                 |
| `startAt`               | DateTime / TIMESTAMP(3) | NULL                  | 岗位开始时间                       |
| `endAt`                 | DateTime / TIMESTAMP(3) | NULL                  | 岗位结束时间                       |
| `genderRequirementCode` | String / TEXT           | NULL                  | `gender_requirement` code；非 FK   |
| `description`           | String / TEXT           | NULL                  | DTO ≤500                           |
| `sortOrder`             | Int / INTEGER           | NOT NULL / 0          | 显式排序                           |

关系：`ActivityPosition.activity` → `Activity.id`，`ON DELETE RESTRICT ON UPDATE CASCADE`；
`Activity.activityPositions` 为反向 relation；`ActivityPosition.registrations` 为报名反向 relation。

普通索引固定覆盖：`activityId` / `attendanceRoleCode` / `deletedAt` / `createdAt` / `sortOrder`。

partial unique 手写：

```sql
CREATE UNIQUE INDEX "activity_positions_activity_name_active_unique"
ON "activity_positions" ("activityId", "name")
WHERE "deletedAt" IS NULL;
```

### 4.2 `ActivityRegistration.activityPositionId`

- 新增 `activityPositionId String?` + 普通索引。
- relation 名固定 `activityPosition`，FK → `activity_positions.id`，Restrict / Cascade update。
- 可空只承接无岗位活动与存量报名；migration 不回填，存量行保持 null。
- 既有 Activity / Member / reviewer / canceller / AttendanceRecord / ActivityCheckIn FK 全部零改动。
- 报名既有 partial unique SQL 必须在 migration diff 中 0 行变化。

### 4.3 migration 性质与执行边界

migration #54 只包含：

1. 创建 `activity_positions` 空表。
2. 创建普通索引与岗位名 partial unique。
3. 新增 `ActivityRegistration.activityPositionId` nullable 列与普通索引。
4. 创建两条 Restrict FK（岗位→活动、报名→岗位）。

无回填、无数据删除、无 enum、无 seed、无既有列类型变化。执行 `prisma migrate dev` 前必须再次
向维护者说明以上 SQL 影响并等待实时确认；`reset/deploy/db push` 恒禁。

## 5. API surface 与权限

### 5.1 Admin（5 个）

| Method | Path                                                                 | 语义         |
| ------ | -------------------------------------------------------------------- | ------------ |
| POST   | `/api/admin/v1/activities/:activityId/positions`                     | 创建岗位     |
| GET    | `/api/admin/v1/activities/:activityId/positions`                     | 岗位列表     |
| GET    | `/api/admin/v1/activities/:activityId/positions/:activityPositionId` | 岗位详情     |
| PATCH  | `/api/admin/v1/activities/:activityId/positions/:activityPositionId` | 部分更新岗位 |
| DELETE | `/api/admin/v1/activities/:activityId/positions/:activityPositionId` | 软删岗位     |

- 两个 GET 仅登录，镜像 Admin 活动 list / detail / options 的 login-only 口径。
- GET 必须先确认 activity 存在；跨 activity 的岗位 id 与软删岗位统一按岗位不存在处理。
- POST / PATCH / DELETE 复用 `activity.update.record`，ref 固定
  `{ type: 'activity', id: activityId }`；`resource_not_found` 回退既有 `rbac.can` 范式。
- 不新增 `activity.read.*` 或任何其它 Permission code；终态 206。

### 5.2 App（1 个）

```text
GET /api/app/v1/activities/:activityId/positions
```

- 复用 App 活动 Controller 的 JwtAuth + `AppIdentityResolver` 准入。
- activity 可见性在 where 中固定为 `published + isPublicRegistration=true + deletedAt=null`；不可见与
  不存在统一 `ACTIVITY_NOT_FOUND`，不暴露存在性。
- 仅返回 live 岗位，排序 `sortOrder ASC, createdAt ASC, id ASC`。
- 返回岗位本身、剩余名额与是否可报，不返回其他报名人、报名名单或任何 L3 字段。
- 岗位满员的报名会进入 waitlisted，因此“满员”本身不改写既有 W2 成拒绝语义。

### 5.3 DTO 隔离

- Admin 岗位 DTO 留在 activities 模块 DTO 范围内；App DTO 独立放入 `dto/app/`。
- 禁止用 `extends` / `Pick` / `Omit` / `IntersectionType` / `PartialType` / `OmitType` 从 Admin DTO
  派生 App DTO。
- 路由参数使用包含 `activityId + activityPositionId` 的专用参数 DTO，两字段均沿 `IdParamDto`
  长度规则（string，8～64），不使用数字 pipe 或 cuid 正则。

## 6. 岗位 CRUD 规则

### 6.1 创建 / 更新字段白名单

POST 字段：

```text
name / attendanceRoleCode / capacity / startAt / endAt /
genderRequirementCode / description / sortOrder
```

PATCH 为同字段 optional；`activityId` / `activityPositionId` / 时间戳 / `deletedAt` 不进入 body。

### 6.2 校验

固定校验：

1. activity live 存在。
2. `name` 非空、≤64；同活动 live 名称不重，P2002 与前置检查映射同一码。
3. `attendanceRoleCode` 命中 active `attendance_role`。
4. `capacity` 为 null 或整数 ≥1。
5. `startAt/endAt` 同空或同有；同有时 start<end 且落在活动窗内。
6. `genderRequirementCode` 为空或命中 active `gender_requirement`。
7. `description` ≤500；`sortOrder` 为整数。

### 6.3 名额 PATCH 与锁后重读

岗位 capacity 更新属于 read-modify-write：

1. 事务内先 `SELECT Activity ... FOR UPDATE`。
2. 取锁后重读目标 `ActivityPosition.capacity` 与同岗位 passCount。
3. 新 capacity 为数值且 `< passCount` 时拒绝缩容。
4. `old finite → new larger` 按 delta 递补；`old finite → null` 递补该岗位全部候补。
5. `null → finite` 或缩容不递补。
6. 更新、递补与 audit 在同事务；通知沿既有 promote 路径在 commit 后派发。

严禁复用锁前读取的岗位 capacity 计算 delta。锁对象仍只有 Activity；不锁 ActivityPosition 行，不改变
Activity → Registration 锁序。

### 6.4 软删除守卫

岗位存在未软删 `pending/pass/waitlisted` 报名时拒绝删除。允许删除时只写 `deletedAt`，不物理删除，
不级联修改报名；FK 保持 Restrict。

### 6.5 audit

不新增 AuditLogEvent。岗位 POST / PATCH / DELETE 复用现有 `activity.update` 事件，在 activity 资源下
记录 `activityPositionId` 与岗位 before / after，禁止记录其他报名人信息或任何凭证字段。

## 7. 报名接线

### 7.1 三条入口

- Admin 代报名 `CreateRegistrationDto` additive 增加可选 `activityPositionId`。
- 旧 self create `CreateMyRegistrationDto` additive 增加可选 `activityPositionId`。
- App `CreateAppMyRegistrationDto` additive 增加可选 `activityPositionId`，薄壳继续转交既有 self create。

有 live 岗位的活动必须提交一个属于该活动的 live `activityPositionId`；无岗位活动保持可省略。
活动无岗位却传入岗位 id、岗位不存在 / 已软删、岗位属于其它活动，均不得把跨活动存在性暴露给调用方。

### 7.2 两级性别闸

报名顺序继续先执行活动级 `genderRequirementCode`，再执行岗位级 `genderRequirementCode`；两级均通过
才可创建。岗位 gender 为空 / `any` 不额外限制，但不能替代活动级限制。

### 7.3 容量分流与 approve

有岗位报名：

```text
passCount WHERE activityId=? AND activityPositionId=? AND deletedAt IS NULL AND statusCode='pass'
capacity = locked live ActivityPosition.capacity
```

- create 分流：capacity=null 或 passCount<capacity → pending；否则 waitlisted。
- approve：仍先锁 Activity 行，再重读岗位与 passCount；满员复用容量拒绝语义。
- 无岗位活动：既有 activityId 级 passCount / `Activity.capacity` 路径逐字不变。
- approve 的 `FOR UPDATE` SQL 锁对象仍为 `Activity`，不改为岗位行或第二把锁。

### 7.4 一人一活动不变量

`assertNoActiveRegistration` 与 DB partial unique 继续只看 `(activityId,memberId)`；不因
`activityPositionId` 分队列而放宽。报第二岗位仍为 21002。

### 7.5 Admin 报名列表 additive

Admin 活动报名列表 item additive 增加：

```text
activityPosition: null | {
  activityPositionId: string,
  name: string
}
```

存量 / 无岗位报名为 null；随原列表 select 一次性 relation 取数，禁止逐 item N+1。该 DTO 增量不新增
endpoint。App 报名读模型本期不扩岗位对象，除已拍板请求字段外不夹带其它响应字段。

## 8. 岗位级候补与递补

### 8.1 队列域

- 有岗位：FIFO 域为 `(activityId, activityPositionId)`。
- 无岗位：FIFO 域仍为 activityId + `activityPositionId=null` 的活动级队列。
- FIFO 排序继续 `registeredAt ASC, id ASC`。
- A 岗空位只递补 A 岗；禁止跨岗借位或合并候补。

### 8.2 `promoteActivityWaitlist`

新增可选参数 `activityPositionId`（全称）：

- 传值：candidate where 加 `activityPositionId`。
- null / 不传：只承接无岗位活动的旧活动级路径。
- 仍锁 Activity 行，逐 registration CAS claim，`waitlisted → pending`，复用
  `registration.review(action=promote)`；不新增事件。

### 8.3 三个触发点

1. 取消 pass：递补该报名 `activityPositionId` 队首 1 名。
2. 岗位 capacity 调大 / 改 null：递补该岗位 delta / 全部候补。
3. Activity capacity update：活动存在 live 岗位时不递补；无岗位时沿旧。

通知继续在 commit 后走既有 waitlist promotion 通知；不新增通知类型。

## 9. 打卡、考勤与草稿

### 9.1 App 打卡

- `ActivityCheckInSchedule` 纯函数接口保持 `{startAt,endAt}`，签名、容差、36 秒 floor 与错误码不变。
- 调用方在 Activity → pass Registration 锁序内读取报名的 `activityPosition`：非空岗位窗优先，岗位窗
  为空则活动窗；无岗位报名活动窗。
- GPS、幂等、partial unique、checkout CAS 与 field policy 全部零改动。

### 9.2 考勤记录

- `validateAndNormalizeRecordsBatch` 批量读取 registrations 时带出 live `activityPosition` 时间窗。
- `registrationId` 非空：先继续校验 registration 与 activity/member/pass 匹配，再按其岗位窗或活动窗
  执行 `assertRecordWithinActivityWindow`。
- `registrationId=null`：继续按活动窗。
- 字典、成员、时间重叠、serviceHours、contributionPoints 三态与提交事务边界零改动。

### 9.3 attendance-sheet-draft

- 有岗位 pass registration：`roleCode=activityPosition.attendanceRoleCode`。
- 无岗位 pass registration：`roleCode='member'`。
- 忘签退 fallback、取消报名出局、raw GPS 不回显、200 条上限与查询预算原则不变。
- 草稿 roleCode 进入既有 submit 后，由原 ContributionCalculator 按既有规则预填贡献值。

## 10. 新 BizCode 规划（最多 6 个）

新增码必须落现有 participation 段，不新开模块段；权限失败继续 30100 / 通用 40100：

| BizCode                                      | 建议段位 | HTTP | 前端提示价值                        |
| -------------------------------------------- | -------: | ---: | ----------------------------------- |
| `ACTIVITY_POSITION_NOT_FOUND`                |    20002 |  404 | 岗位不存在 / 已软删 / 跨活动统一    |
| `ACTIVITY_POSITION_NAME_ALREADY_EXISTS`      |    20003 |  409 | 同活动岗位名冲突，含 P2002          |
| `ACTIVITY_POSITION_TIME_RANGE_INVALID`       |    20017 |  400 | 时间不同空、start>=end 或越出活动窗 |
| `ACTIVITY_POSITION_CAPACITY_INVALID`         |    20018 |  400 | 数值非法或缩容低于本岗位 passCount  |
| `ACTIVITY_POSITION_HAS_ACTIVE_REGISTRATIONS` |    20031 |  409 | pending/pass/waitlisted 存在时禁删  |
| `ACTIVITY_POSITION_REQUIRED`                 |    21035 |  409 | 有岗位活动报名未选择岗位            |

岗位 attendance role 非法复用 `ATTENDANCE_ROLE_CODE_INVALID=22051`；岗位 gender code 非法复用
`ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID=20013`；一人一活动重复继续 21002。终态 BizCode 244→250。

## 11. 行为变更白名单（恰好 7 条）

|   # | 之前                                 | 之后                                                     |
| --: | ------------------------------------ | -------------------------------------------------------- |
|   1 | 活动名额只认 `Activity.capacity`     | 有岗位活动名额真相源为岗位，活动 capacity 不再判闸       |
|   2 | 候补队列只按 activityId              | 有岗位活动按 `(activityId,activityPositionId)` 隔离      |
|   3 | 打卡恒按活动窗                       | 有岗位报名按岗位窗；无岗位沿活动窗                       |
|   4 | 考勤记录恒按活动窗                   | registration 有岗位时按岗位窗；临时参加 / 无岗位沿活动窗 |
|   5 | 草稿 roleCode 恒 `'member'`          | 有岗位报名自动使用岗位 attendanceRoleCode                |
|   6 | 只判活动性别闸                       | 岗位性别闸叠加在活动性别闸之后                           |
|   7 | Activity capacity 调大触发活动级递补 | 有岗位活动不触发；无岗位活动沿旧                         |

除上表外，不改变无岗位活动、报名状态机、ContributionRule、评价、度量、通知、审计事件集合或 API
既有语义。

## 12. 并发与测试矩阵

### 12.1 最高风险并发 e2e

必须至少有：

1. 同岗位并发 approve，不超过岗位 capacity。
2. 同岗位并发取消两个 pass，不会把同一候补重复递补。
3. 跨岗位取消 / 递补互不干扰。
4. 岗位 capacity 并发调大，合计递补不超过锁后真实 delta。
5. **变异验证**：把岗位 capacity 基线读移到 Activity 锁前，上述扩容并发用例必须变红；恢复锁后
   重读后变绿，并保留命令输出作为终版报告证据。

### 12.2 功能 e2e

- Admin 岗位 create/list/detail/update/delete。
- 岗位时间不同空、start>=end、越出活动窗拒绝。
- 同活动重名前置检查与并发 P2002 兜底。
- 有 pending/pass/waitlisted 报名禁删。
- Admin / self / App 三路报名挂岗位。
- 一人先报 A 岗再报 B 岗仍 21002。
- 岗位满员 → waitlisted，排位按岗位计算。
- 同岗 pass cancel 只递补同岗队首；跨岗不递补。
- 岗位扩容递补该岗 delta；有岗位活动 capacity update 不递补。
- 无岗位活动 create / approve / cancel / waitlist / capacity 全链回归。
- 活动窗内但岗位窗外的 check-in / check-out 拒绝。
- 考勤 record 同理；registrationId=null 临时参加沿活动窗。
- 草稿 roleCode 等于岗位角色；提交后 contribution prefill 命中既有角色规则。
- 活动性别闸与岗位性别闸分别失败，以及两级均通过。

### 12.3 契约与地图

- `EXPECTED_ROUTES` 354→360，逐行登记 6 个新路由。
- OpenAPI snapshot 与 `docs/handoff/openapi.json` 同步；snapshot diff 逐行解释，L3 字段零出现。
- `pnpm docs:rbacmap:check` 证明 permission 206、0 FAIL、0 WARN。
- `pnpm docs:codemap:check` 证明 module 36 恒定并完成地图 true-up。

## 13. 文档 true-up

授权范围内同步：

- `CODEMAP.md`
- `prisma/CLAUDE.md`
- `docs/participation-bounded-context.md`
- `src/modules/activities/CLAUDE.md`
- `src/modules/activity-registrations/CLAUDE.md`
- `src/modules/attendances/CLAUDE.md`
- `docs/handoff/admin-web.md`
- `docs/handoff/miniapp.md`
- `docs/handoff/openapi.json`
- `CHANGELOG.md` 的 `## Unreleased`
- `docs/current-state.md §2`

`AGENTS.md`、`ARCHITECTURE.md`、baseline、V2 红线、api-surface-policy 均保持 0 diff。

## 14. 足迹终态

| 项              | 基线 | 终态 | 证据                                            |
| --------------- | ---: | ---: | ----------------------------------------------- |
| Endpoint        |  354 |  360 | contract `EXPECTED_ROUTES` + runtime OpenAPI    |
| Migration       |   53 |   54 | `prisma/migrations` 目录 + clean replay         |
| NestJS module   |   36 |   36 | codemap                                         |
| Permission code |  206 |  206 | rbacmap                                         |
| AuditLogEvent   |  113 |  113 | union count                                     |
| Cron            |    2 |    2 | `@Cron` grep / codemap                          |
| 字典            |   +0 |   +0 | seed / dictionary diff                          |
| BizCode         |  244 |  250 | `Object.keys(BizCode).length`；6 个新码一一对应 |

## 15. 验收 gates 与终版报告

终态必须全绿：

```text
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:contract
pnpm test:e2e
pnpm docs:rbacmap:check
pnpm docs:codemap:check
pnpm agent:preflight
```

终版报告必须包含：F0～F5 PR / 分支清单；7 条行为前后对照；无岗位活动回归证据；并发 e2e 名称与
输出；岗位 capacity 锁前读变异验证红灯证据；migration SQL 全文与干净库 54 migrations 重放；七项
足迹计数；活动岗位命名 grep；miniapp / admin-web 适配要点；刀 6 收官总结与 29 问剩余台账。
