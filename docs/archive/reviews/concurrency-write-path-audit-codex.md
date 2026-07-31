# 并发写路径横向审计

> **性质**：report-only；零 `src/` / `test/` 改动，本文不实施任何修复。  
> **审计基线**：`main@7b0f5c2572b96d95fbf0ac8945047b0b7cf21a5b`（2026-07-31）。  
> **范围**：`attendances`、`activities`（含 waitlist）、`activity-registrations`、`team-join` 的全部 production 写路径；`certificates`、`recruitment`、`auth`、`authz`、限流不在范围。  
> **判据**：S1–S6 采用本次 Goal 定义；本文新增 S7。`claimAtStatus()` 只做
> `WHERE id=? AND statusCode=? ... FOR NO KEY UPDATE`，返回 `void`；除非调用方不再依赖其它列，
> 否则 claim 后仍须复读。

## 1. 摘要

### 1.1 结论与计数

本文按“**并发语义不同、必须独立作出结论的业务分支/事务根**”计数；薄 controller、bulk
逐条委托和同一分支内的 audit/outbox helper 不重复计数。唯一例外是
`activity-registrations.exportCsv`：它虽然业务只读，但会 fail-closed 写 AuditLog，因此作为写路径单列。
`activities` 的 31 个分支覆盖 33 个 production 直接 mutation 位点，见 §3.1 的 W01–W33。

| 模块 | 🔴 活 bug | 🟡 理论缺陷 | 🟢 正确 | 审计落点 |
|---|---:|---:|---:|---:|
| `attendances` | 2 | 1 | 15 | 18 |
| `activities`（含 waitlist） | 0 | 0 | 31 | 31 |
| `activity-registrations` | 1 | 0 | 7 | 8 |
| `team-join` | 2 | 0 | 5 | 7 |
| **合计** | **5** | **1** | **58** | **64** |

一句话结论：

- `attendances`：单 Sheet 的状态 claim 基本正确，但 **Admin 改 records 没有加入
  Activity→Registration 线性化协议**，且 finalApprove 的贡献阈值判断只有 Sheet 行锁，
  存在跨 Sheet write-skew。
- `activities`：33 个直接 mutation 位点均由 Activity 根锁、锁后复读、候补 CAS 或
  新行唯一约束保护；未发现运行时并发 bug，但 canonical handoff 有两处 S6 分叉。
- `activity-registrations`：状态迁移均 claim 后复读；`cancelMy` 唯一使用了锁前 Activity
  元数据写 durable intent，能产生旧标题通知。
- `team-join`：单 Application 的 mark/evaluate 已收口；**submit 与 final join 没有共同处理
  Member 准入及同成员其它申请**，能留下正式队员的进行中/冻死申请。

S5/S6 是注释/契约扫描结果，不伪装成运行时 A/B 交错，故不混入上表。确认：

- **S5**：1 处强失效论证（`attendance.recorded` 日志并不会随事务回滚）及 3 组 stale
  source comment，见 §6。
- **S6**：3 处 confirmed canonical/runtime 分叉；另有 1 处 local-rule/runtime 冲突因
  canonical 未定义而标为“未确定”，见 §7。

### 1.2 第七种形状

**S7：跨行/跨聚合不变量没有共同线性化键。**

机器可查的典型特征：

1. 在聚合 A 读取可变准入事实，随后向聚合 B `create/createMany/update`，但没有锁住事实拥有者并复读；
2. 每个目标行各自有锁，但判定依据是跨多行的 `SUM/count/threshold`，没有
   `member+cycle` 等共同根锁；
3. 终态写只收口当前子行，没有在同一根锁下处理同一父实体的其它 live 子行。

本次命中：Attendance Admin `edit(records)`、Attendance `finalApprove` 贡献阈值、
Team Join `submit`、Team Join `final join`。S7 是本次审计的最大新增产出。

## 2. 机器盘点与覆盖口径

当前 production TypeScript 的字面盘点如下（排除 `*.spec.ts`）：

