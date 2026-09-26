import { Role, UserStatus } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ActivityContributionRuleConversionAuditRecorder } from './activity-contribution-rule-conversion-audit-recorder';

describe('E2 conversion audit whitelist', () => {
  it('records only candidate anchors, count and digest on first commit', async () => {
    const log = jest.fn().mockResolvedValue(undefined);
    const recorder = new ActivityContributionRuleConversionAuditRecorder({
      log,
    } as unknown as AuditLogsService);
    const tx = {} as Parameters<typeof recorder.log>[0];
    const actor = {
      id: 'actor',
      username: 'actor',
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
    const meta = { requestId: 'test', ip: null, ua: null };
    await recorder.log(tx, actor, meta, {
      policyId: 'policy',
      versionId: 'version',
      batchFingerprint: 'a'.repeat(64),
      sourceCount: 1,
    });
    expect(log).toHaveBeenCalledWith({
      event: 'activity.contribution-rule.conversion',
      resourceType: 'contribution-policy-version',
      resourceId: 'version',
      actorUserId: 'actor',
      actorRoleSnap: Role.SUPER_ADMIN,
      meta,
      tx,
      extra: {
        policyId: 'policy',
        batchFingerprint: 'a'.repeat(64),
        sourceCount: 1,
        candidateStatusCode: 'draft',
      },
    });
  });
});
