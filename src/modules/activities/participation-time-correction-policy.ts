import { fingerprintMetricEnvelope } from './activity-metric-definition';
import {
  TIME_SETTLEMENT_CATEGORIES,
  TIME_SETTLEMENT_LIMITS,
} from './activity-time-settlement-policy';

export interface TimeCorrectionAnchor {
  readonly correctionRequestId: string;
  readonly postingBatchId: string;
  readonly activityId: string;
  readonly settlementRunId: string;
  readonly baseSettlementVersionId: string;
  readonly settlementVersionId: string;
  readonly rootManifestId: string;
  readonly rootSettlementVersionId: string;
  readonly predecessorManifestId: string | null;
  readonly baseContentHash: string;
  readonly requestHash: string;
  /**
   * D7-2 frozen source proof. Both values are either absent (legacy format 1)
   * or present (format 2); an existing V1 hash domain is never rewritten.
   */
  readonly sourceProofId?: string | null;
  readonly sourceProofHash?: string | null;
}

export interface TimeCorrectionRoot {
  readonly id: string;
  readonly manifestId: string;
  readonly participationIdentityId: string;
  readonly categoryCode: string;
  readonly recognizedSeconds: number;
}

export interface TimeCorrectionPredecessor {
  readonly id: string;
  readonly manifestId: string;
  readonly rootEntryId: string;
  readonly participationIdentityId: string;
  readonly categoryCode: string;
  readonly entryTypeCode: string;
  readonly secondsDelta: number;
}

export interface TimeCorrectionValue {
  readonly rootEntryId: string;
  readonly recognizedSeconds: number;
}

export class TimeCorrectionPolicyError extends TypeError {
  constructor(readonly reason: 'source_invalid' | 'scale_limit') {
    super('participation time correction: ' + reason);
    this.name = 'TimeCorrectionPolicyError';
  }
}

function invalid(): never {
  throw new TimeCorrectionPolicyError('source_invalid');
}

function validId(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}

function validSeconds(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 2147483647;
}