| 模块 | `claimAtStatus` 调用 | `update()` | `updateMany()` | `$transaction` 字面 |
|---|---:|---:|---:|---:|
| `attendances` | **11** | 11 | 5 | 28 |
| `activities` | 7 | 27 | 2 | 30 |
| `activity-registrations` | 5 | 5 | 0 | 13 |
| `team-join` | 2 | 8 | 0 | 9 |
| **合计** | **25** | **51** | **7** | **80** |

复核命令：

```text
rg -n 'claimAtStatus\(' src/modules/{attendances,activities,activity-registrations,team-join} \
  --glob '*.ts' --glob '!*.spec.ts'
```

Goal 中 `attendances claimAtStatus=12 / 合计=26` 与当前基线有 1 处漂移；当前实际调用点是
11 / 25。其它三列与 Goal 一致。这不是漏审：11 处 Attendance claim（含 submit helper）均已映射到
§3.2。

覆盖方法：

- 先以 mutation、transaction、claim、audit/outbox 调用建立清单，再沿 controller/service
  引用链合并只做薄委托的入口。
- 对每个状态迁移检查“锁前读 → claim/根锁 → 锁后复读 → 守卫 → mutation”的实际顺序。
- 对 create、聚合计数、跨模块 FK 语义额外检查 S2/S4/S7，而不是只扫 25 个 claim。
- 对 `docs/handoff/README.md`、`admin-web.md`、`miniapp.md` 做语义搜索；`openapi.json`
  只表达路由/schema，不能表达本次并发语义。
- 🔴 必须给出具体交错；🟡 必须给出当前阻断和放松条件；否则不升级。

## 3. 逐落点结论

### 3.1 `activities`（31 个分支；0/0/31）

正确性依据缩写：

- **G-ACT**：`activities.service.ts:370-382` 的 Activity `FOR UPDATE` 后立即复读；
  update/softDelete/publish/cancel/complete 的真实判断与写入均在该根锁内。
- **G-POS**：`activity-positions.service.ts:106-167,202-291` 先锁 Activity，再读取 Position、
  容量与 pass 数；扩容递补仍在同事务。
- **G-WAIT**：`activity-waitlist-promotion.ts:120-170,350-400` 在 Activity 根锁下按
  Member→Registration 固定顺序 claim，并复读 candidate 后才更新。
- **G-REVIEW**：`activity-publish-review.service.ts:239-275,301-340,396-460,510-580,691-780`
  先锁 Activity，再读取 review/proposal；proposal apply 只在该锁内被调用。
- **G-RESP**：`activity-responsibility.service.ts:79-131,403-784` 固定
  Activity→排序 Member→Assignment，锁后重校验目标与 assignment，再写 assignment/binding。
- **G-NEW**：只创建新聚合，不按旧 Activity 状态覆盖既有行；唯一/FK 冲突由数据库拒绝。

