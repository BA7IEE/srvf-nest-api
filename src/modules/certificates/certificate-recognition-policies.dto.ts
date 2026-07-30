import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CertificateIssuerPolicy,
  CertificateNumberMode,
  CertificateRecognitionPolicyStatus,
  CertificateValidityMode,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

// 证书标准库 PR-3(冻结稿 §5.3 / §5.4 / §7.2 / §13.2):队内认定规则 DTO。
//
// 两条契约层决策:
// 1. `version` **不接受客户端传**:它必须在 Standard 行锁内取 MAX(version)+1
//    (§5.3),客户端算的版本号在并发下必然过期。
// 2. issuer 集合**随 DRAFT Policy 整体提交与替换**(§13.2),不开单条 issuer 的
//    增删改端点 —— 单条改会让「ACTIVE 规则的机构集合」有被偷偷改的路径,
//    而 §7.2 要求 ACTIVE 规则所有规则只读。

export class CertificateRecognitionIssuerResponseDto {
  @ApiProperty({ description: '认可机构 id(实例提交用它,不用机构文字)' })
  id!: string;

  @ApiProperty({ description: '机构名称(canonical)' })
  name!: string;

  @ApiProperty({ description: '排序权重' })
  sortOrder!: number;
}

export class CertificateRecognitionPolicyResponseDto {
  @ApiProperty({ description: '主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '所属证书标准 id' })
  standardId!: string;

  @ApiProperty({ description: '版本号(同 Standard 内递增;服务端分配)', example: 2 })
  version!: number;

  @ApiProperty({
    description: 'DRAFT 可编辑 / ACTIVE 生效且只读 / RETIRED 已退役且只读',
    enum: CertificateRecognitionPolicyStatus,
  })
  status!: CertificateRecognitionPolicyStatus;

  @ApiProperty({
    description:
      'FIXED 恰好 1 个机构(实例可不传)/ ALLOWLIST ≥1 个(实例必须传 id)/ FREE_TEXT 0 个(实例填自由文本)',
    enum: CertificateIssuerPolicy,
  })
  issuerPolicy!: CertificateIssuerPolicy;

  @ApiProperty({
    description:
      'PERMANENT 到期日必须空 / FIXED_MONTHS 后端按自然月算 / EXPLICIT_REQUIRED 必填 / EXPLICIT_OPTIONAL 可空即终身',
    enum: CertificateValidityMode,
  })
  validityMode!: CertificateValidityMode;

  @ApiPropertyOptional({
    description: '仅 FIXED_MONTHS 有值(1-600);其余模式恒 null',
    nullable: true,
    type: Number,
  })
  validityMonths!: number | null;

  @ApiProperty({ description: '编号规则', enum: CertificateNumberMode })
  certNumberMode!: CertificateNumberMode;

  @ApiPropertyOptional({ description: '激活时刻', nullable: true })
  activatedAt!: Date | null;

  @ApiPropertyOptional({ description: '退役时刻', nullable: true })
  retiredAt!: Date | null;

  @ApiProperty({
    description: '认可机构集合(随 DRAFT 整体替换;FREE_TEXT 时为空数组)',
    type: [CertificateRecognitionIssuerResponseDto],
  })
  issuers!: CertificateRecognitionIssuerResponseDto[];

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

export class CertificateRecognitionPolicyListResponseDto {
  @ApiProperty({
    description: '该 Standard 的全部认定规则版本(version DESC;含 DRAFT / ACTIVE / RETIRED)',
    type: [CertificateRecognitionPolicyResponseDto],
  })
  items!: CertificateRecognitionPolicyResponseDto[];
}

// ============ 入参:issuer 子项 ============

export class CertificateRecognitionIssuerInputDto {
  @ApiProperty({ description: '机构名称', example: '深圳市急救中心', maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @ApiPropertyOptional({ description: '排序权重(默认按数组顺序)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  sortOrder?: number;
}

// ============ 入参:Create(建新版本)============

// 不接受 version / status:version 服务端在 Standard 行锁内算(§5.3),
// status 恒 DRAFT(新版本必须显式激活,不能一步到生效)。
export class CreateCertificateRecognitionPolicyDto {
  @ApiProperty({ description: '机构策略', enum: CertificateIssuerPolicy })
  @IsEnum(CertificateIssuerPolicy)
  issuerPolicy!: CertificateIssuerPolicy;

  @ApiProperty({ description: '有效期模式', enum: CertificateValidityMode })
  @IsEnum(CertificateValidityMode)
  validityMode!: CertificateValidityMode;

  @ApiPropertyOptional({
    description: '有效月数(**仅** FIXED_MONTHS 允许且必填,1-600;其余模式传值即 18015)',
    minimum: 1,
    maximum: 600,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(600)
  validityMonths?: number;

  @ApiProperty({ description: '编号规则', enum: CertificateNumberMode })
  @IsEnum(CertificateNumberMode)
  certNumberMode!: CertificateNumberMode;

  @ApiProperty({
    description:
      '认可机构集合(FIXED 恰好 1 / ALLOWLIST ≥1 / FREE_TEXT 必须空;同名去重后仍重复即 18013)',
    type: [CertificateRecognitionIssuerInputDto],
  })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CertificateRecognitionIssuerInputDto)
  issuers!: CertificateRecognitionIssuerInputDto[];
}

// ============ 入参:Update(仅 DRAFT;issuer 整体替换)============

// 与 Create 同形,但全字段可选;传 issuers 即**整体替换**该 DRAFT 的机构集合
// (§13.2「issuer 集合随 DRAFT Policy 整体提交和替换」),不做增量 merge。
// 不传 issuers = 保持原集合不动。
export class UpdateCertificateRecognitionPolicyDto {
  @ApiPropertyOptional({ description: '机构策略', enum: CertificateIssuerPolicy })
  @IsOptional()
  @IsEnum(CertificateIssuerPolicy)
  issuerPolicy?: CertificateIssuerPolicy;

  @ApiPropertyOptional({ description: '有效期模式', enum: CertificateValidityMode })
  @IsOptional()
  @IsEnum(CertificateValidityMode)
  validityMode?: CertificateValidityMode;

  @ApiPropertyOptional({
    description: '有效月数(仅 FIXED_MONTHS;显式传 null 语义由「不传」表达,本 DTO 不接受 null)',
    minimum: 1,
    maximum: 600,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(600)
  validityMonths?: number;

  @ApiPropertyOptional({ description: '编号规则', enum: CertificateNumberMode })
  @IsOptional()
  @IsEnum(CertificateNumberMode)
  certNumberMode?: CertificateNumberMode;

  @ApiPropertyOptional({
    description: '认可机构集合(传即整体替换,不做增量 merge;不传则保持不动)',
    type: [CertificateRecognitionIssuerInputDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CertificateRecognitionIssuerInputDto)
  issuers?: CertificateRecognitionIssuerInputDto[];
}

// ============ 入参:状态迁移 ============

// §13.2:「激活 DTO 只允许 ACTIVE」+「当前 ACTIVE Policy 由激活动作自动 RETIRE,
// 不让客户端分两步操作」。所以这里也接受 RETIRED(手动退役当前 ACTIVE 而不立新版),
// 但**不接受 DRAFT** —— 已激活/退役的规则永不可回 DRAFT(§7.2 / D-CERT-007)。
export class UpdateCertificateRecognitionPolicyStatusDto {
  @ApiProperty({
    description:
      '目标状态。ACTIVE = 激活本版并**原子退役**该 Standard 当前 ACTIVE 版;RETIRED = 直接退役当前 ACTIVE 版。不接受 DRAFT',
    enum: [CertificateRecognitionPolicyStatus.ACTIVE, CertificateRecognitionPolicyStatus.RETIRED],
    example: CertificateRecognitionPolicyStatus.ACTIVE,
  })
  // 同 Standard status DTO:必须 `@IsIn` 而非 `@IsEnum` —— 后者会放过 DRAFT,
  // 让「不接受 DRAFT」这句话在契约层不成立(只能靠状态机兜 409)。
  @IsIn([CertificateRecognitionPolicyStatus.ACTIVE, CertificateRecognitionPolicyStatus.RETIRED])
  status!: CertificateRecognitionPolicyStatus;
}
