import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { ActivityTimeCorrectionAccessService } from './activity-time-correction-access.service';
import { ActivityTimeCorrectionQueryService } from './activity-time-correction-query.service';

const actor: CurrentUserPayload = {
  id: 'actor-one',
  username: 'actor-one',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: 'member-one',
};

const at = new Date('2026-09-16T09:00:00.000Z');

function fixture() {
  const tx = {
    $queryRaw: jest.fn(),
    attendanceCorrectionRequest: {
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => await callback(tx)),
  };
  const access = {
    authorizeListRead: jest.fn(),
    authorizeRead: jest.fn(),
    authorizeSubmission: jest.fn(),
    authorizeReview: jest.fn(),
  };
  return {
    tx,
    prisma,
    access,
    service: new ActivityTimeCorrectionQueryService(
      prisma as unknown as PrismaService,
      access as unknown as ActivityTimeCorrectionAccessService,
    ),
  };
}

describe('D7-2 Human fact-correction query boundary', () => {
  it('lists an owner-visible activity with two bounded reads and a post-read qualification check', async () => {
    const f = fixture();
    f.access.authorizeListRead.mockResolvedValue({ actor, baseSettlementVersionId: null });
    f.tx.attendanceCorrectionRequest.findMany.mockResolvedValue([
      {
        id: 'request-one',
        version: 4,
        baseSettlementVersionId: 'base-one',
        statusCode: 'approved',
        submittedAt: at,
        reviewedAt: null,
      },
      {
        id: 'request-two',
        version: 2,
        baseSettlementVersionId: 'base-two',
        statusCode: 'returned',
        submittedAt: at,
        reviewedAt: at,
      },
    ]);
    f.tx.attendanceCorrectionRequest.count.mockResolvedValue(2);

    await expect(f.service.list('activity-one', { page: 1, pageSize: 20 }, actor)).resolves.toEqual(
      {
        items: [
          {
            requestId: 'request-one',
            requestVersion: 4,
            baseSettlementVersionId: 'base-one',
            statusCode: 'approved',
            submittedAt: at.toISOString(),
            reviewedAt: null,
          },
          {
            requestId: 'request-two',
            requestVersion: 2,
            baseSettlementVersionId: 'base-two',
            statusCode: 'returned',
            submittedAt: at.toISOString(),
            reviewedAt: at.toISOString(),
          },
        ],
        total: 2,
        page: 1,
        pageSize: 20,
      },
    );
    expect(f.tx.attendanceCorrectionRequest.findMany).toHaveBeenCalledTimes(1);
    expect(f.tx.attendanceCorrectionRequest.count).toHaveBeenCalledTimes(1);
    expect(f.access.authorizeListRead).toHaveBeenCalledTimes(2);
    expect(f.tx.attendanceCorrectionRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { activityId: 'activity-one' },
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        skip: 0,
        take: 20,
      }),
    );
  });

  it('filters a reviewer list to the exact base supplied to the existing read authority', async () => {
    const f = fixture();
    f.access.authorizeListRead.mockResolvedValue({ actor, baseSettlementVersionId: 'base-one' });
    f.tx.attendanceCorrectionRequest.findMany.mockResolvedValue([]);
    f.tx.attendanceCorrectionRequest.count.mockResolvedValue(0);

    await f.service.list(
      'activity-one',
      { baseSettlementVersionId: 'base-one', page: 1, pageSize: 20 },
      actor,
    );

    expect(f.tx.attendanceCorrectionRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { activityId: 'activity-one', baseSettlementVersionId: 'base-one' },
      }),
    );
    expect(f.access.authorizeListRead).toHaveBeenNthCalledWith(
      1,
      f.tx,
      actor,
      'activity-one',
      'base-one',
    );
  });

  it('returns only the immutable summary when a readable request is no longer sensitive to the caller', async () => {
    const f = fixture();
    f.tx.attendanceCorrectionRequest.findFirst.mockResolvedValue({
      id: 'request-one',
      version: 2,
      baseSettlementVersionId: 'base-one',
      statusCode: 'returned',
      submittedAt: at,
      reviewedAt: at,
      submittedByUserId: actor.id,
      requestTypeCode: 'time',
      requestedChangeJson: {
        schemaVersion: 2,
        results: [],
        segments: [],
        timeCorrection: {
          baseSettlementVersionId: 'base-one',
          baseTimeLedgerHash: 'a'.repeat(64),
          reason: '更正时间事实',
          items: [{ rootEntryId: 'root-entry', recognizedSeconds: 0 }],
        },
      },
      reason: '保留的敏感原因',
      attachmentIds: ['attachment-one'],
      reviewNote: '保留的审核说明',
      resubmittedFromRequestId: null,
      resubmittedSuccessor: { id: 'successor-one' },
      applications: [
        {
          timeSourceProof: {
            id: 'proof-one',
            sourceSetHash: 'a'.repeat(64),
            expectedSegmentCount: 1,
          },
        },
      ],
    });
    f.access.authorizeRead.mockResolvedValue(actor);
    f.access.authorizeSubmission.mockRejectedValue(new BizException(BizCode.RBAC_FORBIDDEN));
    f.access.authorizeReview.mockRejectedValue(new BizException(BizCode.RBAC_FORBIDDEN));

    await expect(
      f.service.detail('activity-one', 'request-one', { page: 1, pageSize: 20 }, actor),
    ).resolves.toEqual({
      requestId: 'request-one',
      requestVersion: 2,
      baseSettlementVersionId: 'base-one',
      statusCode: 'returned',
      submittedAt: at.toISOString(),
      reviewedAt: at.toISOString(),
      requestTypeCode: 'time',
      requestedChangeJson: null,
      reason: null,
      attachmentIds: null,
      reviewNote: null,
      resubmittedFromRequestId: null,
      resubmittedSuccessorRequestId: 'successor-one',
      sourceProofHash: 'a'.repeat(64),
      evidenceStatusCode: 'frozen',
      sourcePage: null,
    });
    expect(f.access.authorizeRead).toHaveBeenCalledTimes(2);
    expect(f.access.authorizeSubmission).toHaveBeenCalledWith(f.tx, actor, 'activity-one', 2);
  });

  it('returns only one bounded source-proof page to a currently qualified requester', async () => {
    const f = fixture();
    f.tx.attendanceCorrectionRequest.findFirst.mockResolvedValue({
      id: 'request-one',
      version: 2,
      baseSettlementVersionId: 'base-one',
      statusCode: 'approved',
      submittedAt: at,
      reviewedAt: null,
      submittedByUserId: actor.id,
      requestTypeCode: 'time',
      requestedChangeJson: {
        schemaVersion: 2,
        results: [],
        segments: [],
        timeCorrection: {
          baseSettlementVersionId: 'base-one',
          baseTimeLedgerHash: 'a'.repeat(64),
          reason: '更正时间事实',
          items: [{ rootEntryId: 'root-entry', recognizedSeconds: 0 }],
        },
      },
      reason: '更正时间事实',
      attachmentIds: [],
      reviewNote: null,
      resubmittedFromRequestId: null,
      resubmittedSuccessor: null,
      applications: [
        {
          timeSourceProof: {
            id: 'proof-one',
            sourceSetHash: 'b'.repeat(64),
            expectedSegmentCount: 2,
          },
        },
      ],
    });
    f.access.authorizeRead.mockResolvedValue(actor);
    f.access.authorizeSubmission.mockResolvedValue(actor);
    f.tx.$queryRaw.mockResolvedValue([{ source: { participationIdentityId: 'identity-b' } }]);

    const detail = await f.service.detail(
      'activity-one',
      'request-one',
      { page: 2, pageSize: 1 },
      actor,
    );
    expect(detail.requestedChangeJson).toMatchObject({ schemaVersion: 2 });
    expect(detail.evidenceStatusCode).toBe('frozen');
    expect(detail.sourcePage).toEqual({
      items: [{ participationIdentityId: 'identity-b' }],
      total: 2,
      page: 2,
      pageSize: 1,
    });
    expect(f.access.authorizeReview).not.toHaveBeenCalled();
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
