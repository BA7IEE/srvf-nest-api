import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { TimePolicyCommandResult } from './activity-time-policy-command';

@Injectable()
export class ActivityTimePolicyAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}
  log(
    tx: Prisma.TransactionClient,
    actor: CurrentUserPayload,
    meta: AuditMeta,
    result: TimePolicyCommandResult,
    before: { definitionHash: string; statusCode: string } | null,
  ) {
    return this.auditLogs.log({
      event: 'activity.time-policy.command',
      resourceType: 'activity-time-policy',
      resourceId: result.policyId,
      actorUserId: actor.id,
      actorRoleSnap: actor.role,
      meta,
      tx,
      extra: {
        operationCode: result.operationCode,
        versionId: result.versionId,
        beforeHash: before?.definitionHash ?? null,
        afterHash: result.definitionHash,
        beforeStatus: before?.statusCode ?? null,
        afterStatus: result.resultStatusCode,
      },
    });
  }
}
