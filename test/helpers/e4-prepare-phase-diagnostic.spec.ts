import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as ts from 'typescript';
import { createHash } from 'node:crypto';
import {
  E4_PREPARE_PHASES,
  E4PreparePhaseDiagnostic,
  type E4PreparePhase,
} from './e4-prepare-phase-diagnostic';
import {
  E4EngineRequestWaitDiagnostic,
  joinE4NativeBoundary,
} from './e4-engine-request-wait-diagnostic';

type Target = { work: (this: object, ...args: unknown[]) => unknown };

function fixture() {
  let tick = 0;
  const targets = Object.fromEntries(
    E4_PREPARE_PHASES.map((phase) => [phase, { work: () => Promise.resolve(undefined) }]),
  ) as Record<E4PreparePhase, Target>;
  return {
    targets,
    clock: () => tick++,
    bindings: () =>
      E4_PREPARE_PHASES.map((phase) => ({ phase, target: targets[phase], method: 'work' })),
  };
}

async function remaining(f: ReturnType<typeof fixture>, excluded: E4PreparePhase[] = []) {
  for (const phase of E4_PREPARE_PHASES) {
    if (!excluded.includes(phase)) await f.targets[phase].work();
  }
}

function phase(diagnostic: E4PreparePhaseDiagnostic, name: E4PreparePhase) {
  return diagnostic.snapshot().phases.find((row) => row.phase === name)!;
}

