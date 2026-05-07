import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DictItemStatus, DictTypeStatus } from '@prisma/client';
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
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// V2 第一阶段 dictionaries 模块 DTO 集合。
// 出参显式列字段;入参严格白名单 + class-validator,配合 forbidNonWhitelisted 兜底。
// 详见 docs/v2-api-contract.md §2 / docs/v2-data-model.md §2-§3。

// ============ dict_types 出参 ============

export class DictTypeResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '类型业务标识(全局唯一)', example: 'node_type' })
  code!: string;

  @ApiProperty({ description: '类型显示名(运营可读)', example: 'Demo node type' })
  label!: string;

  @ApiProperty({ description: '启停状态', enum: DictTypeStatus, example: DictTypeStatus.ACTIVE })
  status!: DictTypeStatus;

  @ApiProperty({ description: '排序权重(默认 0)', example: 0 })
  sortOrder!: number;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// ============ dict_types 入参 ============

export class CreateDictTypeDto {
  @ApiProperty({
    description: 'code(全局唯一;小写字母 / 数字 / 下划线,字母开头)',
    example: 'node_type',
    minLength: 1,
    maxLength: 64,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^[a-z][a-z0-9_]*$/, {
    message: 'code 只允许小写字母 / 数字 / 下划线,以字母开头',
  })
  code!: string;

  @ApiProperty({ description: '显示名', maxLength: 255, example: 'Demo node type' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  label!: string;

  @ApiPropertyOptional({ description: '排序权重(默认 0)', minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

// 仅允许 label / sortOrder;**禁止** code(业务标识稳定不可改),
// 禁止 status / deletedAt / id(各走专属接口)。
export class UpdateDictTypeDto {
  @ApiPropertyOptional({ description: '显示名', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  label?: string;

  @ApiPropertyOptional({ description: '排序权重', minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateDictTypeStatusDto {
  @ApiProperty({ description: '目标状态', enum: DictTypeStatus, example: DictTypeStatus.INACTIVE })
  @IsEnum(DictTypeStatus)
  status!: DictTypeStatus;
}

export class ListDictTypesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按状态过滤(可选)', enum: DictTypeStatus })
  @IsOptional()
  @IsEnum(DictTypeStatus)
  status?: DictTypeStatus;
}

// ============ dict_items 出参 ============

export class DictItemResponseDto {
  @ApiProperty({ description: '主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '类型外键(指向 dict_types.id)' })
  typeId!: string;

  @ApiProperty({
    description: 'items 业务标识(同 typeId 范围内唯一)',
    example: 'demo-node-type-1',
  })
  code!: string;

  @ApiProperty({ description: '显示名', example: 'Demo node type 1' })
  label!: string;

  @ApiPropertyOptional({
    description: '父级自引用(null = 顶层 item)',
    nullable: true,
  })
  parentId!: string | null;

  @ApiProperty({ description: '同级排序权重(默认 0)' })
  sortOrder!: number;

  @ApiProperty({ description: '启停状态', enum: DictItemStatus, example: DictItemStatus.ACTIVE })
  status!: DictItemStatus;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// 树形节点 = DictItemResponseDto + 嵌套 children。
// 独立类便于 Swagger schema 清晰(决策点 3)。
export class DictItemTreeNodeDto extends DictItemResponseDto {
  @ApiProperty({
    description: '子节点(空数组表示叶子);深度无限制,业务侧自行约束',
    type: () => [DictItemTreeNodeDto],
  })
  children!: DictItemTreeNodeDto[];
}

// ============ dict_items 入参 ============

export class CreateDictItemDto {
  @ApiProperty({ description: '类型 id(必须存在)', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  typeId!: string;

  @ApiProperty({
    description: 'code(同 typeId 下唯一;小写字母 / 数字 / 下划线 / 中横线,字母或数字开头)',
    example: 'demo-node-type-1',
    minLength: 1,
    maxLength: 64,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^[a-z0-9][a-z0-9_-]*$/, {
    message: 'code 只允许小写字母 / 数字 / 下划线 / 中横线',
  })
  code!: string;

  @ApiProperty({ description: '显示名', maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  label!: string;

  @ApiPropertyOptional({
    description: '父级 id(可选;必须与本 item 同 typeId,且不能形成自环)',
    minLength: 8,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  parentId?: string;

  @ApiPropertyOptional({ description: '排序权重(默认 0)', minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

// 仅允许 label / sortOrder;**禁止** typeId / code / parentId(创建后稳定);
// 禁止 status(走 /:id/status)/ deletedAt / id。
export class UpdateDictItemDto {
  @ApiPropertyOptional({ description: '显示名', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  label?: string;

  @ApiPropertyOptional({ description: '排序权重', minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateDictItemStatusDto {
  @ApiProperty({ description: '目标状态', enum: DictItemStatus, example: DictItemStatus.INACTIVE })
  @IsEnum(DictItemStatus)
  status!: DictItemStatus;
}

export class ListDictItemsQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: '类型 id(必填)', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  typeId!: string;

  @ApiPropertyOptional({
    description: '父级 id(可选;过滤同级)',
    minLength: 8,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  parentId?: string;

  @ApiPropertyOptional({ description: '按状态过滤(可选)', enum: DictItemStatus })
  @IsOptional()
  @IsEnum(DictItemStatus)
  status?: DictItemStatus;
}

export class DictItemTreeQueryDto {
  @ApiProperty({ description: '类型 id(必填)', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  typeId!: string;

  @ApiPropertyOptional({ description: '按状态过滤(可选)', enum: DictItemStatus })
  @IsOptional()
  @IsEnum(DictItemStatus)
  status?: DictItemStatus;
}
