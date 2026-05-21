# Participation Bounded Context Map

> **本文用途**:命名并描述当前 SRVF 仓库中"参与 / 履约 / 贡献"业务上下文的实际边界、状态链条、跨模块耦合、API surface 与 governance 规则。
>
> **本文不是**:重构计划、模块合并提案、代码迁移路线图。
>
> **当前 layout 仍是 model-as-module**([`src/modules/activities/`](../src/modules/activities/) / [`src/modules/activity-registrations/`](../src/modules/activity-registrations/) / [`src/modules/attendances/`](../src/modules/attendances/) / [`src/modules/contribution-rules/`](../src/modules/contribution-rules/) / [`src/modules/certificates/`](../src/modules/certificates/) 各自独立目录)— 本文档**不**改变这一布局,只把已经存在的"边界"和"地图"显式化,供后续 PR review 与新会话理解业务链条参考。

---

## 1. Purpose

- 命名并描述当前 participation 业务上下文的边界范围。
- **不改代码、不动 schema、不合并模块、不改 API path**。
- 把现有跨模块耦合(`attendances` → `Activity` / `ActivityRegistration` / `ContributionRule`)从"凭经验知道"提升为显式文档。
- 让后续 PR review 与新会话能在一页内理解 `Activity → ActivityRegistration → AttendanceSheet → AttendanceRecord + ContributionRule` 这一链条的状态语义与事务边界。
- 让"是否物理合并 4 模块、是否新建 `src/modules/participation/` 子树"的决策有一份明确基线可对照。

---

## 2. Scope

### 2.1 Included(participation context 当前认定范围)

| 模块 | Prisma 模型 | 角色 |
|---|---|---|
| [`src/modules/activities/`](../src/modules/activities/) | `Activity` | 流程发起点;状态机 4 态 |
| [`src/modules/activity-registrations/`](../src/modules/activity-registrations/) | `ActivityRegistration` | 报名 4 态;活动 ↔ 队员 关联 |
| [`src/modules/attendances/`](../src/modules/attendances/) | `AttendanceSheet` / `AttendanceRecord` | 考勤、终审、贡献值落地 |
| [`src/modules/contribution-rules/`](../src/modules/contribution-rules/) | `ContributionRule` | 字典码键 lookup;配置实体而非流程实体 |

### 2.2 Explicitly excluded(明确不在 participation 范围内)

| 模块 | Prisma 模型 | 排除理由 |
|---|---|---|
| [`src/modules/certificates/`](../src/modules/certificates/) | `Certificate` | (1) FK 只到 `Member` + 自引用(`supersededByCertId`)+ `verifiedBy` Member 自校验链;**没有任何 FK** 指向 `Activity` / `ActivityRegistration` / `AttendanceSheet` / `AttendanceRecord` / `ContributionRule`。(2) `certificates.service.ts` 与 `app-my-certificates.service.ts` 完全**不读**上述任何表(grep 验证 0 命中)。(3) Certificate 的语义是**队员资格证书 / 外部资质**(潜水证 / 急救证),由管理员针对 Member 录入并 `verify`,**不是**参与活动后的产物。更接近一个独立的 `member-qualifications` / member credentials 上下文,本期保持独立。 |

> **例外触发条件(本文不开启,只列出)**:未来若新增"完成 X 次某类活动后系统颁发 Certificate"的发证规则,并且 `Certificate` 引入 FK 指向 `Activity` / `AttendanceSheet`,则需要重新评审是否纳入 participation。届时**必须**先开评审,**不**由 AI 自行扩边界。

---

## 3. Domain relationship map

```
Activity (statusCode: draft / published / completed / cancelled)
  ├─ ActivityRegistration[]   [FK activityId → Activity.id, Restrict;
  │     │                      partial unique (activityId, memberId)
  │     │                      WHERE deletedAt IS NULL AND statusCode != 'cancelled']
  │     └─ AttendanceRecord[]  [FK registrationId → ActivityRegistration.id,
  │                             NULLABLE, Restrict(Q-S21:不是 SetNull)]
  ├─ AttendanceSheet[]         [FK activityId → Activity.id, Restrict;
  │     │                      1 Activity 多 Sheet(D47 / R30)]
  │     └─ AttendanceRecord[]  [FK sheetId → AttendanceSheet.id, Restrict]
  │           └─ Member        [FK memberId → Member.id, Restrict]
  │
  └─ activityTypeCode ────┐
                          ├─ ContributionRule lookup
                          │   (NO FK;business-keyed by
                          │    activityTypeCode × attendanceRoleCode × durationThreshold)
                          │   consumed at AttendanceSheet.submit via
                          │   tx.contributionRule.findMany
AttendanceRecord.roleCode ┘

Certificate (不在 participation 图内)
  └─ FK memberId → Member.id
  └─ FK verifiedBy → Member.id(自校验链)
  └─ FK supersededByCertId → Certificate.id(自引用)
```

