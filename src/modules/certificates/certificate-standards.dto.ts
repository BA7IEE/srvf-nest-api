import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CertificateIssuerPolicy,
  CertificateNumberMode,
  CertificateStandardKind,
  CertificateStandardStatus,
  CertificateValidityMode,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
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

// 证书标准库 PR-3(冻结稿 §5.2 / §13.1 / §7.1):CertificateStandard 管理面 DTO。
//
// 出参显式列字段(永不含 deletedAt);入参严格白名单(全局 ValidationPipe forbidNonWhitelisted 兜底)。
//
// **身份字段创建后不可改**(D-CERT-004 / D-CERT-005):`UpdateCertificateStandardDto`
// 刻意**不含** code / kind / categoryCode / levelCode / parentId / isInternal ——
// 语义变化要新建 Standard,不是原地改。DRAFT 期需要改身份字段就删掉重建
// (DRAFT 可软删,且此时不可能被任何 Policy / Claim / Certificate 引用)。
// 这条不是「懒得做」:允许 ACTIVE 后改 category,等于让历史证书的分类事实静默漂移。

// code:小写字母 / 数字 / 下划线 / 中横线,1-64(§5.2)。
// 与 positions 的 kebab-only 不同 —— 证书 code 惯用下划线(bsafe_l2、first_aid),
// 冻结稿 §5.2 明确允许下划线。
const STANDARD_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

// ============ 路径参数 ============

// `:standardId` 的独立 param DTO(不能复用 `IdParamDto` —— 它校验的字段名是 `id`,
// 路径参数名不匹配时 class-validator 会放过一个未校验的值)。
export class CertificateStandardIdParamDto {
  @ApiProperty({ description: '证书标准 id(cuid)' })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  standardId!: string;
}

// ============ 出参 ============

export class CertificateStandardResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '标准 code(长期稳定标识,创建后不可改不可复用)', example: 'bsafe_l2' })
  code!: string;

  @ApiProperty({ description: '标准名称', example: 'BSAFE 二级' })
  name!: string;

  @ApiPropertyOptional({ description: '说明(≤500)', nullable: true, type: String })
  description!: string | null;

  @ApiProperty({
    description: 'FAMILY = 仅目录分组(不可被认定 / 不可持有);CREDENTIAL = 可持有证书标准',
    enum: CertificateStandardKind,
    example: CertificateStandardKind.CREDENTIAL,
  })
  kind!: CertificateStandardKind;

  @ApiProperty({ description: '类别字典 code(cert_type)', example: 'bsafe' })
  categoryCode!: string;

  @ApiPropertyOptional({
    description: '等级 / 子类型字典 code(cert_sub_type)',
    nullable: true,
    type: String,
  })
  levelCode!: string | null;

  @ApiPropertyOptional({
    description: '父级 Standard id(必为 FAMILY;与父级 categoryCode 一致)',
    nullable: true,
    type: String,
  })
  parentId!: string | null;

  @ApiProperty({ description: '是否本会颁发', example: false })
  isInternal!: boolean;

  @ApiProperty({
    description: 'DRAFT 可编辑身份字段 / ACTIVE 可用于认定与建证 / INACTIVE 不出现在新建选项',
    enum: CertificateStandardStatus,
    example: CertificateStandardStatus.ACTIVE,
  })
  status!: CertificateStandardStatus;

  @ApiProperty({ description: '排序权重(越小越前)', example: 0 })
  sortOrder!: number;

  @ApiPropertyOptional({ description: '首次启用时刻', nullable: true })
  activatedAt!: Date | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// options 端点(§13.1)的 issuer 选项。
export class CertificateStandardOptionIssuerDto {
  @ApiProperty({ description: '认可机构 id(实例提交用它,不用机构文字)' })
  id!: string;

  @ApiProperty({ description: '机构名称' })
  name!: string;
}

// options 端点的当前 ACTIVE Policy 摘要:前端据此决定「编号填不填、
// 到期日让不让填、机构是下拉还是自由文本」。
export class CertificateStandardOptionPolicyDto {
  @ApiProperty({ description: '当前 ACTIVE 认定规则 id' })
  id!: string;

  @ApiProperty({ description: '版本号', example: 2 })
  version!: number;

  @ApiProperty({
    description:
      'FIXED = 后端自动选唯一机构 / ALLOWLIST = 必须从 issuers 选 / FREE_TEXT = 自由填写',
    enum: CertificateIssuerPolicy,
  })
  issuerPolicy!: CertificateIssuerPolicy;

  @ApiProperty({
    description:
      'PERMANENT 到期日必须空 / FIXED_MONTHS 后端算(客户端不得传)/ EXPLICIT_REQUIRED 必填 / EXPLICIT_OPTIONAL 可空即终身',
    enum: CertificateValidityMode,
  })
  validityMode!: CertificateValidityMode;

  @ApiPropertyOptional({
    description: '仅 FIXED_MONTHS 有值(1-600)',
    nullable: true,
    type: Number,
  })
  validityMonths!: number | null;

  @ApiProperty({ description: '编号规则', enum: CertificateNumberMode })
  certNumberMode!: CertificateNumberMode;

  @ApiProperty({
    description: '认可机构选项(FREE_TEXT 时为空数组)',
    type: [CertificateStandardOptionIssuerDto],
  })
  issuers!: CertificateStandardOptionIssuerDto[];
}

export class CertificateStandardOptionItemDto {
  @ApiProperty({ description: 'Standard id' })
  id!: string;

  @ApiProperty({ description: 'Standard code', example: 'bsafe_l2' })
  code!: string;

  @ApiProperty({ description: 'Standard 名称' })
  name!: string;

