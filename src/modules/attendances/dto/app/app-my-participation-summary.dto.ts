import { ApiProperty } from '@nestjs/swagger';

import { AppMyParticipationLedgerTotalsDto } from './app-participation-ledger-totals.dto';

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

  /**
   * 账本口径的「已生效 / 在途」两轴小计(第 7 批第 ②-a 刀,**纯加法**)。
   * 上面四个数字的取数、口径、字段名一律未动;本字段是并排摆出的另一条轴。
   * 恒存在、恒非 null(无数据时四个值都是 "0")。
   */
  @ApiProperty({
    description: '账本口径两轴小计(已生效 / 在途);恒存在,无数据时四个值均为 "0"',
    type: () => AppMyParticipationLedgerTotalsDto,
  })
  ledgerTotals!: AppMyParticipationLedgerTotalsDto;
}
