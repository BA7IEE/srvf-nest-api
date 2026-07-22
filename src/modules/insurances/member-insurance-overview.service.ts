import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { normalizeDateOnly } from '../../common/datetime/date-only.util';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AuthzService } from '../authz/authz.service';
import { RbacService } from '../permissions/rbac.service';
import {
  type InsuranceDateStatus,
  MemberInsuranceOverviewResponseDto,
  type MemberInsuranceOverviewSelfItemDto,
  type MemberInsuranceOverviewSummaryDto,
  type MemberInsuranceOverviewTeamItemDto,
} from './member-insurance-overview.dto';

const overviewSelfSelect = {
  id: true,
  insurerName: true,
  policyNumber: true,
  coverageStart: true,
  coverageEnd: true,
  createdAt: true,
  updatedAt: true,
  reviewStatusCode: true,
  version: true,
  reviewedByUserId: true,
  reviewedAt: true,
} as const satisfies Prisma.MemberInsuranceSelect;

const overviewTeamSelect = {
  id: true,
  policyId: true,
  createdAt: true,
  policy: {
    select: {
      id: true,
      insurerName: true,
      coverageStart: true,
      coverageEnd: true,
    },
  },
} as const satisfies Prisma.TeamInsuranceCoverageSelect;

type OverviewSelfRow = Prisma.MemberInsuranceGetPayload<{ select: typeof overviewSelfSelect }>;
type OverviewTeamRow = Prisma.TeamInsuranceCoverageGetPayload<{
  select: typeof overviewTeamSelect;
}>;

const DATE_STATUS_ORDER: Readonly<Record<InsuranceDateStatus, number>> = {
  active: 0,
  upcoming: 1,
  expired: 2,
};

