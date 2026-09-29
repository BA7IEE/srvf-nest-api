import { Prisma } from '@prisma/client';

import {
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_DIRECTED_VISIBILITY,
  NOTIFICATION_TYPE_ACTIVITY_PUBLISHED,
  OUTBOX_EVENT_SYSTEM_BROADCAST,
  OUTBOX_EVENT_TARGETED_NOTIFICATION,
  OUTBOX_EVENT_WECHAT_DELIVERY,
  OUTBOX_PAYLOAD_VERSION,
} from './notification.constants';
import {
  assertStoredNotificationOutboxIntentSafe,
  isForbiddenNotificationOutboxPayloadKey,
  normalizeNotificationOutboxInput,
  redactNotificationOutboxText,
} from './notification-outbox.types';

/**
 * envelope 元数据闸(`assertSafeMetadata`)的判据。
 *
 * 立项由来:值侧此前直接复用**键名**正则做裸子串匹配,于是 `aggregateId` /
 * `destinationRef` / `eventKey` 里装的不透明 id(cuid)只要恰好含 `token` 等禁词子串，或
 * 含 11 位手机号形状数字，就可能被硬抛。前者由字母数字边界修复；后者来自独立自由文本
 * redactor，必须在结构化 ID 槽精确遮掉完整 CUID token。两条防线独立，不能混作一条。
 *
 * ⚠️ 本文件里的 id **全部写成字面量**:随机生成会让「恰好含 token 的 cuid」偶尔不触发,
 * 判据当场退化成 flake —— 那正是本次要修掉的病。
 */

// 实测扫出来的一条真误判样本(200 万条随机 cuid 里的命中):结尾恰好是 "token"。
// 写成字面量而非现场生成 —— 随机样本会让这条判据偶尔不触发,当场退化成 flake。
const FALSE_POSITIVE_CUID = 'c8ob12qafrq354c5ptvjtoken';
const PLAIN_CUID = 'cmt38187b00abcdefghijklm';
// 固定合法 CUID；中段 `13800001111` 会被自由文本手机号正则命中。
const PHONE_SHAPED_CUID = 'cabc13800001111defghijkl';
// 由真实 creationRequestHash 输入确定性搜索得到；中段 `14004586116` 会被手机号正则命中。
const PHONE_SHAPED_SHA256 = 'de0e9bf6b7a22063a3a7d29a14004586116df41b6e025784684dc8261a60de03';
const FIXED_INSTANT = '2026-09-23T00:00:00.000Z';

function targetedInput(overrides: Record<string, unknown> = {}) {
  return {
    eventKey: `notification.targeted:${FALSE_POSITIVE_CUID}`,
    eventType: OUTBOX_EVENT_TARGETED_NOTIFICATION,
    payloadVersion: OUTBOX_PAYLOAD_VERSION,
    payload: {
      recipientMemberId: FALSE_POSITIVE_CUID,
      notificationTypeCode: 'ACTIVITY_PUBLISHED',
      title: '活动已发布',
      body: '请查看详情',
      channels: [NOTIFICATION_CHANNEL_IN_APP],
    } as unknown as Prisma.InputJsonValue,
    aggregateType: 'notification',
    aggregateId: PLAIN_CUID,
    destinationType: 'member',
    destinationRef: FALSE_POSITIVE_CUID,
    ...overrides,
  };
}

function targetedInputWithFreeze(basisRef: string[], cohortKey = `cohort:${PLAIN_CUID}`) {
  const input = targetedInput();
  return {
    ...input,
    payload: {
      ...(input.payload as unknown as Record<string, unknown>),
      recipientFreeze: {
        cohortKey,
        algorithmVersion: 1,
        basisKind: 'emergency-members',
        basisRef,
        computedAt: FIXED_INSTANT,
        cohortSize: 1,
      },
    } as unknown as Prisma.InputJsonValue,
  };
}

function activityPublishedInput() {
  return {
    eventKey: `activity-publish:${PHONE_SHAPED_CUID}:${FIXED_INSTANT}`,
    eventType: OUTBOX_EVENT_SYSTEM_BROADCAST,
    payloadVersion: OUTBOX_PAYLOAD_VERSION,
    payload: {
      notificationTypeCode: NOTIFICATION_TYPE_ACTIVITY_PUBLISHED,
      title: '新活动已发布',
      body: '请查看活动详情',
      visibilityCode: NOTIFICATION_DIRECTED_VISIBILITY,
      recipientFreeze: {
        cohortKey: `activity-publish-audience:${PHONE_SHAPED_CUID}:${FIXED_INSTANT}`,
        algorithmVersion: 1,
        basisKind: 'audience-organizations',
        basisRef: [`org:${PHONE_SHAPED_CUID}`],
        computedAt: FIXED_INSTANT,
        cohortSize: 1,
      },
    } as unknown as Prisma.InputJsonValue,
    aggregateType: 'activity',
    aggregateId: PHONE_SHAPED_CUID,
    destinationType: 'visibility',
    destinationRef: NOTIFICATION_DIRECTED_VISIBILITY,
  };
}

