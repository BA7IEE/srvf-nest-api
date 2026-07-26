import type { Prisma } from '@prisma/client';

import type { NotificationOutboxService } from '../notifications/notification-outbox.service';
import { AttendanceNotificationProducer } from './attendance-notification-producer';

function makeOutboxMock() {
  return {
    enqueue: jest.fn().mockResolvedValue({ id: 'intent-1' }),
  };
}

function makeTxMock() {
  return {
    activity: {
      findUnique: jest.fn().mockResolvedValue({ title: '山地救援' }),
    },
    activityResponsibilityAssignment: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    teamJoinApplication: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
}

describe('AttendanceNotificationProducer', () => {
  const returnedAt = new Date('2026-07-27T01:02:03.000Z');
  const finalReviewedAt = new Date('2026-07-27T02:03:04.000Z');

  it('退回时按 active attendance assignment + submitter member 去重并写稳定 key', async () => {
    const outbox = makeOutboxMock();
    const tx = makeTxMock();
    tx.activityResponsibilityAssignment.findMany.mockResolvedValue([
      { memberId: 'member-owner' },
      { memberId: 'member-shared' },
    ]);
    tx.user.findMany.mockResolvedValue([
      { memberId: 'member-shared' },
      { memberId: 'member-submitter' },
      { memberId: null },
    ]);
    const producer = new AttendanceNotificationProducer(
      outbox as unknown as NotificationOutboxService,
    );

    await producer.enqueueReturned(tx as unknown as Prisma.TransactionClient, {
      sheetId: 'sheet-1',
      activityId: 'activity-1',
      returnedAt,
      returnNote: '补录签退',
      submitterUserIds: ['user-1', 'user-2'],
    });

    expect(tx.activityResponsibilityAssignment.findMany).toHaveBeenCalledWith({
      where: {
        activityId: 'activity-1',
        status: 'active',
        canManageAttendance: true,
        startedAt: { lte: returnedAt },
        endedAt: null,
        member: { status: 'ACTIVE', deletedAt: null },
      },
      select: { memberId: true },
    });
    expect(tx.user.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['user-1', 'user-2'] },
        status: 'ACTIVE',
        deletedAt: null,
        member: { status: 'ACTIVE', deletedAt: null },
      },
      select: { memberId: true },
    });
    expect(outbox.enqueue).toHaveBeenCalledTimes(3);
    expect(
      outbox.enqueue.mock.calls.map(([input]) => (input as { eventKey: string }).eventKey),
    ).toEqual([
      `attendance-return:sheet-1:${returnedAt.toISOString()}:member-owner`,
      `attendance-return:sheet-1:${returnedAt.toISOString()}:member-shared`,
      `attendance-return:sheet-1:${returnedAt.toISOString()}:member-submitter`,
    ]);
    for (const [input, client] of outbox.enqueue.mock.calls) {
      expect(input).toMatchObject({
        eventType: 'notification.targeted',
        aggregateType: 'attendance_sheet',
        aggregateId: 'sheet-1',
        destinationType: 'member',
        payload: {
          notificationTypeCode: 'attendance-result',
          title: '考勤单已退回修改',
          channels: ['in-app'],
        },
      });
      expect(client).toBe(tx);
    }
  });

  it('终审按 record 写独立稳定 key，保留同 member 多时段多条结果', async () => {
    const outbox = makeOutboxMock();
    const tx = makeTxMock();
    const producer = new AttendanceNotificationProducer(
      outbox as unknown as NotificationOutboxService,
    );

    await producer.enqueueFinalApproved(tx as unknown as Prisma.TransactionClient, {
      sheetId: 'sheet-2',
      activityId: 'activity-2',
      finalReviewedAt,
      records: [
        { id: 'record-1', memberId: 'member-1', contributionPoints: '1.5' },
        { id: 'record-2', memberId: 'member-1', contributionPoints: '2' },
      ],
    });

    expect(outbox.enqueue).toHaveBeenCalledTimes(2);
    expect(
      outbox.enqueue.mock.calls.map(([input]) => (input as { eventKey: string }).eventKey),
    ).toEqual([
      `attendance-final:sheet-2:${finalReviewedAt.toISOString()}:record-1`,
      `attendance-final:sheet-2:${finalReviewedAt.toISOString()}:record-2`,
    ]);
    expect(
      outbox.enqueue.mock.calls.map(
        ([input]) =>
          (input as { payload: { recipientMemberId: string } }).payload.recipientMemberId,
      ),
    ).toEqual(['member-1', 'member-1']);
  });
});
