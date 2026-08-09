# activity-registrations — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);上下文边界读 [`/docs/participation-bounded-context.md`](../../../docs/participation-bounded-context.md);架构边界读 [`/docs/architecture-boundary.md`](../../../docs/architecture-boundary.md);API surface 边界读 [`/docs/api-surface-policy.md`](../../../docs/api-surface-policy.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## Scope

- **活动报名记录**:create / approve / reject / cancel / reopen + 内部 promote，5 态闭集
- **状态机 5 态**:`pending → pass|reject`;`waitlisted → pending`(仅自动递补，不开手动端点)；`pending|waitlisted → reject`；`pending|pass|waitlisted → cancelled`；`reject → pending`(reopen)。**不开 waitlisted → pass / reject → pass 直通**；只 pass 占 capacity
- **三 surface**:Admin 代报名 + 审核 + CSV 导出(`admin/v1/activities/:activityId/registrations`);App 本人报名 / 查询 / 取消(`app/v1/my`);App 活动负责人/报名协办管理（含 `POST app/v1/my/managed-activities/:activityId/onsite-participations` 的现场临时参加）;历史 Legacy `/v2/users/me/*` 4 端点已于 Route B Phase 4d2 删除(队员流由 App surface 承载)
- **不负责**:活动主资源生命周期(`activities/`)、考勤(`attendances/`)、贡献值预填(`contribution-rules/` + `attendances/contribution-calculator.ts`);`AttendanceRecord.registrationId` 由 attendances 反向引用,本模块**不**主动维护

## Local facts

