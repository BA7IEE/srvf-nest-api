import type { MetricCandidateCommandResult } from './activity-metric-candidate-command';
import type { ActivityMetricRuleCode } from './activity-metric-rule';

export interface MetricCandidateSafeValue {
  metricDefinitionId: string;
  definitionHash: string;
  value: string | number;
  valueHash: string;
  ruleCode: ActivityMetricRuleCode;
  evaluatorVersion: number;
  unitCode: 'count' | 'hours';
  scale: number;
}

/** No source identifiers, participant partitions, intervals or raw receipts cross this boundary. */
export function presentMetricCandidate(
  creation: MetricCandidateCommandResult,
  freshness: 'fresh' | 'stale' | 'unavailable',
  reproducible: boolean,
  values: readonly MetricCandidateSafeValue[],
) {
  return {
    schemaVersion: creation.schemaVersion,
    candidateId: creation.candidateId,
    activityId: creation.activityId,
    revision: creation.revision,
    metricSetVersionId: creation.metricSetVersionId,
    metricSetDefinitionHash: creation.metricSetDefinitionHash,
    createdStatusCode: creation.createdStatusCode,
    sourceCode: creation.sourceCode,
    valueCount: creation.valueCount,
    sourceCount: creation.sourceCount,
    createdAt: creation.createdAt,
    freshness,
    reproducible,
    values: values.map((value) => ({
      metricDefinitionId: value.metricDefinitionId,
      definitionHash: value.definitionHash,
      value: value.value,
      valueHash: value.valueHash,
      ruleCode: value.ruleCode,
      evaluatorVersion: value.evaluatorVersion,
      unitCode: value.unitCode,
      scale: value.scale,
    })),
  };
}
