import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import type { MemberLedgerTotalsBreakdown } from '../activities/ledger-query.service';
import { LedgerQueryService } from '../activities/ledger-query.service';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { RbacService } from '../permissions/rbac.service';
import { computeCappedContribution } from '../team-join/team-join-progress';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import { ATTENDANCE_SHEET_STATUS } from './attendances.dto';
import { AppMyParticipationSummaryDto } from './dto/app/app-my-participation-summary.dto';
import { MemberParticipationSummaryDto } from './participation-summary.dto';

interface PositiveParticipationSummary {
  totalServiceHours: string;
  activityCount: number;
  recordCount: number;
  contributionPoints: string;
  /** 第 7 批第 ②-a 刀新增的账本轴;上面四个数字未动。 */
  ledgerTotals: MemberLedgerTotalsBreakdown;
}

@Injectable()
export class ParticipationSummaryQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly rbac: RbacService,
    private readonly appIdentity: AppIdentityResolver,
    private readonly ledgerQuery: LedgerQueryService,
    // 活动 v1.1 cutover gate —— 统计读面取数源的判闸依据(合同 §16.2 单轨第三项)。
    private readonly activityWorkflowGate: ActivityWorkflowGate,
  ) {}

  private async assertCanReadMember(
    memberId: string,
    currentUser: CurrentUserPayload,
  ): Promise<void> {
    const action = 'attendance.read.sheet';
    const decision = await this.authz.explain(currentUser, action, {
      type: 'member',
      id: memberId,
    });
    if (decision.allow) return;
    if (decision.reason === 'resource_not_found' && (await this.rbac.can(currentUser, action))) {
      return;
    }
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  private async loadPositiveSummary(memberId: string): Promise<PositiveParticipationSummary> {
    // approved-only 记录取数 + 封顶核并行；贡献值绝不从 records 裸 SUM。
    //
    // 🔴 第 7 批 v1.1 cutover gate(合同 §16.2 第三项):**取数源由闸决定,不是两套并存**。
    //    闸关(默认)= 今天的行为,逐字保留 approved 考勤口径;闸开 = 已 committed 账本口径。
    //    ②-b 曾单独尝试「换源」并**实测停工** —— 因为两条流水线人群零交集,
    //    闸没开之前换源必然归零。故换源只能与新写路径同闸同轨,这正是本刀的形状。
    //
    // ⚠️ `contributionPoints` **不随闸切换**:维护者已拍板 computeCappedContribution
    //    与入队门槛恒按 approved 算。这条不一致是刻意的(判据 C4 反向锁住),别顺手统一。
    const [records, contribution, ledgerTotals] = await Promise.all([
      this.prisma.attendanceRecord.findMany({
        where: {
          memberId,
          deletedAt: null,
          sheet: { statusCode: ATTENDANCE_SHEET_STATUS.APPROVED, deletedAt: null },
        },
        select: {
          serviceHours: true,
          sheet: { select: { activityId: true } },
        },
      }),
      computeCappedContribution(this.prisma, memberId, null),
      this.ledgerQuery.loadMemberLedgerTotals(memberId),
    ]);
    const approvedServiceHours = records.reduce(
      (sum, record) => sum.add(record.serviceHours),
      new Prisma.Decimal(0),
    );

    const positive =
      this.activityWorkflowGate.participationReadSource() === 'committed-ledger'
        ? await this.loadCommittedPositive(memberId, ledgerTotals)
        : {
            totalServiceHours: approvedServiceHours.toString(),
            activityCount: new Set(records.map((record) => record.sheet.activityId)).size,
            recordCount: records.length,
          };

    return {
      ...positive,
      contributionPoints: contribution.toString(),
      ledgerTotals,
    };
  }

  /**
   * 闸开后的取数:三个数字全部来自**已 committed 的账本分录**。
   *
   * 小时数直接复用已经取到的 `committedServiceHours`(同一次 loadMemberLedgerTotals 的结果),
   * 计数另取一次 —— 两者过滤条件在 LedgerQueryService 内部逐字同源,不会半切换。
   */
  private async loadCommittedPositive(
    memberId: string,
    ledgerTotals: MemberLedgerTotalsBreakdown,
  ): Promise<Omit<PositiveParticipationSummary, 'contributionPoints' | 'ledgerTotals'>> {
    const counts = await this.ledgerQuery.countCommittedParticipationForMember(memberId);
    return {
      totalServiceHours: ledgerTotals.committedServiceHours,
      activityCount: counts.activityCount,
      recordCount: counts.recordCount,
    };
  }

  async forMemberAdmin(
    memberId: string,
    currentUser: CurrentUserPayload,
  ): Promise<MemberParticipationSummaryDto> {
    await this.assertCanReadMember(memberId, currentUser);
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, deletedAt: null },
      select: { id: true },
    });
    if (!member) throw new BizException(BizCode.MEMBER_NOT_FOUND);

    return { memberId, ...(await this.loadPositiveSummary(memberId)) };
  }

  async forCurrentMember(currentUser: CurrentUserPayload): Promise<AppMyParticipationSummaryDto> {
    const access = await this.appIdentity.resolve(currentUser);
    if (!access.canUseApp || access.member === null) {
      throw new BizException(BizCode.FORBIDDEN);
    }
    // self-scope 锁在 resolver 返回的本人 member.id，不接收任何 memberId 入参。
    return this.loadPositiveSummary(access.member.id);
  }
}
