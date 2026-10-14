export const E4_DIAGNOSTIC_LIMITS = Object.freeze({
  purpose: 'DIAGNOSTIC_ONLY' as const,
  transactionMs: 90_000,
  processMs: 600_000,
  gracefulStopMs: 560_000,
  forcedStopMs: 590_000,
  standardTransactionMs: 30_000,
});
export const E4_DIAGNOSTIC_SCENARIOS = [
  'ordinary-1',
  'ordinary-100',
  'ordinary-500',
  'maximum',
  'lock-contention',
  'failure-retry',
] as const;
export type E4DiagnosticScenario = (typeof E4_DIAGNOSTIC_SCENARIOS)[number];
export function e4DiagnosticScenario(value: unknown): E4DiagnosticScenario {
  if (!E4_DIAGNOSTIC_SCENARIOS.includes(value as E4DiagnosticScenario))
    throw new Error('E4 finite diagnostic scenario refused');
  return value as E4DiagnosticScenario;
}
export type E4DiagnosticContext = Readonly<{
  purpose: 'DIAGNOSTIC_ONLY';
  scope: string;
  sourceHead: string;
  fixture: 'createMaximumE4Source' | 'createDiagnosticE4Source';
  scenario: E4DiagnosticScenario;
}>;

/** No URL or credential is retained or emitted. This is not an authorization grant. */
export function e4DiagnosticContext(input: {
  purpose: string;
  scope: string;
  sourceHead: string;
  databaseUrl: string;
  appEnv: string;
  scenario?: string;
}): E4DiagnosticContext {
  const scenario = e4DiagnosticScenario(input.scenario ?? 'maximum');
  if (
    input.purpose !== E4_DIAGNOSTIC_LIMITS.purpose ||
    input.appEnv !== 'test' ||
    !/^[0-9a-f]{40}$/u.test(input.sourceHead) ||
    input.scope !== 'app_test_w98'
  )
    throw new Error('E4 diagnostic purpose/source/scope refused');
  let url: URL;
  try {
    url = new URL(input.databaseUrl);
  } catch {
    throw new Error('E4 diagnostic target refused');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) ||
    url.pathname !== '/' + input.scope
  )
    throw new Error('E4 diagnostic target refused');
  return Object.freeze({
    purpose: 'DIAGNOSTIC_ONLY',
    scope: input.scope,
    sourceHead: input.sourceHead,
    fixture: scenario === 'maximum' ? 'createMaximumE4Source' : 'createDiagnosticE4Source',
    scenario,
  });
}

/** Test-process gate only: install after env loading, before Nest configuration; restore after close. */
export function installE4DiagnosticFixtureGate(
  context: E4DiagnosticContext,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (
    context.purpose !== 'DIAGNOSTIC_ONLY' ||
    context.scope !== 'app_test_w98' ||
    !E4_DIAGNOSTIC_SCENARIOS.includes(context.scenario) ||
    !/^[0-9a-f]{40}$/u.test(context.sourceHead) ||
    env.APP_ENV !== 'test' ||
    env.SRVF_E4_DIAGNOSTIC_PURPOSE !== 'DIAGNOSTIC_ONLY' ||
    env.SRVF_E4_W98 !== '1'
  )
    throw new Error('E4 diagnostic fixture gate context refused');
  const previous = env.ACTIVITY_V11_WORKFLOW_ENABLED;
  let restored = false;
  env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
  return () => {
    if (restored) return;
    restored = true;
    if (previous === undefined) delete env.ACTIVITY_V11_WORKFLOW_ENABLED;
    else env.ACTIVITY_V11_WORKFLOW_ENABLED = previous;
  };
}

