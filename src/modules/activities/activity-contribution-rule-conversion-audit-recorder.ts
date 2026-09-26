import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';

@Injectable()
export class ActivityContributionRuleConversionAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}

  log(
    tx: Prisma.TransactionClient,
    actor: CurrentUserPayload,
    meta: AuditMeta,
    result: {
      policyId: string;
      versionId: string;
      batchFingerprint: string;
      sourceCount: number;
    },
  ) {
    return this.auditLogs.log({
      event: 'activity.contribution-rule.conversion',
      resourceType: 'contribution-policy-version',
      resourceId: result.versionId,
      actorUserId: actor.id,
      actorRoleSnap: actor.role,
      meta,
      tx,
      extra: {
        policyId: result.policyId,
        batchFingerprint: result.batchFingerprint,
        sourceCount: result.sourceCount,
        candidateStatusCode: 'draft',
      },
    });
  }
}
