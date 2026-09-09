import {
  fingerprintMetricEnvelope,
  fingerprintParsedMetricMetadata,
  metricInteger,
  metricText,
  parseActivityMetricDefinition,
} from './activity-metric-definition';
import { fingerprintActivityOutcomeValue } from './activity-outcome-value';

export const METRIC_CANDIDATE_LIMITS = Object.freeze({
  bindings: 100,
  members: 2000,
  segments: 10000,
  events: 20000,
  eventsPerIdentity: 1000,
});
export const METRIC_SOURCE_MODE = 'participation_segments';
export const METRIC_SOURCE_PROVIDER_VERSION = 1;
export type ActivityMetricRuleCode =
  | 'actual_participant_count_v1'
  | 'actual_participation_hours_v1';

/** Version 1 is append-only: retain this evaluator when introducing subsequent versions. */
export function getActivityMetricRule(
  ruleCode: unknown,
  evaluatorVersion: unknown,
): { ruleCode: ActivityMetricRuleCode; evaluatorVersion: number; ruleDigest: string } {
  if (
    evaluatorVersion !== 1 ||
    (ruleCode !== 'actual_participant_count_v1' && ruleCode !== 'actual_participation_hours_v1')
  )
    throw new TypeError('unsupported metric rule version');
  const manifest = {
    ruleCode,
    evaluatorVersion: 1,
    sourceMode: METRIC_SOURCE_MODE,
    providerVersion: METRIC_SOURCE_PROVIDER_VERSION,
    currentStatuses: ['draft', 'committed'],
    resultCodes: ['valid', 'early_departure_zero'],
    interval: 'positive_closed_utc_half_open',
    grouping: 'member_partition_by_min_source_revision_id',
    aggregation:
      ruleCode === 'actual_participant_count_v1'
        ? 'distinct_member_groups'
        : 'member_interval_union_integer_ms_once_half_up',
  };
  return {
    ruleCode,
    evaluatorVersion: 1,
    ruleDigest: fingerprintMetricEnvelope('activity-metric-rule-v1', manifest).definitionHash,
  };
}

export function resolveActivityMetricRuleBinding(
  metricDefinitionId: string,
  definitionInput: unknown,
  definitionHash: string,
  ruleCode: unknown,
  evaluatorVersion: unknown,
) {
  const definition = parseActivityMetricDefinition(definitionInput);
  if (fingerprintParsedMetricMetadata(definition).definitionHash !== definitionHash)
    throw new TypeError('metric definition hash mismatch');
  const rule = getActivityMetricRule(ruleCode, evaluatorVersion);
  const config = definition.configuration;
  let unitCode: 'count' | 'hours';
  let scale: number;
  if (rule.ruleCode === 'actual_participant_count_v1') {
    if (config.kindCode !== 'non_negative_integer' || config.unit !== '人')
      throw new TypeError('participant count requires integer 人 definition');
    unitCode = 'count';
    scale = 0;
  } else {
    if (config.kindCode !== 'non_negative_decimal' || config.unit !== '小时')
      throw new TypeError('participation hours requires decimal 小时 definition');
    unitCode = 'hours';
    scale = config.scale;
  }
  const binding = {
    schemaVersion: 1,
    metricDefinitionId: metricText(metricDefinitionId, 64),
    definitionHash,
    ...rule,
    unitCode,
    scale,
  };
  return {
    ...binding,
    bindingHash: fingerprintMetricEnvelope('activity-metric-rule-binding-v1', binding)
      .definitionHash,
  };
}

export interface MetricSourceInterval {
  sourceRevisionId: string;
  identityId: string;
  sessionId: string;
  memberId: string;
  checkInAt: Date;
  checkOutAt: Date;
  resultCode: 'valid' | 'early_departure_zero';
}

export interface MetricCandidateSourceInput {
  ordinal: number;
  sourceRevisionId: string;
  identityId: string;
  sessionId: string;
  memberGroupOrdinal: number;
  checkInAt: string;
  checkOutAt: string;
  resultCode: 'valid' | 'early_departure_zero';
}

