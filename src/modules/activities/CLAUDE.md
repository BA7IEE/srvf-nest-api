# activities — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);上下文边界读 [`/docs/participation-bounded-context.md`](../../../docs/participation-bounded-context.md);架构边界读 [`/docs/architecture-boundary.md`](../../../docs/architecture-boundary.md);API surface 边界读 [`/docs/api-surface-policy.md`](../../../docs/api-surface-policy.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## Scope

- **活动主资源**:create / update / publish / cancel / complete 生命周期管理
- **活动岗位子资源**:`ActivityPosition` 归本模块；Admin CRUD 走 `AdminActivityPositionsController` + `ActivityPositionsService`，不新建 NestJS module
- **状态机 4 态**:`draft → published → completed`，另有 `draft|published → cancelled`;`completed` 的**唯一推进通路**是管理端 `POST admin/v1/activities/:id/complete` 经本状态机执行。考勤提交只建 pending Sheet，禁止再直写 Activity 状态。
- **App 视角**:`AppActivitiesService` 的可参加池仅含 published + 公开报名 + 未结束活动；detail 刻意仍以 published 可见；`GET :activityId/positions` 只认 published + 公开报名活动，返回 live 岗位余量 / `canRegister`。`AppMyActivitiesService` 暴露本人参与过的活动列表(按 `memberId` 锁定)
- **不负责**:报名状态(`activity-registrations/`)、考勤(`attendances/`)、贡献值结算(`contribution-rules/` + `attendances/contribution-calculator.ts`)

## Local facts

