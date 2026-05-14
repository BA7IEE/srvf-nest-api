import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// V2 第一阶段批次 2 certificates 模块 DTO 集合。
// 详见 docs:批次2_API前评审_certificates.md §3 + 草案 v1.0 §4 / §5.1 / §13。
//
// **绝对禁止**入参字段(全部由全局 ValidationPipe + forbidNonWhitelisted 兜底):
// - id / memberId / createdAt / updatedAt / deletedAt(系统字段)
// - certStatusCode / verifiedBy / verifiedAt / verifyNote(状态机内部;通过 verify/reject 动作接口写)
// - isInternal(Q-S7 + Q-A3:本批次 service 始终写 false,DTO 不接受)
// - supersededByCertId(本批次零 API 暴露;假数据走 prisma.create)
// - expireNotifyDueAt(后台任务字段,本批次不实装)
//
// 字段长度上限对齐草案 v1.0 §5.1:
// - issuingOrg 128 / certNumber 128(Q-D3) / verifyNote 500(Q-S5) / 字典 code 64

// ============ 出参 ============

export class CertificateResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '关联队员外键(指向 members.id;N:1)' })
  memberId!: string;

  @ApiProperty({ description: '证书大类字典 code(CT-2;字典 cert_type)' })
  certTypeCode!: string;

  @ApiPropertyOptional({
    description: '证书子类型 / 等级字典 code(CT-3;字典 cert_sub_type;Q-D4 schema 可空)',
    nullable: true,
  })
  certSubTypeCode!: string | null;

  @ApiProperty({ description: '颁发机构(CT-4;自由文本)' })
  issuingOrg!: string;

  @ApiPropertyOptional({
    description: '证书编号(CT-5;中敏感;详情接口才返回)',
    nullable: true,
  })
  certNumber!: string | null;

  @ApiProperty({ description: '颁发日期(CT-6;ISO 8601)' })
  issuedAt!: Date;

  @ApiPropertyOptional({
    description: '到期日(CT-7;NULL = 终身有效;Q-S4)',
    nullable: true,
  })
  expiredAt!: Date | null;

  @ApiProperty({
    description: '核验状态字典 code(CT-8;4 态闭集 pending / verified / expired / rejected)',
  })
  certStatusCode!: string;

  @ApiPropertyOptional({
    description: '核验人 Member.id(CT-9a;待核验态空;Q-I2:user 无 memberId 时为 null)',
    nullable: true,
  })
  verifiedBy!: string | null;

  @ApiPropertyOptional({ description: '核验时间(CT-9b)', nullable: true })
  verifiedAt!: Date | null;

  @ApiPropertyOptional({
    description: '核验备注(CT-9c;中敏感;长度 ≤ 500)',
    nullable: true,
  })
  verifyNote!: string | null;

  @ApiProperty({ description: '是否本会颁发(CT-11;本批次 service 始终写 false)' })
  isInternal!: boolean;

  @ApiPropertyOptional({
    description: '替代关系:被替代的旧证书 id(CT-12;不做反向冗余,Q-S6 / Q-D2)',
    nullable: true,
  })
  supersededByCertId!: string | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// 列表项 DTO:精简版(草案 §13.1 默认隐藏)。
