import type { ConfigType } from '@nestjs/config';

import appConfig from '../../config/app.config';
import type { PrismaService } from '../../database/prisma.service';
import { STORAGE_OPERATION_MAX_ATTEMPTS } from './storage-consistency.types';
import {
  isStorageConsistencyWorkerEntrypoint,
  StorageObjectLedgerService,
} from './storage-object-ledger.service';

type StorageUpdateManyArgs = {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
};

type StorageCreateManyArgs = {
  data: Array<Record<string, unknown>>;
};

describe('StorageObjectLedgerService targeted exhausted claim', () => {
  it('recognizes only the dedicated worker entrypoint for automatic STRICT-gate bypass', () => {
    expect(
      isStorageConsistencyWorkerEntrypoint([
        '/usr/local/bin/node',
        '/srv/app/dist/storage-consistency-worker.js',
        '--purge-replays',
      ]),
    ).toBe(true);
    expect(
      isStorageConsistencyWorkerEntrypoint([
        '/usr/local/bin/node',
        '/srv/app/dist/main.js',
        '--purge-replays',
      ]),
    ).toBe(false);
  });

  it('reapplies eventKey, objectKey, kind and manualOnly after taking locks', async () => {
    const exhausted = {
      id: 'operation_target',
      storageObjectId: 'object_target',
      kind: 'manual_relocate',
    };
    const operationFindMany = jest
      .fn<Promise<(typeof exhausted)[]>, [{ where: unknown }]>()
      .mockResolvedValueOnce([exhausted])
      // Simulate the row being renewed while this claimant waited for locks.
      .mockResolvedValueOnce([]);
    const tx = {
      storageObjectOperation: {
        findMany: operationFindMany,
        updateMany: jest.fn(),
      },
      storageObject: { updateMany: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const cfg = {
      env: 'test',
      storage: { consistencyMode: 'JIT' },
    } as unknown as ConfigType<typeof appConfig>;
    const ledger = new StorageObjectLedgerService(prisma, cfg);
    const now = new Date('2026-07-19T00:00:00.000Z');

    await expect(
      ledger.claim('worker_0001', {
        now,
        eventKey: 'storage.manual-relocate:event-1',
        objectKey: 'attachments/test/object-1',
        kind: 'manual_relocate',
        manualOnly: true,
      }),
    ).resolves.toEqual([]);

    expect(operationFindMany).toHaveBeenCalledTimes(2);
    const beforeLockWhere = operationFindMany.mock.calls[0]?.[0].where;
    const afterLockWhere = operationFindMany.mock.calls[1]?.[0].where;
    expect(afterLockWhere).toEqual(beforeLockWhere);
    expect(afterLockWhere).toEqual({
      status: 'processing',
      attempts: { gte: STORAGE_OPERATION_MAX_ATTEMPTS },
      leaseExpiresAt: { not: null, lte: now },
      AND: [
        { eventKey: 'storage.manual-relocate:event-1' },
        { storageObject: { key: 'attachments/test/object-1' } },
        { kind: 'manual_relocate' },
        { kind: { in: ['manual_relocate', 'manual_attest_absent'] } },
      ],
    });
    // Mutation killed: using the broad processing/exhausted predicate after the lock would call
    // updateMany for an unrelated row. A renewed target produces no terminal write here.
    expect(tx.storageObjectOperation.updateMany).not.toHaveBeenCalled();
    expect(tx.storageObject.updateMany).not.toHaveBeenCalled();
  });

  it('preserves an available state and pinned locator while recording a read failure', async () => {
    const updateMany = jest
      .fn<Promise<{ count: number }>, [StorageUpdateManyArgs]>()
      .mockResolvedValue({ count: 1 });
    const tx = {
      storageObjectOperation: {},
      storageObject: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'object_available',
          state: 'available',
          providerType: 'COS',
          bucket: 'pinned-bucket',
          region: 'ap-test',
          localNamespace: null,
        }),
        updateMany,
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'object_available' }]),
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const cfg = {
      env: 'test',
      storage: { consistencyMode: 'STRICT' },
    } as unknown as ConfigType<typeof appConfig>;
    const ledger = new StorageObjectLedgerService(prisma, cfg);
    const checkedAt = new Date('2026-07-19T04:00:00.000Z');

    await ledger.noteReadFailure(
      'object_available',
      new Error('temporary provider timeout'),
      checkedAt,
    );

    expect(updateMany).toHaveBeenCalledTimes(1);
    const update = updateMany.mock.calls[0]?.[0];
    expect(update?.where).toEqual({ id: 'object_available', state: 'available' });
    expect(update?.data).toMatchObject({
      lastProviderCheckedAt: checkedAt,
      version: { increment: 1 },
    });
    expect(typeof update?.data.lastErrorCode).toBe('string');
    expect(typeof update?.data.lastErrorClass).toBe('string');
    const data = update?.data;
    // Mutation killed: transient read errors may not demote verified state or repin a locator.
    expect(data).not.toHaveProperty('state');
    expect(data).not.toHaveProperty('providerType');
    expect(data).not.toHaveProperty('bucket');
    expect(data).not.toHaveProperty('region');
    expect(data).not.toHaveProperty('localNamespace');
  });

  it('CAS-transitions only an available object on deterministic integrity mismatch', async () => {
    const updateMany = jest
      .fn<Promise<{ count: number }>, [StorageUpdateManyArgs]>()
      .mockResolvedValue({ count: 1 });
    const prisma = { storageObject: { updateMany } } as unknown as PrismaService;
    const cfg = {
      env: 'test',
      storage: { consistencyMode: 'STRICT' },
    } as unknown as ConfigType<typeof appConfig>;
    const ledger = new StorageObjectLedgerService(prisma, cfg);
    const checkedAt = new Date('2026-07-19T04:30:00.000Z');
    const error = Object.assign(new Error('provider HEAD size mismatch'), {
      name: 'StorageObjectIntegrityMismatchError',
      code: 'STORAGE_OBJECT_INTEGRITY_MISMATCH',
    });

    await expect(ledger.markIntegrityMismatch('object_available', error, checkedAt)).resolves.toBe(
      true,
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'object_available', state: 'available' },
      data: {
        state: 'integrity_mismatch',
        lastProviderCheckedAt: checkedAt,
        lastErrorCode: 'STORAGE_OBJECT_INTEGRITY_MISMATCH',
        lastErrorClass: 'StorageObjectIntegrityMismatchError',
        version: { increment: 1 },
      },
    });
  });

  it('preserves a legacy candidate state and locator on timeout or forbidden errors', async () => {
    const updateMany = jest
      .fn<Promise<{ count: number }>, [StorageUpdateManyArgs]>()
      .mockResolvedValue({ count: 1 });
    const tx = {
      storageObject: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'object_legacy',
          state: 'legacy_unverified',
          source: 'backfill',
          providerType: 'COS',
          bucket: 'legacy-bucket',
          region: 'ap-legacy',
          localNamespace: null,
        }),
        updateMany,
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'object_legacy' }]),
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const cfg = {
      env: 'test',
      storage: { consistencyMode: 'JIT' },
    } as unknown as ConfigType<typeof appConfig>;
    const ledger = new StorageObjectLedgerService(prisma, cfg);

    await ledger.noteReadFailure('object_legacy', new Error('temporary forbidden'));

    const data = updateMany.mock.calls[0]?.[0].data;
    expect(data).not.toHaveProperty('state');
    expect(data).not.toHaveProperty('providerType');
    expect(data).not.toHaveProperty('bucket');
    expect(data).not.toHaveProperty('region');
    expect(data).not.toHaveProperty('localNamespace');
  });

  it('demotes an absent legacy candidate and clears every unverified locator field', async () => {
    const updateMany = jest
      .fn<Promise<{ count: number }>, [StorageUpdateManyArgs]>()
      .mockResolvedValue({ count: 1 });
    const tx = {
      storageObjectOperation: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      storageObject: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'object_legacy_absent',
          state: 'legacy_unverified',
          source: 'backfill',
          providerType: 'COS',
          bucket: 'legacy-bucket',
          region: 'ap-legacy',
          localNamespace: null,
        }),
        updateMany,
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'object_legacy_absent' }]),
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const cfg = {
      env: 'test',
      storage: { consistencyMode: 'JIT' },
    } as unknown as ConfigType<typeof appConfig>;
    const ledger = new StorageObjectLedgerService(prisma, cfg);

    await ledger.noteBackfillCandidateAbsent(
      'object_legacy_absent',
      null,
      new Error('provider object absent'),
    );

    expect(updateMany).toHaveBeenCalledTimes(1);
    const update = updateMany.mock.calls[0]?.[0];
    expect(update?.where).toEqual({
      id: 'object_legacy_absent',
      source: 'backfill',
      state: 'legacy_unverified',
    });
    expect(update?.data).toMatchObject({
      state: 'provider_unknown',
      providerType: null,
      bucket: null,
      region: null,
      localNamespace: null,
      version: { increment: 1 },
    });
    expect(update?.data.lastProviderCheckedAt).toBeInstanceOf(Date);
    expect(typeof update?.data.lastErrorCode).toBe('string');
    expect(typeof update?.data.lastErrorClass).toBe('string');
  });

  it('creates runtime backfill intent without persisting the current provider as a locator', async () => {
    const objectCreateMany = jest
      .fn<Promise<{ count: number }>, [StorageCreateManyArgs]>()
      .mockResolvedValue({ count: 1 });
    const operationCreateMany = jest.fn().mockResolvedValue({ count: 1 });
    const createdObject = {
      id: 'runtime_backfill_object',
      key: 'attachments/unit/runtime-backfill.txt',
      state: 'provider_unknown',
      source: 'backfill',
      providerType: null,
      bucket: null,
      region: null,
      localNamespace: null,
    };
    const tx = {
      storageObject: {
        createMany: objectCreateMany,
        findUnique: jest.fn().mockResolvedValue(createdObject),
      },
      storageObjectOperation: {
        findFirst: jest.fn().mockResolvedValue(null),
        createMany: operationCreateMany,
      },
    };
    const prisma = {
      storageObject: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const cfg = {
      env: 'test',
      storage: { consistencyMode: 'JIT' },
    } as unknown as ConfigType<typeof appConfig>;
    const ledger = new StorageObjectLedgerService(prisma, cfg);

    await expect(
      ledger.ensureRuntimeBackfill({
        id: 'attachment_runtime_backfill',
        key: createdObject.key,
        size: 7,
        mime: 'text/plain',
        checksum: null,
        etag: null,
        createdAt: new Date('2026-07-19T06:00:00.000Z'),
      }),
    ).resolves.toBe(createdObject);

    const data = objectCreateMany.mock.calls[0]?.[0].data[0];
    expect(data).toMatchObject({ state: 'provider_unknown', source: 'backfill' });
    expect(data).not.toHaveProperty('providerType');
    expect(data).not.toHaveProperty('bucket');
    expect(data).not.toHaveProperty('region');
    expect(data).not.toHaveProperty('localNamespace');
    expect(operationCreateMany).toHaveBeenCalledTimes(1);
  });
});
