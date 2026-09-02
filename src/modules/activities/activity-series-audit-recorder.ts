import { Injectable } from '@nestjs/common';
import type { Prisma, Role } from '@prisma/client';

import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';

type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class ActivitySeriesAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}

  async logSeriesCommand(args: {
    readonly operation:
      | 'create_series'
      | 'revise_series'
      | 'set_series_status'
      | 'generate_instances';
    readonly seriesId: string;
    readonly revision?: number;
    readonly statusCode?: string;
    readonly actorUserId: string;
    readonly actorRoleSnap: Role;
    readonly auditMeta: AuditMeta;
    readonly tx: PrismaTx;
  }): Promise<void> {
    await this.auditLogs.log({
      event: 'activity-series.change',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: 'activity-series',
      resourceId: args.seriesId,
      meta: args.auditMeta,
      extra: {
        operation: args.operation,
        ...(args.revision === undefined ? {} : { revision: args.revision }),
        ...(args.statusCode === undefined ? {} : { statusCode: args.statusCode }),
      },
      tx: args.tx,
    });
  }

  async logGeneratedOccurrence(args: {
    readonly activityId: string;
    readonly seriesId: string;
    readonly revision: number;
    readonly occurrenceKey: string;
    readonly templateVersionId: string;
    readonly actorUserId: string;
    readonly actorRoleSnap: Role;
    readonly auditMeta: AuditMeta;
    readonly tx: PrismaTx;
  }): Promise<void> {
    await this.auditLogs.log({
      event: 'activity.publish',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: 'activity',
      resourceId: args.activityId,
      meta: args.auditMeta,
      extra: {
        operation: 'generate_series_instance',
        seriesId: args.seriesId,
        revision: args.revision,
        occurrenceKey: args.occurrenceKey,
        templateVersionId: args.templateVersionId,
      },
      tx: args.tx,
    });
  }
}
