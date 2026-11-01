import assert from 'node:assert/strict';
import type { Prisma } from '@prisma/client';
import {
  capacityClock,
  R5_CAPACITY_PINS,
  type CapacityConfig,
} from './r5-setmat-capacity.protocol';
import { capacityMethod, capacityTerminalReceipt } from './r5-setmat-capacity.measurement';
import {
  assertCapacityBags,
  capacityCensus,
  capacityProjection,
  assertCapacityCensusDelta,
} from './r5-setmat-capacity-projection';
import { R5_COMPONENT_ORIGIN } from './r5-setmat-component-continuation';
import { assertR5SeparatedComponent } from './r5-setmat-separated-policy';
import type { R5CapacityFixture } from './r5-setmat-capacity.fixture';
import { join } from 'node:path';
import { writeR5AtomicControlReceipt } from './r5-setmat-durable-receipt';
import { installR5TailProfile } from './r5-setmat-tail-profile';
import { assertR5NativeOnly, verifyR5NativeOnlyEvidence } from './r5-setmat-native-only';

/** The external owned-process driver enforces these durable deadlines even
 * while an awaited Prisma call has not returned. Expiry means UNKNOWN until
 * independent server closeout, never inferred rollback or automatic retry. */
async function controlled<T>(
  config: CapacityConfig,
  name: 'correctness' | 'candidate',
  limitMs: number,
  work: () => Promise<T>,
): Promise<T> {
  const started = Date.now(),
    deadline = started + limitMs;
  writeR5AtomicControlReceipt(join(config.outputDirectory, `control-${name}-start.json`), {
    name,
    started,
    deadline,
    limitMs,
    databaseOutcome: 'UNKNOWN_UNTIL_INDEPENDENT_SERVER_CHECK',
  });
  try {
    const value = await work();
    assert(Date.now() < deadline, 'control deadline exhausted');
    writeR5AtomicControlReceipt(join(config.outputDirectory, `control-${name}-settled.json`), {
      name,
      settledAt: Date.now(),
      state: 'CHECKS_PASSED',
    });
    return value;
  } catch (error) {
    try {
      writeR5AtomicControlReceipt(join(config.outputDirectory, `control-${name}-settled.json`), {
        name,
        settledAt: Date.now(),
        state: 'FAIL_OR_UNKNOWN_NO_RETRY',
      });
    } catch {
      // Keep the native error. The missing settled record keeps the external
      // deadline active; no subsequent measurement or retry is reached.
      try {
        process.stderr.write('R5_CONTROL_JOURNAL_FAILED_OUTCOME_UNKNOWN\n');
      } catch {
        /* Preserve the native failure even if stderr is unavailable. */
      }
    }
    throw error;
  }
}

