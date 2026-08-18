import type { Prisma } from '@prisma/client';

import type { NotificationOutboxService } from '../notifications/notification-outbox.service';
import { ActivityNotificationProducer } from './activity-notification-producer';
import {
  freezeAudienceTags,
  freezeRegistrationRoster,
  isFrozenCohort,
  type FrozenBroadcastAudience,
  type FrozenRecipientCohort,
} from './activity-recipient-freeze';

/**
 * ⚠️ 冻结批次**只能由真的冻结服务造**(品牌类型挡住手搓对象)。所以这里不写假的
 * cohort,而是拿真服务 + 空 outbox 的假 tx 现算一个 —— 单测同时钉住「producer 的
 * 入参形状」与「冻结入口真的能产出它」两件事。
 */
const emptyOutboxTx = {
  notificationOutboxIntent: { findMany: jest.fn().mockResolvedValue([]) },
} as unknown as Prisma.TransactionClient;

async function frozenRoster(
  cohortKey: string,
  memberIds: string[],
  at: Date,
): Promise<FrozenRecipientCohort> {
  return freezeRegistrationRoster(emptyOutboxTx, {
    cohortKey,
    aggregateType: 'activity',
    aggregateIds: ['act-1'],
    basisRef: ['spec'],
    memberIds,
    at,
  });
}

async function frozenBroadcast(at: Date): Promise<FrozenBroadcastAudience> {
  const audience = await freezeAudienceTags(emptyOutboxTx, {
    activityId: 'act-1',
    audienceTagCodes: null,
    at,
  });
  if (isFrozenCohort(audience)) throw new Error('broadcast expected');
  return audience;
}

function stampOf(cohortKey: string, at: Date, cohortSize: number, basisKind: string) {
  return {
    cohortKey,
    algorithmVersion: 1,
    basisKind,
    basisRef: basisKind === 'broadcast-visibility' ? [] : ['spec'],
    computedAt: at.toISOString(),
    cohortSize,
  };
}

function makeFixture() {
  const tx = {
    activityRegistration: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'reg-1',
          updatedAt: new Date('2026-07-27T00:00:04.000Z'),
        },
      ]),
    },
  };
  const outbox = {
    enqueue: jest
      .fn<Promise<{ id: string }>, [Record<string, unknown>, unknown]>()
      .mockResolvedValue({ id: 'intent-1' }),
    enqueueMany: jest
      .fn<Promise<Array<{ id: string }>>, [Array<Record<string, unknown>>, unknown]>()
      .mockResolvedValue([{ id: 'intent-1' }]),
  };
  const producer = new ActivityNotificationProducer(outbox as unknown as NotificationOutboxService);
  return { tx, outbox, producer };
}

