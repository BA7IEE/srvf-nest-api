import type { ConfigType } from '@nestjs/config';

import appConfig from '../../config/app.config';
import type { DevStubSmsProvider } from './providers/dev-stub.provider';
import type { TencentSmsProvider } from './providers/tencent-sms.provider';
import { SmsProviderRouter } from './sms-provider.router';
import type { SmsSettingsService } from './sms-settings.service';
import {
  SmsChannelUnavailableError,
  SmsCredentialStatus,
  type PreparedSmsEffect,
  type SendVerifyCodeResult,
  type SmsProvider,
  type SmsSettingsResolved,
} from './sms.types';

const VERIFY_INPUT = { phone: '13800001234', code: '654321', ttlMinutes: 5 };
const BIRTHDAY_INPUT = { phone: '13800001235' };
const NOTIFICATION_INPUT = { phone: '13800001236' };

function makeSettings(overrides: Partial<SmsSettingsResolved> = {}): SmsSettingsResolved {
  return {
    id: 'sms-settings-1',
    providerType: 'DEV_STUB',
    enabled: true,
    sdkAppId: null,
    signName: null,
    region: null,
    templateIdVerifyCode: null,
    templateIdBirthday: null,
    templateIdNotification: null,
    credentials: null,
    credentialStatus: SmsCredentialStatus.MISSING,
    remarks: null,
    updatedBy: null,
    updatedAt: new Date('2026-07-19T00:00:00.000Z'),
    createdAt: new Date('2026-07-19T00:00:00.000Z'),
    ...overrides,
  };
}

function makePrepared(
  providerType: 'DEV_STUB' | 'TENCENT_SMS',
  providerMsgId: string | null,
): { effect: PreparedSmsEffect; invoke: jest.Mock } {
  const invoke = jest.fn().mockResolvedValue({ providerMsgId });
  return { effect: { providerType, invoke }, invoke };
}

function makeHarness(env = 'development') {
  const settings = { getActiveSettings: jest.fn() };
  const devStub = {
    sendVerifyCode: jest.fn().mockResolvedValue({ providerMsgId: null }),
    sendBirthdayGreeting: jest.fn().mockResolvedValue({ providerMsgId: null }),
    sendNotification: jest.fn().mockResolvedValue({ providerMsgId: null }),
  };
  const verify = makePrepared('TENCENT_SMS', 'tx-verify');
  const birthday = makePrepared('TENCENT_SMS', 'tx-birthday');
  const notification = makePrepared('TENCENT_SMS', 'tx-notification');
  const tencent = {
    prepareVerifyCode: jest.fn().mockReturnValue(verify.effect),
    prepareBirthdayGreeting: jest.fn().mockReturnValue(birthday.effect),
    prepareNotification: jest.fn().mockReturnValue(notification.effect),
  };
  const router = new SmsProviderRouter(
    settings as unknown as SmsSettingsService,
    devStub as unknown as DevStubSmsProvider,
    tencent as unknown as TencentSmsProvider,
    { env } as ConfigType<typeof appConfig>,
  );
  return { router, settings, devStub, tencent, verify, birthday, notification };
}

type RouterHarness = ReturnType<typeof makeHarness>;

const COMPAT_TENCENT_CASES: Array<{
  name: string;
  prepare: (h: RouterHarness) => jest.Mock;
  invoke: (h: RouterHarness) => jest.Mock;
  send: (provider: SmsProvider) => Promise<SendVerifyCodeResult>;
  providerMsgId: string;
}> = [
  {
    name: 'verify',
    prepare: (h) => h.tencent.prepareVerifyCode,
    invoke: (h) => h.verify.invoke,
    send: (provider) => provider.sendVerifyCode(VERIFY_INPUT),
    providerMsgId: 'tx-verify',
  },
  {
    name: 'birthday',
    prepare: (h) => h.tencent.prepareBirthdayGreeting,
    invoke: (h) => h.birthday.invoke,
    send: (provider) => provider.sendBirthdayGreeting(BIRTHDAY_INPUT),
    providerMsgId: 'tx-birthday',
  },
  {
    name: 'notification',
    prepare: (h) => h.tencent.prepareNotification,
    invoke: (h) => h.notification.invoke,
    send: (provider) => provider.sendNotification(NOTIFICATION_INPUT),
    providerMsgId: 'tx-notification',
  },
];

