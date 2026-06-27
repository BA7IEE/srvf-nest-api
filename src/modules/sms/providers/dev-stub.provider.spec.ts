import { Logger } from '@nestjs/common';

import { DevStubSmsProvider } from './dev-stub.provider';

// SMS 基础设施 T2:dev-stub.provider 单元测试(评审稿 §10)
//
// 覆盖:
// 1. sendVerifyCode 恒成功,providerMsgId=null
// 2. 明文码只进 debug 级日志(拍板的唯一例外,E-29),不进其他级别

describe('DevStubSmsProvider', () => {
  it('sendVerifyCode 恒成功且 providerMsgId=null', async () => {
    const provider = new DevStubSmsProvider();
    const result = await provider.sendVerifyCode({
      phone: '13800001234',
      code: '888888',
      ttlMinutes: 5,
    });
    expect(result).toEqual({ providerMsgId: null });
  });

  it('sendNotification 恒成功且 providerMsgId=null(统一通知 S5;零变量,debug 日志可输出号码)', async () => {
    const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    try {
      const provider = new DevStubSmsProvider();
      const result = await provider.sendNotification({ phone: '13800001234' });
      expect(result).toEqual({ providerMsgId: null });
      expect(debugSpy).toHaveBeenCalledTimes(1);
      expect(String(debugSpy.mock.calls[0][0])).toContain('13800001234');
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('明文码仅写 debug 级日志(不写 log/warn/error)', async () => {
    const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const provider = new DevStubSmsProvider();
      await provider.sendVerifyCode({ phone: '13800001234', code: '888888', ttlMinutes: 5 });
      expect(debugSpy).toHaveBeenCalledTimes(1);
      expect(String(debugSpy.mock.calls[0][0])).toContain('888888');
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
