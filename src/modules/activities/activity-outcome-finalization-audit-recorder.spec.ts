import { Prisma, Role, UserStatus } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ActivityOutcomeFinalizationAuditRecorder } from './activity-outcome-finalization-audit-recorder';
import type { OutcomeFinalizationResult } from './activity-outcome-finalization-command';

describe('C3-2 finalization audit', () => {
  const tx = {} as Prisma.TransactionClient;
  const actor = {
    id: 'actor',
    username: 'actor',
    role: Role.USER,
    status: UserStatus.ACTIVE,
    memberId: 'member',
  };
  const meta = { requestId: 'request', ip: null, ua: null };
  const result: OutcomeFinalizationResult = {
    schemaVersion: 1,
    activityId: 'activity',
    outcomeRevisionId: 'formal',
    revision: 3,
    createdStatusCode: 'confirmed',
    operationCode: 'confirm_outcome',
    valueCount: 2,
    evidenceCount: 2,
    createdAt: '2026-09-09T00:00:00.000Z',
  };
  it('writes an exact allowlist in the caller transaction', async () => {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const recorder = new ActivityOutcomeFinalizationAuditRecorder(
      audit as unknown as AuditLogsService,
    );
    await recorder.log(
      tx,
      actor,
      meta,
      {
        ...result,
        ...{
          value: 999,
          requestHash: 'private',
          operationKey: 'private',
          sourceJson: ['private'],
          confirmedByUserId: 'private',
        },
      },
      'old',
      ['system', 'manual', 'system'],
    );
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith({
      event: 'activity.outcome.finalization',
      actorUserId: 'actor',
      actorRoleSnap: Role.USER,
      resourceType: 'activity',
      resourceId: 'activity',
      tx,
      meta,
      extra: {
        operation: 'confirm_outcome',
        outcomeRevisionId: 'formal',
        revision: 3,
        baseConfirmedRevisionId: 'old',
        createdStatusCode: 'confirmed',
        sourceKinds: ['manual', 'system'],
        valueCount: 2,
        evidenceCount: 2,
      },
    });
  });
  it('propagates audit failure to roll back the owning transaction', async () => {
    const error = new Error('audit failure');
    const audit = { log: jest.fn().mockRejectedValue(error) };
    await expect(
      new ActivityOutcomeFinalizationAuditRecorder(audit as unknown as AuditLogsService).log(
        tx,
        actor,
        meta,
        result,
        null,
        ['manual'],
      ),
    ).rejects.toBe(error);
  });
});
