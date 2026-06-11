import { Injectable, Logger } from '@nestjs/common';
import { sms } from 'tencentcloud-sdk-nodejs-sms';

import { maskPhone } from '../sms.constants';
import { SmsSettingsService } from '../sms-settings.service';
import {
  SmsChannelUnavailableError,
  SmsCredentialStatus,
  SmsProviderSendError,
  type SendBirthdayGreetingInput,
  type SendVerifyCodeInput,
  type SendVerifyCodeResult,
  type SmsProvider,
  type SmsSettingsResolved,
} from '../sms.types';

// SMS 基础设施 T2(2026-06-10):腾讯云 SMS Provider(评审稿 §6;镜像 cos.provider 范式)
//
// - 凭证 + sdkAppId / signName / region / templateId 从 SmsSettingsService.getActiveSettings() 读
//   (60s 缓存削减 DB 压力;不依赖 env)
// - 每次调用 requireTencentContext() 做 4 档守护(镜像 CosProvider):
//   settings null·未启用 / providerType ≠ TENCENT_SMS / credentialStatus ≠ CONFIGURED /
//   sdkAppId·signName·region·templateIdVerifyCode 任一缺失
// - **不缓存 SDK client**(镜像 storage Q-89-2 拍板 A;每次调用新建,实例轻量;
//   凭证轮换 / settings 变更经 cache invalidate 即时生效)
// - SDK 仅本文件 import(评审稿 R-4 供应链边界;锁精确版本)
//
// 安全性:
// - 错误信息 / 日志永不含 SecretId / SecretKey 明文或密文;日志中手机号一律 maskPhone
// - 明文验证码仅作为 TemplateParamSet 传给 SDK,不写日志
//
// 模板参数约定(评审稿 E-22;运维侧 SOP 见 docs/ops/sms-production-rollout-checklist.md):
// 验证码模板必须恰好 2 个变量:{1}=验证码,{2}=有效期分钟数(TemplateParamSet=[code, ttlMinutes])。

const SmsClient = sms.v20210111.Client;

interface TencentSmsContext {
  client: InstanceType<typeof SmsClient>;
  sdkAppId: string;
  signName: string;
  templateId: string; // 按调用方选择的模板(verify-code / birthday;缺失在 4 档守护抛)
}

@Injectable()
export class TencentSmsProvider implements SmsProvider {
  private readonly logger = new Logger(TencentSmsProvider.name);

  constructor(private readonly settings: SmsSettingsService) {}

  async sendVerifyCode(input: SendVerifyCodeInput): Promise<SendVerifyCodeResult> {
    const ctx = await this.requireTencentContext('verify-code');
    // 验证码模板恰好 2 个变量:{1}=验证码,{2}=有效期分钟数(评审稿 E-22)
    return this.sendViaSdk(ctx, input.phone, [input.code, String(input.ttlMinutes)]);
  }

  // 生日祝福(B 队列 F5-T2,queue-b 评审稿 §6.5):零变量模板(TemplateParamSet=[]);
  // 模板 ID 取 sms_settings.templateIdBirthday(4 档守护按模板选择校验对应列)。
  async sendBirthdayGreeting(input: SendBirthdayGreetingInput): Promise<SendVerifyCodeResult> {
    const ctx = await this.requireTencentContext('birthday');
    return this.sendViaSdk(ctx, input.phone, []);
  }

  // SDK 单号单发共用段(verify-code / birthday 仅模板与参数不同;错误归一化语义不变)
  private async sendViaSdk(
    ctx: TencentSmsContext,
    phone: string,
    templateParams: string[],
  ): Promise<SendVerifyCodeResult> {
    let response;
    try {
      response = await ctx.client.SendSms({
        PhoneNumberSet: [toE164Mainland(phone)],
        SmsSdkAppId: ctx.sdkAppId,
        SignName: ctx.signName,
        TemplateId: ctx.templateId,
        TemplateParamSet: templateParams,
      });
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
      `TencentSms sent ok phone=${maskPhone(phone)} serialNo=${status.SerialNo ?? ''}`,
    );
    return { providerMsgId: status.SerialNo ?? null };
  }

  // 解析 settings + 构造 SDK client + 4 档守护(镜像 cos.provider.requireCosContext);
  // template 形参选择校验/返回哪个模板列(verify-code → templateIdVerifyCode;
  // birthday → templateIdBirthday;对应列缺失同走 SmsChannelUnavailableError 第 4 档)
  private async requireTencentContext(
    template: 'verify-code' | 'birthday',
  ): Promise<TencentSmsContext> {
    const settings = await this.settings.getActiveSettings();
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

    const templateId =
      template === 'verify-code' ? settings.templateIdVerifyCode : settings.templateIdBirthday;

    const client = new SmsClient({
      credential: {
        secretId: settings.credentials.secretId,
        secretKey: settings.credentials.secretKey,
      },
      region: settings.region as string,
    });
    return {
      client,
      sdkAppId: settings.sdkAppId as string,
      signName: settings.signName as string,
      templateId: templateId as string,
    };
  }
}

function missingRuntimeParams(
  s: SmsSettingsResolved,
  template: 'verify-code' | 'birthday',
): string[] {
  const missing: string[] = [];
  if (!s.sdkAppId) missing.push('sdkAppId');
  if (!s.signName) missing.push('signName');
  if (!s.region) missing.push('region');
  if (template === 'verify-code' && !s.templateIdVerifyCode) missing.push('templateIdVerifyCode');
  if (template === 'birthday' && !s.templateIdBirthday) missing.push('templateIdBirthday');
  return missing;
}

// 大陆 11 位 → E.164(+86 前缀;DTO 已锁 ^1[3-9]\d{9}$,评审稿 E-17)
function toE164Mainland(phone: string): string {
  return `+86${phone}`;
}
