import type { Prisma } from '@prisma/client';

import {
  NOTIFICATION_CHANNEL_IN_APP,
  OUTBOX_EVENT_TARGETED_NOTIFICATION,
  OUTBOX_PAYLOAD_VERSION,
} from '../notifications/notification.constants';
import type { NotificationOutboxEnqueueInput } from '../notifications/notification-outbox.types';
import { ActivityResponsibilityNotificationProducer } from './activity-responsibility-notification-producer';
import { freezeResponsibility, type FrozenRecipientCohort } from './activity-recipient-freeze';

describe('ActivityResponsibilityNotificationProducer', () => {
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const producer = new ActivityResponsibilityNotificationProducer({ enqueue } as never);
  const tx = {} as Prisma.TransactionClient;

  // 冻结批次只能由真的冻结服务造(品牌类型挡住手搓对象)。
  const freezeTx = {
    notificationOutboxIntent: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as Prisma.TransactionClient;
  const frozen = (
    cohortKey: string,
    assignmentId: string,
    memberIds: string[],
    at: Date,
  ): Promise<FrozenRecipientCohort> =>
    freezeResponsibility(freezeTx, {
      cohortKey,
      aggregateType: 'activity_responsibility_assignment',
      aggregateIds: [assignmentId],
      basisRef: [`assignment:${assignmentId}`],
      memberIds,
      at,
    });

  beforeEach(() => {
    enqueue.mockClear();
  });

  it('uses the assignment id as the stable collaborator delegation key', async () => {
    await producer.enqueueCollaboratorAssigned(tx, {
      assignmentId: 'assignment-1',
      activityTitle: '山野救援',
      cohort: await frozen(
        'responsibility-delegate:assignment-1',
        'assignment-1',
        ['member-1'],
        new Date('2026-07-27T01:00:00.000Z'),
      ),
    });

    expect(enqueue).toHaveBeenCalledWith(
      {
        eventKey: 'responsibility-delegate:assignment-1',
        eventType: OUTBOX_EVENT_TARGETED_NOTIFICATION,
        payloadVersion: OUTBOX_PAYLOAD_VERSION,
        payload: {
          recipientMemberId: 'member-1',
          notificationTypeCode: 'general',
          title: '你已被指定为活动协办人',
          body: '你已成为「山野救援」的活动协办人。',
          channels: [NOTIFICATION_CHANNEL_IN_APP],
          recipientFreeze: {
            cohortKey: 'responsibility-delegate:assignment-1',
            algorithmVersion: 1,
            basisKind: 'responsibility',
            basisRef: ['assignment:assignment-1'],
            computedAt: '2026-07-27T01:00:00.000Z',
            cohortSize: 1,
          },
        },
        aggregateType: 'activity_responsibility_assignment',
        aggregateId: 'assignment-1',
        destinationType: 'member',
        destinationRef: 'member-1',
      },
      tx,
    );
  });

  it('versions collaborator-end intents with the persisted endedAt value', async () => {
    await producer.enqueueCollaboratorEnded(tx, {
      assignmentId: 'assignment-2',
      activityTitle: '山野救援',
      endedAt: new Date('2026-07-27T02:00:00.000Z'),
      cohort: await frozen(
        'responsibility-delegate-end:assignment-2:2026-07-27T02:00:00.000Z',
        'assignment-2',
        ['member-2'],
        new Date('2026-07-27T02:00:00.000Z'),
      ),
    });

    const [input, client] = enqueue.mock.calls[0] as [
      NotificationOutboxEnqueueInput,
      Prisma.TransactionClient,
    ];
    expect(input).toMatchObject({
      eventKey: 'responsibility-delegate-end:assignment-2:2026-07-27T02:00:00.000Z',
      aggregateId: 'assignment-2',
      destinationRef: 'member-2',
      payload: {
        recipientMemberId: 'member-2',
        title: '活动协办职责已结束',
      },
    });
    expect(client).toBe(tx);
  });

  it('enqueues old and new owner notifications under the new owner assignment', async () => {
    await producer.enqueueOwnerTransferred(tx, {
      assignmentId: 'assignment-new-owner',
      oldOwnerMemberId: 'member-old',
      newOwnerMemberId: 'member-new',
      activityTitle: '山野救援',
      cohort: await frozen(
        'responsibility-transfer:assignment-new-owner',
        'assignment-new-owner',
        ['member-old', 'member-new'],
        new Date('2026-07-27T03:00:00.000Z'),
      ),
    });

    const calls = enqueue.mock.calls as Array<
      [NotificationOutboxEnqueueInput, Prisma.TransactionClient]
    >;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toMatchObject({
      eventKey: 'responsibility-transfer:assignment-new-owner:previous',
      aggregateId: 'assignment-new-owner',
      destinationRef: 'member-old',
      payload: {
        recipientMemberId: 'member-old',
        title: '活动负责人已移交',
      },
    });
    expect(calls[1][0]).toMatchObject({
      eventKey: 'responsibility-transfer:assignment-new-owner:current',
      aggregateId: 'assignment-new-owner',
      destinationRef: 'member-new',
      payload: {
        recipientMemberId: 'member-new',
        title: '你已成为活动负责人',
      },
    });
    expect(calls[0][1]).toBe(tx);
    expect(calls[1][1]).toBe(tx);
  });
});
