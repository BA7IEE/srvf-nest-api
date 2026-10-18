import { createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';
import type { PrismaService } from '../../src/database/prisma.service';
import { hashCanonical } from '../../src/modules/activities/activity-publish-review-idempotency';

/** Immutable fixture identity, reusable across ready -> committed without changing business data. */
export async function readE5CommitProvenance(db: PrismaService, postingBatchId: string) {
  const batch = await db.ledgerPostingBatch.findUniqueOrThrow({
    where: { id: postingBatchId },
    include: { settlementRun: true },
  });
  const activityId = batch.settlementRun.activityId;
  const snapshots = await db.activityRuleSnapshot.findMany({
    where: { activityId },
    orderBy: { id: 'asc' },
  });
  assert.equal(snapshots.length, 1, 'Expected one real published snapshot');
  const snapshot = snapshots[0];
  assert.equal(
    snapshot.snapshotHash,
    hashCanonical({ schemaVersion: 9, resolvedConfig: snapshot.resolvedConfig }),
    'RuleSnapshot hash differs',
  );
  const approval = await db.activityPublishReview.findUniqueOrThrow({
    where: { id: snapshot.createdByReviewId },
    select: { id: true, status: true },
  });
  assert.equal(approval.status, 'approved');
  const roots = await db.activitySettlementContributionRevision.findMany({
    where: { activityId },
    include: { evaluations: { orderBy: { id: 'asc' } } },
    orderBy: { id: 'asc' },
  });
  assert.equal(roots.length, 2);
  assert.deepEqual(roots.map((root) => root.kindCode).sort(), ['draft', 'submitted']);
  for (const root of roots) {
    assert.equal(root.ruleSnapshotId, snapshot.id);
    assert.equal(root.ruleSnapshotHash, snapshot.snapshotHash);
    assert.equal(root.evaluations.length, 1);
    assert.equal(root.recognizedPointsTotal.toFixed(2), '0.50');
    const evaluation = root.evaluations[0];
    assert.equal(evaluation.ruleSnapshotId, snapshot.id);
    const policy = await db.contributionPolicyVersion.findUniqueOrThrow({
      where: { id: evaluation.policyVersionId },
    });
    assert.equal(evaluation.policyId, policy.policyId);
    assert.equal(evaluation.definitionHash, policy.definitionHash);
    assert.equal(evaluation.evaluatorVersion, policy.evaluatorVersion);
  }
  const segments = await db.participantServiceSegmentRevision.findMany({
    where: { identity: { activityId } },
    select: {
      id: true,
      participationIdentityId: true,
      revision: true,
      segmentKey: true,
      statusCode: true,
      resultCode: true,
      sourceCheckInEventId: true,
      sourceCloseEventId: true,
      checkInAt: true,
      checkOutAt: true,
      serviceHours: true,
    },
    orderBy: { id: 'asc' },
  });
  // Automatic allocation appends the recognized revision; it does not erase the
  // superseded raw observation. Validate that real two-revision chain explicitly.
  assert.equal(segments.length, 2);
  const ordered = [...segments].sort((a, b) => a.revision - b.revision);
  assert.deepEqual(
    ordered.map((segment) => segment.revision),
    [1, 2],
  );
  assert.equal(ordered[0].statusCode, 'superseded');
  assert(['draft', 'committed'].includes(ordered[1].statusCode));
  for (const segment of ordered) {
    assert.equal(segment.resultCode, 'valid');
    assert.equal(segment.participationIdentityId, ordered[0].participationIdentityId);
    assert.equal(segment.segmentKey, ordered[0].segmentKey);
    assert.equal(segment.sourceCheckInEventId, ordered[0].sourceCheckInEventId);
    assert.equal(segment.sourceCloseEventId, ordered[0].sourceCloseEventId);
    assert.equal(segment.checkInAt.getTime(), ordered[0].checkInAt.getTime());
    assert.equal(segment.checkOutAt?.getTime(), ordered[0].checkOutAt?.getTime());
    assert(segment.checkInAt > snapshot.createdAt, 'Participation predates the approved snapshot');
  }
  const actions = await db.settlementReviewAction.findMany({
    where: { settlementVersionId: batch.settlementVersionId },
    orderBy: { id: 'asc' },
  });
  assert.equal(actions.length, 2);
  assert.deepEqual(actions.map((action) => `${action.stageCode}/${action.actionCode}`).sort(), [
    'final/approve',
    'first/approve',
  ]);
  assert.notEqual(actions[0].actorUserId, actions[1].actorUserId);
  const immutable = JSON.parse(
    JSON.stringify({
      snapshots,
      approval,
      roots,
      segments: segments.map((segment) => {
        const immutable = { ...segment };
        Reflect.deleteProperty(immutable, 'statusCode');
        return immutable;
      }),
      actions,
    }),
  ) as unknown;
  return {
    fingerprint: hashCanonical(immutable),
    snapshotHash: snapshot.snapshotHash,
    sourceSetHashes: roots.map((root) => root.sourceSetHash),
    evaluationSetHashes: roots.map((root) => root.evaluationSetHash),
    roots: roots.length,
    evaluations: roots.reduce((n, root) => n + root.evaluations.length, 0),
    approvals: actions.length,
    snapshotHashRecomputed: true,
    sourceAfterSnapshot: true,
  };
}

type Call = (...args: unknown[]) => unknown;
type Event = {
  sequence: number;
  stage: string;
  outcome: 'ENTER' | 'RETURN' | 'THROW';
  elapsedMs: number;
  durationMs?: number;
  error?: ReturnType<typeof safeCommitError>;
  transactionOptions?: { timeout: unknown; isolationLevel: unknown };
};

function read(value: unknown, key: string): unknown {
  try {
    return value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
  } catch {
    return undefined;
  }
}

/** Preserve only error fields whose grammar excludes SQL, parameters and credentials. */
export function safeCommitError(cause: unknown) {
  const code = read(cause, 'code');
  const name = read(cause, 'name');
  const version = read(cause, 'clientVersion');
  const message = read(cause, 'message');
  const meta = read(cause, 'meta');
  const metaCode = read(meta, 'code');
  const metaError = read(meta, 'error');
  const safeTransaction = (value: unknown) =>
    typeof value === 'string' &&
    /^Transaction already closed: (?:A query|A commit) cannot be executed on an expired transaction\. The timeout for this transaction was [0-9]{1,9} ms, however [0-9]{1,9} ms passed since the start of the transaction\.(?: Consider increasing the interactive transaction timeout or doing less work in the transaction\.)?$/.test(
      value,
    )
      ? value
      : null;
  const texts = [message, metaError].filter((x): x is string => typeof x === 'string').join('\n');
  const stack = read(cause, 'stack');
  return {
    errorClass:
      typeof name === 'string' &&
      /^(?:Error|TypeError|PrismaClientKnownRequestError|PrismaClientUnknownRequestError|PrismaClientInitializationError|PrismaClientRustPanicError)$/.test(
        name,
      )
        ? name
        : 'Unknown',
    prismaCode: typeof code === 'string' && /^P[0-9]{4}$/.test(code) ? code : null,
    clientVersion:
      typeof version === 'string' && /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(version)
        ? version
        : null,
    safeMessage: safeTransaction(message),
    meta: {
      code: typeof metaCode === 'string' && /^[0-9A-Z]{5}$/.test(metaCode) ? metaCode : null,
      error: safeTransaction(metaError),
    },
    messageNotRetained: typeof message === 'string' && safeTransaction(message) === null,
    metaErrorNotRetained: typeof metaError === 'string' && safeTransaction(metaError) === null,
    transactionTimeoutMs:
      Number(texts.match(/timeout for this transaction was ([0-9]{1,9}) ms/i)?.[1]) || null,
    transactionElapsedMs: Number(texts.match(/however ([0-9]{1,9}) ms passed/i)?.[1]) || null,
    transactionClosed: /transaction (?:already closed|is no longer valid|has expired)/i.test(texts),
    locations:
      typeof stack === 'string'
        ? (
            stack.match(
              /(?:src|test)\/(?:[A-Za-z0-9_-]{1,80}\/){0,8}[A-Za-z0-9_.-]{1,120}\.ts:[0-9]{1,6}:[0-9]{1,5}/g,
            ) ?? []
          )
            .filter((location) => !location.includes('..'))
            .slice(0, 8)
        : [],
  };
}

function rawLabel(args: unknown[]): string {
  const first = args[0];
  const strings = Array.isArray(first) ? first : read(first, 'strings');
  const sql =
    Array.isArray(strings) && strings.every((value) => typeof value === 'string')
      ? strings.join('?')
      : typeof first === 'string'
        ? first
        : '';
  const digest = createHash('sha256').update(sql).digest('hex').slice(0, 16);
  const functions = [
    'e4_assert_complete',
    'e4_assert_ledger_complete',
    'pg_advisory_xact_lock',
    'pg_try_advisory_xact_lock',
  ].filter((name) => sql.includes(name));
  const kind = /SET LOCAL lock_timeout/.test(sql) ? 'lock_timeout' : functions.join('+') || 'sql';
  return `raw.${kind}.${digest}`;
}

/** Test-only wrappers: same receiver, arguments, tx and awaited result/error; no extra DB query. */
export function observeE5Commit(posting: object, prisma: object, sink?: (event: Event) => void) {
  const events: Event[] = [];
  const restores: (() => void)[] = [];
  const started = performance.now();
  let active = false;
  let hasFailure = false;
  let failure: unknown;
  let sequence = 0;
  let observerIoMs = 0;
  let restorationFailures = 0;
  const delivered = new Set<number>();
  const emit = (event: Event, output = sink) => {
    if (!output || delivered.has(event.sequence)) return;
    const began = performance.now();
    try {
      output(event);
      delivered.add(event.sequence);
    } catch {
      /* Keep the bounded in-memory evidence and original outcome. */
    } finally {
      observerIoMs += performance.now() - began;
    }
  };
  const note = (value: Omit<Event, 'sequence' | 'elapsedMs'>) => {
    const event = { sequence: ++sequence, elapsedMs: performance.now() - started, ...value };
    events.push(event);
    emit(event);
  };
  const restoreAll = (items: (() => void)[]) => {
    for (const restore of items.splice(0).reverse()) {
      try {
        restore();
      } catch (cause) {
        restorationFailures++;
        note({ stage: 'observer.restore', outcome: 'THROW', error: safeCommitError(cause) });
      }
    }
  };
  const span = async (stage: string, work: () => unknown) => {
    const began = performance.now();
    note({ stage, outcome: 'ENTER' });
    try {
      const result = await work();
      note({ stage, outcome: 'RETURN', durationMs: performance.now() - began });
      return result;
    } catch (cause) {
      note({
        stage,
        outcome: 'THROW',
        durationMs: performance.now() - began,
        error: safeCommitError(cause),
      });
      throw cause;
    }
  };
  const replace = (
    target: object,
    key: string,
    factory: (original: Call) => Call,
    into = restores,
  ) => {
    const original = Reflect.get(target, key) as unknown;
    if (typeof original !== 'function') return;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    const observed = factory(original as Call);
    Object.defineProperty(target, key, {
      configurable: true,
      writable: true,
      value: observed,
    });
    into.push(() => {
      if (descriptor)
        Object.defineProperty(
          target,
          key,
          typeof descriptor.value !== 'function' && !descriptor.get
            ? { ...descriptor, value: original, writable: true }
            : descriptor,
        );
      else Reflect.deleteProperty(target, key);
      if (Reflect.get(target, key) !== original)
        throw new Error('Commit observer restore identity mismatch');
    });
    if (Reflect.get(target, key) !== observed)
      throw new Error('Commit observer install identity mismatch');
  };
  const wrap = (target: object, key: string, label: string, into = restores) =>
    replace(
      target,
      key,
      (original) =>
        function (...args) {
          return active
            ? span(label, () => Reflect.apply(original, target, args))
            : Reflect.apply(original, target, args);
        },
      into,
    );

  try {
    for (const key of [
      'commitBatchWithin',
      'commitBatchProtocol',
      'lockActivity',
      'lockRun',
      'lockVersion',
      'lockBatch',
      'assertPreparedSetConsistent',
      'readDraftSegmentMemberIds',
      'acquireCommitBudget',
      'assertNoCrossActivitySegmentOverlap',
      'createMissingDayStates',
      'lockDayStates',
      'readPreparedBaseline',
      'advanceDayStates',
    ])
      wrap(posting, key, `posting.${key}`);
    for (const [field, keys] of [
      ['timeLedger', ['hasClassifiedSource', 'assertComplete', 'source']],
      ['timeLedgerAccess', ['authorize']],
      ['contributions', ['assertVersionInTx']],
      ['audit', ['log']],
      ['notifications', ['enqueuePosted']],
    ] as const) {
      const target = read(posting, field);
      if (target && typeof target === 'object')
        for (const key of keys) wrap(target, key, `${field}.${key}`);
    }
    replace(
      prisma,
      '$transaction',
      (original) =>
        function (...args) {
          if (!active || typeof args[0] !== 'function')
            return Reflect.apply(original, prisma, args);
          const callback = args[0] as Call;
          const options = args[1];
          note({
            stage: 'transaction.options',
            outcome: 'ENTER',
            transactionOptions: {
              timeout:
                typeof read(options, 'timeout') === 'number' ? read(options, 'timeout') : null,
              isolationLevel:
                read(options, 'isolationLevel') === 'ReadCommitted' ? 'ReadCommitted' : null,
            },
          });
          const observedCallback = async (tx: object) => {
            const local: (() => void)[] = [];
            try {
              for (const key of [
                '$queryRaw',
                '$executeRaw',
                '$queryRawUnsafe',
                '$executeRawUnsafe',
              ])
                replace(
                  tx,
                  key,
                  (query) =>
                    (...queryArgs) =>
                      span(rawLabel(queryArgs), () => Reflect.apply(query, tx, queryArgs)),
                  local,
                );
              for (const [delegate, key] of [
                ['ledgerPostingBatch', 'update'],
                ['attendanceSettlementRun', 'update'],
              ] as const) {
                const target = read(tx, delegate);
                if (target && typeof target === 'object')
                  wrap(target, key, `tx.${delegate}.${key}`, local);
              }
              return await span('transaction.callback', () =>
                Reflect.apply(callback, undefined, [tx]),
              );
            } finally {
              restoreAll(local);
            }
          };
          return span('transaction.resolve', () =>
            Reflect.apply(original, prisma, [observedCallback, ...args.slice(1)]),
          );
        },
    );
    replace(
      posting,
      'commitBatch',
      (original) =>
        async function (...args) {
          active = true;
          try {
            return await span('posting.commitBatch', () => Reflect.apply(original, posting, args));
          } catch (cause) {
            if (!hasFailure) {
              hasFailure = true;
              failure = cause;
            }
            throw cause;
          } finally {
            active = false;
          }
        },
    );
  } catch (cause) {
    restoreAll(restores);
    throw cause;
  }
  return {
    events,
    get hasFailure() {
      return hasFailure;
    },
    get failure() {
      return failure;
    },
    get restorationFailures() {
      return restorationFailures;
    },
    get observerIoMs() {
      return observerIoMs;
    },
    flush(sink: (event: Event) => void) {
      for (const event of events) emit(event, sink);
    },
    restore() {
      restoreAll(restores);
    },
  };
}
