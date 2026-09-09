import { Prisma, Role, UserStatus } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ActivityMetricCandidateAuditRecorder } from './activity-metric-candidate-audit-recorder';

describe('C3-1 activity-metric-candidate audit', () => {
  const tx = {} as Prisma.TransactionClient;
  const actor = {
    id: 'actor',
    username: 'actor',
    role: Role.USER,
    status: UserStatus.ACTIVE,
    memberId: 'member',
  };
  const meta = { requestId: 'request', ip: null, ua: null };
  const result = {
    schemaVersion: 1 as const,
    candidateId: 'candidate',
    activityId: 'activity',
    revision: 1,
    metricSetVersionId: 'set',
    metricSetDefinitionHash: 'a'.repeat(64),
    createdStatusCode: 'candidate' as const,
    sourceCode: 'system' as const,
    valueCount: 1,
    sourceCount: 1,
    createdAt: '2025-01-01T00:00:00.000Z',
    sourceRevisionId: 'private-source',
    memberId: 'private-member',
    operationKey: 'private-key',
    checkInAt: 'private-instant',
  };
  it('uses caller transaction and an exact safe payload despite extra input fields', async () => {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    await new ActivityMetricCandidateAuditRecorder(audit as unknown as AuditLogsService).log(
      tx,
      actor,
      meta,
      result,
      null,
    );
    expect(audit.log).toHaveBeenCalledWith({
      event: 'activity.metric-candidate.command',
      actorUserId: 'actor',
      actorRoleSnap: Role.USER,
      resourceType: 'activity',
      resourceId: 'activity',
      tx,
      meta,
      extra: {
        operation: 'calculate_metric_candidate',
        candidateId: 'candidate',
        revision: 1,
        priorCandidateId: null,
        sourceCode: 'system',
        afterStatus: 'candidate',
        valueCount: 1,
        sourceCount: 1,
      },
    });
    expect(audit.log).toHaveBeenCalledTimes(1);
  });
  it('propagates audit failure so the owner transaction can roll back', async () => {
    const error = new Error('audit failed');
    const audit = { log: jest.fn().mockRejectedValue(error) };
    await expect(
      new ActivityMetricCandidateAuditRecorder(audit as unknown as AuditLogsService).log(
        tx,
        actor,
        meta,
        result,
        null,
      ),
    ).rejects.toBe(error);
  });
});
