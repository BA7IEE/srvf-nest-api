# 并发写路径横向审计(report-only)

> **性质**:只读审计,**零 `src/` 改动**。本文只记录判定与依据,**不实施任何修复**。
> **范围**:`attendances` / `activities`(含 waitlist)/ `activity-registrations` / `team-join` 的**全部写路径**。
> **明确不在范围**:`certificates` / `recruitment`(已四轮覆盖)· `auth` / `authz` / 限流(碰到即停)。
> **审计日期**:2026-07-31 · **base**:`7b0f5c25`(= `origin/main`)

---

## 1. 摘要

| 模块 | 落点数 | 🔴 | 🟡 | 🟢 |
|---|---:|---:|---:|---:|
| `attendances` | 13 | 1 | 1 | 11 |
| `activities`(含 waitlist / positions / publish-review / responsibility) | 28 | 1 | 1 | 26 |
| `activity-registrations` | 8 | 0 | 0 | 8 |
| `team-join` | 7 | 0 | 0 | 7 |
| **合计** | **56** | **2** | **2** | **52** |

**一句话结论(逐模块)**:

- `attendances`:**11 处 `claimAtStatus` 全部「锁后复读」,S1 零命中**;真正的洞不在锁的用法,而在**哪些行被锁** ——
  Admin `edit` 既不锁 Activity 也不认领 registration,而同一文件里的 `submit` 两样都做。
- `activities`:主 service 5 处 `claimAtStatus` 之前**都已持有 Activity `FOR UPDATE` 聚合锁并重读**,
  所以 `current` 本身就是锁后行,S1 结构上不成立;缺陷在**终态不级联子实体**(cancel 不管考勤单)。
- `activity-registrations`:5 处 `claimAtStatus` 全部「锁后复读 + 锁后守卫」,`cancelAdmin` / `cancelMy` 的
  参与证据守卫 `assertNoParticipationEvidence` 明确建立在锁后行上。**本模块零 finding。**
- `team-join`:2 处 `claimAtStatus` 全部锁后复读,`evaluate` 还在锁后**重跑了门槛与贡献值判定**;
  `markGate` / `join` / cycle update 均先取行锁再读。**本模块零 finding。**

**另有一项超出六种形状的新发现,见 §6「第七种形状」。**

---

## 2. 逐落点表

判定口径:🔴 = 能写出并发交错的活 bug · 🟡 = 形状命中但当前被挡住 · 🟢 = 正确。

### 2.1 `attendances`(13 落点)

| # | file:line | 落点 | 形状 | 判定 | 依据 |
|---|---|---|---|---|---|
| A1 | [attendances.service.ts:686](../../../src/modules/attendances/attendances.service.ts) | `submit` | — | 🟢 | Activity `FOR SHARE`(managed 为 `FOR UPDATE`)→ `claimRegistrationsForSubmit` 排序去重认领 `pass` → advisory member 锁 → 建单。锁序与写全在同一 tx |
| A2 | [attendances.service.ts:1182](../../../src/modules/attendances/attendances.service.ts) | `edit`(**Admin surface**) | S2/S3 | **🔴 R1** | 见 §3.1。registration 只经 `findMany`(:590)读,无 `FOR SHARE`/无 claim;Admin 路径 `managedActivityId===undefined` → **连 Activity 锁都不取** |
| A3 | attendances.service.ts:1182 | `edit`(**managed surface**) | — | 🟢 | `lockActivityForManagedAttendance`(:1195,`FOR UPDATE`)挡住并发 cancel(cancel 对 pass 报名必取 Activity `FOR UPDATE`) |
| A4 | [attendances.service.ts:1339](../../../src/modules/attendances/attendances.service.ts) | `softDelete`(Admin surface) | S7 | 🟡 Y1 | 见 §4.1。同样只在 managed 分支取 Activity 锁,但后果止于**误报 21033**,不破坏不变量 |
| A5 | attendances.service.ts:1411 | `approve` | — | 🟢 | claim(:1429)→ `findSheetOrThrow` 重读为 `lockedSheet`(:1435)→ 自审隔离、R31 校验、version/audit before 全用锁后行 |
| A6 | attendances.service.ts:1478 | `firstReturn` | — | 🟢 | 同上范式(claim :1495 → 重读 :1501) |
| A7 | attendances.service.ts:1552 | `reject` | — | 🟢 | claim :1573 → 重读 :1579;子行软删在重读之后 |
| A8 | attendances.service.ts:1639 | `finalApprove` | — | 🟢 | claim :1657 → 重读 :1663;贡献快照与通知 enqueue 同 tx |
| A9 | attendances.service.ts:1744 | `finalReturn` | — | 🟢 | claim :1758 → 重读 :1764 |
| A10 | attendances.service.ts:1826 | `finalReject` | — | 🟢 | claim :1846 → 重读 :1852;records 跟随软删在重读之后 |
| A11 | attendances.service.ts:1902 | `resubmit` | — | 🟢 | **无条件**取 Activity `FOR UPDATE`(:1917)→ claim :1924 → 重读 :1930 |
| A12 | attendances.service.ts:1979 | `reopen` | — | 🟢 | claim :1994 → 重读 :2000 |
| A13 | [app-activity-check-ins.service.ts:80/134](../../../src/modules/attendances/app-activity-check-ins.service.ts) | `checkIn` / `checkOut` | — | 🟢 | `lockAndLoadWriteContext`(:254)Activity `FOR SHARE` → registration `FOR SHARE`(**带 `statusCode='pass'` 谓词**)。`FOR SHARE` 与 cancel 的 `FOR NO KEY UPDATE` 互斥 ⇒ 双向串行;锁后重读并重跑时间闸 |

