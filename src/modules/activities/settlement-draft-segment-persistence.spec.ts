import { Prisma } from '@prisma/client';
import { BizException } from '../../common/exceptions/biz.exception';
import { SettlementDraftService } from './settlement-draft.service';
import type { ProjectedSegment } from './settlement-segment-projector';

interface ExistingRow {
  id: string;
  participationIdentityId: string;
  segmentKey: string;
  revision: number;
  statusCode: string;
  sourceCheckInEventId: string;
  sourceCloseEventId: string | null;
  resultCode: string;
  checkInAt: Date;
  checkOutAt: Date | null;
  serviceHours: Prisma.Decimal | null;
  lateFlag: boolean;
  earlyLeaveFlag: boolean;
  exceptionFlagsJson: Prisma.JsonValue | null;
}
interface Stats {
  created: number;
  superseded: number;
  unchanged: number;
  currentCount: number;
}
interface Persistence {
  persistSegments(
    tx: Prisma.TransactionClient,
    identities: string[],
    projections: Map<string, ProjectedSegment[]>,
  ): Promise<Stats>;
}

const START = new Date('2020-03-01T08:00:00.000Z');
const END = new Date('2020-03-01T09:00:00.000Z');

function row(identity: string, key = '0001', patch: Partial<ExistingRow> = {}): ExistingRow {
  return {
    id: `${identity}-${key}-current`,
    participationIdentityId: identity,
    segmentKey: key,
    revision: 1,
    statusCode: 'draft',
    sourceCheckInEventId: `${identity}-${key}-in`,
    sourceCloseEventId: `${identity}-${key}-out`,
    resultCode: 'valid',
    checkInAt: START,
    checkOutAt: END,
    serviceHours: new Prisma.Decimal(1),
    lateFlag: false,
    earlyLeaveFlag: false,
    exceptionFlagsJson: null,
    ...patch,
  };
}

function projection(value: ExistingRow, patch: Partial<ProjectedSegment> = {}): ProjectedSegment {
  return {
    segmentKey: value.segmentKey,
    sourceCheckInEventId: value.sourceCheckInEventId,
    sourceCloseEventId: value.sourceCloseEventId,
    resultCode: 'valid',
    checkInAt: value.checkInAt,
    checkOutAt: value.checkOutAt,
    serviceHours: value.serviceHours === null ? null : Number(value.serviceHours),
    lateFlag: value.lateFlag,
    earlyLeaveFlag: value.earlyLeaveFlag,
    exceptionFlags: [],
    ...patch,
  };
}

function fixture(existing: ExistingRow[]) {
  const calls: { kind: string; input: unknown }[] = [];
  const model = {
    findMany: jest.fn().mockResolvedValue(existing),
    updateMany: jest.fn((input: unknown) => {
      calls.push({ kind: 'supersede', input });
      return Promise.resolve({ count: 1 });
    }),
    createMany: jest.fn((input: unknown) => {
      calls.push({ kind: 'insert', input });
      return Promise.resolve({ count: 1 });
    }),
  };
  // Exercise the real persistence method and segmentMatches, without constructing Nest or a DB.
  const service = Object.create(SettlementDraftService.prototype) as Persistence;
  const tx = { participantServiceSegmentRevision: model } as unknown as Prisma.TransactionClient;
  return {
    model,
    calls,
    run: (identities: string[], projections = new Map<string, ProjectedSegment[]>()) =>
      service.persistSegments(tx, identities, projections),
  };
}

