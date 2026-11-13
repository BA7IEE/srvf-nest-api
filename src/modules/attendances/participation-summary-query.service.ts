import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import type { MemberLedgerTotalsBreakdown } from '../activities/ledger-query.service';
import { LedgerQueryService } from '../activities/ledger-query.service';
import {
  ParticipationTimeTruthQueryService,
  eligibleSecondsToServiceHours,
  sumOfficialEligibleSeconds,
} from '../activities/participation-time-truth-query.service';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { RbacService } from '../permissions/rbac.service';
import { computeCappedContribution } from '../team-join/team-join-progress';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import { nonDeletedMemberExists } from '../members/member-existence-query';
import { AppMyParticipationSummaryDto } from './dto/app/app-my-participation-summary.dto';
import { MemberParticipationSummaryDto } from './participation-summary.dto';
import type { MemberContributionSummaryDto } from './attendances.dto';

interface PositiveParticipationSummary {
  totalServiceHours: string;
  activityCount: number;
  recordCount: number;
  contributionPoints: string;
  /** 第7批新增的账本轴；R5贡献字段现随单闸切换，账本轴字段不变。 */
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
    private readonly participationTimeTruth: ParticipationTimeTruthQueryService,
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
    // A disabled workflow is unavailable; never substitute retired attendance data.
    // Read-only maintenance preserves reads when the ledger workflow is enabled.
    if (this.activityWorkflowGate.participationReadSource() !== 'committed-ledger') {
      throw new BizException(BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED);
    }
    const [contribution, ledgerTotals, officialTime] = await Promise.all([
      computeCappedContribution(
        this.prisma,
        memberId,
        null,
        this.activityWorkflowGate,
        LedgerQueryService,
      ),
      this.ledgerQuery.loadMemberLedgerTotals(memberId),
      this.prisma.$transaction(
        (tx) => this.participationTimeTruth.readOfficialTotalsInTx(tx, { memberIds: [memberId] }),
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      ),
    ]);
    const committedPositive = await this.loadCommittedPositive(memberId, ledgerTotals);
    const positive =
      officialTime === null
        ? committedPositive
        : {
            ...committedPositive,
            totalServiceHours: eligibleSecondsToServiceHours(
              sumOfficialEligibleSeconds(officialTime.totals),
            ).toString(),
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
   * 小时数复用已入账分录正负净额，计数另取当前正式版本的身份日行。
   * 两次读取并非同一个数据库快照；并发更正期间不保证两个字段来自同一版本。
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

  private async assertReadableMember(
    memberId: string,
    currentUser: CurrentUserPayload,
  ): Promise<void> {
    await this.assertCanReadMember(memberId, currentUser);
    if (!(await nonDeletedMemberExists(this.prisma, memberId))) {
      throw new BizException(BizCode.MEMBER_NOT_FOUND);
    }
  }

  async forMemberAdmin(
    memberId: string,
    currentUser: CurrentUserPayload,
  ): Promise<MemberParticipationSummaryDto> {
    await this.assertReadableMember(memberId, currentUser);
    return { memberId, ...(await this.loadPositiveSummary(memberId)) };
  }

  async contributionForMemberAdmin(
    memberId: string,
    currentUser: CurrentUserPayload,
  ): Promise<MemberContributionSummaryDto> {
    await this.assertReadableMember(memberId, currentUser);
    if (this.activityWorkflowGate.participationReadSource() !== 'committed-ledger') {
      throw new BizException(BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED);
    }
    const [points, ledgerTotals] = await Promise.all([
      computeCappedContribution(
        this.prisma,
        memberId,
        null,
        this.activityWorkflowGate,
        LedgerQueryService,
      ),
      this.ledgerQuery.loadMemberLedgerTotals(memberId),
    ]);
    return { memberId, contributionPoints: points.toString(), ledgerTotals };
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