describe('ActivityNotificationProducer', () => {
  it('公开发布:publishedAt 组成稳定 broadcast eventKey；非公开不入队', async () => {
    const { tx, outbox, producer } = makeFixture();
    const base = {
      activityId: 'act-1',
      activityTitle: '公开演练',
      publishedAt: new Date('2026-07-27T00:00:01.000Z'),
      startAt: new Date('2026-08-01T08:00:00.000Z'),
      location: '梧桐山',
      requiresInsurance: true,
    };
    const audience = await frozenBroadcast(base.publishedAt);
    await producer.enqueuePublished(tx as unknown as Prisma.TransactionClient, {
      ...base,
      isPublicRegistration: true,
      audience,
    });
    await producer.enqueuePublished(tx as unknown as Prisma.TransactionClient, {
      ...base,
      activityId: 'act-private',
      isPublicRegistration: false,
      audience,
    });

    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue).toHaveBeenCalledWith(
      {
        eventKey: 'activity-publish:act-1:2026-07-27T00:00:01.000Z',
        eventType: 'notification.system-broadcast',
        payloadVersion: 1,
        payload: {
          notificationTypeCode: 'activity-published',
          title: '新活动已发布',
          body: '「公开演练」已发布，开始时间 2026-08-01T08:00:00.000Z，地点 梧桐山。 本活动要求有效保险，请在报名前确认覆盖期。',
          visibilityCode: 'member',
          recipientFreeze: stampOf(
            'activity-publish-audience:act-1:2026-07-27T00:00:01.000Z',
            base.publishedAt,
            0,
            'broadcast-visibility',
          ),
        },
        aggregateType: 'activity',
        aggregateId: 'act-1',
        destinationType: 'visibility',
        destinationRef: 'member',
      },
      tx,
    );
  });

  it('取消:同一 cancelledAt 按 member 生成互异 intent', async () => {
    const { tx, outbox, producer } = makeFixture();
    await producer.enqueueCancellation(tx as unknown as Prisma.TransactionClient, {
      activityId: 'act-1',
      activityTitle: '夜训',
      cancelledAt: new Date('2026-07-27T00:00:02.000Z'),
      cancelReason: '暴雨',
      cohort: await frozenRoster(
        'activity-cancel:act-1:2026-07-27T00:00:02.000Z',
        ['member-1', 'member-2'],
        new Date('2026-07-27T00:00:02.000Z'),
      ),
    });

    expect(outbox.enqueue).toHaveBeenCalledTimes(2);
    expect(outbox.enqueue.mock.calls.map(([input]) => String(input.eventKey))).toEqual([
      'activity-cancel:act-1:2026-07-27T00:00:02.000Z:member-1',
      'activity-cancel:act-1:2026-07-27T00:00:02.000Z:member-2',
    ]);
  });

  it('B7 定向发布:一次 enqueueMany 写入去重后的逐会员 intent，绝不回退广播', async () => {
    const { tx, outbox, producer } = makeFixture();
    await producer.enqueuePublishedWithAudienceTags(tx as unknown as Prisma.TransactionClient, {
      activityId: 'act-1',
      activityTitle: '受众标签演练',
      publishedAt: new Date('2026-07-27T00:00:02.000Z'),
      startAt: new Date('2026-08-01T08:00:00.000Z'),
      location: '梧桐山',
      requiresInsurance: false,
      cohort: await frozenRoster(
        'activity-publish-audience:act-1:2026-07-27T00:00:02.000Z',
        ['member-1', 'member-2'],
        new Date('2026-07-27T00:00:02.000Z'),
      ),
    });

    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(outbox.enqueueMany).toHaveBeenCalledWith(
      [
        {
          eventKey: 'activity-publish-audience:act-1:2026-07-27T00:00:02.000Z:member-1',
          eventType: 'notification.targeted',
          payloadVersion: 1,
          payload: {
            recipientMemberId: 'member-1',
            notificationTypeCode: 'activity-published',
            title: '新活动已发布',
            body: '「受众标签演练」已发布，开始时间 2026-08-01T08:00:00.000Z，地点 梧桐山。',
            channels: ['in-app'],
            recipientFreeze: stampOf(
              'activity-publish-audience:act-1:2026-07-27T00:00:02.000Z',
              new Date('2026-07-27T00:00:02.000Z'),
              2,
              'registration-roster',
            ),
          },
          aggregateType: 'activity',
          aggregateId: 'act-1',
          destinationType: 'member',
          destinationRef: 'member-1',
        },
        {
          eventKey: 'activity-publish-audience:act-1:2026-07-27T00:00:02.000Z:member-2',
          eventType: 'notification.targeted',
          payloadVersion: 1,
          payload: {
            recipientMemberId: 'member-2',
            notificationTypeCode: 'activity-published',
            title: '新活动已发布',
            body: '「受众标签演练」已发布，开始时间 2026-08-01T08:00:00.000Z，地点 梧桐山。',
            channels: ['in-app'],
            recipientFreeze: stampOf(
              'activity-publish-audience:act-1:2026-07-27T00:00:02.000Z',
              new Date('2026-07-27T00:00:02.000Z'),
              2,
              'registration-roster',
            ),
          },
          aggregateType: 'activity',
          aggregateId: 'act-1',
          destinationType: 'member',
          destinationRef: 'member-2',
        },
      ],
      tx,
    );
  });

  it('直接改期:payload 保留新旧安排与保险提示', async () => {
    const { tx, outbox, producer } = makeFixture();
    await producer.enqueueScheduleChange(tx as unknown as Prisma.TransactionClient, {
      activityId: 'act-1',
      activityTitle: '改期演练',
      versionKey: '2026-07-27T00:00:03.000Z',
      before: {
        startAt: new Date('2026-08-01T08:00:00.000Z'),
        endAt: new Date('2026-08-01T12:00:00.000Z'),
        location: '梧桐山',
      },
      after: {
        startAt: new Date('2026-08-02T08:00:00.000Z'),
        endAt: new Date('2026-08-02T12:00:00.000Z'),
        location: '莲花山',
      },
      requiresInsurance: true,
      cohort: await frozenRoster(
        'activity-change:act-1:2026-07-27T00:00:03.000Z',
        ['member-1'],
        new Date('2026-07-27T00:00:03.000Z'),
      ),
    });

    expect(outbox.enqueue).toHaveBeenCalledWith(
      {
        eventKey: 'activity-change:act-1:2026-07-27T00:00:03.000Z:member-1',
        eventType: 'notification.targeted',
        payloadVersion: 1,
        payload: {
          recipientMemberId: 'member-1',
          notificationTypeCode: 'activity-changed',
          title: '活动安排已变更',
          body: '您报名的「改期演练」安排有变更：开始时间：2026-08-01T08:00:00.000Z → 2026-08-02T08:00:00.000Z；结束时间：2026-08-01T12:00:00.000Z → 2026-08-02T12:00:00.000Z；地点：梧桐山 → 莲花山。 保险覆盖按原日期核验，请按调整后的活动时段重新确认。',
          channels: ['in-app'],
          recipientFreeze: stampOf(
            'activity-change:act-1:2026-07-27T00:00:03.000Z',
            new Date('2026-07-27T00:00:03.000Z'),
            1,
            'registration-roster',
          ),
        },
        aggregateType: 'activity',
        aggregateId: 'act-1',
        destinationType: 'member',
        destinationRef: 'member-1',
      },
      tx,
    );
  });

  it('候补递补:registration.updatedAt 组成与 L1 一致的 eventKey', async () => {
    const { tx, outbox, producer } = makeFixture();
    await producer.enqueueWaitlistPromotions(tx as unknown as Prisma.TransactionClient, {
      activityTitle: '扩容活动',
      promoted: [{ registrationId: 'reg-1', memberId: 'member-1' }],
      cohort: await frozenRoster(
        'waitlist-promote:act-1',
        ['member-1'],
        new Date('2026-07-27T00:00:04.000Z'),
      ),
    });

    expect(outbox.enqueue).toHaveBeenCalledWith(
      {
        eventKey: 'waitlist-promote:reg-1:2026-07-27T00:00:04.000Z',
        eventType: 'notification.targeted',
        payloadVersion: 1,
        payload: {
          recipientMemberId: 'member-1',
          notificationTypeCode: 'registration-result',
          title: '候补已递补',
          body: '您报名的「扩容活动」已从候补递补，现已进入待审核。',
          channels: ['in-app'],
          recipientFreeze: stampOf(
            'waitlist-promote:act-1',
            new Date('2026-07-27T00:00:04.000Z'),
            1,
            'registration-roster',
          ),
        },
        aggregateType: 'activity_registration',
        aggregateId: 'reg-1',
        destinationType: 'member',
        destinationRef: 'member-1',
      },
      tx,
    );
  });

  it('审核结果:reviewId + reviewedAt 稳定指向事务内解析的收件人', async () => {
    const { tx, outbox, producer } = makeFixture();
    await producer.enqueueReviewOutcome(tx as unknown as Prisma.TransactionClient, {
      reviewId: 'review-1',
      activityId: 'act-1',
      activityTitle: '审核活动',
      reviewedAt: new Date('2026-07-27T00:00:05.000Z'),
      cohort: await frozenRoster(
        'activity-review-outcome:review-1:2026-07-27T00:00:05.000Z',
        ['member-owner'],
        new Date('2026-07-27T00:00:05.000Z'),
      ),
      approved: false,
      reviewNote: '调整时间',
    });

    expect(outbox.enqueue).toHaveBeenCalledWith(
      {
        eventKey: 'activity-review-outcome:review-1:2026-07-27T00:00:05.000Z',
        eventType: 'notification.targeted',
        payloadVersion: 1,
        payload: {
          recipientMemberId: 'member-owner',
          notificationTypeCode: 'general',
          title: '活动发布审核已退回',
          body: '「审核活动」发布审核已退回。原因：调整时间',
          channels: ['in-app'],
          recipientFreeze: stampOf(
            'activity-review-outcome:review-1:2026-07-27T00:00:05.000Z',
            new Date('2026-07-27T00:00:05.000Z'),
            1,
            'registration-roster',
          ),
        },
        aggregateType: 'activity_publish_review',
        aggregateId: 'review-1',
        destinationType: 'member',
        destinationRef: 'member-owner',
      },
      tx,
    );
  });
});