describe('settlement segment persistence semantics', () => {
  it('empty population performs no reads or writes', async () => {
    const f = fixture([]);
    await expect(f.run([])).resolves.toEqual({
      created: 0,
      superseded: 0,
      unchanged: 0,
      currentCount: 0,
    });
    expect(f.model.findMany).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });

  it('unchanged open segment retains all nullable values without a write', async () => {
    const open = row('a', '0001', {
      sourceCloseEventId: null,
      checkOutAt: null,
      serviceHours: null,
      exceptionFlagsJson: null,
    });
    const f = fixture([open]);
    await expect(f.run(['a'], new Map([['a', [projection(open)]]]))).resolves.toEqual({
      created: 0,
      superseded: 0,
      unchanged: 1,
      currentCount: 1,
    });
    expect(f.calls).toEqual([]);
  });

  it('changed segment uses maximum historical revision and current base, superseding first', async () => {
    const current = row('a', '0001', { id: 'current', revision: 2 });
    const historical = row('a', '0001', { id: 'history', revision: 7, statusCode: 'superseded' });
    const f = fixture([historical, current]);
    const next = projection(current, { serviceHours: 2 });
    await expect(f.run(['a'], new Map([['a', [next]]]))).resolves.toEqual({
      created: 1,
      superseded: 1,
      unchanged: 0,
      currentCount: 1,
    });
    expect(f.calls).toEqual([
      {
        kind: 'supersede',
        input: { where: { id: { in: ['current'] } }, data: { statusCode: 'superseded' } },
      },
      {
        kind: 'insert',
        input: {
          data: [
            {
              participationIdentityId: 'a',
              segmentKey: '0001',
              revision: 8,
              sourceCheckInEventId: current.sourceCheckInEventId,
              sourceCloseEventId: current.sourceCloseEventId,
              resultCode: 'valid',
              statusCode: 'draft',
              checkInAt: START,
              checkOutAt: END,
              serviceHours: 2,
              lateFlag: false,
              earlyLeaveFlag: false,
              exceptionFlagsJson: Prisma.DbNull,
              baseRevisionId: 'current',
            },
          ],
        },
      },
    ]);
  });

  it('new nullable segment keeps SQL JSON-null and null base semantics', async () => {
    const f = fixture([]);
    const open = projection(row('a'), {
      sourceCloseEventId: null,
      checkOutAt: null,
      serviceHours: null,
    });
    await expect(f.run(['a'], new Map([['a', [open]]]))).resolves.toEqual({
      created: 1,
      superseded: 0,
      unchanged: 0,
      currentCount: 1,
    });
    expect(f.calls).toEqual([
      {
        kind: 'insert',
        input: {
          data: [
            {
              participationIdentityId: 'a',
              segmentKey: '0001',
              revision: 0,
              sourceCheckInEventId: open.sourceCheckInEventId,
              sourceCloseEventId: null,
              resultCode: 'valid',
              statusCode: 'draft',
              checkInAt: START,
              checkOutAt: null,
              serviceHours: null,
              lateFlag: false,
              earlyLeaveFlag: false,
              exceptionFlagsJson: Prisma.DbNull,
              baseRevisionId: null,
            },
          ],
        },
      },
    ]);
  });

  it('missing projection removes only current rows and ignores superseded history', async () => {
    const a = row('a');
    const b = row('b');
    const f = fixture([a, row('a', '0002', { statusCode: 'superseded' }), b]);
    await expect(f.run(['a', 'b'], new Map([['b', [projection(b)]]]))).resolves.toEqual({
      created: 0,
      superseded: 1,
      unchanged: 1,
      currentCount: 1,
    });
    expect(f.calls).toEqual([
      {
        kind: 'supersede',
        input: {
          where: { id: { in: [a.id] } },
          data: { statusCode: 'superseded' },
        },
      },
    ]);
  });

  it('same segment key on another identity never becomes its current match', async () => {
    const a = row('a');
    const b = row('ab');
    const f = fixture([b, a]);
    await expect(f.run(['a', 'ab'], new Map([['a', [projection(a)]]]))).resolves.toEqual({
      created: 0,
      superseded: 1,
      unchanged: 1,
      currentCount: 1,
    });
    expect(f.calls).toEqual([
      {
        kind: 'supersede',
        input: {
          where: { id: { in: [b.id] } },
          data: { statusCode: 'superseded' },
        },
      },
    ]);
  });

  it('final-map overwrite, insertion order and repeated identity inputs remain observable', async () => {
    const b1 = row('b');
    const b2 = row('b', '0002');
    const a1 = row('a', '0001', { id: 'first-a', revision: 1 });
    const a2 = row('a', '0002');
    const winner = row('a', '0001', { id: 'last-a', revision: 3 });
    const f = fixture([b1, b2, a1, a2, winner]);
    await expect(
      f.run(['a', 'b', 'a'], new Map([['a', [projection(winner, { serviceHours: 2 })]]])),
    ).resolves.toEqual({
      created: 2,
      superseded: 6,
      unchanged: 0,
      currentCount: 2,
    });
    expect(f.model.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['last-a', a2.id, b1.id, b2.id, 'last-a', a2.id] } },
      data: { statusCode: 'superseded' },
    });
    const data = f.model.createMany.mock.calls[0][0] as {
      data: { revision: number; baseRevisionId: string }[];
    };
    expect(data.data.map(({ revision, baseRevisionId }) => ({ revision, baseRevisionId }))).toEqual(
      [
        { revision: 4, baseRevisionId: 'last-a' },
        { revision: 4, baseRevisionId: 'last-a' },
      ],
    );
    expect(f.calls.map((call) => call.kind)).toEqual(['supersede', 'insert']);
  });

  it('colon-prefix identities retain the original predicate and order', async () => {
    const parent = row('a');
    const nested = row('a:b');
    const empty = row('');
    const f = fixture([nested, parent, empty]);
    await expect(f.run(['a', 'a:b', ''])).resolves.toEqual({
      created: 0,
      superseded: 4,
      unchanged: 0,
      currentCount: 0,
    });
    expect(f.model.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [nested.id, parent.id, nested.id, empty.id] } },
      data: { statusCode: 'superseded' },
    });
  });

  it('composite-key collision still uses the final map value for every matching prefix', async () => {
    const overwritten = row('a:0001', 'x', { id: 'overwritten' });
    const winner = row('a', '0001:x', { id: 'winner' });
    const f = fixture([overwritten, winner]);
    await expect(f.run(['a', 'a:0001'])).resolves.toEqual({
      created: 0,
      superseded: 2,
      unchanged: 0,
      currentCount: 0,
    });
    expect(f.model.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['winner', 'winner'] } },
      data: { statusCode: 'superseded' },
    });
  });

  it('canonical exception flags do not mutate projection input', async () => {
    const current = row('a', '0001', { exceptionFlagsJson: { flags: ['a', 'z'] } });
    const next = projection(current, { exceptionFlags: ['z', 'a'] });
    const f = fixture([current]);
    await expect(f.run(['a'], new Map([['a', [next]]]))).resolves.toEqual({
      created: 0,
      superseded: 0,
      unchanged: 1,
      currentCount: 1,
    });
    expect(next.exceptionFlags).toEqual(['z', 'a']);
    expect(f.calls).toEqual([]);
  });

  it('committed history refuses before any mutation', async () => {
    const f = fixture([row('a', '0001', { statusCode: 'committed' })]);
    await expect(f.run(['a'])).rejects.toBeInstanceOf(BizException);
    expect(f.calls).toEqual([]);
  });
});

