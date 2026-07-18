import { Role, type StorageObject } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import { StorageUploadIdentityConflictError } from '../storage/storage-consistency.types';
import type { PinnedStorageProvider } from '../storage/storage.interface';
import type { StorageObjectLedgerService } from '../storage/storage-object-ledger.service';
import type {
  DownloadUrlResult,
  HeadObjectResult,
  StorageObjectLocator,
} from '../storage/storage.types';
import type { AttachmentAuditRecorder } from './attachment-audit-recorder';
import type { AttachmentContentValidator } from './attachment-content-validator';
import type {
  AttachmentUploadStorageIdentity,
  FinalizeAttachmentStorageUploadInput,
} from './attachment-storage.types';
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
    putObjectAt: jest.fn(),
    deleteObjectAt: jest.fn(),
    generateUploadUrlAt: jest.fn(),
    headObjectAt,
    readObjectPrefixAt: jest.fn(),
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

describe('AttachmentStorageOrchestrator upload identity boundary', () => {
  const identity: AttachmentUploadStorageIdentity = {
    key: 'attachments/unit/exact-upload.txt',
    ownerType: 'member',
    ownerId: 'member_exact',
    originalName: 'exact-upload.txt',
    mime: 'text/plain',
    size: 7,
    uploadedByUserId: 'user_exact',
    iat: 1_784_435_200,
    exp: 1_784_435_800,
  };
  const requestHash = 'e'.repeat(64);
  const now = new Date('2026-07-19T05:00:00.000Z');
  const availableObject = backfillObject({
    id: 'object_exact',
    key: identity.key,
    state: 'available',
    source: 'attachment_signed_upload',
    providerType: CURRENT_COS.providerType,
    bucket: CURRENT_COS.bucket,
    region: CURRENT_COS.region,
    localNamespace: null,
    expectedSize: BigInt(identity.size),
    actualSize: BigInt(identity.size),
    expectedMime: identity.mime,
    actualMime: identity.mime,
    resourceType: 'attachment',
    resourceId: 'attachment_exact',
    verifiedAt: now,
    presentAt: now,
    lastProviderCheckedAt: now,
  });
  const availableAttachment = {
    id: 'attachment_exact',
    createdAt: now,
    updatedAt: now,
    key: identity.key,
    originalName: identity.originalName,
    mime: identity.mime,
    size: identity.size,
    uploadedBy: identity.uploadedByUserId,
    uploadedAt: now,
    ownerType: identity.ownerType,
    ownerId: identity.ownerId,
    description: null,
    accessLevel: null,
    tags: [] as string[],
    originalUploaderName: null,
    expireAt: null,
  };

  function finalizeInput(
    identityOverride: AttachmentUploadStorageIdentity = identity,
  ): FinalizeAttachmentStorageUploadInput {
    return {
      identity: identityOverride,
      requestHash,
      data: {
        key: identityOverride.key,
        originalName: identityOverride.originalName,
        mime: identityOverride.mime,
        size: identityOverride.size,
        uploadedBy: identityOverride.uploadedByUserId,
        ownerType: identityOverride.ownerType,
        ownerId: identityOverride.ownerId,
      },
      auditKind: 'confirmed',
      actorRoleSnap: Role.ADMIN,
      scope: 'self',
      ownerTable: 'member',
      auditMeta: { requestId: 'unit-exact-replay', ip: null, ua: null },
    };
  }

  function availableFinalizeHarness(
    options: {
      attachment?: typeof availableAttachment;
      operation?: Record<string, unknown>;
    } = {},
  ) {
    const operation = {
      id: 'operation_exact',
      storageObjectId: availableObject.id,
      kind: 'attachment_upload_verify',
      status: 'succeeded',
      effectState: 'provider_present',
      payloadVersion: 1,
      payload: { source: 'attachment_signed_upload' },
      requestHash,
      ...options.operation,
    };
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ id: identity.ownerId, deletedAt: null }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
      storageObject: {
        findUnique: jest.fn().mockResolvedValue(availableObject),
        update: jest.fn(),
      },
      storageObjectOperation: {
        findFirst: jest.fn().mockResolvedValue(operation),
        findUnique: jest.fn().mockResolvedValue(operation),
        update: jest.fn(),
      },
      attachment: {
        findUnique: jest.fn().mockResolvedValue(options.attachment ?? availableAttachment),
        create: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const ledger = {} as StorageObjectLedgerService;
    const logUploadConfirmed = jest.fn();
    const auditRecorder = {
      logUpload: jest.fn(),
      logUploadConfirmed,
    } as unknown as AttachmentAuditRecorder;
    const orchestrator = new AttachmentStorageOrchestrator(
      prisma,
      ledger,
      {} as AttachmentContentValidator,
      auditRecorder,
      {} as PinnedStorageProvider,
    );
    return { orchestrator, tx, logUploadConfirmed };
  }

  it('maps only the dedicated prepare conflict to 13001', async () => {
    const ledger = {
      findObjectByKey: jest.fn().mockResolvedValue(availableObject),
      prepareUpload: jest.fn().mockRejectedValue(new StorageUploadIdentityConflictError()),
    } as unknown as StorageObjectLedgerService;
    const getCurrentLocator = jest.fn();
    const provider = { getCurrentLocator } as unknown as PinnedStorageProvider;
    const orchestrator = new AttachmentStorageOrchestrator(
      {} as PrismaService,
      ledger,
      {} as AttachmentContentValidator,
      {} as AttachmentAuditRecorder,
      provider,
    );

    await expect(
      orchestrator.prepareUpload(
        { ...identity, originalName: 'different-valid-name.txt' },
        'attachment_signed_upload',
        new Date('2026-07-19T06:00:00.000Z'),
      ),
    ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
    expect(getCurrentLocator).not.toHaveBeenCalled();
  });

  it('returns the exact available Attachment without another write or audit', async () => {
    const harness = availableFinalizeHarness();

    await expect(harness.orchestrator.finalizeUpload(finalizeInput())).resolves.toEqual(
      availableAttachment,
    );

    expect(harness.tx.attachment.create).not.toHaveBeenCalled();
    expect(harness.tx.storageObject.update).not.toHaveBeenCalled();
    expect(harness.tx.storageObjectOperation.update).not.toHaveBeenCalled();
    expect(harness.logUploadConfirmed).not.toHaveBeenCalled();
  });

  it.each([
    ['originalName', { originalName: 'different-valid-name.txt' }],
    ['size', { size: identity.size + 1 }],
    ['mime', { mime: 'image/png' }],
  ])('rejects available replay with different %s as 13001', async (_field, override) => {
    const harness = availableFinalizeHarness();

    await expect(
      harness.orchestrator.finalizeUpload(finalizeInput({ ...identity, ...override })),
    ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
    expect(harness.tx.attachment.create).not.toHaveBeenCalled();
    expect(harness.tx.storageObjectOperation.update).not.toHaveBeenCalled();
  });

  it('rejects a non-terminal available replay as 13001 instead of pending', async () => {
    const harness = availableFinalizeHarness({ operation: { status: 'pending' } });

    await expect(harness.orchestrator.finalizeUpload(finalizeInput())).rejects.toEqual(
      new BizException(BizCode.ATTACHMENT_NOT_FOUND),
    );
    expect(harness.tx.attachment.findUnique).not.toHaveBeenCalled();
  });
});
