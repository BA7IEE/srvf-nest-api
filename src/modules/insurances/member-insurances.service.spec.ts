import { Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { AuthzService } from '../authz/authz.service';
import type { RbacService } from '../permissions/rbac.service';
import { MemberInsurancesService } from './member-insurances.service';

const META: AuditMeta = { requestId: 'req-insurance-1', ip: '127.0.0.1', ua: 'jest' };
const USER: CurrentUserPayload = {
  id: 'admin-1',
  username: 'admin',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};

function buildService() {
  const prisma = {
    member: { findFirst: jest.fn().mockResolvedValue({ id: 'member-1' }) },
    memberInsurance: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'insurance-1',
          memberId: 'member-1',
          insurerName: 'Insurer',
          policyNumber: 'POLICY-SECRET',
          coverageStart: new Date('2026-01-01T00:00:00.000Z'),
          coverageEnd: new Date('2027-01-01T00:00:00.000Z'),
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]),
    },
  };
  const auditLogs = {
    log: jest.fn<Promise<void>, [Record<string, unknown>]>().mockResolvedValue(undefined),
  };
  const rbac = { can: jest.fn().mockResolvedValue(true) };
  const authz = { explain: jest.fn().mockResolvedValue({ allow: true, reason: 'matched' }) };
  const service = new MemberInsurancesService(
    prisma as unknown as PrismaService,
    auditLogs as unknown as AuditLogsService,
    rbac as unknown as RbacService,
    authz as unknown as AuthzService,
  );
  return { service, prisma, auditLogs };
}

describe('MemberInsurancesService sensitive read audit', () => {
  it('records only a safe count after the insurance query', async () => {
    const { service, prisma, auditLogs } = buildService();

    await service.listForMember('member-1', USER, META);

    expect(auditLogs.log).toHaveBeenCalledWith({
      event: 'member-insurance.read.other',
      actorUserId: USER.id,
      actorRoleSnap: USER.role,
      resourceType: 'member',
      resourceId: 'member-1',
      meta: META,
      extra: { operation: 'list', count: 1 },
    });
    expect(prisma.memberInsurance.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      auditLogs.log.mock.invocationCallOrder[0],
    );
    const serializedAudit = JSON.stringify(auditLogs.log.mock.calls[0][0]);
    expect(serializedAudit).not.toContain('POLICY-SECRET');
    expect(serializedAudit).not.toContain('Insurer');
  });

  it('fails closed when the audit write is rejected', async () => {
    const { service, auditLogs } = buildService();
    auditLogs.log.mockRejectedValue(new Error('audit unavailable'));

    await expect(service.listForMember('member-1', USER, META)).rejects.toThrow(
      'audit unavailable',
    );
  });
});