> **对照价值**:A13 与 A2 写的是同一张 `ActivityRegistration` 的下游证据,A13 取了 `FOR SHARE`,A2 什么都没取。

### 2.2 `activities`(28 落点)

| # | file:line | 落点 | 形状 | 判定 | 依据 |
|---|---|---|---|---|---|
| B1 | [activities.service.ts:547](../../../src/modules/activities/activities.service.ts) | `create` | — | 🟢 | 新建行,无既存行可竞争;字典/组织校验同 tx |
| B2 | activities.service.ts:650 | `update` | — | 🟢 | `lockAndFindActivityOrThrow`(:375 `FOR UPDATE` + 重读)在先,`current` 即锁后行;claim(:843)是冗余但无害的 CAS |
| B3 | activities.service.ts:939 | `softDelete` | — | 🟢 | 同 B2;参与存在性 count(:968)在 Activity 锁内,并发 submit/create 必阻塞 |
| B4 | activities.service.ts:1012 | `publish` | — | 🟢 | 同 B2 |
| B5 | [activities.service.ts:1093](../../../src/modules/activities/activities.service.ts) | `cancel` | **S4** | **🔴 R2** | 见 §3.2。`ACTIVITY_CANCELLED_REGISTRATION_STATUS_CODES`(:161)只含 `pending`/`waitlisted`;**AttendanceSheet 完全不级联** |
| B6 | activities.service.ts:1188 | `complete` | — | 🟢 | 同 B2;phase 闸在锁后重读上判 |
| B7 | [activity-waitlist-promotion.ts:75](../../../src/modules/activities/activity-waitlist-promotion.ts) | `promoteActivityWaitlist` | — | 🟢 | Activity `FOR UPDATE`(:85)→ Member 生命周期锁 → claim `waitlisted`(:136)→ 重读 `lockedCandidate`(:150);CAS 败者 `continue` 不回滚主事务 |
| B8 | activity-waitlist-promotion.ts:193 | `...AcrossPositions` | — | 🟢 | 同上(claim :371 → 重读 :383);headroom 基线在 Activity 锁内算,并发 approve/pass-cancel 必先拿同一把锁 |
| B9 | [activity-positions.service.ts:94](../../../src/modules/activities/activity-positions.service.ts) | `create` | — | 🟢 | `lockActivityOrThrow`(:399 `FOR UPDATE`)在先 |
| B10 | activity-positions.service.ts:170 | `update` | — | 🟢 | 同上;capacity read-modify-write 基线在 Activity 锁后读 |
| B11 | activity-positions.service.ts:314 | `softDelete` | — | 🟢 | 同上;active 报名 count 在锁内 |
| B12 | [activity-publish-review.service.ts:232](../../../src/modules/activities/activity-publish-review.service.ts) | `submitInitial` | — | 🟢 | `lockActivity`(:76)在先 + P2002 兜底 |
| B13 | activity-publish-review.service.ts:292 | `submitChange` | — | 🟢 | 同上 |
| B14 | activity-publish-review.service.ts:389 | `directPublish` | — | 🟢 | 同上 |
| B15 | activity-publish-review.service.ts:489 | `approve` | — | 🟢 | **Activity → review** 固定锁序(:510/511)→ 锁后重建服务端快照比对 → `baseRevision` 复查 |
| B16 | activity-publish-review.service.ts:665 | `returnReview` | — | 🟢 | 同锁序;决策用锁后 `review` |
| B17 | activity-publish-review.service.ts:751 | `withdraw` | — | 🟢 | 同锁序 |
| B18 | [activity-publish-review.service.ts:790](../../../src/modules/activities/activity-publish-review.service.ts) | `cancelPendingForActivity` | S3 | 🟡 Y2 | 见 §4.2。`findFirst`(:791)**先读后锁**,`decide(...)` 吃锁前 `pending.status`,`update`(:799)按 id 无条件写 |
| B19 | [activity-proposal-applier.ts](../../../src/modules/activities/activity-proposal-applier.ts) | `apply` | — | 🟢 | 无自有事务;唯一调用者 B15 持 Activity 锁,全部读均为锁后读 |
| B20 | [app-managed-activities.service.ts:230](../../../src/modules/activities/app-managed-activities.service.ts) | `declareAttendanceComplete` | — | 🟢 | Activity `FOR UPDATE`(:238)→ 锁后读 → 幂等闸 `attendanceDeclaredCompleteAt !== null`(:269)建立在锁后行 |
| B21–B26 | [activity-responsibility.service.ts](../../../src/modules/activities/activity-responsibility.service.ts) :390 / :460 / :523 / :630 / :718 / :773 | `addCollaborator` / `endCollaborator` / `transferOwner` / `transferInitiator` / `claimLegacy` / `assignLegacyInitiator` | — | 🟢 ×6 | **全部**先 `lockActivity` 再 `lockMembers`(移交时按 memberId 排序)再写;无条件分支,无 S7 |
| B27 | activity-responsibility.service.ts:273 | `createOwnerForPublish` | — | 🟢 | 无自有事务;调用者(B14/B15)持 Activity 锁 |
| B28 | [activity-responsibility-grant-projector.ts:26/80](../../../src/modules/activities/activity-responsibility-grant-projector.ts) | `createBindings` / `endAssignmentBindings` | — | 🟢 | 自身不取锁,但全部调用链在 Activity 锁内;`ended.count !== roleCodes.length` fail-closed(:113) |

