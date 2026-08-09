# Architecture Governance v4 — maintainer decisions

> Decision date: 2026-08-10
> Decision maker: maintainer
> Scope: Phase 0 closeout and the first A-class metadata bootstrap only. This record does not authorize Phase 1 runtime work.

| # | decision | record |
|---:|---|---|
| 1 | Domain map | Confirm `identity-org` and `participation`, including all observed subdomains. Confirm `auth` as `identity-org.accounts` and `ai` as `platform-core`. Confirm the `kernelReadFields` and `kernelPredicateFields` proposals. The unresolved allowed-edge and public-surface declaration remains pending. |
| 2 | Route policy status | All 128 legacy `[auth]` entries are decided. The classification overlay remains the Phase 0 truth source until Phase 1A transfers the truth source to decorators. |
| 3 | Admin activity read surface | The five ordinary admin activity read endpoints use `LOGIN_SCOPED('activity-visibility')`. |
| 4 | Participation read surfaces | Reconciliation, activity participation summary, and participation overview use `RBAC`, `require: all`, `engine: authz-scoped`, with `attendance.read.sheet` and `activity-registration.read.record`. |
| 5 | Content attachment confirmation | Use `RBAC`, one logical `attachment.upload.content-*` code family, and `engine: rbac-global`. The current handler selects `content-image` or `content-file` from the upload-token owner type; Phase 1 must expand the decorator literal from that implementation evidence rather than invent a code. |
| 6 | Other admin/auth/system entries | The remaining ten entries retain their registered provisional semantics as the approved Phase 0 policy. |
| 7 | App policy | All 109 App entries require `app-member`. `Me`/`My*`/Notifications/registration flows use `self`; the six managed families use `responsibility`; Activities and Content catalogues use `visibility`; existing code-bearing families remain registered. |
| 8 | C7 external I/O scope | C7 covers durable business-touching external side effects. Verification SMS, COS I/O, OAuth/WeChat exchange, and OCR are sync-integration exemptions. Existing notification outbox delivery is the sole route for WeChat, WeCom, birthday SMS, and admin SMS. |
| 9 | D7 lock addendum | The D7 lock addendum is approved. The corresponding AGENTS body edit is reserved for the Phase 1 first-slice write set. |
| 10 | Sensitive authorization approval | Reuse the `harness-review` Environment: one approver and no bypass. A fragment records a change but is never an approval. |
| 11 | Authorization implication graph | Initial edge set is empty; no path is treated conservatively as incomparable. |
| 12 | Long-term governance and lanes | R6 stays permanent report-only. W4 remains certificate-backed long-term debt. Lane hard gates and each rule's Exit checklist follow v4. |

## Phase 0 boundary

- No `src/**`, Prisma, migration, or test-behavior change is authorized by these decisions.
- A-class bootstrap is limited to the existing Fast checks job: metadata freshness/completeness blocks; B-class violation scans remain report-only.
