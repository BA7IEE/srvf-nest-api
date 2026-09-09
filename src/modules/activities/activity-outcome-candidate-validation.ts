import type { Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { replayRetainedMetricCandidate } from './activity-metric-candidate-replay';
import type { ActivityMetricCandidateSourceQuery } from './activity-metric-candidate-source.query';

export interface OutcomeCandidateContext {
  activityId: string;
  metricRequirementCode: string;
  metricSetVersionId: string;
  metricSetDefinitionHash: string;
  latestRevision: number;
  /** Loaded from the current correction draft and its retained Source row, never from HTTP. */
  prepared?: { draftRevision: number; priorRevision: number; preparedAgainstRevision: number };
}

export function assertOutcomeCandidateRevision(
  expectedOutcomeRevision: number,
  context: Pick<OutcomeCandidateContext, 'latestRevision' | 'prepared'>,
): void {
  const { latestRevision, prepared } = context;
  const valid = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
  if (!valid(expectedOutcomeRevision) || !valid(latestRevision))
    throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_STALE);
  if (prepared) {
    if (
      !valid(prepared.priorRevision) ||
      prepared.draftRevision !== latestRevision ||
      prepared.draftRevision !== prepared.priorRevision + 1 ||
      prepared.preparedAgainstRevision !== prepared.priorRevision ||
      expectedOutcomeRevision !== prepared.preparedAgainstRevision
    )
      throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_STALE);
  } else if (expectedOutcomeRevision !== latestRevision) {
    throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_STALE);
  }
}

/** Caller holds Activity and metric-reference locks, authorizes, and rechecks identity after waits. */
export async function validateOutcomeCandidateInTx(
  tx: Prisma.TransactionClient,
  source: Pick<ActivityMetricCandidateSourceQuery, 'readTrusted'>,
  candidateId: string,
  context: OutcomeCandidateContext,
) {
  const candidate = await tx.activityMetricCandidate.findFirst({
    where: { id: candidateId, activityId: context.activityId },
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
  if (!candidate) throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_REFERENCE_UNAVAILABLE);
  if (
    context.metricRequirementCode !== 'required' ||
    candidate.metricSetVersionId !== context.metricSetVersionId ||
    candidate.metricSetDefinitionHash !== context.metricSetDefinitionHash ||
    candidate.metricSetVersion.statusCode !== 'active' ||
    candidate.values.some((value) => value.binding.definition.statusCode !== 'active')
  )
    throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_STALE);
  assertOutcomeCandidateRevision(candidate.expectedOutcomeRevision, context);
  if (candidate.valueCount < 1 || candidate.valueCount > 100 || candidate.sourceCount > 10000)
    throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_REFERENCE_UNAVAILABLE);
  const replay = replayRetainedMetricCandidate(candidate);
  if (!replay.reproducible)
    throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_REFERENCE_UNAVAILABLE);
  const current = await source.readTrusted(tx, context.activityId);
  if (current.sourceDigest !== candidate.sourceDigest)
    throw new BizException(BizCode.ACTIVITY_METRIC_CANDIDATE_STALE);
  return { candidate, values: replay.values };
}
