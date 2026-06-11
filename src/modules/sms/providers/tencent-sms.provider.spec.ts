import { sms } from 'tencentcloud-sdk-nodejs-sms';

import type { SmsSettingsService } from '../sms-settings.service';
import {
  SmsChannelUnavailableError,
  SmsCredentialStatus,
  SmsProviderSendError,
  type SmsSettingsResolved,
} from '../sms.types';
import { TencentSmsProvider } from './tencent-sms.provider';

// SMS 基础设施 T2:tencent-sms.provider 单元测试(评审稿 §10;沿 cos.provider.spec 范式:
// 整包 mock SDK,禁止真实联网)

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
    templateIdBirthday: null,
    credentials: { secretId: 'AKID-test-id', secretKey: 'secret-test-key' },
    credentialStatus: SmsCredentialStatus.CONFIGURED,
    remarks: null,
    updatedBy: null,
    updatedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

function makeSettingsServiceMock(settings: SmsSettingsResolved | null): SmsSettingsService {
  return {
    getActiveSettings: jest.fn().mockResolvedValue(settings),
  } as unknown as SmsSettingsService;
}

const INPUT = { phone: '13800001234', code: '654321', ttlMinutes: 5 };

describe('TencentSmsProvider', () => {
  beforeEach(() => {
    ClientMock.mockClear();
    ClientMock.__mockInstance.SendSms.mockReset();
  });

  describe('sendVerifyCode 成功路径', () => {
    it('SendSms 入参:+86 E.164 / SdkAppId / SignName / TemplateId / TemplateParamSet=[code, ttl]', async () => {
      ClientMock.__mockInstance.SendSms.mockResolvedValue({
        SendStatusSet: [{ Code: 'Ok', Message: 'send success', SerialNo: 'sn-123' }],
      });
      const provider = new TencentSmsProvider(makeSettingsServiceMock(makeSettings()));

      const result = await provider.sendVerifyCode(INPUT);

      expect(result).toEqual({ providerMsgId: 'sn-123' });
      expect(ClientMock).toHaveBeenCalledWith({
        credential: { secretId: 'AKID-test-id', secretKey: 'secret-test-key' },
        region: 'ap-guangzhou',
      });
      expect(ClientMock.__mockInstance.SendSms).toHaveBeenCalledWith({
        PhoneNumberSet: ['+8613800001234'],
        SmsSdkAppId: '1400000000',
        SignName: '某救援队',
        TemplateId: '2000000',
        TemplateParamSet: ['654321', '5'],
      });
    });

    it('不缓存 SDK client:两次调用各新建一次(镜像 storage Q-89-2)', async () => {
      ClientMock.__mockInstance.SendSms.mockResolvedValue({
        SendStatusSet: [{ Code: 'Ok', SerialNo: 'sn-1' }],
      });
      const provider = new TencentSmsProvider(makeSettingsServiceMock(makeSettings()));
      await provider.sendVerifyCode(INPUT);
      await provider.sendVerifyCode(INPUT);
      expect(ClientMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('sendVerifyCode 失败路径', () => {
    it('回执 Code != Ok → SmsProviderSendError(携带 errCode/errMsg)', async () => {
      ClientMock.__mockInstance.SendSms.mockResolvedValue({
        SendStatusSet: [
          { Code: 'LimitExceeded.PhoneNumberDailyLimit', Message: 'daily limit', SerialNo: '' },
        ],
      });
      const provider = new TencentSmsProvider(makeSettingsServiceMock(makeSettings()));
      await expect(provider.sendVerifyCode(INPUT)).rejects.toMatchObject({
        name: 'SmsProviderSendError',
        errCode: 'LimitExceeded.PhoneNumberDailyLimit',
        errMsg: 'daily limit',
      });
    });

    it('SendStatusSet 为空 → SmsProviderSendError(EMPTY_SEND_STATUS)', async () => {
      ClientMock.__mockInstance.SendSms.mockResolvedValue({ SendStatusSet: [] });
      const provider = new TencentSmsProvider(makeSettingsServiceMock(makeSettings()));
      await expect(provider.sendVerifyCode(INPUT)).rejects.toMatchObject({
        errCode: 'EMPTY_SEND_STATUS',
      });
    });

    it('SDK 抛异常 → SmsProviderSendError(透传 code,不抛裸异常)', async () => {
      ClientMock.__mockInstance.SendSms.mockRejectedValue(
        Object.assign(new Error('AuthFailure'), { code: 'AuthFailure.SecretIdNotFound' }),
      );
      const provider = new TencentSmsProvider(makeSettingsServiceMock(makeSettings()));
      await expect(provider.sendVerifyCode(INPUT)).rejects.toBeInstanceOf(SmsProviderSendError);
      await expect(provider.sendVerifyCode(INPUT)).rejects.toMatchObject({
        errCode: 'AuthFailure.SecretIdNotFound',
      });
    });
  });

  describe('4 档守护(镜像 cos.provider requireCosContext)', () => {
    it.each([
      ['settings null', null],
      ['enabled=false', makeSettings({ enabled: false })],
      ['providerType=DEV_STUB', makeSettings({ providerType: 'DEV_STUB' })],
      [
        'credentialStatus=missing',
        makeSettings({ credentials: null, credentialStatus: SmsCredentialStatus.MISSING }),
      ],
      ['sdkAppId 缺失', makeSettings({ sdkAppId: null })],
      ['signName 缺失', makeSettings({ signName: null })],
      ['region 缺失', makeSettings({ region: null })],
      ['templateIdVerifyCode 缺失', makeSettings({ templateIdVerifyCode: null })],
    ])('%s → SmsChannelUnavailableError 且不触发 SDK', async (_label, settings) => {
      const provider = new TencentSmsProvider(makeSettingsServiceMock(settings));
      await expect(provider.sendVerifyCode(INPUT)).rejects.toBeInstanceOf(
        SmsChannelUnavailableError,
      );
      expect(ClientMock.__mockInstance.SendSms).not.toHaveBeenCalled();
    });
  });
});
