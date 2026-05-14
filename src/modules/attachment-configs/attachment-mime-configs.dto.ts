import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AttachmentMimeConfigStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// V2.x C-7 attachments 实施 PR #4(2026-05-15):AttachmentMimeConfig 模块 DTO 集合。
// 沿 D7 v1.0 §4.3 + 用户 Step 1 拍板 Q1-Q8:
//
// **MIME 格式校验铁律**(Q1 v1.0 锁;沿 PR #3 type config code 范式):
// - DTO 层只做基础字符串 + 长度校验(@IsString + @MinLength + @MaxLength)
// - **不在 DTO 写复杂 regex**;格式校验留给 Service 层显式 regex + 抛
//   BizException(BizCode.INVALID_ATTACHMENT_MIME_FORMAT)(13025),让本 BizCode
//   真正可触发并被 e2e 覆盖
//
// **PATCH 字段白名单铁律**(Q3 + Q4 v1.0):
// - UpdateAttachmentMimeConfigDto 仅允许 remark
// - **严禁** mime(Q3:业务标识不可改)/ typeConfigId(Q4:绑定关系不可改)/
//   status(走独立 PATCH /:id/status)/ deletedAt / id / createdAt / updatedAt
//
// **不出参 deletedAt**(Q2 v1.0 锁):AttachmentMimeConfigResponseDto 不暴露 deletedAt,
// 沿 dictionaries / RbacRole / type-configs 范式。
//
// **嵌套 typeConfig 摘要**(Q2 v1.0 锁;沿 D7-RBAC RbacRole detail 嵌套范式):
// 出参含 typeConfig: { id, code, displayName }(后台 UI 需要展示类型归属)。

// ============ 嵌套 typeConfig 摘要 ============

export class AttachmentMimeConfigTypeConfigSummaryDto {
  @ApiProperty({ description: 'type config 主键(cuid)' })
  id!: string;

  @ApiProperty({ description: 'type config code', example: 'member' })
  code!: string;

  @ApiProperty({ description: 'type config 显示名', example: '队员证件照(身份证)' })
  displayName!: string;
}

// ============ 出参 ============

export class AttachmentMimeConfigResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({
    description: '关联 type config id(FK;不可改)',
    example: 'cl9z3a8b00000abcd1234efgh',
  })
  typeConfigId!: string;

  @ApiProperty({ description: 'MIME 类型(业务标识;不可改)', example: 'image/jpeg' })
  mime!: string;

  @ApiProperty({
    description: '启停状态(改 status 走 PATCH /:id/status 专属端点)',
    enum: AttachmentMimeConfigStatus,
    example: AttachmentMimeConfigStatus.ACTIVE,
  })
  status!: AttachmentMimeConfigStatus;

  @ApiPropertyOptional({ description: '备注(可空;运营录入)', nullable: true })
  remark?: string | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;

  @ApiProperty({
    description: '关联 type config 摘要(Q2 v1.0:后台 UI 需要展示类型归属)',
    type: () => AttachmentMimeConfigTypeConfigSummaryDto,
  })
  typeConfig!: AttachmentMimeConfigTypeConfigSummaryDto;
}

// ============ 入参 ============

export class CreateAttachmentMimeConfigDto {
  @ApiProperty({
    description: '关联 type config id(FK;不存在或已软删返 13020)',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  typeConfigId!: string;

  @ApiProperty({
    description:
      'MIME 类型(格式校验在 Service 层 / 失败抛 13025;允许标准 MIME 与 wildcard 如 image/*)',
    example: 'image/jpeg',
    minLength: 1,
    maxLength: 128,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  mime!: string;

  @ApiPropertyOptional({ description: '备注', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;

  // **不接受**:status(默认 ACTIVE;改状态走 PATCH /:id/status;沿 Q5 v1.0 type config 范式)/
  //   deletedAt / id / createdAt / updatedAt(forbidNonWhitelisted 兜底)
}

// PATCH 仅允许 remark(Q3 + Q4 v1.0:mime / typeConfigId 不可改;
// status 走独立端点;deletedAt / id / createdAt / updatedAt 沿 baseline §4.2 纵深防御)。
export class UpdateAttachmentMimeConfigDto {
  @ApiPropertyOptional({ description: '备注', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}

// Q5 v1.0:status 走独立端点(沿 PR #3 type config 范式)。
export class UpdateAttachmentMimeConfigStatusDto {
  @ApiProperty({
    description: '目标状态',
    enum: AttachmentMimeConfigStatus,
    example: AttachmentMimeConfigStatus.INACTIVE,
  })
  @IsEnum(AttachmentMimeConfigStatus)
  status!: AttachmentMimeConfigStatus;
}

// 列表入参:分页 + 可选过滤(typeConfigId / status / mime)。
export class ListAttachmentMimeConfigsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '按 typeConfigId 过滤(精确匹配)',
    minLength: 8,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  typeConfigId?: string;

  @ApiPropertyOptional({ description: '按状态过滤', enum: AttachmentMimeConfigStatus })
  @IsOptional()
  @IsEnum(AttachmentMimeConfigStatus)
  status?: AttachmentMimeConfigStatus;

  @ApiPropertyOptional({ description: '按 mime 过滤(精确匹配)', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  mime?: string;
}
