import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import appConfig, { isProductionLike } from '../../config/app.config';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AttachmentContentValidator } from '../attachments/attachment-content-validator';
import { DevStubRealnameProvider } from './providers/dev-stub.provider';
import { TencentRealnameProvider } from './providers/tencent-realname.provider';
import { RealnameSettingsService } from './realname-settings.service';
import {
  RealnameApiError,
  RealnameChannelUnavailableError,
  type PreparedRealnameEffect,
  type RealnameOcrInput,
  type RealnameOcrResult,
  type RealnameSettingsResolved,
} from './realname.types';

interface RealnameProviderRoute {
  readonly providerType: 'DEV_STUB' | 'TENCENT_CLOUD';
  prepare(input: RealnameOcrInput): PreparedRealnameEffect;
}

// 招新实名环节 OCR 改造(2026-06-22):实名 OCR 识别编排(评审稿 §3.6/E-RO-1;
// 镜像 WechatService 的 resolve + 域错误→BizCode 映射边界,不设独立 router 文件——
// realname 仅 recognize 一个方法,router 职责内联本 Service)
//
// resolve 语义(镜像 wechat 不静默 fallback):settings 缺失 / 未启用 /
// production-like 下 DEV_STUB → 一律抛 RealnameChannelUnavailableError。
//
// 第②重 production-like 禁 DEV_STUB(镜像 wechat E-10;第①重在
// RealnameSettingsService.updateSettings 写入口;双重保证假识别结果永不在生产生效)。
//
// 域错误 → BizCode 映射边界归本 Service(评审稿 §3.3):
// RealnameChannelUnavailableError → 27030 / RealnameApiError → 27031。
// 调用方(recruitment 报名 service)只面对 BizException 与 RealnameOcrResult;
// **「不清晰 / 不匹配 / 防伪告警(recognized/warnings/字段)」是返回值不是异常**,由调用方驱动状态机
// (大陆匹配→verified / 其余→manual_review)。提交端对 27030/27031 亦不外抛、转 manual_review(分叉③)。

@Injectable()
export class RealnameVerificationService {
  constructor(
    private readonly settings: RealnameSettingsService,
    private readonly devStub: DevStubRealnameProvider,
    private readonly tencent: TencentRealnameProvider,
    private readonly contentValidator: AttachmentContentValidator,
    @Inject(appConfig.KEY)
    private readonly cfg: ConfigType<typeof appConfig>,
  ) {}

  /**
   * 证件照 OCR 识别(评审稿 §3.6/§4)。
   * 证件照字节 / 姓名 / 证件号不入日志 / audit 明文(调用方掩码);失败映射:
   * 通道未配置 → 27030;其余上游失败 → 27031。返回 OCR 结构化结果由调用方驱动状态机。
   */
  async recognize(input: RealnameOcrInput): Promise<RealnameOcrResult> {
    try {
      this.contentValidator.validateFromBuffer({ mime: input.mimeType, buffer: input.image });
      const route = await this.resolveRoute();
      return await route.prepare(input).invoke();
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

  /** 每次只读取一次 PostgreSQL settings，并返回绑定该 snapshot 的短生命周期 route。 */
  async resolveRoute(): Promise<RealnameProviderRoute> {
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
      return this.createDevStubRoute();
    }
    if (r.providerType === 'TENCENT_CLOUD') {
      return this.createTencentRoute(r);
    }
    // 防御:enum 未来扩展;与 wechat 同款不静默 fallback
    throw new RealnameChannelUnavailableError(`未知 providerType=${String(r.providerType)}`);
  }

  private createDevStubRoute(): RealnameProviderRoute {
    return {
      providerType: 'DEV_STUB',
      prepare: (input) => ({
        providerType: 'DEV_STUB',
        invoke: () => this.devStub.recognize(input),
      }),
    };
  }

  private createTencentRoute(settings: RealnameSettingsResolved): RealnameProviderRoute {
    return {
      providerType: 'TENCENT_CLOUD',
      prepare: (input) => this.tencent.prepare(settings, input),
    };
  }
}
