import { createHash } from 'node:crypto';

import { Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RegistrationUploadSessionService } from './registration-upload-session.service';

const USER: CurrentUserPayload = {
  id: 'upload-user-1',
  username: 'upload-user',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: 'upload-member-1',
};
const META: AuditMeta = { requestId: 'upload-unit', ip: null, ua: null };
const TOKEN = 'one-time-raw-token';

function liveActivity() {
  return {
    statusCode: 'published',
    isPublicRegistration: true,
    registrationDeadline: new Date('2099-01-01T00:00:00.000Z'),
    endAt: new Date('2099-01-02T00:00:00.000Z'),
  };
}

function activeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'upload-session-1',
    activityId: 'upload-activity-1',
    memberId: 'upload-member-1',
    formVersionId: 'upload-form-1',
    tokenHash: createHash('sha256').update(TOKEN, 'utf8').digest('hex'),
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    statusCode: 'active',
    ...overrides,
  };
}

function harness(options: { session?: Record<string, unknown>; existing?: unknown } = {}) {
  let transactionDepth = 0;
  const calls: string[] = [];
  const session = options.session ?? activeSession();
  const tx = {
    $queryRaw: jest.fn().mockImplementation(async (query: { strings?: readonly string[] }) => {
      const text = query.strings?.join('') ?? '';
      if (text.includes('"Activity"')) return [{ id: 'upload-activity-1' }];
      return [session];
    }),
    activity: { findFirst: jest.fn().mockResolvedValue(liveActivity()) },
    registrationFormVersion: { findFirst: jest.fn().mockResolvedValue({ id: 'upload-form-1' }) },
    registrationUploadSession: {
      create: jest.fn().mockResolvedValue({ id: 'upload-session-created', expiresAt: new Date('2099-01-01T00:00:00.000Z') }),
    },
    attachment: { findFirst: jest.fn().mockResolvedValue(options.existing ?? null) },
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (value: typeof tx) => Promise<unknown>) => {
      transactionDepth += 1;
      calls.push('transaction-open');
      try {
        return await callback(tx);
      } finally {
        calls.push('transaction-close');
        transactionDepth -= 1;
      }
    }),
    attachment: { findFirst: jest.fn().mockResolvedValue(options.existing ?? null) },
  };
  const attachments = {
    validateRegistrationUploadOutsideTransactionTrusted: jest.fn().mockImplementation(async () => {
      expect(transactionDepth).toBe(0);
      calls.push('validate');
      return { opaque: 'validated' };
    }),
    prepareRegistrationUploadInTransactionTrusted: jest.fn().mockImplementation(async () => {
      expect(transactionDepth).toBe(1);
      calls.push('prepare');
      return { opaque: 'prepared' };
    }),
    putRegistrationUploadAndVerifyOutsideTransactionTrusted: jest.fn().mockImplementation(async () => {
      expect(transactionDepth).toBe(0);
      calls.push('provider');
      return { opaque: 'verified' };
    }),
    finalizeRegistrationUploadInTransactionTrusted: jest.fn().mockImplementation(async () => {
      expect(transactionDepth).toBe(1);
      calls.push('finalize');
      return { opaque: 'finalized' };
    }),
    registrationUploadResponseTrusted: jest.fn().mockReturnValue({
      attachmentId: 'attachment-1',
      originalName: 'proof.png',
      mime: 'image/png',
      size: 12,
      createdAt: new Date('2099-01-01T00:00:00.000Z'),
    }),
  };
  const policy = { canRegisterSelf: jest.fn().mockReturnValue({ allowed: true }) };
  return {
    service: new RegistrationUploadSessionService(prisma as never, policy as never, attachments as never),
    tx,
    prisma,
    attachments,
    policy,
    calls,
  };
}

function file() {
  return {
    originalName: 'proof.png',
    mime: 'image/png',
    size: 12,
    buffer: Buffer.from('89504e470d0a1a0a00000000', 'hex'),
  };
}

