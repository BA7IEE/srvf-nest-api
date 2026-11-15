# App detail zero-rule lock correction

Scope: fix unnecessary member qualification fact locks when no validated rule sets apply. User authorized continuing SRVF repairs and testing; candidate only, no merge or deployment.

DoD: preserve rule/target validation and output projections; existing rule lock semantics stay unchanged; prove no-rule HTTP under an actual SELECT-only DB role, lock denial negative control, and active-rule failure plus owner positive control. Retain no-rule no-snapshot behavior.

Probes: evaluator/member-facts unit; activities regression; new isolated PostgreSQL HTTP suite; existing CI full checks. Local PostgreSQL unavailable. Expanded affected-module run 3986 passed, one unchanged-main-reproduced CLI subprocess failure, four TODO. No claim of all-green or deployed verification.

Write set: evaluator and unit spec; new activity-detail-no-rule-read-role E2E; CODEMAP generated refresh; this plan and changelog fragment. No workflow/schema/migration/runtime configuration, no permissions in existing databases, no g-series access, no ToMe changes, no external notification.

Test role is generated per suite, NOLOGIN, SELECT only in CI worker DB. Every restricted connection must prove current_user; existing owner is used only for setup/login and an explicitly labeled positive control. Reader closes before revocation/drop. This is not a production ACL recommendation. Candidate PR stacks on fa476663 and excludes separate waitlist patch.
