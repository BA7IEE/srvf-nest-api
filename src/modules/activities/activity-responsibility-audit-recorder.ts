import { Injectable } from '@nestjs/common';
import type { Prisma, Role } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';

@Injectable()
export class ActivityResponsibilityAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}

  async log(args: {
    activityId: string;
    operation:
      | 'responsibility-owner-create'
      | 'responsibility-collaborator-create'
      | 'responsibility-collaborator-end'
      | 'responsibility-transfer'
      | 'responsibility-legacy-claim'
      | 'responsibility-assign-initiator';
    actorUserId: string;
    actorRoleSnap: Role;
    auditMeta: AuditMeta;
    tx: Prisma.TransactionClient;
    assignmentId?: string;
    targetMemberId?: string;
    canManageRegistrations?: boolean;
    canManageAttendance?: boolean;
    source?: string;
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
        ...(args.assignmentId ? { assignmentId: args.assignmentId } : {}),
        ...(args.targetMemberId ? { targetMemberId: args.targetMemberId } : {}),
        ...(args.canManageRegistrations !== undefined
          ? { canManageRegistrations: args.canManageRegistrations }
          : {}),
        ...(args.canManageAttendance !== undefined
          ? { canManageAttendance: args.canManageAttendance }
          : {}),
        ...(args.source ? { source: args.source } : {}),
      },
      tx: args.tx,
    });
  }
}
