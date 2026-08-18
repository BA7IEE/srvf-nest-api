import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { normalizeAttendancePunchReason } from './attendance-punch-request-hash';
import type {} from './dto/app/app-managed-onsite-operations.dto';

type PrismaTx = Prisma.TransactionClient;

export type PackageRow = {
  id: string;
  activityId: string;
  sessionId: string;
  operatorUserId: string;
  operatorMemberId: string;
  deviceId: string;
  packageVersion: number;
  packageKeyVersion: number;
  statusCode: string;
  tokenDigest: string;
  ruleSnapshotId: string;
  ruleSnapshotHash: string;
  workflowRevision: number;
  participantSnapshotHash: string;
  validFrom: Date;
  validUntil: Date;
  uploadUntil: Date;
  sequenceStart: number;
  nextExpectedSequence: number;
  chainAnchorHash: string;
  lastAcceptedHash: string;
  lastAcceptedAt: Date | null;
  issuedAt: Date;
  issueOperationKey: string;
  issueRequestHash: string;
  revokedByUserId: string | null;
  revokedAt: Date | null;
  revokeReason: string | null;
  revokeOperationKey: string | null;
  revokeRequestHash: string | null;
};

export type FrozenParticipant = {
  participationIdentityId: string;
  memberId: string;
  participationRevisionId: string;
  positionId: string | null;
};

export type ReviewRow = {
  id: string;
  offlinePackageId: string;
  activityId: string;
  sessionId: string;
  sequence: number;
  eventKey: string;
  statusCode: string;
  anomalyCode: string;
  approvalPolicyCode: string;
  participationIdentityId: string | null;
  participationRevisionId: string | null;
  actionCode: string | null;
  deviceTime: Date | null;
  longitude: Prisma.Decimal | null;
  latitude: Prisma.Decimal | null;
  accuracy: Prisma.Decimal | null;
  providedPriorHash: string | null;
  eventPayloadHash: string | null;
  signatureDigest: string | null;
  stagedAt: Date;
  reviewedAt: Date | null;
  reviewReason: string | null;
  resolutionOperationKey: string | null;
  resolutionRequestHash: string | null;
  formalPunchEventId: string | null;
};

export function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * 离线包链**准入/原语层**:Activity / Session / OfflinePackage / Review / 参与人的行锁,
 * 托管考勤准入断言、场次时间窗判定、冻结参与人时效校验,以及唯一键重放包装与理由归一。
 *
 * 全部方法以调用方的 `tx` 为入参 —— 事务所有权仍在 AttendanceOfflinePackageService
 * (B6-2 离线写链的 Activity → OfflinePackage 根事务持有者),本类不自持 `$transaction`。
 *
 * ⚠️ `withUniqueReplay` 只包装唯一键冲突的重放语义,不改任何业务判定。
 */
@Injectable()
export class AttendanceOfflinePackageAccessService {
  async lockActivity(
    tx: PrismaTx,
    activityId: string,
    allowedStatuses: readonly string[] = ['published'],
  ): Promise<{ statusCode: string }> {
    const rows = await tx.$queryRaw<Array<{ id: string; statusCode: string }>>(Prisma.sql`
      SELECT "id", "statusCode" FROM "Activity"
      WHERE "id" = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    if (rows.length !== 1) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    const activity = rows[0];
    if (!activity || !allowedStatuses.includes(activity.statusCode)) {
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    }
    return { statusCode: activity.statusCode };
  }

  async lockIssuableSession(
    tx: PrismaTx,
    activityId: string,
    sessionId: string,
  ): Promise<{ checkOutCloseAt: Date; workflowRevision: number }> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "ActivitySession"
      WHERE "id" = ${sessionId}
        AND "activityId" = ${activityId}
        AND "deletedAt" IS NULL
        AND "statusCode" = 'scheduled'
      FOR UPDATE
    `);
    if (locked.length !== 1) throw new BizException(BizCode.BAD_REQUEST);
    const session = await tx.activitySession.findFirst({
      where: { id: sessionId, activityId, deletedAt: null, statusCode: 'scheduled' },
      select: { checkOutCloseAt: true, workflowRevision: true },
    });
    if (!session) throw new BizException(BizCode.BAD_REQUEST);
    return session;
  }

