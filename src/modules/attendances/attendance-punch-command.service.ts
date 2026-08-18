import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AttendanceSegmentProjectorService } from '../activities/attendance-segment-projector.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AttendancePunchAuditRecorder } from './attendance-punch-audit-recorder';
import { AttendancePunchLocationPolicy } from './attendance-punch-location-policy';
import { AttendancePunchPresenter } from './attendance-punch-presenter';
import {
  createAttendancePunchRequestHash,
  createManagedOnlineAttendancePunchRequestHash,
  createOfflineAttendancePunchRequestHash,
  normalizeAttendancePunchReason,
} from './attendance-punch-request-hash';
import { AttendancePunchSegmentRevisionService } from './attendance-punch-segment-revision.service';
import { AttendanceMemberCredentialService } from './attendance-member-credential.service';
import { AttendanceQrCredentialService } from './attendance-qr-credential.service';
import {
  AttendancePunchAccessService,
  PUNCH_EVENT_SELECT,
  type LockedActivity,
  type LockedIdentity,
  type LockedSession,
  type PunchEventRow,
} from './attendance-punch-access.service';
import type {
  AppActivityPunchDto,
  AppActivityPunchReceiptDto,
  AppActivityPunchStateDto,
} from './dto/app/app-activity-punch.dto';

type PrismaTx = Prisma.TransactionClient;
type SelfAction = 'check_in' | 'check_out';
type ManagedAction = 'early_departure_close' | 'void' | 'replace';
type CommandAction = SelfAction | ManagedAction;
type ManagedOnlineSource = 'staff_scan' | 'proxy' | 'bulk' | 'import';

interface SelfPunchInput {
  activityId: string;
  sessionId: string;
  actionCode: SelfAction;
  dto: AppActivityPunchDto;
  currentUser: CurrentUserPayload;
  auditMeta: AuditMeta;
}

interface ManagedEarlyCloseInput {
  activityId: string;
  sessionId: string;
  participationIdentityId: string;
  reason: string;
  eventKey: string;
  currentUser: CurrentUserPayload;
  auditMeta: AuditMeta;
}

interface ManagedCorrectionInput {
  activityId: string;
  eventId: string;
  actionCode: 'void' | 'replace';
  reason: string;
  operationKey: string;
  currentUser: CurrentUserPayload;
  auditMeta: AuditMeta;
}

export interface ManagedOnlinePunchInput {
  activityId: string;
  sessionId: string;
  participationIdentityId: string | null;
  memberCredential: string | null;
  actionCode: SelfAction;
  sourceCode: ManagedOnlineSource;
  eventKey: string;
  reason: string | null;
  deviceId: string | null;
  longitude: number | null;
  latitude: number | null;
  accuracy: number | null;
  /** B6 import only: the timestamp must have been re-parsed from the pinned CSV object. */
  occurredAt?: Date | null;
  /**
   * 批量 / 导入 worker 的不可变 item 锚点。在线人工扫码与单人代签没有该锚点。
   * 事件表沿既有字段名 `importJobItemId` 同时承接 import 与 bulk 来源，不能由
   * worker 在命令事务外补写（PunchEvent 是 append-only）。
   */
  batchJobItemId?: string | null;
  currentUser: CurrentUserPayload;
  auditMeta: AuditMeta;
}

type NormalizedManagedOnlinePunchInput = Omit<ManagedOnlinePunchInput, 'reason' | 'occurredAt'> & {
  reason: string | null;
  occurredAt: Date | null;
};

export interface OfflinePunchWithinTransactionInput {
  activityId: string;
  sessionId: string;
  participationIdentityId: string;
  memberId: string;
  actionCode: SelfAction;
  eventKey: string;
  deviceTime: Date;
  receivedAt: Date;
  deviceId: string;
  longitude: number | null;
  latitude: number | null;
  accuracy: number | null;
  packageId: string;
  sequence: number;
  priorHash: string;
  eventPayloadHash: string;
  signatureDigest: string;
  operatorUserId: string;
  operatorMemberId: string;
  auditActor: CurrentUserPayload;
  auditMeta: AuditMeta;
}

export interface OfflinePunchWithinTransactionResult {
  receipt: AppActivityPunchReceiptDto;
  eventId: string;
  requestHash: string;
  evidenceRevision: number;
  replayed: boolean;
}

const THIRTY_MINUTES_MS = 30 * 60_000;

