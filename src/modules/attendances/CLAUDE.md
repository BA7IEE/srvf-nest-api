# attendances — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);上下文边界读 [`/docs/participation-bounded-context.md`](../../../docs/participation-bounded-context.md);架构边界读 [`/docs/architecture-boundary.md`](../../../docs/architecture-boundary.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## 本地事实

- `attendances.service.ts` 仍是 **god-service(Phase 6-B 两刀后 1481 NCLOC)**;`attendance-sheet-state-machine.ts` / `attendance-audit-recorder.ts` / `time-overlap-policy.ts` / `contribution-calculator.ts` / `attendance-presenter.ts`(P1-4 第一刀,2026-06-10)/ `attendance-sheet-query.service.ts` + `attendance-record.policy.ts`(Phase 6-B 第一/二刀,2026-08-15)已抽离。
- 响应序列化必须走 `attendance-presenter.ts`(Sheet 详情 / 列表项 / Record 含 member 摘要 / Decimal→string),**不**在 service 内重新手写字段映射;**读侧** select 与 where 构造已随 Phase 6-B 第一刀迁入 `attendance-sheet-query.service.ts`(见下方「已抽出的职责边界」),**写侧** `sheetSafeSelect` / `sheetFullSelect` 仍留 service。
- `attendance_sheets` **6 态**(含 `returned` 退回整改与终审);`attendance_records` 子表。
- 状态变更必须经过 `attendance-sheet-state-machine.ts`,**不**在 service 内裸写态迁移。
- `submit` 只创建 pending Sheet；**不得**跨 aggregate 直写 `Activity.statusCode='completed'`。活动完结唯一通路是 activities 模块的管理端 `complete` action。
- 业务写路径必须走 `attendance-audit-recorder.ts` 写入 `AuditLogEvent`;`list`/`findOne`/`reviewDetail` 也必须在查询后经该 recorder fail-closed 落库，extra 只记 operation/count/filterFields。
- **GPS 签到证据的审计口径(维护者 2026-08-01 拍板;canonical 在 [`/docs/handoff/miniapp.md`](../../../docs/handoff/miniapp.md) 与 [`/docs/handoff/admin-web.md`](../../../docs/handoff/admin-web.md))**:上一条的"业务写必审"**不含**队员自助签到/签退的**成功**路径 —— 事实记录就是那行 `ActivityCheckIn`(坐标/精度/距离/时间戳齐全且不可变)，再写一条 audit 只是同一事实的副本。**管理端对签到记录的改/删必须审计**;本仓当前**零**管理端 `ActivityCheckIn` 写路径(管理端只经 `activity-check-in-query.service.ts` 只读)，新增即须接 recorder。两侧都有执行位:豁免钉在 `test/e2e/app-activity-check-ins.e2e-spec.ts`(合法打卡前后 `auditLog.count()` 不变)，写路径集合钉在 `activity-check-in-audit-policy.spec.ts`(出现第三处写调用即红)。
- **考勤通知 durable outbox(PR-L4/PR-M2a,2026-07-27)**:`firstReturn`/`finalReturn` 的整改通知与 `finalApprove` 的逐 record 结果/入队贡献达标通知，必须经 `attendance-notification-producer.ts` 在 Sheet 状态写、audit 的同一事务内 enqueue。退回收件人只认 active `canManageAttendance` assignment 与提交人当前 member 快照并去重；终审结果按 record 保留多时段多条。贡献达标必须在 Sheet 仍为 `pending_final_review` 时按最新 joining application/cycle 调正式 `computeContribution` 快照 capped before，更新 approved 后同事务再算 capped after；禁止 `after-rawDelta`。milestone key 固定 `team-join-contribution-met:{applicationId}:{threshold}`，同 application+门槛最多一次；普通 `attendance-final:{sheetId}:{finalReviewedAt}:{recordId}` 不变。worker commit 后执行 Effect；enqueue 失败整体回滚，provider 失败只重试 intent。
- **时间重叠并发保护(v0.44.0 finding #7)**:submit/edit 在跨 Sheet 重叠查询前,由 `TimeOverlapPolicy.lockMembersForOverlapCheck` 按排序去重的 memberId 获取 PostgreSQL transaction advisory lock;同人并发写必须串行,不得移到事务外或删掉锁后只保留 read-before-write。取锁实现已下沉共享原语 `lockMembersForWrite`(并发审计 K3):**队员维度只允许有一把键**(单参数 `hashtext(memberId)` advisory 空间),各处自己写一份 SQL 迟早漂成两把锁。
- **受保护状态写(2026-07-21)**:`edit`/`softDelete`/`approve`/`reject`/`finalApprove`/`finalReject`/`reopen` 在读写 `attendance_records` 前统一调用 [`/src/common/prisma/claim-at-status.util.ts`](../../common/prisma/claim-at-status.util.ts) 的条件 `SELECT ... FOR NO KEY UPDATE`；获锁后重读 Sheet，version/previousSnapshot、子行读写、真实更新与 audit before 只用锁后行。败者复用既有状态 BizCode 且不得先破坏子行；合法迁移矩阵仍只在 `attendance-sheet-state-machine.ts`。
- **submit × registration 并发不变式**:submit 先对 Activity `FOR SHARE`，批量校验后按 registrationId 排序去重调用公共 `claimAtStatus(expected=pass)`；与 pass cancel 保持 Activity → Registration 锁序。submit 先认领时，后到取消必须在 records 提交后由既有 `ACTIVITY_REGISTRATION_HAS_ATTENDANCE=21033` 拒绝，禁止留下 cancelled + live record
- **已取消活动的增量闸(A-R2 拍板 2026-07-31,方案乙「放行存量、掐断增量」)**:活动 `cancelled` 后 —— **放行存量**:取消前已提交的考勤单仍可 `approve → finalApprove` 并结算服务时长与贡献值(工是真做了的,不因活动取消而作废);`resubmit`/`reopen`/`approve`/`finalApprove` 刻意**不**加活动状态闸。**掐断增量**:`submit` 拒(既有 20122),`edit` 的 **records 分支**拒(同码 20122)—— 改写既有单的 records 是贡献值仅剩的另一条增量来源。判定唯一出口是 `ActivityParticipationPolicy.canChangeAttendanceRecords`,**只拦 `cancelled`**,draft/published/completed 的编辑行为逐字不变;该读位于 K1 的 Activity `FOR UPDATE` 之内,并发 cancel 挤不进闸旁。执行位:`test/e2e/attendance-cancelled-activity-increment-gate.e2e-spec.ts`(含全库巡检:已取消活动上的考勤单 records 数不得增长)
- **Activity 聚合锁无条件取(并发审计 K1,2026-07-31)**:`submit`/`edit`/`softDelete`/`resubmit` 的 Activity 锁**每条 surface 都要取**,不得挂在 `authorization==='managed'` / `managedActivityId !== undefined` 这类判权分支上而没有等价的 else(第七种形状 S7:单读一个方法看不出来,只有把两条 surface 并排看才发现其中一条裸奔)。`edit`/`softDelete` 的 managed 分支先按 `managedActivityId` 取锁再判权(**不得**把 Sheet 存在性暴露在判权之前),Admin 分支读到 Sheet 后按其 `activityId` 取同一把锁。执行位:`test/e2e/attendance-admin-edit-registration-concurrency.e2e-spec.ts`(占住 Activity 行锁时被测写路径必须等待)
- **records 引用的 registration 必须锁内认领 + 锁后复判**:`submit`/`edit` 共用 `claimAndRecheckRegistrations` —— 排序去重 `claimAtStatus(expected=pass)` 后**必须**按同一批 id 复读,重判归属活动 / 归属队员 / 状态 / 岗位时段。claim 只保证「锁到手时仍是 pass」,records 依赖的其余事实全部来自 claim 之前那次普通读;禁止退回「只 claim 不复读」
- **贡献值聚合的 member 共同锁(并发审计 K3)**:`finalApprove`/`reopen` 在读贡献快照前调用 `common/prisma/member-advisory-lock.util.ts` 的 `lockMembersForWrite`。入队里程碑判定跨该成员当年**全部** approved Sheet,只锁单张 Sheet 会 write skew(两边各读 before=3、各算 after=4,跨过 5 分却零 intent,outbox 唯一键兜不住「两边都没插」)。**取键位置固定在 Sheet claim 之后**,与 submit/edit 的「聚合行锁在前、member 键在后」同向;取在 claim 之前会与 `edit` 反向凑出 40P01
- **资格链完整性(C-QUAL)**:Admin submit/edit 每次用同一个服务端 `now` 拒绝 `checkOutAt > now`(22079),App 自助签到位置收紧见下方 GPS fail-closed 条目。`AttendanceRecordInputDto` 不接受 `contributionPoints`;submit/edit 均调 `ContributionCalculator`,无匹配规则落 0。`requiresInsurance=true` 时每条 record 必须带同活动/同成员/pass 的 `registrationId`;false 时仍可空。当前 attendance 只校验提交时的活动开关与报名关联,不能证明该报名创建时 `requiresInsurance=true`,不追溯旧报名,也不代表保险独立核验。
- **终审批量化 + 隔离级别 + 有界锁等待(M3,2026-08-01)**:`finalApprove` 的 before/after 贡献值快照与逐条
  outbox intent 全部批量(`computeContributionBatch` 按 cycleYear 一次;`outbox.enqueueMany` 恒 2 次 SQL)——
  200 人考勤单实测 **810 → <40 次 SQL**,与人数无关。❌ **不许改回逐条,也不许靠调大事务 timeout 顶过去**:
  那只是把锁持有得更久,convoy 更严重。封顶算法只有一份(`capByBeijingDay`,单人 / 批量共用),
  ❌ 不得复制或用原始分反推。`submit`/`edit`/`finalApprove`/`reopen` 四个取 member 键的事务一律走
  `runMemberLinearizedTransaction`:**显式 `ReadCommitted`**(库默认若是 RR,快照停在取键之前,
  排到队也读不到刚提交的分数,write skew 完整复活 —— 有实测用例)+ `SET LOCAL lock_timeout`
  (排队超时返 **40901** 可重试业务错误,不再 P2028 → 50000)。执行位:
  `test/e2e/attendance-final-approve-scale-isolation.e2e-spec.ts`(200 人规模 / convoy / RR 默认库)。
- **已知边界(finding #8,接受记录)**:数据库层未加 `btree_gist` / range exclusion constraint;原因是本仓首个 DB 扩展、托管库可用性未验且触发极罕见。当前只承诺应用写路径的事务 advisory lock;直连 SQL 绕过应用不在此保证内。
- **审核/终审判权(活动责任闭环 PR3)**:`approve`/`reject` 禁最初提交人或最近重提人自审，映射 22081；`finalApprove`/`finalReject` 禁提交/重提人自审(22074)并禁一级审核人与终审人同人(22075)，SUPER_ADMIN 也不豁免，`ATTENDANCE_ALLOW_SAME_REVIEWER` 仅兼容解析、不放开；`reopen` 不受审核约束。终审三动作走 `assertFinalReviewAuthzOrThrow`(`authz.explain` 带 ref)，权限来源为 scoped `attendance-final-reviewer` 或 SUPER_ADMIN，biz-admin 不持码。sheet 不存在 → 回退 `rbac.can`(持码者进事务抛 22001,无码者 30100 防枚举),其余 deny → 30100。角色码集为 `attendance.{read,final-approve,final-reject,reopen}.sheet`;e2e 矩阵在 `test/e2e/attendances-final-review-authz.e2e-spec.ts`。
- **其余调用位点判权(终态 scoped-authz PR12 + v0.49 部门范围)**:`submit`/`list`(嵌套 `:activityId`)带 `{type:'activity', id: activityId}`;`findOne`/`reviewDetail`/`edit`/`softDelete`/`approve`/`reject` 带 `{type:'attendance_sheet', id}`;`listRecordsForMemberAdmin`/`getMemberContributionSummary` 带 `{type:'member', id: memberId}`;`listAllSheetsForAdmin` 通过 `getVisibleOrganizationScope` 按 `activity.organizationId` 下推并与用户组织筛选取交集。`resource_not_found` 回退同 PR9 范式:持全局码者交回既有 NOT_FOUND,无码者 30100。scoped 生效 e2e 在 `test/e2e/participation-scoped-authz.e2e-spec.ts`。
- **活动岗位时段接线(2026-07-16 F4)**:App 签到/签退在既有 Activity→Registration 锁序和锁后重读内，从 `registration.activityPosition` 选择岗位 `startAt/endAt`；无岗位或岗位未配置独立时段才回退活动窗，`ActivityCheckInPolicy` 纯函数签名不变。考勤 submit/edit 的批量 registration IN 预取同样按每条记录选择岗位窗；`registrationId=null` 仅在 `requiresInsurance=false` 时继续走活动窗。`attendance-sheet-draft` 从报名岗位带出 `attendanceRoleCode`，无岗位为 `member`；忘签退时岗位报名回退岗位 `endAt`，从而提交后继续由既有 `activityTypeCode × roleCode` 规则计算贡献值。不得改成逐条查询或重新堆一套贡献计算。
- **GPS 位置 fail-closed(2026-07-18 D-GPS)**:`ActivityCheckInLocationPolicy` 是唯一 geofence 判定源；首次 App 签到/签退只有活动坐标与通过 DTO 的请求坐标均完整合法、且未舍入 Haversine 距离 `<= attendance.checkInRadiusMeters` 才写。活动定位异常/策略层非法坐标/超范围统一 22080，请求 DTO 缺失或非法沿 40000，均零 `ActivityCheckIn`/Sheet/Record/Audit 派生写。`accuracy` 只落证据，不扩缩半径。已有合法 winner 仍在位置判定前幂等返回 200，非法重试不得覆盖快照；新签到行固定 `geoVerified=true/outOfRange=false`，历史异常字段/行与 Admin 只读草稿、手工考勤路径均保留不改。
- **第 5 批 QR / PunchEvent 主链**：`AttendancePunchCommandService` 是本人扫码、责任人早退闭合和 void/replace 的唯一写入口（Activity 根事务持有者；行锁与准入断言已边界化为 `attendance-punch-access.service.ts`，该类以调用方 `tx` 为入参、不自持 `$transaction`，**锁序仍由调用方负责**，既有 Activity → Session → Identity → QR/Event 不得反转；`PUNCH_EVENT_SELECT` 亦由该文件导出，两侧共用同一投影）；`AttendanceQrCredentialService` 只负责负责人签发、作废、受保护渲染与相同根锁序下的职责复查。`AttendancePunchEvent` 只能追加，void/replace 必须以新事实令旧事实失效，服务段只由既有 projector 投影；不得回写或物理删除历史事件。二维码明文 token 只在受保护 SVG render 的进程内使用，绝不进入 JSON DTO、Presenter、audit extra、日志或数据库；token digest / request hash 同样不是 App 读面字段。所有这类写与整单取消共用 Activity 根事务，取消必须按 effective facts 拒绝仍有有效 PunchEvent 的活动。
- **第 6 批工作人员/导入链**：工作人员凭证 render、staff scan、proxy、bulk job、CSV preview/execute 都只能复用 `AttendancePunchCommandService` 的同一 Activity 根事务写核；managed 路由的 `LoginScoped(responsibility)` 只声明边界，写核/worker item 仍须锁后重验 active `canManageAttendance=true`。bulk/import 的每个 item 必须重验 lease/fence、责任、identity、窗口、segment 与 seal；preview 的文件 digest、parserVersion、rowHash、previewHash 都须在 execute 前重新核验，不能把静态预览当成写入授权。
- **第 6 批离线写链（B6-2）**：六条 wire 固定在 `/app/v1/my/managed-activities/:activityId/onsite`，只由 `AttendanceOfflinePackageService` 持有 Activity→OfflinePackage 根事务与 issue/revoke/upload/review 状态编排；正式 `sourceCode=offline` 事件必须调用 `AttendancePunchCommandService.offlinePunchWithinTransaction`，不得出现第二 writer。package token/成员凭证/事件签名只在请求验证边界存在，DB/audit/错误/安全读面禁止原文；22097 必须零写，22098/22099 只 staging 且零 PunchEvent，approve 才能在同事务正式化。

## 已抽出的职责边界(Phase 6-B 第二域,2026-08-15)

- **`attendance-sheet-query.service.ts`(第一刀,§3.2 QueryService)**:四条列表 surface 的 where 构造、
  分页、orderBy、读侧 select 投影(`sheetListSelect` / `recordWithMemberSelect` /
  `adminSheetListSelect` / `adminMemberRecordSelect`),以及 `memberExists` 存在性查询。
  **判权腿不在其中**(沿 members 第一刀 #1008 先例)—— `assertCanOrThrow` /
  `resolveVisibleOrganizationIds`(内含 `getVisibleOrganizationScope` 与 30100 抛出)仍归
  `AttendancesService`,算好的 `visibleOrganizationIds` 作为**入参**传入(§3.2 只豁免
  「显式传入的 read-scope filter」)。该类**不注入** rbac / authz,module 里也**不 exports** ——
  跨模块读仍走 `AttendancesService` 那一个入口,避免出现绕过判权腿的第二条读路径。
  `recordWithMemberSelect` 由 service `import` 回来供 12 处**写路径回读**复用(单一真相源)。
- **刻意没搬的三类**:① `sheetSafeSelect` / `sheetFullSelect`(写路径回读 + §4「loading the
  aggregate root」);② `findOne` / `reviewDetail` 那种**回调式** `$transaction` 内的读(同 §4);
  ③ `expand` 投影与 `activityTitle` 拼装、`MEMBER_NOT_FOUND` 抛出(响应组装与 BizCode 映射是
  业务判定,不是查询构造)。
- **`attendance-record.policy.ts`(第二刀,§3.3 Policy)**:record 的域校验与 normalize ——
  `normalizeRecord` / `spanHours` / `assertRecordWithinActivityWindow` / `resolveScheduleWindow` /
  `assertRegistrationConsistent` / `validateAndNormalizeRecord` / `assertRecordAgainstLockedRegistration`,
  以及 `DICT_TYPE_ATTENDANCE_*` 两个常量(service 侧预取 where 与本文件 key 比对共用同一份)。
  文件名用**点号**,命中 `eslint.harness.mjs:596` 规则 (j) 的 files glob ⇒ **结构上不可能 import
  `prisma.service`**(既有 `time-overlap-policy.ts` 用横线,不在该规则内)。比规则更严的是:
  连**传入的 client** 也不收 —— **3 次 IN 预取与 claim 锁后复读留在 service**,查询**结果**当入参传进去。
  ⚠️ **`validateAndNormalizeRecord` 的判定顺序即错误码契约**(角色码 → 状态码 → 队员存在 →
  保险缺报名 → 报名归属活动 → 报名归属队员/pass → normalize → 时间窗 → 未来签退),
  由 `attendance-record.policy.spec.ts` 用「同时踩两个雷、断言先报的那个」逐对钉住;**重排 = 改契约**。
  submit/edit 的普通批校验与 claim 锁后复判现在**共用同一份** `assertRegistrationConsistent`
  (原本是逐字重复的两段,漂移一处就是安全缺口)。
- **第二刀刻意没搬**:`assertLockedReviewSeparation` / `assertManagedSheetActivity` —— 两者虽是纯判定,
  但属**审核分离 / managed 面归属**,与 record 字段校验不是同一职责,并进去就成了 §7 明禁的 grab-bag。

## 不要做(踩雷区)

- ❌ **不**在没有单独立项的情况下继续拆 `attendances.service.ts`(characterization tests 已落地,
  但每一刀都要单独立项,沿 [`/docs/current-state.md §3`](../../../docs/current-state.md))。
- ❌ **不**把判权腿下放进 `attendance-sheet-query.service.ts`,也**不**把它加进 module 的 `exports` ——
  两者任一都会造出一条绕过 `AttendancesService` 判权的读路径。
- ❌ **不**重排 `validateAndNormalizeRecord` 的判定顺序(那是错误码契约,不是实现细节);
  **不**把 `attendance-record.policy.ts` 改成横线命名或让它 import `prisma.service`
  (两者任一都会把它移出 eslint 规则 (j) 的管辖,纯函数保证随之作废)。
- **Controller 现状**:`attendances.controller.ts` 仅 2 个 Admin class(`AttendanceSheetsCollectionController` + `AttendanceSheetsResourceController`,前缀 `admin/v1/*`);队员自助考勤记录(原 `/v2/users/me/attendance-records`)现位于 [`controllers/app-my-attendance-records.controller.ts`](controllers/app-my-attendance-records.controller.ts)(`@Controller('app/v1/my')`,`GET /attendance-records`)。历史 legacy controller(`attendances-me-records-legacy.controller.ts`)已于 Route B Phase 4d2 删除。
- ❌ **不**借此继续移动 Admin controller(`AttendanceSheetsCollectionController` / `AttendanceSheetsResourceController` 留在 `attendances.controller.ts`),除非另有设计决议。
- ❌ **不**改 App endpoint `GET /api/app/v1/my/attendance-records` 的 path / method / tag / roles / DTO / service call(contract-locked;改任一项升档并须显式更新 snapshot)。
- ❌ **不**借此启动 `attendances.service.ts` 拆分(沿上一条 god-service 禁条与 [`docs/architecture-boundary.md §8`](../../../docs/architecture-boundary.md))。
- ❌ **不**在无 contract 审批下改 OpenAPI snapshot(沿 [`docs/api-surface-policy.md §2.4 / §3`](../../../docs/api-surface-policy.md) + [`testing-discipline`](../../../docs/reference/testing-discipline.md);改 path / DTO / schema 必须显式更新 snapshot 并升档)。
- ❌ **不**新增 Mixed Controller(class-level + 方法级双 `@ApiTags`)。
- ❌ **不**绕过 state-machine / audit-recorder 直接改 sheet 状态。
- ❌ **不**把 admin DTO 用 `extends` / `Pick` / `Omit` 派生为 App DTO(沿根 [`AGENTS.md §2 D-6`](../../../AGENTS.md));App DTO 进 `dto/app/`。
- ❌ App 视角 endpoint 进 `controllers/app-*.controller.ts`,where 子句永远用 `currentUser.memberId` 锁定本人。