**关系类型对照**:

| 关系 | 类型 | onDelete | 备注 |
|---|---|---|---|
| `Activity` ← `ActivityRegistration.activityId` | FK NOT NULL | Restrict | 报名必须挂在 Activity 上 |
| `Activity` ← `AttendanceSheet.activityId` | FK NOT NULL | Restrict | 1 Activity 多 Sheet |
| `AttendanceSheet` ← `AttendanceRecord.sheetId` | FK NOT NULL | Restrict | 记录必须挂在 Sheet 上 |
| `ActivityRegistration` ← `AttendanceRecord.registrationId` | FK **NULLABLE** | Restrict(Q-S21 明确**不**是 SetNull) | 临时参加 / 非公开报名时为 null |
| `ContributionRule` ↔ `AttendanceRecord` | **不是 FK** | — | 业务键 lookup,仅在 submit 事务内查表预填 `contributionPoints` |
| `Certificate` ↔ 上面任何实体 | **无关系** | — | 仅 `Member` 关联;不在本上下文 |

---

## 4. Lifecycle / state chain

| Stage | Module | State / action | Downstream effect |
|---|---|---|---|
| 1. 活动起草 | activities | `create` → `statusCode='draft'` | 仅创建,无下游 |
| 2. 活动发布 | activities | `publish` → `draft → published` | 解锁 Registration 创建与 AttendanceSheet 提交 |
| 3. 活动取消 | activities | `cancel` → `* → cancelled` | 阻断所有下游写;attendances 在 `findActivityForSubmissionFull` 内会拒绝 `ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN` |
| 4. 报名(admin / app / legacy) | activity-registrations | `create` / `createMy` → `pending` | 不影响 Activity 状态;partial unique 防重复 |
| 5. 报名审核 | activity-registrations | `approve` / `reject` → `pass` / `reject` | 仅服务内部状态 |
| 6. 报名取消 | activity-registrations | `cancelAdmin` / `cancelMy` → `cancelled` | partial unique 允许同人再次报名 |
| 7. 考勤表首次提交 | attendances | `submit` → `Sheet.statusCode='pending'` + 多条 `Record` 同事务建立 | **跨模块写**:`Activity.statusCode` 从 `published → completed`(D11 / D-S10;[`attendances.service.ts:495`](../src/modules/attendances/attendances.service.ts:495));**跨模块读**:`tx.contributionRule.findMany` 预填 `AttendanceRecord.contributionPoints`(D14 5.B;[`contribution-calculator.ts:89`](../src/modules/attendances/contribution-calculator.ts:89));**跨模块读**:`assertRegistrationMatchesActivity` 校验 `registrationId.activityId === sheet.activityId`(R23;[`attendances.service.ts:299`](../src/modules/attendances/attendances.service.ts:299)) |
| 8. APD 一级审核 | attendances | `approve` → `pending → pending_final_review`;`reject` → `pending → rejected` | **不**触发 `attendance.recorded`(沿 D-S7;触发点已移到 final-approve) |
| 9. APD 终审通过 | attendances | `finalApprove` → `pending_final_review → approved` | **`contributionPoints` 在此刻语义上生效**;同事务内 `eventPlaceholder('attendance.recorded')` 发出([`attendances.service.ts:1003`](../src/modules/attendances/attendances.service.ts:1003));未来 contribution-points 聚合器从此事件消费 |
| 10. APD 终审驳回 | attendances | `finalReject` → `pending_final_review → final_rejected` | 不触发 `attendance.recorded`;records 跟随软删 |
| —. ContributionRule 维护 | contribution-rules | ops 后台 CRUD;`status: ACTIVE / INACTIVE` | **不是流程状态实体**;仅作为预填配置,在 Step 7 被读取;`active_unique (activityTypeCode, attendanceRoleCode, durationThreshold) WHERE deletedAt IS NULL AND status = 'ACTIVE'` 由 migration SQL 加 partial unique |

**关键 invariant**:

- `AttendanceRecord.contributionPoints` 字段层可空;**业务**层在 Step 9(approved)之前可由 APD 现场修订;终审通过即"语义生效"。
- `attendance.recorded` 事件是 participation context **向外的唯一已锁定出口语义**;其它消费方(未来 contribution 聚合 / 仪表盘 / 队员个人贡献值汇总)应当订阅它,**不应**直接读 `AttendanceSheet` / `AttendanceRecord` 表。
- Activity → completed 由 attendances submit 推动,这是**已知的跨 aggregate 写**;在 §5.2 中明确允许,**不再扩散**到其它方向。

---

## 5. Current code boundary

### 5.1 保留 4 个 module 目录

本期**保留** [`src/modules/activities/`](../src/modules/activities/) / [`src/modules/activity-registrations/`](../src/modules/activity-registrations/) / [`src/modules/attendances/`](../src/modules/attendances/) / [`src/modules/contribution-rules/`](../src/modules/contribution-rules/) 四个独立目录;**不**做 `src/modules/participation/<sub>/` 大合并(参见 §8 Deferred work)。

### 5.2 允许 / 禁止的跨模块访问形式

| 行为 | 是否允许 | 说明 |
|---|---|---|
| `attendances` 在事务内读 `tx.activity.findFirst` | ✅ 允许 | `assertActivityExists` / `findActivityForSubmissionFull` 多处使用;Activity 是 attendances 的前置依赖 |
| `attendances` 在事务内**写** `tx.activity.update({ data: { statusCode: 'completed' }})` | ✅ 允许(唯一例外) | D11 / D-S10 推动:首张 Sheet 创建 → Activity.completed;**这是唯一已认定的跨 aggregate 写**,**不要再扩散** |
| `attendances` 在事务内读 `tx.activityRegistration.findFirst` | ✅ 允许 | R23 校验 `registration.activityId === sheet.activityId` |
| `attendances` 在事务内读 `tx.contributionRule.findMany` | ✅ 允许 | D14 5.B 系统预填;走 [`contribution-calculator.ts`](../src/modules/attendances/contribution-calculator.ts) |
| `activities` 在事务内读 / 写 `tx.attendanceSheet` / `tx.attendanceRecord` | ❌ 不允许 | Activity 是上游,不下探;若需要派生统计,通过 `attendance.recorded` 事件或独立 service |
| `activity-registrations` 在事务内读 / 写 `tx.attendanceSheet` / `tx.attendanceRecord` | ❌ 不允许 | 同上 |
| `contribution-rules` 在事务内读 / 写其它 participation 表 | ❌ 不允许 | ContributionRule 是配置实体,只被读,不读人 |
| 任一模块通过 `import { *Service } from '../<sibling>/...'` 调用兄弟 service | ❌ 不允许(当前 0 命中) | 当前 grep 验证 5 模块之间 service-to-service import = 0;**保持**该零态 |
| 任何 **非** participation 模块读写 `Activity` / `ActivityRegistration` / `AttendanceSheet` / `AttendanceRecord` / `ContributionRule` 表 | ❌ 不允许 | 必须通过 participation 模块的 service 入口或 `attendance.recorded` 事件 |

### 5.3 Transaction boundary

- **submit 路径**:Activity 检查 + ContributionRule 预填 + Sheet 创建 + N 条 Record 创建 + Activity 推完成 + audit 写入,**全部在一个 `prisma.$transaction(...)` 内**。
- **finalApprove 路径**:Sheet 状态翻转 + Record 复查 + `attendance.recorded` 事件 + audit 写入,**全部在一个 `prisma.$transaction(...)` 内**。
- 跨 aggregate 写**只允许在同事务内发生**;**禁止**用"先 attendances 改完,再回调 activities"的两阶段方式;**禁止**用 `setTimeout` / `Promise.then` 把后续写挪出事务。

### 5.4 ContributionRule 是配置,不是流程

- `contribution-rules` 没有 mobile / app surface,只在 ops 管理面([`v2/contribution-rules`](../src/modules/contribution-rules/contribution-rules.controller.ts))。
- 其状态 `ACTIVE / INACTIVE` 是**配置启停**,与 participation 业务流程的状态机**正交**。
- 当 ContributionRule 在 submit 时找不到匹配规则,**service 兜底默认值,不抛错**(沿 BizCode 注释段 `22048` 的设计;参见 [`biz-code.constant.ts`](../src/common/exceptions/biz-code.constant.ts))。

---

## 6. API surface boundary

> 本节只描述 participation 上下文与 [`api-surface-policy.md`](api-surface-policy.md) 三层 surface 的对应关系,不重复 surface policy 本身。

