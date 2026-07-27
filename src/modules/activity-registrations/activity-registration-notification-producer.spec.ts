import type { ConfigType } from '@nestjs/config';
import type { Prisma } from '@prisma/client';

import appConfig from '../../config/app.config';
import type { NotificationOutboxService } from '../notifications/notification-outbox.service';
import { ActivityRegistrationNotificationProducer } from './activity-registration-notification-producer';

function makeFixture(workflowEnabled: boolean) {
  const tx = {
    activity: {
      findUnique: jest.fn().mockResolvedValue({ title: '周末巡山' }),
    },
    auditLog: {
      count: jest.fn().mockResolvedValue(1),
    },
    activityRegistration: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'reg-promoted', updatedAt: new Date('2026-07-26T00:00:02.000Z') },
        ]),
    },
    activityResponsibilityAssignment: {
      findFirst: jest.fn().mockResolvedValue({ memberId: 'member-owner' }),
    },
  };
  const outbox = { enqueue: jest.fn().mockResolvedValue({ id: 'intent-1' }) };
  const producer = new ActivityRegistrationNotificationProducer(
    outbox as unknown as NotificationOutboxService,
    {
      activityResponsibilityWorkflow: { enabled: workflowEnabled },
    } as ConfigType<typeof appConfig>,
  );
  return { producer, tx, outbox };
}

