# JWT TTL startup validation (v0.60 D review)

> Status: frozen for implementation after the maintainer approved the recommended remediation sequence on 2026-07-22.
> Base: `origin/main@f9de8eae` (`v0.60.0`).
> Sources: full-system audit P1-03 and remediation checklist item 6.

## Decisions

1. `JWT_EXPIRES_IN` and `JWT_REFRESH_EXPIRES_IN` are parsed during ConfigModule startup. A value must be an integer followed by an explicit `ms`, `s`, `m`, `h`, or `d` unit; unitless, decimal, signed, blank, non-finite, overflowed and unknown-unit values fail closed.
2. Access TTL is constrained to 1 minute through 24 hours inclusive. Refresh TTL is constrained to 1 day through 365 days inclusive.
3. The normalized access duration is stored as integer seconds for `jsonwebtoken`; the normalized refresh duration is stored as milliseconds for absolute refresh-family expiry. Runtime call sites do not parse environment strings again.
4. Login response `expiresIn` remains the validated original string, preserving the existing public DTO and client contract.
5. Refresh absolute expiry is checked for a valid `Date` both at startup and defensively when a session is created. Refresh rotation continues to inherit the original family expiry unchanged.

## DoD

- Missing, blank, zero, negative, unitless, malformed, below-minimum, above-maximum and overflowing values fail during config loading without leaking secrets.
- `1m` / `24h` access boundaries and `1d` / `365d` refresh boundaries succeed; `15m` / `90d` produce normalized `900` seconds / `7776000000` milliseconds.
- `JwtModule` signs using normalized seconds; session creation uses normalized refresh milliseconds and returns the unchanged validated access TTL string.
- Existing refresh rotation, family revoke, response DTO and JwtPayload behavior remain green.
- Focused config/auth unit tests, auth E2E, contract tests, one final full gate and CI pass.

## Write set

- `src/config/jwt.config.ts` and its unit test
- `src/modules/auth/auth.module.ts`
- `src/modules/auth/auth.service.ts` and existing auth unit fixtures/assertions
- `docs/security.md`, `docs/deployment.md`, this review and one `changelog.d/` fragment

## Forbidden / not done

- No JWT secret, payload, endpoint, DTO, BizCode, throttle, Guard, password, refresh rotation/revoke or audit-event semantic change.
- No dependency, schema/migration, workflow, deployment, merge, release or tag change.

Stop if the implementation requires changing the public login response, token payload, refresh-family absolute-expiry semantics, or any schema/endpoint/error contract.
