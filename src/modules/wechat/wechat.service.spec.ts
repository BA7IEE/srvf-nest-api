import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { DevStubWechatProvider } from './providers/dev-stub.provider';
import type { WechatMiniRealProvider } from './providers/wechat.provider';
import type { WechatSettingsService } from './wechat-settings.service';
import { WechatService } from './wechat.service';
import {
  WechatApiError,
  WechatChannelUnavailableError,
  WechatCodeInvalidError,
  WechatCredentialStatus,
  type WechatSettingsResolved,
} from './wechat.types';

// 微信小程序登录 review 收口(2026-06-12 增量审计②):WechatService 域错误 → BizCode
// 映射层 unit——此前 25031 全仓零行为断言、25010 的 code2session 来源分支零触达
// (e2e DevStub 不模拟失败;provider spec 只断言到域错误层,映射边界无任何测试)。
// 纯构造器注入 mock,不起 Nest、不连库(沿 wechat.provider.spec 范式)。

function makeResolved(overrides: Partial<WechatSettingsResolved> = {}): WechatSettingsResolved {
  return {
    id: 'ws1',
    providerType: 'WECHAT',
    enabled: true,
    appId: 'wx-appid',
    credentials: { appSecret: 'unit-secret' },
    credentialStatus: WechatCredentialStatus.CONFIGURED,
    remarks: null,
    updatedBy: null,
    updatedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

function makeService(
  opts: {
    resolved?: WechatSettingsResolved | null;
    realCode2Session?: jest.Mock;
    env?: string;
  } = {},
): WechatService {
  const resolved = 'resolved' in opts ? opts.resolved : makeResolved();
  const settings = {
    getActiveSettings: jest
      .fn<Promise<WechatSettingsResolved | null>, []>()
      .mockResolvedValue(resolved ?? null),
  };
  const devStub = { code2session: jest.fn() };
  const real = { code2session: opts.realCode2Session ?? jest.fn() };
  const cfg = { env: opts.env ?? 'development' };
  return new WechatService(
    settings as unknown as WechatSettingsService,
    devStub as unknown as DevStubWechatProvider,
    real as unknown as WechatMiniRealProvider,
    cfg as unknown as ConstructorParameters<typeof WechatService>[3],
  );
}

describe('WechatService — 域错误 → BizCode 映射(评审稿 E-11/§5)', () => {
  it('WechatCodeInvalidError → 25010 WECHAT_CODE_INVALID', async () => {
    const service = makeService({
      realCode2Session: jest.fn().mockRejectedValue(new WechatCodeInvalidError('40029')),
    });
    await expect(service.code2session('bad-code')).rejects.toEqual(
      new BizException(BizCode.WECHAT_CODE_INVALID),
    );
  });

  it('WechatApiError → 25031 WECHAT_API_FAILED(超时 / 网络 / HTTP / 非 JSON / 缺 openid 同归)', async () => {
    const service = makeService({
      realCode2Session: jest
        .fn()
        .mockRejectedValue(new WechatApiError('FETCH_ERROR', 'TimeoutError')),
    });
    await expect(service.code2session('x')).rejects.toEqual(
      new BizException(BizCode.WECHAT_API_FAILED),
    );
  });

  it('Provider 抛 WechatChannelUnavailableError → 25030 WECHAT_CHANNEL_NOT_CONFIGURED', async () => {
    const service = makeService({
      realCode2Session: jest
        .fn()
        .mockRejectedValue(new WechatChannelUnavailableError('appId 未配置')),
    });
    await expect(service.code2session('x')).rejects.toEqual(
      new BizException(BizCode.WECHAT_CHANNEL_NOT_CONFIGURED),
    );
  });

  it('resolve:settings 为 null → 25030(不触 provider)', async () => {
    const real = jest.fn();
    const service = makeService({ resolved: null, realCode2Session: real });
    await expect(service.code2session('x')).rejects.toEqual(
      new BizException(BizCode.WECHAT_CHANNEL_NOT_CONFIGURED),
    );
    expect(real).not.toHaveBeenCalled();
  });

  it('非域错误原样上抛(不吞不映射)', async () => {
    const boom = new Error('unexpected');
    const service = makeService({ realCode2Session: jest.fn().mockRejectedValue(boom) });
    await expect(service.code2session('x')).rejects.toBe(boom);
  });

  it('成功路:provider 出参原样透传 { openid }', async () => {
    const service = makeService({
      realCode2Session: jest.fn().mockResolvedValue({ openid: 'o-12345678901234567890' }),
    });
    await expect(service.code2session('ok')).resolves.toEqual({
      openid: 'o-12345678901234567890',
    });
  });
});
