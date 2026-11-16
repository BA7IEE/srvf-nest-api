import {
  D6_RECEIPT_STATS_SQL as SQL,
  D6ReceiptFunctionDiagnostic,
} from '../../test/helpers/d6-receipt-function-diagnostic';

const env: NodeJS.ProcessEnv = {
  GITHUB_ACTIONS: 'true',
  GITHUB_WORKFLOW: 'CI',
  GITHUB_JOB: 'slow',
  GITHUB_EVENT_NAME: 'pull_request',
};
const labels = [
  'RECEIPT_GUARD',
  'SOURCE_DOCUMENT',
  'SOURCE_HASH',
  'BUCKET_HASH',
  'CANONICAL',
] as const;

function state(setting: string, after: boolean) {
  return {
    safeDatabase: true,
    sameRole: true,
    writable: true,
    allowed: true,
    setting,
    backend: 101,
    xact: '1234',
    functions: labels.map((label, index) => ({
      label,
      oid: 200 + index,
      version: '100',
      language: index === 0 || index === 4 ? 'plpgsql' : 'sql',
      recorded: after && index !== 2,
      calls: after && index !== 2 ? (index === 4 ? '100000' : '1') : null,
      totalMs: after && index !== 2 ? (index === 0 ? 25 : 10) : null,
      selfMs: after && index !== 2 ? (index === 0 ? 3 : 5) : null,
    })),
  };
}

function fixture(
  change?: (row: ReturnType<typeof state>, index: number) => unknown,
  fail?: (sql: string, calls: string[]) => boolean,
) {
  let setting = 'none';
  let saved: string | undefined;
  let aborted = false;
  let states = 0;
  let time = 0;
  let nativeCalls = 0;
  const nativeReceivers: unknown[] = [];
  let nativeArgs: unknown[];
  const calls: string[] = [];
  const tx = {
    async $queryRawUnsafe(sql: string) {
      await Promise.resolve();
      calls.push(sql);
      time += 1;
      if (sql === SQL.rollback) {
        if (saved === undefined) throw new Error('no probe savepoint');
        aborted = false;
        setting = saved;
        return [];
      }
      if (aborted) throw new Error('transaction remains aborted');
      if (fail?.(sql, calls)) {
        aborted = true;
        throw new Error('PRIVATE_QUERY_ERROR_CANARY');
      }
      if (sql === SQL.save) {
        if (saved !== undefined) throw new Error('nested probe');
        saved = setting;
        return [];
      }
      if (sql === SQL.release) {
        saved = undefined;
        return [];
      }
      if (sql === SQL.enable) {
        setting = 'all';
        return [{ enabled: true }];
      }
      if (sql === SQL.restore) {
        setting = 'none';
        return [{ restored: true }];
      }
      if (sql !== SQL.state) throw new Error('unexpected diagnostic SQL');
      const index = states++;
      const row = state(setting, index >= 2);
      return [{ observation: change ? change(row, index) : row }];
    },
  };
  const result = Object.freeze({ privateResult: 'PRIVATE_RESULT_CANARY' });
  const target = {
    async receipt(...args: unknown[]) {
      await Promise.resolve();
      nativeCalls++;
      nativeReceivers.push(this);
      nativeArgs = args;
      if (aborted || saved !== undefined) throw new Error('probe polluted original write');
      time += 30;
      return result;
    },
  };
  const original = Reflect.get(target, 'receipt');
  const diagnostic = new D6ReceiptFunctionDiagnostic(target, { env, clock: () => time });
  return {
    tx,
    target,
    result,
    original,
    diagnostic,
    calls,
    get nativeCalls() {
      return nativeCalls;
    },
    get nativeReceiver() {
      return nativeReceivers[0];
    },
    get nativeArgs() {
      return nativeArgs!;
    },
    get setting() {
      return setting;
    },
    get aborted() {
      return aborted;
    },
  };
}

