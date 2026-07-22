# OpenAPI / HTTP success parity (v0.60 D review)

> Status: frozen for implementation after the maintainer approved the recommended remediation sequence on 2026-07-22.
> Base: `origin/main@f9de8eae` (`v0.60.0`, 366 operations).
> Sources: full-system audit P1-02 and remediation checklist item 5.

## Decisions

1. Every documented success response status must equal Nest's effective handler status: explicit `@HttpCode()` wins; otherwise POST defaults to 201 and other supported methods default to 200.
2. A POST that creates a durable resource keeps its current 201 runtime behavior and uses a new `ApiWrappedCreatedResponse`. A command/action/query POST uses explicit `@HttpCode(HttpStatus.OK)` and keeps `ApiWrappedOkResponse`. Existing explicit 200/204 handlers do not drift.
3. Four system settings GET endpoints document `data` as `Dto | null` through a new `ApiWrappedNullableResponse`; update/reset responses remain non-null.
4. Contract tests discover controller handler metadata and compare all 366 OpenAPI operations mechanically. A hand-maintained nullable-route allowlist locks the four settings GET schemas.
5. Snapshot changes are limited to explained success response-key moves (`200`/`201`) and nullable `data` schema changes. Route, DTO field, error response, operation summary and component-schema drift are forbidden.

## DoD

- `ApiWrappedCreatedResponse` emits the standard envelope at HTTP 201; `ApiWrappedNullableResponse` emits the standard 200 envelope whose `data` permits either the DTO or null.
- Every one of 366 operations has exactly the effective success response key derived from controller metadata.
- Storage, SMS, WeChat and realname settings GET success `data` is nullable; the allowlist has no missing or extra route.
- Representative runtime E2E confirms a create POST remains 201 and a command POST explicitly returns 200.
- Contract snapshot diff is reviewed line by line; lint/typecheck, affected E2E, one final full gate and CI pass.

## Write set

- `src/common/decorators/api-response.decorator.ts`
- only controller imports/decorators/`@HttpCode` lines identified by the parity probe
- the four settings controllers
- `test/contract/openapi.contract-spec.ts` and its snapshot
- focused existing E2E assertions needed to lock intentional 200/201 behavior
- active Swagger documentation, this review and one `changelog.d/` fragment

## Forbidden / not done

- No route, DTO field, BizCode, response envelope, service, persistence, auth, permission, audit-event, schema/migration or dependency change.
- No blind snapshot update; any route/component/unrelated schema drift stops the lane.
- No merge, release, tag, deploy or SDK publication.

Stop if parity requires changing business data, a public DTO/route/error contract, or if the generated snapshot contains anything outside the enumerated success status/nullable deltas.
