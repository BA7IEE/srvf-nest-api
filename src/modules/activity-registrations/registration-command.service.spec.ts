import { Prisma, Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import { ActivityParticipationPolicy } from '../activities/activity-participation-policy';
import type { AttachmentsService } from '../attachments/attachments.service';
import type { AppIdentityResolver } from '../users/app-identity.resolver';
import type { ActivityRegistrationAuditRecorder } from './activity-registration-audit-recorder';
import type { AppActivityRegistrationCommandDto } from './dto/app/app-activity-registration-command.dto';
import { hashRegistrationCommand } from './registration-command-hash';
import { RegistrationCommandService } from './registration-command.service';

const NOW = new Date('2099-01-01T00:00:00.000Z');

function user(): CurrentUserPayload {
  return {
    id: 'user-1',
    username: 'user',
    role: Role.USER,
    status: UserStatus.ACTIVE,
    memberId: 'member-1',
  };
}

function command(
  overrides: Partial<AppActivityRegistrationCommandDto> = {},
): AppActivityRegistrationCommandDto {
  return {
    operationKey: 'operation-1',
    formVersion: null,
    answers: [],
    preferences: [],
    ...overrides,
  };
}

function makeTx() {
  const tx = {
    $queryRaw: jest
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'activity-1',
          statusCode: 'published',
          isPublicRegistration: true,
          registrationDeadline: null,
          endAt: new Date('2099-12-31T00:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'member-1', status: 'ACTIVE', deletedAt: null }])
      .mockResolvedValueOnce([{ id: 'user-1', status: 'ACTIVE', deletedAt: null }]),
    activityRegistrationRevision: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'registration-revision-1', submittedAt: NOW }),
    },
    registrationFormVersion: { findFirst: jest.fn().mockResolvedValue(null) },
    activityRegistration: {
      create: jest.fn().mockResolvedValue({ id: 'registration-1', currentRevision: 0 }),
      update: jest.fn().mockResolvedValue({}),
    },
    registrationFormAnswer: {
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    activityPositionPreference: { createMany: jest.fn() },
    activityParticipationIdentity: { create: jest.fn(), update: jest.fn() },
    activityParticipationRevision: { create: jest.fn() },
    attendanceRecord: { findFirst: jest.fn() },
    activityCheckIn: { findFirst: jest.fn() },
    attendancePunchEvent: { findFirst: jest.fn() },
  };
  return tx;
}

function makeService(tx: ReturnType<typeof makeTx>, opts: { transactionError?: Error } = {}) {
  const prisma = {
    $transaction: jest
      .fn()
      .mockImplementation(async (callback: (inner: typeof tx) => Promise<unknown>) => {
        if (opts.transactionError) throw opts.transactionError;
        return callback(tx);
      }),
    activityRegistrationRevision: { findFirst: jest.fn() },
  };
  const appIdentity = {
    resolve: jest.fn().mockResolvedValue({ canUseApp: true, member: { id: 'member-1' } }),
  };
  const attachments = {
    inspectRegistrationUploadsForSubmissionInTransactionTrusted: jest.fn(),
    consumeRegistrationUploadsForFormAnswersInTransactionTrusted: jest.fn(),
  };
  const audit = { logCommandCreate: jest.fn().mockResolvedValue(undefined) };
  return {
    service: new RegistrationCommandService(
      prisma as unknown as PrismaService,
      appIdentity as unknown as AppIdentityResolver,
      new ActivityParticipationPolicy(),
      attachments as unknown as AttachmentsService,
      audit as unknown as ActivityRegistrationAuditRecorder,
    ),
    prisma,
    appIdentity,
    attachments,
    audit,
  };
}

