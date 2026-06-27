import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import appConfig, { isProductionLike } from '../../config/app.config';
import { DevStubSmsProvider } from './providers/dev-stub.provider';
import { TencentSmsProvider } from './providers/tencent-sms.provider';
import { SmsSettingsService } from './sms-settings.service';
import {
  SmsChannelUnavailableError,
  type SendBirthdayGreetingInput,
  type SendNotificationInput,
  type SendVerifyCodeInput,
  type SendVerifyCodeResult,
  type SmsProvider,
} from './sms.types';

// SMS 基础设施 T2(2026-06-10):SMS Provider 动态路由(评审稿 E-16;镜像 storage-provider.router)
//
// 每次调用 resolve():依赖 SmsSettingsService 60s 缓存削减 DB 压力;
// 运维改 providerType → invalidate 后 / 60s 内即时切换,无需重启。
//
// 与 StorageProviderRouter 的**拍板差异**:settings 缺失 / 未启用时**不**静默 fallback
// (storage fallback Local 是 dev 文件存储,无外部副作用;SMS 发送有真实资费与用户触达,
// 静默 stub 会掩盖配置错误)→ 一律抛 SmsChannelUnavailableError,
// 调用方(SmsCodeService,T3)映射 SMS_CHANNEL_NOT_CONFIGURED(24030)。
//
// E-15 第②重:production-like 下 providerType=DEV_STUB 视作未配置(写入口第①重在
// SmsSettingsService.updateSettings;双重保证 DevStub 固定码永不在生产生效)。

@Injectable()
export class SmsProviderRouter implements SmsProvider {
  constructor(
    private readonly settings: SmsSettingsService,
    private readonly devStub: DevStubSmsProvider,
    private readonly tencent: TencentSmsProvider,
    @Inject(appConfig.KEY)
    private readonly cfg: ConfigType<typeof appConfig>,
  ) {}

  async resolve(): Promise<SmsProvider> {
    const r = await this.settings.getActiveSettings();
    if (!r) {
      throw new SmsChannelUnavailableError('sms_settings 未配置');
    }
    if (!r.enabled) {
      throw new SmsChannelUnavailableError('sms_settings.enabled=false');
    }
    if (r.providerType === 'DEV_STUB') {
      if (isProductionLike(this.cfg.env)) {
        throw new SmsChannelUnavailableError('production-like 环境禁用 DEV_STUB 通道');
      }
      return this.devStub;
    }
    if (r.providerType === 'TENCENT_SMS') {
      return this.tencent;
    }
    // 防御:enum 未来扩展;与 storage 不同,SMS 不静默 fallback
    throw new SmsChannelUnavailableError(`未知 providerType=${String(r.providerType)}`);
  }

  async sendVerifyCode(input: SendVerifyCodeInput): Promise<SendVerifyCodeResult> {
    return (await this.resolve()).sendVerifyCode(input);
  }

  // 生日祝福(B 队列 F5-T2;queue-b 评审稿 §6.5):同 resolve 语义(不静默 fallback)。
  async sendBirthdayGreeting(input: SendBirthdayGreetingInput): Promise<SendVerifyCodeResult> {
    return (await this.resolve()).sendBirthdayGreeting(input);
  }

  // 通知兜底(统一通知 S5;评审稿 §4):同 resolve 语义(不静默 fallback);
  // **additive 不改 verifyCode/birthday 既有发送行为**(行为锁)。
  async sendNotification(input: SendNotificationInput): Promise<SendVerifyCodeResult> {
    return (await this.resolve()).sendNotification(input);
  }

  /**
   * 当前生效通道类型(供 SmsCodeService 落 sms_send_logs.providerType 与
   * DevStub 固定码判定,T3);通道不可用时抛 SmsChannelUnavailableError。
   */
  async resolveProviderType(): Promise<'DEV_STUB' | 'TENCENT_SMS'> {
    await this.resolve();
    const r = await this.settings.getActiveSettings();
    // resolve() 已通过,r 必非 null
    return (r as NonNullable<typeof r>).providerType;
  }
}
