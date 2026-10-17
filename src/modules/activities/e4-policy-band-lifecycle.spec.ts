import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Execute the real suite callbacks with inert dependencies. These failure paths must
// be tested without opening a database or rebuilding the successful business fixture.
function suite() {
  const before: (() => Promise<void>)[] = [];
  const after: (() => Promise<void>)[] = [];
  const cases: { name: string; run: (argument?: boolean) => Promise<void> }[] = [];
  let finalize!: () => void;
  const db = {
    $queryRaw: jest.fn((parts: TemplateStringsArray): Promise<unknown[]> => {
      const sql = parts.join('?');
      if (sql.includes('SELECT relname AS name'))
        return Promise.resolve(Array.from({ length: 196 }, (_, index) => ({ name: `T${index}` })));
      if (sql.includes('AS count,(SELECT md5(prosrc)'))
        return Promise.resolve([{ count: 145, pin: 'b03a7298e625b703fa2f011c0fbcc6c0' }]);
      if (sql.includes('pg_stat_activity')) return Promise.resolve([{ remaining: 0 }]);
      return Promise.resolve([]);
    }),
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ hash: 'synthetic' }]),
    activitySettlementContributionRevision: {
      findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'synthetic_root' }),
    },
    participantContributionEvaluation: { count: jest.fn().mockResolvedValue(400) },
  };
  const fixture = { db };
  const create = jest.fn().mockResolvedValue(fixture);
  const close = jest.fn().mockResolvedValue(undefined);
  const owner = {
    deployEvaluationKeyMigrations: jest.fn().mockResolvedValue(undefined),
    deployLatestMigrations: jest.fn().mockResolvedValue(undefined),
  };
  const child = jest
    .fn<
      {
        status: number | null;
        signal: string | null;
        error?: Error;
        stdout: string;
        stderr: string;
      },
      unknown[]
    >()
    .mockReturnValue({
      status: 0,
      signal: null,
      error: undefined,
      stdout: '',
      stderr:
        'NOTICE:  E4_PB_CONTROL {"case":"POSITIVE","versions":[145,146],"completeFunction":true}\n',
    });
  const install = jest.fn((options: { assertReadyToFinalize: () => void }) => {
    finalize = options.assertReadyToFinalize;
    return owner;
  });
  const register = (name: string, run: (argument?: boolean) => Promise<void>) => {
    cases.push({ name, run });
  };
  const it = Object.assign(register, { each: () => register });
  const code = ts.transpileModule(
    readFileSync(
      resolve(
        __dirname,
        '../../../test/e2e/activity-os-r5-e4-policy-band-plan-migration.e2e-spec.ts',
      ),
      'utf8',
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    },
  ).outputText;
  runInNewContext(code, {
    exports: {},
    expect,
    performance,
    process: { env: {}, pid: 12345 },
    console: { info: jest.fn() },
    beforeAll: (callback: () => Promise<void>) => before.push(callback),
    afterAll: (callback: () => Promise<void>) => after.push(callback),
    describe: (_name: string, callback: () => void) => callback(),
    it,
    require: (name: string): unknown => {
      if (name === 'node:child_process') return { spawnSync: child };
      if (name === 'node:fs')
        return {
          mkdtempSync: () => {
            throw new Error('Synthetic evidence disk failure');
          },
        };
      if (name === 'node:crypto' || name === 'node:path' || name === 'node:os')
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require(name) as unknown;
      if (name === '@prisma/client') return {};
      if (name.endsWith('activity-contribution-policy.fixture'))
        return {
          installE4ValidationDatabase: install,
          createE4Fixture: create,
          closeE13Fixture: close,
          prepareE4Time: jest.fn().mockResolvedValue({ settlementVersionId: 'synthetic_version' }),
        };
      if (name.endsWith('e4-prepare-cost.diagnostic-spec'))
        return {
          createDiagnosticE4Source: jest.fn().mockResolvedValue({}),
          verifyPolicyBandMigrationSource: jest.fn(),
          verifyPolicyBandDatabase: jest.fn(),
        };
      if (name.endsWith('e4-policy-band-plan.fixture'))
        return { policyBandControlsSql: () => 'BEGIN; ROLLBACK;' };
      if (name.endsWith('worktree-db')) return { deriveTestDbName: () => 'app_test_w98' };
      if (name.endsWith('test-db')) return {};
      throw new Error(`Unexpected offline suite dependency: ${name}`);
    },
  });
  return { before, after, cases, db, create, close, owner, child, finalize: () => finalize() };
}

describe('146 suite terminal ownership failure injection', () => {
  it('keeps failed initialization UNKNOWN rather than marking an absent fixture closed', async () => {
    const harness = suite();
    const failure = new Error('Synthetic initialization and cleanup failure');
    harness.create.mockRejectedValue(failure);
    await expect(harness.before[0]()).rejects.toBe(failure);
    await expect(harness.after[0]()).rejects.toThrow('initialization close terminal UNKNOWN');
    expect(harness.close).not.toHaveBeenCalled();
    expect(harness.finalize).toThrow('finalizer refused');
  });
  it('awaits the budgeted145 deploy and refuses finalization until setup and app close settle', async () => {
    const harness = suite();
    let finish!: () => void;
    harness.owner.deployEvaluationKeyMigrations.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = harness.before[0]();
    expect(harness.create).not.toHaveBeenCalled();
    expect(harness.finalize).toThrow('finalizer refused');
    expect(harness.owner.deployEvaluationKeyMigrations).toHaveBeenCalledWith(expect.any(Number));
    finish();
    await pending;
    expect(harness.finalize).toThrow('finalizer refused');
    await harness.after[0]();
    expect(harness.finalize).not.toThrow();
  });
  it('passes a decreasing remaining budget to both latest deploy calls', async () => {
    const harness = suite();
    await harness.before[0]();
    await harness.cases[0].run();
    const calls = harness.owner.deployLatestMigrations.mock.calls as unknown as [number][];
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBeGreaterThan(0);
    expect(calls[0][0]).toBeLessThanOrEqual(57000);
    expect(calls[1][0]).toBeLessThanOrEqual(calls[0][0]);
    await harness.after[0]();
    expect(harness.finalize).not.toThrow();
  });
  it('keeps a timed-out child UNKNOWN even if the named backend is gone and evidence disk fails', async () => {
    const harness = suite();
    await harness.before[0]();
    await harness.cases[0].run();
    harness.child.mockReturnValue({
      status: null,
      signal: 'SIGTERM',
      error: Object.assign(new Error('Synthetic timeout'), { code: 'ETIMEDOUT' }),
      stdout: '',
      stderr: 'synthetic stderr',
    });
    await expect(harness.cases[1].run(false)).rejects.toThrow(
      'terminalUnknown=true retained=false',
    );
    await harness.after[0]();
    expect(harness.finalize).toThrow('finalizer refused');
  });
  it('refuses DROP when the independent backend query cannot establish termination', async () => {
    const harness = suite();
    await harness.before[0]();
    await harness.cases[0].run();
    const query = harness.db.$queryRaw.getMockImplementation()!;
    harness.db.$queryRaw.mockImplementation((parts) =>
      parts.join('?').includes('pg_stat_activity')
        ? Promise.reject(new Error('Synthetic catalog unavailable'))
        : query(parts),
    );
    await expect(harness.cases[1].run(false)).rejects.toThrow(
      'ownedBackends=-1 terminalUnknown=true',
    );
    await harness.after[0]();
    expect(harness.finalize).toThrow('finalizer refused');
  });
});