function isCapacityTransaction(value: object): value is Prisma.TransactionClient {
  return ['$executeRaw', '$queryRaw'].every(
    (name) => typeof Reflect.get(value, name) === 'function',
  );
}
export function observedXid(receipt: unknown) {
  assert(receipt && typeof receipt === 'object');
  const rows: unknown = Reflect.get(receipt, 'server');
  assert(Array.isArray(rows) && rows.length === 1);
  const row: unknown = rows[0];
  assert(row && typeof row === 'object' && Reflect.get(row, 'status') === 'aborted');
  const identity: unknown = Reflect.get(row, 'identity');
  assert(identity && typeof identity === 'object');
  const xid: unknown = Reflect.get(identity, 'xid');
  assert(typeof xid === 'string' && /^[1-9][0-9]*$/.test(xid));
  assert(!['158897', '158922'].includes(xid));
  return xid;
}
async function measureCorrectness(f: R5CapacityFixture, config: CapacityConfig) {
  assert.equal(f.delta, 1000);
  assert(config.separatedComponent);
  const authorizationReference = config.separatedComponent.authorization.reference;
  capacityClock(config, Date.now(), 185000);
  const controlStart = performance.now();
  await f.assertExclusiveBoundary!();
  await f.assertRetainedState!();
  const before = await f.snapshot();
  await f.assertExclusiveBoundary!();
  capacityClock(config, Date.now(), 155000);
  assert(
    performance.now() - controlStart + 150000 < 180000,
    'reserve diagnostic120 + full snapshot30; phase exit5 checked separately',
  );
  f.persist({ kind: 'component-before-complete-manifest', snapshot: before });
  const rollback = new Error('owned R5 component rollback AFTER original ledger/seal/audit');
  let referenceMs = 0,
    candidateMs = 0,
    candidateEnded = 0,
    ledgerAuditTailMs = 0,
    projectionMs = 0;
  let materializations = 0,
    audits = 0;
  const reference: unknown = Reflect.get(f.corrections, 'materializeV3PendingSegments');
  assert(typeof reference === 'function');
  const restoreMaterialize = capacityMethod(
    f.corrections,
    'materializePendingSegments',
    async (original, args) => {
      assert.equal(++materializations, 1);
      assert.equal(args.length, 6);
      assert.equal(args[1], f.applicationId);
      assert.equal(args[2], f.activityId);
      assert.equal(args[3], f.postingBatchId);
      // tx is the actual native commit callback transaction, never a new client.
      // Runtime methods are checked before narrowing this reflective private seam.
      const rawTx: unknown = args[0];
      assert(rawTx && typeof rawTx === 'object');
      assert(
        typeof Reflect.get(rawTx, '$executeRaw') === 'function' &&
          typeof Reflect.get(rawTx, '$queryRaw') === 'function',
      );
      assert(isCapacityTransaction(rawTx));
      const tx = rawTx;
      const censusBefore = await capacityCensus(tx, f.activityId);
      await tx.$executeRaw`SAVEPOINT r5_capacity_reference`;
      const rStart = performance.now();
      const referenceCount: unknown = await Reflect.apply(reference, f.corrections, [
        tx,
        args[1],
        args[2],
        args[4],
        args[5],
        undefined,
      ]);
      referenceMs = performance.now() - rStart;
      assert.equal(referenceCount, 1000);
      const pStart = performance.now();
      const referenceBag = await capacityProjection(tx, f.applicationId);
      assertCapacityBags(referenceBag, 1000);
      assertCapacityCensusDelta(censusBefore, await capacityCensus(tx, f.activityId), 1000);
      projectionMs += performance.now() - pStart;
      f.persist({
        kind: 'same-version-reference',
        referenceMs,
        bag: referenceBag,
        prevalidatedProofUsed: false,
        phase: 'OPEN',
        realCommit: false,
      });
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT r5_capacity_reference`;
      await tx.$executeRaw`RELEASE SAVEPOINT r5_capacity_reference`;
      assert.deepEqual(await capacityCensus(tx, f.activityId), censusBefore);
      const cStart = performance.now();
      const count = await original(...args);
      candidateMs = performance.now() - cStart;
      assert.equal(count, 1000);
      const p2Start = performance.now();
      const candidateBag = await capacityProjection(tx, f.applicationId);
      assertCapacityBags(candidateBag, 1000);
      assertCapacityCensusDelta(censusBefore, await capacityCensus(tx, f.activityId), 1000);
      assert.deepEqual(candidateBag, referenceBag, 'complete normalized row bags must agree');
      projectionMs += performance.now() - p2Start;
      const phase = await tx.$queryRaw<
        { state: string }[]
      >`SELECT state FROM public."CorrectionWritePhase" WHERE "applicationId"=${f.applicationId} AND phase='commit'`;
      assert.deepEqual(phase, [{ state: 'MATERIALIZED' }]);
      f.persist({
        kind: 'candidate-materialization',
        candidateMs,
        bag: candidateBag,
        phase: 'MATERIALIZED',
        bothSegmentUpdatesOriginalOrder: true,
        allBindings: 10000,
      });
      candidateEnded = performance.now();
      return count;
    },
  );
  const audit: unknown = Reflect.get(f.corrections, 'audit');
  assert(audit && typeof audit === 'object');
  const restoreAudit = capacityMethod(audit, 'logCommit', async (original, args) => {
    assert.equal(++audits, 1);
    assert(candidateEnded > 0);
    assert(args[0] && typeof args[0] === 'object');
    assert.equal(Reflect.get(args[0], 'correctionApplicationId'), f.applicationId);
    await original(...args);
    ledgerAuditTailMs = performance.now() - candidateEnded;
    f.persist({
      kind: 'forced-rollback-point',
      after: 'original ledger, final status writes, seal and audit',
      ledgerAuditTailMs,
      commitDeferredChecksExecuted: false,
      actualCommitExecuted: false,
    });
    throw rollback;
  });
  let attempt: Awaited<ReturnType<typeof f.observe>>;
  try {
    attempt = await f.observe('CORRECTNESS_ONLY_TWO_PATHS_NO_NATIVE_PERFORMANCE', f.commit, {
      kind: 'R5_SETMAT_CORRECTNESS_120S',
      authorizationReference,
    });
  } finally {
    restoreAudit();
    restoreMaterialize();
  }
  assert.equal(attempt.databaseOutcome, 'ROLLED_BACK');
  assert.equal(attempt.observationComplete, true);
  assert.equal(attempt.configuredTimeoutMs, 120000);
  assert.equal(attempt.configuredIsolationLevel, 'ReadCommitted');
  assert.equal(attempt.client.status, 'rejected');
  if (attempt.client.status === 'rejected' && attempt.client.reason !== rollback)
    throw attempt.client.reason;
  assert.equal(materializations, 1);
  assert.equal(audits, 1);
  const terminal = capacityTerminalReceipt(f.getLastObservation(), 'rollback');
  assert(
    terminal.transactionPromiseElapsedMs <= 120000,
    'diagnostic-only ceiling; never original Human performance',
  );
  await f.assertExclusiveBoundary!();
  const after = await f.snapshot();
  await f.assertRetainedState!();
  await f.assertExclusiveBoundary!();
  f.persist({ kind: 'component-after-complete-manifest', snapshot: after });
  assert.deepEqual(
    after,
    before,
    'all frozen tables/all columns/all rows must be unchanged after proven rollback',
  );
  assert(
    performance.now() - controlStart < 180000,
    'NEW authorized diagnostic outer180s control limit',
  );
  f.checkpoint();
  f.persist({
    kind: 'component-timing-boundaries',
    referenceMs,
    candidateMs,
    projectionMs,
    ledgerAuditTailMs,
    outerMs: performance.now() - controlStart,
  });
  return {
    schema: 'srvf-r5-correctness-diagnostic/v1' as const,
    nativePerformanceEvidence: false,
    transactionCeilingMs: 120000,
    outerControlMs: 180000,
    xid: observedXid(f.getLastObservation()),
    initialState: before,
    finalState: after,
    outcome: 'PASS',
    pins: R5_CAPACITY_PINS,
    runId: f.runId,
    sourceCount: 10000,
    delta: 1000,
    bindingCount: 10000,
    referenceMs,
    candidateMs,
    ledgerAuditTailMs,
    callbackElapsedMs: terminal.callbackElapsedMs,
    databaseOutcome: 'ROLLED_BACK',
    fullManifestRollback: true,
    exactBagParity: true,
    includedLedgerAudit: true,
    includedDeferredTerminalChecks: false,
    includedRealCommit: false,
  };
}

/** Only the candidate and the original native commit path consume Human15s.
 * No reference invocation, census, projection, snapshot or parity query occurs
 * inside this callback. Instrumentation cost stays charged, never subtracted.
 */
async function measureNativeCandidate(
  f: R5CapacityFixture,
  config: CapacityConfig,
  correctness: Pick<Awaited<ReturnType<typeof measureCorrectness>>, 'xid' | 'finalState'>,
) {
  assert(config.separatedComponent || config.nativeOnly);
  capacityClock(config, Date.now(), 125000);
  const started = performance.now();
  await f.assertExclusiveBoundary!();
  await f.assertRetainedState!();
  await f.verifyCatalog();
  const before = await f.snapshot();
  f.persist({ kind: 'NATIVE_CANDIDATE_BEFORE_FULL_MANIFEST', snapshot: before });
  assert.deepEqual(
    before,
    correctness.finalState,
    'same committed all-row/all-column initial state',
  );
  await f.assertExclusiveBoundary!();
  assert(performance.now() - started + 50000 < 120000, 'reserve native15s + snapshot30s + exit5s');
  const rollback = new Error('R5 native candidate rollback after ORIGINAL seal/ledger/audit');
  const profile = config.nativeOnly
    ? installR5TailProfile(f.corrections, f.applicationId, f.postingBatchId, f.persist)
    : undefined;
  let materializations = 0,
    audits = 0,
    materializeMs = 0,
    materializeEnded = 0,
    ledgerAuditMs = 0;
  const restoreMaterialize = capacityMethod(
    f.corrections,
    'materializePendingSegments',
    async (original, args) => {
      assert.equal(++materializations, 1);
      assert.equal(args.length, 6);
      assert.equal(args[1], f.applicationId);
      assert.equal(args[2], f.activityId);
      assert.equal(args[3], f.postingBatchId);
      if (profile) {
        assert(args[0] && typeof args[0] === 'object');
        profile.attachTransaction(args[0]);
      }
      const start = performance.now();
      const count = await original(...args);
      materializeMs = performance.now() - start;
      assert.equal(count, 1000);
      materializeEnded = performance.now();
      return count;
    },
  );
  const audit: unknown = Reflect.get(f.corrections, 'audit');
  assert(audit && typeof audit === 'object');
  const restoreAudit = capacityMethod(audit, 'logCommit', async (original, args) => {
    assert.equal(++audits, 1);
    assert(materializeEnded > 0);
    assert(args[0] && typeof args[0] === 'object');
    assert.equal(Reflect.get(args[0], 'correctionApplicationId'), f.applicationId);
    await original(...args);
    ledgerAuditMs = performance.now() - materializeEnded;
    throw rollback;
  });
  let profileCleanupFailure: unknown;
  let attempt: Awaited<ReturnType<typeof f.observe>>;
  try {
    attempt = await f.observe('CANDIDATE_ONLY_NATIVE_HUMAN15_ROLLBACK', f.commit, {
      kind: 'R5_SETMAT_CANDIDATE_15S',
      authorizationReference: (
        config.nativeOnly?.authorization ?? config.separatedComponent!.authorization
      ).reference,
    });
  } finally {
    restoreAudit();
    restoreMaterialize();
    try {
      profile?.restore();
    } catch (error) {
      profileCleanupFailure = error;
    }
    try {
      if (profile) f.persist({ kind: 'NATIVE_ONLY_TAIL_PROFILE', ...profile.snapshot() });
    } catch (error) {
      profileCleanupFailure ??= error;
    }
  }
  if (attempt.client.status === 'rejected' && attempt.client.reason !== rollback)
    throw attempt.client.reason;
  if (profileCleanupFailure)
    throw profileCleanupFailure instanceof Error
      ? profileCleanupFailure
      : new Error('profile cleanup failed', { cause: profileCleanupFailure });
  profile?.assertHealthy();
  profile?.assertCompletedTail();
  // Preserve raw attempt first, and let the original failure stop all later steps.
  assert.equal(attempt.databaseOutcome, 'ROLLED_BACK');
  assert.equal(attempt.observationComplete, true);
  assert.equal(attempt.configuredTimeoutMs, 15000);
  assert.equal(attempt.configuredIsolationLevel, 'ReadCommitted');
  assert.equal(attempt.client.status, 'rejected');
  if (attempt.client.status === 'rejected' && attempt.client.reason !== rollback)
    throw attempt.client.reason;
  assert.equal(materializations, 1);
  assert.equal(audits, 1);
  const terminal = capacityTerminalReceipt(f.getLastObservation(), 'rollback');
  const xid = observedXid(f.getLastObservation());
  assert.notEqual(xid, correctness.xid, 'independent native candidate transaction');
  assert(
    terminal.transactionPromiseElapsedMs <= 15000,
    'unadjusted native transaction INCLUDING ROLLBACK',
  );
  await f.assertExclusiveBoundary!();
  const after = await f.snapshot();
  f.persist({ kind: 'NATIVE_CANDIDATE_AFTER_FULL_MANIFEST', snapshot: after });
  assert.deepEqual(after, before);
  await f.assertRetainedState!();
  await f.assertExclusiveBoundary!();
  assert(performance.now() - started < 120000, 'unchanged candidate component outer120s');
  f.checkpoint();
  return {
    schema: 'srvf-r5-native-candidate-rollback-timing/v1' as const,
    xid,
    materializeMs,
    ledgerAuditMs,
    ...terminal,
    transactionCeilingMs: 15000,
    outerControlMs: 120000,
    observerOverheadSubtracted: false,
    ...(profile ? { tailProfile: profile.snapshot() } : {}),
    comparisonQueriesInTransaction: 0,
    referenceCallsInTransaction: 0,
    includedLedgerAudit: true,
    databaseOutcome: 'ROLLED_BACK',
    fullManifestRollback: true,
    includedRealCommit: false,
    includedDeferredTerminalChecks: false,
    initialState: before,
    finalState: after,
  };
}

export async function measureR5NativeOnly(f: R5CapacityFixture, config: CapacityConfig) {
  assert(config.nativeOnly && !config.continuation && !config.separatedComponent);
  assertR5NativeOnly(config.nativeOnly);
  assert.equal(f.applicationId, R5_COMPONENT_ORIGIN.applicationId);
  assert.equal(f.delta, 1000);
  assert.equal(f.activityId, R5_COMPONENT_ORIGIN.activityId);
  assert.equal(f.postingBatchId, R5_COMPONENT_ORIGIN.postingBatchId);
  assert(f.assertExclusiveBoundary && f.assertRetainedState);
  const prior = verifyR5NativeOnlyEvidence(config.nativeOnly.evidenceDirectory);
  await f.assertExclusiveBoundary();
  await f.assertRetainedState();
  const baseline = await f.snapshot();
  f.persist({ kind: 'NATIVE_ONLY_CURRENT_POST_LOGIN_BASELINE', snapshot: baseline, prior });
  const candidate = await controlled(config, 'candidate', 120000, () =>
    measureNativeCandidate(f, config, { xid: prior.diagnosticXid, finalState: baseline }),
  );
  return {
    schema: 'srvf-r5-native-only-result/v1',
    outcome: 'PASS',
    candidate,
    prior,
    origin: R5_COMPONENT_ORIGIN,
    pins: R5_CAPACITY_PINS,
    runId: f.runId,
    oldWholePhaseVerdict: 'FAIL_PRESERVED',
    oldDiagnosticPhaseVerdict: 'FAIL_PRESERVED',
    diagnosticTransactionsExecuted: 0,
    prepareReplayed: false,
    actualHumanCommit: false,
    includedRealCommit: false,
    includedDeferredTerminalChecks: false,
    full10000Admission: false,
  };
}

export async function measureR5SeparatedComponent(f: R5CapacityFixture, config: CapacityConfig) {
  assert(config.separatedComponent);
  assertR5SeparatedComponent(config.separatedComponent);
  assert(!config.continuation && config.mode === 'component1000');
  assert.equal(f.applicationId, R5_COMPONENT_ORIGIN.applicationId);
  assert.equal(f.activityId, R5_COMPONENT_ORIGIN.activityId);
  assert.equal(f.postingBatchId, R5_COMPONENT_ORIGIN.postingBatchId);
  assert.equal(f.delta, 1000);
  assert(f.assertRetainedState && f.assertExclusiveBoundary, 'strict retained fixture required');
  const correctness = await controlled(config, 'correctness', 180000, () =>
    measureCorrectness(f, config),
  );
  f.persist({ kind: 'CORRECTNESS_PASS_NOT_PERFORMANCE', correctness });
  // No subtraction: the correctness transaction must be independently aborted
  // and the whole database restored before a fresh original15s transaction.
  const candidate = await controlled(config, 'candidate', 120000, () =>
    measureNativeCandidate(f, config, correctness),
  );
  return {
    schema: 'srvf-r5-separated-component-result/v1' as const,
    outcome: 'PASS',
    runId: f.runId,
    pins: R5_CAPACITY_PINS,
    origin: R5_COMPONENT_ORIGIN,
    correctness,
    candidate,
    originalWholePhaseVerdict: 'FAIL_PRESERVED',
    previousComponentVerdict: 'FAIL_PRESERVED',
    prepareReplayed: false,
    actualHumanCommit: false,
    full10000Admission: false,
    includedRealCommit: false,
    includedDeferredTerminalChecks: false,
  };
}