/** Pure contents only. Caller verifies committed status and all database ownership anchors. */
export function buildParticipationTimeCorrection(
  anchor: TimeCorrectionAnchor,
  roots: readonly TimeCorrectionRoot[],
  values: readonly TimeCorrectionValue[],
  predecessors: readonly TimeCorrectionPredecessor[],
) {
  const {
    rootSettlementVersionId,
    sourceProofId = null,
    sourceProofHash = null,
    ...manifestAnchor
  } = anchor;
  for (const id of [
    anchor.correctionRequestId,
    anchor.postingBatchId,
    anchor.activityId,
    anchor.settlementRunId,
    anchor.baseSettlementVersionId,
    anchor.settlementVersionId,
    anchor.rootManifestId,
    rootSettlementVersionId,
  ])
    if (!validId(id)) invalid();
  if (anchor.settlementVersionId === anchor.baseSettlementVersionId) invalid();
  for (const hash of [anchor.baseContentHash, anchor.requestHash]) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)) invalid();
  }
  if ((sourceProofId === null) !== (sourceProofHash === null)) invalid();
  if (
    sourceProofId !== null &&
    (!validId(sourceProofId) ||
      typeof sourceProofHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(sourceProofHash))
  ) {
    invalid();
  }
  const first = anchor.predecessorManifestId === null;
  if (first !== (anchor.baseSettlementVersionId === rootSettlementVersionId)) invalid();
  if (anchor.predecessorManifestId !== null && !validId(anchor.predecessorManifestId)) invalid();
  if (
    roots.length > TIME_SETTLEMENT_LIMITS.buckets ||
    values.length > TIME_SETTLEMENT_LIMITS.buckets ||
    predecessors.length > TIME_SETTLEMENT_LIMITS.buckets
  ) {
    throw new TimeCorrectionPolicyError('scale_limit');
  }
  if (
    !roots.length ||
    values.length !== roots.length ||
    (first ? predecessors.length !== 0 : predecessors.length !== roots.length)
  )
    invalid();

  const replacements = new Map<string, number>();
  for (const value of values) {
    if (
      !validId(value.rootEntryId) ||
      !validSeconds(value.recognizedSeconds) ||
      replacements.has(value.rootEntryId)
    )
      invalid();
    replacements.set(value.rootEntryId, value.recognizedSeconds);
  }
  const previous = new Map<string, TimeCorrectionPredecessor>();
  const previousIds = new Set<string>();
  for (const entry of predecessors) {
    if (
      !validId(entry.id) ||
      !validId(entry.rootEntryId) ||
      previousIds.has(entry.id) ||
      previous.has(entry.rootEntryId) ||
      entry.manifestId !== anchor.predecessorManifestId ||
      entry.entryTypeCode !== 'credit' ||
      !validSeconds(entry.secondsDelta)
    )
      invalid();
    previous.set(entry.rootEntryId, entry);
    previousIds.add(entry.id);
  }
  const rootIds = new Set<string>();
  const identityCategories = new Set<string>();
  const identities = new Set<string>();
  const totals = new Map<string, { reversal: bigint; replacement: bigint }>(
    TIME_SETTLEMENT_CATEGORIES.map((categoryCode) => [
      categoryCode,
      { reversal: 0n, replacement: 0n },
    ]),
  );
  let changed = false;
  const entries = [...roots]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .flatMap((root) => {
      const total = totals.get(root.categoryCode);
      const identityCategory = JSON.stringify([root.participationIdentityId, root.categoryCode]);
      if (
        !validId(root.id) ||
        !validId(root.participationIdentityId) ||
        root.manifestId !== anchor.rootManifestId ||
        !total ||
        !validSeconds(root.recognizedSeconds) ||
        rootIds.has(root.id) ||
        identityCategories.has(identityCategory)
      )
        invalid();
      rootIds.add(root.id);
      identities.add(root.participationIdentityId);
      identityCategories.add(identityCategory);
      const replacement = replacements.get(root.id);
      if (replacement === undefined) invalid();
      const prior = previous.get(root.id);
      if (
        !first &&
        (!prior ||
          prior.participationIdentityId !== root.participationIdentityId ||
          prior.categoryCode !== root.categoryCode)
      )
        invalid();
      const before = prior ? prior.secondsDelta : root.recognizedSeconds;
      changed ||= before !== replacement;
      total.reversal -= BigInt(before);
      total.replacement += BigInt(replacement);
      return (['reversal', 'credit'] as const).map((entryTypeCode) => {
        const contents = {
          postingBatchId: anchor.postingBatchId,
          activityId: anchor.activityId,
          rootEntryId: root.id,
          participationIdentityId: root.participationIdentityId,
          categoryCode: root.categoryCode,
          entryTypeCode,
          secondsDelta: entryTypeCode === 'credit' ? replacement : before === 0 ? 0 : -before,
          reversesCorrectionEntryId: entryTypeCode === 'reversal' && prior ? prior.id : null,
        };
        return {
          ...contents,
          entryKey: fingerprintMetricEnvelope('participation-time-correction-entry-key-v1', {
            postingBatchId: anchor.postingBatchId,
            rootEntryId: root.id,
            entryTypeCode,
          }).definitionHash,
          contentHash: fingerprintMetricEnvelope('participation-time-correction-entry-v1', contents)
            .definitionHash,
        };
      });
    });
  if (identities.size > TIME_SETTLEMENT_LIMITS.identities)
    throw new TimeCorrectionPolicyError('scale_limit');
  const reversalSecondsTotal = [...totals.values()].reduce((sum, t) => sum + t.reversal, 0n);
  const replacementSecondsTotal = [...totals.values()].reduce((sum, t) => sum + t.replacement, 0n);
  const contents = {
    ...manifestAnchor,
    ...(sourceProofId === null
      ? { formatVersion: 1 as const }
      : {
          formatVersion: 2 as const,
          sourceProofId,
          sourceProofHash: sourceProofHash as string,
        }),
    expectedRootCount: roots.length,
    expectedEntryCount: entries.length,
    reversalSecondsTotal: reversalSecondsTotal.toString(),
    replacementSecondsTotal: replacementSecondsTotal.toString(),
  };
  return {
    manifest: {
      ...contents,
      reversalSecondsTotal,
      replacementSecondsTotal,
      contentHash: fingerprintMetricEnvelope(
        sourceProofId === null
          ? 'participation-time-correction-manifest-v1'
          : 'participation-time-correction-manifest-v2',
        {
          ...contents,
          entries,
        },
      ).definitionHash,
    },
    entries,
    changed,
    categories: [...totals].map(([categoryCode, total]) => ({
      categoryCode,
      reversalSecondsTotal: total.reversal.toString(),
      replacementSecondsTotal: total.replacement.toString(),
      netSecondsDelta: (total.reversal + total.replacement).toString(),
    })),
  };
}
