import { ApiProperty } from '@nestjs/swagger';

/**
 * 账本口径的「已生效 / 在途」两轴小计(第 7 批第 ②-a 刀,Admin surface)。
 *
 * ## 这四个数与旁边那四个数是什么关系
 *
 * 旁边的 `totalServiceHours` / `activityCount` / `recordCount` / `contributionPoints` 是
 * **已审批考勤**口径(approved Sheet 内的记录),本刀**一个字没动**。
 * 本对象是**另一条轴**上的两个口径,来自正式账本:
 *
 * - **已生效**:批次 `committed` 的分录 —— 钱已经落账,不会再变。
 * - **在途**:批次停在 `preparing` / `ready` 的分录 —— 已终审、等入账。
 *
 * ## 🔴 三者**不构成**「已生效 + 在途 = 总数」这个等式
 *
 * 两条独立原因,PR 说明里有实测:
 *
 * 1. **阶段缺口**:批次要到**终审**才存在。「考勤已审批、但结算还没走到终审」的那一段
 *    在账本上根本没有分录 ⇒ 两个小计都不计它,但它**在**旁边那四个数里。
 * 2. **口径不同**:那四个数按 approved 考勤记录算(北京日封顶);这两个数按账本分录
 *    的 delta 求和(含冲正的负分录)。同一份事实走了两条不同的算法。
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
