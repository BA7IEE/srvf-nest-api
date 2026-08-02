import {
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_CHANNEL_SMS,
  NOTIFICATION_CHANNEL_WECHAT,
  NOTIFICATION_CHANNEL_WECOM,
  OUTBOX_ADMIN_PAYLOAD_VERSION,
  OUTBOX_EVENT_TARGETED_NOTIFICATION,
  OUTBOX_EVENT_WECOM_BROADCAST,
  OUTBOX_EVENT_WECOM_DELIVERY,
  OUTBOX_PAYLOAD_VERSION,
} from './notification.constants';
import {
  assertStoredNotificationOutboxIntentSafe,
  extractWecomDeliveryRootId,
  isKnownNotificationOutboxEvent,
  normalizeNotificationOutboxInput,
  NotificationOutboxInvariantError,
  NotificationOutboxPayloadError,
  parseKnownNotificationOutboxPayload,
  type TargetedNotificationOutboxPayload,
} from './notification-outbox.types';

// T5B —— 企业微信 outbox 事件的 **strict payload parser** 与 **envelope coherence** 单测
// (冻结稿 §10.1 / §10.2 / §10.3;§14.3 第 2/3/4/5 条)。
//
// 本文件只喂**合成数据**,不碰 DB —— 这两道闸的全部判据都是纯函数,
// 放进 e2e 反而看不清是哪一条拦下来的。

const NOTIFICATION_ID = 'cm00000000000000000000001';
const MEMBER_ID = 'cm00000000000000000000002';
const ROOT_INTENT_ID = 'cm00000000000000000000003';
const GENERATION = 3;

const broadcastEnvelope = (overrides: Record<string, unknown> = {}) => ({
  eventKey: `wecom-broadcast:${NOTIFICATION_ID}:${GENERATION}`,
  eventType: OUTBOX_EVENT_WECOM_BROADCAST,
  payloadVersion: OUTBOX_ADMIN_PAYLOAD_VERSION,
  payload: { notificationId: NOTIFICATION_ID, publishGeneration: GENERATION },
  aggregateType: 'notification',
  aggregateId: NOTIFICATION_ID,
  destinationType: 'broadcast',
  destinationRef: NOTIFICATION_ID,
  ...overrides,
});

const adminChildEnvelope = (overrides: Record<string, unknown> = {}) => ({
  eventKey: `wecom-delivery:${NOTIFICATION_ID}:${ROOT_INTENT_ID}:${MEMBER_ID}`,
  eventType: OUTBOX_EVENT_WECOM_DELIVERY,
  payloadVersion: OUTBOX_ADMIN_PAYLOAD_VERSION,
  payload: {
    notificationId: NOTIFICATION_ID,
    memberId: MEMBER_ID,
    publishGeneration: GENERATION,
  },
  aggregateType: 'notification',
  aggregateId: NOTIFICATION_ID,
  destinationType: 'member',
  destinationRef: MEMBER_ID,
  ...overrides,
});

const systemChildEnvelope = (overrides: Record<string, unknown> = {}) => ({
  eventKey: `wecom-delivery:${NOTIFICATION_ID}:${MEMBER_ID}`,
  eventType: OUTBOX_EVENT_WECOM_DELIVERY,
  payloadVersion: OUTBOX_PAYLOAD_VERSION,
  payload: { notificationId: NOTIFICATION_ID, memberId: MEMBER_ID },
  aggregateType: 'notification',
  aggregateId: NOTIFICATION_ID,
  destinationType: 'member',
  destinationRef: MEMBER_ID,
  ...overrides,
});

describe('T5B 企业微信 outbox 事件闭集', () => {
  it('两个新事件都在 known 闭集内(否则 worker 会判 unsupported terminal dead)', () => {
    expect(isKnownNotificationOutboxEvent(OUTBOX_EVENT_WECOM_BROADCAST)).toBe(true);
    expect(isKnownNotificationOutboxEvent(OUTBOX_EVENT_WECOM_DELIVERY)).toBe(true);
  });

  it('事件名与微信小程序的两个**不同**(共用名字 = 两渠道共用 active-slot,互斥)', () => {
    expect(OUTBOX_EVENT_WECOM_BROADCAST).toBe('notification.wecom-broadcast');
    expect(OUTBOX_EVENT_WECOM_DELIVERY).toBe('notification.wecom-delivery');
    expect(OUTBOX_EVENT_WECOM_DELIVERY).not.toBe('notification.wechat-delivery');
  });
});

