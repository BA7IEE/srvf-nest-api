// 由 scripts/generate-fe-client.ts 生成,请勿手改。
// 真相源:后端 live /api/docs-json;本文件派生自 docs/handoff/openapi.json 快照。
// surface: Open 无账号公开面
// contractVersion: 0.69.0
// generatorVersion: 1.0.0
// inputDigest: sha256:cc5e22b0837c46cdf372d50174acccc2f6d5e4e8d8cb9dc4fca0570d557ffb67

// 共用类型不在本文件重复定义 —— 从 shared 引入并再导出,保证仓内每个类型只有一份定义。
import type { ApiEnvelope, PageResult, FetchRequest, Fetcher, ContentAttachmentDto, ContentReadDetailDto, ContentReadListItemDto, PageResultDto } from '../shared/types';
export type { ApiEnvelope, PageResult, FetchRequest, Fetcher, ContentAttachmentDto, ContentReadDetailDto, ContentReadListItemDto, PageResultDto };

export interface PublicCertificateClaimDto {
  "id": string;
  "version": number;
  "status": "SUBMITTED" | "NEEDS_INFO" | "APPROVED" | "REJECTED" | "PROMOTED" | "WITHDRAWN";
  "categoryHintCode": string;
  "rawCertificateName"?: string | null;
  "suggestedStandardId"?: string | null;
  "issuingOrg"?: string | null;
  "certNumberMasked"?: string | null;
  "issuedAt"?: Record<string, unknown> | null;
  "expiredAt"?: Record<string, unknown> | null;
  "imageCount": number;
  "reviewNote"?: string | null;
  "createdAt": string;
  "updatedAt": string;
}

export interface PublicCertificateClaimResultDto {
  "claim": PublicCertificateClaimDto;
  "claimCount": number;
}

export interface PublicCertificateStandardOptionDto {
  "id": string;
  "code": string;
  "name": string;
  "categoryCode": string;
  "levelCode"?: string | null;
  "currentlyRecognized": boolean;
}

export interface PublicCertificateStandardOptionsResponseDto {
  "items": PublicCertificateStandardOptionDto[];
}

export interface PublicRecruitmentPublicityItemDto {
  "realName"?: Record<string, unknown> | null;
  "proposedMemberNo"?: Record<string, unknown> | null;
}

export interface PublicRecruitmentPublicityResponseDto {
  "cycleYear"?: Record<string, unknown> | null;
  "items": PublicRecruitmentPublicityItemDto[];
}

export interface RecruitmentApplicationProgressDto {
  "stage": string;
  "stageText": string;
  "statusText": string;
  "nextAction"?: Record<string, unknown> | null;
  "tempNo"?: Record<string, unknown> | null;
  "memberNo"?: Record<string, unknown> | null;
  "identityText": string;
  "todoList": RecruitmentTodoItemDto[];
  "certificates": RecruitmentCertificateProgressItemDto[];
  "meetingInfo"?: Record<string, unknown> | null;
  "qqGroup"?: Record<string, unknown> | null;
  "notice"?: Record<string, unknown> | null;
}

export interface RecruitmentCertificateProgressItemDto {
  "claimId": string;
  "version": number;
  "category": "first_aid" | "bsafe";
  "rawCertificateName"?: string | null;
  "status": "SUBMITTED" | "NEEDS_INFO" | "APPROVED" | "REJECTED" | "PROMOTED" | "WITHDRAWN";
  "imageCount": number;
  "note"?: string | null;
}

export interface RecruitmentOcrCardWarningsDto {
  "copy": boolean;
  "reshoot": boolean;
  "ps": boolean;
  "border": boolean;
  "occlusion": boolean;
  "blur": boolean;
}

export interface RecruitmentOcrDetailDto {
  "sex"?: RecruitmentOcrFieldDto;
  "nation"?: RecruitmentOcrFieldDto;
  "birth"?: RecruitmentOcrFieldDto;
  "address"?: RecruitmentOcrFieldDto;
  "authority"?: RecruitmentOcrFieldDto;
  "validDate"?: RecruitmentOcrFieldDto;
  "documentType"?: Record<string, unknown> | null;
  "cardWarnings"?: RecruitmentOcrCardWarningsDto;
}

export interface RecruitmentOcrFieldDto {
  "content"?: Record<string, unknown> | null;
  "reflect": boolean;
  "incomplete": boolean;
}

export interface RecruitmentOcrRecognizeResponseDto {
  "ocrSupported": boolean;
  "clarityOk": boolean;
  "recognized"?: Record<string, unknown> | null;
  "antiForgeryWarnings": string[];
  "documentCategory"?: Record<string, unknown> | null;
  "hint"?: Record<string, unknown> | null;
  "ocrDetail"?: RecruitmentOcrDetailDto;
}

export interface RecruitmentQueryByPhoneDto {
  "phone": string;
  "code": string;
}

export interface RecruitmentQueryDto {
  "wechatCode": string;
}

export interface RecruitmentRebindPhoneDto {
  "phone": string;
  "code": string;
  "newPhone": string;
  "newPhoneCode": string;
  "reason"?: string;
}

export interface RecruitmentRebindWechatDto {
  "phone": string;
  "code": string;
  "newWechatCode": string;
}

export interface RecruitmentSendCodeDto {
  "phone": string;
}

export interface RecruitmentSendCodeResponseDto {
  "expiresInSeconds": number;
}

export interface RecruitmentSubmitResultDto {
  "outcome": string;
  "statusCode"?: Record<string, unknown> | null;
  "tempNo"?: Record<string, unknown> | null;
  "stage"?: Record<string, unknown> | null;
  "stageText"?: Record<string, unknown> | null;
  "nextAction"?: Record<string, unknown> | null;
  "hint"?: Record<string, unknown> | null;
  "recognized"?: Record<string, unknown> | null;
  "cycleName": string;
  "meetingInfo"?: Record<string, unknown> | null;
  "qqGroup"?: Record<string, unknown> | null;
  "notifyTemplate"?: Record<string, unknown> | null;
}

export interface RecruitmentTodoItemDto {
  "code": string;
  "name": string;
  "done": boolean;
}

export interface RecruitmentVerifyCodeDto {
  "phone": string;
  "code": string;
}

export interface RecruitmentVerifyCodeResponseDto {
  "phoneVerificationToken": string;
  "expiresAt": string;
}

export interface RecruitmentWithdrawDto {
  "wechatCode"?: string;
  "phone"?: string;
  "code"?: string;
}

export interface WithdrawCertificateClaimDto {
  "wechatCode"?: string;
  "phone"?: string;
  "code"?: string;
  "version": number;
}