| ID | 分支 | file:line / mutation | 判定 | 依据 |
|---|---|---|---|---|
| A01 | Activity create | `activities.service.ts:623`（W01） | 🟢 | G-NEW；不覆盖既有状态快照 |
| A02 | Activity update：普通/缩容 | `activities.service.ts:849`（W02） | 🟢 | G-ACT；锁后容量/状态复读 |
| A03 | Activity update：无岗位扩容 | `activities.service.ts:849` + W11 | 🟢 | G-ACT + G-WAIT |
| A04 | Activity update：有岗位扩容 | `activities.service.ts:849` + W12 | 🟢 | G-ACT + G-WAIT |
| A05 | Activity softDelete | `activities.service.ts:989`（W03） | 🟢 | G-ACT；claim 后复读 |
| A06 | legacy publish | `activities.service.ts:1055`（W04） | 🟢 | G-ACT；claim 后复读 |
| A07 | cancel | `activities.service.ts:1133,1144`（W05–W06；必要时 W21） | 🟢 | G-ACT + G-REVIEW；同根锁收口 pending review |
| A08 | complete | `activities.service.ts:1215`（W07） | 🟢 | G-ACT；claim 后复读 |
| A09 | Position create | `activity-positions.service.ts:141`（W08） | 🟢 | G-POS；根锁后校验容量/时间窗 |
| A10 | Position update：普通/缩容 | `activity-positions.service.ts:276`（W09） | 🟢 | G-POS |
| A11 | Position update：扩容 | `activity-positions.service.ts:276` + W11 | 🟢 | G-POS + G-WAIT |
| A12 | Position softDelete | `activity-positions.service.ts:346`（W10） | 🟢 | G-POS；锁后重读依赖数 |
| A13 | managed declare-attendance-complete | `app-managed-activities.service.ts:274`（W33） | 🟢 | Activity `FOR UPDATE` 后复读再写 |
| A14 | Review submitInitial | `activity-publish-review.service.ts:257`（W13） | 🟢 | G-REVIEW |
| A15 | Review submitChange | `activity-publish-review.service.ts:324`（W14） | 🟢 | G-REVIEW |
| A16 | Review directPublish | `activity-publish-review.service.ts:421,444` + W26/W31 | 🟢 | G-REVIEW + G-RESP |
| A17 | Review approve initial | `activity-publish-review.service.ts:556` + W18/W26/W31 | 🟢 | G-REVIEW + G-RESP |
| A18 | Review approve change | `activity-publish-review.service.ts:556` + W22–W25（可含 W12） | 🟢 | G-REVIEW；proposal 仅在锁内 apply |
| A19 | Review return | `activity-publish-review.service.ts:580`（W19） | 🟢 | G-REVIEW |
| A20 | Review withdraw | `activity-publish-review.service.ts:697`（W20） | 🟢 | G-REVIEW |
| A21 | cancelPendingForActivity helper | `activity-publish-review.service.ts:799`（W21） | 🟢 | 调用方已持 Activity 根锁，helper 同事务 |
| A22 | 单队列 waitlist promotion helper | `activity-waitlist-promotion.ts:158`（W11） | 🟢 | G-WAIT |
| A23 | 跨岗位 waitlist promotion helper | `activity-waitlist-promotion.ts:391`（W12） | 🟢 | G-WAIT |
| A24 | createOwnerForPublish helper | `activity-responsibility.service.ts:184` + W31 | 🟢 | G-RESP |
| A25 | addCollaborator | `activity-responsibility.service.ts:223` + W31 | 🟢 | G-RESP；Activity/Member 锁后资格校验 |
| A26 | endCollaborator | `activity-responsibility.service.ts:258` + W32 | 🟢 | G-RESP；Assignment 锁后写 |
| A27 | transferOwner | `activity-responsibility.service.ts:258,184,223` + W31/W32 | 🟢 | G-RESP；排序 Member 锁避免交叉移交 |
| A28 | transferInitiator | `activity-responsibility.service.ts:673`（W29） | 🟢 | G-RESP；Activity/旧新 Member 均锁后复读 |
| A29 | claimLegacy | `activity-responsibility.service.ts:184` + W31 | 🟢 | G-RESP；根锁下 count + P2002 兜底 |
| A30 | assignLegacyInitiator | `activity-responsibility.service.ts:795`（W30） | 🟢 | G-RESP |
| A31 | `ActivityProposalApplier.apply` | `activity-proposal-applier.ts:133,202,237,254`（W22–W25） | 🟢 | G-REVIEW；无独立无锁入口 |

33 个直接 mutation 的完整位置映射：

- W01–W07：`activities.service.ts:623,849,989,1055,1133,1144,1215`
- W08–W10：`activity-positions.service.ts:141,276,346`
- W11–W12：`activity-waitlist-promotion.ts:158,391`
- W13–W21：`activity-publish-review.service.ts:257,324,421,444,556,580,697,768,799`
- W22–W25：`activity-proposal-applier.ts:133,202,237,254`
- W26–W30：`activity-responsibility.service.ts:184,223,258,673,795`
- W31–W32：`activity-responsibility-grant-projector.ts:37,97`
- W33：`app-managed-activities.service.ts:274`

### 3.2 `attendances`（18 个分支；2/1/15）

