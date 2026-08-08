import { Role } from '@prisma/client';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ActivityInvitationAuditRecorder } from './activity-invitation-audit-recorder';

const META = { requestId: 'req-invitation-audit', ip: '127.0.0.1', ua: 'jest' };

function makeAuditLogsMock() {
  return { log: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined) };
}

describe('ActivityInvitationAuditRecorder', () => {
  it('records invitation changes with status-only snapshots and no free-text fields', async () => {
    const auditLogs = makeAuditLogsMock();
    const recorder = new ActivityInvitationAuditRecorder(auditLogs as unknown as AuditLogsService);

    await recorder.logInvitationChange({
      invitation: {
        id: 'invitation-1',
        activityId: 'activity-1',
        sessionId: 'session-1',
        positionId: 'position-1',
        statusCode: 'revoked',
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      },
      before: {
        id: 'invitation-1',
        activityId: 'activity-1',
        sessionId: 'session-1',
        positionId: 'position-1',
        statusCode: 'pending',
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      },
      actorUserId: 'user-1',
      actorRoleSnap: Role.USER,
      operation: 'revoke',
      auditMeta: META,
      tx: {} as never,
    });

    expect(auditLogs.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'invitation.change',
        resourceType: 'activity_invitation',
        resourceId: 'invitation-1',
        before: {
          statusCode: 'pending',
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          scope: 'position',
        },
        after: {
          statusCode: 'revoked',
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          scope: 'position',
        },
        extra: { operation: 'revoke', activityId: 'activity-1', scope: 'position' },
      }),
    );
    expect(JSON.stringify(auditLogs.log.mock.calls[0][0])).not.toContain('因为临时有事');
    expect(JSON.stringify(auditLogs.log.mock.calls[0][0])).not.toContain('reason');
  });

  it('records visitor creation without name, organization, note, or inviter identity', async () => {
    const auditLogs = makeAuditLogsMock();
    const recorder = new ActivityInvitationAuditRecorder(auditLogs as unknown as AuditLogsService);

    await recorder.logVisitorCreate({
      visitorId: 'visitor-1',
      activityId: 'activity-1',
      sessionId: 'session-1',
      invitedByMemberProvided: true,
      actorUserId: 'user-1',
      actorRoleSnap: Role.USER,
      auditMeta: META,
      tx: {} as never,
    });

    const input = auditLogs.log.mock.calls[0][0] as Record<string, unknown>;
    expect(input).toMatchObject({
      event: 'visitor.create',
      resourceType: 'activity_visitor',
      resourceId: 'visitor-1',
      after: { activityId: 'activity-1', sessionId: 'session-1' },
      extra: { operation: 'create', invitedByMemberProvided: true },
    });
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain('访客姓名');
    expect(serialized).not.toContain('访客单位');
    expect(serialized).not.toContain('访客备注');
    expect(serialized).not.toContain('member-1');
  });
});
