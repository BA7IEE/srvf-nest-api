import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import appConfig, { isProductionLike } from '../../config/app.config';
import { DevStubSmsProvider } from './providers/dev-stub.provider';
import { TencentSmsProvider } from './providers/tencent-sms.provider';
import { SmsSettingsService } from './sms-settings.service';
import {
  SmsChannelUnavailableError,
  type PreparedSmsEffect,
  type SendBirthdayGreetingInput,
  type SendNotificationInput,
  type SendVerifyCodeInput,
  type SendVerifyCodeResult,
  type SmsProvider,
  type SmsSettingsResolved,
} from './sms.types';

// SMS 基础设施 T2(2026-06-10):SMS Provider 动态路由(评审稿 E-16;镜像 storage-provider.router)
//
// 每次 resolveRoute() 只通过 SmsSettingsService live-read 一次 PostgreSQL 当前事实，
// 并把同一 settings snapshot 绑定到短生命周期 route。已提交的配置变化影响任一实例的
// 下一次 resolveRoute；已取得 route 的在途操作继续使用原 snapshot。
//
// 与 StorageProviderRouter 的**拍板差异**:settings 缺失 / 未启用时**不**静默 fallback
// (storage fallback Local 是 dev 文件存储,无外部副作用;SMS 发送有真实资费与用户触达,
// 静默 stub 会掩盖配置错误)→ 一律抛 SmsChannelUnavailableError,
// 调用方(SmsCodeService,T3)映射 SMS_CHANNEL_NOT_CONFIGURED(24030)。
//
// E-15 第②重:production-like 下 providerType=DEV_STUB 视作未配置(写入口第①重在
// SmsSettingsService.updateSettings;双重保证 DevStub 固定码永不在生产生效)。

export interface SmsProviderRoute {
  readonly providerType: 'DEV_STUB' | 'TENCENT_SMS';
  prepareVerifyCode(input: SendVerifyCodeInput): PreparedSmsEffect;
  prepareBirthdayGreeting(input: SendBirthdayGreetingInput): PreparedSmsEffect;
  prepareNotification(input: SendNotificationInput): PreparedSmsEffect;
}

@Injectable()
export class SmsProviderRouter implements SmsProvider {
  constructor(
    private readonly settings: SmsSettingsService,
    private readonly devStub: DevStubSmsProvider,
    private readonly tencent: TencentSmsProvider,
    @Inject(appConfig.KEY)
    private readonly cfg: ConfigType<typeof appConfig>,
  ) {}

  async resolveRoute(): Promise<SmsProviderRoute> {
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
      return this.createDevStubRoute();
    }
    if (r.providerType === 'TENCENT_SMS') {
      return this.createTencentRoute(r);
    }
    // 防御:enum 未来扩展;与 storage 不同,SMS 不静默 fallback
    throw new SmsChannelUnavailableError(`未知 providerType=${String(r.providerType)}`);
  }

  /**
   * E-16 兼容入口：只捕获一次 route，并返回绑定该 snapshot 的 SmsProvider 适配器。
   * 禁止返回裸 provider 或在任一 send 内再次解析 settings。
   */
  async resolve(): Promise<SmsProvider> {
    const route = await this.resolveRoute();
    // async boundary 必须无前置 await：同步启动 prepare/invoke，
    // 同时把同步异常保持为 Promise rejection，且不引入 Promise.then microtask。
    const adapter: SmsProvider = {
      sendVerifyCode: async (input) => route.prepareVerifyCode(input).invoke(),
      sendBirthdayGreeting: async (input) => route.prepareBirthdayGreeting(input).invoke(),
      sendNotification: async (input) => route.prepareNotification(input).invoke(),
    };
    return adapter;
  }

  async sendVerifyCode(input: SendVerifyCodeInput): Promise<SendVerifyCodeResult> {
    const route = await this.resolveRoute();
    return route.prepareVerifyCode(input).invoke();
  }

  // prepared API 供后续 Outbox payload/control 分离；本 PR 不接 notifications runtime。
  async prepareBirthdayGreeting(input: SendBirthdayGreetingInput): Promise<PreparedSmsEffect> {
    const route = await this.resolveRoute();
    return route.prepareBirthdayGreeting(input);
  }

  async prepareNotification(input: SendNotificationInput): Promise<PreparedSmsEffect> {
    const route = await this.resolveRoute();
    return route.prepareNotification(input);
  }

  // 生日祝福(B 队列 F5-T2;queue-b 评审稿 §6.5):既有签名与行为不变。
  async sendBirthdayGreeting(input: SendBirthdayGreetingInput): Promise<SendVerifyCodeResult> {
    return (await this.prepareBirthdayGreeting(input)).invoke();
  }

  // 通知兜底(统一通知 S5;评审稿 §4):同 resolve 语义(不静默 fallback);
  // **additive 不改 verifyCode/birthday 既有发送行为**(行为锁)。
  async sendNotification(input: SendNotificationInput): Promise<SendVerifyCodeResult> {
    return (await this.prepareNotification(input)).invoke();
  }

  /**
   * 当前生效通道类型；只读一次 route。仅供需要单次观测的兼容调用方。
   * 证据链不得把本方法与一次独立 send* 拼接，否则会产生两个 settings snapshot；
   * 需要 type + send 原子一致时必须持有 resolveRoute() 的返回值。
   */
  async resolveProviderType(): Promise<'DEV_STUB' | 'TENCENT_SMS'> {
    return (await this.resolveRoute()).providerType;
  }

  private createDevStubRoute(): SmsProviderRoute {
    return {
      providerType: 'DEV_STUB',
      prepareVerifyCode: (input) => ({
        providerType: 'DEV_STUB',
        invoke: () => this.devStub.sendVerifyCode(input),
      }),
      prepareBirthdayGreeting: (input) => ({
        providerType: 'DEV_STUB',
        invoke: () => this.devStub.sendBirthdayGreeting(input),
      }),
      prepareNotification: (input) => ({
        providerType: 'DEV_STUB',
        invoke: () => this.devStub.sendNotification(input),
      }),
    };
  }

  private createTencentRoute(settings: SmsSettingsResolved): SmsProviderRoute {
    return {
      providerType: 'TENCENT_SMS',
      prepareVerifyCode: (input) => this.tencent.prepareVerifyCode(settings, input),
      prepareBirthdayGreeting: (input) => this.tencent.prepareBirthdayGreeting(settings, input),
      prepareNotification: (input) => this.tencent.prepareNotification(settings, input),
    };
  }
}
