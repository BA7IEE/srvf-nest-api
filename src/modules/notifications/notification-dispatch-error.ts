import { Prisma } from '@prisma/client';

import { SmsChannelUnavailableError, SmsProviderSendError } from '../sms/sms.types';
import {
  WechatApiError,
  WechatChannelUnavailableError,
  WechatCodeInvalidError,
} from '../wechat/wechat.types';
import {
  NotificationOutboxInvariantError,
  NotificationOutboxLeaseLostError,
  NotificationOutboxPayloadError,
} from './notification-outbox.types';

export type NotificationDispatchErrorCategory =
  | 'channel-unavailable'
  | 'provider-rejected'
  | 'provider-timeout'
  | 'database-error'
  | 'lease-lost'
  | 'invalid-outbox-payload'
  | 'unexpected-error';

export interface ClassifiedNotificationDispatchError {
  category: NotificationDispatchErrorCategory;
  code: string | null;
  retryable: boolean;
}

export type NotificationDispatchOperation =
  | 'wechat-broadcast'
  | 'wechat-directed'
  | 'wechat-recipient'
  | 'sms-broadcast'
  | 'sms-recipient'
  | 'outbox-drain'
  | 'outbox-intent';

export interface NotificationDispatchLogContext {
  notificationId?: string;
  intentId?: string;
  aggregateType?: string;
  aggregateId?: string;
  attempt?: number;
}

export interface SafeNotificationDispatchFailureLog extends NotificationDispatchLogContext {
  event: 'notification_dispatch_failed';
  operation: NotificationDispatchOperation;
  safeErrorCategory: NotificationDispatchErrorCategory;
  safeErrorCode: string | null;
  retryable: boolean;
}

const SAFE_WECHAT_ERROR_CODES = new Set([
  'CHANNEL_UNAVAILABLE',
  'FETCH_ERROR',
  'HTTP_ERROR',
  'INVALID_RESPONSE',
  'MISSING_OPENID',
  'MISSING_TOKEN',
  'TOKEN_FAILED',
]);

export function classifyNotificationDispatchError(
  error: unknown,
): ClassifiedNotificationDispatchError {
  if (
    error instanceof SmsChannelUnavailableError ||
    error instanceof WechatChannelUnavailableError
  ) {
    return { category: 'channel-unavailable', code: 'CHANNEL_UNAVAILABLE', retryable: true };
  }
  if (error instanceof SmsProviderSendError) {
    return {
      category: 'provider-rejected',
      code: 'SMS_PROVIDER_SEND_FAILED',
      retryable: true,
    };
  }
  if (error instanceof WechatCodeInvalidError) {
    return { category: 'provider-rejected', code: 'WECHAT_CODE_INVALID', retryable: false };
  }
  if (error instanceof WechatApiError) {
    const code = safeWechatErrorCode(error.errCode);
    return {
      category:
        code === 'FETCH_ERROR' || code === 'HTTP_ERROR' ? 'provider-timeout' : 'provider-rejected',
      code,
      retryable:
        code === 'FETCH_ERROR' || code === 'HTTP_ERROR' || code === 'TOKEN_FAILED' || code === null,
    };
  }
  if (error instanceof NotificationOutboxLeaseLostError) {
    return { category: 'lease-lost', code: 'OUTBOX_LEASE_LOST', retryable: true };
  }
  if (
    error instanceof NotificationOutboxPayloadError ||
    error instanceof NotificationOutboxInvariantError ||
    hasKnownErrorName(error, [
      'UnsupportedNotificationOutboxEventError',
      'NotificationOutboxInvariantError',
      'NotificationOutboxPayloadError',
    ])
  ) {
    return {
      category: 'invalid-outbox-payload',
      code: 'INVALID_OUTBOX_PAYLOAD',
      retryable: false,
    };
  }
  if (hasKnownErrorName(error, ['NotificationOutboxGenerationConflictError'])) {
    return { category: 'lease-lost', code: 'OUTBOX_GENERATION_CONFLICT', retryable: true };
  }
  if (hasKnownErrorName(error, ['TransientNotificationProviderError'])) {
    return {
      category: 'provider-rejected',
      code: 'TRANSIENT_NOTIFICATION_PROVIDER',
      retryable: true,
    };
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && /^P\d{4}$/.test(error.code)) {
    return { category: 'database-error', code: error.code, retryable: true };
  }
  if (hasKnownErrorName(error, ['TimeoutError', 'AbortError'])) {
    return { category: 'provider-timeout', code: 'PROVIDER_TIMEOUT', retryable: true };
  }
  return { category: 'unexpected-error', code: null, retryable: true };
}

export function notificationDispatchFailureLog(
  operation: NotificationDispatchOperation,
  error: unknown,
  context: NotificationDispatchLogContext = {},
): SafeNotificationDispatchFailureLog {
  const classified = classifyNotificationDispatchError(error);
  return {
    event: 'notification_dispatch_failed',
    operation,
    safeErrorCategory: classified.category,
    safeErrorCode: classified.code,
    retryable: classified.retryable,
    ...(context.notificationId === undefined ? {} : { notificationId: context.notificationId }),
    ...(context.intentId === undefined ? {} : { intentId: context.intentId }),
    ...(context.aggregateType === undefined ? {} : { aggregateType: context.aggregateType }),
    ...(context.aggregateId === undefined ? {} : { aggregateId: context.aggregateId }),
    ...(context.attempt === undefined ? {} : { attempt: context.attempt }),
  };
}

function safeWechatErrorCode(code: string): string | null {
  if (SAFE_WECHAT_ERROR_CODES.has(code)) return code;
  return /^-?\d{1,8}$/.test(code) ? code : null;
}

function hasKnownErrorName(error: unknown, names: readonly string[]): boolean {
  return error instanceof Error && names.includes(error.name);
}
