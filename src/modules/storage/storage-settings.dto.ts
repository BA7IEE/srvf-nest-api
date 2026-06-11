import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StorageMimePolicyMode, StorageProviderType } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { CredentialStatus } from './storage-settings.types';

// V2.x C-7.5 Provider 选型实施 PR #11:Storage Settings DTO 集合(沿评审 §6.5 / §6.6 + Q-11 拍板)
//
// **入参 DTO 字段白名单铁律**(纵深防御;沿 baseline §4.2 / v1 §11):
// - UpdateStorageSettingsDto:**禁止** secretId / secretKey / secretIdEncrypted / secretKeyEncrypted /
//   credentialConfigured / id / createdAt / updatedAt / updatedBy(forbidNonWhitelisted 兜底拦截)
// - ResetStorageCredentialsDto:仅 secretId + secretKey;**禁止**任何其他字段
//
// **出参 DTO**:
// - StorageSettingsResponseDto **永不**包含 secretId / secretKey / secretIdEncrypted / secretKeyEncrypted /
//   credentials(沿 §6.6.2 Q22 锁)
// - GET 不存在时返 `data: null`(不强行构造空 DTO;沿 Q-11-1)

// === 字段长度常量(沿 §6.5.2 schema) ===
const BUCKET_MAX_LENGTH = 256;
const REGION_MAX_LENGTH = 64;
const ENV_PREFIX_MAX_LENGTH = 64;
const REMARKS_MAX_LENGTH = 500;
const ORIGIN_MAX_LENGTH = 256;
const SECRET_MAX_LENGTH = 256;
const CORS_ORIGINS_MAX_SIZE = 50;
// TTL 区间(沿评审 §8.5.3)
const UPLOAD_TTL_MIN = 60;
const UPLOAD_TTL_MAX = 3600;
const DOWNLOAD_TTL_MIN = 60;
const DOWNLOAD_TTL_MAX = 1800;
const LIFECYCLE_DAYS_MIN = 0;
const LIFECYCLE_DAYS_MAX = 365;

// maxObjectSizeBytes:BigInt 入参/出参用 string(沿 Q-11-10 + V2 JSON 序列化范式)
// 非负整数字符串:`^\d+$`(不接受负数 / 小数 / 科学计数法)
const NON_NEGATIVE_INT_STRING = /^\d+$/;

// ============ 出参 ============

// 沿 §6.5.2 字段顺序:Provider 选型 → 运行参数 → 能力开关 → CORS / 大小 / MIME → 凭证状态 → 元信息(沿 Q-11-18)
export class StorageSettingsResponseDto {
  @ApiProperty({ description: 'cuid 主键' })
  id!: string;

  // ===== Provider 选型(沿 Q4)=====
  @ApiProperty({ description: 'Provider 类型', enum: StorageProviderType })
  providerType!: StorageProviderType;

  @ApiProperty({ description: '全局启用开关' })
  enabled!: boolean;

  // ===== 运行参数(沿 Q11 / Q17 / Q18 / Q20)=====
  @ApiPropertyOptional({ description: 'COS bucket 名;Local 留空', nullable: true })
  bucket!: string | null;

  @ApiPropertyOptional({ description: 'COS region;Local 留空', nullable: true })
  region!: string | null;

  @ApiPropertyOptional({
    description: 'key 环境前缀(dev / test / prod;沿 Q17 / Q18)',
    nullable: true,
  })
  envPrefix!: string | null;

  @ApiProperty({
    description: '上传 signed URL TTL(秒;沿 Q8)',
    minimum: UPLOAD_TTL_MIN,
    maximum: UPLOAD_TTL_MAX,
  })
  uploadUrlTtlSeconds!: number;

  @ApiProperty({
    description: '下载 signed URL TTL(秒;沿 Q8)',
    minimum: DOWNLOAD_TTL_MIN,
    maximum: DOWNLOAD_TTL_MAX,
  })
  downloadUrlTtlSeconds!: number;

  @ApiProperty({ description: '旧版本 expire 天数(沿 Q11;运维侧引用值)' })
  lifecycleDays!: number;

  // ===== 能力开关 =====
  @ApiProperty({ description: '是否启用 signed URL(沿 F2)' })
  enableSignedUrl!: boolean;

  @ApiProperty({ description: 'versioning 业务侧引用(沿 Q11)' })
  enableVersioning!: boolean;

  // ===== CORS / 大小 / MIME 策略 =====
  @ApiPropertyOptional({
    description: '业务侧引用 CORS origins(沿 Q14;运维 SOP 维护)',
    type: [String],
    nullable: true,
  })
  corsAllowedOrigins!: string[] | null;

  @ApiPropertyOptional({
    description: '全局 size 兜底(BigInt 序列化为 string;沿 Q-11-10);null = 不限',
    nullable: true,
    example: '104857600',
  })
  maxObjectSizeBytes!: string | null;

  @ApiProperty({
    description: 'mime 策略模式(沿 D7-attachments §6.6)',
    enum: StorageMimePolicyMode,
  })
  allowedMimePolicyMode!: StorageMimePolicyMode;

  // ===== 凭证状态(沿 §6.6.3;永不回显 secret/Encrypted) =====
  @ApiProperty({
    description:
      '凭证三态(沿 §6.6.3):configured=已配置+解密成功 / missing=未配置 / invalid=已配置但解密失败',
    enum: CredentialStatus,
  })
  credentialStatus!: CredentialStatus;

  @ApiProperty({ description: 'DB 层是否已配置凭证(沿 §6.5.2)' })
  credentialConfigured!: boolean;

