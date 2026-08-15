import { Injectable } from '@nestjs/common';
import type { Prisma, Role } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';

/** 草稿场次／岗位写入与活动根写入同事务落审计；不记录坐标或请求体。 */
@Injectable()
export class ActivityDraftAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}

  async log(args: {
    activityId: string;
    operation?:
      | 'draft-session-create'
      | 'draft-session-update'
      | 'draft-session-delete'
      | 'draft-session-position-create'
      | 'draft-session-position-update'
      | 'draft-session-position-delete'
      | 'draft-registration-form-update';
    actorUserId: string;
    actorRoleSnap: Role;
    auditMeta: AuditMeta;
    tx: Prisma.TransactionClient;
    sessionId?: string;
    positionId?: string;
    formVersionId?: string;
    changedFields?: string[];
  }): Promise<void> {
    await this.auditLogs.log({
      event: 'activity.publish',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: 'activity',
      resourceId: args.activityId,
      meta: args.auditMeta,
      extra: {
        ...(args.operation ? { operation: args.operation } : {}),
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        ...(args.positionId ? { positionId: args.positionId } : {}),
        ...(args.formVersionId ? { formVersionId: args.formVersionId } : {}),
        ...(args.changedFields ? { changedFields: args.changedFields } : {}),
      },
      tx: args.tx,
    });
  }
}
