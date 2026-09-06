import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type {
  ActivityMetricSelectionColumns,
  ActivityMetricSelectionResult,
} from './activity-metric-selection';

export type MetricSelectionSource =
  | 'admin'
  | 'app'
  | 'template'
  | 'professional'
  | 'emergency'
  | 'series'
  | 'clone';
@Injectable()
export class ActivityMetricSelectionAuditRecorder {
  constructor(private readonly audit: AuditLogsService) {}
  async log(
    tx: Prisma.TransactionClient,
    actor: CurrentUserPayload,
    meta: AuditMeta,
    source: MetricSelectionSource,
    result: ActivityMetricSelectionResult,
    before: ActivityMetricSelectionColumns | null,
  ) {
    await this.audit.log({
      event: 'activity.metric-selection.command',
      actorUserId: actor.id,
      actorRoleSnap: actor.role,
      resourceType: 'activity',
      resourceId: result.activityId,
      tx,
      meta,
      extra: {
        operation: 'select_metric_set',
        source,
        beforeMode: before?.metricRequirementCode ?? null,
        beforeRevision: before?.metricSelectionRevision ?? 0,
        beforeHash: before?.selectedMetricSetDefinitionHash ?? null,
        afterMode: result.metricRequirementCode,
        afterRevision: result.metricSelectionRevision,
        afterHash: result.metricSetPointer?.definitionHash ?? null,
      },
    });
  }
}
