import { Injectable } from '@nestjs/common';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PageResultDto, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import { ATTENDANCE_SHEET_STATUS } from '../attendances/attendances.dto';
import { RbacService } from '../permissions/rbac.service';
import {
  ActivityFeedbackAggregateDto,
  AdminActivityFeedbackListItemDto,
  AdminActivityFeedbackSummaryDto,
} from './activity-feedback.dto';

const ATTENDANCE_READ_SHEET_ACTION = 'attendance.read.sheet';

@Injectable()
export class ActivityFeedbacksQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly rbac: RbacService,
  ) {}

  async list(
    activityId: string,
    query: PaginationQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AdminActivityFeedbackListItemDto>> {
    await this.assertCanReadActivity(activityId, currentUser);
    await this.findActivityOrThrow(activityId);

    // 正常路径固定 3 次业务读：Activity exists + items + count；Member 摘要 relation select 批量取。
    const where = { activityId, deletedAt: null } as const;
    const [rows, total] = await Promise.all([
      this.prisma.activityFeedback.findMany({
        where,
        select: {
          rating: true,
          comment: true,
          createdAt: true,
          updatedAt: true,
          member: { select: { memberNo: true, displayName: true } },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.activityFeedback.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        memberNo: row.member.memberNo,
        displayName: row.member.displayName,
        rating: row.rating,
        comment: row.comment,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async summary(
    activityId: string,
    currentUser: CurrentUserPayload,
  ): Promise<AdminActivityFeedbackSummaryDto> {
    await this.assertCanReadActivity(activityId, currentUser);
    await this.findActivityOrThrow(activityId);

    // 正常路径固定 4 次业务读：Activity exists + aggregate + 1 次 groupBy + approved distinct members。
    const [aggregate, grouped, approvedMembers] = await Promise.all([
      this.aggregateForActivity(activityId),
      this.prisma.activityFeedback.groupBy({
        by: ['rating'],
        where: { activityId, deletedAt: null },
        _count: { _all: true },
        orderBy: { rating: 'asc' },
      }),
      this.prisma.attendanceRecord.findMany({
        where: {
          deletedAt: null,
          sheet: {
            activityId,
            deletedAt: null,
            statusCode: ATTENDANCE_SHEET_STATUS.APPROVED,
          },
        },
        select: { memberId: true },
        distinct: ['memberId'],
      }),
    ]);
    const counts = new Map(grouped.map((row) => [row.rating, row._count._all]));
    const denominator = approvedMembers.length;

    return {
      ...aggregate,
      ratingDistribution: [1, 2, 3, 4, 5].map((rating) => ({
        rating,
        count: counts.get(rating) ?? 0,
      })),
      feedbackRate: denominator === 0 ? 0 : this.round(aggregate.count / denominator, 4),
    };
  }

  // Activities participation-summary 的唯一复用出口：恰好 1 次 aggregate，不做鉴权/存在性重复查询。
  async aggregateForActivity(activityId: string): Promise<ActivityFeedbackAggregateDto> {
    const aggregate = await this.prisma.activityFeedback.aggregate({
      where: { activityId, deletedAt: null },
      _count: { _all: true },
      _avg: { rating: true },
    });
    return {
      count: aggregate._count._all,
      avgRating: aggregate._avg.rating === null ? null : this.round(aggregate._avg.rating, 2),
    };
  }

  private async assertCanReadActivity(
    activityId: string,
    currentUser: CurrentUserPayload,
  ): Promise<void> {
    const decision = await this.authz.explain(currentUser, ATTENDANCE_READ_SHEET_ACTION, {
      type: 'activity',
      id: activityId,
    });
    if (decision.allow) return;
    if (
      decision.reason === 'resource_not_found' &&
      (await this.rbac.can(currentUser, ATTENDANCE_READ_SHEET_ACTION))
    ) {
      return;
    }
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  private async findActivityOrThrow(activityId: string): Promise<void> {
    const activity = await this.prisma.activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: { id: true },
    });
    if (activity === null) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
  }

  private round(value: number, digits: number): number {
    const factor = 10 ** digits;
    return Math.round((value + Number.EPSILON) * factor) / factor;
  }
}
