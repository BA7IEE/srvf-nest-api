import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AttachmentTypeConfigStatus } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// V2.x C-7 attachments 实施 PR #3(2026-05-15):AttachmentTypeConfig 模块 DTO 集合。
// 沿 D7 v1.0 §4.2 + §16 决议表 + 用户 Step 1 拍板 Q1-Q7:
//
// **code 格式校验铁律**(Q1 v1.0 锁 + 沿 RBAC permissions D2 范式):
// - DTO 层只做基础字符串 + 长度校验(@IsString + @MinLength + @MaxLength)
// - **不在 DTO 写 @Matches**;格式校验留给 Service 层显式 regex + 抛
//   BizException(BizCode.INVALID_ATTACHMENT_TYPE_CONFIG_CODE_FORMAT)(13023),
//   让本 BizCode 真正可触发并被 e2e 覆盖
//
// **PATCH 字段白名单铁律**(纵深防御;沿 baseline §4.2 / CLAUDE.md §11):
// - UpdateAttachmentTypeConfigDto 仅允许资料字段(displayName / description / ownerTable /
//   defaultMaxSizeBytes / defaultMimeWhitelist)
// - **严禁** code(Q1 拍板:不可改)/ status(Q5 拍板:走独立 PATCH /:id/status 端点)/
//   deletedAt / id / createdAt / updatedAt
//
// **不出参 deletedAt**(Q2 v1.0 锁):AttachmentTypeConfigResponseDto 不暴露 deletedAt 字段,
// 沿 dictionaries / RbacRole 范式。

// ============ 共用大小上限 ============

// 10 GiB 硬上限(沿 Step 1 草案 §3.2;防滥用;具体业务上限由配置表运行时控制)
const DEFAULT_MAX_SIZE_BYTES_HARD_LIMIT = 10_737_418_240;

// 单 type 默认 mime 上限(沿 Step 1 草案 §3.2;运行时由 attachment_mime_configs 表 override 补充)
const DEFAULT_MIME_WHITELIST_MAX_SIZE = 50;

// ============ 出参 ============

export class AttachmentTypeConfigResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: 'ownerType code(全局唯一)', example: 'member' })
  code!: string;

  @ApiProperty({ description: '后台 UI 显示名', example: '队员证件照(身份证)' })
  displayName!: string;

  @ApiPropertyOptional({ description: '描述(可空;运营录入)', nullable: true })
  description?: string | null;

  @ApiProperty({
    description: '关联业务表名(自由字符串;主模块 PR 期校验真实表)',
    example: 'member',
  })
  ownerTable!: string;

  @ApiPropertyOptional({
    description: '默认单文件大小上限(字节);null 表示无默认',
    nullable: true,
    example: 5_242_880,
  })
  defaultMaxSizeBytes?: number | null;

  @ApiProperty({
    description: '默认允许 MIME 列表(可由 mime_config 表覆盖)',
    type: [String],
    example: ['image/jpeg', 'image/png'],
  })
  defaultMimeWhitelist!: string[];

  @ApiProperty({
    description: '启停状态(改 status 走 PATCH /:id/status 专属端点)',
    enum: AttachmentTypeConfigStatus,
    example: AttachmentTypeConfigStatus.ACTIVE,
  })
  status!: AttachmentTypeConfigStatus;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// ============ 入参 ============

export class CreateAttachmentTypeConfigDto {
  @ApiProperty({
    description: 'ownerType code(全局唯一;格式校验在 Service 层 / 失败抛 13023)',
    example: 'member',
    minLength: 1,
    maxLength: 64,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code!: string;

  @ApiProperty({ description: '后台 UI 显示名', maxLength: 255, example: '队员证件照(身份证)' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  displayName!: string;

  @ApiPropertyOptional({ description: '描述', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({
    description: '关联业务表名(Q6 v1.0:自由字符串;主模块 PR 期再做白名单 / 真实表校验)',
    maxLength: 64,
    example: 'member',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  ownerTable!: string;

  @ApiPropertyOptional({
    description: '默认单文件大小上限(字节);null 表示无默认(由 size_limit_config 表覆盖或全局兜底)',
    minimum: 1,
    maximum: DEFAULT_MAX_SIZE_BYTES_HARD_LIMIT,
    nullable: true,
    example: 5_242_880,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(DEFAULT_MAX_SIZE_BYTES_HARD_LIMIT)
  defaultMaxSizeBytes?: number | null;

  @ApiPropertyOptional({
    description: '默认允许 MIME 列表(可由 mime_config 表覆盖);未传默认 []',
    type: [String],
    example: ['image/jpeg', 'image/png'],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(DEFAULT_MIME_WHITELIST_MAX_SIZE)
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  defaultMimeWhitelist?: string[];

  // **不接受**:status(默认 ACTIVE;改状态走 PATCH /:id/status 端点;沿 Q5 v1.0)/
  //   deletedAt / id / createdAt / updatedAt(forbidNonWhitelisted 兜底拦截)
}

// PATCH 仅允许资料字段;严禁 code(Q1 v1.0:不可改)/ status(Q5 v1.0:走专属端点)/
// deletedAt / id / createdAt / updatedAt(沿 baseline §4.2 + CLAUDE.md §11 纵深防御)。
export class UpdateAttachmentTypeConfigDto {
  @ApiPropertyOptional({ description: '显示名', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  displayName?: string;

  @ApiPropertyOptional({ description: '描述', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: '关联业务表名', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  ownerTable?: string;

  @ApiPropertyOptional({
    description: '默认单文件大小上限(字节);显式传 null 移除默认(Q4 v1.0)',
    minimum: 1,
    maximum: DEFAULT_MAX_SIZE_BYTES_HARD_LIMIT,
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(DEFAULT_MAX_SIZE_BYTES_HARD_LIMIT)
  defaultMaxSizeBytes?: number | null;

  @ApiPropertyOptional({
    description: '默认允许 MIME 列表',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(DEFAULT_MIME_WHITELIST_MAX_SIZE)
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  defaultMimeWhitelist?: string[];
}

// Q5 v1.0:status 走独立端点(沿 dictionaries `PATCH /api/system/v1/dict-types/:id/status` 范式)。
export class UpdateAttachmentTypeConfigStatusDto {
  @ApiProperty({
    description: '目标状态',
    enum: AttachmentTypeConfigStatus,
    example: AttachmentTypeConfigStatus.INACTIVE,
  })
  @IsEnum(AttachmentTypeConfigStatus)
  status!: AttachmentTypeConfigStatus;
}

// 列表入参:分页 + 可选过滤(status / ownerTable)。
export class ListAttachmentTypeConfigsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按状态过滤', enum: AttachmentTypeConfigStatus })
  @IsOptional()
  @IsEnum(AttachmentTypeConfigStatus)
  status?: AttachmentTypeConfigStatus;

  @ApiPropertyOptional({ description: '按 ownerTable 过滤(精确匹配)', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  ownerTable?: string;
}

// 沿 v1 §11 IdParamDto 等价(controller 复用全局 IdParamDto;本文件不重复定义)。
