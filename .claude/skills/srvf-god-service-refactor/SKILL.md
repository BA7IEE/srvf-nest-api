---
name: srvf-god-service-refactor
description: Use when changing large service internals, adding service-level characterization tests, or extracting QueryService, Presenter, Policy, StateMachine, AuditRecorder, Calculator, or side-effect boundaries in srvf-nest-api.
---

# srvf-god-service-refactor

## Purpose

SRVF Nest API 项目内所有 god-service / large-service **内部边界抽离** + **service-level characterization spec 补强**的跨模块工作流。本 skill 只编排"何时触发 / 先核验什么 / 哪些不能碰 / 怎么验证 / 怎么报告",**不**替代各模块本地 CLAUDE.md 的具体业务规则(event 名 / BizCode / 状态矩阵 / 字段集等均在模块本地)。

**不**鼓励为了 LOC 而抽离;只在边界**可命名 + 有 characterization 覆盖**时才动手。

## When to use

任务涉及以下任一情况即启用:

- 修改 / 拆分核心 service:[`attendances.service.ts`](../../../src/modules/attendances/attendances.service.ts) / [`attachments.service.ts`](../../../src/modules/attachments/attachments.service.ts) / [`activity-registrations.service.ts`](../../../src/modules/activity-registrations/activity-registrations.service.ts) / [`activities.service.ts`](../../../src/modules/activities/activities.service.ts) / [`certificates.service.ts`](../../../src/modules/certificates/certificates.service.ts) / [`users.service.ts`](../../../src/modules/users/users.service.ts)
- 新增 / 调整模块内职责类:QueryService / Presenter / Policy(PolicyService) / StateMachine / AuditRecorder / Calculator / Effect(side-effect boundary)
- 补 service-level characterization spec / `*.service.spec.ts`
- 任何以"降低 service LOC / 拆 god-service"为目标的 PR

## Authority

冲突时按以下优先级:

1. 用户本轮明确指令
2. module-local `CLAUDE.md`(目标模块,例如 [`src/modules/attendances/CLAUDE.md`](../../../src/modules/attendances/CLAUDE.md))
3. [`docs/architecture-boundary.md`](../../../docs/architecture-boundary.md) — Presenter / QueryService / Policy / StateMachine / AuditRecorder / Effect 6 类边界
4. [`docs/api-surface-policy.md §7-§8`](../../../docs/api-surface-policy.md) — characterization-tests-before-refactor + 不引入 repository 抽象层
5. [`docs/current-state.md §3-§4`](../../../docs/current-state.md) — god-service 债务条目与"不主动拆"条款
6. [`docs/process.md`](../../../docs/process.md) — PR 分级 / D 档降速
7. [`docs/architecture-boundary.md`](../../../docs/architecture-boundary.md) + `AGENTS.md §2` D-7 — 同模块内职责类抽出 + decision-lock
8. [`CODEMAP.md`](../../../CODEMAP.md) — 模块体量级与 god-service 标记

规则冲突时**停止并报告**,不自行调和。

## Required first checks

先**只读**调研,不动任何文件。必须确认并记录:

- 目标 service 当前 LOC 与 [`CODEMAP.md`](../../../CODEMAP.md) 体量级标记(S / M / L / ⚠G)
- 目标模块是否有 local `CLAUDE.md`;若有,先读其 "Risk points / 不要做" 段
- 已抽离的同模块边界类(state-machine / audit-recorder / policy / calculator)与已有 e2e characterization 覆盖
- 本次任务到底是"补测试"还是"真的抽边界";若同一 PR 既补测试又抽边界 → **拆**
- 是否触碰 DTO / controller / OpenAPI snapshot / schema / audit event 名 / RBAC / data scope(任一被动 → 升档)
- 是否触发 [`AGENTS.md §2`](../../../AGENTS.md) 已有 D-series 决策锁 decision lock
- 是否需要降速成 D 档(沿 [`docs/process.md §4`](../../../docs/process.md))

## Core invariants

以下不变式**严禁弱化**;具体业务事件名 / BizCode / 状态矩阵 / 字段集查 module-local CLAUDE.md 或代码:

