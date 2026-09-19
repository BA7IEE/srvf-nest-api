import { ParticipationTimeCorrectionService } from './participation-time-correction.service';

describe('D7 correction source and commit ownership', () => {
  const service = new ParticipationTimeCorrectionService();
  const anchor = {
    correctionRequestId: 'request',
    postingBatchId: 'batch',
    activityId: 'activity',
    settlementRunId: 'run',
    baseSettlementVersionId: 'base',
    settlementVersionId: 'next',
    requestHash: 'a'.repeat(64),
  };
  const change = {
    baseSettlementVersionId: 'base',
    baseTimeLedgerHash: 'b'.repeat(64),
    reason: 'retained',
    items: [{ rootEntryId: 'root-entry', recognizedSeconds: 0 }],
  };
  const makeDb = () => ({
    participationTimeLedgerManifest: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'root',
        settlementVersionId: 'base',
        contentHash: 'b'.repeat(64),
        expectedEntryCount: 1,
      }),
    },
    participationTimeLedgerEntry: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'root-entry',
          manifestId: 'root',
          participationIdentityId: 'person',
          categoryCode: 'training',
          recognizedSeconds: 300,
        },
      ]),
    },
    participationTimeCorrectionManifest: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    },
    participationTimeCorrectionEntry: {
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn(),
    },
    participationTimeCorrectionCommitReceipt: { create: jest.fn() },
    correctionApplication: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest
      .fn<Promise<unknown[]>, [TemplateStringsArray, ...unknown[]]>()
      .mockImplementation((parts) => {
        const sql = parts.join('');
        if (sql.includes('UNION ALL'))
          return Promise.resolve([
            {
              id: 'root',
              settlementVersionId: 'base',
              expectedEntryCount: 1,
              baseContentHash: 'b'.repeat(64),
              predecessorManifestId: null,
            },
          ]);
        if (sql.includes('previousEntryId'))
          return Promise.resolve([
            {
              id: 'root-entry',
              manifestId: 'root',
              participationIdentityId: 'person',
              categoryCode: 'training',
              recognizedSeconds: 300,
              previousEntryId: null,
              previousSeconds: null,
            },
          ]);
        return Promise.resolve([]);
      }),
  });
  it('does not silently select a different base hash or version', async () => {
    for (const changed of [
      { ...change, baseTimeLedgerHash: 'c'.repeat(64) },
      { ...change, baseSettlementVersionId: 'other' },
    ]) {
      await expect(service.source(makeDb() as never, anchor, changed)).rejects.toThrow(
        '分类时长账本来源不完整或不一致',
      );
    }
  });
  it('builds only the exact root snapshot and keeps complete zero replacements', async () => {
    const db = makeDb();
    const result = await service.source(db as never, anchor, change);
    expect(result.entries.map((row) => row.secondsDelta)).toEqual([-300, 0]);
    expect(db.$queryRaw).toHaveBeenCalledWith(
      expect.any(Array),
      'base',
      'activity',
      'run',
      'base',
      'activity',
      'run',
    );
    expect(db.participationTimeCorrectionManifest.findFirst).not.toHaveBeenCalled();
  });
  it('does not include database IDs or extra relation objects in the content hash', async () => {
    const plain = await service.source(makeDb() as never, anchor, change);
    const withDatabaseFields = {
      ...anchor,
      id: 'manifest',
      createdAt: new Date(),
      relation: { arbitrary: true },
    };
    expect(await service.source(makeDb() as never, withDatabaseFields, change)).toEqual(plain);
  });
  it('carries a D7-2 source proof into format 2 without changing the exact source query', async () => {
    const db = makeDb();
    const result = await service.source(
      db as never,
      { ...anchor, sourceProofId: 'proof', sourceProofHash: 'c'.repeat(64) },
      change,
    );
    expect(result.manifest.formatVersion).toBe(2);
    if (result.manifest.formatVersion !== 2) throw new Error('expected format 2 manifest');
    expect(result.manifest.sourceProofId).toBe('proof');
    expect(result.manifest.sourceProofHash).toBe('c'.repeat(64));
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
  });
  it('inherits the immediate V3 proof when a later V2 correction uses that version as its base', async () => {
    const db = makeDb();
    db.$queryRaw
      .mockResolvedValueOnce([
        {
          id: 'root',
          settlementVersionId: 'root-version',
          expectedEntryCount: 1,
          baseContentHash: 'b'.repeat(64),
          predecessorManifestId: 'previous-manifest',
          sourceProofId: 'proof-from-v3',
          sourceProofHash: 'c'.repeat(64),
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'root-entry',
          manifestId: 'root',
          participationIdentityId: 'person',
          categoryCode: 'training',
          recognizedSeconds: 300,
          previousEntryId: 'previous-credit',
          previousSeconds: 300,
        },
      ]);

    const result = await service.source(db as never, anchor, change);

    expect(result.manifest.formatVersion).toBe(2);
    if (result.manifest.formatVersion !== 2) throw new Error('expected inherited format 2 proof');
    expect(result.manifest.sourceProofId).toBe('proof-from-v3');
    expect(result.manifest.sourceProofHash).toBe('c'.repeat(64));
  });
  it('keeps all predecessor keys inside the lateral probe and binds a null predecessor', async () => {
    const db = makeDb();
    await service.source(db as never, anchor, change);
    const [parts, predecessor, root] = db.$queryRaw.mock.calls[1];
    const sql = parts.join('?');
    expect(predecessor).toBeNull();
    expect(root).toBe('root');
    expect(sql).toContain('LEFT JOIN LATERAL');
    for (const predicate of [
      'prior."manifestId" = ?',
      'prior."rootEntryId" = e."id"',
      'prior."entryTypeCode" = \'credit\'',
      'prior."participationIdentityId" = e."participationIdentityId"',
      'prior."categoryCode" = e."categoryCode"',
    ]) {
      expect(sql.indexOf(predicate)).toBeGreaterThan(sql.indexOf('LEFT JOIN LATERAL'));
      expect(sql.indexOf(predicate)).toBeLessThan(sql.indexOf('OFFSET 0'));
    }
    expect(sql).toContain(') p ON TRUE');
    expect(sql).toContain('ORDER BY e."id" LIMIT 8001');
  });
  it.each(['identity', 'category'])(
    'rejects a predecessor filtered out by its %s key',
    async () => {
      // SQL filtering leaves a null predecessor: policy must not fall back to root amounts.
      const db = makeDb();
      db.$queryRaw.mockResolvedValueOnce([
        {
          id: 'root',
          settlementVersionId: 'base',
          expectedEntryCount: 1,
          baseContentHash: 'b'.repeat(64),
          predecessorManifestId: 'previous',
        },
      ]);
      await expect(service.source(db as never, anchor, change)).rejects.toThrow();
    },
  );
  it('rejects missing roots even if the request has the expected number of items', async () => {
    const db = makeDb();
    db.$queryRaw
      .mockResolvedValueOnce([
        {
          id: 'root',
          settlementVersionId: 'base',
          expectedEntryCount: 1,
          baseContentHash: 'b'.repeat(64),
          predecessorManifestId: null,
        },
      ])
      .mockResolvedValueOnce([]);
    await expect(service.source(db as never, anchor, change)).rejects.toThrow();
  });
  it('fails closed on omitted manifest without minting a receipt', async () => {
    const db = makeDb();
    await expect(service.createCommitReceipt(db as never, 'batch')).rejects.toThrow(
      '分类时长账本尚未准备完整',
    );
    expect(db.participationTimeCorrectionCommitReceipt.create).not.toHaveBeenCalled();
  });
  it('never creates a receipt for preparing, failed or committed batches', async () => {
    for (const statusCode of ['preparing', 'failed', 'committed']) {
      const db = makeDb();
      db.$queryRaw.mockResolvedValue([{ id: 'batch', batchStatus: statusCode }]);
      await expect(service.createCommitReceipt(db as never, 'batch')).rejects.toThrow();
      expect(db.participationTimeCorrectionManifest.findUnique).not.toHaveBeenCalled();
      expect(db.participationTimeCorrectionCommitReceipt.create).not.toHaveBeenCalled();
    }
  });
  it('uses the bound application and exact JSON version to identify D7, not the presence of a manifest', async () => {
    const db = makeDb();
    db.$queryRaw.mockResolvedValue([
      { required: false, hasApplication: false, classifiedBase: false },
    ]);
    expect(await service.isCorrectionBatch(db as never, 'batch')).toBe(false);
    db.$queryRaw.mockResolvedValue([
      { required: true, hasApplication: true, classifiedBase: false },
    ]);
    expect(await service.isCorrectionBatch(db as never, 'batch')).toBe(true);
    expect(db.$queryRaw).toHaveBeenCalledWith(expect.any(Array), 'batch');
  });
  it('shares one DB-derived batch fact while preserving a legacy application shape branch', async () => {
    const db = makeDb();
    db.$queryRaw.mockResolvedValue([
      { required: false, hasApplication: true, classifiedBase: false },
    ]);

    await expect(service.classifyBatch(db as never, 'batch')).resolves.toEqual({
      required: false,
      hasApplication: true,
    });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.$queryRaw).toHaveBeenCalledWith(expect.any(Array), 'batch');
  });
  it('propagates unknown failures unchanged', () => {
    const failure = new Error('unknown failure');
    expect(() => service.rethrowConstraint(failure)).toThrow(failure);
  });
  it('retains the legacy classified-base exclusion in the combined application probe', async () => {
    const db = makeDb();
    db.$queryRaw.mockResolvedValue([
      { required: false, hasApplication: false, classifiedBase: true },
    ]);
    await expect(service.isCorrectionBatch(db as never, 'batch')).rejects.toMatchObject({
      biz: { code: 20229 },
    });
  });
});
