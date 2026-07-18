# Architecture Boundary Policy

> **Status**:active policy
> **Scope**:SRVF V2 derived project (`srvf-nest-api`)
> **Source decision**:[`AGENTS.md §19.7 D-7`](../AGENTS.md)(decision-lock record;不再重开讨论)
> **Purpose**:define when new logic should stay in an application service and when it should be extracted into a named boundary class.

---

## 1. Purpose

本文档把 [`AGENTS.md §19.7 D-7`](../AGENTS.md) 的"架构边界 6 类"决策正式承接到 active execution policy。

- [`AGENTS.md §19.7 D-7`](../AGENTS.md) remains the **decision-lock record**(出处 / 拍板时间 / 不再重开讨论)。
- 本文档 is the **execution policy** for future code changes(常规 PR 直接引用)。

The goal is **not** to force large rewrites. The goal is to prevent new service-level god objects by **naming the boundary before code grows**(沿 [`docs/current-state.md §4 P2`](current-state.md) god-service 债务条目)。

---

## 2. Core rule

**Application services remain the transaction owner and orchestration layer.**

When new logic belongs to one of the boundary types in §3 below, prefer a **named class inside the same module** instead of adding another large private helper block to the application service.

**Do not extract merely to reduce LOC.** Extract only when:

- the boundary is **clear**(可命名为单一职责;沿 [`AGENTS.md` §6 同模块内职责类抽出](../AGENTS.md) 铁律), and
- the behavior has **tests or characterization coverage**(沿 [`docs/api-surface-policy.md §7 P1-B`](api-surface-policy.md) characterization-tests-before-refactor 铁律)。

---

## 3. Boundary types

### 3.1 Presenter

Use a Presenter when the logic is mainly about converting internal models / Prisma rows / snapshots into **response DTOs or view models**.

**Should contain**:
- response shaping
- field projection for output
- UI-facing formatting
- stable DTO assembly

**Should not contain**:
- Prisma writes
- authorization
- state transition decisions
- audit writes
- side effects

**Trigger examples**:
- a controller or service builds the same output shape in multiple places
- response shape has many conditional fields(e.g. App view vs Admin view)
- mobile / admin / public views diverge across the same entity

**Current example**:
- [`src/modules/attendances/attendance-presenter.ts`](../src/modules/attendances/attendance-presenter.ts)(P1-4 第一刀;序列化方法在 service 内被 15 处调用,命中第一条 trigger)

### 3.2 QueryService

Use a QueryService when the logic is mainly about **read-side query construction**.

**Should contain**:
- list / detail read queries
- filters
- pagination
- include / select strategy
- read-only aggregation

**Should not contain**:
- business state mutation
- audit writes
- transaction-owned write flows
- permission decisions(except read-scope filters explicitly passed in)

**Trigger examples**:
- list query grows large(many filter branches / dynamic select)
- multiple endpoints share the same read model
- mobile / admin / public read surfaces need different query shapes

### 3.3 PolicyService / Policy

Use a Policy when the logic decides **whether an action is allowed** or **how a rule should be evaluated**.

**Should contain**:
- allow / deny decisions
- eligibility checks
- invariant checks
- domain-specific validation
- pure or near-pure rule evaluation

**Should not contain**:
- audit writes
- DTO presentation
- unrelated DB writes
- controller-level request parsing

**Current examples**:
- [`src/modules/attendances/time-overlap-policy.ts`](../src/modules/attendances/time-overlap-policy.ts)
- [`src/modules/users/users.policy.ts`](../src/modules/users/users.policy.ts)

### 3.4 StateMachine

Use a StateMachine when an entity has a **finite set of states** and actions move it between states or reject invalid transitions.

**Should contain**:
- allowed source state checks
- next state decisions
- BizCode mapping for invalid transitions
- pure transition decisions

**Should not contain**:
- Prisma writes
- audit writes
- event emission
- DTO mapping
- cross-aggregate side effects

**Current example**:
- [`src/modules/attendances/attendance-sheet-state-machine.ts`](../src/modules/attendances/attendance-sheet-state-machine.ts)

### 3.5 AuditRecorder

Use an AuditRecorder when **repeated audit log payload assembly** starts to dominate a service.

**Should contain**:
- audit event name selection
- `resourceType` / `resourceId` payload assembly
- before / after snapshot assembly
- audit `extra` payload assembly
- calls to `AuditLogsService.log(...)` with the transaction passed in

