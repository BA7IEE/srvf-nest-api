import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AttendanceMemberCredentialService } from './attendance-member-credential.service';
import type {} from './dto/app/app-activity-punch.dto';

type PrismaTx = Prisma.TransactionClient;

export type LockedActivity = {
  id: string;
  statusCode: string;
};

export type LockedSession = {
  id: string;
  activityId: string;
  startAt: Date;
  endAt: Date;
  longitude: Prisma.Decimal | null;
  latitude: Prisma.Decimal | null;
  checkInOpenAt: Date;
  checkInCloseAt: Date;
  checkOutOpenAt: Date;
  checkOutCloseAt: Date;
  terminationCheckOutDeadline: Date | null;
  locationRequired: boolean;
  radiusMeters: number | null;
  accuracyWarningMeters: number;
  lateGraceMinutes: number;
  earlyLeaveThresholdMinutes: number;
};

export type LockedIdentity = {
  id: string;
  memberId: string;
  currentStatusCode: string;
  currentPositionId: string | null;
  populationIncluded: boolean;
};

export type PunchEventRow = {
  id: string;
  activityId: string;
  sessionId: string;
  positionId: string | null;
  participationIdentityId: string;
  memberId: string;
  eventTypeCode: string;
  sourceCode: string;
  occurredAt: Date;
  receivedAt: Date;
  operatorUserId: string;
  reason: string | null;
  qrCredentialId: string | null;
  importJobItemId: string | null;
  offlinePackageId: string | null;
  offlineSequence: number | null;
  offlinePriorHash: string | null;
  offlineEventPayloadHash: string | null;
  deviceId: string | null;
  longitude: Prisma.Decimal | null;
  latitude: Prisma.Decimal | null;
  accuracy: Prisma.Decimal | null;
  distance: Prisma.Decimal | null;
  geoVerified: boolean;
  outOfRange: boolean;
  lowAccuracy: boolean;
  eventKey: string;
  requestHash: string;
  supersedesEventId: string | null;
  evidenceRevision: number;
  qrCredential: { credentialVersion: number } | null;
};

/**
 * 打卡链**准入层**:Activity / Session / 参与身份 / QR 凭证 / PunchEvent 的行锁,
 * 以及托管考勤与成员凭证主体的准入断言。
 *
 * 全部方法以调用方的 `tx` 为入参 —— 事务所有权仍在 AttendancePunchCommandService
 * (第 5/6 批的唯一写入口与 Activity 根事务持有者),本类不自持 `$transaction`。
 *
 * ⚠️ 锁序由调用方负责,本类只提供取锁原语;既有顺序 Activity → Session → Identity → QR/Event
 * 不得反转(见 attendances/CLAUDE.md)。
 */
@Injectable()
export class AttendancePunchAccessService {
  constructor(private readonly memberCredentials: AttendanceMemberCredentialService) {}

  async lockActivity(
    tx: PrismaTx,
    activityId: string,
    allowedStatuses: readonly string[] = ['published'],
  ): Promise<LockedActivity> {
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
    return activity;
  }

