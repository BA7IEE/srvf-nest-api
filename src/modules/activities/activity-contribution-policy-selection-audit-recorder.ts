import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type {
  ActivityContributionPolicyPointer,
  ActivityContributionPolicySelectionReceiptResult,
} from './activity-contribution-policy-selection';

@Injectable()
export class ActivityContributionPolicySelectionAuditRecorder {
  constructor(private readonly audit: AuditLogsService) {}

  async log(
    tx: Prisma.TransactionClient,
    actor: CurrentUserPayload,
    meta: AuditMeta,
    result: ActivityContributionPolicySelectionReceiptResult,
    args: {
      changedLayerCount: number;
      targetCount: number;
      pointers: readonly ActivityContributionPolicyPointer[];
      operation?: string;
    },
  ): Promise<void> {
    const pointers = [...args.pointers]
      .sort(
        (left, right) =>
          left.policyId.localeCompare(right.policyId) ||
          left.versionId.localeCompare(right.versionId),
      )
      .map((pointer) => ({
        policyId: pointer.policyId,
        versionId: pointer.versionId,
        definitionHash: pointer.definitionHash,
        evaluatorVersion: pointer.evaluatorVersion,
      }));
    await this.audit.log({
      event: 'activity.contribution-policy.selection',
      actorUserId: actor.id,
      actorRoleSnap: actor.role,
      resourceType: 'activity',
      resourceId: result.activityId,
      tx,
      meta,
      extra: {
        operation: args.operation ?? 'patch_contribution_policy_selection',
        activityId: result.activityId,
        revision: result.revision,
        changedLayerCount: args.changedLayerCount,
        targetCount: args.targetCount,
        pointers,
      },
    });
  }
}
