import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import vm from 'node:vm';
import {
  E4_MAXIMUM_STAGES,
  assertE4PrepareAcceptanceV2,
  restoreE4PrepareAcceptanceV2Opening,
  restoreE4LiveCatalog140Opening,
  E4CapacityFinalization,
  e4CapacityRetentionRequested,
  E4_CAPACITY_CASE_NAMES,
  type E4CapacityFinalizationStage,
  type E4PrepareTransactionFactsV2,
  E4MaximumStageReceipt,
  restoreE4MaximumStageOpening,
  restoreE4HistoricalCatalogOpening,
  restoreE4HistoricalCiFixtureOpening,
  restoreE4OrdinaryOracleOpening,
} from '../../../test/helpers/e4-maximum-stage-receipt';

describe('E4 owned capacity finalizer without a database', () => {
  const cleanups = ['app-close', 'review-close', 'observer-cleanup', 's13-probe'] as const;
  const finish = async (guard: E4CapacityFinalization, which: 's13' | 'maximum') => {
    await guard.run('fixture', () => Promise.resolve(undefined));
    await guard.run(which, () => Promise.resolve(undefined));
    for (const stage of cleanups) await guard.run(stage, () => Promise.resolve(undefined));
  };
  it.each(['s13', 'maximum'] as const)(
    'allows the original cleanup only after complete %s PASS',
    async (which) => {
      const guard = new E4CapacityFinalization(true);
      await finish(guard, which);
      const drop = jest.fn();
      guard.assertReadyToFinalize();
      drop();
      expect(drop).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['fixture', 's13', 'maximum', ...cleanups] as const)(
    'preserves failure in %s even when later cleanup succeeds',
    async (stage) => {
      const guard = new E4CapacityFinalization(true);
      const failure = new Error(stage);
      await expect(guard.run(stage, () => Promise.reject(failure))).rejects.toBe(failure);
      for (const next of ['fixture', 'maximum', ...cleanups] as const) {
        if (next !== stage) await guard.run(next, () => Promise.resolve(undefined));
      }
      const drop = jest.fn();
      expect(() => {
        guard.assertReadyToFinalize();
        drop();
      }).toThrow('preserve database');
      expect(drop).not.toHaveBeenCalled();
    },
  );
  it.each(['no initialization', 'no case', 'partial cleanup'] as const)(
    'preserves %s',
    async (kind) => {
      const guard = new E4CapacityFinalization(true);
      if (kind !== 'no initialization')
        await guard.run('fixture', () => Promise.resolve(undefined));
      if (kind === 'partial cleanup') await guard.run('maximum', () => Promise.resolve(undefined));
      expect(() => guard.assertReadyToFinalize()).toThrow('preserve database');
    },
  );
  it('keeps UNKNOWN sticky after a timed-out operation eventually fulfills', async () => {
    const guard = new E4CapacityFinalization(true);
    await guard.run('fixture', () => Promise.resolve(undefined));
    let release!: () => void;
    const pending = guard.run(
      'maximum',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    for (const stage of cleanups) await guard.run(stage, () => Promise.resolve(undefined));
    expect(() => guard.assertReadyToFinalize()).toThrow('preserve database');
    release();
    await pending;
    expect(() => guard.assertReadyToFinalize()).toThrow('preserve database');
  });
  it('keeps a swallowed cleanup UNKNOWN sticky after a fulfilled business case', async () => {
    const guard = new E4CapacityFinalization(true);
    await finish(guard, 'maximum');
    guard.fail();
    expect(() => guard.assertReadyToFinalize()).toThrow('preserve database');
  });
  it('refuses repeated stage registration', async () => {
    const guard = new E4CapacityFinalization(true);
    await guard.run('fixture', () => Promise.resolve(undefined));
    await expect(guard.run('fixture', () => Promise.resolve(undefined))).rejects.toThrow(
      'repeated',
    );
    await guard.run('maximum', () => Promise.resolve(undefined));
    for (const stage of cleanups) await guard.run(stage, () => Promise.resolve(undefined));
    expect(() => guard.assertReadyToFinalize()).toThrow('preserve database');
  });
  it('preserves ordinary worker result and exception identity', async () => {
    const guard = new E4CapacityFinalization(false);
    const value = {};
    expect(await guard.run('fixture', () => Promise.resolve(value))).toBe(value);
    const failure = new Error('original');
    await expect(guard.run('maximum', () => Promise.reject(failure))).rejects.toBe(failure);
    guard.fail();
    expect(() => guard.assertReadyToFinalize()).not.toThrow();
  });
  it('does not gate unrelated dedicated diagnostics and arms on an actual capacity case', async () => {
    const guard = new E4CapacityFinalization(true, false);
    expect(() => guard.assertReadyToFinalize()).not.toThrow();
    await guard.run('maximum', () => Promise.resolve(undefined));
    expect(() => guard.assertReadyToFinalize()).toThrow('preserve database');
  });
  it.each(E4_CAPACITY_CASE_NAMES)('arms before fixture initialization for %s', (name) => {
    expect(
      e4CapacityRetentionRequested(['node', 'jest', '--testNamePattern', '^' + name + '$']),
    ).toBe(true);
    expect(e4CapacityRetentionRequested(['node', 'jest', '--testNamePattern=^' + name + '$'])).toBe(
      true,
    );
    expect(e4CapacityRetentionRequested(['node', 'jest', '-t', name])).toBe(true);
  });
  it('keeps missing, invalid or ambiguous selectors conservative', () => {
    for (const args of [[], ['-t'], ['--testNamePattern', '['], ['-tmaximum']])
      expect(e4CapacityRetentionRequested(args)).toBe(true);
    expect(e4CapacityRetentionRequested(['-t', 'E4 terminal expected measurement offline'])).toBe(
      false,
    );
  });
  it('wires the actual installer guard and encloses both entire business callbacks', () => {
    const source = readFileSync(
      resolve(
        __dirname,
        '../../../test/e2e/activity-os-r5-e4-contribution-settlement-scale.e2e-spec.ts',
      ),
      'utf8',
    );
    const tree = ts.createSourceFile(
      'scale.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const runs = new Map<string, ts.ArrowFunction>();
    let installer: ts.CallExpression | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'installE4ValidationDatabase'
        )
          installer = node;
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'capacityFinalization' &&
          node.expression.name.text === 'run'
        ) {
          const [stage, work] = node.arguments;
          if (ts.isStringLiteral(stage) && ts.isArrowFunction(work)) runs.set(stage.text, work);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    expect([...runs.keys()].sort()).toEqual(['fixture', 's13', 'maximum', ...cleanups].sort());
    const stages: E4CapacityFinalizationStage[] = ['s13', 'maximum'];
    for (const stage of stages) {
      const callback = runs.get(stage)!;
      expect(callback.body.getText(tree)).toContain(
        stage === 'maximum' ? 'await preflightE4SliceReadDiagnostic' : 's13Probe.active = true',
      );
      expect(callback.body.getText(tree)).toContain(
        stage === 'maximum' ? 'stages.assertReliable();' : 's13Probe.measuredClosed = true',
      );
    }
    expect(installer).toBeDefined();
    const guard = new E4CapacityFinalization(true);
    let captured: { assertReadyToFinalize(): void } | undefined;
    const javascript = ts.transpileModule(installer!.getText(tree), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(javascript, {
      capacityFinalization: guard,
      installE4ValidationDatabase: (options: { assertReadyToFinalize(): void }) => {
        captured = options;
      },
    });
    expect(captured).toBeDefined();
    expect(() => captured!.assertReadyToFinalize()).toThrow('preserve database');
  });
});

describe('E4 live140 catalog binding without a database', () => {
  const scalePath = resolve(
    __dirname,
    '../../../test/e2e/activity-os-r5-e4-contribution-settlement-scale.e2e-spec.ts',
  );
  const migrationPath = resolve(
    __dirname,
    '../../../prisma/migrations/20261012020000_activity_contribution_evaluation_canonical_fast_path/migration.sql',
  );
  const source = readFileSync(scalePath, 'utf8');
  const migration = readFileSync(migrationPath, 'utf8');
  const definitions = [
    'terminalExpectedDefinition',
    'terminalLiveExpectedCatalog',
    'terminalValidateCatalog',
  ].map((name) => {
    const matches = [
      ...source.matchAll(new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}', 'gm')),
    ];
    expect(matches).toHaveLength(1);
    return matches[0][0];
  });
  const code = ts.transpileModule(definitions.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const harness = vm.runInNewContext(
    code + '\n({ profile: terminalLiveExpectedCatalog, validate: terminalValidateCatalog })',
    {
      Buffer,
      readFileSync,
      resolve,
      __dirname: resolve(scalePath, '..'),
      E4_TERMINAL_OLD_BODY_MD5: 'eece3521b68d7ba6c67809866443c3ff',
      terminalHash: (text: string, algorithm = 'sha256') =>
        createHash(algorithm).update(text).digest('hex'),
    },
  ) as {
    profile: (text?: string) => { md5: string; bytes: number };
    validate: (rows: Record<string, unknown>[], identity: { pid: number }) => unknown;
  };
  const catalog = () => {
    const common = {
      pid: 17,
      ownerMatches: true,
      owner: 1,
      acl: null,
      language: 'sql',
      volatility: 's',
      strict: false,
      invoker: true,
      parallel: 'u',
      cost: 100,
      rows: 1000,
      config: ['search_path=pg_catalog, public'],
      args: 'revision_id text',
      result: 'TABLE(unit_canonical text, evaluation jsonb)',
      defaults: 0,
      defaultExpression: null,
    };
    return [
      {
        ...common,
        scope: 'public',
        schema: 'public',
        body: harness.profile().md5,
        bytes: 6124,
        temporary: false,
      },
      {
        ...common,
        scope: 'temporary',
        schema: 'pg_temp_7',
        body: 'eece3521b68d7ba6c67809866443c3ff',
        bytes: 4044,
        temporary: true,
      },
    ];
  };
  it('derives the current profile from the independently pinned complete migration140', () => {
    expect(harness.profile(migration)).toEqual({
      md5: '6fb49ac92a0821d16bfac37e115cde50',
      bytes: 6124,
    });
    expect(() => harness.validate(catalog(), { pid: 17 })).not.toThrow();
  });
  it.each(['extra newline', 'changed body', 'old137 function'])(
    'refuses untrusted migration input (%s)',
    (kind) => {
      const invalid =
        kind === 'extra newline'
          ? migration + '\n'
          : kind === 'changed body'
            ? migration.replace('revision_id', 'other_id')
            : readFileSync(
                resolve(
                  __dirname,
                  '../../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',
                ),
                'utf8',
              );
      expect(() => harness.profile(invalid)).toThrow('migration source mismatch');
    },
  );
  it('refuses stale137 in the live position and live140 in the frozen opening position', () => {
    const stale = catalog();
    Object.assign(stale[0], { body: '96c7319edc1e1a6c5695d1e649acd87a', bytes: 4362 });
    expect(() => harness.validate(stale, { pid: 17 })).toThrow();
    const mixed = catalog();
    Object.assign(mixed[1], { body: harness.profile().md5, bytes: 6124 });
    expect(() => harness.validate(mixed, { pid: 17 })).toThrow();
  });
  it.each([
    ['acl', []],
    ['invoker', false],
    ['strict', true],
    ['config', ['search_path=public, pg_catalog']],
    ['owner', 2],
    ['pid', 18],
    ['bytes', 6123],
    ['body', 'wrong'],
    ['language', 'plpgsql'],
  ])('retains the live %s check', (key, value) => {
    const rows = catalog();
    Reflect.set(rows[0], String(key), value);
    expect(() => harness.validate(rows, { pid: 17 })).toThrow();
  });
  it('restores the complete prior scale bytes before all unchanged historical inverses', () => {
    const opening = restoreE4LiveCatalog140Opening(source);
    expect(createHash('sha256').update(opening).digest('hex')).toBe(
      '175a4997a170887daa6095eda23106334534a1756521f7ce0b3d65bca1e79fa4',
    );
    expect(restoreE4PrepareAcceptanceV2Opening(source)).toBe(
      restoreE4PrepareAcceptanceV2Opening(opening),
    );
    expect(restoreE4MaximumStageOpening(source)).toBe(restoreE4MaximumStageOpening(opening));
    expect(source).toContain(
      "const E4_TERMINAL_NEW_BODY_MD5 = '96c7319edc1e1a6c5695d1e649acd87a';",
    );
    expect(source).toContain('const E4_TERMINAL_NEW_BODY_BYTES = 4362;');
  });
  it('restores the complete migration counterpart before its historical inverse', () => {
    const input = readFileSync(
      resolve(scalePath, '../activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts'),
      'utf8',
    );
    const opening = restoreE4LiveCatalog140Opening(input, 'migration');
    expect(createHash('sha256').update(opening).digest('hex')).toBe(
      '30a764e2b72776dd2185b97ad7e95628740acc340d3d0356fd9aa3eb2daa9fef',
    );
    expect(restoreE4HistoricalCatalogOpening(input)).toBe(
      restoreE4HistoricalCatalogOpening(opening),
    );
    expect(() => restoreE4LiveCatalog140Opening(input, 'scale')).toThrow();
    expect(() => restoreE4LiveCatalog140Opening(input + '\n', 'migration')).toThrow();
  });
  it.each(['scale', 'migration'] as const)(
    'executes the existing %s shared-source assertion offline',
    (kind) => {
      const filename = resolve(
        scalePath,
        '../activity-os-r5-e4-contribution-settlement-' + kind + '.e2e-spec.ts',
      );
      const text = readFileSync(filename, 'utf8');
      const fn = (name: string) => {
        const matches = [
          ...text.matchAll(new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}', 'gm')),
        ];
        expect(matches).toHaveLength(1);
        return matches[0][0];
      };
      const last = fn(
        kind === 'scale' ? 'restoreTerminalScaleOpening' : 'restoreTerminalMigrationOpening',
      );
      const start = text.indexOf('type TerminalOpeningBinding =');
      const end = text.indexOf(last) + last.length;
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const callback = [
        ...text.matchAll(
          /^ {2}it\('closes both test files, all original assertions, and the exact shared native implementation', \(\) => \{([\s\S]*?)^ {2}\}\);/gm,
        ),
      ];
      expect(callback).toHaveLength(1);
      const frozen = kind === 'migration' ? fn('terminalFrozen137SharedOpening') : '';
      const script = [
        fn('terminalNativeWorkerOpening'),
        fn('terminalGithubScopeOpening'),
        frozen,
        text.slice(start, end),
        callback[0][1],
      ].join('\n');
      const javascript = ts.transpileModule(script, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      }).outputText;
      expect(() => {
        vm.runInNewContext(javascript, {
          expect,
          readFileSync,
          resolve,
          __dirname: resolve(filename, '..'),
          __filename: filename,
          restoreE4HistoricalCatalogOpening,
          restoreE4MaximumStageOpening,
          restoreE4LiveCatalog140Opening,
          terminalHash: (input: string) => createHash('sha256').update(input).digest('hex'),
        });
      }).not.toThrow();
    },
  );
  it.each([
    [
      'trusted migration SHA',
      '5d7ff28a64a638440aaa1e9a798a2602f933fc9d6f8b23b68355199dad143513',
      '0'.repeat(64),
    ],
    [
      'live call',
      '[current, live.md5, live.bytes]',
      '[current, E4_TERMINAL_NEW_BODY_MD5, E4_TERMINAL_NEW_BODY_BYTES]',
    ],
    [
      'pair ceiling',
      'expect(performance.now() - pairStarted).toBeLessThan(30_000);',
      'expect(performance.now() - pairStarted).toBeLessThan(60_000);',
    ],
  ])('refuses modified %s during the exact outer inverse', (_name, before, after) => {
    expect(source).toContain(before);
    expect(() => restoreE4LiveCatalog140Opening(source.replace(before, after))).toThrow();
  });
});

type ReceiptEvent = { stage: string; outcome: string; durationMs: number | null };
const readEvent = (line: string) => JSON.parse(line) as ReceiptEvent;
const utc = '2026-10-15T00:00:00.000Z';
function fixture(write?: (line: string) => void) {
  let tick = 0;
  const lines: string[] = [];
  const receipt = new E4MaximumStageReceipt(
    write ?? ((line) => lines.push(line)),
    () => tick,
    () => utc,
  );
  return {
    receipt,
    lines,
    advance: (ms: number) => {
      tick += ms;
    },
  };
}

describe('E4 maximum stage receipt without a database', () => {
  it('writes ENTER before work and COMPLETE only after the actual pending Promise settles', async () => {
    const f = fixture();
    let done!: (value: object) => void;
    const value = Object.freeze({ private: Symbol('not recorded') });
    const work = jest.fn(
      () =>
        new Promise<object>((resolve) => {
          done = resolve;
        }),
    );
    const result = f.receipt.run('FIXTURE', work);
    expect(f.lines.map((line) => readEvent(line).outcome)).toEqual(['ENTER']);
    expect(f.receipt.status()).toMatchObject({ pending: 'FIXTURE', events: 1 });
    f.advance(29271);
    done(value);
    await expect(result).resolves.toBe(value);
    expect(f.lines.map((line) => readEvent(line))).toEqual([
      expect.objectContaining({
        sequence: 1,
        stage: 'FIXTURE',
        outcome: 'ENTER',
        elapsedMs: 0,
        durationMs: null,
        utc,
      }),
      expect.objectContaining({
        sequence: 2,
        stage: 'FIXTURE',
        outcome: 'COMPLETE',
        elapsedMs: 29271,
        durationMs: 29271,
        utc,
      }),
    ]);
    f.advance(600000); // Delayed delivery does not change previously captured clocks.
    expect(readEvent(f.lines[1]).durationMs).toBe(29271);
  });

  it('preserves the original failure and stops downstream work while still cleaning up', async () => {
    const f = fixture();
    const failure = Object.assign(new Error('private SQL and business payload'), { code: 'P2028' });
    await expect(
      f.receipt.run('FIXTURE', () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    const downstream = jest.fn(() => Promise.resolve(undefined));
    await expect(f.receipt.run('SUBMIT', downstream)).rejects.toThrow('order refused');
    expect(downstream).not.toHaveBeenCalled();
    const cleanup = jest.fn(() => Promise.resolve(undefined));
    await f.receipt.cleanup(cleanup);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(f.lines.join('')).not.toContain(failure.message);
    expect(readEvent(f.lines[1])).toMatchObject({ outcome: 'FAILED', errorCode: 'P2028' });
    expect(() => f.receipt.assertReliable()).toThrow('incomplete');
  });

  it.each(['ENTER', 'COMPLETE', 'FAILED'] as const)(
    'does not mistake %s sink failure for a business rollback',
    async (point) => {
      const sinkFailure = new Error('receipt sink failed');
      const primary = new Error('original business failure');
      const f = fixture((line) => {
        if (readEvent(line).outcome === point) throw sinkFailure;
      });
      const work = jest.fn(() => {
        if (point === 'FAILED') throw primary;
        return Promise.resolve(17);
      });
      await expect(f.receipt.run('FIXTURE', work)).rejects.toBe(
        point === 'FAILED' ? primary : sinkFailure,
      );
      expect(work).toHaveBeenCalledTimes(point === 'ENTER' ? 0 : 1);
      const cleanup = jest.fn(() => Promise.resolve(42));
      await expect(f.receipt.cleanup(cleanup)).resolves.toBe(42);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(f.receipt.status().unavailable).toBe(true);
      expect(() => f.receipt.assertReliable()).toThrow('incomplete');
    },
  );

  it('keeps cleanup exceptions unchanged even if cleanup evidence cannot be written', async () => {
    const f = fixture(() => {
      throw new Error('sink unavailable');
    });
    const primary = new Error('original cleanup failure');
    await expect(
      f.receipt.cleanup(() => {
        throw primary;
      }),
    ).rejects.toBe(primary);
  });

  it('requires all stages, refuses overlap/repeats/unknown stages, and bounds the complete output', async () => {
    const f = fixture();
    f.receipt.enter('FIXTURE');
    expect(() => f.receipt.enter('PREPARE')).toThrow('order refused');
    f.receipt.complete('FIXTURE');
    expect(() => f.receipt.enter('FIXTURE')).toThrow('order refused');
    expect(() => f.receipt.enter('private-stage' as 'FIXTURE')).toThrow('order refused');
    expect(() => f.receipt.assertReliable()).toThrow('incomplete');
    for (const stage of E4_MAXIMUM_STAGES.slice(1, -1))
      await f.receipt.run(stage, () => Promise.resolve(undefined));
    await f.receipt.cleanup(() => Promise.resolve(undefined));
    expect(() => f.receipt.assertReliable()).not.toThrow();
    expect(Buffer.byteLength(f.lines.join(''))).toBeLessThan(32 * 1024);
  });

  it('refuses a regressing monotonic clock', () => {
    const f = fixture();
    f.receipt.enter('FIXTURE');
    f.advance(-1);
    expect(() => f.receipt.complete('FIXTURE')).toThrow('unavailable');
  });

  it('leaves a private, exclusive ENTER receipt after a real bounded child is interrupted', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e4-stage-child-'));
    try {
      const source = readFileSync(
        resolve(__dirname, '../../../test/helpers/e4-maximum-stage-receipt.ts'),
        'utf8',
      );
      const js = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const path = resolve(dir, 'receipt.jsonl');
      const script =
        js +
        '\nconst r = exports.createE4MaximumStageReceipt(process.argv[2]); r.run("FIXTURE", () => new Promise(() => {})); setInterval(() => {}, 100);';
      const scriptPath = resolve(dir, 'receipt.cjs');
      writeFileSync(scriptPath, script);
      const result = spawnSync(process.execPath, [scriptPath, path], {
        timeout: 1500,
        killSignal: 'SIGTERM',
        encoding: 'utf8',
      });
      expect(result.signal).toBe('SIGTERM');
      expect(result.error).toMatchObject({ code: 'ETIMEDOUT' });
      const events = readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((line) => readEvent(line));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ stage: 'FIXTURE', outcome: 'ENTER', durationMs: null });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const replay = spawnSync(process.execPath, [scriptPath, path], {
        timeout: 1500,
        encoding: 'utf8',
      });
      expect(replay.status).not.toBe(0);
      expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('E4 actual maximum prepare receipt failure boundary without a database', () => {
  it.each([
    ['PREPARE', 'COMPLETE'],
    ['PREPARE_RECEIPT', 'ENTER'],
  ])('preserves successful prepare when %s %s evidence fails', async (stage, outcome) => {
    const source = readFileSync(
      resolve(
        __dirname,
        '../../../test/e2e/activity-os-r5-e4-contribution-settlement-scale.e2e-spec.ts',
      ),
      'utf8',
    );
    const start = source.indexOf('      let prepareBusinessFailure:');
    const end = source.indexOf('      expect(phaseDiagnostic.snapshot().status)', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const failure = new Error('controlled receipt sink failure');
    const stages = new E4MaximumStageReceipt((line) => {
      const event = readEvent(line);
      if (event.stage === stage && event.outcome === outcome) throw failure;
    });
    stages.enter('PREPARE_SETUP');
    const measured = { prepare: jest.fn().mockResolvedValue({ bucketCount: 8000 }) };
    const phaseDiagnostic = {
      begin: jest.fn(),
      finish: jest.fn(),
      restore: jest.fn(),
      emitTo: jest.fn(),
    };
    const engineRequests = {
      begin: jest.fn(),
      finish: jest.fn(),
      restore: jest.fn(),
      snapshot: jest.fn(),
    };
    const count = jest.fn();
    const script = ts.transpileModule('(async () => {\n' + source.slice(start, end) + '\n})()', {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const result = vm.runInNewContext(script, {
      stages,
      measured,
      phaseDiagnostic,
      sliceReadDiagnostic: undefined,
      engineRequests,
      source: { activityId: 'synthetic-activity' },
      prepareCommand: {},
      E4_META: {},
      e4Actor: () => ({}),
      f: {
        creator: {},
        db: {
          activitySettlementContributionRevision: { count },
          activitySettlementTimeRevision: { count },
        },
      },
      guardFunctionDiagnostic: undefined,
      guardPlanDiagnostic: undefined,
      observed: {},
      performance: { now: jest.fn().mockReturnValue(100) },
      console: { info: jest.fn() },
    }) as Promise<unknown>;
    await expect(result).rejects.toBe(failure);
    expect(measured.prepare).toHaveBeenCalledTimes(1);
    expect(count).not.toHaveBeenCalled();
    expect(phaseDiagnostic.finish).toHaveBeenCalledWith('OK');
    expect(phaseDiagnostic.restore).toHaveBeenCalledTimes(1);
    expect(engineRequests.restore).toHaveBeenCalledTimes(1);
  });

  it.each(['FAILED', 'INCOMPLETE'])(
    'refuses reliable closure after the last business stage is %s',
    async (outcome) => {
      const f = fixture();
      for (const stage of E4_MAXIMUM_STAGES.slice(0, -2))
        await f.receipt.run(stage, () => Promise.resolve(undefined));
      if (outcome === 'FAILED') {
        const failure = new Error('last probe failed');
        await expect(
          f.receipt.run('POST_BUSINESS_PROBE', () => {
            throw failure;
          }),
        ).rejects.toBe(failure);
      } else {
        f.receipt.enter('POST_BUSINESS_PROBE');
      }
      await f.receipt.cleanup(() => Promise.resolve(undefined));
      expect(f.lines.map((line) => readEvent(line))).toContainEqual(
        expect.objectContaining({ stage: 'POST_BUSINESS_PROBE', outcome }),
      );
      expect(() => f.receipt.assertReliable()).toThrow('evidence incomplete');
    },
  );
});

describe('E4 stage instrumentation exact source inverse', () => {
  const path = resolve(
    __dirname,
    '../../../test/e2e/activity-os-r5-e4-contribution-settlement-scale.e2e-spec.ts',
  );
  it('restores the entire frozen source including every oracle, assertion and original budget', () => {
    const source = readFileSync(path, 'utf8');
    const opening = restoreE4MaximumStageOpening(source);
    expect(createHash('sha256').update(opening).digest('hex')).toBe(
      '50a090de9193d80ab659852c0420aed4e05290913be1050b5f5631da9cf17ed6',
    );
    expect(restoreE4MaximumStageOpening(opening)).toBe(opening);
  });
  it.each([
    ['assertion', 'expect(barrierQueries).toBe(1);', 'expect(barrierQueries).toBe(0);'],
    ['oracle', 'async function assertFixedE4Oracle(', 'async function changedOracle('],
    ['instrumentation', "stages.run('FIXTURE'", "stages.run('SUBMIT'"],
    [
      'adjacent',
      "import { createHash } from 'node:crypto';",
      "import { createHash } from 'node:crypto';\n",
    ],
  ])('refuses changed %s bytes before recovering the frozen opening', (_name, before, after) => {
    const source = readFileSync(path, 'utf8');
    expect(source).toContain(before);
    const changed = source.replace(before, after);
    expect(changed).not.toBe(source);
    expect(() => restoreE4MaximumStageOpening(changed)).toThrow('source refused');
  });
  it.each(E4_CAPACITY_CASE_NAMES)('refuses changed timeout bytes for %s', (name) => {
    const source = readFileSync(path, 'utf8');
    const tree = ts.createSourceFile('scale.ts', source, ts.ScriptTarget.Latest, true);
    const matches: ts.NumericLiteral[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const [label, , timeout] = node.arguments;
        if (
          label &&
          ts.isStringLiteral(label) &&
          name.endsWith(' ' + label.text) &&
          timeout &&
          ts.isNumericLiteral(timeout)
        )
          matches.push(timeout);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    expect(matches).toHaveLength(1);
    const timeout = matches[0];
    expect(timeout.getText(tree)).toBe('600_000');
    const changed =
      source.slice(0, timeout.getStart(tree)) + '900_000' + source.slice(timeout.getEnd());
    expect(() => restoreE4MaximumStageOpening(changed)).toThrow('source refused');
  });
});

describe('E4 frozen migration counterpart for the older scale source checker', () => {
  const path = resolve(
    __dirname,
    '../../../test/e2e/activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts',
  );
  it('restores the exact prior candidate for the migration self-reader before catalog adaptation', () => {
    const source = readFileSync(path, 'utf8');
    const prior = restoreE4HistoricalCiFixtureOpening(source);
    expect(prior).not.toBe(source);
    expect(createHash('sha256').update(prior).digest('hex')).toBe(
      '71d36ed2b3bd13b97eb54f6771f7659f03521a1586662413907dfddb6696165f',
    );
    expect(restoreE4HistoricalCiFixtureOpening(prior)).toBe(prior);
    const opening = restoreE4HistoricalCatalogOpening(source);
    expect(restoreE4HistoricalCatalogOpening(prior)).toBe(opening);
    expect(() => restoreE4HistoricalCiFixtureOpening(opening)).toThrow('source refused');
  });
  it('restores the complete approved counterpart instead of changing its original refs pin', () => {
    const source = readFileSync(path, 'utf8');
    const opening = restoreE4HistoricalCatalogOpening(source);
    expect(opening).not.toBe(source);
    expect(createHash('sha256').update(opening).digest('hex')).toBe(
      'd6c887c0b4fba37b8883da63ef70604c64f72bb6401e9553611fd8b7ee959e32',
    );
    expect(restoreE4HistoricalCatalogOpening(opening)).toBe(opening);
    expect(opening).not.toContain('const historicalCatalogTx = frozen137FirstReviewCatalogTx(tx);');
  });
  it.each([
    ['missing CI restore import', '  restoreE4HistoricalCiFixtureOpening,\n', ''],
    [
      'duplicate CI restore import',
      '  restoreE4HistoricalCiFixtureOpening,\n',
      '  restoreE4HistoricalCiFixtureOpening,\n  restoreE4HistoricalCiFixtureOpening,\n',
    ],
    [
      'changed CI restore import',
      '  restoreE4HistoricalCiFixtureOpening,\n',
      '  restoreE4HistoricalCiFixtureOpening as changedRestore,\n',
    ],
    ['missing CI restore call', 'restoreE4HistoricalCiFixtureOpening(source)', 'source'],
    [
      'duplicate CI restore call',
      'restoreE4HistoricalCiFixtureOpening(source)',
      'restoreE4HistoricalCiFixtureOpening(restoreE4HistoricalCiFixtureOpening(source))',
    ],
    [
      'changed CI restore call',
      'restoreE4HistoricalCiFixtureOpening(source)',
      'restoreE4HistoricalCiFixtureOpening(source.trim())',
    ],
    ['phase output', "'E4_GENUINE_BAG_PHASE'", "'E4_GENUINE_BAG_PHASE_CHANGED'"],
    [
      'third fixture',
      'const thirdSource = await createE4Source(fixture);',
      'const thirdSource = await createE4Source(fixture, 2);',
    ],
    [
      'third oracle',
      'for (const rootId of [draftId, submittedId, thirdRootId])',
      'for (const rootId of [draftId, submittedId])',
    ],
    [
      'native timing',
      ".finally(() => recordGenuinePhase('native-with-cleanup', nativeStarted))",
      '',
    ],
    [
      'native deadline',
      '\n    const deadline = performance.now() + 30_000;\n',
      '\n    const deadline = performance.now() + 60_000;\n',
    ],
    [
      'duplicate phase marker',
      "'E4_GENUINE_BAG_PHASE'",
      "'E4_GENUINE_BAG_PHASE', 'E4_GENUINE_BAG_PHASE'",
    ],
    ['body', 'async function', 'async  function'],
    [
      'adapter',
      'const historicalCatalogTx = frozen137FirstReviewCatalogTx(tx);',
      'const historicalCatalogTx = tx;',
    ],
    [
      'source guard',
      '7682abceaaf185b1b54beaffdd1ecddc1fe30745193059cce3da5aeb3518282a',
      '0'.repeat(64),
    ],
  ])('refuses modified %s before restoring the complete counterpart', (_name, before, after) => {
    const source = readFileSync(path, 'utf8');
    const changed = source.replace(before, after);
    expect(changed).not.toBe(source);
    expect(() => restoreE4HistoricalCatalogOpening(changed)).toThrow('source refused');
    expect(() => restoreE4HistoricalCiFixtureOpening(changed)).toThrow('source refused');
  });
});

describe('E4 frozen ordinary oracle after the approved146 pin mirrors', () => {
  const path = resolve(
    __dirname,
    '../../../test/e2e/activity-os-r5-e4-contribution-settlement.e2e-spec.ts',
  );
  it('restores all frozen source bytes without changing the three live146 pin mirrors', () => {
    const source = readFileSync(path, 'utf8');
    const opening = restoreE4OrdinaryOracleOpening(source);
    expect(createHash('sha256').update(opening).digest('hex')).toBe(
      '46c31154bfa284f923ab34ca8be651573a8fe3a1f6d6035e1010265371a17e72',
    );
    expect(restoreE4OrdinaryOracleOpening(opening)).toBe(opening);
    expect(readFileSync(path, 'utf8')).toBe(source);
    expect(source.split('40b56bac5a571c56e589cbc549419bfa')).toHaveLength(4);
  });
  it.each([
    ['oracle', 'function fixedE4RootAggregateSql(', 'function changedOracle('],
    ['pin', '40b56bac5a571c56e589cbc549419bfa', '0'.repeat(32)],
  ])('refuses changed %s source', (_label, before, after) => {
    const source = readFileSync(path, 'utf8');
    const changed = source.replace(before, after);
    expect(changed).not.toBe(source);
    expect(() => restoreE4OrdinaryOracleOpening(changed)).toThrow('source refused');
  });
});

describe('C1-v2 prepare acceptance is bounded transaction feasibility', () => {
  function valid(): E4PrepareTransactionFactsV2 {
    return {
      phases: [
        { phase: 'start', outcome: 'ok' },
        { phase: 'commit', outcome: 'ok' },
      ],
      starts: [{ timeoutMs: 60_000, maxWaitMs: 2_000, isolationLevel: 'ReadCommitted' }],
      pending: 0,
      unknown: false,
    };
  }
  it.each([31_000, 33_960.659994, 61_000])(
    'records method wall %s without inventing a latency SLA',
    (wall) => {
      expect(assertE4PrepareAcceptanceV2(valid(), wall)).toEqual({
        schema: 'r5-c1-prepare/v2',
        status: 'COMMITTED',
        transactionTimeoutMs: 60_000,
        connectionMaxWaitMs: 2_000,
        isolationLevel: 'ReadCommitted',
        methodWallMs: wall,
        latencySla: 'UNESTABLISHED',
      });
    },
  );
  const negatives: [string, (facts: E4PrepareTransactionFactsV2) => void][] = [
    [
      'old transaction budget',
      (f) => {
        f.starts = [{ ...f.starts[0], timeoutMs: 30_000 }];
      },
    ],
    [
      'changed connection wait',
      (f) => {
        f.starts = [{ ...f.starts[0], maxWaitMs: 5_000 }];
      },
    ],
    [
      'changed isolation',
      (f) => {
        f.starts = [{ ...f.starts[0], isolationLevel: 'Serializable' }];
      },
    ],
    [
      'missing actual start',
      (f) => {
        f.starts = [];
      },
    ],
    [
      'duplicate actual start',
      (f) => {
        f.starts = [...f.starts, ...f.starts];
      },
    ],
    [
      'rollback instead of commit',
      (f) => {
        f.phases = [
          { phase: 'start', outcome: 'ok' },
          { phase: 'rollback', outcome: 'ok' },
        ];
      },
    ],
    [
      'failed commit',
      (f) => {
        f.phases = [
          { phase: 'start', outcome: 'ok' },
          { phase: 'commit', outcome: 'error' },
        ];
      },
    ],
    [
      'missing commit',
      (f) => {
        f.phases = [{ phase: 'start', outcome: 'ok' }];
      },
    ],
    [
      'pending work',
      (f) => {
        f.pending = 1;
      },
    ],
    [
      'unknown capture',
      (f) => {
        f.unknown = true;
      },
    ],
  ];
  it.each(negatives)('rejects %s without accepting a wall-time shortcut', (_name, change) => {
    const facts = valid();
    change(facts);
    expect(() => assertE4PrepareAcceptanceV2(facts, 1)).toThrow('transaction facts refused');
  });
  it.each([-1, NaN, Infinity])('rejects invalid wall evidence %s', (wall) => {
    expect(() => assertE4PrepareAcceptanceV2(valid(), wall)).toThrow('transaction facts refused');
  });
  const sourcePath = resolve(
    __dirname,
    '../../../test/e2e/activity-os-r5-e4-contribution-settlement-scale.e2e-spec.ts',
  );
  it('recovers the entire v1 source before its unchanged historical inverses', () => {
    const source = readFileSync(sourcePath, 'utf8');
    const v1 = restoreE4PrepareAcceptanceV2Opening(source);
    expect(createHash('sha256').update(v1).digest('hex')).toBe(
      '5408651f58567fe8b9468f93326686ede1b6ac4da1d15028784fd0c3e3e51d87',
    );
    expect(restoreE4PrepareAcceptanceV2Opening(v1)).toBe(v1);
    expect(restoreE4MaximumStageOpening(source)).toBe(restoreE4MaximumStageOpening(v1));
  });
  it.each([
    [
      'transaction profile call',
      'engineObserver.assertPrepare(prepareMs)',
      'engineObserver.assertPrepare(1)',
    ],
    ['S13 guard', 'expect(barrierQueries).toBe(1);', 'expect(barrierQueries).toBe(0);'],
    [
      'pair budget',
      'expect(performance.now() - pairStarted).toBeLessThan(30_000);',
      'expect(performance.now() - pairStarted).toBeLessThan(60_000);',
    ],
    ['marker removal', '// E4_C1_V2_ENGINE_BEGIN', '// missing-v2-engine'],
  ])('refuses changed %s in the versioned source', (_name, before, after) => {
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).toContain(before);
    expect(() => restoreE4PrepareAcceptanceV2Opening(source.replace(before, after))).toThrow(
      'source refused',
    );
  });
});
