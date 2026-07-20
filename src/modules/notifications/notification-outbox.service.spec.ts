import { Prisma, type NotificationOutboxIntent } from '@prisma/client';

import {
  assertStoredNotificationOutboxIntentSafe,
  normalizeNotificationOutboxInput,
  NotificationOutboxInvariantError,
  NotificationOutboxLeaseLostError,
  redactNotificationOutboxText,
  type NotificationOutboxEnqueueInput,
  type SystemBroadcastOutboxPayload,
  type TargetedNotificationOutboxPayload,
} from './notification-outbox.types';
import {
  type ClaimedNotificationOutboxIntent,
  NotificationOutboxGenerationConflictError,
  NotificationOutboxService,
} from './notification-outbox.service';

const NOW = new Date('2026-07-18T00:00:00.000Z');
const MEMBER_1 = 'cm00000000000000000000001';
const MEMBER_2 = 'cm00000000000000000000002';
const NOTIFICATION_1 = 'cm00000000000000000000003';
const GENERATION_1 = '00000000-0000-4000-8000-000000000001';

interface UpdateManyCall {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}

function input(
  payload: Record<string, string | number> = {
    notificationId: NOTIFICATION_1,
    memberId: MEMBER_1,
    publishGeneration: 1,
  },
): NotificationOutboxEnqueueInput {
  return {
    eventKey: `admin-sms:${NOTIFICATION_1}:${GENERATION_1}:${MEMBER_1}`,
    eventType: 'notification.admin-sms',
    payloadVersion: 2,
    payload,
    aggregateType: 'notification',
    aggregateId: NOTIFICATION_1,
    destinationType: 'member',
    destinationRef: MEMBER_1,
  };
}

function wechatInput(
  rootId: string,
  publishGeneration: number = 1,
): NotificationOutboxEnqueueInput {
  return {
    eventKey: `wechat-delivery:${NOTIFICATION_1}:${rootId}:${MEMBER_1}`,
    eventType: 'notification.wechat-delivery',
    payloadVersion: 2,
    payload: { notificationId: NOTIFICATION_1, memberId: MEMBER_1, publishGeneration },
    aggregateType: 'notification',
    aggregateId: NOTIFICATION_1,
    destinationType: 'member',
    destinationRef: MEMBER_1,
  };
}

