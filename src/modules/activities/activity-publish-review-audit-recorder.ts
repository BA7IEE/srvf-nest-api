import { Injectable } from '@nestjs/common';
import type { Prisma, Role } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';

@Injectable()
export class ActivityPublishReviewAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}

  async log(args: {
    activityId: string;
    reviewId: string;
    operation:
      | 'publish-review-submit'
      | 'publish-review-approve'
      | 'publish-review-return'
      | 'publish-review-withdraw';
    requestVersion: number;
    requestType: string;
    directPublish: boolean;
    actorUserId: string;
    actorRoleSnap: Role;
    auditMeta: AuditMeta;
    tx: Prisma.TransactionClient;
  }): Promise<void> {
    await this.auditLogs.log({
      event: 'activity.publish',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: 'activity',
      resourceId: args.activityId,
      meta: args.auditMeta,
      extra: {
        operation: args.operation,
        reviewId: args.reviewId,
        requestVersion: args.requestVersion,
        requestType: args.requestType,
        directPublish: args.directPublish,
      },
      tx: args.tx,
    });
  }

  // B7 审批单列审计形状；历史审核仍经 log() 保持原 extra 完全不变。
  async logAudienceTagsApproved(args: {
    activityId: string;
    reviewId: string;
    requestVersion: number;
    actorUserId: string;
    actorRoleSnap: Role;
    audienceTagCodes: string[];
    recipientCount: number;
    auditMeta: AuditMeta;
    tx: Prisma.TransactionClient;
  }): Promise<void> {
    await this.auditLogs.log({
      event: 'activity.publish',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: 'activity',
      resourceId: args.activityId,
      meta: args.auditMeta,
      extra: {
        operation: 'publish-review-approve-with-audience-tags',
        reviewId: args.reviewId,
        requestVersion: args.requestVersion,
        requestType: 'initial',
        directPublish: false,
        audienceTagCodes: args.audienceTagCodes,
        recipientCount: args.recipientCount,
      },
      tx: args.tx,
    });
  }
}
