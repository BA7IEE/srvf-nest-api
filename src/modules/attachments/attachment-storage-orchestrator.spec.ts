import type { StorageObject } from '@prisma/client';

import type { PrismaService } from '../../database/prisma.service';
import type { PinnedStorageProvider } from '../storage/storage.interface';
import type { StorageObjectLedgerService } from '../storage/storage-object-ledger.service';
import type {
  DownloadUrlResult,
  HeadObjectResult,
  StorageObjectLocator,
} from '../storage/storage.types';
import type { AttachmentAuditRecorder } from './attachment-audit-recorder';
import type { AttachmentContentValidator } from './attachment-content-validator';
import {
  AttachmentStorageOrchestrator,
  canUseCurrentLocatorAsBackfillCandidate,
} from './attachment-storage-orchestrator';

const CURRENT_COS: StorageObjectLocator = {
  providerType: 'COS',
  bucket: 'current-bucket',
  region: 'ap-current',
  localNamespace: null,
};

const CURRENT_LOCAL: StorageObjectLocator = {
  providerType: 'LOCAL',
  bucket: null,
  region: null,
  localNamespace: '/var/lib/srvf/storage',
};

type PrivatePromotion = {
  promoteBackfillAvailable(
    object: StorageObject,
    locator: StorageObjectLocator,
    head: HeadObjectResult,
  ): Promise<boolean>;
};

type AvailableCheckUpdate = {
  where: { id: string; state: string };
  data: { lastProviderCheckedAt: Date };
};

