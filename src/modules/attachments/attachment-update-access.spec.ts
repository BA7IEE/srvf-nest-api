import { Test, type TestingModule } from '@nestjs/testing';
import { Role, UserStatus, type Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import appConfig from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import { StorageSettingsService } from '../storage/storage-settings.service';
import { AttachmentAccessService, type SafeAttachment } from './attachment-access.service';
import { AttachmentContentUploadConfirmService } from './attachment-content-upload-confirm.service';
import { AttachmentStorageOrchestrator } from './attachment-storage-orchestrator';
import { AttachmentWriteService } from './attachment-write.service';

const STOP = 'STOP_BEFORE_DOWNLOAD_URL_RESOLUTION';
const actor: CurrentUserPayload = {
  id: 'synthetic-metadata-editor',
  username: 'synthetic-metadata-editor',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: 'synthetic-editor-member',
};
const row: SafeAttachment = {
  id: 'synthetic-attachment',
  key: 'synthetic-storage-key',
  ownerType: 'member',
  ownerId: 'synthetic-other-member',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  uploadedAt: new Date('2026-01-01T00:00:00.000Z'),
  uploadedBy: 'synthetic-uploader',
  originalName: 'synthetic-photo',
  mime: 'image/png',
  size: 1,
  description: null,
  accessLevel: null,
  tags: [],
  originalUploaderName: null,
  expireAt: null,
};

describe('attachment metadata update preserves independent file-view permission', () => {
  let module: TestingModule;

  afterEach(async () => {
    await module?.close();
  });

  async function harness(codes: readonly string[]) {
    const update = jest.fn(() => Promise.resolve({ ...row, description: 'changed' }));
    const query = jest.fn(() => Promise.resolve([{ id: row.id }]));
    const tx = {
      $queryRaw: query,
      attachment: { findUnique: jest.fn(() => Promise.resolve(row)), update },
      storageObject: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            key: row.key,
            resourceType: 'attachment',
            resourceId: row.id,
            state: 'available',
            deleteRequestedAt: null,
          }),
        ),
      },
    };
    const roleBindings = jest.fn((query: Prisma.RoleBindingFindManyArgs) => {
      if (
        query.where?.principalId !== actor.id ||
        query.where.principalType !== 'USER' ||
        query.where.scopeType !== 'GLOBAL'
      )
        throw new Error('UNEXPECTED_PERMISSION_QUERY');
      return Promise.resolve([
        { role: { rolePermissions: codes.map((code) => ({ permission: { code } })) } },
      ]);
    });
    const connect = jest.fn((): never => {
      throw new Error('DATABASE_CONNECTION_FORBIDDEN');
    });
    const prisma = {
      $connect: connect,
      roleBinding: { findMany: roleBindings },
      attachment: { findFirst: jest.fn(() => Promise.resolve(row)) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    };
    const resolveDownloadUrl = jest
      .fn<Promise<string | null>, [string, number]>()
      .mockRejectedValue(new Error(STOP));
    module = await Test.createTestingModule({
      providers: [
        RbacService,
        AttachmentAccessService,
        AttachmentWriteService,
        { provide: PrismaService, useValue: prisma },
        { provide: appConfig.KEY, useValue: { env: 'test' } },
        {
          provide: StorageSettingsService,
          useValue: {
            getActiveSettings: jest.fn(() => Promise.resolve({ downloadUrlTtlSeconds: 300 })),
          },
        },
        {
          provide: AttachmentStorageOrchestrator,
          useValue: {
            isMetadataVisible: jest.fn(() => Promise.resolve(true)),
            resolveDownloadUrl,
          },
        },
        { provide: AttachmentContentUploadConfirmService, useValue: {} },
      ],
    }).compile();
    return {
      rbac: module.get(RbacService),
      access: module.get(AttachmentAccessService),
      writes: module.get(AttachmentWriteService),
      update,
      query,
      resolveDownloadUrl,
      connect,
      roleBindings,
    };
  }

  it('first proves the throw-only URL interception and the real independent RBAC decisions', async () => {
    const h = await harness(['attachment.update.member.other']);
    await expect(h.resolveDownloadUrl(row.key, 300)).rejects.toThrow(STOP);
    expect(await h.rbac.can(actor, 'attachment.update.member.other')).toBe(true);
    expect(await h.rbac.can(actor, 'attachment.view.member.other')).toBe(false);
    expect(h.roleBindings.mock.calls[0]?.[0].where).toMatchObject({
      principalId: actor.id,
      principalType: 'USER',
      scopeType: 'GLOBAL',
    });
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('allows update-only metadata editing but never resolves file access without view', async () => {
    const h = await harness(['attachment.update.member.other']);
    await expect(
      h.access.assertReadAllowedOrThrowNotFound(actor, 'attachment.view.member.other', {
        ownerType: 'member',
        ownerId: row.ownerId,
      }),
    ).rejects.toMatchObject({ biz: { code: BizCode.ATTACHMENT_NOT_FOUND.code } });
    const result = await h.writes.update(row.id, { description: 'changed' }, actor);
    expect(result).toMatchObject({ id: row.id, description: 'changed', accessUrl: null });
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(h.resolveDownloadUrl).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('retains the existing response resolution when both update and view are granted', async () => {
    const h = await harness(['attachment.update.member.other', 'attachment.view.member.other']);
    // No signed URL is generated: the isolated resolver returns its legal nullable result.
    h.resolveDownloadUrl.mockResolvedValueOnce(null);
    const result = await h.writes.update(row.id, { description: 'changed' }, actor);
    expect(result).toMatchObject({ id: row.id, description: 'changed', accessUrl: null });
    expect(h.resolveDownloadUrl).toHaveBeenCalledTimes(1);
    expect(h.resolveDownloadUrl).toHaveBeenCalledWith(row.key, 300);
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('view alone cannot edit metadata or reach locks and URL resolution', async () => {
    const h = await harness(['attachment.view.member.other']);
    await expect(h.writes.update(row.id, { description: 'changed' }, actor)).rejects.toMatchObject({
      biz: { code: BizCode.RBAC_FORBIDDEN.code },
    });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
    expect(h.resolveDownloadUrl).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });
});
