import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { CurrentParticipationSegment } from '../attendances/participation-segment.facade';
import { fingerprintMetricEnvelope, metricText } from './activity-metric-definition';
import {
  buildActivityTimeAllocationManifest,
  type ActivityTimeAllocationSliceInput,
} from './activity-time-allocation-command';
import {
  assertAllocationSlicesWithinSource,
  assertManualTimeAllocationAllowed,
  automaticTimeAllocationSlices,
} from './activity-time-allocation-policy';
import {
  fingerprintTimePolicyVersion,
  type TimePolicyCategory,
} from './activity-time-policy-definition';

export const TIME_SETTLEMENT_CATEGORIES = [
  'volunteer_service',
  'training',
  'organization',
  'non_creditable',
] as const;
export const TIME_SETTLEMENT_LIMITS = Object.freeze({
  identities: 2000,
  segments: 10000,
  slices: 50000,
  buckets: 8000,
  sources: 40000,
});

export type TimeSettlementPolicyFailure =
  | 'invalid'
  | 'source_not_ready'
  | 'policy_mixed'
  | 'overlap'
  | 'scale_limit';

/** Pure domain failure; the application boundary maps it to the approved HTTP BizCode. */
export class TimeSettlementPolicyError extends TypeError {
  constructor(readonly reason: TimeSettlementPolicyFailure) {
    super('time settlement: ' + reason);
    this.name = 'TimeSettlementPolicyError';
  }
}

export interface TimeSettlementPopulation {
  readonly participationIdentityId: string;
  readonly memberId: string;
  readonly pending: boolean;
}

export interface TimeSettlementFrozenPolicy {
  readonly id: string;
  readonly schemaVersion: number;
  readonly definitionJson: unknown;
  readonly definitionHash: string;
  readonly evaluatorVersion: number;
  readonly effectiveFrom: Date;
  readonly effectiveUntil: Date | null;
}

export interface TimeSettlementAllocation {
  readonly id: string;
  readonly participationIdentityId: string;
  readonly memberId: string;
  readonly sourceSegmentId: string;
  readonly sourceSegmentRevision: number;
  readonly policyVersionId: string;
  readonly definitionHash: string;
  readonly evaluatorVersion: number;
  readonly attendanceRoleCode: string | null;
  readonly recognitionModeCode: 'automatic' | 'manual';
  readonly manualReason: string | null;
  readonly allocationHash: string;
  readonly slices: readonly ActivityTimeAllocationSliceInput[];
}

export interface TimeSettlementBucketSource {
  readonly allocationRevisionId: string;
  readonly sourceSegmentId: string;
  readonly sourceSegmentRevision: number;
  readonly rawCalculatedMilliseconds: bigint | null;
  readonly rawRecognizedMilliseconds: bigint;
}

export interface TimeSettlementBucket {
  readonly participationIdentityId: string;
  readonly categoryCode: TimePolicyCategory;
  readonly calculatedSeconds: number | null;
  readonly recognizedSeconds: number;
  readonly rawCalculatedMilliseconds: bigint | null;
  readonly rawRecognizedMilliseconds: bigint;
  readonly timePolicyVersionId: string | null;
  readonly definitionHash: string | null;
  readonly evaluatorVersion: number | null;
  readonly quantumSeconds: number | null;
  readonly adjustmentReason:
    | readonly { allocationRevisionId: string; manualReason: string }[]
    | null;
  readonly emptyReasonCode: 'no_valid_segment' | null;
  readonly sources: readonly TimeSettlementBucketSource[];
}

function reject(reason: TimeSettlementPolicyFailure): never {
  throw new TimeSettlementPolicyError(reason);
}

