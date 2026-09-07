import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { ActivityOutcomeAccessService } from './activity-outcome-access.service';
import {
  presentActivityOutcomeDetail,
  presentActivityOutcomeSummary,
} from './activity-outcome-presenter';

@Injectable()
export class ActivityOutcomeQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ActivityOutcomeAccessService,
  ) {}

  async list(activityId: string, query: PaginationQueryDto, user: CurrentUserPayload) {
    const { page, pageSize } = query;
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100 ||
      !Number.isSafeInteger((page - 1) * pageSize)
    )
      throw new BizException(BizCode.BAD_REQUEST);
    return this.prisma.$transaction(
      async (tx) => {
        await this.access.authorize(tx, user, activityId, 'activity.outcome.read');
        const where = { activityId };
        const total = await tx.activityOutcomeRevision.count({ where });
        const rows = await tx.activityOutcomeRevision.findMany({
          where,
          orderBy: { revision: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        });
        await this.access.authorize(tx, user, activityId, 'activity.outcome.read');
        return { items: rows.map(presentActivityOutcomeSummary), total, page, pageSize };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async get(activityId: string, outcomeRevisionId: string, user: CurrentUserPayload) {
    return this.prisma.$transaction(async (tx) => {
      await this.access.authorize(tx, user, activityId, 'activity.outcome.read');
      const row = await tx.activityOutcomeRevision.findFirst({
        where: { id: outcomeRevisionId, activityId },
        include: {
          metricSetVersion: {
            include: { items: { take: 101, include: { metricDefinition: true } } },
          },
          values: { take: 101, include: { evidence: { take: 21, orderBy: { sortOrder: 'asc' } } } },
        },
      });
      if (!row) throw new BizException(BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
      await this.access.authorize(tx, user, activityId, 'activity.outcome.read');
      try {
        return presentActivityOutcomeDetail(row);
      } catch (error) {
        if (error instanceof TypeError)
          throw new BizException(BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
        throw error;
      }
    });
  }
}
