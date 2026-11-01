import assert from 'node:assert/strict';

const sealTemplate = [
  '\n    SELECT * FROM public.r5_correction_seal_phase(',
  '::text, ',
  '::text)\n  ',
];
export function isR5CommitSeal(args: readonly unknown[], applicationId: string) {
  const template = args[0];
  return (
    args.length === 3 &&
    Array.isArray(template) &&
    template.length === 3 &&
    template.every((part, i) => part === sealTemplate[i]) &&
    Array.isArray(Reflect.get(template, 'raw')) &&
    (Reflect.get(template, 'raw') as unknown[]).length === 3 &&
    (Reflect.get(template, 'raw') as unknown[]).every((part, i) => part === sealTemplate[i]) &&
    args[1] === applicationId &&
    args[2] === 'commit'
  );
}
/** Receiver/arguments/fulfillment value/error identity is preserved. No SQL is added or
 * rebuilt. Each START/SETTLED event is durable and charged to the native budget;
 * a failed journal marks the profile unusable without masking a native error. */
export function installR5TailProfile(
  corrections: object,
  applicationId: string,
  postingBatchId: string,
  persist: (v: unknown) => string,
) {
  const events: Record<string, unknown>[] = [];
  let failed = false,
    sequence = 0;
  const restorers: (() => void)[] = [];
  const attached = new WeakSet<object>();
  const emit = (value: Record<string, unknown>) => {
    const e = { kind: 'R5_NATIVE_TAIL_STAGE', at: new Date().toISOString(), ...value };
    events.push(e);
    try {
      persist(e);
    } catch {
      failed = true;
    }
  };
  const wrap = (
    object: object,
    key: string,
    label: string,
    match: (args: unknown[]) => boolean = () => true,
    flag?: 'boolean' | 'presence',
  ) => {
    const original: unknown = Reflect.get(object, key);
    assert(typeof original === 'function');
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    const wrapper = function (this: unknown, ...args: unknown[]) {
      if (!match(args)) return Reflect.apply(original, this, args);
      const id = ++sequence,
        start = performance.now();
      emit({ label, id, event: 'START', monotonicMs: start });
      let result: unknown;
      try {
        result = Reflect.apply(original, this, args);
      } catch (error) {
        emit({ label, id, event: 'REJECTED', elapsedMs: performance.now() - start });
        throw error;
      }
      assert(
        result && typeof result === 'object' && typeof Reflect.get(result, 'then') === 'function',
        'native promise required',
      );
      // Assimilate exactly once; a PrismaPromise must not be subscribed once
      // for tracing and again by its original caller. Return a new observing
      // promise while preserving the native fulfillment value/rejection object.
      return Promise.resolve(result).then(
        (value) => {
          emit({
            label,
            id,
            event: 'FULFILLED',
            elapsedMs: performance.now() - start,
            monotonicMs: performance.now(),
            branchFlag:
              flag === 'boolean'
                ? typeof value === 'boolean'
                  ? value
                  : 'UNKNOWN'
                : flag === 'presence'
                  ? value !== null
                  : undefined,
          });
          return value;
        },
        (error) => {
          emit({
            label,
            id,
            event: 'REJECTED',
            elapsedMs: performance.now() - start,
            monotonicMs: performance.now(),
          });
          throw error;
        },
      );
    };
    Object.defineProperty(object, key, { configurable: true, writable: true, value: wrapper });
    restorers.push(() => {
      assert.equal(Reflect.get(object, key), wrapper);
      if (descriptor)
        Object.defineProperty(
          object,
          key,
          'get' in descriptor || 'set' in descriptor
            ? descriptor
            : { ...descriptor, value: original },
        );
      else Reflect.deleteProperty(object, key);
      assert.equal(Reflect.get(object, key), original, 'restore exact original method');
    });
  };
  const restoreAll = () => {
    let first: unknown;
    for (const restore of restorers.splice(0).reverse()) {
      try {
        restore();
      } catch (error) {
        first ??= error;
      }
    }
    if (first)
      throw first instanceof Error ? first : new Error('profile restore failed', { cause: first });
  };
  try {
    for (const [property, method, label] of [
      ['timeCorrection', 'createCommitReceipt', 'RECEIPT'],
      ['ledgerPosting', 'commitBatchWithin', 'LEDGER'],
      ['humanAccess', 'authorizeCommit', 'AUTHORIZATION'],
    ] as const) {
      const object: unknown = Reflect.get(corrections, property);
      assert(object && typeof object === 'object');
      wrap(object, method, label);
    }
    const audit: unknown = Reflect.get(corrections, 'audit');
    assert(audit && typeof audit === 'object');
    wrap(audit, 'logCommit', 'CORRECTION_AUDIT');
    const ledger: unknown = Reflect.get(corrections, 'ledgerPosting');
    assert(ledger && typeof ledger === 'object');
    const time: unknown = Reflect.get(ledger, 'timeCorrection');
    assert(time && typeof time === 'object');
    wrap(time, 'hasReadyV3CommitReceiptAnchor', 'RECEIPT_ANCHOR', () => true, 'boolean');
    wrap(time, 'assertComplete', 'TIME_CORRECTION_FALLBACK');
    const contributions: unknown = Reflect.get(ledger, 'contributions');
    assert(contributions && typeof contributions === 'object');
    wrap(
      contributions,
      'readNativePostingBoundaryCandidateInTx',
      'E4_BOUNDARY_CANDIDATE',
      () => true,
      'presence',
    );
    wrap(contributions, 'assertVersionInTx', 'E4_FULL_FALLBACK');
    wrap(contributions, 'assertNativePostingBoundaryInTx', 'E4_BOUNDARY_FINAL');
  } catch (error) {
    try {
      restoreAll();
    } catch {
      failed = true;
    }
    throw error;
  }
  const state = () => {
    const starts = events.filter((e) => e.event === 'START'),
      finished = events.filter((e) => e.event === 'FULFILLED' || e.event === 'REJECTED');
    return {
      pendingStageIds: starts.filter((s) => !finished.some((f) => f.id === s.id)).map((s) => s.id),
      completedTail: [
        'RECEIPT',
        'LEDGER',
        'BATCH_VISIBILITY_UPDATE',
        'SEAL',
        'CORRECTION_AUDIT',
      ].every(
        (label) => events.filter((e) => e.label === label && e.event === 'FULFILLED').length === 1,
      ),
    };
  };
  return {
    attachTransaction(tx: object) {
      assert(!attached.has(tx), 'exact one materialization tx expected');
      attached.add(tx);
      wrap(tx, '$queryRaw', 'SEAL', (args) => isR5CommitSeal(args, applicationId));
      const batch: unknown = Reflect.get(tx, 'ledgerPostingBatch');
      assert(batch && typeof batch === 'object');
      wrap(batch, 'update', 'BATCH_VISIBILITY_UPDATE', (args) => {
        const input = args[0];
        if (!input || typeof input !== 'object') return false;
        const where: unknown = Reflect.get(input, 'where'),
          data: unknown = Reflect.get(input, 'data');
        return (
          !!where &&
          typeof where === 'object' &&
          Reflect.get(where, 'id') === postingBatchId &&
          !!data &&
          typeof data === 'object' &&
          Reflect.get(data, 'statusCode') === 'committed'
        );
      });
    },
    assertHealthy() {
      assert(!failed, 'profile journal failure; no performance PASS');
    },
    assertCompletedTail() {
      assert(
        state().completedTail && state().pendingStageIds.length === 0,
        'complete receipt/ledger/visibility/seal/audit observations required',
      );
    },
    snapshot() {
      return {
        events: [...events],
        ...state(),
        journalComplete: !failed,
        overheadSubtracted: false,
        sqlStatementsAdded: 0,
        sqlTextCaptured: false,
      };
    },
    restore: restoreAll,
  };
}
