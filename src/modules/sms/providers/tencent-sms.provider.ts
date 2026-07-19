import { Injectable, Logger } from '@nestjs/common';
import { sms } from 'tencentcloud-sdk-nodejs-sms';

import { maskPhone } from '../sms.constants';
import { SmsSettingsService } from '../sms-settings.service';
import {
  SmsChannelUnavailableError,
  SmsCredentialStatus,
  SmsProviderSendError,
  type PreparedSmsEffect,
  type SendBirthdayGreetingInput,
  type SendNotificationInput,
  type SendVerifyCodeInput,
  type SendVerifyCodeResult,
  type SmsProvider,
  type SmsSettingsResolved,
} from '../sms.types';

// SMS 基础设施 T2(2026-06-10):腾讯云 SMS Provider(评审稿 §6;镜像 cos.provider 范式)
//
// - 既有直接 send* 各自从 SmsSettingsService.getActiveSettings() 读取一次；prepared API
//   接受调用方 supplied snapshot，prepare / invoke 均不再读 settings
// - 每次调用 requireTencentContext() 做 4 档守护(镜像 CosProvider):
//   settings null·未启用 / providerType ≠ TENCENT_SMS / credentialStatus ≠ CONFIGURED /
//   sdkAppId·signName·region·templateIdVerifyCode 任一缺失
// - **不缓存 SDK client**(镜像 storage Q-89-2 拍板 A;每次 prepare / 直接 send 新建,实例轻量);
//   配置变更只影响下一次 resolveRoute / 直接 send，已取得 route 继续使用其原 snapshot
// - SDK 仅本文件 import(评审稿 R-4 供应链边界;锁精确版本)
//
// 安全性:
// - 错误信息 / 日志永不含 SecretId / SecretKey 明文或密文;日志中手机号一律 maskPhone
// - 明文验证码仅作为 TemplateParamSet 传给 SDK,不写日志
//
// 模板参数约定(评审稿 E-22;运维侧 SOP 见 docs/ops/sms-production-rollout-checklist.md):
// 验证码模板必须恰好 2 个变量:{1}=验证码,{2}=有效期分钟数(TemplateParamSet=[code, ttlMinutes])。

const SmsClient = sms.v20210111.Client;

// 外部 SDK 请求超时上限(2026-06-12 goal G3):SDK 默认 reqTimeout 60s(单位:秒),
// 网络黑洞会拖死上游调用方(验证码发送在绑定手机 / 找回密码 / OTP 登录链路上)。
// 超时由 SDK 抛异常,经 sendViaSdk 的 catch 归一为 SmsProviderSendError,错误语义不变。
// 当前真实通道未开通(运维送审中),本配置"正确但休眠":unit spec 锁构造参数就位,
// 真连后的端到端超时行为留运维接力时验证。
const SMS_SDK_REQ_TIMEOUT_SECONDS = 8;

interface TencentSmsContext {
  client: InstanceType<typeof SmsClient>;
  phone: string;
  request: Parameters<InstanceType<typeof SmsClient>['SendSms']>[0];
}

@Injectable()
export class TencentSmsProvider implements SmsProvider {
  private readonly logger = new Logger(TencentSmsProvider.name);

  constructor(private readonly settings: SmsSettingsService) {}

  async sendVerifyCode(input: SendVerifyCodeInput): Promise<SendVerifyCodeResult> {
    const settings = await this.settings.getActiveSettings();
    return this.prepareVerifyCode(settings, input).invoke();
  }

  // 生日祝福(B 队列 F5-T2,queue-b 评审稿 §6.5):零变量模板(TemplateParamSet=[]);
  // 模板 ID 取 sms_settings.templateIdBirthday(4 档守护按模板选择校验对应列)。
  async sendBirthdayGreeting(input: SendBirthdayGreetingInput): Promise<SendVerifyCodeResult> {
    const settings = await this.settings.getActiveSettings();
    return this.prepareBirthdayGreeting(settings, input).invoke();
  }

  // 通知兜底(统一通知 S5,评审稿 §4):紧急召集零变量模板(TemplateParamSet=[]);
  // 模板 ID 取 sms_settings.templateIdNotification(4 档守护按模板选择校验对应列)。
  async sendNotification(input: SendNotificationInput): Promise<SendVerifyCodeResult> {
    const settings = await this.settings.getActiveSettings();
    return this.prepareNotification(settings, input).invoke();
  }

  // supplied settings snapshot 的同步 prepare：不再读取 SmsSettingsService。
  prepareVerifyCode(
    settings: SmsSettingsResolved | null,
    input: SendVerifyCodeInput,
  ): PreparedSmsEffect {
    return this.prepareEffect(settings, 'verify-code', input.phone, [
      input.code,
      String(input.ttlMinutes),
    ]);
  }

  prepareBirthdayGreeting(
    settings: SmsSettingsResolved | null,
    input: SendBirthdayGreetingInput,
  ): PreparedSmsEffect {
    return this.prepareEffect(settings, 'birthday', input.phone, []);
  }

  prepareNotification(
    settings: SmsSettingsResolved | null,
    input: SendNotificationInput,
  ): PreparedSmsEffect {
    return this.prepareEffect(settings, 'notification', input.phone, []);
  }