describe('T5B strict payload parser', () => {
  it('广播 root 只认 v2(本渠道没有无 generation 的历史行)', () => {
    expect(() =>
      parseKnownNotificationOutboxPayload(OUTBOX_EVENT_WECOM_BROADCAST, OUTBOX_PAYLOAD_VERSION, {
        notificationId: NOTIFICATION_ID,
      }),
    ).toThrow(NotificationOutboxPayloadError);
  });

  it('广播 root v2 正常解析', () => {
    expect(
      parseKnownNotificationOutboxPayload(
        OUTBOX_EVENT_WECOM_BROADCAST,
        OUTBOX_ADMIN_PAYLOAD_VERSION,
        { notificationId: NOTIFICATION_ID, publishGeneration: GENERATION },
      ),
    ).toEqual({ notificationId: NOTIFICATION_ID, publishGeneration: GENERATION });
  });

  it('child v1(系统定向)与 v2(admin 广播)各自正常解析', () => {
    expect(
      parseKnownNotificationOutboxPayload(OUTBOX_EVENT_WECOM_DELIVERY, OUTBOX_PAYLOAD_VERSION, {
        notificationId: NOTIFICATION_ID,
        memberId: MEMBER_ID,
      }),
    ).toEqual({ notificationId: NOTIFICATION_ID, memberId: MEMBER_ID });
    expect(
      parseKnownNotificationOutboxPayload(
        OUTBOX_EVENT_WECOM_DELIVERY,
        OUTBOX_ADMIN_PAYLOAD_VERSION,
        { notificationId: NOTIFICATION_ID, memberId: MEMBER_ID, publishGeneration: GENERATION },
      ),
    ).toEqual({
      notificationId: NOTIFICATION_ID,
      memberId: MEMBER_ID,
      publishGeneration: GENERATION,
    });
  });

  // D-WC-18:payload 只存内部引用。多一个键就拒 —— 这是 wecomUserId / token / corpId
  // 进不了库的**真正**执行位(而不是靠字段名黑名单)。
  it.each([
    ['wecomUserId', { wecomUserId: 'zhangsan' }],
    ['corpId', { corpId: 'ww1234567890' }],
    ['agentId', { agentId: 1000002 }],
    ['deepLink', { deepLink: 'https://srvf.example.org/notifications/x' }],
  ])('child payload 夹带 %s 被 exactKeys 拒', (_label, extra) => {
    expect(() =>
      parseKnownNotificationOutboxPayload(
        OUTBOX_EVENT_WECOM_DELIVERY,
        OUTBOX_ADMIN_PAYLOAD_VERSION,
        {
          notificationId: NOTIFICATION_ID,
          memberId: MEMBER_ID,
          publishGeneration: GENERATION,
          ...extra,
        },
      ),
    ).toThrow(NotificationOutboxPayloadError);
  });

  it('缺 publishGeneration 的 v2 child 被拒(不给"当成 0"留口子)', () => {
    expect(() =>
      parseKnownNotificationOutboxPayload(
        OUTBOX_EVENT_WECOM_DELIVERY,
        OUTBOX_ADMIN_PAYLOAD_VERSION,
        { notificationId: NOTIFICATION_ID, memberId: MEMBER_ID },
      ),
    ).toThrow(NotificationOutboxPayloadError);
  });
});

