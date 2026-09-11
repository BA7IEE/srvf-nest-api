import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { ActivityTimePolicySelectionReceiptResult } from './activity-time-policy-selection';

@Injectable()
export class ActivityTimePolicySelectionAuditRecorder {
  constructor(private readonly audit: AuditLogsService) {}

  async log(
    tx: Prisma.TransactionClient,
    actor: CurrentUserPayload,
    meta: AuditMeta,
    result: ActivityTimePolicySelectionReceiptResult,
    targetCount: number,
    operation = 'patch_time_policy_selection',
  ): Promise<void> {
    await this.audit.log({
      event: 'activity.time-policy.selection',
      actorUserId: actor.id,
      actorRoleSnap: actor.role,
      resourceType: 'activity',
      resourceId: result.activityId,
      tx,
      meta,
      extra: {
        operation,
        revision: result.revision,
        selectionHash: result.selectionHash,
        targetCount,
      },
    });
  }
}
