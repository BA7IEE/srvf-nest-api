import { fingerprintContributionPolicyVersion } from './activity-contribution-policy-definition';
import {
  compareContributionShadow,
  ContributionShadowComparisonInput,
  prepareContributionShadowPolicy,
} from './activity-contribution-shadow-comparison';

function fixture(): ContributionShadowComparisonInput {
  const definition = {
    defaultResult: { recognizedPoints: '0.00', explanationCode: 'no_rule' },
    roleRules: [
      {
        attendanceRoleCode: 'member',
        categoryRules: [
          {
            timeCategoryCode: 'volunteer_service' as const,
            durationBands: [
              { maxSecondsInclusive: 14_400, recognizedPoints: '1.25', explanationCode: 'below' },
              { maxSecondsInclusive: null, recognizedPoints: '2.50', explanationCode: 'above' },
            ],
          },
        ],
      },
    ],
  };
  const envelope = fingerprintContributionPolicyVersion({
    schemaVersion: 1,
    definition,
    evaluatorVersion: 1,
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    effectiveUntil: null,
  });
  return {
    fact: {
      activityId: 'fixture-activity',
      memberId: 'fixture-member',
      attendanceId: 'fixture-attendance',
      occurredAt: '2026-09-25T00:00:00.000Z',
      sourceCode: 'fixture-attendance-hours',
      legacyServiceHours: 4,
      durationSeconds: 14_400,
      durationSourceCode: 'fixture-attendance-hours',
    },
    mapping: {
      approved: true,
      signedVersion: 'fixture-signature-v1',
      activityTypeCode: 'fixture_type',
      legacyRoleCode: 'volunteer',
      policyRoleCode: 'member',
      timeCategoryCode: 'volunteer_service',
      sourceCode: 'fixture-attendance-hours',
      precisionCode: 'decimal_hours_2',
      missingRuleIsZero: false,
    },
    legacy: {
      activityTypeCode: 'fixture_type',
      roleCode: 'volunteer',
      serviceHours: 4,
      rules: [
        {
          id: 'fixture-rule',
          activityTypeCode: 'fixture_type',
          attendanceRoleCode: 'volunteer',
          durationThreshold: '4.00',
          pointsBelow: '1.25',
          pointsAbove: '2.50',
        },
      ],
      expectedSourceFingerprint: 'fixture-source-hash',
      observedSourceFingerprint: 'fixture-source-hash',
    },
    policy: {
      definition,
      versionHash: envelope.definitionHash,
      schemaVersion: 1,
      evaluatorVersion: 1,
      effectiveFrom: '2026-09-01T00:00:00.000Z',
      effectiveUntil: null,
      approved: true,
    },
  };
}

