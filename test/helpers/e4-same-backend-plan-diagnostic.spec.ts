import {
  E4SameBackendPlanDiagnostic,
  projectE4NestedPlan,
  projectE4ServerLogs,
} from './e4-same-backend-plan-diagnostic';
import { e4DiagnosticContext, installE4DiagnosticLimits } from './e4-diagnostic-limits-client';

const scope = 'app_test_w98';
const context = e4DiagnosticContext({
  purpose: 'DIAGNOSTIC_ONLY',
  appEnv: 'test',
  scope,
  sourceHead: 'a'.repeat(40),
  databaseUrl: 'postgresql://synthetic:private@localhost/app_test_w98',
});
const node = {
  'Node Type': 'Aggregate',
  'Actual Rows': 1,
  'Actual Loops': 1,
  'Plan Rows': 1,
  'Plan Width': 4,
  'Temp Written Blocks': 2,
  Filter: 'secret sentinel',
  'Relation Name': 'private relation',
};
const document = {
  'Query Text': 'SELECT e4_source_rows($1) /* secret sentinel */',
  'Query Parameters': { $1: 'secret sentinel' },
  Plan: { ...node, Plans: [{ ...node, 'Node Type': 'Seq Scan' }] },
  Triggers: [
    { 'Trigger Name': 'e4_evaluation_set_guard', Calls: 1, Time: 900, private: 'secret sentinel' },
  ],
};
const log = (pid = 81, value: unknown = document, duration = '900.500') =>
  `2026-10-13 17:00:00.000 UTC [${pid}] LOG:  duration: ${duration} ms  plan:\n${JSON.stringify(value, null, 2)}\n`;
const initial = () => [
  {
    pid: 81,
    scope: true,
    version: true,
    allowed: true,
    logFormat: true,
    activity: true,
    disabled: true,
    catalog: true,
  },
];
const restored = () => [{ pid: 81, scope: true, restored: true }];
const observation = {
  scope: true,
  state: 'idle',
  type: 'NONE',
  event: 'NONE',
  blockers: 0,
  noTransaction: true,
};

function fixture(patch: Record<string, unknown> = {}) {
  const tx = {
    $queryRawUnsafe: jest.fn(
      async (sql: string): Promise<Record<string, unknown>[]> =>
        sql.includes(' AS configured') ? [{ pid: 81, scope: true, configured: true }] : initial(),
    ),
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
  };
  const db = {
    $queryRawUnsafe: jest.fn().mockResolvedValue(restored()),
    $transaction: jest.fn(
      async (work: (client: typeof tx) => Promise<unknown>, options: { timeout: number }) => {
        expect(options.timeout).toBe(90000);
        return work(tx);
      },
    ),
  };
  const limits = installE4DiagnosticLimits(db, context);
  const observe = jest.fn().mockResolvedValue([{ ...observation }]);
  const logs = jest.fn().mockResolvedValue(log());
  const diagnostic = new E4SameBackendPlanDiagnostic(limits.client, context, {
    observe,
    logs,
    pause: () => new Promise<void>((resolve) => setTimeout(resolve, 1)),
    ...patch,
  });
  const work = jest.fn().mockResolvedValue({ original: 'business result' });
  const run = () =>
    diagnostic.client.$transaction(work, {
      timeout: 30000,
      maxWait: 2000,
      isolationLevel: 'ReadCommitted',
    } as { timeout: number });
  return { tx, db, limits, observe, logs, diagnostic, work, run };
}

