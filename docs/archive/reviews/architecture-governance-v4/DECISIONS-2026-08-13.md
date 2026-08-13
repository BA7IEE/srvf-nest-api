# Architecture Governance v4 — maintainer decisions (Phase 5)

> Decision date: 2026-08-13
> Decision maker: maintainer
> Scope: Phase 5 slice 5-1 (R14 authorization semantic diff) only. This record does not
> re-open the v4 blueprint, which stays frozen. It records two decisions taken while R14
> was being implemented, so that they are queryable in-repo rather than scattered across
> pull-request discussion.

| # | decision | record |
|---:|---|---|
| 1 | **R14 `engine` axis — convergence on v4's literal wording** | v4 §R14 and 终审【十一】 state that an `engine` change is *always* `INCOMPARABLE`. That rule is **narrowed** to fire only when **both sides carry a judging surface** (non-empty `codes` or `scopes`). Rationale and evidence below. |
| 2 | **Write-side hook literal-path matching — qualified as a known property, not a defect** | `.claude/hooks/bash-write-guard.sh` matches **literal paths present in the command text**; a protected path that is string-concatenated, or that lives inside the invoked program (any generator), is not intercepted locally. Qualified as an accepted property. Registration was upgraded from prose to a live selftest probe. |

## 1. `engine` axis convergence

**What v4 says.** 勘误批次七 and 终审【十一】: “**`engine` 变化恒 `INCOMPARABLE`**（rbac-global↔authz-scoped
改变『谁能通过』的判定方式——三源 scoped grant 与 GLOBAL 单轨的持有者集合互不包含，不可静态定向）”.

**What is implemented.** `engine` forces `INCOMPARABLE` only when **both** the base and head policy
have a non-empty judging surface (`codes.length > 0 || scopes.length > 0`). When either side has an
empty judging surface, the `engine` field is inert on that side and the verdict is decided by the
remaining axes (`admission`, `mode`, `codes`, `scopes`).

**Why the narrowing is sound, not a relaxation of the gate.**

- v4's own stated reason is scoped to `rbac-global ↔ authz-scoped`, i.e. to the case where two
  *different judging engines* must be compared. `engine` only ever governs how `codes`/`scopes`
  are evaluated; with no codes and no scopes there is nothing for it to govern.
- Measured on the live manifest at the time of the decision: **498/498 endpoints satisfy
  `engine === null` ⟺ `codes` empty **and** `scopes` empty**. The inert case is therefore exactly
  `PUBLIC` and `LOGIN_ONLY`, whose admitted set is fully determined by `admission` + `mode`.
- A side with an empty judging surface is a superset by construction, so the comparison reduces to
  the other axes without loss. No downgrade can hide behind the narrowing: if head drops to
  `LOGIN_ONLY`/`PUBLIC`, the `mode` axis already yields `BROADER`.

**Why the literal reading was rejected.** It would classify ordinary tightenings — most visibly
`LOGIN_ONLY → RBAC`, i.e. adding a permission requirement — as `INCOMPARABLE`, sending every such
change to Environment approval. Approval noise dilutes the signal of a genuine downgrade, and
“误伤摧毁守护可信度” is an existing recorded principle of this repository.

**Machine backing.** Both directions are pinned by positive controls in
`scripts/harness-guards.selftest.ts`:

- `R14:engine 变化(两侧均有判定面)= 不可比` — the case v4 actually describes;
- `R14:LOGIN_ONLY → RBAC(engine null→rbac-global)= 收紧,不因惰性 engine 变不可比` — the inert case.

Reverting to the literal reading is a one-line change plus flipping the second assertion.

**Status of the v4 document.** v4 stays frozen and is **not** edited. This record supersedes its
literal `engine` wording for implementation purposes; v4 remains the authority for everything else.

## 2. Write-side hook literal-path matching

**Measured behaviour** (2026-08-13, `.claude/hooks/bash-write-guard.sh`):

| command | intercepted |
|---|---|
| `echo x > AGENTS.md` | yes (exit 2) |
| `node -e "require('fs').writeFileSync('AGENTS.md','x')"` | yes (exit 2) |
| `node -e "const p='AGENTS'+'.md'; require('fs').writeFileSync(p,'x')"` | **no** (exit 0) |
| `pnpm docs:authz` / `pnpm docs:codemap` (path lives inside the generator) | **no** (exit 0) |

**Qualification.** Accepted property, not a defect. Generated artifacts must remain regenerable —
otherwise a single route-declaration change could never satisfy `docs:authz:check`. The shape is
the same as the already-registered ESLint bypasses (variable forwarding, computed properties): this
layer is **literal interception**, not data-flow enforcement.

**Residual protection is unchanged.** CI-side `check-redzone` reports the touched protected paths
from the diff, and the base-trusted judge requires `harness-review` Environment approval. Measured
the same day on probe PR #991: modifying `docs/ai-harness/ROUTE_AUTHZ.md` raised
`architecture-governance-phase0-artifacts` and held the PR for approval. The local gate relies on
AI self-restraint; **the human gate in CI still holds.**

**Registration.** Recorded as known gap `WRITE-GUARD-LITERAL-ONLY` in
`scripts/harness-guards.selftest.ts`, backed by live probes and printed on every selftest run. If
the gap is ever closed, the probes flip and the selftest turns red until the registration is
removed — closure cannot be silently forgotten.

## R14 real-trigger verification (2026-08-13)

Required by the maintainer before proceeding past slice 5-1. Two throwaway draft PRs, both closed
without merging.

| probe | change | result |
|---|---|---|
| [#990](https://github.com/BA7IEE/srvf-nest-api/pull/990) phase 1 | `GET /api/admin/v1/me`: `@LoginOnly` → `@Public()`, no declaration | `Red-zone trusted scan` **failed**; `Red-zone trusted approval` **skipped** — no approval button exists, so the hard failure cannot be approved away |
| [#990](https://github.com/BA7IEE/srvf-nest-api/pull/990) phase 2 | same, plus an `authz-downgrade` declaration | scan **passed**, approval **pending** — declaration completeness and approval are two separate gates, in that order |
| [#991](https://github.com/BA7IEE/srvf-nest-api/pull/991) | `GET /api/open/v1/contents`: `@Public()` → `@LoginOnly` | `authzRequired=false`, no blocking finding, `[NARROWER]` present in the full migration list |

Note recorded from #991: because `docs/ai-harness/ROUTE_AUTHZ.md` is itself inside `selfGuard`, **any**
declaration change already triggers red-zone approval. R14's marginal contribution is therefore not
"triggers approval" but: classifying the change as up/flat/down, **requiring a declaration for
downgrades**, and **hard-failing when that declaration is missing** — the last of which approval
cannot override.
