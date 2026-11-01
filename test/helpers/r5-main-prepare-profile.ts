import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { observeTestEngineTransactions } from './engine-transaction-observation';
import { createR5MainFunctionStats } from './r5-main-function-stats';

type NativeMethod = (...args: unknown[]) => unknown;
export interface MainPrepareIdentity {
  database: string;
  databaseOid: number;
  pid: number;
  xid: string | null;
  role: string;
  sessionUser: string;
  settings?: {
    planCacheMode: string;
    timeZone: string;
    statementTimeout: string;
    lockTimeout: string;
  };
}
interface Span {
  id: number;
  parentId: number | null;
  label: string;
  startedMs: number;
  endedMs?: number;
  outcome?: 'FULFILLED' | 'REJECTED';
  cpuUserUs?: number;
  cpuSystemUs?: number;
  error?: { name: string; code?: string };
  details?: Record<string, unknown>;
}
export interface MainPrepareProfileTargets {
  prisma: object;
  timeSettlement: object;
  timeQueries: object;
  contributions: object;
  contributionQueries: object;
  access: object;
  audit: object;
}
export interface MainPrepareProfileOptions {
  activityId: string;
  /** Independent observer callback. Return only identity/status evidence,
   * never rows or query parameters. It runs AFTER the native promise settles.
   */
  observeOutcome: (identity: MainPrepareIdentity) => Promise<unknown>;
  persist: (profile: unknown) => string;
  onIdentity?: (identity: MainPrepareIdentity) => void;
  /** Diagnostic only: one fresh MAIN, same original postgres role/60s budget. */
  collectNativeFunctionStats?: boolean;
}

const rawMethods = new Set(['$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe']);
const models = new Set([
  'activity',
  'attendanceSettlementRun',
  'attendanceSettlementVersion',
  'evidenceSeal',
  'activityEvidenceState',
  'activitySettlementTimeRevision',
  'participantSettlementTimeBucket',
  'participantSettlementTimeBucketSource',
  'participantTimeAllocationRevision',
  'participantTimeAllocationSlice',
  'participantServiceSegmentRevision',
  'participantSettlementResultRevision',
  'activityParticipationIdentity',
  'activityRuleSnapshot',
  'timePolicyVersion',
  'activityContributionPolicySelectionRevision',
  'activityContributionPolicySelectionItem',
  'contributionPolicyVersion',
  'activitySettlementContributionRevision',
  'participantContributionEvaluation',
  'activitySettlementTimeCommandReceipt',
  'auditLog',
  'user',
]);
function native(object: object, name: string): NativeMethod {
  const value: unknown = Reflect.get(object, name);
  assert(typeof value === 'function', 'missing frozen profiling seam: ' + name);
  return (...args) => Reflect.apply(value, object, args);
}
function errorSummary(error: unknown) {
  const value: { name: string; code?: string } = {
    name: error instanceof Error ? error.name : typeof error,
  };
  if (error && typeof error === 'object') {
    const code: unknown = Reflect.get(error, 'code');
    if (typeof code === 'string') value.code = code;
  }
  return value;
}
function sqlShape(args: unknown[]) {
  const first: unknown = args[0];
  let strings: unknown,
    values: unknown[] = [];
  if (typeof first === 'string') {
    strings = [first];
    values = args.slice(1);
  } else if (Array.isArray(first) && first.every((x) => typeof x === 'string')) {
    strings = first;
    values = args.slice(1);
  } else if (first && typeof first === 'object') {
    strings = Reflect.get(first, 'strings');
    const supplied: unknown = Reflect.get(first, 'values');
    if (Array.isArray(supplied)) values = supplied;
  }
  if (!Array.isArray(strings) || !strings.every((x) => typeof x === 'string'))
    return { fingerprint: 'UNAVAILABLE', evaluationInsert: false, verb: 'UNKNOWN' };
  const shape = strings.join('?').replace(/\s+/g, ' ').trim();
  const evaluationInsert = shape.startsWith('INSERT INTO "ParticipantContributionEvaluation" ');
  const json: unknown = values.at(-1);
  return {
    fingerprint: createHash('sha256').update(shape).digest('hex'),
    verb: /^[a-zA-Z]+/.exec(shape)?.[0]?.toUpperCase() ?? 'UNKNOWN',
    evaluationInsert,
    tag: shape.startsWith('SET CONSTRAINTS ')
      ? 'ORIGINAL_DEFERRED_BARRIER'
      : shape.includes('plan_cache_mode') && shape.includes('set_config')
        ? 'ORIGINAL_PLAN_CACHE_MODE_SET'
        : evaluationInsert
          ? 'EVALUATION_INSERT_ATTEMPT'
          : 'RAW_NATIVE_CALL',
    dispatchProof: 'client-call-only',
    ...(evaluationInsert && typeof json === 'string'
      ? { serializedEvaluationBytes: Buffer.byteLength(json, 'utf8') }
      : {}),
  };
}

