import { Logger } from '@nestjs/common';
import { sms } from 'tencentcloud-sdk-nodejs-sms';

import { DevStubSmsProvider } from '../sms/providers/dev-stub.provider';
import { TencentSmsProvider } from '../sms/providers/tencent-sms.provider';
import type { SmsSettingsService } from '../sms/sms-settings.service';
import {
  type PreparedSmsEffect,
  SmsChannelUnavailableError,
  SmsCredentialStatus,
  SmsProviderSendError,
  type SmsSettingsResolved,
} from '../sms/sms.types';
import { NotificationSmsDispatchService } from './notification-sms-dispatch.service';

jest.mock('tencentcloud-sdk-nodejs-sms', () => {
  const mockInstance = { SendSms: jest.fn() };
  const Constructor = jest.fn().mockImplementation(() => mockInstance);
  (Constructor as unknown as { __mockInstance: typeof mockInstance }).__mockInstance = mockInstance;
  return { __esModule: true, sms: { v20210111: { Client: Constructor } } };
});

const TencentClientMock = sms.v20210111.Client as unknown as jest.Mock & {
  __mockInstance: { SendSms: jest.Mock };
};

const ALLOW_EFFECT = () => Promise.resolve();

// 统一通知 S5:NotificationSmsDispatchService 单测(评审稿 §4 / §8.3;纯 unit,mock prisma + router + settings + rbac)。
// 锁:① 通道未就绪 → 抛 SmsChannelUnavailableError(零计费);② 仅可见且有手机者计入受众;
// ③ 防滥发继承(同日同模板幂等 / 同号日封顶 / 间隔)逐人 skipped + reasonCode;④ re-trigger 去重(already-sent);
// ⑤ FAILED 逐人不阻断;⑥ recipientRef = maskPhone;⑦ countRecipients 仅计数不发送。

interface MemberSpec {
  memberId: string;
  phone: string | null; // null = 无绑定手机(可见但不计入可计费受众)
}

interface SmsLogState {
  // 按号配置防滥发查询返回:同日同模板已发条数 / 当日所有 SENT 条数 / 最近一条 SENT 距今毫秒
  idempotentByPhone?: Record<string, number>;
  dailyByPhone?: Record<string, number>;
  lastSentAgoMsByPhone?: Record<string, number>;
}

function makeTencentSettings(): SmsSettingsResolved {
  return {
    id: 'sms-settings-tencent',
    providerType: 'TENCENT_SMS',
    enabled: true,
    sdkAppId: '1400000000',
    signName: '某救援队',
    region: 'ap-guangzhou',
    templateIdVerifyCode: 'verify-template',
    templateIdBirthday: 'birthday-template',
    templateIdNotification: 'notification-template',
    credentials: { secretId: 'test-secret-id', secretKey: 'test-secret-key' },
    credentialStatus: SmsCredentialStatus.CONFIGURED,
    remarks: null,
    updatedBy: null,
    updatedAt: new Date('2026-07-19T00:00:00.000Z'),
    createdAt: new Date('2026-07-19T00:00:00.000Z'),
  };
}

