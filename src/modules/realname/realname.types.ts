import type { RealnameProviderType } from '@prisma/client';

// 招新实名环节 OCR 改造(2026-06-22):运行时类型(冻结评审稿
// docs/archive/reviews/recruitment-realname-ocr-review.md §3.6/E-RO-1;镜像 wechat/sms 通道层范式)
//
// **语义换血**:实名环节从「腾讯云 faceid 二要素*真实性核验*(查公安库)」改为「腾讯云 **OCR
// 证件识别 + 自洽匹配**」——明确放弃联网真实性核验(D-RO-1)。Provider 不再 verify(name,idCard),
// 改为 recognize(证件照 → 结构化字段 + 防伪 + 清晰度);是否「匹配/放行」由调用方(recruitment
// 报名 service)拿 OCR 结果与申请人确认值比对后决定(§3.6 判定矩阵)。
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
// 差异:凭证两段 secretId + secretKey(镜像 SmsSettings);region 是腾讯云运行参数(非 secret)。
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

// OCR 识别入参(证件照 + 类型;**图片字节与 PII 不入日志 / audit / 响应明文**,调用方掩码)
export interface RealnameOcrInput {
  documentTypeCode: string; // mainland_id / passport / hk_macau_permit(provider 内部映射 action)
  image: Buffer; // 证件照原始字节(provider base64 后入 ImageBase64;不入日志)
  mimeType: string; // image/jpeg | image/png(仅诊断;不影响 base64)
}

// OCR 识别出参(结构化字段 + 防伪 + 清晰度):
// - 「识别成功 + 匹配 + 无防伪告警 + 清晰」是否放行,由调用方据 §3.6 矩阵裁断;
// - 「不清晰 / 不匹配 / 防伪告警」**不是异常**——是 OCR 结果,驱动 manual_review(差异于上游失败)。
export interface RealnameOcrResult {
  // OCR 是否成功读出(清晰度;false = 证件照不清晰 / 读不出关键字段,非上游失败)
  recognized: boolean;
  // OCR 识别出的姓名 / 证件号(供调用方与申请人确认值比对;不入日志明文)
  name: string | null;
  idCardNumber: string | null;
  // 图像防伪 / 质量告警归一码(空数组 = 无告警;仅 mainland RecognizeValidIDCardOCR 有意义)
  warnings: string[];
  // 证件类别(仅 hk_macau MainlandPermitOCR:须 ∈「来往内地」,否则 category_mismatch)
  documentCategory?: string | null;
  // 归一化原因(不含 PII;供审计 extra / 诊断)
  reason?: string;
}

// 实名 OCR 识别 Provider 统一接口(§5 文件计划;镜像 WechatMiniProvider / SmsProvider 范式)
export interface RealnameProvider {
  recognize(input: RealnameOcrInput): Promise<RealnameOcrResult>;
}

// 通道不可用(settings 缺失 / 未启用 / 凭证未配置 / region 缺失 / production-like 下 DEV_STUB)。
// RealnameVerificationService 映射为 BizCode.REALNAME_CHANNEL_NOT_CONFIGURED(27030)。
export class RealnameChannelUnavailableError extends Error {
  constructor(reason: string) {
    super(`REALNAME_CHANNEL_UNAVAILABLE: ${reason}`);
    this.name = 'RealnameChannelUnavailableError';
  }
}

// 上游调用失败(腾讯云 Error 回执 / HTTP 非 200 / 超时 / 网络错误 / 响应缺关键字段)。
// RealnameVerificationService 映射为 BizCode.REALNAME_API_FAILED(27031)。
// **区别于 recognized=false**:后者是「OCR 成功但证件照不清晰」的正常结果(驱动 manual_review);
// 本错误是「调用根本没成功」。errMsg 来自腾讯云回执或归一化错误名,**不含** secret / 完整签名 / PII。
export class RealnameApiError extends Error {
  constructor(
    readonly errCode: string,
    readonly errMsg: string,
  ) {
    super(`REALNAME_API_FAILED: ${errCode} ${errMsg}`);
    this.name = 'RealnameApiError';
  }
}
