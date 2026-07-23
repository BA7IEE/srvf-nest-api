# activities — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);上下文边界读 [`/docs/participation-bounded-context.md`](../../../docs/participation-bounded-context.md);架构边界读 [`/docs/architecture-boundary.md`](../../../docs/architecture-boundary.md);API surface 边界读 [`/docs/api-surface-policy.md`](../../../docs/api-surface-policy.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## Scope

- **活动主资源**:create / update / publish / cancel / complete 生命周期管理
- **发布审核**:`ActivityPublishReview` 的 initial submit/direct publish/approve/return/withdraw/cancel；Admin 工作台由独立 controller/query/presenter 承载，审核事务固定锁序 Activity → review
- **活动责任**:`ActivityResponsibilityAssignment` 是 owner/协办历史真源；发布事务同步创建唯一 owner 与 system-managed scoped RoleBinding，Admin 责任面由独立 controller/service/policy/projector/audit 承载
- **活动岗位子资源**:`ActivityPosition` 归本模块；Admin CRUD 走 `AdminActivityPositionsController` + `ActivityPositionsService`，不新建 NestJS module
- **状态机 4 态**:`draft → published → completed`，另有 `draft|published → cancelled`;`completed` 的**唯一推进通路**是管理端 `POST admin/v1/activities/:id/complete` 经本状态机执行。考勤提交只建 pending Sheet，禁止再直写 Activity 状态。
- **App 视角**:`AppActivitiesService` 的可参加池仅含 published + 公开报名 + 未结束活动；detail 刻意仍以 published 可见；`GET :activityId/positions` 只认 published + 公开报名活动，返回 live 岗位余量 / `canRegister`。`AppMyActivitiesService` 暴露本人参与过的活动列表(按 `memberId` 锁定)
- **不负责**:报名状态(`activity-registrations/`)、考勤(`attendances/`)、贡献值结算(`contribution-rules/` + `attendances/contribution-calculator.ts`)

## Local facts

