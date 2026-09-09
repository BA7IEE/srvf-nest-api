import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { ActivityOutcomeAccessService } from './activity-outcome-access.service';
import { presentConfirmedActivityOutcome } from './activity-outcome-confirmed-presenter';

/** Caller authorizes; filtering by status is essential while a newer draft exists. */
export async function readCurrentConfirmedOutcomeInTx(
  tx: Prisma.TransactionClient,
  activityId: string,
) {
  const rows = await tx.activityOutcomeRevision.findMany({
    where: { activityId, statusCode: 'confirmed' },
    take: 2,
    include: {
      metricSetVersion: { include: { items: { take: 101, include: { metricDefinition: true } } } },
      values: { take: 101, include: { evidence: { take: 21, orderBy: { sortOrder: 'asc' } } } },
    },
  });
  if (rows.length > 1) throw new BizException(BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
  return rows[0] ?? null;
}

@Injectable()
export class ActivityOutcomeConfirmedQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ActivityOutcomeAccessService,
  ) {}

  async get(activityId: string, user: CurrentUserPayload) {
    return this.prisma.$transaction(
      async (tx) => {
        await this.access.authorize(tx, user, activityId, 'activity.outcome.read');
        await tx.$queryRaw`SELECT "id" FROM "Activity" WHERE "id" = ${activityId} AND "deletedAt" IS NULL FOR UPDATE`;
        await this.access.authorize(tx, user, activityId, 'activity.outcome.read');
        const row = await readCurrentConfirmedOutcomeInTx(tx, activityId);
        await this.access.authorize(tx, user, activityId, 'activity.outcome.read');
        if (!row) return null;
        try {
          return presentConfirmedActivityOutcome(row);
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
