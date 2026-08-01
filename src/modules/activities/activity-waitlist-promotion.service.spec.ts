import { Role } from '@prisma/client';
import type { AuditLogInput } from '../audit-logs/audit-logs.service';
import {
  promoteActivityWaitlist,
  promoteActivityWaitlistWithinCapacity,
  promoteActivityWaitlistsWithinSharedCapacity,
} from './activity-waitlist-promotion';

const registeredAt = new Date('2026-07-15T00:00:00.000Z');

function row(
  id: string,
  memberId: string,
  statusCode = 'waitlisted',
  activityPositionId: string | null = null,
) {
  return {
    id,
    activityId: 'activity-1',
    activityPositionId,
    memberId,
    statusCode,
    registeredAt,
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    extras: null,
    cancelledByUserId: null,
    cancelledAt: null,
    cancelReason: null,
  };
}

describe('promoteActivityWaitlist', () => {
  it('锁 Activity 后按 FIFO 逐行 CAS，waitlisted→pending 并逐条写 promote audit', async () => {
    const r1 = row('r1', 'm1');
    const r2 = row('r2', 'm2');
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'activity-1' }]),
      activity: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ title: '演练', statusCode: 'published', capacity: 2 }),
      },
      member: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({ id: 'm1', status: 'ACTIVE' })
          .mockResolvedValueOnce({ id: 'm2', status: 'ACTIVE' }),
      },
      activityRegistration: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(r1)
          .mockResolvedValueOnce(r1)
          .mockResolvedValueOnce(r2)
          .mockResolvedValueOnce(r2),
        update: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => {
          const before = where.id === r1.id ? r1 : r2;
          return Promise.resolve({ ...before, statusCode: 'pending' });
        }),
      },
    };
    const auditLogs = {
      log: jest.fn<Promise<void>, [AuditLogInput]>().mockResolvedValue(undefined),
    };

    const result = await promoteActivityWaitlist({
      activityId: 'activity-1',
      maxPromotions: 2,
      actorUserId: 'user-1',
      actorRoleSnap: Role.ADMIN,
      auditMeta: { requestId: 'req-1', ip: '127.0.0.1', ua: 'jest' },
      tx: tx as never,
      auditLogs,
    });

    expect(tx.$queryRaw).toHaveBeenCalledTimes(5);
    expect(tx.activityRegistration.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ registeredAt: 'asc' }, { id: 'asc' }] }),
    );
    expect(tx.activityRegistration.findFirst).toHaveBeenCalledTimes(4);
    expect(result).toEqual({
      activityTitle: '演练',
      promoted: [
        { registrationId: 'r1', memberId: 'm1' },
        { registrationId: 'r2', memberId: 'm2' },
      ],
    });
    expect(auditLogs.log).toHaveBeenCalledTimes(2);
    const firstAudit = auditLogs.log.mock.calls[0][0];
    expect(firstAudit.event).toBe('registration.review');
    expect(firstAudit.resourceId).toBe('r1');
    expect(firstAudit.before).toMatchObject({ statusCode: 'waitlisted' });
    expect(firstAudit.after).toMatchObject({ statusCode: 'pending' });
    expect(firstAudit.extra).toEqual({
      operation: 'review',
      action: 'promote',
      priorStatusCode: 'waitlisted',
      nextStatusCode: 'pending',
      activityId: 'activity-1',
      targetMemberId: 'm1',
    });
  });

  it('活动已取消时不递补', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'activity-1' }]),
      activity: {
        findFirst: jest.fn().mockResolvedValue({ title: '演练', statusCode: 'cancelled' }),
      },
      activityRegistration: { findFirst: jest.fn() },
    };
    const auditLogs = { log: jest.fn<Promise<void>, [AuditLogInput]>() };

    await expect(
      promoteActivityWaitlist({
        activityId: 'activity-1',
        maxPromotions: null,
        actorUserId: 'user-1',
        actorRoleSnap: Role.ADMIN,
        auditMeta: { requestId: 'req-1', ip: '127.0.0.1', ua: 'jest' },
        tx: tx as never,
        auditLogs,
      }),
    ).resolves.toEqual({ activityTitle: '演练', promoted: [] });
    expect(tx.activityRegistration.findFirst).not.toHaveBeenCalled();
    expect(auditLogs.log).not.toHaveBeenCalled();
  });

  it('单队列跳过 inactive FIFO 队首，并递补下一名 ACTIVE Member', async () => {
    const inactive = row('r-inactive', 'm-inactive');
    const active = row('r-active', 'm-active');
    const findFirst = jest
      .fn<
        Promise<ReturnType<typeof row> | null>,
        [{ where: Record<string, unknown>; select?: unknown; orderBy?: unknown }]
      >()
      .mockResolvedValueOnce(inactive)
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(active);
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'locked' }]),
      activity: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ title: '演练', statusCode: 'published', capacity: 1 }),
      },
      member: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({ id: inactive.memberId, status: 'INACTIVE' })
          .mockResolvedValueOnce({ id: active.memberId, status: 'ACTIVE' }),
      },
      activityRegistration: {
        findFirst,
        update: jest.fn().mockResolvedValue({ ...active, statusCode: 'pending' }),
      },
    };
    const auditLogs = {
      log: jest.fn<Promise<void>, [AuditLogInput]>().mockResolvedValue(undefined),
    };

    await expect(
      promoteActivityWaitlist({
        activityId: 'activity-1',
        maxPromotions: 1,
        actorUserId: 'user-1',
        actorRoleSnap: Role.ADMIN,
        auditMeta: { requestId: 'req-1', ip: '127.0.0.1', ua: 'jest' },
        tx: tx as never,
        auditLogs,
      }),
    ).resolves.toEqual({
      activityTitle: '演练',
      promoted: [{ registrationId: active.id, memberId: active.memberId }],
    });

    expect(findFirst.mock.calls[1][0].where).toMatchObject({
      id: { notIn: [inactive.id] },
    });
    expect(tx.activityRegistration.update).toHaveBeenCalledTimes(1);
    expect(auditLogs.log).toHaveBeenCalledTimes(1);
    expect(auditLogs.log.mock.calls[0][0].resourceId).toBe(active.id);
  });

  // B-D2 翻面用例（原断言「同岗无候补 → 跨岗 fallback 递补 B」，2026-08-01 拍板后必须相反）：
  // A 岗队列空就空着，B 岗候补一个都不许被带走，且查询里不得再出现跨岗位 OR 分支。
  it('本岗无候补时不跨岗取人：B 岗候补保持不动，查询不含跨岗位 OR', async () => {
    const findFirst = jest
      .fn<Promise<ReturnType<typeof row> | null>, [{ where: Record<string, unknown> }]>()
      .mockResolvedValue(null);
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'activity-1' }]),
      activity: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ title: '演练', statusCode: 'published', capacity: 2 }),
      },
      activityPosition: {
        findFirst: jest.fn().mockResolvedValue({ capacity: 1 }),
      },
      member: {
        findFirst: jest.fn().mockResolvedValue({ id: 'm-b', status: 'ACTIVE' }),
      },
      activityRegistration: {
        count: jest.fn().mockResolvedValue(0),
        findFirst,
        update: jest.fn(),
      },
    };
    const auditLogs = {
      log: jest.fn<Promise<void>, [AuditLogInput]>().mockResolvedValue(undefined),
    };

    await expect(
      promoteActivityWaitlistWithinCapacity({
        activityId: 'activity-1',
        activityPositionId: 'position-a',
        maxPromotions: 1,
        actorUserId: 'user-1',
        actorRoleSnap: Role.ADMIN,
        auditMeta: { requestId: 'req-1', ip: '127.0.0.1', ua: 'jest' },
        tx: tx as never,
        auditLogs,
      }),
    ).resolves.toEqual({ activityTitle: '演练', promoted: [] });

    expect(tx.activityRegistration.update).not.toHaveBeenCalled();
    expect(auditLogs.log).not.toHaveBeenCalled();
    for (const call of findFirst.mock.calls) {
      expect(call[0].where).toMatchObject({ activityPositionId: 'position-a' });
      expect(call[0].where).not.toHaveProperty('OR');
    }
  });

  it('本岗递补受「父活动剩余量 ∩ 本岗剩余量」裁剪：岗位已满则一个都不递补', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'activity-1' }]),
      activity: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ title: '演练', statusCode: 'published', capacity: 99 }),
      },
      activityPosition: {
        findFirst: jest.fn().mockResolvedValue({ capacity: 1 }),
      },
      member: { findFirst: jest.fn() },
      activityRegistration: {
        // 全活动 pass=1，本岗 pass=1 → 本岗 headroom 0，父活动仍有余量也不许递补。
        count: jest.fn().mockResolvedValue(1),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
    };
    const auditLogs = {
      log: jest.fn<Promise<void>, [AuditLogInput]>().mockResolvedValue(undefined),
    };

    await expect(
      promoteActivityWaitlistWithinCapacity({
        activityId: 'activity-1',
        activityPositionId: 'position-full',
        maxPromotions: null,
        actorUserId: 'user-1',
        actorRoleSnap: Role.ADMIN,
        auditMeta: { requestId: 'req-1', ip: '127.0.0.1', ua: 'jest' },
        tx: tx as never,
        auditLogs,
      }),
    ).resolves.toEqual({ activityTitle: '演练', promoted: [] });
    expect(tx.activityRegistration.findFirst).not.toHaveBeenCalled();
    expect(tx.activityRegistration.update).not.toHaveBeenCalled();
  });

  it('岗位已在本事务内被软删：不递补任何队列', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'activity-1' }]),
      activity: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ title: '演练', statusCode: 'published', capacity: null }),
      },
      activityPosition: { findFirst: jest.fn().mockResolvedValue(null) },
      member: { findFirst: jest.fn() },
      activityRegistration: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
    };
    const auditLogs = {
      log: jest.fn<Promise<void>, [AuditLogInput]>().mockResolvedValue(undefined),
    };

    await expect(
      promoteActivityWaitlistWithinCapacity({
        activityId: 'activity-1',
        activityPositionId: 'position-gone',
        maxPromotions: null,
        actorUserId: 'user-1',
        actorRoleSnap: Role.ADMIN,
        auditMeta: { requestId: 'req-1', ip: '127.0.0.1', ua: 'jest' },
        tx: tx as never,
        auditLogs,
      }),
    ).resolves.toEqual({ activityTitle: '演练', promoted: [] });
    expect(tx.activityRegistration.findFirst).not.toHaveBeenCalled();
  });

  // 历史无岗位队列（activityPositionId=null）：报名在先、建岗位在后即可达，只受父容量约束。
  it('历史无岗位队列只受父容量约束，跳过 deleted 队首后递补下一名 ACTIVE Member', async () => {
    const deleted = row('r-deleted', 'm-deleted');
    const active = row('r-active', 'm-active');
    const findFirst = jest
      .fn<
        Promise<ReturnType<typeof row> | null>,
        [{ where: Record<string, unknown>; select?: unknown; orderBy?: unknown }]
      >()
      .mockResolvedValueOnce(deleted)
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(active);
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'locked' }]),
      activity: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ title: '演练', statusCode: 'published', capacity: 3 }),
      },
      activityPosition: { findFirst: jest.fn() },
      member: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: active.memberId, status: 'ACTIVE' }),
      },
      activityRegistration: {
        count: jest.fn().mockResolvedValue(1),
        findFirst,
        update: jest.fn().mockResolvedValue({ ...active, statusCode: 'pending' }),
      },
    };
    const auditLogs = {
      log: jest.fn<Promise<void>, [AuditLogInput]>().mockResolvedValue(undefined),
    };

    await expect(
      promoteActivityWaitlistWithinCapacity({
        activityId: 'activity-1',
        activityPositionId: null,
        maxPromotions: 1,
        actorUserId: 'user-1',
        actorRoleSnap: Role.ADMIN,
        auditMeta: { requestId: 'req-1', ip: '127.0.0.1', ua: 'jest' },
        tx: tx as never,
        auditLogs,
      }),
    ).resolves.toEqual({
      activityTitle: '演练',
      promoted: [{ registrationId: active.id, memberId: active.memberId }],
    });

    // 无岗位队列不去查 ActivityPosition（它没有 child cap）。
    expect(tx.activityPosition.findFirst).not.toHaveBeenCalled();
    expect(findFirst.mock.calls[1][0].where).toMatchObject({
      id: { notIn: [deleted.id] },
      activityPositionId: null,
    });
    expect(tx.activityRegistration.update).toHaveBeenCalledTimes(1);
    expect(auditLogs.log).toHaveBeenCalledTimes(1);
  });
});

