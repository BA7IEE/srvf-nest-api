import type { Prisma } from '@prisma/client';
import type { MetricCandidateSafeValue } from './activity-metric-candidate-presenter';
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

export type RetainedMetricCandidate = Prisma.ActivityMetricCandidateGetPayload<{
  include: {
    values: { include: { binding: { include: { definition: true } } } };
    sources: true;
  };
}>;

/** Replays retained facts only; current-source and access checks belong to the caller. */
export function replayRetainedMetricCandidate(candidate: RetainedMetricCandidate) {
  const activityId = candidate.activityId;
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
  return { values, reproducible };
}
