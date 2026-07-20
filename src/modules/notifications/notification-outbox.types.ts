import type { Prisma } from '@prisma/client';

import {
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_CHANNEL_WECHAT,
  NOTIFICATION_VISIBILITIES,
  OUTBOX_EVENT_ADMIN_SMS,
  OUTBOX_EVENT_BIRTHDAY_SMS,
  OUTBOX_EVENT_SYSTEM_BROADCAST,
  OUTBOX_EVENT_TARGETED_NOTIFICATION,
  OUTBOX_EVENT_WECHAT_BROADCAST,
  OUTBOX_EVENT_WECHAT_DELIVERY,
  OUTBOX_ADMIN_PAYLOAD_VERSION,
  OUTBOX_PAYLOAD_VERSION,
} from './notification.constants';

export interface NotificationOutboxEnqueueInput {
  eventKey: string;
  eventType: string;
  payloadVersion: number;
  payload: Prisma.InputJsonValue;
  aggregateType: string;
  aggregateId: string;
  destinationType: string;
  destinationRef: string;
}

type NotificationOutboxSafetyInput = Omit<NotificationOutboxEnqueueInput, 'payload'> & {
  payload: unknown;
};

export interface TargetedNotificationOutboxPayload {
  recipientMemberId: string;
  notificationTypeCode: string;
  title: string;
  body: string;
  channels: string[];
}

export interface SystemBroadcastOutboxPayload {
  notificationTypeCode: string;
  title: string;
  body: string;
  visibilityCode: string;
}

export interface WechatBroadcastOutboxPayload {
  notificationId: string;
  publishGeneration: number;
}

export interface WechatDeliveryOutboxPayload {
  notificationId: string;
  memberId: string;
  publishGeneration?: number;
}

export interface BirthdaySmsOutboxPayload {
  memberId: string;
  dateKey: string;
}

export interface AdminSmsOutboxPayload {
  notificationId: string;
  memberId: string;
  publishGeneration?: number;
}

export interface OutboxExecutionResult {
  effectPerformed: boolean;
  value?: unknown;
}

export type KnownNotificationOutboxPayload =
  | TargetedNotificationOutboxPayload
  | SystemBroadcastOutboxPayload
  | WechatBroadcastOutboxPayload
  | WechatDeliveryOutboxPayload
  | BirthdaySmsOutboxPayload
  | AdminSmsOutboxPayload;

const CUID = /^c[a-z0-9]{20,31}$/;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function isKnownNotificationOutboxEvent(eventType: string): boolean {
  return [
    OUTBOX_EVENT_TARGETED_NOTIFICATION,
    OUTBOX_EVENT_SYSTEM_BROADCAST,
    OUTBOX_EVENT_WECHAT_BROADCAST,
    OUTBOX_EVENT_WECHAT_DELIVERY,
    OUTBOX_EVENT_BIRTHDAY_SMS,
    OUTBOX_EVENT_ADMIN_SMS,
  ].includes(eventType);
}

export function parseKnownNotificationOutboxPayload(
  eventType: string,
  payloadVersion: number,
  value: unknown,
): KnownNotificationOutboxPayload {
  if (!isRecord(value)) {
    throw new NotificationOutboxPayloadError(eventType, payloadVersion);
  }
  switch (eventType) {
    case OUTBOX_EVENT_TARGETED_NOTIFICATION:
      requireVersion(payloadVersion, OUTBOX_PAYLOAD_VERSION, eventType);
      exactKeys(value, ['recipientMemberId', 'notificationTypeCode', 'title', 'body', 'channels']);
      return {
        recipientMemberId: cuid(value.recipientMemberId),
        notificationTypeCode: shortString(value.notificationTypeCode, 64),
        title: shortString(value.title, 200),
        body: shortString(value.body, 5000),
        channels: channelList(value.channels),
      };
    case OUTBOX_EVENT_SYSTEM_BROADCAST:
      requireVersion(payloadVersion, OUTBOX_PAYLOAD_VERSION, eventType);
      exactKeys(value, ['notificationTypeCode', 'title', 'body', 'visibilityCode']);
      return {
        notificationTypeCode: shortString(value.notificationTypeCode, 64),
        title: shortString(value.title, 200),
        body: shortString(value.body, 5000),
        visibilityCode: enumString(value.visibilityCode, NOTIFICATION_VISIBILITIES),
      };
    case OUTBOX_EVENT_WECHAT_BROADCAST:
      if (payloadVersion === OUTBOX_PAYLOAD_VERSION) {
        exactKeys(value, ['notificationId']);
        return { notificationId: resourceRef(value.notificationId), publishGeneration: 0 };
      }
      requireVersion(payloadVersion, OUTBOX_ADMIN_PAYLOAD_VERSION, eventType);
      exactKeys(value, ['notificationId', 'publishGeneration']);
      return {
        notificationId: resourceRef(value.notificationId),
        publishGeneration: generation(value.publishGeneration),
      };
    case OUTBOX_EVENT_WECHAT_DELIVERY:
      if (payloadVersion === OUTBOX_PAYLOAD_VERSION) {
        exactKeys(value, ['notificationId', 'memberId']);
        return {
          notificationId: resourceRef(value.notificationId),
          memberId: cuid(value.memberId),
        };
      }
      requireVersion(payloadVersion, OUTBOX_ADMIN_PAYLOAD_VERSION, eventType);
      exactKeys(value, ['notificationId', 'memberId', 'publishGeneration']);
      return {
        notificationId: resourceRef(value.notificationId),
        memberId: cuid(value.memberId),
        publishGeneration: generation(value.publishGeneration),
      };
    case OUTBOX_EVENT_BIRTHDAY_SMS:
      requireVersion(payloadVersion, OUTBOX_PAYLOAD_VERSION, eventType);
      exactKeys(value, ['memberId', 'dateKey']);
      return {
        memberId: cuid(value.memberId),
        dateKey: dateKey(value.dateKey),
      };
    case OUTBOX_EVENT_ADMIN_SMS:
      if (payloadVersion === OUTBOX_PAYLOAD_VERSION) {
        exactKeys(value, ['notificationId', 'memberId']);
        return {
          notificationId: resourceRef(value.notificationId),
          memberId: cuid(value.memberId),
        };
      }
      requireVersion(payloadVersion, OUTBOX_ADMIN_PAYLOAD_VERSION, eventType);
      exactKeys(value, ['notificationId', 'memberId', 'publishGeneration']);
      return {
        notificationId: resourceRef(value.notificationId),
        memberId: cuid(value.memberId),
        publishGeneration: generation(value.publishGeneration),
      };
    default:
      throw new NotificationOutboxPayloadError(eventType, payloadVersion);
  }
}

