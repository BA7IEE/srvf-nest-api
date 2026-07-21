# Attachment Storage Consistency Phase 1 Rollout

This runbook covers only the `Attachment` key namespace introduced by migration
`20260718233000_attachment_storage_operations`.

## Delivered boundary

- PostgreSQL stores a durable `StorageObject` plus `StorageObjectOperation` intent/effect ledger.
- Provider locator is pinned per object and contains no credentials, token, or signed URL.
- A dedicated worker process performs reconciliation; this phase adds no cron and no queue. The
  continuous worker and `--once` never purge delete replay payloads.
- Runtime progresses from `JIT` to `STRICT`. Reads, signing, confirmation, and deletion fail closed
  when the ledger or Provider evidence is uncertain.
- In `JIT` only, a `backfill/provider_unknown` row with no pinned locator may use the current
  COS/LOCAL locator as a one-HEAD candidate (`providerType=LOCAL` hints remain LOCAL-only). The
  candidate is never persisted before positive evidence; successful validation pins it in the
  same promotion transaction. `STRICT` never uses this fallback.
- A 404/absent result demotes a `legacy_unverified` candidate to `provider_unknown` and discards
  its unverified locator so a later JIT attempt can try the then-current candidate. Timeout, 403,
  credential/signing failure only record error evidence and preserve the prior state and locator.
- A deterministic size/ETag conflict on an `available` object CAS-transitions it to
  `integrity_mismatch`. Both metadata and signing then fail closed; no automatic delete or absent
  attestation is allowed. Recovery requires the reviewed manual-relocate path.
- Manual relocate always verifies size at the target pinned locator. When a trusted stored
  SHA-256 exists, the worker hashes the target incrementally (bounded chunks, including objects up
  to the existing 5GB limit), renews its lease during the read, and requires an exact digest match;
  that content digest takes precedence over an ETag that legitimately changed during a reviewed
  cross-locator copy. Without a checksum it requires the stored and target ETags to match. If both
  trusted checksum and stored ETag are absent, Phase 1 remains fail-closed and the command cannot
  claim recovery from size-only evidence.
- Delete response snapshots are logically usable for 24 hours. Operations must run the explicit
  manual purge command daily; an unpurged snapshot older than 48 hours blocks the rollout gate.
- Manual relocate/absent attestation accepts only an internal ticket reference and requires two
  distinct people (`operatorUserId` and `reviewerUserId`).

PostgreSQL and COS/LOCAL are not one atomic transaction. A committed intent, fenced lease, HEAD
evidence, retry, and terminal reconciliation provide eventual consistency; this document does not
claim cross-system atomicity or storage closure outside `Attachment`.

## Content live boundary

The Content admin wrapper participates in the Attachment ledger lifecycle without moving Provider
Effects into a business transaction:

- publish locks and rereads the `Content` root first, validates the current body/cover Attachment
  bindings and their ledger state, cancels only safe unbound upload intents, then commits the
  `draft -> published` transition and audit in the same transaction;
- the Content confirm route validates route/token ownership before Content or ledger work; both it
  and the generic Attachment confirm route prepare under one short root-locked transaction,
  perform Provider HEAD/prefix evidence outside transactions, then lock and reread the root again
  before binding a content-owned Attachment and audit in a second transaction;
- publish winning between the two confirm transactions leaves the durable reclaim intent in place
  and rejects final binding with the existing Content transition error. Confirm winning makes
  publish wait and observe the committed available binding.

This is an at-publication storage-consistency boundary, not full published-Content immutability.
Post-publish editing, cover mutation, and Attachment deletion remain outside this slice and require
their own reviewed lifecycle decision.

## Phase 1 expand limitation

This migration intentionally does **not** add an `attachments.key -> storage_objects.key` foreign
key. During the expand/rollback window, an old binary or a DB-direct writer can therefore insert an
`Attachment` without a ledger row. The new binary detects or JIT-creates that row and fails closed,
but Phase 1 is not a database-enforced invariant for old writers.

Accordingly, the Phase 1 PR/DoD must say “new-binary fail-closed Attachment consistency”, not
“all writers”, “database FK complete”, “cross-PG/Provider atomic”, or “full-repository storage
consistency”.

## JIT to STRICT gate

Keep the service in `JIT` until all of the following are true:

1. All application writers run the new binary; old writers are drained, and the rollback decision
   no longer requires them.
2. The dedicated worker is healthy. Every Attachment has exactly one same-key object whose
   `resourceType/resourceId` points back to that Attachment; a key-only join is insufficient.
3. Every Attachment object is `available`, except a `delete_pending/delete_failed` row backed by a
   real active `attachment_delete`. Every `available` object points to the same-id/same-key
   Attachment. `legacy_unverified`, `provider_unknown`, `missing`, and `integrity_mismatch` object
   counts are zero.
4. No `backfill_verify` operation is active, and no dead backfill remains attached to an unsafe
   object state.
5. The daily replay purge has run; no unpurged delete response snapshot is older than 48 hours.
6. The gate command succeeds against the intended environment, then the service is restarted with
   `STORAGE_CONSISTENCY_MODE=STRICT`.

The HTTP service runs this gate automatically before production `STRICT` startup. The dedicated
worker does not auto-run it, because purge/manual recovery must remain startable while unsafe rows
exist; use its explicit `--strict-gate` mode when checking rollout readiness. The gate is read-only.
Replay purge is a separately scheduled daily manual SOP, never worker-loop maintenance. Never use
`migrate dev`, `migrate reset`, `db push`, or a default/production database for validation.

## Deferred contract migration

After the STRICT observation window is green and rollback to an old writer is closed, open a
separate reviewed contract migration that:

1. proves `attachments.key` has exactly one matching `storage_objects.key` row;
2. proves every matching object is in a contract-allowed state;
3. adds and validates the `Attachment.key -> StorageObject.key` `RESTRICT` foreign key; and
4. re-runs the STRICT gates before and after deploy.

That follow-up is deliberately not hidden in the Phase 1 migration. Adding the FK in this PR would
change the zero-downtime/rollback plan and requires a new rollout review.

## Operator commands

Run these only in the explicitly selected environment:

```sh
node dist/storage-consistency-worker --strict-gate
# Run once daily from the manual retention SOP; the resident worker never invokes this mode.
node dist/storage-consistency-worker --purge-replays
node dist/storage-consistency-worker --once
```

Manual recovery additionally requires `--operator-user-id`, `--reviewer-user-id`,
`--evidence-ref=<INTERNAL-TICKET>`, and the operation-specific arguments. The operator and reviewer
must differ. The provider stream returns only byte count/SHA-256/ETag evidence; object bytes, signed
URLs, and credentials are never persisted in PostgreSQL or emitted by the worker command.
