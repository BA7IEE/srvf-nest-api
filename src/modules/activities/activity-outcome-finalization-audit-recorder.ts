import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { OutcomeFinalizationResult } from './activity-outcome-finalization-command';

@Injectable()
export class ActivityOutcomeFinalizationAuditRecorder {
  constructor(private readonly audit: AuditLogsService) {}

  async log(
    tx: Prisma.TransactionClient,
    actor: CurrentUserPayload,
    meta: AuditMeta,
    result: OutcomeFinalizationResult,
    baseConfirmedRevisionId: string | null,
    sourceKinds: readonly ('manual' | 'system')[],
  ): Promise<void> {
    await this.audit.log({
      event: 'activity.outcome.finalization',
      actorUserId: actor.id,
      actorRoleSnap: actor.role,
      resourceType: 'activity',
      resourceId: result.activityId,
      tx,
      meta,
      extra: {
        operation: result.operationCode,
        outcomeRevisionId: result.outcomeRevisionId,
        revision: result.revision,
        baseConfirmedRevisionId,
        createdStatusCode: result.createdStatusCode,
        sourceKinds: ['manual', 'system'].filter((kind) =>
          sourceKinds.some((source) => source === kind),
        ),
        valueCount: result.valueCount,
        evidenceCount: result.evidenceCount,
      },
    });
  }
}
