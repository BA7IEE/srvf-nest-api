import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import type { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

const resultSelect = {
  id: true,
  participationIdentityId: true,
  revision: true,
  resultCode: true,
  lateFlag: true,
  earlyLeaveFlag: true,
  recognizedServiceHours: true,
  calculatedServiceHours: true,
  recognizedContributionPoints: true,
  calculatedContributionPoints: true,
  adjustmentReason: true,
  identity: {
    select: {
      member: { select: { id: true, memberNo: true, realName: true, nickname: true } },
      session: { select: { id: true, code: true, name: true } },
    },
  },
} as const satisfies Prisma.ParticipantSettlementResultRevisionSelect;

export type SettlementReviewResultRow = Prisma.ParticipantSettlementResultRevisionGetPayload<{
  select: typeof resultSelect;
}>;

const versionSourceSelect = {
  id: true,
  settlementRunId: true,
  contributionRegimeCode: true,
  settlementTimeRevisions: {
    where: { kindCode: 'submitted' },
    select: { id: true },
    orderBy: { revision: 'desc' },
    take: 1,
  },
  settlementContributionRevisions: {
    select: { id: true, effectiveTimeSettlementVersionId: true },
    orderBy: { revision: 'desc' },
    take: 1,
  },
  correctionApplied: {
    select: {
      statusCode: true,
      newPostingBatch: { select: { statusCode: true } },
      correctionRequest: { select: { baseSettlementVersionId: true } },
    },
    take: 2,
  },
} as const satisfies Prisma.AttendanceSettlementVersionSelect;

type VersionSource = Prisma.AttendanceSettlementVersionGetPayload<{
  select: typeof versionSourceSelect;
}>;
type TimeBucket = {
  participationIdentityId: string;
  categoryCode: string;
  calculatedSeconds: number | null;
  recognizedSeconds: number;
};

/** Module-private query: caller must authorize the exact requested version first. */
@Injectable()
export class SettlementReviewQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async results(settlementVersionId: string, page: PaginationQueryDto) {
    // No current-version pointer, current roster, posted-only or member deletedAt
    // filter: later correction/cancellation must not erase a submitted snapshot.
    const where = { settlementVersionId };
    const [items, total, version] = await this.prisma.$transaction([
      this.prisma.participantSettlementResultRevision.findMany({
        where,
        select: resultSelect,
        orderBy: [{ participationIdentityId: 'asc' }, { id: 'asc' }],
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      this.prisma.participantSettlementResultRevision.count({ where }),
      this.prisma.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: settlementVersionId },
        select: versionSourceSelect,
      }),
    ]);
    const identities = items.map((item) => item.participationIdentityId);
    const contribution = version.settlementContributionRevisions[0];
    const time = await this.readFrozenTime(version, identities);
    const nativePoints = contribution
      ? await this.prisma.participantContributionEvaluation.groupBy({
          by: ['participationIdentityId'],
          where: {
            contributionRevisionId: contribution.id,
            participationIdentityId: { in: identities },
          },
          _sum: { calculatedPoints: true, recognizedPoints: true },
        })
      : [];
    return {
      items,
      total,
      page: page.page,
      pageSize: page.pageSize,
      regimeCode: version.contributionRegimeCode,
      timeState: time.state,
      timeBuckets: time.buckets,
      contributionReady: contribution !== undefined,
      nativePoints,
    };
  }

  private async readFrozenTime(
    initial: VersionSource,
    identities: string[],
  ): Promise<{ state: 'legacy' | 'ready' | 'pending'; buckets: TimeBucket[] }> {
    let source = initial;
    let pendingCorrection = false;
    const visited = new Set<string>();
    const pending = { state: 'pending' as const, buckets: [] };
    for (;;) {
      if (visited.has(source.id))
        throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_REFERENCE_UNAVAILABLE);
      visited.add(source.id);
      const revision = source.settlementTimeRevisions[0];
      if (revision) {
        if (pendingCorrection) return pending;
        return {
          state: 'ready',
          buckets: await this.prisma.participantSettlementTimeBucket.findMany({
            where: { timeRevisionId: revision.id, participationIdentityId: { in: identities } },
            select: {
              participationIdentityId: true,
              categoryCode: true,
              calculatedSeconds: true,
              recognizedSeconds: true,
            },
            orderBy: [{ participationIdentityId: 'asc' }, { categoryCode: 'asc' }],
          }),
        };
      }
      const corrected = await this.prisma.participationTimeCorrectionManifest.findFirst({
        where: { settlementVersionId: source.id, settlementRunId: initial.settlementRunId },
        select: {
          contentHash: true,
          postingBatch: { select: { statusCode: true } },
          commitReceipt: { select: { contentHash: true } },
          entries: {
            where: { entryTypeCode: 'credit', participationIdentityId: { in: identities } },
            select: { participationIdentityId: true, categoryCode: true, secondsDelta: true },
            orderBy: [{ participationIdentityId: 'asc' }, { categoryCode: 'asc' }],
          },
        },
      });
      if (corrected) {
        if (pendingCorrection || corrected.postingBatch.statusCode !== 'committed') return pending;
        if (corrected.commitReceipt?.contentHash !== corrected.contentHash)
          throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_REFERENCE_UNAVAILABLE);
        // Credit is the absolute replacement. Do not add it to the base again.
        return {
          state: 'ready',
          buckets: corrected.entries.map((entry) => ({
            participationIdentityId: entry.participationIdentityId,
            categoryCode: entry.categoryCode,
            calculatedSeconds: null,
            recognizedSeconds: entry.secondsDelta,
          })),
        };
      }
      if (source.correctionApplied.length > 1)
        throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_REFERENCE_UNAVAILABLE);
      const application = source.correctionApplied[0];
      if (
        application &&
        (application.statusCode !== 'committed' ||
          application.newPostingBatch.statusCode !== 'committed')
      )
        pendingCorrection = true;
      const reference = source.settlementContributionRevisions[0]?.effectiveTimeSettlementVersionId;
      const nextId =
        reference && reference !== source.id
          ? reference
          : application?.correctionRequest.baseSettlementVersionId;
      if (!nextId)
        return {
          state: initial.contributionRegimeCode === 'policy_v1' ? 'pending' : 'legacy',
          buckets: [],
        };
      // Follow only explicit frozen references within the authorized run. This
      // also covers unchanged-time corrections with legacy contribution rules.
      const next = await this.prisma.attendanceSettlementVersion.findFirst({
        where: { id: nextId, settlementRunId: initial.settlementRunId },
        select: versionSourceSelect,
      });
      if (!next) throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_REFERENCE_UNAVAILABLE);
      source = next;
    }
  }
}
