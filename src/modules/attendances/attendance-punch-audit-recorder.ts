import { Injectable } from '@nestjs/common';
import type { Prisma, Role } from '@prisma/client';

import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';

type QrAuditOperation = 'attendance-qr.issue' | 'attendance-qr.revoke' | 'attendance-qr.render';
type PunchAuditOperation =
  | 'attendance-punch.create'
  | 'attendance-punch.void'
  | 'attendance-punch.replace';
type OnsiteBatchAuditOperation =
  | 'attendance-bulk.create'
  | 'attendance-import.preview'
  | 'attendance-import.execute';

@Injectable()
export class AttendancePunchAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}

  async logQr(args: {
    operation: QrAuditOperation;
    activityId: string;
    sessionId: string;
    credentialId: string;
    actionCode: string;
    credentialVersion: number;
    statusCode: string;
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
        sessionId: args.sessionId,
        credentialId: args.credentialId,
        actionCode: args.actionCode,
        credentialVersion: args.credentialVersion,
        statusCode: args.statusCode,
      },
      tx: args.tx,
    });
  }

  async logPunch(args: {
    operation: PunchAuditOperation;
    activityId: string;
    sessionId: string;
    participationIdentityId: string;
    eventId: string;
    eventTypeCode: string;
    sourceCode: string;
    evidenceRevision: number;
    supersedesEventId: string | null;
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
        sessionId: args.sessionId,
        participationIdentityId: args.participationIdentityId,
        eventId: args.eventId,
        eventTypeCode: args.eventTypeCode,
        sourceCode: args.sourceCode,
        evidenceRevision: args.evidenceRevision,
        supersedesEventId: args.supersedesEventId,
      },
      tx: args.tx,
    });
  }

  async logOnsiteBatchJob(args: {
    operation: OnsiteBatchAuditOperation;
    activityId: string;
    sessionId: string;
    jobId: string;
    total: number;
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
        sessionId: args.sessionId,
        jobId: args.jobId,
        total: args.total,
      },
      tx: args.tx,
    });
  }
}
