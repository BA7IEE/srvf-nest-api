import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// 保险模块 T2 App 入参 DTO(POST /api/app/v1/me/insurances)。
// goal ①:保险公司 / 保单号 / 到期时间必填 + 起保日可选;自报即可,v1 无核验(D-INS-5)。
// 严格白名单 4 字段;**禁止** memberId / userId(self-scope 从 currentUser 推导,防 IDOR)。
// 跨字段校验(coverageStart ≤ coverageEnd)在 service 层(26010)。
export class CreateAppMeInsuranceDto {
  @ApiProperty({ description: '保险公司(必填)', maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  insurerName!: string;

  @ApiProperty({ description: '保单号(必填)', maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  policyNumber!: string;

  @ApiPropertyOptional({ description: '起保日期(ISO 8601;可选;填写后参与门槛起保校验)' })
  @IsOptional()
  @IsDateString()
  coverageStart?: string;

  @ApiProperty({ description: '到期日期(ISO 8601;必填;有效性唯一依据)' })
  @IsDateString()
  coverageEnd!: string;
}
