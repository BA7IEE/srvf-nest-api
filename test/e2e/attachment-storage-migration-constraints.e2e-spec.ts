import type { INestApplication } from '@nestjs/common';
import { Role, StorageProviderType, UserStatus } from '@prisma/client';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

describe('attachment storage migration constraints', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let actorId: string;
  let sequence = 0;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    actorId = (
      await prisma.user.create({
        data: {
          username: 'storage-migration-constraint-actor',
          passwordHash: '$2a$10$attachment-storage-migration-e2e',
          role: Role.ADMIN,
          status: UserStatus.ACTIVE,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.storageObjectOperation.deleteMany();
    await prisma.storageObject.deleteMany();
    await prisma.attachment.deleteMany();
    await prisma.storageSettings.deleteMany();
  });

  function key(label: string): string {
    sequence += 1;
    return `attachments/migration-constraint/${label}-${sequence}.txt`;
  }

  async function concreteObject(label: string) {
    return prisma.storageObject.create({
      data: {
        key: key(label),
        state: 'pending_upload',
        source: 'attachment_signed_upload',
        providerType: StorageProviderType.COS,
        bucket: 'constraint-bucket',
        region: 'ap-test',
      },
    });
  }

  it('rejects missing locator for new objects and available backfill objects', async () => {
    // Mutations killed: `providerType IS NULL OR ...` and a state-agnostic transition escape.
    await expect(
      prisma.storageObject.create({
        data: {
          key: key('new-without-locator'),
          state: 'pending_upload',
          source: 'attachment_signed_upload',
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.storageObject.create({
        data: {
          key: key('available-without-size-evidence'),
          state: 'available',
          source: 'attachment_signed_upload',
          providerType: StorageProviderType.COS,
          bucket: 'constraint-bucket',
          region: 'ap-test',
          resourceType: 'attachment',
          resourceId: 'attachment_candidate_without_size',
          verifiedAt: new Date(),
          presentAt: new Date(),
          lastProviderCheckedAt: new Date(),
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.storageObject.create({
        data: {
          key: key('available-without-locator'),
          state: 'available',
          source: 'backfill',
          resourceType: 'attachment',
          resourceId: 'attachment_candidate_1',
          verifiedAt: new Date(),
          presentAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects LOCAL null/empty namespace outside the exact provider_unknown backfill exception', async () => {
    await expect(
      prisma.storageObject.create({
        data: {
          key: key('local-new-null'),
          state: 'pending_upload',
          source: 'attachment_signed_upload',
          providerType: StorageProviderType.LOCAL,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.storageObject.create({
        data: {
          key: key('local-legacy-null'),
          state: 'legacy_unverified',
          source: 'backfill',
          providerType: StorageProviderType.LOCAL,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.storageObject.create({
        data: {
          key: key('local-new-empty'),
          state: 'pending_upload',
          source: 'attachment_signed_upload',
          providerType: StorageProviderType.LOCAL,
          localNamespace: '',
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.storageObject.create({
        data: {
          key: key('local-backfill-transition'),
          state: 'provider_unknown',
          source: 'backfill',
          providerType: StorageProviderType.LOCAL,
        },
      }),
    ).resolves.toMatchObject({
      state: 'provider_unknown',
      source: 'backfill',
      providerType: StorageProviderType.LOCAL,
      localNamespace: null,
    });
  });

  it('allows only the all-null backfill/provider_unknown locator for provider-agnostic JIT candidates', async () => {
    await expect(
      prisma.storageObject.create({
        data: {
          key: key('provider-agnostic-candidate'),
          state: 'provider_unknown',
          source: 'backfill',
        },
      }),
    ).resolves.toMatchObject({
      state: 'provider_unknown',
      source: 'backfill',
      providerType: null,
      bucket: null,
      region: null,
      localNamespace: null,
    });

    await expect(
      prisma.storageObject.create({
        data: {
          key: key('provider-agnostic-half-locator'),
          state: 'provider_unknown',
          source: 'backfill',
          bucket: 'must-not-survive',
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.storageObject.create({
        data: {
          key: key('new-writer-provider-unknown'),
          state: 'provider_unknown',
          source: 'attachment_signed_upload',
        },
      }),
    ).rejects.toThrow();
  });

  it('requires integrity_mismatch to retain a concrete locator, Attachment identity and error evidence', async () => {
    const now = new Date();
    await expect(
      prisma.storageObject.create({
        data: {
          key: key('integrity-mismatch-valid'),
          state: 'integrity_mismatch',
          source: 'attachment_signed_upload',
          providerType: StorageProviderType.COS,
          bucket: 'constraint-bucket',
          region: 'ap-test',
          resourceType: 'attachment',
          resourceId: 'attachment_integrity_valid',
          expectedSize: 1n,
          actualSize: 1n,
          verifiedAt: now,
          presentAt: now,
          lastProviderCheckedAt: now,
          lastErrorCode: 'STORAGE_OBJECT_INTEGRITY_MISMATCH',
          lastErrorClass: 'StorageObjectIntegrityMismatchError',
        },
      }),
    ).resolves.toMatchObject({ state: 'integrity_mismatch' });

    await expect(
      prisma.storageObject.create({
        data: {
          key: key('integrity-mismatch-no-locator'),
          state: 'integrity_mismatch',
          source: 'backfill',
          resourceType: 'attachment',
          resourceId: 'attachment_integrity_no_locator',
          expectedSize: 1n,
          actualSize: 1n,
          verifiedAt: now,
          presentAt: now,
          lastProviderCheckedAt: now,
          lastErrorCode: 'STORAGE_OBJECT_INTEGRITY_MISMATCH',
          lastErrorClass: 'StorageObjectIntegrityMismatchError',
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.storageObject.create({
        data: {
          key: key('integrity-mismatch-no-resource'),
          state: 'integrity_mismatch',
          source: 'attachment_signed_upload',
          providerType: StorageProviderType.COS,
          bucket: 'constraint-bucket',
          region: 'ap-test',
          expectedSize: 1n,
          actualSize: 1n,
          verifiedAt: now,
          presentAt: now,
          lastProviderCheckedAt: now,
          lastErrorCode: 'STORAGE_OBJECT_INTEGRITY_MISMATCH',
          lastErrorClass: 'StorageObjectIntegrityMismatchError',
        },
      }),
    ).rejects.toThrow();
  });

  it('requires delete replay expiry and forbids expiry/purge fields on other kinds', async () => {
    const deleteObject = await concreteObject('delete-no-expiry');
    await expect(
      prisma.storageObjectOperation.create({
        data: {
          eventKey: `storage.constraint-delete:${sequence}`,
          storageObjectId: deleteObject.id,
          kind: 'attachment_delete',
          status: 'pending',
          effectState: 'not_started',
          payloadVersion: 1,
          payload: {},
          requestHash: 'a'.repeat(64),
          responseSnapshotExpiresAt: null,
        },
      }),
    ).rejects.toThrow();

    const backfillObject = await concreteObject('backfill-with-expiry');
    await expect(
      prisma.storageObjectOperation.create({
        data: {
          eventKey: `storage.constraint-backfill:${sequence}`,
          storageObjectId: backfillObject.id,
          kind: 'backfill_verify',
          status: 'pending',
          effectState: 'not_started',
          payloadVersion: 1,
          payload: { attachmentId: 'attachment_candidate_2' },
          requestHash: 'b'.repeat(64),
          responseSnapshotExpiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects responsePurgedAt before the delete snapshot expiry', async () => {
    const object = await concreteObject('purged-before-expiry');
    const expiresAt = new Date(Date.now() + 60_000);
    await expect(
      prisma.storageObjectOperation.create({
        data: {
          eventKey: `storage.constraint-purge:${sequence}`,
          storageObjectId: object.id,
          kind: 'attachment_delete',
          status: 'pending',
          effectState: 'not_started',
          payloadVersion: 1,
          payload: {},
          requestHash: 'c'.repeat(64),
          responseSnapshotExpiresAt: expiresAt,
          responsePurgedAt: new Date(expiresAt.getTime() - 1),
        },
      }),
    ).rejects.toThrow();
  });

  it('documents the expand-phase gap: DB-direct Attachment writer is not yet FK constrained', async () => {
    const attachment = await prisma.attachment.create({
      data: {
        key: key('old-writer-gap'),
        originalName: 'old-writer.txt',
        mime: 'text/plain',
        size: 1,
        uploadedBy: actorId,
        ownerType: 'member',
        ownerId: 'member_old_writer',
        tags: [],
      },
    });

    await expect(prisma.storageObject.count({ where: { key: attachment.key } })).resolves.toBe(0);
  });

  it.each([
    ['no-settings', null, null, false],
    ['bucket-only', 'partial-bucket', null, true],
    ['region-only', null, 'partial-region', true],
  ])(
    'actual migration backfill normalizes absent/partial COS locator to all-null provider_unknown: %s',
    async (_label, bucket, region, createSettings) => {
      if (createSettings) {
        await prisma.storageSettings.create({
          data: { providerType: StorageProviderType.COS, bucket, region },
        });
      }
      const attachment = await prisma.attachment.create({
        data: {
          key: key('partial-cos-backfill'),
          originalName: 'partial-cos.txt',
          mime: 'text/plain',
          size: 1,
          uploadedBy: actorId,
          ownerType: 'member',
          ownerId: 'member_partial_cos',
          tags: [],
        },
      });
      const migration = await readFile(
        path.resolve(
          process.cwd(),
          'prisma/migrations/20260718233000_attachment_storage_operations/migration.sql',
        ),
        'utf8',
      );
      const insertStart = migration.indexOf('INSERT INTO "storage_objects" (');
      const insertEnd = migration.indexOf('\n\n-- 每条历史 Attachment', insertStart);
      if (insertStart < 0 || insertEnd < 0) {
        throw new Error('storage object backfill statement markers disappeared');
      }

      // Execute the migration's actual INSERT against real CHECK constraints. If either CASE
      // preserves the half locator, deploy fails here exactly as it would in migrate deploy.
      await prisma.$executeRawUnsafe(migration.slice(insertStart, insertEnd).trim());

      await expect(
        prisma.storageObject.findUnique({ where: { key: attachment.key } }),
      ).resolves.toMatchObject({
        state: 'provider_unknown',
        source: 'backfill',
        providerType: null,
        bucket: null,
        region: null,
        localNamespace: null,
      });
    },
  );
});
