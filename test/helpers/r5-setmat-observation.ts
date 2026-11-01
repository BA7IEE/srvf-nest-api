import assert from 'node:assert/strict';
import { Prisma, type PrismaClient } from '@prisma/client';
import { observeTestEngineTransactions } from './engine-transaction-observation';
import type { R5ObservedAttempt } from './r5-setmat-concurrency-barrier';
import {
  r5RollbackObservationOptions,
  type R5RollbackObservationPolicy,
} from './r5-setmat-separated-policy';

export const R5_SETMAT_DATABASE = 'app_test_r5_setmat_20261029_q1';
export const R5_SETMAT_CALLER = 'r5_boundary_caller_h7c6';
export const R5_SETMAT_CLUSTER = '7695840193603043362';

export interface R5TransactionIdentity {
  database: string;
  databaseOid: number;
  role: string;
  pid: number;
  xid: string;
  sessionUser: string;
  roleOid: string;
  isSuperuser: string;
}

export function r5ServerOutcome(statuses: readonly (string | null)[]) {
  if (statuses.length === 1 && statuses[0] === 'committed') return 'COMMITTED' as const;
  if (statuses.length === 1 && statuses[0] === 'aborted') return 'ROLLED_BACK' as const;
  return 'UNKNOWN' as const;
}

/** Read raw-query SQLSTATE, never infer it from a Prisma error number. */
export function r5ServerError(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2010')
    return undefined;
  const code = error.meta?.code;
  const message = error.meta?.message;
  if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code) || typeof message !== 'string')
    return undefined;
  return {
    sqlState: code,
    message: message.startsWith('ERROR: ') ? message.slice(7) : message,
  };
}

/** Switch only the existing ordinary caller inside real interactive transactions.
 * No membership/grant and no switch to the dedicated materializer. Outside a
 * business transaction, the existing admin connection still supports fixture
 * setup and real login. The single pool connection is retained across requests.
 */
