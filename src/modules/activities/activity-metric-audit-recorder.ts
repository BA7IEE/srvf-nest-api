import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { MetricCommandResult, MetricOperation } from './activity-metric-command';

@Injectable()
export class ActivityMetricAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}

  async log(args: {
    tx: Prisma.TransactionClient;
    actor: CurrentUserPayload;
    meta: AuditMeta;
    operation: MetricOperation;
    result: MetricCommandResult;
    before: { definitionHash: string; statusCode: string } | null;
  }): Promise<void> {
    const isDefinition = args.operation.endsWith('_definition');
    await this.auditLogs.log({
      event: isDefinition ? 'activity.metric-definition.command' : 'activity.metric-set.command',
      actorUserId: args.actor.id,
      actorRoleSnap: args.actor.role,
      resourceType: isDefinition ? 'activity-metric-definition' : 'activity-metric-set',
      resourceId: args.result.id,
      tx: args.tx,
      meta: args.meta,
      extra: {
        operation: args.operation,
        code: args.result.code,
        version: args.result.version,
        beforeHash: args.before?.definitionHash ?? null,
        beforeStatus: args.before?.statusCode ?? null,
        afterHash: args.result.definitionHash,
        afterStatus: args.result.statusCode,
      },
    });
  }
}
