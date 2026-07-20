import {
  Prisma,
  Role,
  type Notification,
  type NotificationOutboxIntent,
  UserStatus,
} from '@prisma/client';

import {
  NotificationOutboxHandlers,
  UnsupportedNotificationOutboxEventError,
} from './notification-outbox.handlers';
import type { ClaimedNotificationOutboxIntent } from './notification-outbox.service';
import { parseKnownNotificationOutboxPayload } from './notification-outbox.types';
import { NotificationWechatDispatchService } from './notification-wechat-dispatch.service';

const NOW = new Date('2026-07-18T00:00:00.000Z');
const ALLOW_EFFECT = { beforeEffect: () => Promise.resolve() };
const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const ROOT_ID = 'cm00000000000000000000008';

function intent(payload: unknown): ClaimedNotificationOutboxIntent {
  return {
    id: 'cm00000000000000000000009',
    eventKey: `admin-sms:cm00000000000000000000001:${REQUEST_ID}:cm00000000000000000000002`,
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
    preparedTemplateId: null,
    sentAt: null,
    completedAt: null,
    lastErrorCode: null,
    lastErrorClass: null,
    deadAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function adminIntent(payload: {
  notificationId: string;
  memberId: string;
}): ClaimedNotificationOutboxIntent {
  return {
    ...intent({ ...payload, publishGeneration: 1 }),
    payloadVersion: 2,
    payload: { ...payload, publishGeneration: 1 },
  };
}

function rootIntent(overrides: Partial<NotificationOutboxIntent> = {}): NotificationOutboxIntent {
  return {
    ...intent({}),
    id: ROOT_ID,
    eventKey: 'wechat-broadcast:cm00000000000000000000001:1',
    eventType: 'notification.wechat-broadcast',
    payloadVersion: 2,
    payload: {
      notificationId: 'cm00000000000000000000001',
      publishGeneration: 1,
    },
    aggregateType: 'notification',
    aggregateId: 'cm00000000000000000000001',
    destinationType: 'broadcast',
    destinationRef: 'cm00000000000000000000001',
    ...overrides,
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
    await expect(handlers.execute(intent(payload), ALLOW_EFFECT)).rejects.toBeInstanceOf(
      UnsupportedNotificationOutboxEventError,
    );
  });

  it('合法形状 v1 admin SMS 仍 fail-closed terminal，绝不进入 permission/provider', async () => {
    const outbox = { authorizeAdminNotificationEffect: jest.fn() };
    const smsDispatch = { dispatchRecipient: jest.fn() };
    const guarded = new NotificationOutboxHandlers(
      {} as never,
      outbox as never,
      {} as never,
      {} as never,
      smsDispatch as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      guarded.execute(
        intent({
          notificationId: 'cm00000000000000000000001',
          memberId: 'cm00000000000000000000002',
        }),
        ALLOW_EFFECT,
      ),
    ).rejects.toBeInstanceOf(UnsupportedNotificationOutboxEventError);
    expect(outbox.authorizeAdminNotificationEffect).not.toHaveBeenCalled();
    expect(smsDispatch.dispatchRecipient).not.toHaveBeenCalled();
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
    await expect(guarded.execute(raw, ALLOW_EFFECT)).rejects.toBeInstanceOf(
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
    await expect(targeted.execute(source, ALLOW_EFFECT)).resolves.toMatchObject({
      effectPerformed: true,
    });
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

  it('微信 deep provider guard 失败时零外发且不写 delivery evidence', async () => {
    const leaseLost = new Error('lease lost before wechat provider');
    const beforeEffect = jest.fn().mockRejectedValue(leaseLost);
    const prisma = {
      notification: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'cm00000000000000000000001',
          notificationTypeCode: 'general',
          title: 'guarded title',
          body: 'guarded body',
          publishedAt: NOW,
          deletedAt: null,
          sourceType: 'system',
          statusCode: 'published',
          audienceType: 'directed',
          recipientMemberId: 'cm00000000000000000000002',
          channels: ['in-app', 'wechat'],
        }),
      },
      notificationDelivery: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        createMany: jest.fn(),
      },
      member: { findFirst: jest.fn().mockResolvedValue({ id: 'cm00000000000000000000002' }) },
      user: { findFirst: jest.fn().mockResolvedValue({ openid: 'dev-openid' }) },
      $transaction: jest.fn(),
    };
    const outbox = {
      markPrepared: jest.fn().mockResolvedValue({
        templateId: 'template-1',
        preparedNow: true,
        refundCapability: {},
      }),
    };
    const wechat = {
      sendSubscribeMessage: jest.fn(
        async (_input: unknown, deepBeforeEffect?: () => Promise<void>) => {
          await deepBeforeEffect?.();
          return { ok: true, msgId: 'must-not-exist' };
        },
      ),
    };
    const templates = { getEnabledTemplateId: jest.fn().mockResolvedValue('template-1') };
    const guarded = new NotificationOutboxHandlers(
      prisma as never,
      outbox as never,
      {} as never,
      {} as never,
      {} as never,
      wechat as never,
      templates as never,
      {} as never,
    );
    const source = {
      ...intent({}),
      eventKey: 'wechat-delivery:cm00000000000000000000001:cm00000000000000000000002',
      eventType: 'notification.wechat-delivery',
      payload: {
        notificationId: 'cm00000000000000000000001',
        memberId: 'cm00000000000000000000002',
      },
    };

    await expect(guarded.execute(source, { beforeEffect })).rejects.toBe(leaseLost);
    expect(beforeEffect).toHaveBeenCalledTimes(1);
    expect(wechat.sendSubscribeMessage).toHaveBeenCalledWith(
      expect.objectContaining({ openid: 'dev-openid', templateId: 'template-1' }),
      beforeEffect,
    );
    expect(prisma.notificationDelivery.createMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['broadcast audience', { audienceType: 'broadcast' }],
    ['recipient mismatch', { recipientMemberId: 'cm00000000000000000000003' }],
    ['wechat channel missing', { channels: ['in-app'] }],
  ])('v1 system child %s 时 terminal，template/quota/provider 均为 0', async (_name, override) => {
    const notification = {
      id: 'cm00000000000000000000001',
      notificationTypeCode: 'general',
      title: 'title',
      body: 'body',
      publishedAt: NOW,
      deletedAt: null,
      sourceType: 'system',
      statusCode: 'published',
      audienceType: 'directed',
      recipientMemberId: 'cm00000000000000000000002',
      channels: ['in-app', 'wechat'],
      ...override,
    };
    const prisma = { notification: { findUnique: jest.fn().mockResolvedValue(notification) } };
    const outbox = { markPrepared: jest.fn() };
    const wechat = { sendSubscribeMessage: jest.fn() };
    const templates = { getEnabledTemplateId: jest.fn() };
    const guarded = new NotificationOutboxHandlers(
      prisma as never,
      outbox as never,
      {} as never,
      {} as never,
      {} as never,
      wechat as never,
      templates as never,
      {} as never,
    );
    const source = {
      ...intent({}),
      eventKey: 'wechat-delivery:cm00000000000000000000001:cm00000000000000000000002',
      eventType: 'notification.wechat-delivery',
      payload: {
        notificationId: 'cm00000000000000000000001',
        memberId: 'cm00000000000000000000002',
      },
    };

    await expect(guarded.execute(source, ALLOW_EFFECT)).rejects.toBeInstanceOf(
      UnsupportedNotificationOutboxEventError,
    );
    expect(templates.getEnabledTemplateId).not.toHaveBeenCalled();
    expect(outbox.markPrepared).not.toHaveBeenCalled();
    expect(wechat.sendSubscribeMessage).not.toHaveBeenCalled();
  });

  it.each([
    [{ preparedAt: NOW, preparedTemplateId: null }],
    [{ preparedAt: null, preparedTemplateId: 'template-a' }],
  ])('微信 prepare 半状态在任何 DB/template/provider 前 fail-closed', async (marker) => {
    const prisma = { notification: { findUnique: jest.fn() } };
    const templates = { getEnabledTemplateId: jest.fn() };
    const wechat = { sendSubscribeMessage: jest.fn() };
    const guarded = new NotificationOutboxHandlers(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      wechat as never,
      templates as never,
      {} as never,
    );
    const source = {
      ...intent({}),
      ...marker,
      eventKey: 'wechat-delivery:cm00000000000000000000001:cm00000000000000000000002',
      eventType: 'notification.wechat-delivery',
      payload: {
        notificationId: 'cm00000000000000000000001',
        memberId: 'cm00000000000000000000002',
      },
    };

    await expect(guarded.execute(source, ALLOW_EFFECT)).rejects.toBeInstanceOf(
      UnsupportedNotificationOutboxEventError,
    );
    expect(prisma.notification.findUnique).not.toHaveBeenCalled();
    expect(templates.getEnabledTemplateId).not.toHaveBeenCalled();
    expect(wechat.sendSubscribeMessage).not.toHaveBeenCalled();
  });

  it.each([
    [{ preparedAt: NOW, preparedTemplateId: null }],
    [{ preparedAt: null, preparedTemplateId: 'template-a' }],
  ])('v2 微信 prepare 半状态在 root DB/template/provider 前 fail-closed', async (marker) => {
    const outbox = { findByEventKey: jest.fn() };
    const templates = { getEnabledTemplateId: jest.fn() };
    const wechat = { sendSubscribeMessage: jest.fn() };
    const guarded = new NotificationOutboxHandlers(
      {} as never,
      outbox as never,
      {} as never,
      {} as never,
      {} as never,
      wechat as never,
      templates as never,
      {} as never,
    );
    const source = {
      ...adminIntent({
        notificationId: 'cm00000000000000000000001',
        memberId: 'cm00000000000000000000002',
      }),
      ...marker,
      eventKey: `wechat-delivery:cm00000000000000000000001:${ROOT_ID}:cm00000000000000000000002`,
      eventType: 'notification.wechat-delivery',
    };

    await expect(guarded.execute(source, ALLOW_EFFECT)).rejects.toBeInstanceOf(
      UnsupportedNotificationOutboxEventError,
    );
    expect(outbox.findByEventKey).not.toHaveBeenCalled();
    expect(templates.getEnabledTemplateId).not.toHaveBeenCalled();
    expect(wechat.sendSubscribeMessage).not.toHaveBeenCalled();
  });

  it('prepared retry 只用持久化 template A，当前 template B 不查询也不替换', async () => {
    const notification = {
      id: 'cm00000000000000000000001',
      notificationTypeCode: 'general',
      title: 'title',
      body: 'body',
      publishedAt: NOW,
      deletedAt: null,
      sourceType: 'system',
      statusCode: 'published',
      audienceType: 'directed',
      recipientMemberId: 'cm00000000000000000000002',
      channels: ['in-app', 'wechat'],
    };
    const prisma = {
      notification: { findUnique: jest.fn().mockResolvedValue(notification) },
      notificationDelivery: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      member: { findFirst: jest.fn().mockResolvedValue({ id: 'member' }) },
      user: { findFirst: jest.fn().mockResolvedValue({ openid: 'dev-openid' }) },
    };
    const outbox = {
      markPrepared: jest.fn().mockResolvedValue({
        templateId: 'template-a',
        preparedNow: false,
        refundCapability: null,
      }),
    };
    const wechat = {
      sendSubscribeMessage: jest.fn().mockResolvedValue({ ok: true, msgId: 'msg-1' }),
    };
    const templates = { getEnabledTemplateId: jest.fn().mockResolvedValue('template-b') };
    const guarded = new NotificationOutboxHandlers(
      prisma as never,
      outbox as never,
      {} as never,
      {} as never,
      {} as never,
      wechat as never,
      templates as never,
      {} as never,
    );
    const source = {
      ...intent({}),
      preparedAt: NOW,
      preparedTemplateId: 'template-a',
      eventKey: 'wechat-delivery:cm00000000000000000000001:cm00000000000000000000002',
      eventType: 'notification.wechat-delivery',
      payload: {
        notificationId: 'cm00000000000000000000001',
        memberId: 'cm00000000000000000000002',
      },
    };

    await expect(guarded.execute(source, ALLOW_EFFECT)).resolves.toMatchObject({
      effectPerformed: true,
    });
    expect(templates.getEnabledTemplateId).not.toHaveBeenCalled();
    expect(outbox.markPrepared).toHaveBeenCalledWith(source, 'template-a', expect.any(Function));
    expect(wechat.sendSubscribeMessage).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 'template-a' }),
      ALLOW_EFFECT.beforeEffect,
    );
  });

  it('v2 final permission 拒绝时只补偿本次精确 reservation，并在 provider 前清 prepare', async () => {
    const notification = {
      id: 'cm00000000000000000000001',
      notificationTypeCode: 'general',
      title: 'title',
      body: 'body',
      publishedAt: NOW,
      deletedAt: null,
      sourceType: 'admin',
      statusCode: 'published',
      audienceType: 'broadcast',
      publishGeneration: 1,
      channels: ['in-app', 'wechat'],
    };
    const quotaUpdate = jest
      .fn<
        Promise<{ count: number }>,
        [
          {
            where: Record<string, unknown>;
            data: { availableCount: { decrement?: number; increment?: number } };
          },
        ]
      >()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const tx = {
      wechatSubscriptionQuota: { updateMany: quotaUpdate },
      notificationDelivery: { createMany: jest.fn() },
    };
    const prisma = {
      notification: { findUnique: jest.fn().mockResolvedValue(notification) },
      notificationDelivery: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      member: { findFirst: jest.fn().mockResolvedValue({ id: 'member' }) },
      user: { findFirst: jest.fn().mockResolvedValue({ openid: 'dev-openid' }) },
    };
    const preparation = {
      templateId: 'template-a',
      preparedNow: true,
      refundCapability: {},
    };
    const outbox = {
      findByEventKey: jest.fn().mockResolvedValue(rootIntent()),
      markPrepared: jest.fn(
        async (
          _source: unknown,
          templateId: string,
          prepare: (client: typeof tx, stableTemplateId: string) => Promise<void>,
        ) => {
          await prepare(tx, templateId);
          return preparation;
        },
      ),
      authorizeAdminNotificationEffect: jest.fn().mockResolvedValue(null),
      refundPrepared: jest.fn(
        async (
          _source: unknown,
          result: typeof preparation,
          refund: (client: typeof tx, stableTemplateId: string) => Promise<boolean>,
        ) => {
          expect(await refund(tx, result.templateId)).toBe(true);
        },
      ),
    };
    const wechat = { sendSubscribeMessage: jest.fn() };
    const wechatDispatch = {
      authorizeDurableBroadcastRecipient: jest.fn().mockResolvedValue(null),
    };
    const guarded = new NotificationOutboxHandlers(
      prisma as never,
      outbox as never,
      {} as never,
      {} as never,
      {} as never,
      wechat as never,
      { getEnabledTemplateId: jest.fn().mockResolvedValue('template-a') } as never,
      wechatDispatch as never,
    );
    const source = {
      ...adminIntent({
        notificationId: 'cm00000000000000000000001',
        memberId: 'cm00000000000000000000002',
      }),
      eventKey: `wechat-delivery:cm00000000000000000000001:${ROOT_ID}:cm00000000000000000000002`,
      eventType: 'notification.wechat-delivery',
    };

    await expect(guarded.execute(source, ALLOW_EFFECT)).resolves.toEqual({
      effectPerformed: false,
    });
    expect(outbox.authorizeAdminNotificationEffect).toHaveBeenCalledTimes(1);
    const [permissionCall] = outbox.authorizeAdminNotificationEffect.mock.calls as unknown as [
      [
        typeof source,
        string,
        number,
        string,
        undefined,
        (tx: unknown, lockedNotification: unknown) => Promise<boolean>,
      ],
    ];
    expect(permissionCall.slice(0, 5)).toEqual([
      source,
      'cm00000000000000000000001',
      1,
      'wechat',
      undefined,
    ]);
    const recipientPermission = permissionCall[5];
    const permissionTx = { marker: 'same-parent-intent-tx' };
    await expect(recipientPermission(permissionTx, notification)).resolves.toBe(false);
    expect(wechatDispatch.authorizeDurableBroadcastRecipient).toHaveBeenCalledWith(
      permissionTx,
      notification,
      'cm00000000000000000000002',
    );
    expect(outbox.refundPrepared).toHaveBeenCalledWith(source, preparation, expect.any(Function));
    const refundInput = quotaUpdate.mock.calls[1]?.[0];
    expect(refundInput?.where).toMatchObject({
      templateId: 'template-a',
      availableCount: { lt: 5 },
    });
    expect(refundInput?.data).toEqual({ availableCount: { increment: 1 } });
    expect(wechat.sendSubscribeMessage).not.toHaveBeenCalled();
  });

  it('旧 attempt durable prepare + inactive recipient 时先走 final permission，零 evidence 且绝不退款', async () => {
    const notification = {
      id: 'cm00000000000000000000001',
      notificationTypeCode: 'general',
      title: 'title',
      body: 'body',
      publishedAt: NOW,
      deletedAt: null,
      sourceType: 'admin',
      statusCode: 'published',
      audienceType: 'broadcast',
      publishGeneration: 1,
      channels: ['wechat'],
    };
    const prisma = {
      notification: { findUnique: jest.fn().mockResolvedValue(notification) },
      notificationDelivery: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        createMany: jest.fn(),
      },
      member: { findFirst: jest.fn().mockResolvedValue(null) },
      user: { findFirst: jest.fn() },
    };
    const outbox = {
      findByEventKey: jest.fn().mockResolvedValue(rootIntent()),
      markPrepared: jest.fn().mockResolvedValue({
        templateId: 'template-a',
        preparedNow: false,
        refundCapability: null,
      }),
      authorizeAdminNotificationEffect: jest.fn().mockResolvedValue(null),
      refundPrepared: jest.fn(),
    };
    const wechat = { sendSubscribeMessage: jest.fn() };
    const templates = { getEnabledTemplateId: jest.fn() };
    const guarded = new NotificationOutboxHandlers(
      prisma as never,
      outbox as never,
      {} as never,
      {} as never,
      {} as never,
      wechat as never,
      templates as never,
      {} as never,
    );
    const source = {
      ...adminIntent({
        notificationId: 'cm00000000000000000000001',
        memberId: 'cm00000000000000000000002',
      }),
      preparedAt: NOW,
      preparedTemplateId: 'template-a',
      eventKey: `wechat-delivery:cm00000000000000000000001:${ROOT_ID}:cm00000000000000000000002`,
      eventType: 'notification.wechat-delivery',
    };

    await expect(guarded.execute(source, ALLOW_EFFECT)).resolves.toEqual({
      effectPerformed: false,
    });
    expect(templates.getEnabledTemplateId).not.toHaveBeenCalled();
    expect(outbox.authorizeAdminNotificationEffect).toHaveBeenCalledTimes(1);
    expect(outbox.refundPrepared).not.toHaveBeenCalled();
    expect(prisma.notificationDelivery.createMany).not.toHaveBeenCalled();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(wechat.sendSubscribeMessage).not.toHaveBeenCalled();
  });

  it('v2 eligible recipient 无 openid 时 final permission 先于 same-attempt refund 与 no-openid evidence', async () => {
    const notification = {
      id: 'cm00000000000000000000001',
      notificationTypeCode: 'general',
      title: 'title',
      body: 'body',
      publishedAt: NOW,
      deletedAt: null,
      sourceType: 'admin',
      statusCode: 'published',
      audienceType: 'broadcast',
      publishGeneration: 1,
      channels: ['wechat'],
    };
    const events: string[] = [];
    const quotaUpdate = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const preparation = {
      templateId: 'template-a',
      preparedNow: true,
      refundCapability: {},
    };
    const prepareTx = {
      wechatSubscriptionQuota: { updateMany: quotaUpdate },
      notificationDelivery: { createMany: jest.fn() },
    };
    const deliveryCreate = jest.fn(() => {
      events.push('no-openid-evidence');
      return Promise.resolve({ count: 1 });
    });
    const prisma = {
      notification: { findUnique: jest.fn().mockResolvedValue(notification) },
      notificationDelivery: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        createMany: deliveryCreate,
      },
      member: { findFirst: jest.fn().mockResolvedValue({ id: 'member' }) },
      user: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const wechatDispatch = {
      authorizeDurableBroadcastRecipient: jest.fn().mockImplementation(() => {
        events.push('recipient-snapshot');
        return Promise.resolve({ openid: null });
      }),
    };
    const outbox = {
      findByEventKey: jest.fn().mockResolvedValue(rootIntent()),
      markPrepared: jest.fn(
        async (
          _source: unknown,
          templateId: string,
          prepare: (client: typeof prepareTx, stableTemplateId: string) => Promise<void>,
        ) => {
          await prepare(prepareTx, templateId);
          return preparation;
        },
      ),
      authorizeAdminNotificationEffect: jest.fn(
        async (
          _source: unknown,
          _notificationId: string,
          _generation: number,
          _channel: string,
          _now: Date | undefined,
          authorizeRecipient: (tx: unknown, locked: typeof notification) => Promise<boolean>,
        ) => {
          expect(await authorizeRecipient({ marker: 'permission-tx' }, notification)).toBe(true);
          events.push('final-permission');
          return notification;
        },
      ),
      refundPrepared: jest.fn(
        async (
          _source: unknown,
          result: typeof preparation,
          refund: (client: typeof prepareTx, stableTemplateId: string) => Promise<boolean>,
        ) => {
          events.push('same-attempt-refund');
          expect(await refund(prepareTx, result.templateId)).toBe(true);
        },
      ),
    };
    const wechat = { sendSubscribeMessage: jest.fn() };
    const guarded = new NotificationOutboxHandlers(
      prisma as never,
      outbox as never,
      {} as never,
      {} as never,
      {} as never,
      wechat as never,
      { getEnabledTemplateId: jest.fn().mockResolvedValue('template-a') } as never,
      wechatDispatch as never,
    );
    const source = {
      ...adminIntent({
        notificationId: 'cm00000000000000000000001',
        memberId: 'cm00000000000000000000002',
      }),
      eventKey: `wechat-delivery:cm00000000000000000000001:${ROOT_ID}:cm00000000000000000000002`,
      eventType: 'notification.wechat-delivery',
    };

    await expect(guarded.execute(source, ALLOW_EFFECT)).resolves.toEqual({
      effectPerformed: false,
    });
    expect(events).toEqual([
      'recipient-snapshot',
      'final-permission',
      'same-attempt-refund',
      'no-openid-evidence',
    ]);
    expect(quotaUpdate).toHaveBeenCalledTimes(2);
    expect(deliveryCreate).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          id: source.id,
          status: 'skipped',
          reasonCode: 'no-openid',
          recipientRef: '-',
        }),
      ],
      skipDuplicates: true,
    });
    expect(wechat.sendSubscribeMessage).not.toHaveBeenCalled();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('v2 即使旧读会是 null，也只消费 final permission 新绑定的 locked openid', async () => {
    const notification = {
      id: 'cm00000000000000000000001',
      notificationTypeCode: 'general',
      title: 'title',
      body: 'body',
      publishedAt: NOW,
      deletedAt: null,
      sourceType: 'admin',
      statusCode: 'published',
      audienceType: 'broadcast',
      publishGeneration: 1,
      channels: ['wechat'],
    };
    const prepareTx = {
      wechatSubscriptionQuota: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      notificationDelivery: { createMany: jest.fn() },
    };
    const prisma = {
      notification: { findUnique: jest.fn().mockResolvedValue(notification) },
      notificationDelivery: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      member: { findFirst: jest.fn().mockResolvedValue({ id: 'member' }) },
      user: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const permissionTx = { marker: 'same-final-permission-tx' };
    const wechatDispatch = {
      authorizeDurableBroadcastRecipient: jest.fn().mockResolvedValue({
        openid: 'locked-current-openid',
      }),
    };
    const outbox = {
      findByEventKey: jest.fn().mockResolvedValue(rootIntent()),
      markPrepared: jest.fn(
        async (
          _source: unknown,
          templateId: string,
          prepare: (client: typeof prepareTx, stableTemplateId: string) => Promise<void>,
        ) => {
          await prepare(prepareTx, templateId);
          return { templateId, preparedNow: true, refundCapability: {} };
        },
      ),
      authorizeAdminNotificationEffect: jest.fn(
        async (
          _source: unknown,
          _notificationId: string,
          _generation: number,
          _channel: string,
          _now: Date | undefined,
          authorizeRecipient: (
            tx: typeof permissionTx,
            locked: typeof notification,
          ) => Promise<boolean>,
        ) => {
          expect(await authorizeRecipient(permissionTx, notification)).toBe(true);
          return notification;
        },
      ),
      refundPrepared: jest.fn(),
    };
    const wechat = {
      sendSubscribeMessage: jest.fn().mockResolvedValue({ ok: true, msgId: 'msg-1' }),
    };
    const guarded = new NotificationOutboxHandlers(
      prisma as never,
      outbox as never,
      {} as never,
      {} as never,
      {} as never,
      wechat as never,
      { getEnabledTemplateId: jest.fn().mockResolvedValue('template-a') } as never,
      wechatDispatch as never,
    );
    const source = {
      ...adminIntent({
        notificationId: notification.id,
        memberId: 'cm00000000000000000000002',
      }),
      eventKey: `wechat-delivery:${notification.id}:${ROOT_ID}:cm00000000000000000000002`,
      eventType: 'notification.wechat-delivery',
    };

    await expect(guarded.execute(source, ALLOW_EFFECT)).resolves.toEqual({
      effectPerformed: true,
    });
    expect(prisma.member.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(wechatDispatch.authorizeDurableBroadcastRecipient).toHaveBeenCalledWith(
      permissionTx,
      notification,
      'cm00000000000000000000002',
    );
    expect(wechat.sendSubscribeMessage).toHaveBeenCalledWith(
      expect.objectContaining({ openid: 'locked-current-openid' }),
      ALLOW_EFFECT.beforeEffect,
    );
    expect(outbox.refundPrepared).not.toHaveBeenCalled();
  });

  it('v2 pre-permission quota=0 固定写 no-quota，不伪造 no-openid destination evidence', async () => {
    const notification = {
      id: 'cm00000000000000000000001',
      notificationTypeCode: 'general',
      title: 'title',
      body: 'body',
      publishedAt: NOW,
      deletedAt: null,
      sourceType: 'admin',
      statusCode: 'published',
      audienceType: 'broadcast',
      publishGeneration: 1,
      channels: ['wechat'],
    };
    const deliveryCreate = jest.fn().mockResolvedValue({ count: 1 });
    const prepareTx = {
      wechatSubscriptionQuota: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      notificationDelivery: { createMany: deliveryCreate },
    };
    const prisma = {
      notification: { findUnique: jest.fn().mockResolvedValue(notification) },
      notificationDelivery: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ status: 'skipped' }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      member: { findFirst: jest.fn() },
      user: { findFirst: jest.fn() },
    };
    const outbox = {
      findByEventKey: jest.fn().mockResolvedValue(rootIntent()),
      markPrepared: jest.fn(
        async (
          _source: unknown,
          templateId: string,
          prepare: (client: typeof prepareTx, stableTemplateId: string) => Promise<void>,
        ) => {
          await prepare(prepareTx, templateId);
          return { templateId, preparedNow: false, refundCapability: null };
        },
      ),
      authorizeAdminNotificationEffect: jest.fn(),
    };
    const wechat = { sendSubscribeMessage: jest.fn() };
    const guarded = new NotificationOutboxHandlers(
      prisma as never,
      outbox as never,
      {} as never,
      {} as never,
      {} as never,
      wechat as never,
      { getEnabledTemplateId: jest.fn().mockResolvedValue('template-a') } as never,
      {} as never,
    );
    const source = {
      ...adminIntent({
        notificationId: notification.id,
        memberId: 'cm00000000000000000000002',
      }),
      eventKey: `wechat-delivery:${notification.id}:${ROOT_ID}:cm00000000000000000000002`,
      eventType: 'notification.wechat-delivery',
    };

    await expect(guarded.execute(source, ALLOW_EFFECT)).resolves.toEqual({
      effectPerformed: false,
    });
    expect(deliveryCreate).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          id: source.id,
          recipientRef: '-',
          status: 'skipped',
          reasonCode: 'no-quota',
        }),
      ],
      skipDuplicates: true,
    });
    expect(outbox.authorizeAdminNotificationEffect).not.toHaveBeenCalled();
    expect(prisma.member.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(wechat.sendSubscribeMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['wrong id', rootIntent({ id: 'cm00000000000000000000007' })],
    ['wrong event', rootIntent({ eventType: 'notification.targeted' })],
    ['wrong version', rootIntent({ payloadVersion: 1 })],
    ['wrong envelope', rootIntent({ destinationType: 'member' })],
    [
      'wrong payload notification',
      rootIntent({
        payload: {
          notificationId: 'cm00000000000000000000007',
          publishGeneration: 1,
        },
      }),
    ],
    [
      'wrong payload generation',
      rootIntent({
        payload: {
          notificationId: 'cm00000000000000000000001',
          publishGeneration: 2,
        },
      }),
    ],
  ])(
    'v2 WeChat child 的 root %s 时在 notification/template/quota/provider/evidence 前 terminal',
    async (_name, root) => {
      const prisma = {
        notification: { findUnique: jest.fn() },
        notificationDelivery: {
          findUnique: jest.fn(),
          findFirst: jest.fn(),
          createMany: jest.fn(),
        },
      };
      const outbox = {
        findByEventKey: jest.fn().mockResolvedValue(root),
        markPrepared: jest.fn(),
      };
      const templates = { getEnabledTemplateId: jest.fn() };
      const wechat = { sendSubscribeMessage: jest.fn() };
      const guarded = new NotificationOutboxHandlers(
        prisma as never,
        outbox as never,
        {} as never,
        {} as never,
        {} as never,
        wechat as never,
        templates as never,
        {} as never,
      );
      const source = {
        ...adminIntent({
          notificationId: 'cm00000000000000000000001',
          memberId: 'cm00000000000000000000002',
        }),
        eventKey: `wechat-delivery:cm00000000000000000000001:${ROOT_ID}:cm00000000000000000000002`,
        eventType: 'notification.wechat-delivery',
      };

      await expect(guarded.execute(source, ALLOW_EFFECT)).rejects.toBeInstanceOf(
        UnsupportedNotificationOutboxEventError,
      );
      expect(outbox.findByEventKey).toHaveBeenCalledWith(
        'wechat-broadcast:cm00000000000000000000001:1',
      );
      expect(prisma.notification.findUnique).not.toHaveBeenCalled();
      expect(prisma.notificationDelivery.findUnique).not.toHaveBeenCalled();
      expect(prisma.notificationDelivery.findFirst).not.toHaveBeenCalled();
      expect(prisma.notificationDelivery.createMany).not.toHaveBeenCalled();
      expect(templates.getEnabledTemplateId).not.toHaveBeenCalled();
      expect(outbox.markPrepared).not.toHaveBeenCalled();
      expect(wechat.sendSubscribeMessage).not.toHaveBeenCalled();
    },
  );

  it.each(['pending', 'processing', 'succeeded', 'dead'])(
    'v2 WeChat child 接受真实 %s root，不把 root lifecycle 当 permission',
    async (status) => {
      const notification = {
        id: 'cm00000000000000000000001',
        notificationTypeCode: 'general',
        title: 'title',
        body: 'body',
        publishedAt: NOW,
        deletedAt: null,
        sourceType: 'admin',
        statusCode: 'published',
        audienceType: 'broadcast',
        publishGeneration: 1,
        channels: ['wechat'],
      };
      const prisma = {
        notification: { findUnique: jest.fn().mockResolvedValue(notification) },
        notificationDelivery: {
          findUnique: jest.fn().mockResolvedValue({ id: 'existing-evidence' }),
          findFirst: jest.fn(),
        },
      };
      const outbox = { findByEventKey: jest.fn().mockResolvedValue(rootIntent({ status })) };
      const templates = { getEnabledTemplateId: jest.fn() };
      const guarded = new NotificationOutboxHandlers(
        prisma as never,
        outbox as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        templates as never,
        {} as never,
      );
      const source = {
        ...adminIntent({
          notificationId: notification.id,
          memberId: 'cm00000000000000000000002',
        }),
        eventKey: `wechat-delivery:${notification.id}:${ROOT_ID}:cm00000000000000000000002`,
        eventType: 'notification.wechat-delivery',
      };

      await expect(guarded.execute(source, ALLOW_EFFECT)).resolves.toEqual({
        effectPerformed: false,
      });
      expect(prisma.notification.findUnique).toHaveBeenCalledTimes(1);
      expect(templates.getEnabledTemplateId).not.toHaveBeenCalled();
    },
  );

  it('生日短信 provider 紧邻 guard 失败时零外发且不伪造 FAILED 流水', async () => {
    const leaseLost = new Error('lease lost before birthday provider');
    const beforeEffect = jest.fn().mockRejectedValue(leaseLost);
    const smsSendLog = {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
    };
    const prisma = {
      user: { findFirst: jest.fn().mockResolvedValue({ phone: '13900000001' }) },
      smsSendLog,
    };
    const invoke = jest.fn();
    const router = {
      prepareBirthdayGreeting: jest.fn().mockResolvedValue({
        providerType: 'DEV_STUB',
        invoke,
      }),
    };
    const settings = {
      getActiveSettings: jest.fn().mockResolvedValue({
        enabled: true,
        templateIdBirthday: 'birthday-template',
      }),
    };
    const guarded = new NotificationOutboxHandlers(
      prisma as never,
      {} as never,
      router as never,
      settings as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const source = {
      ...intent({}),
      eventKey: 'birthday-sms:2026-07-18:cm00000000000000000000002',
      eventType: 'notification.birthday-sms',
      aggregateType: 'member',
      aggregateId: 'cm00000000000000000000002',
      payload: { memberId: 'cm00000000000000000000002', dateKey: '2026-07-18' },
    };

    await expect(guarded.execute(source, { beforeEffect })).rejects.toBe(leaseLost);
    expect(router.prepareBirthdayGreeting).toHaveBeenCalledWith({ phone: '13900000001' });
    expect(beforeEffect).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
    expect(smsSendLog.create).not.toHaveBeenCalled();
  });

  it('生日短信 prepare 失败原样外抛，guard/provider/evidence 均为 0', async () => {
    const prepareError = new Error('birthday route unavailable');
    const beforeEffect = jest.fn().mockResolvedValue(undefined);
    const invoke = jest.fn();
    const smsSendLog = {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
    };
    const prisma = {
      user: { findFirst: jest.fn().mockResolvedValue({ phone: '13900000001' }) },
      smsSendLog,
    };
    const router = {
      prepareBirthdayGreeting: jest.fn().mockRejectedValue(prepareError),
      invoke,
    };
    const settings = {
      getActiveSettings: jest.fn().mockResolvedValue({
        enabled: true,
        templateIdBirthday: 'birthday-template',
      }),
    };
    const guarded = new NotificationOutboxHandlers(
      prisma as never,
      {} as never,
      router as never,
      settings as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const source = {
      ...intent({}),
      eventKey: 'birthday-sms:2026-07-18:cm00000000000000000000002',
      eventType: 'notification.birthday-sms',
      aggregateType: 'member',
      aggregateId: 'cm00000000000000000000002',
      payload: { memberId: 'cm00000000000000000000002', dateKey: '2026-07-18' },
    };

    await expect(guarded.execute(source, { beforeEffect })).rejects.toBe(prepareError);
    expect(beforeEffect).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(smsSendLog.create).not.toHaveBeenCalled();
  });

  it('生日短信仅 invoke Effect 失败进入 FAILED 归一，providerType 取 prepared snapshot', async () => {
    const providerError = new Error('provider rejected birthday SMS');
    const beforeEffect = jest.fn().mockResolvedValue(undefined);
    const invoke = jest.fn().mockRejectedValue(providerError);
    const smsSendLog = {
      count: jest.fn().mockResolvedValue(0),
      create: jest
        .fn<Promise<{ id: string }>, [{ data: Record<string, unknown> }]>()
        .mockResolvedValue({ id: 'failed-log' }),
    };
    const prisma = {
      user: { findFirst: jest.fn().mockResolvedValue({ phone: '13900000001' }) },
      smsSendLog,
    };
    const router = {
      prepareBirthdayGreeting: jest.fn().mockResolvedValue({
        providerType: 'TENCENT_SMS',
        invoke,
      }),
    };
    const settings = {
      getActiveSettings: jest.fn().mockResolvedValue({
        enabled: true,
        templateIdBirthday: 'birthday-template',
      }),
    };
    const guarded = new NotificationOutboxHandlers(
      prisma as never,
      {} as never,
      router as never,
      settings as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const source = {
      ...intent({}),
      eventKey: 'birthday-sms:2026-07-18:cm00000000000000000000002',
      eventType: 'notification.birthday-sms',
      aggregateType: 'member',
      aggregateId: 'cm00000000000000000000002',
      payload: { memberId: 'cm00000000000000000000002', dateKey: '2026-07-18' },
    };

    await expect(guarded.execute(source, { beforeEffect })).rejects.toBe(providerError);
    expect(beforeEffect).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    const [failedEvidence] = smsSendLog.create.mock.calls[0];
    expect(failedEvidence.data).toMatchObject({
      providerType: 'TENCENT_SMS',
      status: 'FAILED',
    });
  });

  it('生日短信 provider accepted 后 SENT evidence 写失败原样外抛且绝不伪造 FAILED', async () => {
    const dbError = new Error('birthday SENT evidence unavailable');
    const beforeEffect = jest.fn().mockResolvedValue(undefined);
    const invoke = jest.fn().mockResolvedValue({ providerMsgId: 'accepted-birthday-msg' });
    const smsSendLog = {
      count: jest.fn().mockResolvedValue(0),
      create: jest
        .fn<Promise<{ id: string }>, [{ data: Record<string, unknown> }]>()
        .mockRejectedValueOnce(dbError),
    };
    const prisma = {
      user: { findFirst: jest.fn().mockResolvedValue({ phone: '13900000001' }) },
      smsSendLog,
    };
    const router = {
      prepareBirthdayGreeting: jest.fn().mockResolvedValue({
        providerType: 'TENCENT_SMS',
        invoke,
      }),
    };
    const settings = {
      getActiveSettings: jest.fn().mockResolvedValue({
        enabled: true,
        templateIdBirthday: 'birthday-template',
      }),
    };
    const guarded = new NotificationOutboxHandlers(
      prisma as never,
      {} as never,
      router as never,
      settings as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const source = {
      ...intent({}),
      eventKey: 'birthday-sms:2026-07-18:cm00000000000000000000002',
      eventType: 'notification.birthday-sms',
      aggregateType: 'member',
      aggregateId: 'cm00000000000000000000002',
      payload: { memberId: 'cm00000000000000000000002', dateKey: '2026-07-18' },
    };

    await expect(guarded.execute(source, { beforeEffect })).rejects.toBe(dbError);
    expect(beforeEffect).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(smsSendLog.create).toHaveBeenCalledTimes(1);
    const [sentEvidence] = smsSendLog.create.mock.calls[0];
    expect(sentEvidence.data).toMatchObject({
      providerType: 'TENCENT_SMS',
      status: 'SENT',
      providerMsgId: 'accepted-birthday-msg',
    });
    expect(smsSendLog.create.mock.calls.map(([input]) => input.data.status)).toEqual(['SENT']);
  });

  it.each([
    ['已撤回', { statusCode: 'draft', channels: ['in-app', 'sms'] }],
    ['已移除 sms', { statusCode: 'published', channels: ['in-app'] }],
    ['已删除或不存在', null],
  ])('admin SMS 父通知%s时 terminal skip 且不进入收件人派发', async () => {
    const smsDispatch = { dispatchRecipient: jest.fn() };
    const prisma = {};
    const outbox = { authorizeAdminNotificationEffect: jest.fn().mockResolvedValue(null) };
    const guarded = new NotificationOutboxHandlers(
      prisma as never,
      outbox as never,
      {} as never,
      {} as never,
      smsDispatch as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const beforeEffect = jest.fn().mockResolvedValue(undefined);

    await expect(
      guarded.execute(
        adminIntent({
          notificationId: 'cm00000000000000000000001',
          memberId: 'cm00000000000000000000002',
        }),
        { beforeEffect },
      ),
    ).resolves.toEqual({
      effectPerformed: false,
      value: { outcome: 'skipped' },
    });
    expect(smsDispatch.dispatchRecipient).not.toHaveBeenCalled();
    expect(beforeEffect).not.toHaveBeenCalled();
  });

  it('admin SMS 将同一 beforeEffect guard 下传到 dispatchRecipient', async () => {
    const beforeEffect = jest.fn().mockResolvedValue(undefined);
    const notification = {
      id: 'cm00000000000000000000001',
      statusCode: 'published',
      channels: ['in-app', 'sms'],
    };
    const smsDispatch = {
      dispatchRecipient: jest.fn().mockResolvedValue({ outcome: 'sent' }),
    };
    const outbox = { authorizeAdminNotificationEffect: jest.fn().mockResolvedValue(notification) };
    const guarded = new NotificationOutboxHandlers(
      {} as never,
      outbox as never,
      {} as never,
      {} as never,
      smsDispatch as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      guarded.execute(
        adminIntent({
          notificationId: notification.id,
          memberId: 'cm00000000000000000000002',
        }),
        { beforeEffect },
      ),
    ).resolves.toMatchObject({ effectPerformed: true });
    expect(smsDispatch.dispatchRecipient).toHaveBeenCalledWith(
      notification,
      'cm00000000000000000000002',
      beforeEffect,
    );
  });

  function buildRecipientEligibility(options?: {
    lockRows?: Array<{ id: string }>;
    member?: { id: string } | null;
    user?: {
      id: string;
      memberId: string;
      openid: string | null;
      role: Role;
      status: UserStatus;
    } | null;
    organizationIds?: string[];
    management?: boolean;
  }) {
    const memberId = 'cm00000000000000000000002';
    const userId = 'cm00000000000000000000003';
    const roleId = 'cm00000000000000000000004';
    const permissionId = 'cm00000000000000000000005';
    const events: string[] = [];
    const queryRaw = jest.fn((query: Prisma.Sql) => {
      const sql = query.strings.join(' ');
      if (sql.includes('FROM "Member"')) {
        events.push('member-lock');
        return Promise.resolve(options?.lockRows ?? [{ id: memberId }]);
      }
      if (sql.includes('pg_advisory_xact_lock_shared')) {
        events.push('topology-shared');
        return Promise.resolve([{ locked: '6961426456611932099' }]);
      }
      if (sql.includes('FROM "User"')) {
        events.push('user-lock');
        return Promise.resolve(
          options && 'user' in options
            ? options.user
              ? [options.user]
              : []
            : [
                {
                  id: userId,
                  memberId,
                  openid: 'locked-openid',
                  role: Role.USER,
                  status: UserStatus.ACTIVE,
                },
              ],
        );
      }
      if (sql.includes('FROM "role_bindings"')) {
        events.push('role-binding-lock');
        return Promise.resolve(options?.management ? [{ id: 'binding', roleId }] : []);
      }
      if (sql.includes('FROM "roles"')) {
        events.push('role-lock');
        return Promise.resolve([{ id: roleId, deletedAt: null }]);
      }
      if (sql.includes('FROM "permissions"')) {
        events.push('permission-lock');
        return Promise.resolve([{ id: permissionId }]);
      }
      if (sql.includes('FROM "role_permissions"')) {
        events.push('role-permission-lock');
        return Promise.resolve(options?.management ? [{ id: 'role-permission' }] : []);
      }
      throw new Error(`unexpected eligibility SQL: ${sql}`);
    });
    const member = {
      findFirst: jest.fn(() => {
        events.push('member-read');
        return Promise.resolve(options && 'member' in options ? options.member : { id: memberId });
      }),
    };
    const memberOrganizationMembership = {
      findMany: jest.fn(() => {
        events.push('primary-membership-read');
        return Promise.resolve(
          (options?.organizationIds ?? []).map((organizationId) => ({ organizationId })),
        );
      }),
    };
    const rbac = {
      can: jest.fn(() => Promise.reject(new Error('root RBAC connection forbidden'))),
    };
    const tx = { $queryRaw: queryRaw, member, memberOrganizationMembership };
    return {
      memberId,
      events,
      queryRaw,
      member,
      memberOrganizationMembership,
      rbac,
      tx,
      service: new NotificationWechatDispatchService(
        {} as never,
        {} as never,
        rbac as never,
        {} as never,
      ),
    };
  }

  function visibilityNotification(
    visibilityCode: string,
    visibleOrganizationIds: string[] = [],
  ): Notification {
    return {
      statusCode: 'published',
      visibilityCode,
      visibleOrganizationIds,
    } as Notification;
  }

  it.each([
    ['member', [], false, [], true],
    ['formal_member', ['org-a'], false, [], true],
    ['department', ['org-a'], false, ['org-a'], true],
    ['management', [], true, [], true],
  ] as const)(
    'final recipient eligibility 复用 %s visibility 并保持 Member→shared topology→资格读锁序',
    async (visibilityCode, organizationIds, management, visibleOrganizationIds, expected) => {
      const f = buildRecipientEligibility({ organizationIds: [...organizationIds], management });

      await expect(
        f.service.authorizeDurableBroadcastRecipient(
          f.tx as never,
          visibilityNotification(visibilityCode, [...visibleOrganizationIds]),
          f.memberId,
          NOW,
        ),
      ).resolves.toEqual(expected ? { openid: 'locked-openid' } : null);
      expect(f.events.slice(0, 5)).toEqual([
        'member-lock',
        'topology-shared',
        'member-read',
        'user-lock',
        'primary-membership-read',
      ]);
      const eligibilitySql = f.queryRaw.mock.calls.map(([query]) => query.strings.join(' '));
      expect(eligibilitySql[0]).toContain('FROM "Member"');
      expect(eligibilitySql[0]).toContain('FOR UPDATE');
      expect(eligibilitySql[1]).toContain('pg_advisory_xact_lock_shared');
      expect(f.queryRaw.mock.calls[1]?.[0].values).toEqual([6961426456611932099n]);
      expect(eligibilitySql[2]).toContain('FROM "User"');
      expect(eligibilitySql[2]).toContain('FOR SHARE');
      expect(eligibilitySql[2]).not.toContain('FOR UPDATE');
      const [membershipInput] = f.memberOrganizationMembership.findMany.mock
        .calls[0] as unknown as [
        {
          where: Record<string, unknown>;
          select: { organizationId: boolean };
        },
      ];
      expect(membershipInput).toMatchObject({
        where: {
          memberId: f.memberId,
          membershipType: 'PRIMARY',
          organization: { status: 'ACTIVE', deletedAt: null },
        },
        select: { organizationId: true },
      });
      expect(f.rbac.can).not.toHaveBeenCalled();
      if (visibilityCode === 'management') {
        expect(f.events).toEqual([
          'member-lock',
          'topology-shared',
          'member-read',
          'user-lock',
          'primary-membership-read',
          'role-binding-lock',
          'role-lock',
          'permission-lock',
          'role-permission-lock',
        ]);
        for (const sql of eligibilitySql.slice(3)) {
          expect(sql).toContain('FOR SHARE');
          expect(sql).not.toContain('FOR UPDATE');
        }
      }
    },
  );

  it.each([
    ['missing member', { lockRows: [], member: null }],
    ['inactive member', { member: null }],
    ['missing/inactive user', { user: null }],
  ])('final recipient eligibility 对 %s fail-closed', async (_name, options) => {
    const f = buildRecipientEligibility(options);
    await expect(
      f.service.authorizeDurableBroadcastRecipient(
        f.tx as never,
        visibilityNotification('member'),
        f.memberId,
        NOW,
      ),
    ).resolves.toBeNull();
    expect(f.events.slice(0, 2)).toEqual(['member-lock', 'topology-shared']);
    expect(f.rbac.can).not.toHaveBeenCalled();
  });

  it('department 非目标组织与 management 无权限均 fail-closed', async () => {
    const department = buildRecipientEligibility({ organizationIds: ['org-a'] });
    await expect(
      department.service.authorizeDurableBroadcastRecipient(
        department.tx as never,
        visibilityNotification('department', ['org-b']),
        department.memberId,
        NOW,
      ),
    ).resolves.toBeNull();

    const management = buildRecipientEligibility({ organizationIds: ['org-a'] });
    await expect(
      management.service.authorizeDurableBroadcastRecipient(
        management.tx as never,
        visibilityNotification('management'),
        management.memberId,
        NOW,
      ),
    ).resolves.toBeNull();
    expect(management.rbac.can).not.toHaveBeenCalled();
  });
});
