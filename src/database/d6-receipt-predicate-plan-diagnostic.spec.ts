import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  D6_PREDICATE_SQL as SQL,
  d6ReceiptPredicateAuthority,
  observeD6ReceiptPredicatePlans,
  summarizeD6PredicatePlan,
  type D6PredicatePlanClient,
} from '../../test/helpers/d6-receipt-predicate-plan-diagnostic';
import {
  deriveTemplateTestDbName,
  deriveTestDbName,
  deriveWorkerTestDbName,
} from '../../test/setup/worktree-db';

const source = readFileSync(
  resolve(
    __dirname,
    '../../prisma/migrations/20260913090000_activity_os_r4_d4_time_bucket_settlement/migration.sql',
  ),
  'utf8',
);
const queries = d6ReceiptPredicateAuthority(source);
const env = {
  GITHUB_ACTIONS: 'true',
  GITHUB_WORKFLOW: 'CI',
  GITHUB_JOB: 'slow',
  GITHUB_EVENT_NAME: 'pull_request',
};
const reference = 'PRIVATE_PARENT_REFERENCE';
const hash = 'b4f874b7fe90738bac9df353e0c0fbaa20e3cbc1090d025b643591e6332cae67';

function plan() {
  return [
    {
      'QUERY PLAN': [
        {
          'Planning Time': 0.75,
          'Execution Time': 17.5,
          'Query Text': 'PRIVATE_RAW_SQL',
          Plan: {
            'Node Type': 'CTE Scan',
            'Plan Rows': 1,
            'Actual Rows': 1,
            'Actual Loops': 1,
            'Shared Hit Blocks': 100,
            'Shared Read Blocks': 4,
            Plans: [
              {
                'Node Type': 'Index Scan',
                'Relation Name': 'ParticipantTimeAllocationSlice',
                'Index Name': 'PRIVATE_INDEX',
                'Index Cond': "allocation = 'PRIVATE_PARAMETER'",
                'Plan Rows': 5,
                'Actual Rows': 5,
                'Actual Loops': 2000,
                'Rows Removed by Filter': 3,
                'Shared Hit Blocks': 80,
              },
            ],
          },
        },
      ],
    },
  ];
}
function state() {
  return {
    database: true,
    sameRole: true,
    readOnly: true,
    backend: 100,
    virtual: '3/100',
    planCacheMode: 'auto',
    guard: { oid: 20000, version: '9000', pinned: true },
    sealed: true,
  };
}
type Call = { transaction: number; kind: string; sql?: string; values?: unknown[] };
function fixture(
  options: {
    database?: string;
    change?: (row: ReturnType<typeof state>, index: number) => unknown;
    fail?: (sql: string, transaction: number) => boolean;
    error?: Error;
    plan?: () => unknown;
  } = {},
) {
  const calls: Call[] = [];
  let transactions = 0;
  let closed = 0;
  const client = {
    async $transaction(
      run: (tx: {
        $queryRawUnsafe(sql: string, ...values: unknown[]): Promise<unknown>;
        $executeRawUnsafe(sql: string): Promise<number>;
      }) => Promise<unknown>,
      bounds: unknown,
    ) {
      const transaction = ++transactions;
      calls.push({ transaction, kind: 'BEGIN', values: [bounds] });
      let readonly = false;
      let metadata = 0;
      const tx = {
        $executeRawUnsafe(sql: string) {
          calls.push({ transaction, kind: 'EXEC', sql });
          if (options.fail?.(sql, transaction))
            return Promise.reject(options.error ?? new Error('PRIVATE_EXEC_ERROR'));
          if (sql === SQL.readOnly) readonly = true;
          return Promise.resolve(0);
        },
        $queryRawUnsafe(sql: string, ...values: unknown[]) {
          calls.push({ transaction, kind: 'QUERY', sql, values });
          if (options.fail?.(sql, transaction))
            return Promise.reject(options.error ?? new Error('PRIVATE_QUERY_ERROR'));
          if (sql === SQL.metadata) {
            const row = state();
            row.readOnly = readonly;
            row.database = values[0] === (options.database ?? deriveTestDbName());
            row.guard.pinned = values[2] === hash;
            row.sealed = values[1] === reference;
            return Promise.resolve([{ observation: options.change?.(row, metadata++) ?? row }]);
          }
          if (!Object.values(queries).includes(sql)) throw new Error('UNEXPECTED_SQL');
          if (values.length !== 1 || values[0] !== reference)
            throw new Error('UNEXPECTED_PARAMETERS');
          return Promise.resolve(options.plan ? options.plan() : plan());
        },
      };
      try {
        const result = await run(tx);
        calls.push({ transaction, kind: 'COMMIT' });
        return result;
      } catch (error) {
        calls.push({ transaction, kind: 'ROLLBACK' });
        throw error;
      } finally {
        closed++;
      }
    },
  };
  return {
    client: client as unknown as D6PredicatePlanClient,
    calls,
    get transactions() {
      return transactions;
    },
    get closed() {
      return closed;
    },
    collect(options: Parameters<typeof observeD6ReceiptPredicatePlans>[2] = {}) {
      return observeD6ReceiptPredicatePlans(client as unknown as D6PredicatePlanClient, reference, {
        env,
        source,
        ...options,
      });
    },
  };
}

