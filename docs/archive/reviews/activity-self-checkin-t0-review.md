# SRVF 活动自助 GPS 签到 T0 评审稿

> **状态**：FROZEN（2026-07-15）<br>
> **档位**：D 档功能串，F0～F4 串行<br>
> **立项基线**：v0.51.0 / `a3ba0e316718415776821b71305240cde7f56182` / 0 open PR<br>
> **已有依据**：活动模块审计刀 6 第一件 goal-objective（2026-07-15）+ 维护者对首轮冲突简报回复“按推荐”+ 对 live-rule 补充简报回复“按补充推荐”<br>
> **目标**：关闭活动审计项 #3（无自助签到）与 #18（活动经纬度存而不用）

本稿只展开 goal 已拍板内容及维护者对两轮冲突简报确认的推荐口径，不新增本期范围；下列
live-rule 补充决策已由维护者回复“按补充推荐”确认并纳入冻结边界。
实施若发现本稿与 live 代码、`AGENTS.md`、baseline、API surface policy 或 bounded-context 冲突，
必须按 `docs/process.md §4.1` 停止并提交人话简报，不得自行调和。

## -1. Live-rule 补充冻结决策

1. **阶段反漂**：F1/F2/F3 各自独立跑 `pnpm agent:check:full`。F2 同 PR 更新 App
   contract/snapshot/OpenAPI/miniapp handoff 与 CODEMAP/RBAC_MAP，路线 345→348、controller
   69→70；F3 同 PR 更新 Admin 对等项，路线 348→350、controller 70→71。F4 只做最终回归、
   current-state/CHANGELOG 与全量核验，不能补缴前阶段契约/handoff/地图义务。
2. **bounded-context 分阶段窄授权**：F1～F3 各自在对应 PR 更新受保护的
   `docs/participation-bounded-context.md`。F1 只登记 `ActivityCheckIn` 模型、关系、attendances
   ownership、append-only/自有表写边界与“空表尚无 API”；F2 再登记 canonical
   `/api/app/v1/my/*` App surface；F3 再登记 Admin 只读 surface。始终不扩散既有
   cross-aggregate write、无 legacy 对等。
3. **geofence 精度**：Haversine 使用平均地球半径 `6_371_008.8m`；`outOfRange` 用未舍入
   原值执行严格 `rawDistance > radius`，DB distance 另四舍五入到 2 位。accuracy 只作证据，
   不参与半径扩缩。
4. **短签退**：首次 check-out 必须 `now >= checkInAt + 36s`，否则复用 22070；重复已完成签退
   仍按幂等返回 200。这与忘签退 fallback 一起保证正常草稿时长至少 0.01h。
5. **草稿直提保证边界**：只纳入未软删 Member；“原样可提交”证明针对当前 Activity 排期仍兼容、
   计算时长位于 Decimal(5,2) 可存范围且不存在既有/竞态考勤重叠的 clean flow。既有活动排期编辑
   与全局 overlap 守卫不改；不声称草稿能绕过这些既有 submit 约束。
6. **实现边界**：新增 FieldPolicy + Admin application service；FieldPolicy 锁安全 allowlist，Admin
   service 做 authz、QueryService 只查询。App 写事务锁定 Activity 与当前 registration 或做等价条件
   复核，防取消/状态变更并发穿透。
7. **响应契约**：确认本稿 §7 的精确 allowlist（App 本人状态、Admin member 摘要、draft
   records/flags/absent 三段）；raw coordinates 与 accuracy 一律 deny，distance 用 string，
   `serviceHours` 为可原样 POST 的 number。

## 0. TL;DR

1. 第一版只做 GPS 自助签到/签退；不做二维码、补签、改删、自动签退、cron 或通知。
2. 打卡是 append-only 证据层，不是考勤结算层；不改既有 Sheet/Record 写链与两级审批。
3. 仅 App 可用且具有“当前仍 pass”报名的本人可写；管理端只读，复用
   `attendance.read.sheet` + `{ type: 'activity', id }`。
4. App 新端点归 `/api/app/v1/my/*`，遵守本人业务记录 surface；Admin 新端点归既有
   `/api/admin/v1/activities/:activityId/*`。
5. 活动坐标完整有效时用手写 Haversine 计算距离；无坐标、半边坐标或历史非法坐标宽进，
   记 `geoVerified=false`；超半径同样宽进，记 `outOfRange=true`。
6. 原始 GPS 坐标只落 DB，不通过 App/Admin DTO 回显；与 schema 同批补 baseline §8 与 logger redact。
7. live partial unique 锁定 `registrationId`，允许取消旧报名后以新报名重新签到；旧证据不删除。
8. 重复与并发请求在当前闸仍合法时返回同一 winner（HTTP 200）；P2002 不转冲突码。
9. 草稿接口纯只读；`records` 与既有 `CreateAttendanceSheetDto` 运行时同形，缺签退固定填活动
   `endAt`，零打卡者进入独立 `absentRegistrations`，不伪造 absent record。
