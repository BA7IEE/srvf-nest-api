# STATE_MACHINE_INVENTORY.md — 状态机登记现状(Phase 4-1a)

> **性质**:治理报告(写就即固定,不再生);Phase 4-1a 的取证留痕。
> **权威源**:`docs/archive/reviews/architecture-governance-v4/README.md` v4 §6 R10 + 勘误⑫;[`../architecture-boundary.md`](../architecture-boundary.md) §3.4。
> **机读登记表** = [`harness/state-machines.json`](../../harness/state-machines.json)(本页是它的人话视图,数值以它为准)。
> **本刀零执行位**:不建共享执行器、不加检查、不改 `action-state-checks.ts`、不回填 DB CHECK、不升任何条目为 `governed`。
> ⚠️ **§0–§9 是 Phase 4-1a 的留痕,写就即固定,4-1b 一字未改**。Phase 4-1b 的执行位、8 条升格与读数 true-up 见 **[§10](#10-phase-4-1b--governed-声明闸已落地)**;
> 两节读数若不一致,以 §10 为准(它是机器现算的,§9 的口径注意事项同样适用)。

## 0. 一句话结论

56 个 String 状态列全部补齐登记字段,**仍全为 `inventory`**。最普遍的缺口不是"没登记",而是
**25 条没有专属 wrong-state 错误码 / 22 条闭集没有 DB 兜底 / 20 条合法迁移边根本没有任何机器可读的声明** ——
其中 **18 条连一个具名状态机模块都没有**,判定散在 service 的裸 `if/throw` 里。
这决定了 4-1b 的执行位应当先守"**边与实现映射**",而不是先守"闭集"(闭集已有 34 条被 DB CHECK 兜住)。

## 1. 口径与方法(先看这节,否则下面的数会被误读)

| 项 | 口径 |
|---|---|
| 总体 | `harness/state-machines.json` 的 56 条 = `prisma/schema.prisma` 中**类型为 `String`** 且列名匹配 `/(status\|state\|stage\|phase\|lifecycle\|mode)(Code)?$/i` 的列(减去 `maritalStatusCode` / `politicalStatusCode` 两个字典属性豁免)。判据在 [`scripts/check-boundaries.ts`](../../scripts/check-boundaries.ts) `stateLikeString()` / `listStringStateColumns()`。 |
| 闭集"有 DB CHECK" | 指该列存在一条**整体形如** `CHECK ("col" IN (...))` 或 `CHECK ("col" IS NULL OR "col" IN (...))` 的约束。**复合 shape 约束里出现的 `IN (…)` 分支不算**(见 §1.1)。 |
| 迁移边 | 只记**代码里真的有判定**的边。无判定的一律记 `not-derived`,**不按语义臆造**。 |
| 层次 | L1 = 配置 / 标注列,取值由配置或 CRUD 决定、无流程语义;L2 = 简单流程(≤3 活跃态、线性或近线性);L3 = 复杂流程(≥4 态,或含审核 / 退回 / 回退语义)。 |

### 1.1 ⚠️ 本刀自己踩到的量具缺陷(必须记,否则下轮重犯)

第一版 CHECK 提取脚本给出"35 条有闭集 CHECK",**其中至少 4 条是假的**。两个独立缺陷:

1. **正则跨语句**:`ALTER TABLE "X" … [\s\S]*? CHECK (…)` 的惰性通配会跨过 `;`,把**后面另一张表**的 CHECK 认到 `X` 头上。
2. **把 shape 约束的分支当成闭集**:`ActivityAllocationBatch.statusCode` 的真闭集是 3 值
   (`preparing/committed/voided`,第 20260804100000 migration),但更晚的 `void_shape_check` 里有一句
   `"statusCode" IN ('preparing','committed')` —— 那是"非 voided 分支"的条件,不是闭集声明。
   "按 migration 取最新"的逻辑于是用分支条件**覆盖**了真闭集,读出 2 值。`modeCode` 同样从 3 值被读成 2 值。

两处都**不会报错**,读数看着完全合理 —— 破绽是 `activity-allocation.service.ts` 明明在写 `statusCode: 'voided'`,
与"闭集只有 2 值"直接矛盾。**教训:量缺陷的尺子自己也要验**;修正后加了 8 条已知真值的正对照断言,全绿才采信。
最终读数 **34 条有闭集 CHECK / 22 条没有**(不是 35/21)。

## 2. 三层分布

| 层 | 条数 | 含义 | 4-1b 取向 |
|---|---:|---|---|
| **L1 配置 / 标注列** | **13** | 无流程语义,边=任意(`unconstrained`) | 只需闭集,**不需要**边与迁移码 |
| **L2 简单流程** | **19** | ≤3 活跃态,线性/近线性 | 闭集 + 边成本低,可批量 |
| **L3 复杂流程** | **24** | ≥4 态或含审核/退回/回退 | 真正的治理对象,单条评估 |

> **对 goal 的一处口径偏离(已如实标注)**:goal 把 L1 写作"**配置二态**"。实际有 3 条配置列是 3–4 值
> (`allocationModeCode` 3 值 / `registrationModeCode` 4 值 / `ActivityAllocationBatch.modeCode` 3 值),
> 语义上仍是"选一个配置值、无流程",因此本报告把 L1 定义**放宽为"无流程语义的配置/标注列"**而非按值个数卡。
> 若按字面"二态"归类,这 3 条会被迫进 L2/L3 并被要求声明迁移边 —— 那是为分类而分类。

### 2.1 L1 清单(13)

| 列 | 闭集 | 来源 | governedBlockers |
|---|---|---|---|
| `Activity.allocationModeCode` | 3 值 | db-check | — |
| `Activity.registrationModeCode` | 4 值 | db-check | — |
| `ActivityAllocationBatch.modeCode` | 3 值 | db-check | — |
| `ActivityReservedQuotaGroup.fallbackMode` | 2 值 | db-check | — |
| `ActivityTemplate.defaultRegistrationModeCode` | 未声明 | undeclared | no-db-check |
| `AttendanceRecord.attendanceStatusCode` | 字典 | dictionary | no-db-check, dictionary-driven |
| `AttendanceSettlementVersion.returnFromStage` | 2 值 | db-check | — |
| `AttendanceSheet.returnedFromStageCode` | 2 值 | db-check | — |
| `Organization.establishmentStatusCode` | 字典 | dictionary | no-db-check, dictionary-driven |
| `QualificationEvaluationSnapshot.evaluationPhaseCode` | 3 值 | db-check | — |
| `RecruitmentApplication.eliminationStage` | 4 值 | ts-constant | no-db-check, retired-value-in-set |
| `SettlementReviewAction.stageCode` | 2 值 | db-check | — |
| `TeamJoinApplication.eliminationStage` | 3 值 | ts-constant | no-db-check |

两个 `eliminationStage` 是**淘汰原因标注**(仅 rejected 时记),不是生命周期列 —— 归 L1 是刻意的。

### 2.2 L2 清单(19)

`ActivityAllocationApplicationProjection.appliedStatusCode` · `ActivityAllocationBatch.statusCode` ·
`ActivityQualificationRuleSet.statusCode` · `ActivityResponsibilityAssignment.status` · `ActivitySession.statusCode` ·
`ActivitySettlementClosureRevision.statusCode` · `ActivityTemplate.statusCode` · `AttendanceQrCredential.statusCode` ·
`CapacityReservation.status` · `EvidenceSeal.statusCode` · `MemberInsurance.reviewStatusCode` ·
`NotificationDelivery.status` · `ParticipantServiceSegmentRevision.statusCode` ·
`ParticipantSettlementResultRevision.statusCode` · `RecruitmentCycle.statusCode` · `RegistrationFormVersion.statusCode` ·
`RegistrationUploadSession.statusCode` · `TeamJoinCycle.statusCode` · `WecomIdentity.status`

多为 `draft→active→retired` / `active→revoked|expired` / `draft→committed→superseded` 三种同形骨架 ——
**这是 4-1b 共享执行器最划算的一批**(19 条里 13 条已有 DB CHECK 兜底,只缺边与码)。

### 2.3 L3 清单(24)

| 列 | 闭集 | 有专属状态机? | governedBlockers |
|---|---:|---|---|
| `Activity.statusCode` | 5 | ✅ | no-db-check |
| `ActivityRegistration.statusCode` | 5 | ✅ | no-db-check, vocabulary-divergence |
| `AttendanceSheet.statusCode` | 6 | ✅ | no-db-check |
| `ActivityPublishReview.status` | 5 | ✅ | decision-shape-divergence |
| `ActivityParticipationIdentity.currentStatusCode` | 14 | 部分 | edges-partially-derived, impl-scattered, vocabulary-divergence |
| `ActivityParticipationRevision.statusCode` | 14 | 部分 | throws-instead-of-decide, edges-partially-derived |
| `ActivityBatchJob.statusCode` | 7 | ❌ | edges-not-derived, no-state-machine, no-wrong-state-bizcode |
| `ActivityBatchJobItem.statusCode` | 3 | ❌ | +closed-set-undeclared, no-db-check |
| `ActivityInvitation.statusCode` | 5 | ❌ | edges-not-derived, no-state-machine |
| `AttendanceCorrectionRequest.statusCode` | 7 | ❌ | edges-not-derived, no-state-machine |
| `AttendanceSettlementRun.statusCode` | 9 | ❌ | edges-not-derived, no-state-machine |
| `AttendanceSettlementVersion.statusCode` | 5 | ❌ | edges-not-derived, no-state-machine |
| `CorrectionApplication.statusCode` | 4 | ❌ | edges-not-derived, no-state-machine |
| `LedgerPostingBatch.statusCode` | 5 | ❌ | edges-not-derived, no-state-machine |
| `StorageObject.state` | 10 | ❌ | +no-wrong-state-bizcode |
| `StorageObjectOperation.status` | 4 | ❌ | +no-wrong-state-bizcode |
| `StorageObjectOperation.effectState` | 6 | ❌ | +no-wrong-state-bizcode |
| `Certificate.certStatusCode` | 4 | ❌ | +no-db-check, no-wrong-state-bizcode |
| `Content.statusCode` | 3 | ❌ | no-db-check, edges-not-derived, no-state-machine |
| `Notification.statusCode` | 3 | ❌ | no-db-check, edges-not-derived, no-state-machine |
| `NotificationOutboxIntent.status` | 4 | ❌ | +closed-set-undeclared, no-wrong-state-bizcode |
| `RecruitmentApplication.statusCode` | 8 | ❌ | +retired-value-in-set, duplicate-constant-definition |
| `TeamJoinApplication.statusCode` | 5 | ❌ | no-db-check, edges-not-derived, no-state-machine |
| `WecomAuthAttempt.status` | 5 | ❌ | +no-wrong-state-bizcode |

**24 条 L3 里只有 6 条有专属状态机**(其中 2 条只覆盖部分边)—— 这是本刀最重要的单条读数。

## 3. governedBlockers 聚合(决定 4-1b 守什么)

| blocker | 命中 | 含义 |
|---|---:|---|
| `no-wrong-state-bizcode` | **25** | 非法迁移没有专属 BizCode(报通用错或不报) |
| `no-db-check` | **22** | 闭集只活在应用层,DB 不兜底 |
| `edges-not-derived` | **20** | 合法迁移边没有任何机器可读声明 |
| `no-state-machine` | **18** | 无具名状态机模块,判定散在 service 裸 `if/throw` |
| `closed-set-undeclared` | 5 | 连一个具名常量/数组都没有,只有散落字面量 |
| `edges-partially-derived` | 2 | 有判定但只覆盖部分边 |
| `vocabulary-divergence` | 2 | 姊妹列同概念不同拼法(见 §5.1) |
| `dictionary-driven` | 2 | 闭集在 DictItem 表里,不在代码/DB 约束里 |
| `retired-value-in-set` | 2 | 闭集含自述"已退役、不再写入"的值 |
| `impl-scattered` | 1 | 同一列的边散在多个 command service |
| `throws-instead-of-decide` | 1 | 直接 `throw` 而非返回 decision(与其余机范式相反) |
| `decision-shape-divergence` | 1 | 返回字段名与同族机不一致 |
| `duplicate-constant-definition` | 1 | 同一闭集成员在两处独立定义(见 §5.2) |

**9 条零 blocker**(4-1b 可最先升 `governed` 的候选):`Activity.allocationModeCode` ·
`Activity.registrationModeCode` · `ActivityAllocationBatch.modeCode` · `ActivityReservedQuotaGroup.fallbackMode` ·
`AttendanceSettlementVersion.returnFromStage` · `AttendanceSheet.returnedFromStageCode` ·
`QualificationEvaluationSnapshot.evaluationPhaseCode` · `SettlementReviewAction.stageCode` ·
`ParticipantSettlementResultRevision.statusCode`。前 8 条都是 L1 —— 即**当前离 governed 最近的全是不需要边的配置列**,
这本身说明"已治理"的门槛还没被任何一条真流程列跨过。

### 3.1 对 4-1b 的直接含义

先守闭集是**错的优先级**:闭集已有 34/56 被 DB 兜住,而边有 20 条根本没有声明、18 条没有承载它的模块。
一致性检查若只比"闭集 vs CHECK",会对这 20 条**恒真通过** —— 那是空绿。
执行位应当先要求:**L3 条目必须指向一个具名实现模块,且其边可被机器读出**。

## 4. 8 个既有状态机的形状差异(约 5 种形状,零共享抽象)

| # | 文件 | 形状 | 治理的列 |
|---|---|---|---|
| 1 | `activities/activity-state-machine.ts` | **A**:`@Injectable` class,`decide(action, status='')` → `{allowed,nextStatusCode}\|{allowed,biz}` | `Activity.statusCode` |
| 2 | `attendances/attendance-sheet-state-machine.ts` | **A**(status 必填) | `AttendanceSheet.statusCode` |
| 3 | `activity-registrations/activity-registration-state-machine.ts` | **A** + 另导出等价自由函数 `decideActivityRegistrationTransition` | `ActivityRegistration.statusCode` |
| 4 | `activities/activity-publish-review-state-machine.ts` | **A′**:同签名,但返回 **`nextStatus`** 而非 `nextStatusCode`,且 `status` 可选 | `ActivityPublishReview.status` |
| 5 | `activity-registrations/onsite-participation-state-machine.ts` | **B**:自由函数,**无 action 参数**,只判一条边;返回 `{allowed,nextStatusCode}\|{allowed:false}`(**无 biz**) | `ActivityParticipationIdentity.currentStatusCode` |
| 6 | `activity-registrations/participation-revision-state-machine.ts` | **C**:自由函数,**直接 `throw BizException`**;另一个返回 `{kind:'append'\|'noop'}`(不是 allowed/next) | `ActivityParticipationRevision.statusCode` |
| 7 | `member-departments/membership-term-state-machine.ts` | **D**:全 `static` 方法,入参是 `{status,startedAt,endedAt}` **对象**不是 status 串;直接 `throw`;抛**通用 `BizCode.BAD_REQUEST`** | `MemberOrganizationMembership.status`(**enum,不在登记表内**) |
| 8 | `recruitment/recruitment-certificate-claim-state-machine.ts` | **E**:一组 `assert*` 自由函数(直接 `throw`)+ 派生计算 `recalcApplicationStatusForThresholds` | `RecruitmentCertificateClaim.status`(**enum,不在登记表内**) |

**共用 `decide(action, status)` 的是 #1–#4 四个**(与 goal 预判一致),但其中 #4 的返回字段名就已经和另外三个不一致 ——
即"四个同签名"只在**入参**上成立,**出参**已经分叉。#5–#8 各是一种形状。

**两条结构性发现**:

- **#7 / #8 治理的列是 Prisma `enum`,登记表按定义装不下**(它只收 `String` 列)。也就是说
  **8 个状态机里有 2 个,在 R10 登记表上没有任何对应条目** —— 登记表无法表达它们的实现映射。
- **#7 抛的是通用 `BizCode.BAD_REQUEST`**,不是任何 wrong-state 码 —— 调用方无法区分"任期不合法"与其他 400。

## 5. 闭集多源与冲突(如实记录,不调和)

### 5.1 `reject` vs `rejected` —— 姊妹表两套拼法

- `ActivityRegistration.statusCode` 闭集用 **`reject`**(`ACTIVITY_REGISTRATION_STATUS.REJECT`)。
- `ActivityParticipationIdentity.currentStatusCode` 的 14 值 DB CHECK 用 **`rejected`**。

两者是**不同的列**,不是同一列的两个来源冲突 —— 但它们同属参与域、语义相同。
最尖锐的一处:[`participation-revision-state-machine.ts`](../../src/modules/activity-registrations/participation-revision-state-machine.ts)
**同一个文件里**,`assertRegistrationCommandHeaderStatus` 判 `'reject'`,
`decideParticipationRevision` 判 `'rejected'` —— 相隔十几行,各自对着不同的列。写对是对的,但极易看错。

### 5.2 招新报名闭集被定义了两次

`recruitment.constants.ts` 定义 `APP_STATUS_VERIFIED/PENDING_EVALUATION/PUBLICITY`;
`recruitment-certificate-claim-state-machine.ts:170-172` **又独立定义了同名同值的三个常量**,且**不 import** 前者。
当前取值一致,但改一处不会同步另一处 —— 属于结构性隐患,本刀只登记不修。

### 5.3 闭集含已退役值

- `RecruitmentApplication.statusCode`:`APP_STATUS_PENDING='pending_verification'` 注释自述
  "退役:OCR 改造后报名不再产生(历史兼容)"。
- `RecruitmentApplication.eliminationStage`:`ELIM_STAGE_REALNAME='realname'` 同样自述已退役。

两者仍在闭集内(历史数据需要),但"闭集"因此不等于"当前流程可达的状态集"。4-1b 若要做可达性检查,须先分离这两个概念。

## 6. 老表零 CHECK:哪些实体的闭集只活在应用层

22 条无闭集 CHECK 的列中,**下列 L3 流程列的闭集完全没有 DB 兜底** —— 直连 SQL 或绕过应用的写入可以写进任意字符串:

| 列 | 表 | 闭集只在 |
|---|---|---|
| `Activity.statusCode` | `Activity` | `activity-state-machine.ts` |
| `ActivityRegistration.statusCode` | `activity_registrations` | `ACTIVITY_REGISTRATION_STATUS` 常量 |
| `AttendanceSheet.statusCode` | `attendance_sheets` | `ATTENDANCE_SHEET_STATUS` 常量 |
| `Content.statusCode` | `contents` | `CONTENT_STATUSES` 常量 |
| `Notification.statusCode` | `notifications` | `NOTIFICATION_STATUSES` 常量 |
| `RecruitmentApplication.statusCode` | `recruitment_applications` | `APP_STATUS_*` 散常量(且被定义两次,见 §5.2) |
| `TeamJoinApplication.statusCode` | `team_join_applications` | `APP_STATUS_*` 散常量 |
| `Certificate.certStatusCode` | `Certificate` | `CERT_STATUS_CODES`(DTO 内 **非导出**常量) |
| `WecomAuthAttempt.status` | `wecom_auth_attempts` | `WECOM_ATTEMPT_STATUS` 常量 |
| `NotificationOutboxIntent.status` | `notification_outbox_intents` | `OUTBOX_STATUS_*` 四个散常量,**无聚合数组** |
| `ActivityBatchJobItem.statusCode` | `ActivityBatchJobItem` | 仅 service 内散落字面量,**无任何具名常量** |
| `MemberInsurance.reviewStatusCode` | `member_insurances` | 仅 `default 'pending'` + 散落字面量 |

前 5 行正是 goal 点名的老核心表(activities / activity_registrations / attendance_sheets / contents / notifications),
**实测确认它们零状态闭集 CHECK**。这与"新表(2026-08 起)大量带 CHECK"形成对照:34 条有 CHECK 的列绝大多数属于
2026-08 活动改造批次新建的表。

> **本刀不回填任何 CHECK**。回填是 D 档(不可逆数据变更 + 存量校验),须单独立项。

## 7. 登记表覆盖面的边界(读这张表时必须知道)

登记表的口径是"**`String` 类型 + 列名形状匹配**",于是有两类状态列**结构上进不来**:

1. **enum 支撑的状态列:24 个**(`User.status` / `Member.status` / `RoleBinding.status` /
   `MemberOrganizationMembership.status` / `RecruitmentCertificateClaim.status` / …)。
   它们**已由 Postgres enum 类型在 DB 层闭集**,不需要 CHECK —— 所以缺席在治理上是**合理**的;
   但请注意 §4 指出的后果:**8 个状态机里有 2 个治理的正是这类列,登记表无法表达它们**。
2. **名字形状不匹配的列**:如 `ActivityRegistration.statusSummaryCode`(5 值 CHECK,派生生命周期摘要)、
   `ActivityAllocationCandidate.resultCode`、`ParticipantSettlementResultRevision.resultCode`、
   `QualificationEvaluationSnapshot.resultCode` 等 **`*resultCode` / `*SummaryCode` 家族**带有结果/生命周期语义却不入册。
   (同批被排除的还有 ~23 个 `*typeCode` / `*sourceCode` 分类列 —— 那些**本就不该**入册,排除是对的。)

**因此"56 条"不是全仓状态列总数**,而是"String 且名字形状匹配"的那一部分。按 String+enum 合计,
状态列总体约 **80 条**,登记表覆盖 56 条(70%)。若 4-1b 要声称"全仓状态机已登记",必须先处理这条口径。

## 8. 本次未做段(明确不在本刀范围)

以下全部**未做**,不因本刀而具备任何执行位:

- ❌ **共享状态机执行器**:8 个机 5 种形状的归一,未做。
- ❌ **任何执行位 / 一致性检查**:未新增任何 CI 检查、lint 规则或 selftest 断言;
  `check-boundaries.ts` 的 `stateRegistryErrors()` 仍只校验 schemaVersion / digest / 覆盖集 / `governanceStatus==='inventory'`,**本刀一字未改**。
- ❌ **`action-state-checks.ts` 全量派生**:仍是 15 项 / 3 机(attendance_sheet 9 + activity 3 + activity_registration 3),未动。
- ❌ **DB CHECK 回填**:22 条无 CHECK 的列一条都没补(D 档,须单独立项)。
- ❌ **任何 `governed` 升格**:56 条全部仍是 `inventory`;`governedBlockers` 是"还差什么"的记录,不是承诺。
- ❌ **既有状态机重写 / 拼法统一**:§5.1 的 `reject`/`rejected`、§5.2 的重复定义均只登记不修。
- ❌ **enum 状态列入册 / 检测口径扩面**:§7 的两类缺席只记录,未改 `stateLikeString()`。

## 9. 复核入口

- 机读数据:[`harness/state-machines.json`](../../harness/state-machines.json)(56 条,逐条含 `layer` / `stateSet` / `transitions` / `wrongStateBizCode` / `implementation` / `governedBlockers`)
- 覆盖集判据:[`scripts/check-boundaries.ts`](../../scripts/check-boundaries.ts) `listStringStateColumns()` / `stateRegistryErrors()`
- wrong-state BizCode 全集:[`src/common/exceptions/biz-code.constant.ts`](../../src/common/exceptions/biz-code.constant.ts)
  —— 31 条,5 种命名法(`*_STATUS_INVALID` / `*_STATE_INVALID` / `*_WRONG_STATE` / `*_INVALID_STATUS_TRANSITION` / `*_NOT_EDITABLE`)。
  按同样 5 种命名法 grep 会得到 33 条,须剔除 `MEMBER_PROFILE_POLITICAL_STATUS_CODE_INVALID` 与
  `ATTENDANCE_STATUS_CODE_INVALID` —— 这两条 message 均为"字典 code 不存在或已停用",是**字典值校验码,不是迁移码**。

---

## 10. Phase 4-1b —— `governed` 声明闸(已落地)

> **性质**:执行位说明 + 本轮读数 true-up。判据源码 = [`scripts/check-boundaries.ts`](../../scripts/check-boundaries.ts)
> (`parseStateEntry` / `governedGateErrors` / `l1GovernedErrors` / `flowGovernedErrors` / `stateGovernanceReport`);
> 阳性对照与负样例 = [`scripts/harness-guards.selftest.ts`](../../scripts/harness-guards.selftest.ts) 的 `R10 4-1b …` 共 17 条。

### 10.1 判据是什么(以及**不是**什么)

它是**声明闸**:只回答「这条登记敢不敢自称已治理」,**不声称被治理的代码是对的**。
结构上 fail-closed —— 拿不出证据就不许标 `governed`,宁可判不了。

判据的优先级由 §3.1 的实测决定,不是拍脑袋:**先守闭集是错的**(闭集已有 34/56 被 DB 兜住,
而边有 20 条零机器声明),所以门槛的核心是**边与实现映射**。

| 类 | 管什么 | 阻断? | 载体 |
|---|---|---|---|
| **A**(登记完整性 + `governed` 声明闸) | 逐条字段完备性;`governanceStatus` 只认 `inventory` \| `governed`;声明 `governed` 必须拿得出 `governedEvidence` | **是** | `pnpm docs:boundaries:check`(`--metadata`),CI `Architecture governance A-metadata gate` 内,**无 `|| true`** |
| **B**(存量分布 / 升格候选) | `stateGovernance` 报告块:分层分布、blocker 直方图、空绿面读数 | 否(恒 report) | `pnpm docs:boundaries`(`--violations`),CI 内被 `|| true` 兜住 |

**`governedEvidence` 是新增的可选字段**,只有 `governed` 才要求;`inventory` 条目**禁止携带**
(半截声明 / 陈旧证据会让下一个人误以为门槛已经过了)。因为它对既有 56 条全是可选的、
既有条目一字不改仍然合法,**本刀不 bump `VERSION`** —— 那个常量同时校验 `harness/domain-map.json`
的 `generatorVersion`,bump 它会强迫并行 lane 一起重算 domain-map。

### 10.2 门槛按层分叉(L1 不是免检,是另一条同样机器可判的路)

goal 原写的 ①「实现模块路径可解析」**对 L1 套错了对象**:13 条 L1 里绝大多数的 `implementation`
是散文(`"活动配置字段"` / `"预留名额组配置"`),因为配置列的实现就是 CRUD,它没有"状态机模块"。
维护者 2026-08-15 拍板改判:

- **L1 配置/标注列**(`edgeModel: "unconstrained"`):`transitions` 必须是 `unconstrained`、
  `wrongStateBizCode` 必须是 `none`、不许声明 edges / 实现模块;
  **闭集必须能从 `stateSet.sourceRef` 指名的那条 migration 的 DB CHECK 原样重算出来**,
  且那条 CHECK 是全仓**最后一次**对该表该列的声明、之后未被 `DROP CONSTRAINT`。
  验证的是「登记声明 = 数据库约束」—— 改 `stateSet.values` 而不改 migration 立刻红。
- **L2 / L3 流程列**(`edgeModel: "enumerated"`):
  ① `implementationFile` 是存在的 `src/**.ts`,`implementationSymbol` 在该文件里**真有顶层声明**;
  ② `edges` 逐条 `{from,to,action?}`,端点 ⊆ 闭集,并**双向对账**:
     正向 —— 每个端点 / 动作必须是该模块里的**字符串字面量**(堵「登记表写了、代码里没有」);
     反向 —— 该模块里出现的、属于本列闭集的字面量必须被某条边覆盖(堵「只登了一半的边」);
  ③ `wrongStateBizCodes` 非空,且每条都是 `BizCode` 里**真实存在**的成员。

三处实现细节直接**承接 §1.1 记录的量具缺陷**,不是重新发明:
CHECK 提取**逐语句切分**(堵缺陷 1 的正则跨语句串味)、**按表名关联**(堵列名重名跨表认错)、
**只认整体形如 `"col" IN (…)` / `"col" IS NULL OR "col" IN (…)`**(堵缺陷 2 把 shape 约束的
分支条件当闭集)。取字面量与符号一律走 **AST 而非 grep** —— 注释不是执行位。

### 10.3 本轮升格:8 条,全部 L1

`Activity.allocationModeCode` · `Activity.registrationModeCode` · `ActivityAllocationBatch.modeCode` ·
`ActivityReservedQuotaGroup.fallbackMode` · `AttendanceSettlementVersion.returnFromStage` ·
`AttendanceSheet.returnedFromStageCode` · `QualificationEvaluationSnapshot.evaluationPhaseCode` ·
`SettlementReviewAction.stageCode`

8/8 实测:闭集与在册 CHECK **逐值相等**、该表该列的 CHECK 命中数**恰 1**、无后续 `DROP`。
**L3 一条都不升** —— 它们缺的正是 §10.2 ② 要求的边与实现映射。

### 10.4 读数 true-up

> ⚠️ **本表是取数时点的快照,不是"永远现算"。** 原标题写作「机器现算」,而它是一次性抄进
> 文档的数字 —— 2026-08-21 复核时实况已是 58 条,表里仍写 56(见 10.4.1)。
> 引用本表前先看时点;要当前值请直接跑 `pnpm docs:boundaries`(`--violations`)读
> `stateGovernance` 块,或数 `harness/state-machines.json` 的 `entries`。

**取数时点:2026-08-25(活动归档刀)**

| 项 | 值 |
|---|---:|
| 总条目 | **59** |
| `governed` / `inventory` | **8 / 51** |
| 51 条 inventory 的分层 | L1 **6** · L2 **19** · L3 **26** |
| 已有机器可读边(`transitions` 是数组)※ | 21 |
| `transitions: "not-derived"` ※ | 25 |
| `transitions: "unconstrained"` ※ | 13 |

> ※ 这三行按**全部 59 条**统计(21+25+13=59),不是按上一行那 51 条 inventory。
> 原表未标口径,而两种口径下 `unconstrained` 分别是 13 与 5 —— 差 8 条,
> 正是 L1 配置列升 `governed` 的那批。复核本表时先确认口径再比数字。
| **`vacuousGreenIfClosedSetOnly`** | **23** |
| 零 blocker 但仍 inventory 的升格候选 | **0** |

> 🔴 **本次 true-up 的两类改动要分开读**(2026-08-25 归档刀):
>
> **① 本刀移动的 6 个数**:总条目 58→59 · inventory 50→51 · L1 5→6 ·
> `not-derived` 24→25 · `vacuousGreenIfClosedSetOnly` 22→23 · `no-db-check` 22→23。
> 来源是新登记的 `Activity.archivedFromStatusCode`(L1 快照列)。
> `Activity.statusCode` 的闭集虽从 5 值扩到 6 值、边从 6 条扩到 14 条,但它**本来就是**
> 数组型 `transitions` 的 inventory L3,故不改变上面任何一个计数。
>
> **② 与本刀无关、早已过期的 3 处**(在 `origin/main` 上就已经是错的,只是没有机器守着):
> 下面 blocker 直方图里 `no-wrong-state-bizcode` 写 25 实为 **27**、`no-state-machine` 写 18
> 实为 **20**、`impl-scattered` 写 1 实为 **2**;「零 blocker 升格候选」写
> `1(ParticipantSettlementResultRevision.statusCode)` 实为 **0**。
> 本刀顺手 true-up 并如实标注来源,**不冒充是本刀造成的漂移**。
> ⚠️ 这四处能悄悄错三个月,正是因为 selftest 的 F3 只钉了「总条目」一个数
> (它自己的注释也写明了这是刻意取舍:逐个盯比率会让断言变成第二份真相)——
> 已知射程限制,不是本刀新引入的缺口。

blocker 直方图(2026-08-25 现算;本刀只新增 1 条 `no-db-check`):`no-wrong-state-bizcode` 27 ·
`no-db-check` 23 · `edges-not-derived` 20 · `no-state-machine` 20 · `closed-set-undeclared` 5 ·
`edges-partially-derived` 2 · `vocabulary-divergence` 2 · `dictionary-driven` 2 ·
`retired-value-in-set` 2 · `impl-scattered` 2 · `throws-instead-of-decide` 1 ·
`decision-shape-divergence` 1 · `duplicate-constant-definition` 1。

**`vacuousGreenIfClosedSetOnly` = 23 是本刀存在的理由的量化**:这 23 条既有已声明的闭集、
`transitions` 又是 `not-derived` —— 一个「只比闭集 vs CHECK」的判据会**全部放它们过去**。
selftest 里那条 `空绿负例` 就钉死了这个形状(`ActivityInvitation.statusCode`:闭集 5 值合法、
零 blocker,但零边零实现 ⇒ 必须被拒)。

### 10.4.1 这张表为什么会漂(2026-08-21 复核)

复核时实况 **58** 条,而表里写 **56**;`governed / inventory` 实况 **8 / 50**,表里写 **8 / 48**。
两条 4-1b 之后新增的状态列被**登记闸正确地逼进了登记表**(A 类 blocking 在做功),
但**文档里的叙述数字没跟着走** —— 而它自称「机器现算」,读者没有理由怀疑它。

这与同日在 `SERVICE_SIZE_RATCHET.md` §4 查出的过期 ✅ 是**同一个缺陷类**:
治理文档把一次性取数写成了持续事实,而没有任何执行位守着它。
两处都不是写错,是**写对之后静默过期**。

**已加机器守护**:`harness-guards.selftest.ts` 断言「本表 §10.4『总条目』一行的数字
必须等于 `harness/state-machines.json` 的 `entries` 长度」。它只盯这一个数 ——
表里其余比率全部由它派生,总数对不上时那些比率一定也不对;
而逐个去盯每一个比率会让断言本身变成需要维护的第二份真相。

### 10.5 本轮发现的两处口径瑕疵(如实记录,均未回改)

1. **登记表内部不一致:24 vs 20**。`transitions: "not-derived"` 的有 **24** 条,
   但只有 **20** 条带 `edges-not-derived` blocker。差的 4 条全是 L2:
   `ActivityAllocationApplicationProjection.appliedStatusCode` · `NotificationDelivery.status` ·
   `RecruitmentCycle.statusCode` · `TeamJoinCycle.statusCode`。
   ⇒ **§3 的 blocker 聚合把边的缺口少算了 4 条**。blocker 是人工判断的产物,本刀只登记不改。
2. **§6 表名笔误**:该表把 `AttendanceSheet.statusCode` 的"表"写作 `attendance_sheets`,
   但 `prisma/schema.prisma` 里 `model AttendanceSheet` **没有 `@@map`**,真表名就是 `AttendanceSheet`
   (migration 里也写 `ALTER TABLE "AttendanceSheet"`)。冻结稿不回改;
   **判据按 schema 真值取表名**,不受此影响。

### 10.6 本次未做

- ❌ **不升任何 L3 / L2**:48 条仍 `inventory`(含唯一的零 blocker 候选 `ParticipantSettlementResultRevision.statusCode`
  —— 它的 `implementation` 是散文"settlement / ledger service 族",结构上给不出 `implementationFile`)。
- ❌ **不回填 DB CHECK**:22 条 `no-db-check` 一条没补(D 档,须单独立项)。
- ❌ **不重写任何状态机**:§4 的 5 种形状、§5.1 `reject`/`rejected`、§5.2 重复定义,原样保留。
- ❌ **不补 wrong-state BizCode**:25 条 `no-wrong-state-bizcode` 一条没加码。
- ❌ **不改检测口径**:`stateLikeString()` 一字未动,§7 的两类缺席(24 个 enum 状态列 /
  `*resultCode`·`*SummaryCode` 家族)仍在册外;"56 条 ≠ 全仓状态列总数"这条口径仍然成立。
- ❌ **不改 blocker**:§10.5 ① 的 4 条缺口只记录,没往 `governedBlockers` 里加。
- ❌ **不建共享状态机执行器**,不动 `action-state-checks.ts`,零 `src/**` / `prisma/**` 改动。

### 10.7 订正:唯一那条「升格候选」是**假读数**(2026-08-24 实测)

§10.4 表里「零 blocker 但仍 inventory 的升格候选 = **1**
(`ParticipantSettlementResultRevision.statusCode`)」——**该条根本升不了格**,
它不该出现在候选里。表里的旧读数保留作历史,本节是订正。

**它是怎么变成假读数的**:`upgradeCandidates` 的算法是
「`governanceStatus === 'inventory'` 且 `governedBlockers` 为空」。
而**上一节 §10.6 自己就写着**这条升不了(「它的 `implementation` 是散文……结构上给不出
`implementationFile`」)—— 也就是说,**事实当时就知道,只是写进了散文、没写进机器读的那个字段**。
`governedBlockers` 空着,算法当然把它算成候选。这正是本仓那句
「**描述文本 ≠ 执行位**」的又一个实例:同一份文件里,散文与机器字段对同一件事给出相反答案。

**取证**(把它升 `governed` 试跑 `pnpm docs:boundaries:check`,判据自己打印):

```
state entry ParticipantSettlementResultRevision.statusCode: edge endpoint "committed"
never appears as a string literal in src/modules/activities/ledger-preparation.service.ts
(registry declares an edge the named module does not mention)
```

**根因**:这台状态机**物理散在 4 个文件** —— `settlement-draft.service.ts` 建 `draft`、
`ledger-posting.service.ts` 用裸 SQL 写 `committed`、`correction-application.service.ts`
用裸 SQL 写 `superseded`、`ledger-preparation.service.ts` 只读校验。
§10.2 ② 的 L2 门槛要求**单一** `implementationFile` 做正反双向对账,结构上给不出。

⚠️ **有三个文件恰好同时含 `draft` / `committed` / `superseded` 三个字面量**
(`correction-application` / `settlement-draft` / `activity-settlement-http`),
把其中任何一个填进 `implementationFile`,**闸会绿**。但那些字面量属于**兄弟模型**
(`ActivitySettlementClosureRevision.statusCode` 与 `ParticipantServiceSegmentRevision.statusCode`
是同一组三值闭集)。**「挑一个能让闸变绿的文件」= 为凑绿放宽口径,已否决。**
这也是本闸的一个已知缺口,写在明处:**它只验字面量在不在,不验那个字面量属于哪个模型。**

**处置**:按实测把 `impl-scattered`(仓内既有取值)补进该条的 `governedBlockers`。
这是**补真相,不是放宽** —— 它此前是 `inventory`、不执行任何判据,补 blocker 不解除任何约束,
只让机器字段与 §10.6 的散文对上。A/B 读数(`pnpm docs:boundaries`):

| 读数 | 补之前 | 补之后 |
|---|---|---|
| `upgradeCandidates` | `["ParticipantSettlementResultRevision.statusCode"]` | `[]` |
| `blockerHistogram["impl-scattered"]` | 1 | 2 |
| `byStatus`(`governed` / `inventory`) | 8 / 50 | 8 / 50(不变) |
| `--violations` findings 总数 | 634 | 634(不变) |
| `pnpm docs:boundaries:check` | exit 0 | exit 0 |

⇒ **Phase 4 当前的真实升格候选 = 0 条。** 「50 条 inventory 里有 1 条够得着门槛」这句话
从今天起不成立;要恢复候选,只能靠**还债**(收口散落实现 / 回填 DB CHECK / 补 wrong-state 码),
不能靠调登记表。

**本节明确不做**:没有给「零 blocker 却仍 inventory」接执行位(那会是 v4 §5.2 R10
「存量按棘轮晋升」的执行位,今天仍是零执法)。理由见
[`NEXT_TASKS.md`](NEXT_TASKS.md) P1-29 的 **B-2**:该闸的常驻阳性对照必须写进
`scripts/harness-guards.selftest.ts`(红区),而且那份里 `:1817` 的
`governedEntries.length === 8` 把 governed 条数**硬编码**了 —— 任何升格都会打红它,
与该条能否过闸无关。**没有常驻阳性对照的新闸是在给债务台账添条目,不是还债。**
