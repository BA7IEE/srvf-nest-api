import { Injectable, Logger } from '@nestjs/common';

import { WECHAT_DEV_STUB_OPENID_PREFIX } from '../wechat.constants';
import type {
  Code2SessionInput,
  Code2SessionResult,
  SendSubscribeMessageInput,
  SendSubscribeMessageResult,
  WechatMiniProvider,
} from '../wechat.types';

// DevStub 订阅消息发送(统一通知 S2):确定性假回执供 e2e。
// - 默认成功,msgid = `dev-msgid-<openid 后段>`(确定性,断言友好)。
// - **失败注入(仅 e2e;production 物理不可达)**:openid 含 `wxerr-<errcode>` → 返该 errcode 失败,
//   e2e 可造 openid=`dev-openid-wxerr-43101` 触发 43101 回补分支、`...wxerr-40003` 触发 invalid-openid 等。
//   镜像 code2session `dev-openid-<code>` 确定性范式(DevStub 决定性使 e2e 可造多态)。
const DEV_STUB_ACCESS_TOKEN = 'dev-stub-access-token';
const DEV_STUB_ERR_INJECT = /wxerr-(\d+)/;

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

  // 确定性假 access_token(不调外部;forceRefresh 对 stub 无意义故省略,接口可选参允许)
  getAccessToken(): Promise<string> {
    this.logger.debug('[DEV_STUB] getAccessToken called');
    return Promise.resolve(DEV_STUB_ACCESS_TOKEN);
  }

  // 确定性假发送回执:默认成功;openid 含 wxerr-<errcode> → 注入该 errcode 失败(仅 e2e 多态)
  sendSubscribeMessage(
    _accessToken: string,
    input: SendSubscribeMessageInput,
  ): Promise<SendSubscribeMessageResult> {
    this.logger.debug('[DEV_STUB] sendSubscribeMessage called');
    const inject = DEV_STUB_ERR_INJECT.exec(input.openid);
    if (inject) {
      return Promise.resolve({
        ok: false,
        errCode: inject[1],
        errMsg: `dev-stub injected ${inject[1]}`,
      });
    }
    return Promise.resolve({ ok: true, msgId: `dev-msgid-${input.openid.slice(-8)}` });
  }
}