10. 目标足迹：endpoint 345→350、migration 51→52、permission 恒 206、AuditLogEvent 恒 113、
    cron 恒 2、依赖 0、BizCode 238→240；本 goal 不 bump 版本、不发版。

## 1. 冻结范围与阶段

### 1.1 F0～F4

| 阶段 | 交付 | 硬边界 |
|---|---|---|
| F0 | 本冻结稿 | 单文件 docs PR |
| F1 | `activity_check_ins` 空表、唯一 migration #52、敏感日志屏蔽、测试清表、bounded-context 模型事实/计数 true-up | additive、无回填、无 enum、无 seed；独立 full gate |
| F2 | App 3 端点、geofence、幂等、闸矩阵、单测/e2e + contract/OpenAPI/miniapp handoff/地图 345→348 | App DTO 独立，不改既有 App 活动详情；controller 69→70；独立 full gate |
| F3 | Admin 打卡列表、只读考勤草稿、查询预算、全链 e2e + contract/OpenAPI/admin handoff/地图 348→350 | 不写 Sheet/Record，不改结算通路；controller 70→71；独立 full gate |
| F4 | 最终回归复核、CHANGELOG、current-state、终态 handoff/足迹核验与全门禁 | 不补缴 F2/F3 同 PR 义务；不 bump、不 tag、不 release |

阶段必须串行：前一 PR 合入 `main`、远端同步、worktree clean、0 open PR 后才能启动下一阶段。
F0 另需通过 `git diff --check` 与文内链接核验；F1～F3 每一 PR 都必须独立通过完整门禁，
不得以“F4 再全跑”为由带红合入。

### 1.2 本期明确不做

- 扫码/二维码签到。
- 修改、删除、补录打卡的 App/Admin 端点。
- 自动补签退、任何新 cron、queue 或通知。
- 临时参加者自助签到；临时参加仍由 Admin 在既有考勤结算链事后补录。
- 修改活动详情 DTO 或把坐标塞进既有 App 活动详情。
- 给报名取消新增“已有打卡不可取消”守卫。
- 改动既有 activities / activity-registrations / attendances 状态机、Policy、Guard、通知、
  Sheet/Record submit/edit/review/final-review/reopen 写路径。
- AuditLog 双写、raw GPS export、历史回填、新依赖、新权限码、新 AuditLogEvent。
- `prisma migrate reset`、`prisma db push`，以及任何面向 `app`/生产库的 migrate deploy。

## 2. 产品与生命周期决策

### 2.1 证据层原则

- 一次当前报名最多一条 live `ActivityCheckIn`。
- check-in 创建证据行；check-out 只允许把同一行的 `checkOutAt null → value` 填一次。
- 第一版没有任何打卡改删端点；`deletedAt` 仅作 schema 预留。
- 打卡不写 `AuditLog`：行内签到/签退时间、坐标、精度、距离与 flags 已构成完整证据快照。
- 配置半径日后变化不回算历史；Admin 草稿只读行内 snapshot。
- 打卡只经 Admin 草稿进入结算；正式结算仍走既有考勤单提交、一级审核、终审流程。

### 2.2 取消与重新报名

- 报名取消不受打卡阻挡。
- 取消后旧 `ActivityCheckIn.registrationId` 证据永久保留，但不再属于“当前仍 pass”集合，
  因而不会进入新草稿。
- 同一成员取消旧报名后重新获得新的 pass 报名，可基于新 `registrationId` 创建一条新打卡。
- check-in、check-out 与本人状态读取均以当前 live pass `registrationId` 为锚；旧报名已取消时，
  App 不再通过本接口读取或补写旧行。
- 因此唯一约束不能使用 `(activityId, memberId)`，必须锁当前报名快照 `registrationId`。

### 2.3 数据保留

- GPS 证据与活动考勤证据同生命周期长期保留。
- 退队、账号软删、活动 completed/cancelled 不自动清理打卡证据。
- 第一版不提供清理/删除 API，不新增 retention cron；未来如需保留期限或删除能力，单独做合规评审。

## 3. API surface 与端点

### 3.1 App（3 个）

App 打卡属于当前 linked member 持有的业务记录，统一放在 `/my/*`：

| Method | Path | 语义 |
|---|---|---|
| POST | `/api/app/v1/my/activities/:activityId/check-in` | 本人 GPS 签到；首次与幂等均 200 |
| POST | `/api/app/v1/my/activities/:activityId/check-out` | 本人 GPS 签退；首次与幂等均 200 |
| GET | `/api/app/v1/my/activities/:activityId/check-in` | 本人当前 pass 报名的打卡状态；存在 200，否则 404 |

