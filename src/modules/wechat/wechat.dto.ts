import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WechatProviderType } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { WechatCredentialStatus } from './wechat.types';

// 微信小程序登录 T2(2026-06-12):Wechat Settings DTO 集合(评审稿 §3.2 ①-③;
// 镜像 sms.dto Settings 段范式)
//
// **入参 DTO 字段白名单铁律**(纵深防御;forbidNonWhitelisted 兜底):
// - UpdateWechatSettingsDto:**禁止** appSecret / appSecretEncrypted / credentialConfigured /
//   id / createdAt / updatedAt / updatedBy
// - ResetWechatCredentialsDto:仅 appSecret
//
// **出参 DTO**(L3 红线):
// - WechatSettingsResponseDto **永不**包含 appSecret / appSecretEncrypted / credentials;
//   GET 不存在时返 `data: null`

// === 字段长度常量 ===
const APP_ID_MAX_LENGTH = 64;
const REMARKS_MAX_LENGTH = 500;
const SECRET_MAX_LENGTH = 256;

// ============ Settings 出参 ============

export class WechatSettingsResponseDto {
  @ApiProperty({ description: 'cuid 主键' })
  id!: string;

  @ApiProperty({ description: '通道类型(production-like 禁 DEV_STUB)', enum: WechatProviderType })
  providerType!: WechatProviderType;

  @ApiProperty({ description: '全局启用开关' })
  enabled!: boolean;

  @ApiPropertyOptional({ description: '微信小程序 AppID(非 secret)', nullable: true })
  appId!: string | null;

  @ApiProperty({
    description: '凭证状态三档(configured / missing / invalid);appSecret 明文与密文永不回显',
    enum: WechatCredentialStatus,
  })
  credentialStatus!: WechatCredentialStatus;

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

export class UpdateWechatSettingsDto {
  @ApiPropertyOptional({
    description: '通道类型;production-like 环境拒绝 DEV_STUB(评审稿 E-6)',
    enum: WechatProviderType,
  })
  @IsOptional()
  @IsEnum(WechatProviderType)
  providerType?: WechatProviderType;

  @ApiPropertyOptional({ description: '全局启用开关' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: '微信小程序 AppID(非 secret)' })
  @IsOptional()
  @IsString()
  @MaxLength(APP_ID_MAX_LENGTH)
  appId?: string;

  @ApiPropertyOptional({ description: '运维备注' })
  @IsOptional()
  @IsString()
  @MaxLength(REMARKS_MAX_LENGTH)
  remarks?: string;
}

export class ResetWechatCredentialsDto {
  @ApiProperty({
    description: '微信小程序 AppSecret 明文;Service 层 AES-256-GCM 加密后落库;**永不回显**',
    minLength: 1,
    maxLength: SECRET_MAX_LENGTH,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(SECRET_MAX_LENGTH)
  appSecret!: string;
}