- **不为 LOC 而抽**;边界必须可命名为单一职责(沿 [`architecture-boundary.md §2`](../../../docs/architecture-boundary.md))
- **characterization tests 先于抽离**;无 spec 不动行为(沿 [`api-surface-policy.md §7 P1-B`](../../../docs/api-surface-policy.md))
- **每个 PR 只抽一个边界**;一次只搬一类职责
- **application service 保持 transaction owner**;`prisma.$transaction(...)` 持有权不下放,除非已有设计决议(沿 [`architecture-boundary.md §4`](../../../docs/architecture-boundary.md))
- **不引入 `*.repository.ts` 抽象层**(沿 [`api-surface-policy.md §8`](../../../docs/api-surface-policy.md))
- **不把业务逻辑塞 `common/utils/`** / `shared-services/` / 任何跨模块 grab-bag(沿 [`AGENTS.md §1` 模块结构行](../../../AGENTS.md))
- **抽离类留在 owning module**;未证明跨模块用例不外移(沿 [`architecture-boundary.md §7`](../../../docs/architecture-boundary.md))
- **不顺手改** DTO / controller / OpenAPI snapshot / BizCode / audit event 名 / state-machine 错误码
- **不顺手改** `prisma/schema.prisma` / migration / seed(归 [`srvf-prisma-change`](../srvf-prisma-change/SKILL.md))
- **不改 RBAC / data scope / `.self` ownership**(归 [`srvf-auth-security`](../srvf-auth-security/SKILL.md))
- **QueryService / Presenter 抽离必须与行为变更分离**;同 PR 既抽又改行为 → 升档 D 或拆 PR

## Risk grade

| 档 | 范围 | 用户拍板 |
|---|---|---|
| **A** | 新增 / 修改本 skill 或 module-local CLAUDE.md;docs-only | ❌ |
| **B** | 仅补 service-level characterization spec / 纯内部测试护栏;无业务代码行为变化 | ❌(常规) |
| **C** | 抽一个新边界类(StateMachine / AuditRecorder / Policy / Calculator / QueryService / Presenter)且 behavior zero drift;不改 public API / DTO / schema / audit semantic | ✅ |
| **D** | 改事务归属 / RBAC / data scope / `.self` / audit event 语义 / BizCode / schema / migration / seed;引入 repository / queue / cache / cross-module abstraction;一次拆多个边界 | ✅ + 评审稿 |

## Validation

按档位选择,不要刷全量:

- **A**:`pnpm agent:preflight`
- **B**:`pnpm agent:preflight && pnpm lint && pnpm typecheck && <相关 unit / service spec>`
- **C**:B 全部 + 相关 e2e(state-transition / audit-characterization / domain e2e);若 controller / DTO / OpenAPI 被动 → 必须加 `pnpm test:contract`
- **D**:先出设计评审稿冻结,**不**直接编码;通过后 `pnpm agent:check:full`;必要时配 ADR / docs 更新

worktree 缺 `node_modules` 或 `eslint command not found` 时:**不要** `pnpm install` / 改 lockfile;如实报告环境阻塞并继续 diff 报告。

## Output report

提交前必须列出:

- 修改文件清单
- 抽离边界(类名 / 来源 service / 行数搬移摘要)
- 行为是否 zero drift(证据:characterization spec 通过 / snapshot 无 drift)
- 新增或复用的 characterization tests
- 事务边界是否未变(`prisma.$transaction(...)` 持有者未下放)
- 权限 / audit event / DTO / OpenAPI / schema 是否未动
- 验证命令与结果
- 档位判定
- 是否建议 commit

## Hard stops

下列情况**立即停止并报告**:

- 未有 characterization tests 就拆核心 service 任何行为
- 一次 PR 同时抽多个边界(StateMachine + AuditRecorder + Policy 任两类)
- 改事务归属但无设计说明 / 评审稿
- 引入 `*.repository.ts` / 任何 repository 抽象层
- 把业务逻辑移入 `common/utils/` / `shared-services/` / 任何 grab-bag
- 改 `prisma/schema.prisma` / migration / seed
- 改 DTO 字段 / controller path / OpenAPI snapshot
- 改 audit event 名 / `extra` 语义 / BizCode 段位
- 改 RBAC `@Roles(...)` / `rbac.can()` / `.self` ownership / storage provider
- 跨模块把同模块边界挪到 shared abstraction
- 单看 service 行数就动手大拆(无 boundary naming + 无 characterization)
- 任务诉求与 [`AGENTS.md §2`](../../../AGENTS.md) 已有 D-series 决策锁 decision lock 冲突