三端点只走全局 JwtAuthGuard + `AppIdentityResolver`；Admin/SUPER_ADMIN 若关联 active Member，
也只能按本人 self scope 使用，后台角色不扩大数据范围。

### 3.2 Admin（2 个）

| Method | Path | 语义 |
|---|---|---|
| GET | `/api/admin/v1/activities/:activityId/check-ins` | 分页查看打卡证据列表 |
| GET | `/api/admin/v1/activities/:activityId/attendance-sheet-draft` | 生成只读考勤提交草稿 |

两端点均复用：

```text
attendance.read.sheet + { type: 'activity', id: activityId }
```

判权错误优先级镜像既有 `ActivityParticipationQueryService`：优先 `authz.explain`；仅
`resource_not_found` 且全局 `rbac.can` 为真时允许回退后继续做真实 activity 存在性检查。
但新实现不复制其职责混放：Admin application service 负责上述授权编排，再调用只负责
activity 存在性、分页与聚合的 QueryService；QueryService 不做 permission decision。
不新增 permission、seed 或角色绑定。

### 3.3 路由与 DTO 隔离

- App request/response DTO 必须位于 `dto/app/`，不得从 Admin DTO 使用
  `extends` / `Pick` / `Omit` / mapped type 派生。
- Admin DTO 独立声明。
- 新 Controller 放 `src/modules/attendances/controllers/`；只机械注册进 `AttendancesModule`。
- 不改 `ActivitiesModule`、既有 `AppActivitiesController` 或任何既有活动详情 DTO。

## 4. App 准入、状态与时间闸

### 4.1 公共准入顺序

写端点固定按以下顺序执行：

1. JwtAuthGuard。
2. `AppIdentityResolver`：`canUseApp=true` 且 active linked Member；否则通用 `FORBIDDEN=40300`。
3. live Activity 存在；否则 `ACTIVITY_NOT_FOUND`。
4. 根据动作校验 Activity 状态。
5. 查当前 live `statusCode='pass'` 报名；不满足复用 `ATTENDANCE_REGISTRATION_INVALID=22076`。
6. 对当前 registrationId 查询幂等 winner；已完成同一动作则直接返回现状 200。
7. 首次写或未完成 check-out 才校验动作时间窗。
8. 首次写才计算 geofence 并落行/CAS；并发败者重读 winner。

“状态与 pass 闸先于幂等”意味着：首次成功后若活动被取消或报名被取消，重复请求不会绕过
新状态返回历史 200；幂等只承诺当前状态与 pass 闸仍合法时的重复与并发一致性。时间窗只约束
新写入：已经完成的同一动作不会因为客户端重试抵达时间窗外而从 200 退化为错误。

GET 本人状态只做 Jwt/AppIdentity、live Activity、当前 pass 报名与当前 registrationId 行查询，
不以 Activity 四态额外阻断读取；任一状态下有当前 pass + 当前行即 200，无当前 pass 或无行均
返回 `ACTIVITY_CHECK_IN_NOT_FOUND=22002`，不泄露历史已取消报名证据。

### 4.2 状态矩阵

| Activity.statusCode | check-in | check-out | GET 当前状态 |
|---|---|---|---|
| `draft` | 拒：20126 | 拒：20126 | 不做状态闸；当前 pass + 行为 200，否则 22002 |
| `published` | 允许（其余闸通过） | 允许（已有未签退行） | 允许 |
| `completed` | 拒：20030 | 允许（已有未签退行） | 允许 |
| `cancelled` | 拒：20122 | 拒：20122 | 不做状态闸；当前 pass + 行为 200，否则 22002 |

复用码：

- `ACTIVITY_STATUS_INVALID=20030`
- `ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN=20122`
- `ACTIVITY_NOT_PUBLISHED_PARTICIPATION_FORBIDDEN=20126`

### 4.3 时间窗

配置继续复用 `ATTENDANCE_WINDOW_TOLERANCE_HOURS`，记为 `tolerance`。

- check-in：`now ∈ [startAt - tolerance, endAt - 36 seconds]`。
- check-out：`now ∈ [startAt - tolerance, endAt + tolerance]`，且首次签退
  `now >= checkInAt + 36 seconds`；不足 36 秒复用 `ATTENDANCE_SERVICE_HOURS_INVALID=22070`。
- 任何边界外请求复用 `ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW=22077`。
- `endAt - 36s` 是为兼容既有考勤 `serviceHours Decimal(5,2)` 最小 `0.01h` 与
  “忘签退固定填 endAt”而冻结的保守充分阈值：它保证原始跨度本身至少 `0.01h`，不是
  `Math.round` 两位小数算法能够产出 `0.01` 的数学最小秒数；该阈值保证 fallback record 稳定直提。
- 若活动本身短到上述签到区间为空，则签到统一按时间窗外拒绝，不修改既有考勤算法。

## 5. 位置输入、geofence 与敏感数据

### 5.1 App 入参

check-in 与 check-out 共用独立 App location DTO：

