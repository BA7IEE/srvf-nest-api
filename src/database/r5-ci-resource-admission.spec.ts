import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const memoryReader = resolve('test/helpers/r5_ci_resources.py');
const probe = `
import importlib.util,json,sys,tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('r5_resources',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
case=json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix='r5-memory-test-') as directory:
 root=Path(directory)
 (root/'meminfo').write_text(case.get('meminfo','MemTotal: 8388608 kB\\nMemAvailable: 6291456 kB\\n'))
 for field in ['memory.max','memory.current']:
  if field in case: (root/field).write_text(case[field])
 try: print(json.dumps(module.memory_admission(root,root/'meminfo')))
 except (ValueError,FileNotFoundError) as error: print(json.dumps({'error':str(error)}))
`;
function readMemory(input: Record<string, string | undefined>): Record<string, unknown> {
  return JSON.parse(
    execFileSync('python3', ['-B', '-c', probe, memoryReader], {
      input: JSON.stringify(input),
      encoding: 'utf8',
    }),
  ) as Record<string, unknown>;
}

describe('isolated CI memory admission reads actual root/cgroup boundaries', () => {
  it('fits the isolated WAL targets inside the unchanged tmpfs and memory caps', () => {
    const result = JSON.parse(
      execFileSync(
        'python3',
        [
          '-B',
          '-c',
          `import ast,json,shlex,sys
from pathlib import Path
tree=ast.parse(Path(sys.argv[1]).read_text())
names={'PG_MEMORY_BYTES','NODE_MEMORY_BYTES','PG_DATA_TMPFS_BYTES','FIXTURE_MEMORY_BUDGET_BYTES','PG_MAX_WAL_BYTES','PG_MIN_WAL_BYTES'}
nodes=[node for node in tree.body if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id in names for target in node.targets)]
shells=[node for node in ast.walk(tree) if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='shell' for target in node.targets)]
assert len(nodes)==len(names) and len(shells)==1
scope={'hba':'test-only','socket':'/run/r5-pg-socket'}
exec(compile(ast.Module(body=nodes+shells,type_ignores=[]),'<isolated-pg-settings>','exec'),scope)
argv=shlex.split(scope['shell'].split('exec su-exec postgres postgres ',1)[1])
options=[argv[i+1] for i,word in enumerate(argv) if word=='-c']
print(json.dumps({'caps':{name:scope[name] for name in names},'options':options}))`,
          resolve('test/helpers/r5-ci-authentication.py'),
        ],
        { encoding: 'utf8' },
      ),
    ) as { caps: Record<string, number>; options: string[] };
    expect(result.caps).toEqual({
      PG_MEMORY_BYTES: 1536 * 1024 ** 2,
      NODE_MEMORY_BYTES: 2 * 1024 ** 3,
      PG_DATA_TMPFS_BYTES: 1024 ** 3,
      FIXTURE_MEMORY_BUDGET_BYTES: 3584 * 1024 ** 2,
      PG_MAX_WAL_BYTES: 128 * 1024 ** 2,
      PG_MIN_WAL_BYTES: 32 * 1024 ** 2,
    });
    expect(result.options).toEqual([
      'max_wal_size=128MB',
      'min_wal_size=32MB',
      'listen_addresses=127.0.0.1',
      'unix_socket_directories=/run/r5-pg-socket',
    ]);
  });

  it.each([{}, { 'memory.max': 'max\n' }])(
    'uses bounded host evidence when the root has no finite cgroup limit: %j',
    (input) => {
      expect(readMemory(input)).toEqual({
        source: 'host-root',
        memoryLimitBytes: 8 * 1024 ** 3,
        memoryUsedBytes: 2 * 1024 ** 3,
        memoryAvailableBytes: 6 * 1024 ** 3,
      });
    },
  );
  it('uses the smaller finite cgroup headroom without treating it as host free memory', () => {
    expect(
      readMemory({ 'memory.max': String(8 * 1024 ** 3), 'memory.current': String(5 * 1024 ** 3) }),
    ).toMatchObject({ source: 'cgroup', memoryAvailableBytes: 3 * 1024 ** 3 });
    expect(
      readMemory({ 'memory.max': String(16 * 1024 ** 3), 'memory.current': '0' }),
    ).toMatchObject({ source: 'cgroup', memoryAvailableBytes: 6 * 1024 ** 3 });
  });
  it.each([
    { 'memory.max': '0', 'memory.current': '0' },
    { 'memory.max': 'invalid', 'memory.current': '0' },
    { 'memory.max': '100', 'memory.current': '-1' },
    { 'memory.max': '100', 'memory.current': '101' },
    { 'memory.max': '100' },
    { meminfo: 'MemTotal: 100 kB\nMemAvailable: 101 kB\n' },
    { meminfo: 'MemTotal: 100 kB\n' },
  ])('rejects malformed, incomplete or contradictory evidence: %j', (input) => {
    expect(readMemory(input)).toHaveProperty('error');
  });
});

