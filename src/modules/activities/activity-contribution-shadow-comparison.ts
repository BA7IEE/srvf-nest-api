import { Prisma } from '@prisma/client';
import {
  ContributionPolicyDefinition,
  ContributionTimeCategoryCode,
  prepareContributionPolicyVersion,
} from './activity-contribution-policy-definition';

/** Offline fixture contract only. No database lookup, runtime shadow switch, or policy selection. */
export interface ContributionShadowComparisonInput {
  fact: {
    activityId: string;
    memberId: string;
    attendanceId: string;
    occurredAt: string;
    sourceCode: string;
    legacyServiceHours: number;
    durationSeconds: number;
    durationSourceCode: string;
  };
  mapping: {
    approved: boolean;
    signedVersion: string;
    activityTypeCode: string;
    legacyRoleCode: string;
    policyRoleCode: string;
    timeCategoryCode: ContributionTimeCategoryCode;
    sourceCode: string;
    /** Old persisted hours have two decimal places; no rounding is performed here. */
    precisionCode: 'decimal_hours_2';
    missingRuleIsZero: boolean;
  };
  legacy: {
    activityTypeCode: string;
    roleCode: string;
    serviceHours: number;
    rules: ReadonlyArray<{
      id: string;
      activityTypeCode: string;
      attendanceRoleCode: string;
      durationThreshold: string | null;
      pointsBelow: string;
      pointsAbove: string | null;
    }>;
    expectedSourceFingerprint: string;
    observedSourceFingerprint: string;
  };
  policy: {
    definition: ContributionPolicyDefinition | null;
    versionHash: string | null;
    schemaVersion: number;
    evaluatorVersion: number;
    effectiveFrom: string;
    effectiveUntil: string | null;
    approved: boolean;
  };
}

export type ContributionShadowClassification =
  | 'equal'
  | 'points_mismatch'
  | 'legacy_rule_missing'
  | 'policy_version_missing_or_unapproved'
  | 'mapping_hold'
  | 'input_source_mismatch'
  | 'precision_boundary'
  | 'source_drift'
  | 'duplicate_active_pair'
  | 'evaluation_error';

export interface ContributionShadowComparisonResult {
  classification: ContributionShadowClassification;
  comparable: boolean;
  legacyPoints: string | null;
  policyPoints: string | null;
  policyExplanationCode: string | null;
}

function result(
  classification: ContributionShadowClassification,
  legacyPoints: string | null = null,
  policyPoints: string | null = null,
  policyExplanationCode: string | null = null,
): ContributionShadowComparisonResult {
  return {
    classification,
    comparable: classification === 'equal' || classification === 'points_mismatch',
    legacyPoints,
    policyPoints,
    policyExplanationCode,
  };
}

function cents(value: string): number {
  if (!/^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,2})?$/u.test(value)) {
    throw new TypeError('Invalid legacy contribution decimal');
  }
  return new Prisma.Decimal(value).mul(100).toNumber();
}

function points(value: string): string {
  const amount = cents(value);
  return `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`;
}

/** Pure, fail-closed comparison; caller must provide an explicitly approved fixture mapping. */
export function compareContributionShadow(
  input: ContributionShadowComparisonInput,
): ContributionShadowComparisonResult {
  return compareWithPolicy(
    input,
    () =>
      prepareContributionPolicyVersion({
        schemaVersion: input.policy.schemaVersion,
        definition: input.policy.definition,
        evaluatorVersion: input.policy.evaluatorVersion,
        effectiveFrom: input.policy.effectiveFrom,
        effectiveUntil: input.policy.effectiveUntil,
      }),
    () => input.policy.definition !== null,
  );
}

type ComparisonCoreInput = Omit<ContributionShadowComparisonInput, 'policy'> & {
  policy: Omit<ContributionShadowComparisonInput['policy'], 'definition'>;
};

/** Strict factory: captures its own verified policy, never accepts a caller's validation flag. */
export function prepareContributionShadowPolicy(value: unknown) {
  const prepared = prepareContributionPolicyVersion(value);
  return Object.freeze({
    definitionHash: prepared.definitionHash,
    categoryCode: (role: string, code: string) => prepared.categoryCode(role, code),
    compare: (
      input: Omit<ContributionShadowComparisonInput, 'policy'>,
      versionHash: string,
    ): ContributionShadowComparisonResult =>
      compareWithPolicy(
        {
          ...input,
          policy: {
            approved: true,
            versionHash,
            schemaVersion: prepared.schemaVersion,
            evaluatorVersion: prepared.evaluatorVersion,
            effectiveFrom: prepared.effectiveFrom,
            effectiveUntil: prepared.effectiveUntil,
          },
        },
        () => prepared,
        () => true,
      ),
  });
}

