import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// 保险模块 T2 admin DTO(2026-06-13;冻结评审稿 docs/archive/reviews/insurance-module-review.md §3.2)。
// 范式:字段长度上限由 DTO 承担不落 @db.VarChar(沿批次 1/2/3 B 路径);
// 日期入参 ISO 8601 字符串,业务层 normalizeDateOnly 归一为北京日 UTC 午夜
// (沿 certificates issuedAt/expiredAt + date-only.util 收口口径);
// 跨字段校验(coverageStart ≤ coverageEnd)在 service 层(26010,E-18)。
// App DTO 独立在 dto/app/,禁止从本文件派生(D-6)。

// ============ 出参:队保单 ============

export class TeamInsurancePolicyResponseDto {
  @ApiProperty({ description: '保单 id(cuid)' })
  id!: string;

  @ApiProperty({ description: '保险公司' })
  insurerName!: string;

  @ApiProperty({ description: '保单号' })
  policyNumber!: string;

  @ApiProperty({ description: '起保日期(北京日归一 00:00:00.000Z)' })
  coverageStart!: Date;

  @ApiProperty({ description: '到期日期(有效性唯一依据;覆盖含当日)' })
  coverageEnd!: Date;

  @ApiPropertyOptional({ description: '备注', nullable: true })
  note!: string | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// ============ 出参:覆盖名单行 ============

export class TeamInsuranceCoverageResponseDto {
  @ApiProperty({ description: '覆盖行 id(cuid)' })
  id!: string;

  @ApiProperty({ description: '保单 id' })
  policyId!: string;

  @ApiProperty({ description: '队员 id' })
  memberId!: string;

  @ApiProperty({ description: '队员编号(展示用冗余,自 Member 关联读出)' })
  memberNo!: string;

  @ApiProperty({ description: '队员姓名(展示用冗余,自 Member 关联读出)' })
  memberDisplayName!: string;

  @ApiProperty({ description: '加入名单时间' })
  createdAt!: Date;
}

// ============ 出参:一键加结果 ============

export class AddAllActiveCoverageResultDto {
  @ApiProperty({ description: '本次实际加入名单的队员数(幂等:已在名单者跳过,二跑为 0)' })
  addedCount!: number;
}

// ============ 出参:队员自购保险(admin 视角;member-insurance.read.other)============

export class MemberInsuranceAdminResponseDto {
  @ApiProperty({ description: '保险记录 id(cuid)' })
  id!: string;

  @ApiProperty({ description: '队员 id' })
  memberId!: string;

  @ApiProperty({ description: '保险公司' })
  insurerName!: string;

  @ApiProperty({ description: '保单号' })
  policyNumber!: string;

  @ApiPropertyOptional({ description: '起保日期(可空 = 未填写,不参与起保校验)', nullable: true })
  coverageStart!: Date | null;

  @ApiProperty({ description: '到期日期(有效性唯一依据;覆盖含当日)' })
  coverageEnd!: Date;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// ============ 入参:队保单 Create ============

// 四字段必填(goal ②:保险公司 / 保单号 / 起保 / 到期)+ 备注可选。
export class CreateTeamInsurancePolicyDto {
  @ApiProperty({ description: '保险公司(必填)', maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  insurerName!: string;

  @ApiProperty({ description: '保单号(必填;无唯一约束,评审稿 E-2)', maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  policyNumber!: string;

  @ApiProperty({ description: '起保日期(ISO 8601;必填;业务层归一为北京日 00:00:00.000Z)' })
  @IsDateString()
  coverageStart!: string;

  @ApiProperty({ description: '到期日期(ISO 8601;必填;须 ≥ 起保日期,否则 26010)' })
  @IsDateString()
  coverageEnd!: string;

  @ApiPropertyOptional({ description: '备注', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// ============ 入参:队保单 Update(全字段可选;白名单同 Create)============

export class UpdateTeamInsurancePolicyDto {
  @ApiPropertyOptional({ description: '保险公司', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  insurerName?: string;

  @ApiPropertyOptional({ description: '保单号', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  policyNumber?: string;

  @ApiPropertyOptional({ description: '起保日期(ISO 8601)' })
  @IsOptional()
  @IsDateString()
  coverageStart?: string;

  @ApiPropertyOptional({ description: '到期日期(ISO 8601;更新后须 ≥ 起保日期,否则 26010)' })
  @IsOptional()
  @IsDateString()
  coverageEnd?: string;

  @ApiPropertyOptional({ description: '备注(传空串视为清空)', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// ============ 入参:覆盖名单单加 ============

export class AddTeamInsuranceCoverageDto {
  @ApiProperty({ description: '队员 id(cuid;须存在且未软删)', maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  memberId!: string;
}

// ============ 入参:列表 Query(分页;v1 无过滤参数,评审稿 E-14/E-16)============

// extends PaginationQueryDto 是唯一允许例外(common 跨模块公共 DTO,非 admin 模块 DTO)。
export class ListTeamInsurancePoliciesQueryDto extends PaginationQueryDto {}

export class ListTeamInsuranceCoverageQueryDto extends PaginationQueryDto {}