describe('settlement segment persistence operation bound', () => {
  it.each([2, 20, 200])(
    '%i identities visit current rows a bounded number of times',
    async (count) => {
      const identities = Array.from({ length: count }, (_, index) => `identity-${index}`);
      const rows = identities.flatMap((id) =>
        Array.from({ length: 5 }, (_, index) => row(id, String(index))),
      );
      const projections = new Map(
        identities.map((id, index) => [
          id,
          rows.slice(index * 5, index * 5 + 5).map((value) => projection(value)),
        ]),
      );
      const f = fixture(rows);
      const targets = new Set<unknown>(rows);
      const descriptor = Object.getOwnPropertyDescriptor(Map.prototype, Symbol.iterator)!;
      const original = Map.prototype[Symbol.iterator];
      let visits = 0;
      Object.defineProperty(Map.prototype, Symbol.iterator, {
        ...descriptor,
        value: function (this: Map<unknown, unknown>) {
          const iterator = original.call(this);
          return {
            next() {
              const next = iterator.next();
              if (!next.done && targets.has(next.value[1])) visits++;
              return next;
            },
            [Symbol.iterator](this: IterableIterator<[unknown, unknown]>) {
              return this;
            },
          };
        },
      });
      let result: Stats;
      try {
        result = await f.run(identities, projections);
      } finally {
        Object.defineProperty(Map.prototype, Symbol.iterator, descriptor);
      }
      console.info(
        'segment persistence operations',
        JSON.stringify({ identities: count, currentRows: rows.length, visits }),
      );
      expect(result).toEqual({
        created: 0,
        superseded: 0,
        unchanged: rows.length,
        currentCount: rows.length,
      });
      expect(f.calls).toEqual([]);
      expect(visits).toBeGreaterThanOrEqual(rows.length);
      expect(visits).toBeLessThanOrEqual(rows.length * 2);
    },
  );
});