**Should not contain**:
- transaction ownership
- business table writes
- authorization
- state transition decisions
- unrelated side effects

**Current example**:
- [`src/modules/attendances/attendance-audit-recorder.ts`](../src/modules/attendances/attendance-audit-recorder.ts)

### 3.6 Effect

Use an Effect when a business action triggers an **external or deferred side effect**.

**Should contain**:
- notification dispatch
- event publishing
- external API calls
- async job handoff
- integration-side payload assembly

**Should not contain**:
- core state transition decisions
- ownership of the main database transaction(unless explicitly designed)
- DTO presentation

**Current status**:
- **First real Effect class is now active**: [`src/modules/notifications/notification-dispatcher.ts`](../src/modules/notifications/notification-dispatcher.ts)(`NotificationDispatcher`,统一通知 GAP-005 S3,2026-06-25)—— 真实副作用路径 = 微信订阅消息外部 API。招新发号/入队只在主业务 transaction 内写 `notification.targeted@1` intent，独立 outbox worker 提交后调用 `dispatchTargeted(...)`；外部 HTTP 始终在主业务事务之外(§6.2)，Effect 不持有主事务、不做核心状态跃迁、不做 DTO 呈现。
- `eventPlaceholder('attendance.recorded')` remains a domain marker inside the attendance flow；participation 通知 producer 已接 S4 dispatcher，但仍是 commit 后 best-effort，属于下一批 outbox 接线范围。
- **Do not** introduce *additional* Effect classes until a real side-effect path exists(短信 / 跨系统集成等);新通知类型先回评审,不在模块内自由生长。

---

## 4. What stays in the application service

The application service should usually keep:

- transaction orchestration(`prisma.$transaction(...)` 持有者)
- call ordering
- Prisma write coordination
- loading the aggregate root
- calling policies / state machines / recorders
- deciding which collaborator to invoke
- returning DTOs(when the presenter boundary is still small)

The service should **not** become a dumping ground for:

- long repeated audit payloads → 抽 AuditRecorder
- embedded state machines → 抽 StateMachine
- large response presenter logic → 抽 Presenter
- repeated query builders → 抽 QueryService
- unrelated side-effect payload assembly → 抽 Effect

---

## 5. Current code examples

