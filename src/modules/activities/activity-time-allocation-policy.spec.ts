import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  parseTimePolicyDefinition,
  type TimePolicyDefinition,
} from './activity-time-policy-definition';
import {
  assertAllocationSlicesWithinSource,
  assertManualTimeAllocationAllowed,
  assertTimeAllocationEvidence,
  automaticTimeAllocationSlices,
  historicalAttendanceRoleFromRuleSnapshot,
  historicalTimePolicySelectionTargetsFromRuleSnapshot,
} from './activity-time-allocation-policy';

function definition(overrides: Partial<TimePolicyDefinition> = {}): TimePolicyDefinition {
  return parseTimePolicyDefinition({
    defaultCategory: 'volunteer_service',
    roleMappings: [{ attendanceRoleCode: 'coach', category: 'training' }],
    allowSplit: false,
    specialIntervals: {
      preparation: { mode: 'exclude' },
      duty: { mode: 'exclude' },
      travel: { mode: 'exclude' },
    },
    rounding: { mode: 'floor', quantumSeconds: 60 },
    evidence: {
      requiredSources: ['service_segment', 'punch_event'],
      requireManualRecognition: false,
    },
    manualAdjustment: { enabled: false },
    ...overrides,
  });
}

function expectBizCode(action: () => void, code: (typeof BizCode)[keyof typeof BizCode]): void {
  try {
    action();
    throw new Error('expected failure');
  } catch (error) {
    expect(error).toMatchObject({ biz: code });
  }
}

const start = new Date('2026-09-12T08:00:00.000Z');
const end = new Date('2026-09-12T10:00:00.000Z');

describe('D3 historical policy inputs', () => {
  const snapshot = {
    sessions: [
      {
        sessionId: 'session-one',
        positions: [{ positionId: 'position-one', attendanceRoleCode: 'coach' }],
      },
    ],
  };

  it('derives only frozen session/position targets and frozen attendance role', () => {
    expect(historicalTimePolicySelectionTargetsFromRuleSnapshot(snapshot)).toEqual([
      { sessionId: 'session-one', positionIds: ['position-one'] },
    ]);
    expect(historicalAttendanceRoleFromRuleSnapshot(snapshot, 'session-one', 'position-one')).toBe(
      'coach',
    );
    expect(historicalAttendanceRoleFromRuleSnapshot(snapshot, 'session-one', null)).toBeNull();
  });

  it('fails closed for malformed or unrecognized historical snapshot facts', () => {
    expectBizCode(
      () => historicalTimePolicySelectionTargetsFromRuleSnapshot({ sessions: [{ sessionId: 42 }] }),
      BizCode.ACTIVITY_TIME_ALLOCATION_POLICY_UNAVAILABLE,
    );
    expectBizCode(
      () => historicalAttendanceRoleFromRuleSnapshot(snapshot, 'session-one', 'missing-position'),
      BizCode.ACTIVITY_TIME_ALLOCATION_POLICY_UNAVAILABLE,
    );
  });
});

describe('D3 allocation policy boundary', () => {
  it('uses only the source interval and deterministic historic role mapping for automatic mode', () => {
    expect(automaticTimeAllocationSlices(definition(), 'coach', start, end)).toEqual([
      {
        categoryCode: 'training',
        intervalKindCode: 'service_segment',
        startAt: start.toISOString(),
        endAt: end.toISOString(),
      },
    ]);
    expect(automaticTimeAllocationSlices(definition(), null, start, end)[0].categoryCode).toBe(
      'volunteer_service',
    );
  });

  it('rejects automatic policy paths requiring facts D3 does not have', () => {
    expectBizCode(
      () =>
        automaticTimeAllocationSlices(
          definition({
            evidence: { requiredSources: ['service_segment'], requireManualRecognition: true },
            manualAdjustment: { enabled: true, reasonRequired: true, evidenceRequired: false },
          }),
          'coach',
          start,
          end,
        ),
      BizCode.ACTIVITY_TIME_ALLOCATION_POLICY_UNAVAILABLE,
    );
    expectBizCode(
      () =>
        automaticTimeAllocationSlices(
          definition({
            specialIntervals: {
              preparation: { mode: 'category', category: 'organization' },
              duty: { mode: 'exclude' },
              travel: { mode: 'exclude' },
            },
            manualAdjustment: { enabled: true, reasonRequired: true, evidenceRequired: false },
          }),
          'coach',
          start,
          end,
        ),
      BizCode.ACTIVITY_TIME_ALLOCATION_POLICY_UNAVAILABLE,
    );
  });

  it('enforces manual enablement, source interval boundaries, overlap, split and evidence rules', () => {
    const fullSlice = {
      categoryCode: 'training' as const,
      intervalKindCode: 'service_segment' as const,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
    };
    expect(() => assertAllocationSlicesWithinSource([fullSlice], start, end, false)).not.toThrow();
    expectBizCode(
      () => assertManualTimeAllocationAllowed(definition()),
      BizCode.ACTIVITY_TIME_ALLOCATION_POLICY_UNAVAILABLE,
    );
    expectBizCode(
      () =>
        assertAllocationSlicesWithinSource(
          [
            fullSlice,
            {
              ...fullSlice,
              startAt: '2026-09-12T09:00:00.000Z',
              endAt: '2026-09-12T10:30:00.000Z',
            },
          ],
          start,
          end,
          true,
        ),
      BizCode.ACTIVITY_TIME_ALLOCATION_INVALID,
    );
    expectBizCode(
      () =>
        assertAllocationSlicesWithinSource(
          [{ ...fullSlice, startAt: '2026-09-12T08:30:00.000Z' }],
          start,
          end,
          false,
        ),
      BizCode.ACTIVITY_TIME_ALLOCATION_INVALID,
    );
    const evidencePolicy = definition({
      evidence: {
        requiredSources: ['service_segment', 'attachment'],
        requireManualRecognition: false,
      },
      manualAdjustment: { enabled: true, reasonRequired: true, evidenceRequired: true },
    });
    expectBizCode(
      () => assertTimeAllocationEvidence(evidencePolicy, 'manual', 0),
      BizCode.ACTIVITY_TIME_ALLOCATION_INVALID,
    );
    expect(() => assertTimeAllocationEvidence(evidencePolicy, 'manual', 1)).not.toThrow();
  });
});
