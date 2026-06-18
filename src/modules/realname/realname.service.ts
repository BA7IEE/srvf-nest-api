import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import appConfig, { isProductionLike } from '../../config/app.config';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { DevStubRealnameProvider } from './providers/dev-stub.provider';
import { TencentRealnameProvider } from './providers/tencent-realname.provider';
import { RealnameSettingsService } from './realname-settings.service';
import {
  RealnameApiError,
  RealnameChannelUnavailableError,
  type RealnameProvider,
  type RealnameVerifyInput,
  type RealnameVerifyResult,
} from './realname.types';

// 招新一期 · 实名核验通道 T2(2026-06-18):实名核验编排(评审稿 §4/E-R-5;
// 镜像 WechatService 的 resolve + 域错误→BizCode 映射边界,不设独立 router 文件——
// realname 仅 verify 一个方法,router 职责内联本 Service)
//
// resolve 语义(镜像 wechat 不静默 fallback):settings 缺失 / 未启用 /
// production-like 下 DEV_STUB → 一律抛 RealnameChannelUnavailableError。
//
// 第②重 production-like 禁 DEV_STUB(镜像 wechat E-10;第①重在
// RealnameSettingsService.updateSettings 写入口;双重保证假核验结果永不在生产生效)。
//
// 域错误 → BizCode 映射边界归本 Service(评审稿 §3.3/§4):
// RealnameChannelUnavailableError → 27030 / RealnameApiError → 27031。
// 调用方(T3 recruitment 报名 service)只面对 BizException 与 RealnameVerifyResult;
// **「不匹配(matched=false)」是返回值不是异常**,由调用方驱动状态机(rejected)。

@Injectable()
export class RealnameVerificationService {
  constructor(
    private readonly settings: RealnameSettingsService,
    private readonly devStub: DevStubRealnameProvider,
    private readonly tencent: TencentRealnameProvider,
    @Inject(appConfig.KEY)
    private readonly cfg: ConfigType<typeof appConfig>,
  ) {}

  /**
   * 姓名 + 身份证号二要素核验(评审稿 §4 步骤 8)。
   * 姓名 / 身份证号不入日志 / audit 明文(调用方掩码);失败映射:
   * 通道未配置 → 27030;其余上游失败 → 27031。返回 {matched} 由调用方驱动状态机。
   */
  async verify(input: RealnameVerifyInput): Promise<RealnameVerifyResult> {
    try {
      const provider = await this.resolve();
      return await provider.verify(input);
    } catch (err) {
      if (err instanceof RealnameChannelUnavailableError) {
        throw new BizException(BizCode.REALNAME_CHANNEL_NOT_CONFIGURED);
      }
      if (err instanceof RealnameApiError) {
        throw new BizException(BizCode.REALNAME_API_FAILED);
      }
      throw err;
    }
  }

  private async resolve(): Promise<RealnameProvider> {
    const r = await this.settings.getActiveSettings();
    if (!r) {
      throw new RealnameChannelUnavailableError('realname_verification_settings 未配置');
    }
    if (!r.enabled) {
      throw new RealnameChannelUnavailableError('realname_verification_settings.enabled=false');
    }
    if (r.providerType === 'DEV_STUB') {
      if (isProductionLike(this.cfg.env)) {
        throw new RealnameChannelUnavailableError('production-like 环境禁用 DEV_STUB 通道');
      }
      return this.devStub;
    }
    if (r.providerType === 'TENCENT_CLOUD') {
      return this.tencent;
    }
    // 防御:enum 未来扩展;与 wechat 同款不静默 fallback
    throw new RealnameChannelUnavailableError(`未知 providerType=${String(r.providerType)}`);
  }
}