- `activity-registrations.service.ts` **1727L**(god-service,沿 CODEMAP);`activity-registration-state-machine.ts`(105L)/ `activity-registration-audit-recorder.ts`(217L)/ `app-my-registrations.service.ts`(295L)已抽离；候补另以纯函数 promotion engine + QueryService 隔离
- **判权(终态 scoped-authz PR12 + v0.49 部门范围)**:管理端点动作走 `assertCanOrThrow` → `authz.explain`;`list`/`exportCsv`(嵌套 `:activityId`)带 `{type:'activity', id: activityId}` 父 ref;`approve`/`reject`/`cancelAdmin` 带 `{type:'activity_registration', id}`;`listForMemberAdmin` 带 `{type:'member', id: memberId}`;`listAllForAdmin` 通过 `getVisibleOrganizationScope` 按 `activity.organizationId` 下推并与用户组织筛选取交集；仅 `create`(代报名)保持无 ref(GLOBAL-only)。`resource_not_found` 回退 `rbac.can` 全局码判定,持码者交回既有 NOT_FOUND,无码者 30100。App 自助端点不受影响,self-scope 不变。e2e 见 `test/e2e/participation-scoped-authz.e2e-spec.ts`。
- **CSV 导出(v0.44.0 finding #13)**:`exportCsv` 必须保持 500 行游标分页 async generator + BOM 首 chunk,controller 用 `Readable.from`;禁止恢复全量 `findMany` / `string[]` / 整串 Buffer。
- Admin Controller:`activity-registrations.controller.ts` `@Controller('admin/v1/activities/:activityId/registrations')` `@ApiTags('Admin - Registrations')`
- App Controller:`controllers/app-my-registrations.controller.ts` `@Controller('app/v1/my')` `@ApiTags('Mobile - My Registrations')`;**方法级**追加 `@ApiTags('Mobile - My Activities')` 于 `GET /my/activities`(刻意保留)
- Managed App Controller:`controllers/app-managed-activity-registrations.controller.ts`，7 路 list/approve/reject/cancel/reopen/bulk-approve/bulk-reject；薄 application service 只做 App safe projection，动作仍复用本模块单条 service 与 bulk wrapper，禁止复制第二套状态机/容量/候补/audit
- **一次性报名附件会话**:`controllers/app-registration-upload-sessions.controller.ts` 只暴露 create/upload 两路；token 用 CSPRNG 生成、库内仅 SHA-256，创建响应明文只一次、固定 30 分钟。每次 upload 都在 Activity/Form/Session 根锁内复校 member/route/activity/formVersion/status/expiry，任一失配在 Provider/ledger/audit 前统一 `ATTACHMENT_NOT_FOUND=13001`；session 上传后仍为 active。只有 canonical 报名提交在同一根事务完成 Form/session/AVAILABLE 复核、创建 `RegistrationFormAnswer` 后，才把附件转为最终 `registration-form-answer` owner、回填 `RegistrationFormAnswer.attachmentId` 并将 session 标为 consumed。
- DTO 隔离:Admin DTO 在 `activity-registrations.dto.ts`;App DTO 在 `dto/app/`(6 文件)，managed 出参刻意不含 `reviewedBy` / `cancelledByUserId`
- **永久报名头 unique** `activity_registrations_activity_member_permanent_unique` 已在 schema 可见：同一 (activityId,memberId) 跨 cancelled / soft-deleted 全历史仅一头。legacy Admin/self 的历史头重报暂由 `P2002` 兜底为 21002；canonical 新 key 暂走既有 21003，旧精确回执重放不变；runtime 同头复用尚未实现。
- **D-INSURANCE v3 PR3**:single gate=true 且 Activity.requiresInsurance=true 时，Admin/App legacy create 与 canonical v1.1 command 都复用 `InsuranceRequirementService` 的同一 source 判定；source 只认覆盖活动北京日闭区间的 verified self，随后才尝试 live Team Policy+Coverage。首次报名成功在各自根事务内恰留一条最小 evidence；canonical 重提仍重验资格、不得重复 evidence，任一腿失败全回滚；pending/rejected/软删/不覆盖均 26030。gate=false 保留旧 consumer 且 0 evidence。
- **canonical v1.1 command 实际锁序**:`Activity FOR UPDATE → active ActivityRegistration FOR UPDATE → ActivityParticipationIdentity(id ASC) FOR UPDATE → Member FOR SHARE → User FOR SHARE → 状态/profile/Form 复核 → [preferences=[] 时全活动 live ActivitySessionPosition(id ASC) FOR UPDATE；否则 ActivitySession(id ASC) FOR UPDATE → 已选场次 live ActivitySessionPosition(id ASC) FOR UPDATE → 已选 position(id ASC) FOR UPDATE] → file RegistrationUploadSession(id ASC) FOR UPDATE → insurance source(self MemberInsurance FOR SHARE；team Policy FOR SHARE → Coverage FOR SHARE) → append revisions/answers/preferences → attachment 转移与 session consumed → current pointers → audit`。因此任一 live 岗位都要求 top-level `preferences` 非空，已选场次有 live 岗位还要求其 `positionIds` 非空。Member/User shared lock 有意在 source 前；队保覆盖写固定 `Policy FOR UPDATE → Coverage set FOR UPDATE → Member FOR SHARE`，shared Member 相容而不形成回边；真实两 Nest/两 pool 屏障见 `activity-batch4-registration-command-concurrency.e2e-spec.ts`。
- **CapacityReservation 内核（第 4 批⑥ #965 已合 main）**:`CapacityReservationService` 只接 caller 已开启的 transaction，固定 `Activity → 该 member/activity 全量 identity(id ASC) → [reserve 目标 ActivitySession(id ASC) 重读且仅 scheduled+未软删] → bucket(scopeTypeCode,scopeId,id) → active reservation(id ASC)`；请求 identities 只是全量对账上下文的子集，所有会影响“最后一个 active session”判断的 session bucket 都先锁定/对账，再做 DML；release 仍可清理历史/取消场次。只写 `CapacityReservation` 与 `ActivityCapacityBucket.occupied/version`，零写 Registration/Identity 指针与状态、revision、audit/outbox。`capacity_unavailable` 只是确定性结果，waitlist/拒绝/批次结果由未来 caller 决定；本刀零 endpoint、零 canonical/approve/allocation caller。新 activity-person 以本批稳定排序最小 identityId 作锚，已有锚保留至最后一个 active session 释放。
- **保险生命周期 PR-A + Member 生命周期 PR-E**:approve 在 Activity `FOR UPDATE` 后、registration claim/capacity write/audit 前调用 `InsuranceRequirementService`。所有活动都必须锁并重读目标 Member：不存在/软删→15001，inactive→17030；insured 分支另要求唯一 evidence 与 exact source，source 失配仍 26030。self 锁序为 Member→MemberInsurance，team 为 Policy→Coverage→Member；bulk 继续逐条调用 single approve。
- Capacity:`Activity.capacity` 永远先作为全局硬上限，有岗位时再叠加 `(activityId,activityPositionId)` 的 passCount + 岗位子上限；create/approve 均先锁 Activity，再同时重读全活动 passCount、岗位 passCount 与两层 capacity。取消 pass **只**递补同岗位 1 人(**B-D2 拍板 2026-08-01:跨岗 fallback 已删除**，同岗无人就空着)；岗位已软删/已满则一个都不递补；岗位扩容递补同岗 delta 仍受全局剩余量裁剪。
- Audit events(2 个):`registration.create` / `registration.review`(approve / reject / cancel / reopen / **promote** / export 共用；promote 固定 `extra.action='promote'`;export 固定 `extra.operation='export'`,在返回 generator 前 fail-closed 落库)
- 状态机错误码:wrong state 统一抛 `BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID`
- **受保护状态写(2026-07-21)**:`approve`/`reject`/`cancelAdmin`/`reopen`/`cancelMy` 在真实写前统一调用 [`/src/common/prisma/claim-at-status.util.ts`](../../common/prisma/claim-at-status.util.ts)；helper 以静态物理表/列执行条件 `SELECT ... FOR NO KEY UPDATE`，不再写 no-op tuple。获锁后必须重读安全行，并让 current-row guard、子表写、真实更新与 audit before 只使用锁后行；并发败者复用 `ACTIVITY_REGISTRATION_STATUS_INVALID`，合法矩阵仍只在 `activity-registration-state-machine.ts`。
- **候补并发锁序**:`promoteActivityWaitlist` 由调用方透传 tx，固定锁 Activity，按 `registeredAt ASC,id ASC` 扫描；每名候补先锁并重读 Member，inactive/软删留在 waitlisted 并仅从本轮排除，live+ACTIVE 才 claim Registration、写 pending/audit。递补固定 Activity→Member→Registration；legacy Admin/self/App create 固定 Activity→保险 source→Member→Registration，避免反转 team 的 Policy→Coverage→Member 全仓锁序；canonical v1.1 的不同完整顺序以上一条为准。
- **durable intent 的 payload 必须取锁后行(并发审计 K4,2026-07-31)**:`cancelMy` 的活动标题 / 发布人在 claim + 证据守卫**之后**才读。放在锁前时,并发改名先提交,本事务仍会用旧标题落 intent —— intent 一旦落库 worker 无法自行恢复正确快照,同一次取消甚至会同时产出「旧标题的取消通知」与「新标题的候补递补通知」(递补 helper 本就是锁后复读的)。执行位:`test/e2e/registration-cancel-my-locked-snapshot-concurrency.e2e-spec.ts`
- **报名通知 durable outbox**:approve/reject 审批结果、取消后的候补递补、自助取消告知均在业务 update + `registration.review` audit 的同一事务内 enqueue `notification.targeted@1`;**自助取消告知只在取消 `pass` 报名时发(B-D3,维护者 2026-08-01 拍板)** —— pending/waitlisted 的取消对负责人没有要做的事,名额本就没被占住,全发是噪音;取消 pass 的 intent 形状(eventKey/aggregate/收件人解析)逐字不变,只是不再为另两个状态多发;enqueue 失败整体回滚，worker 仅在 commit 后执行 Effect。review eventKey 绑定 registration + reviewedAt + review audit 序号，递补/取消绑定对应状态写时间。自助取消正文只使用同事务快照 `displayName（memberNo）`，任一标签不可用即用固定匿名提示，绝不暴露 `Member.id`。责任制 gate=true 仍只通知当前 ACTIVE owner，缺 owner fail-closed，绝不回退 `publishedBy`；gate=false 才显式沿用 publisher；eventKey / aggregate / destination 语义不变。
- **managed 报名判权与锁序(PR-7)**:单条写先走既有 `authz.explain`，再在同一事务的 Activity 根锁后重读 active responsibility 的 `canManageRegistrations=true`；因此 owner/报名协办可管理，global 旧角色、考勤协办不可旁路，协办 end/owner transfer 与在途写串行。默认 `authorization='authz'` 保持 Admin 调用逐字行为，managed 路径显式传 `'managed'`
- **邀请/访客 runtime（第 4 批⑦）**:managed invitations/visitors 先 D-5、既有 `activity-registration.*.record` 权限，再在 Activity 锁后重读 active `canManageRegistrations=true`；GLOBAL 码不旁路。邀请 create/list/revoke 与本人 decline 固定 Activity→Invitation，pending 过期只投影/转 expired，decline 的 operationKey+canonical SHA-256 同 key 同载荷重放、异 hash `20151`；访客 writer 只写 `ActivityVisitor` + 同事务 `visitor.create` audit，新行 `attendanceCode=null`，禁止触报名/参与/预留/考勤/结算/账本/贡献/进度。
- **现场临时参加（第 4 批⑧）**:`OnsiteParticipationCommandService` 仅服务 managed route；先 D-5 + `activity-registration.create.record`，再在同一事务 Activity 根锁后重读 active `canManageRegistrations=true`，GLOBAL/SUPER_ADMIN 都不能绕过责任。Activity 根锁后先重读 actor D-5/责任；新事实锁序为 Activity→全部活动报名头→member/activity 全部永久 identity→session/position/Form/RuleSet/保险→三层 CapacityReservation→immutable revision/current pointer→population revision→`registration.create` audit。只允许明确的前置参与态转 `pass`；`pass/attended/settled/cancellation_requested` 和跨历史报名头一律 21030。D-5/责任重读后精确同 key+hash 的旧成功回执优先返回；仅新 key 在同一 Activity 锁内遇 `now > endAt`、run `statusCode ∈ {posting, posted}`、`currentPostedVersion != null` 或 active closure 才 21030。Form 含字段、适用 active RuleSet 或岗位显式 RuleSet 指向一律 21039 fail-closed，**不**猜 `operator/valueJson`、不实现 evaluator。容量只调用 trusted 内核，绝不写 `capacityReservationId`；audit 不复制 reason/保险/答案/文件，零 outbox/通知。
- **approve 保险锁序**:Activity 后按 evidence 类型分支：self=`Member lifecycle FOR UPDATE→MemberInsurance→Registration`，team=`Policy→Coverage→Member lifecycle FOR UPDATE→Registration`；无保险分支=`Member→Registration`。与现有 self review、队保覆盖写同向；锁住生命周期/来源后才 claim Registration。
- **create / approve Member ACTIVE**:Admin create 与 App core createMy 都先做无锁 live+ACTIVE snapshot 以稳定 15001/17030 优先级，保险 source 选择后再 `assertActiveMemberLifecycle()` 排他锁并重读；approve 同样先 snapshot，再由保险 service 在既有 source 锁位最终加锁。reopen 刻意不查 ACTIVE，只恢复 pending，后续 approve 必须重验。
- **候补排位**:`activity-registration-waitlist-query.service.ts` 批量按 `(activityId,activityPositionId)` 计算，`null` 是无岗位旧队列，列表禁止 N+1；非 waitlisted 返 null
- **岗位报名**:Admin / self / App 三路 legacy create DTO 均只接受可选 `activityPositionId`；有 live 岗位未传→21035，跨活动/已删/不存在→20002；活动 gender 后叠加岗位 gender；一人一活动永久报名头 unique 不含岗位，报第二岗继续 21002。canonical v1.1 则在提交事务内按 live `ActivitySessionPosition` 重查：任一 live 岗位时 `preferences:[]`→21035；已选场次有 live 岗位时空 `positionIds` 也→21035，合法数组顺序才派生从 1 开始的 `preferenceOrder`。Admin 报名列表 additive 返回 `activityPosition{activityPositionId,name}`，App 报名读模型不扩岗位对象
- **参与域生命周期收口(v0.40.0)**:① **approve 活动状态闸** —— approve 事务内 `findActivityOrThrow` 后校验活动 `statusCode ∈ {cancelled, completed}` → `ACTIVITY_ENDED_OR_CANCELLED_APPROVE_FORBIDDEN`(20124);**reject / cancelAdmin / cancelMy 刻意不加此闸**(留作清理已取消/已完结活动残留待审队列的手段)。② **reopen 边** —— `reject → pending`,新端点 `POST admin/v1/activities/:activityId/registrations/:id/reopen`,新码 `activity-registration.reopen.record`(判权带 ref `{type:'activity_registration', id}`);置 pending 同时清空 `reviewedBy/reviewedAt/reviewNote`;audit 复用 `registration.review` 事件、`extra.action='reopen'`;**不发通知**。⑦ **cancel 参与证据守卫** —— cancelAdmin + cancelMy 状态机放行后、写库前经共同 `assertNoParticipationEvidence`，依次直连 `tx.attendanceRecord.count` 与 `tx.activityCheckIn.count` 查询同 `registrationId` 的 live 证据（**不引 attendances service** 防环）；任一 > 0 → `ACTIVITY_REGISTRATION_HAS_ATTENDANCE`(21033)。pass 路径仍固定 Activity → Registration 锁序，因此并发签到/取消只能串行收敛；不删历史、不做贡献值回滚(贡献值属考勤域)
- CSV 导出:`GET admin/v1/activities/:activityId/registrations/export` 手写 `escapeCsvField`,**不**引 `csv-stringify`;**不**写 `export_logs` / **不**生成 `AttendanceRecord`(Q-A6 三禁);返回 generator 前必须完成 `registration.review` 审计,不得把审计移回 generator 尾部
- **报名截止**(活动闭环硬化 2026-06-21):`assertActivityRegistrable`(create 代报名 + createMy 自助 + App `createMyForApp` 共用闸)在 isPublicRegistration 之后判 `registrationDeadline !== null && now > deadline` → `ACTIVITY_REGISTRATION_DEADLINE_PASSED=20123`(精确时刻,不做北京日归一);**approve 不加此闸**(截止只管报名动作,截止前已报 pending 仍可批)
- E2E:`activity-registration-waitlist.e2e-spec.ts` + 既有 `activity-registrations*.e2e-spec.ts` / `app-my-registrations-*.e2e-spec.ts`

## Risk points (不要做)

- ❌ **不**绕过 `activity-registration-state-machine.ts` 在 service 内裸写态迁移
- ❌ **不**绕过永久报名头 unique / `P2002` 兜底直接 `prisma.activityRegistration.create`；历史头 runtime 复用须另立授权刀，不得借本地查询绕过 DB。
- ❌ **不**恢复 create 满员报错；**不**移除 approve 内对 `Activity` 行的 `FOR UPDATE` + capacity 复核
- ❌ **不**改 audit event 名 `registration.create` / `registration.review`(characterization 已锁)
- ❌ 不拆 `INSURANCE_ENFORCEMENT_ENABLED` 单 gate，不在 Activity 锁前查/选 source，不把 evidence/audit 移出 create 根事务；canonical command 也不得另写保险判断、不得在重提重复 evidence。approve 不得重新选择来源或把重验挪到 claim/audit 后；PR4 migration/约束代码已交付但尚未 deploy、生产未生效，禁止新增 Evidence 改删路径或绕过 `InsuranceRequirementService`
- ❌ **不**把 `cancelAdmin` / `cancelMy` 路径区分挪进 StateMachine(只通过 `extra.cancelledByPath` 在 audit 记录)
- ❌ **不**改 Admin Controller path `admin/v1/activities/:activityId/registrations`(`export` 字面段必须**先**于 `:id/<action>` 路由声明,Q-A6 锁定;调换顺序会被 Nest 路由解析为 `:id=export`)
- ❌ **不**把 Admin DTO 用 `extends` / `Pick` / `Omit` / `IntersectionType` / `PartialType` / `OmitType` 派生为 App DTO(沿 [`api-client-boundary` D-6](../../../docs/reference/api-client-boundary.md));App `dto/app/`字段集**刻意删除**`memberId`/`memberNo`/`memberDisplayName`(沿 §16.B.2)
- ❌ App self 视角 where 子句**永远**用 `currentUser.memberId` 锁本人；managed 视角只认当前活动 active responsibility capability；两者都**禁止** role 短路 / `scope=all`
- ❌ **不**主动拆 `activity-registrations.service.ts`(1727L,沿 [`/docs/current-state.md §4 P2`](../../../docs/current-state.md))
- ❌ **不**在 CSV 导出路径引入 `csv-stringify` 等新依赖(沿 Q-A6 + [`/AGENTS.md §3`](../../../AGENTS.md))
- ❌ **不**把递补改成 waitlisted → pass；腾出名额只自动进 pending，仍必须走 approve
- ❌ **不**把报名通知改回 commit 后 best-effort 直调 dispatcher；不得在业务事务内调用 provider，且 gate=true 不得用 `publishedBy` 冒充当前 owner
- ❌ **不**把 upload session 当作报名答案、RegistrationRevision 或永久报名身份；不得在 Form/session/AVAILABLE 全部复核和不可变答案行创建之前提前 consumed/转绑。最终转为 `registration-form-answer` owner 与 consumed 只能由 canonical command 通过 trusted facade 在同一事务完成；不得把 Provider/签名/文件内容校验放进数据库事务。
- ❌ 现场临时参加不得复活或 relink 历史报名头、不得把 `pass` 当非幂等重试、不得接 Form 答案/上传、不得扩展为邀请 accept / allocation / waitlist / cancel；资格条件未定义时必须保留 21039，而非以“现场”理由跳过。

## Before editing

- 状态机:[`activity-registration-state-machine.ts`](activity-registration-state-machine.ts)
- audit:[`activity-registration-audit-recorder.ts`](activity-registration-audit-recorder.ts)
- App service(scope / 字段集 / canUseApp 准入):[`app-my-registrations.service.ts`](app-my-registrations.service.ts) 文件顶部注释
- 跨模块边界:[`/docs/participation-bounded-context.md §4 / §5 / §6`](../../../docs/participation-bounded-context.md)(尤其永久报名头已落、取消重报 runtime 复用仍待那条)
- 永久报名头 migration:在 `prisma/migrations/` 内查 `20260809120000_activity_v11_batch4_registration_head_permanent_unique`

## Validation

- `pnpm lint` + `pnpm typecheck`
- 改业务行为 → `pnpm test:e2e -- activity-registrations app-my-registrations`(覆盖 6 spec)
- 改 audit event / extra → 必须跑 `activity-registrations-audit-characterization.e2e-spec.ts`
- 改状态机 → 必须跑 `activity-registrations-state-transition.e2e-spec.ts`
- 改 DTO 字段 / endpoint path / Swagger schema / 错误码 → 必须再跑 `pnpm test:contract`
- 改现场临时参加 → `pnpm test:e2e -- activity-batch4-onsite-participation.e2e-spec.ts`（含 20 同键并发、100 人 capacity=1 与 Form/RuleSet fail-closed）
