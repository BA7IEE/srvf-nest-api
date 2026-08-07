import { createHash } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Prisma } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { RegistrationUploadSessionService } from '../../src/modules/activity-registrations/registration-upload-session.service';
import { attachmentBytesForMime, VALID_PNG_IMAGE } from '../helpers/file-fixtures';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const MAX_BYTES = 10 * 1024 * 1024;

function objectKeys(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected response data to be an object');
  }
  return Object.keys(value);
}

describe('activity batch4 one-time registration upload sessions', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerAuth: string;
  let otherAuth: string;
  let ownerMemberId: string;
  let activityId: string;
  let otherActivityId: string;
  let formVersionId: string;

  const createPath = () => `/api/app/v1/activities/${activityId}/registration-upload-sessions`;
  const uploadPath = (sessionId: string, routeActivityId = activityId) =>
    `/api/app/v1/activities/${routeActivityId}/registration-upload-sessions/${sessionId}/files`;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    const org = await prisma.organization.create({
      data: { name: 'Batch4 Upload Runtime', nodeTypeCode: 'team', sortOrder: 0 },
      select: { id: true },
    });
    const owner = await createTestUser(app, { username: 'batch4-upload-owner' });
    const other = await createTestUser(app, { username: 'batch4-upload-other' });
    const [ownerMember, otherMember] = await Promise.all([
      prisma.member.create({
        data: {
          memberNo: 'B4UPLOAD-OWNER',
          displayName: 'Upload Owner',
          gradeCode: 'L1',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      }),
      prisma.member.create({
        data: {
          memberNo: 'B4UPLOAD-OTHER',
          displayName: 'Upload Other',
          gradeCode: 'L1',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      }),
    ]);
    ownerMemberId = ownerMember.id;
    await Promise.all([
      prisma.user.update({ where: { id: owner.id }, data: { memberId: ownerMember.id } }),
      prisma.user.update({ where: { id: other.id }, data: { memberId: otherMember.id } }),
    ]);
    ownerAuth = (await loginAs(app, owner.username)).authHeader;
    otherAuth = (await loginAs(app, other.username)).authHeader;

    const baseActivity = {
      activityTypeCode: 'training',
      organizationId: org.id,
      startAt: new Date('2099-11-01T08:00:00.000Z'),
      endAt: new Date('2099-11-01T12:00:00.000Z'),
      registrationDeadline: new Date('2099-10-31T23:59:59.000Z'),
      location: 'Upload Test Field',
      statusCode: 'published',
      isPublicRegistration: true,
      publishedAt: new Date(),
    };
    const [activity, otherActivity] = await Promise.all([
      prisma.activity.create({
        data: { ...baseActivity, title: 'Batch4 Upload' },
        select: { id: true },
      }),
      prisma.activity.create({
        data: { ...baseActivity, title: 'Batch4 Other Upload Activity' },
        select: { id: true },
      }),
    ]);
    activityId = activity.id;
    otherActivityId = otherActivity.id;
    const version = await prisma.registrationFormVersion.create({
      data: {
        activityId,
        version: 1,
        statusCode: 'active',
        workflowRevision: 1,
        schemaHash: 'a'.repeat(64),
        activatedAt: new Date(),
        fields: {
          create: {
            fieldCode: 'proof',
            typeCode: 'file',
            label: '报名资质证明',
            required: false,
            visibilityCode: 'self_only',
            exportable: false,
            sortOrder: 1,
            optionsJson: Prisma.DbNull,
          },
        },
      },
      select: { id: true },
    });
    formVersionId = version.id;
    await prisma.attachmentTypeConfig.create({
      data: {
        code: 'registration-upload-session',
        displayName: '报名会话附件',
        ownerTable: 'registration_upload_sessions',
        defaultMaxSizeBytes: MAX_BYTES,
        defaultMimeWhitelist: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  async function createSession() {
    const response = await request(httpServer(app))
      .post(createPath())
      .set('Authorization', ownerAuth);
    expect(response.status).toBe(201);
    expect(objectKeys(response.body.data).sort()).toEqual([
      'expiresAt',
      'formVersion',
      'id',
      'token',
    ]);
    expect(response.body.data.formVersion).toBe(1);
    return response.body.data as {
      id: string;
      token: string;
      expiresAt: string;
      formVersion: number;
    };
  }

  function upload(
    sessionId: string,
    token: string,
    options: {
      auth?: string;
      activity?: string;
      mime?: string;
      filename?: string;
      body?: Buffer;
    } = {},
  ) {
    return request(httpServer(app))
      .post(uploadPath(sessionId, options.activity ?? activityId))
      .set('Authorization', options.auth ?? ownerAuth)
      .field('token', token)
      .attach('file', options.body ?? VALID_PNG_IMAGE, {
        filename: options.filename ?? 'proof.png',
        contentType: options.mime ?? 'image/png',
      });
  }

  it('returns a raw token once, stores only a SHA-256 hash, and short-circuits wrong member/route before attachment work', async () => {
    const session = await createSession();
    const stored = await prisma.registrationUploadSession.findUniqueOrThrow({
      where: { id: session.id },
      select: {
        tokenHash: true,
        memberId: true,
        activityId: true,
        formVersionId: true,
        statusCode: true,
      },
    });
    expect(stored).toEqual({
      tokenHash: createHash('sha256').update(session.token, 'utf8').digest('hex'),
      memberId: ownerMemberId,
      activityId,
      formVersionId,
      statusCode: 'active',
    });
    expect(stored.tokenHash).not.toBe(session.token);

    expectBizError(
      await upload(session.id, session.token, { auth: otherAuth }),
      BizCode.ATTACHMENT_NOT_FOUND,
    );
    expectBizError(
      await upload(session.id, session.token, { activity: otherActivityId }),
      BizCode.ATTACHMENT_NOT_FOUND,
    );
    expect(
      await prisma.attachment.count({
        where: { ownerType: 'registration-upload-session', ownerId: session.id },
      }),
    ).toBe(0);
  });

  it('accepts each exact MIME through the backend relay and never leaks key/URL/owner/token storage fields', async () => {
    for (const [mime, filename] of [
      ['image/jpeg', 'proof.jpg'],
      ['image/png', 'proof.png'],
      ['image/webp', 'proof.webp'],
      ['application/pdf', 'proof.pdf'],
    ] as const) {
      const session = await createSession();
      const response = await upload(session.id, session.token, {
        mime,
        filename,
        body: attachmentBytesForMime(mime, 64),
      });
      expect(response.status).toBe(200);
      expect(objectKeys(response.body.data).sort()).toEqual([
        'attachmentId',
        'createdAt',
        'mime',
        'originalName',
        'size',
      ]);
      expect(response.body.data).toMatchObject({ mime, originalName: filename, size: 64 });
      expect(JSON.stringify(response.body.data)).not.toMatch(
        /key|accessUrl|signed|ownerType|ownerId|tokenHash|locator/i,
      );
    }
  });

  it('rejects 10 MiB + 1 byte in multipart before the upload service', async () => {
    const uploadSpy = jest.spyOn(app.get(RegistrationUploadSessionService), 'upload');
    try {
      const oversized = await createSession();
      expectBizError(
        await upload(oversized.id, oversized.token, {
          filename: 'parser-too-large.png',
          body: attachmentBytesForMime('image/png', MAX_BYTES + 1),
        }),
        BizCode.ATTACHMENT_SIZE_EXCEEDED,
      );
      expect(uploadSpy).not.toHaveBeenCalled();
    } finally {
      uploadSpy.mockRestore();
    }
  });

  it('allows exactly 10 MiB through multipart into normal upload validation', async () => {
    const uploadSpy = jest.spyOn(app.get(RegistrationUploadSessionService), 'upload');
    try {
      const exactLimit = await createSession();
      const response = await upload(exactLimit.id, exactLimit.token, {
        filename: 'parser-exact-limit.png',
        body: attachmentBytesForMime('image/png', MAX_BYTES),
      });
      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        mime: 'image/png',
        originalName: 'parser-exact-limit.png',
        size: MAX_BYTES,
      });
      expect(uploadSpy).toHaveBeenCalledTimes(1);
    } finally {
      uploadSpy.mockRestore();
    }
  });

  it('rejects expiry, revocation, retired Form, oversize, and magic mismatch with existing codes before a bind', async () => {
    const expired = await createSession();
    await prisma.registrationUploadSession.update({
      where: { id: expired.id },
      data: { expiresAt: new Date('2000-01-01T00:00:00.000Z') },
    });
    expectBizError(await upload(expired.id, expired.token), BizCode.ATTACHMENT_NOT_FOUND);

    const revoked = await createSession();
    await prisma.registrationUploadSession.update({
      where: { id: revoked.id },
      data: { statusCode: 'revoked' },
    });
    expectBizError(await upload(revoked.id, revoked.token), BizCode.ATTACHMENT_NOT_FOUND);

    const retired = await createSession();
    await prisma.registrationFormVersion.update({
      where: { id: formVersionId },
      data: { statusCode: 'retired', retiredAt: new Date() },
    });
    expectBizError(await upload(retired.id, retired.token), BizCode.ATTACHMENT_NOT_FOUND);
    await prisma.registrationFormVersion.update({
      where: { id: formVersionId },
      data: { statusCode: 'active', retiredAt: null },
    });

    const oversized = await createSession();
    expectBizError(
      await upload(oversized.id, oversized.token, {
        filename: 'large.png',
        body: Buffer.alloc(MAX_BYTES + 1),
      }),
      BizCode.ATTACHMENT_SIZE_EXCEEDED,
    );
    const forged = await createSession();
    expectBizError(
      await upload(forged.id, forged.token, {
        filename: 'forged.png',
        body: Buffer.from('not a PNG', 'utf8'),
      }),
      BizCode.ATTACHMENT_CONTENT_TYPE_MISMATCH,
    );
  });

  it('keeps the session active and makes concurrent duplicate uploads converge on one safe attachment', async () => {
    const session = await createSession();
    const [first, second] = await Promise.all([
      upload(session.id, session.token, { body: VALID_PNG_IMAGE }),
      upload(session.id, session.token, { body: VALID_PNG_IMAGE }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.data).toMatchObject({ mime: 'image/png', originalName: 'proof.png' });
    expect(second.body.data).toEqual(first.body.data);
    expect(
      await prisma.attachment.count({
        where: { ownerType: 'registration-upload-session', ownerId: session.id },
      }),
    ).toBe(1);
    expect(
      await prisma.registrationUploadSession.findUniqueOrThrow({
        where: { id: session.id },
        select: { statusCode: true, consumedAt: true },
      }),
    ).toEqual({ statusCode: 'active', consumedAt: null });
  });
});
