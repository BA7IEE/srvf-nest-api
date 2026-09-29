import type { Prisma } from '@prisma/client';
import type { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { AttendanceCorrectionWriteService } from './attendance-correction-write.service';

describe('AttendanceCorrectionWriteService', () => {
  function fixture() {
    const gate = { assertV11WriteAllowed: jest.fn() };
    const db = {
      $transaction: jest.fn(),
      attendanceCorrectionRequest: {
        create: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
      },
      correctionApplication: {
        create: jest.fn().mockResolvedValue({ id: 'application-1' }),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    return {
      db,
      tx: db as unknown as Prisma.TransactionClient,
      gate,
      service: new AttendanceCorrectionWriteService(gate as unknown as ActivityWorkflowGate),
    };
  }

  it('creates the request through the caller transaction with the fixed safe projection', async () => {
    const f = fixture();
    const submittedAt = new Date('2026-09-16T00:00:00.000Z');
    const row = {
      id: 'request-1',
      version: 0,
      activityId: 'activity-1',
      settlementRunId: 'run-1',
      participationIdentityId: null,
      baseSettlementVersionId: 'version-1',
      baseResultRevisionId: null,
      baseClosureRevision: 2,
      requestedChangeJson: { kind: 'time' },
      statusCode: 'pending',
      submittedByUserId: 'user-1',
      reviewedByUserId: null,
      reviewNote: null,
      operationKey: 'operation-1',
      requestHash: 'hash-1',
      resubmittedFromRequestId: null,
    };
    f.db.attendanceCorrectionRequest.create.mockResolvedValue(row);

    await expect(
      f.service.createRequest(f.tx, {
        activityId: 'activity-1',
        settlementRunId: 'run-1',
        participationIdentityId: null,
        baseSettlementVersionId: 'version-1',
        baseResultRevisionId: null,
        baseClosureRevision: 2,
        requestTypeCode: 'time',
        requestedChangeJson: { kind: 'time' },
        reason: 'correct time',
        attachmentIds: ['attachment-1'],
        submittedByUserId: 'user-1',
        submittedAt,
        operationKey: 'operation-1',
        requestHash: 'hash-1',
      }),
    ).resolves.toBe(row);

    expect(f.db.attendanceCorrectionRequest.create).toHaveBeenCalledWith({
      data: {
        activityId: 'activity-1',
        settlementRunId: 'run-1',
        participationIdentityId: null,
        baseSettlementVersionId: 'version-1',
        baseResultRevisionId: null,
        baseClosureRevision: 2,
        requestTypeCode: 'time',
        requestedChangeJson: { kind: 'time' },
        reason: 'correct time',
        attachmentIds: ['attachment-1'],
        statusCode: 'pending',
        submittedByUserId: 'user-1',
        submittedAt,
        operationKey: 'operation-1',
        requestHash: 'hash-1',
        resubmittedFromRequestId: undefined,
      },
      select: {
        id: true,
        version: true,
        activityId: true,
        settlementRunId: true,
        participationIdentityId: true,
        baseSettlementVersionId: true,
        baseResultRevisionId: true,
        baseClosureRevision: true,
        requestedChangeJson: true,
        statusCode: true,
        submittedByUserId: true,
        reviewedByUserId: true,
        reviewNote: true,
        operationKey: true,
        requestHash: true,
        resubmittedFromRequestId: true,
      },
    });
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(f.gate.assertV11WriteAllowed).toHaveBeenCalledTimes(1);
  });

  it('keeps all request state updates inside the caller transaction', async () => {
    const f = fixture();
    const reviewedAt = new Date('2026-09-16T01:00:00.000Z');

    await f.service.voidRequest(f.tx, 'request-void');
    await f.service.reviewRequest(f.tx, {
      correctionRequestId: 'request-review',
      statusCode: 'approved',
      reviewedByUserId: 'reviewer-1',
      reviewedAt,
      reviewNote: 'approved',
    });
    await f.service.markRequestApplying(f.tx, 'request-applying');
    await f.service.markRequestApplied(f.tx, 'request-applied');

    expect(f.db.attendanceCorrectionRequest.update.mock.calls).toEqual([
      [
        {
          where: { id: 'request-void' },
          data: { statusCode: 'voided', version: { increment: 1 } },
        },
      ],
      [
        {
          where: { id: 'request-review' },
          data: {
            statusCode: 'approved',
            reviewedByUserId: 'reviewer-1',
            reviewedAt,
            reviewNote: 'approved',
            version: { increment: 1 },
          },
        },
      ],
      [
        {
          where: { id: 'request-applying' },
          data: { statusCode: 'applying', version: { increment: 1 } },
        },
      ],
      [
        {
          where: { id: 'request-applied' },
          data: { statusCode: 'applied', version: { increment: 1 } },
        },
      ],
    ]);
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(f.gate.assertV11WriteAllowed).toHaveBeenCalledTimes(4);
  });

  it('creates and commits the application through the supplied transaction', async () => {
    const f = fixture();

    await expect(
      f.service.createApplication(f.tx, {
        correctionRequestId: 'request-1',
        newSettlementVersionId: 'version-2',
        newResultRevisionIds: ['result-1', 'result-2'],
        newPostingBatchId: 'batch-1',
      }),
    ).resolves.toEqual({ id: 'application-1' });
    await f.service.markApplicationCommitted(f.tx, 'application-1');

    expect(f.db.correctionApplication.create).toHaveBeenCalledWith({
      data: {
        correctionRequestId: 'request-1',
        newSettlementVersionId: 'version-2',
        newResultRevisionIds: ['result-1', 'result-2'],
        newPostingBatchId: 'batch-1',
        statusCode: 'preparing',
      },
      select: { id: true },
    });
    expect(f.db.correctionApplication.update).toHaveBeenCalledWith({
      where: { id: 'application-1' },
      data: { statusCode: 'committed' },
    });
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(f.gate.assertV11WriteAllowed).toHaveBeenCalledTimes(2);
  });
});
