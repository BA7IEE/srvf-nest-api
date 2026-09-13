import { Role, UserStatus } from '@prisma/client';
import { ActivityTimeSettlementAuditRecorder } from './activity-time-settlement-audit-recorder';
import type { TimeSettlementReceiptResult } from './activity-time-settlement-command';

describe('D4 safe transactional audit', () => {
  const result: TimeSettlementReceiptResult = {
    schemaVersion: 1,
    activityId: 'activity',
    timeRevisionId: 'revision',
    revision: 2,
    kindCode: 'submitted',
    settlementRunId: 'run',
    settlementVersionId: 'version',
    settlementVersion: 3,
    contentHash: 'a'.repeat(64),
    bucketContentHash: 'b'.repeat(64),
    bucketCount: 4,
    sourceCount: 4,
    createdAt: '2026-09-12T00:00:00.000Z',
  };
  const actor = {
    id: 'actor',
    username: 'actor',
    role: Role.USER,
    status: UserStatus.ACTIVE,
    memberId: 'member',
  };
  const meta = { requestId: 'request', ip: null, ua: null };
  it.each([false, true])(
    'uses the same transaction and safe operation/replay fields (%s)',
    async (replayed) => {
      const log = jest.fn().mockResolvedValue(undefined);
      const tx = {} as never;
      await new ActivityTimeSettlementAuditRecorder({ log } as never).log(
        tx,
        actor,
        meta,
        'submit_time_settlement',
        result,
        replayed,
      );
      expect(log).toHaveBeenCalledWith({
        event: 'activity.time-settlement.command',
        actorUserId: 'actor',
        actorRoleSnap: Role.USER,
        resourceType: 'activity',
        resourceId: 'activity',
        tx,
        meta,
        extra: {
          operationCode: 'submit_time_settlement',
          timeRevisionId: 'revision',
          settlementVersionId: 'version',
          revision: 2,
          kindCode: 'submitted',
          bucketCount: 4,
          sourceCount: 4,
          replayed,
        },
      });
      expect(JSON.stringify(log.mock.calls)).not.toMatch(
        /manualReason|adjustmentReason|operationKey|requestHash|contentHash|bucketContentHash|signedUrl/,
      );
    },
  );
  it('propagates the last-step error for whole-transaction rollback', async () => {
    const log = jest.fn().mockRejectedValue(new Error('audit-failed'));
    await expect(
      new ActivityTimeSettlementAuditRecorder({ log } as never).log(
        {} as never,
        actor,
        meta,
        'prepare_time_settlement',
        result,
        false,
      ),
    ).rejects.toThrow('audit-failed');
  });
});