| ID | 分支 | file:line | 形状 / 判定 | 依据 |
|---|---|---|---|---|
| T01 | submit | `attendances.service.ts:657-772` | S1 / 🟡 | Registration 校验后才 claim，未复读；当前受 §5 阻断 |
| T02 | list（read audit write） | `attendances.service.ts:862-905` | 🟢 | 业务实体只读；唯一写是独立 append-only AuditLog |
| T03 | findOne（read audit write） | `attendances.service.ts:1086-1111` | 🟢 | 同上 |
| T04 | reviewDetail（read audit write） | `attendances.service.ts:1116-1171` | 🟢 | 同上 |
| T05 | edit，不替换 records | `attendances.service.ts:1206-1244` | 🟢 | Sheet claim 后复读；version/update 均用 lockedSheet |
| T06 | Admin edit(records) | `attendances.service.ts:1198-1212,1247-1310` | **S3/S7 / 🔴** | 只锁 Sheet；Activity/Registration/Position 均为锁外事实 |
| T07 | managed edit(records) | `attendances.service.ts:1194-1310` | 🟢 | 先锁 Activity，再锁/复读 Sheet；相关写方共享 Activity 根锁 |
| T08 | softDelete | `attendances.service.ts:1362-1400` | 🟢 | claim 后复读；Sheet/Records 同事务级联软删 |
| T09 | approve | `attendances.service.ts:1429-1473` | 🟢 | claim 后复读并重跑职责分离/records 守卫 |
| T10 | firstReturn | `attendances.service.ts:1495-1547` | 🟢 | claim 后复读；状态/audit/outbox 同事务 |
| T11 | reject | `attendances.service.ts:1573-1623` | 🟢 | claim 后复读并级联终结 Records |
| T12 | finalApprove | `attendances.service.ts:1657-1736` | **S7 / 🔴** | 只锁单 Sheet，阈值依据跨 member/cycle 多 Sheet 聚合 |
| T13 | finalReturn | `attendances.service.ts:1758-1810` | 🟢 | claim 后复读；audit/outbox 同事务 |
| T14 | finalReject | `attendances.service.ts:1846-1897` | 🟢 | claim 后复读并级联终结 Records |
| T15 | resubmit | `attendances.service.ts:1913-1968` | 🟢 | Activity→Sheet 锁序；复读后更新锁定版本 |
| T16 | reopen | `attendances.service.ts:1989-2036` | 🟢 | claim 后复读 Records 再迁移 |
| T17 | App checkIn | `app-activity-check-ins.service.ts:80-130,254-305` | 🟢 | Activity→Registration 锁后复读；唯一冲突败者复读 winner |
| T18 | App checkOut | `app-activity-check-ins.service.ts:134-185,254-305` | 🟢 | 同锁序；`updateMany` CAS，失败者复读 winner |

production mutation 已全部覆盖：

- `activityCheckIn.create`：`app-activity-check-ins.service.ts:107`
- `activityCheckIn.updateMany`：`:161`
- `attendanceSheet.create`（含 nested Records）：`attendances.service.ts:749-772`
- `attendanceSheet.update`：`:1224,1303,1381,1447,1507,1595,1678,1770,1869,1937,2007`
- `attendanceRecord.updateMany`：`:1283,1377,1590,1864`
- `attendanceRecord.createMany`：`:1287`

### 3.3 `activity-registrations`（8 个分支；1/0/7）

