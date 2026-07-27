import { Logger } from '@nestjs/common';
import type { Notification } from '@prisma/client';

import { NotificationWechatDispatchService } from './notification-wechat-dispatch.service';

const HIGH_RISK_ERROR_MESSAGE = [
  'SecretId=TEST_SECRET',
  'SecretKey=TEST_KEY',
  'https://provider.example.com/private/path',
  '13800138000',
  'openid-sensitive-value',
  'bucket/private/object-key',
  'Authorization: Bearer test-token',
  'postgresql://user:password@db.internal:5432/app',
].join(' ');

const notification = {
  id: 'notification-1',
  notificationTypeCode: 'activity-changed',
  statusCode: 'published',
  audienceType: 'broadcast',
  visibilityCode: 'member',
  visibleOrganizationIds: [],
  recipientMemberId: 'member-1',
} as unknown as Notification;

function loggedText(spy: jest.SpyInstance): string {
  return spy.mock.calls
    .flat()
    .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
    .join('\n');
}

function expectNoSensitiveLogContent(text: string): void {
  for (const forbidden of [
    'TEST_SECRET',
    'TEST_KEY',
    'https://provider.example.com/private/path',
    '13800138000',
    'openid-sensitive-value',
    'bucket/private/object-key',
    'Authorization',
    'test-token',
    'postgresql://user:password@db.internal:5432/app',
  ]) {
    expect(text).not.toContain(forbidden);
  }
}

function build(overrides?: {
  getTemplate?: () => Promise<string | null>;
  quotaUpdate?: () => Promise<{ count: number }>;
}) {
  const prisma = {
    wechatSubscriptionQuota: {
      findMany: jest.fn().mockResolvedValue([{ memberId: 'member-1' }]),
      updateMany: jest
        .fn()
        .mockImplementation(overrides?.quotaUpdate ?? (() => Promise.resolve({ count: 1 }))),
    },
    notificationDelivery: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'delivery-1' }),
    },
    member: {
      findMany: jest.fn().mockResolvedValue([{ id: 'member-1', gradeCode: 'level-1' }]),
      findFirst: jest.fn().mockResolvedValue({ id: 'member-1' }),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'user-1',
          memberId: 'member-1',
          role: 'USER',
          openid: 'openid-sensitive-value',
        },
      ]),
      findFirst: jest.fn().mockResolvedValue({ openid: 'openid-sensitive-value' }),
    },
    memberOrganizationMembership: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const wechat = {
    sendSubscribeMessage: jest.fn().mockResolvedValue({ ok: true, msgId: 'wechat-message-1' }),
  };
  const rbac = { can: jest.fn().mockResolvedValue(false) };
  const templates = {
    getEnabledTemplateId: jest
      .fn()
      .mockImplementation(overrides?.getTemplate ?? (() => Promise.resolve('template-1'))),
  };
  return {
    service: new NotificationWechatDispatchService(
      prisma as never,
      wechat as never,
      rbac as never,
      templates as never,
    ),
    prisma,
    wechat,
  };
}

describe('NotificationWechatDispatchService · safe application logs', () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('微信广播整体失败不把 raw error.message 写入普通日志', async () => {
    const serviceError = new Error(HIGH_RISK_ERROR_MESSAGE, {
      cause: new Error(`cause ${HIGH_RISK_ERROR_MESSAGE}`),
    });
    serviceError.stack = `stack ${HIGH_RISK_ERROR_MESSAGE}`;
    const { service } = build({ getTemplate: () => Promise.reject(serviceError) });

    await expect(service.dispatchBroadcast(notification)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expectNoSensitiveLogContent(loggedText(errorSpy));
  });

  it('微信定向失败不把 raw error.message 写入普通日志', async () => {
    const serviceError = new Error(HIGH_RISK_ERROR_MESSAGE, {
      cause: new Error(`cause ${HIGH_RISK_ERROR_MESSAGE}`),
    });
    serviceError.stack = `stack ${HIGH_RISK_ERROR_MESSAGE}`;
    const { service } = build({ getTemplate: () => Promise.reject(serviceError) });

    await expect(service.dispatchDirected(notification)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expectNoSensitiveLogContent(loggedText(errorSpy));
  });

  it('微信逐收件人失败不泄漏 raw message，且不改变 provider/delivery 调用语义', async () => {
    const serviceError = new Error(HIGH_RISK_ERROR_MESSAGE, {
      cause: new Error(`cause ${HIGH_RISK_ERROR_MESSAGE}`),
    });
    serviceError.stack = `stack ${HIGH_RISK_ERROR_MESSAGE}`;
    const { service, prisma, wechat } = build({
      quotaUpdate: () => Promise.reject(serviceError),
    });

    await expect(service.dispatchBroadcast(notification)).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expectNoSensitiveLogContent(loggedText(warnSpy));
    expect(wechat.sendSubscribeMessage).not.toHaveBeenCalled();
    expect(prisma.notificationDelivery.create).not.toHaveBeenCalled();
  });
});
