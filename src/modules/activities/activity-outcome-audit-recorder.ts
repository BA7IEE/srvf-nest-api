import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { ActivityOutcomeCommandResult } from './activity-outcome-command';

@Injectable()
export class ActivityOutcomeAuditRecorder {
  constructor(private readonly audit: AuditLogsService) {}
  async log(
    tx: Prisma.TransactionClient,
    actor: CurrentUserPayload,
    meta: AuditMeta,
    result: ActivityOutcomeCommandResult,
    priorRevisionId: string | null,
  ) {
    await this.audit.log({
      event: 'activity.outcome.command',
      actorUserId: actor.id,
      actorRoleSnap: actor.role,
      resourceType: 'activity',
      resourceId: result.activityId,
      tx,
      meta,
      extra: {
        operation: 'record_manual_outcome',
        outcomeRevisionId: result.outcomeRevisionId,
        revision: result.revision,
        priorRevisionId,
        sourceCode: 'manual',
        afterStatus: 'draft',
        priorAfterStatus: priorRevisionId ? 'superseded' : null,
        valueCount: result.valueCount,
        evidenceCount: result.evidenceCount,
      },
    });
  }
}
