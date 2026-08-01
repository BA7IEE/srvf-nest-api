import { Prisma } from '@prisma/client';

import type { NotificationOutboxService } from '../notifications/notification-outbox.service';
import type { NotificationOutboxEnqueueInput } from '../notifications/notification-outbox.types';
import { AttendanceNotificationProducer } from './attendance-notification-producer';

function makeOutboxMock() {
  return {
    enqueue: jest
      .fn<Promise<{ id: string }>, [NotificationOutboxEnqueueInput, Prisma.TransactionClient]>()
      .mockResolvedValue({ id: 'intent-1' }),
    // M3:终审两条路径改走批量 enqueue(恒 2 次 SQL,与条数无关);
    // 退回通知仍是逐条 enqueue(收件人数天然有界,不是 N+1 热点)。
    enqueueMany: jest
      .fn<
        Promise<Array<{ id: string }>>,
        [readonly NotificationOutboxEnqueueInput[], Prisma.TransactionClient]
      >()
      .mockResolvedValue([{ id: 'intent-1' }]),
  };
}

/** 把批量调用摊平成「逐条 (input, client)」,让断言保持与逐条时代同形。 */
function flatEnqueued(
  outbox: ReturnType<typeof makeOutboxMock>,
): Array<[NotificationOutboxEnqueueInput, Prisma.TransactionClient]> {
  return outbox.enqueueMany.mock.calls.flatMap(([inputs, client]) =>
    inputs.map((input): [NotificationOutboxEnqueueInput, Prisma.TransactionClient] => [
      input,
      client,
    ]),
  );
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
      findMany: jest.fn().mockResolvedValue([]),
    },
    attendanceRecord: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

