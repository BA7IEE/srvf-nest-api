import { Prisma, Role, UserStatus } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ActivityMetricRuleBindingAuditRecorder } from './activity-metric-rule-binding-audit-recorder';

describe('C3-1 activity-metric-rule-binding audit', () => {
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
    bindingId: 'binding',
    bindingHash: 'b'.repeat(64),
    metricDefinitionId: 'definition',
    definitionHash: 'a'.repeat(64),
    ruleCode: 'actual_participant_count_v1' as const,
    evaluatorVersion: 1,
    unitCode: 'count' as const,
    scale: 0,
    createdAt: '2025-01-01T00:00:00.000Z',
    sourceRevisionId: 'private-source',
    memberId: 'private-member',
    operationKey: 'private-key',
    checkInAt: 'private-instant',
  };
  it('uses caller transaction and an exact safe payload despite extra input fields', async () => {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    await new ActivityMetricRuleBindingAuditRecorder(audit as unknown as AuditLogsService).log(
      tx,
      actor,
      meta,
      result,
      false,
    );
    expect(audit.log).toHaveBeenCalledWith({
      event: 'activity.metric-rule-binding.command',
      actorUserId: 'actor',
      actorRoleSnap: Role.USER,
      resourceType: 'activity-metric-rule-binding',
      resourceId: 'binding',
      tx,
      meta,
      extra: {
        operation: 'create_metric_rule_binding',
        metricDefinitionId: 'definition',
        definitionHash: 'a'.repeat(64),
        bindingHash: 'b'.repeat(64),
        ruleCode: 'actual_participant_count_v1',
        evaluatorVersion: 1,
        reused: false,
      },
    });
    expect(audit.log).toHaveBeenCalledTimes(1);
  });
  it('propagates audit failure so the owner transaction can roll back', async () => {
    const error = new Error('audit failed');
    const audit = { log: jest.fn().mockRejectedValue(error) };
    await expect(
      new ActivityMetricRuleBindingAuditRecorder(audit as unknown as AuditLogsService).log(
        tx,
        actor,
        meta,
        result,
        false,
      ),
    ).rejects.toBe(error);
  });
});