| ID | 分支 | file:line | 形状 / 判定 | 依据 |
|---|---|---|---|---|
| R01 | Admin create | `activity-registrations.service.ts:921-993` | 🟢 | Activity 根锁后读活动/岗位/容量；Member lifecycle 锁后写；唯一约束兜底 |
| R02 | Self create | `activity-registrations.service.ts:997-1068` | 🟢 | 同上 |
| R03 | approve | `activity-registrations.service.ts:1072-1176` | 🟢 | Activity 锁 + claim + lockedReg 复读 + 锁后容量计数 |
| R04 | reject | `activity-registrations.service.ts:1180-1250` | 🟢 | claim 后在 `:1210` 复读再写 |
| R05 | cancelAdmin | `activity-registrations.service.ts:1254-1343` | 🟢 | pass 固定 Activity→Registration；`:1289` 复读，`:1291` evidence guard |
| R06 | reopen | `activity-registrations.service.ts:1352-1410` | 🟢 | claim 后在 `:1381` 复读 |
| R07 | cancelMy | `activity-registrations.service.ts:1466-1581` | **S1 / 🔴** | `:1483-1489` 锁前读 Activity 元数据，`:1496-1498` 才锁，之后未复读 |
| R08 | exportCsv（read audit write） | `activity-registrations.service.ts:1587-1618` | 🟢 | generator 前只写 append-only export audit；不依赖可变业务状态决定业务 mutation |

bulk 与 App-managed 入口均为逐条/薄壳委托上述根方法，不另造事务或写语义。

### 3.4 `team-join`（7 个分支；2/0/5）

| ID | 分支 | file:line | 形状 / 判定 | 依据 |
|---|---|---|---|---|
| J01 | Cycle create | `team-join-cycles.service.ts:39-80` | 🟢 | 初态强制 closed；新行 + audit 同事务 |
| J02 | Cycle update | `team-join-cycles.service.ts:111-230` | 🟢 | 先按 id 锁 Applications→Cycle，锁后复读；single-open partial unique 兜底 |
| J03 | App submit | `team-join-applications.app.service.ts:73-86,146-190` | **S7 / 🔴** | 普通读 Member/Membership 后向 Application create；无 Member lifecycle 锁/复读 |
| J04 | updateTargets | `team-join-applications.app.service.ts:210-270` | 🟢 | claim 后 `:235-244` 复读；用 lockedRow.cycle 重校验 |
| J05 | markGate | `team-join-applications.service.ts:112-184` | 🟢 | Application `FOR UPDATE` 后才读 gate/贡献并写 |
| J06 | evaluate | `team-join-applications.service.ts:189-280` | 🟢 | claim 后复读；锁后重跑 gate 与 contribution |
| J07 | final join | `team-join-enrollment.service.ts:99-308` | **S4/S7 / 🔴** | 只终结目标 Application；Member 根锁下未收口同成员其它 live Application |

## 4. 🔴 活 bug 逐条展开

### F1 — Attendance Admin `edit(records)` 可写入已取消报名（T06，S3/S7）

关键代码：

- Admin 分支跳过 managed 才执行的 Activity 锁：`attendances.service.ts:1193-1197`
- 锁外读取/校验 Activity、Registration、Position：`:536-650,1247-1255`
- 替换 Records：`:1283-1300`
- 报名取消 evidence guard：`activity-registrations.service.ts:694-711`

交错：

1. A（Admin edit）claim 并复读 Sheet；读取 Registration R=`pass`，校验通过后暂停。
2. B（cancelAdmin/cancelMy）按 Activity→Registration 加锁；此时 A 尚未插入 Record，
   `assertNoParticipationEvidence` 读到 0，B 把 R 改成 `cancelled` 并先提交。
3. A 恢复，在没有 claim/复读 R 的情况下 `createMany` live AttendanceRecord，并更新 Sheet 后提交。
4. 终态为 **cancelled Registration + live AttendanceRecord**。

这不是合法串行结果：A 先完成时 B 应命中 `21033`；B 先完成时 A 应拒绝非 `pass`。
Prisma/schema 只有 `registrationId` FK，没有“被引用 Registration 必须 pass”的状态约束
（`prisma/schema.prisma:1423-1452`；migration
`20260510193742_v2_batch3_activities_attendances/migration.sql:210-216`）。

后果：报名取消守卫和考勤证据不变量同时失真；后续 no-show、参与汇总和报名生命周期会看到互相矛盾的事实。

建议修法（不实施）：Admin/managed edit(records) 统一采用 Activity→排序 Registration→Sheet 的
全局锁序；对所有非空 registrationId claim 后复读 Registration/Position，再重跑资格和时间窗校验。

