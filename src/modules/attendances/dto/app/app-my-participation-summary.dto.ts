import { ApiProperty } from '@nestjs/swagger';

// Mobile self-scope 独立 DTO：只给正向累计，不暴露 memberId/no-show/admin 字段。
export class AppMyParticipationSummaryDto {
  @ApiProperty({
    description: 'approved Sheet 内本人未软删记录 serviceHours 生涯合计',
    type: String,
  })
  totalServiceHours!: string;

  @ApiProperty({ description: 'approved Sheet 记录覆盖的 distinct activityId 数' })
  activityCount!: number;

  @ApiProperty({ description: 'approved Sheet 内本人未软删考勤记录数' })
  recordCount!: number;

  @ApiProperty({
    description: '本人生涯累计贡献值 capped 总分（computeCappedContribution cutoff=null）',
    type: String,
  })
  contributionPoints!: string;
}
