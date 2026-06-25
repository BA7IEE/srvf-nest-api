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

// 统一通知 S2:sendSubscribeMessage 编排(取 token + token 失效刷一次重试 + 归一不抛)。
describe('WechatService.sendSubscribeMessage (S2 编排)', () => {
  const INPUT = { openid: 'oX', templateId: 't', data: {} };

  function makeS2Service(real: {
    getAccessToken?: jest.Mock;
    sendSubscribeMessage?: jest.Mock;
  }): WechatService {
    const settings = {
      getActiveSettings: jest.fn().mockResolvedValue(makeResolved()),
    };
    const realProvider = {
      code2session: jest.fn(),
      getAccessToken: real.getAccessToken ?? jest.fn().mockResolvedValue('at-1'),
      sendSubscribeMessage: real.sendSubscribeMessage ?? jest.fn(),
    };
    return new WechatService(
      settings as unknown as WechatSettingsService,
      { code2session: jest.fn() } as unknown as DevStubWechatProvider,
      realProvider as unknown as WechatMiniRealProvider,
      { env: 'development' } as unknown as ConstructorParameters<typeof WechatService>[3],
    );
  }

  it('成功:取 token + 发送一次,结果透传', async () => {
    const send = jest.fn().mockResolvedValue({ ok: true, msgId: 'm1' });
    const getToken = jest.fn().mockResolvedValue('at-1');
    const service = makeS2Service({ getAccessToken: getToken, sendSubscribeMessage: send });
    await expect(service.sendSubscribeMessage(INPUT)).resolves.toEqual({ ok: true, msgId: 'm1' });
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('token 失效 40001 → 强刷 + 重发一次成功', async () => {
    const getToken = jest.fn().mockResolvedValueOnce('at-old').mockResolvedValueOnce('at-new');
    const send = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, errCode: '40001', errMsg: 'expired' })
      .mockResolvedValueOnce({ ok: true, msgId: 'm2' });
    const service = makeS2Service({ getAccessToken: getToken, sendSubscribeMessage: send });
    await expect(service.sendSubscribeMessage(INPUT)).resolves.toEqual({ ok: true, msgId: 'm2' });
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenLastCalledWith(true); // forceRefresh
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('token 失效重试仍败 → 最终 ok:false(非业务重试,只一次)', async () => {
    const send = jest.fn().mockResolvedValue({ ok: false, errCode: '42001', errMsg: 'x' });
    const service = makeS2Service({
      getAccessToken: jest.fn().mockResolvedValue('at'),
      sendSubscribeMessage: send,
    });
    const result = await service.sendSubscribeMessage(INPUT);
    expect(result).toEqual({ ok: false, errCode: '42001', errMsg: 'x' });
    expect(send).toHaveBeenCalledTimes(2); // 仅重试一次
  });

  it('43101 业务失败不重试(非 token 类)', async () => {
    const send = jest.fn().mockResolvedValue({ ok: false, errCode: '43101', errMsg: 'no auth' });
    const service = makeS2Service({
      getAccessToken: jest.fn().mockResolvedValue('at'),
      sendSubscribeMessage: send,
    });
    const result = await service.sendSubscribeMessage(INPUT);
    expect(result).toEqual({ ok: false, errCode: '43101', errMsg: 'no auth' });
    expect(send).toHaveBeenCalledTimes(1); // 不重试
  });

  it('getAccessToken 抛 WechatApiError → 归一 ok:false(保留 errCode,不抛)', async () => {
    const service = makeS2Service({
      getAccessToken: jest
        .fn()
        .mockRejectedValue(new WechatApiError('FETCH_ERROR', 'TimeoutError')),
    });
    await expect(service.sendSubscribeMessage(INPUT)).resolves.toEqual({
      ok: false,
      errCode: 'FETCH_ERROR',
      errMsg: 'TimeoutError',
    });
  });

  it('通道不可用 → ok:false CHANNEL_UNAVAILABLE(不抛)', async () => {
    const service = makeS2Service({
      getAccessToken: jest.fn().mockRejectedValue(new WechatChannelUnavailableError('未配置')),
    });
    const result = await service.sendSubscribeMessage(INPUT);
    expect(result.ok).toBe(false);
    expect((result as { errCode: string }).errCode).toBe('CHANNEL_UNAVAILABLE');
  });
});