### 2.3 `activity-registrations`(8 落点 — 全绿)

| # | file:line | 落点 | 判定 | 依据 |
|---|---|---|---|---|
| C1 | [activity-registrations.service.ts:921](../../../src/modules/activity-registrations/activity-registrations.service.ts) | `create` | 🟢 | `lockActivityForRegistrationCreate`(:524 `FOR UPDATE`)→ 全部闸 → create + partial unique/P2002 兜底 |
| C2 | activity-registrations.service.ts:997 | `createMy` | 🟢 | 同上 |
| C3 | activity-registrations.service.ts:1073 | `approve` | 🟢 | Activity `FOR UPDATE`(:1101)→ 保险/Member 锁 → claim(:1117)→ **重读 `lockedReg`**(:1123)→ capacity 复核用锁后行 |
| C4 | activity-registrations.service.ts:1180 | `reject` | 🟢 | claim :1204 → 重读 :1210 |
| C5 | activity-registrations.service.ts:1254 | `cancelAdmin` | 🟢 | pass 时 Activity `FOR UPDATE`(:1281)→ claim(:1283)→ 重读(:1289)→ **`assertNoParticipationEvidence(lockedReg.id)`(:1291)建立在锁后行** |
| C6 | activity-registrations.service.ts:1352 | `reopen` | 🟢 | claim :1375 → 重读 :1381 |
| C7 | activity-registrations.service.ts:1466 | `cancelMy` | 🟢 | 同 C5(Activity 锁 :1497 / claim :1499 / 重读 :1505 / 证据守卫 :1507) |
| C8 | [activity-registration-bulk.service.ts](../../../src/modules/activity-registrations/activity-registration-bulk.service.ts) | `bulkApprove` / `bulkReject` | 🟢 | 逐条委派 C3/C4,每条独立事务;**部分成功是已登记的契约**(handoff `admin-web.md:149`),非缺陷 |

### 2.4 `team-join`(7 落点 — 全绿)

| # | file:line | 落点 | 判定 | 依据 |
|---|---|---|---|---|
| D1 | [team-join-cycles.service.ts:51](../../../src/modules/team-join/team-join-cycles.service.ts) | `create` | 🟢 | 新建行;单 open 轮由 partial unique + P2002 兜底(:162) |
| D2 | team-join-cycles.service.ts:111 | `update` | 🟢 | `lockApplicationsThenCycleForUpdate`(:202)按 `id ASC` 先锁本轮全部 live application 再锁重读 cycle;与 D7 同向 |
| D3 | [team-join-applications.service.ts:112](../../../src/modules/team-join/team-join-applications.service.ts) | `markGate` | 🟢 | 裸 `FOR UPDATE`(:121)→ `findOrThrow` 重读(:124)→ 状态闸建立在锁后行 |
| D4 | team-join-applications.service.ts:189 | `evaluate` | 🟢 | claim(:206)→ 重读 `lockedRow`(:212)→ **锁后重跑** `allGeneralGatesSatisfied` + `computeContribution`(:223/228),注释与代码一致 |
| D5 | [team-join-applications.app.service.ts:146](../../../src/modules/team-join/team-join-applications.app.service.ts) | `submit` | 🟢 | 新建行 + partial unique/P2002 兜底(:171) |
| D6 | team-join-applications.app.service.ts:210 | `updateTargets` | 🟢 | claim(:229)→ 重读(:235)→ **锁后再判一次 `statusCode`**(:242)→ 用锁后 `lockedRow.cycle` 校验 |
| D7 | [team-join-enrollment.service.ts:99](../../../src/modules/team-join/team-join-enrollment.service.ts) | `join` | 🟢 | Application `FOR UPDATE`(:110)→ Cycle `FOR SHARE`(:120)→ 锁后读 app 并判 approved(:135)→ Member/User 生命周期锁 → 全部兜底重校验 → 单事务原子写 + P2002 兜底 |

---

## 3. 🔴 逐条展开

### 3.1 R1 — Admin `attendances.edit` 可与报名取消交错,留下 `cancelled` 报名 + live 考勤记录

- **落点**:[`src/modules/attendances/attendances.service.ts:1182`](../../../src/modules/attendances/attendances.service.ts)(`edit`),
  暴露面 = [`attendances.controller.ts:243`](../../../src/modules/attendances/attendances.controller.ts)
  → `PATCH /api/admin/v1/attendance-sheets/:id`(该调用只传 4 个实参 ⇒ `managedActivityId === undefined`)。
- **形状**:S2(相对 registration 完全无锁)+ S3(守卫建立在未加锁的读上)。

**为什么 `submit` 没事而 `edit` 有事** —— 同一文件里的两条路径对同一批 `ActivityRegistration` 的处理不对称:

