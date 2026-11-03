import { Prisma, Role, UserStatus, type Content } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { PrismaService } from '../../database/prisma.service';
import type { AttachmentsService } from '../attachments/attachments.service';
import type { RbacService } from '../permissions/rbac.service';
import type { AppIdentityResolver } from '../users/app-identity.resolver';
import { ContentReadService } from './content-read.service';

const NOW = new Date('2026-11-03T00:00:00.000Z');
const READER: CurrentUserPayload = {
  id: 'reader',
  username: 'reader',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: 'member',
};

function content(): Content {
  return {
    id: 'content',
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    title: 'Public title',
    summary: null,
    body: 'Original public body',
    contentTypeCode: 'announcement',
    statusCode: 'published',
    visibilityCode: 'public',
    visibleOrganizationIds: [],
    tags: [],
    coverImageKey: null,
    coverAttachmentId: null,
    viewCount: 0,
    pinned: false,
    publishedAt: NOW,
    authorUserId: 'editor',
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function matches(where: Prisma.ContentWhereInput, row: Content): boolean {
  if (where.id !== undefined && where.id !== row.id) return false;
  if (where.deletedAt === null && row.deletedAt !== null) return false;
  if (typeof where.statusCode === 'string' && where.statusCode !== row.statusCode) return false;
  if (typeof where.visibilityCode === 'string' && where.visibilityCode !== row.visibilityCode)
    return false;
  if (where.OR && !where.OR.some((clause) => matches(clause, row))) return false;
  return true;
}

function fixture(options: { exists?: boolean; management?: boolean; pause?: boolean } = {}) {
  let row = content();
  const admitted = deferred();
  const release = deferred();
  const findFirst = jest.fn((input: Prisma.ContentFindFirstArgs) =>
    Promise.resolve(
      options.exists === false || !matches(input.where ?? {}, row) ? null : structuredClone(row),
    ),
  );
  const update = jest.fn(async (input: Prisma.ContentUpdateArgs) => {
    admitted.resolve();
    if (options.pause) await release.promise;
    if (!matches(input.where, row)) {
      throw new Prisma.PrismaClientKnownRequestError('No matching content', {
        code: 'P2025',
        clientVersion: 'test',
      });
    }
    expect(input.data).toEqual({ viewCount: { increment: 1 } });
    row.viewCount += 1;
    return structuredClone(row);
  });
  const attachments = {
    listOwnerAttachmentsTrusted: jest.fn(() => Promise.resolve([])),
    resolveSignedUrlTrusted: jest.fn(() => Promise.resolve(null)),
  };
  const prisma = {
    content: { findFirst, update },
    memberOrganizationMembership: { findMany: jest.fn(() => Promise.resolve([])) },
  };
  const rbac = { can: jest.fn(() => Promise.resolve(options.management === true)) };
  const identity = {
    resolve: jest.fn(() =>
      Promise.resolve({
        canUseApp: true,
        member: { id: 'member', gradeCode: 'level-1' },
      }),
    ),
  };
  return {
    service: new ContentReadService(
      prisma as unknown as PrismaService,
      rbac as unknown as RbacService,
      identity as unknown as AppIdentityResolver,
      attachments as unknown as AttachmentsService,
    ),
    admitted,
    release,
    update,
    attachments,
    current: () => structuredClone(row),
    change: (patch: Partial<Content>) => {
      row = { ...row, ...patch };
    },
  };
}

describe('ContentReadService visibility and PV share one eligible row', () => {
  it('keeps a normal public read and increments PV once', async () => {
    const f = fixture();
    await expect(f.service.publicDetail('content')).resolves.toMatchObject({
      body: 'Original public body',
      visibilityCode: 'public',
      viewCount: 1,
    });
    expect(f.current().viewCount).toBe(1);
  });

  it('keeps a currently authorized management reader eligible', async () => {
    const f = fixture({ management: true });
    f.change({ visibilityCode: 'management', body: 'Management body' });
    await expect(f.service.appDetail(READER, 'content')).resolves.toMatchObject({
      body: 'Management body',
      visibilityCode: 'management',
      viewCount: 1,
    });
  });

  it.each(['missing', 'management', 'draft', 'deleted'] as const)(
    'keeps initial %s content hidden without PV or attachment projection',
    async (state) => {
      const f = fixture({ exists: state !== 'missing' });
      if (state === 'management') f.change({ visibilityCode: 'management' });
      if (state === 'draft') f.change({ statusCode: 'draft' });
      if (state === 'deleted') f.change({ deletedAt: NOW });
      await expect(f.service.publicDetail('content')).rejects.toMatchObject({
        biz: BizCode.CONTENT_NOT_FOUND,
      });
      expect(f.current().viewCount).toBe(0);
      expect(f.attachments.listOwnerAttachmentsTrusted).not.toHaveBeenCalled();
    },
  );

  it.each(['anonymous', 'member'] as const)(
    'rejects the %s old-public/new-private race without counting PV',
    async (reader) => {
      const f = fixture({ pause: true });
      const reading =
        reader === 'anonymous'
          ? f.service.publicDetail('content')
          : f.service.appDetail(READER, 'content');
      const outcome = reading.then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );
      try {
        await f.admitted.promise;
        f.change({ visibilityCode: 'management', body: 'Never public replacement body' });
        f.release.resolve();
        const result = await outcome;
        expect(result.value).toBeNull();
        expect(result.error).toMatchObject({ biz: BizCode.CONTENT_NOT_FOUND });
        expect(f.current().viewCount).toBe(0);
        expect(f.attachments.listOwnerAttachmentsTrusted).not.toHaveBeenCalled();
        expect(f.attachments.resolveSignedUrlTrusted).not.toHaveBeenCalled();
      } finally {
        f.release.resolve();
        await outcome;
      }
    },
  );

  it('preserves unrelated database failures', async () => {
    const f = fixture();
    const failure = new Error('database unavailable');
    f.update.mockRejectedValueOnce(failure);
    await expect(f.service.publicDetail('content')).rejects.toBe(failure);
    expect(f.attachments.listOwnerAttachmentsTrusted).not.toHaveBeenCalled();
  });
});
