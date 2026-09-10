import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { ActivityOutcomeAccessService } from './activity-outcome-access.service';
import { readCurrentConfirmedOutcomeInTx } from './activity-outcome-confirmed-query.service';
import { readActivityMetricSelection } from './activity-metric-selection';
import { presentActivityOutcomeReport } from './activity-outcome-report-presenter';
import type { AppActivityOutcomeReportDto } from './dto/app/app-activity-outcome-report.dto';

@Injectable()
export class ActivityOutcomeReportQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ActivityOutcomeAccessService,
  ) {}

  async get(activityId: string, user: CurrentUserPayload) {
    const result = await this.query([activityId], user);
    return result.items[0];
  }

  async query(activityIds: readonly string[], user: CurrentUserPayload) {
    if (
      !Array.isArray(activityIds) ||
      activityIds.length < 1 ||
      activityIds.length > 20 ||
      new Set(activityIds).size !== activityIds.length ||
      activityIds.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 64)
    )
      throw new BizException(BizCode.BAD_REQUEST);
    const ids = activityIds.map((id: string) => id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return this.prisma.$transaction(
      async (tx) => {
        for (const id of ids) await this.access.authorize(tx, user, id, 'activity.outcome.read');
        for (const id of ids) {
          await tx.$queryRaw`SELECT "id" FROM "Activity" WHERE "id" = ${id} AND "deletedAt" IS NULL FOR UPDATE`;
          await this.access.authorize(tx, user, id, 'activity.outcome.read');
        }
        const items: AppActivityOutcomeReportDto[] = [];
        try {
          for (const id of ids) {
            const { activity } = await this.access.authorize(tx, user, id, 'activity.outcome.read');
            const set = activity.selectedMetricSetVersionId
              ? await tx.activityMetricSetVersion.findUnique({
                  where: { id: activity.selectedMetricSetVersionId },
                  include: { items: { take: 101, include: { metricDefinition: true } } },
                })
              : null;
            const selection = readActivityMetricSelection(activity, set);
            const formal = await readCurrentConfirmedOutcomeInTx(tx, id);
            items.push(
              presentActivityOutcomeReport(
                {
                  activityId: activity.id,
                  activityStatusCode: activity.statusCode,
                  metricRequirementCode: selection?.metricRequirementCode ?? 'unconfigured',
                  metricSelectionRevision: activity.metricSelectionRevision,
                },
                formal,
              ),
            );
          }
          for (const id of ids) await this.access.authorize(tx, user, id, 'activity.outcome.read');
          return { items };
        } catch (error) {
          if (error instanceof TypeError || error instanceof RangeError)
            throw new BizException(BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
          throw error;
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30000 },
    );
  }
}
