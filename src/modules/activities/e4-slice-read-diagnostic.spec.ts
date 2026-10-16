import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import ts from 'typescript';
import {
  E4SliceReadDiagnostic,
  E4_SLICE_SQL_SHA256,
  E4_SLICE_PREFIX_MD5,
  E4_SLICE_OBSERVER_SQL,
  e4SliceReadOptions,
  preflightE4SliceReadDiagnostic,
} from '../../../test/helpers/e4-slice-read-diagnostic';
import { E4EngineRequestWaitDiagnostic } from '../../../test/helpers/e4-engine-request-wait-diagnostic';
import { deriveTestDbName } from '../../../test/setup/worktree-db';

// Supply the declared fake scope to the real validator; this suite never connects to a database.
jest.mock('../../../test/setup/test-run-scope', () => {
  const actual = jest.requireActual<typeof import('../../../test/setup/test-run-scope')>(
    '../../../test/setup/test-run-scope',
  );
  return {
    ...actual,
    assertNamedTestDatabaseScope: (databases: string[]) =>
      actual.assertNamedTestDatabaseScope(databases, {
        allowedDatabases: 'app_test_w1',
        planOnly: '0',
        githubActions: 'false',
      }),
  };
});

function actualSliceSql() {
  const path = resolve(__dirname, 'activity-contribution-settlement-query.service.ts');
  const text = readFileSync(path, 'utf8');
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const found: ts.TaggedTemplateExpression[] = [];
  function visit(node: ts.Node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'readTimeEvaluationInTx') {
      function query(child: ts.Node) {
        if (ts.isTaggedTemplateExpression(child) && child.tag.getText(ast) === 'tx.$queryRaw')
          found.push(child);
        ts.forEachChild(child, query);
      }
      query(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  expect(found).toHaveLength(1);
  const template = found[0].template as ts.TemplateExpression;
  let sql = template.head.text;
  template.templateSpans.forEach((span, i) => {
    sql += '$' + (i + 1) + span.literal.text;
  });
  expect(template.templateSpans).toHaveLength(4);
  return sql;
}
const sql = actualSliceSql();
const parameters = ['private-version', 'private-time', 'private-activity', 50001];
const message = () => ({
  action: 'queryRaw',
  query: { arguments: { query: sql, parameters: JSON.stringify(parameters) } },
});
const observation = () => [
  {
    scope: true,
    observerPid: 82,
    activityOn: true,
    activityBytes: 1024,
    targetCount: 1,
    target: [
      {
        pid: 81,
        epoch: '2026-10-16 00:00:00+00',
        transaction: '2026-10-16 01:00:00+00',
        state: 'active',
        type: 'Lock',
        event: 'transactionid',
        slicePrefixMatches: true,
        queryMayBeTruncated: true,
        blockers: 1,
      },
    ],
    chain: [
      {
        pid: 81,
        parent: null,
        depth: 0,
        state: 'active',
        type: 'Lock',
        event: 'transactionid',
        blockers: 1,
      },
      {
        pid: 83,
        parent: 81,
        depth: 1,
        state: 'idle in transaction',
        type: 'Client',
        event: 'ClientRead',
        blockers: 0,
      },
    ],
  },
];
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
function fixture() {
  let done!: (value: object) => void, reject!: (error: Error) => void;
  let tick = 1000;
  let clockFailure = false;
  const promise = new Promise<object>((yes, no) => {
    done = yes;
    reject = no;
  });
  const engine = {
    request: jest.fn((...args: unknown[]) => {
      void args;
      return promise;
    }),
    requestBatch: jest.fn(() => Promise.resolve([])),
  };
  const target = { _engine: engine, $disconnect: jest.fn(() => Promise.resolve()) };
  const originalRequest = engine.request;
  const app = { close: jest.fn(() => Promise.resolve()) };
  const outputs: object[] = [],
    pauses: (() => void)[] = [];
  const observe = jest.fn(() => Promise.resolve(observation()));
  const maintenance = jest.fn((...args: unknown[]) => {
    void args;
    return Promise.resolve({ databases: 1, clients: 0, capturedBackends: 0 });
  });
  const deps = {
    observe,
    maintenance,
    now: () => {
      if (clockFailure) throw new Error('private clock');
      return tick;
    },
    pause: () => new Promise<void>((r) => pauses.push(r)),
    emit: (e: object) => {
      outputs.push(e);
    },
  };
  const diagnostic = new E4SliceReadDiagnostic(
    target,
    {} as PrismaClient,
    app,
    { scope: 'app_test_w1', applicationName: 'e4slice_0123456789abcdef' },
    deps,
  );
  return {
    engine,
    originalRequest,
    target,
    app,
    diagnostic,
    promise,
    done,
    reject,
    outputs,
    observe,
    maintenance,
    breakClock: () => {
      clockFailure = true;
    },
    advance: (ms: number) => {
      tick += ms;
    },
    release: () => {
      for (const p of pauses.splice(0)) p();
    },
    async settle(error?: Error) {
      if (error) reject(error);
      else done({ private: true });
      await promise.catch(() => undefined);
      await flush();
      for (const p of pauses.splice(0)) p();
      await flush();
    },
    async cleanup() {
      diagnostic.restoreEngine();
      await diagnostic.finishObservation();
      await target.$disconnect();
      await app.close();
      await diagnostic.collectCleanup();
    },
  };
}

describe('E4 slice observation without a database', () => {
  it.each([
    { scope: true, activityOn: true, activityBytes: 1024, accepted: true },
    { scope: false, activityOn: true, activityBytes: 1024, accepted: false },
    { scope: true, activityOn: false, activityBytes: 1024, accepted: false },
    { scope: true, activityOn: true, activityBytes: 128, accepted: false },
  ])(
    'validates the observer before any expensive fixture: %j',
    async ({ scope, activityOn, activityBytes, accepted }) => {
      const commands: string[] = [];
      const query = jest.fn((...args: unknown[]) => {
        void args;
        return Promise.resolve([
          { scope, targetCount: 0, observerPid: 82, activityOn, activityBytes },
        ]);
      });
      const monitor = {
        $transaction: jest.fn((work: (tx: object) => Promise<unknown>) =>
          work({
            $executeRawUnsafe: (statement: string) => {
              commands.push(statement);
              return Promise.resolve(0);
            },
            $queryRawUnsafe: query,
          }),
        ),
      } as unknown as PrismaClient;
      const result = preflightE4SliceReadDiagnostic(monitor, {
        scope: 'app_test_w1',
        applicationName: 'e4slice_0123456789abcdef',
      });
      if (accepted) await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toThrow('BEFORE_MAXIMUM_FIXTURE');
      expect(commands).toEqual([
        'SET TRANSACTION READ ONLY',
        "SET LOCAL statement_timeout='500ms'",
      ]);
      expect(query.mock.calls[0][0]).toBe(E4_SLICE_OBSERVER_SQL);
    },
  );
  it('recognizes the real Prisma tagged-query request protocol with its engine stubbed before any connection', async () => {
    const db = new PrismaClient({
      datasourceUrl: 'postgresql://fixture:fixture@127.0.0.1:1/app_test',
    });
    const engine = Reflect.get(db, '_engine') as object;
    const original = Reflect.get(engine, 'request') as unknown;
    const start = jest
      .spyOn(engine as { start: () => Promise<void> }, 'start')
      .mockRejectedValue(new Error('NO_DATABASE_ACCESS'));
    const calls: unknown[][] = [];
    Reflect.set(engine, 'request', (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ data: { queryRaw: { columns: [], types: [], rows: [] } } });
    });
    const app = { close: () => Promise.resolve() };
    const disconnect: unknown = Reflect.get(db, '$disconnect');
    const diagnostic = new E4SliceReadDiagnostic(
      db,
      {} as PrismaClient,
      app,
      { scope: 'app_test_w1', applicationName: 'e4slice_0123456789abcdef' },
      {
        observe: () => Promise.resolve(observation()),
        pause: () => Promise.resolve(),
        maintenance: () => Promise.resolve({ databases: 1, clients: 0, capturedBackends: 0 }),
        emit: () => undefined,
      },
    );
    try {
      diagnostic.arm();
      await db.$queryRaw(Prisma.sql(sql.split(/\$[1-4]/u), ...parameters));
      expect(start).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
      const request = calls[0][0] as {
        action: string;
        query: { arguments: { query: string; parameters: unknown } };
      };
      expect(request.action).toBe('queryRaw');
      expect(
        createHash('sha256')
          .update(request.query.arguments.query.trim().replace(/\s+/gu, ' '))
          .digest('hex'),
      ).toBe(E4_SLICE_SQL_SHA256);
      expect(request.query.arguments.parameters).toBe(JSON.stringify(parameters));
      diagnostic.restoreEngine();
      await diagnostic.finishObservation();
      await db.$disconnect();
      await app.close();
      await diagnostic.collectCleanup();
      expect(diagnostic.snapshot().reasons).toEqual([]);
      expect(Reflect.get(db, '$disconnect')).toBe(disconnect);
    } finally {
      Reflect.set(engine, 'request', original);
      start.mockRestore();
      await db.$disconnect();
    }
  });
  it('identifies only the safe prefix when the real slice SQL exceeds the activity buffer', () => {
    expect(Buffer.byteLength(sql)).toBeGreaterThan(1024);
    const normalize = (value: string) => value.trim().replace(/\s+/gu, ' ');
    const truncated = Buffer.from(sql).subarray(0, 1023).toString('utf8');
    expect(createHash('md5').update(normalize(truncated).slice(0, 128)).digest('hex')).toBe(
      E4_SLICE_PREFIX_MD5,
    );
    expect(createHash('sha256').update(normalize(truncated)).digest('hex')).not.toBe(
      E4_SLICE_SQL_SHA256,
    );
  });
  it('records an unmatched or truncated server prefix as unknown rather than absence of the slice', async () => {
    const f = fixture();
    const rows = observation();
    rows[0].target[0].slicePrefixMatches = false;
    f.observe.mockResolvedValue(rows);
    f.diagnostic.arm();
    void f.engine.request(message());
    await flush();
    await f.settle();
    await f.cleanup();
    expect(f.diagnostic.snapshot()).toMatchObject({
      queryIdentity: {
        unmatchedPrefix: 'UNKNOWN_NOT_PROOF_OF_ABSENCE',
        fullServerQueryMatch: 'UNAVAILABLE',
      },
      samples: [{ slicePrefixMatches: null, queryMayBeTruncated: true, activityBytes: 1024 }],
    });
  });
  it('binds the exact production slice shape and preserves every existing URL option', () => {
    expect(createHash('sha256').update(sql.trim().replace(/\s+/gu, ' ')).digest('hex')).toBe(
      E4_SLICE_SQL_SHA256,
    );
    const input = new URL(
      'postgresql://fixture:fixture@localhost:5432/' +
        deriveTestDbName() +
        '?schema=public&connection_limit=5&pool_timeout=20',
    );
    const output = e4SliceReadOptions(input.toString());
    const changed = new URL(output.clientOptions.datasourceUrl);
    expect(output.applicationName).toMatch(/^e4slice_[a-f0-9]{16}$/u);
    changed.searchParams.delete('application_name');
    expect(changed.toString()).toBe(input.toString());
    expect(() => e4SliceReadOptions('postgresql://fixture:fixture@remote.invalid/prod')).toThrow(
      'E4_SLICE_TEST_SCOPE',
    );
  });
  it('keeps the actual request Promise, receiver, arguments and result; emits only projected evidence', async () => {
    const f = fixture(),
      request = message(),
      options = Object.freeze({ transaction: 'private-transaction' });
    f.diagnostic.arm();
    expect(f.engine.request(request, options)).toBe(f.promise);
    expect(f.originalRequest.mock.contexts[0]).toBe(f.engine);
    expect(f.originalRequest.mock.calls[0][0]).toBe(request);
    expect(f.originalRequest.mock.calls[0][1]).toBe(options);
    await flush();
    f.advance(26496);
    await f.settle();
    f.diagnostic.queryEvent(sql, 23000);
    await f.cleanup();
    expect(f.diagnostic.snapshot()).toMatchObject({
      status: 'OBSERVED',
      requestOutcome: 'OK',
      backendPid: 81,
      requestDurationMs: 26496,
      observedClose: 'COMPLETE',
      appClose: 'COMPLETE',
      planStatus: 'UNAVAILABLE',
      actualSameTransactionPlan: 'UNAVAILABLE',
      cleanup: {
        databases: 1,
        clients: 0,
        capturedBackends: 0,
        workerFinalizer: 'RETAINED_FOR_GLOBAL_TEARDOWN',
        postGlobalDrop: 'UNOBSERVED',
      },
    });
    expect(f.diagnostic.snapshot().samples[0]).toMatchObject({
      pid: 81,
      slicePrefixMatches: true,
      activityBytes: 1024,
      queryMayBeTruncated: true,
      chain: [
        { pid: 81, parent: null },
        { pid: 83, parent: 81 },
      ],
    });
    const encoded = JSON.stringify(f.outputs);
    for (const privateText of [
      ...parameters.slice(0, 3),
      'private-transaction',
      'SELECT b.id',
      'Filter',
      'epoch',
      'applicationName',
    ])
      expect(encoded).not.toContain(privateText);
  });
  it('keeps the original rejection and explicitly marks the failed transaction plan unavailable', async () => {
    const f = fixture(),
      failure = Object.assign(new Error('private SQL and credentials'), { code: 'P2028' });
    f.diagnostic.arm();
    expect(f.engine.request(message())).toBe(f.promise);
    await flush();
    await f.settle(failure);
    await expect(f.promise).rejects.toBe(failure);
    await f.cleanup();
    expect(f.diagnostic.snapshot()).toMatchObject({
      requestOutcome: 'FAIL',
      planStatus: 'UNAVAILABLE',
      actualSameTransactionPlan: 'UNAVAILABLE',
    });
    expect(JSON.stringify(f.outputs)).not.toContain(failure.message);
  });
  it('does not touch parameters or monitor unrelated requests', async () => {
    const f = fixture();
    f.diagnostic.arm();
    const other = {
      action: 'queryRaw',
      query: {
        arguments: {
          query: sql + ' ',
          get parameters() {
            throw new Error('private');
          },
        },
      },
    };
    other.query.arguments.query = 'SELECT 1';
    expect(f.engine.request(other)).toBe(f.promise);
    await f.settle();
    await f.cleanup();
    expect(f.observe).not.toHaveBeenCalled();
    expect(f.diagnostic.snapshot().requestOutcome).toBe('NOT_RUN');
  });
  it('preserves synchronous throws without leaking their text', async () => {
    const failure = new Error('private raw SQL');
    const engine = {
        request: jest.fn((...args: unknown[]) => {
          void args;
          throw failure;
        }),
      },
      target = { _engine: engine, $disconnect: () => Promise.resolve() },
      app = { close: () => Promise.resolve() };
    const d = new E4SliceReadDiagnostic(
      target,
      {} as PrismaClient,
      app,
      { scope: 'app_test_w1', applicationName: 'e4slice_0123456789abcdef' },
      { emit: () => undefined },
    );
    d.arm();
    expect(() => engine.request(message())).toThrow(failure);
    d.restoreEngine();
    await d.finishObservation();
    expect(d.snapshot().requestOutcome).toBe('FAIL');
  });
  it('rolls back partial hook installation and restores every original descriptor', () => {
    const request = () => Promise.resolve(),
      disconnect = () => Promise.resolve();
    const engine = { request },
      target = { _engine: engine, $disconnect: disconnect };
    expect(
      () =>
        new E4SliceReadDiagnostic(
          target,
          {} as PrismaClient,
          {},
          { scope: 'app_test_w1', applicationName: 'e4slice_0123456789abcdef' },
        ),
    ).toThrow('E4_SLICE_INSTALL');
    expect(engine.request).toBe(request);
    expect(target.$disconnect).toBe(disconnect);
  });
  it('restores the existing engine observer before the inner slice wrapper', async () => {
    const f = fixture(),
      sliceWrapper = f.engine.request;
    const outer = new E4EngineRequestWaitDiagnostic(f.engine);
    f.diagnostic.arm();
    outer.begin();
    expect(f.engine.request(message())).toBe(f.promise);
    await f.settle();
    outer.finish();
    outer.restore();
    expect(f.engine.request).toBe(sliceWrapper);
    await f.cleanup();
    expect(f.diagnostic.snapshot().reasons).not.toContain('RESTORE_OWNERSHIP');
    expect(outer.snapshot().status).toBe('COMPLETE');
  });
  it.each(['multiple', 'pid', 'backend_epoch', 'transaction_epoch', 'observer', 'scope'] as const)(
    'refuses ambiguous or changed backend ownership: %s',
    async (kind) => {
      const f = fixture();
      f.diagnostic.arm();
      void f.engine.request(message());
      await flush();
      const rows = observation();
      if (kind === 'multiple') rows[0].targetCount = 2;
      if (kind === 'pid') rows[0].target[0].pid = 84;
      if (kind === 'backend_epoch') rows[0].target[0].epoch = 'changed';
      if (kind === 'transaction_epoch') rows[0].target[0].transaction = 'changed';
      if (kind === 'observer') rows[0].observerPid = 81;
      if (kind === 'scope') rows[0].scope = false;
      f.observe.mockResolvedValue(rows);
      f.release();
      await flush();
      await f.settle();
      await f.cleanup();
      expect(f.diagnostic.snapshot()).toMatchObject({
        status: 'UNKNOWN',
      });
      expect(f.diagnostic.snapshot().reasons).toEqual(expect.arrayContaining(['MONITOR']));
    },
  );
  it('stops new samples and waits for an in-flight observation rather than pretending a timeout cancels it', async () => {
    const f = fixture();
    let done!: (v: ReturnType<typeof observation>) => void;
    f.observe.mockImplementation(
      () =>
        new Promise((r) => {
          done = r;
        }),
    );
    f.diagnostic.arm();
    void f.engine.request(message());
    await flush();
    await f.settle();
    let collected = false;
    const collecting = f.diagnostic.finishObservation().then(() => {
      collected = true;
    });
    await flush();
    expect(collected).toBe(false);
    done(observation());
    await collecting;
    await f.cleanup();
    expect(f.observe).toHaveBeenCalledTimes(1);
  });
  it('retains UNKNOWN after a sampling deadline even if the request later settles', async () => {
    const f = fixture();
    f.diagnostic.arm();
    void f.engine.request(message());
    await flush();
    f.advance(40001);
    f.release();
    await flush();
    await f.settle();
    await f.cleanup();
    expect(f.diagnostic.snapshot()).toMatchObject({
      status: 'UNKNOWN',
    });
    expect(f.diagnostic.snapshot().reasons).toEqual(expect.arrayContaining(['MONITOR']));
  });
  it('does not replace a business failure when sampling or cleanup also fails', async () => {
    const f = fixture(),
      failure = new Error('original private failure');
    f.observe.mockRejectedValue(new Error('private activity error'));
    f.maintenance.mockRejectedValue(new Error('private cleanup'));
    f.diagnostic.arm();
    void f.engine.request(message());
    await flush();
    await f.settle(failure);
    await f.cleanup();
    await expect(f.promise).rejects.toBe(failure);
    expect(f.diagnostic.snapshot()).toMatchObject({
      status: 'UNKNOWN',
    });
    expect(f.diagnostic.snapshot().reasons).toEqual(
      expect.arrayContaining(['MONITOR', 'CLEANUP_READ']),
    );
  });
  it('records remaining clients and never equates a retained worker with a post-global-drop receipt', async () => {
    const f = fixture();
    f.maintenance.mockResolvedValue({ databases: 1, clients: 1, capturedBackends: 1 });
    f.diagnostic.arm();
    void f.engine.request(message());
    await flush();
    await f.settle();
    await f.cleanup();
    expect(f.diagnostic.snapshot()).toMatchObject({
      status: 'UNKNOWN',
      cleanup: { databases: 1, postGlobalDrop: 'UNOBSERVED', container: 'RETAINED_TEST_SERVICE' },
    });
    expect(f.diagnostic.snapshot().reasons).toEqual(expect.arrayContaining(['REMAINING_BACKENDS']));
    expect(f.maintenance.mock.calls[0][0]).not.toMatch(
      /DROP|CREATE|TRUNCATE|pg_terminate_backend|pg_cancel_backend/u,
    );
    expect(f.maintenance.mock.calls[0][0]).toContain("datname='app_test_w1'");
  });
  it('uses only database-scoped reads and bounded blocker depth, never exports raw activity query text', () => {
    expect(E4_SLICE_OBSERVER_SQL).toContain('a.datname=current_database()');
    expect(E4_SLICE_OBSERVER_SQL).toContain('b.datname=current_database()');
    expect(E4_SLICE_OBSERVER_SQL).toContain('c.depth<2');
    expect(E4_SLICE_OBSERVER_SQL).toContain('LIMIT 8');
    expect(E4_SLICE_OBSERVER_SQL).toContain('LIMIT 24');
    expect(E4_SLICE_OBSERVER_SQL).toContain(
      "md5(left(btrim(regexp_replace(query,'\\s+',' ','g')),128))",
    );
    expect(E4_SLICE_OBSERVER_SQL).toContain(
      "pg_size_bytes(current_setting('track_activity_query_size'))",
    );
    expect(E4_SLICE_OBSERVER_SQL).not.toMatch(
      /DROP|CREATE|TRUNCATE|pg_terminate_backend|pg_cancel_backend/u,
    );
  });
  it.each(['sync', 'async'] as const)(
    'keeps the original failure when settlement clock observation throws: %s',
    async (mode) => {
      const f = fixture(),
        failure = new Error('original business cause');
      if (mode === 'sync')
        f.originalRequest.mockImplementation((...args: unknown[]) => {
          void args;
          f.breakClock();
          throw failure;
        });
      f.diagnostic.arm();
      if (mode === 'sync') expect(() => f.engine.request(message())).toThrow(failure);
      else {
        expect(f.engine.request(message())).toBe(f.promise);
        await flush();
        f.breakClock();
        await f.settle(failure);
        await expect(f.promise).rejects.toBe(failure);
      }
      await f.cleanup();
      expect(f.diagnostic.snapshot().reasons).toContain('CLOCK');
    },
  );
  it('stops new sampling near the unchanged whole-case deadline and leaves original cleanup intact', async () => {
    const f = fixture();
    f.diagnostic.arm();
    void f.engine.request(message());
    await flush();
    f.advance(599000);
    await f.settle();
    await f.cleanup();
    expect(f.diagnostic.snapshot()).toMatchObject({
      planStatus: 'UNAVAILABLE',
      observedClose: 'COMPLETE',
      appClose: 'COMPLETE',
    });
  });
  it('continues restoring other hooks when a proxy rejects one restoration', async () => {
    let rejectRestore = false;
    const request = (...args: unknown[]) => {
      void args;
      return Promise.resolve({});
    };
    const disconnect = () => Promise.resolve(),
      close = () => Promise.resolve();
    const base = { _engine: { request }, $disconnect: disconnect };
    const target = new Proxy(base, {
      defineProperty(t, key, descriptor) {
        if (rejectRestore && key === '$disconnect') throw new Error('private proxy');
        return Reflect.defineProperty(t, key, descriptor);
      },
    });
    const app = { close };
    const d = new E4SliceReadDiagnostic(
      target,
      {} as PrismaClient,
      app,
      { scope: 'app_test_w1', applicationName: 'e4slice_0123456789abcdef' },
      {
        emit: () => undefined,
        maintenance: () => Promise.resolve({ databases: 1, clients: 0, capturedBackends: 0 }),
      },
    );
    await target.$disconnect();
    await app.close();
    rejectRestore = true;
    await d.collectCleanup();
    expect(base._engine.request).toBe(request);
    expect(app.close).toBe(close);
    expect(d.snapshot().reasons).toContain('RESTORE');
  });
});
