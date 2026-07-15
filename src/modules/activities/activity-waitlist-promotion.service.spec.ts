import { Role } from '@prisma/client';
import type { AuditLogInput } from '../audit-logs/audit-logs.service';
import { promoteActivityWaitlist } from './activity-waitlist-promotion';

const registeredAt = new Date('2026-07-15T00:00:00.000Z');

function row(id: string, memberId: string, statusCode = 'waitlisted') {
  return {
    id,
    activityId: 'activity-1',
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
        findFirst: jest.fn().mockResolvedValue({ title: '演练', statusCode: 'published' }),
      },
      activityRegistration: {
        findFirst: jest.fn().mockResolvedValueOnce(r1).mockResolvedValueOnce(r2),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.activityRegistration.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ registeredAt: 'asc' }, { id: 'asc' }] }),
    );
    expect(tx.activityRegistration.updateMany).toHaveBeenCalledTimes(2);
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
});
