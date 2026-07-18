import type { INestApplication } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Prisma, Role, UserStatus, type StorageObject } from '@prisma/client';
import { createHash } from 'node:crypto';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import appConfig from '../../src/config/app.config';
import { PrismaService } from '../../src/database/prisma.service';
import { AttachmentAuditRecorder } from '../../src/modules/attachments/attachment-audit-recorder';
import { AttachmentContentValidator } from '../../src/modules/attachments/attachment-content-validator';
import { AttachmentStorageOrchestrator } from '../../src/modules/attachments/attachment-storage-orchestrator';
import type { AttachmentUploadStorageIdentity } from '../../src/modules/attachments/attachment-storage.types';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import type { RbacService } from '../../src/modules/permissions/rbac.service';
import type { PinnedStorageProvider } from '../../src/modules/storage/storage.interface';
import { StorageObjectLedgerService } from '../../src/modules/storage/storage-object-ledger.service';
import type { StorageSettingsService } from '../../src/modules/storage/storage-settings.service';
import {
  STORAGE_DELETE_REPLAY_TTL_MS,
  STORAGE_OPERATION_MAX_ATTEMPTS,
  STORAGE_OPERATION_PAYLOAD_VERSION,
  storageRequestHash,
} from '../../src/modules/storage/storage-consistency.types';
import type {
  DownloadUrlResult,
  GenerateDownloadUrlInput,
  GenerateUploadUrlInput,
  HeadObjectResult,
  PutObjectInput,
  StorageObjectReadProgress,
  StorageObjectSha256Result,
  StoredObject,
  StorageObjectLocator,
  UploadUrlResult,
} from '../../src/modules/storage/storage.types';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const LOCATOR: StorageObjectLocator = {
  providerType: 'COS',
  bucket: 'attachment-storage-e2e',
  region: 'ap-test',
  localNamespace: null,
};
const OLD_LOCATOR: StorageObjectLocator = {
  providerType: 'COS',
  bucket: 'attachment-storage-old',
  region: 'ap-old',
  localNamespace: null,
};
const NEW_LOCATOR: StorageObjectLocator = {
  providerType: 'COS',
  bucket: 'attachment-storage-new',
  region: 'ap-new',
  localNamespace: null,
};
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

class BarrierStorageProvider implements PinnedStorageProvider {
  readonly heads = new Map<string, HeadObjectResult>();
  readonly objectBodies = new Map<string, Buffer>();
  readonly headLocators: StorageObjectLocator[] = [];
  readonly hashLocators: StorageObjectLocator[] = [];
  hashProgressCalls = 0;
  downloadCalls = 0;
  currentLocatorCalls = 0;
  currentLocator: StorageObjectLocator = LOCATOR;
  deleteEntered?: Deferred<void>;
  deleteRelease?: Deferred<void>;
  downloadEntered?: Deferred<void>;
  downloadRelease?: Deferred<void>;
  headFailureOnce?: Error;
  downloadFailureOnce?: Error;

  getCurrentLocator(): Promise<StorageObjectLocator> {
    this.currentLocatorCalls += 1;
    return Promise.resolve(this.currentLocator);
  }

  putObject(input: PutObjectInput): Promise<StoredObject> {
    return this.putObjectAt(LOCATOR, input);
  }

  putObjectAt(_locator: StorageObjectLocator, input: PutObjectInput): Promise<StoredObject> {
    this.heads.set(input.key, { exists: true });
    return Promise.resolve({ key: input.key });
  }

  deleteObject(key: string): Promise<void> {
    return this.deleteObjectAt(LOCATOR, key);
  }

  async deleteObjectAt(_locator: StorageObjectLocator, key: string): Promise<void> {
    this.deleteEntered?.resolve();
    if (this.deleteRelease) await this.deleteRelease.promise;
    this.heads.set(key, { exists: false });
  }

  generateUploadUrl(input: GenerateUploadUrlInput): Promise<UploadUrlResult> {
    return this.generateUploadUrlAt(LOCATOR, input);
  }

  generateUploadUrlAt(
    _locator: StorageObjectLocator,
    input: GenerateUploadUrlInput,
  ): Promise<UploadUrlResult> {
    return Promise.resolve({
      url: `https://upload.invalid/${encodeURIComponent(input.key)}`,
      method: 'PUT',
      headers: {},
      expiresAt: new Date(Date.now() + input.expiresIn * 1000),
    });
  }

  generateDownloadUrl(input: GenerateDownloadUrlInput): Promise<DownloadUrlResult> {
    return this.generateDownloadUrlAt(LOCATOR, input);
  }

  async generateDownloadUrlAt(
    _locator: StorageObjectLocator,
    input: GenerateDownloadUrlInput,
  ): Promise<DownloadUrlResult> {
    this.downloadCalls += 1;
    this.downloadEntered?.resolve();
    if (this.downloadRelease) await this.downloadRelease.promise;
    const failure = this.downloadFailureOnce;
    this.downloadFailureOnce = undefined;
    if (failure) throw failure;
    return {
      url: `https://download.invalid/${encodeURIComponent(input.key)}`,
      expiresAt: new Date(Date.now() + input.expiresIn * 1000),
    };
  }

  headObject(key: string): Promise<HeadObjectResult> {
    return this.headObjectAt(LOCATOR, key);
  }

  headObjectAt(locator: StorageObjectLocator, key: string): Promise<HeadObjectResult> {
    this.headLocators.push(locator);
    const failure = this.headFailureOnce;
    this.headFailureOnce = undefined;
    if (failure) return Promise.reject(failure);
    return Promise.resolve(this.heads.get(key) ?? { exists: false });
  }

  readObjectPrefix(key: string, maxBytes: number): Promise<Buffer> {
    return this.readObjectPrefixAt(LOCATOR, key, maxBytes);
  }

  readObjectPrefixAt(
    _locator: StorageObjectLocator,
    _key: string,
    maxBytes: number,
  ): Promise<Buffer> {
    return Promise.resolve(Buffer.from('plain-text-provider-evidence').subarray(0, maxBytes));
  }

  async hashObjectSha256At(
    locator: StorageObjectLocator,
    key: string,
    onProgress?: StorageObjectReadProgress,
  ): Promise<StorageObjectSha256Result> {
    this.hashLocators.push(locator);
    const body = this.objectBodies.get(key);
    if (!body) throw new Error(`fake body missing for ${key}`);
    const hash = createHash('sha256');
    let size = 0;
    for (let offset = 0; offset < body.length; offset += 3) {
      const chunk = body.subarray(offset, offset + 3);
      hash.update(chunk);
      size += chunk.length;
      this.hashProgressCalls += 1;
      await onProgress?.(size);
    }
    return {
      size,
      checksum: hash.digest('hex'),
      etag: this.heads.get(key)?.etag,
    };
  }
}