/** One instance, one original prepare callback. No SQL, trigger, isolation or maxWait rewrite. */
export function installE4DiagnosticLimits<T extends object>(
  client: T,
  context: E4DiagnosticContext,
) {
  if (
    context.purpose !== 'DIAGNOSTIC_ONLY' ||
    context.scope !== 'app_test_w98' ||
    context.fixture !== 'createMaximumE4Source' ||
    context.scenario !== 'maximum' ||
    !/^[0-9a-f]{40}$/u.test(context.sourceHead)
  )
    throw new Error('E4 diagnostic context refused');
  const descriptor = Object.getOwnPropertyDescriptor(client, '$transaction');
  const original: unknown = Reflect.get(client, '$transaction');
  if (
    typeof original !== 'function' ||
    (descriptor && (!('value' in descriptor) || !descriptor.configurable))
  )
    throw new Error('E4 diagnostic transaction bridge unavailable');
  let calls = 0,
    restored = false,
    ownership = true;
  const wrapper = function (this: unknown, ...args: unknown[]) {
    const options = args[1];
    if (
      this !== adapter ||
      restored ||
      calls !== 0 ||
      args.length !== 2 ||
      typeof args[0] !== 'function' ||
      !options ||
      typeof options !== 'object' ||
      Reflect.get(options, 'timeout') !== 30_000
    )
      throw new Error('E4 diagnostic only accepts one original30 prepare transaction');
    calls++;
    if (Reflect.get(client, '$transaction') !== original)
      throw new Error('E4 diagnostic client ownership changed');
    return Reflect.apply(original, client, [
      args[0],
      { ...options, timeout: E4_DIAGNOSTIC_LIMITS.transactionMs },
    ]);
  };
  // The generated Prisma client is itself a proxy: never add/delete its properties.
  const adapter = new Proxy(client, {
    get: (target, key) =>
      key === '$transaction' && !restored ? wrapper : Reflect.get(target, key, target),
  });
  return {
    client: adapter,
    snapshot: () => ({
      purpose: context.purpose,
      acceptance: 'NOT_AN_ACCEPTANCE_RESULT' as const,
      requestedTransactionMs: 30_000,
      actualTransactionMs: 90_000,
      calls,
      restored,
      ownership,
    }),
    restore: () => {
      if (restored) return;
      restored = true;
      ownership = Reflect.get(client, '$transaction') === original;
    },
  };
}

export type E4DiagnosticChild = {
  onClose: (callback: (code: number | null) => void) => void;
  signal: (signal: 'SIGTERM' | 'SIGKILL') => void;
  groupAlive: () => boolean;
};

/** Transparent engine observation. Never change options, retain transaction IDs or error text. */
export function observeE4DiagnosticTransactionLifetime(
  engine: object,
  clock = () => performance.now(),
) {
  const original: unknown = Reflect.get(engine, 'transaction');
  const descriptor = Object.getOwnPropertyDescriptor(engine, 'transaction');
  if (typeof original !== 'function' || (descriptor && !descriptor.configurable))
    throw new Error('E4 diagnostic engine observation unavailable');
  const transactions: {
    timeoutMs: number | null;
    transactionMs: number;
    workAndWaitMs: number;
    terminalMs: number;
    terminal: 'commit' | 'rollback';
    outcome: 'OK' | 'ERROR';
  }[] = [];
  let active: { started: number; timeoutMs: number | null } | undefined;
  let pending = 0,
    unknown = false,
    restored = false;
  const tick = () => {
    let value = 0;
    try {
      value = clock();
    } catch {
      unknown = true;
    }
    if (!Number.isFinite(value) || value < 0) {
      unknown = true;
      return 0;
    }
    return value;
  };
  const wrapper = function (this: unknown, ...args: unknown[]) {
    const phase = args[0];
    const started = tick();
    const options = args[2];
    const timeout: unknown =
      options && typeof options === 'object' ? Reflect.get(options, 'timeout') : undefined;
    const result: unknown = Reflect.apply(original, this, args);
    if (!(result instanceof Promise)) {
      unknown = true;
      return result;
    }
    pending++;
    const settle = (ok: boolean) => {
      pending--;
      const ended = tick();
      if (phase === 'start') {
        if (!ok || active) {
          unknown = true;
          return;
        }
        active = {
          started: ended,
          timeoutMs:
            typeof timeout === 'number' &&
            Number.isInteger(timeout) &&
            timeout > 0 &&
            timeout <= 90000
              ? timeout
              : null,
        };
      } else if (phase === 'commit' || phase === 'rollback') {
        if (!active || transactions.length >= 32 || started < active.started || ended < started) {
          unknown = true;
          return;
        }
        transactions.push({
          timeoutMs: active.timeoutMs,
          transactionMs: ended - active.started,
          workAndWaitMs: started - active.started,
          terminalMs: ended - started,
          terminal: phase,
          outcome: ok ? 'OK' : 'ERROR',
        });
        active = undefined;
      } else unknown = true;
    };
    void result.then(
      () => {
        try {
          settle(true);
        } catch {
          unknown = true;
        }
      },
      () => {
        try {
          settle(false);
        } catch {
          unknown = true;
        }
      },
    );
    return result;
  };
  Object.defineProperty(engine, 'transaction', {
    configurable: true,
    writable: true,
    value: wrapper,
    enumerable: descriptor?.enumerable ?? false,
  });
  return {
    snapshot: () => ({
      status:
        unknown || pending || active || !restored ? ('UNKNOWN' as const) : ('COMPLETE' as const),
      transactions: transactions.map((row) => ({ ...row })),
    }),
    restore: () => {
      if (restored) return;
      restored = true;
      if (Reflect.get(engine, 'transaction') !== wrapper) {
        unknown = true;
        return;
      }
      if (descriptor) Object.defineProperty(engine, 'transaction', descriptor);
      else Reflect.deleteProperty(engine, 'transaction');
    },
  };
}