function contributionRecord(day: string, points: string | number, memberId = 'member-1') {
  return {
    // 批量版按 memberId 分组,所以合成记录必须带上它(逐人查询时不需要)。
    memberId,
    checkInAt: new Date(`${day}T01:00:00.000Z`),
    contributionPoints: new Prisma.Decimal(points),
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
      contributionThresholdSnapshots: [],
    });

    // 两条 record ⇒ 两条 intent,但只有**一次**批量调用(M3 的判据就在这里)。
    expect(outbox.enqueueMany).toHaveBeenCalledTimes(1);
    const enqueued = flatEnqueued(outbox);
    expect(enqueued.map(([input]) => input.eventKey)).toEqual([
      `attendance-final:sheet-2:${finalReviewedAt.toISOString()}:record-1`,
      `attendance-final:sheet-2:${finalReviewedAt.toISOString()}:record-2`,
    ]);
    expect(
      enqueued.map(
        ([input]) => (input.payload as unknown as { recipientMemberId: string }).recipientMemberId,
      ),
    ).toEqual(['member-1', 'member-1']);
    for (const [, client] of enqueued) expect(client).toBe(tx);
  });

  it('终审前按 member 去重并快照最新 joining application 的真实 capped before', async () => {
    const outbox = makeOutboxMock();
    const tx = makeTxMock();
    tx.teamJoinApplication.findMany.mockResolvedValue([
      { id: 'application-1', memberId: 'member-1', cycle: { year: 2027 } },
    ]);
    tx.attendanceRecord.findMany.mockResolvedValue([
      contributionRecord('2026-08-01', 3),
      contributionRecord('2026-08-02', 1),
    ]);
    const producer = new AttendanceNotificationProducer(
      outbox as unknown as NotificationOutboxService,
    );

    const snapshots = await producer.prepareContributionThresholdSnapshots(
      tx as unknown as Prisma.TransactionClient,
      [{ memberId: 'member-1' }, { memberId: 'member-1' }],
    );

    // M3:整批人**一次** findMany,而不是每人一次 findFirst。
    expect(tx.teamJoinApplication.findMany).toHaveBeenCalledTimes(1);
    expect(tx.teamJoinApplication.findMany).toHaveBeenCalledWith({
      where: { memberId: { in: ['member-1'] }, statusCode: 'joining', deletedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, memberId: true, cycle: { select: { year: true } } },
    });
    // 贡献值也是一次(同 cycleYear 一次),不随人数增长。
    expect(tx.attendanceRecord.findMany).toHaveBeenCalledTimes(1);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      applicationId: 'application-1',
      memberId: 'member-1',
      cycleYear: 2027,
    });
    expect(snapshots[0].beforePoints.toString()).toBe('4');
  });

  it('无 joining application 时不建立 milestone snapshot', async () => {
    const outbox = makeOutboxMock();
    const tx = makeTxMock();
    const producer = new AttendanceNotificationProducer(
      outbox as unknown as NotificationOutboxService,
    );

    await expect(
      producer.prepareContributionThresholdSnapshots(tx as unknown as Prisma.TransactionClient, [
        { memberId: 'member-1' },
      ]),
    ).resolves.toEqual([]);
    expect(tx.attendanceRecord.findMany).not.toHaveBeenCalled();
  });

  it('真实 capped 4→5 时发送稳定 application+threshold milestone', async () => {
    const outbox = makeOutboxMock();
    const tx = makeTxMock();
    tx.attendanceRecord.findMany.mockResolvedValue([
      contributionRecord('2026-08-01', 3),
      contributionRecord('2026-08-02', 2),
    ]);
    const producer = new AttendanceNotificationProducer(
      outbox as unknown as NotificationOutboxService,
    );

    await producer.enqueueFinalApproved(tx as unknown as Prisma.TransactionClient, {
      sheetId: 'sheet-2',
      activityId: 'activity-2',
      finalReviewedAt,
      records: [{ id: 'record-1', memberId: 'member-1', contributionPoints: '1' }],
      contributionThresholdSnapshots: [
        {
          applicationId: 'application-1',
          memberId: 'member-1',
          cycleYear: 2027,
          beforePoints: new Prisma.Decimal(4),
        },
      ],
    });

    const enqueued = flatEnqueued(outbox);
    expect(enqueued).toHaveLength(2);
    expect(enqueued[1][0]).toEqual({
      eventKey: 'team-join-contribution-met:application-1:5',
      eventType: 'notification.targeted',
      payloadVersion: 1,
      payload: {
        recipientMemberId: 'member-1',
        notificationTypeCode: 'recruitment',
        title: '入队贡献值已达标',
        body: '您的贡献值已达到入队要求（5 分）。管理员核对其他门槛后将安排综合评估，请留意后续通知。',
        channels: ['in-app'],
      },
      aggregateType: 'team_join_application',
      aggregateId: 'application-1',
      destinationType: 'member',
      destinationRef: 'member-1',
    });
  });

  it.each([
    { before: 5, after: 5 },
    { before: 6, after: 6 },
  ])('真实 capped $before→$after 时不重复发送 milestone', async ({ before, after }) => {
    const outbox = makeOutboxMock();
    const tx = makeTxMock();
    tx.attendanceRecord.findMany.mockResolvedValue([
      contributionRecord('2026-08-01', 3),
      contributionRecord('2026-08-02', after - 3),
    ]);
    const producer = new AttendanceNotificationProducer(
      outbox as unknown as NotificationOutboxService,
    );

    await producer.enqueueFinalApproved(tx as unknown as Prisma.TransactionClient, {
      sheetId: 'sheet-2',
      activityId: 'activity-2',
      finalReviewedAt,
      records: [{ id: 'record-1', memberId: 'member-1', contributionPoints: '1' }],
      contributionThresholdSnapshots: [
        {
          applicationId: 'application-1',
          memberId: 'member-1',
          cycleYear: 2027,
          beforePoints: new Prisma.Decimal(before),
        },
      ],
    });

    const enqueued = flatEnqueued(outbox);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0][0]).toMatchObject({
      eventKey: `attendance-final:sheet-2:${finalReviewedAt.toISOString()}:record-1`,
    });
  });

  it('同一 member 多 records 原始 +3 但 capped 仅 +1 时保留两条结果并只发一次 milestone', async () => {
    const outbox = makeOutboxMock();
    const tx = makeTxMock();
    tx.attendanceRecord.findMany.mockResolvedValue([
      contributionRecord('2026-08-01', 2),
      contributionRecord('2026-08-01', 1.5),
      contributionRecord('2026-08-01', 1.5),
      contributionRecord('2026-08-02', 2),
    ]);
    const producer = new AttendanceNotificationProducer(
      outbox as unknown as NotificationOutboxService,
    );
    const input = {
      sheetId: 'sheet-2',
      activityId: 'activity-2',
      finalReviewedAt,
      records: [
        { id: 'record-1', memberId: 'member-1', contributionPoints: '1.5' },
        { id: 'record-2', memberId: 'member-1', contributionPoints: '1.5' },
      ],
      contributionThresholdSnapshots: [
        {
          applicationId: 'application-1',
          memberId: 'member-1',
          cycleYear: 2027,
          beforePoints: new Prisma.Decimal(4),
        },
      ],
    };

    await producer.enqueueFinalApproved(tx as unknown as Prisma.TransactionClient, input);
    await producer.enqueueFinalApproved(tx as unknown as Prisma.TransactionClient, input);

    const enqueued = flatEnqueued(outbox);
    expect(enqueued).toHaveLength(6);
    const milestones = enqueued
      .map(([candidate]) => candidate)
      .filter(
        (candidate) =>
          (candidate as { eventKey: string }).eventKey ===
          'team-join-contribution-met:application-1:5',
      );
    expect(milestones).toHaveLength(2);
    expect(milestones[0]).toEqual(milestones[1]);
  });
});
