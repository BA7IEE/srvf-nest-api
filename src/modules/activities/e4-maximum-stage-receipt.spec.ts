import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import vm from 'node:vm';
import {
  E4_MAXIMUM_STAGES,
  E4MaximumStageReceipt,
  restoreE4MaximumStageOpening,
  restoreE4HistoricalCatalogOpening,
  restoreE4OrdinaryOracleOpening,
} from '../../../test/helpers/e4-maximum-stage-receipt';

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
        '\nconst r = exports.createE4MaximumStageReceipt(process.argv[1]); r.run("FIXTURE", () => new Promise(() => {})); setInterval(() => {}, 100);';
      const result = spawnSync(process.execPath, ['-e', script, path], {
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
      const replay = spawnSync(process.execPath, ['-e', script, path], {
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
    ['budget', '}, 600_000);', '}, 900_000);'],
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
});

describe('E4 frozen migration counterpart for the older scale source checker', () => {
  const path = resolve(
    __dirname,
    '../../../test/e2e/activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts',
  );
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
