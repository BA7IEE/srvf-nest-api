import type { PrismaService } from '../../database/prisma.service';
import { BirthdayGreetingService } from './birthday-greeting.service';
import type { NotificationOutboxService } from './notification-outbox.service';

type CandidateRow = {
  birthDate: Date;
  member: {
    id: string;
    users: Array<{ phone: string | null; status: 'ACTIVE' | 'DISABLED' }>;
  };
};

const NOW = new Date('2026-06-11T04:00:00.000Z');

function bd(month: number, day: number, year = 1990): Date {
  return new Date(Date.UTC(year, month - 1, day, 4, 0, 0));
}

function candidate(
  id: string,
  month: number,
  day: number,
  phone: string | null,
  status: 'ACTIVE' | 'DISABLED' = 'ACTIVE',
): CandidateRow {
  return {
    birthDate: bd(month, day, month === 2 && day === 29 ? 2000 : 1990),
    member: { id, users: phone === null ? [] : [{ phone, status }] },
  };
}

describe('BirthdayGreetingService.runOnce · durable enqueue', () => {
  let rows: CandidateRow[];
  let existingKeys: Set<string>;
  const findMany = jest.fn(() => Promise.resolve(rows));
  const findByEventKey = jest.fn((key: string) =>
    Promise.resolve(existingKeys.has(key) ? { id: key } : null),
  );
  const enqueue = jest.fn((input: { eventKey: string }) => {
    existingKeys.add(input.eventKey);
    return Promise.resolve({ id: input.eventKey });
  });

  const prisma = { memberProfile: { findMany } } as unknown as PrismaService;
  const outbox = { findByEventKey, enqueue } as unknown as NotificationOutboxService;
  let service: BirthdayGreetingService;

  beforeEach(() => {
    rows = [];
    existingKeys = new Set();
    jest.clearAllMocks();
    service = new BirthdayGreetingService(prisma, outbox);
  });

  it('只选当日活跃且有 live phone 的队员；payload/eventKey 只存 member 引用，不存 phone', async () => {
    rows = [
      candidate('member-hit', 6, 11, '13900000001'),
      candidate('member-wrong-day', 6, 12, '13900000002'),
      candidate('member-no-phone', 6, 11, null),
      candidate('member-disabled', 6, 11, '13900000003', 'DISABLED'),
    ];

    await expect(service.runOnce(NOW)).resolves.toEqual({
      selected: 1,
      enqueued: 1,
      skippedIdempotent: 0,
      failed: 0,
    });
    expect(enqueue).toHaveBeenCalledWith({
      eventKey: 'birthday-sms:2026-06-11:member-hit',
      eventType: 'notification.birthday-sms',
      payloadVersion: 1,
      payload: { memberId: 'member-hit', dateKey: '2026-06-11' },
      aggregateType: 'member',
      aggregateId: 'member-hit',
      destinationType: 'member',
      destinationRef: 'member-hit',
    });
    expect(JSON.stringify(enqueue.mock.calls)).not.toContain('13900000001');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deletedAt: null, member: { status: 'ACTIVE', deletedAt: null } },
      }),
    );
  });

  it('同一天同 member eventKey 幂等，二跑不新增 intent', async () => {
    rows = [candidate('member-hit', 6, 11, '13900000001')];
    expect((await service.runOnce(NOW)).enqueued).toBe(1);
    expect(await service.runOnce(NOW)).toMatchObject({
      selected: 1,
      enqueued: 0,
      skippedIdempotent: 1,
    });
    expect(enqueue).toHaveBeenCalledTimes(2); // enqueue 自身仍以 DB unique 做最终并发幂等
  });

  it('2/29 不顺延，UTC+8 日界决定 dateKey', async () => {
    rows = [candidate('leap', 2, 29, '13900000007')];
    expect((await service.runOnce(new Date('2026-02-28T04:00:00.000Z'))).selected).toBe(0);
    expect((await service.runOnce(new Date('2026-03-01T04:00:00.000Z'))).selected).toBe(0);
    expect((await service.runOnce(new Date('2028-02-29T04:00:00.000Z'))).enqueued).toBe(1);

    rows = [candidate('next-day', 6, 12, '13900000008')];
    await service.runOnce(new Date('2026-06-11T23:00:00.000Z'));
    expect(enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ eventKey: 'birthday-sms:2026-06-12:next-day' }),
    );
  });

  it('单个 enqueue 失败只增加 failed，不阻断后续队员', async () => {
    rows = [
      candidate('member-fail', 6, 11, '13900000001'),
      candidate('member-ok', 6, 11, '13900000002'),
    ];
    enqueue
      .mockRejectedValueOnce(new Error('db unavailable'))
      .mockResolvedValueOnce({ id: 'intent-ok' });
    await expect(service.runOnce(NOW)).resolves.toEqual({
      selected: 2,
      enqueued: 1,
      skippedIdempotent: 0,
      failed: 1,
    });
  });
});