function compareId(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

export interface TimeSettlementDraftProof {
  readonly activityId: string;
  readonly settlementRunId: string;
  readonly settlementDraftVersionId: string;
  readonly evidenceSealId: string;
  readonly evidenceRevision: number;
  readonly populationRevision: number;
  readonly workflowRevision: number;
  readonly draftContentHash: string;
}

/** Includes excluded facts and the latest revision even if that allocation is now stale. */
export function timeSettlementSourceSetHash(
  proof: TimeSettlementDraftProof,
  population: readonly TimeSettlementPopulation[],
  segments: readonly CurrentParticipationSegment[],
  latestAllocations: readonly {
    id: string;
    participationIdentityId: string;
    segmentKey: string;
    allocationHash: string;
  }[],
): string {
  const latest = new Map(
    latestAllocations.map((row) => [
      JSON.stringify([row.participationIdentityId, row.segmentKey]),
      row,
    ]),
  );
  if (latest.size !== latestAllocations.length) return reject('invalid');
  return fingerprintMetricEnvelope('activity-time-settlement-sources-v1', {
    ...proof,
    population: [...population].sort((a, b) =>
      compareId(a.participationIdentityId, b.participationIdentityId),
    ),
    segments: [...segments]
      .sort((a, b) => compareId(a.id, b.id))
      .map((segment) => {
        const allocation = latest.get(
          JSON.stringify([segment.participationIdentityId, segment.segmentKey]),
        );
        return {
          ...segment,
          checkInAt: segment.checkInAt.toISOString(),
          checkOutAt: segment.checkOutAt?.toISOString() ?? null,
          allocationRevisionId: allocation?.id ?? null,
          allocationHash: allocation?.allocationHash ?? null,
        };
      }),
  }).definitionHash;
}

function instant(value: string): Date {
  const date = new Date(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString() !== value
  )
    return reject('invalid');
  return date;
}

/** Keep all arithmetic integral, including subtraction near JavaScript's Date limits. */
function milliseconds(
  slices: readonly ActivityTimeAllocationSliceInput[],
  category: TimePolicyCategory,
): bigint {
  let sum = 0n;
  for (const slice of slices) {
    if (slice.categoryCode === category)
      sum += BigInt(instant(slice.endAt).getTime()) - BigInt(instant(slice.startAt).getTime());
  }
  return sum;
}

export function roundTimeSettlementMilliseconds(value: bigint, quantumSeconds: number): number {
  if (
    value < 0n ||
    value > 9223372036854775807n ||
    !Number.isInteger(quantumSeconds) ||
    quantumSeconds < 1 ||
    quantumSeconds > 3600
  )
    return reject('invalid');
  const quantum = BigInt(quantumSeconds);
  const seconds = (value / (quantum * 1000n)) * quantum;
  if (seconds > 2147483647n) return reject('scale_limit');
  return Number(seconds);
}

function automaticBaseline(
  policy: ReturnType<typeof fingerprintTimePolicyVersion>,
  source: CurrentParticipationSegment & { checkOutAt: Date },
  allocation: TimeSettlementAllocation,
): readonly ActivityTimeAllocationSliceInput[] | null {
  try {
    return automaticTimeAllocationSlices(
      policy.definition,
      allocation.attendanceRoleCode,
      source.checkInAt,
      source.checkOutAt,
    );
  } catch (error) {
    if (
      error instanceof BizException &&
      error.biz === BizCode.ACTIVITY_TIME_ALLOCATION_POLICY_UNAVAILABLE
    )
      return null;
    throw error;
  }
}

/**
 * Only consumes a transaction-owned, authorized source set. The caller must verify the current
 * draft/seal and each allocation's proof before invoking this pure aggregation. No DB or live
 * directory lookup occurs here, and there is no fallback to old hours or contribution points.
 */
export function buildTimeSettlementBuckets(input: {
  readonly activityId: string;
  readonly population: readonly TimeSettlementPopulation[];
  readonly segments: readonly CurrentParticipationSegment[];
  readonly allocations: readonly TimeSettlementAllocation[];
  readonly policies: readonly TimeSettlementFrozenPolicy[];
}): {
  buckets: readonly TimeSettlementBucket[];
  bucketCount: number;
  sourceCount: number;
  bucketContentHash: string;
} {
  if (
    input.population.length > TIME_SETTLEMENT_LIMITS.identities ||
    input.segments.length > TIME_SETTLEMENT_LIMITS.segments ||
    input.allocations.length > TIME_SETTLEMENT_LIMITS.segments ||
    input.policies.length > TIME_SETTLEMENT_LIMITS.segments
  )
    return reject('scale_limit');
  if (
    input.allocations.reduce((total, allocation) => total + allocation.slices.length, 0) >
    TIME_SETTLEMENT_LIMITS.slices
  )
    return reject('scale_limit');
  const population = new Map(input.population.map((row) => [row.participationIdentityId, row]));
  if (population.size !== input.population.length) return reject('invalid');
  if (input.population.some((row) => row.pending)) return reject('source_not_ready');
  const sourceIds = new Set(input.segments.map((row) => row.id));
  const sourceKeys = new Set(
    input.segments.map((row) => JSON.stringify([row.participationIdentityId, row.segmentKey])),
  );
  if (sourceIds.size !== input.segments.length || sourceKeys.size !== input.segments.length)
    return reject('invalid');
  const allocationBySource = new Map(input.allocations.map((row) => [row.sourceSegmentId, row]));
  if (
    allocationBySource.size !== input.allocations.length ||
    new Set(input.allocations.map((row) => row.id)).size !== input.allocations.length
  )
    return reject('invalid');
  if (input.allocations.some((row) => !sourceIds.has(row.sourceSegmentId)))
    return reject('invalid');

  const policies = new Map<string, ReturnType<typeof fingerprintTimePolicyVersion>>();
  for (const row of input.policies) {
    if (policies.has(row.id)) return reject('invalid');
    const policy = fingerprintTimePolicyVersion({
      schemaVersion: row.schemaVersion,
      definition: row.definitionJson,
      evaluatorVersion: row.evaluatorVersion,
      effectiveFrom: row.effectiveFrom.toISOString(),
      effectiveUntil: row.effectiveUntil?.toISOString() ?? null,
    });
    if (policy.definitionHash !== row.definitionHash) return reject('invalid');
    policies.set(row.id, policy);
  }

  type Resolved = {
    source: CurrentParticipationSegment;
    allocation: TimeSettlementAllocation;
    policy: ReturnType<typeof fingerprintTimePolicyVersion>;
    automatic: readonly ActivityTimeAllocationSliceInput[] | null;
  };
  const byIdentity = new Map<string, Resolved[]>();
  const intervals: { memberId: string; start: number; end: number }[] = [];
  for (const source of input.segments) {
    const identity = population.get(source.participationIdentityId);
    if (
      !identity ||
      identity.memberId !== source.memberId ||
      source.activityId !== input.activityId
    )
      return reject('invalid');
    if (source.checkOutAt === null) return reject('source_not_ready');
    if (source.resultCode !== 'valid') {
      if (allocationBySource.has(source.id)) return reject('invalid');
      continue;
    }
    const { checkOutAt } = source;
    if (
      checkOutAt === null ||
      !Number.isFinite(source.checkInAt.getTime()) ||
      !Number.isFinite(checkOutAt.getTime()) ||
      checkOutAt <= source.checkInAt
    )
      return reject('source_not_ready');
    const allocation = allocationBySource.get(source.id);
    if (
      !allocation ||
      allocation.sourceSegmentRevision !== source.revision ||
      allocation.participationIdentityId !== source.participationIdentityId ||
      allocation.memberId !== source.memberId
    )
      return reject('source_not_ready');
    const policy = policies.get(allocation.policyVersionId);
    if (
      !policy ||
      policy.definitionHash !== allocation.definitionHash ||
      policy.evaluatorVersion !== allocation.evaluatorVersion ||
      policy.effectiveFrom > source.checkInAt.toISOString() ||
      (policy.effectiveUntil !== null && policy.effectiveUntil < checkOutAt.toISOString())
    )
      return reject('source_not_ready');
    for (const slice of allocation.slices) {
      if (!TIME_SETTLEMENT_CATEGORIES.some((category) => category === slice.categoryCode))
        return reject('invalid');
      instant(slice.startAt);
      instant(slice.endAt);
    }
    assertAllocationSlicesWithinSource(
      allocation.slices,
      source.checkInAt,
      checkOutAt,
      policy.definition.allowSplit,
    );
    if (
      buildActivityTimeAllocationManifest(allocation.slices).allocationHash !==
      allocation.allocationHash
    )
      return reject('invalid');
    const automatic = automaticBaseline(policy, { ...source, checkOutAt }, allocation);
    if (allocation.recognitionModeCode === 'automatic') {
      if (
        allocation.manualReason !== null ||
        automatic === null ||
        buildActivityTimeAllocationManifest(automatic).allocationHash !== allocation.allocationHash
      )
        return reject('invalid');
    } else {
      assertManualTimeAllocationAllowed(policy.definition);
      const reason = metricText(allocation.manualReason, 1024);
      if (/\p{Cc}/u.test(reason)) return reject('invalid');
    }
    intervals.push({
      memberId: source.memberId,
      start: source.checkInAt.getTime(),
      end: checkOutAt.getTime(),
    });
    const rows = byIdentity.get(source.participationIdentityId) ?? [];
    rows.push({ source, allocation, policy, automatic });
    byIdentity.set(source.participationIdentityId, rows);
  }
  intervals.sort((a, b) => compareId(a.memberId, b.memberId) || a.start - b.start || a.end - b.end);
  for (let index = 1; index < intervals.length; index += 1) {
    const previous = intervals[index - 1];
    const current = intervals[index];
    if (current.memberId === previous.memberId && current.start < previous.end)
      return reject('overlap');
  }

  const buckets: TimeSettlementBucket[] = [];
  for (const identity of [...input.population].sort((a, b) =>
    compareId(a.participationIdentityId, b.participationIdentityId),
  )) {
    const rows = (byIdentity.get(identity.participationIdentityId) ?? []).sort((a, b) =>
      compareId(a.allocation.id, b.allocation.id),
    );
    const first = rows[0];
    if (
      first &&
      rows.some(
        (row) =>
          row.allocation.policyVersionId !== first.allocation.policyVersionId ||
          row.policy.definitionHash !== first.policy.definitionHash ||
          row.policy.evaluatorVersion !== first.policy.evaluatorVersion ||
          row.policy.definition.rounding.quantumSeconds !==
            first.policy.definition.rounding.quantumSeconds,
      )
    )
      return reject('policy_mixed');
    for (const categoryCode of TIME_SETTLEMENT_CATEGORIES) {
      const sources = rows.map(
        ({ source, allocation, automatic }): TimeSettlementBucketSource => ({
          allocationRevisionId: allocation.id,
          sourceSegmentId: source.id,
          sourceSegmentRevision: source.revision,
          rawCalculatedMilliseconds:
            automatic === null ? null : milliseconds(automatic, categoryCode),
          rawRecognizedMilliseconds: milliseconds(allocation.slices, categoryCode),
        }),
      );
      const rawRecognizedMilliseconds = sources.reduce(
        (total, source) => total + source.rawRecognizedMilliseconds,
        0n,
      );
      const rawCalculatedMilliseconds = sources.some(
        (source) => source.rawCalculatedMilliseconds === null,
      )
        ? null
        : sources.reduce((total, source) => total + (source.rawCalculatedMilliseconds ?? 0n), 0n);
      const quantumSeconds = first?.policy.definition.rounding.quantumSeconds ?? null;
      const adjustmentReason = rows
        .filter((row) => row.allocation.recognitionModeCode === 'manual')
        .map(({ allocation }) => ({
          allocationRevisionId: allocation.id,
          manualReason: metricText(allocation.manualReason, 1024),
        }));
      if (
        (rawCalculatedMilliseconds === null ||
          rawCalculatedMilliseconds !== rawRecognizedMilliseconds) &&
        adjustmentReason.length === 0
      )
        return reject('invalid');
      buckets.push({
        participationIdentityId: identity.participationIdentityId,
        categoryCode,
        calculatedSeconds:
          rawCalculatedMilliseconds === null
            ? null
            : quantumSeconds === null
              ? 0
              : roundTimeSettlementMilliseconds(rawCalculatedMilliseconds, quantumSeconds),
        recognizedSeconds:
          quantumSeconds === null
            ? 0
            : roundTimeSettlementMilliseconds(rawRecognizedMilliseconds, quantumSeconds),
        rawCalculatedMilliseconds,
        rawRecognizedMilliseconds,
        timePolicyVersionId: first?.allocation.policyVersionId ?? null,
        definitionHash: first?.policy.definitionHash ?? null,
        evaluatorVersion: first?.policy.evaluatorVersion ?? null,
        quantumSeconds,
        adjustmentReason: adjustmentReason.length > 0 ? adjustmentReason : null,
        emptyReasonCode: first ? null : 'no_valid_segment',
        sources,
      });
    }
  }
  const sourceCount = buckets.reduce((count, bucket) => count + bucket.sources.length, 0);
  if (
    buckets.length > TIME_SETTLEMENT_LIMITS.buckets ||
    sourceCount > TIME_SETTLEMENT_LIMITS.sources
  )
    return reject('scale_limit');
  const bucketContentHash = fingerprintMetricEnvelope(
    'activity-time-settlement-buckets-v1',
    buckets.map((bucket) => ({
      ...bucket,
      rawCalculatedMilliseconds: bucket.rawCalculatedMilliseconds?.toString() ?? null,
      rawRecognizedMilliseconds: bucket.rawRecognizedMilliseconds.toString(),
      sources: bucket.sources.map((source) => ({
        ...source,
        rawCalculatedMilliseconds: source.rawCalculatedMilliseconds?.toString() ?? null,
        rawRecognizedMilliseconds: source.rawRecognizedMilliseconds.toString(),
      })),
    })),
  ).definitionHash;
  return { buckets, bucketCount: buckets.length, sourceCount, bucketContentHash };
}