function targetedPhoneShapedCuidInput() {
  const input = targetedInput({
    eventKey: `notification.targeted:${PHONE_SHAPED_CUID}`,
    aggregateId: PHONE_SHAPED_CUID,
    destinationRef: PHONE_SHAPED_CUID,
  });
  return {
    ...input,
    payload: {
      ...(input.payload as unknown as Record<string, unknown>),
      recipientMemberId: PHONE_SHAPED_CUID,
    } as unknown as Prisma.InputJsonValue,
  };
}

function wechatDeliveryPhoneShapedCuidInput() {
  return {
    eventKey: `wechat-delivery:${PHONE_SHAPED_CUID}:${PHONE_SHAPED_CUID}`,
    eventType: OUTBOX_EVENT_WECHAT_DELIVERY,
    payloadVersion: OUTBOX_PAYLOAD_VERSION,
    payload: {
      notificationId: PHONE_SHAPED_CUID,
      memberId: PHONE_SHAPED_CUID,
    } as unknown as Prisma.InputJsonValue,
    aggregateType: 'notification',
    aggregateId: PHONE_SHAPED_CUID,
    destinationType: 'member',
    destinationRef: PHONE_SHAPED_CUID,
  };
}

const SENSITIVE_MATERIAL = /contains forbidden sensitive material/;

describe('assertSafeMetadata —— envelope 元数据闸', () => {
  describe('不透明 id 里的偶然子串必须放行', () => {
    it('cuid 结尾恰好是 token 的定向通知,producer 写入路径放行', () => {
      expect(() => normalizeNotificationOutboxInput(targetedInput())).not.toThrow();
    });

    it('同一条 intent 在 worker 读取路径同样放行', () => {
      expect(() => assertStoredNotificationOutboxIntentSafe(targetedInput())).not.toThrow();
    });

    it('前提:这条 id 确实含 token 子串,且本身不是敏感物料', () => {
      // 少了这两条,上面两个"放行"用例可能只是因为样本压根不含关键词 —— 那就成了空判据。
      expect(FALSE_POSITIVE_CUID).toContain('token');
      expect(redactNotificationOutboxText(FALSE_POSITIVE_CUID)).toBe(FALSE_POSITIVE_CUID);
    });
  });

  describe('形状像在传敏感物料的值必须拦下', () => {
    // ⚠️ `openid_wx123` 是关键样例:朴素 `\b` 方案在这里会漏(`_` 是 word 字符),
    // 它是「误判归零」与「防御削弱」两条路的分水岭。
    const shapedValues = [
      'token:abc123',
      'phone=13900001111',
      'openid_wx123',
      'provider-response body',
      'signed-url=https://x',
      'TOKEN',
      'x.token.y',
    ];

    it.each(shapedValues)('destinationRef=%p 被硬抛', (value) => {
      expect(() =>
        assertStoredNotificationOutboxIntentSafe(targetedInput({ destinationRef: value })),
      ).toThrow(SENSITIVE_MATERIAL);
    });

    it.each(['eventKey', 'aggregateType', 'aggregateId', 'destinationType', 'destinationRef'])(
      '受检字段 %s 逐个都在闸内',
      (field) => {
        expect(() =>
          assertStoredNotificationOutboxIntentSafe(targetedInput({ [field]: 'token:abc123' })),
        ).toThrow(new RegExp(`${field} contains forbidden sensitive material`));
      },
    );

    it('形状闸独自做功:token:abc123 本身并不是 containsSensitiveValue 认得的敏感物料', () => {
      // 删掉 `FORBIDDEN_PAYLOAD_SHAPE.test(value)` 那半个条件,上面那组用例就会变绿 ——
      // 这条锁住"它不是被 containsSensitiveValue 顺带拦下的"。
      expect(redactNotificationOutboxText('token:abc123')).toBe('token:abc123');
      expect(redactNotificationOutboxText('openid_wx123')).toBe('openid_wx123');
    });
  });

  describe('containsSensitiveValue 这条纵深保留', () => {
    it('裸手机号被拦 —— 它不含任何禁用词,只有值本身敏感这一条能抓到', () => {
      expect(redactNotificationOutboxText('13900001111')).not.toBe('13900001111');
      expect(() =>
        assertStoredNotificationOutboxIntentSafe(targetedInput({ destinationRef: '13900001111' })),
      ).toThrow(SENSITIVE_MATERIAL);
    });
  });

  describe('手机号形状 CUID 只在结构化身份槽放行', () => {
    it('前提：固定样本是合法 CUID，且自由文本 redactor 确实会误判', () => {
      expect(PHONE_SHAPED_CUID).toMatch(/^c[a-z0-9]{20,31}$/);
      expect(PHONE_SHAPED_CUID).toMatch(/1[3-9]\d{9}/);
      expect(redactNotificationOutboxText(PHONE_SHAPED_CUID)).not.toBe(PHONE_SHAPED_CUID);
    });

    it.each([
      ['Activity 发布广播', activityPublishedInput],
      ['targeted member', targetedPhoneShapedCuidInput],
      ['wechat delivery', wechatDeliveryPhoneShapedCuidInput],
    ])('%s 的 producer 与 worker 都放行', (_name, makeInput) => {
      const input = makeInput();
      expect(() => normalizeNotificationOutboxInput(input)).not.toThrow();
      expect(() => assertStoredNotificationOutboxIntentSafe(input)).not.toThrow();
    });

    it('近似但不是 CUID 的字母数字串仍被拒绝', () => {
      expect(() =>
        assertStoredNotificationOutboxIntentSafe(
          targetedInput({ eventKey: 'xabc13800001111defghijkl' }),
        ),
      ).toThrow(SENSITIVE_MATERIAL);
    });

    it.each([
      ['cohortKey', `activity-publish-audience:13900001111:${FIXED_INSTANT}`],
      ['basisRef', 'org:13900001111'],
    ])('recipientFreeze.%s 中的裸手机号仍被拒绝', (field, value) => {
      const input =
        field === 'cohortKey'
          ? targetedInputWithFreeze(['org:plain'], value)
          : targetedInputWithFreeze([value]);
      expect(() => normalizeNotificationOutboxInput(input)).toThrow(/payload contains sensitive/);
      expect(() => assertStoredNotificationOutboxIntentSafe(input)).toThrow(
        /payload contains sensitive/,
      );
    });
  });
});

