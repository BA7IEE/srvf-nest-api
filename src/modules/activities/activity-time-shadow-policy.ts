import { fingerprintMetricEnvelope } from './activity-metric-definition';
import {
  TIME_SETTLEMENT_CATEGORIES,
  TIME_SETTLEMENT_LIMITS,
  TimeSettlementPolicyError,
} from './activity-time-settlement-policy';

export const TIME_SHADOW_FORMAT_VERSION = 1;
export const TIME_SHADOW_COMPARATOR_VERSION = 1;
export type TimeShadowStatus = 'matched' | 'different' | 'not_comparable';

export interface TimeShadowLegacyResult {
  readonly participationIdentityId: string;
  readonly calculatedServiceHours: string;
  readonly recognizedServiceHours: string;
  readonly manuallyAdjusted: boolean;
}

export interface TimeShadowBucket {
  readonly id: string;
  readonly participationIdentityId: string;
  readonly categoryCode: string;
  readonly calculatedSeconds: number | null;
  readonly recognizedSeconds: number;
  readonly manuallyAdjusted: boolean;
}

export interface TimeShadowAnchor {
  readonly activityId: string;
  readonly settlementRunId: string;
  readonly settlementVersionId: string;
  readonly timeRevisionId: string;
  readonly legacyContentHash: string;
  readonly draftContentHash: string;
  readonly sourceSetHash: string;
  readonly bucketContentHash: string;
}

/** Decimal(5,2) hours are exact centihours: never round through binary floating point. */
export function timeShadowHoursToSeconds(hours: string): number {
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(hours)) throw new TimeSettlementPolicyError('invalid');
  const [whole, fraction = ''] = hours.split('.');
  return Number((BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) * 36n);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function validSeconds(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Pure comparison only: matched is numeric equality, never policy approval or ledger posting. */
export function compareTimeShadow(
  anchor: TimeShadowAnchor,
  legacy: readonly TimeShadowLegacyResult[],
  buckets: readonly TimeShadowBucket[],
) {
  if (
    legacy.length > TIME_SETTLEMENT_LIMITS.identities ||
    buckets.length > TIME_SETTLEMENT_LIMITS.buckets
  )
    throw new TimeSettlementPolicyError('scale_limit');
  const oldByIdentity = new Map<string, TimeShadowLegacyResult>();
  for (const row of legacy) {
    if (oldByIdentity.has(row.participationIdentityId))
      throw new TimeSettlementPolicyError('invalid');
    oldByIdentity.set(row.participationIdentityId, row);
  }
  const newByIdentity = new Map<string, TimeShadowBucket[]>();
  for (const bucket of buckets) {
    const rows = newByIdentity.get(bucket.participationIdentityId) ?? [];
    if (rows.some((row) => row.categoryCode === bucket.categoryCode))
      throw new TimeSettlementPolicyError('invalid');
    rows.push(bucket);
    newByIdentity.set(bucket.participationIdentityId, rows);
  }
  const identities = [...new Set([...oldByIdentity.keys(), ...newByIdentity.keys()])].sort(
    compareText,
  );
  if (identities.length > TIME_SETTLEMENT_LIMITS.identities)
    throw new TimeSettlementPolicyError('scale_limit');
  const items = identities.map((participationIdentityId) => {
    const old = oldByIdentity.get(participationIdentityId);
    const categories = [...(newByIdentity.get(participationIdentityId) ?? [])]
      .sort((a, b) => compareText(a.categoryCode, b.categoryCode))
      .map((row) => ({
        bucketId: row.id,
        categoryCode: row.categoryCode,
        calculatedSeconds: row.calculatedSeconds,
        recognizedSeconds: row.recognizedSeconds,
        manuallyAdjusted: row.manuallyAdjusted,
      }));
    const reasons: string[] = [];
    if (!old) reasons.push('missing_legacy_result');
    if (
      TIME_SETTLEMENT_CATEGORIES.some(
        (category) => !categories.some((row) => row.categoryCode === category),
      )
    )
      reasons.push('missing_bucket');
    if (categories.some((row) => row.categoryCode === 'legacy_unclassified'))
      reasons.push('legacy_unclassified');
    if (
      categories.some(
        (row) =>
          !TIME_SETTLEMENT_CATEGORIES.some((category) => category === row.categoryCode) ||
          !validSeconds(row.recognizedSeconds) ||
          (row.calculatedSeconds !== null && !validSeconds(row.calculatedSeconds)),
      )
    )
      reasons.push('invalid_source');
    const volunteer = categories.find((row) => row.categoryCode === 'volunteer_service');
    if (volunteer?.calculatedSeconds === null) reasons.push('calculation_unknown');
    const legacyCalculatedSeconds = old
      ? timeShadowHoursToSeconds(old.calculatedServiceHours)
      : null;
    const legacyRecognizedSeconds = old
      ? timeShadowHoursToSeconds(old.recognizedServiceHours)
      : null;
    const invalid = reasons.some((reason) => reason !== 'calculation_unknown');
    const calculatedDifferenceSeconds =
      !invalid && volunteer?.calculatedSeconds != null && legacyCalculatedSeconds !== null
        ? volunteer.calculatedSeconds - legacyCalculatedSeconds
        : null;
    const recognizedDifferenceSeconds =
      !invalid && volunteer && legacyRecognizedSeconds !== null
        ? volunteer.recognizedSeconds - legacyRecognizedSeconds
        : null;
    const status: TimeShadowStatus =
      reasons.length > 0
        ? 'not_comparable'
        : calculatedDifferenceSeconds === 0 && recognizedDifferenceSeconds === 0
          ? 'matched'
          : 'different';
    if (old?.manuallyAdjusted || categories.some((row) => row.manuallyAdjusted))
      reasons.push('manual_recognition_present');
    if (
      categories.some(
        (row) => row.categoryCode !== 'volunteer_service' && row.recognizedSeconds > 0,
      )
    )
      reasons.push('non_volunteer_time_present');
    if (status === 'different') reasons.push('unexplained');
    return {
      participationIdentityId,
      status,
      reasons,
      legacyCalculatedSeconds,
      legacyRecognizedSeconds,
      calculatedDifferenceSeconds,
      recognizedDifferenceSeconds,
      categories,
    };
  });
  // Whitelist the anchor as well as rows; no Prisma metadata or sensitive reasons enter the hash.
  const evidence = {
    activityId: anchor.activityId,
    settlementRunId: anchor.settlementRunId,
    settlementVersionId: anchor.settlementVersionId,
    timeRevisionId: anchor.timeRevisionId,
    legacyContentHash: anchor.legacyContentHash,
    draftContentHash: anchor.draftContentHash,
    sourceSetHash: anchor.sourceSetHash,
    bucketContentHash: anchor.bucketContentHash,
  };
  const summary = {
    total: items.length,
    matched: items.filter((row) => row.status === 'matched').length,
    different: items.filter((row) => row.status === 'different').length,
    notComparable: items.filter((row) => row.status === 'not_comparable').length,
    empty: items.length === 0,
  };
  return {
    formatVersion: TIME_SHADOW_FORMAT_VERSION,
    comparatorVersion: TIME_SHADOW_COMPARATOR_VERSION,
    ...evidence,
    inputFingerprint: fingerprintMetricEnvelope('activity-time-shadow-v1', {
      evidence,
      items,
      // Keep the old-side fact independently: a new-side manual marker must not mask its change.
      legacyManualFacts: identities.map((id) => ({
        participationIdentityId: id,
        manuallyAdjusted: oldByIdentity.get(id)?.manuallyAdjusted ?? null,
      })),
    }).definitionHash,
    summary,
    items,
  };
}
