import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { R5ObservedAttempt } from './r5-setmat-concurrency-barrier';
import type { R5SetmatOwnedConfig } from './r5-setmat-owned-fixture';
import { R5_AUXILIARY_SNAPSHOT120_POLICY } from './r5-setmat-manifest';
import { R5_FULL_CHAIN_SOURCE, R5_PREPARED240_PUBLICATION } from './r5-human-correction-full-chain';
import { capacityTerminalReceipt } from './r5-setmat-capacity.measurement';
import { assertR5PreparedPublicationApproval } from './r5-human-correction-prepared-source';
import {
  assertR5OriginalJobRetryApproval,
  type R5OriginalJobRetryApproval,
} from './r5-human-correction-original-job';
import {
  assertR5RetainedContinuation,
  type R5RetainedContinuation,
} from './r5-human-correction-retained-source';
import {
  R5_ASYNC_INSTALLED_IDENTITIES,
  type R5AsyncRuntimeManifest,
} from './r5-human-correction-async-runtime';

export const R5_ASYNC_ENTRY = 'test/e2e/activity-os-r5-human-correction-background.e2e-spec.ts';
export const R5_ASYNC_CAPACITY1000_ENTRY =
  'test/e2e/activity-os-r5-human-correction-background-capacity1000.e2e-spec.ts';
export const R5_ASYNC_BOOTSTRAPS: readonly string[] = Object.freeze([
  R5_ASYNC_ENTRY,
  R5_ASYNC_CAPACITY1000_ENTRY,
]);

export const R5_ASYNC_SCOPE = Object.freeze({
  schema: 'srvf-r5-human-async-smoke/v1',
  approvalScope: 'one-fresh-v3-async-real-commit',
  database: 'app_test_r5_setmat_20261029_q1',
  databaseOid: 1998913,
  cluster: '7695840193603043362',
  serverVersion: '160015',
  caller: 'r5_boundary_caller_h7c6',
  callerOid: 1789091,
  gitBase: '63711eb714713f208729065aaff57de2800b968a',
  phaseMs: 600_000,
  campaignMs: 1_800_000,
  nativeMs: 15_000,
  oracleEvaluations: 4,
  freshFixtures: 1,
  workerRounds: 1,
  nativeAttempts: 1,
  realLogins: 4,
  backendPolicy: 'STRICT_ALL',
  supplementaryTables: [
    'ActivityBatchJob',
    'ActivityBatchJobItem',
    'ActivityInvitation',
    'ActivitySession',
  ],
});
export const R5_ASYNC_CAPACITY1000_UNITS = Object.freeze({
  sourceCount: 10000,
  delta: 1000,
  bindingCount: 10000,
  sliceCount: 50000,
  identities: 2000,
  oracleEvaluations: 8000,
});
export const R5_ASYNC_CAPACITY1000_SCOPE = Object.freeze({
  ...R5_ASYNC_SCOPE,
  schema: 'srvf-r5-human-async-capacity1000/v1',
  approvalScope: 'one-fresh-n10000-d1000-async-real-commit',
  oracleEvaluations: 8000,
});
export const R5_ASYNC_RETAINED_CAPACITY1000_SCOPE = Object.freeze({
  ...R5_ASYNC_CAPACITY1000_SCOPE,
  schema: 'srvf-r5-human-async-retained-capacity1000/v1',
  approvalScope: 'one-retained-n10000-d1000-async-real-commit',
});
export const R5_ASYNC_PREPARED_CAPACITY1000_SCOPE = Object.freeze({
  ...R5_ASYNC_CAPACITY1000_SCOPE,
  schema: 'srvf-r5-human-async-prepared-capacity1000/v1',
  approvalScope: 'one-prepared-n10000-d1000-async-real-commit',
});
export const R5_ASYNC_ORIGINAL_JOB_RETRY_SCOPE = Object.freeze({
  ...R5_ASYNC_CAPACITY1000_SCOPE,
  schema: 'srvf-r5-human-async-original-job-retry1000/v1',
  approvalScope: 'one-original-job-n10000-d1000-explicit-retry',
});
export const R5_ASYNC_FIRST_LAUNCH_SCOPE = Object.freeze({
  ...R5_ASYNC_ORIGINAL_JOB_RETRY_SCOPE,
  schema: 'srvf-r5-first-launch-background60/v1',
  approvalScope: 'one-first-launch-background60-original-job-retry',
  nativeMs: 60_000,
});
export const R5_FIRST_LAUNCH_POLICY = Object.freeze({
  approvalReference: 'Sentinel_d5c4234356648191a1cdbc58c1a9c752',
  commitMs: 60_000,
  prepareCandidateMs: 240_000,
  minChangedSegments: 1000,
  prepareEnabledThisStage: false,
  attempts: 1,
  delta10000: 'DEFERRED_FROM_FIRST_LAUNCH',
});
export const R5_ASYNC_FULL_CHAIN_SCOPE = Object.freeze({
  ...R5_ASYNC_CAPACITY1000_SCOPE,
  schema: 'srvf-r5-first-launch-full-chain240-60/v1',
  approvalScope: 'one-new-request-full-chain-prepare240-background60',
  nativeMs: 60_000,
});
export const R5_FULL_CHAIN_POLICY = Object.freeze({
  ...R5_FIRST_LAUNCH_POLICY,
  prepareEnabledThisStage: true,
});
export const R5_ASYNC_PREPARED240_SCOPE = Object.freeze({
  ...R5_ASYNC_CAPACITY1000_SCOPE,
  schema: 'srvf-r5-prepared240-publication60/v1',
  approvalScope: 'one-committed-prepare240-publication60',
  nativeMs: 60000,
});
export const R5_SNAPSHOT120_PUBLICATION_RESERVES = Object.freeze({
  entry: 540000,
  baseline: 450000,
  accept: 330000,
  worker: 300000,
  finalSnapshot: 210000,
});
export type R5AsyncExecutionScope =
  | typeof R5_ASYNC_SCOPE
  | typeof R5_ASYNC_CAPACITY1000_SCOPE
  | typeof R5_ASYNC_RETAINED_CAPACITY1000_SCOPE
  | typeof R5_ASYNC_PREPARED_CAPACITY1000_SCOPE
  | typeof R5_ASYNC_ORIGINAL_JOB_RETRY_SCOPE
  | typeof R5_ASYNC_FIRST_LAUNCH_SCOPE
  | typeof R5_ASYNC_FULL_CHAIN_SCOPE
  | typeof R5_ASYNC_PREPARED240_SCOPE;
