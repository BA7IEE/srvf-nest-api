import {
  presentActivityTimeCorrectionDetail,
  presentActivityTimeCorrectionResubmit,
  presentActivityTimeCorrectionSubmit,
} from './activity-time-correction.presenter';

const at = new Date('2026-09-16T09:00:00.000Z');

describe('D7-2 App fact-correction presenters', () => {
  it('returns an explicit submit allow-list rather than a domain record spread', () => {
    const result = presentActivityTimeCorrectionSubmit({
      correctionRequestId: 'request-one',
      requestVersion: 3,
      activityId: 'activity-one',
      settlementRunId: 'run-one',
      baseSettlementVersionId: 'base-one',
      baseResultRevisionId: null,
      baseClosureRevision: 2,
      statusCode: 'pending',
      replayed: false,
    });

    expect(result).toEqual({
      requestId: 'request-one',
      requestVersion: 3,
      activityId: 'activity-one',
      settlementRunId: 'run-one',
      baseSettlementVersionId: 'base-one',
      baseResultRevisionId: null,
      baseClosureRevision: 2,
      statusCode: 'pending',
      replayed: false,
    });
    expect(result).not.toHaveProperty('requestHash');
    expect(result).not.toHaveProperty('submittedByUserId');
  });

  it('keeps a base-drift resubmit distinguishable from a new pending request', () => {
    expect(
      presentActivityTimeCorrectionResubmit({
        outcome: 'voided',
        correctionRequestId: 'returned-request',
        baseSettlementVersionId: 'base-one',
        currentSettlementVersionId: 'base-two',
        baseClosureRevision: 3,
        currentClosureRevision: 4,
      }),
    ).toEqual({
      outcome: 'voided',
      requestId: 'returned-request',
      currentSettlementVersionId: 'base-two',
    });
  });

  it('retains sensitive detail fields only when its caller has already decided visibility', () => {
    expect(
      presentActivityTimeCorrectionDetail({
        id: 'request-one',
        version: 1,
        baseSettlementVersionId: 'base-one',
        statusCode: 'returned',
        submittedAt: at,
        reviewedAt: null,
        requestTypeCode: 'time',
        requestedChangeJson: null,
        reason: null,
        attachmentIds: null,
        reviewNote: null,
        resubmittedFromRequestId: null,
        resubmittedSuccessorRequestId: 'next-request',
        sourceProofHash: 'a'.repeat(64),
        evidenceStatusCode: 'frozen',
        sourcePage: {
          items: [{ participationIdentityId: 'person-one' }],
          total: 1,
          page: 1,
          pageSize: 20,
        },
      }),
    ).toEqual({
      requestId: 'request-one',
      requestVersion: 1,
      baseSettlementVersionId: 'base-one',
      statusCode: 'returned',
      submittedAt: at.toISOString(),
      reviewedAt: null,
      requestTypeCode: 'time',
      requestedChangeJson: null,
      reason: null,
      attachmentIds: null,
      reviewNote: null,
      resubmittedFromRequestId: null,
      resubmittedSuccessorRequestId: 'next-request',
      sourceProofHash: 'a'.repeat(64),
      evidenceStatusCode: 'frozen',
      sourcePage: {
        items: [{ participationIdentityId: 'person-one' }],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    });
  });
});