- `activities.service.ts` **1351L**(偏厚,沿 CODEMAP 标 L 体量);活动岗位 CRUD/扩容递补已边界化为 `activity-positions.service.ts`(608L) + `activity-position-audit-recorder.ts`，发布审核边界化为 `activity-publish-review.service.ts`(705L)+query/presenter/audit/state-machine；责任边界化为 `activity-responsibility.service.ts`(698L)+policy/projector/audit，不继续堆入主 service
- **活动责任闭环 PR-5 gate**:`ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED` 在 dev/test 缺省 false，production/smoke 必须显式；false 保持旧 Admin 行为。true 时 create 解析正式 initiator，pending 冻结 Activity/岗位，published 写转 20037，旧 publish 仅审批 pending initial 或允许发起人直接发布；发布成功同步投影唯一 owner。稳定切流与摘旧角色权限归 PR-11
- **活动责任闭环 PR-6 App 面**:`/app/v1/my/managed-activities` 与既有报名历史 `/my/activities` 物理分离；3 个 controller 共 19 路，App DTO 独立。draft Activity/岗位只允许 initiator 直改；published 由 active owner 提交 schemaVersion=1 完整 proposal，approve 固定 Activity→review 锁序并在同事务复校、应用 Activity+positions diff、递增 revision、容量候补递补与 audit；禁止把 proposal 应用拆到事务外。
- **责任锁序与投影不变式**:新增/移交固定 Activity → 目标 Member（移交时新旧 memberId 排序）→ current assignment → RoleBinding；assignment 与 `system:activity-responsibility:{assignmentId}` binding 必须同事务创建/结束。owner=`activity-owner`，协办按 registrations/attendance capability 投影对应角色；通用角色 API 永不代写这些 binding
- **发布审核快照与并发**:snapshot 固定 schemaVersion=1，Activity 与岗位分离且岗位主键名为 `activityPositionId`；initial approve 在 Activity → review 锁后重建并比较服务端快照；change approve 在同一锁序下解析、二次验证完整 proposal，再由无自有事务的 applier 应用聚合 diff；两者均复查 revision 并只递增一次 workflowRevision。并发 E2E 必须是两套 Nest/Prisma pool + PostgreSQL lock waiter barrier
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
- Audit:主资源写路径走 `activity-audit-recorder.ts`；岗位写路径走 `activity-position-audit-recorder.ts`；发布审核走 `activity-publish-review-audit-recorder.ts`；**event 统一复用 `'activity.publish'`，不新增事件**，以 `extra.operation` 区分
- **岗位容量并发基线**:PATCH capacity 必须事务内先锁 `Activity` 行，再重读 `ActivityPosition.capacity` 与本岗位 passCount；锁对象仍只有 Activity，不加岗位行锁
- **活动窗父子不变式**:PATCH Activity `startAt/endAt` 与岗位 create/update/softDelete 共用 Activity 聚合锁；锁后校验全部 live 岗位独立窗仍落在新活动窗内，越窗复用 `ACTIVITY_POSITION_TIME_RANGE_INVALID=20017`，事务整体拒绝
- **保险生命周期 PR-A**:`INSURANCE_ENFORCEMENT_ENABLED=false` 时 update 保持旧查询图；gate=true 时必须在既有 Activity `FOR UPDATE` 根事务内、真实写前检查 live(`deletedAt=null`)且 `statusCode!='cancelled'` 的报名。已有此类报名后，`requiresInsurance` 真值变化一律复用 `ACTIVITY_STATUS_INVALID`；current `requiresInsurance=true` 时 `startAt/endAt` 的实际变化同码拒绝；current false 且仍 false 的改期保持旧行为。策略归 `InsuranceRequirementService`，本模块只持根事务/锁并传当前与合并后值。
- **容量父子不变量**:`Activity.capacity` 始终是全局硬上限；岗位 capacity 只会进一步收紧。Admin/App 活动 list/detail 的 effective capacity 取父上限与岗位合计的交集；有限总容量下岗位合计不得超过父上限。Activity/岗位 capacity 写均在 Activity 聚合锁后重读全部 pass 与 live 岗位容量；岗位扩容递补还必须受全局剩余量裁剪。父容量扩容/改无限时按全活动稳定 FIFO 跨岗位递补，只选择仍有 child headroom 的 live 岗位。
- **完结时间闸**:`complete` 在 Activity 聚合锁后重读状态与时间，只有 `published` 且读侧 phase 已为 `ended`（严格晚于 `endAt`）才允许写 `completed`；未来/进行中活动复用 `ACTIVITY_STATUS_INVALID` fail-closed。
- 状态机错误码:wrong state 统一抛 `BizCode.ACTIVITY_STATUS_INVALID`
- **受保护状态写(2026-07-21)**:`update`/`softDelete`/`publish`/`cancel`/`complete` 在持有 Activity 聚合锁并重读后，统一调用 [`/src/common/prisma/claim-at-status.util.ts`](../../common/prisma/claim-at-status.util.ts) 的条件 `SELECT ... FOR NO KEY UPDATE`；不产生 no-op tuple，调用方在 claim 后继续以既有锁后行完成真实写。并发败者复用 `ACTIVITY_STATUS_INVALID`；helper **只认领、不判断迁移合法性**，合法矩阵仍只在 `activity-state-machine.ts`。
- E2E:`activities.e2e-spec.ts` / `activities-rbac-boundary.e2e-spec.ts` / `activities-state-transition.e2e-spec.ts` / `activities-audit-characterization.e2e-spec.ts` / `activity-publish-review.e2e-spec.ts` / `activity-publish-review-concurrency.e2e-spec.ts` / `activity-responsibilities.e2e-spec.ts` / `activity-responsibility-concurrency.e2e-spec.ts` / `app-activities-available.e2e-spec.ts` / `app-activities-detail.e2e-spec.ts`;scoped 判权矩阵在 `participation-scoped-authz.e2e-spec.ts`

## Risk points (不要做)

- ❌ **不**绕过 `activity-state-machine.ts` 在 service 内裸写状态变更
- ❌ **不**改 audit event 名 `'activity.publish'`(6 处共用〔v0.40.0 +complete〕,characterization 已锁)
- ❌ **不**在发布审核事务中反转锁序或信任提交时快照；必须 Activity → review，approve 时服务端重建快照
- ❌ **不**把责任 assignment 与 system-managed RoleBinding 分成两个事务，也不绕过 projector 直接写 responsibility binding
- ❌ **不**把 `'activity.publish'` 拆成 `activity.create` / `activity.update` 等细分 event(沿现状)
- ❌ 活动岗位链路不得用裸 `positionId` / `position` 命名；字段、参数、relation 一律 `activityPositionId` / `activityPosition`，仅 URL 子资源段保留 `/positions`
- ❌ **不**从 attendances 或其它模块直写 `Activity.statusCode`;完结必须走本模块 `complete` action(`published → completed`)，取消仅允许 draft|published。
- ❌ **不**把保险生命周期查询移到 Activity 聚合锁前，不拆第二 insurance gate；首签到/考勤 submit/edit、offboard 与其它 participation producer 的重验属于后续 PR-B。
- ❌ **不**把 Admin DTO 用 `extends` / `Pick` / `Omit` / `IntersectionType` / `PartialType` / `OmitType` 派生为 App DTO(沿 `harness reference/api-client-boundary.md` D-6`);App DTO 进 `dto/app/`
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
