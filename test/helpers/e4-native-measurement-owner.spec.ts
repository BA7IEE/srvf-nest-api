import childProcess from 'node:child_process';
import { deriveTestDbName } from '../setup/worktree-db';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import {
  E4NativeMeasurementOwner,
  e4NativeMeasurementDatabase,
  withE4NativeMeasurementBinding,
} from './e4-native-measurement-owner';
import {
  ScratchLeaseSession,
  acquireScratchDatabaseReadLease,
  type ScratchSessionTransport,
} from './scratch-database-lease';

function actualLeaseProtocol() {
  let data: (value: string) => void = () => undefined;
  let closed: () => void = () => undefined;
  const statements: string[] = [];
  const transport: ScratchSessionTransport = {
    send: (value) => {
      statements.push(value);
      const marker = value
        .split('\n')
        .find((line) => line.startsWith('\\echo '))!
        .slice(6);
      const result = value.includes('current_database()')
        ? 'postgres|\n'
        : value.includes('SELECT pg_backend_pid()')
          ? '42\n'
          : '';
      data(result + marker + '\n');
    },
    onData: (listener) => {
      data = listener;
    },
    onClosed: (listener) => {
      closed = listener;
    },
    close: jest.fn(async () => {
      closed();
    }),
    stop: jest.fn(() => {
      closed();
    }),
  };
  const owner = new ScratchLeaseSession(transport);
  return { owner, statements, transport, lose: () => closed() };
}

function ordinaryController(database = 'app_test_w2') {
  const lease = actualLeaseProtocol();
  const current = { database };
  const acquire = jest.fn(async () => {
    await lease.owner.acquire(1000);
    return lease.owner;
  });
  const controller = new E4NativeMeasurementOwner(false, () => undefined, 'app_test_w98', {
    database: () => current.database,
    acquire,
  });
  return { controller, current, acquire, ...lease };
}