### F2 — 两个 `finalApprove` 并发跨过 5 分阈值但零里程碑（T12，S7）

关键代码：

- 锁前/更新前 capped snapshot：`attendance-notification-producer.ts:91-115`
- Sheet 更新后重算：`:147-150`
- finalApprove 只 claim 当前 Sheet：`attendances.service.ts:1657-1681`

设同一 member、同一 joining cycle 的已生效 capped contribution=3；两个不同 Sheet A/B 各有一条
在不同北京日生效后增加 1 分的 Record：

1. 事务 A、B 分别锁各自 Sheet；两者都算得 `before=3`。
2. A、B 各自把自己的 Sheet 改为 approved。
3. 在任一事务提交前，两者都执行 after 查询；各自只能看到自己的未提交写，均得 `after=4`。
4. 两者都不尝试 enqueue `team-join-contribution-met:*:5`，随后分别提交。
5. 最终正式 capped 总分=5，但 durable milestone intent=0。

任一串行顺序中，第二个终审都会观察 4→5 并 enqueue；outbox 唯一 key 无法兜底，因为两个事务都没有
尝试插入。

后果：canonical `miniapp.md:117` 承诺的“随考勤终审自动触达本人”丢失；同 application+threshold
永久不会再有第一次跨阈值机会。

建议修法（不实施）：为 `memberId + joining cycle/application` 建所有贡献生效写方共享的确定性锁；
锁后读取 application 与 before，再更新 Sheet/计算 after/enqueue；补真实双连接、双 Sheet 并发测试。

### F3 — `cancelMy` 用锁前标题写 durable intent（R07，S1）

关键代码：

- 锁前 Activity title/publisher：`activity-registrations.service.ts:1483-1489`
- pass 分支直到 `:1496-1498` 才锁 Activity
- self-cancel intent 使用旧 snapshot：`:1555-1563`

交错：

1. A 读到 Activity.title=`旧标题` 后暂停。
2. B 取得 Activity 根锁，经 Activity update 或 approved change proposal 把标题改成 `新标题`，
   并先提交（`activities.service.ts:655-657,807,849-852`；
   `activity-publish-review.service.ts:509-512` +
   `activity-proposal-applier.ts:133-170`）。
3. A 随后取得 Activity 锁，claim/复读报名并完成取消。
4. A 写出的 owner cancellation durable intent 仍含“旧标题”；同一事务里的候补 helper 已锁后复读，
   若有 promotion，其通知可以含“新标题”。

后果：同一次取消产生旧标题，甚至两条互相矛盾的通知；intent 已持久化，worker 无法自行恢复正确 snapshot。

建议修法（不实施）：Activity 根锁后统一复读 title/publisher，取消、owner recipient 与 promotion
全部只消费同一份锁后 Activity snapshot。

### F4 — Team Join `submit` 可在 Member 已入队后创建新申请（J03，S7）

前提：旧轮 C1 已 closed，J1=`approved`；新轮 C2 open；M 初始为未入队志愿者。
`docs/handoff/admin-web.md:528` 明确 J1 的 approved 资格不随关轮失效。

交错：

1. A 提交 C2，在 `team-join-applications.app.service.ts:73-86` 普通读确认 M 尚未入队后暂停。
2. B 对 J1 final join，锁 Member，创建正式 PRIMARY membership、写
   `gradeCode=level-1`、J1→joined，并先提交
   （`team-join-enrollment.service.ts:141,220-260`）。
3. A 恢复，不复读 Member，直接创建 J2=`joining` 并提交。
4. partial unique 只约束 `(memberId, cycleId)`（`schema.prisma:2717-2720`），跨轮不阻断。

后果：**写入发生时已经是正式队员**，仍新增进行中入队申请；后续工作台、进度和自动状态推进都处理一条
不再满足准入的行。

建议修法（不实施）：submit 参与 Member lifecycle 线性化协议，在共同根锁后复读 grade/membership；
必须与 F5 一起设计，单修 submit 不能处理“submit 先完成、join 后发生”的合法顺序。