describe('ADV010 ordinary concurrency uses independent observation within the CI connection cap', () => {
  function arrange(authenticated = true) {
    const source = readFileSync(
      resolve('test/e2e/activity-os-r5-adv010-contribution-progress.e2e-spec.ts'),
      'utf8',
    );
    const ast = ts.createSourceFile('adv010.ts', source, ts.ScriptTarget.Latest, true);
    const functions: ts.FunctionDeclaration[] = [];
    const find = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'ordinaryConcurrencyApps')
        functions.push(node);
      ts.forEachChild(node, find);
    };
    find(ast);
    expect(functions).toHaveLength(1);
    let clients = authenticated ? 3 : 1;
    let maximum = clients;
    const close = jest.fn(() => {
      clients -= 2;
      return Promise.resolve();
    });
    const fixture = { db: {}, humanApp: authenticated ? { close } : undefined };
    const created: Array<{ get: jest.Mock; db: object }> = [];
    const appWithState = jest.fn(() => {
      clients++;
      maximum = Math.max(maximum, clients);
      const db = {};
      const app = { get: jest.fn(() => db), db };
      created.push(app);
      return Promise.resolve(app);
    });
    const scope = {
      f: fixture,
      r5CiAuthenticated: () => authenticated,
      PrismaService: Symbol('ordinary observer'),
      appWithState,
    };
    const code = ts.transpileModule('(' + functions[0].getText(ast) + ')', {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const run = runInNewContext(code, scope) as () => Promise<{
      secondApp: object;
      observationDb: object;
      progressApp: object;
    }>;
    return { run, close, created, appWithState, fixture, scope, maximum: () => maximum };
  }

  it('uses one separate reader for SQL and real HTTP progress without increasing the five-connection cap', async () => {
    const fixture = arrange();
    const result = await fixture.run();
    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(fixture.scope.f.humanApp).toBeUndefined();
    expect(result.secondApp).toBe(fixture.created[0]);
    expect(result.progressApp).toBe(fixture.created[1]);
    expect(result.observationDb).toBe(fixture.created[1].db);
    expect(result.observationDb).not.toBe(fixture.fixture.db);
    expect(fixture.maximum() + 1).toBeLessThanOrEqual(5); // existing holder client
    expect(fixture.appWithState.mock.calls).toEqual([
      [true, false],
      [true, false],
    ]);
  });

  it('preserves the existing non-authenticated fixture path', async () => {
    const fixture = arrange(false);
    const result = await fixture.run();
    expect(fixture.close).not.toHaveBeenCalled();
    expect(fixture.created).toHaveLength(1);
    expect(result.observationDb).toBe(fixture.fixture.db);
    expect(result.progressApp).toBe(result.secondApp);
  });

  it('awaits successful scope close before creating its replacement reader', async () => {
    const fixture = arrange();
    let finish!: () => void;
    let entered!: () => void;
    const closing = new Promise<void>((resolve) => (entered = resolve));
    fixture.close.mockImplementationOnce(() => {
      entered();
      return new Promise<void>((resolve) => (finish = resolve));
    });
    const pending = fixture.run();
    await closing;
    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(fixture.created).toHaveLength(1);
    expect(fixture.scope.f.humanApp).toBeDefined();
    finish();
    await pending;
    expect(fixture.created).toHaveLength(2);
    expect(fixture.scope.f.humanApp).toBeUndefined();
  });

  it('propagates a failed close without a new reader or false cleanup completion', async () => {
    const fixture = arrange();
    const error = new Error('scope close failed');
    fixture.close.mockRejectedValueOnce(error);
    await expect(fixture.run()).rejects.toBe(error);
    expect(fixture.created).toHaveLength(1);
    expect(fixture.scope.f.humanApp).toBeDefined();
  });
});

