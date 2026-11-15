import type { JsonQuery } from '@prisma/client/runtime/library';
import { E4EngineRequestWaitDiagnostic } from '../../test/helpers/e4-engine-request-wait-diagnostic';
import '../../test/helpers/e4-engine-request-wait-diagnostic.spec';

function engine(request: (...args: unknown[]) => unknown = () => Promise.resolve('ok')) {
  return { request, requestBatch: request };
}
const barrier = {
  action: 'executeRaw',
  query: {
    arguments: {
      query:
        'SET CONSTRAINTS public.astr_parent_complete_guard, public.e4_revision_complete_guard IMMEDIATE',
    },
  },
};

describe('D6 optional MODEL request families', () => {
  function create(db: object, clock = () => 0, profile = 'D6_MODELS') {
    return Reflect.construct(E4EngineRequestWaitDiagnostic, [
      db,
      clock,
      profile,
    ]) as E4EngineRequestWaitDiagnostic;
  }
  function model(modelName: string, action: JsonQuery['action'] = 'findFirst'): JsonQuery {
    return { modelName, action, query: { arguments: {}, selection: { $scalars: true } } };
  }
  function summary(observer: E4EngineRequestWaitDiagnostic): unknown {
    return Reflect.get(observer.snapshot(), 'modelRequests');
  }

  it('keeps the default E4 snapshot contract unchanged', async () => {
    const db = engine();
    const observer = new E4EngineRequestWaitDiagnostic(db, () => 0);
    observer.begin();
    await db.request(model('User'));
    observer.finish();
    observer.restore();
    expect(Object.keys(observer.snapshot())).toEqual([
      'status',
      'bridgeCalls',
      'pending',
      'wallMs',
      'insideRequestMs',
      'outsideRequestMs',
      'categories',
    ]);
  });

  it.each([
    ['User', 'findUnique', 'ACTOR_READ'],
    ['Member', 'findUnique', 'ACTOR_READ'],
    ['Activity', 'findFirst', 'ACTIVITY_READ'],
    ['Organization', 'findFirst', 'ORGANIZATION_READ'],
    ['RoleBinding', 'findMany', 'PERMISSION_READ'],
    ['RolePermission', 'findMany', 'PERMISSION_READ'],
    ['Permission', 'findFirst', 'PERMISSION_READ'],
    ['ActivityResponsibilityAssignment', 'findFirst', 'RESPONSIBILITY_READ'],
    ['ActivitySettlementTimeCommandReceipt', 'findUnique', 'RECEIPT_READ'],
    ['ActivitySettlementTimeCommandReceipt', 'createOne', 'RECEIPT_CREATE'],
    ['AuditLog', 'createOne', 'AUDIT_CREATE'],
    ['User', 'updateOne', 'OTHER_MODEL'],
    ['PRIVATE_MODEL_CANARY', 'findMany', 'OTHER_MODEL'],
  ] as const)('classifies fixed protocol metadata %s/%s', async (name, action, family) => {
    let now = 0;
    const db = engine();
    const observer = create(db, () => now);
    observer.begin();
    now = 2;
    const promise = db.request(model(name, action));
    now = 9;
    await promise;
    now = 10;
    observer.finish();
    observer.restore();
    expect(observer.snapshot().status).toBe('COMPLETE');
    expect(summary(observer)).toMatchObject({
      status: 'OBSERVED',
      calls: 1,
      semantics: 'RECEIVED_ENGINE_MODEL_PROMISES_NOT_DATABASE_EXECUTION_OR_TRANSACTION_OWNERSHIP',
      families: [
        {
          family,
          calls: 1,
          pending: 0,
          ok: 1,
          failed: 0,
          wallMs: 7,
          largestMs: 7,
          firstStartedMs: 2,
          lastSettledMs: 9,
        },
      ],
    });
    expect(JSON.stringify(observer.snapshot())).not.toContain('PRIVATE_');
  });

  it('partitions MODEL only, preserves coarse raw categories and omits unobserved rows', async () => {
    const db = engine();
    const observer = create(db);
    await db.request(model('User'));
    observer.begin();
    await db.request(model('User'));
    await db.request(model('AuditLog', 'createOne'));
    await db.request({ action: 'queryRaw' });
    await db.request(barrier);
    await db.requestBatch([model('User')]);
    observer.finish();
    await db.request(model('User'));
    observer.restore();
    expect(observer.snapshot()).toMatchObject({
      status: 'COMPLETE',
      bridgeCalls: 5,
    });
    expect(
      observer
        .snapshot()
        .categories.filter((row) => row.calls > 0)
        .map(({ category, calls }) => ({ category, calls })),
    ).toEqual([
      { category: 'READ', calls: 1 },
      { category: 'MODEL', calls: 2 },
      { category: 'BATCH', calls: 1 },
      { category: 'BARRIER', calls: 1 },
    ]);
    expect(summary(observer)).toMatchObject({
      status: 'OBSERVED',
      calls: 2,
      families: [
        expect.objectContaining({ family: 'ACTOR_READ', calls: 1 }),
        expect.objectContaining({ family: 'AUDIT_CREATE', calls: 1 }),
      ],
    });
  });

  it('separates inclusive MODEL durations from the request union', async () => {
    let now = 0;
    let doneA!: () => void, doneB!: () => void;
    const a = new Promise<void>((resolve) => {
      doneA = resolve;
    });
    const b = new Promise<void>((resolve) => {
      doneB = resolve;
    });
    const db = engine(jest.fn().mockReturnValueOnce(a).mockReturnValueOnce(b));
    const observer = create(db, () => now);
    observer.begin();
    now = 1;
    db.request(model('User'));
    now = 2;
    db.request(model('AuditLog', 'createOne'));
    now = 5;
    doneA();
    await a;
    now = 8;
    doneB();
    await b;
    observer.finish();
    observer.restore();
    expect(observer.snapshot().insideRequestMs).toBe(7);
    expect(summary(observer)).toMatchObject({
      families: [
        expect.objectContaining({ family: 'ACTOR_READ', wallMs: 4, largestMs: 4 }),
        expect.objectContaining({ family: 'AUDIT_CREATE', wallMs: 6, largestMs: 6 }),
      ],
    });
  });

  it('never reads MODEL payloads or rejection getters and preserves original identities', async () => {
    let reads = 0;
    const error = Object.defineProperty(new Error('PRIVATE_REJECTION'), 'code', {
      get() {
        reads++;
        throw new Error('PRIVATE_GETTER');
      },
    });
    const promise = Promise.reject(error);
    const request = Object.defineProperty({ modelName: 'AuditLog', action: 'createOne' }, 'query', {
      get() {
        reads++;
        throw new Error('PRIVATE_QUERY_PARAMETERS');
      },
    });
    const options = { opaque: Symbol('PRIVATE_OPTION') };
    const db = engine(function (this: unknown, ...args) {
      expect(this).toBe(db);
      expect(args[0]).toBe(request);
      expect(args[1]).toBe(options);
      return promise;
    });
    const original = Object.getOwnPropertyDescriptor(db, 'request');
    const observer = create(db);
    observer.begin();
    expect(db.request(request, options)).toBe(promise);
    await expect(promise).rejects.toBe(error);
    observer.finish();
    observer.restore();
    expect(reads).toBe(0);
    expect(Object.getOwnPropertyDescriptor(db, 'request')).toEqual(original);
    expect(summary(observer)).toMatchObject({
      families: [expect.objectContaining({ family: 'AUDIT_CREATE', failed: 1, pending: 0 })],
    });
    expect(JSON.stringify(observer.snapshot())).not.toContain('PRIVATE_');
  });

  it.each(['proxy', 'action-getter', 'model-getter'] as const)(
    'delegates unsafe %s metadata without evaluating it',
    async (kind) => {
      let reads = 0;
      const trap = () => {
        reads++;
        throw new Error('PRIVATE_OPAQUE');
      };
      const request =
        kind === 'proxy'
          ? new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap })
          : Object.defineProperty(
              { modelName: 'User', action: 'findUnique' },
              kind === 'action-getter' ? 'action' : 'modelName',
              { get: trap },
            );
      const promise = Promise.resolve('original');
      const db = engine(() => promise);
      const observer = create(db);
      observer.begin();
      expect(db.request(request)).toBe(promise);
      await promise;
      observer.finish();
      observer.restore();
      expect(reads).toBe(0);
      expect(observer.snapshot().status).toBe('UNKNOWN');
      expect(JSON.stringify(observer.snapshot())).not.toContain('PRIVATE_');
    },
  );

  it('keeps empty observation unknown, bounded and JSON-safe without fabricating zero rows', () => {
    const observer = create(engine());
    observer.begin();
    observer.finish();
    observer.restore();
    expect(summary(observer)).toMatchObject({ status: 'UNKNOWN', calls: 0, families: [] });
    expect(Buffer.byteLength(JSON.stringify(observer.snapshot()))).toBeLessThanOrEqual(4096);
  });

  it('bounds all nine families at the original 400-call cap and marks overflow unknown', async () => {
    let now = 0;
    const requests = [
      model('User'),
      model('Activity'),
      model('Organization'),
      model('RoleBinding'),
      model('ActivityResponsibilityAssignment'),
      model('ActivitySettlementTimeCommandReceipt'),
      model('ActivitySettlementTimeCommandReceipt', 'createOne'),
      model('AuditLog', 'createOne'),
      model('PRIVATE_FALLBACK'),
    ];
    const db = engine();
    const observer = create(db, () => now);
    observer.begin();
    for (let i = 0; i < 400; i++) {
      now += 0.123456789;
      const promise = db.request(requests[i % requests.length]);
      now += 0.987654321;
      await promise;
    }
    expect(summary(observer)).toMatchObject({
      status: 'OBSERVED',
      calls: 400,
      classification: 'PARTIAL',
    });
    expect((summary(observer) as { families: unknown[] }).families).toHaveLength(9);
    expect(Buffer.byteLength(JSON.stringify(observer.snapshot()))).toBeLessThanOrEqual(4096);
    await db.request(model('User'));
    observer.finish();
    observer.restore();
    expect(observer.snapshot().status).toBe('UNKNOWN');
    expect(summary(observer)).toMatchObject({ status: 'UNKNOWN', calls: 400 });
    expect(JSON.stringify(observer.snapshot())).not.toContain('PRIVATE_');
  });

  it('keeps unfinished MODEL work unknown without replacing its promise', async () => {
    let done!: () => void;
    const promise = new Promise<void>((resolve) => {
      done = resolve;
    });
    const db = engine(() => promise);
    const observer = create(db);
    observer.begin();
    expect(db.request(model('User'))).toBe(promise);
    observer.finish();
    observer.restore();
    expect(observer.snapshot().status).toBe('UNKNOWN');
    expect(summary(observer)).toMatchObject({
      status: 'UNKNOWN',
      families: [expect.objectContaining({ pending: 1 })],
    });
    done();
    await promise;
  });

  it('preserves synchronous MODEL failure identity and accounts it once', () => {
    const error = new Error('synthetic identity');
    const db = engine(() => {
      throw error;
    });
    const observer = create(db);
    observer.begin();
    let caught: unknown;
    try {
      db.request(model('AuditLog', 'createOne'));
    } catch (failure) {
      caught = failure;
    }
    observer.finish();
    observer.restore();
    expect(caught).toBe(error);
    expect(summary(observer)).toMatchObject({
      status: 'OBSERVED',
      families: [expect.objectContaining({ failed: 1, pending: 0, calls: 1 })],
    });
  });

  it('rejects an unsupported profile before shadowing the engine', () => {
    const db = engine();
    const original = Object.getOwnPropertyDescriptor(db, 'request');
    const observer = create(db, () => 0, 'PRIVATE_PROFILE');
    expect(Object.getOwnPropertyDescriptor(db, 'request')).toEqual(original);
    expect(observer.snapshot().status).toBe('UNKNOWN');
    expect(JSON.stringify(observer.snapshot())).not.toContain('PRIVATE_');
  });
});