// 不返:certNumber / verifyNote / verifiedBy / verifiedAt / supersededByCertId。
export class CertificateListItemDto {
  @ApiProperty({ description: '主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '关联队员外键' })
  memberId!: string;

  @ApiProperty({ description: '证书大类字典 code' })
  certTypeCode!: string;

  @ApiPropertyOptional({ description: '证书子类型 / 等级字典 code', nullable: true })
  certSubTypeCode!: string | null;

  @ApiProperty({ description: '颁发机构' })
  issuingOrg!: string;

  @ApiProperty({ description: '颁发日期' })
  issuedAt!: Date;

  @ApiPropertyOptional({ description: '到期日(NULL = 终身有效)', nullable: true })
  expiredAt!: Date | null;

  @ApiProperty({ description: '核验状态字典 code(4 态闭集)' })
  certStatusCode!: string;

  @ApiProperty({ description: '是否本会颁发' })
  isInternal!: boolean;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

export class QualificationFlagResponseDto {
  @ApiProperty({ description: '查询的 Member.id' })
  memberId!: string;

  @ApiProperty({ description: '查询的证书大类 code' })
  certTypeCode!: string;

  @ApiProperty({
    description: '是否具备资质(已核验 + 未过期 + 未软删;草案 §9.3 / Q-S9)',
  })
  qualified!: boolean;
}

// ============ 入参:Create ============

// 必填:certTypeCode / issuingOrg / issuedAt;其余可选(schema 可空,Q-D4 / Q-D5)。
export class CreateCertificateDto {
  @ApiProperty({ description: '证书大类字典 code(必填)', maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  certTypeCode!: string;

  @ApiPropertyOptional({ description: '证书子类型 / 等级字典 code', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  certSubTypeCode?: string;

  @ApiProperty({ description: '颁发机构(自由文本;必填)', maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  issuingOrg!: string;

  @ApiPropertyOptional({ description: '证书编号(中敏感)', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  certNumber?: string;

  @ApiProperty({ description: '颁发日期(ISO 8601;业务层规范化为 00:00:00.000Z;必填)' })
  @IsDateString()
  issuedAt!: string;

  @ApiPropertyOptional({ description: '到期日(ISO 8601;NULL = 终身有效)' })
  @IsOptional()
  @IsDateString()
  expiredAt?: string;
}

// ============ 入参:Update ============

// PATCH 语义:全字段 optional;**绝对禁止** certStatusCode / verifiedBy / verifiedAt / verifyNote /
//   isInternal / supersededByCertId / expireNotifyDueAt(forbidNonWhitelisted 兜底)。
// Q-A4 决议:接受 issuedAt / expiredAt 资料修正。
export class UpdateCertificateDto {
  @ApiPropertyOptional({ description: '证书大类字典 code', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  certTypeCode?: string;

  @ApiPropertyOptional({ description: '证书子类型 / 等级字典 code', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  certSubTypeCode?: string;

  @ApiPropertyOptional({ description: '颁发机构', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  issuingOrg?: string;

  @ApiPropertyOptional({ description: '证书编号', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  certNumber?: string;

  @ApiPropertyOptional({ description: '颁发日期(ISO 8601;Q-A4 决议:允许资料修正)' })
  @IsOptional()
  @IsDateString()
  issuedAt?: string;

  @ApiPropertyOptional({ description: '到期日(ISO 8601;Q-A4 决议:允许资料修正;NULL = 终身有效)' })
  @IsOptional()
  @IsDateString()
  expiredAt?: string;
}

// ============ 入参:Verify ============

// 核验通过动作 DTO;state transition pending → verified 由 service 控制。
// **不接收** certStatusCode / verifiedBy / verifiedAt / issuedAt / expiredAt(Q-A4 决议)。
// 轻量类:仅 verifyNote 可选(verify 通过时备注非必填)。
export class VerifyCertificateDto {
  @ApiPropertyOptional({ description: '核验备注(可选)', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  verifyNote?: string;
}

// ============ 入参:Reject ============

// 核验拒绝动作 DTO;verifyNote 必填(业务严格,DTO 严格记录拒绝理由)。
// **不接收** certStatusCode / verifiedBy / verifiedAt / issuedAt / expiredAt(Q-A4 决议)。
export class RejectCertificateDto {
  @ApiProperty({ description: '拒绝原因(必填)', maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  verifyNote!: string;
}

// ============ 入参:QualificationFlag(query 参数) ============

// 资质判定 query 参数 DTO。NestJS 默认不强制 @Query() 必填,
// 需走 DTO + 全局 ValidationPipe(transform + whitelist + forbidNonWhitelisted)兜底校验。
// 缺 certTypeCode → @IsString 失败 → 400。
export class QualificationFlagQueryDto {
  @ApiProperty({ description: '证书大类 code(必填)', maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  certTypeCode!: string;
}
