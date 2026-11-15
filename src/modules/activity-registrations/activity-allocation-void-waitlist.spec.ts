import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { assertVoidLiveFacts } from './activity-allocation-policy';
import type {
  CandidateSource,
  LockedApplicationProjection,
  LockedBatch,
  PersistedCandidate,
} from './activity-allocation.types';

const at = new Date('2026-11-13T00:00:00Z');
const batch: LockedBatch = {
  id: 'batch-1',
  activityId: 'activity-1',
  sessionId: 'session-1',
  positionId: 'position-1',
  modeCode: 'qualification_rank',
  candidateSnapshotHash: 'hash',
  algorithmVersionCode: 'v1',
  randomCommitment: null,
  randomSeedReveal: null,
  statusCode: 'committed',
  operationKey: 'op',
  requestHash: 'hash',
  committedAt: at,
  voidReason: null,
  voidedAt: null,
};
const candidate: PersistedCandidate = {
  allocationCandidateId: 'candidate-1',
  activityId: 'activity-1',
  sessionId: 'session-1',
  waitlistPositionId: 'position-1',
  participationIdentityId: 'identity-1',
  registrationId: 'registration-1',
  registrationRevisionId: 'registration-revision-1',
  acceptedAt: at,
  qualificationSnapshotHash: 'hash',
  qualificationScore: null,
  tieBreakKey: 'identity-1',
  lotteryOrder: null,
  resultCode: 'waitlisted',
  waitlistRank: 1,
  explanation: null,
};
const projection: LockedApplicationProjection = {
  id: 'projection-1',
  allocationCandidateId: 'candidate-1',
  participationIdentityId: 'identity-1',
  memberId: 'member-1',
  appliedParticipationRevisionId: 'waitlist-revision',
  appliedResultCode: 'waitlisted',
  appliedStatusCode: 'waitlisted',
  positionId: null,
  populationIncluded: false,
  expectedIdentityCapacityReservationId: null,
  activityPersonReservationId: null,
  activityPersonBucketId: null,
  sessionReservationId: null,
  sessionBucketId: null,
  positionReservationId: null,
  positionBucketId: null,
};
const source: CandidateSource = {
  id: 'identity-1',
  activityId: 'activity-1',
  memberId: 'member-1',
  sessionId: 'session-1',
  registrationId: 'registration-1',
  identityRevision: 2,
  identityStatusCode: 'waitlisted',
  currentPositionId: null,
  capacityReservationId: null,
  populationIncluded: false,
  identityVersion: 2,
  registrationCurrentRevision: 1,
  registrationRevisionId: 'registration-revision-1',
  participationRevisionId: 'waitlist-revision',
  participationRevisionStatusCode: 'waitlisted',
  participationRevisionPositionId: 'position-1',
  participationRevisionWaitlistRank: 1,
  participationRevisionAllocationBatchId: 'batch-1',
  acceptedAt: at,
  preferenceSnapshot: null,
};

describe('voiding a committed waitlist batch after an individual cancellation', () => {
  it('accepts the unchanged committed projection', () => {
    expect(() =>
      assertVoidLiveFacts({
        batch,
        candidates: [candidate],
        projections: [projection],
        sources: [source],
      }),
    ).not.toThrow();
  });

  it('fails closed after the identity advances to cancelled, preserving the prior projection', () => {
    const cancelled: CandidateSource = {
      ...source,
      identityRevision: 3,
      identityStatusCode: 'cancelled',
      participationRevisionId: 'cancelled-revision',
      participationRevisionStatusCode: 'cancelled',
      participationRevisionPositionId: null,
      participationRevisionWaitlistRank: null,
      participationRevisionAllocationBatchId: null,
    };
    let error: unknown;
    try {
      assertVoidLiveFacts({
        batch,
        candidates: [candidate],
        projections: [projection],
        sources: [cancelled],
      });
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BizException);
    expect(error).toMatchObject({ biz: BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED });
  });
});
