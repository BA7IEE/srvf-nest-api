import {
  evaluateContributionPolicy,
  fingerprintContributionPolicyVersion,
} from './activity-contribution-policy-definition';
import {
  buildLegacyContributionCandidate,
  LegacyContributionMapping,
  LegacyContributionSourceRule,
} from './activity-contribution-rule-conversion';

const mapping: LegacyContributionMapping = {
  activityTypeCode: 'example_duty',
  timeCategoryCode: 'volunteer_service',
  defaultResult: { recognizedPoints: '0.00', explanationCode: 'explicit_no_rule' },
  roleMappings: [
    {
      sourceRoleCode: 'volunteer',
      targetRoleCode: 'member',
      belowExplanationCode: 'legacy_below',
      aboveExplanationCode: 'legacy_above',
    },
  ],
};

const rule: LegacyContributionSourceRule = {
  id: 'rule-1',
  activityTypeCode: 'example_duty',
  attendanceRoleCode: 'volunteer',
  durationThreshold: '4.00',
  pointsBelow: '1.25',
  pointsAbove: '2.50',
  status: 'ACTIVE',
  deletedAt: null,
  updatedAt: '2026-09-25T00:00:00.000Z',
};

function candidate(
  source: LegacyContributionSourceRule = rule,
  signedMapping: LegacyContributionMapping = mapping,
) {
  return buildLegacyContributionCandidate([source], signedMapping);
}

