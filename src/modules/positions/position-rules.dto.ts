import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PolicyStatus } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// 终态 scoped-authz PR3(2026-07-01;冻结稿 §3.3 / §7.2):职务规则(position-rules)CRUD DTO 集合。
// 规则按"组织类别(node_type)× 职务"声明,运营自治。唯一键 (nodeTypeCode, positionId) **创建后不可改**
// (UpdatePositionRuleDto 无此二字段;改键 = 删旧建新;沿 contribution-rules 维度键不可改范式)。
// minCount / maxCount 三态:omit → null;显式 null → null;number → 落库(沿 contribution-rules 三态)。
// **本模块纯配置定义,绝不被任何判权路径读**(消费它的 policy=PR7 / assignment=PR4 / authz=PR8)。

// ============ 出参 ============

export class PositionRuleResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({
    description:
      '组织节点类别 code(node_type 字典:headquarters / rescue-team / functional-dept / group …)',
    example: 'rescue-team',
  })
  nodeTypeCode!: string;

  @ApiProperty({ description: '职务定义外键(指向 organization_positions.id)' })
  positionId!: string;

  @ApiProperty({ description: '该类组织是否必须有此职务', example: false })
  required!: boolean;

  @ApiPropertyOptional({ description: '最少在任人数(null=不限)', nullable: true, type: 'integer' })
  minCount!: number | null;

  @ApiPropertyOptional({ description: '最多在任人数(null=不限)', nullable: true, type: 'integer' })
  maxCount!: number | null;

  @ApiProperty({
    description: '任此职务是否要求先有该组织 active 归属(R8:总队级领导 false)',
    example: true,
  })
  requireMembership!: boolean;

  @ApiProperty({ description: '该类组织内是否允许兼任', example: true })
  allowConcurrent!: boolean;

  @ApiProperty({
    description: '状态(ACTIVE 启用 / INACTIVE 停用)',
    enum: PolicyStatus,
    example: PolicyStatus.ACTIVE,
  })
  status!: PolicyStatus;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// ============ 入参:Create ============

// 必填 2 字段:nodeTypeCode(必须为有效 node_type 字典项)/ positionId(必须存在)。
// required / minCount / maxCount / requireMembership / allowConcurrent / status 可省略
//(走 schema 列默认:false / null / null / true / true / ACTIVE)。
export class CreatePositionRuleDto {
  @ApiProperty({
    description: '组织节点类别 code(必填;必须为有效 node_type 字典项)',
    example: 'rescue-team',
    maxLength: 64,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  nodeTypeCode!: string;

  @ApiProperty({ description: '职务定义 id(必填;必须存在)', example: 'cl9z3a8b00000abcd1234efgh' })
  @IsString()
  @Length(8, 64)
  positionId!: string;

  @ApiPropertyOptional({ description: '该类组织是否必须有此职务(可省略,默认 false)' })
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional({
    description: '最少在任人数(可省略 / 显式 null = 不限)',
    nullable: true,
    type: 'integer',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  minCount?: number | null;

  @ApiPropertyOptional({
    description: '最多在任人数(可省略 / 显式 null = 不限)',
    nullable: true,
    type: 'integer',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  maxCount?: number | null;

  @ApiPropertyOptional({ description: '任此职务是否要求先有该组织 active 归属(可省略,默认 true)' })
  @IsOptional()
  @IsBoolean()
  requireMembership?: boolean;

  @ApiPropertyOptional({ description: '该类组织内是否允许兼任(可省略,默认 true)' })
  @IsOptional()
  @IsBoolean()
  allowConcurrent?: boolean;

  @ApiPropertyOptional({ description: '状态(可省略,默认 ACTIVE)', enum: PolicyStatus })
  @IsOptional()
  @IsEnum(PolicyStatus)
  status?: PolicyStatus;
}

// ============ 入参:Update ============

// 白名单不含 nodeTypeCode / positionId(唯一键创建后不可改;改键 = 删旧建新)。全字段可选(至少一项)。
export class UpdatePositionRuleDto {
  @ApiPropertyOptional({ description: '该类组织是否必须有此职务' })
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional({
    description: '最少在任人数(显式 null = 清空)',
    nullable: true,
    type: 'integer',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  minCount?: number | null;

  @ApiPropertyOptional({
    description: '最多在任人数(显式 null = 清空)',
    nullable: true,
    type: 'integer',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  maxCount?: number | null;

  @ApiPropertyOptional({ description: '任此职务是否要求先有该组织 active 归属' })
  @IsOptional()
  @IsBoolean()
  requireMembership?: boolean;

  @ApiPropertyOptional({ description: '该类组织内是否允许兼任' })
  @IsOptional()
  @IsBoolean()
  allowConcurrent?: boolean;

  @ApiPropertyOptional({ description: '状态(ACTIVE ↔ INACTIVE)', enum: PolicyStatus })
  @IsOptional()
  @IsEnum(PolicyStatus)
  status?: PolicyStatus;
}

// ============ 列表 query ============

// 分页 + 过滤(按 nodeTypeCode / positionId / status)。不暴露 includeDeleted / deletedAt 过滤。
export class PositionRuleQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按组织节点类别过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  nodeTypeCode?: string;

  @ApiPropertyOptional({ description: '按职务定义 id 过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  positionId?: string;

  @ApiPropertyOptional({ description: '按状态过滤', enum: PolicyStatus })
  @IsOptional()
  @IsEnum(PolicyStatus)
  status?: PolicyStatus;
}
