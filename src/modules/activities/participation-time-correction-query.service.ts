import { Injectable } from '@nestjs/common';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { ActivityTimeSettlementAccessService } from './activity-time-settlement-access.service';
import { TIME_SETTLEMENT_CATEGORIES } from './activity-time-settlement-policy';
import type { AppTimeCorrectionReportDto } from './dto/app/app-activity-time-settlement.dto';

@Injectable()
export class ParticipationTimeCorrectionQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ActivityTimeSettlementAccessService,
  ) {}

  async report(
    activityId: string,
    settlementVersionId: string,
    query: PaginationQueryDto,
    user: CurrentUserPayload,
  ): Promise<AppTimeCorrectionReportDto> {
    return this.prisma.$transaction(async (tx) => {
      const manifest = await tx.participationTimeCorrectionManifest.findFirst({
        where: {
          activityId,
          settlementVersionId,
          postingBatch: { statusCode: 'committed' },
          commitReceipt: { isNot: null },
        },
        include: {
          rootManifest: { select: { settlementVersionId: true } },
          commitReceipt: { select: { contentHash: true } },
        },
      });
      // The existing helper performs current App/read scope checks first, then
      // qualification for this root version. One call retains both checks.
      await this.access.authorize(
        tx,
        user,
        activityId,
        'read',
        manifest?.rootManifest.settlementVersionId,
      );
      if (!manifest || manifest.commitReceipt?.contentHash !== manifest.contentHash)
        throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_REFERENCE_UNAVAILABLE);
      const batches = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "LedgerPostingBatch" WHERE "id" = ${manifest.postingBatchId} AND "statusCode" = 'committed' FOR SHARE
      `;
      if (batches.length !== 1)
        throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_REFERENCE_UNAVAILABLE);
      await this.access.authorize(
        tx,
        user,
        activityId,
        'read',
        manifest.rootManifest.settlementVersionId,
      );
      if (manifest.expectedEntryCount > 16000)
        throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SCALE_LIMIT);
      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? 20;
      const entries = await tx.participationTimeCorrectionEntry.findMany({
        where: { manifestId: manifest.id },
        orderBy: [
          { participationIdentityId: 'asc' },
          { categoryCode: 'asc' },
          { entryTypeCode: 'asc' },
          { id: 'asc' },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          rootEntryId: true,
          reversesCorrectionEntryId: true,
          participationIdentityId: true,
          categoryCode: true,
          entryTypeCode: true,
          secondsDelta: true,
        },
      });
      const totals = await tx.$queryRaw<
        { categoryCode: string; reversal: string; replacement: string }[]
      >`
        SELECT "categoryCode", COALESCE(SUM("secondsDelta") FILTER (WHERE "entryTypeCode" = 'reversal'),0)::text AS reversal,
          COALESCE(SUM("secondsDelta") FILTER (WHERE "entryTypeCode" = 'credit'),0)::text AS replacement
        FROM "ParticipationTimeCorrectionEntry" WHERE "manifestId" = ${manifest.id} GROUP BY "categoryCode"
      `;
      return {
        manifestId: manifest.id,
        postingBatchId: manifest.postingBatchId,
        settlementVersionId,
        baseSettlementVersionId: manifest.baseSettlementVersionId,
        rootManifestId: manifest.rootManifestId,
        predecessorManifestId: manifest.predecessorManifestId,
        formatVersion: manifest.formatVersion,
        contentHash: manifest.contentHash,
        reversalSecondsTotal: manifest.reversalSecondsTotal.toString(),
        replacementSecondsTotal: manifest.replacementSecondsTotal.toString(),
        netSecondsDelta: (
          manifest.reversalSecondsTotal + manifest.replacementSecondsTotal
        ).toString(),
        categories: TIME_SETTLEMENT_CATEGORIES.map((categoryCode) => {
          const row = totals.find((total) => total.categoryCode === categoryCode);
          return {
            categoryCode,
            reversalSecondsTotal: row?.reversal ?? '0',
            replacementSecondsTotal: row?.replacement ?? '0',
            netSecondsDelta: (
              BigInt(row?.reversal ?? '0') + BigInt(row?.replacement ?? '0')
            ).toString(),
          };
        }),
        resultPage: { page, pageSize, total: manifest.expectedEntryCount, items: entries },
      };
    });
  }
}
