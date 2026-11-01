import assert from 'node:assert/strict';
import type { Prisma } from '@prisma/client';
import {
  capacityClock,
  R5_CAPACITY_PINS,
  type CapacityConfig,
  type CapacityComponentResult,
} from './r5-setmat-capacity.protocol';
import { assertNativeLaunchFrozenOracle } from './native-launch-live.fixture';
import {
  assertCapacityBags,
  capacityCensus,
  capacityProjection,
  assertCapacityCensusDelta,
} from './r5-setmat-capacity-projection';
import type { R5CapacityFixture } from './r5-setmat-capacity.fixture';

/** Test receipts only. Preserve native failures even when receipt storage fails. */
export function capacityDiagnostics(
  persist: (value: unknown) => string,
  phase: () => string,
  secrets: () => readonly string[],
  fallback: (value: string) => void = (value) => {
    process.stderr.write(value);
  },
) {
  let writeFailure: unknown;
  let failedWrite = false;
  const read = (value: object, key: string): unknown => {
    try {
      return Reflect.get(value, key);
    } catch {
      return '[UNREADABLE_PROPERTY]';
    }
  };
  const redact = (value: string) => {
    let result = value;
    for (const secret of secrets())
      if (secret.length >= 8) result = result.split(secret).join('[REDACTED]');
    return result
      .replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/giu, '[REDACTED_DATABASE_URL]')
      .replace(/https?:\/\/[^\s'"<>]+/giu, '[REDACTED_HTTP_URL]')
      .replace(
        /\b(password|passwd|secret|token|authorization|cookie|api[_-]?key)["']?\s*[:=]\s*(?:'[^']*'|"[^"]*"|[^\s,;]+)/giu,
        '$1=[REDACTED]',
      )
      .replace(/Bearer\s+[A-Za-z0-9._-]+/giu, 'Bearer [REDACTED]')
      .replace(/username=(?:'[^']*'|"[^"]*")/giu, 'username=[REDACTED]')
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, '[REDACTED_JWT]');
  };
  const body = (value: unknown, seen = new Set<unknown>(), depth = 0): unknown => {
    if (typeof value === 'string') return redact(value);
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value) || depth > 12) return '[OMITTED_CYCLIC_OR_DEEP]';
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => body(v, seen, depth + 1));
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /password|secret|token|authorization|cookie|phone|email|username/iu.test(key)
          ? '[REDACTED]'
          : body(entry, seen, depth + 1),
      ]),
    );
  };
  const error = (value: unknown, seen = new Set<unknown>(), depth = 0): unknown => {
    if (!value || typeof value !== 'object') return { message: redact(String(value)) };
    if (seen.has(value) || depth > 8) return { omitted: 'cyclic/deep cause' };
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const key of [
      'name',
      'message',
      'stack',
      'code',
      'error_code',
      'sqlState',
      'sqlstate',
      'SQLSTATE',
      'clientVersion',
    ]) {
      const entry = read(value, key);
      if (typeof entry === 'string') result[key] = redact(entry);
    }
    const meta = read(value, 'meta');
    if (meta && typeof meta === 'object') {
      const safe: Record<string, unknown> = {};
      for (const key of [
        'code',
        'message',
        'sqlState',
        'sqlstate',
        'SQLSTATE',
        'modelName',
        'connection_limit',
        'timeout',
      ]) {
        const entry = read(meta, key);
        if (typeof entry === 'string' || typeof entry === 'number')
          safe[key] = typeof entry === 'string' ? redact(entry) : entry;
      }
      result.meta = safe;
    }
    const cause = read(value, 'cause');
    if (cause !== undefined) result.cause = error(cause, seen, depth + 1);
    const nested = read(value, 'errors');
    if (Array.isArray(nested)) result.errors = nested.map((v) => error(v, seen, depth + 1));
    return result;
  };
  const emit = (record: Record<string, unknown>) => {
    const value = {
      kind: 'capacity-diagnostic',
      phase: phase(),
      wallTime: new Date().toISOString(),
      ...record,
    };
    try {
      persist(value);
    } catch (cause) {
      failedWrite = true;
      writeFailure ??= cause;
      try {
        fallback(
          JSON.stringify({
            kind: 'CAPACITY_DIAGNOSTIC_WRITE_FAILED',
            record: value,
            error: error(cause),
          }) + '\n',
        );
      } catch {
        /* The original business rejection must remain the thrown object. */
      }
    }
  };
  return {
    error,
    body,
    emit,
    assertHealthy() {
      if (failedWrite) throw writeFailure;
    },
    async run<T>(label: string, work: () => Promise<T>): Promise<T> {
      try {
        return await work();
      } catch (cause) {
        emit({ event: 'BOUNDARY_REJECTED', label, error: error(cause) });
        throw cause;
      }
    },
    http(response: { status: number; body: { code?: unknown } }, entry: string) {
      if (![200, 201].includes(response.status) || response.body.code !== 0)
        emit({
          event: 'HTTP_FAILURE',
          entry,
          status: response.status,
          body: body(response.body),
          headersCaptured: false,
        });
      assert(
        [200, 201].includes(response.status) && response.body.code === 0,
        'NATIVE_CAPACITY_HTTP_' + response.status + '_' + String(response.body.code),
      );
      if (failedWrite) throw writeFailure;
    },
    filter(prototype: object, accepts: (host: import('@nestjs/common').ArgumentsHost) => boolean) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'catch');
      assert(descriptor && typeof descriptor.value === 'function');
      const original: (...args: unknown[]) => unknown = descriptor.value;
      const wrapper = function (
        this: unknown,
        exception: unknown,
        host: import('@nestjs/common').ArgumentsHost,
      ) {
        if (accepts(host))
          emit({ event: 'NATIVE_EXCEPTION_BEFORE_MAPPING', error: error(exception) });
        return Reflect.apply(original, this, [exception, host]);
      };
      Object.defineProperty(prototype, 'catch', { ...descriptor, value: wrapper });
      return () => {
        assert.equal(Reflect.get(prototype, 'catch'), wrapper);
        Object.defineProperty(prototype, 'catch', descriptor);
      };
    },
  };
}