// Keep identity checks against frozen entry constants, not caller-created objects.
function assertExecutionScope(scope: R5AsyncExecutionScope) {
  assert(
    scope === R5_ASYNC_SCOPE ||
      scope === R5_ASYNC_CAPACITY1000_SCOPE ||
      scope === R5_ASYNC_RETAINED_CAPACITY1000_SCOPE ||
      scope === R5_ASYNC_PREPARED_CAPACITY1000_SCOPE ||
      scope === R5_ASYNC_ORIGINAL_JOB_RETRY_SCOPE ||
      scope === R5_ASYNC_FIRST_LAUNCH_SCOPE ||
      scope === R5_ASYNC_FULL_CHAIN_SCOPE ||
      scope === R5_ASYNC_PREPARED240_SCOPE,
    'execution scope must be a frozen entry-point constant',
  );
}
export const R5_ASYNC_ITEM_COLUMNS = Object.freeze([
  'id',
  'createdAt',
  'updatedAt',
  'jobId',
  'itemKey',
  'statusCode',
  'attempts',
  'lastErrorCode',
  'safeMessage',
  'resourceType',
  'resourceId',
  'payloadHash',
  'resultReference',
]);
export const R5_ASYNC_ITEM_INSERT = Object.freeze(
  R5_ASYNC_ITEM_COLUMNS.filter((x) => !['lastErrorCode', 'safeMessage'].includes(x)),
);
export const R5_ASYNC_ITEM_UPDATE = Object.freeze([
  'updatedAt',
  'statusCode',
  'attempts',
  'lastErrorCode',
  'safeMessage',
  'resultReference',
]);
export interface R5AsyncManifest {
  schema: R5AsyncExecutionScope['schema'];
  capacity?: typeof R5_ASYNC_CAPACITY1000_UNITS;
  continuation?: R5RetainedContinuation;
  originalJobRetry?: R5OriginalJobRetryApproval;
  firstLaunchCandidate?: typeof R5_FIRST_LAUNCH_POLICY | typeof R5_FULL_CHAIN_POLICY;
  fullChainSource?: typeof R5_FULL_CHAIN_SOURCE;
  prepared240?: typeof R5_PREPARED240_PUBLICATION;
  auxiliarySnapshot?: typeof R5_AUXILIARY_SNAPSHOT120_POLICY;
  checkout: string;
  sourceBinding: { path: string; sha256: string };
  base: R5SetmatOwnedConfig;
  supplemental: {
    querySha256: string;
    expectedPath: string;
    expectedSha256: string;
    origin: 'OFFLINE_SOURCE_REVIEWED';
    sourceReviewReference: string;
    permissionApprovalReference: string;
    installedBindingReference: string;
  };
  approval: {
    approved: boolean;
    scope: R5AsyncExecutionScope['approvalScope'];
    reference: string | null;
    phaseId: string;
    phaseStartedAt: string;
    phaseDeadline: string;
    campaignStartedAt: string;
    campaignDeadline: string;
    originalFailuresPreserved: true;
  };
  outputDirectory: string;
  /** An already running original-owner watchdog; this is NOT an authorization. */
  control: { pid: number; receiptPath: string; receiptSha256: string };
  runtime?: R5AsyncRuntimeManifest;
}
export function assertR5AsyncRuntimeManifest(m: R5AsyncManifest) {
  const r = m.runtime;
  assert(r, 'real P/U memory runtime binding is absent');
  assert.equal(r.installationReceiptSha256, R5_ASYNC_INSTALLED_IDENTITIES.sha256);
  assert.equal(r.installationState, 'INSTALLED_INACTIVE');
  assert.equal(r.runtimeRequirement, 'FRESH_STAGE_LOGIN_AND_LIVE_QUALIFICATION');
  assert.equal(r.credentialsFd, 3);
  assert(isAbsolute(r.installedConnectionPath));
  assert(/^[a-f0-9]{64}$/.test(r.installedConnectionSha256));
  return r;
}
export function r5AsyncHash(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}
export function assertR5AsyncWindow(
  m: R5AsyncManifest,
  now: number,
  reserveMs = 5_000,
  scope: R5AsyncExecutionScope = R5_ASYNC_SCOPE,
) {
  assertExecutionScope(scope);
  const a = m.approval;
  assert.equal(a.approved, true, 'new async real-COMMIT stage is not approved');
  assert.equal(a.scope, scope.approvalScope);
  assert(typeof a.reference === 'string' && a.reference.trim().length > 0);
  assert(typeof a.phaseId === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(a.phaseId));
  assert.equal(a.originalFailuresPreserved, true);
  const [start, end, campaignStart, campaignEnd] = [
    a.phaseStartedAt,
    a.phaseDeadline,
    a.campaignStartedAt,
    a.campaignDeadline,
  ].map(Date.parse);
  assert([start, end, campaignStart, campaignEnd, now, reserveMs].every(Number.isFinite));
  assert(reserveMs >= 0 && end > start && end - start <= R5_ASYNC_SCOPE.phaseMs);
  assert(campaignEnd > campaignStart && campaignEnd - campaignStart <= R5_ASYNC_SCOPE.campaignMs);
  assert(start >= campaignStart && end <= campaignEnd);
  assert(
    now >= start && now + reserveMs < end && now + reserveMs < campaignEnd,
    'closed or exhausted phase/campaign; old clock is never reset',
  );
}
export function assertR5AsyncManifest(
  m: R5AsyncManifest,
  now: number,
  scope: R5AsyncExecutionScope = R5_ASYNC_SCOPE,
) {
  assertExecutionScope(scope);
  assert.equal(m.schema, scope.schema);
  assertR5AsyncWindow(
    m,
    now,
    scope === R5_ASYNC_FULL_CHAIN_SCOPE
      ? 360_000
      : scope === R5_ASYNC_PREPARED240_SCOPE
        ? R5_SNAPSHOT120_PUBLICATION_RESERVES.entry
        : 125_000,
    scope,
  );
  if (scope !== R5_ASYNC_SCOPE)
    assert.deepEqual(m.capacity, R5_ASYNC_CAPACITY1000_UNITS, 'fixed full-root/delta units differ');
  else assert.equal(m.capacity, undefined, 'one-person entry does not accept capacity inputs');
  if (
    scope === R5_ASYNC_RETAINED_CAPACITY1000_SCOPE ||
    scope === R5_ASYNC_PREPARED_CAPACITY1000_SCOPE ||
    scope === R5_ASYNC_ORIGINAL_JOB_RETRY_SCOPE ||
    scope === R5_ASYNC_FIRST_LAUNCH_SCOPE
  )
    assertR5RetainedContinuation(m.continuation, m.approval);
  else assert.equal(m.continuation, undefined, 'fresh entry cannot silently reuse retained input');
  if (
    scope === R5_ASYNC_PREPARED_CAPACITY1000_SCOPE ||
    scope === R5_ASYNC_ORIGINAL_JOB_RETRY_SCOPE ||
    scope === R5_ASYNC_FIRST_LAUNCH_SCOPE
  )
    assertR5PreparedPublicationApproval(
      m.continuation?.preparedPublication,
      m.approval.campaignStartedAt,
      m.continuation?.independentStageApprovalReference ?? null,
      m.approval.phaseId,
    );
  else
    assert.equal(
      m.continuation?.preparedPublication,
      undefined,
      'prepared state requires its publication-only entry',
    );
  if (scope === R5_ASYNC_ORIGINAL_JOB_RETRY_SCOPE || scope === R5_ASYNC_FIRST_LAUNCH_SCOPE)
    assertR5OriginalJobRetryApproval(
      m.originalJobRetry,
      m.approval.phaseId,
      m.approval.campaignStartedAt,
      m.approval.reference,
    );
  else
    assert.equal(m.originalJobRetry, undefined, 'original job requires its explicit retry entry');
  if (
    scope === R5_ASYNC_FIRST_LAUNCH_SCOPE ||
    scope === R5_ASYNC_FULL_CHAIN_SCOPE ||
    scope === R5_ASYNC_PREPARED240_SCOPE
  ) {
    assert.deepEqual(
      m.firstLaunchCandidate,
      scope === R5_ASYNC_FULL_CHAIN_SCOPE ? R5_FULL_CHAIN_POLICY : R5_FIRST_LAUNCH_POLICY,
    );
    assert.equal(m.approval.reference, R5_FIRST_LAUNCH_POLICY.approvalReference);
  } else
    assert.equal(
      m.firstLaunchCandidate,
      undefined,
      'first-launch budget requires its frozen entry',
    );
  if (scope === R5_ASYNC_PREPARED240_SCOPE) {
    assert.deepEqual(m.auxiliarySnapshot, R5_AUXILIARY_SNAPSHOT120_POLICY);
    assert.deepEqual(m.prepared240, R5_PREPARED240_PUBLICATION);
    assert.notEqual(m.approval.phaseId, R5_PREPARED240_PUBLICATION.closedPhaseId);
    assert(
      Date.parse(m.approval.campaignStartedAt) >=
        Date.parse(R5_PREPARED240_PUBLICATION.campaignDeadline),
    );
  } else {
    assert.equal(m.auxiliarySnapshot, undefined, 'auxiliary120 requires prepared240 scope');
    assert.equal(
      m.prepared240,
      undefined,
      'prepare240 recovery requires its publication-only scope',
    );
  }
  if (scope === R5_ASYNC_FULL_CHAIN_SCOPE) {
    assert.deepEqual(m.fullChainSource, R5_FULL_CHAIN_SOURCE);
    assert(
      Date.parse(m.approval.campaignStartedAt) >= Date.parse(R5_FULL_CHAIN_SOURCE.campaignDeadline),
    );
  } else
    assert.equal(
      m.fullChainSource,
      undefined,
      'published-source reuse requires its full-chain entry',
    );
  assert.equal(m.base.databaseOid, R5_ASYNC_SCOPE.databaseOid);
  for (const p of [
    m.checkout,
    m.outputDirectory,
    m.base.outputDirectory,
    m.sourceBinding.path,
    m.supplemental.expectedPath,
    m.control.receiptPath,
  ])
    assert(isAbsolute(p));
  assert.notEqual(resolve(m.outputDirectory), resolve(m.base.outputDirectory));
  assert(!resolve(m.outputDirectory).startsWith(resolve(m.checkout) + sep));
  assert(!resolve(m.base.outputDirectory).startsWith(resolve(m.checkout) + sep));
  for (const h of [
    m.sourceBinding.sha256,
    m.supplemental.querySha256,
    m.supplemental.expectedSha256,
    m.control.receiptSha256,
  ])
    assert(/^[a-f0-9]{64}$/.test(h));
  assert.equal(m.supplemental.origin, 'OFFLINE_SOURCE_REVIEWED');
  for (const r of [
    m.supplemental.sourceReviewReference,
    m.supplemental.permissionApprovalReference,
    m.supplemental.installedBindingReference,
  ])
    assert(typeof r === 'string' && r.trim().length > 0);
  assert(Number.isSafeInteger(m.control.pid) && m.control.pid > 1 && m.control.pid !== process.pid);
}
export interface R5AsyncBindingReview {
  status: 'DRAFT_UNAPPROVED' | 'REVIEWED_AND_APPROVED';
  supplementalExpectedCatalogSha256: string | null;
  installedPreflightBodySha256: string | null;
  originalExpectedCatalogSha256: string | null;
  originalCollectorSha256: string | null;
  queueProvenanceReviewReference: string | null;
  sourceReviewReference: string | null;
  permissionApprovalReference: string | null;
  installedBindingReference: string | null;
}
/** This source-bound review record is not supplied by a DB capture or CLI flag.
 * The checked-in draft deliberately blocks execution until independently
 * reviewed expected pins and the separately approved installation are frozen.
 */
