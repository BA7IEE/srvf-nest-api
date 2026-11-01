import {
  createR5MainFunctionStats,
  functionCounterDeltas,
  R5_FUNCTION_STATS_CALIBRATION_SQL,
  R5_FUNCTION_STATS_CONTROL_SQL,
  R5_FUNCTION_STATS_ENABLE_SQL,
  R5_FUNCTION_STATS_SNAPSHOT_SQL,
  probeR5MainFunctionStatsReadOnly,
} from './r5-main-function-stats';

// Pure protocol model; never connects to PostgreSQL or proves a native outcome.
function model() {
  const seen: string[] = [];
  const control: Record<string, unknown> = {
    database: 'app_test_r5_setmat_20261029_q1',
    databaseOid: 1998913,
    cluster: '7695840193603043362',
    pid: 55,
    xid: null,
    role: 'postgres',
    sessionUser: 'postgres',
    readOnly: 'off',
    trackFunctions: 'none',
    statementTimeout: '0',
    lockTimeout: '4s',
    planCacheMode: 'auto',
    workMem: '4MB',
    canonicalOid: 101,
    canonicalCalls: null,
  };
  const counters = [
    {
      oid: 101,
      identity: 'astr_canonical_json(jsonb)',
      language: 'plpgsql',
      hasConfig: false,
      recorded: false,
      calls: null as string | null,
      totalMs: null as number | null,
      selfMs: null as number | null,
    },
    {
      oid: 102,
      identity: 'e4_evaluation_set_guard()',
      language: 'plpgsql',
      hasConfig: true,
      recorded: false,
      calls: null as string | null,
      totalMs: null as number | null,
      selfMs: null as number | null,
    },
    {
      oid: 103,
      identity: 'e4_database_created_at()',
      language: 'plpgsql',
      hasConfig: true,
      recorded: false,
      calls: null as string | null,
      totalMs: null as number | null,
      selfMs: null as number | null,
    },
  ];
  let calibrationWorks = true;
  const increment = (oid: number, count: number, totalMs: number, selfMs: number) => {
    const c = counters.find((f) => f.oid === oid)!;
    c.recorded = true;
    c.calls = (BigInt(c.calls ?? '0') + BigInt(count)).toString();
    c.totalMs = (c.totalMs ?? 0) + totalMs;
    c.selfMs = (c.selfMs ?? 0) + selfMs;
  };
  const tx = {
    async $queryRawUnsafe(sql: string) {
      seen.push(sql);
      if (sql === R5_FUNCTION_STATS_CONTROL_SQL) return [{ observation: { ...control } }];
      if (sql === R5_FUNCTION_STATS_ENABLE_SQL) {
        control.trackFunctions = 'all';
        return [{ enabled: 'all' }];
      }
      if (sql === R5_FUNCTION_STATS_CALIBRATION_SQL) {
        if (calibrationWorks) increment(101, 1, 0.1, 0.1);
        return [{ calibration: '{"r5_function_stats_probe":55}' }];
      }
      if (sql === R5_FUNCTION_STATS_SNAPSHOT_SQL)
        return [
          {
            observation: { ...control, at: 'synthetic-time', functions: structuredClone(counters) },
          },
        ];
      throw new Error('unexpected diagnostic SQL');
    },
  };
  return {
    seen,
    control,
    counters,
    increment,
    tx,
    disableCalibration: () => {
      calibrationWorks = false;
    },
  };
}

it('arms statistics before business work without assigning an XID or changing native budgets', async () => {
  const m = model(),
    s = createR5MainFunctionStats();
  await s.enable(m.tx);
  expect(m.seen).toEqual([
    R5_FUNCTION_STATS_CONTROL_SQL,
    R5_FUNCTION_STATS_ENABLE_SQL,
    R5_FUNCTION_STATS_CALIBRATION_SQL,
    R5_FUNCTION_STATS_SNAPSHOT_SQL,
  ]);
  expect(m.control.xid).toBeNull();
  expect(m.control.statementTimeout).toBe('0');
  expect(s.snapshot().calibrated).toBe(true);
  expect(R5_FUNCTION_STATS_ENABLE_SQL).toContain("'all',true");
});

it('calls the original once, preserves its result, and captures new row/statement function counters', async () => {
  const m = model(),
    s = createR5MainFunctionStats(),
    result = { inserted: 8000 };
  await s.enable(m.tx);
  m.control.xid = '900';
  const native = jest.fn(async () => {
    m.increment(103, 8000, 150, 150);
    m.increment(102, 1, 25000, 100);
    return result;
  });
  expect(await s.observe(m.tx, 'EVALUATION_INSERT', 'frozen-sql-fingerprint', native)).toBe(result);
  expect(native).toHaveBeenCalledTimes(1);
  const p = s.snapshot();
  expect(p.complete).toBe(false); // The required original barrier has not run.
  expect(p.requiredTargets.originalConstraintBarrier.status).toBe('NOT_OBSERVED');
  expect(p.segments[0].deltas?.find((f) => f.oid === 103)?.calls).toBe('8000');
  expect(p.segments[0].deltas?.find((f) => f.oid === 102)?.calls).toBe('1');
  expect(p.segments[0].before?.xid).toBe('900');
});

it('only marks full coverage after both original target kinds have snapshots', async () => {
  const m = model(),
    s = createR5MainFunctionStats();
  await s.enable(m.tx);
  m.control.xid = '906';
  await s.observe(m.tx, 'EVALUATION_INSERT', 'insert', async () => 1);
  expect(s.snapshot().complete).toBe(false);
  await s.observe(m.tx, 'ORIGINAL_CONSTRAINT_BARRIER', 'barrier', async () => undefined);
  expect(s.snapshot().complete).toBe(true);
});

