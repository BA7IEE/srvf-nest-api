import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { AuthzService } from '../authz/authz.service';
import type { RbacService } from '../permissions/rbac.service';
import type { ActivityInvitationAuditRecorder } from './activity-invitation-audit-recorder';
import { ActivityVisitorService } from './activity-visitor.service';

const USER: CurrentUserPayload = {
  id: 'user-manager',
  username: 'manager',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: 'member-manager',
};
const META: AuditMeta = { requestId: 'req-visitor-service', ip: null, ua: null };
type VisitorAuditInput = Parameters<ActivityInvitationAuditRecorder['logVisitorCreate']>[0];

function makeTx() {
  return {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'activity-1' }]),
    activity: { findFirst: jest.fn().mockResolvedValue({ id: 'activity-1' }) },
    activitySession: { findFirst: jest.fn().mockResolvedValue({ id: 'session-1' }) },
    member: { findFirst: jest.fn().mockResolvedValue({ id: 'member-inviter' }) },
    activityVisitor: {
      create: jest.fn().mockResolvedValue({
        id: 'visitor-1',
        activityId: 'activity-1',
        sessionId: 'session-1',
        name: '访客姓名',
        organization: '访客单位',
        invitedByMemberId: 'member-inviter',
        note: '访客备注',
        createdAt: new Date('2099-01-01T00:00:00.000Z'),
      }),
    },
  };
}

function makeService(args: { allow?: boolean; globalCan?: boolean } = {}) {
  const tx = makeTx();
  const prisma = {
    $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  } as unknown as PrismaService;
  const authz = {
    explain: jest.fn().mockResolvedValue({ allow: args.allow ?? true }),
  } as unknown as AuthzService;
  const rbac = {
    can: jest.fn().mockResolvedValue(args.globalCan ?? false),
  } as unknown as RbacService;
  const auditMock = {
    logVisitorCreate: jest.fn<Promise<void>, [VisitorAuditInput]>().mockResolvedValue(undefined),
  };
  const audit = auditMock as unknown as ActivityInvitationAuditRecorder;
  return { service: new ActivityVisitorService(prisma, authz, rbac, audit), tx, audit: auditMock };
}

describe('ActivityVisitorService', () => {
  it('rejects a managed create before opening a transaction when the registration permission is absent', async () => {
    const { service, tx } = makeService({ allow: false, globalCan: false });

    await expect(
      service.create('activity-1', { sessionId: 'session-1', name: '访客姓名' }, USER, META),
    ).rejects.toEqual(new BizException(BizCode.RBAC_FORBIDDEN));
    expect(tx.activityVisitor.create).not.toHaveBeenCalled();
  });

  it('writes only the visitor payload with a null attendanceCode and same-transaction audit', async () => {
    const { service, tx, audit } = makeService();

    const result = await service.create(
      'activity-1',
      {
        sessionId: 'session-1',
        name: '访客姓名',
        organization: '访客单位',
        invitedByMemberId: 'member-inviter',
        note: '访客备注',
      },
      USER,
      META,
    );

    expect(tx.activityVisitor.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          activityId: 'activity-1',
          sessionId: 'session-1',
          name: '访客姓名',
          organization: '访客单位',
          invitedByMemberId: 'member-inviter',
          note: '访客备注',
          attendanceCode: null,
        },
      }),
    );
    expect(audit.logVisitorCreate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        visitorId: 'visitor-1',
        activityId: 'activity-1',
        sessionId: 'session-1',
      }),
    );
    expect(result).toMatchObject({ visitorId: 'visitor-1', activityId: 'activity-1' });
  });
});