  // ===== 元信息 =====
  @ApiPropertyOptional({ description: '运维备注', nullable: true })
  remarks!: string | null;

  @ApiPropertyOptional({
    description: '最近更新者 User.id(沿 §6.5.3 + V2 范式)',
    nullable: true,
  })
  updatedBy!: string | null;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;
}

// ============ 入参 ============

// PATCH /api/system/v1/storage-settings(upsert;不存在创建 singleton row;沿 Q-11-1 + Q-11-17)
// **禁止接受**(沿 §6.6.2 + Q-11 拍板):
//   - secretId / secretKey(明文凭证;走独立 reset-credentials)
//   - secretIdEncrypted / secretKeyEncrypted(密文;Service 内部管)
//   - credentialConfigured(由 reset-credentials 维护)
//   - id / createdAt / updatedAt / updatedBy(系统字段)
// forbidNonWhitelisted 全局 ValidationPipe 兜底拦截
export class UpdateStorageSettingsDto {
  @ApiPropertyOptional({
    description: 'Provider 类型;PATCH 后 Router 动态切换(沿 Q-11-8;沿 PR #89 动态路由)',
    enum: StorageProviderType,
  })
  @IsOptional()
  @IsEnum(StorageProviderType)
  providerType?: StorageProviderType;

  @ApiPropertyOptional({ description: '全局启用开关' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'COS bucket 名;Local 留空', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(BUCKET_MAX_LENGTH)
  bucket?: string | null;

  @ApiPropertyOptional({ description: 'COS region', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(REGION_MAX_LENGTH)
  region?: string | null;

  @ApiPropertyOptional({ description: 'key 环境前缀', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(ENV_PREFIX_MAX_LENGTH)
  envPrefix?: string | null;

  @ApiPropertyOptional({
    description: '上传 signed URL TTL',
    minimum: UPLOAD_TTL_MIN,
    maximum: UPLOAD_TTL_MAX,
  })
  @IsOptional()
  @IsInt()
  @Min(UPLOAD_TTL_MIN)
  @Max(UPLOAD_TTL_MAX)
  uploadUrlTtlSeconds?: number;

  @ApiPropertyOptional({
    description: '下载 signed URL TTL',
    minimum: DOWNLOAD_TTL_MIN,
    maximum: DOWNLOAD_TTL_MAX,
  })
  @IsOptional()
  @IsInt()
  @Min(DOWNLOAD_TTL_MIN)
  @Max(DOWNLOAD_TTL_MAX)
  downloadUrlTtlSeconds?: number;

  @ApiPropertyOptional({
    description: '旧版本 expire 天数',
    minimum: LIFECYCLE_DAYS_MIN,
    maximum: LIFECYCLE_DAYS_MAX,
  })
  @IsOptional()
  @IsInt()
  @Min(LIFECYCLE_DAYS_MIN)
  @Max(LIFECYCLE_DAYS_MAX)
  lifecycleDays?: number;

  @ApiPropertyOptional({ description: '是否启用 signed URL' })
  @IsOptional()
  @IsBoolean()
  enableSignedUrl?: boolean;

  @ApiPropertyOptional({ description: 'versioning 业务侧引用' })
  @IsOptional()
  @IsBoolean()
  enableVersioning?: boolean;

  @ApiPropertyOptional({
    description: 'CORS origins(沿 Q-11-9:仅 string + maxLength;不做 URL 校验)',
    type: [String],
    nullable: true,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CORS_ORIGINS_MAX_SIZE)
  @IsString({ each: true })
  @MaxLength(ORIGIN_MAX_LENGTH, { each: true })
  corsAllowedOrigins?: string[] | null;

  @ApiPropertyOptional({
    description: '全局 size 兜底(BigInt 用 string 入参;沿 Q-11-10;非负整数字符串 ^\\d+$;null 清空)',
    nullable: true,
    example: '104857600',
  })
  @IsOptional()
  @IsString()
  @Matches(NON_NEGATIVE_INT_STRING, {
    message: 'maxObjectSizeBytes 必须是非负整数字符串(例:"104857600")',
  })
  maxObjectSizeBytes?: string | null;

  @ApiPropertyOptional({
    description: 'mime 策略模式(INHERIT / OVERRIDE;沿 Q-11-12)',
    enum: StorageMimePolicyMode,
  })
  @IsOptional()
  @IsEnum(StorageMimePolicyMode)
  allowedMimePolicyMode?: StorageMimePolicyMode;

  @ApiPropertyOptional({ description: '运维备注', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(REMARKS_MAX_LENGTH)
  remarks?: string | null;
}

// POST /api/system/v1/storage-settings/reset-credentials(只允许 replace;沿 §6.6.2 + Q-11-5)
// **严禁包含** secretIdEncrypted / secretKeyEncrypted / credentialConfigured /
//   oldSecretId / oldSecretKey 等(沿 Q-11-5 不需要 old 校验)
export class ResetStorageCredentialsDto {
  @ApiProperty({
    description: '腾讯云 SecretId 明文;Service 层 AES-256-GCM 加密后落库;**永不回显**',
    minLength: 1,
    maxLength: SECRET_MAX_LENGTH,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(SECRET_MAX_LENGTH)
  secretId!: string;

  @ApiProperty({
    description: '腾讯云 SecretKey 明文;Service 层 AES-256-GCM 加密后落库;**永不回显**',
    minLength: 1,
    maxLength: SECRET_MAX_LENGTH,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(SECRET_MAX_LENGTH)
  secretKey!: string;
}
