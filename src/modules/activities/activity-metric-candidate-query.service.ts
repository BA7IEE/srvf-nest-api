import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { ActivityOutcomeAccessService } from './activity-outcome-access.service';
import { parseMetricCandidateReceipt } from './activity-metric-candidate-command';
import { ActivityMetricCandidateSourceQuery } from './activity-metric-candidate-source.query';
import { presentMetricCandidate } from './activity-metric-candidate-presenter';
import { replayRetainedMetricCandidate } from './activity-metric-candidate-replay';
@Injectable()
export class ActivityMetricCandidateQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ActivityOutcomeAccessService,
    private readonly source: ActivityMetricCandidateSourceQuery,
  ) {}

  async get(activityId: string, candidateId: string, user: CurrentUserPayload) {
    return this.prisma.$transaction(
      async (tx) => {
        await this.access.authorize(tx, user, activityId, 'activity.outcome.read');
        await tx.$queryRaw`SELECT "id" FROM "Activity" WHERE "id" = ${activityId} AND "deletedAt" IS NULL FOR UPDATE`;
        const context = await this.access.authorize(tx, user, activityId, 'activity.outcome.read');
        const candidate = await tx.activityMetricCandidate.findFirst({
          where: { id: candidateId, activityId },
          include: {
            metricSetVersion: { select: { statusCode: true } },
            values: {
              take: 101,
              orderBy: { definitionId: 'asc' },
              include: { binding: { include: { definition: true } } },
            },
            sources: { take: 10001, orderBy: { ordinal: 'asc' } },
          },
        });
        if (!candidate)
          throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_REFERENCE_UNAVAILABLE);
        const creation = parseMetricCandidateReceipt(
          {
            schemaVersion: 1,
            candidateId,
            activityId,
            revision: candidate.candidateRevision,
            metricSetVersionId: candidate.metricSetVersionId,
            metricSetDefinitionHash: candidate.metricSetDefinitionHash,
            createdStatusCode: 'candidate',
            sourceCode: 'system',
            valueCount: candidate.valueCount,
            sourceCount: candidate.sourceCount,
            createdAt: candidate.createdAt.toISOString(),
          },
          activityId,
          candidateId,
        );
        const { values, reproducible } = replayRetainedMetricCandidate(candidate);
        let freshness: 'fresh' | 'stale' | 'unavailable' = 'unavailable';
        if (reproducible) {
          const latestOutcome = await tx.activityOutcomeRevision.findFirst({
            where: { activityId },
            orderBy: { revision: 'desc' },
            select: { revision: true },
          });
          if (
            context.activity.metricRequirementCode !== 'required' ||
            context.activity.selectedMetricSetVersionId !== candidate.metricSetVersionId ||
            context.activity.selectedMetricSetDefinitionHash !==
              candidate.metricSetDefinitionHash ||
            (latestOutcome?.revision ?? 0) !== candidate.expectedOutcomeRevision ||
            candidate.metricSetVersion.statusCode !== 'active' ||
            candidate.values.some((row) => row.binding.definition.statusCode !== 'active')
          ) {
            freshness = 'stale';
          } else {
            try {
              const current = await this.source.readTrusted(tx, activityId);
              freshness = current.sourceDigest === candidate.sourceDigest ? 'fresh' : 'stale';
            } catch (error) {
              if (
                !(error instanceof BizException) ||
                ![
                  BizCode.ACTIVITY_METRIC_SOURCE_UNAVAILABLE.code,
                  BizCode.ACTIVITY_METRIC_SOURCE_INCOMPLETE.code,
                  BizCode.ACTIVITY_METRIC_SOURCE_LIMIT_EXCEEDED.code,
                ].some((code) => code === error.biz.code)
              )
                throw error;
            }
          }
        }
        return presentMetricCandidate(creation, freshness, reproducible, values);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30000 },
    );
  }
}