function build(opts: {
  members: MemberSpec[];
  ready?: boolean; // settings 就绪(默认 true)
  alreadySentMemberIds?: string[]; // 本通知已 sent 短信的 member(re-trigger 去重)
  smsLog?: SmsLogState;
  sendImpl?: (phone: string) => Promise<{ providerMsgId: string | null }>;
  prepareImpl?: (phone: string) => PreparedSmsEffect | Promise<PreparedSmsEffect>;
}) {
  const smsLog = opts.smsLog ?? {};
  const deliveries: Record<string, unknown>[] = [];
  const sendLogs: Record<string, unknown>[] = [];

  const activeMemberIds = opts.members.map((m) => m.memberId);
  const usersRows = opts.members
    .filter((m) => m.phone !== null)
    .map((m) => ({ id: `u-${m.memberId}`, memberId: m.memberId, role: 'USER', phone: m.phone }));

  const prisma = {
    member: {
      findMany: jest.fn().mockResolvedValue(activeMemberIds.map((id) => ({ id }))),
    },
    user: {
      findMany: jest.fn().mockResolvedValue(usersRows),
      findFirst: jest.fn().mockImplementation(({ where }: { where: { memberId?: string } }) => {
        const user = usersRows.find(({ memberId }) => memberId === where.memberId);
        return Promise.resolve(user ? { phone: user.phone } : null);
      }),
    },
    memberOrganizationMembership: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    notificationDelivery: {
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: { where: { memberId?: string } }) =>
          Promise.resolve(
            (opts.alreadySentMemberIds ?? []).includes(where.memberId ?? '')
              ? { id: 'sent-evidence', recipientRef: '139****0001' }
              : null,
          ),
        ),
      findMany: jest
        .fn()
        .mockResolvedValue((opts.alreadySentMemberIds ?? []).map((memberId) => ({ memberId }))),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        deliveries.push(data);
        return Promise.resolve({ id: `d-${deliveries.length}`, ...data });
      }),
    },
    smsSendLog: {
      count: jest.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) => {
        const phone = where.phone as string;
        // templateKey 存在 = 同日同模板幂等查;否则 = 当日所有 SENT 日封顶查
        if (where.templateKey !== undefined) {
          return Promise.resolve(smsLog.idempotentByPhone?.[phone] ?? 0);
        }
        return Promise.resolve(smsLog.dailyByPhone?.[phone] ?? 0);
      }),
      findFirst: jest.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) => {
        const phone = where.phone as string;
        const agoMs = smsLog.lastSentAgoMsByPhone?.[phone];
        if (agoMs === undefined) return Promise.resolve(null);
        // 服务内部用真实 new Date() 比较间隔,故基于真实 Date.now() 构造「距今 agoMs」的上一条。
        return Promise.resolve({ createdAt: new Date(Date.now() - agoMs) });
      }),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        sendLogs.push(data);
        return Promise.resolve({ id: `s-${sendLogs.length}`, ...data });
      }),
    },
  };
  const transaction = jest.fn(
    async (fn: (client: typeof prisma) => Promise<unknown>): Promise<unknown> => {
      const deliveryLength = deliveries.length;
      const sendLogLength = sendLogs.length;
      try {
        return await fn(prisma);
      } catch (error) {
        deliveries.splice(deliveryLength);
        sendLogs.splice(sendLogLength);
        throw error;
      }
    },
  );
  Object.assign(prisma, { $transaction: transaction });

  const invoke = jest
    .fn<Promise<{ providerMsgId: string | null }>, [string]>()
    .mockImplementation((phone: string) =>
      (opts.sendImpl ?? (() => Promise.resolve({ providerMsgId: 'sn-x' })))(phone),
    );
  const prepareNotification = jest.fn<
    PreparedSmsEffect | Promise<PreparedSmsEffect>,
    [{ phone: string }]
  >(({ phone }) =>
    opts.prepareImpl
      ? opts.prepareImpl(phone)
      : Promise.resolve({
          providerType: 'DEV_STUB' as const,
          invoke: () => invoke(phone),
        }),
  );
  const router = {
    resolveProviderType: jest.fn().mockResolvedValue('DEV_STUB'),
    prepareNotification,
    invoke,
  };

  const settings = {
    getActiveSettings: jest
      .fn()
      .mockResolvedValue(
        opts.ready === false
          ? { enabled: true, templateIdNotification: null, providerType: 'DEV_STUB' }
          : { enabled: true, templateIdNotification: 'tpl-notif-1', providerType: 'DEV_STUB' },
      ),
  };

  const rbac = { can: jest.fn().mockResolvedValue(false) };

  const service = new NotificationSmsDispatchService(
    prisma as never,
    router as never,
    settings as never,
    rbac as never,
  );

  const notification = {
    id: 'notif-1',
    audienceType: 'broadcast',
    visibilityCode: 'member',
    visibleOrganizationIds: [],
    statusCode: 'published',
    recipientMemberId: null,
  } as never;

  return { service, notification, prisma, router, settings, transaction, deliveries, sendLogs };
}