export function assertR5AsyncBindingReview(m: R5AsyncManifest, r: R5AsyncBindingReview) {
  assert.equal(
    r.status,
    'REVIEWED_AND_APPROVED',
    'supplemental source qualification remains a draft',
  );
  for (const x of [
    r.supplementalExpectedCatalogSha256,
    r.installedPreflightBodySha256,
    r.originalExpectedCatalogSha256,
    r.originalCollectorSha256,
  ])
    assert(typeof x === 'string' && /^[a-f0-9]{64}$/.test(x));
  assert.equal(m.supplemental.expectedSha256, r.supplementalExpectedCatalogSha256);
  assert.equal(m.base.boundPreflightBodySha256, r.installedPreflightBodySha256);
  assert.equal(m.base.expectedCatalogSha256, r.originalExpectedCatalogSha256);
  assert.equal(m.base.catalogQuerySha256, r.originalCollectorSha256);
  assert(
    typeof r.queueProvenanceReviewReference === 'string' &&
      r.queueProvenanceReviewReference.trim().length > 0,
    'trusted queue provenance review is missing',
  );
  assert.equal(m.supplemental.sourceReviewReference, r.sourceReviewReference);
  assert.equal(m.supplemental.permissionApprovalReference, r.permissionApprovalReference);
  assert.equal(m.supplemental.installedBindingReference, r.installedBindingReference);
}
/** Never print the returned URL. Startup role applies to every new worker
 * connection, including ORM statements outside $transaction and reconnects.
 * Prisma v6 documents the options parameter. A live role probe must still pass.
 */
