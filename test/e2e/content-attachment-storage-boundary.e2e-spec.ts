import type { INestApplication } from '@nestjs/common';
import { Prisma, Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import appConfig from '../../src/config/app.config';
import { PrismaService } from '../../src/database/prisma.service';
import { AttachmentStorageOrchestrator } from '../../src/modules/attachments/attachment-storage-orchestrator';
import type { ContentUploadConfirmVerified } from '../../src/modules/attachments/attachment-storage.types';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { ContentService } from '../../src/modules/content/content.service';
import { STORAGE_PROVIDER } from '../../src/modules/storage/storage.constants';
import {
  STORAGE_UNBOUND_GRACE_MS,
  STORAGE_OPERATION_PAYLOAD_VERSION,
  StorageConsistencyLeaseLostError,
  storageOwnerlessUploadEventKey,
  storageOwnerUploadEventKey,
} from '../../src/modules/storage/storage-consistency.types';
import type { PinnedStorageProvider } from '../../src/modules/storage/storage.interface';
import { StorageObjectLedgerService } from '../../src/modules/storage/storage-object-ledger.service';
import {
  signUploadToken,
  type UploadTokenClaims,
} from '../../src/modules/storage/upload-token.util';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const LOCK_TIMEOUT_MS = 10_000;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

/**
 * Phase-1 source-only PostgreSQL proof. It deliberately boots two Nest applications so the
 * holder and waiter use independent Prisma pools; the observer queries pg_stat_activity from a
 * spare connection while both transactions are live. This suite is reserved for the serialized
 * PostgreSQL window and must not be folded into unit characterization.
 */
describe('Content attachment publish storage boundary (two real PostgreSQL pools)', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let attachmentsA: AttachmentsService;
  let attachmentsB: AttachmentsService;
  let contentA: ContentService;
  let contentB: ContentService;
  let orchestratorB: AttachmentStorageOrchestrator;
  let ledgerB: StorageObjectLedgerService;
  let providerB: PinnedStorageProvider;
  let encryptionKey: string;
  let contentId: string;
  let uploaderId: string;
  let foreignActorId: string;
  let sequence = 0;

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    attachmentsA = appA.get(AttachmentsService);
    attachmentsB = appB.get(AttachmentsService);
    contentA = appA.get(ContentService);
    contentB = appB.get(ContentService);
    orchestratorB = appB.get(AttachmentStorageOrchestrator);
    ledgerB = appB.get(StorageObjectLedgerService);
    providerB = appB.get<PinnedStorageProvider>(STORAGE_PROVIDER);
    encryptionKey = appB.get<{ storage: { encryptionKey: string } }>(appConfig.KEY).storage
      .encryptionKey;
    if (!encryptionKey) {
      encryptionKey = 'content-storage-boundary-test-key-32-chars';
    }
  });

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close()]);
  });

  beforeEach(async () => {
    await prismaA.storageObjectOperation.deleteMany();
    await prismaA.storageObject.deleteMany();
    await prismaA.auditLog.deleteMany();
    await prismaA.attachment.deleteMany();
    await prismaA.content.deleteMany();
    await prismaA.user.deleteMany();
    const [uploader, foreignActor] = await Promise.all([
      prismaA.user.create({
        data: {
          username: `content-storage-uploader-${++sequence}`,
          passwordHash: '$2a$10$content-storage-boundary',
          role: Role.SUPER_ADMIN,
          status: UserStatus.ACTIVE,
        },
      }),
      prismaA.user.create({
        data: {
          username: `content-storage-foreign-${++sequence}`,
          passwordHash: '$2a$10$content-storage-boundary',
          role: Role.ADMIN,
          status: UserStatus.ACTIVE,
        },
      }),
    ]);
    uploaderId = uploader.id;
    foreignActorId = foreignActor.id;
    const content = await prismaA.content.create({
      data: {
        title: `storage-boundary-${++sequence}`,
        body: 'body',
        contentTypeCode: 'announcement',
        statusCode: 'draft',
        visibilityCode: 'public',
        authorUserId: uploader.id,
      },
    });
    contentId = content.id;
  });

  async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), LOCK_TIMEOUT_MS);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function waitForRelationLockWait(relation: string): Promise<{
    pid: number;
    waitEventType: string | null;
    waitEvent: string | null;
  }> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
      const rows = await prismaA.$queryRaw<
        Array<{
          pid: number;
          waitEventType: string | null;
          waitEvent: string | null;
        }>
      >(Prisma.sql`
        SELECT
          pid,
          wait_event_type AS "waitEventType",
          wait_event AS "waitEvent"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND state = 'active'
          AND wait_event_type = 'Lock'
          AND query LIKE ${`%"${relation}"%`}
        ORDER BY pid
        LIMIT 1
      `);
      const waiter = rows[0];
      if (waiter) return waiter;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for PostgreSQL Lock wait_event on ${relation}`);
  }

  async function lockContentRoot(
    tx: Prisma.TransactionClient,
    id: string = contentId,
  ): Promise<void> {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "contents" WHERE "id" = ${id} FOR UPDATE
    `);
  }

  async function createOwnerIntent(ownerType: 'content-image' | 'content-file' = 'content-image') {
    const key = `attachments/storage-boundary/${++sequence}.png`;
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 600;
    const claims: UploadTokenClaims = {
      key,
      ownerType,
      ownerId: contentId,
      originalName: 'boundary.png',
      mime: 'image/png',
      sizeBytes: 8,
      uploadedByUserId: uploaderId,
      iat,
      exp,
    };
    const identity = {
      key: claims.key,
      ownerType,
      ownerId: claims.ownerId,
      originalName: claims.originalName,
      mime: claims.mime,
      size: claims.sizeBytes,
      uploadedByUserId: claims.uploadedByUserId,
      iat: claims.iat,
      exp: claims.exp,
    } as const;
    const requestHash = orchestratorB.uploadRequestHash(identity, 'attachment_signed_upload');
    const unboundExpiresAt = new Date(exp * 1000 + STORAGE_UNBOUND_GRACE_MS);
    const object = await prismaA.storageObject.create({
      data: {
        key,
        state: 'present_unbound',
        source: 'attachment_signed_upload',
        providerType: 'COS',
        bucket: 'content-storage-boundary',
        region: 'ap-test',
        expectedSize: BigInt(identity.size),
        actualSize: BigInt(identity.size),
        expectedMime: identity.mime,
        actualMime: identity.mime,
        presentAt: new Date(),
        unboundExpiresAt,
      },
    });
    const operation = await prismaA.storageObjectOperation.create({
      data: {
        eventKey: storageOwnerUploadEventKey(ownerType, contentId, requestHash),
        storageObjectId: object.id,
        kind: 'attachment_upload_verify',
        status: 'pending',
        effectState: 'provider_present',
        payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
        payload: { source: 'attachment_signed_upload' },
        requestHash,
      },
    });
    return {
      identity,
      uploadToken: token(claims),
      requestHash,
      unboundExpiresAt,
      object,
      operation,
    };
  }

  function actor(id: string): CurrentUserPayload {
    return {
      id,
      username: `actor-${id}`,
      role: id === uploaderId ? Role.SUPER_ADMIN : Role.ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
  }

  function token(claims: UploadTokenClaims): string {
    return signUploadToken(claims, encryptionKey);
  }

  function mockPresentUploadEvidence(size: number) {
    const head = jest.spyOn(providerB, 'headObjectAt').mockResolvedValue({
      exists: true,
      size,
      contentType: 'image/png',
      etag: `etag-${sequence}`,
    });
    const prefix = jest
      .spyOn(providerB, 'readObjectPrefixAt')
      .mockResolvedValue(Buffer.from('89504e470d0a1a0a', 'hex'));
    return {
      head,
      prefix,
      restore() {
        head.mockRestore();
        prefix.mockRestore();
      },
    };
  }

  async function guardAndPrepareOwnerIntent(intent: Awaited<ReturnType<typeof createOwnerIntent>>) {
    const guarded = await attachmentsB.guardContentUploadConfirm(
      { uploadToken: intent.uploadToken },
      actor(uploaderId),
      { ownerType: intent.identity.ownerType, ownerId: contentId },
    );
    const prepared = await prismaB.$transaction(async (tx) => {
      await lockContentRoot(tx);
      return attachmentsB.prepareContentUploadConfirmInTransactionTrusted(tx, guarded);
    });
    return { guarded, prepared };
  }

  async function captureConfirm(uploadToken: string, currentActorId: string): Promise<unknown> {
    try {
      return await attachmentsB.confirmUpload({ uploadToken }, actor(currentActorId), {
        requestId: `content-storage-${++sequence}`,
        ip: null,
        ua: null,
      });
    } catch (error) {
      return error;
    }
  }

  it('boots two Nest apps with distinct Prisma pools', async () => {
    expect(prismaA).not.toBe(prismaB);
    const [backendA, backendB] = await Promise.all([
      prismaA.$queryRaw<Array<{ pid: number }>>(Prisma.sql`SELECT pg_backend_pid() AS pid`),
      prismaB.$queryRaw<Array<{ pid: number }>>(Prisma.sql`SELECT pg_backend_pid() AS pid`),
    ]);
    expect(backendA[0]?.pid).toEqual(expect.any(Number));
    expect(backendB[0]?.pid).toEqual(expect.any(Number));
    expect(backendA[0]?.pid).not.toBe(backendB[0]?.pid);
  });

  it('same-service guarded replay is 13001 with zero extra ledger/Provider/audit mutation', async () => {
    const intent = await createOwnerIntent('content-file');
    const head = jest.spyOn(providerB, 'headObjectAt');
    const prefix = jest.spyOn(providerB, 'readObjectPrefixAt');
    try {
      const guarded = await attachmentsB.guardContentUploadConfirm(
        { uploadToken: intent.uploadToken },
        actor(uploaderId),
        { ownerType: 'content-file', ownerId: contentId },
      );
      await prismaB.$transaction(async (tx) => {
        await lockContentRoot(tx);
        await attachmentsB.prepareContentUploadConfirmInTransactionTrusted(tx, guarded);
      });
      const before = await Promise.all([
        prismaA.storageObject.findUnique({ where: { id: intent.object.id } }),
        prismaA.storageObjectOperation.findUnique({ where: { id: intent.operation.id } }),
        prismaA.attachment.count({ where: { key: intent.identity.key } }),
        prismaA.auditLog.count(),
      ]);

      await expect(
        prismaB.$transaction(async (tx) => {
          await lockContentRoot(tx);
          return attachmentsB.prepareContentUploadConfirmInTransactionTrusted(tx, guarded);
        }),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));

      await expect(
        Promise.all([
          prismaA.storageObject.findUnique({ where: { id: intent.object.id } }),
          prismaA.storageObjectOperation.findUnique({ where: { id: intent.operation.id } }),
          prismaA.attachment.count({ where: { key: intent.identity.key } }),
          prismaA.auditLog.count(),
        ]),
      ).resolves.toEqual(before);
      expect(head).not.toHaveBeenCalled();
      expect(prefix).not.toHaveBeenCalled();
    } finally {
      head.mockRestore();
      prefix.mockRestore();
    }
  });

  it.each(['content-image', 'content-file'] as const)(
    '%s foreign uploader and revoked coarse RBAC stop before a held Content root',
    async (ownerType) => {
      const now = Math.floor(Date.now() / 1000);
      const claims: UploadTokenClaims = {
        key: `attachments/storage-boundary/foreign-${++sequence}.png`,
        ownerType,
        ownerId: contentId,
        originalName: 'foreign.png',
        mime: 'image/png',
        sizeBytes: 7,
        uploadedByUserId: uploaderId,
        iat: now,
        exp: now + 600,
      };
      const expired = token({ ...claims, iat: now - 20, exp: now - 10 });
      const coarseDenied = token({ ...claims, uploadedByUserId: foreignActorId });
      const prepareSpy = jest.spyOn(orchestratorB, 'prepareUploadInTransaction');
      const verifySpy = jest.spyOn(orchestratorB, 'verifyUploadEvidence');
      const finalizeSpy = jest.spyOn(orchestratorB, 'finalizeUpload');
      const finalizeTxSpy = jest.spyOn(orchestratorB, 'finalizeUploadInTransaction');
      const headSpy = jest.spyOn(providerB, 'headObjectAt');
      const holderReady = deferred();
      const holderRelease = deferred();
      const holder = prismaA.$transaction(async (tx) => {
        await lockContentRoot(tx);
        holderReady.resolve();
        await holderRelease.promise;
      });
      await holderReady.promise;

      const operationCountBefore = await prismaA.storageObjectOperation.count();
      const auditCountBefore = await prismaA.auditLog.count();
      try {
        const [invalidError, expiredError, foreignError, coarseDeniedError] = await withTimeout(
          Promise.all([
            captureConfirm('invalid-upload-token', foreignActorId),
            captureConfirm(expired, foreignActorId),
            captureConfirm(token(claims), foreignActorId),
            captureConfirm(coarseDenied, foreignActorId),
          ]),
          'content token early guards while Content root is held',
        );
        for (const error of [invalidError, expiredError, foreignError, coarseDeniedError]) {
          expect(error).toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
          expect((error as BizException).biz).toMatchObject({
            code: 13001,
            message: '附件不存在',
            httpStatus: 404,
          });
        }
        // Mutation killed: restoring foreign content uploaders to 30100 fails the exact contract;
        // moving any guard after Content FOR UPDATE times out while the holder remains unreleased.
        expect(prepareSpy).not.toHaveBeenCalled();
        expect(verifySpy).not.toHaveBeenCalled();
        expect(finalizeSpy).not.toHaveBeenCalled();
        expect(finalizeTxSpy).not.toHaveBeenCalled();
        expect(headSpy).not.toHaveBeenCalled();
        await expect(prismaA.storageObjectOperation.count()).resolves.toBe(operationCountBefore);
        await expect(prismaA.auditLog.count()).resolves.toBe(auditCountBefore);
      } finally {
        holderRelease.resolve();
        await withTimeout(holder, 'Content root holder');
        prepareSpy.mockRestore();
        verifySpy.mockRestore();
        finalizeSpy.mockRestore();
        finalizeTxSpy.mockRestore();
        headSpy.mockRestore();
      }
    },
  );

  it('route owner A/token owner B fails in the public seam before Content/ledger/Provider', async () => {
    const tokenOwner = await prismaA.content.create({
      data: {
        title: `storage-boundary-token-owner-${++sequence}`,
        body: 'body',
        contentTypeCode: 'announcement',
        statusCode: 'draft',
        visibilityCode: 'public',
        authorUserId: uploaderId,
      },
    });
    const now = Math.floor(Date.now() / 1000);
    const claims: UploadTokenClaims = {
      key: `attachments/storage-boundary/route-mismatch-${++sequence}.png`,
      ownerType: 'content-image',
      ownerId: tokenOwner.id,
      originalName: 'route-mismatch.png',
      mime: 'image/png',
      sizeBytes: 8,
      uploadedByUserId: uploaderId,
      iat: now,
      exp: now + 600,
    };
    const prepareSpy = jest.spyOn(orchestratorB, 'prepareUploadInTransaction');
    const verifySpy = jest.spyOn(orchestratorB, 'verifyUploadEvidence');
    const headSpy = jest.spyOn(providerB, 'headObjectAt');
    const holderReady = deferred();
    const holderRelease = deferred();
    const holder = prismaA.$transaction(async (tx) => {
      await lockContentRoot(tx);
      holderReady.resolve();
      await holderRelease.promise;
    });
    await holderReady.promise;
    const operationCountBefore = await prismaA.storageObjectOperation.count();
    const auditCountBefore = await prismaA.auditLog.count();

    try {
      await expect(
        withTimeout(
          contentB.confirmAttachmentUpload(
            contentId,
            { uploadToken: token(claims) },
            actor(uploaderId),
            { requestId: `content-route-mismatch-${++sequence}`, ip: null, ua: null },
          ),
          'route/token owner early guard',
        ),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
      expect(prepareSpy).not.toHaveBeenCalled();
      expect(verifySpy).not.toHaveBeenCalled();
      expect(headSpy).not.toHaveBeenCalled();
      await expect(prismaA.storageObjectOperation.count()).resolves.toBe(operationCountBefore);
      await expect(prismaA.auditLog.count()).resolves.toBe(auditCountBefore);
    } finally {
      holderRelease.resolve();
      await withTimeout(holder, 'route owner Content holder');
      prepareSpy.mockRestore();
      verifySpy.mockRestore();
      headSpy.mockRestore();
    }
  });

  it('parent rollback rolls back upload cancellation and orphan creation (no second tx)', async () => {
    const intent = await createOwnerIntent('content-file');

    await expect(
      prismaB.$transaction(async (tx) => {
        await lockContentRoot(tx);
        await attachmentsB.lockContentPublishStorageBoundaryTrusted(tx, {
          contentId,
          referencedAttachmentIds: [],
          coverAttachmentId: null,
          coverImageKey: null,
        });
        throw new Error('ROLLBACK_CONTENT_PUBLISH_BOUNDARY');
      }),
    ).rejects.toThrow('ROLLBACK_CONTENT_PUBLISH_BOUNDARY');

    await expect(
      prismaA.storageObject.findUnique({ where: { id: intent.object.id } }),
    ).resolves.toMatchObject({
      state: 'present_unbound',
      deleteRequestedAt: null,
      unboundExpiresAt: intent.unboundExpiresAt,
    });
    await expect(
      prismaA.storageObjectOperation.findUnique({ where: { id: intent.operation.id } }),
    ).resolves.toMatchObject({ status: 'pending', deadAt: null, completedAt: null });
    await expect(
      prismaA.storageObjectOperation.count({
        where: { storageObjectId: intent.object.id, kind: 'orphan_delete' },
      }),
    ).resolves.toBe(0);
  });

  it('caller-owned finalization rollback consumes verified handle and leaves no independent commit', async () => {
    const intent = await createOwnerIntent('content-image');
    const evidence = mockPresentUploadEvidence(intent.identity.size);
    try {
      const { prepared } = await guardAndPrepareOwnerIntent(intent);
      const verified =
        await attachmentsB.verifyContentUploadConfirmEvidenceOutsideTransaction(prepared);

      await expect(
        prismaB.$transaction(async (tx) => {
          await lockContentRoot(tx);
          await attachmentsB.finalizeContentUploadConfirmInTransactionTrusted(tx, verified, {
            requestId: `content-confirm-rollback-${++sequence}`,
            ip: null,
            ua: null,
          });
          throw new Error('ROLLBACK_CONTENT_CONFIRM_FINALIZATION');
        }),
      ).rejects.toThrow('ROLLBACK_CONTENT_CONFIRM_FINALIZATION');

      const beforeReplay = await Promise.all([
        prismaA.storageObject.findUnique({ where: { id: intent.object.id } }),
        prismaA.storageObjectOperation.findUnique({ where: { id: intent.operation.id } }),
        prismaA.attachment.count({ where: { key: intent.identity.key } }),
        prismaA.auditLog.count(),
      ]);
      const headCalls = evidence.head.mock.calls.length;
      const prefixCalls = evidence.prefix.mock.calls.length;

      await expect(
        prismaB.$transaction(async (tx) => {
          await lockContentRoot(tx);
          return attachmentsB.finalizeContentUploadConfirmInTransactionTrusted(tx, verified, {
            requestId: `content-confirm-rollback-replay-${++sequence}`,
            ip: null,
            ua: null,
          });
        }),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));

      await expect(
        Promise.all([
          prismaA.storageObject.findUnique({ where: { id: intent.object.id } }),
          prismaA.storageObjectOperation.findUnique({ where: { id: intent.operation.id } }),
          prismaA.attachment.count({ where: { key: intent.identity.key } }),
          prismaA.auditLog.count(),
        ]),
      ).resolves.toEqual(beforeReplay);
      expect(evidence.head).toHaveBeenCalledTimes(headCalls);
      expect(evidence.prefix).toHaveBeenCalledTimes(prefixCalls);
    } finally {
      evidence.restore();
    }

    await expect(
      prismaA.attachment.findUnique({ where: { key: intent.identity.key } }),
    ).resolves.toBeNull();
    await expect(
      prismaA.storageObject.findUnique({ where: { id: intent.object.id } }),
    ).resolves.toMatchObject({
      state: 'present_unbound',
      resourceType: null,
      resourceId: null,
      deleteRequestedAt: null,
    });
    await expect(
      prismaA.storageObjectOperation.findUnique({ where: { id: intent.operation.id } }),
    ).resolves.toMatchObject({
      status: 'pending',
      effectState: 'provider_present',
      completedAt: null,
      deadAt: null,
    });
    await expect(prismaA.auditLog.count()).resolves.toBe(0);
  });

  it('committed finalization consumes verified handle before any replay can mutate state', async () => {
    const intent = await createOwnerIntent('content-image');
    const evidence = mockPresentUploadEvidence(intent.identity.size);
    try {
      const { prepared } = await guardAndPrepareOwnerIntent(intent);
      const verified: ContentUploadConfirmVerified =
        await attachmentsB.verifyContentUploadConfirmEvidenceOutsideTransaction(prepared);
      await prismaB.$transaction(async (tx) => {
        await lockContentRoot(tx);
        await attachmentsB.finalizeContentUploadConfirmInTransactionTrusted(tx, verified, {
          requestId: `content-confirm-commit-${++sequence}`,
          ip: null,
          ua: null,
        });
      });
      const beforeReplay = await Promise.all([
        prismaA.storageObject.findUnique({ where: { id: intent.object.id } }),
        prismaA.storageObjectOperation.findUnique({ where: { id: intent.operation.id } }),
        prismaA.attachment.count({ where: { key: intent.identity.key } }),
        prismaA.auditLog.count(),
      ]);
      const headCalls = evidence.head.mock.calls.length;
      const prefixCalls = evidence.prefix.mock.calls.length;

      await expect(
        prismaB.$transaction(async (tx) => {
          await lockContentRoot(tx);
          return attachmentsB.finalizeContentUploadConfirmInTransactionTrusted(tx, verified, {
            requestId: `content-confirm-commit-replay-${++sequence}`,
            ip: null,
            ua: null,
          });
        }),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));

      await expect(
        Promise.all([
          prismaA.storageObject.findUnique({ where: { id: intent.object.id } }),
          prismaA.storageObjectOperation.findUnique({ where: { id: intent.operation.id } }),
          prismaA.attachment.count({ where: { key: intent.identity.key } }),
          prismaA.auditLog.count(),
        ]),
      ).resolves.toEqual(beforeReplay);
      expect(evidence.head).toHaveBeenCalledTimes(headCalls);
      expect(evidence.prefix).toHaveBeenCalledTimes(prefixCalls);
    } finally {
      evidence.restore();
    }
  });

  it('publish wins: confirm waits on Content then rereads 29030 with only durable reclaim committed', async () => {
    const intent = await createOwnerIntent('content-file');
    const evidence = mockPresentUploadEvidence(intent.identity.size);
    try {
      const { prepared } = await guardAndPrepareOwnerIntent(intent);
      const verified =
        await attachmentsB.verifyContentUploadConfirmEvidenceOutsideTransaction(prepared);
      const publishReady = deferred();
      const publishRelease = deferred();
      const publishing = prismaA.$transaction(async (tx) => {
        await lockContentRoot(tx);
        await attachmentsA.lockContentPublishStorageBoundaryTrusted(tx, {
          contentId,
          referencedAttachmentIds: [],
          coverAttachmentId: null,
          coverImageKey: null,
        });
        await tx.content.update({
          where: { id: contentId },
          data: { statusCode: 'published', publishedAt: new Date() },
        });
        publishReady.resolve();
        await publishRelease.promise;
      });
      await publishReady.promise;
      const confirming = prismaB
        .$transaction(async (tx) => {
          await lockContentRoot(tx);
          return attachmentsB.finalizeContentUploadConfirmInTransactionTrusted(tx, verified, {
            requestId: `publish-wins-confirm-${++sequence}`,
            ip: null,
            ua: null,
          });
        })
        .catch((error: unknown) => error);

      try {
        await waitForRelationLockWait('contents');
      } finally {
        publishRelease.resolve();
        await withTimeout(publishing, 'publish-wins holder');
      }
      await expect(withTimeout(confirming, 'publish-wins confirm waiter')).resolves.toEqual(
        new BizException(BizCode.CONTENT_INVALID_STATUS_TRANSITION),
      );
    } finally {
      evidence.restore();
    }

    await expect(prismaA.content.findUnique({ where: { id: contentId } })).resolves.toMatchObject({
      statusCode: 'published',
      publishedAt: expect.any(Date),
    });
    await expect(
      prismaA.attachment.findUnique({ where: { key: intent.identity.key } }),
    ).resolves.toBeNull();
    await expect(
      prismaA.storageObject.findUnique({ where: { id: intent.object.id } }),
    ).resolves.toMatchObject({ state: 'delete_pending', resourceId: null });
    await expect(
      prismaA.storageObjectOperation.findUnique({ where: { id: intent.operation.id } }),
    ).resolves.toMatchObject({ status: 'dead' });
    await expect(
      prismaA.storageObjectOperation.count({
        where: { storageObjectId: intent.object.id, kind: 'orphan_delete', status: 'pending' },
      }),
    ).resolves.toBe(1);
    await expect(prismaA.auditLog.count()).resolves.toBe(0);
  });

  it('confirm wins: publish waits, then sees the single available binding and commits no orphan', async () => {
    const intent = await createOwnerIntent('content-image');
    const evidence = mockPresentUploadEvidence(intent.identity.size);
    try {
      const { prepared } = await guardAndPrepareOwnerIntent(intent);
      const verified =
        await attachmentsB.verifyContentUploadConfirmEvidenceOutsideTransaction(prepared);
      const confirmReady = deferred();
      const confirmRelease = deferred();
      const confirming = prismaB.$transaction(async (tx) => {
        await lockContentRoot(tx);
        const finalized = await attachmentsB.finalizeContentUploadConfirmInTransactionTrusted(
          tx,
          verified,
          {
            requestId: `confirm-wins-${++sequence}`,
            ip: null,
            ua: null,
          },
        );
        confirmReady.resolve();
        await confirmRelease.promise;
        return finalized;
      });
      await confirmReady.promise;
      const publishing = prismaA.$transaction(async (tx) => {
        await lockContentRoot(tx);
        await attachmentsA.lockContentPublishStorageBoundaryTrusted(tx, {
          contentId,
          referencedAttachmentIds: [],
          coverAttachmentId: null,
          coverImageKey: null,
        });
        await tx.content.update({
          where: { id: contentId },
          data: { statusCode: 'published', publishedAt: new Date() },
        });
      });

      try {
        await waitForRelationLockWait('contents');
      } finally {
        confirmRelease.resolve();
        await withTimeout(confirming, 'confirm-wins holder');
      }
      await withTimeout(publishing, 'confirm-wins publish waiter');
    } finally {
      evidence.restore();
    }

    const attachment = await prismaA.attachment.findUnique({ where: { key: intent.identity.key } });
    if (!attachment) throw new Error('confirm-wins Attachment missing');
    expect(attachment).toMatchObject({
      ownerType: intent.identity.ownerType,
      ownerId: contentId,
      uploadedBy: uploaderId,
    });
    await expect(
      prismaA.storageObject.findUnique({ where: { id: intent.object.id } }),
    ).resolves.toMatchObject({
      state: 'available',
      resourceType: 'attachment',
      resourceId: attachment.id,
    });
    await expect(
      prismaA.storageObjectOperation.findUnique({ where: { id: intent.operation.id } }),
    ).resolves.toMatchObject({ status: 'succeeded', effectState: 'provider_present' });
    await expect(
      prismaA.storageObjectOperation.count({
        where: { storageObjectId: intent.object.id, kind: 'orphan_delete' },
      }),
    ).resolves.toBe(0);
    await expect(prismaA.attachment.count({ where: { key: intent.identity.key } })).resolves.toBe(
      1,
    );
    await expect(prismaA.auditLog.count()).resolves.toBe(1);
    await expect(prismaA.content.findUnique({ where: { id: contentId } })).resolves.toMatchObject({
      statusCode: 'published',
      publishedAt: expect.any(Date),
    });
  });

  it('live Content publish fails closed on an Attachment with no ledger and writes no state/audit', async () => {
    const unsafe = await prismaA.attachment.create({
      data: {
        key: `attachments/storage-boundary/unsafe-${++sequence}.png`,
        originalName: 'unsafe.png',
        mime: 'image/png',
        size: 8,
        uploadedBy: uploaderId,
        ownerType: 'content-image',
        ownerId: contentId,
        tags: [],
      },
    });
    await prismaA.content.update({
      where: { id: contentId },
      data: { body: `![unsafe](attachment:${unsafe.id})` },
    });

    await expect(
      contentA.publish(contentId, actor(uploaderId), {
        requestId: `content-live-publish-unsafe-${++sequence}`,
        ip: null,
        ua: null,
      }),
    ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING));

    await expect(prismaA.content.findUnique({ where: { id: contentId } })).resolves.toMatchObject({
      statusCode: 'draft',
      publishedAt: null,
    });
    await expect(prismaA.auditLog.count()).resolves.toBe(0);
    await expect(
      prismaA.attachment.findUnique({ where: { id: unsafe.id } }),
    ).resolves.toMatchObject({
      id: unsafe.id,
      key: unsafe.key,
    });
  });

  it('live publish wins while confirm is between txs: final reread returns 29030', async () => {
    const intent = await createOwnerIntent('content-file');
    const headStarted = deferred();
    const headRelease = deferred();
    const head = jest.spyOn(providerB, 'headObjectAt').mockImplementation(async () => {
      headStarted.resolve();
      await headRelease.promise;
      return {
        exists: true,
        size: intent.identity.size,
        contentType: intent.identity.mime,
        etag: `etag-live-publish-wins-${sequence}`,
      };
    });
    const prefix = jest
      .spyOn(providerB, 'readObjectPrefixAt')
      .mockResolvedValue(Buffer.from('89504e470d0a1a0a', 'hex'));
    const confirming = contentB
      .confirmAttachmentUpload(contentId, { uploadToken: intent.uploadToken }, actor(uploaderId), {
        requestId: `content-live-confirm-${++sequence}`,
        ip: null,
        ua: null,
      })
      .catch((error: unknown) => error);

    try {
      await withTimeout(headStarted.promise, 'live confirm Provider evidence start');
      await contentA.publish(contentId, actor(uploaderId), {
        requestId: `content-live-publish-${++sequence}`,
        ip: null,
        ua: null,
      });
      headRelease.resolve();
      await expect(
        withTimeout(confirming, 'live publish-wins confirm finalization'),
      ).resolves.toEqual(new BizException(BizCode.CONTENT_INVALID_STATUS_TRANSITION));
      await expect(prismaA.content.findUnique({ where: { id: contentId } })).resolves.toMatchObject(
        {
          statusCode: 'published',
          publishedAt: expect.any(Date),
        },
      );
      await expect(
        prismaA.attachment.findUnique({ where: { key: intent.identity.key } }),
      ).resolves.toBeNull();
      await expect(
        prismaA.storageObject.findUnique({ where: { id: intent.object.id } }),
      ).resolves.toMatchObject({ state: 'delete_pending', resourceId: null });
      await expect(
        prismaA.storageObjectOperation.findUnique({ where: { id: intent.operation.id } }),
      ).resolves.toMatchObject({ status: 'dead' });
      await expect(
        prismaA.storageObjectOperation.count({
          where: { storageObjectId: intent.object.id, kind: 'orphan_delete', status: 'pending' },
        }),
      ).resolves.toBe(1);
      await expect(prismaA.auditLog.count()).resolves.toBe(1);
    } finally {
      headRelease.resolve();
      await withTimeout(confirming, 'live publish-wins confirm cleanup').catch(() => undefined);
      head.mockRestore();
      prefix.mockRestore();
    }
  });

  it('generic Attachment confirm cannot bypass the Content publish-wins final fence', async () => {
    const intent = await createOwnerIntent('content-image');
    const typeConfig = await prismaA.attachmentTypeConfig.create({
      data: {
        code: 'content-image',
        displayName: 'Content image',
        ownerTable: 'contents',
        defaultMimeWhitelist: ['image/png'],
        defaultMaxSizeBytes: null,
      },
    });
    const headStarted = deferred();
    const headRelease = deferred();
    const head = jest.spyOn(providerB, 'headObjectAt').mockImplementation(async () => {
      headStarted.resolve();
      await headRelease.promise;
      return {
        exists: true,
        size: intent.identity.size,
        contentType: intent.identity.mime,
        etag: `etag-generic-publish-wins-${sequence}`,
      };
    });
    const prefix = jest
      .spyOn(providerB, 'readObjectPrefixAt')
      .mockResolvedValue(Buffer.from('89504e470d0a1a0a', 'hex'));
    const confirming = attachmentsB
      .confirmUpload({ uploadToken: intent.uploadToken }, actor(uploaderId), {
        requestId: `generic-content-confirm-${++sequence}`,
        ip: null,
        ua: null,
      })
      .catch((error: unknown) => error);

    try {
      await withTimeout(headStarted.promise, 'generic content confirm Provider evidence start');
      await contentA.publish(contentId, actor(uploaderId), {
        requestId: `generic-content-publish-${++sequence}`,
        ip: null,
        ua: null,
      });
      headRelease.resolve();
      await expect(
        withTimeout(confirming, 'generic content confirm finalization'),
      ).resolves.toEqual(new BizException(BizCode.CONTENT_INVALID_STATUS_TRANSITION));
      await expect(
        prismaA.attachment.findUnique({ where: { key: intent.identity.key } }),
      ).resolves.toBeNull();
      await expect(
        prismaA.storageObject.findUnique({ where: { id: intent.object.id } }),
      ).resolves.toMatchObject({ state: 'delete_pending', resourceId: null });
      await expect(
        prismaA.storageObjectOperation.findUnique({ where: { id: intent.operation.id } }),
      ).resolves.toMatchObject({ status: 'dead' });
      await expect(prismaA.auditLog.count()).resolves.toBe(1);
    } finally {
      headRelease.resolve();
      await withTimeout(confirming, 'generic content confirm cleanup').catch(() => undefined);
      head.mockRestore();
      prefix.mockRestore();
      await prismaA.attachmentTypeConfig.delete({ where: { id: typeConfig.id } });
    }
  });

  it('live confirm wins: publish blocks on Content root and then accepts the available binding', async () => {
    const intent = await createOwnerIntent('content-image');
    const evidence = mockPresentUploadEvidence(intent.identity.size);
    const finalizeReady = deferred();
    const finalizeRelease = deferred();
    const realFinalize =
      attachmentsB.finalizeContentUploadConfirmInTransactionTrusted.bind(attachmentsB);
    const finalize = jest
      .spyOn(attachmentsB, 'finalizeContentUploadConfirmInTransactionTrusted')
      .mockImplementation(async (tx, context, auditMeta) => {
        const result = await realFinalize(tx, context, auditMeta);
        finalizeReady.resolve();
        await finalizeRelease.promise;
        return result;
      });
    const confirming = contentB.confirmAttachmentUpload(
      contentId,
      { uploadToken: intent.uploadToken },
      actor(uploaderId),
      { requestId: `content-live-confirm-wins-${++sequence}`, ip: null, ua: null },
    );
    let publishing: Promise<unknown> | undefined;

    try {
      await withTimeout(finalizeReady.promise, 'live confirm final transaction ready');
      publishing = contentA.publish(contentId, actor(uploaderId), {
        requestId: `content-live-publish-waits-${++sequence}`,
        ip: null,
        ua: null,
      });
      try {
        const waiter = await waitForRelationLockWait('contents');
        expect(waiter.waitEventType).toBe('Lock');
      } finally {
        finalizeRelease.resolve();
      }
      await withTimeout(confirming, 'live confirm-wins response');
      await withTimeout(publishing, 'live publish waiter');
    } finally {
      finalizeRelease.resolve();
      await withTimeout(confirming, 'live confirm-wins cleanup').catch(() => undefined);
      if (publishing) {
        await withTimeout(publishing, 'live publish waiter cleanup').catch(() => undefined);
      }
      finalize.mockRestore();
      evidence.restore();
    }

    const attachment = await prismaA.attachment.findUnique({ where: { key: intent.identity.key } });
    if (!attachment) throw new Error('live confirm-wins Attachment missing');
    await expect(
      prismaA.storageObject.findUnique({ where: { id: intent.object.id } }),
    ).resolves.toMatchObject({
      state: 'available',
      resourceType: 'attachment',
      resourceId: attachment.id,
    });
    await expect(
      prismaA.storageObjectOperation.count({
        where: { storageObjectId: intent.object.id, kind: 'orphan_delete' },
      }),
    ).resolves.toBe(0);
    await expect(prismaA.content.findUnique({ where: { id: contentId } })).resolves.toMatchObject({
      statusCode: 'published',
      publishedAt: expect.any(Date),
    });
    await expect(prismaA.auditLog.count()).resolves.toBe(2);
  });

  it('waits on a real Object lock and rejects the state committed while waiting', async () => {
    const intent = await createOwnerIntent();
    const holderReady = deferred();
    const holderRelease = deferred();
    const holder = prismaA.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "storage_objects" WHERE "id" = ${intent.object.id} FOR UPDATE
      `);
      await tx.storageObject.update({
        where: { id: intent.object.id },
        data: { state: 'legacy_unverified' },
      });
      holderReady.resolve();
      await holderRelease.promise;
    });
    await holderReady.promise;
    const publishing = prismaB
      .$transaction(async (tx) => {
        await lockContentRoot(tx);
        await attachmentsB.lockContentPublishStorageBoundaryTrusted(tx, {
          contentId,
          referencedAttachmentIds: [],
          coverAttachmentId: null,
          coverImageKey: null,
        });
      })
      .catch((error: unknown) => error);

    try {
      const waiter = await waitForRelationLockWait('storage_objects');
      expect(waiter.waitEventType).toBe('Lock');
      expect(waiter.waitEvent).toEqual(expect.any(String));
      // Mutation killed: omitting FOR UPDATE never produces this observer-visible waiter.
    } finally {
      holderRelease.resolve();
      await withTimeout(holder, 'Object state drift holder');
    }
    await expect(withTimeout(publishing, 'publish boundary locked reread')).resolves.toEqual(
      new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING),
    );
    // Mutation killed: trusting the pre-lock candidate would cancel this now-unknown object.
    await expect(
      prismaA.storageObject.findUnique({ where: { id: intent.object.id } }),
    ).resolves.toMatchObject({ state: 'legacy_unverified', deleteRequestedAt: null });
    await expect(
      prismaA.storageObjectOperation.findUnique({ where: { id: intent.operation.id } }),
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('publish cancellation fences a stale claimed upload worker from resurrecting the intent', async () => {
    const intent = await createOwnerIntent('content-file');
    const claimed = await ledgerB.claim(`content-stale-upload-worker-${++sequence}`, {
      eventKey: intent.operation.eventKey,
      limit: 1,
    });
    expect(claimed).toHaveLength(1);
    const workerSnapshot = claimed[0];
    if (!workerSnapshot) throw new Error('upload worker claim missing');

    await prismaA.$transaction(async (tx) => {
      await lockContentRoot(tx);
      await attachmentsA.lockContentPublishStorageBoundaryTrusted(tx, {
        contentId,
        referencedAttachmentIds: [],
        coverAttachmentId: null,
        coverImageKey: null,
      });
    });

    await expect(
      ledgerB.recordPresentUnboundClaimed(workerSnapshot, {
        exists: true,
        size: intent.identity.size,
        contentType: intent.identity.mime,
      }),
    ).rejects.toBeInstanceOf(StorageConsistencyLeaseLostError);
    await expect(
      prismaA.storageObject.findUnique({ where: { id: intent.object.id } }),
    ).resolves.toMatchObject({ state: 'delete_pending', resourceId: null });
    await expect(
      prismaA.storageObjectOperation.findUnique({ where: { id: intent.operation.id } }),
    ).resolves.toMatchObject({
      status: 'dead',
      leaseOwner: null,
      leaseAcquiredAt: null,
      leaseExpiresAt: null,
    });
    await expect(
      prismaA.storageObjectOperation.count({
        where: { storageObjectId: intent.object.id, kind: 'orphan_delete', status: 'pending' },
      }),
    ).resolves.toBe(1);
  });

  it('ownerless confirmable intent fails closed and is never attributed to this Content', async () => {
    const now = Math.floor(Date.now() / 1000);
    const claims: UploadTokenClaims = {
      key: `attachments/storage-boundary/ownerless-${++sequence}.png`,
      ownerType: 'content-image',
      ownerId: contentId,
      originalName: 'ownerless.png',
      mime: 'image/png',
      sizeBytes: 8,
      uploadedByUserId: uploaderId,
      iat: now,
      exp: now + 600,
    };
    const identity = {
      key: claims.key,
      ownerType: claims.ownerType,
      ownerId: claims.ownerId,
      originalName: claims.originalName,
      mime: claims.mime,
      size: claims.sizeBytes,
      uploadedByUserId: claims.uploadedByUserId,
      iat: claims.iat,
      exp: claims.exp,
    } as const;
    const uploadToken = token(claims);
    const requestHash = orchestratorB.uploadRequestHash(identity, 'attachment_signed_upload');
    const unboundExpiresAt = new Date(claims.exp * 1000 + STORAGE_UNBOUND_GRACE_MS);
    const object = await prismaA.storageObject.create({
      data: {
        key: identity.key,
        state: 'pending_upload',
        source: 'attachment_signed_upload',
        providerType: 'COS',
        bucket: 'content-storage-boundary',
        region: 'ap-test',
        expectedSize: BigInt(identity.size),
        expectedMime: identity.mime,
        unboundExpiresAt,
      },
    });
    const operation = await prismaA.storageObjectOperation.create({
      data: {
        eventKey: storageOwnerlessUploadEventKey(requestHash),
        storageObjectId: object.id,
        kind: 'attachment_upload_verify',
        status: 'pending',
        effectState: 'not_started',
        payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
        payload: { source: 'attachment_signed_upload' },
        requestHash,
      },
    });

    // This is a real signed token with the exact production identity hash. The dual-read prepare
    // may replay it, but it must not upgrade/attribute the legacy ownerless event.
    const guarded = await attachmentsB.guardContentUploadConfirm(
      { uploadToken },
      actor(uploaderId),
      { ownerType: 'content-image', ownerId: contentId },
    );
    await prismaB.$transaction(async (tx) => {
      await lockContentRoot(tx);
      await attachmentsB.prepareContentUploadConfirmInTransactionTrusted(tx, guarded);
    });

    await expect(
      prismaB.$transaction(async (tx) => {
        await lockContentRoot(tx);
        await attachmentsB.lockContentPublishStorageBoundaryTrusted(tx, {
          contentId,
          referencedAttachmentIds: [],
          coverAttachmentId: null,
          coverImageKey: null,
        });
      }),
    ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING));

    await expect(
      prismaA.storageObject.findUnique({ where: { id: object.id } }),
    ).resolves.toMatchObject({
      state: 'pending_upload',
      resourceId: null,
      unboundExpiresAt,
    });
    await expect(
      prismaA.storageObjectOperation.findUnique({ where: { id: operation.id } }),
    ).resolves.toMatchObject({
      eventKey: storageOwnerlessUploadEventKey(requestHash),
      requestHash,
      status: 'pending',
    });
    await expect(
      prismaA.storageObjectOperation.count({
        where: { storageObjectId: object.id, kind: 'orphan_delete' },
      }),
    ).resolves.toBe(0);
  });
});
