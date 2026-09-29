import { Injectable } from '@nestjs/common';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { ActivityTimeSettlementAccessService } from './activity-time-settlement-access.service';
import { TIME_SETTLEMENT_CATEGORIES } from './activity-time-settlement-policy';
import type { AppTimeLedgerReportDto } from './dto/app/app-activity-time-settlement.dto';

@Injectable()
export class ParticipationTimeLedgerQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ActivityTimeSettlementAccessService,
  ) {}

  async report(
    activityId: string,
    timeRevisionId: string,
    query: PaginationQueryDto,
    user: CurrentUserPayload,
  ): Promise<AppTimeLedgerReportDto> {
    return this.prisma.$transaction(async (tx) => {
      const revision = await tx.activitySettlementTimeRevision.findFirst({
        where: { id: timeRevisionId, activityId, kindCode: 'submitted' },
        select: { settlementVersionId: true },
      });
      if (!revision) {
        await this.access.authorize(tx, user, activityId, 'read');
        throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_REFERENCE_UNAVAILABLE);
      }
      await this.access.authorize(tx, user, activityId, 'read', revision.settlementVersionId);
      // Share only the bound batch, never a later run version; the manifest and entries are immutable.
      const batches = await tx.$queryRaw<{ id: string }[]>`
        SELECT b.id FROM "LedgerPostingBatch" b
        JOIN "ParticipationTimeLedgerManifest" m ON m."postingBatchId" = b.id
        WHERE m."activityId" = ${activityId} AND m."timeRevisionId" = ${timeRevisionId}
          AND b."statusCode" = 'committed' ORDER BY b.id FOR SHARE OF b
      `;
      if (batches.length !== 1)
        throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_REFERENCE_UNAVAILABLE);
      await this.access.authorize(tx, user, activityId, 'read', revision.settlementVersionId);
      const manifest = await tx.participationTimeLedgerManifest.findUnique({
        where: { postingBatchId: batches[0].id },
      });
      if (!manifest) throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_REFERENCE_UNAVAILABLE);
      if (manifest.expectedEntryCount > 8000)
        throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SCALE_LIMIT);
      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? 20;
      const entries = await tx.participationTimeLedgerEntry.findMany({
        where: { manifestId: manifest.id },
        orderBy: [{ participationIdentityId: 'asc' }, { categoryCode: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          bucketId: true,
          participationIdentityId: true,
          categoryCode: true,
          recognizedSeconds: true,
        },
      });
      const totals = await tx.$queryRaw<{ categoryCode: string; seconds: string }[]>`
        SELECT "categoryCode", SUM("recognizedSeconds")::text AS seconds
        FROM "ParticipationTimeLedgerEntry" WHERE "manifestId" = ${manifest.id} GROUP BY "categoryCode"
      `;
      return {
        postingBatchId: manifest.postingBatchId,
        manifestId: manifest.id,
        timeRevisionId: manifest.timeRevisionId,
        formatVersion: manifest.formatVersion,
        contentHash: manifest.contentHash,
        entryCount: manifest.expectedEntryCount,
        recognizedSecondsTotal: manifest.recognizedSecondsTotal.toString(),
        categories: TIME_SETTLEMENT_CATEGORIES.map((categoryCode) => ({
          categoryCode,
          recognizedSecondsTotal:
            totals.find((row) => row.categoryCode === categoryCode)?.seconds ?? '0',
        })),
        resultPage: { page, pageSize, total: manifest.expectedEntryCount, items: entries },
      };
    });
  }
}
