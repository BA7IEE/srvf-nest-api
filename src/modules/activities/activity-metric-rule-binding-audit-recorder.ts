import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { MetricRuleBindingCommandResult } from './activity-metric-rule-binding-command';

@Injectable()
export class ActivityMetricRuleBindingAuditRecorder {
  constructor(private readonly audit: AuditLogsService) {}
  async log(
    tx: Prisma.TransactionClient,
    actor: CurrentUserPayload,
    meta: AuditMeta,
    result: MetricRuleBindingCommandResult,
    reused: boolean,
  ) {
    await this.audit.log({
      event: 'activity.metric-rule-binding.command',
      actorUserId: actor.id,
      actorRoleSnap: actor.role,
      resourceType: 'activity-metric-rule-binding',
      resourceId: result.bindingId,
      tx,
      meta,
      extra: {
        operation: 'create_metric_rule_binding',
        metricDefinitionId: result.metricDefinitionId,
        definitionHash: result.definitionHash,
        bindingHash: result.bindingHash,
        ruleCode: result.ruleCode,
        evaluatorVersion: result.evaluatorVersion,
        reused,
      },
    });
  }
}