describe('RegistrationUploadSessionService', () => {
  it('returns a raw CSPRNG token only once while storing only its SHA-256 hash', async () => {
    const { service, tx } = harness();
    tx.registrationFormVersion.findFirst.mockResolvedValue({ id: 'upload-form-1', version: 6 });
    const created = await service.create('upload-activity-1', USER, 'upload-member-1');

    const persisted = tx.registrationUploadSession.create.mock.calls[0]?.[0].data;
    expect(created).toEqual({
      id: 'upload-session-created',
      token: expect.stringMatching(/^[A-Za-z0-9_-]{40,}$/),
      expiresAt: expect.any(Date),
      formVersion: 6,
    });
    expect(persisted.tokenHash).toBe(
      createHash('sha256').update(created.token, 'utf8').digest('hex'),
    );
    expect(persisted.tokenHash).not.toBe(created.token);
    expect(created.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 60 * 1000);
  });

  it('delegates published/window/public-registration eligibility to ActivityParticipationPolicy', async () => {
    const { service, tx, policy } = harness();
    tx.activity.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      expect(where.statusCode).toBeUndefined();
      return { ...liveActivity(), statusCode: 'draft' };
    });
    policy.canRegisterSelf.mockReturnValue({
      allowed: false,
      biz: BizCode.ACTIVITY_NOT_PUBLISHED_PARTICIPATION_FORBIDDEN,
    });

    await expect(service.create('upload-activity-1', USER, 'upload-member-1')).rejects.toEqual(
      new BizException(BizCode.ACTIVITY_NOT_PUBLISHED_PARTICIPATION_FORBIDDEN),
    );
    expect(tx.registrationUploadSession.create).not.toHaveBeenCalled();
  });

  it('refuses session creation when the current active Form has no file question', async () => {
    const { service, tx } = harness();
    tx.registrationFormVersion.findFirst.mockResolvedValue(null);

    await expect(service.create('upload-activity-1', USER, 'upload-member-1')).rejects.toEqual(
      new BizException(BizCode.ATTACHMENT_NOT_FOUND),
    );
    expect(tx.registrationUploadSession.create).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong member', activeSession({ memberId: 'someone-else' }), 'upload-member-1'],
    ['wrong route activity', activeSession({ activityId: 'other-activity' }), 'upload-member-1'],
    ['expired', activeSession({ expiresAt: new Date('2000-01-01T00:00:00.000Z') }), 'upload-member-1'],
    ['revoked', activeSession({ statusCode: 'revoked' }), 'upload-member-1'],
  ])('%s short-circuits as 13001 before attachment/provider/audit work', async (_label, session, memberId) => {
    const { service, attachments } = harness({ session });

    await expect(
      service.upload({
        activityId: 'upload-activity-1',
        sessionId: 'upload-session-1',
        token: TOKEN,
        file: file(),
        user: USER,
        memberId,
        auditMeta: META,
      }),
    ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));

    expect(attachments.validateRegistrationUploadOutsideTransactionTrusted).not.toHaveBeenCalled();
    expect(attachments.prepareRegistrationUploadInTransactionTrusted).not.toHaveBeenCalled();
    expect(attachments.putRegistrationUploadAndVerifyOutsideTransactionTrusted).not.toHaveBeenCalled();
    expect(attachments.finalizeRegistrationUploadInTransactionTrusted).not.toHaveBeenCalled();
  });

  it('replays existing safe metadata without making a second attachment/provider attempt', async () => {
    const existing = {
      id: 'attachment-winner',
      originalName: 'proof.png',
      mime: 'image/png',
      size: 12,
      createdAt: new Date('2099-01-01T00:00:00.000Z'),
    };
    const { service, attachments } = harness({ existing });

    await expect(
      service.upload({
        activityId: 'upload-activity-1',
        sessionId: 'upload-session-1',
        token: TOKEN,
        file: file(),
        user: USER,
        memberId: 'upload-member-1',
        auditMeta: META,
      }),
    ).resolves.toEqual({
      attachmentId: 'attachment-winner',
      originalName: 'proof.png',
      mime: 'image/png',
      size: 12,
      createdAt: existing.createdAt,
    });
    expect(attachments.validateRegistrationUploadOutsideTransactionTrusted).not.toHaveBeenCalled();
    expect(attachments.putRegistrationUploadAndVerifyOutsideTransactionTrusted).not.toHaveBeenCalled();
  });

  it('does validation and Provider work outside the three caller transactions, then finalizes exactly once', async () => {
    const { service, attachments, calls } = harness();

    await expect(
      service.upload({
        activityId: 'upload-activity-1',
        sessionId: 'upload-session-1',
        token: TOKEN,
        file: file(),
        user: USER,
        memberId: 'upload-member-1',
        auditMeta: META,
      }),
    ).resolves.toMatchObject({ attachmentId: 'attachment-1', mime: 'image/png' });

    expect(calls).toEqual([
      'transaction-open',
      'transaction-close',
      'validate',
      'transaction-open',
      'prepare',
      'transaction-close',
      'provider',
      'transaction-open',
      'finalize',
      'transaction-close',
    ]);
    expect(attachments.finalizeRegistrationUploadInTransactionTrusted).toHaveBeenCalledTimes(1);
  });
});