| | Activity 锁 | registration 认领 |
|---|---|---|
| `submit`(:686) | ✅ `FOR SHARE`(:704),managed 为 `FOR UPDATE` | ✅ `claimRegistrationsForSubmit`(:657,`expected='pass'`) |
| `edit` **managed**(:1195) | ✅ `FOR UPDATE` | ❌ 无 |
| `edit` **Admin** | ❌ **无** | ❌ **无** |

两把锁**任一把**都足以关掉这个洞;Admin 路径两把都没有。

**并发交错**(A = Admin 编辑考勤单,B = 取消报名;`R` 是一条 `pass` 报名,此刻还没有任何 live 考勤记录 / 签到证据):

| 时刻 | A:`PATCH admin/v1/attendance-sheets/:id`(往 records 里**新增**一条引用 `R` 的记录) | B:`PATCH .../registrations/:rid/cancel` |
|---|---|---|
| t1 | 开 tx;`claimAtStatus(attendanceSheet)` + 重读 —— **只锁了 Sheet** | |
| t2 | `validateAndNormalizeRecordsBatch`(:1250)→ `tx.activityRegistration.findMany`(:590)读到 `R.statusCode='pass'` ✅(:632 校验通过)—— **未取任何行锁** | |
| t3 | (仍在跑 overlap advisory 锁 / 贡献值计算 / previousSnapshot / 旧 records 软删,窗口很宽) | 开 tx;`R` 是 pass → 取 Activity `FOR UPDATE`(:1281)—— **A 没持有它,不阻塞** |
| t4 | | `claimAtStatus(activityRegistration, 'pass')`(:1283)成功 —— **A 没持有 `R` 的行锁** |
| t5 | | `assertNoParticipationEvidence(R)`(:1291):`attendanceRecord.count` 读不到 A 未提交的行 → **0**;`activityCheckIn.count` → 0 → 放行 |
| t6 | | `R.statusCode := 'cancelled'`;**COMMIT** |
| t7 | `tx.attendanceRecord.createMany`(:1287)写入 `registrationId = R`;**COMMIT** | |

**后果**:

1. 终局出现 **`cancelled` 报名 + 未软删考勤记录**,这正是 `attendances/CLAUDE.md` 明文禁止的状态
   (「禁止留下 cancelled + live record」),也正是 `assertNoParticipationEvidence` 存在的目的。
2. 该状态**违反已发布的对外契约**:`docs/handoff/admin-web.md:80` 与 `docs/handoff/miniapp.md:30` 都承诺
   「报名一旦有未撤销的考勤记录,cancel 返 21033」。见 §5(S6)。
3. 这条记录随 Sheet 走完 `approve → finalApprove`,**给一条已取消的报名结算服务时长与贡献值**;
   贡献值进而喂给入队门槛(`computeContribution`)。
4. 反向自锁:此后再想取消 `R` 会被 21033 永久拒绝,除非先去考勤面软删记录 —— 数据已经进入需要人工拆解的状态。

**触发窗口是否现实**:t2→t7 之间 `edit` 还要跑 advisory member 锁、跨 Sheet overlap 查询、贡献规则计算、
snapshot 构建、旧 records `updateMany` 软删 —— 是本仓最长的写事务之一。窗口不是理论上的微秒级。

**前置条件**:`R` 在 t5 时刻没有 live 考勤记录/签到证据。这正是「编辑考勤单、补上漏记的队员」这一**主流程**的常态
(把已在单内的成员改时间不触发,**新增成员才触发**)。

**为什么没有数据库兜底**:`AttendanceRecord.registrationId` 的 FK 是 `onDelete: Restrict`
([`prisma/schema.prisma`](../../../prisma/schema.prisma) `model AttendanceRecord`),只拦**硬删**;
取消是 `statusCode` 的普通列更新。且插入子行只在父行取 `FOR KEY SHARE`,与 cancel 的 `FOR NO KEY UPDATE`
**不冲突**(这正是 `claimAtStatus` 选 `FOR NO KEY UPDATE` 的原因)。无 CHECK / 无触发器。

**建议修法(只建议,不实施)** —— 三选一,按侵入性从小到大:

- **(a) 最小、与 `submit` 对齐**:在 `edit` 里对 `normalized` 的 `registrationId` 调用既有
  `claimRegistrationsForSubmit(...)`(排序去重已在其内),位置放在 `validateAndNormalizeRecordsBatch` 之后、
  overlap 检查之前 —— 与 `submit`(:725)逐字同构。**改动 ~3 行,复用既有原语,无新锁对象。**
- **(b) 补齐锁序**:把 `edit` 的 Activity 锁改成无条件(Admin 走 `FOR SHARE`,managed 保持 `FOR UPDATE`),
  与 `submit`(:700-712)同构。副作用是同活动的并发 Admin edit 之间多一层串行。
- **(c) 两者都做**:与 `submit` 完全对齐。考虑到 `submit` 当初就是两样都上,一致性最高。

> ⚠️ 修 R1 时请一并复核 `softDelete`(Y1)与 `resubmit` —— `resubmit` 已经是无条件 Activity 锁(:1917),
> 三者现在是三种不同写法。

### 3.2 R2 — `activities.cancel` 不级联考勤单:已取消活动仍能走完考勤审批并结算贡献值