  async lockPackage(tx: PrismaTx, activityId: string, packageId: string): Promise<PackageRow> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "OfflinePackage"
      WHERE "id" = ${packageId} AND "activityId" = ${activityId}
      FOR UPDATE
    `);
    if (locked.length !== 1) throw new BizException(BizCode.ATTENDANCE_OFFLINE_PACKAGE_INVALID);
    const row = await tx.offlinePackage.findFirst({
      where: { id: packageId, activityId },
      select: OFFLINE_PACKAGE_SELECT,
    });
    if (!row) throw new BizException(BizCode.ATTENDANCE_OFFLINE_PACKAGE_INVALID);
    return row;
  }

  async lockReview(tx: PrismaTx, activityId: string, reviewItemId: string): Promise<ReviewRow> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "OfflinePunchReviewItem"
      WHERE "id" = ${reviewItemId} AND "activityId" = ${activityId}
      FOR UPDATE
    `);
    if (locked.length !== 1) throw new BizException(BizCode.BAD_REQUEST);
    const row = await tx.offlinePunchReviewItem.findFirst({
      where: { id: reviewItemId, activityId },
      select: OFFLINE_REVIEW_SELECT,
    });
    if (!row) throw new BizException(BizCode.BAD_REQUEST);
    return row;
  }

  async lockIssuableParticipants(
    tx: PrismaTx,
    activityId: string,
    sessionId: string,
  ): Promise<FrozenParticipant[]> {
    return tx.$queryRaw<FrozenParticipant[]>(Prisma.sql`
      SELECT
        i."id" AS "participationIdentityId",
        i."memberId",
        r."id" AS "participationRevisionId",
        i."currentPositionId" AS "positionId"
      FROM "ActivityParticipationIdentity" i
      INNER JOIN "ActivityParticipationRevision" r
        ON r."identityId" = i."id" AND r."revision" = i."currentRevision"
      WHERE i."activityId" = ${activityId}
        AND i."sessionId" = ${sessionId}
        AND i."currentStatusCode" = 'pass'
        AND i."populationIncluded" = true
        AND r."statusCode" = 'pass'
      ORDER BY i."id" COLLATE "C" ASC
      FOR SHARE OF i, r
    `);
  }

  async frozenParticipantIsCurrent(
    tx: PrismaTx,
    offlinePackage: PackageRow,
    participant: FrozenParticipant,
    credential: { userId: string; memberId: string } | null,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT i."id"
      FROM "ActivityParticipationIdentity" i
      INNER JOIN "ActivityParticipationRevision" r
        ON r."id" = ${participant.participationRevisionId}
        AND r."identityId" = i."id"
        AND r."revision" = i."currentRevision"
      INNER JOIN "Member" m ON m."id" = i."memberId"
      ${
        credential === null
          ? Prisma.empty
          : Prisma.sql`INNER JOIN "User" u ON u."id" = ${credential.userId} AND u."memberId" = i."memberId"`
      }
      WHERE i."id" = ${participant.participationIdentityId}
        AND i."activityId" = ${offlinePackage.activityId}
        AND i."sessionId" = ${offlinePackage.sessionId}
        AND i."memberId" = ${participant.memberId}
        AND i."currentStatusCode" = 'pass'
        AND i."populationIncluded" = true
        AND i."currentPositionId" IS NOT DISTINCT FROM ${participant.positionId}
        AND r."statusCode" = 'pass'
        AND m."status" = 'ACTIVE'
        AND m."deletedAt" IS NULL
        ${
          credential === null
            ? Prisma.empty
            : Prisma.sql`AND u."status" = 'ACTIVE' AND u."deletedAt" IS NULL`
        }
      FOR SHARE OF i, r, m${credential === null ? Prisma.empty : Prisma.sql`, u`}
    `);
    return (
      rows.length === 1 && (credential === null || credential.memberId === participant.memberId)
    );
  }

  async hasManagedAttendance(
    tx: PrismaTx,
    activityId: string,
    memberId: string | null,
  ): Promise<boolean> {
    if (memberId === null) return false;
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "activity_responsibility_assignments"
      WHERE "activityId" = ${activityId}
        AND "memberId" = ${memberId}
        AND "status" = 'active'
        AND "canManageAttendance" = true
      ORDER BY "id" ASC
      FOR SHARE
    `);
    return rows.length > 0;
  }

  async requireManagedAttendance(
    tx: PrismaTx,
    activityId: string,
    memberId: string,
  ): Promise<void> {
    if (!(await this.hasManagedAttendance(tx, activityId, memberId))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  async inSessionWindow(
    tx: PrismaTx,
    activityId: string,
    sessionId: string,
    action: 'check_in' | 'check_out',
    at: Date,
  ): Promise<boolean> {
    const session = await tx.activitySession.findFirst({
      where: { id: sessionId, activityId, deletedAt: null, statusCode: 'scheduled' },
      select: {
        checkInOpenAt: true,
        checkInCloseAt: true,
        checkOutOpenAt: true,
        checkOutCloseAt: true,
        terminationCheckOutDeadline: true,
      },
    });
    if (!session) return false;
    const from = action === 'check_in' ? session.checkInOpenAt : session.checkOutOpenAt;
    const until =
      action === 'check_in'
        ? session.checkInCloseAt
        : (session.terminationCheckOutDeadline ?? session.checkOutCloseAt);
    return at >= from && at <= until;
  }

  requiredReason(value: string): string {
    const reason = normalizeAttendancePunchReason(value);
    if (reason === null) throw new BizException(BizCode.BAD_REQUEST);
    return reason;
  }

  async withUniqueReplay<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      try {
        return await operation();
      } catch (retryError) {
        if (isUniqueConflict(retryError)) {
          throw new BizException(BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT);
        }
        throw retryError;
      }
    }
  }
}

