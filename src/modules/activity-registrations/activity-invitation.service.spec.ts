import { MemberStatus, Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { AuthzService } from '../authz/authz.service';
import type { RbacService } from '../permissions/rbac.service';
import type { ActivityInvitationAuditRecorder } from './activity-invitation-audit-recorder';
import type { RegistrationCommandService } from './registration-command.service';
import { ActivityInvitationService } from './activity-invitation.service';

const USER: CurrentUserPayload = {
  id: 'user-manager',
  username: 'manager',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: 'member-manager',
};
const META: AuditMeta = { requestId: 'req-invitation-service', ip: null, ua: null };
const P2002 = new Prisma.PrismaClientKnownRequestError('unique', {
  code: 'P2002',
  clientVersion: 'test',
});

function makePrisma(transaction: jest.Mock) {
  return {
    $transaction: transaction,
    activityInvitation: { findFirst: jest.fn() },
  } as unknown as PrismaService;
}

function makeService(args: {
  transaction: jest.Mock;
  decision?: { allow: boolean; reason?: string };
  globalCan?: boolean;
}) {
  const authz = {
    explain: jest.fn().mockResolvedValue(args.decision ?? { allow: true }),
  } as unknown as AuthzService;
  const rbac = {
    can: jest.fn().mockResolvedValue(args.globalCan ?? false),
  } as unknown as RbacService;
  const audit = {
    logInvitationChange: jest.fn().mockResolvedValue(undefined),
  } as unknown as ActivityInvitationAuditRecorder;
  const registrationCommands = {
    submitInTransaction: jest.fn(),
  } as unknown as RegistrationCommandService;
  return new ActivityInvitationService(
    makePrisma(args.transaction),
    authz,
    rbac,
    audit,
    registrationCommands,
  );
}

describe('ActivityInvitationService', () => {
  function createFixture(status: MemberStatus) {
    const calls: string[] = [];
    const invitation = {
      id: 'invitation-1',
      activityId: 'activity-1',
      memberId: 'member-target',
      sessionId: null,
      positionId: null,
      statusCode: 'pending',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      respondedAt: null,
      revokedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const tx = {
      $queryRaw: jest.fn().mockImplementation((sql: Prisma.Sql) => {
        if (sql.sql.includes('FROM "ActivityInvitation"')) {
          calls.push('invitations');
          return Promise.resolve([]);
        }
        if (sql.sql.includes('FROM "Activity"')) {
          calls.push('activity-lock');
          return Promise.resolve([{ id: 'activity-1' }]);
        }
        if (sql.sql.includes('FROM "Member"')) {
          calls.push('member-lock');
          return Promise.resolve([{ id: 'member-target' }]);
        }
        throw new Error('unexpected query');
      }),
      activity: { findFirst: jest.fn().mockResolvedValue({ id: 'activity-1' }) },
      member: {
        findFirst: jest.fn().mockImplementation(() => {
          calls.push('member-read');
          return Promise.resolve({ id: 'member-target', status });
        }),
      },
      activityInvitation: {
        create: jest.fn().mockImplementation(() => {
          calls.push('create');
          return Promise.resolve(invitation);
        }),
        updateMany: jest.fn(),
      },
    };
    const transaction = jest
      .fn()
      .mockImplementation((fn: (arg: typeof tx) => Promise<unknown>) => fn(tx));
    const service = makeService({ transaction });
    return { service, transaction, tx, calls };
  }

  it('locks the activity then the target member and rereads their status before creating an invitation', async () => {
    const f = createFixture(MemberStatus.ACTIVE);
    await f.service.create(
      'activity-1',
      { memberId: 'member-target', expiresAt: '2099-01-01T00:00:00.000Z' },
      USER,
      META,
    );
    expect(f.calls).toEqual([
      'activity-lock',
      'member-lock',
      'member-read',
      'invitations',
      'create',
    ]);
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  });

  it('does not create an invitation if the locked target is inactive', async () => {
    const f = createFixture(MemberStatus.INACTIVE);
    await expect(
      f.service.create(
        'activity-1',
        { memberId: 'member-target', expiresAt: '2099-01-01T00:00:00.000Z' },
        USER,
        META,
      ),
    ).rejects.toEqual(new BizException(BizCode.MEMBER_INACTIVE));
    expect(f.calls).toEqual(['activity-lock', 'member-lock', 'member-read']);
    expect(f.tx.activityInvitation.create).not.toHaveBeenCalled();
    expect(f.tx.activityInvitation.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a managed create before opening a transaction when the registration permission is absent', async () => {
    const transaction = jest.fn();
    const service = makeService({
      transaction,
      decision: { allow: false, reason: 'forbidden' },
      globalCan: false,
    });

    await expect(
      service.create(
        'activity-1',
        { memberId: 'member-target', expiresAt: '2099-01-01T00:00:00.000Z' },
        USER,
        META,
      ),
    ).rejects.toEqual(new BizException(BizCode.RBAC_FORBIDDEN));
    expect(transaction).not.toHaveBeenCalled();
  });

  it('maps the pending partial-unique P2002 race to ACTIVITY_INVITATION_ALREADY_PENDING', async () => {
    const transaction = jest.fn().mockRejectedValue(P2002);
    const service = makeService({ transaction });

    await expect(
      service.create(
        'activity-1',
        { memberId: 'member-target', expiresAt: '2099-01-01T00:00:00.000Z' },
        USER,
        META,
      ),
    ).rejects.toEqual(new BizException(BizCode.ACTIVITY_INVITATION_ALREADY_PENDING));
  });
});