- **落点**:[`src/modules/activities/activities.service.ts:1093`](../../../src/modules/activities/activities.service.ts)(`cancel`)
- **形状**:S4(终态迁移不级联子实体)。

**事实**:

1. `cancel` 只 `updateMany` 了 `ACTIVITY_CANCELLED_REGISTRATION_STATUS_CODES = ['pending','waitlisted']`
   (:161 / :1144)—— **`pass` 报名原样留在 `pass`**。
2. `cancel` **完全不触碰 `AttendanceSheet`**(全方法无 `attendanceSheet` 写)。
3. 活动状态闸在 attendances 里**只存在于 `submit`**(:715 → `canSubmitAttendance` :826)。
   `edit` / `approve` / `reject` / `firstReturn` / `finalApprove` / `finalReturn` / `finalReject` /
   `resubmit` / `reopen` **九个写方法一次都没有读过 `Activity.statusCode`**(已全文件 grep 确认)。

**⚠️ 诚实标注**:这一条**不需要并发也能到达**(t0 提交考勤单 → t1 取消活动,顺序执行即可)。
按 goal §3 的口径它仍是 🔴(形状命中且**可达**,不是被挡住的 🟡),但它的本质是**级联缺口**,不是竞态。
下面给出的交错只是说明「即使运维先检查再取消也躲不掉」,不是它成立的必要条件。

**并发交错**(说明其不可用操作纪律规避):

| 时刻 | A:`POST admin/v1/activities/:id/attendance-sheets`(提交考勤单) | B:`PATCH admin/v1/activities/:id/cancel` |
|---|---|---|
| t1 | 开 tx;Activity `FOR SHARE`(:704)成功(活动仍 `published`) | |
| t2 | | 开 tx;`lockAndFindActivityOrThrow` 要 `FOR UPDATE` → **与 A 的 `FOR SHARE` 冲突,阻塞** |
| t3 | `canSubmitAttendance('published')` 放行 → 建 `pending` Sheet + records;**COMMIT** | |
| t4 | | 解除阻塞;活动 → `cancelled`;`pending`/`waitlisted` 报名 → `cancelled`;**Sheet 不管**;COMMIT |

终局:`cancelled` 活动上挂着一张 `pending` 的考勤单。此后 `approve` → `finalApprove` **畅通无阻**
(两者都不看活动状态),服务时长与贡献值照常结算并计入入队门槛。

**后果**:

1. 已取消的活动仍能产出**有效贡献值**;`GLOBAL_DAILY_CONTRIBUTION_CAP` 与入队门槛都会吃到这些分。
2. `pass` 报名滞留在 `pass`:队员端与管理端读模型上,一个已取消的活动仍显示「已通过」参与者。
3. 与 `softDelete`(:939)的口径**自相矛盾** —— 软删活动会因存在报名/考勤单直接拒绝
   (`ACTIVITY_PARTICIPATION_EXISTS_DELETE_FORBIDDEN` :979),而 `cancel` 对同样的子实体一句不问。

**建议修法(只建议,不实施)** —— 需要维护者先拍板语义,代码方案取决于拍板结果:

- **先拍板**:活动取消后,已存在的 `pending` / `pending_final_review` / `returned` 考勤单应当
  ①随之作废(`final_rejected` 或软删,records 跟随软删), 还是 ②冻结(禁止继续审批,但保留待人工处理),
  还是 ③**刻意放行**(补录已发生的服务 —— 若如此,则应把这个决定写进 CLAUDE.md 与 handoff,现在两处都没写)。
- **若选 ①/②**:在 `cancel` 的 Activity 锁内追加对 `AttendanceSheet` 的级联处理,或在
  `approve` / `finalApprove` 前置活动状态闸(复用 20122 `ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN`)。
  后者改动更小且能同时覆盖「先建单后取消」的顺序路径。
- **`pass` 报名是否一并取消**:同属这次拍板。注意 §2.3 C5/C7 的 `assertNoParticipationEvidence`
  会让「有考勤记录的 pass 报名」无法被取消,所以级联顺序必须是**先处理考勤单再处理报名**。

---

## 4. 🟡 逐条展开

### 4.1 Y1 — Admin `attendances.softDelete` 同样缺 Activity 锁(后果止于误报,不破坏不变量)

- **落点**:[`attendances.service.ts:1339`](../../../src/modules/attendances/attendances.service.ts)
- **形状**:S7(见 §6)—— Activity 锁在 `if (managedActivityId !== undefined)`(:1350)分支内,Admin 路径无 `else`。

**被什么挡住**:`softDelete` 的方向是**移除**考勤证据,不是新增。两种交错都收敛到安全态:

- A(softDelete)先提交 → B(cancel)的 `assertNoParticipationEvidence` 读到 0 → 正常取消 ✅
- B 先读 → 读到 A 未提交的 live records → **误报 21033** → 用户重试即成功 ⚠️

即:最坏结果是一次**假阴性的 21033**,没有「cancelled + live record」这类不变量破坏。因此不升 🔴。

**放松哪一条会立刻可达**:若将来给 `softDelete` 增加任何**新增性**副作用(例如软删 Sheet 时反写报名状态、
补写补偿记录、或触发候补递补),这条就与 R1 同构、立即升 🔴。
另外,若 R1 按 §3.1(b) 修(只补 Activity 锁而不补 registration claim),**应当同一刀把 Y1 一起补上**,
否则 `edit` / `softDelete` / `resubmit` 三种写法会继续分叉。