  @ApiProperty({ description: '类别字典 code' })
  categoryCode!: string;

  @ApiPropertyOptional({ description: '等级字典 code', nullable: true, type: String })
  levelCode!: string | null;

  @ApiProperty({ description: '是否本会颁发' })
  isInternal!: boolean;

  @ApiProperty({
    description:
      '当前是否可用于认定 = 存在 ACTIVE Policy。false 代表「已收录、待认定」——' +
      '可作为申请人建议,后台**不得**据此直接通过(§11.2 / §13.3)',
    example: true,
  })
  currentlyRecognized!: boolean;

  @ApiPropertyOptional({
    description: '当前 ACTIVE 认定规则摘要;currentlyRecognized=false 时为 null',
    nullable: true,
    type: CertificateStandardOptionPolicyDto,
  })
  currentPolicy!: CertificateStandardOptionPolicyDto | null;
}

export class CertificateStandardOptionsResponseDto {
  @ApiProperty({ type: [CertificateStandardOptionItemDto] })
  items!: CertificateStandardOptionItemDto[];
}

// ============ 入参:查询 ============

export class CertificateStandardQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按 kind 过滤', enum: CertificateStandardKind })
  @IsOptional()
  @IsEnum(CertificateStandardKind)
  kind?: CertificateStandardKind;

  @ApiPropertyOptional({ description: '按类别字典 code 过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  categoryCode?: string;

  @ApiPropertyOptional({ description: '按等级字典 code 过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  levelCode?: string;

  @ApiPropertyOptional({ description: '按状态过滤', enum: CertificateStandardStatus })
  @IsOptional()
  @IsEnum(CertificateStandardStatus)
  status?: CertificateStandardStatus;

  @ApiPropertyOptional({ description: '按父级过滤(取某 FAMILY 的直接子节点)', maxLength: 32 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  parentId?: string;

  @ApiPropertyOptional({ description: '模糊搜 name / code', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  q?: string;
}

export class CertificateStandardOptionsQueryDto {
  @ApiPropertyOptional({
    description:
      'true = 只返「ACTIVE 且有 ACTIVE Policy」的标准(建证 / 审核下拉用);' +
      '不传或 false = 也返「已收录待认定」的标准',
    example: true,
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  recognizedOnly?: boolean;

  @ApiPropertyOptional({ description: '按类别字典 code 过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  categoryCode?: string;

  @ApiPropertyOptional({ description: '模糊搜 name / code', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  q?: string;

  @ApiPropertyOptional({ description: '条数上限(≤200,默认 50)', minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

// ============ 入参:Create ============

export class CreateCertificateStandardDto {
  @ApiProperty({
    description: '标准 code(小写字母/数字/下划线/中横线;创建后不可改不可复用)',
    example: 'bsafe_l2',
    maxLength: 64,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(STANDARD_CODE_PATTERN, {
    message: 'code 只允许小写字母、数字、下划线与中横线,且以字母或数字开头',
  })
  code!: string;

  @ApiProperty({ description: '标准名称', example: 'BSAFE 二级', maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @ApiPropertyOptional({ description: '说明', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({
    description: 'FAMILY 仅分组 / CREDENTIAL 可持有',
    enum: CertificateStandardKind,
  })
  @IsEnum(CertificateStandardKind)
  kind!: CertificateStandardKind;

  @ApiProperty({ description: '类别字典 code(必须是 ACTIVE cert_type)', maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  categoryCode!: string;

  @ApiPropertyOptional({
    description: '等级字典 code(非空时必须是 ACTIVE cert_sub_type)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  levelCode?: string;

  @ApiPropertyOptional({ description: '父级 Standard id(必为 FAMILY 且同 categoryCode)' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  parentId?: string;

  @ApiPropertyOptional({ description: '是否本会颁发(默认 false)' })
  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;

  @ApiPropertyOptional({ description: '排序权重(默认 0)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  sortOrder?: number;
}

// ============ 入参:Update ============

// **只允许文案与排序**(§7.1 ACTIVE/INACTIVE 段:「只允许修正名称、说明、排序」)。
// DRAFT 期同样只开这三项 —— 身份字段要改就删掉重建(DRAFT 可软删且必然零引用),
// 这样「身份字段可变期」在代码里根本不存在,不必靠运行时判状态防漏。
export class UpdateCertificateStandardDto {
  @ApiPropertyOptional({ description: '标准名称', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name?: string;

  @ApiPropertyOptional({ description: '说明', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: '排序权重' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  sortOrder?: number;
}

// ============ 入参:状态迁移 ============

// 允许 DRAFT→ACTIVE / ACTIVE→INACTIVE / INACTIVE→ACTIVE(§7.1)。
// 不允许回到 DRAFT —— 一旦启用过就可能被历史证书引用,回 DRAFT 等于让
// 「不可用于建证」的标准挂着历史引用,语义不可解释。
export class UpdateCertificateStandardStatusDto {
  @ApiProperty({
    description: '目标状态(不接受 DRAFT:启用过的标准不可回退)',
    enum: [CertificateStandardStatus.ACTIVE, CertificateStandardStatus.INACTIVE],
    example: CertificateStandardStatus.ACTIVE,
  })
  // 用 `@IsIn` 而不是 `@IsEnum`:`@IsEnum(CertificateStandardStatus)` 会**放过 DRAFT**
  // (它确实是该枚举成员),`@ApiProperty.enum` 只是文档元数据、不参与校验 ——
  // 于是 DRAFT 会溜过契约层、由状态机兜成 409。契约上说了不接受,就该在契约层 400。
  @IsIn([CertificateStandardStatus.ACTIVE, CertificateStandardStatus.INACTIVE])
  status!: CertificateStandardStatus;
}
