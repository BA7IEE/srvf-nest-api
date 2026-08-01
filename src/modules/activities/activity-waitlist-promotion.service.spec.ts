import { Role } from '@prisma/client';
import type { AuditLogInput } from '../audit-logs/audit-logs.service';
import {
  promoteActivityWaitlist,
  promoteActivityWaitlistWithinCapacity,
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
