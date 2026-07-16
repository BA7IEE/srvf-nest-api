# activity-registrations — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);上下文边界读 [`/docs/participation-bounded-context.md`](../../../docs/participation-bounded-context.md);架构边界读 [`/docs/architecture-boundary.md`](../../../docs/architecture-boundary.md);API surface 边界读 [`/docs/api-surface-policy.md`](../../../docs/api-surface-policy.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## Scope

- **活动报名记录**:create / approve / reject / cancel / reopen + 内部 promote，5 态闭集
- **状态机 5 态**:`pending → pass|reject`;`waitlisted → pending`(仅自动递补，不开手动端点)；`pending|waitlisted → reject`；`pending|pass|waitlisted → cancelled`；`reject → pending`(reopen)。**不开 waitlisted → pass / reject → pass 直通**；只 pass 占 capacity
- **两 surface**:Admin 代报名 + 审核 + CSV 导出(`admin/v1/activities/:activityId/registrations`);App 本人报名 / 查询 / 取消(`app/v1/my`)。历史 Legacy `/v2/users/me/*` 4 端点已于 Route B Phase 4d2 删除(队员流由 App surface 承载)
- **不负责**:活动主资源生命周期(`activities/`)、考勤(`attendances/`)、贡献值预填(`contribution-rules/` + `attendances/contribution-calculator.ts`);`AttendanceRecord.registrationId` 由 attendances 反向引用,本模块**不**主动维护

## Local facts