### 4.2 Y2 — `cancelPendingForActivity` 用锁前状态做决策 + 按 id 无条件写

- **落点**:[`activity-publish-review.service.ts:790`](../../../src/modules/activities/activity-publish-review.service.ts)

```
:791  const pending = await tx.activityPublishReview.findFirst({ where:{ activityId, status:'pending' } … })  ← 锁前读
:796  await this.lockReview(pending.id, tx);                                    ← 后加锁
:797  const decision = this.stateMachine.decide('activity-cancel', pending.status);  ← 吃锁前快照
:799  await tx.activityPublishReview.update({ where:{ id: pending.id }, … });   ← 按 id 无条件写
```

形状与 S3/S1 完全一致:**加锁之后没有重读,决策与写都基于锁前事实**。

**被什么挡住(具体位置)**:

1. **唯一调用者**是 [`activities.service.ts:1112`](../../../src/modules/activities/activities.service.ts)
   (`cancel` 内),而 `cancel` 在 :1101 已经通过 `lockAndFindActivityOrThrow`(:375)持有
   **Activity `FOR UPDATE`**。(全仓 grep 确认只有这一个生产调用点,另一处是 spec 里的 mock。)
2. **所有**其它 review 状态迁移都在 `lockReview` **之前**先 `lockActivity`:
   `approve`(:510→511)、`returnReview`(:691→692)、`withdraw`(:762→763);
   `submitInitial`(:239)/`submitChange`(:301)/`directPublish`(:396)同样先 `lockActivity`。

⇒ 在 `cancelPendingForActivity` 持有 Activity 锁期间,**没有任何路径能改动该 review 的 status**,
所以 :791 的读与 :799 的写之间不存在可插入的写者。当前不可达。

**放松哪一条会立刻可达**(任意一条即可):

- 给 `ActivityPublishReview` 增加**任何**不先取 Activity 锁的状态写入路径(例如一个 review 过期清理 cron、
  一个直接按 reviewId 操作的运维端点、或一个只 `lockReview` 的新 action);
- 把 `cancelPendingForActivity` 改成可被别的调用者复用(它是 `public` 的,签名 `(activityId, tx)`
  只要求传 tx —— **任何持 tx 但未持 Activity 锁的调用者都能合法调用它,类型系统不会拦**);
- `activities.cancel` 因任何重构失去 Activity `FOR UPDATE`。

> 这正是 goal §3 所说「三条互不相关的规则撞出来的『不可能』,是最脆的那种不可能」。
> 它现在的安全**完全依赖调用者的锁**,而这个契约没有写在函数签名、注释或任何断言里。
> 低成本加固(**建议,不实施**):在 :796 之后重读一次并复判 status,或把 `pending.status`
> 换成锁后重读值 —— 3 行,与仓库既有 `claim → 重读` 范式一致,且不需要改锁序。

---

## 5. S5 / S6 专项结论

### S5(注释声称不变量,但没有执行位)——**已扫,未发现假声明**

逐条核对了四个模块内所有断言性注释(`不可能`/`必然`/`理论上`/`恒`/`绝不`/`保证`/`永远` 等词面),
载荷最重的四条实际验证如下:

| 注释 | 位置 | 是否有执行位 | 结论 |
|---|---|---|---|
| 「每个 pair 恰有 0 或 1 条;漂移返回多条立即 fail-closed,绝不选首条/末条」 | [contribution-calculator.ts:38](../../../src/modules/attendances/contribution-calculator.ts) | ✅ 有 —— :73 `throw new Error('ContributionRule ACTIVE pair invariant violated…')` | ✅ 名副其实 |
| 「SQL 内 ORDER BY 保证跨 batch 取锁顺序一致,避免反向取锁死锁」 | [time-overlap-policy.ts:33](../../../src/modules/attendances/time-overlap-policy.ts) | ✅ 有 —— **已实测**,见下 | ✅ 成立 |
| 「onDelete=Restrict FK 保证 activity row 存在」 | attendances.service.ts:199 等 4 处 | ✅ 有 —— DB FK 约束;且注释准确区分了「行存在」与「未软删」 | ✅ 名副其实 |
| 「level-1 须存在 + ACTIVE(seed 已保证)」 | [team-join-enrollment.service.ts:84](../../../src/modules/team-join/team-join-enrollment.service.ts) | ✅ 有 —— 不依赖 seed,:95 显式 `MEMBER_GRADE_CODE_INVALID` | ✅ 注释比代码保守,无风险 |

**关于 advisory 锁顺序那条的实测**:该注释把死锁自由归因于 SQL 的 `ORDER BY`,而 PostgreSQL
一般**不保证** SELECT 列表相对 Sort 的求值顺序,所以这条值得怀疑。用一次性探针在本机 PostgreSQL 上
`EXPLAIN (VERBOSE, COSTS OFF)` 实测该查询,计划为:

```
Result                                              ← pg_advisory_xact_lock 在这里求值
  Output: (pg_advisory_xact_lock(...))::text, "*VALUES*".column1
  ->  Sort                                          ← 排序在下面
        Sort Key: "*VALUES*".column1
        ->  Values Scan on "*VALUES*"
```

