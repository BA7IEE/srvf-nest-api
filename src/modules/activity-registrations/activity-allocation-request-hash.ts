import { createHash, createHmac } from 'node:crypto';

export type AllocationModeCode = 'qualification_rank' | 'lottery';

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export type AllocationQualificationRuleOutcome = {
  ruleId: string;
  resultCode: 'pass' | 'warn' | 'fail';
  warnScore: number | null;
};

export type AllocationQualificationRuleSetOutcome = {
  ruleSetVersionId: string;
  scope: { sessionId: string | null; positionId: string | null };
  inputFactsHash: string;
  resultCode: 'pass' | 'warn' | 'fail';
  rules: readonly AllocationQualificationRuleOutcome[];
};

export type AllocationQualificationSnapshotInput = {
  algorithmVersionCode: string;
  target: { activityId: string; sessionId: string; positionId: string | null };
  aggregateResultCode: 'pass' | 'warn' | 'fail';
  penalty: number | null;
  qualificationScore: string | null;
  ruleSets: readonly AllocationQualificationRuleSetOutcome[];
};

/** Bytewise UTF-8 ordering is intentionally independent of process locale. */
export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/**
 * Allocation hashes deliberately keep a local copy of the evaluator's stable-json contract.
 * The evaluator helper is private and outside this Goal's write set; sharing its implementation
 * by copy preserves the current semantic without broadening that boundary. Arrays are already
 * semantic here and callers explicitly sort every unordered collection before passing it in.
 */
export function stableJson(value: CanonicalValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort(compareUtf8)
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`;
}

export function sha256Canonical(value: CanonicalValue): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

export function createQualificationSnapshotHash(
  input: AllocationQualificationSnapshotInput,
): string {
  const ruleSets = [...input.ruleSets]
    .sort((left, right) => compareUtf8(left.ruleSetVersionId, right.ruleSetVersionId))
    .map((ruleSet) => ({
      ruleSetVersionId: ruleSet.ruleSetVersionId,
      scope: {
        sessionId: ruleSet.scope.sessionId,
        positionId: ruleSet.scope.positionId,
      },
      inputFactsHash: ruleSet.inputFactsHash,
      resultCode: ruleSet.resultCode,
      rules: [...ruleSet.rules]
        .sort((left, right) => compareUtf8(left.ruleId, right.ruleId))
        .map((rule) => ({
          ruleId: rule.ruleId,
          resultCode: rule.resultCode,
          warnScore: rule.warnScore,
        })),
    }));
  return sha256Canonical({
    version: 'allocation_qualification_snapshot/v1',
    algorithmVersionCode: input.algorithmVersionCode,
    target: input.target,
    aggregateResultCode: input.aggregateResultCode,
    penalty: input.penalty,
    qualificationScore: input.qualificationScore,
    ruleSets,
  });
}

export function createCandidateSnapshotHash(input: {
  activityId: string;
  sessionId: string;
  positionId: string | null;
  modeCode: AllocationModeCode;
  algorithmVersionCode: string;
  candidates: readonly {
    participationIdentityId: string;
    registrationId: string;
    registrationRevisionId: string;
    acceptedAt: Date;
    qualificationSnapshotHash: string;
    qualificationScore: string | null;
    tieBreakKey: string;
  }[];
}): string {
  return sha256Canonical({
    version: 'allocation_candidate_snapshot/v1',
    activityId: input.activityId,
    sessionId: input.sessionId,
    positionId: input.positionId,
    modeCode: input.modeCode,
    algorithmVersionCode: input.algorithmVersionCode,
    candidates: [...input.candidates]
      .sort((left, right) => compareUtf8(left.participationIdentityId, right.participationIdentityId))
      .map((candidate) => ({
        participationIdentityId: candidate.participationIdentityId,
        registrationId: candidate.registrationId,
        registrationRevisionId: candidate.registrationRevisionId,
        acceptedAt: candidate.acceptedAt.toISOString(),
        qualificationSnapshotHash: candidate.qualificationSnapshotHash,
        qualificationScore: candidate.qualificationScore,
        tieBreakKey: candidate.tieBreakKey,
      })),
  });
}

export function hashAllocationCommand(input: {
  commandCode: 'prepare' | 'commit' | 'void';
  activityId: string;
  allocationBatchId: string | null;
  operationKey: string;
  sessionId?: string;
  positionId?: string | null;
  reason?: string | null;
}): string {
  return sha256Canonical({
    version: 'allocation-command-request/v1',
    commandCode: input.commandCode,
    activityId: input.activityId,
    allocationBatchId: input.allocationBatchId,
    operationKey: input.operationKey,
    sessionId: input.sessionId ?? null,
    positionId: input.positionId ?? null,
    reason: input.reason ?? null,
  });
}

export function createAllocationResponseHash(input: {
  activityId: string;
  allocationBatchId: string;
  batchStatusCode: 'preparing' | 'committed' | 'voided';
  commandCode: 'prepare' | 'commit' | 'void';
}): string {
  return sha256Canonical({
    activityId: input.activityId,
    allocationBatchId: input.allocationBatchId,
    batchStatusCode: input.batchStatusCode,
    commandCode: input.commandCode,
    responseSchemaVersion: 'allocation-command-response-v1',
  });
}

/**
 * A seed is never persisted before commit. The server can deterministically reproduce it from
 * its existing protected signing secret and the immutable batch anchor, then disclose it only
 * with the committed result. A secret rotation between prepare and commit therefore fails the
 * commitment check closed rather than silently redrawing.
 */
export function deriveLotterySeed(
  serverSecret: string,
  input: { activityId: string; allocationBatchId: string; algorithmVersionCode: string },
): string {
  return createHmac('sha256', serverSecret)
    .update(
      stableJson({
        version: 'allocation_lottery_seed/v1',
        activityId: input.activityId,
        allocationBatchId: input.allocationBatchId,
        algorithmVersionCode: input.algorithmVersionCode,
      }),
      'utf8',
    )
    .digest('hex');
}

export function createLotteryCommitment(seed: string): string {
  return createHash('sha256').update(seed, 'utf8').digest('hex');
}