function compareText(a: string, b: string): number {
  // Match PostgreSQL COLLATE "C", including non-ASCII identifiers.
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Only the source owner may call this after proving availability, closure and query budgets. */
export function normalizeMetricCandidateSources(input: readonly MetricSourceInterval[]) {
  if (input.length > METRIC_CANDIDATE_LIMITS.segments)
    throw new RangeError('metric source limit exceeded');
  const groups = new Map<string, MetricSourceInterval[]>();
  const seen = new Set<string>();
  for (const row of input) {
    metricText(row.sourceRevisionId, 64);
    metricText(row.identityId, 64);
    metricText(row.sessionId, 64);
    metricText(row.memberId, 64);
    if (seen.has(row.sourceRevisionId)) throw new TypeError('duplicate metric source');
    seen.add(row.sourceRevisionId);
    if (
      !(row.checkInAt instanceof Date) ||
      !(row.checkOutAt instanceof Date) ||
      !Number.isFinite(row.checkInAt.getTime()) ||
      !Number.isFinite(row.checkOutAt.getTime()) ||
      row.checkOutAt.getTime() <= row.checkInAt.getTime() ||
      (row.resultCode !== 'valid' && row.resultCode !== 'early_departure_zero')
    )
      throw new TypeError('invalid metric source interval');
    const group = groups.get(row.memberId) ?? [];
    group.push(row);
    groups.set(row.memberId, group);
  }
  if (groups.size > METRIC_CANDIDATE_LIMITS.members)
    throw new RangeError('metric member limit exceeded');
  const ordered = [...groups.values()]
    .map((group) => group.sort((a, b) => compareText(a.sourceRevisionId, b.sourceRevisionId)))
    .sort((a, b) => compareText(a[0].sourceRevisionId, b[0].sourceRevisionId));
  const sources: MetricCandidateSourceInput[] = [];
  ordered.forEach((group, memberGroupOrdinal) => {
    for (const row of group)
      sources.push({
        ordinal: sources.length,
        sourceRevisionId: row.sourceRevisionId,
        identityId: row.identityId,
        sessionId: row.sessionId,
        memberGroupOrdinal,
        checkInAt: row.checkInAt.toISOString(),
        checkOutAt: row.checkOutAt.toISOString(),
        resultCode: row.resultCode,
      });
  });
  return sources;
}

export function fingerprintMetricCandidateSources(
  activityId: string,
  sources: readonly MetricCandidateSourceInput[],
) {
  // Validate retained inputs too: corrupted history must never silently replay as zero.
  aggregateMetricCandidateSources(sources);
  const sourceFingerprints = sources.map(
    (source) =>
      fingerprintMetricEnvelope('activity-metric-candidate-source-row-v1', source).definitionHash,
  );
  return {
    sourceFingerprints,
    sourceDigest: fingerprintMetricEnvelope('activity-metric-candidate-source-v1', {
      activityId: metricText(activityId, 64),
      sourceMode: METRIC_SOURCE_MODE,
      providerVersion: METRIC_SOURCE_PROVIDER_VERSION,
      sources,
    }).definitionHash,
  };
}

/** Replays only retained inputs; no database, current membership, wall clock or serviceHours. */
export function aggregateMetricCandidateSources(sources: readonly MetricCandidateSourceInput[]) {
  if (sources.length > METRIC_CANDIDATE_LIMITS.segments)
    throw new RangeError('metric source limit exceeded');
  const groups = new Map<number, { start: bigint; end: bigint }[]>();
  const seen = new Set<string>();
  for (const [ordinal, source] of sources.entries()) {
    if (source.ordinal !== ordinal) throw new TypeError('noncontinuous source ordinal');
    metricText(source.sourceRevisionId, 64);
    metricText(source.identityId, 64);
    metricText(source.sessionId, 64);
    metricInteger(source.memberGroupOrdinal, 0, METRIC_CANDIDATE_LIMITS.members - 1);
    if (seen.has(source.sourceRevisionId)) throw new TypeError('duplicate metric source');
    seen.add(source.sourceRevisionId);
    const start = new Date(source.checkInAt);
    const end = new Date(source.checkOutAt);
    if (
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      start.toISOString() !== source.checkInAt ||
      end.toISOString() !== source.checkOutAt ||
      end.getTime() <= start.getTime() ||
      (source.resultCode !== 'valid' && source.resultCode !== 'early_departure_zero')
    )
      throw new TypeError('invalid retained metric source');
    const intervals = groups.get(source.memberGroupOrdinal) ?? [];
    intervals.push({ start: BigInt(start.getTime()), end: BigInt(end.getTime()) });
    groups.set(source.memberGroupOrdinal, intervals);
  }
  let milliseconds = 0n;
  for (let group = 0; group < groups.size; group += 1) {
    const intervals = groups.get(group);
    if (!intervals) throw new TypeError('noncontinuous member groups');
    intervals.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    let { start, end } = intervals[0];
    for (const interval of intervals.slice(1)) {
      if (interval.start <= end) {
        if (interval.end > end) end = interval.end;
      } else {
        milliseconds += end - start;
        start = interval.start;
        end = interval.end;
      }
    }
    milliseconds += end - start;
  }
  return { participantCount: groups.size, milliseconds };
}

export function evaluateActivityMetricRule(
  definitionId: string,
  definitionInput: unknown,
  definitionHash: string,
  ruleCode: unknown,
  evaluatorVersion: unknown,
  sources: readonly MetricCandidateSourceInput[],
) {
  const binding = resolveActivityMetricRuleBinding(
    definitionId,
    definitionInput,
    definitionHash,
    ruleCode,
    evaluatorVersion,
  );
  const { participantCount, milliseconds } = aggregateMetricCandidateSources(sources);
  let value: string | number = participantCount;
  if (binding.unitCode === 'hours') {
    // Exact positive HALF_UP, once after union and aggregation; no floating-point division.
    const factor = 10n ** BigInt(binding.scale);
    const scaled = (milliseconds * factor + 1800000n) / 3600000n;
    const whole = scaled / factor;
    const fraction = (scaled % factor).toString().padStart(binding.scale, '0').replace(/0+$/, '');
    value = fraction ? `${whole}.${fraction}` : whole.toString();
  }
  return fingerprintActivityOutcomeValue(definitionInput, definitionHash, value);
}
