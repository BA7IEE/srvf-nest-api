import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import {
  ActivityPublishReviewResponseDto,
  ListActivityPublishReviewsQueryDto,
} from './activity-publish-review.dto';
import {
  ActivityPublishReviewPresenter,
  activityPublishReviewViewSelect,
} from './activity-publish-review-presenter';

@Injectable()
export class ActivityPublishReviewQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly presenter: ActivityPublishReviewPresenter,
  ) {}

  async list(
    query: ListActivityPublishReviewsQueryDto,
    user: CurrentUserPayload,
  ): Promise<PageResultDto<ActivityPublishReviewResponseDto>> {
    const scope = await this.authz.getVisibleOrganizationScope(
      user,
      'activity-review.read.request',
    );
    if (!scope.hasPermission) throw new BizException(BizCode.RBAC_FORBIDDEN);

    let requestedOrgIds: string[] | undefined;
    if (query.organizationId) {
      requestedOrgIds = query.includeDescendants
        ? (
            await this.prisma.organizationClosure.findMany({
              where: { ancestorId: query.organizationId },
              select: { descendantId: true },
            })
          ).map((row) => row.descendantId)
        : [query.organizationId];
    }
    const visibleOrgIds = scope.global
      ? requestedOrgIds
      : requestedOrgIds
        ? requestedOrgIds.filter((id) => scope.organizationIds.includes(id))
        : scope.organizationIds;

    const where: Prisma.ActivityPublishReviewWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.requestType ? { requestType: query.requestType } : {}),
      ...(query.submittedFrom || query.submittedTo
        ? {
            submittedAt: {
              ...(query.submittedFrom ? { gte: new Date(query.submittedFrom) } : {}),
              ...(query.submittedTo ? { lte: new Date(query.submittedTo) } : {}),
            },
          }
        : {}),
      activity: {
        ...(visibleOrgIds ? { organizationId: { in: visibleOrgIds } } : {}),
        ...(query.activityQ ? { title: { contains: query.activityQ, mode: 'insensitive' } } : {}),
        ...(query.initiatorQ
          ? {
              initiator: {
                OR: [
                  { displayName: { contains: query.initiatorQ, mode: 'insensitive' } },
                  { memberNo: { contains: query.initiatorQ, mode: 'insensitive' } },
                ],
              },
            }
          : {}),
      },
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.activityPublishReview.findMany({
        where,
        select: activityPublishReviewViewSelect,
        orderBy: { submittedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.activityPublishReview.count({ where }),
    ]);
    return {
      items: rows.map((row) => this.presenter.toDto(row)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async findOne(id: string, user: CurrentUserPayload): Promise<ActivityPublishReviewResponseDto> {
    const decision = await this.authz.explain(user, 'activity-review.read.request', {
      type: 'activity_publish_review',
      id,
    });
    if (!decision.allow) {
      throw new BizException(
        decision.reason === 'resource_not_found'
          ? BizCode.ACTIVITY_PUBLISH_REVIEW_NOT_FOUND
          : BizCode.RBAC_FORBIDDEN,
      );
    }
    const row = await this.prisma.activityPublishReview.findUnique({
      where: { id },
      select: activityPublishReviewViewSelect,
    });
    if (!row) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_NOT_FOUND);
    return this.presenter.toDto(row);
  }
}