function compareWithPolicy(
  input: ComparisonCoreInput,
  resolvePolicy: () => ReturnType<typeof prepareContributionPolicyVersion>,
  hasDefinition: () => boolean,
): ContributionShadowComparisonResult {
  const { fact, mapping, legacy, policy } = input;
  if (
    !mapping.approved ||
    !mapping.signedVersion ||
    mapping.activityTypeCode !== legacy.activityTypeCode ||
    mapping.legacyRoleCode !== legacy.roleCode ||
    !mapping.policyRoleCode ||
    !mapping.timeCategoryCode ||
    mapping.precisionCode !== 'decimal_hours_2'
  ) {
    return result('mapping_hold');
  }
  if (
    !fact.activityId ||
    !fact.memberId ||
    !fact.attendanceId ||
    !fact.occurredAt ||
    !fact.sourceCode ||
    fact.sourceCode !== mapping.sourceCode ||
    fact.durationSourceCode !== fact.sourceCode ||
    !Number.isFinite(fact.legacyServiceHours) ||
    !Number.isFinite(legacy.serviceHours) ||
    fact.legacyServiceHours !== legacy.serviceHours ||
    !Number.isSafeInteger(fact.durationSeconds) ||
    fact.durationSeconds < 0
  ) {
    return result('input_source_mismatch');
  }
  if (
    !Number.isSafeInteger(Math.round(legacy.serviceHours * 100)) ||
    legacy.serviceHours !== Number(legacy.serviceHours.toFixed(2)) ||
    legacy.serviceHours < 0
  ) {
    return result('input_source_mismatch');
  }
  // A two-decimal hour value cannot prove a one-second boundary. Never call it a policy mismatch.
  const representedSeconds = Math.round(legacy.serviceHours * 100) * 36;
  if (representedSeconds !== fact.durationSeconds) {
    return result(
      Math.abs(representedSeconds - fact.durationSeconds) <= 18
        ? 'precision_boundary'
        : 'input_source_mismatch',
    );
  }
  if (
    !legacy.expectedSourceFingerprint ||
    legacy.expectedSourceFingerprint !== legacy.observedSourceFingerprint
  ) {
    return result('source_drift');
  }
  const matches = legacy.rules.filter(
    (rule) =>
      rule.activityTypeCode === legacy.activityTypeCode &&
      rule.attendanceRoleCode === legacy.roleCode,
  );
  if (matches.length > 1) return result('duplicate_active_pair');
  if (matches.length === 0 && !mapping.missingRuleIsZero) return result('legacy_rule_missing');
  if (
    !policy.approved ||
    !hasDefinition() ||
    policy.versionHash === null ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(fact.occurredAt) ||
    !Number.isFinite(Date.parse(fact.occurredAt)) ||
    new Date(fact.occurredAt).toISOString() !== fact.occurredAt ||
    fact.occurredAt < policy.effectiveFrom ||
    (policy.effectiveUntil !== null && fact.occurredAt >= policy.effectiveUntil)
  ) {
    return result('policy_version_missing_or_unapproved');
  }
  try {
    const prepared = resolvePolicy();
    if (prepared.definitionHash !== policy.versionHash) return result('source_drift');
    if (!prepared.categoryCode(mapping.policyRoleCode, mapping.timeCategoryCode)) {
      return result('mapping_hold');
    }
    const chosen = matches[0];
    const legacyPoints = chosen
      ? points(
          chosen.durationThreshold === null ||
            legacy.serviceHours <= Number(chosen.durationThreshold)
            ? chosen.pointsBelow
            : (chosen.pointsAbove ?? chosen.pointsBelow),
        )
      : '0.00';
    if (chosen?.durationThreshold !== null && chosen !== undefined) {
      cents(chosen.durationThreshold);
    }
    const evaluated = prepared.evaluate({
      attendanceRoleCode: mapping.policyRoleCode,
      timeCategoryCode: mapping.timeCategoryCode,
      durationSeconds: fact.durationSeconds,
    });
    return result(
      legacyPoints === evaluated.recognizedPoints ? 'equal' : 'points_mismatch',
      legacyPoints,
      evaluated.recognizedPoints,
      evaluated.explanationCode,
    );
  } catch {
    return result('evaluation_error');
  }
}