describe('Attachment durable storage consistency (real PostgreSQL barriers)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: StorageObjectLedgerService;
  let auditRecorder: AttachmentAuditRecorder;
  let actorId: string;
  let actorTwoId: string;
  let provider: BarrierStorageProvider;
  let orchestrator: AttachmentStorageOrchestrator;
  let sequence = 0;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    ledger = app.get(StorageObjectLedgerService);
    auditRecorder = app.get(AttachmentAuditRecorder);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.storageObjectOperation.deleteMany();
    await prisma.storageObject.deleteMany();
    await prisma.auditLog.deleteMany({ where: { resourceType: 'attachment' } });
    await prisma.attachment.deleteMany();
    await prisma.user.deleteMany();
    await prisma.member.deleteMany();
    const [actor, actorTwo] = await Promise.all([
      prisma.user.create({
        data: {
          username: `storage-actor-${++sequence}`,
          passwordHash: '$2a$10$attachment-storage-e2e',
          role: Role.ADMIN,
          status: UserStatus.ACTIVE,
        },
      }),
      prisma.user.create({
        data: {
          username: `storage-actor-${++sequence}`,
          passwordHash: '$2a$10$attachment-storage-e2e',
          role: Role.ADMIN,
          status: UserStatus.ACTIVE,
        },
      }),
    ]);
    actorId = actor.id;
    actorTwoId = actorTwo.id;
    provider = new BarrierStorageProvider();
    orchestrator = new AttachmentStorageOrchestrator(
      prisma,
      ledger,
      new AttachmentContentValidator(provider),
      auditRecorder,
      provider,
    );
  });

  async function createAttachmentObject(
    options: {
      key?: string;
      state?: 'available' | 'legacy_unverified' | 'provider_unknown' | 'delete_pending';
      source?: 'backfill' | 'attachment_signed_upload';
      size?: number;
      ownerId?: string;
      locator?: StorageObjectLocator | null;
    } = {},
  ) {
    const key = options.key ?? `attachments/storage-e2e/${++sequence}.txt`;
    const size = options.size ?? 7;
    const attachment = await prisma.attachment.create({
      data: {
        key,
        originalName: 'evidence.txt',
        mime: 'text/plain',
        size,
        uploadedBy: actorId,
        ownerType: 'member',
        ownerId: options.ownerId ?? `member_${sequence}`,
      },
    });
    const state = options.state ?? 'available';
    const locator = options.locator === undefined ? LOCATOR : options.locator;
    const object = await prisma.storageObject.create({
      data: {
        key,
        state,
        source: options.source ?? (state === 'available' ? 'attachment_signed_upload' : 'backfill'),
        providerType: locator?.providerType,
        bucket: locator?.bucket,
        region: locator?.region,
        localNamespace: locator?.localNamespace,
        expectedSize: BigInt(size),
        actualSize: state === 'available' ? BigInt(size) : undefined,
        expectedMime: 'text/plain',
        resourceType: 'attachment',
        resourceId: attachment.id,
        verifiedAt: state === 'available' ? new Date() : undefined,
        presentAt: state === 'available' ? new Date() : undefined,
        lastProviderCheckedAt: state === 'available' ? new Date() : undefined,
        deleteRequestedAt: state === 'delete_pending' ? new Date() : undefined,
      },
    });
    provider.heads.set(key, { exists: true, size, contentType: 'text/plain' });
    return { attachment, object };
  }

  async function createActiveMember() {
    return prisma.member.create({
      data: {
        memberNo: `storage-member-${++sequence}`,
        displayName: 'Storage consistency owner',
      },
    });
  }

  function createStrictOrchestrator(): AttachmentStorageOrchestrator {
    const strictLedger = new StorageObjectLedgerService(prisma, {
      env: 'test',
      storage: { consistencyMode: 'STRICT' },
    } as unknown as ConfigType<typeof appConfig>);
    return new AttachmentStorageOrchestrator(
      prisma,
      strictLedger,
      new AttachmentContentValidator(provider),
      auditRecorder,
      provider,
    );
  }

  function createPatchService(): AttachmentsService {
    return new AttachmentsService(
      prisma,
      { can: jest.fn().mockResolvedValue(true) } as unknown as RbacService,
      orchestrator,
      { getActiveSettings: jest.fn().mockResolvedValue(null) } as unknown as StorageSettingsService,
      {
        env: 'test',
        storage: { encryptionKey: 'attachment-storage-e2e-encryption-key' },
      } as unknown as ConfigType<typeof appConfig>,
    );
  }

  function patchUser(memberId: string): CurrentUserPayload {
    return {
      id: actorId,
      username: 'storage-patch-actor',
      role: Role.ADMIN,
      status: UserStatus.ACTIVE,
      memberId,
    };
  }

  function deletePayload(
    attachment: Awaited<ReturnType<typeof createAttachmentObject>>['attachment'],
  ) {
    return {
      response: {
        id: attachment.id,
        key: attachment.key,
        originalName: attachment.originalName,
        mime: attachment.mime,
        size: attachment.size,
        uploadedBy: attachment.uploadedBy,
        uploadedAt: attachment.uploadedAt.toISOString(),
        ownerType: attachment.ownerType,
        ownerId: attachment.ownerId,
        createdAt: attachment.createdAt.toISOString(),
        updatedAt: attachment.updatedAt.toISOString(),
        description: null,
        accessLevel: null,
        tags: [],
        originalUploaderName: null,
        expireAt: null,
        accessUrl: null,
      },
      audit: {
        actorUserId: actorId,
        actorRoleSnap: Role.ADMIN,
        scope: 'other',
        deletedByPath: 'admin',
        requestId: `storage-delete-${sequence}`,
        ip: null,
        ua: null,
      },
    };
  }

  async function createDeleteOperation(
    attachment: Awaited<ReturnType<typeof createAttachmentObject>>['attachment'],
    object: StorageObject,
  ) {
    const payload = deletePayload(attachment);
    const requestHash = storageRequestHash({ operation: 'delete', attachmentId: attachment.id });
    return prisma.storageObjectOperation.create({
      data: {
        eventKey: `storage.attachment-delete:${requestHash}`,
        storageObjectId: object.id,
        kind: 'attachment_delete',
        status: 'pending',
        effectState: 'not_started',
        payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
        payload,
        requestHash,
        responseSnapshotExpiresAt: new Date(Date.now() + STORAGE_DELETE_REPLAY_TTL_MS),
      },
    });
  }

  async function createBackfillOperation(
    attachment: Awaited<ReturnType<typeof createAttachmentObject>>['attachment'],
    object: StorageObject,
  ) {
    const requestHash = storageRequestHash({
      operation: 'backfill',
      attachmentId: attachment.id,
    });
    return prisma.storageObjectOperation.create({
      data: {
        eventKey: `storage.backfill-verify:${attachment.id}`,
        storageObjectId: object.id,
        kind: 'backfill_verify',
        status: 'pending',
        effectState: 'not_started',
        payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
        payload: { attachmentId: attachment.id },
        requestHash,
      },
    });
  }

  async function claimOne(eventKey: string) {
    const rows = await ledger.claim(`storage-e2e-worker-${++sequence}`, { eventKey, limit: 1 });
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function waitForRelationLockWait(relation: string): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
      const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(*)::BIGINT AS "count"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND state = 'active'
          AND wait_event_type = 'Lock'
          AND query LIKE ${`%FROM "${relation}"%`}
      `);
      if ((rows[0]?.count ?? 0n) > 0n) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for PostgreSQL lock waiter on ${relation}`);
  }

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

  it('STRICT gate rejects a key-only ledger join and an orphaned available object', async () => {
    const attachment = await prisma.attachment.create({
      data: {
        key: `attachments/storage-e2e/strict-key-only-${++sequence}.txt`,
        originalName: 'strict-key-only.txt',
        mime: 'text/plain',
        size: 7,
        uploadedBy: actorId,
        ownerType: 'member',
        ownerId: `member_${sequence}`,
      },
    });
    const keyOnlyObject = await prisma.storageObject.create({
      data: {
        key: attachment.key,
        state: 'pending_upload',
        source: 'attachment_signed_upload',
        providerType: LOCATOR.providerType,
        bucket: LOCATOR.bucket,
        region: LOCATOR.region,
        expectedSize: BigInt(attachment.size),
        expectedMime: attachment.mime,
      },
    });

    // Mutation killed: LEFT JOIN by key alone used to let this old-writer race pass STRICT.
    await expect(ledger.assertStrictStartGate()).rejects.toThrow('invalidAttachmentObjects=1');

    await prisma.attachment.delete({ where: { id: attachment.id } });
    await prisma.storageObject.update({
      where: { id: keyOnlyObject.id },
      data: {
        state: 'available',
        resourceType: 'attachment',
        resourceId: attachment.id,
        expectedSize: BigInt(attachment.size),
        actualSize: BigInt(attachment.size),
        verifiedAt: new Date(),
        presentAt: new Date(),
        lastProviderCheckedAt: new Date(),
      },
    });
    await expect(ledger.assertStrictStartGate()).rejects.toThrow('invalidAvailableObjects=1');
  });

  it('delete finalizer waits on Attachment before holding Object/Operation locks', async () => {
    const { attachment, object } = await createAttachmentObject({ state: 'delete_pending' });
    const operation = await createDeleteOperation(attachment, object);
    const claimed = await claimOne(operation.eventKey);
    provider.heads.set(attachment.key, { exists: false });

    const holderReady = deferred();
    const holderRelease = deferred();
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "attachments" WHERE "id" = ${attachment.id} FOR UPDATE
      `);
      holderReady.resolve();
      await holderRelease.promise;
    });
    await holderReady.promise;
    const execution = orchestrator.executeClaimed(claimed);

    try {
      await waitForRelationLockWait('attachments');
      // Mutation killed: Operation -> Object -> Attachment would make either NOWAIT fail here.
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$queryRaw(Prisma.sql`
            SELECT "id" FROM "storage_objects" WHERE "id" = ${object.id} FOR UPDATE NOWAIT
          `);
          await tx.$queryRaw(Prisma.sql`
            SELECT "id" FROM "storage_object_operations"
            WHERE "id" = ${operation.id} FOR UPDATE NOWAIT
          `);
        }),
      ).resolves.toBeUndefined();
    } finally {
      holderRelease.resolve();
      await withTimeout(holder, 'attachment lock holder');
      await withTimeout(execution, 'delete finalizer');
    }
    await expect(
      prisma.attachment.findUnique({ where: { id: attachment.id } }),
    ).resolves.toBeNull();
  });

  it('delete intent commit wins: PATCH waits on Attachment then rejects without changing fields', async () => {
    const owner = await createActiveMember();
    const { attachment, object } = await createAttachmentObject({ ownerId: owner.id });
    const holderReady = deferred();
    const holderRelease = deferred();
    const deleteIntentHolder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "attachments" WHERE "id" = ${attachment.id} FOR UPDATE
      `);
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "storage_objects" WHERE "id" = ${object.id} FOR UPDATE
      `);
      await tx.storageObject.update({
        where: { id: object.id },
        data: { state: 'delete_pending', deleteRequestedAt: new Date() },
      });
      holderReady.resolve();
      await holderRelease.promise;
    });
    await holderReady.promise;
    const updating = createPatchService().update(
      attachment.id,
      { description: 'must-not-commit' },
      patchUser(owner.id),
    );
    const updateOutcome = updating.catch((error: unknown) => error);

    try {
      await waitForRelationLockWait('attachments');
    } finally {
      holderRelease.resolve();
      await withTimeout(deleteIntentHolder, 'delete intent holder');
    }
    await expect(withTimeout(updateOutcome, 'PATCH after delete intent')).resolves.toEqual(
      new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING),
    );
    await expect(
      prisma.attachment.findUnique({ where: { id: attachment.id } }),
    ).resolves.toMatchObject({ description: null });
  });

  it('PATCH locks Attachment then Object: update commits before delete and final hard delete succeeds', async () => {
    const owner = await createActiveMember();
    const { attachment, object } = await createAttachmentObject({ ownerId: owner.id });
    const holderReady = deferred();
    const holderRelease = deferred();
    const objectHolder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "storage_objects" WHERE "id" = ${object.id} FOR UPDATE
      `);
      holderReady.resolve();
      await holderRelease.promise;
    });
    await holderReady.promise;
    const updating = createPatchService().update(
      attachment.id,
      { description: 'update-won' },
      patchUser(owner.id),
    );
    await waitForRelationLockWait('storage_objects');
    const preparingDelete = orchestrator.prepareDelete({
      attachmentId: attachment.id,
      actorUserId: actorId,
      actorRoleSnap: Role.ADMIN,
      allowAuthorizedJoin: true,
      scope: 'self',
      deletedByPath: 'owner',
      auditMeta: { requestId: 'patch-before-delete', ip: null, ua: null },
    });

    try {
      await waitForRelationLockWait('attachments');
    } finally {
      holderRelease.resolve();
      await withTimeout(objectHolder, 'PATCH object holder');
    }
    const updated = await withTimeout(updating, 'PATCH lock-first completion');
    const eventKey = await withTimeout(preparingDelete, 'delete after PATCH');
    expect(updated.description).toBe('update-won');

    provider.heads.set(attachment.key, { exists: false });
    await orchestrator.executeEventKey(eventKey);
    await expect(
      prisma.attachment.findUnique({ where: { id: attachment.id } }),
    ).resolves.toBeNull();
  });

  it('non-Attachment worker finalizer waits on Object before holding its Operation lock', async () => {
    const { attachment, object } = await createAttachmentObject({
      state: 'legacy_unverified',
      source: 'backfill',
    });
    const requestHash = storageRequestHash({ operation: 'backfill', attachmentId: attachment.id });
    const operation = await prisma.storageObjectOperation.create({
      data: {
        eventKey: `storage.backfill-verify:${attachment.id}`,
        storageObjectId: object.id,
        kind: 'backfill_verify',
        status: 'pending',
        effectState: 'not_started',
        payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
        payload: { attachmentId: attachment.id },
        requestHash,
      },
    });
    const claimed = await claimOne(operation.eventKey);

    const holderReady = deferred();
    const holderRelease = deferred();
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "storage_objects" WHERE "id" = ${object.id} FOR UPDATE
      `);
      holderReady.resolve();
      await holderRelease.promise;
    });
    await holderReady.promise;
    const execution = orchestrator.executeClaimed(claimed);

    try {
      await waitForRelationLockWait('storage_objects');
      // Mutation killed: terminal Operation update before Object update holds this row lock.
      await expect(
        prisma.$transaction((tx) =>
          tx.$queryRaw(Prisma.sql`
            SELECT "id" FROM "storage_object_operations"
            WHERE "id" = ${operation.id} FOR UPDATE NOWAIT
          `),
        ),
      ).resolves.toEqual(expect.any(Array));
    } finally {
      holderRelease.resolve();
      await withTimeout(holder, 'object lock holder');
      await withTimeout(execution, 'backfill finalizer');
    }
    await expect(
      prisma.storageObject.findUnique({ where: { id: object.id } }),
    ).resolves.toMatchObject({
      state: 'available',
    });
  });

  it('confirm cannot bind an object while an orphan delete is in provider effect', async () => {
    const owner = await createActiveMember();
    const identity: AttachmentUploadStorageIdentity = {
      key: `attachments/storage-e2e/orphan-${++sequence}.txt`,
      ownerType: 'member',
      ownerId: owner.id,
      originalName: 'orphan.txt',
      mime: 'text/plain',
      size: 7,
      uploadedByUserId: actorId,
    };
    const requestHash = orchestrator.uploadRequestHash(identity, 'attachment_signed_upload');
    const object = await prisma.storageObject.create({
      data: {
        key: identity.key,
        state: 'delete_pending',
        source: 'attachment_signed_upload',
        providerType: LOCATOR.providerType,
        bucket: LOCATOR.bucket,
        region: LOCATOR.region,
        expectedSize: BigInt(identity.size),
        expectedMime: identity.mime,
        presentAt: new Date(),
        unboundExpiresAt: new Date(Date.now() - 1_000),
        deleteRequestedAt: new Date(),
      },
    });
    const upload = await prisma.storageObjectOperation.create({
      data: {
        eventKey: `storage.attachment-upload-verify:${requestHash}`,
        storageObjectId: object.id,
        kind: 'attachment_upload_verify',
        status: 'succeeded',
        effectState: 'provider_present',
        payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
        payload: { source: 'attachment_signed_upload' },
        requestHash,
        completedAt: new Date(),
      },
    });
    const orphanHash = storageRequestHash({ operation: 'orphan', objectId: object.id });
    const orphan = await prisma.storageObjectOperation.create({
      data: {
        eventKey: `storage.orphan-delete:${object.id}`,
        storageObjectId: object.id,
        replayOfId: upload.id,
        kind: 'orphan_delete',
        status: 'pending',
        effectState: 'not_started',
        payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
        payload: {},
        requestHash: orphanHash,
      },
    });
    provider.heads.set(identity.key, { exists: true, size: identity.size });
    provider.deleteEntered = deferred();
    provider.deleteRelease = deferred();
    const deleting = orchestrator.executeEventKey(orphan.eventKey);
    await withTimeout(provider.deleteEntered.promise, 'provider orphan delete entry');

    try {
      await expect(
        orchestrator.finalizeUpload({
          identity,
          requestHash,
          data: {
            key: identity.key,
            originalName: identity.originalName,
            mime: identity.mime,
            size: identity.size,
            uploadedBy: actorId,
            ownerType: identity.ownerType,
            ownerId: identity.ownerId,
          },
          auditKind: 'confirmed',
          actorRoleSnap: Role.ADMIN,
          scope: 'other',
          ownerTable: 'member',
          auditMeta: { requestId: 'confirm-vs-orphan', ip: null, ua: null },
        }),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING));
    } finally {
      provider.deleteRelease.resolve();
      await withTimeout(deleting, 'orphan delete completion');
    }
    await expect(
      prisma.attachment.findUnique({ where: { key: identity.key } }),
    ).resolves.toBeNull();
  });

  it('reuses the upload intent pinned locator after current settings switch', async () => {
    const identity: AttachmentUploadStorageIdentity = {
      key: `attachments/storage-e2e/pinned-upload-${++sequence}.txt`,
      ownerType: 'member',
      ownerId: `member_${sequence}`,
      originalName: 'pinned-upload.txt',
      mime: 'text/plain',
      size: 7,
      uploadedByUserId: actorId,
      iat: 1_784_435_200,
      exp: 1_784_435_800,
    };
    provider.currentLocator = OLD_LOCATOR;
    const first = await orchestrator.prepareUpload(
      identity,
      'attachment_signed_upload',
      new Date(Date.now() + 60_000),
    );
    provider.currentLocator = NEW_LOCATOR;
    const replay = await orchestrator.prepareUpload(
      identity,
      'attachment_signed_upload',
      new Date(Date.now() + 60_000),
    );

    expect(replay).toMatchObject({
      objectId: first.objectId,
      operationId: first.operationId,
      requestHash: first.requestHash,
      locator: OLD_LOCATOR,
    });
    expect(provider.currentLocatorCalls).toBe(1);
    await expect(
      prisma.storageObject.findUnique({ where: { id: first.objectId } }),
    ).resolves.toMatchObject({
      providerType: OLD_LOCATOR.providerType,
      bucket: OLD_LOCATOR.bucket,
      region: OLD_LOCATOR.region,
      localNamespace: null,
    });
  });

  it('locks and rereads the owner before binding a verified upload', async () => {
    const owner = await createActiveMember();
    const identity: AttachmentUploadStorageIdentity = {
      key: `attachments/storage-e2e/owner-race-${++sequence}.txt`,
      ownerType: 'member',
      ownerId: owner.id,
      originalName: 'owner-race.txt',
      mime: 'text/plain',
      size: 7,
      uploadedByUserId: actorId,
    };
    const requestHash = orchestrator.uploadRequestHash(identity, 'attachment_signed_upload');
    const object = await prisma.storageObject.create({
      data: {
        key: identity.key,
        state: 'present_unbound',
        source: 'attachment_signed_upload',
        providerType: LOCATOR.providerType,
        bucket: LOCATOR.bucket,
        region: LOCATOR.region,
        expectedSize: BigInt(identity.size),
        expectedMime: identity.mime,
        actualSize: BigInt(identity.size),
        actualMime: identity.mime,
        presentAt: new Date(),
        unboundExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const operation = await prisma.storageObjectOperation.create({
      data: {
        eventKey: `storage.attachment-upload-verify:${requestHash}`,
        storageObjectId: object.id,
        kind: 'attachment_upload_verify',
        status: 'pending',
        effectState: 'provider_present',
        payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
        payload: { source: 'attachment_signed_upload' },
        requestHash,
      },
    });

    const deleteReady = deferred();
    const deleteRelease = deferred();
    const deletingOwner = prisma.$transaction(async (tx) => {
      await tx.member.update({ where: { id: owner.id }, data: { deletedAt: new Date() } });
      deleteReady.resolve();
      await deleteRelease.promise;
    });
    await deleteReady.promise;
    const confirming = orchestrator.finalizeUpload({
      identity,
      requestHash,
      data: {
        key: identity.key,
        originalName: identity.originalName,
        mime: identity.mime,
        size: identity.size,
        uploadedBy: actorId,
        ownerType: identity.ownerType,
        ownerId: identity.ownerId,
      },
      auditKind: 'confirmed',
      actorRoleSnap: Role.ADMIN,
      scope: 'other',
      ownerTable: 'member',
      auditMeta: { requestId: 'owner-delete-wins-confirm', ip: null, ua: null },
    });

    try {
      await waitForRelationLockWait('Member');
      // Mutation killed: an Object-first finalizer would already hold either ledger row here.
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$queryRaw(Prisma.sql`
            SELECT "id" FROM "storage_objects" WHERE "id" = ${object.id} FOR UPDATE NOWAIT
          `);
          await tx.$queryRaw(Prisma.sql`
            SELECT "id" FROM "storage_object_operations"
            WHERE "id" = ${operation.id} FOR UPDATE NOWAIT
          `);
        }),
      ).resolves.toBeUndefined();
    } finally {
      deleteRelease.resolve();
      await withTimeout(deletingOwner, 'owner soft-delete lock holder');
    }
    await expect(withTimeout(confirming, 'owner-race confirm')).rejects.toEqual(
      new BizException(BizCode.ATTACHMENT_OWNER_NOT_FOUND),
    );
    await expect(
      prisma.attachment.findUnique({ where: { key: identity.key } }),
    ).resolves.toBeNull();
    await expect(
      prisma.storageObject.findUnique({ where: { id: object.id } }),
    ).resolves.toMatchObject({ state: 'present_unbound', resourceId: null });
    await expect(
      prisma.storageObjectOperation.findUnique({ where: { id: operation.id } }),
    ).resolves.toMatchObject({ status: 'pending', effectState: 'provider_present' });
    await expect(prisma.auditLog.count({ where: { resourceType: 'attachment' } })).resolves.toBe(0);
  });

  it('discards a generated download URL when delete wins the available-state CAS', async () => {
    const { attachment } = await createAttachmentObject();
    provider.downloadEntered = deferred();
    provider.downloadRelease = deferred();
    const resolving = orchestrator.resolveDownloadUrl(attachment.key, 300);
    await withTimeout(provider.downloadEntered.promise, 'download signing entry');

    const eventKey = await orchestrator.prepareDelete({
      attachmentId: attachment.id,
      actorUserId: actorId,
      actorRoleSnap: Role.ADMIN,
      allowAuthorizedJoin: true,
      scope: 'other',
      deletedByPath: 'admin',
      auditMeta: { requestId: 'delete-wins-download', ip: null, ua: null },
    });
    provider.downloadRelease.resolve();

    await expect(withTimeout(resolving, 'download linearization')).resolves.toBeNull();
    expect(provider.downloadCalls).toBe(1);
    await expect(
      prisma.storageObjectOperation.findUnique({ where: { eventKey } }),
    ).resolves.toMatchObject({ status: 'pending', kind: 'attachment_delete' });
  });

  it('does not return a signed URL when the ledger row disappears before DB linearization', async () => {
    const { attachment, object } = await createAttachmentObject();
    provider.downloadEntered = deferred();
    provider.downloadRelease = deferred();
    const resolving = orchestrator.resolveDownloadUrl(attachment.key, 300);
    await withTimeout(provider.downloadEntered.promise, 'download signing entry');

    await prisma.storageObject.delete({ where: { id: object.id } });
    provider.downloadRelease.resolve();

    await expect(withTimeout(resolving, 'download missing CAS')).resolves.toBeNull();
    expect(provider.downloadCalls).toBe(1);
  });

  it.each(['HEAD', 'sign'] as const)(
    'STRICT available survives one transient provider %s failure without locator drift',
    async (failurePoint) => {
      const { attachment, object } = await createAttachmentObject();
      const strictOrchestrator = createStrictOrchestrator();
      if (failurePoint === 'HEAD') provider.headFailureOnce = new Error('transient HEAD timeout');
      else provider.downloadFailureOnce = new Error('transient signing failure');

      await expect(strictOrchestrator.resolveDownloadUrl(attachment.key, 300)).resolves.toBeNull();
      await expect(
        prisma.storageObject.findUnique({ where: { id: object.id } }),
      ).resolves.toMatchObject({
        state: 'available',
        providerType: LOCATOR.providerType,
        bucket: LOCATOR.bucket,
        region: LOCATOR.region,
        localNamespace: null,
        lastErrorCode: expect.any(String),
        lastErrorClass: expect.any(String),
      });

      await expect(strictOrchestrator.resolveDownloadUrl(attachment.key, 300)).resolves.toContain(
        'https://download.invalid/',
      );
      await expect(
        prisma.storageObject.findUnique({ where: { id: object.id } }),
      ).resolves.toMatchObject({
        state: 'available',
        providerType: LOCATOR.providerType,
        bucket: LOCATOR.bucket,
        region: LOCATOR.region,
        localNamespace: null,
        lastErrorCode: null,
        lastErrorClass: null,
      });
    },
  );

  it.each(['size', 'etag'] as const)(
    'STRICT available %s conflict becomes hidden integrity_mismatch and blocks the gate',
    async (field) => {
      const { attachment, object } = await createAttachmentObject();
      if (field === 'size') {
        provider.heads.set(attachment.key, {
          exists: true,
          size: attachment.size + 1,
          contentType: attachment.mime,
        });
      } else {
        await prisma.storageObject.update({
          where: { id: object.id },
          data: { etag: 'expected-etag' },
        });
        provider.heads.set(attachment.key, {
          exists: true,
          size: attachment.size,
          etag: 'different-etag',
          contentType: attachment.mime,
        });
      }
      const strictOrchestrator = createStrictOrchestrator();

      await expect(strictOrchestrator.resolveDownloadUrl(attachment.key, 300)).resolves.toBeNull();
      await expect(
        prisma.storageObject.findUnique({ where: { id: object.id } }),
      ).resolves.toMatchObject({
        state: 'integrity_mismatch',
        providerType: LOCATOR.providerType,
        bucket: LOCATOR.bucket,
        region: LOCATOR.region,
        localNamespace: null,
        lastErrorCode: 'STORAGE_OBJECT_INTEGRITY_MISMATCH',
        lastErrorClass: 'StorageObjectIntegrityMismatchError',
      });
      await expect(strictOrchestrator.filterMetadataVisible([attachment])).resolves.toEqual([]);
      await expect(ledger.assertStrictStartGate()).rejects.toThrow(/unsafeObjects=1/);
      expect(provider.downloadCalls).toBe(0);
    },
  );

  it('manual relocate recovers integrity_mismatch while absent attestation remains forbidden', async () => {
    const { attachment, object } = await createAttachmentObject();
    const trustedBody = Buffer.from('payload');
    const trustedChecksum = createHash('sha256').update(trustedBody).digest('hex');
    await prisma.storageObject.update({
      where: { id: object.id },
      data: { checksum: trustedChecksum, etag: 'source-etag' },
    });
    provider.objectBodies.set(attachment.key, trustedBody);
    const requestHash = storageRequestHash({ operation: 'integrity-source', id: object.id });
    const original = await prisma.storageObjectOperation.create({
      data: {
        eventKey: `storage.attachment-upload-verify:${requestHash}`,
        storageObjectId: object.id,
        kind: 'attachment_upload_verify',
        status: 'succeeded',
        effectState: 'provider_present',
        payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
        payload: { source: 'attachment_signed_upload' },
        requestHash,
        completedAt: new Date(),
      },
    });
    provider.heads.set(attachment.key, {
      exists: true,
      size: attachment.size + 1,
      contentType: attachment.mime,
    });
    await expect(
      createStrictOrchestrator().resolveDownloadUrl(attachment.key, 300),
    ).resolves.toBeNull();

    const manualEvidence = {
      replayOperationId: original.id,
      operatorUserId: actorId,
      reviewerUserId: actorTwoId,
      reasonCode: 'integrity_recovery',
      evidenceRef: 'OPS-13034',
      verifiedAt: new Date(),
    };
    await expect(orchestrator.prepareManualAttestAbsent(manualEvidence)).rejects.toThrow(
      /manual attest target rejected/,
    );

    provider.heads.set(attachment.key, {
      exists: true,
      size: attachment.size,
      etag: 'replacement-etag',
      contentType: attachment.mime,
    });
    const eventKey = await orchestrator.prepareManualRelocate({
      ...manualEvidence,
      targetLocator: NEW_LOCATOR,
    });
    await orchestrator.executeEventKey(eventKey);

    await expect(
      prisma.storageObject.findUnique({ where: { id: object.id } }),
    ).resolves.toMatchObject({
      state: 'available',
      providerType: NEW_LOCATOR.providerType,
      bucket: NEW_LOCATOR.bucket,
      region: NEW_LOCATOR.region,
      localNamespace: null,
      actualSize: BigInt(attachment.size),
      etag: 'replacement-etag',
      checksum: trustedChecksum,
      lastErrorCode: null,
      lastErrorClass: null,
    });
    await expect(
      prisma.storageObjectOperation.findUnique({ where: { eventKey } }),
    ).resolves.toMatchObject({ status: 'succeeded', effectState: 'provider_present' });
    expect(provider.hashLocators).toEqual([NEW_LOCATOR]);
    expect(provider.hashProgressCalls).toBeGreaterThan(1);
    await expect(ledger.assertStrictStartGate()).resolves.toBeUndefined();
  });

  it('manual relocate without checksum requires the stored ETag and never substitutes size-only evidence', async () => {
    const { attachment, object } = await createAttachmentObject({
      state: 'legacy_unverified',
      source: 'backfill',
      locator: OLD_LOCATOR,
    });
    await prisma.storageObject.update({
      where: { id: object.id },
      data: { etag: 'trusted-source-etag' },
    });
    const requestHash = storageRequestHash({ operation: 'etag-source', id: object.id });
    const original = await prisma.storageObjectOperation.create({
      data: {
        eventKey: `storage.backfill-verify:${requestHash}`,
        storageObjectId: object.id,
        kind: 'backfill_verify',
        status: 'succeeded',
        effectState: 'provider_present',
        payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
        payload: { attachmentId: attachment.id },
        requestHash,
        completedAt: new Date(),
      },
    });
    provider.heads.set(attachment.key, {
      exists: true,
      size: attachment.size,
      etag: 'copy-changed-etag',
      contentType: attachment.mime,
    });
    const eventKey = await orchestrator.prepareManualRelocate({
      replayOperationId: original.id,
      operatorUserId: actorId,
      reviewerUserId: actorTwoId,
      reasonCode: 'etag_only_recovery',
      evidenceRef: 'OPS-ETAG-FAIL-CLOSED',
      verifiedAt: new Date(),
      targetLocator: NEW_LOCATOR,
    });

    await orchestrator.executeEventKey(eventKey);

    await expect(
      prisma.storageObject.findUnique({ where: { id: object.id } }),
    ).resolves.toMatchObject({
      state: 'legacy_unverified',
      providerType: OLD_LOCATOR.providerType,
      bucket: OLD_LOCATOR.bucket,
      region: OLD_LOCATOR.region,
    });
    await expect(
      prisma.storageObjectOperation.findUnique({ where: { eventKey } }),
    ).resolves.toMatchObject({
      status: 'pending',
      lastErrorCode: 'STORAGE_OBJECT_INTEGRITY_MISMATCH',
    });
    expect(provider.hashLocators).toEqual([]);
  });

  it('manual relocate rejects same-size target content whose streamed SHA-256 differs', async () => {
    const { attachment, object } = await createAttachmentObject();
    const trustedChecksum = createHash('sha256').update('payload').digest('hex');
    await prisma.storageObject.update({
      where: { id: object.id },
      data: { checksum: trustedChecksum, etag: 'source-etag' },
    });
    await ledger.markIntegrityMismatch(
      object.id,
      new Error('force reviewed integrity recovery fixture'),
    );
    const requestHash = storageRequestHash({ operation: 'checksum-source', id: object.id });
    const original = await prisma.storageObjectOperation.create({
      data: {
        eventKey: `storage.attachment-upload-verify:${requestHash}`,
        storageObjectId: object.id,
        kind: 'attachment_upload_verify',
        status: 'succeeded',
        effectState: 'provider_present',
        payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
        payload: { source: 'attachment_signed_upload' },
        requestHash,
        completedAt: new Date(),
      },
    });
    provider.objectBodies.set(attachment.key, Buffer.from('corrupt'));
    provider.heads.set(attachment.key, {
      exists: true,
      size: attachment.size,
      etag: 'replacement-etag',
      contentType: attachment.mime,
    });
    const eventKey = await orchestrator.prepareManualRelocate({
      replayOperationId: original.id,
      operatorUserId: actorId,
      reviewerUserId: actorTwoId,
      reasonCode: 'checksum_mismatch',
      evidenceRef: 'OPS-CHECKSUM-FAIL-CLOSED',
      verifiedAt: new Date(),
      targetLocator: NEW_LOCATOR,
    });

    await orchestrator.executeEventKey(eventKey);

    await expect(
      prisma.storageObject.findUnique({ where: { id: object.id } }),
    ).resolves.toMatchObject({
      state: 'integrity_mismatch',
      providerType: LOCATOR.providerType,
      bucket: LOCATOR.bucket,
      region: LOCATOR.region,
      checksum: trustedChecksum,
    });
    await expect(
      prisma.storageObjectOperation.findUnique({ where: { eventKey } }),
    ).resolves.toMatchObject({
      status: 'pending',
      lastErrorCode: 'STORAGE_OBJECT_INTEGRITY_MISMATCH',
    });
    expect(provider.hashLocators).toEqual([NEW_LOCATOR]);
  });

  it('JIT promotion pins locator, makes available and closes the active backfill before signing', async () => {
    const { attachment, object } = await createAttachmentObject({
      state: 'legacy_unverified',
      source: 'backfill',
    });
    const requestHash = storageRequestHash({ operation: 'jit-backfill', id: attachment.id });
    const operation = await prisma.storageObjectOperation.create({
      data: {
        eventKey: `storage.backfill-verify:${attachment.id}`,
        storageObjectId: object.id,
        kind: 'backfill_verify',
        status: 'pending',
        effectState: 'not_started',
        payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
        payload: { attachmentId: attachment.id },
        requestHash,
      },
    });

    await expect(orchestrator.resolveDownloadUrl(attachment.key, 300)).resolves.toContain(
      'https://download.invalid/',
    );
    await expect(
      prisma.storageObject.findUnique({ where: { id: object.id } }),
    ).resolves.toMatchObject({
      state: 'available',
      providerType: LOCATOR.providerType,
      bucket: LOCATOR.bucket,
      region: LOCATOR.region,
      localNamespace: null,
    });
    await expect(
      prisma.storageObjectOperation.findUnique({ where: { id: operation.id } }),
    ).resolves.toMatchObject({ status: 'succeeded', effectState: 'provider_present' });
    await expect(
      prisma.storageObjectOperation.count({
        where: { storageObjectId: object.id, status: { in: ['pending', 'processing'] } },
      }),
    ).resolves.toBe(0);
  });

  it('JIT uses current COS only as an unpinned provider_unknown candidate and pins after present HEAD', async () => {
    const { attachment, object } = await createAttachmentObject({
      state: 'provider_unknown',
      source: 'backfill',
      locator: null,
    });

    await expect(orchestrator.resolveDownloadUrl(attachment.key, 300)).resolves.toContain(
      'https://download.invalid/',
    );
    expect(provider.currentLocatorCalls).toBe(1);
    expect(provider.headLocators).toEqual([LOCATOR]);
    await expect(
      prisma.storageObject.findUnique({ where: { id: object.id } }),
    ).resolves.toMatchObject({
      state: 'available',
      providerType: LOCATOR.providerType,
      bucket: LOCATOR.bucket,
      region: LOCATOR.region,
      localNamespace: null,
    });
  });

  it.each(['absent', 'timeout'] as const)(
    'JIT current locator %s evidence leaves provider_unknown completely unpinned',
    async (result) => {
      const { attachment, object } = await createAttachmentObject({
        state: 'provider_unknown',
        source: 'backfill',
        locator: null,
      });
      if (result === 'absent') provider.heads.set(attachment.key, { exists: false });
      else provider.headFailureOnce = new Error('candidate HEAD timeout');

      await expect(orchestrator.resolveDownloadUrl(attachment.key, 300)).resolves.toBeNull();
      expect(provider.downloadCalls).toBe(0);
      await expect(
        prisma.storageObject.findUnique({ where: { id: object.id } }),
      ).resolves.toMatchObject({
        state: 'provider_unknown',
        providerType: null,
        bucket: null,
        region: null,
        localNamespace: null,
      });
    },
  );

  it('STRICT never consults the current locator for an unpinned provider_unknown row', async () => {
    const { attachment, object } = await createAttachmentObject({
      state: 'provider_unknown',
      source: 'backfill',
      locator: null,
    });

    await expect(
      createStrictOrchestrator().resolveDownloadUrl(attachment.key, 300),
    ).resolves.toBeNull();
    expect(provider.currentLocatorCalls).toBe(0);
    expect(provider.headLocators).toEqual([]);
    await expect(
      prisma.storageObject.findUnique({ where: { id: object.id } }),
    ).resolves.toMatchObject({
      state: 'provider_unknown',
      providerType: null,
      bucket: null,
      region: null,
      localNamespace: null,
    });
  });

  it('legacy COS 404 forgets the old candidate, then current COS present pins the new locator', async () => {
    const { attachment, object } = await createAttachmentObject({
      state: 'legacy_unverified',
      source: 'backfill',
      locator: OLD_LOCATOR,
    });
    provider.currentLocator = NEW_LOCATOR;
    provider.heads.set(attachment.key, { exists: false });

    await expect(orchestrator.resolveDownloadUrl(attachment.key, 300)).resolves.toBeNull();
    expect(provider.headLocators).toEqual([OLD_LOCATOR]);
    expect(provider.currentLocatorCalls).toBe(0);
    await expect(
      prisma.storageObject.findUnique({ where: { id: object.id } }),
    ).resolves.toMatchObject({
      state: 'provider_unknown',
      providerType: null,
      bucket: null,
      region: null,
      localNamespace: null,
    });

    provider.heads.set(attachment.key, { exists: true, size: 7, contentType: 'text/plain' });
    await expect(orchestrator.resolveDownloadUrl(attachment.key, 300)).resolves.toContain(
      'https://download.invalid/',
    );
    expect(provider.headLocators).toEqual([OLD_LOCATOR, NEW_LOCATOR]);
    expect(provider.currentLocatorCalls).toBe(1);
    await expect(
      prisma.storageObject.findUnique({ where: { id: object.id } }),
    ).resolves.toMatchObject({
      state: 'available',
      providerType: NEW_LOCATOR.providerType,
      bucket: NEW_LOCATOR.bucket,
      region: NEW_LOCATOR.region,
      localNamespace: null,
    });
  });

  it.each(['timeout', 'forbidden'] as const)(
    'legacy COS transient %s preserves legacy_unverified and its pinned candidate',
    async (failure) => {
      const { attachment, object } = await createAttachmentObject({
        state: 'legacy_unverified',
        source: 'backfill',
        locator: OLD_LOCATOR,
      });
      const error = new Error(failure === 'timeout' ? 'provider timeout' : 'provider forbidden');
      error.name = failure === 'timeout' ? 'StorageProviderTimeout' : 'StorageProviderForbidden';
      provider.headFailureOnce = error;

      await expect(orchestrator.resolveDownloadUrl(attachment.key, 300)).resolves.toBeNull();
      await expect(
        prisma.storageObject.findUnique({ where: { id: object.id } }),
      ).resolves.toMatchObject({
        state: 'legacy_unverified',
        providerType: OLD_LOCATOR.providerType,
        bucket: OLD_LOCATOR.bucket,
        region: OLD_LOCATOR.region,
        localNamespace: null,
        lastErrorCode: expect.any(String),
        lastErrorClass: error.name,
      });
    },
  );

  it('claimed backfill worker demotes only absent evidence and preserves transient legacy state', async () => {
    const absentCandidate = await createAttachmentObject({
      state: 'legacy_unverified',
      source: 'backfill',
      locator: OLD_LOCATOR,
    });
    provider.heads.set(absentCandidate.attachment.key, { exists: false });
    const absentOperation = await createBackfillOperation(
      absentCandidate.attachment,
      absentCandidate.object,
    );
    await orchestrator.executeEventKey(absentOperation.eventKey);
    await expect(
      prisma.storageObject.findUnique({ where: { id: absentCandidate.object.id } }),
    ).resolves.toMatchObject({
      state: 'provider_unknown',
      providerType: null,
      bucket: null,
      region: null,
      localNamespace: null,
    });

    const transientCandidate = await createAttachmentObject({
      state: 'legacy_unverified',
      source: 'backfill',
      locator: OLD_LOCATOR,
    });
    const transientOperation = await createBackfillOperation(
      transientCandidate.attachment,
      transientCandidate.object,
    );
    provider.headFailureOnce = new Error('claimed provider timeout');
    await orchestrator.executeEventKey(transientOperation.eventKey);
    await expect(
      prisma.storageObject.findUnique({ where: { id: transientCandidate.object.id } }),
    ).resolves.toMatchObject({
      state: 'legacy_unverified',
      providerType: OLD_LOCATOR.providerType,
      bucket: OLD_LOCATOR.bucket,
      region: OLD_LOCATOR.region,
      localNamespace: null,
    });
  });

  it('builds delete snapshot from the row reread after the Attachment lock', async () => {
    const { attachment } = await createAttachmentObject();
    const committedUpdatedAt = new Date('2026-07-19T03:00:00.000Z');
    const holderReady = deferred();
    const holderRelease = deferred();
    const holder = prisma.$transaction(async (tx) => {
      await tx.attachment.update({
        where: { id: attachment.id },
        data: { description: 'concurrent patch', updatedAt: committedUpdatedAt },
      });
      holderReady.resolve();
      await holderRelease.promise;
    });
    await holderReady.promise;
    const preparing = orchestrator.prepareDelete({
      attachmentId: attachment.id,
      actorUserId: actorId,
      actorRoleSnap: Role.ADMIN,
      allowAuthorizedJoin: true,
      scope: 'other',
      deletedByPath: 'admin',
      auditMeta: { requestId: 'snapshot-lock-reread', ip: null, ua: null },
    });

    await waitForRelationLockWait('attachments');
    holderRelease.resolve();
    await withTimeout(holder, 'patch lock holder');
    const eventKey = await withTimeout(preparing, 'delete prepare');
    const operation = await prisma.storageObjectOperation.findUniqueOrThrow({
      where: { eventKey },
    });
    const payload = operation.payload as { response: { updatedAt: string } };
    // Mutation killed: constructing payload before the FOR UPDATE reread captures the old timestamp.
    expect(payload.response.updatedAt).toBe(committedUpdatedAt.toISOString());
  });

  it('authorized actor joins active delete; only original actor can replay after hard delete', async () => {
    const { attachment } = await createAttachmentObject();
    const first = await orchestrator.prepareDelete({
      attachmentId: attachment.id,
      actorUserId: actorId,
      actorRoleSnap: Role.ADMIN,
      allowAuthorizedJoin: true,
      scope: 'other',
      deletedByPath: 'admin',
      auditMeta: { requestId: 'delete-original', ip: null, ua: null },
    });
    const joined = await orchestrator.prepareDelete({
      attachmentId: attachment.id,
      actorUserId: actorTwoId,
      actorRoleSnap: Role.ADMIN,
      allowAuthorizedJoin: true,
      scope: 'other',
      deletedByPath: 'admin',
      auditMeta: { requestId: 'delete-join', ip: null, ua: null },
    });
    expect(joined).toBe(first);
    await expect(orchestrator.getDeleteReplay(attachment.id, actorTwoId)).resolves.toBeNull();
    await expect(
      orchestrator.getDeleteReplay(attachment.id, actorTwoId, { allowAuthorizedJoin: true }),
    ).resolves.toMatchObject({ state: 'pending', eventKey: first });

    provider.heads.set(attachment.key, { exists: false });
    await orchestrator.executeEventKey(first);
    // Same actor lost-response retry remains available for 24h.
    await expect(orchestrator.getDeleteReplay(attachment.id, actorId)).resolves.toMatchObject({
      state: 'succeeded',
      eventKey: first,
      response: { id: attachment.id },
    });
    // A new request sees no Attachment, cannot pass RBAC, and therefore cannot set join=true.
    await expect(orchestrator.getDeleteReplay(attachment.id, actorTwoId)).resolves.toBeNull();
  });

  it('directly inserted invalid actorRoleSnap is dead-lettered before provider/audit effects', async () => {
    const { attachment, object } = await createAttachmentObject({ state: 'delete_pending' });
    const payload = deletePayload(attachment);
    const requestHash = storageRequestHash({ operation: 'invalid-role', id: attachment.id });
    const operation = await prisma.storageObjectOperation.create({
      data: {
        eventKey: `storage.attachment-delete:${requestHash}`,
        storageObjectId: object.id,
        kind: 'attachment_delete',
        status: 'pending',
        effectState: 'not_started',
        payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
        payload: {
          ...payload,
          audit: { ...payload.audit, actorRoleSnap: 'ROOT_OPERATOR' },
        },
        requestHash,
        responseSnapshotExpiresAt: new Date(Date.now() + STORAGE_DELETE_REPLAY_TTL_MS),
      },
    });

    await orchestrator.executeEventKey(operation.eventKey);

    await expect(
      prisma.storageObjectOperation.findUnique({ where: { id: operation.id } }),
    ).resolves.toMatchObject({ status: 'dead' });
    await expect(
      prisma.storageObject.findUnique({ where: { id: object.id } }),
    ).resolves.toMatchObject({
      state: 'delete_failed',
    });
    await expect(
      prisma.attachment.findUnique({ where: { id: attachment.id } }),
    ).resolves.not.toBeNull();
    await expect(
      prisma.auditLog.count({ where: { resourceType: 'attachment', resourceId: attachment.id } }),
    ).resolves.toBe(0);
    expect(provider.heads.get(attachment.key)?.exists).toBe(true);
  });

  it.each([
    ['eventKey', { eventKey: 'target-event' }],
    ['objectKey', { objectKey: 'target-key' }],
    ['kind', { kind: 'manual_relocate' as const }],
    ['manualOnly', { manualOnly: true }],
  ])('targeted exhausted claim keeps unrelated processing op alive: %s', async (_name, scope) => {
    await prisma.storageObjectOperation.deleteMany();
    await prisma.storageObject.deleteMany();
    const expiredAt = new Date(Date.now() - 60_000);
    const targetObject = await prisma.storageObject.create({
      data: {
        key: 'target-key',
        state: 'provider_unknown',
        source: 'backfill',
        providerType: LOCATOR.providerType,
        bucket: LOCATOR.bucket,
        region: LOCATOR.region,
      },
    });
    const unrelatedObject = await prisma.storageObject.create({
      data: {
        key: 'unrelated-key',
        state: 'provider_unknown',
        source: 'backfill',
        providerType: LOCATOR.providerType,
        bucket: LOCATOR.bucket,
        region: LOCATOR.region,
      },
    });
    const targetKind = 'manual_relocate';
    const unrelatedKind = 'backfill_verify';
    const target = await prisma.storageObjectOperation.create({
      data: {
        eventKey: 'target-event',
        storageObjectId: targetObject.id,
        kind: targetKind,
        status: 'processing',
        effectState: 'not_started',
        payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
        payload: {},
        requestHash: 'a'.repeat(64),
        attempts: STORAGE_OPERATION_MAX_ATTEMPTS,
        leaseOwner: 'expired-worker',
        leaseGeneration: 1,
        leaseAcquiredAt: new Date(expiredAt.getTime() - 1_000),
        leaseExpiresAt: expiredAt,
      },
    });
    const unrelated = await prisma.storageObjectOperation.create({
      data: {
        eventKey: 'unrelated-event',
        storageObjectId: unrelatedObject.id,
        kind: unrelatedKind,
        status: 'processing',
        effectState: 'not_started',
        payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
        payload: {},
        requestHash: 'b'.repeat(64),
        attempts: STORAGE_OPERATION_MAX_ATTEMPTS,
        leaseOwner: 'expired-worker',
        leaseGeneration: 1,
        leaseAcquiredAt: new Date(expiredAt.getTime() - 1_000),
        leaseExpiresAt: expiredAt,
      },
    });

    await ledger.claim('targeted-claim-worker', { ...scope, now: new Date() });

    await expect(
      prisma.storageObjectOperation.findUnique({ where: { id: target.id } }),
    ).resolves.toMatchObject({ status: 'dead', lastErrorCode: 'MAX_ATTEMPTS_EXHAUSTED' });
    await expect(
      prisma.storageObjectOperation.findUnique({ where: { id: unrelated.id } }),
    ).resolves.toMatchObject({ status: 'processing', leaseOwner: 'expired-worker' });
  });
});
