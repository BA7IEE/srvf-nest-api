import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { normalizeDateOnly } from '../../common/datetime/date-only.util';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';

// 保险模块 T2:活动报名保险门槛校验 service(2026-06-13;InsurancesModule 唯一 export)。
// 冻结评审稿 docs/archive/reviews/insurance-module-review.md §4 / E-10~E-13。
//
// 调用方:activity-registrations.service create()(admin 代报名)与 createMy()(自助,
// App createMyForApp 薄壳经此)事务内调用(T3 已接线;依赖单向 activity-registration → insurances)。
// 本 service 纯读,**不**接 rbac(内部服务)、**不**写 audit。
//
// 语义冻结(E-11/E-12;快照:仅报名 create 时校验,approve/cancel/保险变化不回溯):
//   任一来源即可:
//     a) 自购:本人 member_insurances 存在 deletedAt IS NULL
//        AND coverageEnd >= 活动结束日 AND (coverageStart IS NULL OR coverageStart <= 活动开始日)
//     b) 队保单:覆盖行与保单均未软删 AND p.coverageEnd >= 活动结束日 AND p.coverageStart <= 活动开始日
//
// 日期粒度:**北京日历日**——存储侧 coverageStart/End 已 normalizeDateOnly 归一(北京日 UTC 午夜),
// 比较侧把活动 startAt/endAt 同样归一后比较,使"到期日 = 活动结束日当天"判定为覆盖
// (到期≥活动日期含等号,评审稿 E-11 边界语义;避免 00:00 存储值与活动具体时刻直接比较的隐性失覆盖)。

type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class InsuranceRequirementService {
  constructor(private readonly prisma: PrismaService) {}

  // 返回该队员是否被任一来源覆盖整个活动期(纯查询;T3 报名门槛断言与 e2e 复用)。
  async isMemberInsuredForActivity(
    memberId: string,
    activity: { startAt: Date; endAt: Date },
    tx?: PrismaTx,
  ): Promise<boolean> {
    const client = tx ?? this.prisma;
    const activityStartDay = normalizeDateOnly(activity.startAt.toISOString());
    const activityEndDay = normalizeDateOnly(activity.endAt.toISOString());

    const selfInsurance = await client.memberInsurance.findFirst({
      where: {
        memberId,
        deletedAt: null,
        coverageEnd: { gte: activityEndDay },
        OR: [{ coverageStart: null }, { coverageStart: { lte: activityStartDay } }],
      },
      select: { id: true },
    });
    if (selfInsurance) return true;

    const coverage = await client.teamInsuranceCoverage.findFirst({
      where: {
        memberId,
        deletedAt: null,
        policy: {
          deletedAt: null,
          coverageStart: { lte: activityStartDay },
          coverageEnd: { gte: activityEndDay },
        },
      },
      select: { id: true },
    });
    return coverage !== null;
  }

  // 报名门槛断言(T3;报名 create 事务内调用,E-10/E-12 快照语义)。
  // requiresInsurance=false → 零查询直接通过(既有活动 / 既有测试零回归保证,D-INS-1);
  // 任一来源覆盖 → 通过;否则 INSURANCE_REQUIRED=26030(过期与无保险不细分,E-8)。
  async assertMemberInsuredForActivity(
    memberId: string,
    activity: { requiresInsurance: boolean; startAt: Date; endAt: Date },
    tx?: PrismaTx,
  ): Promise<void> {
    if (!activity.requiresInsurance) return;
    const insured = await this.isMemberInsuredForActivity(memberId, activity, tx);
    if (!insured) {
      throw new BizException(BizCode.INSURANCE_REQUIRED);
    }
  }
}
