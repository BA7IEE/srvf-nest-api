import type { StorageMimePolicyMode, StorageProviderType } from '@prisma/client';

// V2.x C-7.5 Provider 选型实施 PR #6:storage_settings 运行时类型(沿 §6.5.5 + §6.6.3)
//
// 这些类型仅在 Service 层 / 测试 / Provider 实装(PR #7-8)中使用;
// **API DTO 出参永不包含 `credentials`**(沿 Q22:明文凭证永不外露)。

// 凭证状态三档(沿 §6.6.3 + Q22)
// - configured:credentialConfigured=true 且 secretIdEncrypted / secretKeyEncrypted 都成功解密
// - missing:任一凭证字段为 null(系统未初始化 / 运维未配置)
// - invalid:credentialConfigured=true 但解密失败(key 不匹配 / 密文被篡改 / 算法升级)
export enum CredentialStatus {
  CONFIGURED = 'configured',
  MISSING = 'missing',
  INVALID = 'invalid',
}

// 运行时合成的 Storage 配置(沿 §6.5.5)。
// `credentials` 明文仅在 Service 内部传递,**不进任何 API 出参 / 日志 / audit**(沿 Q21 / Q22)。
export interface StorageSettingsResolved {
  id: string;
  providerType: StorageProviderType;
  enabled: boolean;
  bucket: string | null;
  region: string | null;
  envPrefix: string | null;
  uploadUrlTtlSeconds: number;
  downloadUrlTtlSeconds: number;
  lifecycleDays: number;
  enableSignedUrl: boolean;
  enableVersioning: boolean;
  corsAllowedOrigins: string[] | null;
  maxObjectSizeBytes: bigint | null;
  allowedMimePolicyMode: StorageMimePolicyMode;
  credentials: { secretId: string; secretKey: string } | null;
  credentialStatus: CredentialStatus;
  remarks: string | null;
  updatedBy: string | null;
  updatedAt: Date;
  createdAt: Date;
}
