import { Prisma, PrismaClient } from '@prisma/client';
import { ParticipationTimeLedgerService } from './participation-time-ledger.service';
import { buildParticipationTimeLedger } from './participation-time-ledger-policy';

describe('D6 manifest and entry replay checks', () => {
  const db = new PrismaClient();
  const service = new ParticipationTimeLedgerService();
  const batch = { id: 'batch', settlementVersionId: 'version', settlementRunId: 'run' };
  const source = buildParticipationTimeLedger(
    {
      postingBatchId: 'batch',
      activityId: 'activity',
      settlementVersionId: 'version',
      settlementRunId: 'run',
      timeRevisionId: 'revision',
      bucketContentHash: 'a'.repeat(64),
      sourceSetHash: 'b'.repeat(64),
    },
    [
      {
        id: 'bucket',
        participationIdentityId: 'identity',
        categoryCode: 'training',
        recognizedSeconds: 0,
      },
    ],
  );
  const manifest = { ...source.manifest, id: 'manifest', createdAt: new Date(0) };
  beforeEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  it('does not invent a manifest for legacy sources', async () => {
    jest.spyOn(service, 'source').mockResolvedValue(null);
    jest.spyOn(db.participationTimeLedgerManifest, 'findUnique').mockResolvedValue(null);
    const create = jest.spyOn(db.participationTimeLedgerManifest, 'create');
    expect(await service.ensureManifest(db, batch)).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
  it('reuses identical immutable manifests without writes', async () => {
    jest.spyOn(service, 'source').mockResolvedValue(source);
    jest.spyOn(db.participationTimeLedgerManifest, 'findUnique').mockResolvedValue(manifest);
    const create = jest.spyOn(db.participationTimeLedgerManifest, 'create');
    expect(await service.ensureManifest(db, batch)).toEqual(manifest);
    expect(create).not.toHaveBeenCalled();
  });
  it('rejects same-batch different manifest content', async () => {
    jest.spyOn(service, 'source').mockResolvedValue(source);
    jest
      .spyOn(db.participationTimeLedgerManifest, 'findUnique')
      .mockResolvedValue({ ...manifest, contentHash: 'c'.repeat(64) });
    await expect(service.ensureManifest(db, batch)).rejects.toThrow('分类时长账本幂等内容冲突');
  });
  it('rejects source disappearance rather than silently treating it as legacy', async () => {
    jest.spyOn(service, 'source').mockResolvedValue(null);
    jest.spyOn(db.participationTimeLedgerManifest, 'findUnique').mockResolvedValue(manifest);
    await expect(service.assertComplete(db, batch)).rejects.toThrow(
      '分类时长账本来源不完整或不一致',
    );
  });
  it('rejects an incomplete entry set', async () => {
    jest.spyOn(service, 'source').mockResolvedValue(source);
    jest.spyOn(db.participationTimeLedgerManifest, 'findUnique').mockResolvedValue(manifest);
    jest.spyOn(db.participationTimeLedgerEntry, 'findMany').mockResolvedValue([]);
    await expect(service.assertComplete(db, batch)).rejects.toThrow('分类时长账本尚未准备完整');
  });
  it('rejects same-count wrong entries', async () => {
    jest.spyOn(service, 'source').mockResolvedValue(source);
    jest.spyOn(db.participationTimeLedgerManifest, 'findUnique').mockResolvedValue(manifest);
    jest.spyOn(db.participationTimeLedgerEntry, 'findMany').mockResolvedValue([
      {
        ...source.entries[0],
        id: 'entry',
        manifestId: 'manifest',
        createdAt: new Date(0),
        bucketId: 'wrong',
      },
    ]);
    await expect(service.assertComplete(db, batch)).rejects.toThrow('分类时长账本幂等内容冲突');
  });
  it('recognizes complete zero-valued entries', async () => {
    jest.spyOn(service, 'source').mockResolvedValue(source);
    jest.spyOn(db.participationTimeLedgerManifest, 'findUnique').mockResolvedValue(manifest);
    jest
      .spyOn(db.participationTimeLedgerEntry, 'findMany')
      .mockResolvedValue([
        { ...source.entries[0], id: 'entry', manifestId: 'manifest', createdAt: new Date(0) },
      ]);
    expect(await service.assertComplete(db, batch)).toBe(true);
  });

  it.each([
    ['ptlm_batch_fkey', 'P2003', 20226],
    ['ptle_bucket_fkey', 'P2003', 20226],
    ['ptlm_source_guard', 'P2004', 20226],
    ['ptle_hash_check', 'P2004', 20226],
    ['ptle_batch_guard', 'P2010', 20226],
    ['ptl_visibility_guard', 'P2010', 20228],
    ['ptle_entry_key', 'P2002', 20227],
    ['ptle_manifest_bucket_key', 'P2002', 20227],
  ])('maps exact named constraint %s without swallowing it', (constraint, code, expected) => {
    const error = new Prisma.PrismaClientKnownRequestError('constraint "' + constraint + '"', {
      code: String(code),
      clientVersion: 'test',
      meta: { code: '23514', field_name: constraint },
    });
    let caught: unknown;
    try {
      service.rethrowConstraint(error);
    } catch (actual) {
      caught = actual;
    }
    expect(caught).toMatchObject({ biz: { code: expected, httpStatus: 409 } });
  });

  it('maps Prisma unknown CHECK errors only when an exact D6 name is present', () => {
    const error = new Prisma.PrismaClientUnknownRequestError(
      'constraint: Some("ptlm_shape_check")',
      { clientVersion: 'test' },
    );
    expect(() => service.rethrowConstraint(error)).toThrow('分类时长账本来源不完整或不一致');
  });

  it.each([
    new Error('ptlm_shape_check'),
    new Prisma.PrismaClientKnownRequestError('ptlm_shape_check', {
      code: 'P2028',
      clientVersion: 'test',
    }),
    new Prisma.PrismaClientKnownRequestError('ptl_visibility_guard', {
      code: 'P2010',
      clientVersion: 'test',
      meta: { code: '40P01' },
    }),
    new Prisma.PrismaClientKnownRequestError('other_ptlm_shape_check', {
      code: 'P2004',
      clientVersion: 'test',
    }),
    new Prisma.PrismaClientKnownRequestError('ptlm_shape_check_suffix', {
      code: 'P2004',
      clientVersion: 'test',
    }),
    new Prisma.PrismaClientKnownRequestError('other_table_unique', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['id'] },
    }),
  ])('preserves unrelated error %# by identity', (error) => {
    let caught: unknown;
    try {
      service.rethrowConstraint(error, 'manifest');
    } catch (actual) {
      caught = actual;
    }
    expect(caught).toBe(error);
  });

  it('maps exact manifest unique fields at the real manifest write boundary', async () => {
    jest.spyOn(service, 'source').mockResolvedValue(source);
    jest.spyOn(db.participationTimeLedgerManifest, 'findUnique').mockResolvedValue(null);
    jest.spyOn(db.participationTimeLedgerManifest, 'create').mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['postingBatchId'] },
      }),
    );
    await expect(service.ensureManifest(db, batch)).rejects.toThrow('分类时长账本幂等内容冲突');
  });

  it('maps exact source FK at the real entry write boundary', async () => {
    jest.spyOn(service, 'source').mockResolvedValue(source);
    jest.spyOn(db.participationTimeLedgerManifest, 'findUnique').mockResolvedValue(manifest);
    jest.spyOn(db.participationTimeLedgerEntry, 'findMany').mockResolvedValue([]);
    jest.spyOn(db.participationTimeLedgerEntry, 'createMany').mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('foreign key', {
        code: 'P2003',
        clientVersion: 'test',
        meta: { field_name: 'ptle_bucket_fkey (index)' },
      }),
    );
    await expect(service.prepareIdentities(db, batch, ['identity'])).rejects.toThrow(
      '分类时长账本来源不完整或不一致',
    );
  });
});
