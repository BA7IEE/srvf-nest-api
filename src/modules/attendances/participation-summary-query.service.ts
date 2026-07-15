import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
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
}

@Injectable()
export class ParticipationSummaryQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly rbac: RbacService,
    private readonly appIdentity: AppIdentityResolver,
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
    const [records, contribution] = await Promise.all([
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
    ]);
    const totalServiceHours = records.reduce(
      (sum, record) => sum.add(record.serviceHours),
      new Prisma.Decimal(0),
    );

    return {
      totalServiceHours: totalServiceHours.toString(),
      activityCount: new Set(records.map((record) => record.sheet.activityId)).size,
      recordCount: records.length,
      contributionPoints: contribution.toString(),
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