function row(overrides: Partial<NotificationOutboxIntent> = {}): NotificationOutboxIntent {
  return {
    id: 'intent-1',
    eventKey: `admin-sms:${NOTIFICATION_1}:${GENERATION_1}:${MEMBER_1}`,
    eventType: 'notification.admin-sms',
    payloadVersion: 2,
    payload: { notificationId: NOTIFICATION_1, memberId: MEMBER_1, publishGeneration: 1 },
    aggregateType: 'notification',
    aggregateId: NOTIFICATION_1,
    destinationType: 'member',
    destinationRef: MEMBER_1,
    status: 'pending',
    attempts: 0,
    availableAt: NOW,
    leaseOwner: null,
    lockedAt: null,
    leaseExpiresAt: null,
    preparedAt: null,
    preparedTemplateId: null,
    sentAt: null,
    completedAt: null,
    lastErrorCode: null,
    lastErrorClass: null,
    deadAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('NotificationOutboxService', () => {
  function build() {
    const createMany = jest.fn().mockResolvedValue({ count: 1 });
    const findUnique = jest.fn().mockResolvedValue(row());
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const findFirst = jest.fn().mockResolvedValue({ preparedAt: null, preparedTemplateId: null });
    const findMany = jest.fn().mockResolvedValue([]);
    const queryRaw = jest
      .fn<Promise<Array<Record<string, unknown>>>, [Prisma.Sql]>()
      .mockResolvedValue([]);
    const tx = {
      notificationOutboxIntent: { createMany, findUnique, updateMany, findFirst, findMany },
      $queryRaw: queryRaw,
    };
    const prisma = {
      notificationOutboxIntent: { createMany, findUnique, updateMany, findFirst },
      $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    return {
      service: new NotificationOutboxService(prisma as never),
      prisma,
      tx,
      createMany,
      findUnique,
      updateMany,
      findFirst,
      findMany,
      queryRaw,
    };
  }

  it('同 eventKey 同内容幂等；不同内容 fail-closed', async () => {
    const f = build();
    f.createMany.mockResolvedValue({ count: 0 });
    await expect(f.service.enqueue(input())).resolves.toMatchObject({ id: 'intent-1' });

    await expect(
      f.service.enqueue(
        input({ notificationId: NOTIFICATION_1, memberId: MEMBER_1, publishGeneration: 2 }),
      ),
    ).rejects.toBeInstanceOf(NotificationOutboxInvariantError);
  });

  it('微信广播不同 generation 撞 active partial unique 时显式要求 root defer', async () => {
    const f = build();
    const firstGeneration = wechatInput('cm00000000000000000000007');
    const active = row({
      id: 'cm00000000000000000000009',
      eventKey: firstGeneration.eventKey,
      eventType: firstGeneration.eventType,
      payloadVersion: firstGeneration.payloadVersion,
      payload: { notificationId: NOTIFICATION_1, memberId: MEMBER_1, publishGeneration: 1 },
      aggregateType: firstGeneration.aggregateType,
      aggregateId: firstGeneration.aggregateId,
      destinationType: firstGeneration.destinationType,
      destinationRef: firstGeneration.destinationRef,
      status: 'processing',
      attempts: 1,
      leaseOwner: 'worker-1',
      lockedAt: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 30_000),
    });
    f.createMany.mockResolvedValue({ count: 0 });
    f.findUnique.mockResolvedValue(null);
    f.findFirst.mockResolvedValue(active);

    await expect(
      f.service.enqueueWechatDeliveryAttempt(wechatInput('cm00000000000000000000008', 2)),
    ).rejects.toEqual(new NotificationOutboxGenerationConflictError(active));
    expect(f.createMany).toHaveBeenCalledTimes(1);
    const [findFirstInput] = f.findFirst.mock.calls.at(-1) as unknown as [
      { where: Record<string, unknown> },
    ];
    expect(findFirstInput.where).toMatchObject({
      aggregateId: NOTIFICATION_1,
      destinationRef: MEMBER_1,
      status: { in: ['pending', 'processing'] },
    });
  });

  it('cross-generation root 只以稳定 fence 回 pending、恢复 attempt 且排到 active lease 之后', async () => {
    const f = build();
    const root = row({
      id: 'cm00000000000000000000010',
      eventType: 'notification.wechat-broadcast',
      status: 'processing',
      attempts: 1,
      leaseOwner: 'root-worker',
      lockedAt: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 30_000),
      preparedAt: null,
    }) as ClaimedNotificationOutboxIntent;
    const active = row({
      id: 'cm00000000000000000000011',
      eventType: 'notification.wechat-delivery',
      status: 'processing',
      attempts: 2,
      leaseOwner: 'child-worker',
      lockedAt: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 5_000),
    });

    await expect(
      f.service.deferWechatBroadcast(
        root,
        new NotificationOutboxGenerationConflictError(active),
        NOW,
      ),
    ).resolves.toBeUndefined();
    const [call] = f.updateMany.mock.calls.at(-1) as unknown as [UpdateManyCall];
    expect(call.where).toMatchObject({
      id: root.id,
      status: 'processing',
      leaseOwner: 'root-worker',
      lockedAt: NOW,
      preparedAt: null,
      attempts: { gt: 0 },
    });
    expect(call.data).toMatchObject({
      status: 'pending',
      attempts: { decrement: 1 },
      leaseOwner: null,
      lockedAt: null,
      leaseExpiresAt: null,
    });
    expect((call.data.availableAt as Date).getTime()).toBe(NOW.getTime() + 6_000);
  });

  it('active processing lease 已过期时仍从 now 加完整 BASE，不退化为 now+1 busy loop', async () => {
    const f = build();
    const root = row({
      id: 'cm00000000000000000000010',
      eventType: 'notification.wechat-broadcast',
      status: 'processing',
      attempts: 1,
      leaseOwner: 'root-worker',
      lockedAt: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 30_000),
    }) as ClaimedNotificationOutboxIntent;
    const active = row({
      id: 'cm00000000000000000000011',
      eventType: 'notification.wechat-delivery',
      status: 'processing',
      attempts: 2,
      leaseOwner: 'expired-worker',
      lockedAt: new Date(NOW.getTime() - 10_000),
      leaseExpiresAt: new Date(NOW.getTime() - 5_000),
    });

    await expect(
      f.service.deferWechatBroadcast(
        root,
        new NotificationOutboxGenerationConflictError(active),
        NOW,
      ),
    ).resolves.toBeUndefined();
    const [call] = f.updateMany.mock.calls.at(-1) as unknown as [UpdateManyCall];
    expect((call.data.availableAt as Date).getTime()).toBe(NOW.getTime() + 1_000);
  });

  it('cross-generation root 任一 prepare marker 非空都禁止 defer，避免制造 pending 半状态', async () => {
    const f = build();
    const root = row({
      eventType: 'notification.wechat-broadcast',
      status: 'processing',
      attempts: 1,
      leaseOwner: 'root-worker',
      lockedAt: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 30_000),
      preparedTemplateId: 'unexpected-template',
    }) as ClaimedNotificationOutboxIntent;
    const active = row({
      eventType: 'notification.wechat-delivery',
      status: 'processing',
      leaseOwner: 'child-worker',
      lockedAt: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 5_000),
    });

    await expect(
      f.service.deferWechatBroadcast(
        root,
        new NotificationOutboxGenerationConflictError(active),
        NOW,
      ),
    ).rejects.toBeInstanceOf(NotificationOutboxInvariantError);
    expect(f.updateMany).not.toHaveBeenCalled();
  });

  it('provider permission 固定先 SHARE parent 再 UPDATE intent，并返回同一 generation 快照', async () => {
    const f = build();
    const claimed = row({
      status: 'processing',
      attempts: 1,
      leaseOwner: 'worker',
      lockedAt: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 30_000),
    }) as ClaimedNotificationOutboxIntent;
    const notification = {
      id: NOTIFICATION_1,
      deletedAt: null,
      statusCode: 'published',
      sourceType: 'admin',
      audienceType: 'broadcast',
      publishGeneration: 3,
      channels: ['in-app', 'wechat'],
    };
    f.queryRaw.mockResolvedValueOnce([notification]).mockResolvedValueOnce([{ id: claimed.id }]);
    f.findFirst.mockResolvedValueOnce({ id: claimed.id });

    await expect(
      f.service.authorizeAdminNotificationEffect(claimed, NOTIFICATION_1, 3, 'wechat', NOW),
    ).resolves.toBe(notification);
    const sql = f.queryRaw.mock.calls.map(([query]) => query.strings.join(' '));
    expect(sql[0]).toContain('FROM "notifications"');
    expect(sql[0]).toContain('FOR SHARE');
    expect(sql[0]).not.toContain('FOR UPDATE');
    expect(sql[1]).toContain('FROM "notification_outbox_intents"');
    expect(sql[1]).toContain('FOR UPDATE');
  });

  it('recipient permission 在 parent→intent→fence 之后消费同一 tx；false 拒绝 Effect', async () => {
    const f = build();
    const claimed = row({
      status: 'processing',
      attempts: 1,
      leaseOwner: 'worker',
      lockedAt: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 30_000),
    }) as ClaimedNotificationOutboxIntent;
    const notification = {
      id: NOTIFICATION_1,
      deletedAt: null,
      statusCode: 'published',
      sourceType: 'admin',
      audienceType: 'broadcast',
      publishGeneration: 3,
      channels: ['in-app', 'wechat'],
    };
    f.queryRaw.mockResolvedValueOnce([notification]).mockResolvedValueOnce([{ id: claimed.id }]);
    f.findFirst.mockResolvedValueOnce({ id: claimed.id });
    const authorizeRecipient = jest.fn((tx: unknown, lockedNotification: unknown) => {
      expect(tx).toBe(f.tx);
      expect(lockedNotification).toBe(notification);
      expect(f.queryRaw).toHaveBeenCalledTimes(2);
      expect(f.findFirst).toHaveBeenCalledTimes(1);
      return Promise.resolve(false);
    });

    await expect(
      f.service.authorizeAdminNotificationEffect(
        claimed,
        NOTIFICATION_1,
        3,
        'wechat',
        NOW,
        authorizeRecipient,
      ),
    ).resolves.toBeNull();
    expect(authorizeRecipient).toHaveBeenCalledTimes(1);
  });

  it('recipient permission/parent DB error 原样冒泡，不归一为 terminal skip', async () => {
    const claimed = row({
      status: 'processing',
      attempts: 1,
      leaseOwner: 'worker',
      lockedAt: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 30_000),
    }) as ClaimedNotificationOutboxIntent;
    const callbackError = new Error('recipient permission database unavailable');
    const callbackFixture = build();
    callbackFixture.queryRaw
      .mockResolvedValueOnce([
        {
          id: NOTIFICATION_1,
          deletedAt: null,
          statusCode: 'published',
          sourceType: 'admin',
          audienceType: 'broadcast',
          publishGeneration: 3,
          channels: ['wechat'],
        },
      ])
      .mockResolvedValueOnce([{ id: claimed.id }]);
    callbackFixture.findFirst.mockResolvedValueOnce({ id: claimed.id });
    await expect(
      callbackFixture.service.authorizeAdminNotificationEffect(
        claimed,
        NOTIFICATION_1,
        3,
        'wechat',
        NOW,
        () => Promise.reject(callbackError),
      ),
    ).rejects.toBe(callbackError);

    const parentError = new Error('parent lock database unavailable');
    const parentFixture = build();
    parentFixture.queryRaw.mockRejectedValueOnce(parentError);
    const authorizeRecipient = jest.fn();
    await expect(
      parentFixture.service.authorizeAdminNotificationEffect(
        claimed,
        NOTIFICATION_1,
        3,
        'wechat',
        NOW,
        authorizeRecipient,
      ),
    ).rejects.toBe(parentError);
    expect(authorizeRecipient).not.toHaveBeenCalled();
  });

  it.each([
    ['phone', '说明 13900000001 请勿外传'],
    ['JWT', '说明 eyJabc123.def456.ghi789 请勿外传'],
    ['Bearer', '请用 Bearer abcdefghijklmnop'],
    ['sk', '请用 sk-abcdefghijklmnop'],
    ['AKID', '请用 AKIDabcdefghijklmnop'],
    ['openid', '内嵌 oOpaqueOpenidValue123456789'],
    ['COS V5 URL', '下载 https://cos.example/x?q-signature=abc&q-ak=AKID123'],
    ['AWS URL', '下载 https://s3.example/x?X-Amz-Signature=abc&x=1'],
  ])('targeted/system exact-shape 会 canonical redact %s 且二跑幂等', (_name, sensitive) => {
    const targeted = normalizeNotificationOutboxInput({
      eventKey: `targeted:${MEMBER_1}`,
      eventType: 'notification.targeted',
      payloadVersion: 1,
      payload: {
        recipientMemberId: MEMBER_1,
        notificationTypeCode: 'activity-reminder',
        title: `活动 ${sensitive}`,
        body: `正文 ${sensitive}`,
        channels: ['wechat', 'in-app', 'wechat'],
      },
      aggregateType: 'activity',
      aggregateId: NOTIFICATION_1,
      destinationType: 'member',
      destinationRef: MEMBER_1,
    });
    const system = normalizeNotificationOutboxInput({
      eventKey: `system:${NOTIFICATION_1}`,
      eventType: 'notification.system-broadcast',
      payloadVersion: 1,
      payload: {
        notificationTypeCode: 'expiry-reminder',
        title: `活动 ${sensitive}`,
        body: `正文 ${sensitive}`,
        visibilityCode: 'management',
      },
      aggregateType: 'activity',
      aggregateId: NOTIFICATION_1,
      destinationType: 'audience',
      destinationRef: NOTIFICATION_1,
    });
    const targetedPayload = targeted.payload as unknown as TargetedNotificationOutboxPayload;
    expect(targetedPayload.title).toContain('[REDACTED]');
    expect(targetedPayload.body).toContain('[REDACTED]');
    expect(targetedPayload.channels).toEqual(['in-app', 'wechat']);
    const systemPayload = system.payload as unknown as SystemBroadcastOutboxPayload;
    expect(systemPayload.title).toContain('[REDACTED]');
    expect(systemPayload.body).toContain('[REDACTED]');
    expect(normalizeNotificationOutboxInput(targeted)).toEqual(targeted);
    expect(normalizeNotificationOutboxInput(system)).toEqual(system);
  });

  it('safe URL/design、普通 token/secret/openid 词、日期/CUID/活动名逐字不变；空渠道补 in-app', () => {
    const safe =
      '山野训练 2026-07-18 ' +
      `${MEMBER_1} token secret openid https://example.test/page?design=blue&tokenize=yes`;
    expect(redactNotificationOutboxText(safe)).toBe(safe);
    const normalized = normalizeNotificationOutboxInput({
      eventKey: `targeted-safe:${MEMBER_1}`,
      eventType: 'notification.targeted',
      payloadVersion: 1,
      payload: {
        recipientMemberId: MEMBER_1,
        notificationTypeCode: 'activity-reminder',
        title: safe,
        body: safe,
        channels: [],
      },
      aggregateType: 'activity',
      aggregateId: NOTIFICATION_1,
      destinationType: 'member',
      destinationRef: MEMBER_1,
    });
    expect(normalized.payload).toMatchObject({ title: safe, body: safe, channels: ['in-app'] });
  });

  it('strict metadata/extra payload/unknown type 仍 fail-closed', async () => {
    const f = build();
    const forbidden = [
      input({ phone: '13900000001' }),
      { ...input(), eventKey: 'phone:13900000001' },
      { ...input(), aggregateType: 'credential' },
      { ...input(), aggregateId: '13900000001' },
      { ...input(), destinationType: 'openid' },
      { ...input(), destinationRef: '13900000001' },
      { ...input(), eventType: 'notification.unknown' },
    ];
    for (const candidate of forbidden) {
      await expect(f.service.enqueue(candidate)).rejects.toBeInstanceOf(
        NotificationOutboxInvariantError,
      );
    }
    expect(f.createMany).not.toHaveBeenCalled();
  });

  it.each([
    [
      'targeted destination',
      {
        eventKey: `targeted:${MEMBER_1}`,
        eventType: 'notification.targeted',
        payloadVersion: 1,
        payload: {
          recipientMemberId: MEMBER_1,
          notificationTypeCode: 'general',
          title: 'title',
          body: 'body',
          channels: ['in-app'],
        },
        aggregateType: 'notification',
        aggregateId: NOTIFICATION_1,
        destinationType: 'member',
        destinationRef: MEMBER_2,
      },
    ],
    [
      'wechat root aggregate',
      {
        eventKey: `wechat-broadcast:${NOTIFICATION_1}:1`,
        eventType: 'notification.wechat-broadcast',
        payloadVersion: 2,
        payload: { notificationId: NOTIFICATION_1, publishGeneration: 1 },
        aggregateType: 'notification',
        aggregateId: MEMBER_2,
        destinationType: 'broadcast',
        destinationRef: NOTIFICATION_1,
      },
    ],
    [
      'wechat root destination',
      {
        eventKey: `wechat-broadcast:${NOTIFICATION_1}:1`,
        eventType: 'notification.wechat-broadcast',
        payloadVersion: 2,
        payload: { notificationId: NOTIFICATION_1, publishGeneration: 1 },
        aggregateType: 'notification',
        aggregateId: NOTIFICATION_1,
        destinationType: 'broadcast',
        destinationRef: MEMBER_2,
      },
    ],
    [
      'wechat child aggregate',
      {
        eventKey: `wechat-delivery:${NOTIFICATION_1}:cm00000000000000000000004:${MEMBER_1}`,
        eventType: 'notification.wechat-delivery',
        payloadVersion: 2,
        payload: { notificationId: NOTIFICATION_1, memberId: MEMBER_1, publishGeneration: 1 },
        aggregateType: 'notification',
        aggregateId: MEMBER_2,
        destinationType: 'member',
        destinationRef: MEMBER_1,
      },
    ],
    [
      'wechat child destination',
      {
        eventKey: `wechat-delivery:${NOTIFICATION_1}:cm00000000000000000000004:${MEMBER_1}`,
        eventType: 'notification.wechat-delivery',
        payloadVersion: 2,
        payload: { notificationId: NOTIFICATION_1, memberId: MEMBER_1, publishGeneration: 1 },
        aggregateType: 'notification',
        aggregateId: NOTIFICATION_1,
        destinationType: 'member',
        destinationRef: MEMBER_2,
      },
    ],
    [
      'birthday aggregate',
      {
        eventKey: `birthday-sms:2026-07-18:${MEMBER_1}`,
        eventType: 'notification.birthday-sms',
        payloadVersion: 1,
        payload: { memberId: MEMBER_1, dateKey: '2026-07-18' },
        aggregateType: 'member',
        aggregateId: MEMBER_2,
        destinationType: 'member',
        destinationRef: MEMBER_1,
      },
    ],
    [
      'birthday destination',
      {
        eventKey: `birthday-sms:2026-07-18:${MEMBER_1}`,
        eventType: 'notification.birthday-sms',
        payloadVersion: 1,
        payload: { memberId: MEMBER_1, dateKey: '2026-07-18' },
        aggregateType: 'member',
        aggregateId: MEMBER_1,
        destinationType: 'member',
        destinationRef: MEMBER_2,
      },
    ],
    ['admin SMS aggregate', { ...input(), aggregateId: MEMBER_2 }],
    ['admin SMS destination', { ...input(), destinationRef: MEMBER_2 }],
  ])('%s envelope/payload 错位在 producer 与 raw stored 两条入口都 fail-closed', (_name, body) => {
    const candidate: NotificationOutboxEnqueueInput = body;
    expect(() => normalizeNotificationOutboxInput(candidate)).toThrow(
      NotificationOutboxInvariantError,
    );
    expect(() => assertStoredNotificationOutboxIntentSafe(candidate)).toThrow(
      NotificationOutboxInvariantError,
    );
  });

  it.each([
    [
      'wechat root key',
      {
        eventKey: `wechat-broadcast:${NOTIFICATION_1}:2`,
        eventType: 'notification.wechat-broadcast',
        payloadVersion: 2,
        payload: { notificationId: NOTIFICATION_1, publishGeneration: 1 },
        aggregateType: 'notification',
        aggregateId: NOTIFICATION_1,
        destinationType: 'broadcast',
        destinationRef: NOTIFICATION_1,
      },
    ],
    [
      'wechat root type',
      {
        eventKey: `wechat-broadcast:${NOTIFICATION_1}:1`,
        eventType: 'notification.wechat-broadcast',
        payloadVersion: 2,
        payload: { notificationId: NOTIFICATION_1, publishGeneration: 1 },
        aggregateType: 'notification',
        aggregateId: NOTIFICATION_1,
        destinationType: 'member',
        destinationRef: NOTIFICATION_1,
      },
    ],
    [
      'v1 wechat child key',
      {
        eventKey: `wechat-delivery:${NOTIFICATION_1}:cm00000000000000000000004:${MEMBER_1}`,
        eventType: 'notification.wechat-delivery',
        payloadVersion: 1,
        payload: { notificationId: NOTIFICATION_1, memberId: MEMBER_1 },
        aggregateType: 'notification',
        aggregateId: NOTIFICATION_1,
        destinationType: 'member',
        destinationRef: MEMBER_1,
      },
    ],
    [
      'v1 wechat child key notificationId',
      {
        eventKey: `wechat-delivery:${MEMBER_2}:${MEMBER_1}`,
        eventType: 'notification.wechat-delivery',
        payloadVersion: 1,
        payload: { notificationId: NOTIFICATION_1, memberId: MEMBER_1 },
        aggregateType: 'notification',
        aggregateId: NOTIFICATION_1,
        destinationType: 'member',
        destinationRef: MEMBER_1,
      },
    ],
    [
      'v1 wechat child key memberId',
      {
        eventKey: `wechat-delivery:${NOTIFICATION_1}:${MEMBER_2}`,
        eventType: 'notification.wechat-delivery',
        payloadVersion: 1,
        payload: { notificationId: NOTIFICATION_1, memberId: MEMBER_1 },
        aggregateType: 'notification',
        aggregateId: NOTIFICATION_1,
        destinationType: 'member',
        destinationRef: MEMBER_1,
      },
    ],
    [
      'v2 wechat child middle',
      {
        eventKey: `wechat-delivery:${NOTIFICATION_1}:not-a-cuid:${MEMBER_1}`,
        eventType: 'notification.wechat-delivery',
        payloadVersion: 2,
        payload: { notificationId: NOTIFICATION_1, memberId: MEMBER_1, publishGeneration: 1 },
        aggregateType: 'notification',
        aggregateId: NOTIFICATION_1,
        destinationType: 'member',
        destinationRef: MEMBER_1,
      },
    ],
    [
      'v2 wechat child key notificationId',
      {
        eventKey: `wechat-delivery:${MEMBER_2}:cm00000000000000000000004:${MEMBER_1}`,
        eventType: 'notification.wechat-delivery',
        payloadVersion: 2,
        payload: { notificationId: NOTIFICATION_1, memberId: MEMBER_1, publishGeneration: 1 },
        aggregateType: 'notification',
        aggregateId: NOTIFICATION_1,
        destinationType: 'member',
        destinationRef: MEMBER_1,
      },
    ],
    [
      'v2 wechat child key memberId',
      {
        eventKey: `wechat-delivery:${NOTIFICATION_1}:cm00000000000000000000004:${MEMBER_2}`,
        eventType: 'notification.wechat-delivery',
        payloadVersion: 2,
        payload: { notificationId: NOTIFICATION_1, memberId: MEMBER_1, publishGeneration: 1 },
        aggregateType: 'notification',
        aggregateId: NOTIFICATION_1,
        destinationType: 'member',
        destinationRef: MEMBER_1,
      },
    ],
    [
      'wechat child type',
      {
        eventKey: `wechat-delivery:${NOTIFICATION_1}:cm00000000000000000000004:${MEMBER_1}`,
        eventType: 'notification.wechat-delivery',
        payloadVersion: 2,
        payload: { notificationId: NOTIFICATION_1, memberId: MEMBER_1, publishGeneration: 1 },
        aggregateType: 'member',
        aggregateId: NOTIFICATION_1,
        destinationType: 'member',
        destinationRef: MEMBER_1,
      },
    ],
    [
      'birthday key',
      {
        eventKey: `birthday-sms:2026-07-19:${MEMBER_1}`,
        eventType: 'notification.birthday-sms',
        payloadVersion: 1,
        payload: { memberId: MEMBER_1, dateKey: '2026-07-18' },
        aggregateType: 'member',
        aggregateId: MEMBER_1,
        destinationType: 'member',
        destinationRef: MEMBER_1,
      },
    ],
    [
      'birthday type',
      {
        eventKey: `birthday-sms:2026-07-18:${MEMBER_1}`,
        eventType: 'notification.birthday-sms',
        payloadVersion: 1,
        payload: { memberId: MEMBER_1, dateKey: '2026-07-18' },
        aggregateType: 'notification',
        aggregateId: MEMBER_1,
        destinationType: 'member',
        destinationRef: MEMBER_1,
      },
    ],
    ['admin SMS key', { ...input(), eventKey: `admin-sms:${NOTIFICATION_1}:not-uuid:${MEMBER_1}` }],
    [
      'admin SMS key nil UUID',
      {
        ...input(),
        eventKey: `admin-sms:${NOTIFICATION_1}:00000000-0000-0000-0000-000000000000:${MEMBER_1}`,
      },
    ],
    [
      'admin SMS key UUID v1',
      {
        ...input(),
        eventKey: `admin-sms:${NOTIFICATION_1}:00000000-0000-1000-8000-000000000001:${MEMBER_1}`,
      },
    ],
    [
      'admin SMS key UUID v7',
      {
        ...input(),
        eventKey: `admin-sms:${NOTIFICATION_1}:00000000-0000-7000-8000-000000000001:${MEMBER_1}`,
      },
    ],
    [
      'admin SMS key UUID bad variant',
      {
        ...input(),
        eventKey: `admin-sms:${NOTIFICATION_1}:00000000-0000-4000-7000-000000000001:${MEMBER_1}`,
      },
    ],
    [
      'admin SMS key notificationId',
      {
        ...input(),
        eventKey: `admin-sms:${MEMBER_2}:${GENERATION_1}:${MEMBER_1}`,
      },
    ],
    [
      'admin SMS key memberId',
      {
        ...input(),
        eventKey: `admin-sms:${NOTIFICATION_1}:${GENERATION_1}:${MEMBER_2}`,
      },
    ],
    ['admin SMS type', { ...input(), destinationType: 'broadcast' }],
  ])('%s 错误在 producer 与 raw stored 两条入口都 fail-closed', (_name, candidate) => {
    expect(() => normalizeNotificationOutboxInput(candidate)).toThrow(
      NotificationOutboxInvariantError,
    );
    expect(() => assertStoredNotificationOutboxIntentSafe(candidate)).toThrow(
      NotificationOutboxInvariantError,
    );
  });

  it('expired 第 8 次 processing 先原子 dead，claim 查询不得返回第 9 次 Effect', async () => {
    const f = build();
    await expect(f.service.claim('worker-2', { now: NOW })).resolves.toEqual([]);
    const [reaper] = (f.updateMany.mock.calls as Array<[UpdateManyCall]>)[0];
    expect(reaper.where).toMatchObject({
      status: 'processing',
      attempts: { gte: 8 },
      leaseExpiresAt: { not: null, lte: NOW },
    });
    expect(reaper.data).toMatchObject({ status: 'dead', deadAt: NOW, completedAt: NOW });
    expect(f.queryRaw).toHaveBeenCalledTimes(1);
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it('首次 prepare 原子持久化稳定 template，并只向本次调用返回退款 capability', async () => {
    const f = build();
    const intent = row({
      status: 'processing',
      attempts: 1,
      leaseOwner: 'worker-1',
      lockedAt: NOW,
    }) as ClaimedNotificationOutboxIntent;
    const prepare = jest.fn().mockResolvedValue(undefined);
    const preparation = await f.service.markPrepared(intent, 'template-a', prepare, NOW);
    expect(preparation).toMatchObject({ templateId: 'template-a', preparedNow: true });
    expect(preparation.refundCapability).not.toBeNull();
    expect(prepare).toHaveBeenCalledWith(f.tx, 'template-a');
    const [markerWrite] = f.updateMany.mock.calls.at(-1) as unknown as [UpdateManyCall];
    expect(markerWrite.where).toMatchObject({ preparedAt: null, preparedTemplateId: null });
    expect(markerWrite.data).toEqual({ preparedAt: NOW, preparedTemplateId: 'template-a' });
  });

  it('重领只返回持久化 template A，不读取/采用当前请求 B，也无退款 capability', async () => {
    const f = build();
    const intent = row({
      status: 'processing',
      attempts: 2,
      leaseOwner: 'worker-2',
      lockedAt: NOW,
      preparedAt: NOW,
      preparedTemplateId: 'template-a',
    }) as ClaimedNotificationOutboxIntent;
    f.findFirst.mockResolvedValue({ preparedAt: NOW, preparedTemplateId: 'template-a' });
    const prepare = jest.fn();

    await expect(f.service.markPrepared(intent, 'template-b', prepare, NOW)).resolves.toEqual({
      templateId: 'template-a',
      preparedNow: false,
      refundCapability: null,
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each([
    [{ preparedAt: NOW, preparedTemplateId: null }],
    [{ preparedAt: null, preparedTemplateId: 'template-a' }],
  ])('prepare 半状态 fail-closed，callback 与 marker 写均为 0', async (current) => {
    const f = build();
    const intent = row({
      status: 'processing',
      attempts: 1,
      leaseOwner: 'worker-1',
      lockedAt: NOW,
    }) as ClaimedNotificationOutboxIntent;
    f.findFirst.mockResolvedValue(current);
    const prepare = jest.fn();

    await expect(f.service.markPrepared(intent, 'template-a', prepare, NOW)).rejects.toBeInstanceOf(
      NotificationOutboxInvariantError,
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(f.updateMany).not.toHaveBeenCalled();
  });

  it('退款 capability 单次消费；旧 attempt/伪 capability 均不能进入补偿事务', async () => {
    const f = build();
    const intent = row({
      status: 'processing',
      attempts: 1,
      leaseOwner: 'worker-1',
      lockedAt: NOW,
    }) as ClaimedNotificationOutboxIntent;
    const preparation = await f.service.markPrepared(
      intent,
      'template-a',
      jest.fn().mockResolvedValue(undefined),
      NOW,
    );
    f.findFirst.mockResolvedValue({ preparedAt: NOW, preparedTemplateId: 'template-a' });
    f.updateMany.mockClear();
    const refund = jest.fn().mockResolvedValue(true);

    const transactionCallsBeforeWrongIntent = f.prisma.$transaction.mock.calls.length;
    await expect(
      f.service.refundPrepared({ ...intent, id: 'different-intent' }, preparation, refund),
    ).rejects.toBeInstanceOf(NotificationOutboxInvariantError);
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(transactionCallsBeforeWrongIntent);

    await expect(f.service.refundPrepared(intent, preparation, refund)).resolves.toBeUndefined();
    expect(refund).toHaveBeenCalledWith(f.tx, 'template-a');
    const [markerClear] = f.updateMany.mock.calls.at(-1) as unknown as [UpdateManyCall];
    expect(markerClear.where).toMatchObject({
      preparedAt: NOW,
      preparedTemplateId: 'template-a',
    });
    expect(markerClear.data).toEqual({ preparedAt: null, preparedTemplateId: null });

    const transactionCalls = f.prisma.$transaction.mock.calls.length;
    await expect(f.service.refundPrepared(intent, preparation, refund)).rejects.toBeInstanceOf(
      NotificationOutboxInvariantError,
    );
    await expect(
      f.service.refundPrepared(
        intent,
        { templateId: 'template-a', preparedNow: false, refundCapability: null },
        refund,
      ),
    ).rejects.toBeInstanceOf(NotificationOutboxInvariantError);
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(transactionCalls);
  });

  it('退款未精确恢复 quota 时事务在清 marker 前 fail-closed', async () => {
    const f = build();
    const intent = row({
      status: 'processing',
      attempts: 1,
      leaseOwner: 'worker-1',
      lockedAt: NOW,
    }) as ClaimedNotificationOutboxIntent;
    const preparation = await f.service.markPrepared(
      intent,
      'template-a',
      jest.fn().mockResolvedValue(undefined),
      NOW,
    );
    f.findFirst.mockResolvedValue({ preparedAt: NOW, preparedTemplateId: 'template-a' });
    f.updateMany.mockClear();

    await expect(
      f.service.refundPrepared(intent, preparation, jest.fn().mockResolvedValue(false)),
    ).rejects.toBeInstanceOf(NotificationOutboxInvariantError);
    expect(f.updateMany).not.toHaveBeenCalled();
  });

  it('退款 final fence 失败不消费 capability，同一调用可在事务回滚后重试', async () => {
    const f = build();
    const intent = row({
      status: 'processing',
      attempts: 1,
      leaseOwner: 'worker-1',
      lockedAt: NOW,
    }) as ClaimedNotificationOutboxIntent;
    const preparation = await f.service.markPrepared(
      intent,
      'template-a',
      jest.fn().mockResolvedValue(undefined),
      NOW,
    );
    f.findFirst.mockResolvedValue({ preparedAt: NOW, preparedTemplateId: 'template-a' });
    f.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    const refund = jest.fn().mockResolvedValue(true);

    await expect(f.service.refundPrepared(intent, preparation, refund)).rejects.toBeInstanceOf(
      NotificationOutboxLeaseLostError,
    );
    await expect(f.service.refundPrepared(intent, preparation, refund)).resolves.toBeUndefined();
    expect(refund).toHaveBeenCalledTimes(2);
  });

  it('admin SMS transaction 只创建 pending/attempts=0 且 lease 全空的 durable command', async () => {
    const f = build();
    await expect(f.service.reserveAdminSmsAttempt(input(), f.tx as never)).resolves.toMatchObject({
      state: 'reserved',
      intent: {
        status: 'pending',
        attempts: 0,
        leaseOwner: null,
        lockedAt: null,
        leaseExpiresAt: null,
      },
    });
    expect(f.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            status: 'pending',
            attempts: 0,
            leaseOwner: null,
            lockedAt: null,
            leaseExpiresAt: null,
          }),
        ],
      }),
    );
  });

  it('renewLease 保留终身 lockedAt fence，只在完整 CAS 下延长 leaseExpiresAt', async () => {
    const f = build();
    const intent = row({
      status: 'processing',
      attempts: 1,
      leaseOwner: 'worker-1',
      lockedAt: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 30_000),
    }) as ClaimedNotificationOutboxIntent;
    const renewAt = new Date(NOW.getTime() + 10_000);
    const nextExpiry = new Date(renewAt.getTime() + 30_000);

    await expect(f.service.renewLease(intent, renewAt, 30_000)).resolves.toMatchObject({
      lockedAt: NOW,
      leaseExpiresAt: nextExpiry,
    });
    const [renew] = (f.updateMany.mock.calls as Array<[UpdateManyCall]>).at(-1)!;
    expect(renew.where).toMatchObject({
      id: intent.id,
      status: 'processing',
      leaseOwner: 'worker-1',
      lockedAt: NOW,
      leaseExpiresAt: { not: null, gt: renewAt },
    });
    expect(renew.data).toEqual({ leaseExpiresAt: nextExpiry });
    expect(renew.data).not.toHaveProperty('lockedAt');
  });

  it('第 8 次失败直接 dead；此前失败清 lease 并指数退避回 pending', async () => {
    const f = build();
    const first = row({
      status: 'processing',
      attempts: 1,
      leaseOwner: 'worker-1',
      lockedAt: NOW,
    }) as ClaimedNotificationOutboxIntent;
    await expect(f.service.nack(first, new Error('transient'), NOW)).resolves.toBe('pending');
    const [pending] = (f.updateMany.mock.calls as Array<[UpdateManyCall]>).at(-1)!;
    expect(pending.data).toMatchObject({
      status: 'pending',
      availableAt: new Date(NOW.getTime() + 1000),
      leaseOwner: null,
    });

    const eighth = { ...first, attempts: 8 };
    await expect(f.service.nack(eighth, new Error('terminal'), NOW)).resolves.toBe('dead');
    const [dead] = (f.updateMany.mock.calls as Array<[UpdateManyCall]>).at(-1)!;
    expect(dead.data).toMatchObject({ status: 'dead', deadAt: NOW, completedAt: NOW });
  });
});
