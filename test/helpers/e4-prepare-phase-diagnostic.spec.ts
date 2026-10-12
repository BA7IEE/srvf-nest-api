import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as ts from 'typescript';
import {
  E4_PREPARE_PHASES,
  E4PreparePhaseDiagnostic,
  type E4PreparePhase,
} from './e4-prepare-phase-diagnostic';

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