@Injectable()
export class AttendancePunchCommandService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly qrCredentials: AttendanceQrCredentialService,
    private readonly memberCredentials: AttendanceMemberCredentialService,
    private readonly locationPolicy: AttendancePunchLocationPolicy,
    private readonly projector: AttendanceSegmentProjectorService,
    private readonly segments: AttendancePunchSegmentRevisionService,
    private readonly presenter: AttendancePunchPresenter,
    private readonly audit: AttendancePunchAuditRecorder,
    private readonly access: AttendancePunchAccessService,
  ) {}

  async selfPunch(input: SelfPunchInput): Promise<AppActivityPunchReceiptDto> {
    if (input.currentUser.memberId === null) throw new BizException(BizCode.FORBIDDEN);
    let payload;
    try {
      payload = this.qrCredentials.verifyToken(input.dto.qrToken);
    } catch {
      throw new BizException(BizCode.ATTENDANCE_QR_NOT_FOUND);
    }
    if (payload.actionCode !== input.actionCode) {
      throw new BizException(BizCode.ATTENDANCE_QR_ACTION_MISMATCH);
    }
    if (payload.activityId !== input.activityId || payload.sessionId !== input.sessionId) {
      throw new BizException(BizCode.ATTENDANCE_QR_NOT_FOUND);
    }

    return this.prisma.$transaction(
      async (tx) => {
        const activity = await this.access.lockActivity(tx, input.activityId, [
          'published',
          'terminated',
        ]);
        const session = await this.access.lockSession(tx, input.activityId, input.sessionId);
        const identity = await this.access.lockIdentityByMember(
          tx,
          input.activityId,
          input.sessionId,
          input.currentUser.memberId!,
        );
        const existing = await this.findEventByKey(tx, input.dto.eventKey);
        if (existing) {
          return this.replaySelfEvent({
            existing,
            input,
            identity,
            session,
            qrVersion: payload.credentialVersion,
          });
        }

        this.assertActivityAllowsPunch(activity, input.actionCode);

        const now = new Date();
        const credential = await this.access.lockQrCredential(
          tx,
          payload.credentialId,
          input.activityId,
          input.sessionId,
        );
        if (credential.statusCode === 'revoked')
          throw new BizException(BizCode.ATTENDANCE_QR_REVOKED);
        if (credential.statusCode !== 'active')
          throw new BizException(BizCode.ATTENDANCE_PUNCH_OUTSIDE_WINDOW);
        if (credential.credentialVersion !== payload.credentialVersion) {
          throw new BizException(BizCode.ATTENDANCE_QR_VERSION_CONFLICT);
        }
        if (credential.actionCode !== input.actionCode) {
          throw new BizException(BizCode.ATTENDANCE_QR_ACTION_MISMATCH);
        }
        if (credential.tokenDigest !== this.qrCredentials.tokenDigest(input.dto.qrToken)) {
          throw new BizException(BizCode.ATTENDANCE_QR_NOT_FOUND);
        }
        if (now < credential.validFrom || now > credential.validUntil) {
          throw new BizException(BizCode.ATTENDANCE_PUNCH_OUTSIDE_WINDOW);
        }
        this.assertSessionWindow(session, input.actionCode, now);

        const priorEvents = await this.eventsForIdentity(tx, identity.id);
        const projection = this.project(priorEvents, session);
        const open = projection.segments.find((segment) => segment.checkOutAt === null) ?? null;
        if (input.actionCode === 'check_in') {
          if (!identity.populationIncluded || identity.currentStatusCode !== 'pass') {
            throw new BizException(BizCode.ATTENDANCE_REGISTRATION_INVALID);
          }
          if (open) throw new BizException(BizCode.ATTENDANCE_PUNCH_OPEN_SEGMENT_EXISTS);
        } else {
          if (!open)
            throw new BizException(BizCode.ATTENDANCE_PUNCH_CHECK_OUT_REQUIRES_OPEN_SEGMENT);
          if (now.getTime() - open.checkInAt.getTime() < THIRTY_MINUTES_MS) {
            throw new BizException(BizCode.ATTENDANCE_PUNCH_MIN_DURATION_NOT_REACHED);
          }
        }

        const checkInEvent = open
          ? (priorEvents.find((event) => event.id === open.sourceCheckInEventId) ?? null)
          : null;
        const positionId =
          input.actionCode === 'check_in'
            ? identity.currentPositionId
            : (checkInEvent?.positionId ?? null);
        const locationRule = await this.lockLocationRule(
          tx,
          input.activityId,
          input.sessionId,
          positionId,
        );
        const location = this.locationPolicy.evaluate({
          required: locationRule.required,
          radiusMeters: locationRule.radiusMeters,
          activityLongitude: this.numberOrNull(session.longitude),
          activityLatitude: this.numberOrNull(session.latitude),
          accuracyWarningMeters: session.accuracyWarningMeters,
          request: {
            longitude: input.dto.longitude,
            latitude: input.dto.latitude,
            accuracy: input.dto.accuracy,
          },
        });
        if (!location.allowed) throw new BizException(location.bizCode);

        const requestHash = createAttendancePunchRequestHash({
          operatorUserId: input.currentUser.id,
          memberId: identity.memberId,
          participationIdentityId: identity.id,
          activityId: input.activityId,
          sessionId: input.sessionId,
          positionId,
          eventTypeCode: input.actionCode,
          sourceCode: 'self_qr',
          deviceId: null,
          occurredAt: now,
          longitude: location.longitude,
          latitude: location.latitude,
          accuracy: location.accuracy,
          qrCredentialVersion: credential.credentialVersion,
          supersedesEventId: null,
          reason: null,
        });
        const evidenceRevision = await this.bumpEvidenceRevision(tx, input.activityId, now);
        const created = await tx.attendancePunchEvent.create({
          data: {
            activityId: input.activityId,
            sessionId: input.sessionId,
            positionId,
            participationIdentityId: identity.id,
            memberId: identity.memberId,
            eventTypeCode: input.actionCode,
            sourceCode: 'self_qr',
            occurredAt: now,
            receivedAt: now,
            operatorUserId: input.currentUser.id,
            operatorMemberId: input.currentUser.memberId,
            reason: null,
            qrCredentialId: credential.id,
            longitude: location.longitude,
            latitude: location.latitude,
            accuracy: location.accuracy,
            distance: location.distanceMeters,
            geoVerified: location.geoVerified,
            outOfRange: location.outOfRange,
            lowAccuracy: location.lowAccuracy,
            eventKey: input.dto.eventKey,
            requestHash,
            supersedesEventId: null,
            evidenceRevision,
          },
          select: PUNCH_EVENT_SELECT,
        });
        const afterEvents = [...priorEvents, created];
        await this.segments.rebuild({
          tx,
          identityId: identity.id,
          events: afterEvents,
          session,
          operationEventType: input.actionCode,
        });
        await this.audit.logPunch({
          operation: 'attendance-punch.create',
          activityId: input.activityId,
          sessionId: input.sessionId,
          participationIdentityId: identity.id,
          eventId: created.id,
          eventTypeCode: created.eventTypeCode,
          sourceCode: created.sourceCode,
          evidenceRevision,
          supersedesEventId: null,
          actorUserId: input.currentUser.id,
          actorRoleSnap: input.currentUser.role,
          auditMeta: input.auditMeta,
          tx,
        });
        return this.presentEvent(
          created,
          now,
          input.actionCode === 'check_in' ? 'open' : 'closed_valid',
        );
      },
      { maxWait: 60_000, timeout: 60_000 },
    );
  }

  async earlyDepartureClose(input: ManagedEarlyCloseInput): Promise<AppActivityPunchReceiptDto> {
    const reason = normalizeAttendancePunchReason(input.reason);
    if (reason === null) throw new BizException(BizCode.ATTENDANCE_EARLY_DEPARTURE_REASON_REQUIRED);
    return this.writeManagedEvent({
      activityId: input.activityId,
      sessionId: input.sessionId,
      identityId: input.participationIdentityId,
      actionCode: 'early_departure_close',
      eventKey: input.eventKey,
      reason,
      supersedesEventId: null,
      currentUser: input.currentUser,
      auditMeta: input.auditMeta,
    });
  }

  async voidEvent(input: ManagedCorrectionInput): Promise<AppActivityPunchReceiptDto> {
    return this.correctEvent(input);
  }

  async replaceEvent(input: ManagedCorrectionInput): Promise<AppActivityPunchReceiptDto> {
    return this.correctEvent(input);
  }

  /**
   * 第 6 批在线工作人员入口的唯一落点。staff/proxy/bulk/import 都复用与本人扫码相同的
   * Activity → Session → ParticipationIdentity → Event 锁序、幂等、位置和服务段投影链。
   */
  async managedPunch(input: ManagedOnlinePunchInput): Promise<AppActivityPunchReceiptDto> {
    return this.prisma.$transaction((tx) => this.managedPunchWithinTransaction(tx, input), {
      maxWait: 60_000,
      timeout: 60_000,
    });
  }

  /**
   * ActivityBatchWorker 的单 item 事务复用同一写核。调用方必须已经持有自己的 job/item
   * 围栏；本方法仍自行执行 Activity 根锁、责任人、场次、身份、segment、evidence 与审计。
   */
  async managedPunchWithinTransaction(
    tx: PrismaTx,
    input: ManagedOnlinePunchInput,
  ): Promise<AppActivityPunchReceiptDto> {
    return this.writeManagedOnlinePunch(tx, this.normalizeManagedOnlineInput(input));
  }

  /**
   * 离线包 service 已持有 Activity 与 OfflinePackage 根锁后调用的唯一正式 writer。
   * 这里继续锁 session/identity/event，复用在线写入的窗口、服务段、定位、evidence 和审计链。
   */
  async offlinePunchWithinTransaction(
    tx: PrismaTx,
    input: OfflinePunchWithinTransactionInput,
  ): Promise<OfflinePunchWithinTransactionResult> {
    const session = await this.access.lockSession(tx, input.activityId, input.sessionId);
    const identity = await this.access.lockIdentityById(
      tx,
      input.activityId,
      input.sessionId,
      input.participationIdentityId,
    );
    if (identity.memberId !== input.memberId) {
      throw new BizException(BizCode.ATTENDANCE_REGISTRATION_INVALID);
    }
    const requestHash = createOfflineAttendancePunchRequestHash({
      activityId: input.activityId,
      sessionId: input.sessionId,
      participationIdentityId: identity.id,
      memberId: identity.memberId,
      operatorUserId: input.operatorUserId,
      packageId: input.packageId,
      sequence: input.sequence,
      priorHash: input.priorHash,
      eventPayloadHash: input.eventPayloadHash,
      signatureDigest: input.signatureDigest,
      eventKey: input.eventKey,
      actionCode: input.actionCode,
      deviceTime: input.deviceTime,
      longitude: input.longitude,
      latitude: input.latitude,
      accuracy: input.accuracy,
    });
    const existing = await this.findEventByKey(tx, input.eventKey);
    if (existing) {
      if (
        existing.requestHash !== requestHash ||
        existing.sourceCode !== 'offline' ||
        existing.offlinePackageId !== input.packageId ||
        existing.offlineSequence !== input.sequence ||
        existing.offlinePriorHash !== input.priorHash ||
        existing.offlineEventPayloadHash !== input.eventPayloadHash
      ) {
        throw new BizException(BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT);
      }
      return {
        receipt: this.presentEvent(
          existing,
          existing.receivedAt,
          input.actionCode === 'check_in' ? 'open' : 'closed_valid',
        ),
        eventId: existing.id,
        requestHash,
        evidenceRevision: existing.evidenceRevision,
        replayed: true,
      };
    }

    this.assertSessionWindow(session, input.actionCode, input.deviceTime);
    const priorEvents = await this.eventsForIdentity(tx, identity.id);
    const projection = this.project(priorEvents, session);
    const open = projection.segments.find((segment) => segment.checkOutAt === null) ?? null;
    if (input.actionCode === 'check_in') {
      if (!identity.populationIncluded || identity.currentStatusCode !== 'pass') {
        throw new BizException(BizCode.ATTENDANCE_REGISTRATION_INVALID);
      }
      if (open) throw new BizException(BizCode.ATTENDANCE_PUNCH_OPEN_SEGMENT_EXISTS);
    } else {
      if (!open) throw new BizException(BizCode.ATTENDANCE_PUNCH_CHECK_OUT_REQUIRES_OPEN_SEGMENT);
      if (input.deviceTime.getTime() - open.checkInAt.getTime() < THIRTY_MINUTES_MS) {
        throw new BizException(BizCode.ATTENDANCE_PUNCH_MIN_DURATION_NOT_REACHED);
      }
    }
    const checkInEvent = open
      ? (priorEvents.find((event) => event.id === open.sourceCheckInEventId) ?? null)
      : null;
    const positionId =
      input.actionCode === 'check_in'
        ? identity.currentPositionId
        : (checkInEvent?.positionId ?? null);
    const locationRule = await this.lockLocationRule(
      tx,
      input.activityId,
      input.sessionId,
      positionId,
    );
    const location = this.locationPolicy.evaluate({
      required: locationRule.required,
      radiusMeters: locationRule.radiusMeters,
      activityLongitude: this.numberOrNull(session.longitude),
      activityLatitude: this.numberOrNull(session.latitude),
      accuracyWarningMeters: session.accuracyWarningMeters,
      request: {
        longitude: input.longitude,
        latitude: input.latitude,
        accuracy: input.accuracy,
      },
    });
    if (!location.allowed) throw new BizException(location.bizCode);

    const evidenceRevision = await this.bumpEvidenceRevision(
      tx,
      input.activityId,
      input.receivedAt,
    );
    const created = await tx.attendancePunchEvent.create({
      data: {
        activityId: input.activityId,
        sessionId: input.sessionId,
        positionId,
        participationIdentityId: identity.id,
        memberId: identity.memberId,
        eventTypeCode: input.actionCode,
        sourceCode: 'offline',
        occurredAt: input.deviceTime,
        receivedAt: input.receivedAt,
        operatorUserId: input.operatorUserId,
        operatorMemberId: input.operatorMemberId,
        reason: null,
        qrCredentialId: null,
        importJobItemId: null,
        offlinePackageId: input.packageId,
        offlineSequence: input.sequence,
        offlinePriorHash: input.priorHash,
        offlineEventPayloadHash: input.eventPayloadHash,
        deviceId: input.deviceId,
        longitude: location.longitude,
        latitude: location.latitude,
        accuracy: location.accuracy,
        distance: location.distanceMeters,
        geoVerified: location.geoVerified,
        outOfRange: location.outOfRange,
        lowAccuracy: location.lowAccuracy,
        eventKey: input.eventKey,
        requestHash,
        supersedesEventId: null,
        evidenceRevision,
      },
      select: PUNCH_EVENT_SELECT,
    });
    await this.segments.rebuild({
      tx,
      identityId: identity.id,
      events: [...priorEvents, created],
      session,
      operationEventType: input.actionCode,
    });
    await this.audit.logPunch({
      operation: 'attendance-punch.create',
      activityId: input.activityId,
      sessionId: input.sessionId,
      participationIdentityId: identity.id,
      eventId: created.id,
      eventTypeCode: created.eventTypeCode,
      sourceCode: created.sourceCode,
      evidenceRevision,
      supersedesEventId: null,
      actorUserId: input.auditActor.id,
      actorRoleSnap: input.auditActor.role,
      auditMeta: input.auditMeta,
      tx,
    });
    return {
      receipt: this.presentEvent(
        created,
        input.receivedAt,
        input.actionCode === 'check_in' ? 'open' : 'closed_valid',
      ),
      eventId: created.id,
      requestHash,
      evidenceRevision,
      replayed: false,
    };
  }

  async myState(args: {
    activityId: string;
    sessionId: string;
    memberId: string;
  }): Promise<AppActivityPunchStateDto> {
    const identity = await this.prisma.activityParticipationIdentity.findFirst({
      where: { activityId: args.activityId, sessionId: args.sessionId, memberId: args.memberId },
      select: { id: true },
    });
    if (!identity) throw new BizException(BizCode.ATTENDANCE_REGISTRATION_INVALID);
    const open = await this.prisma.participantServiceSegmentRevision.findFirst({
      where: {
        participationIdentityId: identity.id,
        statusCode: { not: 'superseded' },
        checkOutAt: null,
      },
      select: {
        checkInAt: true,
        sourceCheckInEvent: {
          select: { distance: true, geoVerified: true, lowAccuracy: true },
        },
      },
      orderBy: [{ checkInAt: 'desc' }, { id: 'desc' }],
    });
    const now = new Date();
    return this.presenter.presentState({
      isPresent: open !== null,
      checkInAt: open?.checkInAt ?? null,
      checkOutAllowedAt: open ? new Date(open.checkInAt.getTime() + THIRTY_MINUTES_MS) : null,
      distanceMeters: this.numberOrNull(open?.sourceCheckInEvent.distance ?? null),
      geoVerified: open?.sourceCheckInEvent.geoVerified ?? false,
      lowAccuracy: open?.sourceCheckInEvent.lowAccuracy ?? false,
      serverTime: now,
    });
  }

  private async writeManagedOnlinePunch(
    tx: PrismaTx,
    input: NormalizedManagedOnlinePunchInput,
  ): Promise<AppActivityPunchReceiptDto> {
    const activity = await this.access.lockActivity(tx, input.activityId, [
      'published',
      'terminated',
    ]);
    await this.access.assertManagedAttendance(tx, input.activityId, input.currentUser);
    const session = await this.access.lockSession(tx, input.activityId, input.sessionId);
    const identity =
      input.memberCredential === null
        ? await this.access.lockIdentityById(
            tx,
            input.activityId,
            input.sessionId,
            input.participationIdentityId!,
          )
        : await this.access.lockIdentityForMemberCredential(
            tx,
            input.activityId,
            input.sessionId,
            input.memberCredential,
          );
    const existing = await this.findEventByKey(tx, input.eventKey);
    if (existing) {
      return this.replayManagedOnlineEvent({ existing, input, identity });
    }

    this.assertActivityAllowsPunch(activity, input.actionCode);

    const receivedAt = new Date();
    const occurredAt = input.sourceCode === 'import' ? input.occurredAt : receivedAt;
    if (occurredAt === null || !Number.isFinite(occurredAt.getTime())) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    this.assertSessionWindow(session, input.actionCode, occurredAt);
    const priorEvents = await this.eventsForIdentity(tx, identity.id);
    const projection = this.project(priorEvents, session);
    const open = projection.segments.find((segment) => segment.checkOutAt === null) ?? null;
    if (input.actionCode === 'check_in') {
      if (!identity.populationIncluded || identity.currentStatusCode !== 'pass') {
        throw new BizException(BizCode.ATTENDANCE_REGISTRATION_INVALID);
      }
      if (open) throw new BizException(BizCode.ATTENDANCE_PUNCH_OPEN_SEGMENT_EXISTS);
    } else {
      if (!open) throw new BizException(BizCode.ATTENDANCE_PUNCH_CHECK_OUT_REQUIRES_OPEN_SEGMENT);
      if (occurredAt.getTime() - open.checkInAt.getTime() < THIRTY_MINUTES_MS) {
        throw new BizException(BizCode.ATTENDANCE_PUNCH_MIN_DURATION_NOT_REACHED);
      }
    }
    const checkInEvent = open
      ? (priorEvents.find((event) => event.id === open.sourceCheckInEventId) ?? null)
      : null;
    const positionId =
      input.actionCode === 'check_in'
        ? identity.currentPositionId
        : (checkInEvent?.positionId ?? null);
    const locationRule = await this.lockLocationRule(
      tx,
      input.activityId,
      input.sessionId,
      positionId,
    );
    const location = this.locationPolicy.evaluate({
      required: locationRule.required,
      radiusMeters: locationRule.radiusMeters,
      activityLongitude: this.numberOrNull(session.longitude),
      activityLatitude: this.numberOrNull(session.latitude),
      accuracyWarningMeters: session.accuracyWarningMeters,
      request: {
        longitude: input.longitude,
        latitude: input.latitude,
        accuracy: input.accuracy,
      },
    });
    if (!location.allowed) throw new BizException(location.bizCode);

    const requestHash = createManagedOnlineAttendancePunchRequestHash({
      participationIdentityId: identity.id,
      activityId: input.activityId,
      sessionId: input.sessionId,
      actorUserId: input.currentUser.id,
      actionCode: input.actionCode,
      sourceCode: input.sourceCode,
      longitude: location.longitude,
      latitude: location.latitude,
      accuracy: location.accuracy,
      eventKey: input.eventKey,
      reason: input.reason,
      occurredAt: input.sourceCode === 'import' ? occurredAt : null,
    });
    const evidenceRevision = await this.bumpEvidenceRevision(tx, input.activityId, receivedAt);
    const created = await tx.attendancePunchEvent.create({
      data: {
        activityId: input.activityId,
        sessionId: input.sessionId,
        positionId,
        participationIdentityId: identity.id,
        memberId: identity.memberId,
        eventTypeCode: input.actionCode,
        sourceCode: input.sourceCode,
        occurredAt,
        receivedAt,
        operatorUserId: input.currentUser.id,
        operatorMemberId: input.currentUser.memberId,
        reason: input.reason,
        qrCredentialId: null,
        importJobItemId: input.batchJobItemId ?? null,
        deviceId: input.deviceId,
        longitude: location.longitude,
        latitude: location.latitude,
        accuracy: location.accuracy,
        distance: location.distanceMeters,
        geoVerified: location.geoVerified,
        outOfRange: location.outOfRange,
        lowAccuracy: location.lowAccuracy,
        eventKey: input.eventKey,
        requestHash,
        supersedesEventId: null,
        evidenceRevision,
      },
      select: PUNCH_EVENT_SELECT,
    });
    await this.segments.rebuild({
      tx,
      identityId: identity.id,
      events: [...priorEvents, created],
      session,
      operationEventType: input.actionCode,
    });
    await this.audit.logPunch({
      operation: 'attendance-punch.create',
      activityId: input.activityId,
      sessionId: input.sessionId,
      participationIdentityId: identity.id,
      eventId: created.id,
      eventTypeCode: created.eventTypeCode,
      sourceCode: created.sourceCode,
      evidenceRevision,
      supersedesEventId: null,
      actorUserId: input.currentUser.id,
      actorRoleSnap: input.currentUser.role,
      auditMeta: input.auditMeta,
      tx,
    });
    return this.presentEvent(
      created,
      receivedAt,
      input.actionCode === 'check_in' ? 'open' : 'closed_valid',
    );
  }

  private normalizeManagedOnlineInput(
    input: ManagedOnlinePunchInput,
  ): NormalizedManagedOnlinePunchInput {
    const reason = normalizeAttendancePunchReason(input.reason);
    if (input.sourceCode === 'proxy' && reason === null) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    if ((input.participationIdentityId === null) === (input.memberCredential === null)) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    const occurredAt = input.occurredAt ?? null;
    if (
      (input.sourceCode === 'import' &&
        (occurredAt === null || !Number.isFinite(occurredAt.getTime()))) ||
      (input.sourceCode !== 'import' && occurredAt !== null)
    ) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    return { ...input, reason, occurredAt };
  }

  private async writeManagedEvent(args: {
    activityId: string;
    sessionId: string;
    identityId: string;
    actionCode: 'early_departure_close';
    eventKey: string;
    reason: string;
    supersedesEventId: null;
    currentUser: CurrentUserPayload;
    auditMeta: AuditMeta;
  }): Promise<AppActivityPunchReceiptDto> {
    return this.prisma.$transaction(
      async (tx) => {
        const activity = await this.access.lockActivity(tx, args.activityId, [
          'published',
          'terminated',
        ]);
        await this.access.assertManagedAttendance(tx, args.activityId, args.currentUser);
        const session = await this.access.lockSession(tx, args.activityId, args.sessionId);
        const identity = await this.access.lockIdentityById(
          tx,
          args.activityId,
          args.sessionId,
          args.identityId,
        );
        const existing = await this.findEventByKey(tx, args.eventKey);
        if (existing) {
          return this.replayManagedEvent({ existing, args, identity, session, qrVersion: null });
        }
        const now = new Date();
        this.assertSessionWindow(session, 'check_out', now, {
          ignoreUpperBound: activity.statusCode === 'terminated',
        });
        const priorEvents = await this.eventsForIdentity(tx, identity.id);
        const projection = this.project(priorEvents, session);
        const open = projection.segments.find((segment) => segment.checkOutAt === null) ?? null;
        if (!open) throw new BizException(BizCode.ATTENDANCE_PUNCH_CHECK_OUT_REQUIRES_OPEN_SEGMENT);
        const checkInEvent =
          priorEvents.find((event) => event.id === open.sourceCheckInEventId) ?? null;
        const positionId = checkInEvent?.positionId ?? null;
        const requestHash = createAttendancePunchRequestHash({
          operatorUserId: args.currentUser.id,
          memberId: identity.memberId,
          participationIdentityId: identity.id,
          activityId: args.activityId,
          sessionId: args.sessionId,
          positionId,
          eventTypeCode: args.actionCode,
          sourceCode: 'correction',
          deviceId: null,
          occurredAt: now,
          longitude: null,
          latitude: null,
          accuracy: null,
          qrCredentialVersion: null,
          supersedesEventId: null,
          reason: args.reason,
        });
        const evidenceRevision = await this.bumpEvidenceRevision(tx, args.activityId, now);
        const created = await tx.attendancePunchEvent.create({
          data: {
            activityId: args.activityId,
            sessionId: args.sessionId,
            positionId,
            participationIdentityId: identity.id,
            memberId: identity.memberId,
            eventTypeCode: args.actionCode,
            sourceCode: 'correction',
            occurredAt: now,
            receivedAt: now,
            operatorUserId: args.currentUser.id,
            operatorMemberId: args.currentUser.memberId,
            reason: args.reason,
            qrCredentialId: null,
            longitude: null,
            latitude: null,
            accuracy: null,
            distance: null,
            geoVerified: false,
            outOfRange: false,
            lowAccuracy: false,
            eventKey: args.eventKey,
            requestHash,
            supersedesEventId: null,
            evidenceRevision,
          },
          select: PUNCH_EVENT_SELECT,
        });
        await this.segments.rebuild({
          tx,
          identityId: identity.id,
          events: [...priorEvents, created],
          session,
          operationEventType: args.actionCode,
        });
        await this.audit.logPunch({
          operation: 'attendance-punch.create',
          activityId: args.activityId,
          sessionId: args.sessionId,
          participationIdentityId: identity.id,
          eventId: created.id,
          eventTypeCode: created.eventTypeCode,
          sourceCode: created.sourceCode,
          evidenceRevision,
          supersedesEventId: null,
          actorUserId: args.currentUser.id,
          actorRoleSnap: args.currentUser.role,
          auditMeta: args.auditMeta,
          tx,
        });
        return this.presentEvent(created, now, 'closed_zero');
      },
      { maxWait: 60_000, timeout: 60_000 },
    );
  }

  private async correctEvent(input: ManagedCorrectionInput): Promise<AppActivityPunchReceiptDto> {
    const reason = normalizeAttendancePunchReason(input.reason);
    if (reason === null) throw new BizException(BizCode.BAD_REQUEST);
    return this.prisma.$transaction(
      async (tx) => {
        await this.access.lockActivity(tx, input.activityId);
        await this.access.assertManagedAttendance(tx, input.activityId, input.currentUser);
        const targetReference = await tx.attendancePunchEvent.findFirst({
          where: { id: input.eventId, activityId: input.activityId },
          select: { sessionId: true, participationIdentityId: true },
        });
        if (!targetReference) throw new BizException(BizCode.BAD_REQUEST);
        const session = await this.access.lockSession(
          tx,
          input.activityId,
          targetReference.sessionId,
        );
        const identity = await this.access.lockIdentityById(
          tx,
          input.activityId,
          targetReference.sessionId,
          targetReference.participationIdentityId,
        );
        // Target row lock comes after the immutable aggregate/session/identity lock chain.
        const target = await this.access.lockEvent(tx, input.activityId, input.eventId);
        const existing = await this.findEventByKey(tx, input.operationKey);
        if (existing) {
          return this.replayCorrectionEvent({ existing, input, target, identity, session, reason });
        }
        if (target.eventTypeCode === 'void' || target.eventTypeCode === 'replace') {
          throw new BizException(BizCode.ATTENDANCE_PUNCH_EVENT_ALREADY_VOIDED);
        }
        const directEffect = await tx.attendancePunchEvent.findFirst({
          where: { supersedesEventId: target.id },
          select: { id: true },
          orderBy: { id: 'asc' },
        });
        if (directEffect) throw new BizException(BizCode.ATTENDANCE_PUNCH_EVENT_ALREADY_VOIDED);
        const committed = await tx.ledgerPostingBatch.findFirst({
          where: { statusCode: 'committed', settlementRun: { activityId: input.activityId } },
          select: { id: true },
        });
        if (committed) throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);

        const now = new Date();
        const priorEvents = await this.eventsForIdentity(tx, identity.id);
        const requestHash = createAttendancePunchRequestHash({
          operatorUserId: input.currentUser.id,
          memberId: identity.memberId,
          participationIdentityId: identity.id,
          activityId: input.activityId,
          sessionId: target.sessionId,
          positionId: target.positionId,
          eventTypeCode: input.actionCode,
          sourceCode: 'correction',
          deviceId: null,
          occurredAt: now,
          longitude: null,
          latitude: null,
          accuracy: null,
          qrCredentialVersion: null,
          supersedesEventId: target.id,
          reason,
        });
        const evidenceRevision = await this.bumpEvidenceRevision(tx, input.activityId, now);
        const created = await tx.attendancePunchEvent.create({
          data: {
            activityId: input.activityId,
            sessionId: target.sessionId,
            positionId: target.positionId,
            participationIdentityId: identity.id,
            memberId: identity.memberId,
            eventTypeCode: input.actionCode,
            sourceCode: 'correction',
            occurredAt: now,
            receivedAt: now,
            operatorUserId: input.currentUser.id,
            operatorMemberId: input.currentUser.memberId,
            reason,
            qrCredentialId: null,
            longitude: null,
            latitude: null,
            accuracy: null,
            distance: null,
            geoVerified: false,
            outOfRange: false,
            lowAccuracy: false,
            eventKey: input.operationKey,
            requestHash,
            supersedesEventId: target.id,
            evidenceRevision,
          },
          select: PUNCH_EVENT_SELECT,
        });
        const afterEvents = [...priorEvents, created];
        await this.segments.rebuild({
          tx,
          identityId: identity.id,
          events: afterEvents,
          session,
          operationEventType: input.actionCode,
        });
        await this.audit.logPunch({
          operation:
            input.actionCode === 'void' ? 'attendance-punch.void' : 'attendance-punch.replace',
          activityId: input.activityId,
          sessionId: target.sessionId,
          participationIdentityId: identity.id,
          eventId: created.id,
          eventTypeCode: created.eventTypeCode,
          sourceCode: created.sourceCode,
          evidenceRevision,
          supersedesEventId: target.id,
          actorUserId: input.currentUser.id,
          actorRoleSnap: input.currentUser.role,
          auditMeta: input.auditMeta,
          tx,
        });
        const afterProjection = this.project(afterEvents, session);
        const hasOpen = afterProjection.segments.some((segment) => segment.checkOutAt === null);
        return this.presentEvent(created, now, hasOpen ? 'open' : 'closed_valid');
      },
      { maxWait: 60_000, timeout: 60_000 },
    );
  }

  private replaySelfEvent(args: {
    existing: PunchEventRow;
    input: SelfPunchInput;
    identity: LockedIdentity;
    session: LockedSession;
    qrVersion: number;
  }): AppActivityPunchReceiptDto {
    const expected = this.hashForExisting({
      existing: args.existing,
      operatorUserId: args.input.currentUser.id,
      memberId: args.identity.memberId,
      identityId: args.identity.id,
      activityId: args.input.activityId,
      sessionId: args.input.sessionId,
      eventTypeCode: args.input.actionCode,
      sourceCode: 'self_qr',
      deviceId: null,
      longitude: args.input.dto.longitude ?? null,
      latitude: args.input.dto.latitude ?? null,
      accuracy: args.input.dto.accuracy ?? null,
      qrCredentialVersion: args.qrVersion,
      supersedesEventId: null,
      reason: null,
    });
    if (args.existing.requestHash !== expected) {
      throw new BizException(BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT);
    }
    return this.presentEvent(
      args.existing,
      args.existing.occurredAt,
      args.input.actionCode === 'check_in' ? 'open' : 'closed_valid',
    );
  }

  private replayManagedEvent(args: {
    existing: PunchEventRow;
    args: {
      activityId: string;
      sessionId: string;
      identityId: string;
      actionCode: 'early_departure_close';
      eventKey: string;
      reason: string;
    };
    identity: LockedIdentity;
    session: LockedSession;
    qrVersion: null;
  }): AppActivityPunchReceiptDto {
    const expected = this.hashForExisting({
      existing: args.existing,
      operatorUserId: args.existing.operatorUserId,
      memberId: args.identity.memberId,
      identityId: args.identity.id,
      activityId: args.args.activityId,
      sessionId: args.args.sessionId,
      eventTypeCode: 'early_departure_close',
      sourceCode: 'correction',
      deviceId: null,
      longitude: null,
      latitude: null,
      accuracy: null,
      qrCredentialVersion: null,
      supersedesEventId: null,
      reason: args.args.reason,
    });
    if (args.existing.requestHash !== expected) {
      throw new BizException(BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT);
    }
    return this.presentEvent(args.existing, args.existing.occurredAt, 'closed_zero');
  }

  private replayManagedOnlineEvent(args: {
    existing: PunchEventRow;
    input: NormalizedManagedOnlinePunchInput;
    identity: LockedIdentity;
  }): AppActivityPunchReceiptDto {
    const expected = createManagedOnlineAttendancePunchRequestHash({
      activityId: args.input.activityId,
      sessionId: args.input.sessionId,
      actorUserId: args.input.currentUser.id,
      participationIdentityId: args.identity.id,
      actionCode: args.input.actionCode,
      sourceCode: args.input.sourceCode,
      longitude: args.input.longitude,
      latitude: args.input.latitude,
      accuracy: args.input.accuracy,
      eventKey: args.input.eventKey,
      reason: args.input.reason,
      occurredAt: args.input.sourceCode === 'import' ? args.input.occurredAt : null,
    });
    if (args.existing.requestHash !== expected) {
      throw new BizException(BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT);
    }
    if ((args.existing.importJobItemId ?? null) !== (args.input.batchJobItemId ?? null)) {
      throw new BizException(BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT);
    }
    return this.presentEvent(
      args.existing,
      args.existing.occurredAt,
      args.input.actionCode === 'check_in' ? 'open' : 'closed_valid',
    );
  }

  private replayCorrectionEvent(args: {
    existing: PunchEventRow;
    input: ManagedCorrectionInput;
    target: PunchEventRow;
    identity: LockedIdentity;
    session: LockedSession;
    reason: string;
  }): AppActivityPunchReceiptDto {
    const expected = this.hashForExisting({
      existing: args.existing,
      operatorUserId: args.input.currentUser.id,
      memberId: args.identity.memberId,
      identityId: args.identity.id,
      activityId: args.input.activityId,
      sessionId: args.target.sessionId,
      eventTypeCode: args.input.actionCode,
      sourceCode: 'correction',
      deviceId: null,
      longitude: null,
      latitude: null,
      accuracy: null,
      qrCredentialVersion: null,
      supersedesEventId: args.target.id,
      reason: args.reason,
    });
    if (args.existing.requestHash !== expected) {
      throw new BizException(BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT);
    }
    return this.presentEvent(args.existing, args.existing.occurredAt, 'closed_valid');
  }

  private hashForExisting(args: {
    existing: PunchEventRow;
    operatorUserId: string;
    memberId: string;
    identityId: string;
    activityId: string;
    sessionId: string;
    eventTypeCode: CommandAction;
    sourceCode: 'self_qr' | ManagedOnlineSource | 'correction';
    deviceId: string | null;
    longitude: number | null;
    latitude: number | null;
    accuracy: number | null;
    qrCredentialVersion: number | null;
    supersedesEventId: string | null;
    reason: string | null;
  }): string {
    return createAttendancePunchRequestHash({
      operatorUserId: args.operatorUserId,
      memberId: args.memberId,
      participationIdentityId: args.identityId,
      activityId: args.activityId,
      sessionId: args.sessionId,
      positionId: args.existing.positionId,
      eventTypeCode: args.eventTypeCode,
      sourceCode: args.sourceCode,
      deviceId: args.deviceId,
      occurredAt: args.existing.occurredAt,
      longitude: args.longitude,
      latitude: args.latitude,
      accuracy: args.accuracy,
      qrCredentialVersion: args.qrCredentialVersion,
      supersedesEventId: args.supersedesEventId,
      reason: args.reason,
    });
  }

  private async eventsForIdentity(tx: PrismaTx, identityId: string): Promise<PunchEventRow[]> {
    return tx.attendancePunchEvent.findMany({
      where: { participationIdentityId: identityId },
      select: PUNCH_EVENT_SELECT,
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
  }

  private project(events: PunchEventRow[], session: LockedSession) {
    const projection = this.projector.rebuild(
      events.map((event) => this.asProjectionEvent(event)),
      {
        sessionStartAt: session.startAt,
        sessionEndAt: session.endAt,
        lateGraceMinutes: session.lateGraceMinutes,
        earlyLeaveThresholdMinutes: session.earlyLeaveThresholdMinutes,
      },
    );
    if (projection.chainAnomalies.length > 0) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    return projection;
  }

  private asProjectionEvent(event: {
    id: string;
    eventTypeCode: string;
    occurredAt: Date;
    supersedesEventId: string | null;
  }) {
    return {
      id: event.id,
      eventTypeCode: event.eventTypeCode,
      occurredAt: event.occurredAt,
      supersedesEventId: event.supersedesEventId,
    };
  }

  private async lockLocationRule(
    tx: PrismaTx,
    activityId: string,
    sessionId: string,
    positionId: string | null,
  ): Promise<{ required: boolean; radiusMeters: number | null }> {
    if (positionId === null) {
      const session = await tx.activitySession.findFirst({
        where: { id: sessionId, activityId, deletedAt: null },
        select: { locationRequired: true, radiusMeters: true },
      });
      if (!session) throw new BizException(BizCode.BAD_REQUEST);
      return { required: session.locationRequired, radiusMeters: session.radiusMeters };
    }
    const position = await tx.activitySessionPosition.findFirst({
      where: { id: positionId, activityId, sessionId, deletedAt: null },
      select: {
        locationRequired: true,
        radiusMeters: true,
        session: { select: { locationRequired: true, radiusMeters: true } },
      },
    });
    if (!position) throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    return {
      required: position.locationRequired ?? position.session.locationRequired,
      radiusMeters: position.radiusMeters ?? position.session.radiusMeters,
    };
  }

  private assertSessionWindow(
    session: LockedSession,
    action: SelfAction,
    now: Date,
    options: { ignoreUpperBound?: boolean } = {},
  ): void {
    const from = action === 'check_in' ? session.checkInOpenAt : session.checkOutOpenAt;
    const until =
      action === 'check_in'
        ? session.checkInCloseAt
        : (session.terminationCheckOutDeadline ?? session.checkOutCloseAt);
    if (now < from || (!options.ignoreUpperBound && now > until)) {
      throw new BizException(BizCode.ATTENDANCE_PUNCH_OUTSIDE_WINDOW);
    }
  }

  private assertActivityAllowsPunch(activity: LockedActivity, action: SelfAction): void {
    if (activity.statusCode === 'terminated' && action !== 'check_out') {
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    }
  }

  private async bumpEvidenceRevision(tx: PrismaTx, activityId: string, now: Date): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ id: string; evidenceRevision: number }>>(Prisma.sql`
      SELECT "id", "evidenceRevision" FROM "ActivityEvidenceState"
      WHERE "activityId" = ${activityId}
      FOR UPDATE
    `);
    if (rows.length !== 1) throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    const next = rows[0].evidenceRevision + 1;
    await tx.activityEvidenceState.update({
      where: { id: rows[0].id },
      data: { evidenceRevision: next, lastEvidenceAt: now, version: { increment: 1 } },
    });
    return next;
  }

  private async findEventByKey(tx: PrismaTx, eventKey: string): Promise<PunchEventRow | null> {
    return tx.attendancePunchEvent.findUnique({ where: { eventKey }, select: PUNCH_EVENT_SELECT });
  }

  private presentEvent(
    event: PunchEventRow,
    serverTime: Date,
    segmentStatusCode: 'open' | 'closed_valid' | 'closed_zero',
  ): AppActivityPunchReceiptDto {
    return this.presenter.presentReceipt(
      {
        eventId: event.id,
        eventTypeCode: event.eventTypeCode,
        occurredAt: event.occurredAt,
        segmentStatusCode,
        distanceMeters: this.numberOrNull(event.distance),
        geoVerified: event.geoVerified,
        lowAccuracy: event.lowAccuracy,
        nextAllowedAction: segmentStatusCode === 'open' ? 'check_out' : 'check_in',
      },
      serverTime,
    );
  }

  private numberOrNull(value: Prisma.Decimal | number | null): number | null {
    return value === null ? null : Number(value);
  }
}