describe('recipientFreeze.basisRef —— 结构化 SHA-256 事实锚', () => {
  it('摘要偶然含手机号形状时 producer 与 worker 都放行', () => {
    const input = targetedInputWithFreeze([PHONE_SHAPED_SHA256]);

    expect(PHONE_SHAPED_SHA256).toMatch(/1[3-9]\d{9}/);
    // 自由文本 redactor 仍会识别这一数字片段；放行只来自 basisRef 的精确语义路径。
    expect(redactNotificationOutboxText(PHONE_SHAPED_SHA256)).not.toBe(PHONE_SHAPED_SHA256);
    expect(() => normalizeNotificationOutboxInput(input)).not.toThrow();
    expect(() => assertStoredNotificationOutboxIntentSafe(input)).not.toThrow();
  });

  it('basisRef 中的裸手机号仍被拒绝', () => {
    const input = targetedInputWithFreeze(['13900001111']);

    expect(() => normalizeNotificationOutboxInput(input)).toThrow(
      /payload contains sensitive value at \$\.recipientFreeze\.basisRef\[0\]/,
    );
    expect(() => assertStoredNotificationOutboxIntentSafe(input)).toThrow(
      /payload contains sensitive value at \$\.recipientFreeze\.basisRef\[0\]/,
    );
  });

  it('同一摘要放到 cohortKey 仍被拒绝，豁免不扩散到其他字段', () => {
    const input = targetedInputWithFreeze(['a'.repeat(64)], PHONE_SHAPED_SHA256);

    expect(() => normalizeNotificationOutboxInput(input)).toThrow(
      /payload contains sensitive value at \$\.recipientFreeze\.cohortKey/,
    );
    expect(() => assertStoredNotificationOutboxIntentSafe(input)).toThrow(
      /payload contains sensitive value at \$\.recipientFreeze\.cohortKey/,
    );
  });
});

describe('isForbiddenNotificationOutboxPayloadKey —— 键名侧口径不受值侧收窄影响', () => {
  // 键名侧刻意仍是裸子串:camelCase 键的词首前挨着字母,套上值侧那套字母数字边界会
  // 把 accessToken / userPhone / phoneNumber 整片放过去。
  it.each([
    'phone',
    'userPhone',
    'phoneNumber',
    'mobile',
    'openId',
    'openid',
    'token',
    'accessToken',
    'secret',
    'credential',
    'signedUrl',
    'signed_url',
    'providerRequest',
    'providerResponse',
    'provider_response',
  ])('禁用键 %s 仍被拦', (key) => {
    expect(isForbiddenNotificationOutboxPayloadKey(key)).toBe(true);
  });

  it.each(['memberId', 'title', 'body', 'activityId', 'notificationTypeCode', 'channels'])(
    '业务键 %s 仍放行',
    (key) => {
      expect(isForbiddenNotificationOutboxPayloadKey(key)).toBe(false);
    },
  );
});