it('preserves the exact native rejection and never queries its failed transaction', async () => {
  const m = model(),
    s = createR5MainFunctionStats(),
    failure = Object.assign(new Error('native'), { code: 'P2028' });
  await s.enable(m.tx);
  m.control.xid = '901';
  let queriesAtRejection = 0;
  const native = jest.fn(async () => {
    queriesAtRejection = m.seen.length;
    throw failure;
  });
  await expect(s.observe(m.tx, 'EVALUATION_INSERT', 'fingerprint', native)).rejects.toBe(failure);
  expect(m.seen.length).toBe(queriesAtRejection);
  expect(native).toHaveBeenCalledTimes(1);
  expect(s.snapshot().complete).toBe(false);
  expect(s.snapshot().segments[0].after).toBeUndefined();
  expect(s.snapshot().segments[0].deltas).toBeUndefined();
});

it('retains a completed INSERT measurement when the original later barrier rejects', async () => {
  const m = model(),
    s = createR5MainFunctionStats();
  await s.enable(m.tx);
  m.control.xid = '902';
  await s.observe(m.tx, 'EVALUATION_INSERT', 'insert', async () => {
    m.increment(102, 1, 200, 20);
    return 8000;
  });
  const failure = new Error('original barrier');
  await expect(
    s.observe(m.tx, 'ORIGINAL_CONSTRAINT_BARRIER', 'barrier', async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(s.snapshot().segments[0].deltas?.find((f) => f.oid === 102)?.totalMs).toBe(200);
  expect(s.snapshot().segments[1].before).toBeDefined();
  expect(s.snapshot().segments[1].after).toBeUndefined();
  expect(s.snapshot().complete).toBe(false);
});

it.each(['database', 'databaseOid', 'cluster', 'role', 'sessionUser', 'readOnly'])(
  'rejects a different original %s before enabling tracking',
  async (key) => {
    const m = model(),
      s = createR5MainFunctionStats();
    m.control[key] = 'wrong';
    await expect(s.enable(m.tx)).rejects.toThrow();
    expect(m.seen).toEqual([R5_FUNCTION_STATS_CONTROL_SQL]);
    expect(s.snapshot().setupError).toBeDefined();
  },
);

it('fails calibration before the business callback if counters do not advance', async () => {
  const m = model(),
    s = createR5MainFunctionStats();
  m.disableCalibration();
  await expect(s.enable(m.tx)).rejects.toThrow('tracking calibration failed');
  expect(s.snapshot().calibrated).toBe(false);
});

it('keeps absent counters unknown and catches counter resets instead of manufacturing zeros', () => {
  const m = model();
  const before = structuredClone(m.counters);
  expect(functionCounterDeltas(before, before)[0]).toMatchObject({
    status: 'NOT_RECORDED',
    calls: null,
  });
  m.increment(102, 2, 20, 10);
  expect(functionCounterDeltas(before, m.counters)[1]).toMatchObject({
    status: 'CAPTURED',
    beforeRecorded: false,
    calls: '2',
  });
  expect(() => functionCounterDeltas(m.counters, before)).toThrow('disappeared');
});

it('stops on PID/XID changes and never invokes the next original statement', async () => {
  const m = model(),
    s = createR5MainFunctionStats();
  await s.enable(m.tx);
  m.control.xid = '903';
  await s.observe(m.tx, 'EVALUATION_INSERT', 'first', async () => 1);
  m.control.xid = '904';
  const next = jest.fn(async () => 1);
  await expect(s.observe(m.tx, 'ORIGINAL_CONSTRAINT_BARRIER', 'second', next)).rejects.toThrow();
  expect(next).not.toHaveBeenCalled();
});

it('keeps original success distinct from a failed post-statement observation', async () => {
  const m = model(),
    s = createR5MainFunctionStats();
  await s.enable(m.tx);
  m.control.xid = '905';
  const native = jest.fn(async () => {
    m.control.pid = 99;
    return 7;
  });
  await expect(s.observe(m.tx, 'EVALUATION_INSERT', 'insert', native)).rejects.toThrow();
  expect(native).toHaveBeenCalledTimes(1);
  expect(s.snapshot().segments[0].outcome).toBe('FULFILLED');
  expect(s.snapshot().segments[0].observationError).toBeDefined();
  expect(s.snapshot().complete).toBe(false);
});

it('rejects a second transaction rather than reusing a previous measurement', async () => {
  const m = model(),
    s = createR5MainFunctionStats();
  await s.enable(m.tx);
  await expect(s.enable(m.tx)).rejects.toThrow('one original MAIN');
});

it('requires an explicitly read-only transaction for the pre-fixture capability gate', async () => {
  const m = model();
  await expect(probeR5MainFunctionStatsReadOnly(m.tx)).rejects.toThrow('transaction mode');
  expect(m.seen).toEqual([R5_FUNCTION_STATS_CONTROL_SQL]);
  const readOnly = model();
  readOnly.control.readOnly = 'on';
  const result = await probeR5MainFunctionStatsReadOnly(readOnly.tx);
  expect(result.ready).toBe(true);
  expect(result.observation.calibrated).toBe(true);
  expect(result.observation.setup?.xid).toBeNull();
  expect(readOnly.seen.every((sql) => sql.startsWith('SELECT '))).toBe(true);
});
