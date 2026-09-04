---
type: changed
scope: activities
---

Activity OS R2 B3: add governed Form blueprints with owner-only governance metadata, while keeping legacy Form payloads and public Form projections unchanged.

<!-- contract-breaking
operation: PUT /api/app/v1/my/managed-activities/{activityId}/registration-form
reason: B3 must distinguish a legacy Form definition from a governed one. governance itself remains optional so existing legacy payloads stay valid; once a caller chooses governed mode, its five metadata keys must all be required to reject partial governance and prevent silent removal of a copied governed Form.
impact: Existing legacy Form clients may continue omitting governance and retain their prior wire shape. A client editing a governed Form must send the complete governance object for every Field; a legacy-shaped non-null replacement of a governed draft is now rejected before any version or audit write.
migration: Regenerate the App client and use ManagedRegistrationFormDefinitionInputDto for governed Forms. Keep governance omitted for legacy Forms; for governed Forms send purposeCode, dataClassCode, retentionPolicyCode, maskingPolicyCode and prefillSourceCode:null on every Field. Explicit form:null remains the existing retirement command.
rollback: Before any governed Form data is written, revert this PR and retain the additive migration as inert nullable columns plus its CHECK. Do not deploy the pre-B3 binary after governed rows exist: it cannot preserve their governance hash. That case requires a separately reviewed forward-compatible rollback or a database restore; no destructive cleanup is authorized here.
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities/{activityId}/change-reviews
reason: Published-activity change review must use the same legacy/governed all-or-none Form shape as managed PUT; otherwise a legacy-shaped review payload could silently strip governance from an active Form target. The new optional governance object has five required nested keys when present.
impact: Existing reviews that omit registrationForm or submit a legacy Form remain valid. A review replacing a governed Form must send the complete governance object for every Field; a legacy-shaped non-null replacement is rejected before a new review snapshot is created.
migration: Regenerate the App client and use ManagedRegistrationFormDefinitionInputDto for registrationForm. Omit registrationForm to retain the active Form, use null for the existing retirement behavior, or send complete governance metadata on every Field when changing a governed Form.
rollback: Before any governed Form data is written, revert this PR and retain the additive migration as inert nullable columns plus its CHECK. Do not deploy the pre-B3 binary after governed rows exist: it cannot preserve their governance hash. That case requires a separately reviewed forward-compatible rollback or a database restore; no destructive cleanup is authorized here.
-->