const diagnosticStages = [
  'GUARD',
  'FIXTURE_BOOTSTRAP',
  'SOURCE_BUILD',
  'PREPARE',
  'ORACLE',
  'SUBMIT',
  'FIRST_REVIEW',
  'FINAL_REVIEW',
  'LEDGER',
  'ROLLBACK',
  'RETRY',
  'REPLAY',
  'CLEANUP',
] as const;
const diagnosticErrors = [
  'NONE',
  'REFUSED',
  'STARTUP_FAILED',
  'INITIALIZATION_FAILED',
  'CLEANUP_FAILED',
  'ASSERTION_FAILED',
  'P2028',
  'P2010',
  'P2002',
  'P2003',
  'UNKNOWN',
  'OUTPUT_INVALID',
  'DEADLINE',
] as const;
type DiagnosticStage = (typeof diagnosticStages)[number];
type DiagnosticError = (typeof diagnosticErrors)[number];
type StageEvent = {
  stage: DiagnosticStage;
  outcome: 'ENTER' | 'COMPLETE' | 'FAILED';
  errorCategory: DiagnosticError;
};
type StageReceipt = {
  schema: 'e4-prepare-stage/v1';
  head: string;
  run: string;
  events: StageEvent[];
};

/** Fixed enums only: never retain an error message, stack, URL, SQL or environment. */
export function e4DiagnosticErrorCategory(
  error: unknown,
  fallback: DiagnosticError = 'UNKNOWN',
): DiagnosticError {
  try {
    if (error && typeof error === 'object') {
      const code: unknown = Reflect.get(error, 'code');
      if (typeof code === 'string' && ['P2028', 'P2010', 'P2002', 'P2003'].includes(code))
        return code as DiagnosticError;
      const name: unknown = Reflect.get(error, 'name');
      if (typeof name === 'string' && ['AssertionError', 'JestAssertionError'].includes(name))
        return 'ASSERTION_FAILED';
    }
  } catch {
    /* Hostile error getters cannot add raw data or replace the fallback. */
  }
  return fallback;
}
export function e4DiagnosticStageReceipt(
  head: string,
  run: string,
  write: (receipt: StageReceipt) => void,
) {
  const events: StageEvent[] = [];
  const snapshot = (): StageReceipt => ({
    schema: 'e4-prepare-stage/v1',
    head,
    run,
    events: events.map((event) => ({ ...event })),
  });
  const mark = (
    stage: DiagnosticStage,
    outcome: StageEvent['outcome'],
    errorCategory: DiagnosticError = 'NONE',
  ) => {
    if (
      events.length >= 40 ||
      !diagnosticStages.includes(stage) ||
      !diagnosticErrors.includes(errorCategory) ||
      !['ENTER', 'COMPLETE', 'FAILED'].includes(outcome)
    )
      throw new Error('E4 stage receipt refused');
    events.push({ stage, outcome, errorCategory });
    write(snapshot());
  };
  return {
    mark,
    snapshot,
    lastStage: () => events.at(-1)?.stage ?? 'GUARD',
    start: <T>(stage: DiagnosticStage, work: () => T, fallback: DiagnosticError): T => {
      mark(stage, 'ENTER');
      try {
        return work();
      } catch (error) {
        mark(stage, 'FAILED', e4DiagnosticErrorCategory(error, fallback));
        throw error;
      }
    },
  };
}
/** Reconstruct only allowed fields, even when child.json never existed. Not an acceptance verdict. */
export function readE4DiagnosticStageReceipt(
  value: unknown,
  head: string,
  run: string,
  exitCode: number | null,
  stopped = false,
) {
  const invalid = () => ({
    receiptStatus: 'UNKNOWN' as const,
    lastStage: 'GUARD' as DiagnosticStage,
    lastOutcome: 'ENTER',
    failureStage: null as DiagnosticStage | null,
    errorCategory: 'OUTPUT_INVALID' as DiagnosticError,
    events: [] as StageEvent[],
  });
  if (
    !value ||
    typeof value !== 'object' ||
    Reflect.get(value, 'schema') !== 'e4-prepare-stage/v1' ||
    Reflect.get(value, 'head') !== head ||
    Reflect.get(value, 'run') !== run
  )
    return invalid();
  const rows: unknown = Reflect.get(value, 'events');
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 40) return invalid();
  const events: StageEvent[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') return invalid();
    const stage: unknown = Reflect.get(row, 'stage'),
      outcome: unknown = Reflect.get(row, 'outcome'),
      error: unknown = Reflect.get(row, 'errorCategory');
    if (
      !diagnosticStages.includes(stage as DiagnosticStage) ||
      !['ENTER', 'COMPLETE', 'FAILED'].includes(outcome as string) ||
      !diagnosticErrors.includes(error as DiagnosticError)
    )
      return invalid();
    events.push({
      stage: stage as DiagnosticStage,
      outcome: outcome as StageEvent['outcome'],
      errorCategory: error as DiagnosticError,
    });
  }
  const last = events.at(-1)!;
  const failed = events.find((event) => event.outcome === 'FAILED');
  const failureStage = failed?.stage ?? (stopped || exitCode !== 0 ? last.stage : null);
  const errorCategory: DiagnosticError = stopped
    ? 'DEADLINE'
    : (failed?.errorCategory ??
      (exitCode === 0
        ? 'NONE'
        : last.stage === 'GUARD'
          ? 'STARTUP_FAILED'
          : last.stage === 'FIXTURE_BOOTSTRAP'
            ? 'INITIALIZATION_FAILED'
            : last.stage === 'CLEANUP'
              ? 'CLEANUP_FAILED'
              : 'UNKNOWN'));
  return {
    receiptStatus: failureStage ? ('FAILED' as const) : ('OBSERVED' as const),
    lastStage: last.stage,
    lastOutcome: last.outcome,
    failureStage,
    errorCategory,
    events,
  };
}
type DeadlineTimers = {
  after: (milliseconds: number, callback: () => void) => unknown;
  clear: (handle: unknown) => void;
};

