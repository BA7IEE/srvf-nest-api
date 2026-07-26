import type { Prisma } from '@prisma/client';

import {
  NOTIFICATION_CHANNEL_IN_APP,
  OUTBOX_EVENT_TARGETED_NOTIFICATION,
  OUTBOX_PAYLOAD_VERSION,
} from '../notifications/notification.constants';
import type { NotificationOutboxEnqueueInput } from '../notifications/notification-outbox.types';
import { ActivityResponsibilityNotificationProducer } from './activity-responsibility-notification-producer';

describe('ActivityResponsibilityNotificationProducer', () => {
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const producer = new ActivityResponsibilityNotificationProducer({ enqueue } as never);
  const tx = {} as Prisma.TransactionClient;

  beforeEach(() => {
    enqueue.mockClear();
  });

  it('uses the assignment id as the stable collaborator delegation key', async () => {
    await producer.enqueueCollaboratorAssigned(tx, {
      assignmentId: 'assignment-1',
      memberId: 'member-1',
      activityTitle: '山野救援',
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
      memberId: 'member-2',
      activityTitle: '山野救援',
      endedAt: new Date('2026-07-27T02:00:00.000Z'),
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
