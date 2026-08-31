# Architecture Boundary Policy

> **Status**:active policy
> **Scope**:SRVF V2 derived project (`srvf-nest-api`)
> **Source decision**:[`AGENTS.md §2 D-7`](../AGENTS.md)(decision-lock entry;不再重开讨论)
> **Purpose**:define when new logic should stay in an application service and when it should be extracted into a named boundary class.

---

## 1. Purpose

本文档把 [`AGENTS.md §2 D-7`](../AGENTS.md) 的"架构边界 6 类"决策正式承接到 active execution policy。

- [`AGENTS.md §2 D-7`](../AGENTS.md) remains the **decision-lock entry**(出处 / 不再重开讨论;全文在 reference)。
- 本文档 is the **execution policy** for future code changes(常规 PR 直接引用)。

The goal is **not** to force large rewrites. The goal is to prevent new service-level god objects by **naming the boundary before code grows**(沿 [`docs/current-state.md §4 P2`](current-state.md) god-service 债务条目)。

---

## 2. Core rule

**Application services remain the transaction owner and orchestration layer.**

When new logic belongs to one of the boundary types in §3 below, prefer a **named class inside the same module** instead of adding another large private helper block to the application service.

**Do not extract merely to reduce LOC.** Extract only when:

- the boundary is **clear**(可命名为单一职责;沿 [`AGENTS.md §1`](../AGENTS.md) + [`reference/naming-dto-validation.md §2`](reference/naming-dto-validation.md) 同模块内职责类抽出铁律), and
- the behavior has **tests or characterization coverage**(沿根 [`AGENTS.md §1`](../AGENTS.md) 测试纪律 + [`current-state.md §4 P2`](current-state.md))。

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
- **First real Effect path is now active**: [`src/modules/notifications/notification-outbox.handlers.ts`](../src/modules/notifications/notification-outbox.handlers.ts) + [`notification-dispatcher.ts`](../src/modules/notifications/notification-dispatcher.ts)(兼容实现)—— 真实副作用路径 = 微信订阅消息外部 API。招新发号/入队与 participation L1-L4 只在主业务 transaction 内写既有 outbox intent，独立 outbox worker 提交后执行 Effect；外部 HTTP 始终在主业务事务之外(§6.2)，Effect 不持有主事务、不做核心状态跃迁、不做 DTO 呈现。
- `eventPlaceholder('attendance.recorded')` remains a domain marker inside the attendance flow；考勤退回/终审通知已由 `AttendanceNotificationProducer` 在同一业务事务内写 durable intent。
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
| Effect | [`src/modules/notifications/notification-outbox.handlers.ts`](../src/modules/notifications/notification-outbox.handlers.ts) | **active**(GAP-005 S3/D-Outbox;首个真实 Effect = 微信外部 API;业务 targeted intent 由 outbox worker 驱动) |

---

## 6. Trigger rules

**Before** adding a new mobile endpoint, new export endpoint, new approval state, new data scope, or new notification side effect — check this document(沿 [`AGENTS.md §2 D-7`](../AGENTS.md) Refactor Triggers)。

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
- extraction would create a **generic grab-bag helper**(沿 [`AGENTS.md §1`](../AGENTS.md) "禁止变成无边界的 common util grab-bag")
- the new class would **hide** rather than clarify the transaction boundary

---

## 7. Governance

- New boundary classes should stay **inside the owning module** unless a cross-module use case is proven。
- **Do not** create shared generic helper bags(`common/utils/` / `shared-services/` 之类的目录扩张视作越权)。
- **Do not** move Prisma write ownership out of the application service unless explicitly reviewed。
- **Do not** introduce a `*.repository.ts` abstraction layer merely to wrap Prisma;本 active policy 只允许 §3 六类有边界职责,单纯包一层 Prisma 不构成抽离理由。
- Prefer **characterization tests before** extracting behavior from a large service(沿 [`docs/current-state.md §4 P2`](current-state.md) god-service 拆分前置条件)。
- For docs / code 冲突,[`AGENTS.md §2 D-7`](../AGENTS.md) is the decision-lock entry;本文档 is the active execution policy。

