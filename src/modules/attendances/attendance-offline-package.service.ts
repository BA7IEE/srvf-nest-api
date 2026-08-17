import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AttendanceMemberCredentialService } from './attendance-member-credential.service';
import {
  AttendanceOfflinePackageTokenService,
  createAttendanceOfflineChainHash,
  verifyAttendanceOfflineEvent,
  type AttendanceOfflinePackageTokenPayload,
} from './attendance-offline-package-token';
import { AttendancePunchAuditRecorder } from './attendance-punch-audit-recorder';
import { AttendancePunchCommandService } from './attendance-punch-command.service';
import {
  createOfflinePackageIssueRequestHash,
  createOfflinePackageRevokeRequestHash,
  createOfflineReviewResolutionRequestHash,
  normalizeAttendancePunchReason,
} from './attendance-punch-request-hash';
import type { AppActivityPunchReceiptDto } from './dto/app/app-activity-punch.dto';
import type {
  AppManagedOfflinePackageDto,
  AppManagedOfflinePackageIssueReceiptDto,
  AppManagedOfflineReviewItemDto,
} from './dto/app/app-managed-onsite-operations.dto';

type PrismaTx = Prisma.TransactionClient;
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

type PackageRow = {
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

type FrozenParticipant = {
  participationIdentityId: string;
  memberId: string;
  participationRevisionId: string;
  positionId: string | null;
};

type ReviewRow = {
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

const DAY_MS = 24 * 60 * 60_000;
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const REJECT_ONLY_ANOMALIES = new Set<ReviewAnomaly>([
  'device_mismatch',
  'sequence_gap',
  'sequence_duplicate',
  'hash_chain_invalid',
  'signature_invalid',
  'participant_snapshot_mismatch',
]);

@Injectable()
export class AttendanceOfflinePackageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AttendanceOfflinePackageTokenService,
    private readonly memberCredentials: AttendanceMemberCredentialService,
    private readonly punch: AttendancePunchCommandService,
    private readonly audit: AttendancePunchAuditRecorder,
  ) {}

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
    return this.withUniqueReplay(() =>
      this.prisma.$transaction(
        async (tx) => {
          await this.lockActivity(tx, input.activityId);
          await this.requireManagedAttendance(tx, input.activityId, currentUser.memberId!);
          const replay = await tx.offlinePackage.findUnique({
            where: { issueOperationKey: input.operationKey },
            select: this.packageSelect,
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

          const session = await this.lockIssuableSession(tx, input.activityId, input.sessionId);
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
          const participants = await this.lockIssuableParticipants(
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
            select: this.packageSelect,
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
    const reason = this.requiredReason(input.reason);
    const requestHash = createOfflinePackageRevokeRequestHash({
      activityId: input.activityId,
      packageId: input.packageId,
      actorUserId: currentUser.id,
      operationKey: input.operationKey,
      reason,
    });
    return this.withUniqueReplay(() =>
      this.prisma.$transaction(
        async (tx) => {
          await this.lockActivity(tx, input.activityId);
          const row = await this.lockPackage(tx, input.activityId, input.packageId);
          await this.requireManagedAttendance(tx, input.activityId, currentUser.memberId!);
          const keyed = await tx.offlinePackage.findUnique({
            where: { revokeOperationKey: input.operationKey },
            select: this.packageSelect,
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
            select: this.packageSelect,
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
    const outcome = await this.withUniqueReplay(() =>
      this.prisma.$transaction(
        async (tx) => {
          await this.lockActivity(tx, input.activityId);
          await this.requireManagedAttendance(tx, input.activityId, uploaderMemberId);
          const offlinePackage = await this.lockPackage(tx, input.activityId, input.packageId);
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
              : await this.hasManagedAttendance(
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

          const participantCurrent = frozenParticipant
            ? await this.frozenParticipantIsCurrent(
                tx,
                offlinePackage,
                frozenParticipant,
                credential,
              )
            : false;

          const pending = await tx.offlinePunchReviewItem.findFirst({
            where: { offlinePackageId: offlinePackage.id, statusCode: 'pending' },
            select: this.reviewSelect,
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
            !(await this.inSessionWindow(
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
            const staged = await this.stageReview(tx, {
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

  async listReviews(input: {
    activityId: string;
    sessionId?: string;
    statusCode?: 'pending' | 'approved' | 'rejected';
    page: number;
    pageSize: number;
    currentUser: CurrentUserPayload;
  }): Promise<{
    items: AppManagedOfflineReviewItemDto[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    if (input.currentUser.memberId === null) throw new BizException(BizCode.RBAC_FORBIDDEN);
    return this.prisma.$transaction(
      async (tx) => {
        await this.lockActivity(tx, input.activityId);
        await this.requireManagedAttendance(tx, input.activityId, input.currentUser.memberId!);
        const where: Prisma.OfflinePunchReviewItemWhereInput = {
          activityId: input.activityId,
          ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
          ...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
        };
        const [rows, total] = await Promise.all([
          tx.offlinePunchReviewItem.findMany({
            where,
            select: this.reviewSelect,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip: (input.page - 1) * input.pageSize,
            take: input.pageSize,
          }),
          tx.offlinePunchReviewItem.count({ where }),
        ]);
        return {
          items: rows.map((row) => this.presentReview(row)),
          total,
          page: input.page,
          pageSize: input.pageSize,
        };
      },
      { maxWait: 60_000, timeout: 60_000 },
    );
  }

  async approveReview(
    input: {
      activityId: string;
      reviewItemId: string;
      operationKey: string;
      reason: string;
    },
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedOfflineReviewItemDto> {
    return this.resolveReview('approve', input, currentUser, auditMeta);
  }

  async rejectReview(
    input: {
      activityId: string;
      reviewItemId: string;
      operationKey: string;
      reason: string;
    },
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedOfflineReviewItemDto> {
    return this.resolveReview('reject', input, currentUser, auditMeta);
  }

  private async resolveReview(
    action: 'approve' | 'reject',
    input: {
      activityId: string;
      reviewItemId: string;
      operationKey: string;
      reason: string;
    },
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedOfflineReviewItemDto> {
    if (currentUser.memberId === null) throw new BizException(BizCode.RBAC_FORBIDDEN);
    const reason = this.requiredReason(input.reason);
    const requestHash = createOfflineReviewResolutionRequestHash({
      action,
      activityId: input.activityId,
      reviewItemId: input.reviewItemId,
      actorUserId: currentUser.id,
      operationKey: input.operationKey,
      reason,
    });
    return this.withUniqueReplay(() =>
      this.prisma.$transaction(
        async (tx) => {
          await this.lockActivity(tx, input.activityId);
          const reference = await tx.offlinePunchReviewItem.findFirst({
            where: { id: input.reviewItemId, activityId: input.activityId },
            select: { offlinePackageId: true },
          });
          if (!reference) throw new BizException(BizCode.BAD_REQUEST);
          const offlinePackage = await this.lockPackage(
            tx,
            input.activityId,
            reference.offlinePackageId,
          );
          await this.requireManagedAttendance(tx, input.activityId, currentUser.memberId!);
          const review = await this.lockReview(tx, input.activityId, input.reviewItemId);
          const keyed = await tx.offlinePunchReviewItem.findUnique({
            where: { resolutionOperationKey: input.operationKey },
            select: this.reviewSelect,
          });
          if (keyed) {
            const keyedAction = keyed.statusCode === 'approved' ? 'approve' : 'reject';
            if (
              keyed.id !== review.id ||
              keyedAction !== action ||
              keyed.resolutionRequestHash !== requestHash
            ) {
              throw new BizException(BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT);
            }
            return this.presentReview(keyed);
          }
          if (review.statusCode !== 'pending') throw new BizException(BizCode.BAD_REQUEST);
          if (action === 'approve' && review.approvalPolicyCode !== 'approvable') {
            throw new BizException(BizCode.BAD_REQUEST);
          }
          const now = new Date();
          let formalEventId: string | null = null;
          let chainHash: string | null = null;
          if (action === 'approve') {
            if (
              review.participationIdentityId === null ||
              review.participationRevisionId === null ||
              review.actionCode === null ||
              review.deviceTime === null ||
              review.providedPriorHash === null ||
              review.eventPayloadHash === null ||
              review.signatureDigest === null ||
              review.sequence !== offlinePackage.nextExpectedSequence ||
              review.providedPriorHash !== offlinePackage.lastAcceptedHash ||
              !['check_in', 'check_out'].includes(review.actionCode) ||
              review.deviceTime < offlinePackage.validFrom ||
              review.deviceTime > offlinePackage.validUntil ||
              review.deviceTime.getTime() > now.getTime() + FUTURE_TOLERANCE_MS
            ) {
              throw new BizException(BizCode.ATTENDANCE_PUNCH_OUTSIDE_WINDOW);
            }
            const frozenParticipant = await tx.offlinePackageParticipant.findUnique({
              where: {
                offlinePackageId_participationIdentityId: {
                  offlinePackageId: offlinePackage.id,
                  participationIdentityId: review.participationIdentityId,
                },
              },
              select: {
                participationIdentityId: true,
                memberId: true,
                participationRevisionId: true,
                positionId: true,
              },
            });
            if (
              !frozenParticipant ||
              frozenParticipant.participationRevisionId !== review.participationRevisionId ||
              !(await this.frozenParticipantIsCurrent(tx, offlinePackage, frozenParticipant, null))
            ) {
              throw new BizException(BizCode.ATTENDANCE_REGISTRATION_INVALID);
            }
            const written = await this.punch.offlinePunchWithinTransaction(tx, {
              activityId: offlinePackage.activityId,
              sessionId: offlinePackage.sessionId,
              participationIdentityId: frozenParticipant.participationIdentityId,
              memberId: frozenParticipant.memberId,
              actionCode: review.actionCode as 'check_in' | 'check_out',
              eventKey: review.eventKey,
              deviceTime: review.deviceTime,
              receivedAt: now,
              deviceId: offlinePackage.deviceId,
              longitude: this.numberOrNull(review.longitude),
              latitude: this.numberOrNull(review.latitude),
              accuracy: this.numberOrNull(review.accuracy),
              packageId: offlinePackage.id,
              sequence: review.sequence,
              priorHash: review.providedPriorHash,
              eventPayloadHash: review.eventPayloadHash,
              signatureDigest: review.signatureDigest,
              operatorUserId: offlinePackage.operatorUserId,
              operatorMemberId: offlinePackage.operatorMemberId,
              auditActor: currentUser,
              auditMeta,
            });
            formalEventId = written.eventId;
            chainHash = createAttendanceOfflineChainHash({
              packageId: offlinePackage.id,
              sequence: review.sequence,
              priorHash: review.providedPriorHash,
              eventPayloadHash: review.eventPayloadHash,
              signatureDigest: review.signatureDigest,
            });
          }
          const updatedReview = await tx.offlinePunchReviewItem.update({
            where: { id: review.id },
            data: {
              statusCode: action === 'approve' ? 'approved' : 'rejected',
              reviewedByUserId: currentUser.id,
              reviewedByMemberId: currentUser.memberId,
              reviewedAt: now,
              reviewReason: reason,
              resolutionOperationKey: input.operationKey,
              resolutionRequestHash: requestHash,
              formalPunchEventId: formalEventId,
            },
            select: this.reviewSelect,
          });
          if (action === 'approve' && chainHash !== null) {
            await tx.offlinePackage.update({
              where: { id: offlinePackage.id },
              data: {
                nextExpectedSequence: Math.max(
                  offlinePackage.nextExpectedSequence,
                  review.sequence + 1,
                ),
                lastAcceptedHash: chainHash,
                lastAcceptedAt: now,
                ...(offlinePackage.statusCode === 'review_required' &&
                now <= offlinePackage.uploadUntil
                  ? { statusCode: 'active' }
                  : {}),
              },
            });
          } else if (action === 'reject' && offlinePackage.statusCode === 'review_required') {
            const conflictingRevoke = await tx.offlinePackage.findUnique({
              where: { revokeOperationKey: input.operationKey },
              select: { id: true },
            });
            if (conflictingRevoke && conflictingRevoke.id !== offlinePackage.id) {
              throw new BizException(BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT);
            }
            await tx.offlinePackage.update({
              where: { id: offlinePackage.id },
              data: {
                statusCode: 'revoked',
                revokedByUserId: currentUser.id,
                revokedAt: now,
                revokeReason: reason,
                revokeOperationKey: input.operationKey,
                revokeRequestHash: requestHash,
              },
            });
          }
          await this.audit.logOffline({
            operation:
              action === 'approve'
                ? 'attendance-offline-review.approve'
                : 'attendance-offline-review.reject',
            activityId: offlinePackage.activityId,
            sessionId: offlinePackage.sessionId,
            packageId: offlinePackage.id,
            reviewItemId: review.id,
            eventId: formalEventId,
            statusCode: updatedReview.statusCode,
            anomalyCode: updatedReview.anomalyCode,
            actorUserId: currentUser.id,
            actorRoleSnap: currentUser.role,
            auditMeta,
            tx,
          });
          return this.presentReview(updatedReview);
        },
        { maxWait: 60_000, timeout: 60_000 },
      ),
    );
  }

  private async stageReview(
    tx: PrismaTx,
    args: {
      offlinePackage: PackageRow;
      anomaly: ReviewAnomaly;
      currentUser: CurrentUserPayload;
      receivedAt: Date;
      input: {
        sequence: number;
        priorHash: string;
        eventKey: string;
        actionCode: 'check_in' | 'check_out';
        deviceTime: Date;
        longitude: number | null;
        latitude: number | null;
        accuracy: number | null;
      };
      proof: { eventPayloadHash: string; signatureDigest: string };
      frozenParticipant: FrozenParticipant | null;
    },
  ): Promise<{ review: ReviewRow; created: boolean }> {
    const existing = await tx.offlinePunchReviewItem.findUnique({
      where: {
        offlinePackageId_sequence: {
          offlinePackageId: args.offlinePackage.id,
          sequence: args.input.sequence,
        },
      },
      select: this.reviewSelect,
    });
    if (existing) {
      if (
        existing.eventKey !== args.input.eventKey ||
        existing.providedPriorHash !== args.input.priorHash ||
        existing.eventPayloadHash !== args.proof.eventPayloadHash ||
        existing.signatureDigest !== args.proof.signatureDigest
      ) {
        throw new BizException(BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT);
      }
      return { review: existing, created: false };
    }
    const created = await tx.offlinePunchReviewItem.create({
      data: {
        offlinePackageId: args.offlinePackage.id,
        activityId: args.offlinePackage.activityId,
        sessionId: args.offlinePackage.sessionId,
        sequence: args.input.sequence,
        eventKey: args.input.eventKey,
        statusCode: 'pending',
        anomalyCode: args.anomaly,
        approvalPolicyCode: REJECT_ONLY_ANOMALIES.has(args.anomaly) ? 'reject_only' : 'approvable',
        participationIdentityId: args.frozenParticipant?.participationIdentityId ?? null,
        participationRevisionId: args.frozenParticipant?.participationRevisionId ?? null,
        actionCode: args.input.actionCode,
        deviceTime: args.input.deviceTime,
        longitude: args.input.longitude,
        latitude: args.input.latitude,
        accuracy: args.input.accuracy,
        providedPriorHash: args.input.priorHash,
        eventPayloadHash: args.proof.eventPayloadHash,
        signatureDigest: args.proof.signatureDigest,
        stagedByUserId: args.currentUser.id,
        stagedByMemberId: args.currentUser.memberId,
        stagedAt: args.receivedAt,
      },
      select: this.reviewSelect,
    });
    if (args.anomaly === 'package_expired') {
      if (['active', 'review_required'].includes(args.offlinePackage.statusCode)) {
        await tx.offlinePackage.update({
          where: { id: args.offlinePackage.id },
          data: { statusCode: 'expired' },
        });
      }
    } else if (args.offlinePackage.statusCode === 'active') {
      await tx.offlinePackage.update({
        where: { id: args.offlinePackage.id },
        data: { statusCode: 'review_required' },
      });
    }
    return { review: created, created: true };
  }

  private async lockActivity(tx: PrismaTx, activityId: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string; statusCode: string }>>(Prisma.sql`
      SELECT "id", "statusCode" FROM "Activity"
      WHERE "id" = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    if (rows.length !== 1) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    if (rows[0].statusCode !== 'published') {
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    }
  }

  private async lockIssuableSession(
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

  private async lockPackage(
    tx: PrismaTx,
    activityId: string,
    packageId: string,
  ): Promise<PackageRow> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "OfflinePackage"
      WHERE "id" = ${packageId} AND "activityId" = ${activityId}
      FOR UPDATE
    `);
    if (locked.length !== 1) throw new BizException(BizCode.ATTENDANCE_OFFLINE_PACKAGE_INVALID);
    const row = await tx.offlinePackage.findFirst({
      where: { id: packageId, activityId },
      select: this.packageSelect,
    });
    if (!row) throw new BizException(BizCode.ATTENDANCE_OFFLINE_PACKAGE_INVALID);
    return row;
  }

  private async lockReview(
    tx: PrismaTx,
    activityId: string,
    reviewItemId: string,
  ): Promise<ReviewRow> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "OfflinePunchReviewItem"
      WHERE "id" = ${reviewItemId} AND "activityId" = ${activityId}
      FOR UPDATE
    `);
    if (locked.length !== 1) throw new BizException(BizCode.BAD_REQUEST);
    const row = await tx.offlinePunchReviewItem.findFirst({
      where: { id: reviewItemId, activityId },
      select: this.reviewSelect,
    });
    if (!row) throw new BizException(BizCode.BAD_REQUEST);
    return row;
  }

  private async lockIssuableParticipants(
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

  private async frozenParticipantIsCurrent(
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

  private async hasManagedAttendance(
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

  private async requireManagedAttendance(
    tx: PrismaTx,
    activityId: string,
    memberId: string,
  ): Promise<void> {
    if (!(await this.hasManagedAttendance(tx, activityId, memberId))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  private async inSessionWindow(
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
      },
    });
    if (!session) return false;
    const from = action === 'check_in' ? session.checkInOpenAt : session.checkOutOpenAt;
    const until = action === 'check_in' ? session.checkInCloseAt : session.checkOutCloseAt;
    return at >= from && at <= until;
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

  private presentReview(row: ReviewRow): AppManagedOfflineReviewItemDto {
    return {
      id: row.id,
      packageId: row.offlinePackageId,
      sessionId: row.sessionId,
      sequence: row.sequence,
      eventKey: row.eventKey,
      statusCode: row.statusCode,
      anomalyCode: row.anomalyCode,
      approvalPolicyCode: row.approvalPolicyCode,
      participationIdentityId: row.participationIdentityId,
      actionCode: row.actionCode,
      deviceTime: row.deviceTime,
      stagedAt: row.stagedAt,
      reviewedAt: row.reviewedAt,
      reviewReason: row.reviewReason,
      formalPunchEventId: row.formalPunchEventId,
    };
  }

  private requiredReason(value: string): string {
    const reason = normalizeAttendancePunchReason(value);
    if (reason === null) throw new BizException(BizCode.BAD_REQUEST);
    return reason;
  }

  private async withUniqueReplay<T>(operation: () => Promise<T>): Promise<T> {
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

  private numberOrNull(value: Prisma.Decimal | null): number | null {
    return value === null ? null : Number(value);
  }

  private readonly packageSelect = {
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

  private readonly reviewSelect = {
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
}

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
