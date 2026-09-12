import type {
  ParticipantTimeAllocationEvidence,
  ParticipantTimeAllocationRevision,
  ParticipantTimeAllocationSlice,
} from '@prisma/client';
import {
  buildActivityTimeAllocationManifest,
  type ActivityTimeAllocationSliceInput,
} from './activity-time-allocation-command';

export type ParticipantTimeAllocationDetailRow = ParticipantTimeAllocationRevision & {
  slices: ParticipantTimeAllocationSlice[];
  evidence: ParticipantTimeAllocationEvidence[];
};

export function presentParticipantTimeAllocationSummary(row: ParticipantTimeAllocationRevision) {
  return {
    allocationRevisionId: row.id,
    activityId: row.activityId,
    sourceSegmentId: row.sourceSegmentId,
    sourceSegmentRevision: row.sourceSegmentRevision,
    revision: row.revision,
    recognitionModeCode: row.recognitionModeCode,
    allocationHash: row.allocationHash,
    sliceCount: row.sliceCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Internal-safe shape only: no operation key, request hash, attachment key, signed URL or actor
 * data leaves this presenter.  Consumers must still apply their own authorization before calling.
 */
export function presentParticipantTimeAllocationDetail(row: ParticipantTimeAllocationDetailRow) {
  const slices = [...row.slices].sort((left, right) => left.ordinal - right.ordinal);
  if (
    slices.length !== row.sliceCount ||
    slices.some(
      (slice, ordinal) => slice.ordinal !== ordinal || slice.activityId !== row.activityId,
    )
  ) {
    throw new TypeError('invalid time allocation slice sequence');
  }
  const sourceSlices: ActivityTimeAllocationSliceInput[] = slices.map((slice) => {
    if (
      slice.categoryCode !== 'volunteer_service' &&
      slice.categoryCode !== 'training' &&
      slice.categoryCode !== 'organization' &&
      slice.categoryCode !== 'non_creditable'
    ) {
      throw new TypeError('invalid time allocation category');
    }
    if (slice.intervalKindCode !== 'service_segment') {
      throw new TypeError('invalid time allocation interval kind');
    }
    return {
      categoryCode: slice.categoryCode,
      intervalKindCode: 'service_segment',
      startAt: slice.startAt.toISOString(),
      endAt: slice.endAt.toISOString(),
    };
  });
  const { manifest, allocationHash } = buildActivityTimeAllocationManifest(sourceSlices);
  if (allocationHash !== row.allocationHash) throw new TypeError('time allocation hash mismatch');
  const evidence = [...row.evidence].sort((left, right) => left.ordinal - right.ordinal);
  if (
    evidence.some(
      (link, ordinal) =>
        link.ordinal !== ordinal ||
        link.activityId !== row.activityId ||
        link.allocationRevisionId !== row.id,
    )
  ) {
    throw new TypeError('invalid time allocation evidence sequence');
  }
  return {
    ...presentParticipantTimeAllocationSummary(row),
    allocation: manifest,
    slices: sourceSlices,
    evidence: evidence.map((link) => ({ attachmentId: link.attachmentId, ordinal: link.ordinal })),
  };
}
