import { Role, type Prisma } from '@prisma/client';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { ActivityContributionPolicySelectionReceiptResult } from './activity-contribution-policy-selection';
import { ActivityContributionPolicySelectionAuditRecorder } from './activity-contribution-policy-selection-audit-recorder';

const actor = {
  id: 'actor-one',
  username: 'actor-one',
  role: Role.ADMIN,
  status: 'ACTIVE',
  memberId: null,
} as const;
const tx = {} as Prisma.TransactionClient;
const meta = { requestId: 'selection-audit', ip: null, ua: null };
const result: ActivityContributionPolicySelectionReceiptResult = {
  activityId: 'activity-one',
  selectionRevisionId: 'revision-one',
  revision: 2,
  selectionHash: 'a'.repeat(64),
  createdAt: '2026-09-23T00:00:00.000Z',
};

describe('E1-3 contribution policy selection audit', () => {
  it('emits the fixed allowlisted fact projection without command keys or definitions', async () => {
    const log = jest
      .fn<ReturnType<AuditLogsService['log']>, Parameters<AuditLogsService['log']>>()
      .mockResolvedValue(undefined);
    const recorder = new ActivityContributionPolicySelectionAuditRecorder({
      log,
    } as unknown as AuditLogsService);
    await recorder.log(
      tx,
      actor,
      meta,
      {
        ...result,
        operationKey: 'must-not-leak',
      } as ActivityContributionPolicySelectionReceiptResult,
      {
        operation: 'patch_contribution_policy_selection',
        changedLayerCount: 2,
        targetCount: 3,
        pointers: [
          {
            policyId: 'policy-one',
            versionId: 'version-one',
            definitionHash: 'b'.repeat(64),
            evaluatorVersion: 1,
          },
        ],
      },
    );
    expect(log).toHaveBeenCalledWith({
      event: 'activity.contribution-policy.selection',
      actorUserId: actor.id,
      actorRoleSnap: actor.role,
      resourceType: 'activity',
      resourceId: result.activityId,
      tx,
      meta,
      extra: {
        operation: 'patch_contribution_policy_selection',
        activityId: result.activityId,
        revision: 2,
        changedLayerCount: 2,
        targetCount: 3,
        pointers: [
          {
            policyId: 'policy-one',
            versionId: 'version-one',
            definitionHash: 'b'.repeat(64),
            evaluatorVersion: 1,
          },
        ],
      },
    });
    expect(JSON.stringify(log.mock.calls[0])).not.toContain('must-not-leak');
  });
});
