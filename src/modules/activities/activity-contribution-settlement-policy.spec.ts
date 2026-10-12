import { fingerprintContributionPolicyVersion } from './activity-contribution-policy-definition';
import { parseActivityContributionPolicySelectionValue } from './activity-contribution-policy-selection';
import { parseActivityRuleSnapshotV9ContributionPolicyPointers } from './activity-publish-proposal-v9';
import {
  canonicalizeActivityTemplateDefinition,
  computeActivityTemplateDefinitionHash,
} from './activity-template-definition';
import * as templateCanonical from './activity-template-definition';
import {
  ContributionSettlementPolicyError,
  evaluateSettlementContributions,
  type ContributionFrozenPolicy,
  type ContributionSource,
  type ContributionSourceKind,
} from './activity-contribution-settlement-policy';

const effectiveFrom = new Date('2026-01-01T00:00:00.000Z');
function policy(value = '1.00'): ContributionFrozenPolicy {
  const envelope = fingerprintContributionPolicyVersion({
    schemaVersion: 1,
    evaluatorVersion: 1,
    effectiveFrom: effectiveFrom.toISOString(),
    effectiveUntil: null,
    definition: {
      defaultResult: { recognizedPoints: '0.00', explanationCode: 'default_zero' },
      roleRules: [
        {
          attendanceRoleCode: 'participant',
          categoryRules: [
            {
              timeCategoryCode: 'training',
              durationBands: [
                {
                  maxSecondsInclusive: 60,
                  recognizedPoints: '0.00',
                  explanationCode: 'below_threshold',
                },
                {
                  maxSecondsInclusive: null,
                  recognizedPoints: value,
                  explanationCode: 'training_credit',
                },
              ],
            },
          ],
        },
      ],
    },
  });
  return {
    policyId: 'policy-one',
    versionId: 'version-one',
    schemaVersion: 1,
    definitionJson: envelope.definition,
    definitionHash: envelope.definitionHash,
    evaluatorVersion: 1,
    effectiveFrom,
    effectiveUntil: null,
  };
}
function source(overrides: Partial<ContributionSource> = {}): ContributionSource {
  return {
    participationIdentityId: 'identity-one',
    memberId: 'member-one',
    sessionId: 'session-one',
    ruleSnapshotId: 'snapshot-one',
    attendanceRoleCode: 'participant',
    timeCategoryCode: 'training',
    selection: { id: 'selection-one', mode: 'policy', policy: policy() },
    allocationRevisionId: 'allocation-one',
    sliceId: 'slice-one',
    sourceSegmentId: 'segment-one',
    sourceSegmentRevision: 1,
    allocationHash: 'a'.repeat(64),
    durationSeconds: 120,
    startsAt: new Date('2026-10-01T15:59:00.000Z'),
    endsAt: new Date('2026-10-01T16:01:00.000Z'),
    ...overrides,
  };
}
function evaluate(
  sources: ContributionSource[],
  sourceKindCode: ContributionSourceKind = 'time_revision',
) {
  return evaluateSettlementContributions({
    activityId: 'activity-one',
    settlementVersionId: 'settlement-one',
    sourceKindCode,
    sources,
  });
}
function twoSources() {
  const frozenPolicy = policy();
  return [
    source({
      durationSeconds: 60,
      startsAt: new Date('2026-10-01T15:59:00.000Z'),
      endsAt: new Date('2026-10-01T16:00:00.000Z'),
      selection: { id: 'selection-b', mode: 'policy', policy: frozenPolicy },
    }),
    source({
      allocationRevisionId: 'allocation-two',
      sliceId: 'slice-two',
      sourceSegmentId: 'segment-two',
      durationSeconds: 60,
      startsAt: new Date('2026-10-01T16:00:00.000Z'),
      endsAt: new Date('2026-10-01T16:01:00.000Z'),
      selection: { id: 'selection-a', mode: 'policy', policy: frozenPolicy },
    }),
  ];
}