describe('ActivityRegistrationNotificationProducer', () => {
  it('review:审计版本 + reviewedAt 组成稳定 eventKey，payload 只含定向通知字段', async () => {
    const { producer, tx, outbox } = makeFixture(true);
    await producer.enqueueReview(tx as unknown as Prisma.TransactionClient, {
      registrationId: 'reg-1',
      activityId: 'act-1',
      memberId: 'member-1',
      reviewedAt: new Date('2026-07-26T00:00:01.000Z'),
      outcome: 'approved',
      reviewNote: '材料齐全',
    });

    expect(tx.auditLog.count).toHaveBeenCalledWith({
      where: { resourceId: 'reg-1', event: 'registration.review' },
    });
    expect(outbox.enqueue).toHaveBeenCalledWith(
      {
        eventKey: 'registration-review:reg-1:2026-07-26T00:00:01.000Z:1',
        eventType: 'notification.targeted',
        payloadVersion: 1,
        payload: {
          recipientMemberId: 'member-1',
          notificationTypeCode: 'registration-result',
          title: '报名已通过',
          body: '您报名的「周末巡山」已通过审核。 理由:材料齐全',
          channels: ['in-app'],
        },
        aggregateType: 'activity_registration',
        aggregateId: 'reg-1',
        destinationType: 'member',
        destinationRef: 'member-1',
      },
      tx,
    );
  });

  it('waitlist promotion:使用 registration.updatedAt 生成每条独立 eventKey', async () => {
    const { producer, tx, outbox } = makeFixture(true);
    await producer.enqueueWaitlistPromotions(tx as unknown as Prisma.TransactionClient, {
      activityTitle: '周末巡山',
      promoted: [{ registrationId: 'reg-promoted', memberId: 'member-2' }],
    });

    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: 'waitlist-promote:reg-promoted:2026-07-26T00:00:02.000Z',
        aggregateId: 'reg-promoted',
        destinationRef: 'member-2',
        payload: expect.objectContaining({ title: '候补已递补' }) as Record<string, unknown>,
      }),
      tx,
    );
  });

  it('gate=true:self cancel 只解析 active owner，不读取 publisher fallback', async () => {
    const { producer, tx, outbox } = makeFixture(true);
    const resolution = await producer.enqueueSelfCancellation(
      tx as unknown as Prisma.TransactionClient,
      {
        registrationId: 'reg-1',
        activityId: 'act-1',
        activityTitle: '周末巡山',
        publisherMemberId: 'member-publisher',
        cancellingMember: { memberNo: 'LOCAL-001', displayName: '本地队员甲' },
        cancelledAt: new Date('2026-07-26T00:00:03.000Z'),
        cancelReason: null,
      },
    );

    expect(resolution).toBe('active-owner');
    expect(tx.activityResponsibilityAssignment.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        activityId: 'act-1',
        responsibilityType: 'owner',
        status: 'active',
        endedAt: null,
        member: { status: 'ACTIVE', deletedAt: null },
      }) as Record<string, unknown>,
      select: { memberId: true },
    });
    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationRef: 'member-owner',
        eventKey: 'registration-cancel:reg-1:2026-07-26T00:00:03.000Z',
        eventType: 'notification.targeted',
        payloadVersion: 1,
        aggregateType: 'activity_registration',
        aggregateId: 'reg-1',
        destinationType: 'member',
        payload: {
          recipientMemberId: 'member-owner',
          notificationTypeCode: 'activity-changed',
          title: '队员取消活动报名',
          body: '队员本地队员甲（LOCAL-001）已取消「周末巡山」报名。',
          channels: ['in-app'],
        },
      }),
      tx,
    );
  });

  it('gate=true 无 active owner:fail closed 零 intent，不向 publisher 猜测', async () => {
    const { producer, tx, outbox } = makeFixture(true);
    tx.activityResponsibilityAssignment.findFirst.mockResolvedValue(null);

    await expect(
      producer.enqueueSelfCancellation(tx as unknown as Prisma.TransactionClient, {
        registrationId: 'reg-1',
        activityId: 'act-1',
        activityTitle: '周末巡山',
        publisherMemberId: 'member-publisher',
        cancellingMember: { memberNo: 'LOCAL-001', displayName: '本地队员甲' },
        cancelledAt: new Date('2026-07-26T00:00:03.000Z'),
        cancelReason: null,
      }),
    ).resolves.toBe('missing-active-owner');
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('gate=false:显式保留 legacy publisher fallback', async () => {
    const { producer, tx, outbox } = makeFixture(false);

    await expect(
      producer.enqueueSelfCancellation(tx as unknown as Prisma.TransactionClient, {
        registrationId: 'reg-1',
        activityId: 'act-1',
        activityTitle: '周末巡山',
        publisherMemberId: 'member-publisher',
        cancellingMember: { memberNo: 'LOCAL-001', displayName: '本地队员甲' },
        cancelledAt: new Date('2026-07-26T00:00:03.000Z'),
        cancelReason: '临时有事',
      }),
    ).resolves.toBe('legacy-publisher');
    expect(tx.activityResponsibilityAssignment.findFirst).not.toHaveBeenCalled();
    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationRef: 'member-publisher',
        eventKey: 'registration-cancel:reg-1:2026-07-26T00:00:03.000Z',
        aggregateType: 'activity_registration',
        aggregateId: 'reg-1',
        payload: {
          recipientMemberId: 'member-publisher',
          notificationTypeCode: 'activity-changed',
          title: '队员取消活动报名',
          body: '队员本地队员甲（LOCAL-001）已取消「周末巡山」报名，原因：临时有事。',
          channels: ['in-app'],
        },
      }),
      tx,
    );
  });

  it('gate=false 无 legacy publisher:零 intent，不查询 active owner', async () => {
    const { producer, tx, outbox } = makeFixture(false);

    await expect(
      producer.enqueueSelfCancellation(tx as unknown as Prisma.TransactionClient, {
        registrationId: 'reg-1',
        activityId: 'act-1',
        activityTitle: '周末巡山',
        publisherMemberId: null,
        cancellingMember: { memberNo: 'LOCAL-001', displayName: '本地队员甲' },
        cancelledAt: new Date('2026-07-26T00:00:03.000Z'),
        cancelReason: null,
      }),
    ).resolves.toBe('missing-legacy-publisher');
    expect(tx.activityResponsibilityAssignment.findFirst).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    {
      cancellingMember: null,
      cancelReason: null,
      body: '有队员已取消「周末巡山」报名，请查看活动报名列表。',
    },
    {
      cancellingMember: { memberNo: 'LOCAL-001', displayName: null },
      cancelReason: '临时有事',
      body: '有队员已取消「周末巡山」报名，请查看活动报名列表。原因：临时有事。',
    },
    {
      cancellingMember: { memberNo: '   ', displayName: '本地队员甲' },
      cancelReason: null,
      body: '有队员已取消「周末巡山」报名，请查看活动报名列表。',
    },
  ])('安全标签不可用时使用固定兜底，不生成内部 ID/undefined/null/空括号', async (testCase) => {
    const { producer, tx, outbox } = makeFixture(false);
    await producer.enqueueSelfCancellation(tx as unknown as Prisma.TransactionClient, {
      registrationId: 'reg-1',
      activityId: 'act-1',
      activityTitle: '周末巡山',
      publisherMemberId: 'member-publisher',
      cancellingMember: testCase.cancellingMember,
      cancelledAt: new Date('2026-07-26T00:00:03.000Z'),
      cancelReason: testCase.cancelReason,
    });

    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ body: testCase.body }) as Record<string, unknown>,
      }),
      tx,
    );
    expect(testCase.body).not.toContain('member-');
    expect(testCase.body).not.toContain('undefined');
    expect(testCase.body).not.toContain('null');
    expect(testCase.body).not.toContain('（）');
  });
});