/** Instance-local test seam; all originals and their checks are called. */
function isCapacityTransaction(value: object): value is Prisma.TransactionClient {
  return ['$executeRaw', '$queryRaw'].every(
    (name) => typeof Reflect.get(value, name) === 'function',
  );
}

export function capacityMethod(
  object: object,
  name: string,
  wrap: (original: (...args: unknown[]) => Promise<unknown>, args: unknown[]) => Promise<unknown>,
) {
  const original: unknown = Reflect.get(object, name);
  assert(typeof original === 'function', `missing frozen method ${name}`);
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  const replacement = async (...args: unknown[]) =>
    wrap(async (...input: unknown[]) => {
      const value: unknown = Reflect.apply(original, object, input);
      assert(value instanceof Promise, 'native async method required');
      return await value;
    }, args);
  Object.defineProperty(object, name, { configurable: true, writable: true, value: replacement });
  return () => {
    assert.equal(Reflect.get(object, name), replacement);
    if (descriptor) Object.defineProperty(object, name, descriptor);
    else Reflect.deleteProperty(object, name);
  };
}

export function capacityTerminalReceipt(receipt: unknown, terminal: 'commit' | 'rollback') {
  assert(receipt && typeof receipt === 'object');
  const transactions: unknown = Reflect.get(receipt, 'transactions');
  assert(Array.isArray(transactions) && transactions.length === 1);
  const entry: unknown = transactions[0];
  assert(entry && typeof entry === 'object');
  const expected = terminal === 'commit' ? 'FULFILLED' : 'REJECTED';
  assert.equal(Reflect.get(entry, 'callback'), expected);
  assert.equal(Reflect.get(entry, 'transactionPromise'), expected);
  const engine: unknown = Reflect.get(receipt, 'engine');
  assert(engine && typeof engine === 'object');
  assert.equal(Reflect.get(engine, 'status'), 'COMPLETE');
  assert.equal(Reflect.get(engine, 'pending'), 0);
  const phases: unknown = Reflect.get(engine, 'phases');
  assert(Array.isArray(phases) && phases.length === 2);
  assert.deepEqual(
    phases.map((p: unknown) => {
      assert(p && typeof p === 'object');
      return { phase: Reflect.get(p, 'phase'), outcome: Reflect.get(p, 'outcome') };
    }),
    [
      { phase: 'start', outcome: 'ok' },
      { phase: terminal, outcome: 'ok' },
    ],
  );
  const phase: unknown = phases[1];
  assert(phase && typeof phase === 'object');
  const terminalMs: unknown = Reflect.get(phase, 'elapsedMs');
  assert(typeof terminalMs === 'number' && Number.isFinite(terminalMs) && terminalMs >= 0);
  const server: unknown = Reflect.get(receipt, 'server');
  assert(Array.isArray(server) && server.length === 1);
  const row: unknown = server[0];
  assert(row && typeof row === 'object');
  assert.equal(Reflect.get(row, 'status'), terminal === 'commit' ? 'committed' : 'aborted');
  const started: unknown = Reflect.get(entry, 'callbackStartedMs'),
    ended: unknown = Reflect.get(entry, 'callbackEndedMs');
  assert(typeof started === 'number' && typeof ended === 'number' && ended > started);
  const txStarted: unknown = Reflect.get(entry, 'transactionStartedMs'),
    txEnded: unknown = Reflect.get(entry, 'transactionSettledMs');
  assert(
    typeof txStarted === 'number' &&
      typeof txEnded === 'number' &&
      Number.isFinite(txStarted) &&
      Number.isFinite(txEnded) &&
      txEnded > txStarted,
  );
  const clientEntry: unknown = Reflect.get(receipt, 'entry');
  assert(clientEntry && typeof clientEntry === 'object');
  const entryElapsedMs: unknown = Reflect.get(clientEntry, 'elapsedMs');
  assert(
    typeof entryElapsedMs === 'number' && Number.isFinite(entryElapsedMs) && entryElapsedMs >= 0,
  );
  return {
    callbackElapsedMs: ended - started,
    terminalMs,
    transactionPromiseElapsedMs: txEnded - txStarted,
    entryElapsedMs,
  };
}