describe('E4 fixed prepare phase diagnostic', () => {
  it('preserves the receiver, arguments, options and exact original Promise', async () => {
    const f = fixture();
    let resolve!: (value: unknown) => void;
    const original = new Promise<unknown>((done) => {
      resolve = done;
    });
    const receivedCall: { receiver?: unknown; args: unknown[] } = { args: [] };
    f.targets.C3_PROOF.work = function (...args) {
      receivedCall.receiver = this;
      receivedCall.args = args;
      return original;
    };
    const originalFunction = f.targets.C3_PROOF.work;
    const diagnostic = new E4PreparePhaseDiagnostic(f.bindings(), f.clock);
    diagnostic.begin();
    const options = { timeout: 30000 };
    const payload = Object.freeze({ opaque: Symbol('unrecorded input') });
    const returned = f.targets.C3_PROOF.work(payload, options);
    expect(returned).toBe(original);
    expect(receivedCall.receiver).toBe(f.targets.C3_PROOF);
    expect(receivedCall.args[0]).toBe(payload);
    expect(receivedCall.args[1]).toBe(options);
    resolve(payload);
    await original;
    await remaining(f, ['C3_PROOF']);
    diagnostic.finish('OK');
    diagnostic.restore();
    expect(f.targets.C3_PROOF.work).toBe(originalFunction);
    expect(diagnostic.snapshot().status).toBe('COMPLETE');
    expect(phase(diagnostic, 'C3_PROOF')).toMatchObject({ calls: 1, ok: 1, failed: 0, pending: 0 });
  });

  it('preserves the exact rejection and emits only fixed failure counters', async () => {
    const f = fixture();
    const error = new Error('unrecorded failure payload');
    const original = Promise.reject(error);
    f.targets.C3_PROOF.work = () => original;
    const diagnostic = new E4PreparePhaseDiagnostic(f.bindings(), f.clock);
    diagnostic.begin();
    expect(f.targets.C3_PROOF.work()).toBe(original);
    await expect(original).rejects.toBe(error);
    diagnostic.finish('FAIL');
    diagnostic.restore();
    let output = '';
    expect(
      diagnostic.emitTo((json) => {
        output = json;
      }),
    ).toBe(true);
    expect(output).not.toContain(error.message);
    expect(diagnostic.snapshot().status).toBe('COMPLETE');
    expect(phase(diagnostic, 'C3_PROOF')).toMatchObject({ failed: 1, ok: 0, pending: 0 });
    expect(phase(diagnostic, 'C3_RECEIPT').calls).toBe(0);
  });

  it('preserves an immediate throw without manufacturing a Promise', () => {
    const f = fixture();
    const error = new Error('unrecorded immediate failure');
    f.targets.C3_PROOF.work = () => {
      throw error;
    };
    const diagnostic = new E4PreparePhaseDiagnostic(f.bindings(), f.clock);
    diagnostic.begin();
    try {
      f.targets.C3_PROOF.work();
      throw new Error('Original throw missing');
    } catch (caught) {
      expect(caught).toBe(error);
    }
    diagnostic.finish('FAIL');
    diagnostic.restore();
    expect(diagnostic.snapshot().status).toBe('COMPLETE');
    expect(phase(diagnostic, 'C3_PROOF')).toMatchObject({ failed: 1, pending: 0 });
  });

  it('records nested method residence and inclusive event windows without summing them', async () => {
    const f = fixture();
    f.targets.E4_EVAL.work = async () => {
      diagnostic.query('READ', 7);
    };
    f.targets.E4_EVAL_WRITE.work = async () => {
      diagnostic.query('WRITE', 11);
    };
    f.targets.E4_PREPARE.work = async () => {
      await f.targets.E4_EVAL.work();
      await f.targets.E4_EVAL_WRITE.work();
    };
    const diagnostic = new E4PreparePhaseDiagnostic(f.bindings(), f.clock);
    diagnostic.query('READ', 1000);
    diagnostic.begin();
    await remaining(f, ['E4_EVAL', 'E4_EVAL_WRITE']);
    diagnostic.finish('OK');
    diagnostic.restore();
    diagnostic.query('WRITE', 1000);
    const snapshot = diagnostic.snapshot();
    expect(snapshot.status).toBe('COMPLETE');
    expect(snapshot.root).toMatchObject({ queryCount: 2, readMs: 7, writeMs: 11, largestMs: 11 });
    expect(phase(diagnostic, 'E4_PREPARE')).toMatchObject({
      queryCount: 2,
      readMs: 7,
      writeMs: 11,
    });
    expect(phase(diagnostic, 'E4_EVAL')).toMatchObject({ queryCount: 1, readMs: 7, writeMs: 0 });
    expect(phase(diagnostic, 'E4_EVAL_WRITE')).toMatchObject({
      queryCount: 1,
      readMs: 0,
      writeMs: 11,
    });
    expect(phase(diagnostic, 'E4_PREPARE').wallMs).toBeGreaterThan(
      phase(diagnostic, 'E4_EVAL').wallMs!,
    );
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(4096);
  });

  it('rejects missing fixed phases before changing an instance', () => {
    const f = fixture();
    const originals = E4_PREPARE_PHASES.map((name) => f.targets[name].work);
    const diagnostic = new E4PreparePhaseDiagnostic(f.bindings().slice(1), f.clock);
    diagnostic.begin();
    diagnostic.finish('FAIL');
    diagnostic.restore();
    expect(diagnostic.snapshot().status).toBe('UNKNOWN');
    expect(E4_PREPARE_PHASES.map((name) => f.targets[name].work)).toEqual(originals);
  });

  it('rejects a second observer without taking ownership from the first', () => {
    const f = fixture();
    const first = new E4PreparePhaseDiagnostic(f.bindings(), f.clock);
    const owned = f.targets.C3_PROOF.work;
    const second = new E4PreparePhaseDiagnostic(f.bindings(), f.clock);
    second.restore();
    expect(second.snapshot().status).toBe('UNKNOWN');
    expect(f.targets.C3_PROOF.work).toBe(owned);
    first.begin();
    first.finish('FAIL');
    first.restore();
    expect(first.snapshot().status).toBe('COMPLETE');
  });

  it('restores inherited and own property descriptors exactly', async () => {
    const f = fixture();
    const inherited = { work: () => Promise.resolve(undefined) };
    f.targets.C3_PROOF = Object.create(inherited);
    Object.defineProperty(f.targets.C3_SOURCE, 'work', {
      configurable: true,
      writable: false,
      enumerable: false,
      value: () => Promise.resolve(undefined),
    });
    const original = Object.getOwnPropertyDescriptor(f.targets.C3_SOURCE, 'work');
    const diagnostic = new E4PreparePhaseDiagnostic(f.bindings(), f.clock);
    diagnostic.begin();
    await remaining(f);
    diagnostic.finish('OK');
    diagnostic.restore();
    expect(Object.getOwnPropertyDescriptor(f.targets.C3_PROOF, 'work')).toBeUndefined();
    expect(f.targets.C3_PROOF.work).toBe(inherited.work);
    expect(Object.getOwnPropertyDescriptor(f.targets.C3_SOURCE, 'work')).toEqual(original);
    expect(diagnostic.snapshot().status).toBe('COMPLETE');
  });

  it('keeps a foreign method change and reports lost ownership', () => {
    const f = fixture();
    const diagnostic = new E4PreparePhaseDiagnostic(f.bindings(), f.clock);
    const foreign = () => Promise.resolve(undefined);
    f.targets.C3_SOURCE.work = foreign;
    diagnostic.begin();
    diagnostic.finish('FAIL');
    diagnostic.restore();
    expect(f.targets.C3_SOURCE.work).toBe(foreign);
    expect(diagnostic.snapshot().status).toBe('UNKNOWN');
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
    'reports an invalid monotonic clock %s without changing original failure',
    async (time) => {
      const f = fixture();
      const error = new Error('unrecorded clock-case failure');
      const original = Promise.reject(error);
      f.targets.C3_PROOF.work = () => original;
      const diagnostic = new E4PreparePhaseDiagnostic(f.bindings(), () => time);
      diagnostic.begin();
      expect(f.targets.C3_PROOF.work()).toBe(original);
      await expect(original).rejects.toBe(error);
      diagnostic.finish('FAIL');
      diagnostic.restore();
      expect(diagnostic.snapshot().status).toBe('UNKNOWN');
      expect(diagnostic.snapshot().root.wallMs).toBeNull();
    },
  );

  it('does not replace a synchronous value when a method stops returning a Promise', () => {
    const f = fixture();
    const value = Object.freeze({ opaque: Symbol('unrecorded return value') });
    f.targets.C3_PROOF.work = () => value;
    const diagnostic = new E4PreparePhaseDiagnostic(f.bindings(), f.clock);
    diagnostic.begin();
    expect(f.targets.C3_PROOF.work()).toBe(value);
    diagnostic.finish('FAIL');
    diagnostic.restore();
    expect(diagnostic.snapshot().status).toBe('UNKNOWN');
    expect(phase(diagnostic, 'C3_PROOF')).toMatchObject({ pending: 0, ok: 0, failed: 0 });
  });

  it('retains UNKNOWN after a method settles later than the prepare boundary', async () => {
    const f = fixture();
    let resolve!: () => void;
    const original = new Promise<void>((done) => {
      resolve = done;
    });
    f.targets.C3_PROOF.work = () => original;
    const diagnostic = new E4PreparePhaseDiagnostic(f.bindings(), f.clock);
    diagnostic.begin();
    expect(f.targets.C3_PROOF.work()).toBe(original);
    diagnostic.finish('FAIL');
    diagnostic.restore();
    expect(diagnostic.snapshot().status).toBe('UNKNOWN');
    resolve();
    await original;
    expect(phase(diagnostic, 'C3_PROOF').pending).toBe(0);
    expect(diagnostic.snapshot().status).toBe('UNKNOWN');
  });

  it('rejects invalid query timing and leaves original values untouched', async () => {
    const f = fixture();
    const diagnostic = new E4PreparePhaseDiagnostic(f.bindings(), f.clock);
    diagnostic.begin();
    diagnostic.query('READ', Number.NaN);
    await remaining(f);
    diagnostic.finish('OK');
    diagnostic.restore();
    expect(diagnostic.snapshot().status).toBe('UNKNOWN');
    expect(diagnostic.snapshot().root.queryCount).toBe(0);
  });

  it('contains logging failure and preserves the original prepare rejection', async () => {
    const f = fixture();
    const error = new Error('unrecorded rejected payload');
    const original = Promise.reject(error);
    f.targets.C3_PROOF.work = () => original;
    const diagnostic = new E4PreparePhaseDiagnostic(f.bindings(), f.clock);
    diagnostic.begin();
    expect(f.targets.C3_PROOF.work()).toBe(original);
    await expect(original).rejects.toBe(error);
    diagnostic.finish('FAIL');
    diagnostic.restore();
    expect(
      diagnostic.emitTo(() => {
        throw new Error('unrecorded logger failure');
      }),
    ).toBe(false);
    expect(diagnostic.snapshot().status).toBe('UNKNOWN');
    await expect(original).rejects.toBe(error);
  });
});

function maximumSourceFragments() {
  const text = fs.readFileSync(
    path.join(__dirname, '../e2e/activity-os-r5-e4-contribution-settlement-scale.e2e-spec.ts'),
    'utf8',
  );
  const ast = ts.createSourceFile('maximum.ts', text, ts.ScriptTarget.Latest, true);
  const boundaries: ts.TryStatement[] = [];
  const collectors: string[] = [];
  let oldCollector = '';
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'measured.prepare') {
      let parent: ts.Node | undefined = node.parent;
      while (
        parent &&
        !(
          ts.isTryStatement(parent) && parent.catchClause?.getText(ast).includes('const prismaCode')
        )
      )
        parent = parent.parent;
      if (parent && ts.isTryStatement(parent)) boundaries.push(parent);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === 'observed.$on' &&
      node.arguments[1]?.getText(ast).includes('preparePhaseDiagnostic?.query')
    ) {
      const start = text.lastIndexOf('    const timing = ', node.getStart(ast));
      const end = text.indexOf('    const reset = ', node.end);
      if (start < 0 || end < 0) throw new Error('Actual query collector unavailable');
      collectors.push(text.slice(start, end));
    }
    if (
      ts.isStringLiteral(node) &&
      node.text.includes('let preparePhaseDiagnostic: E4PreparePhaseDiagnostic')
    ) {
      const row = node.parent;
      if (
        ts.isPropertyAssignment(row) &&
        row.name.getText(ast) === 'candidate' &&
        ts.isObjectLiteralExpression(row.parent)
      ) {
        const opening = row.parent.properties.find(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) && property.name.getText(ast) === 'opening',
        );
        if (opening && ts.isStringLiteral(opening.initializer))
          oldCollector = opening.initializer.text;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (boundaries.length !== 1 || collectors.length !== 1 || !oldCollector)
    throw new Error('Actual maximum fragments are not unique');
  const boundary = boundaries[0];
  const start = text.lastIndexOf('      let prepared;', boundary.getStart(ast));
  if (start < 0 || !boundary.catchClause) throw new Error('Actual prepare declaration unavailable');
  if (!ts.isBlock(boundary.parent)) throw new Error('Actual prepare scope unavailable');
  const next = boundary.parent.statements[boundary.parent.statements.indexOf(boundary) + 1];
  if (!next || next.getText(ast) !== "expect(phaseDiagnostic.snapshot().status).toBe('COMPLETE');")
    throw new Error('Integrity guard must follow the original failure branch');
  return {
    invocation: text.slice(start, boundary.catchClause.end),
    integrity: next.getText(ast),
    collector: collectors[0],
    oldCollector,
  };
}

function compileProbe(text: string) {
  const compiled = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
  if (compiled.diagnostics?.length) throw new Error('Actual probe transpilation failed');
  return compiled.outputText;
}

function wiredPrepare(error?: Error, missingBinding = false, loggerFails = false) {
  const output: string[] = [];
  let factQueries = 0;
  let originalArgs: unknown[] = [];
  const result = Object.freeze({ opaque: Symbol('unrecorded result') });
  const actor = Object.freeze({ opaque: Symbol('unrecorded actor') });
  const command = Object.freeze({ operationKey: 'opaque-command' });
  const meta = Object.freeze({ opaque: Symbol('unrecorded metadata') });
  const noop = async () => undefined;
  const contributionQueries = { readTimeEvaluationInTx: noop };
  const contributions = {
    insertEvaluations: async () => {
      if (error) throw error;
    },
    prepareTimeInTx: async () => {
      await contributionQueries.readTimeEvaluationInTx();
      await contributions.insertEvaluations();
    },
  };
  const reader = { evaluateInTx: noop };
  const measured = {
    lockedProof: noop,
    lockedSources: noop,
    insertBuckets: noop,
    receipt: noop,
    prepare: async (...args: unknown[]) => {
      originalArgs = args;
      if (!missingBinding) {
        await measured.lockedProof();
        await measured.lockedSources();
        await reader.evaluateInTx();
        await measured.insertBuckets();
        await contributions.prepareTimeInTx();
        await measured.receipt();
      }
      return result;
    },
  };
  const originals = [
    measured.lockedProof,
    measured.lockedSources,
    reader.evaluateInTx,
    measured.insertBuckets,
    contributions.prepareTimeInTx,
    contributionQueries.readTimeEvaluationInTx,
    contributions.insertEvaluations,
    measured.receipt,
  ];
  const f = {
    creator: { id: 'opaque-creator' },
    app: { get: () => contributionQueries },
    db: {
      activitySettlementContributionRevision: { count: async () => 0 },
      activitySettlementTimeRevision: { count: async () => 0 },
      $queryRaw: async () => {
        factQueries++;
        return [
          {
            roots: 0,
            evaluations: 0,
            timeRoots: 0,
            buckets: 0,
            sources: 0,
            receipts: 0,
            audits: 0,
          },
        ];
      },
    },
  };
  const source = { activityId: 'opaque-activity', generated: {} };
  if (missingBinding) Reflect.deleteProperty(measured, 'lockedProof');
  const fragment = maximumSourceFragments();
  const program =
    'async function actualMaximumPrepare() { let preparePhaseDiagnostic; ' +
    fragment.invocation +
    '\n' +
    fragment.integrity +
    '\nreturn prepared; } actualMaximumPrepare();';
  const returned: unknown = vm.runInNewContext(compileProbe(program), {
    E4PreparePhaseDiagnostic,
    guardPlanDiagnostic: undefined,
    guardFunctionDiagnostic: undefined,
    ActivityContributionSettlementQueryService: class {},
    measured,
    contributions,
    reader,
    f,
    source,
    prepareCommand: command,
    prepareRequestHash: 'opaque-request',
    TIME_SETTLEMENT_PREPARE_OPERATION: 'opaque-time-prepare',
    e4Actor: () => actor,
    E4_META: meta,
    expect,
    Date,
    started: Date.now(),
    queries: 0,
    e4Queries: 0,
    barrierQueries: 0,
    timing: { readMs: 0, writeMs: 0, largestMs: 0 },
    engineObserver: { phases: [] },
    engineRequests: {
      begin: () => undefined,
      finish: () => undefined,
      restore: () => undefined,
      snapshot: () => ({ status: 'COMPLETE' }),
    },
    boundaryAnchor: 0,
    nativeBoundaryDiagnostic: {
      begin: () => undefined,
      finish: () => undefined,
      restore: () => undefined,
      snapshot: () => ({ status: 'NOT_RUN' }),
    },
    Prisma: { PrismaClientKnownRequestError: class extends Error {} },
    console: {
      info: (tag: string, payload: unknown) => {
        if (tag === 'E4 maximum prepare phases (fixed counters)') {
          if (loggerFails) throw new Error('unrecorded diagnostic logging failure');
          if (typeof payload !== 'string') throw new Error('Unexpected diagnostic payload');
          output.push(payload);
        }
      },
    },
  });
  return {
    returned,
    result,
    output,
    args: () => originalArgs,
    expectedArgs: [source.activityId, command, actor, meta],
    factQueries: () => factQueries,
    restored: () =>
      [
        measured.lockedProof,
        measured.lockedSources,
        reader.evaluateInTx,
        measured.insertBuckets,
        contributions.prepareTimeInTx,
        contributionQueries.readTimeEvaluationInTx,
        contributions.insertEvaluations,
        measured.receipt,
      ].every((method, index) => method === originals[index]),
  };
}

describe('E4 actual maximum prepare diagnostic wiring offline', () => {
  it('runs the real invocation with unchanged arguments and restored original methods', async () => {
    const probe = wiredPrepare();
    await expect(probe.returned).resolves.toBe(probe.result);
    expect(probe.args()).toEqual(probe.expectedArgs);
    expect(probe.restored()).toBe(true);
    expect(probe.factQueries()).toBe(0);
    expect(probe.output).toHaveLength(1);
    const record = JSON.parse(probe.output[0]) as ReturnType<E4PreparePhaseDiagnostic['snapshot']>;
    expect(Object.keys(record)).toEqual(['status', 'root', 'phases']);
    expect(record.status).toBe('COMPLETE');
    expect(record.phases.map((row: { phase: string }) => row.phase)).toEqual(E4_PREPARE_PHASES);
    for (const row of record.phases) {
      expect(Object.keys(row)).toEqual([
        'phase',
        'calls',
        'pending',
        'ok',
        'failed',
        'wallMs',
        'cpuUserUs',
        'cpuSystemUs',
        'queryCount',
        'readMs',
        'writeMs',
        'largestMs',
      ]);
      expect(row.calls).toBe(1);
      expect(row.pending).toBe(0);
    }
    expect(Buffer.byteLength(probe.output[0])).toBeLessThanOrEqual(4096);
    expect(probe.output[0]).not.toContain('opaque');
  });

  it('keeps the original rejection and only the existing same-command facts query', async () => {
    const error = new Error('unrecorded original prepare error');
    const probe = wiredPrepare(error);
    await expect(probe.returned).rejects.toBe(error);
    expect(probe.restored()).toBe(true);
    expect(probe.factQueries()).toBe(1);
    expect(JSON.parse(probe.output[0]).status).toBe('COMPLETE');
    expect(probe.output[0]).not.toContain(error.message);
  });

  it('does not send diagnostic UNKNOWN through the original failure-query branch', async () => {
    const probe = wiredPrepare(undefined, true);
    await expect(probe.returned).rejects.toThrow();
    expect(probe.factQueries()).toBe(0);
    expect(JSON.parse(probe.output[0]).status).toBe('UNKNOWN');
  });

  it('keeps original failure behavior when only diagnostic logging fails', async () => {
    const error = new Error('unrecorded original rejection');
    const probe = wiredPrepare(error, false, true);
    await expect(probe.returned).rejects.toBe(error);
    expect(probe.restored()).toBe(true);
    expect(probe.factQueries()).toBe(1);
  });

  it('keeps the existing query counters and forwards only kind plus duration', () => {
    const fragment = maximumSourceFragments();
    const events = [
      { query: 'SELECT unrecorded_payload', duration: 7 },
      { query: 'INSERT unrecorded_payload', duration: 11 },
      { query: 'BEGIN', duration: 1 },
    ];
    function run(collector: string, withDiagnostic: boolean) {
      let callback: (event: { query: string; duration: number }) => void = () => undefined;
      const forwarded: unknown[][] = [];
      const result: unknown = vm.runInNewContext(
        compileProbe(
          collector +
            (withDiagnostic ? '\npreparePhaseDiagnostic = fakeDiagnostic;\n' : '\n') +
            'for (const event of events) observed.emit(event);\n' +
            '({ queries, e4Queries, barrierQueries, timing });',
        ),
        {
          queries: 0,
          e4Queries: 0,
          barrierQueries: 0,
          events,
          observed: {
            $on: (_event: string, listener: typeof callback) => {
              callback = listener;
            },
            emit: (event: { query: string; duration: number }) => callback(event),
          },
          fakeDiagnostic: {
            query: (...args: unknown[]) => {
              forwarded.push(args);
            },
          },
        },
      );
      return { result, forwarded };
    }
    const current = run(fragment.collector, true);
    const old = run(fragment.oldCollector, false);
    expect(current.result).toEqual(old.result);
    expect(current.forwarded).toEqual([
      ['READ', 7],
      ['WRITE', 11],
    ]);
  });
});

describe('E4 explicit method boundary timeline', () => {
  it('keeps the default snapshot and timeline disabled', () => {
    const f = fixture();
    const diagnostic = new E4PreparePhaseDiagnostic(f.bindings(), f.clock);
    expect(Object.keys(diagnostic.snapshot())).toEqual(['status', 'root', 'phases']);
    expect(diagnostic.boundarySnapshot().status).toBe('NOT_RUN');
    diagnostic.restore();
  });

  it('uses the shared monotonic anchor and preserves the original method promise', async () => {
    const f = fixture();
    let now = 100;
    let done!: () => void;
    const promise = new Promise<void>((resolve) => {
      done = resolve;
    });
    f.targets.E4_EVAL_WRITE.work = () => promise;
    const diagnostic = new E4PreparePhaseDiagnostic(
      f.bindings(),
      () => now,
      () => ({ user: 0, system: 0 }),
    );
    diagnostic.enableBoundaryTimeline(100);
    diagnostic.begin();
    now = 110;
    expect(f.targets.E4_EVAL_WRITE.work()).toBe(promise);
    now = 130;
    done();
    await promise;
    await remaining(f, ['E4_EVAL_WRITE']);
    diagnostic.finish('OK');
    diagnostic.restore();
    expect(diagnostic.boundarySnapshot()).toMatchObject({
      status: 'COMPLETE',
      calls: 1,
      trace: [
        { edge: 'METHOD_ENTER', atMs: 10 },
        { edge: 'METHOD_OK', atMs: 30 },
      ],
    });
    expect(Object.keys(diagnostic.snapshot())).toEqual(['status', 'root', 'phases']);
  });

  it('preserves rejected method identity without retaining its input or error', async () => {
    const f = fixture();
    const error = new Error('opaque original method failure');
    const promise = Promise.reject(error);
    f.targets.E4_EVAL_WRITE.work = () => promise;
    const diagnostic = new E4PreparePhaseDiagnostic(
      f.bindings(),
      () => 100,
      () => ({ user: 0, system: 0 }),
    );
    diagnostic.enableBoundaryTimeline(100);
    diagnostic.begin();
    expect(
      f.targets.E4_EVAL_WRITE.work({
        toJSON() {
          throw new Error('do not serialize input');
        },
      }),
    ).toBe(promise);
    await expect(promise).rejects.toBe(error);
    diagnostic.finish('FAIL');
    diagnostic.restore();
    expect(diagnostic.boundarySnapshot()).toMatchObject({
      status: 'COMPLETE',
      trace: [{ edge: 'METHOD_ENTER' }, { edge: 'METHOD_ERROR' }],
    });
    expect(JSON.stringify(diagnostic.boundarySnapshot())).not.toContain(error.message);
  });

  it('does not turn an invalid anchor or missing method into a complete boundary record', async () => {
    const f = fixture();
    const diagnostic = new E4PreparePhaseDiagnostic(f.bindings(), f.clock);
    diagnostic.enableBoundaryTimeline(Number.NaN);
    diagnostic.begin();
    await remaining(f);
    diagnostic.finish('OK');
    diagnostic.restore();
    expect(diagnostic.snapshot().status).toBe('COMPLETE');
    expect(diagnostic.boundarySnapshot().status).toBe('UNKNOWN');
    const second = fixture();
    const missing = new E4PreparePhaseDiagnostic(second.bindings(), second.clock);
    missing.enableBoundaryTimeline(0);
    missing.begin();
    missing.finish('FAIL');
    missing.restore();
    expect(missing.boundarySnapshot().status).toBe('UNKNOWN');
  });

  it('caps boundary records without dropping original method invocations', async () => {
    const f = fixture();
    const original = jest.fn(() => Promise.resolve(undefined));
    f.targets.E4_EVAL_WRITE.work = original;
    const diagnostic = new E4PreparePhaseDiagnostic(f.bindings(), f.clock);
    diagnostic.enableBoundaryTimeline(0);
    diagnostic.begin();
    for (let i = 0; i < 10; i++) await f.targets.E4_EVAL_WRITE.work();
    diagnostic.finish('FAIL');
    diagnostic.restore();
    expect(original).toHaveBeenCalledTimes(10);
    expect(diagnostic.boundarySnapshot().status).toBe('UNKNOWN');
    expect(diagnostic.boundarySnapshot().trace.length).toBeLessThanOrEqual(8);
    expect(Buffer.byteLength(JSON.stringify(diagnostic.boundarySnapshot()))).toBeLessThanOrEqual(
      4096,
    );
  });
});

const compositionMethods: Record<E4PreparePhase, string> = {
  C3_PROOF: 'lockedProof',
  C3_SOURCE: 'lockedSources',
  C3_EVAL: 'evaluateInTx',
  C3_BUCKET_WRITE: 'insertBuckets',
  E4_PREPARE: 'prepareTimeInTx',
  E4_EVAL: 'readTimeEvaluationInTx',
  E4_EVAL_WRITE: 'insertEvaluations',
  C3_RECEIPT: 'receipt',
};
function compositionFixture(promise: Promise<unknown> = Promise.resolve(undefined)) {
  let tick = 0;
  const clock = () => tick++;
  const listeners: ((event: unknown) => void)[] = [];
  const native = jest.fn<Promise<unknown>, unknown[]>(() => promise);
  const engine = {
    name: 'LibraryEngine',
    engine: { query: native },
    request(...args: unknown[]) {
      return this.engine.query(...args);
    },
    requestBatch: () => Promise.resolve(undefined),
  };
  const client = {
    _engine: engine,
    $on(kind: string, listener: (event: unknown) => void) {
      expect(this).toBe(client);
      expect(kind).toBe('query');
      listeners.push(listener);
    },
  };
  const request = {
    action: 'executeRaw',
    query: {
      arguments: {
        query:
          'INSERT INTO "ParticipantContributionEvaluation" ("one") SELECT one FROM jsonb_to_recordset($1::jsonb)',
      },
    },
  };
  const received: { phase: E4PreparePhase; receiver: object; args: unknown[] }[] = [];
  function phaseFor(actualClient: object = client) {
    const bindings = E4_PREPARE_PHASES.map((phase) => ({
      phase,
      method: compositionMethods[phase],
      target: {
        ...(phase === 'C3_PROOF' ? { prisma: actualClient } : {}),
        [compositionMethods[phase]]: function (this: object, ...args: unknown[]) {
          received.push({ phase, receiver: this, args });
          return phase === 'E4_EVAL_WRITE' ? engine.request(request) : Promise.resolve(undefined);
        },
      },
    }));
    const diagnostic = new E4PreparePhaseDiagnostic(bindings, clock, () => ({
      user: 0,
      system: 0,
    }));
    return { bindings, diagnostic };
  }
  const phase = phaseFor();
  const keys = Reflect.ownKeys(engine);
  const requestDescriptor = Object.getOwnPropertyDescriptor(engine, 'request');
  const nativeDescriptor = Object.getOwnPropertyDescriptor(engine.engine, 'query');
  const waits = new E4EngineRequestWaitDiagnostic(engine, clock);
  const invoke = (binding: (typeof phase.bindings)[number], ...args: unknown[]): unknown => {
    const method: unknown = Reflect.get(binding.target, binding.method);
    if (typeof method !== 'function') throw new Error('Fixture method missing');
    return Reflect.apply(method, binding.target, args);
  };
  return {
    client,
    engine,
    listeners,
    native,
    promise,
    request,
    phase,
    phaseFor,
    waits,
    received,
    invoke,
    keys,
    requestDescriptor,
    nativeDescriptor,
    event: (query: string, duration: number) =>
      listeners.forEach((listener) => listener({ query, duration })),
  };
}
async function completeComposition(f: ReturnType<typeof compositionFixture>) {
  const payload = Object.freeze({ opaque: Symbol('unrecorded') });
  for (const binding of f.phase.bindings) {
    const returned = f.invoke(binding, payload);
    if (binding.phase === 'E4_EVAL_WRITE') expect(returned).toBe(f.promise);
    await returned;
  }
  f.waits.finish();
  f.waits.restore();
  f.phase.diagnostic.finish('OK');
  f.phase.diagnostic.restore();
  for (const binding of f.phase.bindings)
    expect(f.received.find((row) => row.phase === binding.phase)).toEqual({
      phase: binding.phase,
      receiver: binding.target,
      args: [payload],
    });
}
function loggedBoundary(log: jest.SpyInstance, tag: string): unknown {
  const entry = log.mock.calls.find((args: unknown[]) => args[0] === tag);
  if (!entry || typeof entry[1] !== 'string') throw new Error('Fixed boundary output missing');
  expect(Buffer.byteLength(entry[1], 'utf8')).toBeLessThanOrEqual(4096);
  const value: unknown = JSON.parse(entry[1]);
  return value;
}
describe('E4 explicit same-engine observer composition', () => {
  afterEach(() => jest.restoreAllMocks());
  it('joins the actual engine, preserves method Promise/arguments and restores native before outer', async () => {
    const log = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const f = compositionFixture();
    f.waits.begin();
    f.phase.diagnostic.begin();
    f.event('BEGIN', 0);
    f.event('SET TRANSACTION READ ONLY', 0);
    f.event(f.request.query.arguments.query, 3);
    f.event('COMMIT', 0);
    await completeComposition(f);
    const old: string[] = [];
    expect(f.phase.diagnostic.emitTo((text) => old.push(text))).toBe(true);
    expect(old).toHaveLength(1);
    expect(Object.keys(f.phase.diagnostic.snapshot())).toEqual(['status', 'root', 'phases']);
    expect(Object.keys(f.waits.snapshot())).toEqual([
      'status',
      'bridgeCalls',
      'pending',
      'wallMs',
      'insideRequestMs',
      'outsideRequestMs',
      'categories',
    ]);
    expect(f.waits.snapshot()).toMatchObject({ status: 'COMPLETE', bridgeCalls: 1 });
    expect(f.native).toHaveBeenCalledWith(f.request);
    expect(f.native.mock.contexts[0]).toBe(f.engine.engine);
    expect(loggedBoundary(log, 'E4 maximum method boundaries (fixed counters)')).toMatchObject({
      status: 'COMPLETE',
      calls: 1,
      trace: [{ edge: 'METHOD_ENTER' }, { edge: 'METHOD_OK' }],
    });
    expect(
      loggedBoundary(log, 'E4 maximum native request boundaries (fixed counters)'),
    ).toMatchObject({
      status: 'COMPLETE',
      selectedCalls: 1,
      nativeCalls: 1,
      reasons: [],
      events: expect.arrayContaining([
        expect.objectContaining({ event: 'EVAL_INSERT', calls: 1, durationMs: 3 }),
        expect.objectContaining({ event: 'COMMIT', calls: 1 }),
      ]),
    });
    expect(Object.getOwnPropertyDescriptor(f.engine, 'request')).toEqual(f.requestDescriptor);
    expect(Object.getOwnPropertyDescriptor(f.engine.engine, 'query')).toEqual(f.nativeDescriptor);
    expect(Reflect.ownKeys(f.engine)).toEqual(f.keys);
    const before = log.mock.calls.length;
    f.event('SELECT 1', 8);
    expect(log.mock.calls).toHaveLength(before);
  });
  it('preserves the original rejection and failure outcome through the composed observers', async () => {
    const error = new Error('unrecorded original');
    const promise = Promise.reject(error);
    const f = compositionFixture(promise);
    const log = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    f.waits.begin();
    f.phase.diagnostic.begin();
    const write = f.phase.bindings.find((binding) => binding.phase === 'E4_EVAL_WRITE')!;
    const returned = f.invoke(write);
    expect(returned).toBe(promise);
    await expect(returned).rejects.toBe(error);
    f.waits.finish();
    f.waits.restore();
    f.phase.diagnostic.finish('FAIL');
    f.phase.diagnostic.restore();
    expect(f.phase.diagnostic.emitTo(() => undefined)).toBe(true);
    expect(f.phase.diagnostic.snapshot()).toMatchObject({
      status: 'COMPLETE',
      root: { failed: 1 },
    });
    expect(
      loggedBoundary(log, 'E4 maximum native request boundaries (fixed counters)'),
    ).toMatchObject({
      status: 'COMPLETE',
      trace: [
        { edge: 'OUTER_ENTER' },
        { edge: 'NATIVE_ENTER' },
        { edge: 'NATIVE_ERROR' },
        { edge: 'OUTER_ERROR' },
      ],
    });
    expect(Reflect.ownKeys(f.engine)).toEqual(f.keys);
  });
  it('leaves an outer-only R4 observer and its native bridge unchanged', async () => {
    const f = compositionFixture();
    f.waits.begin();
    expect(f.engine.engine.query).toBe(f.native);
    expect(f.listeners).toHaveLength(0);
    expect(f.engine.request({ action: 'queryRaw' })).toBe(f.promise);
    await f.promise;
    f.waits.finish();
    f.waits.restore();
    expect(f.engine.engine.query).toBe(f.native);
    expect(f.waits.snapshot()).toMatchObject({ status: 'COMPLETE', bridgeCalls: 1 });
    expect(Reflect.ownKeys(f.engine)).toEqual(f.keys);
  });
  it('does not join a different client engine or a phase that starts without an active owner', async () => {
    const f = compositionFixture(),
      other = compositionFixture();
    const phase = f.phaseFor(other.client);
    f.waits.begin();
    phase.diagnostic.begin();
    expect(phase.diagnostic.boundarySnapshot().status).toBe('NOT_RUN');
    expect(f.listeners).toHaveLength(0);
    expect(other.listeners).toHaveLength(0);
    expect(f.engine.engine.query).toBe(f.native);
    expect(other.engine.engine.query).toBe(other.native);
    phase.diagnostic.finish('FAIL');
    phase.diagnostic.restore();
    f.waits.finish();
    f.waits.restore();
    other.phase.diagnostic.begin();
    other.waits.begin();
    expect(other.phase.diagnostic.boundarySnapshot().status).toBe('NOT_RUN');
    other.waits.finish();
    other.waits.restore();
    other.phase.diagnostic.finish('FAIL');
    other.phase.diagnostic.restore();
  });
  it('keeps two interleaved engines and event subscribers independent', async () => {
    const log = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const a = compositionFixture(),
      b = compositionFixture();
    a.waits.begin();
    b.waits.begin();
    a.phase.diagnostic.begin();
    b.phase.diagnostic.begin();
    a.event('ROLLBACK', 7);
    b.event('COMMIT', 9);
    await completeComposition(a);
    await completeComposition(b);
    a.phase.diagnostic.emitTo(() => undefined);
    expect(
      loggedBoundary(log, 'E4 maximum native request boundaries (fixed counters)'),
    ).toMatchObject({
      status: 'COMPLETE',
      events: expect.arrayContaining([
        expect.objectContaining({ event: 'ROLLBACK', calls: 1, durationMs: 7 }),
        expect.objectContaining({ event: 'COMMIT', calls: 0 }),
      ]),
    });
    log.mockClear();
    b.phase.diagnostic.emitTo(() => undefined);
    expect(
      loggedBoundary(log, 'E4 maximum native request boundaries (fixed counters)'),
    ).toMatchObject({
      status: 'COMPLETE',
      events: expect.arrayContaining([
        expect.objectContaining({ event: 'COMMIT', calls: 1, durationMs: 9 }),
        expect.objectContaining({ event: 'ROLLBACK', calls: 0 }),
      ]),
    });
    expect(Reflect.ownKeys(a.engine)).toEqual(a.keys);
    expect(Reflect.ownKeys(b.engine)).toEqual(b.keys);
  });
  it('marks a second join UNKNOWN instead of sharing one native observer by call order', async () => {
    const log = jest.spyOn(console, 'info').mockImplementation(() => undefined),
      f = compositionFixture();
    f.waits.begin();
    f.phase.diagnostic.begin();
    expect(joinE4NativeBoundary(f.client)).toBeUndefined();
    await completeComposition(f);
    f.phase.diagnostic.emitTo(() => undefined);
    expect(
      loggedBoundary(log, 'E4 maximum native request boundaries (fixed counters)'),
    ).toMatchObject({ status: 'UNKNOWN', reasons: ['OWNER_AMBIGUITY'] });
  });
  it('rejects two active owners on one engine and removes only each owned handshake', async () => {
    const log = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const f = compositionFixture();
    const second = new E4EngineRequestWaitDiagnostic(f.engine);
    f.waits.begin();
    second.begin();
    f.phase.diagnostic.begin();
    expect(f.engine.engine.query).toBe(f.native);
    for (const binding of f.phase.bindings) await f.invoke(binding);
    second.finish();
    second.restore();
    f.waits.finish();
    f.waits.restore();
    f.phase.diagnostic.finish('OK');
    f.phase.diagnostic.restore();
    expect(second.snapshot().status).toBe('COMPLETE');
    expect(f.waits.snapshot().status).toBe('COMPLETE');
    f.phase.diagnostic.emitTo(() => undefined);
    expect(
      loggedBoundary(log, 'E4 maximum native request boundaries (fixed counters)'),
    ).toMatchObject({ status: 'UNKNOWN', reasons: ['OWNER_AMBIGUITY'], nativeCalls: 0 });
    expect(Reflect.ownKeys(f.engine)).toEqual(f.keys);
  });
  it('does not let extra logging or subscription failures replace the old emitter result', async () => {
    const f = compositionFixture();
    f.client.$on = () => {
      throw new Error('unrecorded subscription');
    };
    f.waits.begin();
    f.phase.diagnostic.begin();
    expect(f.engine.engine.query).toBe(f.native);
    await completeComposition(f);
    const log = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    expect(f.phase.diagnostic.emitTo(() => undefined)).toBe(true);
    expect(
      loggedBoundary(log, 'E4 maximum native request boundaries (fixed counters)'),
    ).toMatchObject({ status: 'UNKNOWN', reasons: expect.arrayContaining(['SUBSCRIBE']) });
    log.mockImplementation(() => {
      throw new Error('unrecorded extra logger');
    });
    expect(f.phase.diagnostic.emitTo(() => undefined)).toBe(true);
    expect(f.phase.diagnostic.snapshot().status).toBe('COMPLETE');
    expect(f.waits.snapshot().status).toBe('COMPLETE');
  });
});

describe('E4 native composition preserves the complete approved scale base', () => {
  function opening() {
    const source = fs.readFileSync(
      path.join(__dirname, '../e2e/activity-os-r5-e4-contribution-settlement-scale.e2e-spec.ts'),
      'utf8',
    );
    const check = (text: string): void => {
      if (
        createHash('sha256').update(text).digest('hex') !==
        '50a090de9193d80ab659852c0420aed4e05290913be1050b5f5631da9cf17ed6'
      )
        throw new Error('Complete approved scale bytes differ');
    };
    return { source, check };
  }
  it('restores the entire bc28 scale file including every old assertion and SQL byte', () => {
    const { source } = opening();
    expect(createHash('sha256').update(source).digest('hex')).toBe(
      '50a090de9193d80ab659852c0420aed4e05290913be1050b5f5631da9cf17ed6',
    );
  });
  it('rejects missing, duplicated and modified source bytes', () => {
    const { source, check } = opening();
    expect(() =>
      check(source.replace('import { PrismaClient, Prisma }', 'import { PrismaClient }')),
    ).toThrow();
    expect(() =>
      check(source.replace('// E4_TERMINAL_HELPERS_BEGIN', '// removed marker')),
    ).toThrow();
    expect(() => check(source + source.slice(0, source.indexOf('\n')))).toThrow();
  });
  it('keeps every old assertion byte change visible without a source normalizer', () => {
    const { source } = opening();
    const changed = source.replace(
      'expect(barrierQueries).toBe(1);',
      'expect(barrierQueries).toBe(0);',
    );
    expect(changed).not.toBe(source);
    expect(createHash('sha256').update(changed).digest('hex')).not.toBe(
      '50a090de9193d80ab659852c0420aed4e05290913be1050b5f5631da9cf17ed6',
    );
  });
});
