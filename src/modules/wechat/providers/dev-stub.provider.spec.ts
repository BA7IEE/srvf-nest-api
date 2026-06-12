import { Logger } from '@nestjs/common';

import { DevStubWechatProvider } from './dev-stub.provider';

// 微信小程序登录 T2:dev-stub.provider 单元测试(评审稿 E-10/§10)
//
// 覆盖:
// 1. code2session 按 code 返确定性假 openid(同 code 恒同 openid;不同 code 不同 openid)
// 2. 与 SMS DevStub 的差异纪律:debug 日志**不含 code / openid**(评审稿 §6,不开例外)

describe('DevStubWechatProvider', () => {
  it('code2session 返确定性假 openid(dev-openid-<code>)', async () => {
    const provider = new DevStubWechatProvider();
    const a1 = await provider.code2session({ code: 'codeA' });
    const a2 = await provider.code2session({ code: 'codeA' });
    const b = await provider.code2session({ code: 'codeB' });
    expect(a1).toEqual({ openid: 'dev-openid-codeA' });
    expect(a2.openid).toBe(a1.openid); // 确定性:同 code 恒同 openid
    expect(b.openid).toBe('dev-openid-codeB');
    expect(b.openid).not.toBe(a1.openid);
  });

  it('debug 日志不含 code / openid(且不写 log/warn/error)', async () => {
    const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const provider = new DevStubWechatProvider();
      await provider.code2session({ code: 'secret-wx-code' });
      expect(debugSpy).toHaveBeenCalledTimes(1);
      expect(String(debugSpy.mock.calls[0][0])).not.toContain('secret-wx-code');
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      debugSpy.mockRestore();
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
