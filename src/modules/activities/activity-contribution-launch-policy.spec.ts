import {
  NATIVE_CONTRIBUTION_LAUNCH_LIMITS as limits,
  assertNativeContributionLaunchCount as count,
  assertNativeContributionLaunchEvaluations as evaluations,
  assertNativeContributionLaunchJson as json,
  assertNativeContributionLaunchPolicies as policies,
  assertNativeContributionLaunchSources as sources,
  assertNativeContributionLaunchSpans as spans,
  assertNativeContributionLaunchTimePolicies as timePolicies,
  assertNativeContributionLaunchTotal as total,
} from './activity-contribution-launch-policy';
import {
  ContributionSettlementPolicyError,
  type ContributionSource,
} from './activity-contribution-settlement-policy';

const band = { maxSecondsInclusive: null, recognizedPoints: '1.00', explanationCode: 'service' };
const category = { timeCategoryCode: 'volunteer_service', durationBands: [band] };
const role = { attendanceRoleCode: 'service', categoryRules: [category] };
const definition = {
  defaultResult: { recognizedPoints: '0.00', explanationCode: 'zero' },
  roleRules: [role],
};
const interval = {
  startsAt: new Date('2026-10-01T15:59:59.000Z'),
  endsAt: new Date('2026-10-02T16:00:00.000Z'),
};

function over(action: () => unknown) {
  expect(action).toThrow(new ContributionSettlementPolicyError('scale_limit'));
}

function source(identity: string): ContributionSource {
  return {
    participationIdentityId: identity,
    memberId: 'member',
    sessionId: 'session',
    ruleSnapshotId: 'snapshot',
    attendanceRoleCode: 'service',
    timeCategoryCode: 'volunteer_service',
    selection: { id: 'selection', mode: 'policy', policy: null },
    allocationRevisionId: 'allocation',
    sliceId: identity,
    sourceSegmentId: 'segment',
    sourceSegmentRevision: 1,
    allocationHash: 'a'.repeat(64),
    durationSeconds: 1,
    ...interval,
  };
}

