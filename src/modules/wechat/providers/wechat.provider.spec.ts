import { Logger } from '@nestjs/common';

import type { WechatSettingsService } from '../wechat-settings.service';
import {
  WechatApiError,
  WechatChannelUnavailableError,
  WechatCodeInvalidError,
  WechatCredentialStatus,
  type WechatSettingsResolved,
} from '../wechat.types';
import { WechatMiniRealProvider } from './wechat.provider';

// 微信小程序登录 T2:真实 Provider 单元测试(评审稿 E-11/E-12/E-28;mock 全局 fetch,
// 镜像 tencent-sms.provider.spec 的"真实通道行为由 mock 覆盖"范式)
//
// 覆盖矩阵:
// 1. 成功:errcode 缺省 + openid → 仅返 { openid }(session_key / unionid 即弃)
// 2. errcode 40029 / 40163 → WechatCodeInvalidError(→ T3 25010)
// 3. 其余 errcode(-1)→ WechatApiError(→ T3 25031),errMsg 来自微信回执
// 4. HTTP 非 200 → WechatApiError('HTTP_ERROR')
// 5. fetch 抛错(超时 TimeoutError / 网络)→ WechatApiError('FETCH_ERROR'),
//    错误信息仅含 err.name,**不含 URL / secret**(E-12)
// 6. 非 JSON 体 → WechatApiError('INVALID_RESPONSE')
// 7. 200 但缺 openid → WechatApiError('MISSING_OPENID')
// 8. 4 档守护:settings null / 未启用 / providerType≠WECHAT / 凭证非 CONFIGURED / appId 缺失
//    → WechatChannelUnavailableError
// 9. 请求构造:URL 落 api.weixin.qq.com/sns/jscode2session + 4 个 query 参数 + AbortSignal 就位
// 10. 失败路径 warn 日志(2026-06-12 增量 review ①⑨ 收口):四失败路径各一行 warn,
//     内容零 secret / URL / 响应原文;body 读取阶段中断归类 FETCH_ERROR(非 INVALID_RESPONSE)

const APP_ID = 'wx-test-appid';
const APP_SECRET = 'test-app-secret-value';