describe('same-backend prepare plans (offline; no Docker/DB)', () => {
  it('projects only fixed numeric fields and preserves plan-node parents without source/parameter text', () => {
    const result = projectE4NestedPlan(document, 900.5);
    expect(result.role).toBe('SOURCE_CHECK');
    expect(result.nodes.map((n) => n.parent)).toEqual([null, 0]);
    expect(result.triggers).toEqual([{ role: 'EVALUATION_SET', calls: 1, timeMs: 900 }]);
    expect(JSON.stringify(result)).not.toMatch(
      /secret sentinel|private relation|Query|Filter|Parameters/,
    );
  });
  it('parses the real PG16 object layout, ignores other PIDs and handles JSON escapes/braces', () => {
    const input = {
      ...document,
      'Query Text': "SELECT e4_source_rows($1), 'escaped { } \\\" text'",
    };
    expect(projectE4ServerLogs(log(82) + log(81, input), 81)).toHaveLength(1);
    expect(projectE4ServerLogs(log(81, input), 81)[0].durationMs).toBe(900.5);
  });
  it('preserves unmeasured trigger time as null with TIMING OFF, without fabricating zero', () => {
    const { Time, ...trigger } = document.Triggers[0];
    expect(Time).toBe(900);
    const result = projectE4ServerLogs(log(81, { ...document, Triggers: [trigger] }), 81);
    expect(result[0].triggers).toEqual([{ role: 'EVALUATION_SET', calls: 1, timeMs: null }]);
    expect(JSON.stringify(result)).not.toContain('secret sentinel');
  });
  it.each([null, -1, '900', NaN, Infinity, 600001])(
    'still refuses invalid present trigger time %s',
    (Time) => {
      expect(() =>
        projectE4NestedPlan({ ...document, Triggers: [{ ...document.Triggers[0], Time }] }, 1),
      ).toThrow('E4_PLAN_NUMBER');
    },
  );
  it.each([
    log(82),
    log().slice(0, -8),
    log(81, [document]),
    log(81, { ...document, Plan: { ...node, 'Actual Rows': -1 } }),
    log(81, { ...document, Plan: { ...node, 'Actual Loops': '1' } }),
    log(81, document, 'NaN'),
  ])('refuses missing, truncated, wrong shape or nonnumeric telemetry', (value) => {
    expect(() => projectE4ServerLogs(value, 81)).toThrow();
  });
  it('rejects an interrupted matching frame and bounded-output/input overflow', () => {
    expect(() => projectE4ServerLogs(log().slice(0, -8) + '\n' + log(), 81)).toThrow(
      'E4_LOG_UNCLOSED',
    );
    expect(() => projectE4ServerLogs(log().repeat(33), 81)).toThrow('E4_LOG_OUTPUT');
    expect(() => projectE4ServerLogs('x'.repeat(2 * 1024 * 1024 + 1), 81)).toThrow('E4_LOG_INPUT');
    expect(() =>
      projectE4NestedPlan(
        { ...document, Plan: { ...node, Plans: Array.from({ length: 256 }, () => node) } },
        1,
      ),
    ).toThrow('E4_PLAN_NODES');
  });
  it('composes the real90 adapter above exactly one original30 callback without changing options or result', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toEqual({ original: 'business result' });
    expect(f.work).toHaveBeenCalledTimes(1);
    expect(f.work).toHaveBeenCalledWith(f.tx);
    expect(f.db.$transaction.mock.calls[0][1]).toMatchObject({
      timeout: 90000,
      maxWait: 2000,
      isolationLevel: 'ReadCommitted',
    });
    const commands: unknown[] = f.tx.$executeRawUnsafe.mock.calls.map((args) => args[0]);
    expect(commands).toHaveLength(9);
    expect(commands[0]).toBe("LOAD 'auto_explain'");
    expect(commands[1]).toBe('SET LOCAL auto_explain.log_parameter_max_length=0');
    expect(commands[8]).toBe("SET LOCAL auto_explain.log_min_duration='250ms'");
    expect(
      commands.every(
        (c) =>
          typeof c === 'string' && !/\b(?:ALTER|GRANT|ROLE|ANALYZE|timeout|work_mem)\b/iu.test(c),
      ),
    ).toBe(true);
    expect(f.tx.$executeRawUnsafe.mock.invocationCallOrder.at(-1)).toBeLessThan(
      f.work.mock.invocationCallOrder[0],
    );
    expect(f.diagnostic.snapshot()).toMatchObject({
      status: 'OBSERVED',
      setupReason: 'NONE',
      logReason: 'NONE',
      sameBackendAndSettingsRestored: true,
      terminal: 'IDLE_NO_TX',
      nestedTotalsAdditive: false,
      crossStatementParents: 'UNOBSERVED',
    });
    await expect(f.run()).rejects.toThrow('E4_PLAN_ONCE');
    expect(f.db.$transaction).toHaveBeenCalledTimes(1);
    expect(f.limits.snapshot().actualTransactionMs).toBe(90000);
  });
  it.each([
    ['scope', 'PREFLIGHT_SCOPE'],
    ['version', 'PREFLIGHT_VERSION'],
    ['allowed', 'PREFLIGHT_ROLE'],
    ['logFormat', 'PREFLIGHT_LOG_FORMAT'],
    ['activity', 'PREFLIGHT_ACTIVITY'],
    ['disabled', 'PREFLIGHT_DISABLED'],
    ['catalog', 'PREFLIGHT_CATALOG'],
  ])('refuses%s before LOAD or business', async (key, setupReason) => {
    const f = fixture();
    f.tx.$queryRawUnsafe.mockResolvedValue([{ ...initial()[0], [key]: false }]);
    await expect(f.run()).rejects.toThrow('E4_SAME_BACKEND_DIAGNOSTIC_UNKNOWN');
    expect(f.tx.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(f.work).not.toHaveBeenCalled();
    expect(f.diagnostic.snapshot()).toMatchObject({
      status: 'UNKNOWN',
      reason: 'SETUP',
      setupReason,
    });
  });
  it('reports the PostgreSQL-folded preflight field without retaining the returned row', async () => {
    const f = fixture();
    const { logFormat, ...row } = initial()[0];
    f.tx.$queryRawUnsafe.mockResolvedValue([{ ...row, logformat: logFormat }]);
    await expect(f.run()).rejects.toThrow('E4_SAME_BACKEND_DIAGNOSTIC_UNKNOWN');
    expect(f.tx.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(f.work).not.toHaveBeenCalled();
    expect(f.diagnostic.snapshot()).toMatchObject({
      reason: 'SETUP',
      setupReason: 'PREFLIGHT_LOG_FORMAT',
    });
    expect(JSON.stringify(f.diagnostic.snapshot())).not.toContain('logformat');
  });
  it.each([
    [[], 'PREFLIGHT_SHAPE'],
    [[{ ...initial()[0], pid: 0 }], 'PREFLIGHT_PID'],
  ])('classifies an invalid preflight shape or PID before business', async (rows, setupReason) => {
    const f = fixture();
    f.tx.$queryRawUnsafe.mockResolvedValue(rows);
    await expect(f.run()).rejects.toThrow('E4_SAME_BACKEND_DIAGNOSTIC_UNKNOWN');
    expect(f.work).not.toHaveBeenCalled();
    expect(f.diagnostic.snapshot()).toMatchObject({ reason: 'SETUP', setupReason });
  });
  it('classifies a preflight read failure without retaining its raw exception', async () => {
    const f = fixture();
    f.tx.$queryRawUnsafe.mockRejectedValue(new Error('secret sentinel read detail'));
    await expect(f.run()).rejects.toThrow('E4_SAME_BACKEND_DIAGNOSTIC_UNKNOWN');
    expect(f.work).not.toHaveBeenCalled();
    expect(f.diagnostic.snapshot()).toMatchObject({
      reason: 'SETUP',
      setupReason: 'PREFLIGHT_QUERY',
    });
    expect(JSON.stringify(f.diagnostic.snapshot())).not.toContain('secret sentinel');
  });
  it('closes a LOAD/settings permission failure without echoing the original error', async () => {
    const f = fixture();
    f.tx.$executeRawUnsafe.mockRejectedValue(new Error('secret sentinel permission detail'));
    await expect(f.run()).rejects.toThrow('E4_SAME_BACKEND_DIAGNOSTIC_UNKNOWN');
    expect(f.work).not.toHaveBeenCalled();
    expect(f.logs).not.toHaveBeenCalled();
    expect(f.diagnostic.snapshot()).toMatchObject({ setupReason: 'LOAD' });
    expect(JSON.stringify(f.diagnostic.snapshot())).not.toContain('secret sentinel');
  });
  it('distinguishes a setting failure from LOAD without retaining SQL or errors', async () => {
    const f = fixture();
    f.tx.$executeRawUnsafe
      .mockResolvedValueOnce(0)
      .mockRejectedValue(new Error('secret sentinel setting detail'));
    await expect(f.run()).rejects.toThrow('E4_SAME_BACKEND_DIAGNOSTIC_UNKNOWN');
    expect(f.work).not.toHaveBeenCalled();
    expect(f.diagnostic.snapshot()).toMatchObject({ reason: 'SETUP', setupReason: 'SETTINGS' });
    expect(JSON.stringify(f.diagnostic.snapshot())).not.toContain('secret sentinel');
  });
  it('distinguishes configuration read failure from configuration refusal', async () => {
    const f = fixture();
    f.tx.$queryRawUnsafe
      .mockResolvedValueOnce(initial())
      .mockRejectedValue(new Error('secret sentinel configuration detail'));
    await expect(f.run()).rejects.toThrow('E4_SAME_BACKEND_DIAGNOSTIC_UNKNOWN');
    expect(f.work).not.toHaveBeenCalled();
    expect(f.diagnostic.snapshot()).toMatchObject({
      reason: 'SETUP',
      setupReason: 'CONFIGURATION_QUERY',
    });
    expect(JSON.stringify(f.diagnostic.snapshot())).not.toContain('secret sentinel');
  });
  it('refuses mismatched actual settings or a backend switch before business execution', async () => {
    const f = fixture();
    f.tx.$queryRawUnsafe.mockImplementation(async (sql: string) =>
      sql.includes(' AS configured') ? [{ pid: 82, scope: true, configured: true }] : initial(),
    );
    await expect(f.run()).rejects.toThrow('E4_SAME_BACKEND_DIAGNOSTIC_UNKNOWN');
    expect(f.work).not.toHaveBeenCalled();
    expect(f.diagnostic.snapshot()).toMatchObject({ setupReason: 'CONFIGURATION_CHECK' });
  });
  it('does not convert a successful committed business result into failure when log capture fails', async () => {
    const f = fixture({
      logs: async () => {
        throw new Error('secret sentinel raw Docker stderr');
      },
    });
    await expect(f.run()).resolves.toEqual({ original: 'business result' });
    expect(f.diagnostic.snapshot()).toMatchObject({
      status: 'UNKNOWN',
      reason: 'LOG',
      logReason: 'READ',
      terminal: 'IDLE_NO_TX',
    });
    expect(JSON.stringify(f.diagnostic.snapshot())).not.toContain('secret sentinel');
  });
  it('rejects a lookalike error prefix carrying private text', async () => {
    const f = fixture({
      logs: async () => {
        throw new Error('E4_PLAN_NUMBER secret sentinel');
      },
    });
    await expect(f.run()).resolves.toEqual({ original: 'business result' });
    expect(f.diagnostic.snapshot()).toMatchObject({ reason: 'LOG', logReason: 'READ' });
    expect(JSON.stringify(f.diagnostic.snapshot())).not.toContain('secret sentinel');
  });
  it.each([
    ['MISSING', () => log(82)],
    ['JSON', () => log().replace('"Query Text":', '"Query Text" secret sentinel:')],
    ['PLAN_NUMBER', () => log(81, { ...document, Triggers: [{ Calls: 'private' }] })],
    ['HOTSPOT_COVERAGE', () => log(81, { ...document, 'Query Text': 'SELECT 1' })],
  ])(
    'classifies actual parser/coverage failure %s without SQL or exception text',
    async (logReason, logs) => {
      const f = fixture({ logs: async () => logs() });
      await expect(f.run()).resolves.toEqual({ original: 'business result' });
      expect(f.diagnostic.snapshot()).toMatchObject({
        status: 'UNKNOWN',
        reason: 'LOG',
        logReason,
      });
      expect(JSON.stringify(f.diagnostic.snapshot())).not.toMatch(/secret sentinel|private/);
    },
  );
  it('closes hostile error getters and arbitrary parser exceptions without exporting text', async () => {
    const f = fixture({
      logs: async () => {
        const error = new Error();
        Object.defineProperty(error, 'message', {
          get() {
            throw new Error('private');
          },
        });
        throw error;
      },
    });
    await expect(f.run()).resolves.toEqual({ original: 'business result' });
    expect(f.diagnostic.snapshot()).toMatchObject({ reason: 'LOG', logReason: 'READ' });
    const wrong = fixture({ logs: async () => undefined });
    await wrong.run();
    expect(wrong.diagnostic.snapshot()).toMatchObject({ reason: 'LOG', logReason: 'UNKNOWN' });
    expect(JSON.stringify([f.diagnostic.snapshot(), wrong.diagnostic.snapshot()])).not.toContain(
      'private',
    );
  });
  it('records original transaction settlement before the separately bounded log capture completes', async () => {
    let finish!: () => void, entered!: () => void;
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const f = fixture({
      logs: async () => {
        entered();
        await release;
        return log();
      },
    });
    const result = f.run();
    await started;
    expect(f.diagnostic.snapshot().costs.transactionWallMs).toEqual(expect.any(Number));
    expect(f.diagnostic.snapshot().costs.callbackMs).toEqual(expect.any(Number));
    expect(f.diagnostic.snapshot().costs.collectionMs).toBeNull();
    finish();
    await result;
    expect(f.diagnostic.snapshot().costs.collectionMs).toEqual(expect.any(Number));
  });
  it.each([
    { pid: 82, scope: true, restored: true },
    { pid: 81, scope: false, restored: true },
    { pid: 81, scope: true, restored: false },
  ])('marks backend switches or settings restoration failures UNKNOWN', async (row) => {
    const f = fixture();
    f.db.$queryRawUnsafe.mockResolvedValue([row]);
    await expect(f.run()).resolves.toEqual({ original: 'business result' });
    expect(f.diagnostic.snapshot()).toMatchObject({ status: 'UNKNOWN', reason: 'RESTORE' });
    expect(f.logs).not.toHaveBeenCalled();
  });
  it('records only fixed wait enums/blocker counts and marks wrong observer scope UNKNOWN', async () => {
    const f = fixture();
    f.observe.mockResolvedValueOnce([
      {
        ...observation,
        state: 'active',
        type: 'Lock',
        event: 'advisory',
        blockers: 2,
        noTransaction: false,
      },
    ]);
    await f.run();
    expect(f.diagnostic.snapshot().waitTypes.Lock).toBe(1);
    expect(f.diagnostic.snapshot().maxBlockers).toBe(2);
    const wrong = fixture();
    wrong.observe.mockResolvedValue([{ ...observation, scope: false }]);
    await wrong.run();
    expect(wrong.diagnostic.snapshot().status).toBe('UNKNOWN');
  });
  it('preserves the original business error and still collects after the original rollback', async () => {
    const f = fixture(),
      error = new Error('original business error');
    f.work.mockRejectedValue(error);
    await expect(f.run()).rejects.toBe(error);
    expect(f.diagnostic.snapshot()).toMatchObject({ status: 'OBSERVED', terminal: 'IDLE_NO_TX' });
  });
  it('does not call an absence of the source/expected hotspot coverage a successful observation', async () => {
    const f = fixture({ logs: async () => log(81, { ...document, 'Query Text': 'SELECT 1' }) });
    await f.run();
    expect(f.diagnostic.snapshot()).toMatchObject({ status: 'UNKNOWN', reason: 'LOG' });
  });
});
