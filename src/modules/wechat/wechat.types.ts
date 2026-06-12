import type { WechatProviderType } from '@prisma/client';

// 微信小程序登录 T2(2026-06-12):运行时类型(冻结评审稿
// docs/archive/reviews/wechat-mini-login-review.md E-3/E-11/E-12;镜像 sms.types)
//
// 这些类型仅在 Service / Provider / 测试中使用;
// **API DTO 出参永不包含 `credentials`**(appSecret 明文 / 密文永不外露,L3 红线)。

// 凭证状态三档(镜像 sms CredentialStatus 语义)
// - configured:credentialConfigured=true 且 appSecret 密文成功解密
// - missing:credentialConfigured=false 或密文列为 null
// - invalid:credentialConfigured=true 但解密失败(WECHAT_ENCRYPTION_KEY 轮换 / 密文被篡改)
export enum WechatCredentialStatus {
  CONFIGURED = 'configured',
  MISSING = 'missing',
  INVALID = 'invalid',
}

// 运行时合成的微信配置。
// `credentials` 明文仅在 Service / Provider 内部传递,**不进任何 API 出参 / 日志 / audit**。
export interface WechatSettingsResolved {
  id: string;
  providerType: WechatProviderType;
  enabled: boolean;
  appId: string | null;
  credentials: { appSecret: string } | null;
  credentialStatus: WechatCredentialStatus;
  remarks: string | null;
  updatedBy: string | null;
  updatedAt: Date;
  createdAt: Date;
}

// code2session 入参(wx.login 产出的一次性 code;不入日志 / audit / 响应)
export interface Code2SessionInput {
  code: string;
}

// code2session 出参(评审稿 E-12:session_key / unionid 解析即弃,**不进本类型**;
// openid 非 L3 但不滥回显——不入 pino 日志 / snapshot 示例,响应与 audit 一律掩码)
export interface Code2SessionResult {
  openid: string;
}

// 微信 Provider 统一接口(评审稿 §5 文件计划;镜像 SmsProvider 范式)
export interface WechatMiniProvider {
  code2session(input: Code2SessionInput): Promise<Code2SessionResult>;
}

// 通道不可用(settings 缺失 / 未启用 / 凭证未配置 / appId 缺失 / production-like 下 DEV_STUB)。
// WechatService 映射为 BizCode.WECHAT_CHANNEL_NOT_CONFIGURED(25030;T3 实装,T2 期间仅域错误)。
export class WechatChannelUnavailableError extends Error {
  constructor(reason: string) {
    super(`WECHAT_CHANNEL_UNAVAILABLE: ${reason}`);
    this.name = 'WechatChannelUnavailableError';
  }
}

// 微信明确判定 code 无效 / 已被使用(errcode 40029 / 40163;评审稿 E-11)。
// WechatService 映射为 BizCode.WECHAT_CODE_INVALID(25010)。
export class WechatCodeInvalidError extends Error {
  constructor(readonly errCode: string) {
    super(`WECHAT_CODE_INVALID: errcode=${errCode}`);
    this.name = 'WechatCodeInvalidError';
  }
}

// 上游调用失败(其余非 0 errcode / HTTP 非 200 / 超时 / 网络错误 / 响应缺 openid)。
// WechatService 映射为 BizCode.WECHAT_API_FAILED(25031)。
// errMsg 来自微信回执或归一化错误名,**不含** secret / 完整 URL(评审稿 E-12)。
export class WechatApiError extends Error {
  constructor(
    readonly errCode: string,
    readonly errMsg: string,
  ) {
    super(`WECHAT_API_FAILED: ${errCode} ${errMsg}`);
    this.name = 'WechatApiError';
  }
}
