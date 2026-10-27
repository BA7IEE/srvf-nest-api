import { fingerprintContributionPolicyVersion } from './activity-contribution-policy-definition';
import { fingerprintTimePolicyVersion } from './activity-time-policy-definition';
import {
  fixedNativeCapacityArguments,
  NATIVE_CAPACITY_POLICY,
  NATIVE_CAPACITY_TIME_POLICY,
  type NativeCapacityCalibrationContext,
} from '../../../test/helpers/native-capacity-calibration.fixture';
const id = (kind: string) => 'c' + kind.padEnd(24, '0').slice(0, 24);
const window = {
  effectiveFrom: '1900-01-01T00:00:00.000Z',
  effectiveUntil: '2101-01-01T00:00:00.000Z',
};
const contribution = fingerprintContributionPolicyVersion({
  schemaVersion: 1,
  evaluatorVersion: 1,
  definition: NATIVE_CAPACITY_POLICY,
  ...window,
});
const time = fingerprintTimePolicyVersion({
  schemaVersion: 1,
  evaluatorVersion: 1,
  definition: NATIVE_CAPACITY_TIME_POLICY,
  ...window,
});
const context: NativeCapacityCalibrationContext = {
  activityId: id('activity'),
  sessionId: id('session'),
  positionId: id('position'),
  startsAt: '2026-10-10T08:00:00.000Z',
  actorId: id('actor'),
  creatorMemberId: id('member'),
  selectionItemId: id('item'),
  sessionThresholds: { lateGraceMinutes: 0, earlyLeaveThresholdMinutes: 0 },
  snapshot: {
    id: id('snapshot'),
    snapshotHash: 'a'.repeat(64),
    workflowRevision: 1,
    resolvedConfig: {
      sessions: [
        {
          sessionId: id('session'),
          positions: [{ positionId: id('position'), attendanceRoleCode: 'service' }],
        },
      ],
    },
  },
  contributionSelection: { id: id('selection'), selectionJson: { schemaVersion: 1, items: {} } },
  timeSelection: { id: id('timeselect'), selectionHash: 'b'.repeat(64) },
  contribution: {
    policyId: id('cpolicy'),
    versionId: id('cversion'),
    definitionHash: contribution.definitionHash,
  },
  time: { policyId: id('tpolicy'), versionId: id('tversion'), definitionHash: time.definitionHash },
};

describe('capacity fixed-input graph before any database calibration', () => {
  it('builds all legal maxima and parses the full V3 request using the original validators', () => {
    const result = fixedNativeCapacityArguments(context);
    expect(result.counts).toEqual({
      identities: 2000,
      segments: 10000,
      allocations: 10000,
      slices: 50000,
      buckets: 8000,
      evaluations: 8000,
    });
    expect(result.fixedInputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(result.measurements.map((row) => row.label)).size).toBe(
      result.measurements.length,
    );
    expect(result.measurements.filter((row) => row.dimension === 'evaluationBytes')).toHaveLength(
      4,
    );
    expect(result.measurements.some((row) => row.label === 'full parsed V3 changeSet')).toBe(true);
  }, 30000);
});
