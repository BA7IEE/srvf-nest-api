// 由 scripts/generate-fe-client.ts 生成,请勿手改。
// 真相源:后端 live /api/docs-json;本文件派生自 docs/handoff/openapi.json 快照。
// surface: Auth 登录/令牌(admin 与 app 共用)
// contractVersion: 0.69.0
// generatorVersion: 1.0.0
// inputDigest: sha256:0cfebda9c65800bf6276f9d92b4027eac43d50f2610193508898b03a0c1b5106

// 共用类型不在本文件重复定义 —— 从 shared 引入并再导出,保证仓内每个类型只有一份定义。
import type { ApiEnvelope, PageResult, FetchRequest, Fetcher } from '../shared/types';
export type { ApiEnvelope, PageResult, FetchRequest, Fetcher };

export interface LoginDto {
  "username": string;
  "password": string;
}

export interface LoginResponseDto {
  "accessToken": string;
  "tokenType": string;
  "expiresIn": string;
  "refreshToken": string;
  "refreshExpiresAt": string;
}

export interface LoginSmsDto {
  "phone": string;
  "code": string;
}

export interface LoginWechatDto {
  "code": string;
}

export interface LoginWecomDto {
  "code": string;
  "state": string;
}

export interface LogoutAllResponseDto {
  "revokedCount": number;
}

export interface LogoutDto {
  "refreshToken": string;
}

export type Object = Record<string, unknown>;

export interface RefreshTokenDto {
  "refreshToken": string;
}

export interface ResetPasswordBySmsDto {
  "phone": string;
  "code": string;
  "newPassword": string;
}

export interface SendLoginSmsCodeDto {
  "phone": string;
}

export interface SendPasswordResetCodeDto {
  "phone": string;
}

export interface SendPasswordResetCodeResponseDto {
  "expiresInSeconds": number;
}

export interface SendStepUpSmsCodeDto {
  "action": "PHONE_BIND" | "WECHAT_BIND" | "WECOM_BIND" | "RBAC_ROLE_PERMISSION_SET_REPLACE";
}

export interface SendWechatBindCodeDto {
  "phone": string;
}

export interface SendWecomBindCodeDto {
  "bindingTicket": string;
  "phone": string;
}

export interface StepUpPasswordDto {
  "action": "PHONE_BIND" | "WECHAT_BIND" | "WECOM_BIND" | "RBAC_ROLE_PERMISSION_SET_REPLACE";
  "password": string;
  "rolePermissionSet"?: StepUpRolePermissionSetDto;
}

export interface StepUpResponseDto {
  "stepUpToken": string;
  "expiresAt": string;
}

export interface StepUpRolePermissionSetDto {
  "roleId": string;
  "expectedRevision": number;
  "payloadHash": string;
}

export interface StepUpSmsDto {
  "action": "PHONE_BIND" | "WECHAT_BIND" | "WECOM_BIND" | "RBAC_ROLE_PERMISSION_SET_REPLACE";
  "code": string;
  "rolePermissionSet"?: StepUpRolePermissionSetDto;
}

export interface StepUpWechatDto {
  "action": "PHONE_BIND" | "WECHAT_BIND" | "WECOM_BIND" | "RBAC_ROLE_PERMISSION_SET_REPLACE";
  "code": string;
  "rolePermissionSet"?: StepUpRolePermissionSetDto;
}

export interface WechatBindDto {
  "code": string;
  "phone": string;
  "smsCode": string;
}

export interface WechatLoginResponseDto {
  "bindingRequired": boolean;
  "session": LoginResponseDto;
}

export interface WecomAuthorizeDto {
  "returnPath"?: string;
}

export interface WecomAuthorizeResponseDto {
  "authorizeUrl": string;
  "expiresAt": string;
}

export interface WecomBindDto {
  "bindingTicket": string;
  "phone": string;
  "smsCode": string;
}

export interface WecomLoginResponseDto {
  "bindingRequired": boolean;
  "bindingTicket": Record<string, unknown> | null;
  "session": LoginResponseDto;
  "returnPath": string;
}