describe('D6 post-prepare read-only predicate plan diagnostic', () => {
  it('derives only three authority-pinned SELECT predicates without native body changes', () => {
    expect(Object.keys(queries)).toEqual(['SOURCE_READY', 'BUCKET_SOURCE', 'BUCKET_TOTAL']);
    for (const sql of Object.values(queries)) {
      expect(sql.startsWith('EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)')).toBe(true);
      expect(sql.includes('WITH verdict AS MATERIALIZED')).toBe(true);
      expect(sql.includes('parent_row.id=$1')).toBe(true);
      expect(sql.includes('draft_id')).toBe(false);
      expect(sql.includes(reference)).toBe(false);
      expect(/\b(?:FROM|JOIN)\s+"[A-Z]/u.test(sql)).toBe(false);
      expect(
        /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|LOAD|GRANT|SET)\b/i.test(
          sql.replace(/--[^\n]*/g, ''),
        ),
      ).toBe(false);
      expect(/auto_explain|plan_cache_mode/i.test(sql)).toBe(false);
    }
    expect(queries.SOURCE_READY.includes('parent_row."settlementVersionId"')).toBe(true);
    expect(queries.SOURCE_READY.includes('source_counts AS MATERIALIZED')).toBe(true);
    expect(queries.BUCKET_SOURCE.includes('"ParticipantTimeAllocationSlice"')).toBe(true);
    expect(queries.BUCKET_TOTAL.includes('totals AS MATERIALIZED')).toBe(true);
  });

  it.each(['changed', 'duplicate'])('refuses %s guard source before constructing SQL', (kind) => {
    const changed =
      kind === 'changed'
        ? source.replace('WITH source_facts AS (', 'WITH source_facts AS MATERIALIZED (')
        : source + source;
    expect(() => d6ReceiptPredicateAuthority(changed)).toThrow(
      'D6 post-prepare plan observation unavailable',
    );
  });

  it('bounds plan output and reports loops/row work rather than retaining raw plans', () => {
    const result = summarizeD6PredicatePlan(plan());
    expect(result.executionMs).toBe(17.5);
    expect(result.planningMs).toBe(0.75);
    expect(result.rootBuffers).toEqual({ hit: 100, read: 4, tempRead: null, tempWritten: null });
    expect(result.parsedNodes).toBe(2);
    expect(result.topWorkNodes[0]).toEqual({
      kind: 'Index Scan',
      relation: 'SLICE',
      estimatedRows: 5,
      rows: 5,
      loops: 2000,
      removed: 3,
      joinRemoved: null,
      buffers: { hit: 80, read: null, tempRead: null, tempWritten: null },
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('does not touch accessors in forbidden plan fields', () => {
    const rows = plan();
    const root = rows[0]['QUERY PLAN'][0].Plan;
    for (const key of ['Output', 'Filter', 'Index Cond', 'Query Text'])
      Object.defineProperty(root, key, {
        get() {
          throw new Error('PRIVATE_GETTER');
        },
      });
    expect(summarizeD6PredicatePlan(rows).rootRows).toBe(1);
  });

  it('maps unknown relation/node names to OTHER rather than leaking them', () => {
    const rows = plan();
    rows[0]['QUERY PLAN'][0].Plan['Node Type'] = 'PRIVATE_KIND';
    rows[0]['QUERY PLAN'][0].Plan.Plans[0]['Relation Name'] = '__proto__';
    const output = summarizeD6PredicatePlan(rows);
    expect(output.topWorkNodes[0].relation).toBe('OTHER');
    expect(output.topWorkNodes[1].kind).toBe('OTHER');
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE|__proto__/);
  });

  it.each(['number', 'accessor', 'proxy', 'deep', 'wide', 'missing'])(
    'refuses a %s plan without reading/serializing private fields',
    (kind) => {
      const rows = plan();
      const root = rows[0]['QUERY PLAN'][0].Plan;
      if (kind === 'number') root['Actual Loops'] = NaN;
      if (kind === 'accessor')
        Object.defineProperty(root, 'Actual Rows', {
          get() {
            throw new Error('PRIVATE_ACTUAL_ROWS_GETTER');
          },
        });
      if (kind === 'proxy')
        rows[0]['QUERY PLAN'][0].Plan = new Proxy(root, {
          get() {
            throw new Error('PRIVATE_PROXY');
          },
        });
      if (kind === 'deep') {
        let parent: object = root;
        for (let i = 0; i < 34; i++) {
          const child = { ...root, Plans: [] };
          Reflect.set(parent, 'Plans', [child]);
          parent = child;
        }
      }
      if (kind === 'wide')
        Reflect.set(
          root,
          'Plans',
          Array.from({ length: 33 }, () => root),
        );
      if (kind === 'missing') Reflect.deleteProperty(rows[0]['QUERY PLAN'][0], 'Execution Time');
      expect(() => summarizeD6PredicatePlan(rows)).toThrow(
        'D6 post-prepare plan observation unavailable',
      );
    },
  );

  it('captures three independently read-only, bounded transactions after native completion', async () => {
    const f = fixture();
    const result = await f.collect();
    expect(result.status).toBe('OBSERVED');
    expect(f.transactions).toBe(3);
    expect(f.closed).toBe(3);
    expect(result.transactions).toBe(3);
    expect(result.explicitObserverStatements).toBe(15);
    expect(result.rows.map((r) => r.label)).toEqual([
      'SOURCE_READY',
      'BUCKET_SOURCE',
      'BUCKET_TOTAL',
    ]);
    for (const row of result.rows) {
      expect(row.status).toBe('CAPTURED');
      expect(row.sameBackend).toBe(true);
      expect(row.sameVirtualTransaction).toBe(true);
      expect(row.readOnly).toBe(true);
      expect(row.functionPinned).toBe(true);
      expect(row.parentSealed).toBe(true);
      expect(row.planCacheMode).toBe('auto');
    }
    for (let transaction = 1; transaction <= 3; transaction++) {
      const calls = f.calls.filter((c) => c.transaction === transaction);
      expect(calls.map((c) => c.kind)).toEqual([
        'BEGIN',
        'EXEC',
        'EXEC',
        'QUERY',
        'QUERY',
        'QUERY',
        'COMMIT',
      ]);
      expect(calls[0].values).toEqual([{ maxWait: 1000, timeout: 5000 }]);
      expect(calls[1].sql).toBe(SQL.readOnly);
      expect(calls[2].sql).toBe(SQL.timeout);
      expect(calls[3].sql).toBe(SQL.metadata);
      expect(calls[3].values).toEqual([deriveTestDbName(), reference, hash]);
      expect(calls[5].sql).toBe(SQL.metadata);
    }
    const output = JSON.stringify(result);
    expect(output).not.toMatch(/PRIVATE|b4f874|9000|3\/100|app_test/);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(8192);
    expect(result.purpose).toBe('POST_PREPARE_PLAN_SAMPLE_NOT_NATIVE_GUARD_OR_PLAN_CACHE_PROOF');
  });

  it.each([
    { GITHUB_ACTIONS: 'false' },
    { GITHUB_WORKFLOW: 'Docker Smoke' },
    { GITHUB_JOB: 'r5-human-ci' },
    { GITHUB_EVENT_NAME: 'push' },
  ])('does no SQL outside the approved PR slow job (%j)', async (change) => {
    const f = fixture();
    expect((await f.collect({ env: { ...env, ...change } })).status).toBe('DISABLED');
    expect(f.calls).toEqual([]);
  });

  it.each([undefined, '0', '100', 'arbitrary'])(
    'requires a current worker (%s)',
    async (worker) => {
      const replacement = jest.replaceProperty(process, 'env', { ...env, JEST_WORKER_ID: worker });
      try {
        const f = fixture();
        const result = await f.collect();
        expect(result.status).toBe('UNKNOWN');
        expect(f.transactions).toBe(0);
        expect(result.reason).toBe('WORKER');
        expect(f.calls).toEqual([]);
      } finally {
        replacement.restore();
      }
    },
  );

  it.each(['template', 'other worker', 'production-looking'])(
    'never probes the %s database',
    async (kind) => {
      const f = fixture({
        database:
          kind === 'template'
            ? deriveTemplateTestDbName()
            : kind === 'other worker'
              ? deriveWorkerTestDbName(
                  deriveTestDbName() === deriveWorkerTestDbName('1') ? '2' : '1',
                )
              : 'app_test_prod',
      });
      const result = await f.collect();
      expect(result.status).toBe('UNKNOWN');
      expect(f.transactions).toBe(1);
      expect(result.rows).toHaveLength(3);
      expect(f.calls.some((c) => c.sql?.startsWith('EXPLAIN'))).toBe(false);
      expect(f.closed).toBe(f.transactions);
    },
  );

  it.each(['readOnly', 'sameRole', 'sealed', 'pinned', 'version'])(
    'refuses failed %s preflight without an EXPLAIN',
    async (field) => {
      const f = fixture({
        change(row) {
          if (field === 'pinned') row.guard.pinned = false;
          else if (field === 'version') row.guard.version = 'not-a-version';
          else Reflect.set(row, field, false);
        },
      });
      const result = await f.collect();
      expect(result.status).toBe('UNKNOWN');
      expect(f.transactions).toBe(1);
      expect(result.rows).toHaveLength(3);
      expect(f.calls.some((c) => c.sql?.startsWith('EXPLAIN'))).toBe(false);
      expect(result.rows.every((r) => r.plan === null)).toBe(true);
    },
  );

  it.each(['backend', 'virtual', 'oid', 'version', 'mode'])(
    'does not accept changed %s metadata as the same observation',
    async (field) => {
      const f = fixture({
        change(row, index) {
          if (!index) return;
          if (field === 'backend') row.backend++;
          if (field === 'virtual') row.virtual = '3/101';
          if (field === 'oid') row.guard.oid++;
          if (field === 'version') row.guard.version = '9001';
          if (field === 'mode') row.planCacheMode = 'force_generic_plan';
        },
      });
      const result = await f.collect();
      expect(result.status).toBe('UNKNOWN');
      expect(result.rows).toHaveLength(3);
      expect(result.rows.every((r) => r.reason === 'IDENTITY' && r.plan === null)).toBe(true);
    },
  );

  it('records an existing forced mode but never changes it or infers the native cached plan', async () => {
    const f = fixture({
      change(row) {
        row.planCacheMode = 'force_generic_plan';
      },
    });
    const result = await f.collect();
    expect(result.status).toBe('OBSERVED');
    expect(result.rows.every((r) => r.planCacheMode === 'force_generic_plan')).toBe(true);
    expect(f.calls.some((c) => c.sql?.startsWith('SET') && c.sql.includes('plan_cache_mode'))).toBe(
      false,
    );
  });

  it('rolls back only its own failed transaction and emits no SQL after that failure', async () => {
    const f = fixture({ fail: (sql, tx) => tx === 2 && sql.startsWith('EXPLAIN') });
    const result = await f.collect();
    expect(result.status).toBe('PARTIAL');
    expect(result.rows.map((r) => r.status)).toEqual(['CAPTURED', 'UNKNOWN', 'CAPTURED']);
    expect(result.rows[1].reason).toBe('PLAN_SQL');
    expect(f.calls.filter((c) => c.transaction === 2).at(-1)?.kind).toBe('ROLLBACK');
    expect(f.closed).toBe(3);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('does not accept a zero-row (missing or now-violating) verdict as a fast success', async () => {
    const f = fixture({
      plan() {
        const rows = plan();
        rows[0]['QUERY PLAN'][0].Plan['Actual Rows'] = 0;
        return rows;
      },
    });
    const result = await f.collect();
    expect(result.status).toBe('UNKNOWN');
    expect(result.rows).toHaveLength(3);
    expect(
      result.rows.every((r) => r.reason === 'POST_PREPARE_DATA_CHANGED' && r.plan === null),
    ).toBe(true);
  });

  it('never consults DATABASE_URL for trusted scope', async () => {
    const nextEnv: NodeJS.ProcessEnv = { ...env, JEST_WORKER_ID: '1' };
    Object.defineProperty(nextEnv, 'DATABASE_URL', {
      get() {
        throw new Error('PRIVATE_URL_GETTER');
      },
    });
    const replacement = jest.replaceProperty(process, 'env', nextEnv);
    try {
      expect((await fixture().collect()).status).toBe('OBSERVED');
    } finally {
      replacement.restore();
    }
  });

  it('retains only the top six work nodes and does not sum inclusive buffer counts', () => {
    const rows = plan();
    const root = rows[0]['QUERY PLAN'][0].Plan;
    const sample = root.Plans[0];
    root.Plans = Array.from({ length: 20 }, (_, i) => ({
      ...sample,
      'Actual Rows': 10,
      'Actual Loops': i + 1,
    }));
    const summary = summarizeD6PredicatePlan(rows);
    expect(summary.parsedNodes).toBe(21);
    expect(summary.topWorkNodes.map((r) => r.loops)).toEqual([20, 19, 18, 17, 16, 15]);
    expect(summary.rootBuffers.hit).toBe(100);
  });

  it('distinguishes recorded zero buffers from missing buffers', () => {
    const rows = plan();
    rows[0]['QUERY PLAN'][0].Plan['Shared Read Blocks'] = 0;
    const summary = summarizeD6PredicatePlan(rows);
    expect(summary.rootBuffers.read).toBe(0);
    expect(summary.rootBuffers.tempRead).toBeNull();
  });

  it('does no metadata/plan SQL if making its own transaction read-only fails', async () => {
    const f = fixture({ fail: (sql) => sql === SQL.readOnly });
    const result = await f.collect();
    expect(result.status).toBe('UNKNOWN');
    expect(f.transactions).toBe(1);
    expect(f.closed).toBe(1);
    expect(f.calls.map((c) => c.kind)).toEqual(['BEGIN', 'EXEC', 'ROLLBACK']);
    expect(result.rows[0].reason).toBe('READ_ONLY');
  });

  it('rejects malformed plans inside its own transaction, never emitting raw values', async () => {
    const f = fixture({
      plan: () => [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'PRIVATE_SQL' } }] }],
    });
    const result = await f.collect();
    expect(result.status).toBe('UNKNOWN');
    expect(result.rows).toHaveLength(3);
    expect(result.rows.every((r) => r.reason === 'PLAN_SHAPE' && r.plan === null)).toBe(true);
    expect(f.calls.filter((r) => r.kind === 'ROLLBACK')).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it.each(['statement', 'transaction'])(
    'classifies a %s budget failure without error messages',
    async (kind) => {
      const error = Object.assign(new Error('PRIVATE_BUDGET_ERROR'), {
        code: kind === 'statement' ? 'P2010' : 'P2028',
        meta: { code: '57014' },
      });
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('PRIVATE_ERROR_MESSAGE_GETTER');
        },
      });
      const f = fixture({ error, fail: (sql) => sql.startsWith('EXPLAIN') });
      const result = await f.collect();
      expect(result.status).toBe('UNKNOWN');
      expect(result.rows).toHaveLength(3);
      expect(
        result.rows.every(
          (r) => r.reason === (kind === 'statement' ? 'PLAN_TIMEOUT' : 'TRANSACTION_BUDGET'),
        ),
      ).toBe(true);
      expect(f.closed).toBe(3);
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    },
  );

  it('never coerces an invalid reference or sends it to SQL', async () => {
    const f = fixture();
    const value = {
      toString() {
        throw new Error('PRIVATE_REFERENCE_COERCION');
      },
    };
    const result = await observeD6ReceiptPredicatePlans(f.client, value, { env, source });
    expect(result.reason).toBe('REFERENCE');
    expect(f.calls).toEqual([]);
  });

  it('does not issue SQL if a timed-out callback resumes after its transaction has ended', async () => {
    let release: (value: unknown) => void = () => {};
    let reached: () => void = () => {};
    const pending = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const calls: string[] = [];
    let background: Promise<unknown> | undefined;
    const client = {
      async $transaction(run: (tx: object) => Promise<unknown>) {
        background = run({
          $executeRawUnsafe(sql: string) {
            calls.push(sql);
            return Promise.resolve(0);
          },
          $queryRawUnsafe(sql: string) {
            calls.push(sql);
            reached();
            return pending;
          },
        });
        void background.catch(() => {});
        await started;
        throw Object.assign(new Error('PRIVATE_ENDED_TRANSACTION'), { code: 'P2028' });
      },
    };
    const result = await observeD6ReceiptPredicatePlans(
      client as unknown as D6PredicatePlanClient,
      reference,
      { env, source },
    );
    expect(result.rows[0].reason).toBe('TRANSACTION_BUDGET');
    release([{ observation: state() }]);
    await background?.catch(() => {});
    expect(calls).toEqual([SQL.readOnly, SQL.timeout, SQL.metadata]);
  });

  it('rejects an accessor in required metadata without invoking it', async () => {
    let accessed = false;
    const f = fixture({
      change(row) {
        Object.defineProperty(row, 'sealed', {
          get() {
            accessed = true;
            throw new Error('PRIVATE_METADATA_GETTER');
          },
        });
      },
    });
    expect((await f.collect()).status).toBe('UNKNOWN');
    expect(accessed).toBe(false);
    expect(f.calls.some((c) => c.sql?.startsWith('EXPLAIN'))).toBe(false);
  });

  it('bounds the final protocol even when all retained metrics contain large values', async () => {
    const f = fixture({
      plan() {
        const rows = plan();
        const root = rows[0]['QUERY PLAN'][0].Plan;
        const sample = root.Plans[0];
        root.Plans = Array.from({ length: 20 }, () => ({
          ...sample,
          'Node Type': 'Incremental Sort',
          'Relation Name': 'ParticipantSettlementResultRevision',
          'Actual Rows': 1e6,
          'Actual Loops': 1e6,
          'Plan Rows': 1e12,
          'Rows Removed by Filter': 1e12,
          'Shared Hit Blocks': 1e12,
          'Shared Read Blocks': 1e12,
          'Temp Read Blocks': 1e12,
          'Temp Written Blocks': 1e12,
        }));
        return rows;
      },
    });
    const result = await f.collect();
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192);
    expect(['OBSERVED', 'UNKNOWN']).toContain(result.status);
    if (result.status === 'UNKNOWN') expect(result.reason).toBe('OUTPUT');
  });

  it('does not discard a high-loop lookup merely because it returns zero rows', () => {
    const rows = plan();
    const root = rows[0]['QUERY PLAN'][0].Plan;
    const child = root.Plans[0];
    root.Plans = [
      ...Array.from({ length: 10 }, () => ({ ...child, 'Actual Rows': 1, 'Actual Loops': 2 })),
      { ...child, 'Actual Rows': 0, 'Actual Loops': 40000 },
    ];
    const summary = summarizeD6PredicatePlan(rows);
    expect(summary.topWorkNodes.some((r) => r.rows === 0 && r.loops === 40000)).toBe(true);
  });

  it('does no database work with unpinned source', async () => {
    const f = fixture();
    const result = await f.collect({
      source: source.replace('WITH source_facts AS (', 'WITH changed AS ('),
    });
    expect(result.reason).toBe('AUTHORITY');
    expect(f.calls).toEqual([]);
  });
});
