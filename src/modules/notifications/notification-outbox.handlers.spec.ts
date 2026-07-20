import type { NotificationOutboxIntent } from '@prisma/client';

import {
  NotificationOutboxHandlers,
  UnsupportedNotificationOutboxEventError,
} from './notification-outbox.handlers';
import type { ClaimedNotificationOutboxIntent } from './notification-outbox.service';
import { parseKnownNotificationOutboxPayload } from './notification-outbox.types';

const NOW = new Date('2026-07-18T00:00:00.000Z');
const ALLOW_EFFECT = { beforeEffect: () => Promise.resolve() };

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
        findFirst: jest.fn().mockResolvedValue({
          id: 'cm00000000000000000000001',
          notificationTypeCode: 'general',
          title: 'guarded title',
          body: 'guarded body',
          publishedAt: NOW,
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
    const outbox = { markPrepared: jest.fn().mockResolvedValue(true) };
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
      eventType: 'notification.birthday-sms',
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
      eventType: 'notification.birthday-sms',
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
      eventType: 'notification.birthday-sms',
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
      eventType: 'notification.birthday-sms',
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
  ])('admin SMS 父通知%s时 terminal skip 且不进入收件人派发', async (_name, state) => {
    const smsDispatch = { dispatchRecipient: jest.fn() };
    const prisma = {
      notification: {
        findFirst: jest.fn().mockResolvedValue(
          state
            ? {
                id: 'cm00000000000000000000001',
                ...state,
              }
            : null,
        ),
      },
    };
    const guarded = new NotificationOutboxHandlers(
      prisma as never,
      {} as never,
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
        intent({
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
    const guarded = new NotificationOutboxHandlers(
      { notification: { findFirst: jest.fn().mockResolvedValue(notification) } } as never,
      {} as never,
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
});