锁函数被放在 Sort **之上**的 `Result` 节点求值(PostgreSQL 刻意不把 volatile 函数下推到 Sort 之下),
**取锁顺序确实跟随 `ORDER BY`,注释成立**。另外 :35 的 JS `[...new Set(ids)].sort()` 给出第二层确定性排序,
两层对 cuid(纯小写字母数字)口径一致;全仓 advisory 锁点已 grep,`member` 维度只有这一处,无反向取锁来源。
(探针为一次性 `EXPLAIN`,只读、未建对象、未进提交。)

### S6(运行时与 `docs/handoff/**` 契约分叉)——**发现 1 处,且是 R1 的下游**

逐条核对了 handoff 两份文档中与本次四模块写语义相关的断言(21033 / 20122 / 20124 / 20126 / 21035 /
终态五字段白名单 / 批量部分成功 / 候补递补 / reopen 语义),BizCode 编号与运行时**逐条一致**
(已核 `ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN=20122`、`ACTIVITY_REGISTRATION_HAS_ATTENDANCE=21033`;
终态字段白名单在 `activities.service.ts:684-691` 有执行位)。

**唯一分叉**:

> `docs/handoff/admin-web.md:80`:「③ **已考勤报名禁取消** —— 报名一旦有未撤销的考勤记录,
> `PATCH .../:rid/cancel`(及 App 端 `cancelMy`)返 **`21033`**」
> `docs/handoff/miniapp.md:30`:「已有考勤不可取消 `21033` 等既有闸不变」

这是一条**无条件的不变量声明**,而 §3.1 的 R1 表明它在 Admin `edit` 并发场景下**可被绕过**:
取消成功返回 200,事后才出现考勤记录。前端据此写的文案与状态机(「有考勤 ⇒ 一定取消不了」)在该场景下失真。

**注意这不是独立的文档漂移** —— 文档描述的是**正确的意图**,分叉的是运行时。
修 R1 即自动消除本条;**不建议**反过来去改文档来迁就当前实现。

---

## 6. 第七种形状(六种之外的新发现)

### S7 —— 锁的获取被绑在 authorization 分支上,同一个写操作的另一条 surface 裸奔

**形状**:同一个 service 方法(或写同一批表的一组姊妹方法)把行锁/聚合锁的获取放进
`if (authorization === 'managed')` / `if (managedActivityId !== undefined)` 之类的分支里,
**且没有 `else` 分支取等价强度的锁**。结果是:方法**看起来是加了锁的**,单独审读它会得出「已保护」的结论,
只有把两条 surface 并排看才发现其中一条什么都没取。

**机器可查的特征**(可做成 lint / AST 规则):
> 锁获取语句(`FOR UPDATE` / `FOR SHARE` 裸 SQL、`lockXxx(...)` helper、`claimAtStatus`)
> 出现在以 `authorization` / `managedActivityId` 为条件的 `if` 内,而该 `if` **没有** `else`
> 分支获取同一聚合的锁。

**为什么它不能被 S1–S6 覆盖**:

- 不是 S1 —— 锁**有**,而且锁后确实复读了(Admin `edit` 老老实实 `claimAtStatus` + `findSheetOrThrow` 重读)。
- 不是 S2 —— 方法不是「完全无锁」,它锁了 Sheet;缺的是**另一个聚合**的锁。
- 不是 S3 —— 守卫也不是建立在锁前读上,而是**该对象根本不在这个方法的锁集合里**。
- 诊断路径不同:S1–S3 读单个方法即可判定;**S7 必须跨 surface 对照才暴露**。
  这也解释了为什么 R1 能躲过前几轮评审 —— 逐方法读 `edit`,每一步都是对的。

**本次实测分布**(四个模块全量):

| 位置 | 分支条件 | Admin/authz 分支 | managed 分支 | 判定 |
|---|---|---|---|---|
| `attendances.submit`:700 | `authorization === 'managed'` | ✅ `FOR SHARE`(有 else) | ✅ `FOR UPDATE` | 🟢 |
| **`attendances.edit`:1194** | `managedActivityId !== undefined` | ❌ **无 else** | ✅ `FOR UPDATE` | **🔴 R1** |
| **`attendances.softDelete`:1350** | `managedActivityId !== undefined` | ❌ **无 else** | ✅ `FOR UPDATE` | **🟡 Y1** |
| `attendances.resubmit`:1917 | 无分支 | ✅ 无条件 `FOR UPDATE` | ✅ | 🟢 |
| `registrations.approve`:1085/1100 | 两个互补 `if` | ✅ `FOR UPDATE`(:1101) | ✅ `FOR UPDATE`(:1086) | 🟢 两条都锁 |
| `registrations.reject`:1193 | `=== 'managed'` | (不需要:无容量/候补副作用) | ✅ | 🟢 |
| `registrations.cancelAdmin`:1267/1280 | `managed` / `authz && pass` | ✅ pass 时锁 | ✅ 恒锁 | 🟢 非 pass 无需锁(非 pass 不可能有考勤记录) |
| `activities.*` 6 个写方法 | 无分支 | ✅ 无条件 `lockAndFindActivityOrThrow` | 同 | 🟢 |
| `responsibility.*` 6 个写方法 | 无分支 | ✅ 无条件 `lockActivity` | 同 | 🟢 |