describe('T5B envelope coherence', () => {
  it.each([
    ['广播 root', broadcastEnvelope()],
    ['admin 广播 child', adminChildEnvelope()],
    ['系统定向 child', systemChildEnvelope()],
  ])('%s 的正常信封通过', (_label, envelope) => {
    expect(() => assertStoredNotificationOutboxIntentSafe(envelope)).not.toThrow();
    expect(() => normalizeNotificationOutboxInput(envelope)).not.toThrow();
  });

  // 最硬的一条:destinationRef 是 active-slot partial unique 键的一部分。
  // 允许它与 payload.memberId 错开 = 直插脏行就能用假 destinationRef 绕过单 active 槽。
  it('destinationRef 与 payload.memberId 不一致 → fail-closed', () => {
    expect(() =>
      assertStoredNotificationOutboxIntentSafe(
        adminChildEnvelope({ destinationRef: 'cm00000000000000000000009' }),
      ),
    ).toThrow(NotificationOutboxInvariantError);
  });

  it.each([
    ['aggregateId 错', { aggregateId: 'cm00000000000000000000009' }],
    ['aggregateType 错', { aggregateType: 'member' }],
    ['destinationType 错', { destinationType: 'broadcast' }],
    [
      'eventKey 前缀写成 wechat',
      {
        eventKey: `wechat-delivery:${NOTIFICATION_ID}:${ROOT_INTENT_ID}:${MEMBER_ID}`,
      },
    ],
    [
      'eventKey 里的 notificationId 错',
      {
        eventKey: `wecom-delivery:cm00000000000000000000009:${ROOT_INTENT_ID}:${MEMBER_ID}`,
      },
    ],
    [
      'eventKey 里的 memberId 错',
      {
        eventKey: `wecom-delivery:${NOTIFICATION_ID}:${ROOT_INTENT_ID}:cm00000000000000000000009`,
      },
    ],
    [
      'eventKey 段数不对(v2 用了 v1 形状)',
      {
        eventKey: `wecom-delivery:${NOTIFICATION_ID}:${MEMBER_ID}`,
      },
    ],
  ])('admin child %s → fail-closed', (_label, overrides) => {
    expect(() => assertStoredNotificationOutboxIntentSafe(adminChildEnvelope(overrides))).toThrow(
      NotificationOutboxInvariantError,
    );
  });

  it('广播 root 的 eventKey 必须含 publishGeneration', () => {
    expect(() =>
      assertStoredNotificationOutboxIntentSafe(
        broadcastEnvelope({ eventKey: `wecom-broadcast:${NOTIFICATION_ID}` }),
      ),
    ).toThrow(NotificationOutboxInvariantError);
  });

  it('extractWecomDeliveryRootId:v2 取出 rootId,v1 恒 null', () => {
    expect(
      extractWecomDeliveryRootId(
        `wecom-delivery:${NOTIFICATION_ID}:${ROOT_INTENT_ID}:${MEMBER_ID}`,
        OUTBOX_ADMIN_PAYLOAD_VERSION,
      ),
    ).toBe(ROOT_INTENT_ID);
    expect(
      extractWecomDeliveryRootId(
        `wecom-delivery:${NOTIFICATION_ID}:${MEMBER_ID}`,
        OUTBOX_PAYLOAD_VERSION,
      ),
    ).toBeNull();
    // rootId 段不是 cuid → 不承认(防"随便塞个字符串冒充 root")。
    expect(
      extractWecomDeliveryRootId(
        `wecom-delivery:${NOTIFICATION_ID}:not-a-cuid:${MEMBER_ID}`,
        OUTBOX_ADMIN_PAYLOAD_VERSION,
      ),
    ).toBeNull();
  });
});

describe('T5B targeted parser 的 channel 闭集(§10.1 末条)', () => {
  const targeted = (channels: unknown[]) => ({
    eventKey: `targeted:${MEMBER_ID}`,
    eventType: OUTBOX_EVENT_TARGETED_NOTIFICATION,
    payloadVersion: OUTBOX_PAYLOAD_VERSION,
    payload: {
      recipientMemberId: MEMBER_ID,
      notificationTypeCode: 'general',
      title: '标题',
      body: '正文',
      channels,
    },
    aggregateType: 'notification',
    aggregateId: NOTIFICATION_ID,
    destinationType: 'member',
    destinationRef: MEMBER_ID,
  });

  const channelsOf = (envelope: ReturnType<typeof targeted>): string[] =>
    (
      parseKnownNotificationOutboxPayload(
        envelope.eventType,
        envelope.payloadVersion,
        envelope.payload,
      ) as TargetedNotificationOutboxPayload
    ).channels;

  it('允许 wecom', () => {
    expect(channelsOf(targeted([NOTIFICATION_CHANNEL_IN_APP, NOTIFICATION_CHANNEL_WECOM]))).toEqual(
      [NOTIFICATION_CHANNEL_IN_APP, NOTIFICATION_CHANNEL_WECOM],
    );
  });

  it('wechat 与 wecom 可以并存,且归一化顺序固定(canonicalJson 对账不被顺序抖动误判)', () => {
    expect(channelsOf(targeted([NOTIFICATION_CHANNEL_WECOM, NOTIFICATION_CHANNEL_WECHAT]))).toEqual(
      [NOTIFICATION_CHANNEL_IN_APP, NOTIFICATION_CHANNEL_WECHAT, NOTIFICATION_CHANNEL_WECOM],
    );
  });

  // 行为锁:T5A/S5 的既有语义 —— targeted sms 永远拒(短信只由 admin 显式计费确认端点触发)。
  it('仍然拒 targeted sms', () => {
    expect(() => channelsOf(targeted([NOTIFICATION_CHANNEL_SMS]))).toThrow(
      NotificationOutboxPayloadError,
    );
  });

  it.each([
    ['未知渠道', 'telegram'],
    ['非字符串', 42],
    ['null', null],
  ])('仍然拒 %s', (_label, value) => {
    expect(() => channelsOf(targeted([value]))).toThrow(NotificationOutboxPayloadError);
  });

  it('不含 wecom 时输出逐字不变(既有微信/站内行为零变化)', () => {
    expect(channelsOf(targeted([NOTIFICATION_CHANNEL_WECHAT]))).toEqual([
      NOTIFICATION_CHANNEL_IN_APP,
      NOTIFICATION_CHANNEL_WECHAT,
    ]);
    expect(channelsOf(targeted([NOTIFICATION_CHANNEL_IN_APP]))).toEqual([
      NOTIFICATION_CHANNEL_IN_APP,
    ]);
  });
});
