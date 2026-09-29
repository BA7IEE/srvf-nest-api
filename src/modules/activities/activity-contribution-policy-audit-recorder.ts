import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { ContributionPolicyCommandResult } from './activity-contribution-policy-command';

@Injectable()
export class ActivityContributionPolicyAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}
  log(
    tx: Prisma.TransactionClient,
    actor: CurrentUserPayload,
    meta: AuditMeta,
    result: ContributionPolicyCommandResult,
    before: { definitionHash: string; statusCode: string } | null,
  ) {
    const policyCommand = result.operationCode === 'create_policy';
    return this.auditLogs.log({
      event: policyCommand
        ? 'activity.contribution-policy.command'
        : 'activity.contribution-policy-version.command',
      resourceType: policyCommand ? 'contribution-policy' : 'contribution-policy-version',
      resourceId: policyCommand ? result.policyId : (result.versionId ?? result.policyId),
      actorUserId: actor.id,
      actorRoleSnap: actor.role,
      meta,
      tx,
      extra: {
        operationCode: result.operationCode,
        policyId: result.policyId,
        versionId: result.versionId,
        definitionHash: result.definitionHash,
        evaluatorVersion: result.evaluatorVersion,
        beforeStatusCode: before?.statusCode ?? null,
        resultStatusCode: result.resultStatusCode,
      },
    });
  }
}