describe('RegistrationCommandService', () => {
  it('creates a minimal first immutable command chain only after all pre-write rereads', async () => {
    const tx = makeTx();
    const { service, audit } = makeService(tx);

    const receipt = await service.submit('activity-1', command(), user(), {
      requestId: 'request-1',
      ip: null,
      ua: null,
    });

    expect(receipt).toEqual({
      registrationId: 'registration-1',
      registrationRevisionId: 'registration-revision-1',
      revision: 1,
      submittedAt: NOW,
    });
    const createOrder = tx.activityRegistration.create.mock.invocationCallOrder[0];
    const formReadOrder = tx.registrationFormVersion.findFirst.mock.invocationCallOrder[0];
    if (createOrder === undefined || formReadOrder === undefined) {
      throw new Error('expected Form read before registration header write');
    }
    expect(createOrder).toBeGreaterThan(formReadOrder);
    const revisionCreateCalls = tx.activityRegistrationRevision.create.mock
      .calls as unknown as readonly [unknown][];
    const revisionCreateInput = revisionCreateCalls[0]?.[0];
    expect(revisionCreateInput).toMatchObject({
      data: {
        registrationId: 'registration-1',
        revision: 1,
        formVersionId: null,
        sourceCode: 'self',
        requestKey: 'operation-1',
      },
    });
    expect(audit.logCommandCreate).toHaveBeenCalledWith(
      expect.objectContaining({ answerCount: 0, preferenceCount: 0, source: 'self' }),
    );
  });

  it('returns the immutable winner before Form/upload revalidation for same key/hash', async () => {
    const tx = makeTx();
    const { service } = makeService(tx);
    const dto = command();
    tx.activityRegistrationRevision.findFirst.mockResolvedValue({
      registrationId: 'registration-previous',
      id: 'revision-previous',
      revision: 7,
      submittedAt: NOW,
      requestHash: hashRegistrationCommand({
        actorUserId: 'user-1',
        memberId: 'member-1',
        activityId: 'activity-1',
        source: 'self',
        formVersion: null,
        answers: [],
        preferences: [],
      }),
    });

    await expect(
      service.submit('activity-1', dto, user(), { requestId: 'request-1', ip: null, ua: null }),
    ).resolves.toEqual({
      registrationId: 'registration-previous',
      registrationRevisionId: 'revision-previous',
      revision: 7,
      submittedAt: NOW,
    });
    expect(tx.registrationFormVersion.findFirst).not.toHaveBeenCalled();
  });

  it('maps a P2002 race to the winner receipt rather than exposing Prisma', async () => {
    const tx = makeTx();
    const p2002 = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: '6.19.3',
    });
    const { service, prisma } = makeService(tx, { transactionError: p2002 });
    prisma.activityRegistrationRevision.findFirst.mockResolvedValue({
      registrationId: 'registration-winner',
      id: 'revision-winner',
      revision: 1,
      submittedAt: NOW,
      requestHash: hashRegistrationCommand({
        actorUserId: 'user-1',
        memberId: 'member-1',
        activityId: 'activity-1',
        source: 'self',
        formVersion: null,
        answers: [],
        preferences: [],
      }),
    });

    await expect(
      service.submit('activity-1', command(), user(), {
        requestId: 'request-1',
        ip: null,
        ua: null,
      }),
    ).resolves.toMatchObject({ registrationId: 'registration-winner', revision: 1 });
  });

  it('rejects a different hash for an already-used operation key', async () => {
    const tx = makeTx();
    tx.activityRegistrationRevision.findFirst.mockResolvedValue({
      registrationId: 'registration-previous',
      id: 'revision-previous',
      revision: 1,
      submittedAt: NOW,
      requestHash: 'different',
    });
    const { service } = makeService(tx);

    await expect(
      service.submit('activity-1', command(), user(), {
        requestId: 'request-1',
        ip: null,
        ua: null,
      }),
    ).rejects.toEqual(new BizException(BizCode.ACTIVITY_REGISTRATION_OPERATION_KEY_CONFLICT));
    expect(tx.registrationFormVersion.findFirst).not.toHaveBeenCalled();
  });
});
