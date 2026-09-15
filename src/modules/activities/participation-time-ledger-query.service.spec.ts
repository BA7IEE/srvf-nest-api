import { Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ActivityTimeSettlementAccessService } from './activity-time-settlement-access.service';
import { ParticipationTimeLedgerQueryService } from './participation-time-ledger-query.service';

describe('D6 committed historical ledger query', () => {
  const user = {
    id: 'reviewer',
    username: 'reviewer',
    role: Role.USER,
    status: UserStatus.ACTIVE,
    memberId: 'member',
  };
  const manifest = {
    id: 'manifest',
    postingBatchId: 'batch',
    timeRevisionId: 'historical-revision',
    formatVersion: 1,
    contentHash: 'a'.repeat(64),
    expectedEntryCount: 4,
    recognizedSecondsTotal: 17179869176n,
  };
  const tx = {
    activitySettlementTimeRevision: { findFirst: jest.fn() },
    participationTimeLedgerManifest: { findUnique: jest.fn() },
    participationTimeLedgerEntry: { findMany: jest.fn() },
    $queryRaw: jest.fn(),
  };
  const authorize = jest.fn();
  const service = new ParticipationTimeLedgerQueryService(
    {
      $transaction: (run: (client: typeof tx) => Promise<unknown>) => run(tx),
    } as unknown as PrismaService,
    { authorize } as unknown as ActivityTimeSettlementAccessService,
  );
  const report = () =>
    service.report('activity', 'historical-revision', { page: 2, pageSize: 2 }, user);

  beforeEach(() => {
    jest.resetAllMocks();
    authorize.mockResolvedValue({});
    tx.activitySettlementTimeRevision.findFirst.mockResolvedValue({
      settlementVersionId: 'historical-version',
    });
    tx.participationTimeLedgerManifest.findUnique.mockResolvedValue(manifest);
    tx.participationTimeLedgerEntry.findMany.mockResolvedValue([]);
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: 'batch' }])
      .mockResolvedValueOnce([{ categoryCode: 'training', seconds: '17179869176' }]);
  });

  it('authorizes the bound historical version both before and after the batch lock', async () => {
    const result = await report();
    expect(authorize.mock.calls).toEqual([
      [tx, user, 'activity', 'read', 'historical-version'],
      [tx, user, 'activity', 'read', 'historical-version'],
    ]);
    expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$queryRaw.mock.invocationCallOrder[0],
    );
    expect(authorize.mock.invocationCallOrder[1]).toBeGreaterThan(
      tx.$queryRaw.mock.invocationCallOrder[0],
    );
    expect(result.recognizedSecondsTotal).toBe('17179869176');
    expect(result.categories).toHaveLength(4);
    expect(result.categories.filter((row) => row.recognizedSecondsTotal === '0')).toHaveLength(3);
    expect(result.resultPage).toEqual({ page: 2, pageSize: 2, total: 4, items: [] });
    expect(tx.participationTimeLedgerEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { manifestId: 'manifest' },
        skip: 2,
        take: 2,
        orderBy: [{ participationIdentityId: 'asc' }, { categoryCode: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  it('does not return manifest or entries after access is revoked during the lock wait', async () => {
    authorize.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('revoked'));
    await expect(report()).rejects.toThrow('revoked');
    expect(tx.participationTimeLedgerManifest.findUnique).not.toHaveBeenCalled();
    expect(tx.participationTimeLedgerEntry.findMany).not.toHaveBeenCalled();
  });

  it('rejects an unpublished batch without loading its ledger content', async () => {
    tx.$queryRaw.mockReset().mockResolvedValueOnce([]);
    await expect(report()).rejects.toThrow();
    expect(tx.participationTimeLedgerManifest.findUnique).not.toHaveBeenCalled();
    expect(tx.participationTimeLedgerEntry.findMany).not.toHaveBeenCalled();
  });

  it('still checks access before reporting a missing revision', async () => {
    tx.activitySettlementTimeRevision.findFirst.mockResolvedValue(null);
    authorize.mockRejectedValueOnce(new Error('denied'));
    await expect(report()).rejects.toThrow('denied');
    expect(authorize).toHaveBeenCalledWith(tx, user, 'activity', 'read');
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
