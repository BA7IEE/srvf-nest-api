import { Role, type Prisma } from '@prisma/client';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { ActivityTimePolicySelectionReceiptResult } from './activity-time-policy-selection';
import { ActivityTimePolicySelectionAuditRecorder } from './activity-time-policy-selection-audit-recorder';

const actor = {
  id: 'actor-one',
  username: 'actor-one',
  role: Role.ADMIN,
  status: 'ACTIVE',
  memberId: null,
} as const;
const meta = { requestId: 'selection-audit', ip: null, ua: null };
const tx = {} as Prisma.TransactionClient;
const result: ActivityTimePolicySelectionReceiptResult = {
  activityId: 'activity-one',
  selectionRevisionId: 'revision-one',
  revision: 2,
  selectionHash: 'a'.repeat(64),
  createdAt: '2026-09-11T00:00:00.000Z',
};

function setup() {
  const log = jest
    .fn<ReturnType<AuditLogsService['log']>, Parameters<AuditLogsService['log']>>()
    .mockResolvedValue(undefined);
  return {
    log,
    recorder: new ActivityTimePolicySelectionAuditRecorder({ log } as unknown as AuditLogsService),
  };
}

describe('D1-3 time policy selection audit', () => {
  it.each([
    'patch_time_policy_selection',
    'initialize_time_policy_selection',
    'publish_review_time_policy_selection',
  ])('writes only the fixed fact projection for %s', async (operation) => {
    const { log, recorder } = setup();
    await recorder.log(
      tx,
      actor,
      meta,
      { ...result, operationKey: 'must-not-leak' } as ActivityTimePolicySelectionReceiptResult,
      17,
      operation,
    );
    expect(log).toHaveBeenCalledWith({
      event: 'activity.time-policy.selection',
      actorUserId: actor.id,
      actorRoleSnap: actor.role,
      resourceType: 'activity',
      resourceId: result.activityId,
      tx,
      meta,
      extra: {
        operation,
        revision: 2,
        selectionHash: 'a'.repeat(64),
        targetCount: 17,
      },
    });
  });

  it('propagates the audit failure to the transaction owner', async () => {
    const { log, recorder } = setup();
    const failure = new Error('synthetic audit failure');
    log.mockRejectedValueOnce(failure);
    await expect(recorder.log(tx, actor, meta, result, 1)).rejects.toBe(failure);
  });
});
