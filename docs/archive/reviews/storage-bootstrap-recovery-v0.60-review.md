# Storage bootstrap / recovery closure (v0.60 D review)

> Status: frozen for implementation after the maintainer approved the recommended remediation sequence on 2026-07-22.
> Base: `origin/main@f9de8eae` (`v0.60.0`).
> Sources: `srvf-nest-api-v0.60.0-full-system-audit-2026-07-22.md` P0-01, P0-02, P1-04, P1-05 and `srvf-nest-api-v0.60.1-backend-remediation-checklist.md` items 2, 3, 7.

## 1. Decisions

1. The offline bootstrap owns a narrow configuration boundary. It parses only `APP_ENV` and `STORAGE_ENCRYPTION_KEY`; unrelated HTTP, CORS, insurance, SMS, WeChat, realname and consistency settings are not prerequisites.
2. Bootstrap continues to instantiate the existing `StorageCryptoService`. The AES-256-GCM format, fixed salt and scrypt parameters do not change; `storage-crypto.service.ts` is outside the write set.
3. Production startup invariants are: the singleton exists, provider is COS, bucket and region are non-empty, and credentials decrypt with the current key. `enabled=false` is allowed and emits a warning.
4. `enabled=false` remains a fail-closed kill switch for every ordinary pinned and non-pinned provider effect. API and worker control planes may start; explicitly reviewed manual maintenance keeps its existing bypass.
5. In production, a missing settings row or any non-COS/unknown provider value fails closed at routing time. Local fallback remains development/test/smoke-only.
6. Until every raw-key namespace has a pinned locator, an existing production singleton's `providerType`, `bucket`, and `region` are immutable through ordinary PATCH. Same-value PATCH, `enabled`, TTLs, remarks and credentials at the same location remain supported. Relocation remains a separate reviewed worker flow.
7. Docker smoke runs the real production chain: migrate, seed, narrow bootstrap, image boot with `APP_ENV=production`, readiness and login. Ephemeral credentials are masked and never printed.

## 2. Definition of done

- A genuinely clean production bootstrap subprocess succeeds with only `APP_ENV`, `STORAGE_ENCRYPTION_KEY` and the config-file database URL; dry-run is zero-write, create persists one verified row, and missing/short key or invalid environment fails fast without secret/URL leakage.
- Production application bootstrap succeeds for a valid disabled singleton and logs WARN; invalid location/provider/credentials still prevents startup.
- Unit/E2E evidence proves disabled ordinary effects make zero provider calls, while maintenance pinned effects remain reachable.
- Production null/LOCAL/unknown routing makes zero Local/COS calls and raises the existing unavailable/locator errors; non-production fallback remains unchanged.
- Production ordinary PATCH cannot change provider/bucket/region and rolls back audit; same location and non-location updates remain valid.
- Docker smoke workflow executes the production bootstrap before starting the container and boots with the same key.
- Focused tests, affected Storage/Attachment E2E, contract tests, one final `pnpm agent:check:full`, Docker image/smoke where locally available, and CI are green.

## 3. Probe queue

1. Bootstrap unit/E2E, including clean child environment and leak assertions.
2. Storage settings lifecycle/invariant unit and E2E.
3. Router ordinary and pinned effect matrix.
4. Storage consistency worker CLI/unit and attachment storage consistency E2E.
5. Contract snapshot (expected zero route/schema drift).
6. Production Docker smoke.

## 4. Authorized write set

- `src/config/app.config.ts`
- `src/modules/storage/storage-settings-bootstrap.ts`
- `src/modules/storage/storage-settings.service.ts`
- `src/modules/storage/storage-provider.router.ts`
- their existing unit/E2E tests under `src/modules/storage/**` and `test/e2e/storage-settings*`
- `.github/workflows/docker-smoke.yml`
- active Storage/security/deployment/ops documentation and `src/modules/storage/CLAUDE.md`
- this frozen review and one `changelog.d/` fragment

## 5. Forbidden domains

- `prisma/schema.prisma`, migrations, seed semantics and production database mutation
- `src/modules/storage/storage-crypto.service.ts` and all encryption/salt/ciphertext-format changes
- endpoint paths, DTO fields, BizCodes, permissions, guards and audit event names
- raw-key consumer migration, recruitment durable ledger, automatic relocation, COS network calls
- merge, release, tag and deploy

## 6. Stop rules

Stop and report if implementation needs a schema/migration, encryption-format change, new endpoint/DTO/BizCode/permission, provider SDK behavior change, or if existing tests reveal a behavior conflict outside the decisions above.