export async function measureR5CapacityComponent(
  f: R5CapacityFixture,
  config: CapacityConfig,
): Promise<CapacityComponentResult> {
  assert.equal(f.delta, 1000);
  capacityClock(config, Date.now(), 120000);
  const controlStart = performance.now();
  const before = await f.snapshot();
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
    attempt = await f.observe('COMPONENT1000_REAL_CALLBACK_FORCED_ROLLBACK', f.commit);
  } finally {
    restoreAudit();
    restoreMaterialize();
  }
  assert.equal(attempt.databaseOutcome, 'ROLLED_BACK');
  assert.equal(attempt.observationComplete, true);
  assert.equal(attempt.configuredTimeoutMs, 15000);
  assert.equal(attempt.configuredIsolationLevel, 'ReadCommitted');
  assert.equal(attempt.client.status, 'rejected');
  if (attempt.client.status === 'rejected') assert.equal(attempt.client.reason, rollback);
  assert.equal(materializations, 1);
  assert.equal(audits, 1);
  const terminal = capacityTerminalReceipt(f.getLastObservation(), 'rollback');
  assert(
    terminal.transactionPromiseElapsedMs <= 15000,
    'original Human15s includes actual transaction settlement',
  );
  const after = await f.snapshot();
  f.persist({ kind: 'component-after-complete-manifest', snapshot: after });
  assert.deepEqual(
    after,
    before,
    'all frozen tables/all columns/all rows must be unchanged after proven rollback',
  );
  assert(performance.now() - controlStart < 120000, 'component outer120s control limit');
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
    schema: 'srvf-r5-capacity-component/v1',
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