### 6.1 Admin / Ops surface

| Surface | 路径前缀 | 文件 |
|---|---|---|
| Admin Activities | `v2/activities` | [`activities.controller.ts`](../src/modules/activities/activities.controller.ts) |
| Admin Registrations | `v2/activities/:activityId/registrations` | [`activity-registrations.controller.ts`](../src/modules/activity-registrations/activity-registrations.controller.ts) |
| Admin Attendances | `v2/activities/:activityId/attendance-sheets` + `v2/attendance-sheets` | [`attendances.controller.ts`](../src/modules/attendances/attendances.controller.ts) |
| Ops ContributionRules | `v2/contribution-rules` | [`contribution-rules.controller.ts`](../src/modules/contribution-rules/contribution-rules.controller.ts) |

### 6.2 App surface(participation 视角的 mobile 路径)

| 路径 | 文件 |
|---|---|
| `app/v1/activities/available` / `app/v1/activities/:id` | [`controllers/app-activities.controller.ts`](../src/modules/activities/controllers/app-activities.controller.ts) |
| `app/v1/my/activities` / `app/v1/my/registrations` / `app/v1/my/registrations/:id` / `POST app/v1/my/registrations` / `PATCH app/v1/my/registrations/:id/cancel` | [`controllers/app-my-registrations.controller.ts`](../src/modules/activity-registrations/controllers/app-my-registrations.controller.ts) |
| `app/v1/my/attendance-records` | [`controllers/app-my-attendance-records.controller.ts`](../src/modules/attendances/controllers/app-my-attendance-records.controller.ts) |

> 沿 [`api-surface-policy.md`](api-surface-policy.md) Mobile App 段,App API DTO 严格独立于 Admin DTO,以 `currentUser.memberId` 锁定本人;`scope = self`。

### 6.3 Legacy Root surface(已知边界问题,本期不处理)

| 路径 | 文件 |
|---|---|
| `v2/users/me/activities/:activityId/registration`(POST)+ `v2/users/me/registrations*`(GET / cancel) | [`controllers/activity-registrations-me-legacy.controller.ts`](../src/modules/activity-registrations/controllers/activity-registrations-me-legacy.controller.ts) |
| `v2/users/me/attendance-records` | [`attendances.controller.ts`](../src/modules/attendances/attendances.controller.ts)(末段 `@Controller('v2/users/me/attendance-records')`) |

> 这些是**旧 mobile-like endpoint**,沿 [`api-surface-policy.md`](api-surface-policy.md) "只维护兼容、不扩展"。新移动端能力**只在** `/api/app/v1/*` 落地。legacy 与 app 双路径是**已知边界问题**,本文**不**主张立即删除 legacy;清理需要独立立项。

---

## 7. Governance rules

新增 participation 相关代码或规则时,**必须**逐条对照:

1. **判定归属**:新规则是属于某一个实体(Activity / Registration / Sheet / Record / Rule),还是属于整体流程?
   - 如果属于单实体,落在对应模块的 service;
   - 如果属于流程(跨实体的状态决策 / 校验 / 计算),默认落在 `attendances/` 下并通过 `*-policy.ts` / `*-state-machine.ts` / `*-calculator.ts` 命名(沿现有 4 抽:[`time-overlap-policy.ts`](../src/modules/attendances/time-overlap-policy.ts) / [`attendance-sheet-state-machine.ts`](../src/modules/attendances/attendance-sheet-state-machine.ts) / [`contribution-calculator.ts`](../src/modules/attendances/contribution-calculator.ts) / [`attendance-audit-recorder.ts`](../src/modules/attendances/attendance-audit-recorder.ts))。

2. **禁止大搬目录**:**不**为了"统一上下文"把 4 模块挪到 `src/modules/participation/<sub>/`;**除非**先开 D 档评审并落 ADR,并由用户拍板。

3. **禁止扩 certificates 边界**:**不**把 [`certificates/`](../src/modules/certificates/) 模块纳入 participation;**除非**未来出现明确的"完成活动后系统颁发 Certificate"发证规则,且 `Certificate` 引入 FK 指向 `Activity` / `AttendanceSheet`。届时**必须**先开评审。

4. **新增跨表写**:**必须**在 PR 描述中明确说明 transaction boundary;**必须**说明是否扩散了 §5.2 表中现有的"跨 aggregate 写"许可。默认**不扩散**——即只有 `attendances → Activity.statusCode='completed'` 这一条已存在的跨 aggregate 写被允许。