describe('E3-1 offline contribution shadow comparison', () => {
  it('retains early mapping failure without evaluating later policy properties', () => {
    const input = fixture();
    input.mapping.approved = false;
    const read = jest.fn(() => {
      throw new Error('late policy field must not be read');
    });
    Object.defineProperty(input.policy, 'definition', { get: read });
    expect(compareContributionShadow(input).classification).toBe('mapping_hold');
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    'equal',
    'mismatch',
    'precision',
    'hold',
    'source',
    'role',
    'hash',
    'expired',
    'missing-rule',
  ])('prepared comparison preserves strict classification for %s', (kind) => {
    const input = fixture();
    if (kind === 'mismatch')
      input.legacy.rules = [{ ...input.legacy.rules[0], pointsBelow: '1.50' }];
    if (kind === 'precision') input.fact.durationSeconds += 1;
    if (kind === 'hold') input.mapping.approved = false;
    if (kind === 'source') input.legacy.observedSourceFingerprint = 'other';
    if (kind === 'role') input.mapping.policyRoleCode = 'absent';
    if (kind === 'hash') input.policy.versionHash = 'a'.repeat(64);
    if (kind === 'expired') input.fact.occurredAt = '2026-08-01T00:00:00.000Z';
    if (kind === 'missing-rule') input.legacy.rules = [];
    const prepared = prepareContributionShadowPolicy({
      schemaVersion: input.policy.schemaVersion,
      evaluatorVersion: input.policy.evaluatorVersion,
      definition: input.policy.definition,
      effectiveFrom: input.policy.effectiveFrom,
      effectiveUntil: input.policy.effectiveUntil,
    });
    expect(prepared.compare(input, input.policy.versionHash!)).toEqual(
      compareContributionShadow(input),
    );
  });

  it('prepared comparison captures policy contents and does not accept a replacement proof', () => {
    const input = fixture();
    const prepared = prepareContributionShadowPolicy({
      schemaVersion: 1,
      evaluatorVersion: 1,
      definition: input.policy.definition,
      effectiveFrom: input.policy.effectiveFrom,
      effectiveUntil: null,
    });
    const expected = compareContributionShadow(input);
    input.policy.definition!.roleRules[0].categoryRules[0].durationBands[0].recognizedPoints =
      '99.00';
    expect(prepared.compare(input, input.policy.versionHash!)).toEqual(expected);
    expect(compareContributionShadow(input).classification).toBe('source_drift');
    input.mapping.approved = false;
    expect(prepared.compare(input, 'bad').classification).toBe('mapping_hold');
  });
  it('is equal at the inclusive threshold and deterministic on replay', () => {
    const input = fixture();
    expect(compareContributionShadow(input)).toEqual({
      classification: 'equal',
      comparable: true,
      legacyPoints: '1.25',
      policyPoints: '1.25',
      policyExplanationCode: 'below',
    });
    expect(compareContributionShadow(input)).toEqual(compareContributionShadow(input));
  });

  it('reports a comparable mismatch without changing either original value', () => {
    const input = fixture();
    input.legacy.rules = [{ ...input.legacy.rules[0], pointsBelow: '1.50' }];
    expect(compareContributionShadow(input)).toMatchObject({
      classification: 'points_mismatch',
      comparable: true,
      legacyPoints: '1.50',
      policyPoints: '1.25',
    });
  });

  it('uses the above band only for an exact two-decimal hour input above threshold', () => {
    const input = fixture();
    input.fact.legacyServiceHours = 4.01;
    input.legacy.serviceHours = 4.01;
    input.fact.durationSeconds = 14_436;
    expect(compareContributionShadow(input)).toMatchObject({
      classification: 'equal',
      legacyPoints: '2.50',
      policyPoints: '2.50',
    });
  });

  it('keeps one-second rounding ambiguity outside the comparable denominator', () => {
    const input = fixture();
    input.fact.durationSeconds = 14_401;
    expect(compareContributionShadow(input)).toMatchObject({
      classification: 'precision_boundary',
      comparable: false,
    });
  });

  it('classifies a material hours/seconds disagreement as different input', () => {
    const input = fixture();
    input.fact.durationSeconds = 18_000;
    expect(compareContributionShadow(input).classification).toBe('input_source_mismatch');
  });

  it('rejects a hidden sub-cent hour offset instead of treating it as the threshold', () => {
    const input = fixture();
    input.fact.legacyServiceHours = 4.00000000001;
    input.legacy.serviceHours = 4.00000000001;
    expect(compareContributionShadow(input).classification).toBe('input_source_mismatch');
  });

  it('holds an unsigned mapping even if the synthetic values happen to match', () => {
    const input = fixture();
    input.mapping.approved = false;
    expect(compareContributionShadow(input)).toMatchObject({
      classification: 'mapping_hold',
      comparable: false,
    });
  });

  it('does not infer a category or role mapping', () => {
    const input = fixture();
    input.mapping.legacyRoleCode = 'other';
    expect(compareContributionShadow(input).classification).toBe('mapping_hold');
  });

  it('holds a signed-looking mapping when the selected policy has no matching role', () => {
    const input = fixture();
    input.mapping.policyRoleCode = 'unmapped';
    expect(compareContributionShadow(input).classification).toBe('mapping_hold');
  });

  it('holds a signed-looking mapping when the selected policy has no matching category', () => {
    const input = fixture();
    input.mapping.timeCategoryCode = 'training';
    expect(compareContributionShadow(input).classification).toBe('mapping_hold');
  });

  it('rejects different fact sources before comparing points', () => {
    const input = fixture();
    input.fact.durationSourceCode = 'another-source';
    expect(compareContributionShadow(input).classification).toBe('input_source_mismatch');
  });

  it('does not equate an absent old rule with the policy default without an explicit decision', () => {
    const input = fixture();
    input.legacy.rules = [];
    expect(compareContributionShadow(input)).toMatchObject({
      classification: 'legacy_rule_missing',
      comparable: false,
    });
  });

  it('reports duplicate active role pairs instead of choosing one', () => {
    const input = fixture();
    input.legacy.rules = [...input.legacy.rules, { ...input.legacy.rules[0], id: 'duplicate' }];
    expect(compareContributionShadow(input).classification).toBe('duplicate_active_pair');
  });

  it('preserves the old no-threshold rule even when pointsAbove is populated', () => {
    const input = fixture();
    input.legacy.rules = [
      { ...input.legacy.rules[0], durationThreshold: null, pointsAbove: '9.00' },
    ];
    expect(compareContributionShadow(input)).toMatchObject({
      classification: 'equal',
      legacyPoints: '1.25',
    });
  });

  it('preserves the old pointsAbove-null fallback', () => {
    const input = fixture();
    input.fact.legacyServiceHours = 4.01;
    input.legacy.serviceHours = 4.01;
    input.fact.durationSeconds = 14_436;
    input.legacy.rules = [{ ...input.legacy.rules[0], pointsAbove: null }];
    expect(compareContributionShadow(input)).toMatchObject({
      classification: 'points_mismatch',
      legacyPoints: '1.25',
      policyPoints: '2.50',
    });
  });

  it('compares old missing-rule zero only when separately signed', () => {
    const input = fixture();
    input.legacy.rules = [];
    input.mapping.missingRuleIsZero = true;
    expect(compareContributionShadow(input)).toMatchObject({
      classification: 'points_mismatch',
      legacyPoints: '0.00',
      policyPoints: '1.25',
    });
  });

  it('rejects unapproved policy versions', () => {
    const input = fixture();
    input.policy.approved = false;
    expect(compareContributionShadow(input).classification).toBe(
      'policy_version_missing_or_unapproved',
    );
  });

  it('rejects a policy outside its signed effective interval', () => {
    const input = fixture();
    input.fact.occurredAt = '2026-08-31T23:59:59.000Z';
    expect(compareContributionShadow(input).classification).toBe(
      'policy_version_missing_or_unapproved',
    );
  });

  it('requires an explicit mapping signature version', () => {
    const input = fixture();
    input.mapping.signedVersion = '';
    expect(compareContributionShadow(input).classification).toBe('mapping_hold');
  });

  it('detects old-source and policy-hash drift', () => {
    const input = fixture();
    input.legacy.observedSourceFingerprint = 'changed';
    expect(compareContributionShadow(input).classification).toBe('source_drift');
    input.legacy.observedSourceFingerprint = input.legacy.expectedSourceFingerprint;
    input.policy.versionHash = 'changed';
    expect(compareContributionShadow(input).classification).toBe('source_drift');
  });

  it('classifies invalid evaluator metadata without leaking errors into the old result', () => {
    const input = fixture();
    input.policy.evaluatorVersion = 2;
    expect(compareContributionShadow(input)).toMatchObject({
      classification: 'evaluation_error',
      comparable: false,
      legacyPoints: null,
      policyPoints: null,
    });
  });
});