### F5 — Team Join `final join` 不终结同成员其它 live Application（J07，S4/S7）

交错：

1. A 在新轮提交 J2；B 同时准备对旧轮 approved J1 final join。A 先提交 J2=`joining`。
2. B 随后取得 J1/Cycle/Member 锁，完成 Membership、grade、J1→joined，但只更新 J1。
3. J2 仍是 joining；`markGate/evaluate` 不复核“Member 仍未入队”，可继续把 J2 推到 approved
   （`team-join-applications.service.ts:112-280`）。
4. approved 后 evaluate 不再接受它，而 final join 永远因 M 已入队返回 `28210`。

后果：J2 成为没有现有终态通路的 frozen approved 行；这正是“父实体进入终态但子实体不级联”的 S4。

建议修法（不实施）：在既有 Application→Cycle→Member 锁图内，final join 同事务查询并按稳定顺序收口
该 member 的其它 live applications；目标终态、audit 和用户可见语义须由维护者先拍板。F4/F5 应作为
同一修复 goal，避免两套相反锁序。

## 5. 🟡 理论缺陷

### Y1 — Attendance submit claim Registration 后未复读（T01，S1）

`validateAndNormalizeRecordsBatch()` 在 `attendances.service.ts:536-650` 先读取 Registration，
之后才由 `claimRegistrationsForSubmit()` 在 `:657-669,725-730` 以 `expectedStatus=pass`
逐条 claim，claim 后没有复读。

当前不可达的具体阻断：

1. 状态变化：`expectedStatus=pass` 会拒绝已发生的 cancel/review 状态变化
   （`:657-669`）。
2. Activity/Position 变化：submit 在 `:697-712` 先持 Activity `FOR SHARE/UPDATE`；
   Activity、Position 和 pass cancel 的 production 写方均以同一 Activity 根锁串行。
3. Registration 关系变化：当前 5 个 `activityRegistration.update()` 只改
   review/cancel/reopen 生命周期字段
   （`activity-registrations.service.ts:1138,1212,1294,1382,1514`），没有
   `activityId/memberId/activityPositionId` 改写入口。

放松任一条件即转为活 bug：新增不持 Activity 根锁的 Position/Activity writer，或允许报名换成员/换活动/
换岗位而 submit 仍不复读，锁前 member/position/time-window snapshot 就能过期。

建议修法（不实施）：即使当前不可达，也应在已有 claim 后批量复读 Registration+Position，再生成 normalized
records；这是防御性加固，优先级低于 5 条活 bug。

## 6. S5：注释无执行位扫描

| 模块 | 结论 | 证据 |
|---|---|---|
| `attendances` | **确认 1 处强 S5**：注释声称 audit 失败会使 `attendance.recorded` 一起随 DB 事务回滚；实际事件只是立即 Logger 写出，DB 回滚不能撤回日志 | `attendances.service.ts:108-115` 对比 `common/event/event-placeholder.ts:1-35` |
| `activities` | 未发现新增 S5；Activity/Position/waitlist/responsibility 注释所述锁序均有对应执行位 | §3.1 G-ACT/G-POS/G-WAIT/G-RESP |
| `activity-registrations` | 确认 stale comment：App wrapper 仍写“容量满拒绝”和“仅 pending/pass 可取消”；运行时已支持 waitlist，cancel 状态机也包含 waitlisted | `app-my-registrations.service.ts:125-128,167-171` 对比 `activity-registration-state-machine.ts:82-93` |
| `team-join` | 确认 stale comment：文件头仍称 final join 消费综合评估延长期；运行时与 canonical 均明确不再依赖 | `team-join-enrollment.service.ts:48-52,144`；`docs/handoff/admin-web.md:528` |

这些 S5 结论不改代码、不替维护者选择语义。Attendance 项是错误的原子性论证；
Activity Registrations 与 Team Join 合计 3 组 stale comment 会误导后续维护者。

## 7. S6：runtime 与 canonical handoff 扫描

`docs/handoff` 的三份 Markdown 均已扫过；确认以下分叉：

