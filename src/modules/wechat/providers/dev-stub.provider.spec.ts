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

  // 统一通知 S2:订阅消息发送 stub(确定性回执 + 失败注入)。
  describe('getAccessToken / sendSubscribeMessage (S2)', () => {
    it('无 guard 时 Promise 返回前已同步进入 debug/假 Effect（零 microtask 漂移）', async () => {
      const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      try {
        const provider = new DevStubWechatProvider();
        const tokenPending = provider.getAccessToken();
        expect(debugSpy).toHaveBeenCalledWith('[DEV_STUB] getAccessToken called');
        await expect(tokenPending).resolves.toBe('dev-stub-access-token');

        debugSpy.mockClear();
        const sendPending = provider.sendSubscribeMessage('tok', {
          openid: 'dev-openid-alice',
          templateId: 't',
          data: {},
        });
        expect(debugSpy).toHaveBeenCalledWith('[DEV_STUB] sendSubscribeMessage called');
        await expect(sendPending).resolves.toEqual({ ok: true, msgId: 'dev-msgid-id-alice' });
      } finally {
        debugSpy.mockRestore();
      }
    });

    it('getAccessToken 返确定性假 token', async () => {
      const provider = new DevStubWechatProvider();
      expect(await provider.getAccessToken()).toBe('dev-stub-access-token');
    });

    it('getAccessToken guard 失败时 debug/假 token Effect=0 且原错误冒泡', async () => {
      const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      const leaseLost = new Error('lease lost before stub token');
      try {
        const provider = new DevStubWechatProvider();
        await expect(provider.getAccessToken(false, () => Promise.reject(leaseLost))).rejects.toBe(
          leaseLost,
        );
        expect(debugSpy).not.toHaveBeenCalled();
      } finally {
        debugSpy.mockRestore();
      }
    });

    it('sendSubscribeMessage 默认成功 + 确定性 msgid', async () => {
      const provider = new DevStubWechatProvider();
      const r = await provider.sendSubscribeMessage('tok', {
        openid: 'dev-openid-alice',
        templateId: 't',
        data: {},
      });
      expect(r).toEqual({ ok: true, msgId: 'dev-msgid-id-alice' });
    });

    it('sendSubscribeMessage guard 失败时 debug/假回执 Effect=0 且原错误冒泡', async () => {
      const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      const leaseLost = new Error('lease lost before stub send');
      try {
        const provider = new DevStubWechatProvider();
        await expect(
          provider.sendSubscribeMessage(
            'tok',
            { openid: 'dev-openid-alice', templateId: 't', data: {} },
            () => Promise.reject(leaseLost),
          ),
        ).rejects.toBe(leaseLost);
        expect(debugSpy).not.toHaveBeenCalled();
      } finally {
        debugSpy.mockRestore();
      }
    });

    it('openid 含 wxerr-<errcode> → 注入该 errcode 失败(e2e 多态)', async () => {
      const provider = new DevStubWechatProvider();
      const r = await provider.sendSubscribeMessage('tok', {
        openid: 'dev-openid-wxerr-43101',
        templateId: 't',
        data: {},
      });
      expect(r).toMatchObject({ ok: false, errCode: '43101' });
    });
  });
});