| 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| `longitude` | number | 是 | `[-180, 180]`，最多 7 位小数 |
| `latitude` | number | 是 | `[-90, 90]`，最多 7 位小数 |
| `accuracy` | number | 否 | `[0, 99_999_999.99]`，最多 2 位小数；单位米，对齐 Decimal(10,2) |

客户端拒绝定位/缺少任一经纬度时由 DTO + 全局 ValidationPipe 返回 400；P4“宽进”只适用于
活动侧无可用坐标或计算后超距，不豁免队员拒绝提交位置。

### 5.2 配置

新增 `ATTENDANCE_CHECKIN_RADIUS_METERS`：

- 未设置默认 `500`。
- 只接受正整数，范围 `[50, 10000]`。
- 归 `src/config/app.config.ts` 的 `AttendanceConfig.checkInRadiusMeters`。
- 同步 `.env.example`；业务代码不得直读 `process.env`。

### 5.3 Haversine

- 手写纯函数，不引入依赖。
- 输入/活动坐标均按 WGS84 十进制度数。
- Prisma Decimal 坐标先显式转为有限 `number`，Haversine 计算值是 IEEE-754 数值近似。
- 使用平均地球半径 `6_371_008.8m`。
- 对中间 haversine `a` clamp 至 `[0,1]`，防浮点误差产生 NaN。
- `outOfRange` 使用未舍入的 IEEE-754 计算值执行严格 `rawDistance > radius`；计算值 `<= radius`
  视为范围内，不宣称浮点结果能证明数学精确相等。DB distance 另按 half-up 四舍五入到 2 位
  小数作为 snapshot，展示精度不反向改写 geofence 判定。
- `accuracy` 只留证据，不参与 radius 扩缩。

### 5.4 活动坐标判定

只有以下条件全部满足才计算距离：

- `locationLongitude` 与 `locationLatitude` 均非 null；
- longitude ∈ `[-180,180]`；
- latitude ∈ `[-90,90]`。

缺一、均缺或历史非法值一律宽进：

```text
distance = null
geoVerified = false
outOfRange = false
```

坐标完整有效时：

```text
distance = rounded Haversine meters
geoVerified = true
outOfRange = raw Haversine distance > configured radius
```

单一 `geoVerified/outOfRange` 是 **check-in 时刻快照**。check-out 只追加自己的坐标、精度、
距离，不回写或重算两个 check-in flags。

### 5.5 敏感字段三问与最小回显

1. **业务用途**：仅用于活动现场 geofence 与事后考勤证据复核。
2. **查看角色**：原始 longitude/latitude 只落 DB，不通过 App/Admin API 返回；App 本人只见
   时间、距离和 flags，Admin 持 `attendance.read.sheet` 只见成员摘要、时间、距离和 flags。
3. **保存期限**：与活动考勤证据同生命周期长期保留；第一版无自动/人工 API 清理，退队或账号
   软删不自动删除。未来改变须重新做合规与 retention 评审。

F1 与 schema 同批：

- additive 更新 `docs/srvf-foundation-baseline.md §8`，登记位置轨迹类别与实际字段名；
- 更新 `src/bootstrap/logger-options.ts` 与单测，至少覆盖请求 `longitude/latitude` 以及
  `checkInLongitude/checkInLatitude/checkOutLongitude/checkOutLatitude`；
- censor 仍为 `[REDACTED]`，不输出长度或坐标片段。

## 6. Schema 与 migration 决策

### 6.1 新模型

Prisma model：`ActivityCheckIn`；物理表：`activity_check_ins`。

| 字段 | Prisma / DB | NULL | 语义 |
|---|---|---|---|
| `id` | String / TEXT | 否 | cuid 主键 |
| `createdAt` | DateTime / TIMESTAMP(3) | 否 | `now()` |
| `updatedAt` | DateTime / TIMESTAMP(3) | 否 | `@updatedAt` |
| `deletedAt` | DateTime / TIMESTAMP(3) | 是 | 预留；本期无写入口 |
| `activityId` | String / TEXT | 否 | FK → Activity，Restrict |
| `memberId` | String / TEXT | 否 | FK → Member，Restrict |
| `registrationId` | String / TEXT | 否 | 当前 pass 报名快照；FK → ActivityRegistration，Restrict |
| `checkInAt` | DateTime / TIMESTAMP(3) | 否 | 服务端 now，无 DB default |
| `checkOutAt` | DateTime / TIMESTAMP(3) | 是 | 服务端首次签退 now |
| `checkInLongitude` | Decimal(10,7) | 是 | 签到 longitude snapshot |
| `checkInLatitude` | Decimal(10,7) | 是 | 签到 latitude snapshot |
| `checkInAccuracy` | Decimal(10,2) | 是 | 签到 accuracy，米 |
| `checkInDistance` | Decimal(10,2) | 是 | 签到 distance，米 |
| `checkOutLongitude` | Decimal(10,7) | 是 | 签退 longitude snapshot |
| `checkOutLatitude` | Decimal(10,7) | 是 | 签退 latitude snapshot |
| `checkOutAccuracy` | Decimal(10,2) | 是 | 签退 accuracy，米 |
| `checkOutDistance` | Decimal(10,2) | 是 | 签退 distance，米 |
| `geoVerified` | Boolean | 否 | check-in 时是否完成活动坐标校验；service 显式写 |
| `outOfRange` | Boolean | 否 | check-in 时是否超半径；default false |