/** Independent parent watchdog. Work is stopped before600s; success requires the whole owned group gone. */
export function superviseE4DiagnosticChild(
  child: E4DiagnosticChild,
  timers: DeadlineTimers = {
    after: (ms, callback) => setTimeout(callback, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
) {
  return new Promise<{ exitCode: number | null; stopped: boolean; cleanupConfirmed: boolean }>(
    (resolve) => {
      const handles: unknown[] = [];
      let done = false,
        closed = false,
        code: number | null = null,
        stopped = false;
      const finish = (cleanupConfirmed: boolean) => {
        if (done) return;
        done = true;
        for (const handle of handles) timers.clear(handle);
        resolve({ exitCode: code, stopped, cleanupConfirmed });
      };
      const signal = (kind: 'SIGTERM' | 'SIGKILL') => {
        stopped = true;
        try {
          child.signal(kind);
        } catch {
          /* Final liveness check must still refuse success. */
        }
      };
      const check = () => {
        if (done) return;
        let alive = true;
        try {
          alive = child.groupAlive();
        } catch {
          /* Unknown is not cleaned. */
        }
        if (closed && !alive) {
          finish(true);
          return;
        }
        if (closed) {
          signal('SIGKILL');
          handles.push(timers.after(100, check));
        }
      };
      child.onClose((exitCode) => {
        closed = true;
        code = exitCode;
        check();
      });
      if (done) return;
      handles.push(timers.after(E4_DIAGNOSTIC_LIMITS.gracefulStopMs, () => signal('SIGTERM')));
      handles.push(timers.after(E4_DIAGNOSTIC_LIMITS.forcedStopMs, () => signal('SIGKILL')));
      handles.push(
        timers.after(E4_DIAGNOSTIC_LIMITS.processMs, () => {
          signal('SIGKILL');
          let alive = true;
          try {
            alive = child.groupAlive();
          } catch {
            /* Refuse a cleanup claim. */
          }
          finish(closed && !alive);
        }),
      );
    },
  );
}
