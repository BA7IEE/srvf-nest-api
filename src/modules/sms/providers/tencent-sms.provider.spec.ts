import { sms } from 'tencentcloud-sdk-nodejs-sms';

import type { SmsSettingsService } from '../sms-settings.service';
import {
  SmsChannelUnavailableError,
  SmsCredentialStatus,
  SmsProviderSendError,
  type SmsSettingsResolved,
} from '../sms.types';
import { TencentSmsProvider } from './tencent-sms.provider';

// 整包 mock SDK，禁止真实联网；prepared Effect 的同步入口与三模板请求在此锁定。
jest.mock('tencentcloud-sdk-nodejs-sms', () => {
  const mockInstance = { SendSms: jest.fn() };
  const Constructor = jest.fn().mockImplementation(() => mockInstance);
  (Constructor as unknown as { __mockInstance: typeof mockInstance }).__mockInstance = mockInstance;
  return { __esModule: true, sms: { v20210111: { Client: Constructor } } };
});

const ClientMock = sms.v20210111.Client as unknown as jest.Mock & {
  __mockInstance: { SendSms: jest.Mock };
};

function makeSettings(overrides: Partial<SmsSettingsResolved> = {}): SmsSettingsResolved {
  return {
    id: 'cuid-sms-settings',
    providerType: 'TENCENT_SMS',
    enabled: true,
    sdkAppId: '1400000000',
    signName: '某救援队',
    region: 'ap-guangzhou',
    templateIdVerifyCode: '2000000',
    templateIdBirthday: '3000000',
    templateIdNotification: '9000000',
    credentials: { secretId: 'AKID-test-id', secretKey: 'secret-test-key' },
    credentialStatus: SmsCredentialStatus.CONFIGURED,
    remarks: null,
    updatedBy: null,
    updatedAt: new Date('2026-07-19T00:00:00.000Z'),
    createdAt: new Date('2026-07-19T00:00:00.000Z'),
    ...overrides,
  };
}

function makeSettingsServiceMock(settings: SmsSettingsResolved | null): {
  service: SmsSettingsService;
  getActiveSettings: jest.Mock;
} {
  const getActiveSettings = jest.fn().mockResolvedValue(settings);
  return {
    service: { getActiveSettings } as unknown as SmsSettingsService,
    getActiveSettings,
  };
}

const VERIFY_INPUT = { phone: '13800001234', code: '654321', ttlMinutes: 5 };