Activity / Member / ActivityRegistration 只增加 Prisma 反向 relation，不改变既有业务字段。

### 6.2 索引与唯一约束

普通单列索引：

```text
activityId / memberId / registrationId / checkInAt / deletedAt / createdAt
```

Prisma DSL 不支持 partial unique，migration 末尾手写：

```sql
CREATE UNIQUE INDEX "activity_check_ins_registration_active_unique"
ON "activity_check_ins" ("registrationId")
WHERE "deletedAt" IS NULL;
```

不再建立 `(activityId, memberId)` live unique。

### 6.3 `@@map` 窄例外

本 goal 明确要求物理表名 `activity_check_ins`，维护者已在冲突简报中确认推荐口径，因此本模型
获一次性窄例外使用 `@@map("activity_check_ins")`。不修改任何既有 model 的 `@map/@@map`，
不把该例外推广到其它 schema 工作。

### 6.4 migration 与数据库授权

- 唯一 migration：`YYYYMMDDHHMMSS_add_activity_check_ins`，累计 52。
- 纯 additive 空表，无回填、无数据删除、无 enum、无 seed 变化、无不可逆 SQL。
- F1 仅允许创建/销毁 `app_migration_generate` 与 `app_migration_check`，并允许 `migrate dev`
  使用其临时 shadow DB；禁止触碰 `app`。
- F2～F4 contract/e2e 可经现有 `assertTestDatabaseUrl` 保护的 global setup，仅对 `app_test`
  自动执行 `migrate deploy` 与测试清表。
- 仍禁止手工/非测试库 deploy、`migrate reset` 与 `db push`。
- F1 必须把 `activity_check_ins` 加入 `test/setup/reset-db.ts` 显式 TRUNCATE 清单，并同步
  `CODEMAP.md` 与 `prisma/CLAUDE.md` 的 migration 51→52 事实行；`prisma/seed.ts` 零改。
- 新 migration SQL 全文必须进入 F1 PR 描述；另附 `app_migration_check` 从空库完整重放
  52 migrations、FK/普通索引/partial unique introspection 与 `migrate status` 证据。

## 7. DTO 与响应字段锁

### 7.1 App 响应

App 三端点统一返回当前本人安全视图：

```text
id
activityId
registrationId
checkInAt
checkOutAt
checkInDistance
checkOutDistance
geoVerified
outOfRange
createdAt
updatedAt
```

- Date → ISO 8601 字符串。
- Decimal distance → string 或 null，避免 JSON 浮点漂移。
- 不返回 `memberId`、任一 longitude/latitude、任一 accuracy、`deletedAt` 或其它 Member 字段。

### 7.2 Admin 打卡列表

分页固定 `PaginationQueryDto` / `PageResultDto`，默认 `createdAt desc`。item 只含：

```text
id / activityId / registrationId
member { id / memberNo / displayName }
checkInAt / checkOutAt
checkInDistance / checkOutDistance
geoVerified / outOfRange
createdAt / updatedAt
```

不返回原始坐标、accuracy 或其它 Member PII。

### 7.3 Admin 草稿

响应最小结构：

```text
activityId
records[]
flags[]
absentRegistrations[]
```

`records[]` 每项与既有 `AttendanceRecordInputDto` 可直接提交的字段同形，但 DTO 独立声明：

```text
memberId
roleCode = "member"
checkInAt
checkOutAt
serviceHours（number，最多 2 位小数；不得序列化为 Decimal string）
attendanceStatusCode = "present"
registrationId
```

刻意不输出 `contributionPoints`，让既有 submit 继续执行原有 ContributionRule 预填。

`flags[]` 用 `registrationId + memberId` 稳定关联 record：

```text
registrationId / memberId / noCheckOut / outOfRange / unverified
```

`absentRegistrations[]` 只列当前仍 pass 且零打卡者：

```text
registrationId / memberId / memberNo / displayName
```

absent 不伪造成 AttendanceRecord；既有字典仍只有 present/late/early_leave。

## 8. 草稿算法与提交兼容

1. Admin application service 先按既有错误优先级完成 `attendance.read.sheet` 判权。
2. QueryService 校验 activity 存在。
3. 一次查询当前 live pass registrations，并限定关联 Member `deletedAt=null`；软删 Member
   不进入 records 或 absent。
