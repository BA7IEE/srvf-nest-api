import { Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { AuthzService } from '../authz/authz.service';
import type { RbacService } from '../permissions/rbac.service';
import { EmergencyContactsService } from './emergency-contacts.service';

const META: AuditMeta = { requestId: 'req-contact-1', ip: '127.0.0.1', ua: 'jest' };
const USER: CurrentUserPayload = {
  id: 'admin-1',
  username: 'admin',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};

function buildService() {
  const rows = [
    {
      id: 'contact-1',
      memberId: 'member-1',
      contactName: 'Contact',
      relationCode: 'family',
      phonePrimary: '13800000000',
      phoneBackup: null,
      address: null,
      priority: 0,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  ];
  const prisma = {
    member: { findFirst: jest.fn().mockResolvedValue({ id: 'member-1' }) },
    emergencyContact: { findMany: jest.fn().mockResolvedValue(rows) },
  };
  const auditLogs = { log: jest.fn().mockResolvedValue(undefined) };
  const rbac = { can: jest.fn().mockResolvedValue(true) };
  const authz = {
    explain: jest.fn().mockResolvedValue({ allow: true, reason: 'matched' }),
    can: jest.fn().mockResolvedValue(true),
  };
  const service = new EmergencyContactsService(
    prisma as unknown as PrismaService,
    auditLogs as unknown as AuditLogsService,
    rbac as unknown as RbacService,
    authz as unknown as AuthzService,
  );
  return { service, prisma, auditLogs };
}

describe('EmergencyContactsService sensitive read audit', () => {
  it('records only collection count and mask level after the query', async () => {
    const { service, prisma, auditLogs } = buildService();

    await service.list('member-1', USER, META);

    expect(auditLogs.log).toHaveBeenCalledWith({
      event: 'emergency-contact.read.other',
      actorUserId: USER.id,
      actorRoleSnap: USER.role,
      resourceType: 'member',
      resourceId: 'member-1',
      meta: META,
      extra: { operation: 'list', count: 1, maskLevel: 'plain' },
    });
    expect(prisma.emergencyContact.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      auditLogs.log.mock.invocationCallOrder[0],
    );
  });

  it('fails closed when the audit write is rejected', async () => {
    const { service, auditLogs } = buildService();
    auditLogs.log.mockRejectedValue(new Error('audit unavailable'));

    await expect(service.list('member-1', USER, META)).rejects.toThrow('audit unavailable');
  });
});
