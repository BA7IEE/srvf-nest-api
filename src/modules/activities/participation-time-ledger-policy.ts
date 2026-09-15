import { fingerprintMetricEnvelope } from './activity-metric-definition';
import {
  TIME_SETTLEMENT_CATEGORIES,
  TIME_SETTLEMENT_LIMITS,
} from './activity-time-settlement-policy';

export interface TimeLedgerAnchor {
  readonly postingBatchId: string;
  readonly activityId: string;
  readonly settlementRunId: string;
  readonly settlementVersionId: string;
  readonly timeRevisionId: string;
  readonly bucketContentHash: string;
  readonly sourceSetHash: string;
}

export interface TimeLedgerSourceBucket {
  readonly id: string;
  readonly participationIdentityId: string;
  readonly categoryCode: string;
  readonly recognizedSeconds: number;
}

export class TimeLedgerPolicyError extends TypeError {
  constructor(readonly reason: 'source_invalid' | 'scale_limit') {
    super('participation time ledger: ' + reason);
    this.name = 'TimeLedgerPolicyError';
  }
}

function invalid(): never {
  throw new TimeLedgerPolicyError('source_invalid');
}

/** Database-independent canonical contents; random ids and audit timestamps are excluded. */
export function buildParticipationTimeLedger(
  anchor: TimeLedgerAnchor,
  buckets: readonly TimeLedgerSourceBucket[],
) {
  const {
    postingBatchId,
    activityId,
    settlementRunId,
    settlementVersionId,
    timeRevisionId,
    bucketContentHash,
    sourceSetHash,
  } = anchor;
  for (const id of [
    postingBatchId,
    activityId,
    settlementRunId,
    settlementVersionId,
    timeRevisionId,
  ]) {
    if (typeof id !== 'string' || id.trim().length === 0) invalid();
  }
  for (const hash of [bucketContentHash, sourceSetHash]) {
    if (!/^[a-f0-9]{64}$/u.test(hash)) invalid();
  }
  if (buckets.length > TIME_SETTLEMENT_LIMITS.buckets) {
    throw new TimeLedgerPolicyError('scale_limit');
  }
  const seenBuckets = new Set<string>();
  const seenIdentityCategories = new Set<string>();
  const identities = new Set<string>();
  const totals = new Map<string, bigint>(TIME_SETTLEMENT_CATEGORIES.map((code) => [code, 0n]));
  const entries = [...buckets]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((bucket) => {
      if (
        typeof bucket.id !== 'string' ||
        !bucket.id.trim() ||
        typeof bucket.participationIdentityId !== 'string' ||
        !bucket.participationIdentityId.trim() ||
        !totals.has(bucket.categoryCode) ||
        !Number.isInteger(bucket.recognizedSeconds) ||
        bucket.recognizedSeconds < 0 ||
        bucket.recognizedSeconds > 2147483647
      )
        invalid();
      const identityCategory = JSON.stringify([
        bucket.participationIdentityId,
        bucket.categoryCode,
      ]);
      if (seenBuckets.has(bucket.id) || seenIdentityCategories.has(identityCategory)) invalid();
      seenBuckets.add(bucket.id);
      seenIdentityCategories.add(identityCategory);
      identities.add(bucket.participationIdentityId);
      totals.set(
        bucket.categoryCode,
        (totals.get(bucket.categoryCode) ?? 0n) + BigInt(bucket.recognizedSeconds),
      );
      const contents = {
        postingBatchId,
        activityId,
        timeRevisionId,
        bucketId: bucket.id,
        participationIdentityId: bucket.participationIdentityId,
        categoryCode: bucket.categoryCode,
        recognizedSeconds: bucket.recognizedSeconds,
      };
      return {
        ...contents,
        entryKey: fingerprintMetricEnvelope('participation-time-ledger-entry-key-v1', {
          postingBatchId,
          bucketId: bucket.id,
        }).definitionHash,
        contentHash: fingerprintMetricEnvelope('participation-time-ledger-entry-v1', contents)
          .definitionHash,
      };
    });
  if (identities.size > TIME_SETTLEMENT_LIMITS.identities)
    throw new TimeLedgerPolicyError('scale_limit');
  const recognizedSecondsTotal = [...totals.values()].reduce((sum, value) => sum + value, 0n);
  const manifestContents = {
    postingBatchId,
    activityId,
    settlementRunId,
    settlementVersionId,
    timeRevisionId,
    bucketContentHash,
    sourceSetHash,
    formatVersion: 1,
    expectedEntryCount: entries.length,
    recognizedSecondsTotal: recognizedSecondsTotal.toString(),
  };
  return {
    manifest: {
      ...manifestContents,
      recognizedSecondsTotal,
      contentHash: fingerprintMetricEnvelope('participation-time-ledger-manifest-v1', {
        ...manifestContents,
        entries,
      }).definitionHash,
    },
    entries,
    categories: TIME_SETTLEMENT_CATEGORIES.map((categoryCode) => ({
      categoryCode,
      recognizedSecondsTotal: (totals.get(categoryCode) ?? 0n).toString(),
    })),
  };
}
