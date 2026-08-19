import { ApiProperty } from '@nestjs/swagger';

import { MemberParticipationLedgerTotalsDto } from './participation-ledger-totals.dto';

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

  /**
   * 账本口径的「已生效 / 在途」两轴小计(第 7 批第 ②-a 刀,**纯加法**)。
   * 上面四个数字的取数、口径、字段名一律未动;本字段是并排摆出的另一条轴。
   * 恒存在、恒非 null(无数据时四个值都是 "0")。
   */
  @ApiProperty({
    description: '账本口径两轴小计(已生效 / 在途);恒存在,无数据时四个值均为 "0"',
    type: () => MemberParticipationLedgerTotalsDto,
  })
  ledgerTotals!: MemberParticipationLedgerTotalsDto;
}
