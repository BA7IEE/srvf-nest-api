import { ApiProperty } from '@nestjs/swagger';

/**
 * 账本口径的「已生效 / 在途」两轴小计(第 7 批第 ②-a 刀,**App self surface**)。
 *
 * 与 Admin 侧 `MemberParticipationLedgerTotalsDto` **物理独立**(D-6:App DTO 禁派生自 Admin),
 * 字段名与语义逐字相同 —— 相同是**被用例钉住的**,不是靠"记得同步":
 * `test/e2e/activity-batch7-in-flight-display.e2e-spec.ts` 拿同一个队员同时打 App 面与
 * Admin 面,对这四个值做整包相等断言,任一端改算法当场红。
 *
 * 语义与「为什么不合并成一个数」的完整推导见 Admin 侧同名 DTO 的类注释。
 */
export class AppMyParticipationLedgerTotalsDto {
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