4. 一次查询这些 registrationId 的 live check-ins。
5. 一次查询成员摘要；禁止 map 内 N+1。
6. 只有存在 check-in 的当前 pass 报名进入 `records`。
7. 有 `checkOutAt` 时原样使用；无签退时 `checkOutAt = activity.endAt`，并记
   `noCheckOut=true`。
8. `serviceHours` 使用与既有考勤相同的小时数两位小数，并作为 JSON number 输出；只有
   `[0.01, 999.99]` 的 Decimal(5,2) 可存范围属于“原样可提交”保证。
9. `attendanceStatusCode='present'`、`roleCode='member'`；Admin 可在提交前编辑。
10. `outOfRange`/`unverified` 只读行内 snapshot，不按当前半径重算。
11. 已取消报名的旧打卡按 registrationId join 自然出局。

边界：

- `records=[]` 时仍返回 200 + absent 清单，前端不得调用既有 Sheet POST。
- `records.length <= 200` 且符合下述 clean-flow 前提时可原样提交。
- `records.length > 200` 时前端按既有 `ArrayMaxSize(200)` 分批提交多个 Sheet；后端草稿不截断、
  不伪造分页遗漏，也不修改既有 200 上限。
- “原样可提交”是 clean-flow 保证：证据时间仍兼容当前 Activity 排期、时长可存、Member 未软删，
  且不存在已有或竞态创建的跨 Sheet/跨活动考勤时间重叠。草稿不绕过既有 Activity 编辑能力、
  `TimeOverlapPolicy` 或 submit 时的最终校验；这些前提不成立时由 Admin 编辑/处置后再提交。
- F3 e2e 必须真实执行“GET draft → 原样 POST 既有 attendance-sheets → pending Sheet 成功”，
  在上述 clean flow 证明时间窗、字典、member/registration/activity 三元校验兼容。

## 9. 幂等、并发与事务

### 9.1 check-in

- 锁序固定为 Activity → 当前 registration，二者优先用 PostgreSQL `FOR SHARE`：允许同活动不同
  队员并发写，同时阻断活动/报名更新穿透；若实现改用更强锁也必须保持同一锁序。
- 锁前查询只作快速失败；首次写在事务内取得两把锁后立即捕获唯一 authoritative `now`，
  再在锁保护下重读并用该值重跑 Activity 状态/排期、当前 pass、existing-row 与时间窗闸，
  最后写入 `checkInAt`。
  禁止沿用锁外时间或锁前快照，否则等待锁期间可能越过时间边界。
- 锁后已有当前 registration live row 时直接返回 200；否则才计算 geofence 并创建。
- 禁止在 READ COMMITTED 下只信锁前查询，或让并发取消/状态变化穿透已完成的闸判断。
- 并发败者若命中 partial unique P2002，必须退出失败事务后重查 winner；winner 存在则返回同一 DTO 200。
- 不新增 ALREADY_EXISTS BizCode，不把 P2002 暴露为 409。

### 9.2 check-out

- 同样按 Activity → 当前 registration 的固定 `FOR SHARE` 锁序；取得两把锁后立即捕获唯一
  authoritative `now`，再在锁保护下重读并重跑所有可变闸与 existing row；该值同时用于
  时间/36 秒校验与 `checkOutAt` 落行。
- 锁后当前 registrationId 无行抛 `ACTIVITY_CHECK_OUT_REQUIRES_CHECK_IN=22078`。
- 已有 `checkOutAt` 直接返回现状 200，不重算/覆盖首次签退坐标和距离。
- 首次签退在同一事务内校验距 check-in 至少 36 秒；锁前时间/状态结果不得作为最终依据。
- 首次签退用 `updateMany({ where: { id, checkOutAt: null } })` CAS；并发败者 count=0 后重查 winner。
- check-out 更新只补 check-out 字段，不改 check-in 字段、`geoVerified` 或 `outOfRange`。

### 9.3 查询预算

权限解析查询与业务取数分开报告。

- Admin 列表业务取数固定 4 次：activity、page rows、count、members IN。
- Admin 草稿业务取数固定 4 次：activity、registrations、check-ins、members IN。
- 所有 App 写/读为常数查询；不得随结果条数增加。

## 10. BizCode 冻结

### 10.1 新增 2 个（238→240）

| 常量 | code | HTTP | message | 用途 |
|---|---:|---:|---|---|
| `ACTIVITY_CHECK_IN_NOT_FOUND` | 22002 | 404 | `活动打卡记录不存在` | GET 当前本人打卡无行/无当前 pass |
| `ACTIVITY_CHECK_OUT_REQUIRES_CHECK_IN` | 22078 | 409 | `请先完成签到再签退` | 当前 pass 尚无签到即请求签退 |

### 10.2 复用

