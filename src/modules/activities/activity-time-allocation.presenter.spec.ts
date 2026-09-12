import type { ParticipantTimeAllocationDetailRow } from './activity-time-allocation.presenter';
import {
  presentParticipantTimeAllocationDetail,
  presentParticipantTimeAllocationSummary,
} from './activity-time-allocation.presenter';
import { buildActivityTimeAllocationManifest } from './activity-time-allocation-command';

function row(): ParticipantTimeAllocationDetailRow {
  const slices = [
    {
      id: 'slice',
      allocationRevisionId: 'allocation',
      activityId: 'activity',
      ordinal: 0,
      categoryCode: 'volunteer_service',
      intervalKindCode: 'service_segment',
      startAt: new Date('2026-09-12T08:00:00.000Z'),
      endAt: new Date('2026-09-12T09:00:00.000Z'),
    },
  ];
  const { allocationHash } = buildActivityTimeAllocationManifest([
    {
      categoryCode: 'volunteer_service',
      intervalKindCode: 'service_segment',
      startAt: slices[0].startAt.toISOString(),
      endAt: slices[0].endAt.toISOString(),
    },
  ]);
  return {
    id: 'allocation',
    activityId: 'activity',
    sourceSegmentId: 'segment',
    sourceSegmentRevision: 1,
    revision: 1,
    recognitionModeCode: 'automatic',
    allocationHash,
    sliceCount: 1,
    createdAt: new Date('2026-09-12T09:00:00.000Z'),
    slices,
    evidence: [
      {
        id: 'evidence',
        allocationRevisionId: 'allocation',
        activityId: 'activity',
        attachmentId: 'attachment',
        ordinal: 0,
      },
    ],
  } as unknown as ParticipantTimeAllocationDetailRow;
}

describe('D3 time-allocation presenter', () => {
  it('presents only safe summary/detail fields and recomputes the canonical manifest', () => {
    const value = row();
    expect(presentParticipantTimeAllocationSummary(value)).toEqual({
      allocationRevisionId: 'allocation',
      activityId: 'activity',
      sourceSegmentId: 'segment',
      sourceSegmentRevision: 1,
      revision: 1,
      recognitionModeCode: 'automatic',
      allocationHash: value.allocationHash,
      sliceCount: 1,
      createdAt: '2026-09-12T09:00:00.000Z',
    });
    const detail = presentParticipantTimeAllocationDetail(value);
    expect(detail.evidence).toEqual([{ attachmentId: 'attachment', ordinal: 0 }]);
    expect(JSON.stringify(detail)).not.toContain('createdByUserId');
    expect(JSON.stringify(detail)).not.toContain('operationKey');
    expect(JSON.stringify(detail)).not.toContain('requestHash');
  });

  it('fails closed for a malformed child sequence or allocation hash', () => {
    expect(() =>
      presentParticipantTimeAllocationDetail({
        ...row(),
        slices: [{ ...row().slices[0], ordinal: 1 }],
      }),
    ).toThrow(TypeError);
    expect(() =>
      presentParticipantTimeAllocationDetail({ ...row(), allocationHash: 'b'.repeat(64) }),
    ).toThrow(TypeError);
  });
});