describe('E2 pure legacy contribution conversion', () => {
  it('builds an uncommitted E1 definition with inclusive decimal-hour threshold', () => {
    const result = candidate();
    expect(result.definition.roleRules[0].categoryRules[0].durationBands).toEqual([
      {
        maxSecondsInclusive: 14_400,
        recognizedPoints: '1.25',
        explanationCode: 'legacy_below',
      },
      {
        maxSecondsInclusive: null,
        recognizedPoints: '2.50',
        explanationCode: 'legacy_above',
      },
    ]);
    expect(
      evaluateContributionPolicy(result.definition, {
        attendanceRoleCode: 'member',
        timeCategoryCode: 'volunteer_service',
        durationSeconds: 14_400,
      }).recognizedPoints,
    ).toBe('1.25');
    expect(
      evaluateContributionPolicy(result.definition, {
        attendanceRoleCode: 'member',
        timeCategoryCode: 'volunteer_service',
        durationSeconds: 14_401,
      }).recognizedPoints,
    ).toBe('2.50');
    expect(result.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.canonicalDefinition).toContain('legacy_below');
    expect(rule.durationThreshold).toBe('4.00');
  });

  it('leaves missing-role behavior to the explicit default, never invents a zero policy', () => {
    const result = candidate();
    expect(
      evaluateContributionPolicy(result.definition, {
        attendanceRoleCode: 'unmapped',
        timeCategoryCode: 'volunteer_service',
        durationSeconds: 1,
      }),
    ).toEqual(mapping.defaultResult);
    expect(() => candidate(rule, { ...mapping, defaultResult: undefined! })).toThrow(TypeError);
    expect(() => buildLegacyContributionCandidate([], mapping)).toThrow(TypeError);
  });

  it('preserves no-threshold and pointsAbove-null fallback semantics', () => {
    const noThreshold = candidate({ ...rule, durationThreshold: null, pointsAbove: '9.00' });
    expect(noThreshold.definition.roleRules[0].categoryRules[0].durationBands).toEqual([
      {
        maxSecondsInclusive: null,
        recognizedPoints: '1.25',
        explanationCode: 'legacy_below',
      },
    ]);
    const fallback = candidate({ ...rule, pointsAbove: null });
    expect(fallback.definition.roleRules[0].categoryRules[0].durationBands[1]).toMatchObject({
      recognizedPoints: '1.25',
      maxSecondsInclusive: null,
    });
  });

  it('converts 0.01 hours to exactly 36 seconds and normalizes Decimal strings', () => {
    const result = candidate({
      ...rule,
      durationThreshold: '0.01',
      pointsBelow: '1',
      pointsAbove: '2.5',
    });
    expect(result.definition.roleRules[0].categoryRules[0].durationBands).toMatchObject([
      { maxSecondsInclusive: 36, recognizedPoints: '1.00' },
      { maxSecondsInclusive: null, recognizedPoints: '2.50' },
    ]);
  });

  it('source fingerprint and definition are independent of input row order', () => {
    const other: LegacyContributionSourceRule = {
      ...rule,
      id: 'rule-2',
      attendanceRoleCode: 'leader',
      durationThreshold: null,
      pointsBelow: '3.00',
    };
    const twoRoles: LegacyContributionMapping = {
      ...mapping,
      roleMappings: [
        ...mapping.roleMappings,
        {
          sourceRoleCode: 'leader',
          targetRoleCode: 'captain',
          belowExplanationCode: 'legacy_below',
          aboveExplanationCode: 'legacy_above',
        },
      ],
    };
    const a = buildLegacyContributionCandidate([rule, other], twoRoles);
    const b = buildLegacyContributionCandidate([other, rule], {
      ...twoRoles,
      roleMappings: [...twoRoles.roleMappings].reverse(),
    });
    expect(b).toEqual(a);
  });

  it('source fingerprint changes when the old row revision changes', () => {
    const original = candidate();
    const revised = candidate({ ...rule, updatedAt: '2026-09-25T00:00:01.000Z' });
    expect(revised.definition).toEqual(original.definition);
    expect(revised.sourceFingerprint).not.toBe(original.sourceFingerprint);
  });

  it.each([
    ['inactive', { ...rule, status: 'INACTIVE' as const }],
    ['soft deleted', { ...rule, deletedAt: '2026-01-01T00:00:00.000Z' }],
    ['wrong type', { ...rule, activityTypeCode: 'other' }],
    ['negative threshold', { ...rule, durationThreshold: '-1.00' }],
    ['subcent threshold', { ...rule, durationThreshold: '1.001' }],
    ['negative points', { ...rule, pointsBelow: '-1.00' }],
    ['out-of-range points', { ...rule, pointsAbove: '1000.00' }],
    ['invalid revision timestamp', { ...rule, updatedAt: '2026-02-30T00:00:00.000Z' }],
  ])('rejects %s without silently converting', (_name, source) => {
    expect(() => candidate(source)).toThrow(TypeError);
  });

  it('rejects duplicate source IDs, roles, missing mappings and duplicate target roles', () => {
    expect(() => buildLegacyContributionCandidate([rule, rule], mapping)).toThrow(TypeError);
    expect(() => candidate(rule, { ...mapping, roleMappings: [] })).toThrow(TypeError);
    expect(() =>
      candidate(rule, {
        ...mapping,
        roleMappings: [{ ...mapping.roleMappings[0], sourceRoleCode: 'other' }],
      }),
    ).toThrow(TypeError);
    expect(() =>
      buildLegacyContributionCandidate(
        [rule, { ...rule, id: 'rule-2', attendanceRoleCode: 'leader' }],
        {
          ...mapping,
          roleMappings: [
            ...mapping.roleMappings,
            {
              sourceRoleCode: 'leader',
              targetRoleCode: 'member',
              belowExplanationCode: 'legacy_below',
              aboveExplanationCode: 'legacy_above',
            },
          ],
        },
      ),
    ).toThrow(TypeError);
  });

  it('rejects source identity collisions even with otherwise complete mapping', () => {
    const anotherMapping: LegacyContributionMapping = {
      ...mapping,
      roleMappings: [
        ...mapping.roleMappings,
        {
          sourceRoleCode: 'leader',
          targetRoleCode: 'captain',
          belowExplanationCode: 'legacy_below',
          aboveExplanationCode: 'legacy_above',
        },
      ],
    };
    expect(() =>
      buildLegacyContributionCandidate(
        [rule, { ...rule, attendanceRoleCode: 'leader' }],
        anotherMapping,
      ),
    ).toThrow(TypeError);
  });

  it('rejects unapproved category, malformed default and extra source fields', () => {
    expect(() =>
      candidate(rule, {
        ...mapping,
        timeCategoryCode: 'unknown' as LegacyContributionMapping['timeCategoryCode'],
      }),
    ).toThrow(TypeError);
    expect(() =>
      candidate(rule, {
        ...mapping,
        defaultResult: { recognizedPoints: '-1.00', explanationCode: 'explicit_no_rule' },
      }),
    ).toThrow(TypeError);
    expect(() =>
      candidate({ ...rule, remark: 'must not copy' } as LegacyContributionSourceRule),
    ).toThrow(TypeError);
  });

  it('does not claim a final policy-version hash without explicit effective dates', () => {
    const result = candidate();
    expect(result).not.toHaveProperty('definitionHash');
    expect(() =>
      fingerprintContributionPolicyVersion({
        schemaVersion: 1,
        definition: result.definition,
        evaluatorVersion: 1,
        effectiveFrom: undefined,
        effectiveUntil: null,
      }),
    ).toThrow(TypeError);
  });
});