describe('D6 receipt function diagnostic', () => {
  it('captures five fixed families in the original transaction without inventing an inlined zero', async () => {
    const f = fixture();
    await expect(f.target.receipt(f.tx)).resolves.toBe(f.result);
    const data = f.diagnostic.snapshot();
    expect(data.status).toBe('OBSERVED');
    expect(data.coverage).toBe('PARTIAL');
    expect(data.sameBackend).toBe(true);
    expect(data.sameTransaction).toBe(true);
    expect(data.settingRestored).toBe(true);
    expect(data.nativeCalls).toBe(1);
    expect(data.nativeOutcome).toBe('OK');
    expect(data.nativeReceiptMs).toBe(30);
    expect(data.diagnosticQueries).toBe(9);
    expect(data.functions).toHaveLength(5);
    expect(data.functions[0]).toEqual({
      label: 'RECEIPT_GUARD',
      status: 'CAPTURED',
      calls: '1',
      totalMs: 25,
      selfMs: 3,
    });
    expect(data.functions[2]).toEqual({
      label: 'SOURCE_HASH',
      status: 'NOT_RECORDED',
      calls: null,
      totalMs: null,
      selfMs: null,
    });
    expect(f.calls).toEqual([
      SQL.save,
      SQL.state,
      SQL.enable,
      SQL.state,
      SQL.release,
      SQL.save,
      SQL.state,
      SQL.restore,
      SQL.release,
    ]);
    expect(f.setting).toBe('none');
    f.diagnostic.restore();
    expect(Reflect.get(f.target, 'receipt')).toBe(f.original);
  });

  it('delegates the receiver, original argument references and returned value exactly once', async () => {
    const f = fixture();
    const body = Object.create(null) as object;
    Object.defineProperty(body, 'toJSON', {
      get() {
        throw new Error('PRIVATE_BODY_GETTER_CANARY');
      },
    });
    const wrapped = Reflect.get(f.target, 'receipt');
    expect(await Reflect.apply(wrapped, f.target, [f.tx, body])).toBe(f.result);
    expect(f.nativeCalls).toBe(1);
    expect(f.nativeReceiver).toBe(f.target);
    expect(f.nativeArgs).toEqual([f.tx, body]);
    expect(JSON.stringify(f.diagnostic.snapshot())).not.toMatch(/PRIVATE_|backend|1234|version/u);
  });

  it('uses a bounded emitted schema', async () => {
    const f = fixture();
    await f.target.receipt(f.tx);
    const value = f.diagnostic.snapshot();
    expect(value.purpose).toBe('INSTRUMENTED_RECEIPT_NOT_PERFORMANCE_ACCEPTANCE');
    expect(value.status).toBe('OBSERVED');
    expect(value.scope).toBe('CURRENT_TRANSACTION_ONLY_NO_GLOBAL_FUNCTION_STATS');
    expect(value.semantics).toBe('INCLUSIVE_TOTAL_SELF_NOT_CPU_DO_NOT_SUM_PARENT_CHILDREN');
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(4096);
  });

  it.each(['safeDatabase', 'sameRole', 'writable', 'allowed'] as const)(
    'does not enable tracking when %s fails, but still calls the original',
    async (key) => {
      const f = fixture((row) => ({ ...row, [key]: false }));
      expect(await f.target.receipt(f.tx)).toBe(f.result);
      expect(f.nativeCalls).toBe(1);
      expect(f.diagnostic.snapshot().status).toBe('UNKNOWN');
      expect(f.calls).not.toContain(SQL.enable);
      expect(f.calls).toContain(SQL.rollback);
      expect(f.aborted).toBe(false);
    },
  );

  it.each([
    'backend',
    'xact',
    'catalog',
    'duplicate',
    'missing',
    'decreasing',
    'nonfinite',
    'guard missing',
  ])('rejects invalid or unowned counter observations: %s', async (kind) => {
    const f = fixture((row, index) => {
      if (index !== 2) return row;
      if (kind === 'backend') row.backend++;
      if (kind === 'xact') row.xact = '5678';
      if (kind === 'catalog') row.functions[0].version = '200';
      if (kind === 'duplicate') row.functions[1].label = 'RECEIPT_GUARD';
      if (kind === 'missing') row.functions.pop();
      if (kind === 'decreasing') row.functions[0].totalMs = -1;
      if (kind === 'nonfinite') row.functions[0].selfMs = Number.POSITIVE_INFINITY;
      if (kind === 'guard missing') row.functions[0].recorded = false;
      return row;
    });
    expect(await f.target.receipt(f.tx)).toBe(f.result);
    expect(f.calls.filter((sql) => sql === SQL.state)).toHaveLength(3);
    expect(f.diagnostic.snapshot().status).toBe('UNKNOWN');
    expect(f.diagnostic.snapshot().functions).toEqual([]);
    expect(f.setting).toBe('none');
  });

  it.each([SQL.enable, SQL.state, SQL.restore])(
    'recovers a failed probe SQL without aborting the original transaction',
    async (failedSql) => {
      let injected = false;
      const f = fixture(undefined, (sql) => {
        if (!injected && sql === failedSql) {
          injected = true;
          return true;
        }
        return false;
      });
      expect(await f.target.receipt(f.tx)).toBe(f.result);
      expect(injected).toBe(true);
      expect(f.calls).toContain(SQL.rollback);
      expect(f.aborted).toBe(false);
      expect(f.setting).toBe('none');
      expect(f.nativeCalls).toBe(1);
      expect(f.diagnostic.snapshot().status).toBe('UNKNOWN');
      expect(JSON.stringify(f.diagnostic.snapshot())).not.toContain('PRIVATE_QUERY_ERROR_CANARY');
    },
  );

  it('does not issue another diagnostic SQL after the native receipt rejects', async () => {
    const f = fixture();
    f.diagnostic.restore();
    const error = new Error('PRIVATE_NATIVE_ERROR_CANARY');
    Object.defineProperty(error, 'code', {
      get() {
        throw new Error('PRIVATE_ERROR_GETTER_CANARY');
      },
    });
    const target = {
      receipt: async () => Promise.reject(error),
    };
    const observer = new D6ReceiptFunctionDiagnostic(target, { env });
    await expect(Reflect.apply(target.receipt, target, [f.tx])).rejects.toBe(error);
    expect(f.calls.at(-1)).toBe(SQL.release);
    expect(f.calls.filter((s) => s === SQL.state)).toHaveLength(2);
    expect(observer.snapshot().status).toBe('UNKNOWN');
    expect(observer.snapshot().nativeOutcome).toBe('ERROR');
    expect(observer.snapshot().settingRestored).toBeNull();
    expect(JSON.stringify(observer.snapshot())).not.toContain('PRIVATE_');
    observer.restore();
  });

  it('rolls back a failing after-snapshot and restores LOCAL settings without changing the result', async () => {
    const f = fixture(undefined, (sql, history) => {
      return sql === SQL.state && history.filter((value) => value === SQL.state).length === 3;
    });
    expect(await f.target.receipt(f.tx)).toBe(f.result);
    expect(f.nativeCalls).toBe(1);
    expect(f.aborted).toBe(false);
    expect(f.setting).toBe('none');
    expect(f.diagnostic.snapshot().status).toBe('UNKNOWN');
    expect(f.diagnostic.snapshot().settingRestored).toBe(true);
    expect(f.diagnostic.snapshot().functions).toEqual([]);
    expect(f.calls).toContain(SQL.rollback);
    expect(f.calls).toHaveLength(12);
  });

  it('never probes a second receipt on the same observer or fabricates single-call ownership', async () => {
    const f = fixture();
    await f.target.receipt(f.tx);
    const queries = f.calls.length;
    expect(await f.target.receipt(f.tx)).toBe(f.result);
    expect(f.calls).toHaveLength(queries);
    expect(f.nativeCalls).toBe(2);
    expect(f.diagnostic.snapshot().status).toBe('UNKNOWN');
    expect(f.diagnostic.snapshot().functions).toEqual([]);
  });

  it.each(['GITHUB_ACTIONS', 'GITHUB_WORKFLOW', 'GITHUB_JOB', 'GITHUB_EVENT_NAME'])(
    'is a no-op outside the approved CI context (%s)',
    async (key) => {
      const target = {
        receipt(this: void) {
          return Promise.resolve('unchanged');
        },
      };
      const native = target.receipt;
      const observer = new D6ReceiptFunctionDiagnostic(target, {
        env: { ...env, [key]: 'not-approved' },
      });
      expect(target.receipt).toBe(native);
      expect(await target.receipt()).toBe('unchanged');
      expect(observer.snapshot().status).toBe('DISABLED');
      observer.restore();
    },
  );

  it('keeps the observer query protocol fixed, transaction-local and free from logging/grants', () => {
    expect(SQL.state).toContain('pg_stat_xact_user_functions');
    expect(SQL.state).not.toMatch(/\bpg_stat_user_functions\b/u);
    expect(SQL.enable).toContain("'all',true");
    expect(SQL.restore).toContain("'none',true");
    expect(Object.values(SQL).join('\n')).not.toMatch(
      /auto_explain|EXPLAIN|pg_stat_reset|pg_stat_force|SET ROLE|GRANT |ALTER |CREATE |pg_control_system|pg_get_functiondef/iu,
    );
    expect(SQL.state).not.toMatch(/coalesce\(s\.(?:calls|total_time|self_time)/iu);
  });

  it.each(['proxy', 'getter'])(
    'does not evaluate opaque observation metadata (%s)',
    async (kind) => {
      let reads = 0;
      const f = fixture((row) => {
        if (kind === 'proxy')
          return new Proxy(row, {
            get() {
              reads++;
              throw new Error('PRIVATE_PROXY_CANARY');
            },
          });
        Object.defineProperty(row, 'allowed', {
          get() {
            reads++;
            throw new Error('PRIVATE_GETTER_CANARY');
          },
        });
        return row;
      });
      expect(await f.target.receipt(f.tx)).toBe(f.result);
      expect(reads).toBe(0);
      expect(f.nativeCalls).toBe(1);
      expect(f.diagnostic.snapshot().status).toBe('UNKNOWN');
      expect(JSON.stringify(f.diagnostic.snapshot())).not.toContain('PRIVATE_');
    },
  );

  it('reports complete coverage only when every fixed function actually has tracked deltas', async () => {
    const f = fixture((row, index) => {
      if (index === 2)
        Object.assign(row.functions[2], { recorded: true, calls: '1', totalMs: 2, selfMs: 1 });
      return row;
    });
    await f.target.receipt(f.tx);
    expect(f.diagnostic.snapshot().status).toBe('OBSERVED');
    expect(f.diagnostic.snapshot().coverage).toBe('COMPLETE');
  });

  it('does not cap recursive inclusive function totals at the receipt wall duration', async () => {
    const f = fixture((row, index) => {
      if (index === 2) Object.assign(row.functions[4], { totalMs: 60000, selfMs: 1000 });
      return row;
    });
    await f.target.receipt(f.tx);
    expect(f.diagnostic.snapshot().status).toBe('OBSERVED');
    expect(f.diagnostic.snapshot().functions[4].totalMs).toBe(60000);
    expect(f.diagnostic.snapshot().nativeReceiptMs).toBe(30);
  });

  it('does not interpret a cached SQL zero counter as proof of zero logical executions', async () => {
    const f = fixture((row) => {
      Object.assign(row.functions[2], { recorded: true, calls: '0', totalMs: 0, selfMs: 0 });
      return row;
    });
    await f.target.receipt(f.tx);
    expect(f.diagnostic.snapshot().status).toBe('OBSERVED');
    expect(f.diagnostic.snapshot().coverage).toBe('PARTIAL');
    expect(f.diagnostic.snapshot().functions[2]).toEqual({
      label: 'SOURCE_HASH',
      status: 'NOT_RECORDED',
      calls: null,
      totalMs: null,
      selfMs: null,
    });
  });

  it('does not overwrite another owner during installation or restoration', async () => {
    const f = fixture();
    const wrapper = Reflect.get(f.target, 'receipt');
    const duplicate = new D6ReceiptFunctionDiagnostic(f.target, { env });
    expect(Reflect.get(f.target, 'receipt')).toBe(wrapper);
    expect(duplicate.snapshot().status).toBe('UNKNOWN');
    duplicate.restore();
    expect(Reflect.get(f.target, 'receipt')).toBe(wrapper);
    const replacement = () => Promise.resolve(f.result);
    f.target.receipt = replacement;
    f.diagnostic.restore();
    expect(Reflect.get(f.target, 'receipt')).toBe(replacement);
    expect(f.diagnostic.snapshot().status).toBe('UNKNOWN');
    expect(await f.target.receipt()).toBe(f.result);
  });

  it('marks broken clocks unknown without replacing the original result', async () => {
    const f = fixture();
    f.diagnostic.restore();
    const observer = new D6ReceiptFunctionDiagnostic(f.target, {
      env,
      clock: () => Number.POSITIVE_INFINITY,
    });
    expect(await f.target.receipt(f.tx)).toBe(f.result);
    expect(observer.snapshot().status).toBe('UNKNOWN');
    expect(observer.snapshot().diagnosticMs).toBeNull();
    expect(observer.snapshot().nativeReceiptMs).toBeNull();
    expect(JSON.stringify(observer.snapshot())).not.toMatch(/Infinity|NaN/u);
    observer.restore();
  });
});
