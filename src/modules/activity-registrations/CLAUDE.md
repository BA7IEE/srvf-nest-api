# activity-registrations — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);上下文边界读 [`/docs/participation-bounded-context.md`](../../../docs/participation-bounded-context.md);架构边界读 [`/docs/architecture-boundary.md`](../../../docs/architecture-boundary.md);API surface 边界读 [`/docs/api-surface-policy.md`](../../../docs/api-surface-policy.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## Scope

- **活动报名记录**:create / approve / reject / cancel 4 态闭集
- **状态机 4 态**:`pending → (pass | reject)`;`pending|pass → cancelled`(`pass` 之后仍可 cancel);**只 `pass` 占活动 capacity 名额**(Q-D17)
- **两 surface**:Admin 代报名 + 审核 + CSV 导出(`admin/v1/activities/:activityId/registrations`);App 本人报名 / 查询 / 取消(`app/v1/my`)。历史 Legacy `/v2/users/me/*` 4 端点已于 Route B Phase 4d2 删除(队员流由 App surface 承载)
- **不负责**:活动主资源生命周期(`activities/`)、考勤(`attendances/`)、贡献值预填(`contribution-rules/` + `attendances/contribution-calculator.ts`);`AttendanceRecord.registrationId` 由 attendances 反向引用,本模块**不**主动维护

## Local facts

- `activity-registrations.service.ts` **1020L**(god-service,沿 CODEMAP;true-up 自陈旧 750L 记载);`activity-registration-state-machine.ts`(71L)/ `activity-registration-audit-recorder.ts`(197L)/ `app-my-registrations.service.ts`(280L)已抽离
- **判权(终态 scoped-authz PR12,2026-07-02)**:8 处调用位点判权走 `assertCanOrThrow` → `authz.explain`;`list`/`exportCsv`(嵌套 `:activityId`)带 `{type:'activity', id: activityId}` 父 ref;`approve`/`reject`/`cancelAdmin` 带 `{type:'activity_registration', id}`(点动作,scoped 持有者树内可用);`create`(代报名)/ `listAllForAdmin`(扁平跨轴)/ `listForMemberAdmin`(队员轴跨活动)无 ref(GLOBAL-only,不在冻结稿①点动作枚举内);`resource_not_found` 回退 `rbac.can` 全局码判定,持码者 return 交回既有 `findActivityOrThrow`/`findRegistrationOrThrow` 抛 `ACTIVITY_NOT_FOUND`/`ACTIVITY_REGISTRATION_NOT_FOUND`,无码者 30100。App 自助端点(`createMy`/`listMy`/`findMy`/`cancelMy`)不受影响,self-scope 不变。e2e 见 `test/e2e/participation-scoped-authz.e2e-spec.ts`。
- Admin Controller:`activity-registrations.controller.ts` `@Controller('admin/v1/activities/:activityId/registrations')` `@ApiTags('Admin - Registrations')`
- App Controller:`controllers/app-my-registrations.controller.ts` `@Controller('app/v1/my')` `@ApiTags('Mobile - My Registrations')`;**方法级**追加 `@ApiTags('Mobile - My Activities')` 于 `GET /my/activities`(刻意保留)
- DTO 隔离:Admin DTO 在 `activity-registrations.dto.ts`;App DTO 在 `dto/app/`(5 文件)
- **Partial unique** `activity_registrations_activity_member_active_unique` 由 migration 直写(Prisma schema 上**不可见**);service 用 `P2002` 兜底转 `BizCode.ACTIVITY_REGISTRATION_ALREADY_EXISTS = 21002`
- Capacity 复核 `assertCapacityNotExceeded`:create + approve 共用;**approve 转 pass 前对 `Activity` 行加 `FOR UPDATE` 排他锁**串行化并发 approve 防超容量(F11 #399;原「事务内重新计数避免 race」在 READ COMMITTED 下不成立)。`capacity=null` 不限名额免锁;create 仅建 pending 不占名额,容量校验为前置提示
- Audit events(2 个):`registration.create`(create 路径)/ `registration.review`(approve / reject / cancel 共用,通过 `extra.action` 区分;`cancelAdmin` vs `cancelMy` 由 `extra.cancelledByPath` 字段记录,**不**进 StateMachine)
- 状态机错误码:wrong state 统一抛 `BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID`
- CSV 导出:`GET admin/v1/activities/:activityId/registrations/export` 手写 `escapeCsvField`,**不**引 `csv-stringify`;**不**写 `export_logs` / **不**生成 `AttendanceRecord`(Q-A6 三禁)
- **报名截止**(活动闭环硬化 2026-06-21):`assertActivityRegistrable`(create 代报名 + createMy 自助 + App `createMyForApp` 共用闸)在 isPublicRegistration 之后判 `registrationDeadline !== null && now > deadline` → `ACTIVITY_REGISTRATION_DEADLINE_PASSED=20123`(精确时刻,不做北京日归一);**approve 不加此闸**(截止只管报名动作,截止前已报 pending 仍可批)
- E2E:`activity-registrations.e2e-spec.ts` / `activity-registrations-rbac-boundary.e2e-spec.ts` / `activity-registrations-state-transition.e2e-spec.ts` / `activity-registrations-audit-characterization.e2e-spec.ts` / `activity-registrations-insurance-gate.e2e-spec.ts` / `app-my-registrations-read.e2e-spec.ts` / `app-my-registrations-write.e2e-spec.ts`;scoped 判权矩阵在 `participation-scoped-authz.e2e-spec.ts`(与 activities / attendances 共用一个文件)

## Risk points (不要做)

- ❌ **不**绕过 `activity-registration-state-machine.ts` 在 service 内裸写态迁移
- ❌ **不**绕过 partial unique 防护 / `P2002` 兜底直接 `prisma.activityRegistration.create`(`assertNoActiveDuplicate` 路径必须命中)
- ❌ **不**绕过 `assertCapacityNotExceeded`(create + approve 共用);**不**移除 approve 内对 `Activity` 行的 `FOR UPDATE` 锁(F11 #399 并发超容量防护)
- ❌ **不**改 audit event 名 `registration.create` / `registration.review`(characterization 已锁)
- ❌ **不**把 `cancelAdmin` / `cancelMy` 路径区分挪进 StateMachine(只通过 `extra.cancelledByPath` 在 audit 记录)
- ❌ **不**改 Admin Controller path `admin/v1/activities/:activityId/registrations`(`export` 字面段必须**先**于 `:id/<action>` 路由声明,Q-A6 锁定;调换顺序会被 Nest 路由解析为 `:id=export`)
- ❌ **不**把 Admin DTO 用 `extends` / `Pick` / `Omit` / `IntersectionType` / `PartialType` / `OmitType` 派生为 App DTO(沿 [`/AGENTS.md §19.7 D-6`](../../../AGENTS.md));App `dto/app/` 字段集**刻意删除** `memberId` / `memberNo` / `memberDisplayName`(沿 §16.B.2)
- ❌ App 视角 where 子句**永远**用 `currentUser.memberId` 锁本人;**禁止** role 短路 / `scope=all`
- ❌ **不**主动拆 `activity-registrations.service.ts`(1020L,沿 [`/docs/current-state.md §4 P2`](../../../docs/current-state.md))
- ❌ **不**在 CSV 导出路径引入 `csv-stringify` 等新依赖(沿 Q-A6 + [`/AGENTS.md §0`](../../../AGENTS.md))
- ❌ **不**误以为 `pass → cancelled` 后会自动腾出 capacity 给后续 pending(腾出靠 partial unique 让 `cancelled` 不占;但 capacity 复核只看 `pass` 计数,无 reservation 机制)

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
