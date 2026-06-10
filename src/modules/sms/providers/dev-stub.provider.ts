import { Injectable, Logger } from '@nestjs/common';

import type { SendVerifyCodeInput, SendVerifyCodeResult, SmsProvider } from '../sms.types';

// SMS 基础设施 T2(2026-06-10):DevStub Provider(评审稿 D-SMS-5 / E-29)
//
// 非生产联调通道:不调任何外部服务,**以 debug 级日志输出明文码**——这是
// "明文码不入日志"铁律的唯一拍板例外(评审稿 §4 DevStub 例外),前提:
// - providerType=DEV_STUB 在 production-like(production/smoke)写入与运行时双重被禁(E-15),
//   本 Provider 在生产环境物理不可达;
// - 配合 SmsCodeService(T3)在 DEV_STUB 通道下签发固定码 888888,e2e / 本地联调无需翻日志。
//
// 不做:不模拟失败 / 延迟 / 回执(真实通道行为由 tencent-sms.provider.spec mock 覆盖)。

@Injectable()
export class DevStubSmsProvider implements SmsProvider {
  private readonly logger = new Logger(DevStubSmsProvider.name);

  sendVerifyCode(input: SendVerifyCodeInput): Promise<SendVerifyCodeResult> {
    // debug 级:默认日志级别(info)下不输出;本地排查时调低 LOG_LEVEL 可见
    this.logger.debug(
      `[DEV_STUB] sendVerifyCode phone=${input.phone} code=${input.code} ttlMinutes=${input.ttlMinutes}`,
    );
    return Promise.resolve({ providerMsgId: null });
  }
}