function requireVersion(actual: number, expected: number, eventType: string): void {
  if (actual !== expected) throw new NotificationOutboxPayloadError(eventType, actual);
}

function generation(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new NotificationOutboxPayloadError(
      'invalid-publish-generation',
      OUTBOX_ADMIN_PAYLOAD_VERSION,
    );
  }
  return value as number;
}

export class NotificationOutboxPayloadError extends Error {
  constructor(eventType: string, payloadVersion: number) {
    super(`UNSUPPORTED_NOTIFICATION_OUTBOX_PAYLOAD: ${eventType}@${payloadVersion}`);
    this.name = 'NotificationOutboxPayloadError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new NotificationOutboxPayloadError('invalid-shape', OUTBOX_PAYLOAD_VERSION);
  }
}

function cuid(value: unknown): string {
  if (typeof value !== 'string' || !CUID.test(value)) {
    throw new NotificationOutboxPayloadError('invalid-internal-id', OUTBOX_PAYLOAD_VERSION);
  }
  return value;
}

function resourceRef(value: unknown): string {
  if (typeof value !== 'string' || !CUID.test(value)) {
    throw new NotificationOutboxPayloadError('invalid-resource-ref', OUTBOX_PAYLOAD_VERSION);
  }
  return value;
}

function shortString(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new NotificationOutboxPayloadError('invalid-string', OUTBOX_PAYLOAD_VERSION);
  }
  return value;
}

function enumString<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new NotificationOutboxPayloadError('invalid-enum', OUTBOX_PAYLOAD_VERSION);
  }
  return value;
}

function channelList(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (channel) =>
        channel !== NOTIFICATION_CHANNEL_IN_APP && channel !== NOTIFICATION_CHANNEL_WECHAT,
    )
  ) {
    throw new NotificationOutboxPayloadError('invalid-channels', OUTBOX_PAYLOAD_VERSION);
  }
  const channels = new Set(value as string[]);
  return [
    NOTIFICATION_CHANNEL_IN_APP,
    ...(channels.has(NOTIFICATION_CHANNEL_WECHAT) ? [NOTIFICATION_CHANNEL_WECHAT] : []),
  ];
}

function dateKey(value: unknown): string {
  if (typeof value !== 'string' || !DATE_KEY.test(value)) {
    throw new NotificationOutboxPayloadError('invalid-date-key', OUTBOX_PAYLOAD_VERSION);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new NotificationOutboxPayloadError('invalid-date-key', OUTBOX_PAYLOAD_VERSION);
  }
  return value;
}

export class NotificationOutboxInvariantError extends Error {
  constructor(message: string) {
    super(`NOTIFICATION_OUTBOX_INVARIANT: ${message}`);
    this.name = 'NotificationOutboxInvariantError';
  }
}

export class NotificationOutboxLeaseLostError extends Error {
  constructor(id: string) {
    super(`NOTIFICATION_OUTBOX_LEASE_LOST: ${id}`);
    this.name = 'NotificationOutboxLeaseLostError';
  }
}