---

## 8. Deferred work(本期不做)

- **Do not** retrofit every existing service into this pattern immediately(沿 [`AGENTS.md §2 D-7`](../AGENTS.md) "本规则不要求立即大规模重构" 段)。
- **Do not** extract QueryService / Effect until a concrete trigger appears(沿 §6 Trigger rules;Presenter 已于 2026-06-10 P1-4 第一刀按"逐个立项"路径抽出,见 §5)。
- **Do not** rename existing extracted classes just to match this document(`contribution-calculator.ts` 保留现名,不强行改为 "Service" / "Policy" 等)。
- **Do not** move participation / attachment / permissions module directories as part of this policy(沿 [`docs/participation-bounded-context.md §8`](participation-bounded-context.md) "禁止大搬目录" 铁律)。
- **Do not** alter the large attendances / attachments / activity-registrations / activities services as an incidental cleanup — 拆分需先补 characterization tests + 单独立项(沿 [`docs/current-state.md §3 / §4`](current-state.md));实时体量由 `docs:codemap:check` 报告,本 policy 不固化易漂 LOC。

---

## 9. Source references

- [`AGENTS.md §2 D-7`](../AGENTS.md) — decision-lock entry(2026-05-19 立项)
- [`archive/reviews/code-architecture-boundary-review.md`](archive/reviews/code-architecture-boundary-review.md) — Phase 0.7 评审稿(已归档;**仅作历史证据,不再作为当前执行约束**;沿 [`docs/README.md §2`](README.md) 归档铁律)
- [`docs/participation-bounded-context.md §7`](participation-bounded-context.md) — participation 上下文内的 `*-policy.ts` / `*-state-machine.ts` / `*-calculator.ts` / `*-audit-recorder.ts` 命名约定(本文档与之兼容,且把范围扩到全仓库 + 增加 Presenter / QueryService / Effect 3 类未来触发条件)
- [`docs/api-surface-policy.md §7-§8`](api-surface-policy.md) — 2026-05 P1 执行期历史来源;当前规则由本文 §2 / §7 + 根 `AGENTS.md §1` 承接
- [`docs/current-state.md §4`](current-state.md) — god-service 债务条目与拆分前置条件

---

## 10. Activity OS 的可选 AI Assist 边界

Activity OS 的 AI 不是第七类核心架构边界，也不是核心服务的依赖。它若在未来出现，只能是
可拔插的辅助渠道；AI 不可用、超时、返回非法内容或没有网络时，核心业务必须照常完成。

- **核心不反向依赖 Assist**：Activity、报名、发布、考勤、结算、时长、贡献、成果、更正和
  核心 health 不得 import AI 模块、SDK 或 Provider，更不得在主事务中等待其结果。
- **Assist 只经 Facade**：读取只能使用已授权的 Query DTO、脱敏结构化上下文和白名单统计；
  写入只能形成未提交建议或经人工确认后调用正式命令。不得把 Prisma、自由 SQL、连接串、
  Token、Secret、完整 Prompt 或原始敏感字段交给模型。
- **Effect 不拥有事实**：Provider 调用属于可选 Effect，必须在核心事务外；它不拥有状态迁移、
  账本写入、发布判定或 Readiness 判定。确定性 Readiness 和手工输入是正式路径。
- **建议是可删的附属物**：若未来持久化建议，记录归可选 Assist 域所有；核心事实不得对其建
  NOT NULL 依赖，删除建议不得改变已确认的业务结果。
- **不把模块形式预设为答案**：是否注册 `AiModule`、选择 SDK 或引入向量检索，都属于真实
  产品需求出现后的单独设计与维护者授权；当前不得因本条创建任何运行时 AI 模块。

该边界由红区裁判
[`scripts/check-ai-dependency-boundary.ts`](../scripts/check-ai-dependency-boundary.ts) 执行，并由
[`src/ai-dependency-boundary.criteria.spec.ts`](../src/ai-dependency-boundary.criteria.spec.ts) 接入
既有 unit runner；对外机器入口和 Integration 授权矩阵见
[`reference/api-client-boundary.md §22`](reference/api-client-boundary.md)。