function backfillObject(overrides: Partial<StorageObject> = {}): StorageObject {
  const now = new Date('2026-07-19T05:00:00.000Z');
  return {
    id: 'object_candidate',
    key: 'attachments/unit/candidate.txt',
    state: 'provider_unknown',
    source: 'backfill',
    providerType: null,
    bucket: null,
    region: null,
    localNamespace: null,
    expectedSize: 7n,
    actualSize: null,
    expectedMime: 'text/plain',
    actualMime: null,
    etag: null,
    checksum: null,
    resourceType: 'attachment',
    resourceId: 'attachment_candidate',
    version: 0,
    unboundExpiresAt: null,
    lastProviderCheckedAt: null,
    verifiedAt: null,
    presentAt: null,
    deleteRequestedAt: null,
    absentAt: null,
    missingAt: null,
    lastErrorCode: null,
    lastErrorClass: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function harness(options: { strict?: boolean; head?: HeadObjectResult; headError?: Error } = {}) {
  const object = backfillObject();
  const attachment = {
    id: object.resourceId,
    key: object.key,
    size: 7,
    mime: 'text/plain',
    etag: null,
    checksum: null,
    createdAt: object.createdAt,
  };
  const updateMany = jest
    .fn<Promise<{ count: number }>, [AvailableCheckUpdate]>()
    .mockResolvedValue({ count: 1 });
  const prisma = {
    attachment: { findUnique: jest.fn().mockResolvedValue(attachment) },
    storageObject: { updateMany },
  } as unknown as PrismaService;
  const noteBackfillCandidateAbsent = jest
    .fn<Promise<void>, [string, string | null, Error]>()
    .mockResolvedValue(undefined);
  const noteReadFailure = jest.fn<Promise<void>, [string, Error]>().mockResolvedValue(undefined);
  const ledger = {
    findObjectByKey: jest.fn().mockResolvedValue(object),
    isStrictMode: jest.fn().mockReturnValue(options.strict ?? false),
    isReadableState: jest
      .fn()
      .mockImplementation(
        (state: string) => !(options.strict ?? false) && state === 'provider_unknown',
      ),
    ensureRuntimeBackfill: jest.fn(),
    noteBackfillCandidateAbsent,
    noteReadFailure,
    markMissing: jest.fn().mockResolvedValue(undefined),
    noteAvailableHead: jest.fn().mockResolvedValue(undefined),
  } as unknown as StorageObjectLedgerService;
  const headObjectAt = jest.fn<Promise<HeadObjectResult>, [StorageObjectLocator, string]>();
  if (options.headError) headObjectAt.mockRejectedValue(options.headError);
  else
    headObjectAt.mockResolvedValue(
      options.head ?? { exists: true, size: 7, contentType: 'text/plain' },
    );
  const signed: DownloadUrlResult = {
    url: 'https://download.invalid/candidate',
    expiresAt: new Date('2026-07-19T05:05:00.000Z'),
  };
  const getCurrentLocator = jest
    .fn<Promise<StorageObjectLocator>, []>()
    .mockResolvedValue(CURRENT_COS);
  const provider = {
    getCurrentLocator,
    headObjectAt,
    hashObjectSha256At: jest.fn(),
    generateDownloadUrlAt: jest.fn().mockResolvedValue(signed),
  } as unknown as PinnedStorageProvider;
  const orchestrator = new AttachmentStorageOrchestrator(
    prisma,
    ledger,
    {} as AttachmentContentValidator,
    {} as AttachmentAuditRecorder,
    provider,
  );
  const promote = jest
    .spyOn(orchestrator as unknown as PrivatePromotion, 'promoteBackfillAvailable')
    .mockResolvedValue(true);
  return {
    orchestrator,
    object,
    getCurrentLocator,
    headObjectAt,
    noteBackfillCandidateAbsent,
    noteReadFailure,
    promote,
    updateMany,
  };
}

describe('AttachmentStorageOrchestrator JIT locator candidates', () => {
  it('admits only exact unpinned backfill/provider_unknown shapes', () => {
    const unknown = backfillObject();
    expect(canUseCurrentLocatorAsBackfillCandidate(unknown, CURRENT_COS)).toBe(true);
    expect(
      canUseCurrentLocatorAsBackfillCandidate(
        backfillObject({ providerType: 'LOCAL' }),
        CURRENT_LOCAL,
      ),
    ).toBe(true);
    expect(
      canUseCurrentLocatorAsBackfillCandidate(
        backfillObject({ providerType: 'LOCAL' }),
        CURRENT_COS,
      ),
    ).toBe(false);
    expect(
      canUseCurrentLocatorAsBackfillCandidate(
        backfillObject({ state: 'legacy_unverified' }),
        CURRENT_COS,
      ),
    ).toBe(false);
    expect(
      canUseCurrentLocatorAsBackfillCandidate(
        backfillObject({ bucket: 'half-locator' }),
        CURRENT_COS,
      ),
    ).toBe(false);
  });

  it('uses current COS for HEAD but reaches promotion before any DB linearization', async () => {
    const { orchestrator, object, getCurrentLocator, headObjectAt, promote, updateMany } =
      harness();

    await expect(orchestrator.resolveDownloadUrl(object.key, 300)).resolves.toBe(
      'https://download.invalid/candidate',
    );
    expect(getCurrentLocator).toHaveBeenCalledTimes(1);
    expect(headObjectAt).toHaveBeenCalledWith(CURRENT_COS, object.key);
    expect(promote).toHaveBeenCalledWith(
      object,
      CURRENT_COS,
      expect.objectContaining({ exists: true, size: 7 }),
    );
    expect(updateMany).toHaveBeenCalledTimes(1);
    const update = updateMany.mock.calls[0]?.[0];
    expect(update?.where).toEqual({ id: object.id, state: 'available' });
    expect(update?.data.lastProviderCheckedAt).toBeInstanceOf(Date);
  });

  it.each([
    ['absent', { head: { exists: false } }],
    ['timeout', { headError: new Error('candidate timeout') }],
  ] as const)(
    '%s evidence never promotes or pins the current candidate',
    async (_label, options) => {
      const {
        orchestrator,
        object,
        noteBackfillCandidateAbsent,
        noteReadFailure,
        promote,
        updateMany,
      } = harness(options);

      await expect(orchestrator.resolveDownloadUrl(object.key, 300)).resolves.toBeNull();
      expect(promote).not.toHaveBeenCalled();
      expect(updateMany).not.toHaveBeenCalled();
      if ('head' in options) {
        expect(noteBackfillCandidateAbsent).toHaveBeenCalledWith(
          object.id,
          null,
          expect.any(Error),
        );
        expect(noteReadFailure).not.toHaveBeenCalled();
      } else {
        expect(noteReadFailure).toHaveBeenCalledWith(object.id, options.headError);
        expect(noteBackfillCandidateAbsent).not.toHaveBeenCalled();
      }
    },
  );

  it('STRICT rejects provider_unknown before consulting the current locator', async () => {
    const { orchestrator, object, getCurrentLocator, headObjectAt, promote, updateMany } = harness({
      strict: true,
    });

    await expect(orchestrator.resolveDownloadUrl(object.key, 300)).resolves.toBeNull();
    expect(getCurrentLocator).not.toHaveBeenCalled();
    expect(headObjectAt).not.toHaveBeenCalled();
    expect(promote).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
