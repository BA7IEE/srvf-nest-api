import type { SmsProviderType } from '@prisma/client';

// SMS 基础设施 T2(2026-06-10):运行时类型(沿评审稿 §3.1 / E-13 / E-16;镜像 storage-settings.types)
//
// 这些类型仅在 Service / Provider / 测试中使用;
// **API DTO 出参永不包含 `credentials`**(明文凭证永不外露,L3 红线)。

// 凭证状态三档(镜像 storage CredentialStatus 语义,评审稿 E-13)
// - configured:credentialConfigured=true 且两段密文都成功解密
// - missing:credentialConfigured=false 或任一凭证列为 null
// - invalid:credentialConfigured=true 但解密失败(SMS_ENCRYPTION_KEY 轮换 / 密文被篡改)
export enum SmsCredentialStatus {
  CONFIGURED = 'configured',
  MISSING = 'missing',
  INVALID = 'invalid',
}

// 运行时合成的 SMS 配置。
// `credentials` 明文仅在 Service / Provider 内部传递,**不进任何 API 出参 / 日志 / audit**。
export interface SmsSettingsResolved {
  id: string;
  providerType: SmsProviderType;
  enabled: boolean;
  sdkAppId: string | null;
  signName: string | null;
  region: string | null;
  templateIdVerifyCode: string | null;
  credentials: { secretId: string; secretKey: string } | null;
  credentialStatus: SmsCredentialStatus;
  remarks: string | null;
  updatedBy: string | null;
  updatedAt: Date;
  createdAt: Date;
}

// Provider 发送入参(本期仅验证码模板一种;评审稿 E-22)
export interface SendVerifyCodeInput {
  phone: string; // 大陆 11 位(DTO 已校验);Tencent provider 内部转 +86 E.164
  code: string; // 明文码;仅在内存中传递,Provider 不得写入日志(DevStub debug 例外,E-29)
  ttlMinutes: number; // 模板参数 {2}:有效期分钟数
}

// Provider 发送结果(成功路径;失败一律抛 SmsProviderSendError / SmsChannelUnavailableError)
export interface SendVerifyCodeResult {
  providerMsgId: string | null; // provider 回执 ID(腾讯云 SerialNo;DevStub 为 null)
}

// SMS Provider 统一接口(评审稿 §5 文件计划;镜像 StorageProvider 范式)
export interface SmsProvider {
  sendVerifyCode(input: SendVerifyCodeInput): Promise<SendVerifyCodeResult>;
}

// 通道不可用(settings 缺失 / 未启用 / 凭证未配置 / production-like 下 DEV_STUB / 运行参数缺失)。
// 调用方(SmsCodeService,T3)映射为 BizCode.SMS_CHANNEL_NOT_CONFIGURED(24030)。
export class SmsChannelUnavailableError extends Error {
  constructor(reason: string) {
    super(`SMS_CHANNEL_UNAVAILABLE: ${reason}`);
    this.name = 'SmsChannelUnavailableError';
  }
}

// provider 调用失败(SDK 异常 / 回执非 Ok)。
// 调用方映射为 BizCode.SMS_SEND_FAILED(24031);errCode/errMsg 落 sms_send_logs(不含 secret)。
export class SmsProviderSendError extends Error {
  constructor(
    readonly errCode: string,
    readonly errMsg: string,
  ) {
    super(`SMS_PROVIDER_SEND_FAILED: ${errCode} ${errMsg}`);
    this.name = 'SmsProviderSendError';
  }
}
