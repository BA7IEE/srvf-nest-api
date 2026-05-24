# activities — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);上下文边界读 [`/docs/participation-bounded-context.md`](../../../docs/participation-bounded-context.md);架构边界读 [`/docs/architecture-boundary.md`](../../../docs/architecture-boundary.md);API surface 边界读 [`/docs/api-surface-policy.md`](../../../docs/api-surface-policy.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## Scope

- **活动主资源**:create / update / publish / cancel 生命周期管理
- **状态机 4 态**:`draft → published → completed`(分支)/ `* → cancelled`;`completed` 由 [`/src/modules/attendances/`](../attendances/) 在首次 sheet 提交时跨模块推进(沿 D11 / D-S10),**不**在本模块状态机闭集内
- **App 视角**:`AppActivitiesService` 暴露 published 活动池(全员相同);`AppMyActivitiesService` 暴露本人参与过的活动列表(按 `memberId` 锁定)
- **不负责**:报名状态(`activity-registrations/`)、考勤(`attendances/`)、贡献值结算(`contribution-rules/` + `attendances/contribution-calculator.ts`)

## Local facts

- `activities.service.ts` **607L**(偏厚,沿 CODEMAP 标 L 体量);`activity-state-machine.ts`(63L)/ `activity-audit-recorder.ts`(291L)/ `app-activities.service.ts`(162L)/ `app-my-activities.service.ts`(181L)已抽离
- Admin Controller:`activities.controller.ts` `@Controller('v2/activities')` `@ApiTags('Admin - Activities')`
- App Controller:`controllers/app-activities.controller.ts` `@Controller('app/v1/activities')` `@ApiTags('Mobile - Activities')`(单文件单 class,**非** Mixed Controller)
- DTO 隔离:Admin DTO 在 `activities.dto.ts`(524L);App DTO 在 `dto/app/`(4 文件)
- Audit:写路径全部走 `activity-audit-recorder.ts`;**event 名 5 处共用 `'activity.publish'`,不动**(沿 PR #199 characterization 锁定)
- 状态机错误码:wrong state 统一抛 `BizCode.ACTIVITY_STATUS_INVALID`
- E2E:`activities.e2e-spec.ts` / `activities-state-transition.e2e-spec.ts` / `activities-audit-characterization.e2e-spec.ts` / `app-activities-available.e2e-spec.ts` / `app-activities-detail.e2e-spec.ts`

## Risk points (不要做)

- ❌ **不**绕过 `activity-state-machine.ts` 在 service 内裸写状态变更
- ❌ **不**改 audit event 名 `'activity.publish'`(5 处共用,characterization 已锁)
- ❌ **不**把 `'activity.publish'` 拆成 `activity.create` / `activity.update` 等细分 event(沿现状)
- ❌ **不**把 `completed` 推进逻辑挪进本模块状态机(由 attendances 在首次 sheet 提交时推动;沿 [`/docs/participation-bounded-context.md §5`](../../../docs/participation-bounded-context.md))
- ❌ **不**把 Admin DTO 用 `extends` / `Pick` / `Omit` / `IntersectionType` / `PartialType` / `OmitType` 派生为 App DTO(沿 [`/AGENTS.md §19.7 D-6`](../../../AGENTS.md));App DTO 进 `dto/app/`
- ❌ **不**新增 Mixed Controller(class-level + 方法级双 `@ApiTags`);新 App endpoint 进 `controllers/app-*.controller.ts`
- ❌ **不**主动拆 `activities.service.ts`(607L,沿 [`/docs/current-state.md §4 P2`](../../../docs/current-state.md);拆分需单独立项)
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
