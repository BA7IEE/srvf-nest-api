import { Prisma, Role, type StorageObject, type StorageObjectOperation } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import {
  StorageUploadIdentityConflictError,
  storageOwnerUploadEventKey,
  storageRequestHash,
} from '../storage/storage-consistency.types';
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

function storageOperation(overrides: Partial<StorageObjectOperation> = {}): StorageObjectOperation {
  const now = new Date('2026-07-19T05:00:00.000Z');
  return {
    id: 'operation_candidate',
    eventKey: `storage.fixture:${'7'.repeat(64)}`,
    storageObjectId: 'object_candidate',
    replayOfId: null,
    kind: 'attachment_upload_verify',
    status: 'pending',
    effectState: 'not_started',
    payloadVersion: 1,
    payload: { source: 'attachment_signed_upload' },
    requestHash: '7'.repeat(64),
    attempts: 0,
    availableAt: now,
    leaseOwner: null,
    leaseGeneration: 0,
    leaseAcquiredAt: null,
    leaseRenewedAt: null,
    leaseExpiresAt: null,
    effectStartedAt: null,
    effectCompletedAt: null,
    completedAt: null,
    deadAt: null,
    lastErrorCode: null,
    lastErrorClass: null,
    responseSnapshotExpiresAt: null,
    responsePurgedAt: null,
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
      eventKey: storageOwnerUploadEventKey(identity.ownerType, identity.ownerId, requestHash),
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
        findMany: jest.fn().mockResolvedValue([]),
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
      prepareUploadInTransaction: jest
        .fn()
        .mockRejectedValue(new StorageUploadIdentityConflictError()),
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
      orchestrator.prepareUploadInTransaction(
        {} as Prisma.TransactionClient,
        { ...identity, originalName: 'different-valid-name.txt' },
        'attachment_signed_upload',
        new Date('2026-07-19T06:00:00.000Z'),
      ),
    ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
    expect(getCurrentLocator).not.toHaveBeenCalled();
  });

  it.each(['member', 'certificate', 'activity', 'content-image', 'content-file'] as const)(
    'issues every new %s upload with owner-v1 inside the supplied transaction',
    async (ownerType) => {
      const ownerIdentity = {
        ...identity,
        ownerType,
        ownerId: `${ownerType}-private-owner`,
      };
      const prepareUploadInTransaction = jest.fn(
        (_tx: Prisma.TransactionClient, input: { eventKey: string; requestHash: string }) => ({
          object: availableObject,
          operation: {
            id: 'operation-owner-v1',
            eventKey: input.eventKey,
          },
        }),
      );
      const ledger = {
        findObjectByKey: jest.fn().mockResolvedValue(availableObject),
        prepareUploadInTransaction,
      } as unknown as StorageObjectLedgerService;
      const prismaTransaction = jest.fn();
      const prisma = { $transaction: prismaTransaction } as unknown as PrismaService;
      const orchestrator = new AttachmentStorageOrchestrator(
        prisma,
        ledger,
        {} as AttachmentContentValidator,
        {} as AttachmentAuditRecorder,
        {} as PinnedStorageProvider,
      );
      const tx = {} as Prisma.TransactionClient;

      const prepared = await orchestrator.prepareUploadInTransaction(
        tx,
        ownerIdentity,
        'attachment_signed_upload',
        new Date('2026-07-19T06:00:00.000Z'),
      );

      const ledgerInput = prepareUploadInTransaction.mock.calls[0]?.[1];
      if (!ledgerInput) throw new Error('ledger input was not captured');
      expect(ledgerInput.eventKey).toBe(
        storageOwnerUploadEventKey(ownerType, ownerIdentity.ownerId, ledgerInput.requestHash),
      );
      expect(ledgerInput.eventKey).not.toContain(ownerIdentity.ownerId);
      expect(prepared.eventKey).toBe(ledgerInput.eventKey);
      expect(prismaTransaction).not.toHaveBeenCalled();
    },
  );

  it('durably records Provider-unknown evidence before returning 13034', async () => {
    const providerRequestHash = storageRequestHash({
      source: 'attachment_signed_upload',
      ...identity,
    });
    const object = {
      ...availableObject,
      state: 'pending_upload',
      resourceType: null,
      resourceId: null,
      actualSize: null,
      actualMime: null,
      verifiedAt: null,
      presentAt: null,
    };
    const operation = storageOperation({
      id: 'operation_provider_unknown',
      eventKey: storageOwnerUploadEventKey(
        identity.ownerType,
        identity.ownerId,
        providerRequestHash,
      ),
      storageObjectId: object.id,
      requestHash: providerRequestHash,
    });
    const providerError = Object.assign(new Error('upload HEAD timed out'), {
      name: 'ProviderHeadTimeoutError',
      code: 'ETIMEDOUT',
    });
    const noteProviderUnknown = jest.fn().mockResolvedValue(undefined);
    const ledger = {
      findUploadContext: jest.fn().mockResolvedValue({ object, operation }),
      noteProviderUnknown,
    } as unknown as StorageObjectLedgerService;
    const validateFromObjectAt = jest.fn().mockRejectedValue(providerError);
    const orchestrator = new AttachmentStorageOrchestrator(
      {} as PrismaService,
      ledger,
      { validateFromObjectAt } as unknown as AttachmentContentValidator,
      {} as AttachmentAuditRecorder,
      {} as PinnedStorageProvider,
    );

    await expect(
      orchestrator.verifyUploadEvidence(identity, 'attachment_signed_upload'),
    ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING));

    expect(validateFromObjectAt).toHaveBeenCalledWith(CURRENT_COS, {
      key: identity.key,
      mime: identity.mime,
      size: identity.size,
    });
    expect(noteProviderUnknown).toHaveBeenCalledWith(object.id, operation.id, providerError);
  });

  it('returns the exact available Attachment without another write or audit', async () => {
    const harness = availableFinalizeHarness();

    await expect(
      harness.orchestrator.finalizeUpload(finalizeInput(), {
        exists: true,
        size: identity.size,
      }),
    ).resolves.toEqual(availableAttachment);

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
      harness.orchestrator.finalizeUpload(finalizeInput({ ...identity, ...override }), {
        exists: true,
        size: identity.size,
      }),
    ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
    expect(harness.tx.attachment.create).not.toHaveBeenCalled();
    expect(harness.tx.storageObjectOperation.update).not.toHaveBeenCalled();
  });

  it('rejects a non-terminal available replay as 13001 instead of pending', async () => {
    const harness = availableFinalizeHarness({ operation: { status: 'pending' } });

    await expect(
      harness.orchestrator.finalizeUpload(finalizeInput(), {
        exists: true,
        size: identity.size,
      }),
    ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
    expect(harness.tx.attachment.findUnique).not.toHaveBeenCalled();
  });
});

