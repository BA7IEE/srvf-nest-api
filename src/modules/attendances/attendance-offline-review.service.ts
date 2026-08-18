import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { createAttendanceOfflineChainHash } from './attendance-offline-package-token';
import {
  AttendanceOfflinePackageAccessService,
  OFFLINE_REVIEW_SELECT,
  type FrozenParticipant,
  type PackageRow,
  type ReviewRow,
} from './attendance-offline-package-access.service';
import { AttendancePunchAuditRecorder } from './attendance-punch-audit-recorder';
import { AttendancePunchCommandService } from './attendance-punch-command.service';
import { createOfflineReviewResolutionRequestHash } from './attendance-punch-request-hash';
import type { AppManagedOfflineReviewItemDto } from './dto/app/app-managed-onsite-operations.dto';

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
/**
 * 离线包链**审核族**:异常回执的列表读面与 approve / reject 决议。
 *
 * 边界:仅处理 OfflinePackageReview 的读与状态决议;签发(issue)、作废(revoke)、
 * 上传(upload)留在 AttendanceOfflinePackageService。两侧共用
 * attendance-offline-package-access 的行锁 / 准入 / 重放原语。
 *
 * ⚠️ 本类自持决议路径的 `prisma.$transaction`(与拆分前逐字一致),
 * 锁序仍为 Activity → OfflinePackage → Review,不得反转。
 */
@Injectable()
export class AttendanceOfflineReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly punch: AttendancePunchCommandService,
    private readonly audit: AttendancePunchAuditRecorder,
    private readonly access: AttendanceOfflinePackageAccessService,
  ) {}

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
        await this.access.lockActivity(tx, input.activityId);
        await this.access.requireManagedAttendance(
          tx,
          input.activityId,
          input.currentUser.memberId!,
        );
        const where: Prisma.OfflinePunchReviewItemWhereInput = {
          activityId: input.activityId,
          ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
          ...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
        };
        const [rows, total] = await Promise.all([
          tx.offlinePunchReviewItem.findMany({
            where,
            select: OFFLINE_REVIEW_SELECT,
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
    const reason = this.access.requiredReason(input.reason);
    const requestHash = createOfflineReviewResolutionRequestHash({
      action,
      activityId: input.activityId,
      reviewItemId: input.reviewItemId,
      actorUserId: currentUser.id,
      operationKey: input.operationKey,
      reason,
    });
    return this.access.withUniqueReplay(() =>
      this.prisma.$transaction(
        async (tx) => {
          await this.access.lockActivity(tx, input.activityId);
          const reference = await tx.offlinePunchReviewItem.findFirst({
            where: { id: input.reviewItemId, activityId: input.activityId },
            select: { offlinePackageId: true },
          });
          if (!reference) throw new BizException(BizCode.BAD_REQUEST);
          const offlinePackage = await this.access.lockPackage(
            tx,
            input.activityId,
            reference.offlinePackageId,
          );
          await this.access.requireManagedAttendance(tx, input.activityId, currentUser.memberId!);
          const review = await this.access.lockReview(tx, input.activityId, input.reviewItemId);
          const keyed = await tx.offlinePunchReviewItem.findUnique({
            where: { resolutionOperationKey: input.operationKey },
            select: OFFLINE_REVIEW_SELECT,
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
              !(await this.access.frozenParticipantIsCurrent(
                tx,
                offlinePackage,
                frozenParticipant,
                null,
              ))
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
            select: OFFLINE_REVIEW_SELECT,
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

  async stageReview(
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
      select: OFFLINE_REVIEW_SELECT,
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
      select: OFFLINE_REVIEW_SELECT,
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

  private numberOrNull(value: Prisma.Decimal | null): number | null {
    return value === null ? null : Number(value);
  }
}