  private prepareEffect(
    settings: SmsSettingsResolved | null,
    template: 'verify-code' | 'birthday' | 'notification',
    phone: string,
    templateParams: string[],
  ): PreparedSmsEffect {
    const ctx = this.requireTencentContext(settings, template, phone, templateParams);
    return {
      providerType: 'TENCENT_SMS',
      // 非 async 薄入口：sendViaSdk 在返回 Promise 前同步调用 ctx.client.SendSms。
      invoke: () => this.sendViaSdk(ctx),
    };
  }

  // SDK 单号单发共用段；进入方法后、首个 await 前即调用 SendSms。
  private async sendViaSdk(ctx: TencentSmsContext): Promise<SendVerifyCodeResult> {
    let response;
    try {
      response = await ctx.client.SendSms(ctx.request);
    } catch (err) {
      // SDK 网络 / 鉴权异常(TencentCloudSDKException 含 code 字段);不含 secret
      const e = err as { code?: string; message?: string };
      throw new SmsProviderSendError(e.code ?? 'SDK_ERROR', e.message ?? 'unknown SDK error');
    }

    const status = response.SendStatusSet?.[0];
    if (!status) {
      throw new SmsProviderSendError('EMPTY_SEND_STATUS', 'SendStatusSet 为空');
    }
    if (status.Code !== 'Ok') {
      // 单号单发:取第一条回执;Code 形如 LimitExceeded.PhoneNumberDailyLimit 等
      throw new SmsProviderSendError(status.Code ?? 'UNKNOWN', status.Message ?? 'unknown');
    }

    this.logger.log(
      `TencentSms sent ok phone=${maskPhone(ctx.phone)} serialNo=${status.SerialNo ?? ''}`,
    );
    return { providerMsgId: status.SerialNo ?? null };
  }

  // 使用调用方 supplied snapshot，完成 4 档守护并同步构造 SDK client + request params；
  // 本方法不读取 SmsSettingsService。
  // template 形参选择校验/返回哪个模板列(verify-code → templateIdVerifyCode;
  // birthday → templateIdBirthday;notification → templateIdNotification〔统一通知 S5〕;
  // 对应列缺失同走 SmsChannelUnavailableError 第 4 档)
  private requireTencentContext(
    settings: SmsSettingsResolved | null,
    template: 'verify-code' | 'birthday' | 'notification',
    phone: string,
    templateParams: string[],
  ): TencentSmsContext {
    if (!settings || !settings.enabled) {
      throw new SmsChannelUnavailableError('sms_settings 未配置或未启用');
    }
    if (settings.providerType !== 'TENCENT_SMS') {
      throw new SmsChannelUnavailableError(
        `providerType=${settings.providerType} 不是 TENCENT_SMS`,
      );
    }
    if (settings.credentialStatus !== SmsCredentialStatus.CONFIGURED || !settings.credentials) {
      throw new SmsChannelUnavailableError(`credentialStatus=${settings.credentialStatus}`);
    }
    const missing = missingRuntimeParams(settings, template);
    if (missing.length > 0) {
      throw new SmsChannelUnavailableError(`sms_settings.${missing.join(' / ')} 未配置`);
    }

    const templateId = selectTemplateId(settings, template);

    const client = new SmsClient({
      credential: {
        secretId: settings.credentials.secretId,
        secretKey: settings.credentials.secretKey,
      },
      region: settings.region as string,
      profile: { httpProfile: { reqTimeout: SMS_SDK_REQ_TIMEOUT_SECONDS } },
    });
    return {
      client,
      phone,
      request: {
        PhoneNumberSet: [toE164Mainland(phone)],
        SmsSdkAppId: settings.sdkAppId as string,
        SignName: settings.signName as string,
        TemplateId: templateId as string,
        TemplateParamSet: templateParams,
      },
    };
  }
}

function missingRuntimeParams(
  s: SmsSettingsResolved,
  template: 'verify-code' | 'birthday' | 'notification',
): string[] {
  const missing: string[] = [];
  if (!s.sdkAppId) missing.push('sdkAppId');
  if (!s.signName) missing.push('signName');
  if (!s.region) missing.push('region');
  if (template === 'verify-code' && !s.templateIdVerifyCode) missing.push('templateIdVerifyCode');
  if (template === 'birthday' && !s.templateIdBirthday) missing.push('templateIdBirthday');
  if (template === 'notification' && !s.templateIdNotification) {
    missing.push('templateIdNotification');
  }
  return missing;
}

// 模板列选择(verify-code / birthday / notification → 对应 sms_settings 模板 ID 列;统一通知 S5)。
function selectTemplateId(
  s: SmsSettingsResolved,
  template: 'verify-code' | 'birthday' | 'notification',
): string | null {
  if (template === 'verify-code') return s.templateIdVerifyCode;
  if (template === 'birthday') return s.templateIdBirthday;
  return s.templateIdNotification;
}

// 大陆 11 位 → E.164(+86 前缀;DTO 已锁 ^1[3-9]\d{9}$,评审稿 E-17)
function toE164Mainland(phone: string): string {
  return `+86${phone}`;
}