/** Optional, single-request diagnostic. It delegates to every original method,
 * preserving receiver, arguments, timeout, ordering, return value and error.
 * It creates no fixture, request, DB role, grant or alternative write path.
 * Explicit function-statistics mode adds transaction-local instrumentation;
 * its overhead stays inside the original budget. Default mode adds no setting.
 * Install immediately before ONE future fresh MAIN_PREPARE call.
 * Records stay in RAM until that native promise has settled.
 */
export function installR5MainPrepareProfile(
  targets: MainPrepareProfileTargets,
  options: MainPrepareProfileOptions,
) {
  assert(options.activityId);
  const functionStats = options.collectNativeFunctionStats
    ? createR5MainFunctionStats()
    : undefined;
  const engine: unknown = Reflect.get(targets.prisma, '_engine');
  assert(engine && typeof engine === 'object');
  const units = [
    [
      targets.timeSettlement,
      'D4',
      ['write', 'lockedProof', 'lockedSources', 'insertBuckets', 'receipt'],
    ],
    [targets.timeQueries, 'D4Query', ['readDraftContextInTx', 'readSourceSetInTx', 'evaluateInTx']],
    [
      targets.contributions,
      'E4',
      ['assertNewNativeActivityInTx', 'prepareTimeInTx', 'insertEvaluations'],
    ],
    [
      targets.contributionQueries,
      'E4Query',
      ['readTimeEvaluationInTx', 'readTimePolicySelectionInTx', 'readFrozenPoliciesInTx'],
    ],
    [targets.access, 'AUTH', ['authorize']],
    [targets.audit, 'AUDIT', ['log']],
  ] as const;
  for (const [object, , names] of [
    ...units,
    [targets.prisma, '', ['$transaction']],
    [targets.timeSettlement, '', ['prepare']],
  ] as const) {
    for (const name of names) {
      native(object, name);
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      assert(!descriptor || descriptor.configurable, 'nonconfigurable diagnostic seam: ' + name);
    }
  }
  const scope = new AsyncLocalStorage<number>();
  const spans: Span[] = [];
  const restores: (() => void)[] = [];
  const transactions: {
    startedMs: number;
    settledMs?: number;
    callbackStartedMs?: number;
    callbackEndedMs?: number;
    callback?: string;
    transactionPromise?: string;
    options: Record<string, unknown>;
  }[] = [];
  let active = false,
    consumed = false,
    origin = 0,
    pending = 0,
    dropped = 0,
    identity: MainPrepareIdentity | undefined;
  let engineReceipt: unknown,
    serverReceipt: unknown,
    observerError: unknown,
    flushError: unknown,
    evidenceRef: string | undefined;
  const stamp = () => performance.now() - origin;
  const measure = async <T>(
    label: string,
    work: () => Promise<T>,
    details?: Record<string, unknown>,
  ): Promise<T> => {
    if (!active) return await work();
    if (spans.length >= 4096) {
      dropped++;
      return await work();
    }
    const entry: Span = {
      id: spans.length + 1,
      parentId: scope.getStore() ?? null,
      label,
      startedMs: stamp(),
      details,
    };
    spans.push(entry);
    const cpu = process.cpuUsage();
    try {
      const result = await scope.run(entry.id, work);
      entry.outcome = 'FULFILLED';
      return result;
    } catch (error) {
      entry.outcome = 'REJECTED';
      entry.error = errorSummary(error);
      throw error;
    } finally {
      entry.endedMs = stamp();
      const used = process.cpuUsage(cpu);
      entry.cpuUserUs = used.user;
      entry.cpuSystemUs = used.system;
    }
  };
  const replace = (
    object: object,
    name: string,
    wrap: (original: NativeMethod, args: unknown[]) => unknown,
  ) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    const original = native(object, name);
    const replacement = (...args: unknown[]) => wrap(original, args);
    Object.defineProperty(object, name, { configurable: true, writable: true, value: replacement });
    restores.push(() => {
      assert.equal(Reflect.get(object, name), replacement);
      if (descriptor) Object.defineProperty(object, name, descriptor);
      else Reflect.deleteProperty(object, name);
    });
  };
  const txProxy = (tx: object) =>
    new Proxy(tx, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof key === 'string' && rawMethods.has(key) && typeof value === 'function')
          return (...args: unknown[]) => {
            const details = sqlShape(args);
            const parent = scope.getStore();
            if (active && details.evaluationInsert && parent) {
              const entry = spans[parent - 1];
              if (
                entry.label === 'E4/insertEvaluations' &&
                entry.details?.preSqlGapMs === undefined
              )
                entry.details = {
                  ...entry.details,
                  preSqlGapMs: stamp() - entry.startedMs,
                  preSqlGapMeaning:
                    'JSON serialization plus original JS/query construction, not isolated JSON-only CPU',
                };
            }
            const invoke = () =>
              measure('RAW/' + key, async () => await Reflect.apply(value, target, args), details);
            if (
              active &&
              functionStats &&
              (details.evaluationInsert ||
                ('tag' in details && details.tag === 'ORIGINAL_DEFERRED_BARRIER'))
            )
              return functionStats.observe(
                target,
                details.evaluationInsert ? 'EVALUATION_INSERT' : 'ORIGINAL_CONSTRAINT_BARRIER',
                details.fingerprint,
                invoke,
              );
            return invoke();
          };
        if (typeof key === 'string' && models.has(key) && value && typeof value === 'object')
          return new Proxy(value, {
            get(delegate, method) {
              const call: unknown = Reflect.get(delegate, method, delegate);
              if (typeof method !== 'string' || typeof call !== 'function') return call;
              return (...args: unknown[]) =>
                measure(
                  'ORM/' + key + '.' + method,
                  async () => await Reflect.apply(call, delegate, args),
                );
            },
          });
        return value;
      },
    });
  replace(targets.prisma, '$transaction', (original, args) => {
    if (!active || typeof args[0] !== 'function') return original(...args);
    const callback = args[0];
    const supplied: unknown = args[1];
    const txEntry = {
      startedMs: stamp(),
      options:
        supplied && typeof supplied === 'object'
          ? {
              timeout: Reflect.get(supplied, 'timeout'),
              maxWait: Reflect.get(supplied, 'maxWait'),
              isolationLevel: Reflect.get(supplied, 'isolationLevel'),
            }
          : {},
    };
    transactions.push(txEntry);
    pending++;
    const callArgs = [...args];
    callArgs[0] = async (tx: unknown) => {
      assert(tx && typeof tx === 'object');
      Object.assign(txEntry, { callbackStartedMs: stamp() });
      try {
        if (functionStats) await functionStats.enable(tx);
        const result: unknown = await Reflect.apply(callback, undefined, [txProxy(tx)]);
        Object.assign(txEntry, { callback: 'FULFILLED' });
        return result;
      } catch (error) {
        Object.assign(txEntry, { callback: 'REJECTED' });
        throw error;
      } finally {
        Object.assign(txEntry, { callbackEndedMs: stamp() });
      }
    };
    let result: unknown;
    try {
      result = original(...callArgs);
    } catch (error) {
      pending--;
      Object.assign(txEntry, { settledMs: stamp(), transactionPromise: 'SYNCHRONOUS_THROW' });
      throw error;
    }
    assert(result instanceof Promise);
    void result.then(
      () => {
        pending--;
        Object.assign(txEntry, { settledMs: stamp(), transactionPromise: 'FULFILLED' });
      },
      () => {
        pending--;
        Object.assign(txEntry, { settledMs: stamp(), transactionPromise: 'REJECTED' });
      },
    );
    return result;
  });
  const identityProbe = async (tx: unknown) => {
    if (identity) return;
    assert(tx && typeof tx === 'object');
    const query = native(tx, '$queryRaw');
    const rows: unknown =
      await query`SELECT jsonb_build_object('database',current_database(),'databaseOid',(SELECT oid::int FROM pg_database WHERE datname=current_database()),'pid',pg_backend_pid(),'xid',pg_current_xact_id_if_assigned()::text,'role',current_user,'sessionUser',session_user,'settings',jsonb_build_object('planCacheMode',current_setting('plan_cache_mode'),'timeZone',current_setting('TimeZone'),'statementTimeout',current_setting('statement_timeout'),'lockTimeout',current_setting('lock_timeout'))) AS identity`;
    assert(Array.isArray(rows) && rows.length === 1);
    const row: unknown = rows[0];
    assert(row && typeof row === 'object');
    const id: unknown = Reflect.get(row, 'identity');
    assert(id && typeof id === 'object');
    const database: unknown = Reflect.get(id, 'database'),
      databaseOid: unknown = Reflect.get(id, 'databaseOid'),
      pid: unknown = Reflect.get(id, 'pid'),
      xid: unknown = Reflect.get(id, 'xid'),
      role: unknown = Reflect.get(id, 'role'),
      sessionUser: unknown = Reflect.get(id, 'sessionUser');
    assert.equal(database, 'app_test_r5_setmat_20261029_q1');
    assert.equal(databaseOid, 1998913);
    assert(
      typeof database === 'string' &&
        typeof databaseOid === 'number' &&
        typeof pid === 'number' &&
        (xid === null || typeof xid === 'string') &&
        typeof role === 'string' &&
        typeof sessionUser === 'string',
    );
    identity = { database, databaseOid, pid, xid, role, sessionUser };
    const settings: unknown = Reflect.get(id, 'settings');
    if (settings && typeof settings === 'object') {
      const planCacheMode: unknown = Reflect.get(settings, 'planCacheMode'),
        timeZone: unknown = Reflect.get(settings, 'timeZone'),
        statementTimeout: unknown = Reflect.get(settings, 'statementTimeout'),
        lockTimeout: unknown = Reflect.get(settings, 'lockTimeout');
      if (
        typeof planCacheMode === 'string' &&
        typeof timeZone === 'string' &&
        typeof statementTimeout === 'string' &&
        typeof lockTimeout === 'string'
      )
        identity.settings = { planCacheMode, timeZone, statementTimeout, lockTimeout };
    }
    try {
      options.onIdentity?.(identity);
    } catch (error) {
      observerError = error;
    }
  };
  for (const [object, prefix, names] of units) {
    for (const name of names)
      replace(object, name, (original, args) =>
        measure(
          prefix + '/' + name,
          async () => {
            if (active && prefix === 'D4' && name === 'lockedProof') await identityProbe(args[0]);
            return await original(...args);
          },
          name === 'insertEvaluations'
            ? { evaluationCount: Array.isArray(args[2]) ? args[2].length : null }
            : undefined,
        ),
      );
  }
  function snapshot() {
    const records = spans.map((entry) => {
      const children = spans
        .filter((x) => x.parentId === entry.id && x.endedMs !== undefined)
        .map((x) => [
          Math.max(entry.startedMs, x.startedMs),
          Math.min(entry.endedMs ?? stamp(), x.endedMs ?? stamp()),
        ])
        .filter((x) => x[1] > x[0])
        .sort((a, b) => a[0] - b[0]);
      let union = 0,
        end = -Infinity;
      for (const [a, b] of children) {
        union += Math.max(0, b - Math.max(end, a));
        end = Math.max(end, b);
      }
      return {
        ...entry,
        exclusiveWallMs:
          entry.endedMs === undefined ? null : Math.max(0, entry.endedMs - entry.startedMs - union),
      };
    });
    return {
      schema: 'srvf-r5-main-prepare-profile/v1',
      activityId: options.activityId,
      consumed,
      active,
      pending,
      dropped,
      spans: records,
      transactions,
      identity,
      engine: engineReceipt,
      independentServer: serverReceipt,
      observerError: observerError ? errorSummary(observerError) : undefined,
      flushError: flushError ? errorSummary(flushError) : undefined,
      evidenceRef,
      ...(functionStats ? { nativeFunctionStats: functionStats.snapshot() } : {}),
      coverage: {
        rawQueries: 'client await latency, not server exclusive time',
        orm: 'logical ORM calls, not physical SQL count',
        cpu: 'inclusive process CPU; excludes independent DB process',
        preSqlGap: 'serialization+JS, not JSON-only timing',
        nativeBudgetChanged: false,
        fixtureCreated: false,
        ...(functionStats ? { exclusiveWallIncludesUnspannedObservationQueries: true } : {}),
      },
      complete:
        consumed &&
        !active &&
        pending === 0 &&
        dropped === 0 &&
        identity?.xid !== null &&
        Boolean(identity) &&
        !observerError &&
        !flushError &&
        serverReceipt !== undefined &&
        transactions.length === 1 &&
        engineReceipt !== null &&
        typeof engineReceipt === 'object' &&
        Reflect.get(engineReceipt, 'status') === 'COMPLETE' &&
        Reflect.get(engineReceipt, 'pending') === 0,
    };
  }
  replace(targets.timeSettlement, 'prepare', (original, args) => {
    if (args[0] !== options.activityId || consumed) return original(...args);
    return (async () => {
      consumed = true;
      active = true;
      origin = performance.now();
      let bridge: ReturnType<typeof observeTestEngineTransactions>;
      try {
        bridge = observeTestEngineTransactions(engine);
      } catch (error) {
        active = false;
        observerError = error;
        throw error;
      }
      try {
        return await measure('MAIN_PREPARE', async () => await original(...args));
      } finally {
        active = false;
        try {
          bridge.restore();
        } catch (error) {
          observerError = error;
        }
        engineReceipt = bridge.snapshot();
        if (identity?.xid) {
          try {
            serverReceipt = await options.observeOutcome(identity);
            assert(serverReceipt && typeof serverReceipt === 'object');
            assert.equal(Reflect.get(serverReceipt, 'database'), identity.database);
            assert.equal(Reflect.get(serverReceipt, 'databaseOid'), identity.databaseOid);
            assert.equal(Reflect.get(serverReceipt, 'cluster'), '7695840193603043362');
            assert.equal(Reflect.get(serverReceipt, 'xid'), identity.xid);
            const observerPid: unknown = Reflect.get(serverReceipt, 'observerPid');
            assert(typeof observerPid === 'number' && observerPid !== identity.pid);
            assert(['committed', 'aborted'].includes(String(Reflect.get(serverReceipt, 'status'))));
          } catch (error) {
            observerError = error;
          }
        }
        try {
          evidenceRef = options.persist(snapshot());
        } catch (error) {
          flushError = error;
        }
      }
    })();
  });
  return {
    snapshot,
    restore() {
      assert(!active && pending === 0, 'native prepare/transaction still active');
      for (const restore of [...restores].reverse()) restore();
    },
  };
}