describe('E4 pure contribution evaluation', () => {
  // Captured from the original pre-§12.20 implementation, before either production edit.
  it.each<[ContributionSourceKind, string, string]>([
    ['time_revision', '0.00', '0edd637acf05492349e2c7cc055d6c31fbcdb317ad6c9797a200961f564376f7'],
    ['time_revision', '1.01', '5a0a1cec6570101154842db954354010643164166be0d4d5d2122e798e034f4d'],
    ['time_revision', '999.99', '0f3f202aee06088f39bc9a0302079acd3df9ee038315dc4b736552dc2ae2bad2'],
    [
      'correction_time_proof',
      '1.01',
      'c064ad28276ac1d2994814bfbb92870525015555aa6e6bf4e32ca6d8987f7d57',
    ],
    ['unchanged_time', '1.01', '02921e1c192dff213a01190d6edbe8c38c761e574ad05d67f9dfce2a2b71a2c1'],
  ])('P-Local original complete result %s / %s', (kind, value, oldDigest) => {
    const frozenPolicy = policy(value);
    const ids = ['é', 'e\u0301', '😀', 'a"\\x', '中'];
    const sources = ids.map((id) =>
      source({
        selection: { id: `selection-${id}`, mode: 'policy', policy: { ...frozenPolicy } },
        allocationRevisionId: `allocation-${id}`,
        sliceId: kind === 'correction_time_proof' ? `allocation-${id}:0` : `slice-${id}`,
        sourceSegmentId: `segment-${id}`,
        ...(kind === 'correction_time_proof'
          ? {
              correctionSource: {
                proofId: `proof-${id}`,
                pendingAllocationId: null,
                sourceHash: 'b'.repeat(64),
                sliceOrdinal: 0,
              },
            }
          : {}),
      }),
    );
    const original = evaluate(sources, kind);
    expect(evaluate([...sources].reverse(), kind)).toEqual(original);
    const refs = original.evaluations[0].sourceRefsJson;
    // Independent original comparator, including UTF-16 ordering and escaped JSON values.
    expect(refs).toEqual(
      [...refs].sort((left, right) => {
        const a = canonicalizeActivityTemplateDefinition(left);
        const b = canonicalizeActivityTemplateDefinition(right);
        return a < b ? -1 : a > b ? 1 : 0;
      }),
    );
    expect(computeActivityTemplateDefinitionHash({ schemaVersion: 1, definition: original })).toBe(
      oldDigest,
    );
  });
  it('records the E1 contract gap: not_required is not an accepted selection mode', () => {
    expect(() =>
      parseActivityContributionPolicySelectionValue({ mode: 'not_required', pointer: null }),
    ).toThrow('invalid selection value');
    expect(
      parseActivityContributionPolicySelectionValue({ mode: 'inherit', pointer: null }),
    ).toEqual({ mode: 'inherit', pointer: null });
  });
  it('does not confuse an absent V9 policy envelope with explicit not_required evidence', () => {
    expect(parseActivityRuleSnapshotV9ContributionPolicyPointers(null)).toBeNull();
  });
  it('evaluates a policy once after merging segment durations, not once per selection', () => {
    const result = evaluate(twoSources());
    expect(result.evaluationCount).toBe(1);
    expect(result.recognizedPointsTotal).toBe('1.00');
    expect(result.evaluations[0]).toMatchObject({
      durationSeconds: 120,
      recognizedPoints: '1.00',
      selectionItemId: 'selection-a',
      explanationCode: 'training_credit',
    });
    expect(result.evaluations[0].sourceRefsJson.map((ref) => ref.selectionItemId).sort()).toEqual([
      'selection-a',
      'selection-b',
    ]);
  });
  it('keeps source ordering and hashes deterministic', () => {
    const refs = twoSources();
    expect(evaluate(refs)).toEqual(evaluate([...refs].reverse()));
  });
  it('P-Local computes each new reference sort key once without changing hash inputs', () => {
    const serializer = jest.spyOn(templateCanonical, 'canonicalizeActivityTemplateDefinition');
    try {
      const result = evaluate(twoSources());
      const refCalls = serializer.mock.calls.filter(
        ([value]) =>
          value !== null && typeof value === 'object' && Reflect.has(value, 'sourceSegmentId'),
      );
      expect(refCalls).toHaveLength(2);
      expect(result.evaluations[0].sourceRefsJson).toHaveLength(2);
      expect(result.recognizedPointsTotal).toBe('1.00');
    } finally {
      serializer.mockRestore();
    }
  });
  it('keeps positive training points independent of volunteer hours', () => {
    const result = evaluate([source()]);
    expect(result.evaluations[0].timeCategoryCode).toBe('training');
    expect(result.evaluations[0].recognizedPoints).toBe('1.00');
  });
  it('keeps positive volunteer duration with an explicit zero contribution result', () => {
    const result = evaluate([source({ timeCategoryCode: 'volunteer_service' })]);
    expect(result.evaluations[0]).toMatchObject({
      durationSeconds: 120,
      recognizedPoints: '0.00',
      explanationCode: 'default_zero',
    });
  });
  it('retains the policy and source evidence for explicit zero-contribution training', () => {
    const frozenPolicy = policy('0.00');
    const result = evaluate([
      source({
        selection: { id: 'zero-training-selection', mode: 'policy', policy: frozenPolicy },
      }),
    ]);
    expect(result.evaluations[0]).toMatchObject({
      mode: 'policy',
      timeCategoryCode: 'training',
      policyId: frozenPolicy.policyId,
      policyVersionId: frozenPolicy.versionId,
      definitionHash: frozenPolicy.definitionHash,
      evaluatorVersion: frozenPolicy.evaluatorVersion,
      calculatedPoints: '0.00',
      recognizedPoints: '0.00',
      explanationCode: 'training_credit',
    });
    expect(result.evaluations[0].sourceRefsJson).toHaveLength(1);
    expect(result.evaluations[0].beijingDayPointsJson).toEqual([
      { ledgerDate: '2026-10-01', recognizedPoints: '0.00' },
      { ledgerDate: '2026-10-02', recognizedPoints: '0.00' },
    ]);
  });
  it('evaluates 2,000 identities and retains all 10,000 source references without per-slice rewards', () => {
    const base = source();
    const sources = Array.from({ length: 2_000 }, (_, identity) =>
      Array.from({ length: 5 }, (_, segment) => ({
        ...base,
        participationIdentityId: `identity-${identity}`,
        memberId: `member-${identity}`,
        allocationRevisionId: `allocation-${identity}`,
        sliceId: `slice-${identity}-${segment}`,
        sourceSegmentId: `segment-${identity}-${segment}`,
        startsAt: new Date(Date.UTC(2026, 9, 1, 15, 58) + segment * 120_000),
        endsAt: new Date(Date.UTC(2026, 9, 1, 15, 58) + (segment + 1) * 120_000),
      })),
    ).flat();
    const result = evaluate(sources);
    expect(result.evaluationCount).toBe(2_000);
    expect(result.recognizedPointsTotal).toBe('2000.00');
    expect(new Set(result.evaluations.map((entry) => entry.participationIdentityId)).size).toBe(
      2_000,
    );
    expect(result.evaluations.every((entry) => entry.durationSeconds === 600)).toBe(true);
    expect(result.evaluations.every((entry) => entry.recognizedPoints === '1.00')).toBe(true);
    expect(result.evaluations.every((entry) => entry.sourceRefsJson.length === 5)).toBe(true);
    const sourceKeys = result.evaluations.flatMap((entry) =>
      entry.sourceRefsJson.map(
        (ref) => `${entry.participationIdentityId}/${ref.allocationRevisionId}/${ref.sliceId}`,
      ),
    );
    expect(sourceKeys).toHaveLength(10_000);
    expect(new Set(sourceKeys).size).toBe(10_000);
  });
  it('rejects a 2,001st identity instead of partially evaluating a capped population', () => {
    const base = source();
    const sources = Array.from({ length: 2_001 }, (_, identity) => ({
      ...base,
      participationIdentityId: `identity-${identity}`,
      memberId: `member-${identity}`,
    }));
    expect(() => evaluate(sources)).toThrow(new ContributionSettlementPolicyError('scale_limit'));
  });
  it('rejects more than 50,000 source slices before any partial evaluation', () => {
    const base = source();
    const sources = Array.from({ length: 50_001 }, () => base);
    expect(() => evaluate(sources)).toThrow(new ContributionSettlementPolicyError('scale_limit'));
  });
  it('honors the inclusive threshold and the original defaultResult', () => {
    expect(evaluate([source({ durationSeconds: 60 })]).evaluations[0].explanationCode).toBe(
      'below_threshold',
    );
    expect(
      evaluate([source({ attendanceRoleCode: 'unknown-role' })]).evaluations[0].explanationCode,
    ).toBe('default_zero');
  });
  it('splits a single evaluated result at Beijing midnight without evaluating twice', () => {
    const result = evaluate([
      source({ selection: { id: 'selection-one', mode: 'policy', policy: policy('1.01') } }),
    ]);
    expect(result.evaluations[0].beijingDayPointsJson).toEqual([
      { ledgerDate: '2026-10-01', recognizedPoints: '0.51' },
      { ledgerDate: '2026-10-02', recognizedPoints: '0.50' },
    ]);
    expect(result.recognizedPointsTotal).toBe('1.01');
  });
  it('uses recognized-second weights, not each segment raw duration, for daily distribution', () => {
    const refs = twoSources();
    expect(
      evaluate([
        { ...refs[0], durationSeconds: 30 },
        { ...refs[1], durationSeconds: 90 },
      ]).evaluations[0].beijingDayPointsJson,
    ).toEqual([
      { ledgerDate: '2026-10-01', recognizedPoints: '0.25' },
      { ledgerDate: '2026-10-02', recognizedPoints: '0.75' },
    ]);
  });
  it('rejects unsupported not_required rather than creating unapproved zero evidence', () => {
    const invalid = source({ selection: { id: 'selection-none', mode: 'policy', policy: null } });
    Reflect.set(invalid.selection, 'mode', 'not_required');
    expect(() => evaluate([invalid])).toThrow(
      new ContributionSettlementPolicyError('source_not_ready'),
    );
  });
  it('rejects a missing policy rather than interpreting it as zero', () => {
    expect(() =>
      evaluate([source({ selection: { id: 'missing', mode: 'policy', policy: null } })]),
    ).toThrow(ContributionSettlementPolicyError);
  });
  it('rejects a policy hidden under not_required', () => {
    const invalid = source();
    Reflect.set(invalid.selection, 'mode', 'not_required');
    expect(() => evaluate([invalid])).toThrow(ContributionSettlementPolicyError);
  });
  it('rejects a changed policy definition behind an unchanged hash', () => {
    const original = policy();
    expect(() =>
      evaluate([
        source({
          selection: {
            id: 'selection-one',
            mode: 'policy',
            policy: {
              ...original,
              definitionJson: policy('2.00').definitionJson,
            },
          },
        }),
      ]),
    ).toThrow(ContributionSettlementPolicyError);
  });
  it('rejects contradictory definitions of the same immutable version inside one request', () => {
    const refs = twoSources();
    expect(() =>
      evaluate([
        refs[0],
        {
          ...refs[1],
          selection: { id: 'selection-other', mode: 'policy', policy: policy('2.00') },
        },
      ]),
    ).toThrow(ContributionSettlementPolicyError);
  });
  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects duration %s',
    (durationSeconds) => {
      expect(() => evaluate([source({ durationSeconds })])).toThrow(
        ContributionSettlementPolicyError,
      );
    },
  );
  it('rejects duplicate allocation/slice evidence even under another selection', () => {
    const first = source();
    expect(() =>
      evaluate([first, { ...first, selection: { ...first.selection, id: 'other-selection' } }]),
    ).toThrow(ContributionSettlementPolicyError);
  });
  it('rejects a member mismatch for one participation identity', () => {
    const refs = twoSources();
    expect(() => evaluate([refs[0], { ...refs[1], memberId: 'other-member' }])).toThrow(
      ContributionSettlementPolicyError,
    );
  });
  it('rejects mixing rule snapshots within a session', () => {
    const refs = twoSources();
    expect(() => evaluate([refs[0], { ...refs[1], ruleSnapshotId: 'other-snapshot' }])).toThrow(
      ContributionSettlementPolicyError,
    );
  });
  it('keeps policy, role, category and session in distinct evaluation units', () => {
    const first = source();
    const others = [
      source({ sliceId: 'slice-role', attendanceRoleCode: 'organizer' }),
      source({ sliceId: 'slice-category', timeCategoryCode: 'organization' }),
      source({
        sliceId: 'slice-session',
        sessionId: 'session-two',
        ruleSnapshotId: 'snapshot-two',
      }),
    ];
    expect(evaluate([first, ...others]).evaluationCount).toBe(4);
  });
  it('rejects per-identity sums above Decimal(5,2) instead of truncating', () => {
    const first = source({ selection: { id: 'large', mode: 'policy', policy: policy('999.99') } });
    expect(() =>
      evaluate([
        first,
        {
          ...first,
          sliceId: 'slice-two',
          sessionId: 'session-two',
          ruleSnapshotId: 'snapshot-two',
        },
      ]),
    ).toThrow(ContributionSettlementPolicyError);
  });
  it('does not incorrectly apply the per-person limit to the multi-person root', () => {
    const first = source({ selection: { id: 'large', mode: 'policy', policy: policy('999.99') } });
    const result = evaluate([
      first,
      { ...first, participationIdentityId: 'identity-two', memberId: 'member-two' },
    ]);
    expect(result.recognizedPointsTotal).toBe('1999.98');
  });
  it('creates a real zero-set fingerprint without fabricated evaluations', () => {
    expect(evaluate([])).toMatchObject({
      evaluationCount: 0,
      recognizedPointsTotal: '0.00',
      evaluations: [],
    });
  });
  it('permits zero seconds and zero points without a fabricated business day', () => {
    const result = evaluate([
      source({ durationSeconds: 0, endsAt: new Date('2026-10-01T15:59:00.000Z') }),
    ]);
    expect(result.evaluations[0].beijingDayPointsJson).toEqual([]);
  });
  it('rejects nonzero default points with no provable recognized coverage', () => {
    const original = policy();
    const definition = {
      defaultResult: { recognizedPoints: '1.00', explanationCode: 'fixed' },
      roleRules: [],
    };
    const envelope = fingerprintContributionPolicyVersion({
      schemaVersion: 1,
      evaluatorVersion: 1,
      definition,
      effectiveFrom: effectiveFrom.toISOString(),
      effectiveUntil: null,
    });
    expect(() =>
      evaluate([
        source({
          durationSeconds: 0,
          selection: {
            id: 'fixed',
            mode: 'policy',
            policy: {
              ...original,
              definitionJson: definition,
              definitionHash: envelope.definitionHash,
            },
          },
        }),
      ]),
    ).toThrow(ContributionSettlementPolicyError);
  });
  it('separates D4, D7 and inherited-source fingerprint domains', () => {
    const sources = [source()];
    const hashes = ['time_revision', 'correction_time_proof', 'unchanged_time'].map(
      (domain) =>
        evaluate(
          domain === 'correction_time_proof'
            ? [
                source({
                  sliceId: `${sources[0].allocationRevisionId}:0`,
                  correctionSource: {
                    proofId: 'current-proof',
                    pendingAllocationId: null,
                    sourceHash: 'a'.repeat(64),
                    sliceOrdinal: 0,
                  },
                }),
              ]
            : sources,
          domain as ContributionSourceKind,
        ).sourceSetHash,
    );
    expect(new Set(hashes).size).toBe(3);
  });
  it('validates the four-value time-category domain at runtime', () => {
    const invalid = source();
    Reflect.set(invalid, 'timeCategoryCode', 'unknown_category');
    expect(() => evaluate([invalid])).toThrow(ContributionSettlementPolicyError);
  });
  it('rejects invalid date/hash evidence', () => {
    expect(() => evaluate([source({ startsAt: new Date(NaN) })])).toThrow(
      ContributionSettlementPolicyError,
    );
    expect(() => evaluate([source({ allocationHash: 'not-a-hash' })])).toThrow(
      ContributionSettlementPolicyError,
    );
  });
  it.each(['single', 'reordered-unicode', 'zero', 'correction'] as const)(
    'preserves the full evaluation and original generic hashes: %s',
    (name) => {
      let rows: ContributionSource[];
      let domain: ContributionSourceKind = 'time_revision';
      if (name === 'reordered-unicode')
        rows = [
          source({
            sliceId: '片"z',
            allocationRevisionId: 'allocation-z',
            selection: { id: '选择"z', mode: 'policy', policy: policy() },
          }),
          source({ sliceId: '片a', allocationRevisionId: 'allocation-a' }),
        ];
      else if (name === 'zero')
        rows = [source({ durationSeconds: 0, endsAt: new Date('2026-10-01T15:59:00.000Z') })];
      else if (name === 'correction') {
        domain = 'correction_time_proof';
        rows = [
          source({
            sliceId: 'allocation-one:0',
            correctionSource: {
              proofId: 'proof',
              pendingAllocationId: null,
              sourceHash: 'a'.repeat(64),
              sliceOrdinal: 0,
            },
          }),
        ];
      } else rows = [source()];
      const result = evaluate(rows, domain);
      expect(result).toMatchSnapshot(name);
      for (const row of result.evaluations) {
        expect(row.sourceFingerprint).toBe(
          computeActivityTemplateDefinitionHash({
            schemaVersion: 1,
            definition: { domain, sources: row.sourceRefsJson },
          }),
        );
        const { evaluationHash, ...definition } = row;
        expect(evaluationHash).toBe(
          computeActivityTemplateDefinitionHash({ schemaVersion: 1, definition }),
        );
      }
    },
  );
});
