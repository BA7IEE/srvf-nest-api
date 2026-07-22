# HTTP query log redaction (v0.60 D review)

> Status: frozen after the maintainer approved the recommended remediation sequence on 2026-07-22.
> Base: `origin/main@f9de8eae` (`v0.60.0`).
> Source: full-system audit P1-01 and remediation checklist item 4.

## Decisions

1. The automatic pino request serializer emits only `method` and URL pathname. It never emits query objects, `originalUrl`, raw request-target or request headers.
2. Existing completion facts remain: response status, response time, request ID and authenticated user ID.
3. The test uses a real `pino-http` middleware and Node HTTP request, then asserts captured serialized output. Static option assertions alone are insufficient.
4. No ingress manifest/config exists in this repository. Active deployment guidance requires pathname-only access logs (`$uri`) and forbids `$request_uri`, `$request`, query variables and raw upstream URL. Applying that setting to the real ingress is an external deployment action.

## DoD

- A request containing phone, email and name-like search values emits none of those values or the complete query string.
- The captured completion log contains method, pathname, status, responseTime, reqId and userId.
- Existing redact list, client-IP redaction and request-id behavior remain green.
- Focused unit, request-id E2E, contract, one final full gate and CI pass.

## Write set

- `src/bootstrap/logger-options.ts`
- `src/bootstrap/logger-options.spec.ts`
- `docs/security.md`, `docs/deployment.md`
- this review and one `changelog.d/` fragment

## Forbidden / not done

- No controller, DTO, endpoint, auth, guard, schema/migration, audit event or logger retention change.
- No request-body logging and no query-value hashing.
- No external ingress mutation, deploy, merge, release or tag.

Stop if preserving required log facts needs a global middleware/interceptor change or if an in-repository ingress asset is discovered outside this write set.
