import { Prisma } from '@prisma/client';

import {
  NOTIFICATION_CHANNEL_IN_APP,
  OUTBOX_EVENT_TARGETED_NOTIFICATION,
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
 * `destinationRef` / `eventKey` 里装的不透明 id(cuid)只要恰好含 `token` / `phone`
 * 等子串就被硬抛 —— 实测 200 万条 cuid 形状 id 命中 1 条。非确定性 + 错误消息对着随机
 * id 谁也看不懂 ⇒ 现场只会当成 flake。改成「只把字母数字当词内字符」的口径后误判归零,
 * 而防御一条不少。
 *
 * ⚠️ 本文件里的 id **全部写成字面量**:随机生成会让「恰好含 token 的 cuid」偶尔不触发,
 * 判据当场退化成 flake —— 那正是本次要修掉的病。
 */

// 实测扫出来的一条真误判样本(200 万条随机 cuid 里的命中):结尾恰好是 "token"。
// 写成字面量而非现场生成 —— 随机样本会让这条判据偶尔不触发,当场退化成 flake。
const FALSE_POSITIVE_CUID = 'c8ob12qafrq354c5ptvjtoken';
const PLAIN_CUID = 'cmt38187b00abcdefghijklm';

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