function makeResolved(overrides: Partial<WechatSettingsResolved> = {}): WechatSettingsResolved {
  return {
    id: 'ws1',
    providerType: 'WECHAT',
    enabled: true,
    appId: APP_ID,
    credentials: { appSecret: APP_SECRET },
    credentialStatus: WechatCredentialStatus.CONFIGURED,
    remarks: null,
    updatedBy: null,
    updatedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

function makeProvider(resolved: WechatSettingsResolved | null): WechatMiniRealProvider {
  const settings = {
    getActiveSettings: jest.fn().mockResolvedValue(resolved),
  } as unknown as WechatSettingsService;
  return new WechatMiniRealProvider(settings);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

async function caughtFrom(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return err;
  }
}

describe('WechatMiniRealProvider', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('成功:仅返 { openid },session_key / unionid 即弃(E-12)', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ openid: 'oABCDEF1234567890', session_key: 'sk-discard', unionid: 'u-x' }),
    );
    const provider = makeProvider(makeResolved());
    const result = await provider.code2session({ code: 'wx-code-1' });
    expect(result).toEqual({ openid: 'oABCDEF1234567890' });
    expect(Object.keys(result)).toEqual(['openid']); // session_key / unionid 不在返回形状里
  });

  it('请求构造:URL + 4 query 参数 + AbortSignal 就位(E-2)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ openid: 'o1' }));
    const provider = makeProvider(makeResolved());
    await provider.code2session({ code: 'the-code' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [urlArg, initArg] = fetchSpy.mock.calls[0] as [URL, { signal?: AbortSignal }];
    expect(urlArg).toBeInstanceOf(URL);
    expect(urlArg.origin + urlArg.pathname).toBe('https://api.weixin.qq.com/sns/jscode2session');
    expect(urlArg.searchParams.get('appid')).toBe(APP_ID);
    expect(urlArg.searchParams.get('secret')).toBe(APP_SECRET);
    expect(urlArg.searchParams.get('js_code')).toBe('the-code');
    expect(urlArg.searchParams.get('grant_type')).toBe('authorization_code');
    expect(initArg.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([[40029], [40163]])('errcode %d → WechatCodeInvalidError', async (errcode) => {
    fetchSpy.mockResolvedValue(jsonResponse({ errcode, errmsg: 'invalid code' }));
    const provider = makeProvider(makeResolved());
    const caught = await caughtFrom(provider.code2session({ code: 'bad' }));
    expect(caught).toBeInstanceOf(WechatCodeInvalidError);
    expect((caught as WechatCodeInvalidError).errCode).toBe(String(errcode));
  });

  it('其余 errcode(-1 系统繁忙)→ WechatApiError 携带微信 errmsg', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ errcode: -1, errmsg: 'system busy' }));
    const provider = makeProvider(makeResolved());
    const caught = await caughtFrom(provider.code2session({ code: 'x' }));
    expect(caught).toBeInstanceOf(WechatApiError);
    expect((caught as WechatApiError).errCode).toBe('-1');
    expect((caught as WechatApiError).errMsg).toBe('system busy');
  });

  it('HTTP 非 200 → WechatApiError(HTTP_ERROR)', async () => {
    fetchSpy.mockResolvedValue(new Response('oops', { status: 502 }));
    const provider = makeProvider(makeResolved());
    const caught = await caughtFrom(provider.code2session({ code: 'x' }));
    expect(caught).toBeInstanceOf(WechatApiError);
    expect((caught as WechatApiError).errCode).toBe('HTTP_ERROR');
  });

  it('fetch 抛错(超时)→ WechatApiError(FETCH_ERROR),错误信息不含 URL / secret(E-12)', async () => {
    const timeoutErr = new Error('The operation was aborted due to timeout');
    timeoutErr.name = 'TimeoutError';
    fetchSpy.mockRejectedValue(timeoutErr);
    const provider = makeProvider(makeResolved());
    const caught = await caughtFrom(provider.code2session({ code: 'x' }));
    expect(caught).toBeInstanceOf(WechatApiError);
    const err = caught as WechatApiError;
    expect(err.errCode).toBe('FETCH_ERROR');
    expect(err.errMsg).toBe('TimeoutError'); // 仅 err.name,原文不外传
    expect(err.message).not.toContain(APP_SECRET);
    expect(err.message).not.toContain('api.weixin.qq.com');
  });

  it('非 JSON 体 → WechatApiError(INVALID_RESPONSE)', async () => {
    fetchSpy.mockResolvedValue(new Response('<html>not json</html>', { status: 200 }));
    const provider = makeProvider(makeResolved());
    const caught = await caughtFrom(provider.code2session({ code: 'x' }));
    expect(caught).toBeInstanceOf(WechatApiError);
    expect((caught as WechatApiError).errCode).toBe('INVALID_RESPONSE');
  });

  it('200 但缺 openid → WechatApiError(MISSING_OPENID)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ session_key: 'only-sk' }));
    const provider = makeProvider(makeResolved());
    const caught = await caughtFrom(provider.code2session({ code: 'x' }));
    expect(caught).toBeInstanceOf(WechatApiError);
    expect((caught as WechatApiError).errCode).toBe('MISSING_OPENID');
  });

  it.each([
    ['settings 为 null', null],
    ['未启用', makeResolved({ enabled: false })],
    ['providerType 不是 WECHAT', makeResolved({ providerType: 'DEV_STUB' })],
    [
      '凭证非 CONFIGURED',
      makeResolved({ credentials: null, credentialStatus: WechatCredentialStatus.MISSING }),
    ],
    ['appId 缺失', makeResolved({ appId: null })],
  ])('4 档守护:%s → WechatChannelUnavailableError(不发起 fetch)', async (_label, resolved) => {
    const provider = makeProvider(resolved);
    const caught = await caughtFrom(provider.code2session({ code: 'x' }));
    expect(caught).toBeInstanceOf(WechatChannelUnavailableError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe('失败路径 warn 日志(2026-06-12 增量 review ①⑨ 收口)', () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    function warnText(): string {
      return (warnSpy.mock.calls as unknown[][]).map((call) => String(call[0])).join('\n');
    }

    it('fetch 抛错 → warn 一行,含 err.name 不含 URL / secret(E-12 兼容)', async () => {
      const timeoutErr = new Error('The operation was aborted due to timeout');
      timeoutErr.name = 'TimeoutError';
      fetchSpy.mockRejectedValue(timeoutErr);
      const provider = makeProvider(makeResolved());
      await caughtFrom(provider.code2session({ code: 'x' }));
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnText()).toContain('name=TimeoutError');
      expect(warnText()).not.toContain(APP_SECRET);
      expect(warnText()).not.toContain('api.weixin.qq.com');
    });

    it('HTTP 非 200 → warn 一行,含 status 不含响应体', async () => {
      fetchSpy.mockResolvedValue(new Response('upstream secret-ish body', { status: 502 }));
      const provider = makeProvider(makeResolved());
      await caughtFrom(provider.code2session({ code: 'x' }));
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnText()).toContain('status=502');
      expect(warnText()).not.toContain('secret-ish');
    });

    it('非 JSON 体 → warn 一行(固定标签,响应原文不入日志)', async () => {
      fetchSpy.mockResolvedValue(new Response('<html>not json</html>', { status: 200 }));
      const provider = makeProvider(makeResolved());
      await caughtFrom(provider.code2session({ code: 'x' }));
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnText()).toContain('non-JSON body');
      expect(warnText()).not.toContain('<html>');
    });

    it('200 但缺 openid → warn 一行', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ session_key: 'only-sk' }));
      const provider = makeProvider(makeResolved());
      await caughtFrom(provider.code2session({ code: 'x' }));
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnText()).toContain('no openid');
      expect(warnText()).not.toContain('only-sk');
    });

    it('body 读取阶段中断 → 归类 FETCH_ERROR(原误标 INVALID_RESPONSE)且 warn 一行', async () => {
      const abortErr = new Error('terminated');
      abortErr.name = 'TimeoutError';
      const bodyHangsRes = { ok: true, status: 200, text: () => Promise.reject(abortErr) };
      fetchSpy.mockResolvedValue(bodyHangsRes);
      const provider = makeProvider(makeResolved());
      const caught = await caughtFrom(provider.code2session({ code: 'x' }));
      expect(caught).toBeInstanceOf(WechatApiError);
      expect((caught as WechatApiError).errCode).toBe('FETCH_ERROR');
      expect((caught as WechatApiError).errMsg).toBe('TimeoutError');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnText()).toContain('body read failed name=TimeoutError');
    });
  });
});
