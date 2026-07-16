import { Injectable } from '@nestjs/common';
import type { Prisma, Role } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';

type PrismaTx = Prisma.TransactionClient;

interface ActivityPositionAuditSnapshotInput {
  id: string;
  activityId: string;
  name: string;
  attendanceRoleCode: string;
  capacity: number | null;
  startAt: Date | null;
  endAt: Date | null;
  genderRequirementCode: string | null;
  description: string | null;
  sortOrder: number;
  deletedAt: Date | null;
}

@Injectable()
export class ActivityPositionAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}

  async logCreate(args: {
    activityPosition: ActivityPositionAuditSnapshotInput;
    actorUserId: string;
    actorRoleSnap: Role;
    auditMeta: AuditMeta;
    tx: PrismaTx;
  }): Promise<void> {
    await this.auditLogs.log({
      event: 'activity.publish',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: 'activity',
      resourceId: args.activityPosition.activityId,
      meta: args.auditMeta,
      after: this.toSnapshot(args.activityPosition),
      extra: {
        operation: 'activityPosition.create',
        activityPositionId: args.activityPosition.id,
      },
      tx: args.tx,
    });
  }

  async logUpdate(args: {
    before: ActivityPositionAuditSnapshotInput;
    after: ActivityPositionAuditSnapshotInput;
    changedFields: string[];
    actorUserId: string;
    actorRoleSnap: Role;
    auditMeta: AuditMeta;
    tx: PrismaTx;
  }): Promise<void> {
    await this.auditLogs.log({
      event: 'activity.publish',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: 'activity',
      resourceId: args.before.activityId,
      meta: args.auditMeta,
      before: this.toSnapshot(args.before),
      after: this.toSnapshot(args.after),
      extra: {
        operation: 'activityPosition.update',
        activityPositionId: args.before.id,
        changedFields: args.changedFields,
      },
      tx: args.tx,
    });
  }

  async logSoftDelete(args: {
    before: ActivityPositionAuditSnapshotInput;
    after: ActivityPositionAuditSnapshotInput;
    actorUserId: string;
    actorRoleSnap: Role;
    auditMeta: AuditMeta;
    tx: PrismaTx;
  }): Promise<void> {
    await this.auditLogs.log({
      event: 'activity.publish',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: 'activity',
      resourceId: args.before.activityId,
      meta: args.auditMeta,
      before: this.toSnapshot(args.before),
      after: this.toSnapshot(args.after),
      extra: {
        operation: 'activityPosition.softDelete',
        activityPositionId: args.before.id,
      },
      tx: args.tx,
    });
  }

  private toSnapshot(
    activityPosition: ActivityPositionAuditSnapshotInput,
  ): Record<string, unknown> {
    return {
      activityPositionId: activityPosition.id,
      activityId: activityPosition.activityId,
      name: activityPosition.name,
      attendanceRoleCode: activityPosition.attendanceRoleCode,
      capacity: activityPosition.capacity,
      startAt: activityPosition.startAt,
      endAt: activityPosition.endAt,
      genderRequirementCode: activityPosition.genderRequirementCode,
      description: activityPosition.description,
      sortOrder: activityPosition.sortOrder,
      deletedAt: activityPosition.deletedAt,
    };
  }
}