describe('E4 native measurement owner offline', () => {
  it('binds an ordinary worker to the actual held original protocol without lifecycle DDL', async () => {
    const f = ordinaryController();
    expect(() => f.controller.current()).toThrow('original lease owner missing');
    await f.controller.start();
    expect(f.acquire).toHaveBeenCalledWith('app_test_w2');
    const binding = f.controller.current();
    await withE4NativeMeasurementBinding(binding, async () => {
      expect(e4NativeMeasurementDatabase('app_test_w98')).toBe('app_test_w2');
      await Promise.resolve();
      expect(e4NativeMeasurementDatabase('app_test_w98')).toBe('app_test_w2');
    });
    expect(e4NativeMeasurementDatabase('app_test_w98')).toBe('app_test_w98');
    expect(f.statements.some((s) => s.includes('SRVF:test:D3:app_test_w98'))).toBe(true);
    expect(f.statements.some((s) => /DROP|CREATE|TRUNCATE|terminate_backend/u.test(s))).toBe(false);
    await f.controller.finish();
    expect(f.transport.close).toHaveBeenCalledTimes(1);
    expect(() => withE4NativeMeasurementBinding(binding, () => undefined)).toThrow('not owned');
  });

  it('reuses the dedicated lifecycle owner and leaves release to its original finalizer', async () => {
    const lease = actualLeaseProtocol();
    await lease.owner.acquire(1000);
    const acquire = jest.fn();
    const controller = new E4NativeMeasurementOwner(true, () => lease.owner, 'app_test_w98', {
      database: () => 'app_test_w98',
      acquire,
    });
    await controller.start();
    expect(controller.current().owner).toBe(lease.owner);
    expect(acquire).not.toHaveBeenCalled();
    await controller.finish();
    expect(lease.transport.close).not.toHaveBeenCalled();
    lease.owner.assertHeld();
    await lease.owner.release();
  });

  it('refuses a missing dedicated owner without falling back to another acquisition', async () => {
    const acquire = jest.fn();
    const controller = new E4NativeMeasurementOwner(true, () => undefined, 'app_test_w98', {
      database: () => 'app_test_w98',
      acquire,
    });
    await expect(controller.start()).rejects.toThrow('original lease owner missing');
    expect(acquire).not.toHaveBeenCalled();
    await controller.finish();
  });

  it('refuses a dedicated scope mismatch before looking up or acquiring an owner', async () => {
    const lookup = jest.fn();
    const acquire = jest.fn();
    const controller = new E4NativeMeasurementOwner(true, lookup, 'app_test_w98', {
      database: () => 'app_test_w2',
      acquire,
    });
    await expect(controller.start()).rejects.toThrow('dedicated scope differs');
    expect(lookup).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it('fences measurement when the owner is lost or the assigned worker changes', async () => {
    const f = ordinaryController();
    await f.controller.start();
    const binding = f.controller.current();
    f.current.database = 'app_test_w1';
    expect(() => withE4NativeMeasurementBinding(binding, () => undefined)).toThrow('scope changed');
    f.current.database = 'app_test_w2';
    f.lose();
    expect(() => withE4NativeMeasurementBinding(binding, () => undefined)).toThrow('lease lost');
    await f.controller.finish();
  });

  it('restores the default scope after an interrupted callback and refuses nested or forged bindings', async () => {
    const f = ordinaryController();
    await f.controller.start();
    const binding = f.controller.current();
    await expect(
      withE4NativeMeasurementBinding(binding, async () => {
        expect(() => withE4NativeMeasurementBinding(binding, () => undefined)).toThrow('nested');
        throw new Error('controlled');
      }),
    ).rejects.toThrow('controlled');
    expect(e4NativeMeasurementDatabase('app_test_w98')).toBe('app_test_w98');
    expect(() => withE4NativeMeasurementBinding({ ...binding }, () => undefined)).toThrow(
      'not owned',
    );
    await f.controller.finish();
  });

  it('keeps two async measurements isolated and rejects use after finalization', async () => {
    const a = ordinaryController('app_test_w1');
    const b = ordinaryController('app_test_w2');
    await a.controller.start();
    await b.controller.start();
    await Promise.all(
      [a, b].map((f) =>
        withE4NativeMeasurementBinding(f.controller.current(), async () => {
          await Promise.resolve();
          expect(e4NativeMeasurementDatabase('app_test_w98')).toBe(f.current.database);
          await f.controller.finish();
          expect(() => e4NativeMeasurementDatabase('app_test_w98')).toThrow('no longer owned');
        }),
      ),
    );
    expect(e4NativeMeasurementDatabase('app_test_w98')).toBe('app_test_w98');
  });

  it('refuses duplicate starts and closes a newly acquired owner when validation fails', async () => {
    const f = ordinaryController();
    await f.controller.start();
    await expect(f.controller.start()).rejects.toThrow('start twice');
    await f.controller.finish();
    await f.controller.finish();
    expect(f.transport.close).toHaveBeenCalledTimes(1);
    const unknown = actualLeaseProtocol();
    const controller = new E4NativeMeasurementOwner(false, () => undefined, 'app_test_w98', {
      database: () => 'app_test_w2',
      acquire: async () => unknown.owner,
    });
    await expect(controller.start()).rejects.toThrow('lease lost');
    expect(unknown.transport.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a read-lease request for another worker before opening any process', async () => {
    const previous = process.env.JEST_WORKER_ID;
    process.env.JEST_WORKER_ID = '2';
    try {
      await expect(acquireScratchDatabaseReadLease('app_test_w98')).rejects.toThrow(
        'assigned worker differs',
      );
    } finally {
      if (previous === undefined) delete process.env.JEST_WORKER_ID;
      else process.env.JEST_WORKER_ID = previous;
    }
  });
});

function originalNativeRuntime(f: ReturnType<typeof ordinaryController>) {
  const source = readFileSync(
    resolve(__dirname, '../e2e/activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts'),
    'utf8',
  );
  const ast = ts.createSourceFile('native.ts', source, ts.ScriptTarget.Latest, true);
  const names = new Set([
    'withTerminalNative',
    'terminalAssertIdentity',
    'terminalIdle',
    'terminalBusinessPrincipal',
    'terminalNativeIdentity',
    'terminalRemaining',
    'terminalRequestBudget',
    'terminalCleanupKnown',
  ]);
  const bodies = ast.statements
    .filter((node) => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text))
    .map((node) => node.getText(ast));
  expect(bodies).toHaveLength(names.size);
  const clients: TestReadClient[] = [];
  const observations: { values: (string | number | undefined)[] }[] = [];
  class TestReadClient {
    closed = false;
    connect = jest.fn(async () => undefined);
    constructor(readonly database: string) {
      clients.push(this);
    }
    async query(sql: string, values: (string | number | undefined)[] = []) {
      if (sql.includes('pg_stat_activity')) {
        observations.push({ values });
        return { rows: [{ idle: true }] };
      }
      if (sql.includes('current_database()'))
        return {
          rows: [{ db: this.database, pid: 71, session: 'postgres', principal: 'postgres' }],
        };
      return { rows: [] };
    }
    async end() {
      this.closed = true;
    }
    terminalState() {
      return { pending: false, closed: this.closed };
    }
  }
  const context = createContext({
    S13ReadClient: TestReadClient,
    S13_LOCAL_DB: 'app_test_w98',
    terminalMigrationNativeOwner: f.controller,
    terminalMigrationLease: { owner: f.owner },
    terminalMigrationPending: 0,
    terminalMigrationFailed: false,
    e4NativeMeasurementDatabase,
    withE4NativeMeasurementBinding,
    performance,
    console: { info: jest.fn() },
    terminalInstallOpening: async () => ({ current: {} }),
    terminalDropOpening: async (
      plan: TestReadClient,
      monitor: TestReadClient,
      deadline: number,
      identity: object,
    ) => {
      const idle = Reflect.get(context, 'terminalIdle') as (
        p: TestReadClient,
        m: TestReadClient,
        d: number,
        i: object,
      ) => Promise<void>;
      await idle(plan, monitor, deadline, identity);
    },
  });
  const js = ts.transpileModule(bodies.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInContext(js, context, { timeout: 1000 });
  const run = Reflect.get(context, 'withTerminalNative') as (
    db: object,
    work: (client: TestReadClient, deadline: number, identity: { db: string }) => Promise<string>,
  ) => Promise<string>;
  const assertIdentity = Reflect.get(context, 'terminalAssertIdentity') as (
    actual: object,
    expected: object,
  ) => void;
  const business = {
    $queryRawUnsafe: jest.fn(async () => [
      { db: f.current.database, session: 'postgres', principal: 'postgres' },
    ]),
  };
  return { run, assertIdentity, business, clients, observations, context };
}

describe('E4 native original orchestration offline', () => {
  it('runs the actual native helper against the bound worker and checks cleanup on the same database', async () => {
    const f = ordinaryController();
    await f.controller.start();
    const runtime = originalNativeRuntime(f);
    await expect(
      runtime.run(runtime.business, async (_client, _deadline, identity) => {
        await Promise.resolve();
        expect(identity.db).toBe('app_test_w2');
        expect(e4NativeMeasurementDatabase('app_test_w98')).toBe('app_test_w2');
        return 'complete';
      }),
    ).resolves.toBe('complete');
    expect(runtime.clients.map((c) => c.database)).toEqual(['app_test_w2', 'postgres']);
    expect(runtime.clients.every((c) => c.closed)).toBe(true);
    expect(runtime.observations).toEqual([{ values: [71, 'app_test_w2'] }]);
    expect(Reflect.get(runtime.context, 'terminalMigrationPending')).toBe(0);
    expect(Reflect.get(runtime.context, 'terminalMigrationFailed')).toBe(false);
    expect(e4NativeMeasurementDatabase('app_test_w98')).toBe('app_test_w98');
    await f.controller.finish();
  });

  it('keeps the actual identity guard strict both in owned worker context and default retained context', async () => {
    const f = ordinaryController();
    await f.controller.start();
    const runtime = originalNativeRuntime(f);
    const identity = { db: 'app_test_w2', pid: 71, session: 'postgres', principal: 'postgres' };
    await withE4NativeMeasurementBinding(f.controller.current(), async () => {
      expect(() => runtime.assertIdentity(identity, identity)).not.toThrow();
      expect(() => runtime.assertIdentity({ ...identity, db: 'app_test_w1' }, identity)).toThrow(
        'scope/PID/principal mismatch',
      );
      expect(() => runtime.assertIdentity({ ...identity, pid: 72 }, identity)).toThrow(
        'scope/PID/principal mismatch',
      );
    });
    expect(() => runtime.assertIdentity(identity, identity)).toThrow(
      'scope/PID/principal mismatch',
    );
    const retained = { ...identity, db: 'app_test_w98' };
    expect(() => runtime.assertIdentity(retained, retained)).not.toThrow();
    await f.controller.finish();
  });

  it('refuses owner loss before the actual helper constructs or opens measurement clients', async () => {
    const f = ordinaryController();
    await f.controller.start();
    const runtime = originalNativeRuntime(f);
    f.lose();
    await expect(runtime.run(runtime.business, async () => 'invalid')).rejects.toThrow(
      'lease lost',
    );
    expect(runtime.clients).toHaveLength(0);
    expect(runtime.business.$queryRawUnsafe).not.toHaveBeenCalled();
    await f.controller.finish();
  });
});

describe('E4 native actual assigned scope guard offline', () => {
  it('refuses absent workers, mismatched database URLs and undeclared scope before any process can open', async () => {
    const saved = {
      worker: process.env.JEST_WORKER_ID,
      url: process.env.DATABASE_URL,
      scope: process.env.SRVF_TEST_RUN_SCOPE,
    };
    const exec = jest.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      throw new Error('No database process permitted in this offline test');
    });
    const spawn = jest.spyOn(childProcess, 'spawn').mockImplementation(() => {
      throw new Error('No database process permitted in this offline test');
    });
    const controller = () => new E4NativeMeasurementOwner(false, () => undefined, 'app_test_w98');
    try {
      delete process.env.JEST_WORKER_ID;
      await expect(controller().start()).rejects.toThrow('assigned worker missing');
      process.env.JEST_WORKER_ID = '2';
      process.env.DATABASE_URL = 'postgresql://postgres@127.0.0.1:5432/app_test_wrong_worker';
      await expect(controller().start()).rejects.toThrow();
      process.env.DATABASE_URL = 'postgresql://postgres@127.0.0.1:5432/' + deriveTestDbName();
      process.env.SRVF_TEST_RUN_SCOPE = 'app_test_undeclared';
      await expect(controller().start()).rejects.toThrow('超出已声明范围');
      expect(exec).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      exec.mockRestore();
      spawn.mockRestore();
      for (const [key, value] of [
        ['JEST_WORKER_ID', saved.worker],
        ['DATABASE_URL', saved.url],
        ['SRVF_TEST_RUN_SCOPE', saved.scope],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
