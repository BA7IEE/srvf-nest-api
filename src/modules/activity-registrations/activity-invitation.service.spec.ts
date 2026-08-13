import { Prisma, Role, UserStatus } from '@prisma/client';
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
    submitInTransactionTrusted: jest.fn(),
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
