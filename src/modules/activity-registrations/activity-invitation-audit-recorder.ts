import { Injectable } from '@nestjs/common';
import type { Prisma, Role } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';

type PrismaTx = Prisma.TransactionClient;
type InvitationOperation = 'accept' | 'create' | 'decline' | 'revoke' | 'expire';

type InvitationAuditRow = {
  id: string;
  activityId: string;
  sessionId: string | null;
  positionId: string | null;
  statusCode: string;
  expiresAt: Date;
};

@Injectable()
export class ActivityInvitationAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}

  async logInvitationChange(args: {
    invitation: InvitationAuditRow;
    before?: InvitationAuditRow;
    actorUserId: string | null;
    actorRoleSnap: Role | null;
    operation: InvitationOperation;
    auditMeta: AuditMeta;
    tx: PrismaTx;
  }): Promise<void> {
    await this.auditLogs.log({
      event: 'invitation.change',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: 'activity_invitation',
      resourceId: args.invitation.id,
      meta: args.auditMeta,
      ...(args.before === undefined ? {} : { before: this.invitationSnapshot(args.before) }),
      after: this.invitationSnapshot(args.invitation),
      extra: {
        operation: args.operation,
        activityId: args.invitation.activityId,
        scope: this.scopeOf(args.invitation),
      },
      tx: args.tx,
    });
  }

  async logVisitorCreate(args: {
    visitorId: string;
    activityId: string;
    sessionId: string;
    invitedByMemberProvided: boolean;
    actorUserId: string;
    actorRoleSnap: Role;
    auditMeta: AuditMeta;
    tx: PrismaTx;
  }): Promise<void> {
    await this.auditLogs.log({
      event: 'visitor.create',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: 'activity_visitor',
      resourceId: args.visitorId,
      meta: args.auditMeta,
      after: { activityId: args.activityId, sessionId: args.sessionId },
      extra: {
        operation: 'create',
        invitedByMemberProvided: args.invitedByMemberProvided,
      },
      tx: args.tx,
    });
  }

  private invitationSnapshot(row: InvitationAuditRow): Record<string, unknown> {
    return {
      statusCode: row.statusCode,
      expiresAt: row.expiresAt,
      scope: this.scopeOf(row),
    };
  }

  private scopeOf(row: Pick<InvitationAuditRow, 'sessionId' | 'positionId'>): string {
    if (row.positionId !== null) return 'position';
    if (row.sessionId !== null) return 'session';
    return 'activity';
  }
}
