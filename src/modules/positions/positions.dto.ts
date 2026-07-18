import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PolicyStatus, PositionCategory } from '@prisma/client';
import { Type } from 'class-transformer';
import {
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
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// 终态 scoped-authz PR3(2026-07-01;冻结稿 §3.2 / §7.2):职务定义(positions)CRUD DTO 集合。
// 出参显式列字段(永不含 deletedAt);入参严格白名单(全局 ValidationPipe forbidNonWhitelisted 兜底)。
// code 为长期稳定标识:**创建后不可改**(UpdatePositionDto 无 code;沿 org / dict / contribution 维度键不可改范式)。
// PositionAssignmentPolicy 在新任命时执行 status / allowMultiple / allowConcurrent;
// 本配置不直接改写既有任职的 authz 口径。

const POSITION_CODE_PATTERN = /^[a-z][a-z0-9-]*$/; // kebab-case,首字母小写

// ============ 出参 ============

export class PositionResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '职务 code(kebab,长期稳定标识)', example: 'team-leader' })
  code!: string;

  @ApiProperty({ description: '显示名', example: '队长' })
  name!: string;

  @ApiProperty({
    description: '职务类别(LEADER 正职 / DEPUTY 副职 / STAFF 干事)',
    enum: PositionCategory,
    example: PositionCategory.LEADER,
  })
  categoryCode!: PositionCategory;

  @ApiProperty({ description: '层级排序权重(数值越小越资深)', example: 10 })
  rank!: number;

  @ApiProperty({ description: '是否领导职务', example: true })
  isLeadership!: boolean;

  @ApiProperty({
    description: '定义层多人开关(false 等价人数上限 1；与职务规则 maxCount 取更严格上限)',
    example: false,
  })
  allowMultiple!: boolean;

  @ApiProperty({
    description: '定义层兼任开关；任命时与匹配职务规则 allowConcurrent 取严格交集',
    example: true,
  })
  allowConcurrent!: boolean;

  @ApiProperty({ description: '显示排序', example: 1 })
  sortOrder!: number;

  @ApiProperty({
    description: '状态(ACTIVE 可新任命 / INACTIVE 禁止新任命；不追溯撤销既有任职)',
    enum: PolicyStatus,
    example: PolicyStatus.ACTIVE,
  })
  status!: PolicyStatus;

  @ApiPropertyOptional({ description: '备注', nullable: true })
  description!: string | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// ============ 入参:Create ============

// 必填 3 字段:code / name / categoryCode。rank / isLeadership / allowMultiple / allowConcurrent /
// sortOrder / status / description 可省略(走 schema 列默认:0 / false / false / true / 0 / ACTIVE / null)。
export class CreatePositionDto {
  @ApiProperty({
    description: '职务 code(kebab,必填;长期稳定)',
    example: 'team-leader',
    maxLength: 64,
  })
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(POSITION_CODE_PATTERN, {
    message: 'code 必须为 kebab-case(首字母小写,仅小写字母/数字/连字符)',
  })
  code!: string;

  @ApiProperty({ description: '显示名(必填)', example: '队长', maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name!: string;

  @ApiProperty({ description: '职务类别(必填)', enum: PositionCategory })
  @IsEnum(PositionCategory)
  categoryCode!: PositionCategory;

  @ApiPropertyOptional({ description: '层级排序权重(可省略,默认 0)', example: 10 })
  @IsOptional()
  @IsInt()
  @Min(0)
  rank?: number;

  @ApiPropertyOptional({ description: '是否领导职务(可省略,默认 false)' })
  @IsOptional()
  @IsBoolean()
  isLeadership?: boolean;

  @ApiPropertyOptional({
    description: '定义层多人开关(false 等价上限 1；与规则 maxCount 取更严格上限；默认 false)',
  })
  @IsOptional()
  @IsBoolean()
  allowMultiple?: boolean;

  @ApiPropertyOptional({
    description: '定义层兼任开关(与匹配规则 allowConcurrent 取严格交集；默认 true)',
  })
  @IsOptional()
  @IsBoolean()
  allowConcurrent?: boolean;

  @ApiPropertyOptional({ description: '显示排序(可省略,默认 0)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({ description: '状态(可省略,默认 ACTIVE)', enum: PolicyStatus })
  @IsOptional()
  @IsEnum(PolicyStatus)
  status?: PolicyStatus;

  @ApiPropertyOptional({ description: '备注', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

// ============ 入参:Update ============

// 白名单不含 code(创建后不可改;改 code = 停用旧建新)。全字段可选(至少一项)。
export class UpdatePositionDto {
  @ApiPropertyOptional({ description: '显示名', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name?: string;

  @ApiPropertyOptional({ description: '职务类别', enum: PositionCategory })
  @IsOptional()
  @IsEnum(PositionCategory)
  categoryCode?: PositionCategory;

  @ApiPropertyOptional({ description: '层级排序权重' })
  @IsOptional()
  @IsInt()
  @Min(0)
  rank?: number;

  @ApiPropertyOptional({ description: '是否领导职务' })
  @IsOptional()
  @IsBoolean()
  isLeadership?: boolean;

  @ApiPropertyOptional({
    description: '定义层多人开关(false 等价上限 1；与规则 maxCount 取更严格上限)',
  })
  @IsOptional()
  @IsBoolean()
  allowMultiple?: boolean;

  @ApiPropertyOptional({
    description: '定义层兼任开关(与匹配规则 allowConcurrent 取严格交集)',
  })
  @IsOptional()
  @IsBoolean()
  allowConcurrent?: boolean;

  @ApiPropertyOptional({ description: '显示排序' })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({
    description: '状态(ACTIVE 可新任命 / INACTIVE 禁止新任命；不追溯既有任职)',
    enum: PolicyStatus,
  })
  @IsOptional()
  @IsEnum(PolicyStatus)
  status?: PolicyStatus;

  @ApiPropertyOptional({ description: '备注(显式 null = 清空)', nullable: true, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;
}

// ============ 列表 query ============

// 分页 + 过滤;沿 v1 §4 PaginationQueryDto。不暴露 includeDeleted / deletedAt 过滤。
export class PositionQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按职务类别过滤', enum: PositionCategory })
  @IsOptional()
  @IsEnum(PositionCategory)
  categoryCode?: PositionCategory;

  @ApiPropertyOptional({ description: '按状态过滤', enum: PolicyStatus })
  @IsOptional()
  @IsEnum(PolicyStatus)
  status?: PolicyStatus;
}

// ============ F1/A5 选择器(路线图 §4;D2/D3 拍板)============

export class PositionOptionsQueryDto {
  @ApiPropertyOptional({ description: '按职务类别过滤', enum: PositionCategory })
  @IsOptional()
  @IsEnum(PositionCategory)
  categoryCode?: PositionCategory;

  @ApiPropertyOptional({ description: '按状态过滤', enum: PolicyStatus })
  @IsOptional()
  @IsEnum(PolicyStatus)
  status?: PolicyStatus;

  @ApiPropertyOptional({ description: '模糊搜索(命中 name)', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ description: '结果条数上限(默认 20,上限 100)', minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class PositionOptionItemDto {
  @ApiProperty({ description: '主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '展示标签(= name)' })
  label!: string;

  @ApiProperty({ description: '职务类别', enum: PositionCategory })
  categoryCode!: PositionCategory;
}

export class PositionOptionsResponseDto {
  @ApiProperty({
    description: '结果列表(不分页,受 limit 截断)',
    type: () => [PositionOptionItemDto],
  })
  items!: PositionOptionItemDto[];
}
