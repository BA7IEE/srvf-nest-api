import type { Prisma } from '@prisma/client';
import { AttendanceMetricSourceQueryService } from './attendance-metric-source-query.service';

describe('C3-1 attendance source owner boundary', () => {
  const service = new AttendanceMetricSourceQueryService();
  function fixture() {
    const db = {
      attendancePunchEvent: { findMany: jest.fn().mockResolvedValue([]) },
      correctionApplication: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return { db, tx: db as unknown as Prisma.TransactionClient };
  }
  it('uses the supplied transaction and a minimal, ordered cap+1 event projection', async () => {
    const f = fixture();
    await expect(
      service.readActivityPunchProjectionInputTrusted(f.tx, 'activity', 20000),
    ).resolves.toEqual([]);
    expect(f.db.attendancePunchEvent.findMany).toHaveBeenCalledWith({
      where: { activityId: 'activity' },
      orderBy: { id: 'asc' },
      take: 20001,
      select: {
        id: true,
        activityId: true,
        sessionId: true,
        participationIdentityId: true,
        eventTypeCode: true,
        occurredAt: true,
        supersedesEventId: true,
      },
    });
  });
  it('rejects unsupported budgets before issuing a query', async () => {
    const f = fixture();
    await expect(
      service.readActivityPunchProjectionInputTrusted(f.tx, 'activity', 20001),
    ).rejects.toThrow(RangeError);
    expect(f.db.attendancePunchEvent.findMany).not.toHaveBeenCalled();
  });
  it('accepts the exact per-identity budget but rejects cap+1 without truncation', async () => {
    const f = fixture();
    const event = { activityId: 'activity', participationIdentityId: 'identity' };
    f.db.attendancePunchEvent.findMany.mockResolvedValue(Array.from({ length: 1000 }, () => event));
    await expect(
      service.readActivityPunchProjectionInputTrusted(f.tx, 'activity', 20000),
    ).resolves.toHaveLength(1000);
    f.db.attendancePunchEvent.findMany.mockResolvedValue(Array.from({ length: 1001 }, () => event));
    await expect(
      service.readActivityPunchProjectionInputTrusted(f.tx, 'activity', 20000),
    ).rejects.toThrow(RangeError);
  });
  it('rejects activity cap+1 and incorrect activity rows', async () => {
    const f = fixture();
    f.db.attendancePunchEvent.findMany.mockResolvedValue(Array.from({ length: 20001 }, () => ({})));
    await expect(
      service.readActivityPunchProjectionInputTrusted(f.tx, 'activity', 20000),
    ).rejects.toThrow(RangeError);
    f.db.attendancePunchEvent.findMany.mockResolvedValue([{ activityId: 'other' }]);
    await expect(
      service.readActivityPunchProjectionInputTrusted(f.tx, 'activity', 20000),
    ).rejects.toThrow(TypeError);
  });
  it('queries correction batches without hiding wrong-activity associations', async () => {
    const f = fixture();
    await service.readCommittedCorrectionAnchorsTrusted(f.tx, 'activity', ['batch']);
    expect(f.db.correctionApplication.findMany).toHaveBeenCalledWith({
      where: { newPostingBatchId: { in: ['batch'] } },
      take: 2,
      orderBy: { id: 'asc' },
      select: {
        id: true,
        statusCode: true,
        newPostingBatchId: true,
        newSettlementVersionId: true,
        correctionRequestId: true,
        correctionRequest: {
          select: {
            id: true,
            statusCode: true,
            activityId: true,
            settlementRunId: true,
            baseSettlementVersionId: true,
          },
        },
      },
    });
  });
  it('rejects duplicate associations even if some requested batches have no correction', async () => {
    const f = fixture();
    const application = { newPostingBatchId: 'a', correctionRequest: { activityId: 'activity' } };
    f.db.correctionApplication.findMany.mockResolvedValue([application, application]);
    await expect(
      service.readCommittedCorrectionAnchorsTrusted(f.tx, 'activity', ['a', 'b']),
    ).rejects.toThrow(TypeError);
  });
  it('rejects cross-activity corrections rather than treating them as absent', async () => {
    const f = fixture();
    f.db.correctionApplication.findMany.mockResolvedValue([
      { newPostingBatchId: 'a', correctionRequest: { activityId: 'other' } },
    ]);
    await expect(
      service.readCommittedCorrectionAnchorsTrusted(f.tx, 'activity', ['a']),
    ).rejects.toThrow(TypeError);
  });
  it('keeps empty batches query-free and refuses unbounded batch inputs', async () => {
    const f = fixture();
    await expect(
      service.readCommittedCorrectionAnchorsTrusted(f.tx, 'activity', []),
    ).resolves.toEqual([]);
    await expect(
      service.readCommittedCorrectionAnchorsTrusted(
        f.tx,
        'activity',
        Array.from({ length: 10001 }, (_, i) => String(i)),
      ),
    ).rejects.toThrow(RangeError);
    expect(f.db.correctionApplication.findMany).not.toHaveBeenCalled();
  });
});