- `activity-registrations.service.ts` **1603L**(god-service,沿 CODEMAP);`activity-registration-state-machine.ts`(105L)/ `activity-registration-audit-recorder.ts`(198L)/ `app-my-registrations.service.ts`(295L)已抽离；候补另以纯函数 promotion engine + QueryService 隔离
- **判权(终态 scoped-authz PR12 + v0.49 部门范围)**:管理端点动作走 `assertCanOrThrow` → `authz.explain`;`list`/`exportCsv`(嵌套 `:activityId`)带 `{type:'activity', id: activityId}` 父 ref;`approve`/`reject`/`cancelAdmin` 带 `{type:'activity_registration', id}`;`listForMemberAdmin` 带 `{type:'member', id: memberId}`;`listAllForAdmin` 通过 `getVisibleOrganizationScope` 按 `activity.organizationId` 下推并与用户组织筛选取交集；仅 `create`(代报名)保持无 ref(GLOBAL-only)。`resource_not_found` 回退 `rbac.can` 全局码判定,持码者交回既有 NOT_FOUND,无码者 30100。App 自助端点不受影响,self-scope 不变。e2e 见 `test/e2e/participation-scoped-authz.e2e-spec.ts`。
- **CSV 导出(v0.44.0 finding #13)**:`exportCsv` 必须保持 500 行游标分页 async generator + BOM 首 chunk,controller 用 `Readable.from`;禁止恢复全量 `findMany` / `string[]` / 整串 Buffer。
- Admin Controller:`activity-registrations.controller.ts` `@Controller('admin/v1/activities/:activityId/registrations')` `@ApiTags('Admin - Registrations')`
- App Controller:`controllers/app-my-registrations.controller.ts` `@Controller('app/v1/my')` `@ApiTags('Mobile - My Registrations')`;**方法级**追加 `@ApiTags('Mobile - My Activities')` 于 `GET /my/activities`(刻意保留)
- DTO 隔离:Admin DTO 在 `activity-registrations.dto.ts`;App DTO 在 `dto/app/`(5 文件)
- **Partial unique** `activity_registrations_activity_member_active_unique` 由 migration 直写(Prisma schema 上**不可见**);service 用 `P2002` 兜底转 `BizCode.ACTIVITY_REGISTRATION_ALREADY_EXISTS = 21002`
- Capacity:有岗位 create/approve 按 `(activityId,activityPositionId)` 的 passCount + 岗位 capacity 分流/复核；无岗位显式 `activityPositionId=null` 沿 Activity.capacity。approve 仍先锁 Activity，再重读岗位 capacity 与 passCount。取消 pass 递补同岗位 1 人；岗位 capacity 调大递补同岗 delta，改 null 递补同岗全部；有岗位时 Activity capacity 不递补
- Audit events(2 个):`registration.create` / `registration.review`(approve / reject / cancel / reopen / **promote** 共用；promote 固定 `extra.action='promote'`)
- 状态机错误码:wrong state 统一抛 `BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID`
- **受保护状态写(2026-07-13 finding #6)**:`cancelAdmin`/`reopen`/`cancelMy` 在真实写前统一调用 [`/src/common/prisma/claim-at-status.util.ts`](../../common/prisma/claim-at-status.util.ts) `claimAtStatus`;并发败者复用 `ACTIVITY_REGISTRATION_STATUS_INVALID`。`approve`/`reject` 的 v0.44.0 内联 no-op CAS 保留;新路径不得再散落第二份 CAS。helper **不**改 `activity-registration-state-machine.ts` 的合法迁移矩阵。
- **候补并发锁序**:`promoteActivityWaitlist` 由调用方透传 tx，固定锁 Activity，按 `registeredAt ASC,id ASC` 逐行 claim CAS。Admin/self/App 三路 create 在读取 Activity/岗位/passCount 前先锁 Activity；pass 取消在 claim registration 前同样先锁 Activity，与 approve / check-in / attendance submit 统一 Activity → Registration 锁序，禁止恢复会触发 PostgreSQL 40P01 的反向锁序
- **候补排位**:`activity-registration-waitlist-query.service.ts` 批量按 `(activityId,activityPositionId)` 计算，`null` 是无岗位旧队列，列表禁止 N+1；非 waitlisted 返 null
- **岗位报名**:Admin / self / App 三路 create DTO 均只接受可选 `activityPositionId`；有 live 岗位未传→21035，跨活动/已删/不存在→20002；活动 gender 后叠加岗位 gender；一人一活动 partial unique 仍不含岗位，报第二岗继续 21002。Admin 报名列表 additive 返回 `activityPosition{activityPositionId,name}`，App 报名读模型不扩岗位对象
- **参与域生命周期收口(v0.40.0)**:① **approve 活动状态闸** —— approve 事务内 `findActivityOrThrow` 后校验活动 `statusCode ∈ {cancelled, completed}` → `ACTIVITY_ENDED_OR_CANCELLED_APPROVE_FORBIDDEN`(20124);**reject / cancelAdmin / cancelMy 刻意不加此闸**(留作清理已取消/已完结活动残留待审队列的手段)。② **reopen 边** —— `reject → pending`,新端点 `POST admin/v1/activities/:activityId/registrations/:id/reopen`,新码 `activity-registration.reopen.record`(判权带 ref `{type:'activity_registration', id}`);置 pending 同时清空 `reviewedBy/reviewedAt/reviewNote`;audit 复用 `registration.review` 事件、`extra.action='reopen'`;**不发通知**。⑦ **cancel 考勤守卫** —— cancelAdmin + cancelMy 状态机放行后、写库前经 `assertNoAttendanceRecords`(直连 `tx.attendanceRecord.count({registrationId, deletedAt:null})`,**不引 attendances service** 防环)> 0 → `ACTIVITY_REGISTRATION_HAS_ATTENDANCE`(21033);不做贡献值回滚(贡献值属考勤域)
- CSV 导出:`GET admin/v1/activities/:activityId/registrations/export` 手写 `escapeCsvField`,**不**引 `csv-stringify`;**不**写 `export_logs` / **不**生成 `AttendanceRecord`(Q-A6 三禁)
- **报名截止**(活动闭环硬化 2026-06-21):`assertActivityRegistrable`(create 代报名 + createMy 自助 + App `createMyForApp` 共用闸)在 isPublicRegistration 之后判 `registrationDeadline !== null && now > deadline` → `ACTIVITY_REGISTRATION_DEADLINE_PASSED=20123`(精确时刻,不做北京日归一);**approve 不加此闸**(截止只管报名动作,截止前已报 pending 仍可批)
- E2E:`activity-registration-waitlist.e2e-spec.ts` + 既有 `activity-registrations*.e2e-spec.ts` / `app-my-registrations-*.e2e-spec.ts`

## Risk points (不要做)

- ❌ **不**绕过 `activity-registration-state-machine.ts` 在 service 内裸写态迁移
- ❌ **不**绕过 partial unique 防护 / `P2002` 兜底直接 `prisma.activityRegistration.create`(`assertNoActiveDuplicate` 路径必须命中)
- ❌ **不**恢复 create 满员报错；**不**移除 approve 内对 `Activity` 行的 `FOR UPDATE` + capacity 复核
- ❌ **不**改 audit event 名 `registration.create` / `registration.review`(characterization 已锁)
- ❌ **不**把 `cancelAdmin` / `cancelMy` 路径区分挪进 StateMachine(只通过 `extra.cancelledByPath` 在 audit 记录)
- ❌ **不**改 Admin Controller path `admin/v1/activities/:activityId/registrations`(`export` 字面段必须**先**于 `:id/<action>` 路由声明,Q-A6 锁定;调换顺序会被 Nest 路由解析为 `:id=export`)
- ❌ **不**把 Admin DTO 用 `extends` / `Pick` / `Omit` / `IntersectionType` / `PartialType` / `OmitType` 派生为 App DTO(沿 `harness reference/api-client-boundary.md` D-6`);App `dto/app/` 字段集**刻意删除** `memberId` / `memberNo` / `memberDisplayName`(沿 §16.B.2)
- ❌ App 视角 where 子句**永远**用 `currentUser.memberId` 锁本人;**禁止** role 短路 / `scope=all`
- ❌ **不**主动拆 `activity-registrations.service.ts`(1587L,沿 [`/docs/current-state.md §4 P2`](../../../docs/current-state.md))
- ❌ **不**在 CSV 导出路径引入 `csv-stringify` 等新依赖(沿 Q-A6 + [`/AGENTS.md §3`](../../../AGENTS.md))
- ❌ **不**把递补改成 waitlisted → pass；腾出名额只自动进 pending，仍必须走 approve

## Before editing

- 状态机:[`activity-registration-state-machine.ts`](activity-registration-state-machine.ts)
- audit:[`activity-registration-audit-recorder.ts`](activity-registration-audit-recorder.ts)
- App service(scope / 字段集 / canUseApp 准入):[`app-my-registrations.service.ts`](app-my-registrations.service.ts) 文件顶部注释
- 跨模块边界:[`/docs/participation-bounded-context.md §4 / §5 / §6`](../../../docs/participation-bounded-context.md)(尤其"报名取消 → partial unique 允许同人再次报名"那条)
- partial unique 实际 migration:在 `prisma/migrations/` 内 grep `activity_registrations_activity_member_active_unique`

## Validation

- `pnpm lint` + `pnpm typecheck`
- 改业务行为 → `pnpm test:e2e -- activity-registrations app-my-registrations`(覆盖 6 spec)
- 改 audit event / extra → 必须跑 `activity-registrations-audit-characterization.e2e-spec.ts`
- 改状态机 → 必须跑 `activity-registrations-state-transition.e2e-spec.ts`
- 改 DTO 字段 / endpoint path / Swagger schema / 错误码 → 必须再跑 `pnpm test:contract`
