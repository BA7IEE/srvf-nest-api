import { Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { AuthzService } from '../authz/authz.service';
import type { RbacService } from '../permissions/rbac.service';
import { MemberProfilesService } from './member-profiles.service';

const META: AuditMeta = { requestId: 'req-profile-1', ip: '127.0.0.1', ua: 'jest' };
const USER: CurrentUserPayload = {
  id: 'admin-1',
  username: 'admin',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};

function buildService(profile: { id: string; memberId: string } | null) {
  const prisma = {
    member: { findFirst: jest.fn().mockResolvedValue({ id: 'member-1' }) },
    memberProfile: { findFirst: jest.fn().mockResolvedValue(profile) },
  };
  const auditLogs = { log: jest.fn().mockResolvedValue(undefined) };
  const rbac = { can: jest.fn().mockResolvedValue(true) };
  const authz = {
    explain: jest.fn().mockResolvedValue({ allow: true, reason: 'matched' }),
    can: jest.fn().mockResolvedValue(true),
  };
  const service = new MemberProfilesService(
    prisma as unknown as PrismaService,
    auditLogs as unknown as AuditLogsService,
    rbac as unknown as RbacService,
    authz as unknown as AuthzService,
  );
  return { service, prisma, auditLogs };
}

describe('MemberProfilesService sensitive read audit', () => {
  it('queries the profile before recording a full-view detail read', async () => {
    const { service, prisma, auditLogs } = buildService({
      id: 'profile-1',
      memberId: 'member-1',
    });

    await service.findOne('member-1', USER, META);

    expect(auditLogs.log).toHaveBeenCalledWith({
      event: 'profile.read.other',
      actorUserId: USER.id,
      actorRoleSnap: USER.role,
      resourceType: 'member_profile',
      resourceId: 'profile-1',
      meta: META,
      extra: {
        operation: 'detail',
        targetMemberId: 'member-1',
        maskLevel: 'plain',
      },
    });
    expect(prisma.memberProfile.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      auditLogs.log.mock.invocationCallOrder[0],
    );
  });

  it('records a nullable resource id when the member has no profile', async () => {
    const { service, auditLogs } = buildService(null);

    await expect(service.findOne('member-1', USER, META)).resolves.toBeNull();
    expect(auditLogs.log).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'member_profile', resourceId: null }),
    );
  });

  it('propagates audit rejection instead of returning profile data', async () => {
    const { service, auditLogs } = buildService({ id: 'profile-1', memberId: 'member-1' });
    auditLogs.log.mockRejectedValue(new Error('audit unavailable'));

    await expect(service.findOne('member-1', USER, META)).rejects.toThrow('audit unavailable');
  });
});