const REDACTED_OUTBOX_TEXT = '[REDACTED]';
const URL_CANDIDATE = /https?:\/\/[^\s<>"'，。！？；：、（）[\]{}]+/gi;
const JWT_CANDIDATE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const SECRET_TOKEN_CANDIDATE = /\b(?:sk-|AKID)[A-Za-z0-9_-]{12,}\b/gi;
const BEARER_CANDIDATE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const OPENID_CANDIDATE = /\bo[A-Za-z0-9_-]{20,}\b/g;
const PHONE_CANDIDATE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const SENSITIVE_QUERY_KEYS = new Set([
  'access_token',
  'credential',
  'security-token',
  'secret',
  'secretid',
  'sign',
  'signature',
  'token',
  'x-amz-credential',
  'x-amz-security-token',
  'x-amz-signature',
  'x-cos-security-token',
  'x-cos-signature',
  'q-ak',
  'q-signature',
]);

// notifications-owned canonical redactor：只作用于 known targeted/system title/body。
// 普通 Unicode 逐字保留；敏感片段统一替换固定占位，重复执行不再变化。
export function redactNotificationOutboxText(value: string): string {
  return value
    .replace(URL_CANDIDATE, (candidate) =>
      isSensitiveSignedUrl(candidate) ? REDACTED_OUTBOX_TEXT : candidate,
    )
    .replace(BEARER_CANDIDATE, REDACTED_OUTBOX_TEXT)
    .replace(JWT_CANDIDATE, REDACTED_OUTBOX_TEXT)
    .replace(SECRET_TOKEN_CANDIDATE, REDACTED_OUTBOX_TEXT)
    .replace(OPENID_CANDIDATE, REDACTED_OUTBOX_TEXT)
    .replace(PHONE_CANDIDATE, REDACTED_OUTBOX_TEXT);
}

// producer 写入路径：先仅清洗 known targeted/system@v1 的自由文本，再做 exact parser / canonical
// channel，最后以 strict guard 复检将要持久化的最终内容。extra key / unknown type/version 仍 fail-closed。
export function normalizeNotificationOutboxInput(
  input: NotificationOutboxEnqueueInput,
): NotificationOutboxEnqueueInput {
  assertSafeMetadata(input);
  let candidate: unknown = input.payload;
  if (
    input.payloadVersion === OUTBOX_PAYLOAD_VERSION &&
    (input.eventType === OUTBOX_EVENT_TARGETED_NOTIFICATION ||
      input.eventType === OUTBOX_EVENT_SYSTEM_BROADCAST) &&
    isRecord(input.payload)
  ) {
    const payloadRecord = input.payload as Record<string, unknown>;
    candidate = {
      ...payloadRecord,
      ...(typeof payloadRecord.title === 'string'
        ? { title: redactNotificationOutboxText(payloadRecord.title) }
        : {}),
      ...(typeof payloadRecord.body === 'string'
        ? { body: redactNotificationOutboxText(payloadRecord.body) }
        : {}),
    };
  }
  let payload: KnownNotificationOutboxPayload;
  try {
    payload = parseKnownNotificationOutboxPayload(input.eventType, input.payloadVersion, candidate);
  } catch {
    throw new NotificationOutboxInvariantError(
      `eventType=${input.eventType}@${input.payloadVersion} payload shape is invalid`,
    );
  }
  walkPayload(payload, '$');
  return { ...input, payload: payload as unknown as Prisma.InputJsonValue };
}

// worker 读取路径永不 sanitize：直 SQL / 旧脏 row 必须在任何业务 Effect 前 exact parse +
// raw strict guard，失败由 worker 映射 terminal dead，不能“修好后继续执行”。
export function assertStoredNotificationOutboxIntentSafe(
  input: NotificationOutboxSafetyInput,
): void {
  assertSafeMetadata(input);
  if (!isKnownNotificationOutboxEvent(input.eventType)) {
    throw new NotificationOutboxPayloadError(input.eventType, input.payloadVersion);
  }
  parseKnownNotificationOutboxPayload(input.eventType, input.payloadVersion, input.payload);
  walkPayload(input.payload, '$');
}

function assertSafeMetadata(input: NotificationOutboxSafetyInput): void {
  for (const [field, value] of [
    ['eventKey', input.eventKey],
    ['aggregateType', input.aggregateType],
    ['aggregateId', input.aggregateId],
    ['destinationType', input.destinationType],
    ['destinationRef', input.destinationRef],
  ] as const) {
    if (containsSensitiveValue(value) || FORBIDDEN_PAYLOAD_KEY.test(value)) {
      throw new NotificationOutboxInvariantError(`${field} contains forbidden sensitive material`);
    }
  }
}

const FORBIDDEN_PAYLOAD_KEY =
  /(phone|mobile|openid|token|secret|credential|signed.?url|provider.?request|provider.?response)/i;

function walkPayload(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (containsSensitiveValue(value)) {
      throw new NotificationOutboxInvariantError(`payload contains sensitive value at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => walkPayload(child, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_PAYLOAD_KEY.test(key)) {
        throw new NotificationOutboxInvariantError(`payload contains forbidden key ${path}.${key}`);
      }
      walkPayload(child, `${path}.${key}`);
    }
  }
}

function containsSensitiveValue(value: string): boolean {
  return redactNotificationOutboxText(value) !== value;
}

function isSensitiveSignedUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return [...url.searchParams.keys()].some((key) => SENSITIVE_QUERY_KEYS.has(key.toLowerCase()));
  } catch {
    return false;
  }
}