export const OFFLINE_PACKAGE_SELECT = {
  id: true,
  activityId: true,
  sessionId: true,
  operatorUserId: true,
  operatorMemberId: true,
  deviceId: true,
  packageVersion: true,
  packageKeyVersion: true,
  statusCode: true,
  tokenDigest: true,
  ruleSnapshotId: true,
  ruleSnapshotHash: true,
  workflowRevision: true,
  participantSnapshotHash: true,
  validFrom: true,
  validUntil: true,
  uploadUntil: true,
  sequenceStart: true,
  nextExpectedSequence: true,
  chainAnchorHash: true,
  lastAcceptedHash: true,
  lastAcceptedAt: true,
  issuedAt: true,
  issueOperationKey: true,
  issueRequestHash: true,
  revokedByUserId: true,
  revokedAt: true,
  revokeReason: true,
  revokeOperationKey: true,
  revokeRequestHash: true,
} satisfies Prisma.OfflinePackageSelect;

export const OFFLINE_REVIEW_SELECT = {
  id: true,
  offlinePackageId: true,
  activityId: true,
  sessionId: true,
  sequence: true,
  eventKey: true,
  statusCode: true,
  anomalyCode: true,
  approvalPolicyCode: true,
  participationIdentityId: true,
  participationRevisionId: true,
  actionCode: true,
  deviceTime: true,
  longitude: true,
  latitude: true,
  accuracy: true,
  providedPriorHash: true,
  eventPayloadHash: true,
  signatureDigest: true,
  stagedAt: true,
  reviewedAt: true,
  reviewReason: true,
  resolutionOperationKey: true,
  resolutionRequestHash: true,
  formalPunchEventId: true,
} satisfies Prisma.OfflinePunchReviewItemSelect;
