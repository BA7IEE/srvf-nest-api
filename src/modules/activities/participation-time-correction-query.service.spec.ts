import { ParticipationTimeCorrectionQueryService } from './participation-time-correction-query.service';

describe('D7 correction read boundary', () => {
  const user = { id: 'reader' };
  const setup = () => {
    const manifest = {
      id: 'manifest',
      postingBatchId: 'batch',
      baseSettlementVersionId: 'base',
      rootManifestId: 'root',
      predecessorManifestId: null,
      formatVersion: 1,
      contentHash: 'hash',
      expectedEntryCount: 2,
      reversalSecondsTotal: -9007199254740993n,
      replacementSecondsTotal: 9007199254740992n,
      rootManifest: { settlementVersionId: 'historical-root-version' },
      commitReceipt: { contentHash: 'hash' },
    };
    const tx = {
      participationTimeCorrectionManifest: { findFirst: jest.fn().mockResolvedValue(manifest) },
      participationTimeCorrectionEntry: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'batch' }])
        .mockResolvedValueOnce([
          {
            categoryCode: 'training',
            reversal: '-9007199254740993',
            replacement: '9007199254740992',
          },
        ]),
    };
    const db = { $transaction: (run: (tx: unknown) => unknown) => run(tx) };
    const access = { authorize: jest.fn().mockResolvedValue({}) };
    const service = new ParticipationTimeCorrectionQueryService(db as never, access as never);
    return { manifest, tx, access, service };
  };
  it('uses the exact committed version, checks current qualification after locking, and preserves int64 totals', async () => {
    const { service, tx, access } = setup();
    const result = await service.report(
      'activity',
      'exact-version',
      { page: 2, pageSize: 100 },
      user as never,
    );
    expect(tx.participationTimeCorrectionManifest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          activityId: 'activity',
          settlementVersionId: 'exact-version',
          postingBatch: { statusCode: 'committed' },
          commitReceipt: { isNot: null },
        },
      }),
    );
    expect(access.authorize.mock.calls).toEqual([
      [tx, user, 'activity', 'read', 'historical-root-version'],
      [tx, user, 'activity', 'read', 'historical-root-version'],
    ]);
    expect(tx.participationTimeCorrectionEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 100,
        take: 100,
        orderBy: [
          { participationIdentityId: 'asc' },
          { categoryCode: 'asc' },
          { entryTypeCode: 'asc' },
          { id: 'asc' },
        ],
      }),
    );
    expect(result.netSecondsDelta).toBe('-1');
    expect(result.reversalSecondsTotal).toBe('-9007199254740993');
    expect(result.categories).toHaveLength(4);
    expect(result.categories.find((row) => row.categoryCode === 'training')?.netSecondsDelta).toBe(
      '-1',
    );
    expect(result).not.toHaveProperty('reason');
  });
  it('returns unavailable for missing or invisible versions without fetching entries', async () => {
    const { service, tx, access } = setup();
    tx.participationTimeCorrectionManifest.findFirst.mockResolvedValue(null);
    await expect(
      service.report('activity', 'hidden', { page: 1, pageSize: 20 }, user as never),
    ).rejects.toMatchObject({ biz: { httpStatus: 404 } });
    expect(access.authorize).toHaveBeenCalledTimes(1);
    expect(tx.participationTimeCorrectionEntry.findMany).not.toHaveBeenCalled();
  });
  it('does not serve contents after a failed post-lock authority recheck', async () => {
    const { service, tx, access } = setup();
    access.authorize
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('authority revoked'));
    await expect(
      service.report('activity', 'version', { page: 1, pageSize: 20 }, user as never),
    ).rejects.toThrow('authority revoked');
    expect(tx.participationTimeCorrectionEntry.findMany).not.toHaveBeenCalled();
  });
});