⇒ **命中 2 处,都在 `attendances`,都是 `managedActivityId !== undefined` 无 else 的写法。**
`activities` / `responsibility` 采用「无条件取聚合锁」的写法,结构上免疫 S7 —— 这也是最省事的通用防线。

**这条形状的价值**:它给出了一个**不依赖人工推理的筛子**。`registrations` 里同样的条件分支写法之所以安全,
是因为两条分支都取了锁(或未取的那条确实不需要);把这个规则做成机器检查,就能把「需要跨 surface 对照才看得出来」
的判断降级成一次 AST 扫描。考虑到维护者无法审阅代码,**这类可执行化的规则比逐条修复更值钱**。

---

## 7. 本次未审(点名 + 原因)

| 未审对象 | 原因 |
|---|---|
| `certificates` / `recruitment` | goal §1 明确排除(已四轮覆盖) |
| `auth` / `authz` / 限流 | goal §4 红线「碰到即停」。**注意**:`assertCanOrThrow` / `authz.explain` / `rbac.can` 在四模块内被大量调用,本次**只把它们当作事务外的前置判权**看待,**未审**其内部并发语义,也未审「判权结果与事务内锁后事实是否可能不一致」 |
| `insuranceRequirement.*`(`InsuranceRequirementService`) | 跨模块被 `registrations.approve` / `create` / `team-join.join` 调用并在其中取 Member/Policy/Coverage 锁。**其内部锁序未逐行审计**,本次只核对了「调用点位于调用者的聚合锁之内」这一外部条件。若要给保险链条结论,需单独立项 |
| `members/member-lifecycle-lock.ts`(`lockAndReadLiveMemberLifecycle` / `lockMemberLifecycle`) | 同上,作为黑盒依赖使用;只核对了调用位置在锁序中的次序,未审其实现 |
| `notifications` outbox producer / worker | 四模块在事务内 enqueue,本次核对了「enqueue 与业务写同事务」,但 **worker 侧的并发消费语义未审**(不在 goal 范围) |
| `AuditLogsService.log` | 同事务写入,未审其内部 |
| e2e 实测复现 | **未跑**。R1 / R2 的判定全部来自代码路径 + PostgreSQL 行锁冲突矩阵 + schema/migration 核对,**未写并发 e2e 实证**。goal §4 允许一次性探针,本次只用探针验证了 §5 的 `EXPLAIN` 一项(纯只读)。**若维护者要把 R1 升级为「已实测」,需要两套 Nest/Prisma pool + `pg_blocking_pids` barrier 的并发 spec**(仓库已有此范式,见 `activity-publish-review-concurrency.e2e-spec.ts`) |
| `activity-feedbacks` / `contribution-rules` | 不在 goal §1 的四模块清单内,尽管与考勤贡献值链路相关 |

---

## 8. 建议修复排序(**建议,不执行**;最终范围由维护者拍板)

| 序 | 项 | 理由 | 预估侵入性 |
|---|---|---|---|
| 1 | **R1** — `edit` 补 `claimRegistrationsForSubmit`(§3.1 方案 a) | 唯一会**破坏已发布契约 + 污染贡献值**的活 bug;修法是复用同文件既有原语、与 `submit` 逐字对齐,~3 行 | 极小 |
| 2 | **Y1** — `softDelete` 与 `resubmit` 对齐锁写法 | 与 1 同一刀最省;不修则 `edit`/`softDelete`/`resubmit` 三种写法继续分叉,下次评审还要重新推一遍 | 极小 |
| 3 | **S7 做成机器检查** | 维护者无法审阅代码,**可执行化的规则 > 逐条修复**;规则简单(AST:锁调用位于 authorization 条件分支内且无等价 else),能防住这类缺陷复发 | 小(harness 侧) |
| 4 | **R2 拍板** — 活动取消后考勤单的语义 | **需要先做业务决策再写代码**,不是纯技术修复;且当前无数据损坏风险(是语义缺口),可以排在纯技术项之后。拍板后落地建议走「approve/finalApprove 前置活动状态闸」,同时覆盖顺序路径与并发路径 | 中(取决于拍板) |
| 5 | **Y2** — `cancelPendingForActivity` 锁后重读 | 当前不可达,但其安全性**完全寄生在调用者的锁上且无任何断言保护**;3 行加固可让它自洽 | 极小 |

> **排序理由**:1/2/5 都是低风险、可独立验证的小改动;3 是防复发的杠杆点;4 单独排在最后
> **不是因为它不重要**,而是因为它卡在业务拍板上,技术侧先动会做成半成品。

---

## 9. DoD 自查

- [x] 四个模块**全部写路径**都有判定(56 个落点),不只 26 处 `claimAtStatus`;未覆盖项在 §7 点名
- [x] 每个 🔴 都有可读的并发交错(R2 额外诚实标注「不需要并发也可达」);每个 🟡 都指出了挡它的**具体位置**
- [x] 零推断当事实:`EXPLAIN` 结论来自实测;锁冲突结论来自 PostgreSQL 行锁矩阵 + 代码;
      未实测项在 §7 明确标注「未跑 e2e」
- [x] S5 扫过一遍(4 条载荷最重的逐条验证,结论:无假声明);S6 扫过一遍(结论:1 处分叉,系 R1 下游)
- [x] `src/` 与 `test/` 零改动
