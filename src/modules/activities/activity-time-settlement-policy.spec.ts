import type { CurrentParticipationSegment } from '../attendances/participation-segment.facade';
import {
  buildActivityTimeAllocationManifest,
  type ActivityTimeAllocationSliceInput,
} from './activity-time-allocation-command';
import {
  fingerprintTimePolicyVersion,
  type TimePolicyDefinition,
} from './activity-time-policy-definition';
import {
  buildTimeSettlementBuckets,
  roundTimeSettlementMilliseconds,
  TimeSettlementPolicyError,
  type TimeSettlementAllocation,
  type TimeSettlementFrozenPolicy,
  type TimeSettlementPopulation,
} from './activity-time-settlement-policy';

function policy(
  overrides: Partial<TimePolicyDefinition> = {},
  id = 'policy-version-1',
): TimeSettlementFrozenPolicy {
  const definition: TimePolicyDefinition = {
    defaultCategory: 'volunteer_service',
    roleMappings: [],
    allowSplit: true,
    specialIntervals: {
      preparation: { mode: 'exclude' },
      duty: { mode: 'exclude' },
      travel: { mode: 'exclude' },
    },
    rounding: { mode: 'floor', quantumSeconds: 60 },
    evidence: { requiredSources: ['service_segment'], requireManualRecognition: false },
    manualAdjustment: { enabled: true, reasonRequired: true, evidenceRequired: false },
    ...overrides,
  };
  const document = fingerprintTimePolicyVersion({
    schemaVersion: 1,
    evaluatorVersion: 1,
    definition,
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    effectiveUntil: null,
  });
  return {
    id,
    schemaVersion: 1,
    evaluatorVersion: 1,
    definitionJson: definition,
    definitionHash: document.definitionHash,
    effectiveFrom: new Date(document.effectiveFrom),
    effectiveUntil: null,
  };
}

function segment(
  id: string,
  start: string,
  end: string,
  identity = 'identity-1',
  memberId = 'member-1',
): CurrentParticipationSegment {
  return {
    id,
    activityId: 'activity-1',
    sessionId: 'session-1',
    participationIdentityId: identity,
    memberId,
    sourcePositionId: null,
    segmentKey: id,
    revision: 1,
    sourceCheckInEventId: 'check-in-' + id,
    sourceCloseEventId: 'close-' + id,
    resultCode: 'valid',
    statusCode: 'draft',
    checkInAt: new Date(start),
    checkOutAt: new Date(end),
    lateFlag: false,
    earlyLeaveFlag: false,
    exceptionFlagsJson: null,
  };
}

function allocation(
  source: CurrentParticipationSegment,
  frozen: TimeSettlementFrozenPolicy,
  slices?: readonly ActivityTimeAllocationSliceInput[],
): TimeSettlementAllocation {
  if (!source.checkOutAt) throw new Error('fixture requires closed source');
  const recognized = slices ?? [
    {
      categoryCode: 'volunteer_service',
      intervalKindCode: 'service_segment',
      startAt: source.checkInAt.toISOString(),
      endAt: source.checkOutAt.toISOString(),
    },
  ];
  return {
    id: 'allocation-' + source.id,
    participationIdentityId: source.participationIdentityId,
    memberId: source.memberId,
    sourceSegmentId: source.id,
    sourceSegmentRevision: source.revision,
    policyVersionId: frozen.id,
    definitionHash: frozen.definitionHash,
    evaluatorVersion: 1,
    attendanceRoleCode: null,
    recognitionModeCode: slices ? 'manual' : 'automatic',
    manualReason: slices ? '现场确认分类' : null,
    allocationHash: buildActivityTimeAllocationManifest(recognized).allocationHash,
    slices: recognized,
  };
}

const first = segment('segment-1', '2026-09-12T08:00:00.000Z', '2026-09-12T08:00:59.000Z');
const second = segment('segment-2', '2026-09-12T08:01:00.000Z', '2026-09-12T08:01:59.000Z');
const population: readonly TimeSettlementPopulation[] = [
  { participationIdentityId: 'identity-1', memberId: 'member-1', pending: false },
];
const frozen = policy();

function input(segments: readonly CurrentParticipationSegment[] = [first, second]) {
  return {
    activityId: 'activity-1',
    population,
    segments,
    allocations: segments.map((source) => allocation(source, frozen)),
    policies: [frozen],
  };
}