// ── 多队列共享父预算(2026-08-01 整批评审 P1)────────────────────────────────
//
// 修复前:proposal applier 逐岗调 `promoteActivityWaitlistWithinCapacity`,每一岗都把
// **同一份**父剩余量重新算一遍并完整领走(递补写 pending 不写 pass,父 pass 基线在批次内
// 不动),于是合计递补数突破活动容量。下面第一条用例就是那条 red-first。
describe('promoteActivityWaitlistsWithinSharedCapacity', () => {
  /** 被测代码实际发出的 where 形状(取队首 / 锁后重读 / 计数三种共用)。 */
  interface RegistrationWhere {
    id?: string | { notIn: string[] };
    activityPositionId?: string | null;
  }

  /**
   * 用一份内存队列模拟本活动的候补行,让批量入口真的跑完整个出队循环。
   * `promote` 写的是 `pending`(不是 `pass`)—— 与生产一致,这正是父预算不能靠重读 pass 数的原因。
   */
  function makeTx(options: {
    activityCapacity: number | null;
    positionCapacities: Record<string, number | null>;
    /** 队列 key:岗位 id,或 'null' 表示历史无岗位队列 */
    waitlists: Record<string, ReadonlyArray<{ id: string; memberId: string }>>;
    passTotal?: number;
    passByQueue?: Record<string, number>;
    inactiveMemberIds?: ReadonlyArray<string>;
  }) {
    const rows = new Map<string, ReturnType<typeof row>>();
    for (const [queueKey, entries] of Object.entries(options.waitlists)) {
      for (const entry of entries) {
        const positionId = queueKey === 'null' ? null : queueKey;
        rows.set(entry.id, row(entry.id, entry.memberId, 'waitlisted', positionId));
      }
    }
    const inactive = new Set(options.inactiveMemberIds ?? []);
    /** 队列 key:`null` 队列统一记成字符串 'null'。 */
    const keyOf = (activityPositionId: string | null | undefined): string =>
      activityPositionId == null ? 'null' : activityPositionId;

    const findFirst = jest.fn(({ where }: { where: RegistrationWhere }): Promise<unknown> => {
      // 锁后重读:where 只带 id 字符串。
      if (typeof where.id === 'string') return Promise.resolve(rows.get(where.id) ?? null);
      const queueKey = keyOf(where.activityPositionId);
      const excluded = new Set(
        typeof where.id === 'object' && where.id !== null ? where.id.notIn : [],
      );
      const hit = (options.waitlists[queueKey] ?? []).find(
        (entry) => !excluded.has(entry.id) && rows.get(entry.id)?.statusCode === 'waitlisted',
      );
      return Promise.resolve(hit ? rows.get(hit.id) : null);
    });

    return {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'activity-1' }]),
      activity: {
        findFirst: jest.fn().mockResolvedValue({
          title: '演练',
          statusCode: 'published',
          capacity: options.activityCapacity,
        }),
      },
      activityPosition: {
        findFirst: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve(
            where.id in options.positionCapacities
              ? { capacity: options.positionCapacities[where.id] }
              : null,
          ),
        ),
      },
      member: {
        findFirst: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve(
            inactive.has(where.id)
              ? { id: where.id, status: 'INACTIVE' }
              : { id: where.id, status: 'ACTIVE' },
          ),
        ),
      },
      activityRegistration: {
        count: jest.fn(({ where }: { where: RegistrationWhere }) => {
          if (!('activityPositionId' in where)) return Promise.resolve(options.passTotal ?? 0);
          return Promise.resolve(options.passByQueue?.[keyOf(where.activityPositionId)] ?? 0);
        }),
        findFirst,
        update: jest.fn(({ where }: { where: { id: string } }) => {
          const before = rows.get(where.id);
          if (!before) throw new Error(`unexpected update on ${where.id}`);
          const after = { ...before, statusCode: 'pending' };
          rows.set(where.id, after);
          return Promise.resolve(after);
        }),
      },
    };
  }

  const BASE = {
    activityId: 'activity-1',
    actorUserId: 'user-1',
    actorRoleSnap: Role.ADMIN,
    auditMeta: { requestId: 'req-1', ip: '127.0.0.1', ua: 'jest' },
  } as const;

  it('岗位 headroom 之和 > 父 headroom：合计递补数被父剩余量钳住(修复前每岗各领一份父预算)', async () => {
    // 父容量 5、已 pass 3 ⇒ 父剩余 2。两岗各自剩余 2 ⇒ 各岗单看都能递补 2,合计 4 > 2。
    const tx = makeTx({
      activityCapacity: 5,
      positionCapacities: { 'position-a': 2, 'position-b': 2 },
      passTotal: 3,
      passByQueue: { 'position-a': 0, 'position-b': 0 },
      waitlists: {
        'position-a': [
          { id: 'a1', memberId: 'm-a1' },
          { id: 'a2', memberId: 'm-a2' },
        ],
        'position-b': [
          { id: 'b1', memberId: 'm-b1' },
          { id: 'b2', memberId: 'm-b2' },
        ],
      },
    });
    const auditLogs = {
      log: jest.fn<Promise<void>, [AuditLogInput]>().mockResolvedValue(undefined),
    };

    const result = await promoteActivityWaitlistsWithinSharedCapacity({
      ...BASE,
      orderedPositionIds: ['position-a', 'position-b'],
      tx: tx as never,
      auditLogs,
    });

    // 父剩余 2 ⇒ 恰好 2 人;FIFO 先吃满 A 岗,B 岗一个都拿不到。
    expect(result.promoted).toEqual([
      { registrationId: 'a1', memberId: 'm-a1' },
      { registrationId: 'a2', memberId: 'm-a2' },
    ]);
    expect(auditLogs.log).toHaveBeenCalledTimes(2);
    // 岗位隔离:B 岗候补仍是 waitlisted,没有被 A 岗的事件顺手带走,也没有越过父预算。
    expect(tx.activityRegistration.update).toHaveBeenCalledTimes(2);
  });

  it('预算按**实际 promoted 数**扣减：前一岗没用完的份额留给下一岗', async () => {
    // 父剩余 2。A 岗只有 1 名候补 ⇒ 用掉 1,剩下的 1 必须能落到 B 岗。
    const tx = makeTx({
      activityCapacity: 2,
      positionCapacities: { 'position-a': 9, 'position-b': 9 },
      waitlists: {
        'position-a': [{ id: 'a1', memberId: 'm-a1' }],
        'position-b': [
          { id: 'b1', memberId: 'm-b1' },
          { id: 'b2', memberId: 'm-b2' },
        ],
      },
    });
    const auditLogs = {
      log: jest.fn<Promise<void>, [AuditLogInput]>().mockResolvedValue(undefined),
    };

    const result = await promoteActivityWaitlistsWithinSharedCapacity({
      ...BASE,
      orderedPositionIds: ['position-a', 'position-b'],
      tx: tx as never,
      auditLogs,
    });

    expect(result.promoted).toEqual([
      { registrationId: 'a1', memberId: 'm-a1' },
      { registrationId: 'b1', memberId: 'm-b1' },
    ]);
  });

  it('被跳过的非 ACTIVE 候选人不消耗预算：额度留给同队列下一名与后续队列', async () => {
    // 父剩余 1;A 岗队首 member 非 ACTIVE ⇒ 跳过后继续吃同队列下一名,预算只扣 1。
    const tx = makeTx({
      activityCapacity: 1,
      positionCapacities: { 'position-a': 9, 'position-b': 9 },
      waitlists: {
        'position-a': [
          { id: 'a1', memberId: 'm-inactive' },
          { id: 'a2', memberId: 'm-a2' },
        ],
        'position-b': [{ id: 'b1', memberId: 'm-b1' }],
      },
      inactiveMemberIds: ['m-inactive'],
    });
    const auditLogs = {
      log: jest.fn<Promise<void>, [AuditLogInput]>().mockResolvedValue(undefined),
    };

    const result = await promoteActivityWaitlistsWithinSharedCapacity({
      ...BASE,
      orderedPositionIds: ['position-a', 'position-b'],
      tx: tx as never,
      auditLogs,
    });

    expect(result.promoted).toEqual([{ registrationId: 'a2', memberId: 'm-a2' }]);
  });

  it('父容量不限(null)时各岗只受本岗 cap 约束', async () => {
    const tx = makeTx({
      activityCapacity: null,
      positionCapacities: { 'position-a': 1, 'position-b': 1 },
      waitlists: {
        'position-a': [
          { id: 'a1', memberId: 'm-a1' },
          { id: 'a2', memberId: 'm-a2' },
        ],
        'position-b': [{ id: 'b1', memberId: 'm-b1' }],
      },
    });
    const auditLogs = {
      log: jest.fn<Promise<void>, [AuditLogInput]>().mockResolvedValue(undefined),
    };

    const result = await promoteActivityWaitlistsWithinSharedCapacity({
      ...BASE,
      orderedPositionIds: ['position-a', 'position-b'],
      tx: tx as never,
      auditLogs,
    });

    expect(result.promoted).toEqual([
      { registrationId: 'a1', memberId: 'm-a1' },
      { registrationId: 'b1', memberId: 'm-b1' },
    ]);
  });

  it('父预算用尽后不再触碰后续队列(连岗位行都不去查)', async () => {
    const tx = makeTx({
      activityCapacity: 1,
      positionCapacities: { 'position-a': 9, 'position-b': 9 },
      waitlists: {
        'position-a': [{ id: 'a1', memberId: 'm-a1' }],
        'position-b': [{ id: 'b1', memberId: 'm-b1' }],
      },
    });
    const auditLogs = {
      log: jest.fn<Promise<void>, [AuditLogInput]>().mockResolvedValue(undefined),
    };

    await promoteActivityWaitlistsWithinSharedCapacity({
      ...BASE,
      orderedPositionIds: ['position-a', 'position-b'],
      tx: tx as never,
      auditLogs,
    });

    expect(tx.activityPosition.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.activityPosition.findFirst.mock.calls[0][0].where.id).toBe('position-a');
  });

  it('重复列出同一队列只分一份预算(去重且保序)', async () => {
    const tx = makeTx({
      activityCapacity: 9,
      positionCapacities: { 'position-a': 1 },
      waitlists: {
        'position-a': [
          { id: 'a1', memberId: 'm-a1' },
          { id: 'a2', memberId: 'm-a2' },
        ],
      },
    });
    const auditLogs = {
      log: jest.fn<Promise<void>, [AuditLogInput]>().mockResolvedValue(undefined),
    };

    const result = await promoteActivityWaitlistsWithinSharedCapacity({
      ...BASE,
      orderedPositionIds: ['position-a', 'position-a'],
      tx: tx as never,
      auditLogs,
    });

    expect(result.promoted).toEqual([{ registrationId: 'a1', memberId: 'm-a1' }]);
    expect(tx.activityPosition.findFirst).toHaveBeenCalledTimes(1);
  });

  it('历史无岗位队列(null)在批量入口里同样只受父容量约束', async () => {
    const tx = makeTx({
      activityCapacity: 1,
      positionCapacities: {},
      waitlists: {
        null: [
          { id: 'n1', memberId: 'm-n1' },
          { id: 'n2', memberId: 'm-n2' },
        ],
      },
    });
    const auditLogs = {
      log: jest.fn<Promise<void>, [AuditLogInput]>().mockResolvedValue(undefined),
    };

    const result = await promoteActivityWaitlistsWithinSharedCapacity({
      ...BASE,
      orderedPositionIds: [null],
      tx: tx as never,
      auditLogs,
    });

    expect(result.promoted).toEqual([{ registrationId: 'n1', memberId: 'm-n1' }]);
    expect(tx.activityPosition.findFirst).not.toHaveBeenCalled();
  });

  it('活动非 published：一个队列都不动', async () => {
    const tx = makeTx({
      activityCapacity: null,
      positionCapacities: { 'position-a': null },
      waitlists: { 'position-a': [{ id: 'a1', memberId: 'm-a1' }] },
    });
    tx.activity.findFirst.mockResolvedValue({
      title: '演练',
      statusCode: 'cancelled',
      capacity: null,
    });
    const auditLogs = {
      log: jest.fn<Promise<void>, [AuditLogInput]>().mockResolvedValue(undefined),
    };

    await expect(
      promoteActivityWaitlistsWithinSharedCapacity({
        ...BASE,
        orderedPositionIds: ['position-a'],
        tx: tx as never,
        auditLogs,
      }),
    ).resolves.toEqual({ activityTitle: '演练', promoted: [] });
    expect(tx.activityRegistration.count).not.toHaveBeenCalled();
  });

  it('队列在本事务内被软删：跳过它,不占用任何预算', async () => {
    const tx = makeTx({
      activityCapacity: 1,
      positionCapacities: { 'position-b': 9 },
      waitlists: { 'position-b': [{ id: 'b1', memberId: 'm-b1' }] },
    });
    const auditLogs = {
      log: jest.fn<Promise<void>, [AuditLogInput]>().mockResolvedValue(undefined),
    };

    const result = await promoteActivityWaitlistsWithinSharedCapacity({
      ...BASE,
      orderedPositionIds: ['position-gone', 'position-b'],
      tx: tx as never,
      auditLogs,
    });

    expect(result.promoted).toEqual([{ registrationId: 'b1', memberId: 'm-b1' }]);
  });
});
