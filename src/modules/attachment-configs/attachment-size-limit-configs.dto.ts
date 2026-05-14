import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// V2.x C-7 attachments 实施 PR #5(2026-05-15):AttachmentSizeLimitConfig 模块 DTO 集合。
// 沿 D7 v1.0 §4.4 + 用户 Step 1 拍板 Q1-Q8 + PR #3 / PR #4 范式。
//
// **关键差异**(沿 D7 v1.0 §4.4 schema 现状;Q1 v1.0):
// - **本表无 status 字段**(size limit 是数值覆盖语义,不需要启停);**5 端点**(无独立 status 端点)
// - 1:1 关系:`typeConfigId @unique`(每 type 至多一条 override)
// - `maxSizeBytes Int NOT NULL`(沿 schema;Q5:PATCH 不允许传 null,清除走 DELETE)
//
// **PATCH 字段白名单铁律**(Q4 PR #4 沿用):
// - UpdateAttachmentSizeLimitConfigDto 仅允许 maxSizeBytes / remark
// - **严禁** typeConfigId(绑定关系不可改;沿 Q4 PR #4 mime 范式)/ deletedAt / id / createdAt / updatedAt
//
// **不出参 deletedAt**(Q2 PR #3/#4 沿用):Response DTO 不暴露 deletedAt。
//
// **嵌套 typeConfig 摘要**(Q4 v1.0 锁:新建独立 AttachmentSizeLimitConfigTypeConfigSummaryDto,
// 不复用 mime 的 summary DTO;避免跨表 DTO 耦合)。

// ============ 共用大小上限 ============

// 10 GiB 硬上限(Q6 v1.0:沿 PR #3 AttachmentTypeConfig.defaultMaxSizeBytes 范式)
const MAX_SIZE_BYTES_HARD_LIMIT = 10_737_418_240;

// ============ 嵌套 typeConfig 摘要(独立 DTO;Q4 v1.0)============

export class AttachmentSizeLimitConfigTypeConfigSummaryDto {
  @ApiProperty({ description: 'type config 主键(cuid)' })
  id!: string;

  @ApiProperty({ description: 'type config code', example: 'member' })
  code!: string;

  @ApiProperty({ description: 'type config 显示名', example: '队员证件照(身份证)' })
  displayName!: string;
}

// ============ 出参 ============

export class AttachmentSizeLimitConfigResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({
    description: '关联 type config id(FK;1:1 唯一;不可改)',
    example: 'cl9z3a8b00000abcd1234efgh',
  })
  typeConfigId!: string;

  @ApiProperty({
    description: '单文件大小上限(字节);覆盖 type config 的 defaultMaxSizeBytes',
    example: 5_242_880,
  })
  maxSizeBytes!: number;

  @ApiPropertyOptional({ description: '备注(可空;运营录入)', nullable: true })
  remark?: string | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;

  @ApiProperty({
    description: '关联 type config 摘要(Q4 v1.0:独立摘要 DTO,不复用 mime 的)',
    type: () => AttachmentSizeLimitConfigTypeConfigSummaryDto,
  })
  typeConfig!: AttachmentSizeLimitConfigTypeConfigSummaryDto;
}

// ============ 入参 ============

export class CreateAttachmentSizeLimitConfigDto {
  @ApiProperty({
    description: '关联 type config id(FK;1:1 唯一;不存在或已软删返 13020)',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  typeConfigId!: string;

  @ApiProperty({
    description: '单文件大小上限(字节);沿 Q6 v1.0 硬上限 10 GiB',
    minimum: 1,
    maximum: MAX_SIZE_BYTES_HARD_LIMIT,
    example: 5_242_880,
  })
  @IsInt()
  @Min(1)
  @Max(MAX_SIZE_BYTES_HARD_LIMIT)
  maxSizeBytes!: number;

  @ApiPropertyOptional({ description: '备注', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;

  // **不接受**:deletedAt / id / createdAt / updatedAt(forbidNonWhitelisted 兜底)
  // **不接受 status**:本表无 status 字段(Q1 v1.0)
}

// PATCH 允许 maxSizeBytes / remark;严禁 typeConfigId(Q4 PR #4 范式:绑定关系不可改);
// Q5 v1.0:PATCH **不允许 maxSizeBytes = null**(schema 中 maxSizeBytes 是 NOT NULL;清除走 DELETE)。
export class UpdateAttachmentSizeLimitConfigDto {
  @ApiPropertyOptional({
    description: '单文件大小上限(字节);Q5 v1.0:不允许 null(清除走 DELETE)',
    minimum: 1,
    maximum: MAX_SIZE_BYTES_HARD_LIMIT,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_SIZE_BYTES_HARD_LIMIT)
  maxSizeBytes?: number;

  @ApiPropertyOptional({ description: '备注', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}

// 列表入参:分页 + 可选 typeConfigId 过滤(沿 PR #4 mime 范式,无 status / mime 字段)。
export class ListAttachmentSizeLimitConfigsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '按 typeConfigId 过滤(精确匹配)',
    minLength: 8,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  typeConfigId?: string;
}
