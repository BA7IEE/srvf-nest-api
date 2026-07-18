# attendances — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);上下文边界读 [`/docs/participation-bounded-context.md`](../../../docs/participation-bounded-context.md);架构边界读 [`/docs/architecture-boundary.md`](../../../docs/architecture-boundary.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## 本地事实

- `attendances.service.ts` 是 **god-service(1781 行,P1-4 第一刀后)**;`attendance-sheet-state-machine.ts` / `attendance-audit-recorder.ts` / `time-overlap-policy.ts` / `contribution-calculator.ts` / `attendance-presenter.ts`(P1-4 第一刀,2026-06-10)已抽离。
- 响应序列化必须走 `attendance-presenter.ts`(Sheet 详情 / 列表项 / Record 含 member 摘要 / Decimal→string),**不**在 service 内重新手写字段映射;select 查询策略仍留 service(归未来 QueryService 议题,第二刀另行立项)。
- `attendance_sheets` **5 态**(含终审);`attendance_records` 子表。
- 状态变更必须经过 `attendance-sheet-state-machine.ts`,**不**在 service 内裸写态迁移。
- `submit` 只创建 pending Sheet；**不得**跨 aggregate 直写 `Activity.statusCode='completed'`。活动完结唯一通路是 activities 模块的管理端 `complete` action。
- 业务写路径必须走 `attendance-audit-recorder.ts` 写入 `AuditLogEvent`。
- **时间重叠并发保护(v0.44.0 finding #7)**:submit/edit 在跨 Sheet 重叠查询前,由 `TimeOverlapPolicy.lockMembersForOverlapCheck` 按排序去重的 memberId 获取 PostgreSQL transaction advisory lock;同人并发写必须串行,不得移到事务外或删掉锁后只保留 read-before-write。
- **受保护状态写(2026-07-13 finding #6;v0.47.0 F2)**:`edit`/`softDelete` 在读取或软删 `attendance_records` 前统一调用 [`/src/common/prisma/claim-at-status.util.ts`](../../common/prisma/claim-at-status.util.ts) `claimAtStatus`,确保 Sheet 仍处 `pending`;败者复用 `ATTENDANCE_SHEET_STATUS_INVALID`,且不得先破坏子行。`approve`/`reject`/`finalApprove`/`finalReject`/`reopen` 的内联 CAS 保留;合法迁移矩阵仍只在 `attendance-sheet-state-machine.ts`。
- **submit × registration 并发不变式**:submit 先对 Activity `FOR SHARE`，批量校验后按 registrationId 排序去重调用公共 `claimAtStatus(expected=pass)`；与 pass cancel 保持 Activity → Registration 锁序。submit 先认领时，后到取消必须在 records 提交后由既有 `ACTIVITY_REGISTRATION_HAS_ATTENDANCE=21033` 拒绝，禁止留下 cancelled + live record
- **资格链完整性(C-QUAL)**:Admin submit/edit 每次用同一个服务端 `now` 拒绝 `checkOutAt > now`(22079),App 自助签到位置收紧见下方 GPS fail-closed 条目。`AttendanceRecordInputDto` 不接受 `contributionPoints`;submit/edit 均调 `ContributionCalculator`,无匹配规则落 0。`requiresInsurance=true` 时每条 record 必须带同活动/同成员/pass 的 `registrationId`;false 时仍可空。当前 attendance 只校验提交时的活动开关与报名关联,不能证明该报名创建时 `requiresInsurance=true`,不追溯旧报名,也不代表保险独立核验。
- **已知边界(finding #8,接受记录)**:数据库层未加 `btree_gist` / range exclusion constraint;原因是本仓首个 DB 扩展、托管库可用性未验且触发极罕见。当前只承诺应用写路径的事务 advisory lock;直连 SQL 绕过应用不在此保证内。
- **终审/撤回判权(终态 scoped-authz PR9 + v0.47.0 F2)**:`finalApprove`/`finalReject`/`reopen` 走 `assertFinalReviewAuthzOrThrow`(`authz.explain` 带 ref)。三动作的权限来源均为 scoped `attendance-final-reviewer` 或 SUPER_ADMIN,biz-admin 不持码;只有 `finalApprove` 咬合自审 22074 / 一级同人 22075,`finalReject`/`reopen` 不受这两条约束。sheet 不存在 → 回退 `rbac.can`(持码者进事务抛 22001,无码者 30100 防枚举),其余 deny → 30100。角色码集为 `attendance.{read,final-approve,final-reject,reopen}.sheet`;e2e 矩阵在 `test/e2e/attendances-final-review-authz.e2e-spec.ts`。
- **其余调用位点判权(终态 scoped-authz PR12 + v0.49 部门范围)**:`submit`/`list`(嵌套 `:activityId`)带 `{type:'activity', id: activityId}`;`findOne`/`reviewDetail`/`edit`/`softDelete`/`approve`/`reject` 带 `{type:'attendance_sheet', id}`;`listRecordsForMemberAdmin`/`getMemberContributionSummary` 带 `{type:'member', id: memberId}`;`listAllSheetsForAdmin` 通过 `getVisibleOrganizationScope` 按 `activity.organizationId` 下推并与用户组织筛选取交集。`resource_not_found` 回退同 PR9 范式:持全局码者交回既有 NOT_FOUND,无码者 30100。scoped 生效 e2e 在 `test/e2e/participation-scoped-authz.e2e-spec.ts`。
- **活动岗位时段接线(2026-07-16 F4)**:App 签到/签退在既有 Activity→Registration 锁序和锁后重读内，从 `registration.activityPosition` 选择岗位 `startAt/endAt`；无岗位或岗位未配置独立时段才回退活动窗，`ActivityCheckInPolicy` 纯函数签名不变。考勤 submit/edit 的批量 registration IN 预取同样按每条记录选择岗位窗；`registrationId=null` 仅在 `requiresInsurance=false` 时继续走活动窗。`attendance-sheet-draft` 从报名岗位带出 `attendanceRoleCode`，无岗位为 `member`；忘签退时岗位报名回退岗位 `endAt`，从而提交后继续由既有 `activityTypeCode × roleCode` 规则计算贡献值。不得改成逐条查询或重新堆一套贡献计算。
- **GPS 位置 fail-closed(2026-07-18 D-GPS)**:`ActivityCheckInLocationPolicy` 是唯一 geofence 判定源；首次 App 签到/签退只有活动坐标与通过 DTO 的请求坐标均完整合法、且未舍入 Haversine 距离 `<= attendance.checkInRadiusMeters` 才写。活动定位异常/策略层非法坐标/超范围统一 22080，请求 DTO 缺失或非法沿 40000，均零 `ActivityCheckIn`/Sheet/Record/Audit 派生写。`accuracy` 只落证据，不扩缩半径。已有合法 winner 仍在位置判定前幂等返回 200，非法重试不得覆盖快照；新签到行固定 `geoVerified=true/outOfRange=false`，历史异常字段/行与 Admin 只读草稿、手工考勤路径均保留不改。

## 不要做(踩雷区)

- ❌ **不**主动拆 `attendances.service.ts`(characterization tests 已落地,但拆分本身需单独立项,沿 [`/docs/current-state.md §3`](../../../docs/current-state.md))。
- **Controller 现状**:`attendances.controller.ts` 仅 2 个 Admin class(`AttendanceSheetsCollectionController` + `AttendanceSheetsResourceController`,前缀 `admin/v1/*`);队员自助考勤记录(原 `/v2/users/me/attendance-records`)现位于 [`controllers/app-my-attendance-records.controller.ts`](controllers/app-my-attendance-records.controller.ts)(`@Controller('app/v1/my')`,`GET /attendance-records`)。历史 legacy controller(`attendances-me-records-legacy.controller.ts`)已于 Route B Phase 4d2 删除。
- ❌ **不**借此继续移动 Admin controller(`AttendanceSheetsCollectionController` / `AttendanceSheetsResourceController` 留在 `attendances.controller.ts`),除非另有设计决议。
- ❌ **不**改 App endpoint `GET /api/app/v1/my/attendance-records` 的 path / method / tag / roles / DTO / service call(contract-locked;改任一项升档并须显式更新 snapshot)。
- ❌ **不**借此启动 `attendances.service.ts` 拆分(沿上一条 god-service 禁条与 [`/docs/api-surface-policy.md §8`](../../../docs/api-surface-policy.md))。
- ❌ **不**在无 contract 审批下改 OpenAPI snapshot(沿 [`/docs/api-surface-policy.md §8`](../../../docs/api-surface-policy.md);改 path / DTO / schema 必须显式更新 snapshot 并升档)。
- ❌ **不**新增 Mixed Controller(class-level + 方法级双 `@ApiTags`)。
- ❌ **不**绕过 state-machine / audit-recorder 直接改 sheet 状态。
- ❌ **不**把 admin DTO 用 `extends` / `Pick` / `Omit` 派生为 App DTO(沿 §19.7 D-6);App DTO 进 `dto/app/`。
- ❌ App 视角 endpoint 进 `controllers/app-*.controller.ts`,where 子句永远用 `currentUser.memberId` 锁定本人。
