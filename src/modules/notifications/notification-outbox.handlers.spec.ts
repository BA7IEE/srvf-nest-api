import type { NotificationOutboxIntent } from '@prisma/client';

import {
  NotificationOutboxHandlers,
  UnsupportedNotificationOutboxEventError,
} from './notification-outbox.handlers';
import type { ClaimedNotificationOutboxIntent } from './notification-outbox.service';
import { parseKnownNotificationOutboxPayload } from './notification-outbox.types';

const NOW = new Date('2026-07-18T00:00:00.000Z');

function intent(payload: unknown): ClaimedNotificationOutboxIntent {
  return {
    id: 'cm00000000000000000000009',
    eventKey: 'admin-sms:cm00000000000000000000001:cm00000000000000000000002',
    eventType: 'notification.admin-sms',
    payloadVersion: 1,
    payload: payload as NotificationOutboxIntent['payload'],
    aggregateType: 'notification',
    aggregateId: 'cm00000000000000000000001',
    destinationType: 'member',
    destinationRef: 'cm00000000000000000000002',
    status: 'processing',
    attempts: 1,
    availableAt: NOW,
    leaseOwner: 'worker-1',
    lockedAt: NOW,
    leaseExpiresAt: new Date(NOW.getTime() + 30_000),
    preparedAt: null,
    sentAt: null,
    completedAt: null,
    lastErrorCode: null,
    lastErrorClass: null,
    deadAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('NotificationOutboxHandlers exact payload gate', () => {
  const handlers = new NotificationOutboxHandlers(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  it.each([
    ['missing memberId', { notificationId: 'cm00000000000000000000001' }],
    [
      'extra ordinary key carrying openid',
      {
        notificationId: 'cm00000000000000000000001',
        memberId: 'cm00000000000000000000002',
        note: 'oOpaqueOpenidValue123456789',
      },
    ],
    [
      'non-internal destination id',
      { notificationId: 'cm00000000000000000000001', memberId: 'opaque-token-value' },
    ],
  ])('%s 在任何 Effect 前 terminal', async (_name, payload) => {
    await expect(handlers.execute(intent(payload))).rejects.toBeInstanceOf(
      UnsupportedNotificationOutboxEventError,
    );
  });

  it.each([
    ['phone', '正文内嵌 13900000001'],
    ['JWT', '正文内嵌 eyJabc123.def456.ghi789'],
    ['Bearer', '正文内嵌 Bearer abcdefghijklmnop'],
    ['sk', '正文内嵌 sk-abcdefghijklmnop'],
    ['AKID', '正文内嵌 AKIDabcdefghijklmnop'],
    ['openid', '正文内嵌 oOpaqueOpenidValue123456789'],
    ['signed URL', '正文内嵌 https://cos.example/x?q-signature=abc&q-ak=AKID123'],
  ])('直插 exact-shape targeted raw %s 在任何 DB/渠道 Effect 前 terminal', async (_name, body) => {
    const transaction = jest.fn();
    const outbox = { enqueue: jest.fn() };
    const guarded = new NotificationOutboxHandlers(
      { $transaction: transaction } as never,
      outbox as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const raw = {
      ...intent({}),
      eventType: 'notification.targeted',
      payload: {
        recipientMemberId: 'cm00000000000000000000002',
        notificationTypeCode: 'expiry-reminder',
        title: '到期提醒',
        body,
        channels: ['in-app'],
      },
    };
    await expect(guarded.execute(raw)).rejects.toBeInstanceOf(
      UnsupportedNotificationOutboxEventError,
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('targeted intent 与生成的 Notification/微信 child 沿用同一 CUID id 域', async () => {
    const tx = { notification: { createMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    const prisma = { $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)) };
    const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const targeted = new NotificationOutboxHandlers(
      prisma as never,
      outbox as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const source = {
      ...intent({}),
      eventType: 'notification.targeted',
      payload: {
        recipientMemberId: 'cm00000000000000000000002',
        notificationTypeCode: 'expiry-reminder',
        title: '到期提醒',
        body: '请及时处理',
        channels: ['in-app', 'wechat'],
      },
    };
    await expect(targeted.execute(source)).resolves.toMatchObject({ effectPerformed: true });
    const [child] = outbox.enqueue.mock.calls[0] as [
      { eventType: string; payloadVersion: number; payload: unknown },
    ];
    expect(() =>
      parseKnownNotificationOutboxPayload(child.eventType, child.payloadVersion, child.payload),
    ).not.toThrow();
    expect(child.payload).toEqual({
      notificationId: source.id,
      memberId: 'cm00000000000000000000002',
    });
    expect(source.id).toMatch(/^c[a-z0-9]{20,31}$/);
  });
});