describe('TencentSmsProvider prepared snapshot', () => {
  beforeEach(() => {
    ClientMock.mockClear();
    ClientMock.__mockInstance.SendSms.mockReset();
  });

  it('verify prepare 不读 settings，并在 invoke 返回 Promise 前同步调用 SDK', async () => {
    ClientMock.__mockInstance.SendSms.mockResolvedValue({
      SendStatusSet: [{ Code: 'Ok', Message: 'send success', SerialNo: 'sn-123' }],
    });
    const settingsService = makeSettingsServiceMock(makeSettings({ providerType: 'DEV_STUB' }));
    const provider = new TencentSmsProvider(settingsService.service);
    const snapshot = makeSettings();

    const prepared = provider.prepareVerifyCode(snapshot, VERIFY_INPUT);

    expect(settingsService.getActiveSettings).not.toHaveBeenCalled();
    expect(ClientMock).toHaveBeenCalledWith({
      credential: { secretId: 'AKID-test-id', secretKey: 'secret-test-key' },
      region: 'ap-guangzhou',
      profile: { httpProfile: { reqTimeout: 8 } },
    });
    expect(ClientMock.__mockInstance.SendSms).not.toHaveBeenCalled();
    expect(Object.keys(prepared).sort()).toEqual(['invoke', 'providerType']);
    expect(JSON.stringify(prepared)).toBe('{"providerType":"TENCENT_SMS"}');
    expect(prepared.invoke.constructor.name).toBe('Function');

    const pending = prepared.invoke();
    expect(ClientMock.__mockInstance.SendSms).toHaveBeenCalledWith({
      PhoneNumberSet: ['+8613800001234'],
      SmsSdkAppId: '1400000000',
      SignName: '某救援队',
      TemplateId: '2000000',
      TemplateParamSet: ['654321', '5'],
    });
    await expect(pending).resolves.toEqual({ providerMsgId: 'sn-123' });
  });

  it('birthday supplied snapshot 绑定对应零变量模板且不读 settings', async () => {
    ClientMock.__mockInstance.SendSms.mockResolvedValue({
      SendStatusSet: [{ Code: 'Ok', SerialNo: 'sn-birthday' }],
    });
    const settingsService = makeSettingsServiceMock(null);
    const provider = new TencentSmsProvider(settingsService.service);

    const prepared = provider.prepareBirthdayGreeting(makeSettings(), {
      phone: '13800001235',
    });
    const pending = prepared.invoke();

    expect(settingsService.getActiveSettings).not.toHaveBeenCalled();
    expect(ClientMock.__mockInstance.SendSms).toHaveBeenCalledWith({
      PhoneNumberSet: ['+8613800001235'],
      SmsSdkAppId: '1400000000',
      SignName: '某救援队',
      TemplateId: '3000000',
      TemplateParamSet: [],
    });
    await expect(pending).resolves.toEqual({ providerMsgId: 'sn-birthday' });
  });

  it('notification supplied snapshot 绑定对应零变量模板且不读 settings', async () => {
    ClientMock.__mockInstance.SendSms.mockResolvedValue({
      SendStatusSet: [{ Code: 'Ok', SerialNo: 'sn-notification' }],
    });
    const settingsService = makeSettingsServiceMock(null);
    const provider = new TencentSmsProvider(settingsService.service);

    const prepared = provider.prepareNotification(makeSettings(), { phone: '13800001236' });
    const pending = prepared.invoke();

    expect(settingsService.getActiveSettings).not.toHaveBeenCalled();
    expect(ClientMock.__mockInstance.SendSms).toHaveBeenCalledWith({
      PhoneNumberSet: ['+8613800001236'],
      SmsSdkAppId: '1400000000',
      SignName: '某救援队',
      TemplateId: '9000000',
      TemplateParamSet: [],
    });
    await expect(pending).resolves.toEqual({ providerMsgId: 'sn-notification' });
  });

  it.each([
    ['settings null', null],
    ['enabled=false', makeSettings({ enabled: false })],
    ['providerType=DEV_STUB', makeSettings({ providerType: 'DEV_STUB' })],
    [
      'credentialStatus=missing',
      makeSettings({ credentials: null, credentialStatus: SmsCredentialStatus.MISSING }),
    ],
    [
      'credentialStatus=invalid',
      makeSettings({ credentials: null, credentialStatus: SmsCredentialStatus.INVALID }),
    ],
    ['sdkAppId 缺失', makeSettings({ sdkAppId: null })],
    ['signName 缺失', makeSettings({ signName: null })],
    ['region 缺失', makeSettings({ region: null })],
    ['templateIdVerifyCode 缺失', makeSettings({ templateIdVerifyCode: null })],
  ])('%s 在 prepare 阶段 fail-closed，SDK client/send 均为 0', (_label, settings) => {
    const provider = new TencentSmsProvider(makeSettingsServiceMock(null).service);

    expect(() => provider.prepareVerifyCode(settings, VERIFY_INPUT)).toThrow(
      SmsChannelUnavailableError,
    );
    expect(ClientMock).not.toHaveBeenCalled();
    expect(ClientMock.__mockInstance.SendSms).not.toHaveBeenCalled();
  });

  it.each([
    [
      'birthday',
      'templateIdBirthday',
      (provider: TencentSmsProvider, settings: SmsSettingsResolved) =>
        provider.prepareBirthdayGreeting(settings, { phone: '13800001235' }),
    ],
    [
      'notification',
      'templateIdNotification',
      (provider: TencentSmsProvider, settings: SmsSettingsResolved) =>
        provider.prepareNotification(settings, { phone: '13800001236' }),
    ],
  ])('%s 模板缺失在 prepare 阶段失败且 SDK=0', (_label, key, prepare) => {
    const provider = new TencentSmsProvider(makeSettingsServiceMock(null).service);
    const settings = makeSettings({ [key]: null });

    expect(() => prepare(provider, settings)).toThrow(SmsChannelUnavailableError);
    expect(ClientMock).not.toHaveBeenCalled();
    expect(ClientMock.__mockInstance.SendSms).not.toHaveBeenCalled();
  });
});

