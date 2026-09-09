import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { ActivityOutcomeAccessService } from './activity-outcome-access.service';
import { parseMetricCandidateReceipt } from './activity-metric-candidate-command';
import { ActivityMetricCandidateSourceQuery } from './activity-metric-candidate-source.query';
import {
  MetricCandidateSafeValue,
  presentMetricCandidate,
} from './activity-metric-candidate-presenter';
import { fingerprintMetricEnvelope } from './activity-metric-definition';
import { metricDefinitionDocument } from './activity-metric-presenter';
import {
  evaluateActivityMetricRule,
  fingerprintMetricCandidateSources,
  MetricCandidateSourceInput,
  METRIC_SOURCE_MODE,
  METRIC_SOURCE_PROVIDER_VERSION,
  resolveActivityMetricRuleBinding,
} from './activity-metric-rule';

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
        const values: MetricCandidateSafeValue[] = [];
        let reproducible = false;
        try {
          if (
            candidate.values.length !== candidate.valueCount ||
            candidate.sources.length !== candidate.sourceCount ||
            candidate.sourceMode !== METRIC_SOURCE_MODE ||
            candidate.providerVersion !== METRIC_SOURCE_PROVIDER_VERSION
          )
            throw new TypeError('incomplete retained candidate');
          const sources: MetricCandidateSourceInput[] = candidate.sources.map((row) => {
            if (row.resultCode !== 'valid' && row.resultCode !== 'early_departure_zero')
              throw new TypeError('invalid retained source result');
            return {
              ordinal: row.ordinal,
              sourceRevisionId: row.sourceRevisionId,
              identityId: row.identityId,
              sessionId: row.sessionId,
              memberGroupOrdinal: row.memberGroupOrdinal,
              checkInAt: row.checkInAt.toISOString(),
              checkOutAt: row.checkOutAt.toISOString(),
              resultCode: row.resultCode,
            };
          });
          const fingerprint = fingerprintMetricCandidateSources(activityId, sources);
          if (
            fingerprint.sourceDigest !== candidate.sourceDigest ||
            candidate.sources.some(
              (row, i) => row.sourceFingerprint !== fingerprint.sourceFingerprints[i],
            )
          )
            throw new TypeError('retained source digest mismatch');
          const bindingRefs = candidate.values
            .map((row) => ({ id: row.bindingId, bindingHash: row.binding.bindingHash }))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          if (
            fingerprintMetricEnvelope('activity-metric-candidate-bindings-v1', bindingRefs)
              .definitionHash !== candidate.bindingsDigest
          )
            throw new TypeError('retained binding digest mismatch');
          for (const row of candidate.values) {
            const binding = resolveActivityMetricRuleBinding(
              row.definitionId,
              metricDefinitionDocument(row.binding.definition),
              row.definitionHash,
              row.binding.ruleCode,
              row.binding.evaluatorVersion,
            );
            if (
              binding.bindingHash !== row.binding.bindingHash ||
              binding.ruleDigest !== row.binding.ruleDigest
            )
              throw new TypeError('retained rule mismatch');
            const replay = evaluateActivityMetricRule(
              row.definitionId,
              metricDefinitionDocument(row.binding.definition),
              row.definitionHash,
              binding.ruleCode,
              binding.evaluatorVersion,
              sources,
            );
            if (typeof replay.valueJson !== 'number' && typeof replay.valueJson !== 'string')
              throw new TypeError('non-numeric retained rule value');
            if (replay.valueHash !== row.valueHash || replay.valueJson !== row.valueJson)
              throw new TypeError('retained value mismatch');
            values.push({
              metricDefinitionId: row.definitionId,
              definitionHash: row.definitionHash,
              value: replay.valueJson,
              valueHash: replay.valueHash,
              ruleCode: binding.ruleCode,
              evaluatorVersion: binding.evaluatorVersion,
              unitCode: binding.unitCode,
              scale: binding.scale,
            });
          }
          reproducible = true;
        } catch (error) {
          if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
          values.length = 0;
        }
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
