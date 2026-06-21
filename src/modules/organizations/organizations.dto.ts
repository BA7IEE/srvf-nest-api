import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrganizationStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

// 组织缩写格式:大写字母 / 数字 / 连字符(长期契约 code 风格;seed 内置 SRVF / SMRT …)。
// 格式校验放 DTO @Matches → 违规走全局 ValidationPipe 返 400;唯一性由 service 校验(11033)。
const ORGANIZATION_CODE_PATTERN = /^[A-Z0-9-]+$/;
const ORGANIZATION_CODE_MAX_LENGTH = 32;
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// V2 第一阶段 organizations 模块 DTO 集合。
// 出参显式列字段;入参严格白名单 + class-validator,配合 forbidNonWhitelisted 兜底。
// 详见 docs/v2-api-contract.md §3 / docs/v2-data-model.md §4。
//
// **绝对禁止改 parentId**:UpdateOrganizationDto 不含 parentId 字段(对应 D7-min O-1)。
// PATCH 请求传 parentId 由全局 ValidationPipe forbidNonWhitelisted 兜底拒绝。

// ============ 出参 ============

export class OrganizationResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '节点名', example: 'Demo Org Root' })
  name!: string;

  @ApiPropertyOptional({
    description: '组织缩写(null = 未设置;全局唯一)',
    example: 'SRVF',
    nullable: true,
  })
  code!: string | null;

  @ApiPropertyOptional({
    description: '父级自引用(null = 根节点;V2 第一阶段单根上限 1)',
    nullable: true,
  })
  parentId!: string | null;

  @ApiProperty({
    description: '引用 dict_items.code(隐含 type code = node_type)',
    example: 'demo-node-type-1',
  })
  nodeTypeCode!: string;

  @ApiProperty({ description: '同级排序权重(默认 0)' })
  sortOrder!: number;

  @ApiProperty({ description: '启停状态', enum: OrganizationStatus })
  status!: OrganizationStatus;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// 树形节点 = OrganizationResponseDto + children。沿用 dictionaries 风格(独立类)。
export class OrganizationTreeNodeDto extends OrganizationResponseDto {
  @ApiProperty({
    description: '子节点(空数组表示叶子);深度无限制',
    type: () => [OrganizationTreeNodeDto],
  })
  children!: OrganizationTreeNodeDto[];
}

// ============ 入参 ============

export class CreateOrganizationDto {
  @ApiProperty({ description: '节点名', maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    description: '组织缩写(可选;大写字母 / 数字 / 连字符;全局唯一,含软删历史占用)',
    example: 'SRVF',
    maxLength: ORGANIZATION_CODE_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(ORGANIZATION_CODE_MAX_LENGTH)
  @Matches(ORGANIZATION_CODE_PATTERN, { message: 'code 仅允许大写字母 / 数字 / 连字符' })
  code?: string;

  @ApiPropertyOptional({
    description: '父级 id(可选;不传 = 创建根节点;V2 第一阶段单根上限 1)',
    minLength: 8,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  parentId?: string;

  @ApiProperty({
    description: '节点类别字典 code(必须在 type=node_type 字典中存在且 ACTIVE)',
    example: 'demo-node-type-1',
    maxLength: 64,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  nodeTypeCode!: string;

  @ApiPropertyOptional({ description: '排序权重(默认 0)', minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

// 仅允许 name / code / sortOrder / nodeTypeCode;**绝对禁止** parentId(对应 D7-min O-1
// "不可改父级"红线);status 走 /:id/status;deletedAt / id 永不接受。
export class UpdateOrganizationDto {
  @ApiPropertyOptional({ description: '节点名', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    description: '组织缩写(可选;大写字母 / 数字 / 连字符;全局唯一,含软删历史占用)',
    example: 'SRVF',
    maxLength: ORGANIZATION_CODE_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(ORGANIZATION_CODE_MAX_LENGTH)
  @Matches(ORGANIZATION_CODE_PATTERN, { message: 'code 仅允许大写字母 / 数字 / 连字符' })
  code?: string;

  @ApiPropertyOptional({ description: '同级排序权重', minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({ description: '节点类别字典 code', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  nodeTypeCode?: string;
}

export class UpdateOrganizationStatusDto {
  @ApiProperty({
    description: '目标状态',
    enum: OrganizationStatus,
    example: OrganizationStatus.INACTIVE,
  })
  @IsEnum(OrganizationStatus)
  status!: OrganizationStatus;
}

// 列表 query:parentId 接受字面值 'null'(过滤根节点)/ cuid(过滤指定父下子节点);
// 不传则不限制(列出全部活跃节点)。
export class ListOrganizationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: "parentId 过滤;字面值 'null' 表示根节点;不传不限制",
    example: 'null',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  parentId?: string;

  @ApiPropertyOptional({ description: '按 nodeTypeCode 过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  nodeTypeCode?: string;

  @ApiPropertyOptional({ description: '按状态过滤', enum: OrganizationStatus })
  @IsOptional()
  @IsEnum(OrganizationStatus)
  status?: OrganizationStatus;
}

export class OrganizationTreeQueryDto {
  @ApiPropertyOptional({ description: '按状态过滤(默认无过滤,全部活跃)', enum: OrganizationStatus })
  @IsOptional()
  @IsEnum(OrganizationStatus)
  status?: OrganizationStatus;
}