5. **新增 ContributionRule 消费方**:**必须**说明是否复用 `attendances` 现有的 `applyContributionRulePrefill` 语义;如果新消费方走自己的 lookup 路径,**必须**说明为什么不复用以及如何保持语义一致(档位 / cap / 默认值兜底)。

6. **新增 App `/my/*` 端点**:**必须**说明与 legacy `v2/users/me/*` 路径的关系(覆盖 / 并存 / 替代);默认沿 [`api-surface-policy.md`](api-surface-policy.md) "新移动端能力只在 `/api/app/v1/*` 落地"。

7. **状态机扩展**:对 `Activity` / `ActivityRegistration` / `AttendanceSheet` 任意一个 `statusCode` 集合做扩展时,**必须**同步更新本文 §4 表;BizCode 仍按现行段位(沿 [`biz-code.constant.ts`](../src/common/exceptions/biz-code.constant.ts) 与 [`docs/current-state.md`](current-state.md))。

---

## 8. Deferred work(本期不做)

明确**不**在本 PR 范围内,需要时各自单独立项:

- 不立即重组 4 个模块,**不**创建 `src/modules/participation/<sub>/` 目录树。
- 不删除 legacy `v2/users/me/*` / `v2/users/me/attendance-records`(沿 [`api-surface-policy.md`](api-surface-policy.md) "只维护兼容、不扩展")。
- 不抽 `participation/` 共享 module / 共享 service / 共享 DTO 基座。
- 不移动 Prisma model 在 [`prisma/schema.prisma`](../prisma/schema.prisma) 内的位置,不改 FK,不改字段。
- 不改 [`src/modules/permissions/`](../src/modules/permissions/) / RBAC 权限点(沿现行 P0-F 收紧范围)。
- 不改 BizCode 段位(沿现行 [`biz-code.constant.ts`](../src/common/exceptions/biz-code.constant.ts) 与 BizCode range index)。
- 不动 [`src/modules/certificates/`](../src/modules/certificates/) — 它是独立的 member-qualifications 上下文,本文只是把它从 participation 排除。
- 不引入新 audit / event 主题;`attendance.recorded` 仍然是唯一对外事件出口。
- 不对 `app/v1/*` ↔ `v2/users/me/*` 两路径做合并或迁移。
- 不动 [`src/common/exceptions/biz-code.constant.ts`](../src/common/exceptions/biz-code.constant.ts) 中跨 participation 的共享 BizCode 命名(`ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN` / `ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH` / `CONTRIBUTION_RULE_*` 等)。

---

## 9. Source references

### 代码

- [`src/modules/activities/`](../src/modules/activities/)
- [`src/modules/activity-registrations/`](../src/modules/activity-registrations/)
- [`src/modules/attendances/`](../src/modules/attendances/) — 含 4 抽:[`contribution-calculator.ts`](../src/modules/attendances/contribution-calculator.ts) / [`time-overlap-policy.ts`](../src/modules/attendances/time-overlap-policy.ts) / [`attendance-sheet-state-machine.ts`](../src/modules/attendances/attendance-sheet-state-machine.ts) / [`attendance-audit-recorder.ts`](../src/modules/attendances/attendance-audit-recorder.ts)
- [`src/modules/contribution-rules/`](../src/modules/contribution-rules/)
- [`src/modules/certificates/`](../src/modules/certificates/) — **明确排除**,作为对照引用
- [`src/common/exceptions/biz-code.constant.ts`](../src/common/exceptions/biz-code.constant.ts) — BizCode 来源(其中 `ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN` / `ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH` / `CONTRIBUTION_RULE_*` 等为跨模块共享词汇)

### Schema

- [`prisma/schema.prisma`](../prisma/schema.prisma)(`Activity` / `ActivityRegistration` / `AttendanceSheet` / `AttendanceRecord` / `ContributionRule` / `Certificate` 段;后者为对照排除)

### 文档

- [`docs/current-state.md`](current-state.md) — 当前版本状态、已发能力、当前债务
- [`docs/api-surface-policy.md`](api-surface-policy.md) — App API / Admin Legacy / Root Legacy 三层 surface 长期边界
- [`docs/v2-api-contract.md`](v2-api-contract.md) — V2 第一阶段接口契约(完整字段 / 错误码 / 权限矩阵)
- [`docs/v2-data-model.md`](v2-data-model.md) — V2 第一阶段数据模型说明
- [`AGENTS.md`](../AGENTS.md) — 长期 AI 协作铁律主入口(命名 / 目录 / 错误码 / 软删除等)