  async lockSession(tx: PrismaTx, activityId: string, sessionId: string): Promise<LockedSession> {
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
      select: {
        id: true,
        activityId: true,
        startAt: true,
        endAt: true,
        longitude: true,
        latitude: true,
        checkInOpenAt: true,
        checkInCloseAt: true,
        checkOutOpenAt: true,
        checkOutCloseAt: true,
        terminationCheckOutDeadline: true,
        locationRequired: true,
        radiusMeters: true,
        accuracyWarningMeters: true,
        lateGraceMinutes: true,
        earlyLeaveThresholdMinutes: true,
      },
    });
    if (!session) throw new BizException(BizCode.BAD_REQUEST);
    return session;
  }

  async lockIdentityByMember(
    tx: PrismaTx,
    activityId: string,
    sessionId: string,
    memberId: string,
  ): Promise<LockedIdentity> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "ActivityParticipationIdentity"
      WHERE "activityId" = ${activityId}
        AND "sessionId" = ${sessionId}
        AND "memberId" = ${memberId}
      FOR UPDATE
    `);
    if (locked.length !== 1) throw new BizException(BizCode.ATTENDANCE_REGISTRATION_INVALID);
    const identity = await tx.activityParticipationIdentity.findFirst({
      where: { id: locked[0].id, activityId, sessionId, memberId },
      select: {
        id: true,
        memberId: true,
        currentStatusCode: true,
        currentPositionId: true,
        populationIncluded: true,
      },
    });
    if (!identity) throw new BizException(BizCode.ATTENDANCE_REGISTRATION_INVALID);
    return identity;
  }

  async lockIdentityById(
    tx: PrismaTx,
    activityId: string,
    sessionId: string,
    identityId: string,
  ): Promise<LockedIdentity> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "ActivityParticipationIdentity"
      WHERE "id" = ${identityId}
        AND "activityId" = ${activityId}
        AND "sessionId" = ${sessionId}
      FOR UPDATE
    `);
    if (locked.length !== 1) throw new BizException(BizCode.BAD_REQUEST);
    const identity = await tx.activityParticipationIdentity.findFirst({
      where: { id: identityId, activityId, sessionId },
      select: {
        id: true,
        memberId: true,
        currentStatusCode: true,
        currentPositionId: true,
        populationIncluded: true,
      },
    });
    if (!identity) throw new BizException(BizCode.BAD_REQUEST);
    return identity;
  }

  /**
   * 扫描凭证只在本事务内解出主体：既验证签名/时效，也把 User→Member 当前有效性和
   * ActivityParticipationIdentity 绑定在 Activity 根锁之后重验，不能由控制器用裸 ID 旁路。
   */
  async lockIdentityForMemberCredential(
    tx: PrismaTx,
    activityId: string,
    sessionId: string,
    token: string,
  ): Promise<LockedIdentity> {
    let credential: { userId: string; memberId: string };
    try {
      credential = this.memberCredentials.verify(token);
    } catch {
      throw new BizException(BizCode.ATTENDANCE_QR_NOT_FOUND);
    }
    await this.assertActiveMemberCredentialSubject(tx, credential.userId, credential.memberId);
    return this.lockIdentityByMember(tx, activityId, sessionId, credential.memberId);
  }

  async assertActiveMemberCredentialSubject(
    tx: PrismaTx,
    userId: string,
    memberId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
      SELECT u."id" AS "userId"
      FROM "User" u
      INNER JOIN "Member" m ON m."id" = u."memberId"
      WHERE u."id" = ${userId}
        AND u."memberId" = ${memberId}
        AND u."status" = 'ACTIVE'
        AND u."deletedAt" IS NULL
        AND m."status" = 'ACTIVE'
        AND m."deletedAt" IS NULL
      FOR SHARE OF u, m
    `);
    if (rows.length !== 1) throw new BizException(BizCode.ATTENDANCE_QR_NOT_FOUND);
  }

  async lockQrCredential(
    tx: PrismaTx,
    credentialId: string,
    activityId: string,
    sessionId: string,
  ): Promise<{
    id: string;
    actionCode: string;
    credentialVersion: number;
    statusCode: string;
    tokenDigest: string;
    validFrom: Date;
    validUntil: Date;
  }> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "AttendanceQrCredential"
      WHERE "id" = ${credentialId}
        AND "activityId" = ${activityId}
        AND "sessionId" = ${sessionId}
      FOR UPDATE
    `);
    if (locked.length !== 1) throw new BizException(BizCode.ATTENDANCE_QR_NOT_FOUND);
    const credential = await tx.attendanceQrCredential.findFirst({
      where: { id: credentialId, activityId, sessionId },
      select: {
        id: true,
        actionCode: true,
        credentialVersion: true,
        statusCode: true,
        tokenDigest: true,
        validFrom: true,
        validUntil: true,
      },
    });
    if (!credential) throw new BizException(BizCode.ATTENDANCE_QR_NOT_FOUND);
    return credential;
  }

  async lockEvent(tx: PrismaTx, activityId: string, eventId: string): Promise<PunchEventRow> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "AttendancePunchEvent"
      WHERE "id" = ${eventId} AND "activityId" = ${activityId}
      FOR UPDATE
    `);
    if (locked.length !== 1) throw new BizException(BizCode.BAD_REQUEST);
    const row = await tx.attendancePunchEvent.findFirst({
      where: { id: eventId, activityId },
      select: PUNCH_EVENT_SELECT,
    });
    if (!row) throw new BizException(BizCode.BAD_REQUEST);
    return row;
  }

  async assertManagedAttendance(
    tx: PrismaTx,
    activityId: string,
    currentUser: CurrentUserPayload,
  ): Promise<void> {
    if (currentUser.memberId === null) throw new BizException(BizCode.RBAC_FORBIDDEN);
    const assignments = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "activity_responsibility_assignments"
      WHERE "activityId" = ${activityId}
        AND "memberId" = ${currentUser.memberId}
        AND "status" = 'active'
        AND "canManageAttendance" = true
      ORDER BY "id" ASC
      FOR SHARE
    `);
    if (assignments.length === 0) throw new BizException(BizCode.RBAC_FORBIDDEN);
  }
}

export const PUNCH_EVENT_SELECT = {
  id: true,
  activityId: true,
  sessionId: true,
  positionId: true,
  participationIdentityId: true,
  memberId: true,
  eventTypeCode: true,
  sourceCode: true,
  occurredAt: true,
  receivedAt: true,
  operatorUserId: true,
  reason: true,
  qrCredentialId: true,
  importJobItemId: true,
  offlinePackageId: true,
  offlineSequence: true,
  offlinePriorHash: true,
  offlineEventPayloadHash: true,
  deviceId: true,
  longitude: true,
  latitude: true,
  accuracy: true,
  distance: true,
  geoVerified: true,
  outOfRange: true,
  lowAccuracy: true,
  eventKey: true,
  requestHash: true,
  supersedesEventId: true,
  evidenceRevision: true,
  qrCredential: { select: { credentialVersion: true } },
} satisfies Prisma.AttendancePunchEventSelect;