describe('AttachmentStorageOrchestrator Content publish storage boundary', () => {
  const contentId = 'content_publish_boundary_1';
  const requestHash = '6'.repeat(64);
  const unboundExpiresAt = new Date('2026-07-19T07:00:00.000Z');

  type BoundaryObjectUpdate = {
    where: {
      id: string;
      state: string;
      resourceId: null;
      deleteRequestedAt: null;
    };
    data: {
      state: string;
      deleteRequestedAt: Date;
      version: { increment: number };
    };
  };
  type BoundaryOperationUpdate = {
    where: {
      id: string;
      status: string;
      storageObjectId: string;
      kind: string;
    };
    data: {
      status: string;
      completedAt: Date;
      deadAt: Date;
      leaseOwner: null;
      leaseAcquiredAt: null;
      leaseRenewedAt: null;
      leaseExpiresAt: null;
      lastErrorCode: null;
      lastErrorClass: null;
    };
  };
  type BoundaryOperationCreate = {
    data: {
      eventKey: string;
      storageObjectId: string;
      replayOfId: string;
      kind: string;
      status: string;
      effectState: string;
      payloadVersion: number;
      payload: Prisma.InputJsonValue;
      requestHash: string;
      availableAt: Date;
    };
  };

  function unboundHarness(options: { ownerless?: boolean; state?: string } = {}) {
    const object = backfillObject({
      id: 'object_content_unbound',
      key: 'attachments/unit/content-unbound.png',
      state: options.state ?? 'present_unbound',
      source: 'attachment_signed_upload',
      providerType: CURRENT_COS.providerType,
      bucket: CURRENT_COS.bucket,
      region: CURRENT_COS.region,
      localNamespace: null,
      expectedSize: 7n,
      actualSize: 7n,
      expectedMime: 'image/png',
      actualMime: 'image/png',
      resourceType: null,
      resourceId: null,
      unboundExpiresAt,
      presentAt: new Date('2026-07-19T05:30:00.000Z'),
    });
    const operation = storageOperation({
      id: 'operation_content_upload',
      eventKey: storageOwnerUploadEventKey('content-image', contentId, requestHash),
      storageObjectId: object.id,
      requestHash,
      effectState: 'provider_present',
      payload: { source: 'attachment_signed_upload' },
    });
    const queryRaw = jest.fn<Promise<Array<{ id: string }>>, [Prisma.Sql]>();
    if (options.ownerless) {
      queryRaw.mockResolvedValueOnce([{ id: 'ownerless_confirmable' }]);
    } else {
      queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: object.id }])
        .mockResolvedValueOnce([{ id: operation.id }]);
    }
    const attachmentFindMany = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const objectFindMany = jest
      .fn()
      .mockResolvedValueOnce([{ id: object.id }])
      .mockResolvedValueOnce([object]);
    const operationFindMany = jest
      .fn()
      .mockResolvedValueOnce([{ storageObjectId: object.id }])
      .mockResolvedValueOnce([operation])
      .mockResolvedValueOnce([{ id: operation.id, storageObjectId: object.id }]);
    const objectUpdateMany = jest
      .fn<Promise<{ count: number }>, [BoundaryObjectUpdate]>()
      .mockResolvedValue({ count: 1 });
    const operationUpdateMany = jest
      .fn<Promise<{ count: number }>, [BoundaryOperationUpdate]>()
      .mockResolvedValue({ count: 1 });
    const operationCreate = jest
      .fn<Promise<{ id: string }>, [BoundaryOperationCreate]>()
      .mockResolvedValue({ id: 'operation_orphan' });
    const tx = {
      $queryRaw: queryRaw,
      attachment: { findMany: attachmentFindMany },
      storageObject: {
        findMany: objectFindMany,
        updateMany: objectUpdateMany,
      },
      storageObjectOperation: {
        findMany: operationFindMany,
        updateMany: operationUpdateMany,
        update: jest.fn(),
        create: operationCreate,
      },
    };
    const prismaTransaction = jest.fn();
    const prisma = { $transaction: prismaTransaction } as unknown as PrismaService;
    const validateFromObjectAt = jest.fn();
    const contentValidator = { validateFromObjectAt } as unknown as AttachmentContentValidator;
    const logUpload = jest.fn();
    const logUploadConfirmed = jest.fn();
    const logDelete = jest.fn();
    const auditRecorder = {
      logUpload,
      logUploadConfirmed,
      logDelete,
    } as unknown as AttachmentAuditRecorder;
    const headObjectAt = jest.fn();
    const deleteObjectAt = jest.fn();
    const provider = {
      getCurrentLocator: jest.fn(),
      headObjectAt,
      deleteObjectAt,
    } as unknown as PinnedStorageProvider;
    const orchestrator = new AttachmentStorageOrchestrator(
      prisma,
      {} as StorageObjectLedgerService,
      contentValidator,
      auditRecorder,
      provider,
    );
    return {
      orchestrator,
      prisma,
      tx,
      object,
      operation,
      queryRaw,
      attachmentFindMany,
      objectFindMany,
      operationFindMany,
      objectUpdateMany,
      operationUpdateMany,
      operationCreate,
      prismaTransaction,
      validateFromObjectAt,
      logUpload,
      logUploadConfirmed,
      logDelete,
      headObjectAt,
      deleteObjectAt,
    };
  }

  it('fails closed at the ownerless rollout gate without attributing or mutating an intent', async () => {
    const harness = unboundHarness({ ownerless: true });

    await expect(
      harness.orchestrator.lockContentPublishBoundary(
        harness.tx as unknown as Prisma.TransactionClient,
        {
          contentId,
          referencedAttachmentIds: [],
          coverAttachmentId: null,
          coverImageKey: null,
        },
      ),
    ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING));

    expect(harness.queryRaw).toHaveBeenCalledTimes(1);
    expect(harness.attachmentFindMany).not.toHaveBeenCalled();
    expect(harness.objectFindMany).not.toHaveBeenCalled();
    expect(harness.operationFindMany).not.toHaveBeenCalled();
    expect(harness.objectUpdateMany).not.toHaveBeenCalled();
    expect(harness.operationUpdateMany).not.toHaveBeenCalled();
    expect(harness.operationCreate).not.toHaveBeenCalled();
    expect(harness.headObjectAt).not.toHaveBeenCalled();
    expect(harness.deleteObjectAt).not.toHaveBeenCalled();
  });

  it('locks Attachment→Object→Operation, rereads, then atomically schedules durable reclaim', async () => {
    const harness = unboundHarness();

    await harness.orchestrator.lockContentPublishBoundary(
      harness.tx as unknown as Prisma.TransactionClient,
      {
        contentId,
        referencedAttachmentIds: [],
        coverAttachmentId: null,
        coverImageKey: null,
      },
    );

    const lockSql = harness.queryRaw.mock.calls.map((call) => call[0].strings.join(' '));
    expect(lockSql[1]).toContain('FROM "attachments"');
    expect(lockSql[2]).toContain('FROM "storage_objects"');
    expect(lockSql[3]).toContain('FROM "storage_object_operations"');
    expect(harness.objectFindMany).toHaveBeenCalledTimes(2);
    expect(harness.operationFindMany).toHaveBeenCalledTimes(3);
    const objectUpdate = harness.objectUpdateMany.mock.calls[0]?.[0];
    expect(objectUpdate?.where).toEqual({
      id: harness.object.id,
      state: 'present_unbound',
      resourceId: null,
      deleteRequestedAt: null,
    });
    expect(objectUpdate?.data).toMatchObject({
      state: 'delete_pending',
      version: { increment: 1 },
    });
    expect(objectUpdate?.data.deleteRequestedAt).toBeInstanceOf(Date);
    const operationUpdate = harness.operationUpdateMany.mock.calls[0]?.[0];
    expect(operationUpdate?.where).toEqual({
      id: harness.operation.id,
      status: 'pending',
      storageObjectId: harness.object.id,
      kind: 'attachment_upload_verify',
    });
    expect(operationUpdate?.data).toMatchObject({
      status: 'dead',
      leaseOwner: null,
      leaseAcquiredAt: null,
      leaseRenewedAt: null,
      leaseExpiresAt: null,
    });
    expect(operationUpdate?.data.completedAt).toBeInstanceOf(Date);
    expect(operationUpdate?.data.deadAt).toBeInstanceOf(Date);
    const orphanCreate = harness.operationCreate.mock.calls[0]?.[0];
    if (!orphanCreate) throw new Error('orphan create was not captured');
    const orphan = orphanCreate.data;
    expect(orphan).toMatchObject({
      eventKey: `storage.orphan-delete:${harness.object.id}`,
      storageObjectId: harness.object.id,
      replayOfId: harness.operation.id,
      kind: 'orphan_delete',
      status: 'pending',
      effectState: 'not_started',
      payloadVersion: 1,
      payload: {},
    });
    expect(orphan.availableAt.getTime()).toBeGreaterThanOrEqual(unboundExpiresAt.getTime());
    expect(harness.prismaTransaction).not.toHaveBeenCalled();
    expect(harness.validateFromObjectAt).not.toHaveBeenCalled();
    expect(harness.headObjectAt).not.toHaveBeenCalled();
    expect(harness.deleteObjectAt).not.toHaveBeenCalled();
    expect(harness.logUpload).not.toHaveBeenCalled();
    expect(harness.logUploadConfirmed).not.toHaveBeenCalled();
    expect(harness.logDelete).not.toHaveBeenCalled();
  });

  it('rejects an unknown locked object state before any cancellation write', async () => {
    const harness = unboundHarness({ state: 'legacy_unverified' });

    await expect(
      harness.orchestrator.lockContentPublishBoundary(
        harness.tx as unknown as Prisma.TransactionClient,
        {
          contentId,
          referencedAttachmentIds: [],
          coverAttachmentId: null,
          coverImageKey: null,
        },
      ),
    ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING));

    expect(harness.objectFindMany).toHaveBeenCalledTimes(2);
    expect(harness.objectUpdateMany).not.toHaveBeenCalled();
    expect(harness.operationUpdateMany).not.toHaveBeenCalled();
    expect(harness.operationCreate).not.toHaveBeenCalled();
  });
});
