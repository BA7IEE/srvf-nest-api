import { ApiProperty } from '@nestjs/swagger';

// Admin member-axis DTO。App DTO 物理独立，不通过继承/Pick/Omit 复用。
export class MemberParticipationSummaryDto {
  @ApiProperty({ description: '队员 Member.id' })
  memberId!: string;

  @ApiProperty({ description: 'approved Sheet 内未软删记录 serviceHours 生涯合计', type: String })
  totalServiceHours!: string;

  @ApiProperty({ description: 'approved Sheet 记录覆盖的 distinct activityId 数' })
  activityCount!: number;

  @ApiProperty({ description: 'approved Sheet 内未软删考勤记录数' })
  recordCount!: number;

  @ApiProperty({
    description: '生涯累计贡献值 capped 总分（computeCappedContribution cutoff=null）',
    type: String,
  })
  contributionPoints!: string;
}