describe('NotificationSmsDispatchService · dispatch(短信兜底派发)', () => {
  beforeEach(() => {
    TencentClientMock.mockClear();
    TencentClientMock.__mockInstance.SendSms.mockReset();
  });

  it('通道未就绪(templateIdNotification 空)→ 抛 SmsChannelUnavailableError,零发送零 delivery', async () => {
    const { service, notification, router, deliveries } = build({
      members: [{ memberId: 'm1', phone: '13900000001' }],
      ready: false,
    });
    await expect(service.dispatch(notification)).rejects.toBeInstanceOf(SmsChannelUnavailableError);
    expect(router.prepareNotification).not.toHaveBeenCalled();
    expect(router.invoke).not.toHaveBeenCalled();
    expect(deliveries).toHaveLength(0);
  });

  it('仅可见且有手机者发送:SENT 落 send_log(templateKey=notification)+ delivery sent;无手机者不计入', async () => {
    const { service, notification, transaction, sendLogs, deliveries } = build({
      members: [
        { memberId: 'm1', phone: '13900000001' },
        { memberId: 'm2', phone: null }, // 无手机 → 不计入可计费受众
        { memberId: 'm3', phone: '13900000003' },
      ],
    });
    const summary = await service.dispatch(notification);
    expect(summary).toEqual({ recipientCount: 2, sent: 2, failed: 0, skipped: 0 });
    expect(sendLogs).toHaveLength(2);
    expect(sendLogs.every((r) => r.templateKey === 'notification' && r.status === 'SENT')).toBe(
      true,
    );
    expect(deliveries.every((d) => d.channel === 'sms' && d.status === 'sent')).toBe(true);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('recipientRef = maskPhone(138****1234)', async () => {
    const { service, notification, deliveries } = build({
      members: [{ memberId: 'm1', phone: '13912341234' }],
    });
    await service.dispatch(notification);
    expect(deliveries[0].recipientRef).toBe('139****1234');
  });

  it('同日同模板幂等继承:同号当日已 SENT notification 短信 → skipped idempotent,不发', async () => {
    const { service, notification, router, deliveries } = build({
      members: [{ memberId: 'm1', phone: '13900000001' }],
      smsLog: { idempotentByPhone: { '13900000001': 1 } },
    });
    const summary = await service.dispatch(notification);
    expect(summary).toEqual({ recipientCount: 1, sent: 0, failed: 0, skipped: 1 });
    expect(router.prepareNotification).not.toHaveBeenCalled();
    expect(router.invoke).not.toHaveBeenCalled();
    expect(deliveries[0]).toMatchObject({ status: 'skipped', reasonCode: 'idempotent' });
  });

  it('同号日封顶继承:当日 SENT 短信已达封顶(10)→ skipped daily-limit', async () => {
    const { service, notification, router, deliveries } = build({
      members: [{ memberId: 'm1', phone: '13900000001' }],
      smsLog: { idempotentByPhone: { '13900000001': 0 }, dailyByPhone: { '13900000001': 10 } },
    });
    const summary = await service.dispatch(notification);
    expect(summary.skipped).toBe(1);
    expect(router.prepareNotification).not.toHaveBeenCalled();
    expect(router.invoke).not.toHaveBeenCalled();
    expect(deliveries[0]).toMatchObject({ status: 'skipped', reasonCode: 'daily-limit' });
  });

  it('同号间隔继承:最近一条 SENT 短信在 60s 内 → skipped interval', async () => {
    const { service, notification, router, deliveries } = build({
      members: [{ memberId: 'm1', phone: '13900000001' }],
      smsLog: { lastSentAgoMsByPhone: { '13900000001': 10_000 } }, // 10s 前
    });
    const summary = await service.dispatch(notification);
    expect(summary.skipped).toBe(1);
    expect(router.prepareNotification).not.toHaveBeenCalled();
    expect(router.invoke).not.toHaveBeenCalled();
    expect(deliveries[0]).toMatchObject({ status: 'skipped', reasonCode: 'interval' });
  });

  it('间隔外(>60s)正常发送(防滥发不误伤)', async () => {
    const { service, notification, router } = build({
      members: [{ memberId: 'm1', phone: '13900000001' }],
      smsLog: { lastSentAgoMsByPhone: { '13900000001': 120_000 } }, // 2min 前
    });
    const summary = await service.dispatch(notification);
    expect(summary.sent).toBe(1);
    expect(router.prepareNotification).toHaveBeenCalledTimes(1);
    expect(router.invoke).toHaveBeenCalledTimes(1);
  });

  it('legacy 无 guard 时 prepare resolve 后不额外让出 microtask，invoke 同步启动 Effect', async () => {
    let registerProbe!: (registered: { probe: Promise<boolean> }) => void;
    const probeRegistered = new Promise<{ probe: Promise<boolean> }>((resolve) => {
      registerProbe = resolve;
    });
    const { service, notification, router } = build({
      members: [{ memberId: 'm1', phone: '13900000001' }],
    });
    router.prepareNotification.mockImplementationOnce(({ phone }: { phone: string }) => {
      const prepared = {
        providerType: 'DEV_STUB' as const,
        invoke: () => router.invoke(phone),
      };
      const resolved = Promise.resolve(prepared);
      const probe = new Promise<boolean>((resolve) => {
        void resolved.then(() => {
          queueMicrotask(() => resolve(router.invoke.mock.calls.length === 1));
        });
      });
      registerProbe({ probe });
      return resolved;
    });

    const pending = service.dispatch(notification);
    const { probe } = await probeRegistered;
    await expect(probe).resolves.toBe(true);
    await expect(pending).resolves.toMatchObject({ sent: 1, failed: 0 });
  });

  it('发送证据 providerType 只取 prepared snapshot，不拼 assertChannelReady 的旧 route', async () => {
    const { service, notification, sendLogs, router } = build({
      members: [{ memberId: 'm1', phone: '13900000001' }],
      prepareImpl: () => ({
        providerType: 'TENCENT_SMS',
        invoke: () => Promise.resolve({ providerMsgId: 'tencent-snapshot-msg' }),
      }),
    });

    await expect(service.dispatchRecipient(notification, 'm1', ALLOW_EFFECT)).resolves.toEqual({
      outcome: 'sent',
    });
    expect(router.resolveProviderType).toHaveBeenCalledTimes(1);
    expect(sendLogs).toContainEqual(
      expect.objectContaining({
        providerType: 'TENCENT_SMS',
        providerMsgId: 'tencent-snapshot-msg',
        status: 'SENT',
      }),
    );
  });

  it('re-trigger 去重:本通知已 sent 过的 member → skipped already-sent', async () => {
    const { service, notification, router, deliveries } = build({
      members: [{ memberId: 'm1', phone: '13900000001' }],
      alreadySentMemberIds: ['m1'],
    });
    const summary = await service.dispatch(notification);
    expect(summary).toEqual({ recipientCount: 1, sent: 0, failed: 0, skipped: 1 });
    expect(router.prepareNotification).not.toHaveBeenCalled();
    expect(router.invoke).not.toHaveBeenCalled();
    expect(deliveries[0]).toMatchObject({ status: 'skipped', reasonCode: 'already-sent' });
  });

  it('FAILED 逐人不阻断:一人发送抛错落 FAILED,继续发下一人', async () => {
    const { service, notification, sendLogs, deliveries } = build({
      members: [
        { memberId: 'm1', phone: '13900000001' },
        { memberId: 'm2', phone: '13900000002' },
      ],
      sendImpl: (phone) =>
        phone === '13900000001'
          ? Promise.reject(new SmsProviderSendError('LimitExceeded', 'daily limit'))
          : Promise.resolve({ providerMsgId: 'sn-ok' }),
    });
    const summary = await service.dispatch(notification);
    expect(summary).toEqual({ recipientCount: 2, sent: 1, failed: 1, skipped: 0 });
    // 失败 + 成功 各落一条 send_log
    expect(sendLogs.find((r) => r.status === 'FAILED')).toMatchObject({ errCode: 'LimitExceeded' });
    expect(sendLogs.find((r) => r.status === 'SENT')).toBeDefined();
    // delivery:一 failed(send-failed + errCode)一 sent
    expect(deliveries.find((d) => d.status === 'failed')).toMatchObject({
      reasonCode: 'send-failed',
      errCode: 'LimitExceeded',
    });
    expect(deliveries.find((d) => d.status === 'sent')).toBeDefined();
  });

  it('中途通道不可用(SmsChannelUnavailableError)→ 中止剩余,零成本不写 FAILED', async () => {
    const { service, notification, sendLogs } = build({
      members: [
        { memberId: 'm1', phone: '13900000001' },
        { memberId: 'm2', phone: '13900000002' },
      ],
      sendImpl: () => Promise.reject(new SmsChannelUnavailableError('运维关闭')),
    });
    const summary = await service.dispatch(notification);
    expect(summary).toEqual({ recipientCount: 2, sent: 0, failed: 0, skipped: 0 });
    // 中止:不写 FAILED send_log
    expect(sendLogs).toHaveLength(0);
  });

  it('countRecipients:仅可见有手机者计数,不发送不查通道', async () => {
    const { service, notification, router, sendLogs } = build({
      members: [
        { memberId: 'm1', phone: '13900000001' },
        { memberId: 'm2', phone: null },
        { memberId: 'm3', phone: '13900000003' },
      ],
    });
    const count = await service.countRecipients(notification);
    expect(count).toBe(2);
    expect(router.prepareNotification).not.toHaveBeenCalled();
    expect(router.invoke).not.toHaveBeenCalled();
    expect(router.resolveProviderType).not.toHaveBeenCalled();
    expect(sendLogs).toHaveLength(0);
  });

  it('outbox 单收件人 provider 失败必须外抛，FAILED 流水保留供该 child 重试', async () => {
    const { service, notification, sendLogs, deliveries } = build({
      members: [{ memberId: 'm1', phone: '13900000001' }],
      sendImpl: () => Promise.reject(new SmsProviderSendError('Transient', 'retry me')),
    });
    await expect(
      service.dispatchRecipient(notification, 'm1', ALLOW_EFFECT),
    ).rejects.toBeInstanceOf(SmsProviderSendError);
    expect(sendLogs).toContainEqual(expect.objectContaining({ status: 'FAILED' }));
    expect(deliveries).toContainEqual(expect.objectContaining({ status: 'failed' }));
  });

  it('outbox provider成功后 sendLog+Delivery 同一短事务；delivery 失败两者均回滚并外抛', async () => {
    const { service, notification, prisma, transaction, sendLogs, deliveries } = build({
      members: [{ memberId: 'm1', phone: '13900000001' }],
    });
    prisma.notificationDelivery.create.mockRejectedValueOnce(new Error('delivery db unavailable'));
    await expect(service.dispatchRecipient(notification, 'm1', ALLOW_EFFECT)).rejects.toThrow(
      'delivery db unavailable',
    );
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(sendLogs).not.toContainEqual(expect.objectContaining({ status: 'SENT' }));
    expect(deliveries).toHaveLength(0);
  });

  it('outbox beforeEffect guard 失败时 provider=0 且不伪造 FAILED/SENT evidence', async () => {
    const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const devStub = new DevStubSmsProvider();
    const invoke = jest.fn((phone: string) => devStub.sendNotification({ phone }));
    const { service, notification, router, sendLogs, deliveries } = build({
      members: [{ memberId: 'm1', phone: '13900000001' }],
      prepareImpl: (phone) => ({ providerType: 'DEV_STUB', invoke: () => invoke(phone) }),
    });
    const leaseLost = new Error('lease lost at provider boundary');
    const beforeEffect = jest.fn().mockRejectedValue(leaseLost);

    try {
      await expect(service.dispatchRecipient(notification, 'm1', beforeEffect)).rejects.toBe(
        leaseLost,
      );
      expect(router.prepareNotification).toHaveBeenCalledWith({ phone: '13900000001' });
      expect(beforeEffect).toHaveBeenCalledTimes(1);
      expect(invoke).not.toHaveBeenCalled();
      expect(debugSpy).not.toHaveBeenCalled();
      expect(sendLogs).toHaveLength(0);
      expect(deliveries).toHaveLength(0);
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('outbox guard 失败时真实 Tencent prepared Effect 不 invoke 且 SDK SendSms=0', async () => {
    const tencent = new TencentSmsProvider({
      getActiveSettings: jest.fn(),
    } as unknown as SmsSettingsService);
    const invoke = jest.fn<Promise<{ providerMsgId: string | null }>, []>();
    const { service, notification, router, sendLogs, deliveries } = build({
      members: [{ memberId: 'm1', phone: '13900000001' }],
      prepareImpl: (phone) => {
        const prepared = tencent.prepareNotification(makeTencentSettings(), { phone });
        invoke.mockImplementation(() => prepared.invoke());
        return { providerType: prepared.providerType, invoke };
      },
    });
    const leaseLost = new Error('lease lost before Tencent SendSms');
    const beforeEffect = jest.fn().mockRejectedValue(leaseLost);

    await expect(service.dispatchRecipient(notification, 'm1', beforeEffect)).rejects.toBe(
      leaseLost,
    );
    expect(router.prepareNotification).toHaveBeenCalledTimes(1);
    expect(beforeEffect).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
    expect(TencentClientMock.__mockInstance.SendSms).not.toHaveBeenCalled();
    expect(sendLogs).toHaveLength(0);
    expect(deliveries).toHaveLength(0);
  });

  it('outbox prepare rejection 原样外抛，guard/provider/evidence 均为 0', async () => {
    const prepareError = new Error('prepared route unavailable');
    const beforeEffect = jest.fn().mockResolvedValue(undefined);
    const { service, notification, router, sendLogs, deliveries } = build({
      members: [{ memberId: 'm1', phone: '13900000001' }],
      prepareImpl: () => Promise.reject(prepareError),
    });

    await expect(service.dispatchRecipient(notification, 'm1', beforeEffect)).rejects.toBe(
      prepareError,
    );
    expect(router.prepareNotification).toHaveBeenCalledTimes(1);
    expect(beforeEffect).not.toHaveBeenCalled();
    expect(router.invoke).not.toHaveBeenCalled();
    expect(sendLogs).toHaveLength(0);
    expect(deliveries).toHaveLength(0);
  });

  it('SENT evidence 检查早于 disabled settings/audience，ack-crash reclaim 只记 already-sent', async () => {
    const { service, notification, router, settings, deliveries } = build({
      members: [{ memberId: 'm1', phone: '13900000001' }],
      ready: false,
      alreadySentMemberIds: ['m1'],
    });
    await expect(service.dispatchRecipient(notification, 'm1', ALLOW_EFFECT)).resolves.toEqual({
      outcome: 'skipped',
    });
    expect(settings.getActiveSettings).not.toHaveBeenCalled();
    expect(router.resolveProviderType).not.toHaveBeenCalled();
    expect(router.prepareNotification).not.toHaveBeenCalled();
    expect(router.invoke).not.toHaveBeenCalled();
    expect(deliveries).toContainEqual(
      expect.objectContaining({ status: 'skipped', reasonCode: 'already-sent' }),
    );
  });

  it('outbox 单收件人通道关闭直接外抛，零 FAILED 流水并由 worker nack', async () => {
    const { service, notification, sendLogs } = build({
      members: [{ memberId: 'm1', phone: '13900000001' }],
      sendImpl: () => Promise.reject(new SmsChannelUnavailableError('closed')),
    });
    await expect(
      service.dispatchRecipient(notification, 'm1', ALLOW_EFFECT),
    ).rejects.toBeInstanceOf(SmsChannelUnavailableError);
    expect(sendLogs).toHaveLength(0);
  });
});
