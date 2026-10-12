import { createHash } from 'node:crypto';
import { splitSpanByBeijingDay } from '../../common/datetime/date-only.util';
import {
  CONTRIBUTION_TIME_CATEGORY_CODES,
  prepareContributionPolicyVersion,
  type ContributionTimeCategoryCode,
} from './activity-contribution-policy-definition';
import {
  canonicalizeActivityTemplateDefinition,
  computeActivityTemplateDefinitionHash,
  isActivityTemplateDefinitionHash,
} from './activity-template-definition';
import { distributeByWeight } from './ledger-day-allocation';
import { TIME_SETTLEMENT_LIMITS } from './activity-time-settlement-policy';

export type ContributionRegimeCode = 'legacy' | 'policy_v1';
export type ContributionSourceKind = 'time_revision' | 'correction_time_proof' | 'unchanged_time';

/** Pure failures are translated to existing BizCodes at the application boundary. */
export class ContributionSettlementPolicyError extends TypeError {
  constructor(readonly reason: 'invalid' | 'source_not_ready' | 'overflow' | 'scale_limit') {
    super(`contribution settlement: ${reason}`);
    this.name = 'ContributionSettlementPolicyError';
  }
}

export interface ContributionFrozenPolicy {
  readonly policyId: string;
  readonly versionId: string;
  readonly schemaVersion: number;
  readonly definitionJson: unknown;
  readonly definitionHash: string;
  readonly evaluatorVersion: number;
  readonly effectiveFrom: Date;
  readonly effectiveUntil: Date | null;
}

export interface ContributionSelection {
  readonly id: string;
  readonly mode: 'policy';
  readonly policy: ContributionFrozenPolicy | null;
}

export interface ContributionSource {
  readonly participationIdentityId: string;
  readonly memberId: string;
  readonly sessionId: string;
  readonly ruleSnapshotId: string;
  readonly attendanceRoleCode: string;
  readonly timeCategoryCode: ContributionTimeCategoryCode;
  readonly selection: ContributionSelection;
  readonly allocationRevisionId: string;
  readonly sliceId: string;
  readonly sourceSegmentId: string;
  readonly sourceSegmentRevision: number;
  readonly allocationHash: string;
  readonly durationSeconds: number;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly correctionSource?: {
    readonly proofId: string;
    readonly pendingAllocationId: string | null;
    readonly sourceHash: string;
    readonly sliceOrdinal: number;
  };
}

export interface ContributionSourceReference {
  readonly selectionItemId: string;
  readonly allocationRevisionId: string;
  readonly sliceId: string;
  readonly sourceSegmentId: string;
  readonly sourceSegmentRevision: number;
  readonly allocationHash: string;
  readonly durationSeconds: number;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly correctionSource?: ContributionSource['correctionSource'];
}

export interface ContributionEvaluation {
  readonly participationIdentityId: string;
  readonly memberId: string;
  readonly sessionId: string;
  readonly ruleSnapshotId: string;
  readonly selectionItemId: string;
  readonly mode: 'policy';
  readonly policyId: string;
  readonly policyVersionId: string;
  readonly definitionHash: string;
  readonly evaluatorVersion: number;
  readonly attendanceRoleCode: string;
  readonly timeCategoryCode: ContributionTimeCategoryCode;
  readonly evaluationUnitKey: string;
  readonly durationSeconds: number;
  readonly sourceRefsJson: readonly ContributionSourceReference[];
  readonly sourceFingerprint: string;
  readonly calculatedPoints: string;
  readonly recognizedPoints: string;
  readonly explanationCode: string;
  readonly beijingDayPointsJson: readonly { ledgerDate: string; recognizedPoints: string }[];
  readonly evaluationHash: string;
}

function reject(reason: ContributionSettlementPolicyError['reason']): never {
  throw new ContributionSettlementPolicyError(reason);
}

function text(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) reject('invalid');
  return value;
}

function nonnegative(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) reject('invalid');
  return value;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hash(value: unknown): string {
  return computeActivityTemplateDefinitionHash({ schemaVersion: 1, definition: value });
}

// Exact primitive branches of the original canonicalizer. Unsupported values
// continue through its structural and numeric checks.
function canonicalPrimitive(value: unknown): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