| 常量 | code | 用途 |
|---|---:|---|
| `BAD_REQUEST` | 40000 | DTO 坐标/accuracy/白名单错误 |
| `FORBIDDEN` | 40300 | canUseApp=false |
| `ACTIVITY_NOT_FOUND` | 20001 | activity 不存在或软删 |
| `ACTIVITY_STATUS_INVALID` | 20030 | completed 新签到等 wrong-state |
| `ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN` | 20122 | cancelled 打卡写 |
| `ACTIVITY_NOT_PUBLISHED_PARTICIPATION_FORBIDDEN` | 20126 | draft 打卡写 |
| `ATTENDANCE_REGISTRATION_INVALID` | 22076 | 无当前 pass 报名 |
| `ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW` | 22077 | 签到/签退时间窗外 |
| `ATTENDANCE_SERVICE_HOURS_INVALID` | 22070 | 首次签退距签到不足 36 秒 |
| `RBAC_FORBIDDEN` | 30100 | Admin 无 attendance.read.sheet |

P2002 不对应新码；无 throw path 的码禁止预埋。

## 11. 模块与职责边界

实现归 `src/modules/attendances/`，不新增第五个 participation 模块：

```text
controllers/app-activity-check-ins.controller.ts
controllers/admin-activity-check-ins.controller.ts
dto/app/activity-check-in-location.dto.ts
dto/app/app-activity-check-in.dto.ts
activity-check-ins.dto.ts
app-activity-check-ins.service.ts
admin-activity-check-ins.service.ts
activity-check-in-query.service.ts
activity-check-in-policy.ts
activity-check-in-field-policy.ts
activity-check-in-presenter.ts
haversine-distance.ts
```

- App service 是 check-in/check-out transaction owner。
- Admin application service 是 authz 编排边界；授权通过后才调用 QueryService。
- `ActivityCheckIn` 是 attendances 拥有的 append-only evidence；本功能写入只落该自有表。
  对 Activity/ActivityRegistration 的查询、锁定与条件复核不修改两者，不扩散现有
  cross-aggregate write 许可。
- 三个 App 端点是全新 canonical `/api/app/v1/my/*` 能力，无 legacy 对等路径、alias 或双写。
- Policy 只承载动作状态/时间合法性，不塞 RBAC。
- QueryService 只承载 Admin list/draft 的分页、批量查询与只读聚合，不做 permission decision。
- FieldPolicy 集中定义 App/Admin safe select 与响应 allowlist，明确 deny raw coordinates、accuracy、
  `memberId`（App）及其它 Member PII；Presenter 必须消费该 policy。
- Presenter 是 Prisma row → App/Admin DTO 的唯一映射边界，负责 Decimal/Date 与字段最小化。
- Haversine 是无 Nest/Prisma/config 依赖的纯函数。
- 只修改 `attendances.module.ts` 注册新 controller/provider；不注入或修改 `AttendancesService`。
- 本期无 StateMachine/AuditRecorder/Effect：证据只存在 create 与单向 CAS 两种写形态，且明确不 audit、无副作用。

## 12. 测试与验收矩阵

### 12.1 Unit

- Haversine：同点、已知纬度距离、对称性、国际日期变更线、近极点、半径边界、有限非负。
- Policy：四 activity 状态、签到/签退上下边界、签到与首次签退 36 秒 floor、completed 可退不可签。
- FieldPolicy/Presenter：精确字段集、Decimal string、raw 坐标/accuracy/memberId 永不回显。
- QueryService：列表/草稿固定查询次数，authz activity ref，无 N+1。

### 12.2 App e2e

- 未登录、canUseApp=false、未绑定/Inactive Member。
- 无报名、pending/reject/cancelled 报名均拒；当前 pass 成功。
- draft/cancelled/completed 新签到拒；completed 已有签到可签退。
- 时间窗前后拒；`endAt-36s` 与 `checkInAt+36s` 边界；缺坐标/越界/accuracy 超界/夹带字段 400。
- 活动无坐标/半坐标/历史非法坐标 → 200 + unverified。
- 同点范围内、半径等值、超距 → 200 + 正确 snapshot。
- 重复签到/签退 200；签退不覆盖首次 snapshot。
- 8 路并发 check-in 全 200、同 id、DB live row=1；并发 check-out 单 CAS winner。
- GET 无行 404、有行 200、他人行不泄露。
- 取消旧报名后旧行出局；新 pass registration 可新建另一行。

### 12.3 Admin 与草稿 e2e

- 无权限 30100；GLOBAL/scoped activity ref inside/outside 矩阵。
- 列表分页、排序、成员摘要、距离/flags，精确断言无 raw 坐标/accuracy。
- 草稿完整签退、忘签退、outOfRange、unverified、取消出局、零打卡 absent。
- 草稿 GET 前后 Sheet/Record count 不变，证明只读。
- `draft.records` 原样 POST 既有 attendance-sheets 成功；生成 pending Sheet 与正确 Records。