describe('active native whole-activity launch envelope', () => {
  it.each([
    ['identities', 2000],
    ['segments', 10000],
    ['allocations', 10000],
    ['slices', 50000],
    ['buckets', 8000],
    ['bucketSources', 40000],
    ['evaluations', 8000],
    ['sourceRefs', 50000],
    ['punchEvents', 20000],
    ['selectionScopes', 32],
    ['policyVersions', 1],
    ['snapshots', 1],
    ['dayPieces', 50000],
    ['sourceBytes', 49283072],
    ['evaluationBytes', 53477376],
  ] as const)(
    'accepts the %s boundary and rejects one extra without truncation',
    (dimension, maximum) => {
      expect(limits[dimension]).toBe(maximum);
      expect(() => count(maximum, dimension)).not.toThrow();
      over(() => count(maximum + 1, dimension));
    },
  );

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects malformed counts: %s',
    (value) => {
      expect(() => count(value, 'identities')).toThrow(
        new ContributionSettlementPolicyError('invalid'),
      );
    },
  );

  it('counts the whole manifest, including rows later filtered out of evaluation', () => {
    expect(total([25000, 25000], 'slices')).toBe(50000);
    over(() => total([25000, 25001], 'slices'));
    expect(() => total([50000, -1], 'slices')).toThrow();
  });

  it('uses UTF-8 bytes and exact bigint text for locally serialized storage values', () => {
    expect(() => json('x'.repeat(limits.policyBytes - 2), 'policyBytes')).not.toThrow();
    over(() => json('x'.repeat(limits.policyBytes - 1), 'policyBytes'));
    over(() => json('中'.repeat(3000), 'policyBytes'));
    expect(() => json({ milliseconds: 9007199254740993n }, 'sourceBytes')).not.toThrow();
    expect(() => json(undefined, 'sourceBytes')).toThrow();
  });

  it('admits one frozen simple policy and counts unused policies as real work', () => {
    const input = [{ definitionJson: definition }];
    const before = JSON.stringify(input);
    expect(() => policies(input)).not.toThrow();
    over(() => policies([...input, ...input]));
    expect(JSON.stringify(input)).toBe(before);
  });

  it('rejects a second role or a third duration band even with one identity', () => {
    over(() =>
      policies([
        {
          definitionJson: {
            ...definition,
            roleRules: [role, { ...role, attendanceRoleCode: 'other' }],
          },
        },
      ]),
    );
    over(() =>
      policies([
        {
          definitionJson: {
            ...definition,
            roleRules: [
              {
                ...role,
                categoryRules: [
                  {
                    ...category,
                    durationBands: [
                      { ...band, maxSecondsInclusive: 100 },
                      { ...band, maxSecondsInclusive: 200 },
                      band,
                    ],
                  },
                ],
              },
            ],
          },
        },
      ]),
    );
  });

  it('admits the four-category/eight-band boundary and rejects malformed definitions', () => {
    const categoryRules = ['volunteer_service', 'training', 'organization', 'non_creditable'].map(
      (timeCategoryCode) => ({
        timeCategoryCode,
        durationBands: [{ ...band, maxSecondsInclusive: 3599 }, band],
      }),
    );
    expect(() =>
      policies([{ definitionJson: { ...definition, roleRules: [{ ...role, categoryRules }] } }]),
    ).not.toThrow();
    expect(() =>
      policies([{ definitionJson: { ...definition, roleRules: 'not-an-array' } }]),
    ).toThrow();
  });

  it('bounds time policy versions, role mappings and serialized definitions too', () => {
    const policy = {
      definitionJson: {
        defaultCategory: 'volunteer_service',
        roleMappings: [{ attendanceRoleCode: 'service', category: 'volunteer_service' }],
        allowSplit: true,
        specialIntervals: {
          preparation: { mode: 'exclude' },
          duty: { mode: 'exclude' },
          travel: { mode: 'exclude' },
        },
        rounding: { mode: 'floor', quantumSeconds: 1 },
        evidence: { requiredSources: [], requireManualRecognition: false },
        manualAdjustment: { enabled: false },
      },
    };
    expect(() => timePolicies([policy])).not.toThrow();
    over(() => timePolicies([policy, policy]));
    over(() =>
      timePolicies([
        {
          definitionJson: {
            ...policy.definitionJson,
            roleMappings: [
              ...policy.definitionJson.roleMappings,
              { attendanceRoleCode: 'other', category: 'training' },
            ],
          },
        },
      ]),
    );
  });

  it('handles Beijing midnight with an exclusive end before any day-by-day loop', () => {
    expect(() => spans([interval])).not.toThrow();
    over(() => spans([{ ...interval, endsAt: new Date(interval.endsAt.getTime() + 1) }]));
    over(() => spans([{ startsAt: new Date('2000-01-01'), endsAt: new Date('2100-01-01') }]));
    expect(() => spans([{ ...interval, startsAt: new Date('invalid') }])).toThrow();
    expect(() => spans([{ startsAt: interval.endsAt, endsAt: interval.startsAt }])).toThrow();
  });

  it('bounds all physical slices even when their duration or eventual award is zero', () => {
    const zero = { startsAt: interval.startsAt, endsAt: interval.startsAt };
    expect(() => spans(Array.from({ length: 25000 }, () => interval))).not.toThrow();
    over(() => spans(Array.from({ length: 50001 }, () => zero)));
  });

  it('counts8000 semantic units and50000 physical refs independently', () => {
    const units = Array.from({ length: 8000 }, (_, i) => source(String(i)));
    const refs = Array.from({ length: 50000 }, (_, i) => units[i % units.length]);
    expect(() => sources(refs)).not.toThrow();
    over(() => sources([...units, source('extra')]));
    over(() => sources([...refs, units[0]]));
  });

  it('does not make cumulative historical revision counts business admission limits', () => {
    expect(limits).not.toHaveProperty('segmentRevisions');
    expect(limits).not.toHaveProperty('allocationRevisions');
  });

  it('independently verifies actual evaluated units and aggregate day rows', () => {
    const empty = { sourceRefsJson: [], beijingDayPointsJson: [] };
    expect(() => evaluations(Array.from({ length: 8000 }, () => empty))).not.toThrow();
    over(() => evaluations(Array.from({ length: 8001 }, () => empty)));
    const dayRow = { ledgerDate: '2026-10-01', recognizedPoints: '0.00' };
    expect(() =>
      evaluations([
        { ...empty, beijingDayPointsJson: Array.from({ length: 50000 }, () => dayRow) },
      ]),
    ).not.toThrow();
    over(() =>
      evaluations([
        { ...empty, beijingDayPointsJson: Array.from({ length: 50001 }, () => dayRow) },
      ]),
    );
  });
});
