import { ContributionSettlementPolicyError } from './activity-contribution-settlement-policy';
import type {
  ContributionEvaluation,
  ContributionSource,
} from './activity-contribution-settlement-policy';
import { parseContributionPolicyDefinition } from './activity-contribution-policy-definition';
import { parseTimePolicyDefinition } from './activity-time-policy-definition';

/** Active new-business admission only. Fixture correctness limits and frozen proofs stay separate. */
export const NATIVE_CONTRIBUTION_LAUNCH_LIMITS = Object.freeze({
  identities: 500,
  segments: 500,
  allocations: 500,
  punchEvents: 2_000,
  segmentRevisions: 1_000,
  allocationRevisions: 1_000,
  slices: 2_500,
  buckets: 2_000,
  bucketSources: 2_000,
  evaluations: 2_000,
  sourceRefs: 2_500,
  policyVersions: 1,
  policyRoles: 1,
  policyCategories: 4,
  bandsPerCategory: 2,
  policyBands: 8,
  timePolicyVersions: 1,
  timePolicyRoles: 1,
  snapshots: 1,
  selectionScopes: 32,
  policyBytes: 8_192,
  snapshotBytes: 262_144,
  selectionBytes: 65_536,
  sourceBytes: 4_194_304,
  evaluationBytes: 8_388_608,
  daysPerSlice: 2,
  dayPieces: 5_000,
});

type Limit = keyof typeof NATIVE_CONTRIBUTION_LAUNCH_LIMITS;

/** Counts are actual whole-activity/frozen-input facts, never page size or present-source counts. */
export function assertNativeContributionLaunchCount(value: number, dimension: Limit): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new ContributionSettlementPolicyError('invalid');
  if (value > NATIVE_CONTRIBUTION_LAUNCH_LIMITS[dimension])
    throw new ContributionSettlementPolicyError('scale_limit');
}

export function assertNativeContributionLaunchTotal(values: readonly number[], dimension: Limit) {
  let total = 0;
  for (const value of values) {
    assertNativeContributionLaunchCount(value, dimension);
    total += value;
    assertNativeContributionLaunchCount(total, dimension);
  }
  return total;
}

/** Closed database JSON / local serialization only; this does not replace canonical validation. */
export function assertNativeContributionLaunchJson(value: unknown, dimension: Limit): void {
  const serialized = JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
  if (serialized === undefined) throw new ContributionSettlementPolicyError('invalid');
  assertNativeContributionLaunchCount(Buffer.byteLength(serialized, 'utf8'), dimension);
}

/** Arithmetic before splitSpanByBeijingDay: exclusive end, Beijing has no DST in this domain. */
export function assertNativeContributionLaunchSpans(
  slices: readonly { startsAt: Date; endsAt: Date }[],
): void {
  assertNativeContributionLaunchCount(slices.length, 'slices');
  const offset = 8 * 3_600_000;
  const day = 86_400_000;
  let pieces = 0;
  for (const slice of slices) {
    const start = slice.startsAt.getTime(),
      end = slice.endsAt.getTime();
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start)
      throw new ContributionSettlementPolicyError('invalid');
    const count =
      end === start
        ? 0
        : Math.floor((end - 1 + offset) / day) - Math.floor((start + offset) / day) + 1;
    assertNativeContributionLaunchCount(count, 'daysPerSlice');
    pieces += count;
    assertNativeContributionLaunchCount(pieces, 'dayPieces');
  }
}

export function assertNativeContributionLaunchPolicies(
  policies: readonly { definitionJson: unknown }[],
): void {
  assertNativeContributionLaunchCount(policies.length, 'policyVersions');
  let roles = 0,
    categories = 0,
    bands = 0;
  for (const policy of policies) {
    assertNativeContributionLaunchJson(policy.definitionJson, 'policyBytes');
    const definition = parseContributionPolicyDefinition(policy.definitionJson);
    roles += definition.roleRules.length;
    for (const role of definition.roleRules) {
      categories += role.categoryRules.length;
      for (const category of role.categoryRules) {
        assertNativeContributionLaunchCount(category.durationBands.length, 'bandsPerCategory');
        bands += category.durationBands.length;
      }
    }
  }
  assertNativeContributionLaunchCount(roles, 'policyRoles');
  assertNativeContributionLaunchCount(categories, 'policyCategories');
  assertNativeContributionLaunchCount(bands, 'policyBands');
}

export function assertNativeContributionLaunchTimePolicies(
  policies: readonly { definitionJson: unknown }[],
): void {
  assertNativeContributionLaunchCount(policies.length, 'timePolicyVersions');
  let roles = 0;
  for (const policy of policies) {
    assertNativeContributionLaunchJson(policy.definitionJson, 'policyBytes');
    roles += parseTimePolicyDefinition(policy.definitionJson).roleMappings.length;
  }
  assertNativeContributionLaunchCount(roles, 'timePolicyRoles');
}

export function assertNativeContributionLaunchEvaluations(
  evaluations: readonly Pick<ContributionEvaluation, 'sourceRefsJson' | 'beijingDayPointsJson'>[],
): void {
  assertNativeContributionLaunchCount(evaluations.length, 'evaluations');
  assertNativeContributionLaunchTotal(
    evaluations.map((row) => row.sourceRefsJson.length),
    'sourceRefs',
  );
  assertNativeContributionLaunchTotal(
    evaluations.map((row) => row.beijingDayPointsJson.length),
    'dayPieces',
  );
  assertNativeContributionLaunchJson(evaluations, 'evaluationBytes');
}

/** Count the evaluator's semantic tuple before policy evaluation and day expansion. */
export function assertNativeContributionLaunchSources(
  sources: readonly ContributionSource[],
): void {
  assertNativeContributionLaunchCount(sources.length, 'sourceRefs');
  const units = new Set(
    sources.map((source) =>
      JSON.stringify([
        source.participationIdentityId,
        source.sessionId,
        source.selection.mode,
        source.selection.policy?.policyId,
        source.selection.policy?.versionId,
        source.selection.policy?.definitionHash,
        source.selection.policy?.evaluatorVersion,
        source.attendanceRoleCode,
        source.timeCategoryCode,
      ]),
    ),
  );
  assertNativeContributionLaunchCount(units.size, 'evaluations');
}