// These flat references are newly built locally and never mutate after sorting.
// Other properties still pass through the original canonicalizer.
function hashWithTimeReferences(
  definition: Record<string, unknown>,
  field: 'sources' | 'sourceRefsJson',
  canonicalRefs: readonly string[],
): string {
  const parts = Object.keys(definition)
    .sort()
    .map((key) => {
      if (key === field) return JSON.stringify(key) + ':[' + canonicalRefs.join(',') + ']';
      const primitive = canonicalPrimitive(definition[key]);
      return primitive === undefined
        ? canonicalizeActivityTemplateDefinition({ [key]: definition[key] }).slice(1, -1)
        : JSON.stringify(key) + ':' + primitive;
    });
  return createHash('sha256')
    .update('{"definition":{' + parts.join(',') + '},"schemaVersion":1}', 'utf8')
    .digest('hex');
}

function cents(value: string): number {
  if (!/^(?:0|[1-9][0-9]{0,2})\.[0-9]{2}$/u.test(value)) reject('overflow');
  const [whole, fraction] = value.split('.');
  return Number(whole) * 100 + Number(fraction);
}

function points(value: number): string {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
}

/** Actual classified coverage, not volunteer hours or a receipt creation date. */
function distributeDays(
  total: number,
  refs: readonly ContributionSourceReference[],
): ContributionEvaluation['beijingDayPointsJson'] {
  const days = new Map<string, number>();
  for (const ref of refs) {
    if (ref.durationSeconds === 0) continue;
    const startsAt = Date.parse(ref.startsAt);
    const endsAt = Date.parse(ref.endsAt);
    const length = endsAt - startsAt;
    if (!(length > 0)) reject('source_not_ready');
    for (const slice of splitSpanByBeijingDay(new Date(startsAt), new Date(endsAt))) {
      const date = slice.ledgerDate.toISOString().slice(0, 10);
      const weight = ref.durationSeconds * (slice.milliseconds / length);
      days.set(date, (days.get(date) ?? 0) + weight);
    }
  }
  if (days.size === 0) {
    if (total !== 0) reject('source_not_ready');
    return [];
  }
  const ordered = [...days.entries()].sort(([left], [right]) => compare(left, right));
  const amounts = distributeByWeight(
    total,
    ordered.map(([, weight]) => weight),
  );
  return ordered.map(([ledgerDate], index) => ({
    ledgerDate,
    recognizedPoints: points(amounts[index]),
  }));
}

