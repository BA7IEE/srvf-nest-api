import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import appConfig, { isProductionLike } from '../../config/app.config';
import { DevStubWechatProvider } from './providers/dev-stub.provider';
import { WechatMiniRealProvider } from './providers/wechat.provider';
import { WechatSettingsService } from './wechat-settings.service';
import {
  WechatChannelUnavailableError,
  type Code2SessionResult,
  type WechatMiniProvider,
} from './wechat.types';

// 微信小程序登录 T2(2026-06-12):微信通道编排(评审稿 E-9;
// 镜像 sms-provider.router 的 resolve 语义,**不设独立 router 文件**——
// 微信仅 code2session 一个方法,router 职责内联本 Service,差异显式登记)
//
// resolve 语义(镜像 sms 不静默 fallback 拍板):settings 缺失 / 未启用 /
// production-like 下 DEV_STUB → 一律抛 WechatChannelUnavailableError
// (code2session 是登录链路依赖,静默 stub 会掩盖配置错误)。
//
// 第②重 production-like 禁 DEV_STUB(镜像 sms E-15;第①重在
// WechatSettingsService.updateSettings 写入口;双重保证假 openid 永不在生产生效)。
//
// 域错误 → BizCode 映射边界归本 Service(评审稿 §5):BizCode 25xxx 段随 T3 实装,
// T3 在 code2session 增加映射(25010 / 25030 / 25031);T2 期间仅域错误向上传播
// (本模块 T2 无业务调用方,settings 三端点不经过本 Service)。

@Injectable()
export class WechatService {
  constructor(
    private readonly settings: WechatSettingsService,
    private readonly devStub: DevStubWechatProvider,
    private readonly real: WechatMiniRealProvider,
    @Inject(appConfig.KEY)
    private readonly cfg: ConfigType<typeof appConfig>,
  ) {}

  /**
   * wx.login code → openid(评审稿 §4.1)。
   * session_key / unionid 在 Provider 层即弃(E-12);code 不入日志 / audit / 响应。
   */
  async code2session(code: string): Promise<Code2SessionResult> {
    const provider = await this.resolve();
    return provider.code2session({ code });
  }

  private async resolve(): Promise<WechatMiniProvider> {
    const r = await this.settings.getActiveSettings();
    if (!r) {
      throw new WechatChannelUnavailableError('wechat_settings 未配置');
    }
    if (!r.enabled) {
      throw new WechatChannelUnavailableError('wechat_settings.enabled=false');
    }
    if (r.providerType === 'DEV_STUB') {
      if (isProductionLike(this.cfg.env)) {
        throw new WechatChannelUnavailableError('production-like 环境禁用 DEV_STUB 通道');
      }
      return this.devStub;
    }
    if (r.providerType === 'WECHAT') {
      return this.real;
    }
    // 防御:enum 未来扩展;与 sms 同款不静默 fallback
    throw new WechatChannelUnavailableError(`未知 providerType=${String(r.providerType)}`);
  }
}