describe('D4 worker reconstruction retains the all-backends-zero guard', () => {
  function recreation(frames: unknown[], queryDelay = 0) {
    const file = resolve('test/e2e/activity-os-r4-d4-time-bucket-migration.e2e-spec.ts');
    const source = readFileSync(file, 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const names = ['waitForD4WorkerQuiescence', 'recreate', 'literal'];
    const functions = ast.statements.filter(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && !!node.name && names.includes(node.name.text),
    );
    expect(functions).toHaveLength(3);
    let time = 0;
    let index = 0;
    const calls: Array<{ argv: string[]; options?: { input?: string; timeout?: number } }> = [];
    const drop = jest.fn();
    const info = jest.fn();
    const scope = {
      target: () => ({ database: 'app_test_w4', worker: '4' }),
      performance: { now: () => time },
      console: { info },
      Atomics: {
        wait: (_buffer: unknown, _offset: number, _value: number, duration: number) => {
          time += duration;
          return 'timed-out';
        },
      },
      execFileSync: (
        _command: string,
        argv: string[],
        options?: { input?: string; timeout?: number },
      ) => {
        calls.push({ argv, options });
        if (argv[0] === 'context') return 'unix:///fixture-only';
        if (argv.includes('psql')) {
          time += queryDelay;
          const value = frames[Math.min(index++, frames.length - 1)];
          return typeof value === 'string' ? value : JSON.stringify(value);
        }
        return '';
      },
      dropWorkerDatabase: drop,
      sql: () => 'app_test_w4',
    };
    const code = ts.transpileModule(
      functions.map((node) => node.getText(ast)).join('\n') + '\nrecreate;',
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    const run = runInNewContext(code, scope) as () => void;
    return { run, calls, drop, info, time: () => time };
  }

  it('uses the same target-wide predicate and normal DROP only after an empty snapshot', () => {
    const fixture = recreation([[]]);
    fixture.run();
    expect(fixture.drop).toHaveBeenCalledWith('4');
    const reads = fixture.calls.filter((call) => call.argv.includes('psql'));
    expect(reads).toHaveLength(1);
    expect(reads[0].options?.input?.split('FROM pg_stat_activity')[1]).toBe(
      " WHERE datname = 'app_test_w4'",
    );
    expect(reads[0].options?.timeout).toBe(1_000);
    expect(fixture.calls.filter((call) => call.argv.includes('createdb'))).toHaveLength(1);
  });

  it('waits for actual disappearance and retains the prior PID/classification', () => {
    const fixture = recreation([[{ pid: 51, kind: 'CLIENT', state: 'IDLE' }], []]);
    fixture.run();
    expect(fixture.time()).toBe(25);
    expect(fixture.drop).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fixture.info.mock.calls)).toContain('QUIESCENT');
    expect(JSON.stringify(fixture.info.mock.calls)).toContain('51');
  });

  it.each(['CLIENT', 'AUTOVACUUM', 'OTHER'])(
    'refuses a persistent %s backend without filtering it out or terminating it',
    (kind) => {
      const fixture = recreation([[{ pid: 51, kind, state: 'ACTIVE' }]]);
      expect(() => fixture.run()).toThrow('DEADLINE');
      expect(fixture.time()).toBe(1_000);
      expect(fixture.drop).not.toHaveBeenCalled();
      expect(fixture.calls.some((call) => call.argv.includes('createdb'))).toBe(false);
      for (const call of fixture.calls.filter((call) => call.argv.includes('psql'))) {
        expect(call.options?.timeout).toBeGreaterThan(0);
        expect(call.options?.timeout).toBeLessThanOrEqual(1_000);
      }
    },
  );

  it.each([
    { kind: 'invalid JSON', frame: 'invalid JSON' },
    { kind: 'invalid PID', frame: [{ pid: 'DO_NOT_LOG', kind: 'CLIENT', state: 'IDLE' }] },
  ])('refuses $kind without reconstruction or raw metadata output', ({ frame }) => {
    const fixture = recreation([frame]);
    expect(() => fixture.run()).toThrow('INVALID_SNAPSHOT');
    expect(fixture.drop).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.info.mock.calls)).not.toContain('DO_NOT_LOG');
  });

  it('refuses even an empty response arriving outside the one-second observation window', () => {
    const fixture = recreation([[]], 1_001);
    expect(() => fixture.run()).toThrow('DEADLINE');
    expect(fixture.drop).not.toHaveBeenCalled();
  });
});
