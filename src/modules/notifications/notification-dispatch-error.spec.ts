import { Prisma } from '@prisma/client';

import { SmsChannelUnavailableError, SmsProviderSendError } from '../sms/sms.types';
import { WechatApiError } from '../wechat/wechat.types';
import {
  classifyNotificationDispatchError,
  notificationDispatchFailureLog,
} from './notification-dispatch-error';
import { NotificationOutboxLeaseLostError } from './notification-outbox.types';

describe('classifyNotificationDispatchError', () => {
  it.each([
    [
      new SmsChannelUnavailableError('SecretId=TEST_SECRET'),
      { category: 'channel-unavailable', code: 'CHANNEL_UNAVAILABLE', retryable: true },
    ],
    [
      new SmsProviderSendError('LimitExceeded', 'SecretKey=TEST_KEY'),
      { category: 'provider-rejected', code: 'SMS_PROVIDER_SEND_FAILED', retryable: true },
    ],
    [
      new WechatApiError('43101', 'openid-sensitive-value'),
      { category: 'provider-rejected', code: '43101', retryable: false },
    ],
    [
      new NotificationOutboxLeaseLostError('intent-sensitive-value'),
      { category: 'lease-lost', code: 'OUTBOX_LEASE_LOST', retryable: true },
    ],
    [
      new Prisma.PrismaClientKnownRequestError('postgresql://db.internal/app', {
        code: 'P2002',
        clientVersion: 'test',
      }),
      { category: 'database-error', code: 'P2002', retryable: true },
    ],
  ] as const)('已知错误只输出后端映射的 category/code', (error, expected) => {
    expect(classifyNotificationDispatchError(error)).toEqual(expected);
  });

  it('未知错误只输出 unexpected-error/code=null，不信任 name/message', () => {
    const error = new Error('Authorization: Bearer test-token');
    error.name = 'SecretId=TEST_SECRET';

    expect(classifyNotificationDispatchError(error)).toEqual({
      category: 'unexpected-error',
      code: null,
      retryable: true,
    });
  });

  it('安全日志对象只保留闭集 operation、分类结果和显式稳定上下文', () => {
    const error = new Error(
      'https://provider.example.com/private/path 13800138000 bucket/private/object-key',
    );
    error.stack = 'stack SecretKey=TEST_KEY';
    Object.defineProperty(error, 'cause', {
      value: new Error('postgresql://user:password@db.internal:5432/app'),
    });

    const log = notificationDispatchFailureLog('outbox-intent', error, {
      intentId: 'intent-1',
      aggregateType: 'notification',
      aggregateId: 'notification-1',
      attempt: 2,
    });

    expect(log).toEqual({
      event: 'notification_dispatch_failed',
      operation: 'outbox-intent',
      safeErrorCategory: 'unexpected-error',
      safeErrorCode: null,
      retryable: true,
      intentId: 'intent-1',
      aggregateType: 'notification',
      aggregateId: 'notification-1',
      attempt: 2,
    });
    expect(JSON.stringify(log)).not.toMatch(
      /provider\.example|13800138000|object-key|TEST_KEY|postgresql/,
    );
  });
});