export async function measureR5CapacityFull(f: R5CapacityFixture, config: CapacityConfig) {
  assert.equal(f.delta, 10000);
  capacityClock(config, Date.now(), 120000);
  const before = await f.snapshot();
  f.persist({ kind: 'full-before-complete-manifest', snapshot: before });
  const censusBefore = await f.observer.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return await capacityCensus(tx, f.activityId);
    },
    { timeout: 30000, maxWait: 2000 },
  );
  // No reference/rollback seam: this is exactly one original Human commit.
  const attempt = await f.observe('FULL10000_ONCE_REAL_HUMAN_COMMIT', f.commit);
  assert.equal(attempt.databaseOutcome, 'COMMITTED');
  assert.equal(attempt.observationComplete, true);
  assert.equal(attempt.configuredTimeoutMs, 15000);
  assert.equal(attempt.configuredIsolationLevel, 'ReadCommitted');
  if (attempt.client.status === 'rejected') throw attempt.client.reason;
  const result = attempt.client.value;
  const terminal = capacityTerminalReceipt(f.getLastObservation(), 'commit');
  assert(
    terminal.transactionPromiseElapsedMs <= 15000,
    'full actual transaction including COMMIT must fit Human15s',
  );
  assert.equal(result.replayed, false);
  assert.equal(result.applicationStatus, 'committed');
  assert.equal(result.correctionStatus, 'applied');
  assert.equal(result.postingBatchId, f.postingBatchId);
  const application = await f.observer.correctionApplication.findUniqueOrThrow({
    where: { id: f.applicationId },
  });
  assert.equal(application.statusCode, 'committed');
  const phase = await f.observer.$queryRaw<
    { state: string }[]
  >`SELECT state FROM public."CorrectionWritePhase" WHERE "applicationId"=${f.applicationId} AND phase='commit'`;
  assert.deepEqual(phase, [{ state: 'SEALED' }]);
  const batch = await f.observer.ledgerPostingBatch.findUniqueOrThrow({
    where: { id: f.postingBatchId },
  });
  assert.equal(batch.statusCode, 'committed');
  const proof = await f.observer.correctionTimeSourceProof.findUniqueOrThrow({
    where: { applicationId: f.applicationId },
  });
  assert.equal(proof.expectedSegmentCount, 10000);
  assert.equal(proof.expectedBindingCount, 10000);
  assert.equal(proof.expectedPendingCount, 10000);
  assert.equal(proof.expectedSliceCount, 50000);
  const bags = await f.observer.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const bags = await capacityProjection(tx, f.applicationId);
      assertCapacityBags(bags, 10000);
      assertCapacityCensusDelta(censusBefore, await capacityCensus(tx, f.activityId), 10000);
      const statuses = await tx.$queryRaw<{ statusCode: string; count: number }[]>`
      SELECT s."statusCode",count(*)::int AS count FROM "ParticipantServiceSegmentRevision" s
      JOIN "CorrectionPendingTimeAllocation" p ON p."targetSegmentRevisionId"=s.id
      WHERE p."applicationId"=${f.applicationId} GROUP BY s."statusCode"`;
      assert.deepEqual(statuses, [{ statusCode: 'committed', count: 10000 }]);
      return bags;
    },
    { isolationLevel: 'RepeatableRead', timeout: 30000, maxWait: 2000 },
  );
  assert.equal(
    await f.observer.auditLog.count({
      where: {
        resourceType: 'activity',
        resourceId: f.activityId,
        event: 'activity.publish',
        success: true,
        AND: [
          { context: { path: ['extra', 'operation'], equals: 'correction-commit' } },
          { context: { path: ['extra', 'correctionApplicationId'], equals: f.applicationId } },
          { context: { path: ['extra', 'postingBatchId'], equals: f.postingBatchId } },
        ],
      },
    }),
    1,
    'exact new commit audit must be durable',
  );
  await assertNativeLaunchFrozenOracle(f.observer, f.root, 8000, f.stage);
  const after = await f.snapshot();
  f.persist({ kind: 'full-after-complete-manifest', snapshot: after });
  f.checkpoint();
  return {
    schema: 'srvf-r5-capacity-full/v1',
    outcome: 'PASS',
    pins: R5_CAPACITY_PINS,
    runId: f.runId,
    sourceCount: 10000,
    delta: 10000,
    bindingCount: 10000,
    databaseOutcome: attempt.databaseOutcome,
    observationComplete: true,
    actualHumanCommit: true,
    includedLedgerAudit: true,
    includedDeferredTerminalChecks: true,
    includedRealCommit: true,
    oracleRerun: true,
    fullTableManifestMatched: true,
    bags,
    transactionEvidence: attempt.evidenceRef,
    ...terminal,
    postingBatchId: f.postingBatchId,
  };
}