| Boundary | Current file | Status |
|---|---|---|
| StateMachine | [`src/modules/attendances/attendance-sheet-state-machine.ts`](../src/modules/attendances/attendance-sheet-state-machine.ts) | **active**(PR #183 抽出) |
| StateMachine | [`src/modules/activities/activity-state-machine.ts`](../src/modules/activities/activity-state-machine.ts) | **active**(PR #200 抽出) |
| StateMachine | [`src/modules/activity-registrations/activity-registration-state-machine.ts`](../src/modules/activity-registrations/activity-registration-state-machine.ts) | **active**(PR #197 抽出) |
| AuditRecorder | [`src/modules/attendances/attendance-audit-recorder.ts`](../src/modules/attendances/attendance-audit-recorder.ts) | **active**(PR #185 抽出) |
| AuditRecorder | [`src/modules/activities/activity-audit-recorder.ts`](../src/modules/activities/activity-audit-recorder.ts) | **active**(PR #201 抽出) |
| AuditRecorder | [`src/modules/activity-registrations/activity-registration-audit-recorder.ts`](../src/modules/activity-registrations/activity-registration-audit-recorder.ts) | **active**(PR #198 抽出) |
| AuditRecorder | [`src/modules/attachments/attachment-audit-recorder.ts`](../src/modules/attachments/attachment-audit-recorder.ts) | **active**(PR #203 抽出) |
| Policy | [`src/modules/attendances/time-overlap-policy.ts`](../src/modules/attendances/time-overlap-policy.ts) | **active** |
| Policy | [`src/modules/users/users.policy.ts`](../src/modules/users/users.policy.ts) | **active** |
| Calculator | [`src/modules/attendances/contribution-calculator.ts`](../src/modules/attendances/contribution-calculator.ts) | **active**:accepted adjacent pattern;not one of the six D-7 names but follows the same extraction discipline(纯计算、无 Prisma 写、无 audit) |
| Presenter | [`src/modules/attendances/attendance-presenter.ts`](../src/modules/attendances/attendance-presenter.ts) | **active**(P1-4 第一刀,2026-06-10 方案 A 拍板抽出;select 查询策略不随迁,留 service) |
| QueryService | none required yet | **deferred** |
| Effect | [`src/modules/notifications/notification-dispatcher.ts`](../src/modules/notifications/notification-dispatcher.ts) | **active**(GAP-005 S3 抽出;首个真实 Effect = 微信外部 API;招新/入队 targeted intent 由 outbox worker 驱动) |

---

## 6. Trigger rules

**Before** adding a new mobile endpoint, new export endpoint, new approval state, new data scope, or new notification side effect — check this document(沿 [`AGENTS.md §19.7 D-7`](../AGENTS.md) Refactor Triggers)。

Prefer a named boundary class when **any** of the following is true:

- one method would gain another large private helper block
- the same rule appears in more than one method
- a state transition table is emerging
- audit payload assembly repeats across write paths
- read-side query construction is becoming a separate concern
- side-effect payload construction is not part of core persistence

**Do not** extract when:

- the logic is less than a few clear lines
- the rule is not stable(仍在频繁改动)
- the behavior is not tested or characterized(沿 §2 末尾 characterization-tests-before-refactor 铁律)
- extraction would create a **generic grab-bag helper**(沿 [`AGENTS.md` §6 同模块内职责类抽出](../AGENTS.md) "禁止变成无边界的 common util grab-bag")
- the new class would **hide** rather than clarify the transaction boundary

---

## 7. Governance

- New boundary classes should stay **inside the owning module** unless a cross-module use case is proven。
- **Do not** create shared generic helper bags(`common/utils/` / `shared-services/` 之类的目录扩张视作越权)。
- **Do not** move Prisma write ownership out of the application service unless explicitly reviewed。
- **Do not** introduce a `*.repository.ts` abstraction layer merely to wrap Prisma(沿 [`docs/api-surface-policy.md §8`](api-surface-policy.md) "不引入 repository 抽象层" 铁律)。
- Prefer **characterization tests before** extracting behavior from a large service(沿 [`docs/current-state.md §4 P2`](current-state.md) god-service 拆分前置条件)。
- For docs / code 冲突,[`AGENTS.md §19.7 D-7`](../AGENTS.md) is the decision-lock record;本文档 is the active execution policy。

---

## 8. Deferred work(本期不做)

- **Do not** retrofit every existing service into this pattern immediately(沿 [`AGENTS.md §19.7 D-7`](../AGENTS.md) "本规则不要求立即大规模重构" 段)。
- **Do not** extract QueryService / Effect until a concrete trigger appears(沿 §6 Trigger rules;Presenter 已于 2026-06-10 P1-4 第一刀按"逐个立项"路径抽出,见 §5)。
- **Do not** rename existing extracted classes just to match this document(`contribution-calculator.ts` 保留现名,不强行改为 "Service" / "Policy" 等)。
- **Do not** move participation / attachment / permissions module directories as part of this policy(沿 [`docs/participation-bounded-context.md §8`](participation-bounded-context.md) "禁止大搬目录" 铁律)。
- **Do not** alter `attendances.service.ts`(1157 LOC)/ `attachments.service.ts`(826 LOC)/ `activity-registrations.service.ts`(750 LOC)/ `activities.service.ts`(607 LOC)行为 — 拆分需先补 characterization tests + 单独立项(沿 [`docs/current-state.md §3 / §4`](current-state.md));LOC 为 2026-05-23 实测,已计入 §5 state-machine + audit-recorder 抽离后的余量。

---

## 9. Source references

- [`AGENTS.md §19.7 D-7`](../AGENTS.md) — decision-lock record(2026-05-19 立项)
- [`docs/archive/reviews/code-architecture-boundary-review.md`](archive/reviews/code-architecture-boundary-review.md) — Phase 0.7 评审稿(已归档;**仅作历史证据,不再作为当前执行约束**;沿 [`docs/README.md §2`](README.md) 归档铁律)
- [`docs/participation-bounded-context.md §7`](participation-bounded-context.md) — participation 上下文内的 `*-policy.ts` / `*-state-machine.ts` / `*-calculator.ts` / `*-audit-recorder.ts` 命名约定(本文档与之兼容,且把范围扩到全仓库 + 增加 Presenter / QueryService / Effect 3 类未来触发条件)
- [`docs/api-surface-policy.md §7-§8`](api-surface-policy.md) — characterization-tests-before-refactor + 不引入 repository 抽象层
- [`docs/current-state.md §4`](current-state.md) — god-service 债务条目与拆分前置条件