### 12.4 Contract 与足迹

- F0：`git diff --check` 通过，文内相对链接逐一可解析。
- F1：52 migrations 干净库 replay/status/introspection、logger redaction 定向验证与
  `pnpm agent:check:full` 独立全绿；CODEMAP 与 `prisma/CLAUDE.md` 同 PR 51→52。
- F2：`EXPECTED_ROUTES` 345→348、controller 69→70；同 PR 更新 `EXPECTED_SCHEMAS`、contract
  Jest snapshot、`docs/handoff/openapi.json`、miniapp、CODEMAP/RBAC_MAP 阶段事实与
  `docs/participation-bounded-context.md` App surface。跑本阶段 targeted e2e、`pnpm test:contract`、
  live `/api/docs`/`/api/docs-json` 及 `pnpm agent:check:full`。
- F3：`EXPECTED_ROUTES` 348→350、controller 70→71；对 Admin 的 schemas、两类 snapshot、
  admin handoff、CODEMAP/RBAC_MAP、bounded-context Admin surface 履行同样的同 PR 更新，
  并跑 targeted e2e、contract、live docs 与 `pnpm agent:check:full`。
- F4 只复核终态 350 与做最终回归；不得把 F2/F3 漏掉的 route/schema/snapshot/handoff/地图
  更新延期到 F4。
- migration=52、endpoint=350、controller=71（69→71）、module=35、permission=206、role=9、
  AuditLogEvent=113、cron=2、BizCode=240。
- `docs:rbacmap:check` / `docs:codemap:check` / lint / typecheck / build / unit / contract / full e2e 全绿。
- full e2e 必须在 CI 25 分钟上限内完成。
- Haversine production callsite 是关闭审计 #18 的必要证据；只有 unit helper 不算关闭。

## 13. Handoff 与文档收口

### 13.1 miniapp

- 定位权限请求、拒绝定位时不发请求、重新授权指引。
- 按钮态：未签到 → 可签到；已签到未签退 → 可签退；已签退 → 已完成。
- 明确 22002/22076/22077/22078/20030/20122/20126 的初始化与用户提示。
- 超距与 unverified 都是成功态告警，不当作失败重试。
- 网络重试可安全依赖 200 幂等。

### 13.2 admin-web

- `check-ins` 用于证据复核，raw GPS 不提供。
- `attendance-sheet-draft` → 本地编辑 records/flags 告警 → 既有 POST attendance-sheets。
- 读取需 `attendance.read.sheet`；真正提交另需既有 `attendance.create.sheet`。
- absent 不伪造 record；空 records 禁止提交；超过 200 分批。

### 13.3 收口文件

- F1：`docs/participation-bounded-context.md` 只登记模型/关系/ownership/自有表写边界与“空表尚无
  API”，另同 PR 更新 baseline §8、logger redact、`test/setup/reset-db.ts`、`CODEMAP.md` migration
  事实与 `prisma/CLAUDE.md` migration 事实。
- F2 同实现 PR：`docs/handoff/miniapp.md`、contract/snapshot、`docs/handoff/openapi.json`、
  CODEMAP/RBAC_MAP 中 App controller/endpoint 阶段事实，以及 bounded-context canonical App surface。
- F3 同实现 PR：`docs/handoff/admin-web.md`、contract/snapshot、`docs/handoff/openapi.json`、
  CODEMAP/RBAC_MAP 中 Admin controller/endpoint/authz 阶段事实，以及 bounded-context Admin 只读 surface。
- F4：`CHANGELOG.md` Unreleased、`docs/current-state.md §2`，并最终复核两份 handoff/OpenAPI/地图；
  若发现 F2/F3 同 PR 义务漏缴，按停止规则处理，不在 F4 兜底补写。
- permission 仍恒 206；RBAC_MAP 只同步 endpoint/controller 映射，不新增 permission。

## 14. 停止规则

出现下列任一情况立即停止：

- 需要改既有 Sheet/Record 写路径、活动详情契约、报名取消守卫，或超出 F1～F3 已获分阶段
  窄授权的 protected bounded-context 事实同步。
- 需要新增 permission、AuditLogEvent、cron、notification、dependency、enum、回填或第二条 migration。
- migration 不再是纯 additive 空表，或干净库 52 migration replay 不通过。
- F0～F4 任一阶段需要与下一阶段混 PR 才能过门禁。
- raw GPS **值**将进入响应 DTO、日志、audit、OpenAPI/contract example 或 handoff 示例；
  OpenAPI request schema 必须声明 longitude/latitude 字段但不得给真实/固定坐标 example，DB evidence
  snapshot 是本功能明确允许的唯一原始坐标值落点。
- 实现无法同时满足当前 pass、时间窗、幂等与 draft 原样提交。

此时必须按 `docs/process.md §4.1` 提交人话简报，等待维护者重新拍板。