export function installR5CallerTransactions(
  client: PrismaClient,
  databaseOid: number,
  beforeBody?: (tx: Prisma.TransactionClient) => Promise<void>,
  progress?: (event: Record<string, unknown>) => void,
) {
  const original: unknown = Reflect.get(client, '$transaction');
  assert(typeof original === 'function');
  const descriptor = Object.getOwnPropertyDescriptor(client, '$transaction');
  interface Capture {
    entries: {
      identity?: R5TransactionIdentity;
      callbackStartedMs: number;
      callbackEndedMs?: number;
      callback: 'PENDING' | 'FULFILLED' | 'REJECTED';
      transactionPromise: 'PENDING' | 'FULFILLED' | 'REJECTED';
      transactionSettledMs?: number;
      transactionStartedMs: number;
      options: { timeout: unknown; maxWait: unknown; isolationLevel: unknown };
    }[];
    start: number;
    unknown: boolean;
    error?: unknown;
    label: string;
    rollbackPolicy?: R5RollbackObservationPolicy;
  }
  let active: Capture | undefined;
  let pending = 0;
  let callerScope = false;
  const emit = (capture: Capture | undefined, event: Record<string, unknown>) => {
    if (!capture || !progress) return;
    try {
      progress({
        kind: 'r5-native-transaction-progress',
        label: capture.label,
        wallTime: new Date().toISOString(),
        elapsedMs: performance.now() - capture.start,
        databaseOutcome: 'UNKNOWN_UNTIL_INDEPENDENT_SERVER_CHECK',
        ...event,
      });
    } catch {
      capture.unknown = true;
    }
  };
  const wrapper = function (this: unknown, ...args: unknown[]) {
    // Real password login also uses this Prisma instance and its own session
    // transaction. Route only the explicitly scoped correction operation.
    if (!active && !callerScope) return Reflect.apply(original, this, args);
    const body = args[0];
    if (typeof body !== 'function') {
      if (active) active.unknown = true;
      return Reflect.apply(original, this, args);
    }
    const capture = active;
    const requestedOptions = args[1] && typeof args[1] === 'object' ? args[1] : {};
    const options = capture?.rollbackPolicy
      ? r5RollbackObservationOptions(requestedOptions, capture.rollbackPolicy)
      : requestedOptions;
    const entry: Capture['entries'][number] | undefined = capture
      ? {
          callbackStartedMs: 0,
          transactionStartedMs: performance.now() - capture.start,
          callback: 'PENDING' as 'PENDING' | 'FULFILLED' | 'REJECTED',
          transactionPromise: 'PENDING' as 'PENDING' | 'FULFILLED' | 'REJECTED',
          options: {
            timeout: Reflect.get(options, 'timeout'),
            maxWait: Reflect.get(options, 'maxWait'),
            isolationLevel: Reflect.get(options, 'isolationLevel'),
          },
        }
      : undefined;
    if (capture && entry) capture.entries.push(entry);
    emit(capture, {
      event: 'TRANSACTION_PROMISE_STARTED',
      options: entry?.options,
      requestedOptions: capture?.rollbackPolicy ? requestedOptions : undefined,
      rollbackPolicy: capture?.rollbackPolicy,
    });
    const callArgs = [...args];
    if (capture?.rollbackPolicy) callArgs[1] = options;
    callArgs[0] = async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SET LOCAL ROLE "r5_boundary_caller_h7c6"`;
      try {
        if (entry && capture) {
          entry.callbackStartedMs = performance.now() - capture.start;
          const identities = await tx.$queryRaw<R5TransactionIdentity[]>`
          SELECT current_database()::text AS database,
            (SELECT oid FROM pg_database WHERE datname=current_database())::int AS "databaseOid",
            current_user::text AS role, pg_backend_pid() AS pid, pg_current_xact_id()::text AS xid,
            session_user::text AS "sessionUser", current_user::regrole::oid::text AS "roleOid",
            current_setting('is_superuser') AS "isSuperuser"
        `;
          assert.equal(identities.length, 1);
          const identity = identities[0];
          Object.assign(entry, { identity });
          assert.equal(identity.database, R5_SETMAT_DATABASE);
          assert.equal(identity.databaseOid, databaseOid);
          assert.equal(identity.role, R5_SETMAT_CALLER);
          assert.equal(identity.isSuperuser, 'off');
          assert(typeof identity.sessionUser === 'string' && identity.sessionUser.length > 0);
          assert(/^[1-9][0-9]*$/.test(identity.roleOid));
          emit(capture, { event: 'CALLBACK_IDENTITY', identity });
        }
        await beforeBody?.(tx);
        emit(capture, { event: 'BUSINESS_CALLBACK_STARTED', identity: entry?.identity });
        const result: unknown = await Reflect.apply(body, undefined, [tx]);
        if (capture?.rollbackPolicy)
          throw new Error('R5_ROLLBACK_ONLY_CALLBACK_RETURNED_WITHOUT_EXPECTED_AUDIT_SENTINEL');
        if (entry) entry.callback = 'FULFILLED';
        return result;
      } catch (error) {
        if (entry) entry.callback = 'REJECTED';
        if (capture) capture.error = error;
        throw error;
      } finally {
        if (entry && capture) {
          Object.assign(entry, { callbackEndedMs: performance.now() - capture.start });
          emit(capture, {
            event: 'CALLBACK_SETTLED',
            outcome: entry.callback,
            identity: entry.identity,
            callbackStartedMs: entry.callbackStartedMs,
            callbackEndedMs: entry.callbackEndedMs,
          });
        }
      }
    };
    pending++;
    let result: unknown;
    try {
      result = Reflect.apply(original, this, callArgs);
    } catch (error) {
      pending--;
      if (capture) {
        capture.error = error;
        capture.unknown = true;
      }
      throw error;
    }
    assert(result instanceof Promise, 'actual Prisma transaction must return a Promise');
    void result.then(
      () => {
        pending--;
        if (entry && capture)
          Object.assign(entry, {
            transactionPromise: 'FULFILLED',
            transactionSettledMs: performance.now() - capture.start,
          });
        emit(capture, {
          event: 'TRANSACTION_PROMISE_SETTLED',
          outcome: 'FULFILLED',
          identity: entry?.identity,
        });
      },
      (error: unknown) => {
        pending--;
        if (entry && capture)
          Object.assign(entry, {
            transactionPromise: 'REJECTED',
            transactionSettledMs: performance.now() - capture.start,
          });
        if (capture) capture.error = error;
        emit(capture, {
          event: 'TRANSACTION_PROMISE_SETTLED',
          outcome: 'REJECTED',
          identity: entry?.identity,
          sqlState: r5ServerError(error)?.sqlState,
        });
      },
    );
    return result;
  };
  Object.defineProperty(client, '$transaction', {
    configurable: true,
    writable: true,
    value: wrapper,
  });

  return {
    async withinCaller<T>(operation: () => Promise<T>): Promise<T> {
      assert(!active && !callerScope && pending === 0, 'overlapping caller scope refused');
      callerScope = true;
      try {
        return await operation();
      } finally {
        callerScope = false;
      }
    },
    async observe<T>(
      observer: PrismaClient,
      label: string,
      operation: () => Promise<T>,
      persist: (receipt: unknown) => string,
      rollbackPolicy?: R5RollbackObservationPolicy,
    ): Promise<R5ObservedAttempt<T>> {
      assert(!active && pending === 0, 'overlapping observations on one client are refused');
      const capture: Capture = {
        start: performance.now(),
        entries: [],
        unknown: false,
        label,
        rollbackPolicy,
      };
      const engine: unknown = Reflect.get(client, '_engine');
      assert(engine && typeof engine === 'object', 'actual Prisma engine is required');
      // A failed initial journal prevents this observation from starting work.
      emit(capture, { event: 'ENTRY_STARTED' });
      assert(!capture.unknown, 'progress journal unavailable before native work');
      const engineObservation = observeTestEngineTransactions(engine, undefined, (event) =>
        emit(capture, event),
      );
      active = capture;
      let clientResult: PromiseSettledResult<T>;
      try {
        clientResult = { status: 'fulfilled', value: await operation() };
      } catch (reason) {
        clientResult = { status: 'rejected', reason };
      } finally {
        active = undefined;
        engineObservation.restore();
      }
      const entrySettledMs = performance.now() - capture.start;
      emit(capture, { event: 'ENTRY_SETTLED', outcome: clientResult.status });
      const server: {
        identity: R5TransactionIdentity;
        status: string | null;
        observerPid: number;
      }[] = [];
      try {
        for (const entry of capture.entries) {
          assert(entry.identity, 'transaction identity was not observed');
          const rows = await observer.$queryRaw<
            { database: string; databaseOid: number; observerPid: number; status: string | null }[]
          >`
            SELECT current_database()::text AS database,
              (SELECT oid FROM pg_database WHERE datname=current_database())::int AS "databaseOid",
              pg_backend_pid() AS "observerPid", pg_xact_status(${entry.identity.xid}::xid8) AS status
          `;
          assert.equal(rows.length, 1);
          assert.equal(rows[0].database, R5_SETMAT_DATABASE);
          assert.equal(rows[0].databaseOid, databaseOid);
          assert.notEqual(rows[0].observerPid, entry.identity.pid);
          server.push({
            identity: entry.identity,
            status: rows[0].status,
            observerPid: rows[0].observerPid,
          });
          emit(capture, {
            event: 'INDEPENDENT_SERVER_STATUS',
            identity: entry.identity,
            observerPid: rows[0].observerPid,
            status: rows[0].status,
          });
        }
      } catch {
        capture.unknown = true;
      }
      const bridge = engineObservation.snapshot();
      const observationComplete = !capture.unknown && pending === 0 && bridge.status === 'COMPLETE';
      const databaseOutcome =
        capture.entries.length === 0 && bridge.phases.length === 0 && observationComplete
          ? 'NO_TRANSACTION'
          : !capture.unknown && server.length === capture.entries.length
            ? r5ServerOutcome(server.map((row) => row.status))
            : 'UNKNOWN';
      const serverError = r5ServerError(capture.error);
      const single = capture.entries.length === 1 ? capture.entries[0] : undefined;
      const configuredTimeoutMs =
        typeof single?.options.timeout === 'number' ? single.options.timeout : null;
      const configuredIsolationLevel =
        typeof single?.options.isolationLevel === 'string' ? single.options.isolationLevel : null;
      const evidenceRef = persist({
        label,
        rollbackPolicy,
        entry: { outcome: clientResult.status, elapsedMs: entrySettledMs },
        transactions: capture.entries,
        engine: bridge,
        server,
        databaseOutcome,
        observationComplete,
        serverError,
        configuredTimeoutMs,
        configuredIsolationLevel,
        observationEndedMs: performance.now() - capture.start,
      });
      return {
        client: clientResult,
        databaseOutcome,
        observationComplete,
        configuredTimeoutMs,
        configuredIsolationLevel,
        evidenceRef,
        serverError,
      };
    },
    restore() {
      assert(
        !active && !callerScope && pending === 0,
        'pending real transactions prevent adapter teardown',
      );
      assert.equal(
        Reflect.get(client, '$transaction'),
        wrapper,
        'transaction wrapper changed unexpectedly',
      );
      if (descriptor) Object.defineProperty(client, '$transaction', descriptor);
      else Reflect.deleteProperty(client, '$transaction');
    },
  };
}
