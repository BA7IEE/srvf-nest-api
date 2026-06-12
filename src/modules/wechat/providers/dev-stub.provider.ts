import { Injectable, Logger } from '@nestjs/common';

import { WECHAT_DEV_STUB_OPENID_PREFIX } from '../wechat.constants';
import type { Code2SessionInput, Code2SessionResult, WechatMiniProvider } from '../wechat.types';

// 微信小程序登录 T2(2026-06-12):DevStub Provider(评审稿 E-10)
//
// 非生产联调通道:不调任何外部服务,按 code 返**确定性**假 openid
// `dev-openid-<code>`——e2e / 本地联调可用不同 code 造多个"微信用户",
// 同 code 恒得同 openid(绑定 → 登录全链可测)。
//
// 与 SMS DevStub 的差异(评审稿 §6):debug 日志**不输出 code / openid**
// (code 是一次性凭证不入日志;openid 不滥回显——即使是假值也不开例外,避免范式漂移)。
//
// 不做:不模拟失败 / 延迟 / errcode(真实通道错误映射由 wechat.provider.spec mock 覆盖,E-28);
// production-like 下 DEV_STUB 写入与运行时双重被禁(镜像 sms E-15),本 Provider 生产物理不可达。

@Injectable()
export class DevStubWechatProvider implements WechatMiniProvider {
  private readonly logger = new Logger(DevStubWechatProvider.name);

  code2session(input: Code2SessionInput): Promise<Code2SessionResult> {
    this.logger.debug('[DEV_STUB] code2session called');
    return Promise.resolve({ openid: `${WECHAT_DEV_STUB_OPENID_PREFIX}${input.code}` });
  }
}
