import { Role, UserStatus, type Prisma } from '@prisma/client';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ContributionShadowEvidenceAuditRecorder } from './contribution-shadow-evidence.audit-recorder';
describe('D3 minimal read audit', () => {
  it.each(['windows', 'summary', 'candidates', 'candidate', 'comparisons'] as const)(
    'records %s without raw evidence, using the caller transaction',
    async (operation) => {
      const log = jest.fn().mockResolvedValue(undefined);
      const recorder = new ContributionShadowEvidenceAuditRecorder({
        log,
      } as unknown as AuditLogsService);
      const tx = {} as Prisma.TransactionClient;
      const user = {
        id: 'human-fixture',
        username: 'fixture',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
        memberId: null,
      };
      const meta = { requestId: 'fixture', ip: null, ua: null };
      await recorder.record(
        tx,
        user,
        meta,
        operation,
        { windowId: 'window-fixture', auditLogId: 'audit-fixture' },
        20,
      );
      expect(log).toHaveBeenCalledWith({
        tx,
        event: 'activity.contribution-shadow.evidence-read',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: 'contribution_shadow_evidence',
        resourceId: 'window-fixture',
        meta,
        extra: { operation, windowId: 'window-fixture', auditLogId: 'audit-fixture', count: 20 },
      });
    },
  );
  it('does not swallow an audit write failure', async () => {
    const recorder = new ContributionShadowEvidenceAuditRecorder({
      log: jest.fn().mockRejectedValue(new Error('fixture-failure')),
    } as unknown as AuditLogsService);
    await expect(
      recorder.record(
        {} as Prisma.TransactionClient,
        {
          id: 'fixture',
          username: 'fixture',
          role: Role.ADMIN,
          status: UserStatus.ACTIVE,
          memberId: null,
        },
        { requestId: 'fixture', ip: null, ua: null },
        'windows',
        {},
        0,
      ),
    ).rejects.toThrow('fixture-failure');
  });
});