@Injectable()
export class MemberInsuranceOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly rbac: RbacService,
    private readonly authz: AuthzService,
  ) {}

  async getForMember(
    memberId: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<MemberInsuranceOverviewResponseDto> {
    await this.assertCanReadMemberOrThrow(memberId, currentUser);

    const member = await this.prisma.member.findFirst({
      where: notDeletedWhere({ id: memberId }),
      select: { id: true },
    });
    if (!member) {
      throw new BizException(BizCode.MEMBER_NOT_FOUND);
    }

    const asOfDate = normalizeDateOnly(new Date().toISOString());
    const [selfRows, teamRows] = await this.prisma.$transaction([
      this.prisma.memberInsurance.findMany({
        where: { memberId, deletedAt: null },
        select: overviewSelfSelect,
      }),
      this.prisma.teamInsuranceCoverage.findMany({
        where: {
          memberId,
          deletedAt: null,
          policy: { deletedAt: null },
        },
        select: overviewTeamSelect,
      }),
    ]);

    const selfWithConfirmation = selfRows.map((row) => {
      const item = this.toSelfItem(row, asOfDate);
      return {
        item,
        confirmed:
          item.dateStatus === 'active' &&
          row.reviewStatusCode === 'verified' &&
          row.reviewedByUserId !== null &&
          row.reviewedAt !== null,
      };
    });
    const teamProvided = teamRows.map((row) => this.toTeamItem(row, asOfDate));
    const selfPurchased = selfWithConfirmation.map(({ item }) => item);

    selfPurchased.sort((left, right) => this.compareItems(left, right, left.id, right.id));
    teamProvided.sort((left, right) =>
      this.compareItems(left, right, left.coverageId, right.coverageId),
    );

    const summary = this.buildSummary(selfWithConfirmation, teamProvided);

    await this.auditLogs.log({
      event: 'member-insurance.read.other',
      actorUserId: currentUser.id,
      actorRoleSnap: currentUser.role,
      resourceType: 'member',
      resourceId: memberId,
      meta: auditMeta,
      extra: {
        operation: 'overview',
        selfPurchasedCount: selfPurchased.length,
        teamProvidedCount: teamProvided.length,
      },
    });

    return {
      memberId,
      asOfDate,
      summary,
      selfPurchased,
      teamProvided,
    };
  }

  private async assertCanReadMemberOrThrow(
    memberId: string,
    currentUser: CurrentUserPayload,
  ): Promise<void> {
    const action = 'member-insurance.read.other';
    const decision = await this.authz.explain(currentUser, action, {
      type: 'member',
      id: memberId,
    });
    if (
      !decision.allow &&
      !(decision.reason === 'resource_not_found' && (await this.rbac.can(currentUser, action)))
    ) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  private toSelfItem(row: OverviewSelfRow, asOfDate: Date): MemberInsuranceOverviewSelfItemDto {
    return {
      id: row.id,
      insurerName: row.insurerName,
      policyNumber: row.policyNumber,
      coverageStart: row.coverageStart,
      coverageEnd: row.coverageEnd,
      reviewStatusCode: row.reviewStatusCode,
      version: row.version,
      reviewedAt: row.reviewedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      dateStatus: this.resolveDateStatus(row.coverageStart, row.coverageEnd, asOfDate),
    };
  }

  private toTeamItem(row: OverviewTeamRow, asOfDate: Date): MemberInsuranceOverviewTeamItemDto {
    return {
      coverageId: row.id,
      policyId: row.policyId,
      insurerName: row.policy.insurerName,
      coverageStart: row.policy.coverageStart,
      coverageEnd: row.policy.coverageEnd,
      coverageAddedAt: row.createdAt,
      dateStatus: this.resolveDateStatus(
        row.policy.coverageStart,
        row.policy.coverageEnd,
        asOfDate,
      ),
    };
  }

  private resolveDateStatus(
    coverageStart: Date | null,
    coverageEnd: Date,
    asOfDate: Date,
  ): InsuranceDateStatus {
    if (coverageStart !== null && coverageStart.getTime() > asOfDate.getTime()) {
      return 'upcoming';
    }
    if (coverageEnd.getTime() < asOfDate.getTime()) {
      return 'expired';
    }
    return 'active';
  }

  private compareItems(
    left: { dateStatus: InsuranceDateStatus; coverageEnd: Date },
    right: { dateStatus: InsuranceDateStatus; coverageEnd: Date },
    leftId: string,
    rightId: string,
  ): number {
    const statusDifference =
      DATE_STATUS_ORDER[left.dateStatus] - DATE_STATUS_ORDER[right.dateStatus];
    if (statusDifference !== 0) return statusDifference;

    const coverageEndDifference = right.coverageEnd.getTime() - left.coverageEnd.getTime();
    if (coverageEndDifference !== 0) return coverageEndDifference;

    return leftId.localeCompare(rightId);
  }

  private buildSummary(
    selfItems: Array<{ item: MemberInsuranceOverviewSelfItemDto; confirmed: boolean }>,
    teamItems: MemberInsuranceOverviewTeamItemDto[],
  ): MemberInsuranceOverviewSummaryDto {
    const confirmedCoverageEnds = [
      ...selfItems.filter(({ confirmed }) => confirmed).map(({ item }) => item.coverageEnd),
      ...teamItems.filter((item) => item.dateStatus === 'active').map((item) => item.coverageEnd),
    ];
    const confirmedCoverageThrough = confirmedCoverageEnds.reduce<Date | null>(
      (latest, current) =>
        latest === null || current.getTime() > latest.getTime() ? current : latest,
      null,
    );

    return {
      dateActiveSelfPurchasedCount: selfItems.filter(({ item }) => item.dateStatus === 'active')
        .length,
      confirmedActiveSelfPurchasedCount: selfItems.filter(({ confirmed }) => confirmed).length,
      dateActiveTeamProvidedCount: teamItems.filter((item) => item.dateStatus === 'active').length,
      hasConfirmedCoverage: confirmedCoverageThrough !== null,
      confirmedCoverageThrough,
    };
  }
}
