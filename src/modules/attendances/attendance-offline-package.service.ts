import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AttendanceMemberCredentialService } from './attendance-member-credential.service';
import {
  AttendanceOfflinePackageTokenService,
  verifyAttendanceOfflineEvent,
  type AttendanceOfflinePackageTokenPayload,
} from './attendance-offline-package-token';
import {
  AttendanceOfflinePackageAccessService,
  OFFLINE_PACKAGE_SELECT,
  OFFLINE_REVIEW_SELECT,
  type FrozenParticipant,
  type PackageRow,
} from './attendance-offline-package-access.service';
import { AttendanceOfflineReviewService } from './attendance-offline-review.service';
import { AttendancePunchAuditRecorder } from './attendance-punch-audit-recorder';
import { AttendancePunchCommandService } from './attendance-punch-command.service';
import {
  createOfflinePackageIssueRequestHash,
  createOfflinePackageRevokeRequestHash,
} from './attendance-punch-request-hash';
import type { AppActivityPunchReceiptDto } from './dto/app/app-activity-punch.dto';
import type {
  AppManagedOfflinePackageDto,
  AppManagedOfflinePackageIssueReceiptDto,
} from './dto/app/app-managed-onsite-operations.dto';

type ReviewAnomaly =
  | 'operator_authorization_revoked'
  | 'package_revoked'
  | 'package_expired'
  | 'device_mismatch'
  | 'sequence_gap'
  | 'sequence_duplicate'
  | 'future_time'
  | 'time_out_of_window'
  | 'hash_chain_invalid'
  | 'signature_invalid'
  | 'participant_snapshot_mismatch';

