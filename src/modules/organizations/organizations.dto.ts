import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrganizationStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
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

  // 终态 scoped-authz PR11(2026-07-02;冻结稿 §3.0.1 R1/R3 + §8.4):PR1 已加列但未接入
  // Create DTO 的两 additive 可空字段,本刀接入(仅新增可选入参,不改 name/code/parentId/nodeTypeCode/
  // sortOrder 既有校验与行为)。establishmentStatusCode 取值锁字典 org_establishment_status 的两个
  // 已知值(空 = 未设置);groupFunctionCode 沿 R3「留口不写业务逻辑」仅格式校验,不做字典存在性校验。
  @ApiPropertyOptional({
    description: "设立状态(可选;'formal'=正式 /'provisional'=筹备组;不传 = 未设置)",
    enum: ['formal', 'provisional'],
  })
  @IsOptional()
  @IsIn(['formal', 'provisional'])
  establishmentStatusCode?: string;

  @ApiPropertyOptional({
    description: '组功能字典 code(留口;v1 只占列不做业务校验)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  groupFunctionCode?: string;
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

// 终态 scoped-authz PR1(2026-07-01 goal「组织基座」;冻结稿 §8.3 / §11 PR1):reparent 入参。
// 独立 DTO(不派生 Create/Update);仅接**非空** parentId(移成根不支持,守单根上限)。
// service 层守卫:改根节点父级 → PARENT_CHANGE_FORBIDDEN;目标父不存在 → PARENT_NOT_FOUND;
// 目标父=自身/自身后代 → PARENT_CYCLE(closure 判定)。
export class MoveOrganizationDto {
  @ApiProperty({
    description: '新父级 id(必填;不支持移成根节点)',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  parentId!: string;
}

// 列表 query:parentId 接受字面值 'null'(过滤根节点)/ cuid(过滤指定父下子节点);
// 不传则不限制(列出全部活跃节点)。
// F1/A3(路线图 §4;D1 拍板):新增可选 q(跨字段模糊命中 name+code)/ nameContains / codeContains
// (D1 精确子串备用);全部 contains + mode:'insensitive'。旧字段/响应形状不变(additive)。
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

  @ApiPropertyOptional({
    description: '模糊搜索(跨字段命中 name + code;contains + insensitive)',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    description: '按 name 精确子串过滤(contains + insensitive)',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  nameContains?: string;

  @ApiPropertyOptional({
    description: '按 code 精确子串过滤(contains + insensitive)',
    maxLength: 32,
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  codeContains?: string;
}

export class OrganizationTreeQueryDto {
  @ApiPropertyOptional({ description: '按状态过滤(默认无过滤,全部活跃)', enum: OrganizationStatus })
  @IsOptional()
  @IsEnum(OrganizationStatus)
  status?: OrganizationStatus;
}

// ============ F1/A3 选择器(路线图 §4;D2/D3 拍板)============
//
// options = list 的轻量投影(同一批数据,复用 org.read.node 码,不新增权限码);
// 独立 /options 路由(D3),响应 {items:[...]},非分页(无 total/page)。

export class OrganizationOptionsQueryDto {
  @ApiPropertyOptional({ description: '模糊搜索(跨字段命中 name + code)', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ description: '按 nodeTypeCode 过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  nodeTypeCode?: string;

  @ApiPropertyOptional({ description: '按状态过滤', enum: OrganizationStatus })
  @IsOptional()
  @IsEnum(OrganizationStatus)
  status?: OrganizationStatus;

  @ApiPropertyOptional({ description: '结果条数上限(默认 20,上限 100)', minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class OrganizationOptionItemDto {
  @ApiProperty({ description: '主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '展示标签(= name)' })
  label!: string;

  @ApiPropertyOptional({ description: '组织缩写', nullable: true })
  code!: string | null;

  @ApiProperty({ description: '节点类别字典 code' })
  nodeTypeCode!: string;

  @ApiPropertyOptional({ description: '父级 id(null = 根节点)', nullable: true })
  parentId!: string | null;
}

export class OrganizationOptionsResponseDto {
  @ApiProperty({
    description: '结果列表(不分页,受 limit 截断)',
    type: () => [OrganizationOptionItemDto],
  })
  items!: OrganizationOptionItemDto[];
}

export class OrganizationTreeOptionItemDto {
  @ApiProperty({ description: '主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '展示标签(= name)' })
  label!: string;

  @ApiPropertyOptional({ description: '组织缩写', nullable: true })
  code!: string | null;

  @ApiProperty({
    description: '子节点(空数组表示叶子);深度无限制',
    type: () => [OrganizationTreeOptionItemDto],
  })
  children!: OrganizationTreeOptionItemDto[];
}