function expectReason(action: () => unknown, reason: TimeSettlementPolicyError['reason']): void {
  expect(action).toThrow(new TimeSettlementPolicyError(reason));
}

describe('D4 classification aggregation', () => {
  it('sums two 59-second sources before the single 60-second rounding step', () => {
    const result = buildTimeSettlementBuckets(input());
    expect(result.bucketCount).toBe(4);
    expect(result.sourceCount).toBe(8);
    expect(result.buckets[0]).toMatchObject({
      rawRecognizedMilliseconds: 118000n,
      rawCalculatedMilliseconds: 118000n,
      recognizedSeconds: 60,
      calculatedSeconds: 60,
      quantumSeconds: 60,
      adjustmentReason: null,
    });
    expect(result.buckets.slice(1).map((bucket) => bucket.recognizedSeconds)).toEqual([0, 0, 0]);
    expect(result.buckets.every((bucket) => bucket.sources.length === 2)).toBe(true);
  });

  it('rounds per identity and category, never by summing rounded segments', () => {
    const sources = [
      first,
      { ...second, participationIdentityId: 'identity-2', memberId: 'member-2' },
    ];
    const result = buildTimeSettlementBuckets({
      ...input(sources),
      population: [
        ...population,
        { participationIdentityId: 'identity-2', memberId: 'member-2', pending: false },
      ],
    });
    expect(result.buckets.map((bucket) => bucket.recognizedSeconds)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it('preserves exact sub-second durations in each source', () => {
    const sources = [
      segment('a', '2026-09-12T08:00:00.000Z', '2026-09-12T08:00:59.999Z'),
      segment('b', '2026-09-12T08:01:00.000Z', '2026-09-12T08:01:00.001Z'),
    ];
    const result = buildTimeSettlementBuckets(input(sources));
    expect(result.buckets[0].rawRecognizedMilliseconds).toBe(60000n);
    expect(result.buckets[0].recognizedSeconds).toBe(60);
    expect(result.buckets[0].sources.map((source) => source.rawRecognizedMilliseconds)).toEqual([
      59999n,
      1n,
    ]);
  });

  it('keeps manual recognized categories separate from recomputed automatic values', () => {
    const source = segment('manual', '2026-09-12T08:00:00.000Z', '2026-09-12T08:01:00.000Z');
    const revised = allocation(source, frozen, [
      {
        categoryCode: 'training',
        intervalKindCode: 'service_segment',
        startAt: '2026-09-12T08:00:00.000Z',
        endAt: '2026-09-12T08:01:00.000Z',
      },
    ]);
    const result = buildTimeSettlementBuckets({ ...input([source]), allocations: [revised] });
    expect(result.buckets[0]).toMatchObject({ calculatedSeconds: 60, recognizedSeconds: 0 });
    expect(result.buckets[1]).toMatchObject({
      calculatedSeconds: 0,
      recognizedSeconds: 60,
      adjustmentReason: [
        { allocationRevisionId: 'allocation-manual', manualReason: '现场确认分类' },
      ],
    });
  });

  it.each<Partial<TimePolicyDefinition>>([
    { evidence: { requiredSources: ['service_segment'], requireManualRecognition: true } },
    {
      specialIntervals: {
        preparation: { mode: 'manual' },
        duty: { mode: 'exclude' },
        travel: { mode: 'exclude' },
      },
    },
  ])('retains null when the frozen policy has no automatic interpretation', (change) => {
    const unknown = policy(change);
    const base = allocation(first, unknown);
    const manual = {
      ...base,
      recognitionModeCode: 'manual' as const,
      manualReason: '根据现场证据认定',
    };
    const result = buildTimeSettlementBuckets({
      ...input([first]),
      allocations: [manual],
      policies: [unknown],
    });
    expect(result.buckets.map((bucket) => bucket.calculatedSeconds)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(result.buckets.map((bucket) => bucket.rawCalculatedMilliseconds)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(
      result.buckets.every(
        (bucket) => bucket.adjustmentReason?.[0].manualReason === '根据现场证据认定',
      ),
    ).toBe(true);
  });

  it('rejects an automatic row when that policy requires manual recognition', () => {
    const manualOnly = policy({
      evidence: { requiredSources: [], requireManualRecognition: true },
    });
    expectReason(
      () =>
        buildTimeSettlementBuckets({
          ...input([first]),
          allocations: [allocation(first, manualOnly)],
          policies: [manualOnly],
        }),
      'invalid',
    );
  });

  it.each(['', ' ', '理由\n换行', 'x'.repeat(1025)])(
    'rejects invalid manual reason %s',
    (manualReason) => {
      expect(() =>
        buildTimeSettlementBuckets({
          ...input([first]),
          allocations: [
            { ...allocation(first, frozen), recognitionModeCode: 'manual', manualReason },
          ],
        }),
      ).toThrow();
    },
  );

  it('retains every manual reason once in deterministic allocation order', () => {
    const allocations = input().allocations.map((row, index) => ({
      ...row,
      recognitionModeCode: 'manual' as const,
      manualReason: '人工理由' + index,
    }));
    const result = buildTimeSettlementBuckets({
      ...input(),
      allocations: [...allocations].reverse(),
    });
    expect(result.buckets[0].adjustmentReason).toEqual([
      { allocationRevisionId: 'allocation-segment-1', manualReason: '人工理由0' },
      { allocationRevisionId: 'allocation-segment-2', manualReason: '人工理由1' },
    ]);
  });

  it.each(['voided', 'replaced', 'early_departure_zero'] as const)(
    'produces proven empty buckets for excluded result %s',
    (resultCode) => {
      const result = buildTimeSettlementBuckets({
        ...input(),
        segments: [{ ...first, resultCode }],
        allocations: [],
        policies: [],
      });
      expect(result.sourceCount).toBe(0);
      expect(result.buckets).toHaveLength(4);
      for (const bucket of result.buckets)
        expect(bucket).toMatchObject({
          recognizedSeconds: 0,
          calculatedSeconds: 0,
          timePolicyVersionId: null,
          definitionHash: null,
          evaluatorVersion: null,
          quantumSeconds: null,
          sources: [],
          emptyReasonCode: 'no_valid_segment',
        });
    },
  );

  it('does not substitute a zero bucket for a pending identity, open source or absent allocation', () => {
    expectReason(
      () =>
        buildTimeSettlementBuckets({
          ...input([]),
          population: [{ ...population[0], pending: true }],
        }),
      'source_not_ready',
    );
    expectReason(
      () => buildTimeSettlementBuckets({ ...input(), segments: [{ ...first, checkOutAt: null }] }),
      'invalid',
    );
    expectReason(
      () =>
        buildTimeSettlementBuckets({
          ...input([first]),
          segments: [{ ...first, checkOutAt: null }],
        }),
      'source_not_ready',
    );
    expectReason(
      () => buildTimeSettlementBuckets({ ...input([first]), allocations: [] }),
      'source_not_ready',
    );
  });

  it('rejects same-member overlaps across identities and permits adjacent half-open intervals', () => {
    const adjacent = segment(
      'adjacent',
      first.checkOutAt!.toISOString(),
      '2026-09-12T08:01:59.000Z',
    );
    expect(buildTimeSettlementBuckets(input([first, adjacent])).buckets[0].recognizedSeconds).toBe(
      60,
    );
    const overlap = segment(
      'overlap',
      '2026-09-12T08:00:58.000Z',
      '2026-09-12T08:01:00.000Z',
      'identity-2',
    );
    expectReason(
      () =>
        buildTimeSettlementBuckets({
          ...input([first, overlap]),
          population: [
            ...population,
            { participationIdentityId: 'identity-2', memberId: 'member-1', pending: false },
          ],
        }),
      'overlap',
    );
  });

  it('allows overlapping clock time belonging to different members', () => {
    const other = {
      ...first,
      id: 'other',
      segmentKey: 'other',
      participationIdentityId: 'identity-2',
      memberId: 'member-2',
    };
    expect(
      buildTimeSettlementBuckets({
        ...input([first, other]),
        population: [
          ...population,
          { participationIdentityId: 'identity-2', memberId: 'member-2', pending: false },
        ],
      }).bucketCount,
    ).toBe(8);
  });

  it('rejects distinct policy versions even with identical definitions and rounding', () => {
    const sameDefinitionOtherVersion = policy({}, 'policy-version-2');
    expectReason(
      () =>
        buildTimeSettlementBuckets({
          ...input(),
          allocations: [allocation(first, frozen), allocation(second, sameDefinitionOtherVersion)],
          policies: [frozen, sameDefinitionOtherVersion],
        }),
      'policy_mixed',
    );
  });

  it('rejects mixed quantum rather than choosing the latest or largest one', () => {
    const other = policy({ rounding: { mode: 'floor', quantumSeconds: 1 } }, 'policy-version-2');
    expectReason(
      () =>
        buildTimeSettlementBuckets({
          ...input(),
          allocations: [allocation(first, frozen), allocation(second, other)],
          policies: [frozen, other],
        }),
      'policy_mixed',
    );
  });

  it('requires an existing frozen policy and rejects tampered definition hashes', () => {
    expectReason(
      () => buildTimeSettlementBuckets({ ...input(), policies: [] }),
      'source_not_ready',
    );
    expectReason(
      () =>
        buildTimeSettlementBuckets({
          ...input(),
          policies: [{ ...frozen, definitionHash: '0'.repeat(64) }],
        }),
      'invalid',
    );
    expectReason(
      () =>
        buildTimeSettlementBuckets({
          ...input([first]),
          allocations: [{ ...allocation(first, frozen), definitionHash: '0'.repeat(64) }],
        }),
      'source_not_ready',
    );
  });

  it('refuses stale source revisions and crossed member or identity anchors', () => {
    for (const change of [
      { sourceSegmentRevision: 2 },
      { participationIdentityId: 'wrong-identity' },
      { memberId: 'wrong-member' },
    ]) {
      expectReason(
        () =>
          buildTimeSettlementBuckets({
            ...input([first]),
            allocations: [{ ...allocation(first, frozen), ...change }],
          }),
        'source_not_ready',
      );
    }
    expectReason(
      () => buildTimeSettlementBuckets({ ...input([first]), activityId: 'wrong-activity' }),
      'invalid',
    );
  });

  it('rejects duplicate sources, source keys, identities, allocations and policies', () => {
    expectReason(
      () => buildTimeSettlementBuckets({ ...input([first]), segments: [first, first] }),
      'invalid',
    );
    expectReason(
      () =>
        buildTimeSettlementBuckets({
          ...input(),
          segments: [first, { ...second, segmentKey: first.segmentKey }],
        }),
      'invalid',
    );
    expectReason(
      () => buildTimeSettlementBuckets({ ...input(), population: [population[0], population[0]] }),
      'invalid',
    );
    expectReason(
      () =>
        buildTimeSettlementBuckets({
          ...input([first]),
          allocations: [allocation(first, frozen), allocation(first, frozen)],
        }),
      'invalid',
    );
    expectReason(
      () => buildTimeSettlementBuckets({ ...input(), policies: [frozen, frozen] }),
      'invalid',
    );
  });

  it('rejects recognized slices outside the source, overlapping slices and corrupt manifests', () => {
    const outside = allocation(first, frozen, [
      {
        categoryCode: 'training',
        intervalKindCode: 'service_segment',
        startAt: '2026-09-12T07:59:59.000Z',
        endAt: '2026-09-12T08:00:59.000Z',
      },
    ]);
    expect(() =>
      buildTimeSettlementBuckets({ ...input([first]), allocations: [outside] }),
    ).toThrow();
    const slice = allocation(first, frozen).slices[0];
    const overlap = allocation(first, frozen, [slice, slice]);
    expect(() =>
      buildTimeSettlementBuckets({ ...input([first]), allocations: [overlap] }),
    ).toThrow();
    expectReason(
      () =>
        buildTimeSettlementBuckets({
          ...input([first]),
          allocations: [{ ...allocation(first, frozen), allocationHash: '0'.repeat(64) }],
        }),
      'invalid',
    );
  });

  it('refuses automatic rows whose stored category differs from the frozen automatic interpretation', () => {
    const changed = allocation(first, frozen, [
      { ...allocation(first, frozen).slices[0], categoryCode: 'training' },
    ]);
    expectReason(
      () =>
        buildTimeSettlementBuckets({
          ...input([first]),
          allocations: [{ ...changed, recognitionModeCode: 'automatic', manualReason: null }],
        }),
      'invalid',
    );
  });

  it('has a stable content hash independent of input order but sensitive to reason changes', () => {
    const initial = input();
    expect(
      buildTimeSettlementBuckets({
        ...initial,
        segments: [...initial.segments].reverse(),
        allocations: [...initial.allocations].reverse(),
      }).bucketContentHash,
    ).toBe(buildTimeSettlementBuckets(initial).bucketContentHash);
    const manual = {
      ...initial,
      allocations: initial.allocations.map((row) => ({
        ...row,
        recognitionModeCode: 'manual' as const,
        manualReason: '现场复核',
      })),
    };
    expect(
      buildTimeSettlementBuckets({
        ...manual,
        allocations: manual.allocations.map((row) => ({ ...row, manualReason: '另一份现场复核' })),
      }).bucketContentHash,
    ).not.toBe(buildTimeSettlementBuckets(manual).bucketContentHash);
  });

  it('enforces identity and segment limits before doing partial work', () => {
    expectReason(
      () =>
        buildTimeSettlementBuckets({
          ...input([]),
          population: Array.from({ length: 2001 }, (_, i) => ({
            participationIdentityId: 'identity-' + i,
            memberId: 'member-' + i,
            pending: false,
          })),
        }),
      'scale_limit',
    );
    expectReason(
      () =>
        buildTimeSettlementBuckets({
          ...input([]),
          segments: Array.from({ length: 10001 }, () => first),
        }),
      'scale_limit',
    );
  });

  it('supports 2000 identities, 10000 segments, 50000 slices, 8000 buckets and 40000 source rows; rejects slice 50001', () => {
    const allPopulation = Array.from({ length: 2000 }, (_, i) => ({
      participationIdentityId: 'identity-' + i,
      memberId: 'member-' + i,
      pending: false,
    }));
    const sources = Array.from({ length: 10000 }, (_, i) => {
      const sourceStart = new Date('2026-09-12T08:00:00.000Z').getTime() + (i % 5) * 10000;
      return segment(
        'source-' + i,
        new Date(sourceStart).toISOString(),
        new Date(sourceStart + 5000).toISOString(),
        'identity-' + Math.floor(i / 5),
        'member-' + Math.floor(i / 5),
      );
    });
    const allocations = sources.map((source) =>
      allocation(
        source,
        frozen,
        Array.from({ length: 5 }, (_, i) => ({
          categoryCode: 'volunteer_service',
          intervalKindCode: 'service_segment',
          startAt: new Date(source.checkInAt.getTime() + i * 1000).toISOString(),
          endAt: new Date(source.checkInAt.getTime() + (i + 1) * 1000).toISOString(),
        })),
      ),
    );
    const full = {
      activityId: 'activity-1',
      population: allPopulation,
      segments: sources,
      allocations,
      policies: [frozen],
    };
    const result = buildTimeSettlementBuckets(full);
    expect(result.bucketCount).toBe(8000);
    expect(result.sourceCount).toBe(40000);
    expect(result.buckets[0].rawRecognizedMilliseconds).toBe(25000n);
    expectReason(
      () =>
        buildTimeSettlementBuckets({
          ...full,
          allocations: [
            { ...allocations[0], slices: [...allocations[0].slices, allocations[0].slices[0]] },
            ...allocations.slice(1),
          ],
        }),
      'scale_limit',
    );
  }, 30000);
});

describe('D4 integer rounding boundaries', () => {
  it.each([
    [59999n, 60, 0],
    [60000n, 60, 60],
    [119999n, 60, 60],
    [120000n, 60, 120],
    [2147483647000n, 1, 2147483647],
  ] as const)('rounds %s milliseconds at quantum %s to %s', (milliseconds, quantum, expected) => {
    expect(roundTimeSettlementMilliseconds(milliseconds, quantum)).toBe(expected);
  });

  it.each([
    [-1n, 60],
    [9223372036854775808n, 60],
    [0n, 0],
    [0n, 3601],
    [0n, 1.5],
  ] as const)('rejects invalid raw milliseconds or quantum %s/%s', (milliseconds, quantum) => {
    expectReason(() => roundTimeSettlementMilliseconds(milliseconds, quantum), 'invalid');
  });

  it('rejects overflow instead of losing BigInt precision in a JSON number', () => {
    expectReason(() => roundTimeSettlementMilliseconds(2147483648000n, 1), 'scale_limit');
    expectReason(() => roundTimeSettlementMilliseconds(9007199254740993n, 60), 'scale_limit');
  });
});
