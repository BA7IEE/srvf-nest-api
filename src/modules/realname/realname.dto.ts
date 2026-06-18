import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RealnameProviderType } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { RealnameCredentialStatus } from './realname.types';

// 招新一期 · 实名核验通道 T2(2026-06-18):Realname Settings DTO 集合(评审稿 §3.2 ①-③;
// 镜像 wechat.dto / sms.dto Settings 段范式)
//
// **入参 DTO 字段白名单铁律**(纵深防御;forbidNonWhitelisted 兜底):
// - UpdateRealnameSettingsDto:**禁止** secretId / secretKey / *Encrypted / credentialConfigured /
//   id / createdAt / updatedAt / updatedBy
// - ResetRealnameCredentialsDto:仅 secretId + secretKey 两段
//
// **出参 DTO**(L3 红线):
// - RealnameSettingsResponseDto **永不**包含 secretId / secretKey / *Encrypted / credentials;
//   GET 不存在时返 `data: null`

// === 字段长度常量 ===
const REGION_MAX_LENGTH = 64;
const REMARKS_MAX_LENGTH = 500;
const SECRET_MAX_LENGTH = 256;

// ============ Settings 出参 ============

export class RealnameSettingsResponseDto {
  @ApiProperty({ description: 'cuid 主键' })
  id!: string;

  @ApiProperty({ description: '通道类型(production-like 禁 DEV_STUB)', enum: RealnameProviderType })
  providerType!: RealnameProviderType;

  @ApiProperty({ description: '全局启用开关' })
  enabled!: boolean;

  @ApiPropertyOptional({ description: '腾讯云 region(非 secret;如 ap-guangzhou)', nullable: true })
  region!: string | null;

  @ApiProperty({
    description:
      '凭证状态三档(configured / missing / invalid);secretId/secretKey 明文与密文永不回显',
    enum: RealnameCredentialStatus,
  })
  credentialStatus!: RealnameCredentialStatus;

  @ApiProperty({ description: 'DB 层是否已配置凭证(运行时状态看 credentialStatus)' })
  credentialConfigured!: boolean;

  @ApiPropertyOptional({ description: '运维备注', nullable: true })
  remarks!: string | null;

  @ApiPropertyOptional({ description: '最后更新人 User.id', nullable: true })
  updatedBy!: string | null;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;
}

// ============ Settings 入参 ============

export class UpdateRealnameSettingsDto {
  @ApiPropertyOptional({
    description: '通道类型;production-like 环境拒绝 DEV_STUB(评审稿 E-R-5)',
    enum: RealnameProviderType,
  })
  @IsOptional()
  @IsEnum(RealnameProviderType)
  providerType?: RealnameProviderType;

  @ApiPropertyOptional({ description: '全局启用开关' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: '腾讯云 region(非 secret)' })
  @IsOptional()
  @IsString()
  @MaxLength(REGION_MAX_LENGTH)
  region?: string;

  @ApiPropertyOptional({ description: '运维备注' })
  @IsOptional()
  @IsString()
  @MaxLength(REMARKS_MAX_LENGTH)
  remarks?: string;
}

export class ResetRealnameCredentialsDto {
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
