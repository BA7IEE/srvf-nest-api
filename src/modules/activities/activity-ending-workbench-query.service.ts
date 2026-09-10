import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { ActivityOutcomeAccessService } from './activity-outcome-access.service';
import { readCurrentConfirmedOutcomeInTx } from './activity-outcome-confirmed-query.service';
import { presentConfirmedActivityOutcome } from './activity-outcome-confirmed-presenter';
import { readActivityMetricSelection } from './activity-metric-selection';
import { presentEndingWorkbench } from './activity-ending-workbench-presenter';
import type { AppActivityEndingDraftSummaryDto } from './dto/app/app-ending-workbench.dto';

@Injectable()
export class ActivityEndingWorkbenchQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ActivityOutcomeAccessService,
  ) {}

  async get(activityId: string, user: CurrentUserPayload) {
    return this.prisma.$transaction(
      async (tx) => {
        await this.access.authorize(tx, user, activityId, 'activity.outcome.read');
        await tx.$queryRaw`SELECT "id" FROM "Activity" WHERE "id" = ${activityId} AND "deletedAt" IS NULL FOR UPDATE`;
        const { activity } = await this.access.authorize(
          tx,
          user,
          activityId,
          'activity.outcome.read',
        );
        try {
          const set = activity.selectedMetricSetVersionId
            ? await tx.activityMetricSetVersion.findUnique({
                where: { id: activity.selectedMetricSetVersionId },
                include: { items: { take: 101, include: { metricDefinition: true } } },
              })
            : null;
          const selection = readActivityMetricSelection(activity, set);
          const formalRow = await readCurrentConfirmedOutcomeInTx(tx, activityId);
          const formal = formalRow ? presentConfirmedActivityOutcome(formalRow) : null;
          const latest = await tx.activityOutcomeRevision.findFirst({
            where: { activityId },
            orderBy: { revision: 'desc' },
            select: { id: true, revision: true, statusCode: true },
          });
          let pendingDraft: AppActivityEndingDraftSummaryDto | null = null;
          if (latest?.statusCode === 'draft') {
            if (formalRow) {
              const receipt = await tx.activityOutcomeFinalizationReceipt.findFirst({
                where: {
                  activityId,
                  outcomeRevisionId: latest.id,
                  operationCode: 'prepare_outcome_correction',
                  baseConfirmedRevisionId: formalRow.id,
                },
                select: { id: true },
              });
              if (!receipt) throw new TypeError('unanchored correction draft');
            }
            pendingDraft = {
              id: latest.id,
              revision: latest.revision,
              kind: formalRow ? 'correction' : 'initial',
              baseConfirmedRevision: formalRow?.revision ?? null,
            };
          }
          await this.access.authorize(tx, user, activityId, 'activity.outcome.read');
          return presentEndingWorkbench({
            activityId: activity.id,
            activityStatusCode: activity.statusCode,
            metricRequirementCode: selection?.metricRequirementCode ?? 'unconfigured',
            metricSelectionRevision: activity.metricSelectionRevision,
            selectedMetricSetVersionId: activity.selectedMetricSetVersionId,
            currentConfirmed:
              formalRow && formal
                ? {
                    id: formalRow.id,
                    revision: formalRow.revision,
                    metricSetVersionId: formalRow.metricSetVersionId,
                    confirmedAt: formal.confirmedAt,
                    valueCount: formalRow.values.length,
                  }
                : null,
            pendingDraft,
          });
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