| ID | canonical | runtime | 结论 |
|---|---|---|---|
| D1 | 有 live Position 时“编辑 Activity.capacity 不再触发递补”（`admin-web.md:73`） | Activity capacity update 仍计算 delta，并调用跨岗位 promotion（`activities.service.ts:760-803,867-890`） | **confirmed S6** |
| D2 | A 岗释放/扩容只递补 A 岗，不影响 B 岗（`admin-web.md:73`；`miniapp.md:108-111`） | preferred 队列为空后会进入其它有 headroom Position 的全局 FIFO fallback（`activity-waitlist-promotion.ts:311-347`） | **confirmed S6** |
| D3 | “队员取消已通过报名”才发 `activity-changed`（`admin-web.md:198,460`；`miniapp.md:65`） | pending/pass/waitlisted 的 self-cancel 都无条件 enqueue owner intent（`activity-registration-state-machine.ts:82-93`；`activity-registrations.service.ts:1555-1563`） | **confirmed S6** |

另外：

- `attendances` 的 finalApprove 阈值 intent 运行时设计与
  `miniapp.md:117`、`participation-bounded-context.md:144,246-248` 静态一致，但 F2 证明并发下会违约；
  已计入活 bug，不重复列为“静态代码分叉”。
- `team-join` 核心 runtime 与 `admin-web.md:522-528` 未发现新增 S6。
- **未确定，不擅自调和**：`attendances/CLAUDE.md:12` 要求所有业务写经
  AttendanceAuditRecorder；App checkIn/checkOut 成功路径直接写 ActivityCheckIn，canonical
  `docs/handoff/**` 未定义成功 GPS 证据是否必须写 AuditLog。需维护者确认 GPS evidence write 是否为豁免；
  本文不将其写成已确认缺陷。

## 8. 建议修复排序（只建议，不执行）

1. **F1 Attendance Admin edit(records)**：先修跨模块数据不变量；它能制造 cancelled Registration +
   live AttendanceRecord，后续多个读面都会继承矛盾事实。
2. **F4 + F5 Team Join 作为同一 goal**：共同设计 Member eligibility 根锁与 sibling application
   收口；只修一半仍可由另一个顺序留下正式队员的 live/frozen 申请。
3. **F2 finalApprove 聚合 write-skew**：建立 member+cycle/application 共同锁并补双连接测试，
   关闭永久漏发里程碑。
4. **F3 cancelMy 锁前 metadata**：风险主要是通知正确性，修复局部且应沿既有 Activity 根锁复读。
5. **Y1 submit 防御性复读**：当前有明确阻断，待活 bug 收口后做低风险加固。
6. **D1–D3/S5**：先由维护者拍板 canonical 是改运行时还是改 handoff/comment；不得在并发修复 PR
   里顺手调和。

建议修复 goal 至少拆为：Attendance cross-module evidence、Attendance contribution aggregate、
Team Join eligibility/cascade、Registration notification snapshot、canonical/comment decision。
写集相交的 participation 三项应串行集成。

## 9. 本次未审

- **范围内未遗漏业务写路径**：64 个并发语义落点及 33 个 activities 直接 mutation 位点均已判定；
  controller、bulk、App-managed 的纯委托通过其根方法覆盖，没有另计。
- 按 Goal 禁止域，未展开 `auth`、`authz`、RBAC、限流实现；因此“请求途中身份失效/离队与 GPS
  check-in/out 交错”只记录为未确定边界，不进入红黄绿。
- 未审 `certificates`、`recruitment`；它们已有独立四轮覆盖。
- AuditLogs、Notification Outbox、Insurance 仅沿调用链确认“同事务 sink/helper”所需事实，
  未把这些模块自身扩成新的审计范围。
- 未运行新并发 E2E、未连接生产数据库、未写临时探针；5 条 🔴 均给出源码可复核交错，
  但“数据库实测复现”留给后续获授权修复 goal 的 red-first 测试。
- 未修改 `src/`、`test/`、schema、migration、handoff、current-state；未实施任何建议修法。
