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
      | 'publish-review-direct'
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
}
