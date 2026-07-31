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
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { OmittableOnly } from '../../common/decorators/omittable-only.decorator';

// 证书标准库 PR-3(冻结稿 §5.3 / §5.4 / §7.2 / §13.2):队内认定规则 DTO。
//
// 第四轮评审 P1(null 契约):本文件**没有任何一个字段是「可清空」的** ——
// 认定规则的四个核心列(issuerPolicy / validityMode / certNumberMode / issuers)
// 在库内全是非空,`validityMonths` 虽可空但它的空值**由 validityMode 派生**、
// 不由客户端直接指定(见 UpdateCertificateRecognitionPolicyDto 上的逐字说明)。
// 所以这里 7 处一律 `@OmittableOnly()`,`null` 稳定 400。
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
  @OmittableOnly()
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
  @OmittableOnly()
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
  @OmittableOnly()
  @IsEnum(CertificateIssuerPolicy)
  issuerPolicy?: CertificateIssuerPolicy;

  @ApiPropertyOptional({ description: '有效期模式', enum: CertificateValidityMode })
  @OmittableOnly()
  @IsEnum(CertificateValidityMode)
  validityMode?: CertificateValidityMode;

  // 第四轮评审 P1:这句「本 DTO 不接受 null」以前**只是一句话** ——
  // `@IsOptional()` 对 null 照样放行,service 再 `!== undefined` 判成「传了」,
  // 于是 `validityMonths: null` 一路写进库。现在由 `@OmittableOnly()` 执行它。
  //
  // 为什么它是「仅可省略」而不是「可清空」:`validityMonths` 只在 FIXED_MONTHS
  // 模式下有值,其余模式恒 null —— 而这个 null **是 validityMode 派生出来的**,
  // 不是客户端能独立指定的事实。想把它变回 null 的唯一正确动作是改 validityMode
  // (service 在改 mode 时会自动把 months 归零重判)。保持 FIXED_MONTHS 却清掉
  // months 是非法组合,本来就该 18015。
  // description 逐字不变(同 certificates.dto.ts 的理由):契约本来就说了不接受 null,
  // 本刀只是补上执行位;改文案会动 test/contract 快照(红区)。
  @ApiPropertyOptional({
    description: '有效月数(仅 FIXED_MONTHS;显式传 null 语义由「不传」表达,本 DTO 不接受 null)',
    minimum: 1,
    maximum: 600,
  })
  @OmittableOnly()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(600)
  validityMonths?: number;

  @ApiPropertyOptional({ description: '编号规则', enum: CertificateNumberMode })
  @OmittableOnly()
  @IsEnum(CertificateNumberMode)
  certNumberMode?: CertificateNumberMode;

  // 「清空机构集合」的表达方式是传 `[]`(FREE_TEXT 规则下合法),不是传 null。
  //
  // 实测口径(别把它写得比事实严重):`dto.issuers ?? []` 会把 null 折成空数组,
  // 于是 null 成了「清空」的一个**隐式同义词**。它当前**没有**变成可达的静默清空 ——
  // FIXED 要求恰好 1、ALLOWLIST 要求 ≥1,`assertIssuerCountMatchesPolicy` 会先拒掉;
  // 而 FREE_TEXT 的机构集合本来就必须是空的,没有东西可清。
  // 那道 count 检查是**顺手**兜住的,不是为这件事设的 —— 依赖「恰好被别的规则挡住」
  // 正是这一轮反复修的形状。这里把 null 直接拒掉,不留这条同义通道。
  @ApiPropertyOptional({
    description: '认可机构集合(传即整体替换,不做增量 merge;不传则保持不动)',
    type: [CertificateRecognitionIssuerInputDto],
  })
  @OmittableOnly()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CertificateRecognitionIssuerInputDto)
  issuers?: CertificateRecognitionIssuerInputDto[];
}

// ============ 入参:状态迁移 ============

// §13.2 逐字:「激活 DTO **只允许 ACTIVE**」+「当前 ACTIVE Policy 由激活动作自动 RETIRE,
// 不让客户端分两步操作」。
//
// 评审 findings F5 + 维护者 2026-07-30 拍板:**撤掉对 `RETIRED` 的放开,恢复冻结契约。**
//
// 这里原先多收了一个 `RETIRED`(「手动退役当前 ACTIVE 版而不立新版」),
// 而上一行注释自己就写着「§13.2:激活 DTO 只允许 ACTIVE」—— 描述与执行位当场矛盾,
// 是本批抓到的三处同类问题之一。
//
// 更要紧的是它悄悄扩了业务语义:手动退役会让这个 Standard 进入「有标准、无生效规则」
// 状态,此后既不能建证也不能过审(18035 / 28062)。那是一个**真实的运营动作**
// (「暂停认定这类证书」),需要它自己的权限判定、审计语义和前端提示,
// 不该由一次「顺手多接一个枚举值」的 DTO 改动带进来。真需要就单独立项。
export class UpdateCertificateRecognitionPolicyStatusDto {
  @ApiProperty({
    description:
      '目标状态。**只接受 ACTIVE** = 激活本版并**原子退役**该 Standard 当前 ACTIVE 版。' +
      '不接受 DRAFT(已激活/退役的规则永不可回,§7.2 / D-CERT-007);' +
      '也不接受 RETIRED(「暂停认定」是独立业务动作,不在本接口)',
    enum: [CertificateRecognitionPolicyStatus.ACTIVE],
    example: CertificateRecognitionPolicyStatus.ACTIVE,
  })
  // 必须 `@IsIn` 而非 `@IsEnum` —— 后者会放过 DRAFT / RETIRED,
  // 让「只允许 ACTIVE」这句话在契约层不成立(只能靠状态机兜 409)。
  @IsIn([CertificateRecognitionPolicyStatus.ACTIVE])
  status!: CertificateRecognitionPolicyStatus;
}
