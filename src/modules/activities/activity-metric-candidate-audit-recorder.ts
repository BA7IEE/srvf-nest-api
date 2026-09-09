import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { MetricCandidateCommandResult } from './activity-metric-candidate-command';

@Injectable()
export class ActivityMetricCandidateAuditRecorder {
  constructor(private readonly audit: AuditLogsService) {}
  async log(
    tx: Prisma.TransactionClient,
    actor: CurrentUserPayload,
    meta: AuditMeta,
    result: MetricCandidateCommandResult,
    priorCandidateId: string | null,
  ) {
    await this.audit.log({
      event: 'activity.metric-candidate.command',
      actorUserId: actor.id,
      actorRoleSnap: actor.role,
      resourceType: 'activity',
      resourceId: result.activityId,
      tx,
      meta,
      extra: {
        operation: 'calculate_metric_candidate',
        candidateId: result.candidateId,
        revision: result.revision,
        priorCandidateId,
        sourceCode: 'system',
        afterStatus: 'candidate',
        valueCount: result.valueCount,
        sourceCount: result.sourceCount,
      },
    });
  }
}
