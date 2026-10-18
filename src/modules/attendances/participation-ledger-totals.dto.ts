import { ApiProperty } from '@nestjs/swagger';

/**
 * 账本口径的「已生效 / 在途」两轴小计(第 7 批第 ②-a 刀,Admin surface)。
 *
 * ## 这四个数与旁边那四个数是什么关系
 *
 * 旁边的 `totalServiceHours` / `activityCount` / `recordCount` / `contributionPoints` 是
 * 在第 7 批交付时均为已审批考勤口径，当时未改；此段保留历史决定。
 * R5 后贡献随单闸切源：off 读旧考勤封顶，on 仅 committed credited；本对象仍展示账本两轴：
 *
 * - **已生效**:批次 `committed` 的分录 —— 钱已经落账,不会再变。
 * - **在途**:批次停在 `preparing` / `ready` 的分录 —— 已终审、等入账。
 *
 * ## 🔴 三者**不构成**「已生效 + 在途 = 总数」这个等式
 *
 * 两条独立原因,PR 说明里有实测:
 *
 * 1. **阶段缺口**:批次要到**终审**才存在。「考勤已审批、但结算还没走到终审」的那一段
 *    在账本上没有分录 ⇒ 两个小计都不计它；闸关时旁边贡献仍可计入旧考勤。
 * 2. **口径不同**（原交付时）:贡献按 approved 考勤封顶；R5 闸开后贡献与 committed 小计均按账本
 *    credited delta 求和（含冲正）；不二次封顶，不与旧考勤相加，也不把在途加到已生效。
 *
 * 所以本刀**不合并数字**,只把两条轴并排摆出来 —— 这正是维护者 2026-08-19 的拍板:
 * 「数字不合并、但让人看得见」。
 */
export class MemberParticipationLedgerTotalsDto {
  @ApiProperty({
    description: '已生效(committed 批次)服务时长小计;无数据恒为 "0"',
    type: 'string',
    example: '6',
  })
  committedServiceHours!: string;

  @ApiProperty({
    description: '已生效(committed 批次)贡献值小计(credited 口径,封顶后);无数据恒为 "0"',
    type: 'string',
    example: '3',
  })
  committedContributionPoints!: string;

  @ApiProperty({
    description:
      '在途(批次停在 preparing / ready,已终审待入账)服务时长小计;无数据恒为 "0",不是 null',
    type: 'string',
    example: '2',
  })
  inFlightServiceHours!: string;

  @ApiProperty({
    description: '在途(批次停在 preparing / ready,已终审待入账)贡献值小计;无数据恒为 "0"',
    type: 'string',
    example: '1',
  })
  inFlightContributionPoints!: string;
}
