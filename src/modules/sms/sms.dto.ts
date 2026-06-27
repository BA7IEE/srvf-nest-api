import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SmsProviderType, SmsSendStatus } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { MAINLAND_PHONE_PATTERN } from './sms.constants';
import { SmsCredentialStatus } from './sms.types';

// SMS 基础设施 T2(2026-06-10):SMS Settings / Send Logs DTO 集合(评审稿 §3.2;
// 镜像 storage-settings.dto 范式)
//
// **入参 DTO 字段白名单铁律**(纵深防御;forbidNonWhitelisted 兜底):
// - UpdateSmsSettingsDto:**禁止** secretId / secretKey / secretIdEncrypted / secretKeyEncrypted /
//   credentialConfigured / id / createdAt / updatedAt / updatedBy
// - ResetSmsCredentialsDto:仅 secretId + secretKey
//
// **出参 DTO**(L3 红线):
// - SmsSettingsResponseDto **永不**包含 secretId / secretKey / secretIdEncrypted /
//   secretKeyEncrypted / credentials;GET 不存在时返 `data: null`
// - SmsSendLogResponseDto.phone **一律掩码** 138****1234(评审稿 E-20/E-21)

// === 字段长度常量 ===
const SDK_APP_ID_MAX_LENGTH = 64;
const SIGN_NAME_MAX_LENGTH = 64;
const REGION_MAX_LENGTH = 64;
const TEMPLATE_ID_MAX_LENGTH = 64;
const REMARKS_MAX_LENGTH = 500;
const SECRET_MAX_LENGTH = 256;
const PHONE_FILTER_MAX_LENGTH = 16;

// ============ Settings 出参 ============

export class SmsSettingsResponseDto {
  @ApiProperty({ description: 'cuid 主键' })
  id!: string;

  @ApiProperty({ description: '通道类型(production-like 禁 DEV_STUB)', enum: SmsProviderType })
  providerType!: SmsProviderType;

  @ApiProperty({ description: '全局启用开关' })
  enabled!: boolean;

  @ApiPropertyOptional({ description: '腾讯云 SMS SdkAppId(非 secret)', nullable: true })
  sdkAppId!: string | null;

  @ApiPropertyOptional({ description: '短信签名(须先过审)', nullable: true })
  signName!: string | null;

  @ApiPropertyOptional({ description: '腾讯云 region(如 ap-guangzhou)', nullable: true })
  region!: string | null;

  @ApiPropertyOptional({ description: '验证码模板 ID(须先过审)', nullable: true })
  templateIdVerifyCode!: string | null;

  @ApiPropertyOptional({ description: '生日祝福模板 ID(须先过审;零变量模板)', nullable: true })
  templateIdBirthday!: string | null;

  @ApiPropertyOptional({
    description: '通知兜底模板 ID(统一通知 S5 紧急召集;须先过审;零变量模板)',
    nullable: true,
  })
  templateIdNotification!: string | null;

  @ApiProperty({
    description: '凭证状态三档(configured / missing / invalid);明文与密文永不回显',
    enum: SmsCredentialStatus,
  })
  credentialStatus!: SmsCredentialStatus;

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

export class UpdateSmsSettingsDto {
  @ApiPropertyOptional({
    description: '通道类型;production-like 环境拒绝 DEV_STUB(评审稿 E-15)',
    enum: SmsProviderType,
  })
  @IsOptional()
  @IsEnum(SmsProviderType)
  providerType?: SmsProviderType;

  @ApiPropertyOptional({ description: '全局启用开关' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: '腾讯云 SMS SdkAppId(非 secret)' })
  @IsOptional()
  @IsString()
  @MaxLength(SDK_APP_ID_MAX_LENGTH)
  sdkAppId?: string;

  @ApiPropertyOptional({ description: '短信签名(须先过审)' })
  @IsOptional()
  @IsString()
  @MaxLength(SIGN_NAME_MAX_LENGTH)
  signName?: string;

  @ApiPropertyOptional({ description: '腾讯云 region(如 ap-guangzhou)' })
  @IsOptional()
  @IsString()
  @MaxLength(REGION_MAX_LENGTH)
  region?: string;

  @ApiPropertyOptional({ description: '验证码模板 ID(须先过审;模板变量约定 {1}=码 {2}=分钟)' })
  @IsOptional()
  @IsString()
  @MaxLength(TEMPLATE_ID_MAX_LENGTH)
  templateIdVerifyCode?: string;

  @ApiPropertyOptional({ description: '生日祝福模板 ID(须先过审;零变量模板,queue-b 评审稿 §6.5)' })
  @IsOptional()
  @IsString()
  @MaxLength(TEMPLATE_ID_MAX_LENGTH)
  templateIdBirthday?: string;

  @ApiPropertyOptional({
    description: '通知兜底模板 ID(统一通知 S5 紧急召集;须先过审;零变量模板,评审稿 §4)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(TEMPLATE_ID_MAX_LENGTH)
  templateIdNotification?: string;

  @ApiPropertyOptional({ description: '运维备注' })
  @IsOptional()
  @IsString()
  @MaxLength(REMARKS_MAX_LENGTH)
  remarks?: string;
}

export class ResetSmsCredentialsDto {
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

// ============ Send Logs(评审稿 E-20) ============

export class SmsSendLogQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按发送状态过滤', enum: SmsSendStatus })
  @IsOptional()
  @IsEnum(SmsSendStatus)
  status?: SmsSendStatus;

  @ApiPropertyOptional({
    description: '按手机号精确过滤(大陆 11 位;入参明文仅用于查询,响应仍掩码)',
    maxLength: PHONE_FILTER_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @Matches(MAINLAND_PHONE_PATTERN, { message: 'phone 必须是大陆 11 位手机号' })
  phone?: string;
}

export class SmsSendLogResponseDto {
  @ApiProperty({ description: 'cuid 主键' })
  id!: string;

  @ApiProperty({ description: '目标手机号(**一律掩码** 138****1234)' })
  phone!: string;

  @ApiProperty({ description: "逻辑模板键(本期仅 'verify-code')" })
  templateKey!: string;

  @ApiProperty({ description: '发送时通道', enum: SmsProviderType })
  providerType!: SmsProviderType;

  @ApiProperty({ description: '发送状态', enum: SmsSendStatus })
  status!: SmsSendStatus;

  @ApiPropertyOptional({ description: 'provider 回执 ID(腾讯云 SerialNo)', nullable: true })
  providerMsgId!: string | null;

  @ApiPropertyOptional({ description: '失败时 provider 错误码', nullable: true })
  errCode!: string | null;

  @ApiPropertyOptional({ description: '失败时 provider 错误信息', nullable: true })
  errMsg!: string | null;

  @ApiPropertyOptional({ description: '关联验证码记录 id', nullable: true })
  codeId!: string | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;
}
