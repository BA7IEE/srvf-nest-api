import { ApiProperty } from '@nestjs/swagger';

import { MemberParticipationLedgerTotalsDto } from './participation-ledger-totals.dto';

// Admin member-axis DTO。App DTO 物理独立，不通过继承/Pick/Omit 复用。
export class MemberParticipationSummaryDto {
  @ApiProperty({ description: '队员 Member.id' })
  memberId!: string;

  @ApiProperty({
    description: '正式时长证明优先；无证明时为 committed 账本服务时长净额',
    type: String,
  })
  totalServiceHours!: string;

  @ApiProperty({ description: '当前正式版本中有已入账日行的不同活动数' })
  activityCount!: number;

  @ApiProperty({
    description: '当前正式版本已入账日行按参与身份和北京日去重数（包括合法零值日行）',
  })
  recordCount!: number;

  @ApiProperty({
    description:
      '生涯累计贡献值（只取 committed 账本 credited 正负净额，不叠加、不再封顶，无 cutoff；闸关返回 20153/503）',
    type: String,
  })
  contributionPoints!: string;

  /**
   * 账本口径的「已生效 / 在途」两轴小计(第 7 批第 ②-a 刀,**纯加法**)。
   * 当前汇总只从已入账账本与正式时长证明计算，本对象仍展示两轴。
   * 恒存在、恒非 null(无数据时四个值都是 "0")。
   */
  @ApiProperty({
    description: '账本口径两轴小计(已生效 / 在途);恒存在,无数据时四个值均为 "0"',
    type: () => MemberParticipationLedgerTotalsDto,
  })
  ledgerTotals!: MemberParticipationLedgerTotalsDto;
}