describe('SmsProviderRouter single-snapshot route', () => {
  it('DEV→TENCENT 配置切换：已取得 route 的 type / prepare / invoke 全绑定 DEV 且只读一次', async () => {
    const h = makeHarness();
    h.settings.getActiveSettings
      .mockResolvedValueOnce(makeSettings({ providerType: 'DEV_STUB' }))
      .mockResolvedValue(makeSettings({ providerType: 'TENCENT_SMS' }));

    const route = await h.router.resolveRoute();
    const verify = route.prepareVerifyCode(VERIFY_INPUT);
    const birthday = route.prepareBirthdayGreeting(BIRTHDAY_INPUT);
    const notification = route.prepareNotification(NOTIFICATION_INPUT);

    expect(route.providerType).toBe('DEV_STUB');
    expect([verify.providerType, birthday.providerType, notification.providerType]).toEqual([
      'DEV_STUB',
      'DEV_STUB',
      'DEV_STUB',
    ]);
    await expect(verify.invoke()).resolves.toEqual({ providerMsgId: null });
    await expect(birthday.invoke()).resolves.toEqual({ providerMsgId: null });
    await expect(notification.invoke()).resolves.toEqual({ providerMsgId: null });
    expect(h.settings.getActiveSettings).toHaveBeenCalledTimes(1);
    expect(h.devStub.sendVerifyCode).toHaveBeenCalledWith(VERIFY_INPUT);
    expect(h.devStub.sendBirthdayGreeting).toHaveBeenCalledWith(BIRTHDAY_INPUT);
    expect(h.devStub.sendNotification).toHaveBeenCalledWith(NOTIFICATION_INPUT);
    expect(h.tencent.prepareVerifyCode).not.toHaveBeenCalled();
    expect(h.tencent.prepareBirthdayGreeting).not.toHaveBeenCalled();
    expect(h.tencent.prepareNotification).not.toHaveBeenCalled();
  });

  it('TENCENT→DEV 配置切换：三类 prepare 始终收到同一 TENCENT snapshot', async () => {
    const h = makeHarness();
    const tencentSnapshot = makeSettings({
      providerType: 'TENCENT_SMS',
      credentialStatus: SmsCredentialStatus.CONFIGURED,
      credentials: { secretId: 'id', secretKey: 'key' },
    });
    h.settings.getActiveSettings
      .mockResolvedValueOnce(tencentSnapshot)
      .mockResolvedValue(makeSettings({ providerType: 'DEV_STUB' }));

    const route = await h.router.resolveRoute();
    const verify = route.prepareVerifyCode(VERIFY_INPUT);
    const birthday = route.prepareBirthdayGreeting(BIRTHDAY_INPUT);
    const notification = route.prepareNotification(NOTIFICATION_INPUT);

    expect(route.providerType).toBe('TENCENT_SMS');
    expect(h.tencent.prepareVerifyCode).toHaveBeenCalledWith(tencentSnapshot, VERIFY_INPUT);
    expect(h.tencent.prepareBirthdayGreeting).toHaveBeenCalledWith(tencentSnapshot, BIRTHDAY_INPUT);
    expect(h.tencent.prepareNotification).toHaveBeenCalledWith(tencentSnapshot, NOTIFICATION_INPUT);
    expect(h.settings.getActiveSettings).toHaveBeenCalledTimes(1);
    expect(h.devStub.sendVerifyCode).not.toHaveBeenCalled();
    await expect(verify.invoke()).resolves.toEqual({ providerMsgId: 'tx-verify' });
    await expect(birthday.invoke()).resolves.toEqual({ providerMsgId: 'tx-birthday' });
    await expect(notification.invoke()).resolves.toEqual({ providerMsgId: 'tx-notification' });
  });

  it('resolve 只读一次 settings，返回非裸 provider 适配器且三类 send 固定首次 DEV route', async () => {
    const h = makeHarness();
    h.settings.getActiveSettings
      .mockResolvedValueOnce(makeSettings({ providerType: 'DEV_STUB' }))
      .mockResolvedValue(makeSettings({ providerType: 'TENCENT_SMS' }));

    const provider = await h.router.resolve();
    expect(provider).not.toBe(h.devStub);
    expect(provider).not.toBe(h.tencent);

    await expect(provider.sendVerifyCode(VERIFY_INPUT)).resolves.toEqual({ providerMsgId: null });
    await expect(provider.sendBirthdayGreeting(BIRTHDAY_INPUT)).resolves.toEqual({
      providerMsgId: null,
    });
    await expect(provider.sendNotification(NOTIFICATION_INPUT)).resolves.toEqual({
      providerMsgId: null,
    });

    expect(h.settings.getActiveSettings).toHaveBeenCalledTimes(1);
    expect(h.devStub.sendVerifyCode).toHaveBeenCalledWith(VERIFY_INPUT);
    expect(h.devStub.sendBirthdayGreeting).toHaveBeenCalledWith(BIRTHDAY_INPUT);
    expect(h.devStub.sendNotification).toHaveBeenCalledWith(NOTIFICATION_INPUT);
    expect(h.tencent.prepareVerifyCode).not.toHaveBeenCalled();
    expect(h.tencent.prepareBirthdayGreeting).not.toHaveBeenCalled();
    expect(h.tencent.prepareNotification).not.toHaveBeenCalled();
  });

  it.each(COMPAT_TENCENT_CASES)(
    'resolve 兼容 provider/$name：prepare 同步异常转 rejected Promise 且 identity 不变',
    async ({ name, prepare, invoke, send }) => {
      const h = makeHarness();
      h.settings.getActiveSettings.mockResolvedValue(makeSettings({ providerType: 'TENCENT_SMS' }));
      const provider = await h.router.resolve();
      const error = new Error(`sync-${name}-prepare-error`);
      prepare(h).mockImplementationOnce(() => {
        throw error;
      });
      let pending: Promise<SendVerifyCodeResult> | undefined;

      expect(() => {
        pending = send(provider);
      }).not.toThrow();
      expect(pending).toBeInstanceOf(Promise);
      expect(invoke(h)).not.toHaveBeenCalled();
      if (pending === undefined) throw new Error('compat send did not return a Promise');
      await expect(pending).rejects.toBe(error);
    },
  );

  it.each(COMPAT_TENCENT_CASES)(
    'resolve 兼容 provider/$name：返回 pending 前 prepare/invoke 已同步各调用一次',
    async ({ prepare, invoke, send, providerMsgId }) => {
      const h = makeHarness();
      h.settings.getActiveSettings.mockResolvedValue(makeSettings({ providerType: 'TENCENT_SMS' }));
      const provider = await h.router.resolve();

      const pending = send(provider);
      expect(prepare(h)).toHaveBeenCalledTimes(1);
      expect(invoke(h)).toHaveBeenCalledTimes(1);
      await expect(pending).resolves.toEqual({ providerMsgId });
    },
  );

  it('resolveProviderType 只解析一次 route / 只读一次 settings', async () => {
    const h = makeHarness();
    h.settings.getActiveSettings.mockResolvedValue(makeSettings());

    await expect(h.router.resolveProviderType()).resolves.toBe('DEV_STUB');

    expect(h.settings.getActiveSettings).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['settings null', null, 'development'],
    ['enabled=false', makeSettings({ enabled: false }), 'development'],
    ['production-like DEV_STUB', makeSettings(), 'production'],
    [
      'unknown provider',
      makeSettings({ providerType: 'UNKNOWN' as SmsSettingsResolved['providerType'] }),
      'development',
    ],
  ])('%s → fail-closed', async (_label, settings, env) => {
    const h = makeHarness(env);
    h.settings.getActiveSettings.mockResolvedValue(settings);

    await expect(h.router.resolveRoute()).rejects.toBeInstanceOf(SmsChannelUnavailableError);
    expect(h.devStub.sendVerifyCode).not.toHaveBeenCalled();
    expect(h.tencent.prepareVerifyCode).not.toHaveBeenCalled();
  });
});