/** Request-local, closed evaluators; no cross-request policy or authorization cache. */
export function evaluateSettlementContributions(input: {
  readonly activityId: string;
  readonly settlementVersionId: string;
  readonly sourceKindCode: ContributionSourceKind;
  readonly sources: readonly ContributionSource[];
}) {
  text(input.activityId);
  text(input.settlementVersionId);
  if (!['time_revision', 'correction_time_proof', 'unchanged_time'].includes(input.sourceKindCode))
    reject('invalid');
  if (input.sources.length > TIME_SETTLEMENT_LIMITS.slices) reject('scale_limit');
  const groups = new Map<
    string,
    { first: ContributionSource; refs: ContributionSourceReference[] }
  >();
  const sourceKeys = new Set<string>();
  const identities = new Map<string, string>();
  const policyEvaluators = new Map<string, ReturnType<typeof prepareContributionPolicyVersion>>();
  const preparedInputs = new WeakMap<
    ContributionFrozenPolicy,
    ReturnType<typeof prepareContributionPolicyVersion>
  >();
  const snapshots = new Map<string, string>();
  const unitCanonicals = new Map<string, string>();
  for (const source of input.sources) {
    for (const value of [
      source.participationIdentityId,
      source.memberId,
      source.sessionId,
      source.ruleSnapshotId,
      source.attendanceRoleCode,
      source.selection.id,
      source.allocationRevisionId,
      source.sliceId,
      source.sourceSegmentId,
    ])
      text(value);
    if (!CONTRIBUTION_TIME_CATEGORY_CODES.includes(source.timeCategoryCode)) reject('invalid');
    if (input.sourceKindCode === 'correction_time_proof') {
      const correction = source.correctionSource;
      if (
        !correction ||
        !isActivityTemplateDefinitionHash(correction.sourceHash) ||
        !Number.isSafeInteger(correction.sliceOrdinal) ||
        correction.sliceOrdinal < 0 ||
        source.sliceId !== `${source.allocationRevisionId}:${correction.sliceOrdinal}`
      )
        reject('invalid');
      text(correction.proofId);
      if (correction.pendingAllocationId !== null) text(correction.pendingAllocationId);
    } else if (source.correctionSource !== undefined && input.sourceKindCode === 'time_revision')
      reject('invalid');
    const existingMember = identities.get(source.participationIdentityId);
    if (existingMember !== undefined && existingMember !== source.memberId) reject('invalid');
    identities.set(source.participationIdentityId, source.memberId);
    if (identities.size > TIME_SETTLEMENT_LIMITS.identities) reject('scale_limit');
    const oldSnapshot = snapshots.get(source.sessionId);
    if (oldSnapshot !== undefined && oldSnapshot !== source.ruleSnapshotId) reject('invalid');
    snapshots.set(source.sessionId, source.ruleSnapshotId);
    nonnegative(source.durationSeconds);
    if (
      !Number.isSafeInteger(source.sourceSegmentRevision) ||
      source.sourceSegmentRevision < 1 ||
      !isActivityTemplateDefinitionHash(source.allocationHash) ||
      !(source.startsAt instanceof Date) ||
      !(source.endsAt instanceof Date) ||
      !Number.isFinite(source.startsAt.getTime()) ||
      !Number.isFinite(source.endsAt.getTime()) ||
      source.endsAt < source.startsAt ||
      (source.durationSeconds > 0 && source.endsAt <= source.startsAt)
    )
      reject('invalid');
    const sourceKey = canonicalizeActivityTemplateDefinition({
      participationIdentityId: source.participationIdentityId,
      allocationRevisionId: source.allocationRevisionId,
      sliceId: source.sliceId,
    });
    if (sourceKeys.has(sourceKey)) reject('invalid');
    sourceKeys.add(sourceKey);
    const policy = source.selection.policy;
    if (source.selection.mode !== 'policy' || !policy) reject('source_not_ready');
    {
      text(policy.policyId);
      text(policy.versionId);
      const prepared =
        preparedInputs.get(policy) ??
        prepareContributionPolicyVersion({
          schemaVersion: policy.schemaVersion,
          definition: policy.definitionJson,
          evaluatorVersion: policy.evaluatorVersion,
          effectiveFrom: policy.effectiveFrom.toISOString(),
          effectiveUntil: policy.effectiveUntil?.toISOString() ?? null,
        });
      if (prepared.definitionHash !== policy.definitionHash) reject('invalid');
      preparedInputs.set(policy, prepared);
      const old = policyEvaluators.get(policy.versionId);
      if (old && old.definitionHash !== prepared.definitionHash) reject('invalid');
      policyEvaluators.set(policy.versionId, old ?? prepared);
    }
    const unit = {
      participationIdentityId: source.participationIdentityId,
      sessionId: source.sessionId,
      mode: source.selection.mode,
      policyId: policy.policyId,
      policyVersionId: policy.versionId,
      definitionHash: policy.definitionHash,
      evaluatorVersion: policy.evaluatorVersion,
      attendanceRoleCode: source.attendanceRoleCode,
      timeCategoryCode: source.timeCategoryCode,
    };
    // All fields are copied into this local flat object after the original
    // per-source and per-policy validation. Equal primitive tuples have equal
    // canonical bytes; other shapes still use the original canonicalizer.
    const cacheable =
      input.sourceKindCode === 'time_revision' &&
      Object.values(unit).every(
        (value) =>
          typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)),
      );
    // Encode only primitive values; object serialization could invoke toJSON.
    const unitInput = cacheable ? Object.values(unit).map(canonicalPrimitive).join(',') : undefined;
    let unitKey = unitInput === undefined ? undefined : unitCanonicals.get(unitInput);
    if (unitKey === undefined) {
      unitKey = canonicalizeActivityTemplateDefinition(unit);
      if (unitInput !== undefined) unitCanonicals.set(unitInput, unitKey);
    }
    const group = groups.get(unitKey) ?? { first: source, refs: [] };
    group.refs.push({
      selectionItemId: source.selection.id,
      allocationRevisionId: source.allocationRevisionId,
      sliceId: source.sliceId,
      sourceSegmentId: source.sourceSegmentId,
      sourceSegmentRevision: source.sourceSegmentRevision,
      allocationHash: source.allocationHash,
      durationSeconds: source.durationSeconds,
      startsAt: source.startsAt.toISOString(),
      endsAt: source.endsAt.toISOString(),
      ...(source.correctionSource === undefined
        ? {}
        : { correctionSource: source.correctionSource }),
    });
    groups.set(unitKey, group);
  }
  const evaluations: ContributionEvaluation[] = [];
  const totals = new Map<string, number>();
  for (const [unitKey, { first, refs }] of [...groups.entries()].sort(([a], [b]) =>
    compare(a, b),
  )) {
    // These refs are newly built for this invocation and remain unchanged during sorting.
    // Keep the original canonicalizer/comparator; only reuse each ref's sort key.
    let canonicalRefs: string[] | undefined;
    if (refs.length > 1) {
      const orderedRefs = refs.map((ref) => ({
        ref,
        canonical: canonicalizeActivityTemplateDefinition(ref),
      }));
      orderedRefs.sort((a, b) => compare(a.canonical, b.canonical));
      if (input.sourceKindCode === 'time_revision')
        canonicalRefs = orderedRefs.map((row) => row.canonical);
      for (const [index, { ref }] of orderedRefs.entries()) refs[index] = ref;
    }
    const durationSeconds = nonnegative(refs.reduce((sum, ref) => sum + ref.durationSeconds, 0));
    const policy = first.selection.policy;
    if (!policy) reject('source_not_ready');
    const evaluator = policyEvaluators.get(policy.versionId);
    if (!evaluator) reject('source_not_ready');
    const result = evaluator.evaluate({
      attendanceRoleCode: first.attendanceRoleCode,
      timeCategoryCode: first.timeCategoryCode,
      durationSeconds,
    });
    const amount = cents(result.recognizedPoints);
    const identityTotal = (totals.get(first.participationIdentityId) ?? 0) + amount;
    if (identityTotal > 99999) reject('overflow');
    totals.set(first.participationIdentityId, identityTotal);
    if (input.sourceKindCode === 'time_revision' && canonicalRefs === undefined)
      canonicalRefs = refs.map((ref) => canonicalizeActivityTemplateDefinition(ref));
    const sourceDefinition = { domain: input.sourceKindCode, sources: refs };
    const sourceFingerprint = canonicalRefs
      ? hashWithTimeReferences(sourceDefinition, 'sources', canonicalRefs)
      : hash(sourceDefinition);
    const evaluation = {
      participationIdentityId: first.participationIdentityId,
      memberId: first.memberId,
      sessionId: first.sessionId,
      ruleSnapshotId: first.ruleSnapshotId,
      selectionItemId: refs.map((ref) => ref.selectionItemId).sort(compare)[0],
      mode: first.selection.mode,
      policyId: policy.policyId,
      policyVersionId: policy.versionId,
      definitionHash: policy.definitionHash,
      evaluatorVersion: policy.evaluatorVersion,
      attendanceRoleCode: first.attendanceRoleCode,
      timeCategoryCode: first.timeCategoryCode,
      evaluationUnitKey: hash({ unit: unitKey }),
      durationSeconds,
      sourceRefsJson: refs,
      sourceFingerprint,
      calculatedPoints: result.recognizedPoints,
      recognizedPoints: result.recognizedPoints,
      explanationCode: result.explanationCode,
      beijingDayPointsJson: distributeDays(amount, refs),
    };
    evaluations.push({
      ...evaluation,
      evaluationHash: canonicalRefs
        ? hashWithTimeReferences(evaluation, 'sourceRefsJson', canonicalRefs)
        : hash(evaluation),
    });
  }
  const recognizedHundredths = [...totals.values()].reduce((sum, value) => sum + value, 0);
  return {
    evaluations,
    evaluationCount: evaluations.length,
    recognizedPointsTotal: points(recognizedHundredths),
    sourceSetHash: hash({
      domain: input.sourceKindCode,
      sources: evaluations.map((row) => ({
        evaluationUnitKey: row.evaluationUnitKey,
        sourceFingerprint: row.sourceFingerprint,
      })),
    }),
    evaluationSetHash: hash({ evaluations: evaluations.map((row) => row.evaluationHash) }),
  };
}