describe('TencentSmsProvider invoke error mapping', () => {
  beforeEach(() => {
    ClientMock.mockClear();
    ClientMock.__mockInstance.SendSms.mockReset();
  });

  it('SDK 同步 throw → invoke 返回 rejected Promise 并映射 SmsProviderSendError', async () => {
    ClientMock.__mockInstance.SendSms.mockImplementationOnce(() => {
      throw Object.assign(new Error('sync auth failure'), { code: 'AuthFailure.Sync' });
    });
    const provider = new TencentSmsProvider(makeSettingsServiceMock(null).service);
    const prepared = provider.prepareVerifyCode(makeSettings(), VERIFY_INPUT);

    const pending = prepared.invoke();
    expect(ClientMock.__mockInstance.SendSms).toHaveBeenCalledTimes(1);
    await expect(pending).rejects.toMatchObject({
      name: 'SmsProviderSendError',
      errCode: 'AuthFailure.Sync',
      errMsg: 'sync auth failure',
    });
  });

  it('SDK async reject → SmsProviderSendError(透传 code/message)', async () => {
    ClientMock.__mockInstance.SendSms.mockRejectedValueOnce(
      Object.assign(new Error('async auth failure'), { code: 'AuthFailure.Async' }),
    );
    const provider = new TencentSmsProvider(makeSettingsServiceMock(null).service);

    await expect(provider.prepareVerifyCode(makeSettings(), VERIFY_INPUT).invoke()).rejects.toEqual(
      new SmsProviderSendError('AuthFailure.Async', 'async auth failure'),
    );
  });

  it('SendStatusSet 为空 → SmsProviderSendError(EMPTY_SEND_STATUS)', async () => {
    ClientMock.__mockInstance.SendSms.mockResolvedValueOnce({ SendStatusSet: [] });
    const provider = new TencentSmsProvider(makeSettingsServiceMock(null).service);

    await expect(
      provider.prepareVerifyCode(makeSettings(), VERIFY_INPUT).invoke(),
    ).rejects.toMatchObject({ errCode: 'EMPTY_SEND_STATUS' });
  });

  it('回执 Code != Ok → SmsProviderSendError(errCode/errMsg)', async () => {
    ClientMock.__mockInstance.SendSms.mockResolvedValueOnce({
      SendStatusSet: [
        { Code: 'LimitExceeded.PhoneNumberDailyLimit', Message: 'daily limit', SerialNo: '' },
      ],
    });
    const provider = new TencentSmsProvider(makeSettingsServiceMock(null).service);

    await expect(
      provider.prepareVerifyCode(makeSettings(), VERIFY_INPUT).invoke(),
    ).rejects.toMatchObject({
      errCode: 'LimitExceeded.PhoneNumberDailyLimit',
      errMsg: 'daily limit',
    });
  });
});

describe('TencentSmsProvider direct send compatibility', () => {
  beforeEach(() => {
    ClientMock.mockClear();
    ClientMock.__mockInstance.SendSms.mockReset();
  });

  it('既有三类 send 各读取一次 settings 并保持结果/模板行为', async () => {
    ClientMock.__mockInstance.SendSms.mockResolvedValue({
      SendStatusSet: [{ Code: 'Ok', SerialNo: 'sn-direct' }],
    });
    const snapshot = makeSettings();
    const settingsService = makeSettingsServiceMock(snapshot);
    const provider = new TencentSmsProvider(settingsService.service);
    const verifyPrepareSpy = jest.spyOn(provider, 'prepareVerifyCode');
    const birthdayPrepareSpy = jest.spyOn(provider, 'prepareBirthdayGreeting');
    const notificationPrepareSpy = jest.spyOn(provider, 'prepareNotification');

    await expect(provider.sendVerifyCode(VERIFY_INPUT)).resolves.toEqual({
      providerMsgId: 'sn-direct',
    });
    await expect(provider.sendBirthdayGreeting({ phone: '13800001235' })).resolves.toEqual({
      providerMsgId: 'sn-direct',
    });
    await expect(provider.sendNotification({ phone: '13800001236' })).resolves.toEqual({
      providerMsgId: 'sn-direct',
    });

    expect(settingsService.getActiveSettings).toHaveBeenCalledTimes(3);
    expect(verifyPrepareSpy).toHaveBeenCalledWith(snapshot, VERIFY_INPUT);
    expect(birthdayPrepareSpy).toHaveBeenCalledWith(snapshot, { phone: '13800001235' });
    expect(notificationPrepareSpy).toHaveBeenCalledWith(snapshot, { phone: '13800001236' });
    expect(ClientMock).toHaveBeenCalledTimes(3);
    expect(ClientMock.__mockInstance.SendSms).toHaveBeenCalledTimes(3);
  });

  it('不缓存 SDK client：两次直接 send 各自新建 client', async () => {
    ClientMock.__mockInstance.SendSms.mockResolvedValue({
      SendStatusSet: [{ Code: 'Ok', SerialNo: 'sn-direct' }],
    });
    const provider = new TencentSmsProvider(makeSettingsServiceMock(makeSettings()).service);

    await provider.sendVerifyCode(VERIFY_INPUT);
    await provider.sendVerifyCode(VERIFY_INPUT);

    expect(ClientMock).toHaveBeenCalledTimes(2);
  });

  it('settings null 仍在直接 send 路径 fail-closed，SDK=0', async () => {
    const settingsService = makeSettingsServiceMock(null);
    const provider = new TencentSmsProvider(settingsService.service);

    await expect(provider.sendVerifyCode(VERIFY_INPUT)).rejects.toBeInstanceOf(
      SmsChannelUnavailableError,
    );
    expect(settingsService.getActiveSettings).toHaveBeenCalledTimes(1);
    expect(ClientMock).not.toHaveBeenCalled();
    expect(ClientMock.__mockInstance.SendSms).not.toHaveBeenCalled();
  });
});