const DAY_MS = 24 * 60 * 60_000;
const FUTURE_TOLERANCE_MS = 5 * 60_000;
@Injectable()
export class AttendanceOfflinePackageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AttendanceOfflinePackageTokenService,
    private readonly memberCredentials: AttendanceMemberCredentialService,
    private readonly punch: AttendancePunchCommandService,
    private readonly audit: AttendancePunchAuditRecorder,
    private readonly access: AttendanceOfflinePackageAccessService,
    private readonly reviews: AttendanceOfflineReviewService,
  ) {}

  async listReviews(
    ...args: Parameters<AttendanceOfflineReviewService['listReviews']>
  ): ReturnType<AttendanceOfflineReviewService['listReviews']> {
    return this.reviews.listReviews(...args);
  }

  async approveReview(
    ...args: Parameters<AttendanceOfflineReviewService['approveReview']>
  ): ReturnType<AttendanceOfflineReviewService['approveReview']> {
    return this.reviews.approveReview(...args);
  }

  async rejectReview(
    ...args: Parameters<AttendanceOfflineReviewService['rejectReview']>
  ): ReturnType<AttendanceOfflineReviewService['rejectReview']> {
    return this.reviews.rejectReview(...args);
  }

  async issue(
    input: {
      activityId: string;
      sessionId: string;
      operationKey: string;
      deviceId: string;
    },
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedOfflinePackageIssueReceiptDto> {
    if (currentUser.memberId === null) throw new BizException(BizCode.RBAC_FORBIDDEN);
    const requestHash = createOfflinePackageIssueRequestHash({
      activityId: input.activityId,
      sessionId: input.sessionId,
      actorUserId: currentUser.id,
      actorMemberId: currentUser.memberId,
      operationKey: input.operationKey,
      deviceId: input.deviceId,
    });
    return this.access.withUniqueReplay(() =>
      this.prisma.$transaction(
        async (tx) => {
          await this.access.lockActivity(tx, input.activityId);
          await this.access.requireManagedAttendance(tx, input.activityId, currentUser.memberId!);
          const replay = await tx.offlinePackage.findUnique({
            where: { issueOperationKey: input.operationKey },
            select: OFFLINE_PACKAGE_SELECT,
          });
          if (replay) {
            if (replay.issueRequestHash !== requestHash) {
              throw new BizException(BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT);
            }
            const packageToken = this.signPackage(replay);
            if (this.tokens.digest(packageToken) !== replay.tokenDigest) {
              throw new BizException(BizCode.ATTENDANCE_OFFLINE_PACKAGE_INVALID);
            }
            return { package: this.presentPackage(replay), packageToken };
          }

          const session = await this.access.lockIssuableSession(
            tx,
            input.activityId,
            input.sessionId,
          );
          const now = new Date();
          if (now >= session.checkOutCloseAt) throw new BizException(BizCode.BAD_REQUEST);
          const liveDevicePackage = await tx.offlinePackage.findFirst({
            where: {
              activityId: input.activityId,
              sessionId: input.sessionId,
              deviceId: input.deviceId,
              statusCode: { in: ['active', 'review_required'] },
            },
            select: { id: true },
          });
          if (liveDevicePackage) throw new BizException(BizCode.BAD_REQUEST);

          const ruleSnapshot = await tx.activityRuleSnapshot.findUnique({
            where: {
              activityId_workflowRevision: {
                activityId: input.activityId,
                workflowRevision: session.workflowRevision,
              },
            },
            select: { id: true, snapshotHash: true },
          });
          if (!ruleSnapshot)
            throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
          const participants = await this.access.lockIssuableParticipants(
            tx,
            input.activityId,
            input.sessionId,
          );
          if (participants.length === 0) throw new BizException(BizCode.BAD_REQUEST);
          const participantSnapshotHash = this.participantSnapshotHash(participants);
          const maximumVersion = await tx.offlinePackage.aggregate({
            where: {
              activityId: input.activityId,
              sessionId: input.sessionId,
              deviceId: input.deviceId,
            },
            _max: { packageVersion: true },
          });
          const packageVersion = (maximumVersion._max.packageVersion ?? 0) + 1;
          const packageId = randomUUID();
          const chainAnchorHash = randomBytes(32).toString('hex');
          const validUntil = session.checkOutCloseAt;
          const uploadUntil = new Date(validUntil.getTime() + DAY_MS);
          const payload: AttendanceOfflinePackageTokenPayload = {
            v: 1,
            purpose: 'attendance-offline-package',
            packageId,
            activityId: input.activityId,
            sessionId: input.sessionId,
            operatorUserId: currentUser.id,
            operatorMemberId: currentUser.memberId!,
            deviceId: input.deviceId,
            packageVersion,
            packageKeyVersion: 0,
            validFrom: now.toISOString(),
            validUntil: validUntil.toISOString(),
            uploadUntil: uploadUntil.toISOString(),
            sequenceStart: 1,
            chainAnchorHash,
            ruleSnapshotHash: ruleSnapshot.snapshotHash,
            workflowRevision: session.workflowRevision,
            participantSnapshotHash,
          };
          const packageToken = this.tokens.sign(payload);
          const created = await tx.offlinePackage.create({
            data: {
              id: packageId,
              activityId: input.activityId,
              sessionId: input.sessionId,
              operatorUserId: currentUser.id,
              operatorMemberId: currentUser.memberId!,
              deviceId: input.deviceId,
              packageVersion,
              packageKeyVersion: 0,
              statusCode: 'active',
              tokenDigest: this.tokens.digest(packageToken),
              ruleSnapshotId: ruleSnapshot.id,
              ruleSnapshotHash: ruleSnapshot.snapshotHash,
              workflowRevision: session.workflowRevision,
              participantSnapshotHash,
              validFrom: now,
              validUntil,
              uploadUntil,
              sequenceStart: 1,
              nextExpectedSequence: 1,
              chainAnchorHash,
              lastAcceptedHash: chainAnchorHash,
              lastAcceptedAt: null,
              issuedAt: now,
              issueOperationKey: input.operationKey,
              issueRequestHash: requestHash,
            },
            select: OFFLINE_PACKAGE_SELECT,
          });
          await tx.offlinePackageParticipant.createMany({
            data: participants.map((participant) => ({
              offlinePackageId: created.id,
              activityId: input.activityId,
              sessionId: input.sessionId,
              participationIdentityId: participant.participationIdentityId,
              memberId: participant.memberId,
              participationRevisionId: participant.participationRevisionId,
              positionId: participant.positionId,
            })),
          });
          await this.audit.logOffline({
            operation: 'attendance-offline-package.issue',
            activityId: input.activityId,
            sessionId: input.sessionId,
            packageId: created.id,
            statusCode: created.statusCode,
            actorUserId: currentUser.id,
            actorRoleSnap: currentUser.role,
            auditMeta,
            tx,
          });
          return { package: this.presentPackage(created), packageToken };
        },
        { maxWait: 60_000, timeout: 60_000 },
      ),
    );
  }

  async revoke(
    input: {
      activityId: string;
      packageId: string;
      operationKey: string;
      reason: string;
    },
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedOfflinePackageDto> {
    if (currentUser.memberId === null) throw new BizException(BizCode.RBAC_FORBIDDEN);
    const reason = this.access.requiredReason(input.reason);
    const requestHash = createOfflinePackageRevokeRequestHash({
      activityId: input.activityId,
      packageId: input.packageId,
      actorUserId: currentUser.id,
      operationKey: input.operationKey,
      reason,
    });
    return this.access.withUniqueReplay(() =>
      this.prisma.$transaction(
        async (tx) => {
          await this.access.lockActivity(tx, input.activityId, ['published', 'terminated']);
          const row = await this.access.lockPackage(tx, input.activityId, input.packageId);
          await this.access.requireManagedAttendance(tx, input.activityId, currentUser.memberId!);
          const keyed = await tx.offlinePackage.findUnique({
            where: { revokeOperationKey: input.operationKey },
            select: OFFLINE_PACKAGE_SELECT,
          });
          if (keyed) {
            if (keyed.id !== row.id || keyed.revokeRequestHash !== requestHash) {
              throw new BizException(BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT);
            }
            return this.presentPackage(keyed);
          }
          if (!['active', 'review_required'].includes(row.statusCode)) {
            throw new BizException(BizCode.BAD_REQUEST);
          }
          const now = new Date();
          const updated = await tx.offlinePackage.update({
            where: { id: row.id },
            data: {
              statusCode: 'revoked',
              revokedByUserId: currentUser.id,
              revokedAt: now,
              revokeReason: reason,
              revokeOperationKey: input.operationKey,
              revokeRequestHash: requestHash,
            },
            select: OFFLINE_PACKAGE_SELECT,
          });
          await this.audit.logOffline({
            operation: 'attendance-offline-package.revoke',
            activityId: updated.activityId,
            sessionId: updated.sessionId,
            packageId: updated.id,
            statusCode: updated.statusCode,
            actorUserId: currentUser.id,
            actorRoleSnap: currentUser.role,
            auditMeta,
            tx,
          });
          return this.presentPackage(updated);
        },
        { maxWait: 60_000, timeout: 60_000 },
      ),
    );
  }

  async upload(
    input: {
      activityId: string;
      packageId: string;
      packageToken: string;
      sequence: number;
      priorHash: string;
      eventKey: string;
      actionCode: 'check_in' | 'check_out';
      deviceTime: Date;
      memberCredential: string;
      longitude: number | null;
      latitude: number | null;
      accuracy: number | null;
      signature: string;
    },
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppActivityPunchReceiptDto> {
    if (currentUser.memberId === null) throw new BizException(BizCode.RBAC_FORBIDDEN);
    const uploaderMemberId = currentUser.memberId;
    const receivedAt = new Date();
    const outcome = await this.access.withUniqueReplay(() =>
      this.prisma.$transaction(
        async (tx) => {
          const activity = await this.access.lockActivity(tx, input.activityId, [
            'published',
            'terminated',
          ]);
          await this.access.requireManagedAttendance(tx, input.activityId, uploaderMemberId);
          const offlinePackage = await this.access.lockPackage(
            tx,
            input.activityId,
            input.packageId,
          );
          let packagePayload: AttendanceOfflinePackageTokenPayload;
          try {
            packagePayload = this.tokens.verify(input.packageToken);
          } catch {
            throw new BizException(BizCode.ATTENDANCE_OFFLINE_PACKAGE_INVALID);
          }
          if (
            packagePayload.packageId !== input.packageId ||
            packagePayload.activityId !== input.activityId
          ) {
            throw new BizException(BizCode.ATTENDANCE_OFFLINE_PACKAGE_INVALID);
          }
          this.assertPackageTokenAnchors(offlinePackage, packagePayload, input.packageToken);
          let credential: { userId: string; memberId: string };
          try {
            credential = this.memberCredentials.verifyAt(input.memberCredential, input.deviceTime);
          } catch {
            throw new BizException(BizCode.ATTENDANCE_OFFLINE_PACKAGE_INVALID);
          }
          let proof;
          try {
            proof = verifyAttendanceOfflineEvent(
              input.packageToken,
              {
                packageId: input.packageId,
                sequence: input.sequence,
                priorHash: input.priorHash,
                eventKey: input.eventKey,
                actionCode: input.actionCode,
                deviceTime: input.deviceTime,
                memberCredential: input.memberCredential,
                longitude: input.longitude,
                latitude: input.latitude,
                accuracy: input.accuracy,
              },
              input.signature,
            );
          } catch {
            throw new BizException(BizCode.ATTENDANCE_OFFLINE_PACKAGE_INVALID);
          }
          const operatorAuthorized =
            offlinePackage.operatorMemberId === uploaderMemberId
              ? true
              : await this.access.hasManagedAttendance(
                  tx,
                  offlinePackage.activityId,
                  offlinePackage.operatorMemberId,
                );
          const frozenParticipant = await tx.offlinePackageParticipant.findUnique({
            where: {
              offlinePackageId_participationIdentityId: {
                offlinePackageId: offlinePackage.id,
                participationIdentityId:
                  (
                    await tx.activityParticipationIdentity.findFirst({
                      where: {
                        activityId: offlinePackage.activityId,
                        sessionId: offlinePackage.sessionId,
                        memberId: credential.memberId,
                      },
                      select: { id: true },
                    })
                  )?.id ?? '__missing__',
              },
            },
            select: {
              participationIdentityId: true,
              memberId: true,
              participationRevisionId: true,
              positionId: true,
            },
          });

          const existingFormal = await tx.attendancePunchEvent.findUnique({
            where: { eventKey: input.eventKey },
            select: {
              offlinePackageId: true,
              offlineSequence: true,
              offlinePriorHash: true,
              offlineEventPayloadHash: true,
            },
          });
          if (existingFormal) {
            if (
              existingFormal.offlinePackageId !== offlinePackage.id ||
              existingFormal.offlineSequence !== input.sequence ||
              existingFormal.offlinePriorHash !== input.priorHash ||
              existingFormal.offlineEventPayloadHash !== proof.eventPayloadHash ||
              !frozenParticipant
            ) {
              throw new BizException(BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT);
            }
            const replay = await this.punch.offlinePunchWithinTransaction(tx, {
              activityId: offlinePackage.activityId,
              sessionId: offlinePackage.sessionId,
              participationIdentityId: frozenParticipant.participationIdentityId,
              memberId: frozenParticipant.memberId,
              actionCode: input.actionCode,
              eventKey: input.eventKey,
              deviceTime: input.deviceTime,
              receivedAt,
              deviceId: offlinePackage.deviceId,
              longitude: input.longitude,
              latitude: input.latitude,
              accuracy: input.accuracy,
              packageId: offlinePackage.id,
              sequence: input.sequence,
              priorHash: input.priorHash,
              eventPayloadHash: proof.eventPayloadHash,
              signatureDigest: proof.signatureDigest,
              operatorUserId: offlinePackage.operatorUserId,
              operatorMemberId: offlinePackage.operatorMemberId,
              auditActor: currentUser,
              auditMeta,
            });
            return { kind: 'success' as const, receipt: replay.receipt };
          }

          if (activity.statusCode === 'terminated' && input.actionCode !== 'check_out') {
            throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
          }

          const participantCurrent = frozenParticipant
            ? await this.access.frozenParticipantIsCurrent(
                tx,
                offlinePackage,
                frozenParticipant,
                credential,
              )
            : false;

          const pending = await tx.offlinePunchReviewItem.findFirst({
            where: { offlinePackageId: offlinePackage.id, statusCode: 'pending' },
            select: OFFLINE_REVIEW_SELECT,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          });
          if (pending) {
            if (pending.sequence === input.sequence) {
              if (
                pending.eventKey !== input.eventKey ||
                pending.providedPriorHash !== input.priorHash ||
                pending.eventPayloadHash !== proof.eventPayloadHash ||
                pending.signatureDigest !== proof.signatureDigest
              ) {
                throw new BizException(BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT);
              }
              return {
                kind: 'review' as const,
                code:
                  pending.anomalyCode === 'package_expired'
                    ? BizCode.ATTENDANCE_OFFLINE_PACKAGE_EXPIRED
                    : BizCode.ATTENDANCE_OFFLINE_REVIEW_REQUIRED,
              };
            }
            return { kind: 'review' as const, code: BizCode.ATTENDANCE_OFFLINE_REVIEW_REQUIRED };
          }

          let anomaly: ReviewAnomaly | null = null;
          let responseCode: BizCodeEntry = BizCode.ATTENDANCE_OFFLINE_REVIEW_REQUIRED;
          if (packagePayload.deviceId !== offlinePackage.deviceId) {
            anomaly = 'device_mismatch';
          } else if (input.sequence < offlinePackage.nextExpectedSequence) {
            anomaly = 'sequence_duplicate';
          } else if (input.sequence > offlinePackage.nextExpectedSequence) {
            anomaly = 'sequence_gap';
          } else if (input.priorHash !== offlinePackage.lastAcceptedHash) {
            anomaly = 'hash_chain_invalid';
          } else if (!proof.signatureValid) {
            anomaly = 'signature_invalid';
          } else if (!frozenParticipant || !participantCurrent) {
            anomaly = 'participant_snapshot_mismatch';
          } else if (receivedAt > offlinePackage.uploadUntil) {
            anomaly = 'package_expired';
            responseCode = BizCode.ATTENDANCE_OFFLINE_PACKAGE_EXPIRED;
          } else if (offlinePackage.statusCode === 'revoked') {
            anomaly = 'package_revoked';
          } else if (!operatorAuthorized) {
            anomaly = 'operator_authorization_revoked';
          } else if (input.deviceTime.getTime() > receivedAt.getTime() + FUTURE_TOLERANCE_MS) {
            anomaly = 'future_time';
          } else if (
            input.deviceTime < offlinePackage.validFrom ||
            input.deviceTime > offlinePackage.validUntil ||
            !(await this.access.inSessionWindow(
              tx,
              offlinePackage.activityId,
              offlinePackage.sessionId,
              input.actionCode,
              input.deviceTime,
            ))
          ) {
            anomaly = 'time_out_of_window';
          }

          if (anomaly !== null) {
            const staged = await this.reviews.stageReview(tx, {
              offlinePackage,
              anomaly,
              currentUser,
              receivedAt,
              input,
              proof,
              frozenParticipant,
            });
            if (staged.created) {
              await this.audit.logOffline({
                operation: 'attendance-offline-package.upload-review',
                activityId: offlinePackage.activityId,
                sessionId: offlinePackage.sessionId,
                packageId: offlinePackage.id,
                reviewItemId: staged.review.id,
                statusCode: staged.review.statusCode,
                anomalyCode: anomaly,
                actorUserId: currentUser.id,
                actorRoleSnap: currentUser.role,
                auditMeta,
                tx,
              });
            }
            return { kind: 'review' as const, code: responseCode };
          }
          if (!frozenParticipant) {
            throw new BizException(BizCode.ATTENDANCE_OFFLINE_PACKAGE_INVALID);
          }
          const written = await this.punch.offlinePunchWithinTransaction(tx, {
            activityId: offlinePackage.activityId,
            sessionId: offlinePackage.sessionId,
            participationIdentityId: frozenParticipant.participationIdentityId,
            memberId: frozenParticipant.memberId,
            actionCode: input.actionCode,
            eventKey: input.eventKey,
            deviceTime: input.deviceTime,
            receivedAt,
            deviceId: offlinePackage.deviceId,
            longitude: input.longitude,
            latitude: input.latitude,
            accuracy: input.accuracy,
            packageId: offlinePackage.id,
            sequence: input.sequence,
            priorHash: input.priorHash,
            eventPayloadHash: proof.eventPayloadHash,
            signatureDigest: proof.signatureDigest,
            operatorUserId: offlinePackage.operatorUserId,
            operatorMemberId: offlinePackage.operatorMemberId,
            auditActor: currentUser,
            auditMeta,
          });
          if (!written.replayed) {
            await tx.offlinePackage.update({
              where: { id: offlinePackage.id },
              data: {
                nextExpectedSequence: { increment: 1 },
                lastAcceptedHash: proof.chainHash,
                lastAcceptedAt: receivedAt,
              },
            });
            await this.audit.logOffline({
              operation: 'attendance-offline-package.upload',
              activityId: offlinePackage.activityId,
              sessionId: offlinePackage.sessionId,
              packageId: offlinePackage.id,
              eventId: written.eventId,
              statusCode: offlinePackage.statusCode,
              actorUserId: currentUser.id,
              actorRoleSnap: currentUser.role,
              auditMeta,
              tx,
            });
          }
          return { kind: 'success' as const, receipt: written.receipt };
        },
        { maxWait: 60_000, timeout: 60_000 },
      ),
    );
    if (outcome.kind === 'review') throw new BizException(outcome.code);
    return outcome.receipt;
  }

  private assertPackageTokenAnchors(
    row: PackageRow,
    payload: AttendanceOfflinePackageTokenPayload,
    token: string,
  ): void {
    const exact =
      payload.packageId === row.id &&
      payload.activityId === row.activityId &&
      payload.sessionId === row.sessionId &&
      payload.operatorUserId === row.operatorUserId &&
      payload.operatorMemberId === row.operatorMemberId &&
      payload.packageVersion === row.packageVersion &&
      payload.packageKeyVersion === row.packageKeyVersion &&
      payload.validFrom === row.validFrom.toISOString() &&
      payload.validUntil === row.validUntil.toISOString() &&
      payload.uploadUntil === row.uploadUntil.toISOString() &&
      payload.sequenceStart === row.sequenceStart &&
      payload.chainAnchorHash === row.chainAnchorHash &&
      payload.ruleSnapshotHash === row.ruleSnapshotHash &&
      payload.workflowRevision === row.workflowRevision &&
      payload.participantSnapshotHash === row.participantSnapshotHash &&
      this.tokens.digest(token) === row.tokenDigest;
    if (!exact) throw new BizException(BizCode.ATTENDANCE_OFFLINE_PACKAGE_INVALID);
  }

  private participantSnapshotHash(participants: FrozenParticipant[]): string {
    const ordered = [...participants].sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.participationIdentityId, 'utf8'),
        Buffer.from(right.participationIdentityId, 'utf8'),
      ),
    );
    return createHash('sha256')
      .update(
        JSON.stringify({
          v: 'attendance-offline-participants/v1',
          participants: ordered,
        }),
        'utf8',
      )
      .digest('hex');
  }

  private signPackage(row: PackageRow): string {
    return this.tokens.sign({
      v: 1,
      purpose: 'attendance-offline-package',
      packageId: row.id,
      activityId: row.activityId,
      sessionId: row.sessionId,
      operatorUserId: row.operatorUserId,
      operatorMemberId: row.operatorMemberId,
      deviceId: row.deviceId,
      packageVersion: row.packageVersion,
      packageKeyVersion: 0,
      validFrom: row.validFrom.toISOString(),
      validUntil: row.validUntil.toISOString(),
      uploadUntil: row.uploadUntil.toISOString(),
      sequenceStart: row.sequenceStart,
      chainAnchorHash: row.chainAnchorHash,
      ruleSnapshotHash: row.ruleSnapshotHash,
      workflowRevision: row.workflowRevision,
      participantSnapshotHash: row.participantSnapshotHash,
    });
  }

  private presentPackage(row: PackageRow): AppManagedOfflinePackageDto {
    return {
      id: row.id,
      activityId: row.activityId,
      sessionId: row.sessionId,
      deviceId: row.deviceId,
      packageVersion: row.packageVersion,
      packageKeyVersion: 0,
      statusCode: row.statusCode,
      validFrom: row.validFrom,
      validUntil: row.validUntil,
      uploadUntil: row.uploadUntil,
      sequenceStart: row.sequenceStart,
      nextExpectedSequence: row.nextExpectedSequence,
      ruleSnapshotHash: row.ruleSnapshotHash,
      workflowRevision: row.workflowRevision,
      participantSnapshotHash: row.participantSnapshotHash,
    };
  }
}
