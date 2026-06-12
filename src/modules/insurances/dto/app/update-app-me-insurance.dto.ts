import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// 保险模块 T2 App 入参 DTO(PATCH /api/app/v1/me/insurances/:id)。
// 全字段可选,白名单同 Create 4 字段;**不**从 CreateAppMeInsuranceDto 派生
// (PartialType 等映射工具越权,沿 AGENTS §2 / §19.7 D-6,显式平铺)。
export class UpdateAppMeInsuranceDto {
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
}