describe('SmsProviderRouter compatibility send API', () => {
  it('既有 verify / birthday / notification send 签名均委托 prepared.invoke 且结果不变', async () => {
    const h = makeHarness();
    h.settings.getActiveSettings.mockResolvedValue(makeSettings());

    await expect(h.router.sendVerifyCode(VERIFY_INPUT)).resolves.toEqual({ providerMsgId: null });
    await expect(h.router.sendBirthdayGreeting(BIRTHDAY_INPUT)).resolves.toEqual({
      providerMsgId: null,
    });
    await expect(h.router.sendNotification(NOTIFICATION_INPUT)).resolves.toEqual({
      providerMsgId: null,
    });

    expect(h.settings.getActiveSettings).toHaveBeenCalledTimes(3);
    expect(h.devStub.sendVerifyCode).toHaveBeenCalledWith(VERIFY_INPUT);
    expect(h.devStub.sendBirthdayGreeting).toHaveBeenCalledWith(BIRTHDAY_INPUT);
    expect(h.devStub.sendNotification).toHaveBeenCalledWith(NOTIFICATION_INPUT);
  });

  it('公共 birthday / notification prepare 只返回 Effect，调用 invoke 前不发送', async () => {
    const h = makeHarness();
    h.settings.getActiveSettings.mockResolvedValue(makeSettings());

    const birthday = await h.router.prepareBirthdayGreeting(BIRTHDAY_INPUT);
    const notification = await h.router.prepareNotification(NOTIFICATION_INPUT);
    expect(h.devStub.sendBirthdayGreeting).not.toHaveBeenCalled();
    expect(h.devStub.sendNotification).not.toHaveBeenCalled();

    await birthday.invoke();
    await notification.invoke();
    expect(h.devStub.sendBirthdayGreeting).toHaveBeenCalledTimes(1);
    expect(h.devStub.sendNotification).toHaveBeenCalledTimes(1);
  });
});
