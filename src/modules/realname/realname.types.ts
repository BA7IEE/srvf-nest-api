import type { RealnameProviderType } from '@prisma/client';

// 招新一期 · 实名核验通道 T2(2026-06-18):运行时类型(冻结评审稿
// docs/archive/reviews/recruitment-phase1-review.md §3.1/§4/E-R-2/E-R-5;镜像 wechat.types / sms.types)
//
// 这些类型仅在 Service / Provider / 测试中使用;
// **API DTO 出参永不包含 `credentials`**(secretId / secretKey 明文 / 密文永不外露,L3 红线)。

// 凭证状态三档(镜像 wechat/sms CredentialStatus 语义;两段凭证)
// - configured:credentialConfigured=true 且 secretId + secretKey 两段密文均成功解密
// - missing:credentialConfigured=false 或任一密文列为 null
// - invalid:credentialConfigured=true 但解密失败(REALNAME_ENCRYPTION_KEY 轮换 / 密文被篡改)
export enum RealnameCredentialStatus {
  CONFIGURED = 'configured',
  MISSING = 'missing',
  INVALID = 'invalid',
}

// 运行时合成的实名核验配置。
// `credentials` 明文仅在 Service / Provider 内部传递,**不进任何 API 出参 / 日志 / audit**。
// 差异:凭证两段 secretId + secretKey(镜像 SmsSettings,≠ wechat 单段 appSecret);region 替 appId。
export interface RealnameSettingsResolved {
  id: string;
  providerType: RealnameProviderType;
  enabled: boolean;
  region: string | null;
  credentials: { secretId: string; secretKey: string } | null;
  credentialStatus: RealnameCredentialStatus;
  remarks: string | null;
  updatedBy: string | null;
  updatedAt: Date;
  createdAt: Date;
}

// 实名核验入参(姓名 + 身份证号二要素;**不入日志 / audit / 响应明文**,调用方掩码)
export interface RealnameVerifyInput {
  name: string;
  idCardNumber: string;
}

// 实名核验出参(二要素核验结果):
// - matched:姓名与身份证号一致(腾讯云 Result='0')→ 报名状态机走 verified
// - 不一致:matched=false(腾讯云 Result≠'0')→ 报名状态机走 rejected
//   **「不一致」是核验结果、不是异常**——故无 CodeInvalid 域错误(差异于 wechat E-11)。
export interface RealnameVerifyResult {
  matched: boolean;
  // 不一致时的归一化原因(腾讯云 Description;不含 PII,仅供审计 extra,掩码后)
  reason?: string;
}

// 实名核验 Provider 统一接口(评审稿 §5 文件计划;镜像 WechatMiniProvider / SmsProvider 范式)
export interface RealnameProvider {
  verify(input: RealnameVerifyInput): Promise<RealnameVerifyResult>;
}

// 通道不可用(settings 缺失 / 未启用 / 凭证未配置 / region 缺失 / production-like 下 DEV_STUB)。
// RealnameVerificationService 映射为 BizCode.REALNAME_CHANNEL_NOT_CONFIGURED(27030)。
export class RealnameChannelUnavailableError extends Error {
  constructor(reason: string) {
    super(`REALNAME_CHANNEL_UNAVAILABLE: ${reason}`);
    this.name = 'RealnameChannelUnavailableError';
  }
}

// 上游调用失败(腾讯云 Error 回执 / HTTP 非 200 / 超时 / 网络错误 / 响应缺 Result)。
// RealnameVerificationService 映射为 BizCode.REALNAME_API_FAILED(27031)。
// errMsg 来自腾讯云回执或归一化错误名,**不含** secret / 完整签名 / PII(评审稿 §6)。
export class RealnameApiError extends Error {
  constructor(
    readonly errCode: string,
    readonly errMsg: string,
  ) {
    super(`REALNAME_API_FAILED: ${errCode} ${errMsg}`);
    this.name = 'RealnameApiError';
  }
}