- `activities.service.ts` **1206L**(偏厚,沿 CODEMAP 标 L 体量);活动岗位 CRUD/扩容递补已边界化为 `activity-positions.service.ts`(500L) + `activity-position-audit-recorder.ts`，不继续堆入主 service；`activity-state-machine.ts` / `activity-audit-recorder.ts` / App 两 service 已抽离
- **判权(终态 scoped-authz PR12,2026-07-02;v0.40.0 +complete)**:6 个写方法(create/update/delete/publish/cancel/**complete**)判权走 `assertCanOrThrow` → `authz.explain`;`create` 无 ref(GLOBAL-only,scoped 创建留后续批);`update`/`delete`/`publish`/`cancel`/`complete` 带 `{type:'activity', id}` ref(scoped 持有者〔如 team-leader 经 policy→org-admin@TREE〕在其组织树内可用);`resource_not_found` 回退 `rbac.can` 全局码判定,持码者 return 交回 `findActivityOrThrow` 抛既有 `ACTIVITY_NOT_FOUND`,无码者 30100;`list`/`findOne`/`options`(F1/A6 新增)仍无码仅登录(Slow-4 现状不变;RBAC_MAP §2.4 BD-3 已决 won't-do 新增 `activity.read.*` 码)。e2e 见 `test/e2e/participation-scoped-authz.e2e-spec.ts`。
- **App 可报名池 endAt 过滤(v0.40.0 参与域生命周期收口③)**:`AppActivitiesService.listAvailableForMember` where 追加 `endAt >= now`——已结束(endAt < now)的 published 活动退出可报名列表;`findVisibleByIdForMember`(detail)口径**刻意不动**(published 即可见,已报名者回看已结束活动无碍)。报名 endAt 闸在 `activity-registrations` 侧 `assertActivityRegistrable`(20125),不在本模块。
- **F1/A6(2026-07-04,路线图 §4 A6)**:list 新增可选 `q`(模糊 title)/`dateFrom`+`dateTo`(startAt 区间)/`includeDescendants`(配合 organizationId,注入 `OrganizationsService.queryDescendantOrgIds()`)/`includeStats`(默认 false;true 时批量 `groupBy` 聚合 `registrationCount`/`attendanceSheetCount`,禁 N+1);新增 `GET /options`(`q?`/`statusCode?`/`organizationId?`/`limit?` → `{items:[{id,label,startAt,statusCode}]}`,USER 角色同样强制白名单状态防泄漏)。0 新权限码、0 schema。
- Admin Controller:`activities.controller.ts` `@Controller('admin/v1/activities')` `@ApiTags('Admin - Activities')`
- Admin 岗位 Controller:`controllers/admin-activity-positions.controller.ts` 同前缀嵌套 `:activityId/positions[/:activityPositionId]`；list/detail `[auth]`，create/update/delete 复用 `activity.update.record` + activity ref
- App Controller:`controllers/app-activities.controller.ts` `@Controller('app/v1/activities')` `@ApiTags('Mobile - Activities')`(单文件单 class,**非** Mixed Controller)
- DTO 隔离:Admin DTO 在 `activities.dto.ts`(524L);App DTO 在 `dto/app/`(4 文件)
- **活动 participation-summary 评价扩展(F3)**:`ActivityParticipationQueryService` 只调用
  `ActivityFeedbacksQueryService.aggregateForActivity(activityId)` 追加 `{feedback:{count,avgRating}}`；
  单次 aggregate、总业务查询固定 4 次；不在本模块复制评价统计，也不改既有度量字段算法。
- Audit:主资源写路径走 `activity-audit-recorder.ts`；岗位写路径走 `activity-position-audit-recorder.ts`；**event 统一复用 `'activity.publish'`，不新增事件**，岗位以 `extra.operation=activityPosition.{create,update,softDelete}` 区分
- **岗位容量并发基线**:PATCH capacity 必须事务内先锁 `Activity` 行，再重读 `ActivityPosition.capacity` 与本岗位 passCount；锁对象仍只有 Activity，不加岗位行锁
- **P4 effective capacity**:Admin/App 活动 list/detail 的 `capacity` 有 live 岗位时由岗位派生（任一不限→null，否则求和）；无岗位沿 `Activity.capacity`。有岗位时 PATCH Activity.capacity 不判闸、不递补；岗位扩容只递补同 `activityPositionId` 队列。
- 状态机错误码:wrong state 统一抛 `BizCode.ACTIVITY_STATUS_INVALID`
- **受保护状态写(2026-07-13 finding #6)**:`update`/`softDelete`/`publish`/`cancel`/`complete` 在真实写前统一调用 [`/src/common/prisma/claim-at-status.util.ts`](../../common/prisma/claim-at-status.util.ts) `claimAtStatus` 做期望旧态 no-op CAS;并发败者复用 `ACTIVITY_STATUS_INVALID`。helper **只认领、不判断迁移合法性**;合法矩阵仍只在 `activity-state-machine.ts`。
- E2E:`activities.e2e-spec.ts` / `activities-rbac-boundary.e2e-spec.ts` / `activities-state-transition.e2e-spec.ts` / `activities-audit-characterization.e2e-spec.ts` / `app-activities-available.e2e-spec.ts` / `app-activities-detail.e2e-spec.ts`;scoped 判权矩阵在 `participation-scoped-authz.e2e-spec.ts`(与 activity-registrations / attendances 共用一个文件)

## Risk points (不要做)

- ❌ **不**绕过 `activity-state-machine.ts` 在 service 内裸写状态变更
- ❌ **不**改 audit event 名 `'activity.publish'`(6 处共用〔v0.40.0 +complete〕,characterization 已锁)
- ❌ **不**把 `'activity.publish'` 拆成 `activity.create` / `activity.update` 等细分 event(沿现状)
- ❌ 活动岗位链路不得用裸 `positionId` / `position` 命名；字段、参数、relation 一律 `activityPositionId` / `activityPosition`，仅 URL 子资源段保留 `/positions`
- ❌ **不**从 attendances 或其它模块直写 `Activity.statusCode`;完结必须走本模块 `complete` action(`published → completed`)，取消仅允许 draft|published。
- ❌ **不**把 Admin DTO 用 `extends` / `Pick` / `Omit` / `IntersectionType` / `PartialType` / `OmitType` 派生为 App DTO(沿 [`/AGENTS.md §19.7 D-6`](../../../AGENTS.md));App DTO 进 `dto/app/`
- ❌ **不**新增 Mixed Controller(class-level + 方法级双 `@ApiTags`);新 App endpoint 进 `controllers/app-*.controller.ts`
- ❌ **不**主动拆 `activities.service.ts`(898L,沿 [`/docs/current-state.md §4 P2`](../../../docs/current-state.md);拆分需单独立项)
- ❌ App 服务的 `_memberId` 入参是**扩展槽**(v0.1 published 活动池对全员相同,未参与 where 过滤),**不**借口"未使用"删掉(沿 `AppActivitiesService.findVisibleByIdForMember` / `listAvailableForMember` 顶部注释)

## Before editing

- 状态机:[`activity-state-machine.ts`](activity-state-machine.ts)
- audit:[`activity-audit-recorder.ts`](activity-audit-recorder.ts)
- 跨模块边界:[`/docs/participation-bounded-context.md`](../../../docs/participation-bounded-context.md)(尤其 §3 / §5 跨模块写)
- App surface 准入与 scope 注释:[`app-activities.service.ts`](app-activities.service.ts) / [`app-my-activities.service.ts`](app-my-activities.service.ts) 文件顶部

## Validation

- `pnpm lint` + `pnpm typecheck`
- 改业务行为 → `pnpm test:e2e -- activities`(覆盖 `activities*` + `app-activities*` 5 spec)
- 改 audit event / extra → 必须跑 `activities-audit-characterization.e2e-spec.ts`
- 改状态机 → 必须跑 `activities-state-transition.e2e-spec.ts`
- 改 DTO 字段 / endpoint path / Swagger schema → 必须再跑 `pnpm test:contract`