export function r5AsyncCallerUrl(existing: string): string {
  let u: URL;
  try {
    u = new URL(existing);
  } catch {
    throw new Error('invalid existing database URL');
  }
  assert(['postgres:', 'postgresql:'].includes(u.protocol));
  assert.equal(decodeURIComponent(u.pathname.slice(1)), R5_ASYNC_SCOPE.database);
  assert(
    !u.searchParams.has('schema') || u.searchParams.get('schema') === 'public',
    'another Prisma schema is outside this source binding',
  );
  assert(!u.searchParams.has('options'), 'existing startup options need explicit source review');
  assert(u.searchParams.get('pgbouncer') !== 'true', 'session role requires direct connection');
  u.searchParams.set('connection_limit', '1');
  u.searchParams.set('options', '-c role=' + R5_ASYNC_SCOPE.caller);
  return u.toString();
}
export function readR5AsyncPinnedJson<T>(path: string, digest: string): T {
  assert(/^[a-f0-9]{64}$/.test(digest));
  const bytes = readFileSync(path);
  assert.equal(r5AsyncHash(bytes), digest, 'pinned file differs');
  return JSON.parse(bytes.toString()) as T;
}
export function verifyR5AsyncSourceBinding(
  checkout: string,
  pins: { path: string; sha256: string }[],
) {
  assert(Array.isArray(pins) && pins.length > 2107, 'complete frozen source inventory required');
  const root = realpathSync(checkout),
    seen = new Set<string>();
  for (const pin of pins) {
    assert(
      typeof pin.path === 'string' && !isAbsolute(pin.path) && !pin.path.split('/').includes('..'),
    );
    assert(!seen.has(pin.path), 'duplicate source binding');
    seen.add(pin.path);
    const p = realpathSync(resolve(root, pin.path));
    assert(!relative(root, p).startsWith('..') && !isAbsolute(relative(root, p)));
    assert.equal(r5AsyncHash(readFileSync(p)), pin.sha256, 'frozen source changed: ' + pin.path);
  }
  for (const p of [
    'src/modules/activities/correction-application.service.ts',
    'src/modules/activities/activity-time-correction-background.service.ts',
    'src/modules/activities/correction-background-job.ts',
    'src/modules/activities/activity-batch.worker.ts',
    'test/helpers/r5-human-correction-async-driver.ts',
    'test/helpers/r5-setmat-async-job-catalog.sql',
    'test/helpers/r5-human-correction-async-binding.draft.json',
    'prisma/schema.prisma',
  ])
    assert(seen.has(p), 'missing core source pin');
  const actual: string[] = [];
  const walk = (directory: string) => {
    for (const item of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      const path = directory + '/' + item.name;
      assert(!item.isSymbolicLink(), 'source symlinks are not a frozen inventory');
      if (item.isDirectory()) walk(path);
      else if (item.isFile() && !R5_ASYNC_BOOTSTRAPS.includes(path)) actual.push(path);
    }
  };
  walk('src');
  walk('test');
  walk('prisma');
  actual.push('package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.build.json');
  assert.deepEqual([...seen].sort(), actual.sort(), 'complete source path set differs');
}
export function assertR5AsyncCatalogPair(
  base: Record<string, unknown>,
  addon: Record<string, unknown>,
) {
  for (const x of [base, addon]) {
    assert.equal(x.database, R5_ASYNC_SCOPE.database);
    assert.equal(x.databaseOid, R5_ASYNC_SCOPE.databaseOid);
    assert(Array.isArray(x.tables) && x.tables.length > 0);
    assert(Array.isArray(x.functions) && x.functions.length > 0);
  }
  const names = (addon.tables as { name: string }[]).map((x) => x.name).sort();
  assert.deepEqual(names, [...R5_ASYNC_SCOPE.supplementaryTables].sort());
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(addon.namespace, base.namespace, 'namespace/ACL pins must be the same version');
  assert.deepEqual(
    addon.functions,
    base.functions,
    'all function source/ACL pins must be the same version',
  );
}
export interface R5AsyncAclRow {
  table: string;
  column: string;
  select: boolean;
  insert: boolean;
  update: boolean;
  tableSelect: boolean;
  tableInsert: boolean;
  tableUpdate: boolean;
  tableDelete: boolean;
}
export function assertR5AsyncItemAcl(rows: readonly R5AsyncAclRow[]) {
  const item = rows.filter((x) => x.table === 'ActivityBatchJobItem');
  assert.deepEqual(item.map((x) => x.column).sort(), [...R5_ASYNC_ITEM_COLUMNS].sort());
  for (const row of item) {
    assert.equal(row.select, true, 'Item SELECT is not installed');
    assert.equal(
      row.insert,
      R5_ASYNC_ITEM_INSERT.includes(row.column),
      'Item INSERT delta differs',
    );
    assert.equal(
      row.update,
      R5_ASYNC_ITEM_UPDATE.includes(row.column),
      'Item UPDATE delta differs',
    );
    for (const permission of ['tableSelect', 'tableInsert', 'tableUpdate', 'tableDelete'] as const)
      assert.equal(row[permission], false, 'unexpected table-level Item permission');
  }
}
export function assertR5AsyncSingleCommit(
  attempts: readonly R5ObservedAttempt<unknown>[],
  scope: R5AsyncExecutionScope = R5_ASYNC_SCOPE,
) {
  assertExecutionScope(scope);
  assert.equal(
    attempts.length,
    1,
    'exactly one native attempt; metadata must not enter this observer',
  );
  const a = attempts[0];
  assert.equal(a.configuredTimeoutMs, scope.nativeMs);
  assert.equal(a.configuredIsolationLevel, 'ReadCommitted');
  assert.equal(a.observationComplete, true);
  assert.equal(a.databaseOutcome, 'COMMITTED', 'HTTP/Promise/P2028 is not a database outcome');
  assert.equal(a.client.status, 'fulfilled');
  assert(typeof a.evidenceRef === 'string' && a.evidenceRef.length > 0);
}
export function assertR5AsyncNativeReceipt(
  receipt: unknown,
  scope: R5AsyncExecutionScope = R5_ASYNC_SCOPE,
) {
  assertExecutionScope(scope);
  const timing = capacityTerminalReceipt(receipt, 'commit');
  assert(
    timing.transactionPromiseElapsedMs <= scope.nativeMs,
    scope.nativeMs === 15000
      ? 'whole native transaction exceeds the unchanged 15-second budget'
      : 'whole native transaction exceeds the first-launch 60-second budget',
  );
  assert(receipt && typeof receipt === 'object');
  const transactions: unknown = Reflect.get(receipt, 'transactions');
  const server: unknown = Reflect.get(receipt, 'server');
  assert(Array.isArray(transactions) && transactions.length === 1);
  assert(Array.isArray(server) && server.length === 1);
  const identity: unknown = Reflect.get(transactions[0] as object, 'identity');
  assert(identity && typeof identity === 'object');
  assert.equal(Reflect.get(identity, 'role'), R5_ASYNC_SCOPE.caller);
  assert.equal(Reflect.get(identity, 'sessionUser'), R5_ASYNC_INSTALLED_IDENTITIES.P.name);
  assert.equal(Reflect.get(identity, 'roleOid'), String(R5_ASYNC_SCOPE.callerOid));
  assert.equal(Reflect.get(identity, 'isSuperuser'), 'off');
  assert.equal(Reflect.get(identity, 'database'), R5_ASYNC_SCOPE.database);
  assert.equal(Reflect.get(identity, 'databaseOid'), R5_ASYNC_SCOPE.databaseOid);
  assert.deepEqual(Reflect.get(server[0] as object, 'identity'), identity);
  assert.notEqual(Reflect.get(server[0] as object, 'observerPid'), Reflect.get(identity, 'pid'));
  return timing;
}
export function assertR5AsyncResources(r: {
  cpuMax: string;
  memoryMaxBytes: string;
  diskAvailableBytes: number;
}) {
  assert.equal(r.cpuMax, '400000 100000');
  assert.equal(r.memoryMaxBytes, '17179869184');
  assert(Number.isFinite(r.diskAvailableBytes) && r.diskAvailableBytes > 10 * 1024 ** 3);
}
