import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';

import type { JwtConfig } from '../../config/jwt.config';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AuthzService } from '../authz/authz.service';
import { RbacService } from '../permissions/rbac.service';
import { ActivityRegistrationAuditRecorder } from './activity-registration-audit-recorder';
import { ActivityRegistrationLifecycleService } from './activity-registration-lifecycle.service';
import { ActivityRegistrationNotificationProducer } from './activity-registration-notification-producer';
import {
  ActivityQualificationEvaluatorService,
  type ActivityQualificationEvaluation,
  type QualificationProjection,
} from './activity-qualification-evaluator.service';
import {
  CapacityReservationService,
  type CapacityReservationReserveResult,
} from './capacity-reservation.service';
import {
  compareUtf8,
  createAllocationResponseHash,
  createCandidateSnapshotHash,
  createLotteryCommitment,
  createQualificationSnapshotHash,
  deriveLotterySeed,
  hashAllocationCommand,
  sha256Canonical,
  type AllocationModeCode,
  type AllocationQualificationRuleSetOutcome,
} from './activity-allocation-request-hash';
import type {
  AppActivityAllocationBatchDto,
  AppActivityAllocationCommandReceiptDto,
  CommitAppManagedActivityAllocationBatchDto,
  PrepareAppManagedActivityAllocationBatchDto,
  VoidAppManagedActivityAllocationBatchDto,
} from './dto/app/app-activity-allocation-batch.dto';

type PrismaTx = Prisma.TransactionClient;
type AllocationResultCode = 'allocated' | 'waitlisted' | 'not_selected';
type AllocationCommandCode = 'prepare' | 'commit' | 'void';
type QualificationModeCode = AllocationModeCode | 'first_come';
type ReceiptBatchStatusCode = 'preparing' | 'committed' | 'voided';

const ALLOCATION_ALGORITHM_VERSION = 'allocation-v1';
const RESPONSE_SCHEMA_VERSION = 'allocation-command-response-v1';

type LockedActivity = {
  id: string;
  title: string;
  statusCode: string;
  registrationDeadline: Date | null;
  allocationModeCode: string;
  startAt: Date;
  endAt: Date;
};

type LockedBatch = {
  id: string;
  activityId: string;
  sessionId: string;
  positionId: string | null;
  modeCode: string;
  candidateSnapshotHash: string;
  algorithmVersionCode: string;
  randomCommitment: string | null;
  randomSeedReveal: string | null;
  statusCode: string;
  operationKey: string;
  requestHash: string | null;
  committedAt: Date | null;
  voidReason: string | null;
  voidedAt: Date | null;
};

type CandidateSource = {
  id: string;
  activityId: string;
  memberId: string;
  sessionId: string;
  registrationId: string;
  identityRevision: number;
  identityStatusCode: string;
  currentPositionId: string | null;
  capacityReservationId: string | null;
  populationIncluded: boolean;
  identityVersion: number;
  registrationCurrentRevision: number;
  registrationRevisionId: string;
  participationRevisionId: string;
  participationRevisionStatusCode: string;
  participationRevisionPositionId: string | null;
  participationRevisionWaitlistRank: number | null;
  participationRevisionAllocationBatchId: string | null;
  acceptedAt: Date;
  preferenceSnapshot: Prisma.JsonValue | null;
};

type FrozenQualification = {
  aggregateResultCode: 'pass' | 'warn' | 'fail';
  penalty: number | null;
  qualificationScore: string | null;
  qualificationSnapshotHash: string;
  explanation: Prisma.InputJsonObject;
};

type FrozenCandidate = CandidateSource &
  FrozenQualification & {
    participationIdentityId: string;
    tieBreakKey: string;
  };

type PersistedCandidate = {
  allocationCandidateId: string;
  activityId: string;
  sessionId: string;
  waitlistPositionId: string | null;
  participationIdentityId: string;
  registrationId: string;
  registrationRevisionId: string;
  acceptedAt: Date;
  qualificationSnapshotHash: string;
  qualificationScore: Prisma.Decimal | null;
  tieBreakKey: string;
  lotteryOrder: number | null;
  resultCode: string | null;
  waitlistRank: number | null;
  explanation: Prisma.JsonValue;
};

type CheckedCandidate = PersistedCandidate &
  CandidateSource & {
    frozen: FrozenQualification;
  };

type ReservationAnchors = {
  activityPersonReservationId: string;
  activityPersonBucketId: string;
  sessionReservationId: string;
  sessionBucketId: string;
  positionReservationId: string | null;
  positionBucketId: string | null;
};

type LockedApplicationProjection = {
  id: string;
  allocationCandidateId: string;
  participationIdentityId: string;
  memberId: string;
  appliedParticipationRevisionId: string;
  appliedResultCode: AllocationResultCode;
  appliedStatusCode: 'pass' | 'waitlisted' | 'not_selected';
  positionId: string | null;
  populationIncluded: boolean;
  expectedIdentityCapacityReservationId: string | null;
  activityPersonReservationId: string | null;
  activityPersonBucketId: string | null;
  sessionReservationId: string | null;
  sessionBucketId: string | null;
  positionReservationId: string | null;
  positionBucketId: string | null;
};

type ProjectedReservationRow = {
  id: string;
  identityId: string;
  reservationType: string;
  memberId: string | null;
  activityId: string | null;
  bucketId: string;
  status: string;
  bucketOccupied: number;
  bucketActiveCount: number;
};

type FirstComeWaitlistRow = {
  participationIdentityId: string;
  acceptedAt: Date;
  waitlistRank: number | null;
  currentPositionId: string | null;
  capacityReservationId: string | null;
  populationIncluded: boolean;
};

type FreedAllocationSlot = {
  participationIdentityId: string;
  sessionId: string;
  positionId: string | null;
  allocationBatchId: string | null;
  priorSourceCode: string;
  priorRequestKey: string | null;
  currentStatusCode: string;
  currentRevisionStatusCode: string;
  currentPositionId: string | null;
  capacityReservationId: string | null;
  populationIncluded: boolean;
};

type PromotionWaitlistCandidate = {
  participationIdentityId: string;
  registrationId: string;
  memberId: string;
  sessionId: string;
  positionId: string | null;
  allocationBatchId: string | null;
  waitlistRank: number;
  acceptedAt: Date;
  preferenceSnapshot: Prisma.JsonValue | null;
  identityRevision: number;
  identityVersion: number;
  currentStatusCode: string;
  currentPositionId: string | null;
  capacityReservationId: string | null;
  populationIncluded: boolean;
};

type LockedBatchPromotionCandidate = PromotionWaitlistCandidate & {
  candidateActivityId: string;
  candidateSessionId: string;
  waitlistPositionId: string | null;
  batchModeCode: string;
  batchStatusCode: string;
  batchPositionId: string | null;
  applicationProjectionId: string | null;
  appliedResultCode: string | null;
  appliedStatusCode: string | null;
  appliedPositionId: string | null;
  appliedPopulationIncluded: boolean | null;
  appliedExpectedReservationId: string | null;
  appliedActivityReservationId: string | null;
  appliedSessionReservationId: string | null;
  appliedPositionReservationId: string | null;
};

type AllocationPromotionResult = {
  handled: boolean;
  activityTitle: string;
  promoted: Array<{ registrationId: string; memberId: string }>;
};

function isAllocationMode(value: string): value is AllocationModeCode {
  return value === 'qualification_rank' || value === 'lottery';
}

function decimalString(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toFixed(4);
}

function asObject(value: Prisma.JsonValue): Record<string, Prisma.JsonValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : null;
}

function candidateQualificationResult(value: Prisma.JsonValue): 'pass' | 'warn' | 'fail' {
  const explanation = asObject(value);
  const result = explanation?.aggregateResultCode;
  if (result === 'pass' || result === 'warn' || result === 'fail') return result;
  throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
}

function hasPositionPreference(value: Prisma.JsonValue | null, positionId: string): boolean {
  const snapshot = value === null ? null : asObject(value);
  const positions = snapshot?.positionIds;
  return Array.isArray(positions) && positions.some((position) => position === positionId);
}

/**
 * The coordinator owns allocation state only. Reservation/bucket occupancy remains entirely in
 * CapacityReservationService; all command writes run under the Activity aggregate transaction.
 */
@Injectable()
export class ActivityAllocationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly rbac: RbacService,
    private readonly qualificationEvaluator: ActivityQualificationEvaluatorService,
    private readonly capacityReservations: CapacityReservationService,
    private readonly lifecycle: ActivityRegistrationLifecycleService,
    private readonly registrationAudit: ActivityRegistrationAuditRecorder,
    private readonly notifications: ActivityRegistrationNotificationProducer,
    private readonly config: ConfigService,
  ) {}

  async prepare(
    activityId: string,
    dto: PrepareAppManagedActivityAllocationBatchDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppActivityAllocationCommandReceiptDto> {
    await this.assertAction(currentUser, 'activity-registration.approve.record', activityId);
    const positionId = dto.positionId ?? null;
    const requestHash = hashAllocationCommand({
      commandCode: 'prepare',
      activityId,
      allocationBatchId: null,
      operationKey: dto.operationKey,
      sessionId: dto.sessionId,
      positionId,
    });
    try {
      return await this.prisma.$transaction(async (tx) => {
        const activity = await this.lockActivity(tx, activityId);
        await this.assertManagedResponsibility(tx, activityId, currentUser);
        const replay = await this.findReplay(
          tx,
          activityId,
          'prepare',
          dto.operationKey,
          requestHash,
        );
        if (replay) return replay;

        if (!isAllocationMode(activity.allocationModeCode)) {
          throw new BizException(BizCode.ACTIVITY_ALLOCATION_MODE_INCONSISTENT);
        }
        if (
          activity.registrationDeadline === null ||
          new Date().getTime() <= activity.registrationDeadline.getTime()
        ) {
          throw new BizException(BizCode.ACTIVITY_REGISTRATION_DEADLINE_PASSED);
        }
        await this.assertAllHistoricalBatchModes(tx, activityId, activity.allocationModeCode);
        await this.assertTargetShape(tx, activityId, dto.sessionId, positionId);
        await this.assertNoUnvoidedTargetBatch(tx, activityId, dto.sessionId, positionId);

        // Activity -> target session/position -> batch -> candidate identity/header/revision is fixed.
        const sources = await this.lockCandidateSources(tx, activityId, dto.sessionId);
        const selected = sources.filter(
          (source) =>
            source.identityStatusCode === 'pending' &&
            (positionId === null || hasPositionPreference(source.preferenceSnapshot, positionId)),
        );
        const frozen: FrozenCandidate[] = [];
        for (const source of selected) {
          this.assertPendingSource(source);
          const qualification = await this.freezeQualification({
            tx,
            activity,
            memberId: source.memberId,
            sessionId: dto.sessionId,
            positionId,
            modeCode: activity.allocationModeCode,
          });
          frozen.push({
            ...source,
            ...qualification,
            participationIdentityId: source.id,
            tieBreakKey: source.id,
          });
        }

        const batchId = randomUUID();
        const candidateSnapshotHash = createCandidateSnapshotHash({
          activityId,
          sessionId: dto.sessionId,
          positionId,
          modeCode: activity.allocationModeCode,
          algorithmVersionCode: ALLOCATION_ALGORITHM_VERSION,
          candidates: frozen.map((candidate) => ({
            participationIdentityId: candidate.participationIdentityId,
            registrationId: candidate.registrationId,
            registrationRevisionId: candidate.registrationRevisionId,
            acceptedAt: candidate.acceptedAt,
            qualificationSnapshotHash: candidate.qualificationSnapshotHash,
            qualificationScore: candidate.qualificationScore,
            tieBreakKey: candidate.tieBreakKey,
          })),
        });
        const lotterySeed =
          activity.allocationModeCode === 'lottery'
            ? this.deriveLotterySeed({
                activityId,
                allocationBatchId: batchId,
                algorithmVersionCode: ALLOCATION_ALGORITHM_VERSION,
              })
            : null;
        const created = await tx.activityAllocationBatch.create({
          data: {
            id: batchId,
            activityId,
            sessionId: dto.sessionId,
            positionId,
            modeCode: activity.allocationModeCode,
            candidateSnapshotHash,
            algorithmVersionCode: ALLOCATION_ALGORITHM_VERSION,
            randomCommitment: lotterySeed === null ? null : createLotteryCommitment(lotterySeed),
            statusCode: 'preparing',
            operationKey: dto.operationKey,
            requestHash,
            createdByUserId: currentUser.id,
          },
          select: { id: true },
        });
        if (frozen.length > 0) {
          await tx.activityAllocationCandidate.createMany({
            data: frozen.map((candidate) => ({
              allocationBatchId: created.id,
              activityId: candidate.activityId,
              sessionId: candidate.sessionId,
              participationIdentityId: candidate.participationIdentityId,
              registrationId: candidate.registrationId,
              registrationRevisionId: candidate.registrationRevisionId,
              acceptedAt: candidate.acceptedAt,
              qualificationSnapshotHash: candidate.qualificationSnapshotHash,
              qualificationScore: candidate.qualificationScore,
              tieBreakKey: candidate.tieBreakKey,
              explanation: candidate.explanation,
            })),
          });
        }
        const receipt = await this.writeReceipt(tx, {
          activityId,
          allocationBatchId: created.id,
          commandCode: 'prepare',
          operationKey: dto.operationKey,
          requestHash,
          actorUserId: currentUser.id,
          batchStatusCode: 'preparing',
        });
        await this.registrationAudit.logAllocationCommand({
          activityId,
          allocationBatchId: created.id,
          commandCode: 'prepare',
          actorUserId: currentUser.id,
          actorRoleSnap: currentUser.role,
          auditMeta,
          tx,
        });
        return receipt;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.resolveReplayRace(activityId, 'prepare', dto.operationKey, requestHash);
      }
      throw error;
    }
  }

  async get(
    activityId: string,
    batchId: string,
    currentUser: CurrentUserPayload,
  ): Promise<AppActivityAllocationBatchDto> {
    await this.assertAction(currentUser, 'activity-registration.read.record', activityId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockActivity(tx, activityId);
      await this.assertManagedResponsibility(tx, activityId, currentUser);
      return this.loadBatchDto(tx, activityId, batchId);
    });
  }

  /**
   * D84's database default is a compatibility bridge for activities published before the
   * capacity-bucket projection existed.  Under the already-held Activity root lock, an entirely
   * absent topology means that legacy first_come registration retains its pre-allocation pending
   * behavior.  A non-empty topology is deliberately not validated here: the CapacityReservation
   * service must see and fail-close every partial or drifted topology itself.
   */
  async hasInitializedCapacityTopologyInTransactionTrusted(
    tx: PrismaTx,
    activityId: string,
  ): Promise<boolean> {
    const bucketCount = await tx.activityCapacityBucket.count({ where: { activityId } });
    return bucketCount > 0;
  }

  /**
   * Canonical/invitation registration callers invoke this only after their common Form,
   * qualification, insurance, permanent-identity and pointer chain has been written under the
   * Activity root lock.  first_come never creates an allocation batch: its durable facts are the
   * next immutable participation revision, CapacityReservation rows, audit and outbox intent.
   */
  async applyFirstComeAfterSubmissionInTransactionTrusted(
    tx: PrismaTx,
    input: {
      activity: LockedActivity;
      memberId: string;
      identities: readonly { id: string; sessionId: string }[];
      currentUser: CurrentUserPayload;
      sourceCode: 'self' | 'invitation';
      requestKey: string;
      requestHash: string;
      occurredAt: Date;
      auditMeta: AuditMeta;
    },
  ): Promise<void> {
    if (input.activity.allocationModeCode !== 'first_come') {
      throw new BizException(BizCode.ACTIVITY_ALLOCATION_MODE_INCONSISTENT);
    }
    const uniqueTargets = new Map<string, { id: string; sessionId: string }>();
    for (const identity of input.identities) {
      if (!identity.id || !identity.sessionId || uniqueTargets.has(identity.id)) {
        throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
      }
      uniqueTargets.set(identity.id, identity);
    }
    const sources: CandidateSource[] = [];
    for (const target of [...uniqueTargets.values()].sort(
      (left, right) =>
        compareUtf8(left.sessionId, right.sessionId) || compareUtf8(left.id, right.id),
    )) {
      const rows = await this.lockCandidateSources(tx, input.activity.id, target.sessionId, [
        target.id,
      ]);
      const source = rows[0];
      if (rows.length !== 1 || !source || source.memberId !== input.memberId) {
        throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
      }
      this.assertPendingSource(source);
      sources.push(source);
    }

    let populationChanged = false;
    const outcomesByRegistration = new Map<string, { allocated: number; waitlisted: number }>();
    for (const source of sources.sort(
      (left, right) =>
        compareUtf8(left.sessionId, right.sessionId) || compareUtf8(left.id, right.id),
    )) {
      const qualification = await this.freezeQualification({
        tx,
        activity: input.activity,
        memberId: source.memberId,
        sessionId: source.sessionId,
        positionId: null,
        modeCode: 'first_come',
      });
      if (qualification.aggregateResultCode === 'fail') {
        throw new BizException(BizCode.ACTIVITY_QUALIFICATION_NOT_MET);
      }
      const selection = await this.reserveInitialPreference(tx, {
        activityId: input.activity.id,
        memberId: source.memberId,
        participationIdentityId: source.id,
        preferenceSnapshot: source.preferenceSnapshot,
        batchPositionId: null,
      });
      const allocated = selection.reservation !== null;
      const resultCode: Extract<AllocationResultCode, 'allocated' | 'waitlisted'> = allocated
        ? 'allocated'
        : 'waitlisted';
      const waitlistRank = allocated
        ? null
        : await this.firstComeWaitlistRank(tx, {
            activityId: input.activity.id,
            sessionId: source.sessionId,
            positionId: selection.waitlistPositionId,
            participationIdentityId: source.id,
            acceptedAt: source.acceptedAt,
          });
      const anchors = allocated
        ? await this.readReservationAnchors(
            tx,
            source.id,
            selection.positionId,
            selection.reservation as Extract<
              CapacityReservationReserveResult,
              { outcome: 'reserved' }
            >,
          )
        : null;
      const nextRevision = source.identityRevision + 1;
      await tx.activityParticipationRevision.create({
        data: {
          identityId: source.id,
          revision: nextRevision,
          statusCode: allocated ? 'pass' : 'waitlisted',
          positionId: allocated ? selection.positionId : selection.waitlistPositionId,
          preferenceSnapshot: source.preferenceSnapshot ?? Prisma.JsonNull,
          waitlistRank,
          effectiveAt: source.acceptedAt,
          createdByUserId: input.currentUser.id,
          sourceCode: input.sourceCode,
          requestKey: input.requestKey,
          requestHash: input.requestHash,
        },
      });
      const updated = await tx.activityParticipationIdentity.updateMany({
        where: {
          id: source.id,
          currentRevision: source.identityRevision,
          version: source.identityVersion,
        },
        data: {
          currentRevision: nextRevision,
          currentStatusCode: allocated ? 'pass' : 'waitlisted',
          currentPositionId: allocated ? selection.positionId : null,
          capacityReservationId: anchors?.sessionReservationId ?? null,
          populationIncluded: allocated,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1)
        throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
      populationChanged ||= allocated;
      const outcomes = outcomesByRegistration.get(source.registrationId) ?? {
        allocated: 0,
        waitlisted: 0,
      };
      outcomes[resultCode] += 1;
      outcomesByRegistration.set(source.registrationId, outcomes);
      await this.notifications.enqueueAllocationOutcome(tx, {
        allocationKey: `first-come:${source.registrationRevisionId}`,
        participationIdentityId: source.id,
        registrationId: source.registrationId,
        memberId: source.memberId,
        activityTitle: input.activity.title,
        resultCode,
      });
    }
    if (populationChanged) {
      await this.lifecycle.incrementPopulationRevisionInTransactionTrusted(
        tx,
        input.activity.id,
        input.occurredAt,
      );
    }
    await this.reconcileRegistrationHeaders(tx, new Set(outcomesByRegistration.keys()));
    for (const [registrationId, outcomeCounts] of [...outcomesByRegistration.entries()].sort(
      ([left], [right]) => compareUtf8(left, right),
    )) {
      await this.registrationAudit.logFirstComeAllocation({
        registrationId,
        activityId: input.activity.id,
        actorUserId: input.currentUser.id,
        actorRoleSnap: input.currentUser.role,
        outcomeCounts,
        auditMeta: input.auditMeta,
        tx,
      });
    }
  }

  /**
   * The legacy registration cancellation caller delegates here only after it has released the
   * cancelled allocation pass under the Activity root lock.  Batch candidates remain immutable:
   * a promotion appends a new participation revision and never rewrites the committed result.
   */
  async promoteAfterCancellationInTransactionTrusted(
    tx: PrismaTx,
    input: {
      activityId: string;
      registrationId: string;
      actorUser: CurrentUserPayload;
      promotedAt: Date;
      auditMeta: AuditMeta;
    },
  ): Promise<AllocationPromotionResult> {
    const activity = await this.lockActivity(tx, input.activityId);
    const modeCode = activity.allocationModeCode;
    if (modeCode !== 'first_come' && !isAllocationMode(modeCode)) {
      return { handled: false, activityTitle: activity.title, promoted: [] };
    }
    const slots = await this.lockCancelledAllocationSlots(
      tx,
      input.activityId,
      input.registrationId,
    );
    const allocationSlots = slots.filter(
      (slot) =>
        slot.allocationBatchId !== null ||
        (modeCode === 'first_come' &&
          (slot.priorSourceCode === 'self' || slot.priorSourceCode === 'invitation') &&
          slot.priorRequestKey !== null),
    );
    if (allocationSlots.length === 0) {
      return { handled: false, activityTitle: activity.title, promoted: [] };
    }

    const promoted: Array<{ registrationId: string; memberId: string }> = [];
    const touchedRegistrations = new Set<string>();
    let populationChanged = false;
    for (const slot of allocationSlots.sort(
      (left, right) =>
        compareUtf8(left.sessionId, right.sessionId) ||
        compareUtf8(left.participationIdentityId, right.participationIdentityId),
    )) {
      const candidate =
        slot.allocationBatchId === null
          ? modeCode === 'first_come'
            ? await this.lockFirstComeWaitlistHead(tx, input.activityId, slot)
            : null
          : isAllocationMode(modeCode)
            ? await this.lockBatchWaitlistHead(tx, input.activityId, slot, modeCode)
            : null;
      if (candidate === null) continue;
      const reservation = await this.capacityReservations.reserveInTransactionTrusted(tx, {
        activityId: input.activityId,
        memberId: candidate.memberId,
        selections: [
          { identityId: candidate.participationIdentityId, positionId: candidate.positionId },
        ],
      });
      if (reservation.outcome !== 'reserved') continue;
      const anchors = await this.readReservationAnchors(
        tx,
        candidate.participationIdentityId,
        candidate.positionId,
        reservation,
      );
      const nextRevision = candidate.identityRevision + 1;
      await tx.activityParticipationRevision.create({
        data: {
          identityId: candidate.participationIdentityId,
          revision: nextRevision,
          statusCode: 'pass',
          positionId: candidate.positionId,
          preferenceSnapshot: candidate.preferenceSnapshot ?? Prisma.JsonNull,
          waitlistRank: null,
          allocationBatchId: candidate.allocationBatchId,
          effectiveAt: input.promotedAt,
          createdByUserId: input.actorUser.id,
          sourceCode: 'admin',
        },
        select: { id: true },
      });
      const updated = await tx.activityParticipationIdentity.updateMany({
        where: {
          id: candidate.participationIdentityId,
          currentRevision: candidate.identityRevision,
          version: candidate.identityVersion,
        },
        data: {
          currentRevision: nextRevision,
          currentStatusCode: 'pass',
          currentPositionId: candidate.positionId,
          capacityReservationId: anchors.sessionReservationId,
          populationIncluded: true,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1)
        throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
      populationChanged = true;
      touchedRegistrations.add(candidate.registrationId);
      promoted.push({ registrationId: candidate.registrationId, memberId: candidate.memberId });
      const promotionKey = `${candidate.allocationBatchId ?? 'first-come'}:${nextRevision}`;
      await this.notifications.enqueueAllocationPromotion(tx, {
        promotionKey,
        participationIdentityId: candidate.participationIdentityId,
        registrationId: candidate.registrationId,
        memberId: candidate.memberId,
        activityTitle: activity.title,
      });
      await this.registrationAudit.logAllocationPromotion({
        registrationId: candidate.registrationId,
        activityId: input.activityId,
        allocationBatchId: candidate.allocationBatchId,
        modeCode: candidate.allocationBatchId === null ? 'first_come' : modeCode,
        actorUserId: input.actorUser.id,
        actorRoleSnap: input.actorUser.role,
        auditMeta: input.auditMeta,
        tx,
      });
    }
    if (populationChanged) {
      await this.lifecycle.incrementPopulationRevisionInTransactionTrusted(
        tx,
        input.activityId,
        input.promotedAt,
      );
    }
    await this.reconcileRegistrationHeaders(tx, touchedRegistrations);
    return { handled: true, activityTitle: activity.title, promoted };
  }

  async commit(
    activityId: string,
    batchId: string,
    dto: CommitAppManagedActivityAllocationBatchDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppActivityAllocationCommandReceiptDto> {
    await this.assertAction(currentUser, 'activity-registration.approve.record', activityId);
    const requestHash = hashAllocationCommand({
      commandCode: 'commit',
      activityId,
      allocationBatchId: batchId,
      operationKey: dto.operationKey,
    });
    try {
      return await this.prisma.$transaction(async (tx) => {
        const activity = await this.lockActivity(tx, activityId);
        await this.assertManagedResponsibility(tx, activityId, currentUser);
        const replay = await this.findReplay(
          tx,
          activityId,
          'commit',
          dto.operationKey,
          requestHash,
        );
        if (replay) return replay;
        if (!isAllocationMode(activity.allocationModeCode)) {
          throw new BizException(BizCode.ACTIVITY_ALLOCATION_MODE_INCONSISTENT);
        }
        await this.assertAllHistoricalBatchModes(tx, activityId, activity.allocationModeCode);
        const batch = await this.lockBatch(tx, activityId, batchId);
        if (
          batch.statusCode !== 'preparing' ||
          batch.modeCode !== activity.allocationModeCode ||
          batch.algorithmVersionCode !== ALLOCATION_ALGORITHM_VERSION
        ) {
          throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
        }
        await this.assertTargetShape(tx, activityId, batch.sessionId, batch.positionId);
        const candidates = await this.lockPersistedCandidates(tx, batch.id);
        this.assertPreparingCandidates(batch, candidates);
        const candidateIds = candidates.map((candidate) => candidate.participationIdentityId);
        const sources = await this.lockCandidateSources(
          tx,
          activityId,
          batch.sessionId,
          candidateIds,
        );
        if (sources.length !== candidates.length) {
          throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
        }
        const sourceByIdentity = new Map(sources.map((source) => [source.id, source]));
        const checked: CheckedCandidate[] = [];
        for (const candidate of candidates) {
          const source = sourceByIdentity.get(candidate.participationIdentityId);
          if (!source) throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
          this.assertPendingSource(source);
          if (
            source.registrationId !== candidate.registrationId ||
            source.registrationRevisionId !== candidate.registrationRevisionId ||
            source.acceptedAt.getTime() !== candidate.acceptedAt.getTime() ||
            source.id !== candidate.tieBreakKey
          ) {
            throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
          }
          const qualification = await this.freezeQualification({
            tx,
            activity,
            memberId: source.memberId,
            sessionId: batch.sessionId,
            positionId: batch.positionId,
            modeCode: activity.allocationModeCode,
          });
          if (
            qualification.qualificationSnapshotHash !== candidate.qualificationSnapshotHash ||
            qualification.qualificationScore !== decimalString(candidate.qualificationScore) ||
            qualification.aggregateResultCode !==
              candidateQualificationResult(candidate.explanation)
          ) {
            throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
          }
          checked.push({ ...candidate, ...source, frozen: qualification });
        }

        const lotteryOrderByCandidateId = new Map<string, number>();
        const eligible = checked.filter(
          (candidate) => candidate.frozen.aggregateResultCode !== 'fail',
        );
        const notSelected = checked.filter(
          (candidate) => candidate.frozen.aggregateResultCode === 'fail',
        );
        let allocationOrder: CheckedCandidate[];
        let lotterySeed: string | null = null;
        if (batch.modeCode === 'qualification_rank') {
          if (batch.randomCommitment !== null || batch.randomSeedReveal !== null) {
            throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
          }
          allocationOrder = [...eligible].sort((left, right) => {
            const score =
              Number(right.frozen.qualificationScore) - Number(left.frozen.qualificationScore);
            if (score !== 0) return score;
            const accepted = left.acceptedAt.getTime() - right.acceptedAt.getTime();
            if (accepted !== 0) return accepted;
            return compareUtf8(left.participationIdentityId, right.participationIdentityId);
          });
        } else if (batch.modeCode === 'lottery') {
          lotterySeed = this.deriveLotterySeed({
            activityId,
            allocationBatchId: batch.id,
            algorithmVersionCode: batch.algorithmVersionCode,
          });
          if (
            batch.randomCommitment === null ||
            batch.randomSeedReveal !== null ||
            createLotteryCommitment(lotterySeed) !== batch.randomCommitment
          ) {
            throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
          }
          allocationOrder = [...eligible].sort((left, right) => {
            const leftDraw = sha256Canonical({
              seed: lotterySeed!,
              identityId: left.participationIdentityId,
            });
            const rightDraw = sha256Canonical({
              seed: lotterySeed!,
              identityId: right.participationIdentityId,
            });
            const draw = compareUtf8(leftDraw, rightDraw);
            return draw !== 0
              ? draw
              : compareUtf8(left.participationIdentityId, right.participationIdentityId);
          });
          allocationOrder.forEach((candidate, index) => {
            lotteryOrderByCandidateId.set(candidate.allocationCandidateId, index + 1);
          });
        } else {
          throw new BizException(BizCode.ACTIVITY_ALLOCATION_MODE_INCONSISTENT);
        }

        const now = new Date();
        const nextWaitlistRankByPosition = new Map<string, number>();
        let populationChanged = false;
        const touchedRegistrationIds = new Set<string>();
        for (const candidate of allocationOrder) {
          const selection = await this.reserveInitialPreference(tx, {
            activityId,
            memberId: candidate.memberId,
            participationIdentityId: candidate.participationIdentityId,
            preferenceSnapshot: candidate.preferenceSnapshot,
            batchPositionId: batch.positionId,
          });
          const resultCode: AllocationResultCode = selection.reservation
            ? 'allocated'
            : 'waitlisted';
          let waitlistRank: number | null = null;
          if (resultCode === 'waitlisted') {
            const waitlistPositionId = selection.waitlistPositionId;
            if (waitlistPositionId === null) {
              throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
            }
            waitlistRank = nextWaitlistRankByPosition.get(waitlistPositionId) ?? 1;
            nextWaitlistRankByPosition.set(waitlistPositionId, waitlistRank + 1);
          }
          await this.persistCommittedCandidate(tx, {
            activity,
            batch,
            candidate,
            resultCode,
            waitlistRank,
            lotteryOrder: lotteryOrderByCandidateId.get(candidate.allocationCandidateId) ?? null,
            reservation: selection.reservation,
            positionId: selection.positionId,
            waitlistPositionId: selection.waitlistPositionId,
            now,
            currentUser,
            requestHash,
            operationKey: dto.operationKey,
          });
          populationChanged ||= resultCode === 'allocated';
          touchedRegistrationIds.add(candidate.registrationId);
        }
        for (const candidate of notSelected) {
          await this.persistCommittedCandidate(tx, {
            activity,
            batch,
            candidate,
            resultCode: 'not_selected',
            waitlistRank: null,
            lotteryOrder: lotteryOrderByCandidateId.get(candidate.allocationCandidateId) ?? null,
            reservation: null,
            positionId: null,
            waitlistPositionId: null,
            now,
            currentUser,
            requestHash,
            operationKey: dto.operationKey,
          });
          touchedRegistrationIds.add(candidate.registrationId);
        }
        if (populationChanged) {
          await this.lifecycle.incrementPopulationRevisionInTransactionTrusted(tx, activityId, now);
        }
        await this.reconcileRegistrationHeaders(tx, touchedRegistrationIds);
        const committed = await tx.activityAllocationBatch.updateMany({
          where: { id: batch.id, statusCode: 'preparing' },
          data: {
            statusCode: 'committed',
            committedAt: now,
            ...(lotterySeed === null ? {} : { randomSeedReveal: lotterySeed }),
          },
        });
        if (committed.count !== 1)
          throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
        const receipt = await this.writeReceipt(tx, {
          activityId,
          allocationBatchId: batch.id,
          commandCode: 'commit',
          operationKey: dto.operationKey,
          requestHash,
          actorUserId: currentUser.id,
          batchStatusCode: 'committed',
        });
        await this.registrationAudit.logAllocationCommand({
          activityId,
          allocationBatchId: batch.id,
          commandCode: 'commit',
          actorUserId: currentUser.id,
          actorRoleSnap: currentUser.role,
          auditMeta,
          tx,
        });
        return receipt;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.resolveReplayRace(activityId, 'commit', dto.operationKey, requestHash);
      }
      throw error;
    }
  }

  async void(
    activityId: string,
    batchId: string,
    dto: VoidAppManagedActivityAllocationBatchDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppActivityAllocationCommandReceiptDto> {
    await this.assertAction(currentUser, 'activity-registration.cancel.record', activityId);
    const reason = dto.reason.trim();
    if (!reason) throw new BizException(BizCode.BAD_REQUEST);
    const requestHash = hashAllocationCommand({
      commandCode: 'void',
      activityId,
      allocationBatchId: batchId,
      operationKey: dto.operationKey,
      reason,
    });
    try {
      return await this.prisma.$transaction(async (tx) => {
        const activity = await this.lockActivity(tx, activityId);
        await this.assertManagedResponsibility(tx, activityId, currentUser);
        const replay = await this.findReplay(tx, activityId, 'void', dto.operationKey, requestHash);
        if (replay) return replay;
        if (!isAllocationMode(activity.allocationModeCode)) {
          throw new BizException(BizCode.ACTIVITY_ALLOCATION_MODE_INCONSISTENT);
        }
        await this.assertAllHistoricalBatchModes(tx, activityId, activity.allocationModeCode);
        const batch = await this.lockBatch(tx, activityId, batchId);
        if (
          batch.modeCode !== activity.allocationModeCode ||
          batch.statusCode === 'voided' ||
          (batch.statusCode !== 'preparing' && batch.statusCode !== 'committed')
        ) {
          throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
        }
        const candidates = await this.lockPersistedCandidates(tx, batch.id);
        const now = new Date();
        let populationChanged = false;
        const registrationIds = new Set<string>();
        if (batch.statusCode === 'committed') {
          const projections = await this.lockApplicationProjections(tx, batch.id);
          const sources = await this.lockCandidateSources(
            tx,
            activityId,
            batch.sessionId,
            candidates.map((candidate) => candidate.participationIdentityId),
          );
          this.assertVoidLiveFacts({ batch, candidates, projections, sources });
          await this.assertProjectedReservationsExact(tx, activityId, projections);
          const allocatedByMember = new Map<string, string[]>();
          for (const projection of projections) {
            registrationIds.add(
              candidates.find(
                (candidate) => candidate.allocationCandidateId === projection.allocationCandidateId,
              )!.registrationId,
            );
            if (projection.appliedResultCode === 'allocated') {
              const identities = allocatedByMember.get(projection.memberId) ?? [];
              identities.push(projection.participationIdentityId);
              allocatedByMember.set(projection.memberId, identities);
              populationChanged = true;
            }
          }
          for (const [memberId, identityIds] of [...allocatedByMember.entries()].sort(
            (left, right) => compareUtf8(left[0], right[0]),
          )) {
            await this.capacityReservations.releaseInTransactionTrusted(tx, {
              activityId,
              memberId,
              identityIds: identityIds.sort(compareUtf8),
              releaseReason: 'allocation_batch_voided',
            });
          }
          const sourceByIdentity = new Map(sources.map((source) => [source.id, source]));
          for (const candidate of candidates) {
            const source = sourceByIdentity.get(candidate.participationIdentityId);
            if (!source) throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
            await tx.activityParticipationRevision.create({
              data: {
                identityId: source.id,
                revision: source.identityRevision + 1,
                statusCode: 'pending',
                preferenceSnapshot: source.preferenceSnapshot ?? Prisma.JsonNull,
                effectiveAt: now,
                createdByUserId: currentUser.id,
                sourceCode: 'admin',
                requestKey: dto.operationKey,
                requestHash,
              },
            });
            const cleared = await tx.activityParticipationIdentity.updateMany({
              where: {
                id: source.id,
                currentRevision: source.identityRevision,
                version: source.identityVersion,
              },
              data: {
                currentRevision: source.identityRevision + 1,
                currentStatusCode: 'pending',
                currentPositionId: null,
                capacityReservationId: null,
                populationIncluded: false,
                version: { increment: 1 },
              },
            });
            if (cleared.count !== 1)
              throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
          }
        } else {
          this.assertPreparingCandidates(batch, candidates);
          candidates.forEach((candidate) => registrationIds.add(candidate.registrationId));
        }
        if (populationChanged) {
          await this.lifecycle.incrementPopulationRevisionInTransactionTrusted(tx, activityId, now);
        }
        await this.reconcileRegistrationHeaders(tx, registrationIds);
        const voided = await tx.activityAllocationBatch.updateMany({
          where: { id: batch.id, statusCode: batch.statusCode },
          data: { statusCode: 'voided', voidReason: reason, voidedAt: now },
        });
        if (voided.count !== 1)
          throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
        const receipt = await this.writeReceipt(tx, {
          activityId,
          allocationBatchId: batch.id,
          commandCode: 'void',
          operationKey: dto.operationKey,
          requestHash,
          actorUserId: currentUser.id,
          batchStatusCode: 'voided',
        });
        await this.registrationAudit.logAllocationCommand({
          activityId,
          allocationBatchId: batch.id,
          commandCode: 'void',
          actorUserId: currentUser.id,
          actorRoleSnap: currentUser.role,
          auditMeta,
          tx,
        });
        return receipt;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.resolveReplayRace(activityId, 'void', dto.operationKey, requestHash);
      }
      throw error;
    }
  }

  private async lockActivity(tx: PrismaTx, activityId: string): Promise<LockedActivity> {
    const rows = await tx.$queryRaw<LockedActivity[]>(Prisma.sql`
      SELECT "id", "title", "statusCode", "registrationDeadline", "allocationModeCode", "startAt", "endAt"
      FROM "Activity"
      WHERE "id" = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    const activity = rows[0];
    if (rows.length !== 1 || !activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return activity;
  }

  private async lockBatch(tx: PrismaTx, activityId: string, batchId: string): Promise<LockedBatch> {
    const rows = await tx.$queryRaw<LockedBatch[]>(Prisma.sql`
      SELECT
        "id", "activityId", "sessionId", "positionId", "modeCode", "candidateSnapshotHash",
        "algorithmVersionCode", "randomCommitment", "randomSeedReveal", "statusCode",
        "operationKey", "requestHash", "committedAt", "voidReason", "voidedAt"
      FROM "ActivityAllocationBatch"
      WHERE "id" = ${batchId} AND "activityId" = ${activityId}
      FOR UPDATE
    `);
    const batch = rows[0];
    if (rows.length !== 1 || !batch) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    return batch;
  }

  private async lockPersistedCandidates(
    tx: PrismaTx,
    allocationBatchId: string,
  ): Promise<PersistedCandidate[]> {
    return tx.$queryRaw<PersistedCandidate[]>(Prisma.sql`
      SELECT
        "id" AS "allocationCandidateId", "activityId", "sessionId", "waitlistPositionId",
        "participationIdentityId", "registrationId", "registrationRevisionId", "acceptedAt",
        "qualificationSnapshotHash", "qualificationScore", "tieBreakKey", "lotteryOrder",
        "resultCode", "waitlistRank", "explanation"
      FROM "ActivityAllocationCandidate"
      WHERE "allocationBatchId" = ${allocationBatchId}
      ORDER BY "participationIdentityId" ASC
      FOR UPDATE
    `);
  }

  private async lockCancelledAllocationSlots(
    tx: PrismaTx,
    activityId: string,
    registrationId: string,
  ): Promise<FreedAllocationSlot[]> {
    const rows = await tx.$queryRaw<FreedAllocationSlot[]>(Prisma.sql`
      SELECT
        i."id" AS "participationIdentityId", i."sessionId",
        prior."positionId", prior."allocationBatchId", prior."sourceCode" AS "priorSourceCode",
        prior."requestKey" AS "priorRequestKey", i."currentStatusCode",
        current_revision."statusCode" AS "currentRevisionStatusCode", i."currentPositionId",
        i."capacityReservationId", i."populationIncluded"
      FROM "ActivityParticipationIdentity" i
      INNER JOIN "ActivityParticipationRevision" current_revision
        ON current_revision."identityId" = i."id"
          AND current_revision."revision" = i."currentRevision"
      INNER JOIN "ActivityParticipationRevision" prior
        ON prior."identityId" = i."id"
          AND prior."revision" = i."currentRevision" - 1
      WHERE i."activityId" = ${activityId}
        AND i."registrationId" = ${registrationId}
        AND i."currentStatusCode" = 'cancelled'
        AND current_revision."statusCode" = 'cancelled'
        AND prior."statusCode" = 'pass'
      ORDER BY i."id" ASC
      FOR UPDATE OF i, current_revision, prior
    `);
    if (
      rows.some(
        (row) =>
          row.currentStatusCode !== 'cancelled' ||
          row.currentRevisionStatusCode !== 'cancelled' ||
          row.currentPositionId !== null ||
          row.capacityReservationId !== null ||
          row.populationIncluded,
      )
    ) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    return rows;
  }

  private async lockBatchWaitlistHead(
    tx: PrismaTx,
    activityId: string,
    slot: FreedAllocationSlot,
    expectedModeCode: AllocationModeCode,
  ): Promise<PromotionWaitlistCandidate | null> {
    if (slot.allocationBatchId === null) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    const rows = await tx.$queryRaw<LockedBatchPromotionCandidate[]>(Prisma.sql`
      SELECT
        c."participationIdentityId", c."registrationId", i."memberId", i."sessionId",
        c."activityId" AS "candidateActivityId", c."sessionId" AS "candidateSessionId",
        c."waitlistPositionId", pr."positionId", c."allocationBatchId", c."waitlistRank", c."acceptedAt",
        pr."preferenceSnapshot", i."currentRevision" AS "identityRevision",
        i."version" AS "identityVersion", i."currentStatusCode", i."currentPositionId",
        i."capacityReservationId", i."populationIncluded", b."modeCode" AS "batchModeCode",
        b."statusCode" AS "batchStatusCode", b."positionId" AS "batchPositionId",
        projection."id" AS "applicationProjectionId",
        projection."appliedResultCode", projection."appliedStatusCode",
        projection."positionId" AS "appliedPositionId",
        projection."populationIncluded" AS "appliedPopulationIncluded",
        projection."expectedIdentityCapacityReservationId" AS "appliedExpectedReservationId",
        projection."activityPersonReservationId" AS "appliedActivityReservationId",
        projection."sessionReservationId" AS "appliedSessionReservationId",
        projection."positionReservationId" AS "appliedPositionReservationId"
      FROM "ActivityAllocationCandidate" c
      INNER JOIN "ActivityAllocationBatch" b ON b."id" = c."allocationBatchId"
      INNER JOIN "ActivityParticipationIdentity" i ON i."id" = c."participationIdentityId"
      INNER JOIN "ActivityParticipationRevision" pr
        ON pr."identityId" = i."id" AND pr."revision" = i."currentRevision"
      LEFT JOIN "ActivityAllocationApplicationProjection" projection
        ON projection."allocationCandidateId" = c."id"
      WHERE c."allocationBatchId" = ${slot.allocationBatchId}
        AND c."resultCode" = 'waitlisted'
        AND c."waitlistRank" IS NOT NULL
        AND c."activityId" = ${activityId}
        AND c."sessionId" = ${slot.sessionId}
        AND c."waitlistPositionId" IS NOT DISTINCT FROM ${slot.positionId}
        AND b."activityId" = ${activityId}
        AND b."sessionId" = ${slot.sessionId}
        AND b."statusCode" = 'committed'
        AND i."activityId" = ${activityId}
        AND i."sessionId" = ${slot.sessionId}
        AND i."currentStatusCode" = 'waitlisted'
        AND pr."statusCode" = 'waitlisted'
        AND pr."allocationBatchId" = c."allocationBatchId"
        AND pr."positionId" IS NOT DISTINCT FROM ${slot.positionId}
      ORDER BY c."id" ASC
      FOR UPDATE OF c, b, i, pr
    `);
    if (rows.length === 0) return null;
    if (
      rows.some(
        (row) =>
          row.batchModeCode !== expectedModeCode ||
          row.batchStatusCode !== 'committed' ||
          row.candidateActivityId !== activityId ||
          row.candidateSessionId !== slot.sessionId ||
          row.waitlistPositionId !== slot.positionId ||
          (row.batchPositionId !== null && row.batchPositionId !== slot.positionId) ||
          row.waitlistRank === null ||
          row.waitlistRank < 1 ||
          row.positionId !== slot.positionId ||
          row.currentStatusCode !== 'waitlisted' ||
          row.currentPositionId !== null ||
          row.capacityReservationId !== null ||
          row.populationIncluded ||
          row.applicationProjectionId === null ||
          row.appliedResultCode !== 'waitlisted' ||
          row.appliedStatusCode !== 'waitlisted' ||
          row.appliedPositionId !== null ||
          row.appliedPopulationIncluded !== false ||
          row.appliedExpectedReservationId !== null ||
          row.appliedActivityReservationId !== null ||
          row.appliedSessionReservationId !== null ||
          row.appliedPositionReservationId !== null,
      )
    ) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    const queue = [...rows].sort(
      (left, right) =>
        left.waitlistRank - right.waitlistRank ||
        compareUtf8(left.participationIdentityId, right.participationIdentityId),
    );
    if (
      new Set(queue.map((row) => row.waitlistRank)).size !== queue.length ||
      new Set(queue.map((row) => row.participationIdentityId)).size !== queue.length
    ) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    return queue[0] ?? null;
  }

  private async lockFirstComeWaitlistHead(
    tx: PrismaTx,
    activityId: string,
    slot: FreedAllocationSlot,
  ): Promise<PromotionWaitlistCandidate | null> {
    const rows = await tx.$queryRaw<PromotionWaitlistCandidate[]>(Prisma.sql`
      SELECT
        i."id" AS "participationIdentityId", i."registrationId", i."memberId", i."sessionId",
        pr."positionId", pr."allocationBatchId", pr."waitlistRank",
        pr."effectiveAt" AS "acceptedAt", pr."preferenceSnapshot",
        i."currentRevision" AS "identityRevision", i."version" AS "identityVersion",
        i."currentStatusCode", i."currentPositionId", i."capacityReservationId", i."populationIncluded"
      FROM "ActivityParticipationIdentity" i
      INNER JOIN "ActivityParticipationRevision" pr
        ON pr."identityId" = i."id" AND pr."revision" = i."currentRevision"
      WHERE i."activityId" = ${activityId}
        AND i."sessionId" = ${slot.sessionId}
        AND i."currentStatusCode" = 'waitlisted'
        AND pr."statusCode" = 'waitlisted'
        AND pr."allocationBatchId" IS NULL
        AND pr."sourceCode" IN ('self', 'invitation')
        AND pr."requestKey" IS NOT NULL
        AND pr."positionId" IS NOT DISTINCT FROM ${slot.positionId}
      ORDER BY i."id" ASC
      FOR UPDATE OF i, pr
    `);
    if (rows.length === 0) return null;
    if (
      rows.some(
        (row) =>
          row.allocationBatchId !== null ||
          row.waitlistRank === null ||
          row.waitlistRank < 1 ||
          row.positionId !== slot.positionId ||
          row.currentStatusCode !== 'waitlisted' ||
          row.currentPositionId !== null ||
          row.capacityReservationId !== null ||
          row.populationIncluded,
      )
    ) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    const queue = [...rows].sort(
      (left, right) =>
        left.acceptedAt.getTime() - right.acceptedAt.getTime() ||
        compareUtf8(left.participationIdentityId, right.participationIdentityId),
    );
    if (new Set(queue.map((row) => row.participationIdentityId)).size !== queue.length) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    return queue[0] ?? null;
  }

  private async lockApplicationProjections(
    tx: PrismaTx,
    allocationBatchId: string,
  ): Promise<LockedApplicationProjection[]> {
    return tx.$queryRaw<LockedApplicationProjection[]>(Prisma.sql`
      SELECT
        "id", "allocationCandidateId", "participationIdentityId", "memberId",
        "appliedParticipationRevisionId", "appliedResultCode", "appliedStatusCode", "positionId",
        "populationIncluded", "expectedIdentityCapacityReservationId",
        "activityPersonReservationId", "activityPersonBucketId", "sessionReservationId",
        "sessionBucketId", "positionReservationId", "positionBucketId"
      FROM "ActivityAllocationApplicationProjection"
      WHERE "allocationBatchId" = ${allocationBatchId}
      ORDER BY "allocationCandidateId" ASC
      FOR UPDATE
    `);
  }

  private assertVoidLiveFacts(input: {
    batch: LockedBatch;
    candidates: readonly PersistedCandidate[];
    projections: readonly LockedApplicationProjection[];
    sources: readonly CandidateSource[];
  }): void {
    if (
      input.candidates.length !== input.projections.length ||
      input.candidates.length !== input.sources.length
    ) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    const candidateById = new Map(
      input.candidates.map((candidate) => [candidate.allocationCandidateId, candidate]),
    );
    const sourceById = new Map(input.sources.map((source) => [source.id, source]));
    const seenIdentities = new Set<string>();
    for (const projection of input.projections) {
      const candidate = candidateById.get(projection.allocationCandidateId);
      const source = sourceById.get(projection.participationIdentityId);
      const candidateWaitlisted = candidate?.resultCode === 'waitlisted';
      const candidateClosedShape = candidateWaitlisted
        ? candidate.waitlistRank !== null &&
          candidate.waitlistRank >= 1 &&
          candidate.waitlistPositionId !== null
        : candidate?.resultCode === 'allocated' || candidate?.resultCode === 'not_selected'
          ? candidate.waitlistRank === null && candidate.waitlistPositionId === null
          : false;
      const expectedRevisionPosition = candidateWaitlisted
        ? (candidate?.waitlistPositionId ?? null)
        : projection.positionId;
      const expectedRevisionWaitlistRank = candidateWaitlisted
        ? (candidate?.waitlistRank ?? null)
        : null;
      if (
        !candidate ||
        !source ||
        !candidateClosedShape ||
        seenIdentities.has(projection.participationIdentityId) ||
        candidate.activityId !== input.batch.activityId ||
        candidate.sessionId !== input.batch.sessionId ||
        candidate.participationIdentityId !== projection.participationIdentityId ||
        candidate.resultCode !== projection.appliedResultCode ||
        source.id !== projection.participationIdentityId ||
        source.activityId !== input.batch.activityId ||
        source.sessionId !== input.batch.sessionId ||
        source.memberId !== projection.memberId ||
        source.participationRevisionId !== projection.appliedParticipationRevisionId ||
        source.participationRevisionStatusCode !== projection.appliedStatusCode ||
        source.participationRevisionPositionId !== expectedRevisionPosition ||
        source.participationRevisionWaitlistRank !== expectedRevisionWaitlistRank ||
        source.participationRevisionAllocationBatchId !== input.batch.id ||
        source.identityStatusCode !== projection.appliedStatusCode ||
        source.currentPositionId !== projection.positionId ||
        source.capacityReservationId !== projection.expectedIdentityCapacityReservationId ||
        source.populationIncluded !== projection.populationIncluded
      ) {
        throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
      }
      seenIdentities.add(projection.participationIdentityId);
      if (projection.appliedResultCode === 'allocated') {
        if (
          projection.appliedStatusCode !== 'pass' ||
          !projection.populationIncluded ||
          (input.batch.positionId !== null && projection.positionId !== input.batch.positionId) ||
          projection.expectedIdentityCapacityReservationId === null ||
          projection.activityPersonReservationId === null ||
          projection.activityPersonBucketId === null ||
          projection.sessionReservationId === null ||
          projection.sessionBucketId === null ||
          projection.expectedIdentityCapacityReservationId !== projection.sessionReservationId ||
          (projection.positionId === null
            ? projection.positionReservationId !== null || projection.positionBucketId !== null
            : projection.positionReservationId === null || projection.positionBucketId === null)
        ) {
          throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
        }
        continue;
      }
      if (
        projection.positionId !== null ||
        projection.populationIncluded ||
        projection.expectedIdentityCapacityReservationId !== null ||
        projection.activityPersonReservationId !== null ||
        projection.activityPersonBucketId !== null ||
        projection.sessionReservationId !== null ||
        projection.sessionBucketId !== null ||
        projection.positionReservationId !== null ||
        projection.positionBucketId !== null
      ) {
        throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
      }
    }
  }

  private async assertProjectedReservationsExact(
    tx: PrismaTx,
    activityId: string,
    projections: readonly LockedApplicationProjection[],
  ): Promise<void> {
    const allocated = projections.filter(
      (projection) => projection.appliedResultCode === 'allocated',
    );
    const reservationIds = [
      ...new Set(
        allocated.flatMap((projection) => [
          projection.activityPersonReservationId!,
          projection.sessionReservationId!,
          ...(projection.positionReservationId ? [projection.positionReservationId] : []),
        ]),
      ),
    ].sort(compareUtf8);
    if (reservationIds.length === 0) return;
    const rows = await tx.$queryRaw<ProjectedReservationRow[]>(Prisma.sql`
      SELECT
        r."id", r."identityId", r."reservationType", r."memberId", r."activityId",
        r."bucketId", r."status", b."occupied" AS "bucketOccupied",
        (SELECT COUNT(*)::int FROM "CapacityReservation" active_for_bucket
         WHERE active_for_bucket."bucketId" = b."id" AND active_for_bucket."status" = 'active')
          AS "bucketActiveCount"
      FROM "CapacityReservation" r
      INNER JOIN "ActivityCapacityBucket" b ON b."id" = r."bucketId"
      WHERE r."id" IN (${Prisma.join(reservationIds)}) AND b."activityId" = ${activityId}
      ORDER BY r."id" ASC
      FOR UPDATE OF r, b
    `);
    if (rows.length !== reservationIds.length) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const projection of allocated) {
      const activityPerson = byId.get(projection.activityPersonReservationId!);
      const session = byId.get(projection.sessionReservationId!);
      const position = projection.positionReservationId
        ? byId.get(projection.positionReservationId)
        : null;
      const positionInvalid =
        projection.positionReservationId === null
          ? position !== null
          : !position ||
            position.status !== 'active' ||
            position.reservationType !== 'position_participation' ||
            position.identityId !== projection.participationIdentityId ||
            position.bucketId !== projection.positionBucketId;
      if (
        !activityPerson ||
        !session ||
        activityPerson.status !== 'active' ||
        session.status !== 'active' ||
        activityPerson.reservationType !== 'activity_person' ||
        session.reservationType !== 'session_participation' ||
        activityPerson.memberId !== projection.memberId ||
        activityPerson.activityId !== activityId ||
        activityPerson.bucketId !== projection.activityPersonBucketId ||
        session.identityId !== projection.participationIdentityId ||
        session.bucketId !== projection.sessionBucketId ||
        positionInvalid ||
        [activityPerson, session, ...(position ? [position] : [])].some(
          (row) => row.bucketOccupied !== row.bucketActiveCount,
        )
      ) {
        throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
      }
    }
  }

  private assertPreparingCandidates(
    batch: LockedBatch,
    candidates: readonly PersistedCandidate[],
  ): void {
    if (
      candidates.some(
        (candidate) =>
          candidate.activityId !== batch.activityId ||
          candidate.sessionId !== batch.sessionId ||
          candidate.waitlistPositionId !== null ||
          candidate.resultCode !== null ||
          candidate.waitlistRank !== null ||
          candidate.lotteryOrder !== null ||
          candidate.tieBreakKey !== candidate.participationIdentityId,
      )
    ) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    const snapshotHash = createCandidateSnapshotHash({
      activityId: batch.activityId,
      sessionId: batch.sessionId,
      positionId: batch.positionId,
      modeCode: batch.modeCode as AllocationModeCode,
      algorithmVersionCode: batch.algorithmVersionCode,
      candidates: candidates.map((candidate) => ({
        participationIdentityId: candidate.participationIdentityId,
        registrationId: candidate.registrationId,
        registrationRevisionId: candidate.registrationRevisionId,
        acceptedAt: candidate.acceptedAt,
        qualificationSnapshotHash: candidate.qualificationSnapshotHash,
        qualificationScore: decimalString(candidate.qualificationScore),
        tieBreakKey: candidate.tieBreakKey,
      })),
    });
    if (snapshotHash !== batch.candidateSnapshotHash) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
  }

  /**
   * A session-level batch consumes only the applicant's immutable submitted preference order.
   * It may fall through during this initial allocation; after a waitlist result no later caller
   * may substitute a different position without a new user command.
   */
  private async reserveInitialPreference(
    tx: PrismaTx,
    input: {
      activityId: string;
      memberId: string;
      participationIdentityId: string;
      preferenceSnapshot: Prisma.JsonValue | null;
      batchPositionId: string | null;
    },
  ): Promise<{
    reservation: Extract<CapacityReservationReserveResult, { outcome: 'reserved' }> | null;
    positionId: string | null;
    waitlistPositionId: string | null;
  }> {
    const positions = this.initialPreferencePositions(
      input.preferenceSnapshot,
      input.batchPositionId,
    );
    for (const positionId of positions) {
      const reservation = await this.capacityReservations.reserveInTransactionTrusted(tx, {
        activityId: input.activityId,
        memberId: input.memberId,
        selections: [{ identityId: input.participationIdentityId, positionId }],
      });
      if (reservation.outcome === 'reserved') {
        return { reservation, positionId, waitlistPositionId: null };
      }
    }
    return { reservation: null, positionId: null, waitlistPositionId: positions[0] ?? null };
  }

  private async firstComeWaitlistRank(
    tx: PrismaTx,
    input: {
      activityId: string;
      sessionId: string;
      positionId: string | null;
      participationIdentityId: string;
      acceptedAt: Date;
    },
  ): Promise<number> {
    const rows = await tx.$queryRaw<FirstComeWaitlistRow[]>(Prisma.sql`
      SELECT
        i."id" AS "participationIdentityId",
        pr."effectiveAt" AS "acceptedAt",
        pr."waitlistRank",
        i."currentPositionId", i."capacityReservationId", i."populationIncluded"
      FROM "ActivityParticipationIdentity" i
      INNER JOIN "ActivityParticipationRevision" pr
        ON pr."identityId" = i."id" AND pr."revision" = i."currentRevision"
      WHERE i."activityId" = ${input.activityId}
        AND i."sessionId" = ${input.sessionId}
        AND i."currentStatusCode" = 'waitlisted'
        AND pr."statusCode" = 'waitlisted'
        AND pr."allocationBatchId" IS NULL
        AND pr."positionId" IS NOT DISTINCT FROM ${input.positionId}
      FOR UPDATE OF i, pr
    `);
    if (
      rows.some(
        (row) =>
          row.waitlistRank === null ||
          row.waitlistRank < 1 ||
          row.currentPositionId !== null ||
          row.capacityReservationId !== null ||
          row.populationIncluded,
      )
    ) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    const ranks = rows.map((row) => row.waitlistRank!);
    if (
      new Set(ranks).size !== ranks.length ||
      new Set(rows.map((row) => row.participationIdentityId)).size !== rows.length
    ) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    // Revisions are append-only: a departure must not rewrite the ranks stored on earlier queue
    // facts. Actual promotion always re-sorts by acceptedAt + UTF-8 identity below; this ordinal
    // is only a durable entry sequence and therefore deliberately permits gaps after departures.
    return Math.max(0, ...ranks) + 1;
  }

  private initialPreferencePositions(
    preferenceSnapshot: Prisma.JsonValue | null,
    batchPositionId: string | null,
  ): Array<string | null> {
    if (batchPositionId !== null) return [batchPositionId];
    const snapshot = preferenceSnapshot === null ? null : asObject(preferenceSnapshot);
    const positions = snapshot?.positionIds;
    if (!Array.isArray(positions)) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    if (positions.length === 0) return [null];
    if (
      positions.some((position) => typeof position !== 'string' || position.length === 0) ||
      new Set(positions).size !== positions.length
    ) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    return positions as string[];
  }

  private async persistCommittedCandidate(
    tx: PrismaTx,
    input: {
      activity: LockedActivity;
      batch: LockedBatch;
      candidate: CheckedCandidate;
      resultCode: AllocationResultCode;
      waitlistRank: number | null;
      lotteryOrder: number | null;
      reservation: CapacityReservationReserveResult | null;
      positionId: string | null;
      waitlistPositionId: string | null;
      now: Date;
      currentUser: CurrentUserPayload;
      requestHash: string;
      operationKey: string;
    },
  ): Promise<void> {
    const allocated = input.resultCode === 'allocated';
    if (allocated !== (input.reservation?.outcome === 'reserved')) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    if (!allocated && input.reservation !== null) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    if (input.resultCode !== 'waitlisted' && input.waitlistPositionId !== null) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    if (
      (input.resultCode === 'waitlisted' &&
        (input.waitlistRank === null ||
          input.waitlistRank < 1 ||
          input.waitlistPositionId === null)) ||
      (input.resultCode !== 'waitlisted' && input.waitlistRank !== null)
    ) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    const anchors = allocated
      ? await this.readReservationAnchors(
          tx,
          input.candidate.participationIdentityId,
          input.positionId,
          input.reservation as Extract<CapacityReservationReserveResult, { outcome: 'reserved' }>,
        )
      : null;
    await tx.activityAllocationCandidate.update({
      where: { id: input.candidate.allocationCandidateId },
      data: {
        resultCode: input.resultCode,
        waitlistRank: input.waitlistRank,
        waitlistPositionId: input.waitlistPositionId,
        lotteryOrder: input.lotteryOrder,
      },
    });
    const participationRevision = await tx.activityParticipationRevision.create({
      data: {
        identityId: input.candidate.participationIdentityId,
        revision: input.candidate.identityRevision + 1,
        statusCode:
          input.resultCode === 'allocated'
            ? 'pass'
            : input.resultCode === 'waitlisted'
              ? 'waitlisted'
              : 'not_selected',
        positionId: allocated
          ? input.positionId
          : input.resultCode === 'waitlisted'
            ? input.waitlistPositionId
            : null,
        preferenceSnapshot: input.candidate.preferenceSnapshot ?? Prisma.JsonNull,
        waitlistRank: input.waitlistRank,
        allocationBatchId: input.batch.id,
        effectiveAt: input.now,
        createdByUserId: input.currentUser.id,
        sourceCode: 'admin',
        requestKey: input.operationKey,
        requestHash: input.requestHash,
      },
      select: { id: true },
    });
    const pointer = await tx.activityParticipationIdentity.updateMany({
      where: {
        id: input.candidate.participationIdentityId,
        currentRevision: input.candidate.identityRevision,
        version: input.candidate.identityVersion,
      },
      data: {
        currentRevision: input.candidate.identityRevision + 1,
        currentStatusCode:
          input.resultCode === 'allocated'
            ? 'pass'
            : input.resultCode === 'waitlisted'
              ? 'waitlisted'
              : 'not_selected',
        currentPositionId: allocated ? input.positionId : null,
        capacityReservationId: anchors?.sessionReservationId ?? null,
        populationIncluded: allocated,
        version: { increment: 1 },
      },
    });
    if (pointer.count !== 1)
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    await tx.activityAllocationApplicationProjection.create({
      data: {
        appliedAt: input.now,
        activityId: input.activity.id,
        sessionId: input.batch.sessionId,
        allocationBatchId: input.batch.id,
        allocationCandidateId: input.candidate.allocationCandidateId,
        participationIdentityId: input.candidate.participationIdentityId,
        memberId: input.candidate.memberId,
        appliedParticipationRevisionId: participationRevision.id,
        appliedResultCode: input.resultCode,
        appliedStatusCode:
          input.resultCode === 'allocated'
            ? 'pass'
            : input.resultCode === 'waitlisted'
              ? 'waitlisted'
              : 'not_selected',
        positionId: allocated ? input.positionId : null,
        populationIncluded: allocated,
        expectedIdentityCapacityReservationId: anchors?.sessionReservationId ?? null,
        activityPersonReservationId: anchors?.activityPersonReservationId ?? null,
        activityPersonBucketId: anchors?.activityPersonBucketId ?? null,
        sessionReservationId: anchors?.sessionReservationId ?? null,
        sessionBucketId: anchors?.sessionBucketId ?? null,
        positionReservationId: anchors?.positionReservationId ?? null,
        positionBucketId: anchors?.positionBucketId ?? null,
      },
    });
    await this.notifications.enqueueAllocationOutcome(tx, {
      allocationKey: input.batch.id,
      participationIdentityId: input.candidate.participationIdentityId,
      registrationId: input.candidate.registrationId,
      memberId: input.candidate.memberId,
      activityTitle: input.activity.title,
      resultCode: input.resultCode,
    });
  }

  private async readReservationAnchors(
    tx: PrismaTx,
    identityId: string,
    positionId: string | null,
    reservation: Extract<CapacityReservationReserveResult, { outcome: 'reserved' }>,
  ): Promise<ReservationAnchors> {
    const identityReservation = reservation.identities.find(
      (candidate) => candidate.identityId === identityId,
    );
    if (!identityReservation)
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    if (
      (positionId === null && identityReservation.positionReservationId !== null) ||
      (positionId !== null && identityReservation.positionReservationId === null)
    ) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    const reservationIds = [
      reservation.activityPersonReservationId,
      identityReservation.sessionReservationId,
      ...(identityReservation.positionReservationId
        ? [identityReservation.positionReservationId]
        : []),
    ];
    const rows = await tx.capacityReservation.findMany({
      where: { id: { in: reservationIds }, status: 'active' },
      select: { id: true, bucketId: true, reservationType: true, identityId: true },
    });
    if (rows.length !== reservationIds.length) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    const activityPerson = byId.get(reservation.activityPersonReservationId);
    const session = byId.get(identityReservation.sessionReservationId);
    const position = identityReservation.positionReservationId
      ? byId.get(identityReservation.positionReservationId)
      : null;
    if (
      !activityPerson ||
      !session ||
      activityPerson.reservationType !== 'activity_person' ||
      session.reservationType !== 'session_participation' ||
      session.identityId !== identityId ||
      (positionId === null
        ? position !== null
        : !position ||
          position.reservationType !== 'position_participation' ||
          position.identityId !== identityId)
    ) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    return {
      activityPersonReservationId: activityPerson.id,
      activityPersonBucketId: activityPerson.bucketId,
      sessionReservationId: session.id,
      sessionBucketId: session.bucketId,
      positionReservationId: position?.id ?? null,
      positionBucketId: position?.bucketId ?? null,
    };
  }

  private async reconcileRegistrationHeaders(
    tx: PrismaTx,
    registrationIds: ReadonlySet<string>,
  ): Promise<void> {
    for (const registrationId of [...registrationIds].sort(compareUtf8)) {
      const identities = await tx.activityParticipationIdentity.findMany({
        where: { registrationId },
        select: { currentStatusCode: true },
      });
      if (identities.length === 0)
        throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
      const statuses = identities.map((identity) => identity.currentStatusCode);
      const statusCode = statuses.some(
        (status) => status === 'pass' || status === 'attended' || status === 'settled',
      )
        ? 'pass'
        : statuses.some((status) => status === 'pending')
          ? 'pending'
          : statuses.some((status) => status === 'waitlisted')
            ? 'waitlisted'
            : 'reject';
      const updated = await tx.activityRegistration.updateMany({
        where: { id: registrationId, deletedAt: null },
        data: {
          statusCode,
          statusSummaryCode: statusCode === 'reject' ? 'not_selected' : 'active',
        },
      });
      if (updated.count !== 1)
        throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
  }

  private async assertAction(
    currentUser: CurrentUserPayload,
    action: string,
    activityId: string,
  ): Promise<void> {
    const decision = await this.authz.explain(currentUser, action, {
      type: 'activity',
      id: activityId,
    });
    if (decision.allow) return;
    if (decision.reason === 'resource_not_found' && (await this.rbac.can(currentUser, action))) {
      return;
    }
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  private async assertManagedResponsibility(
    tx: PrismaTx,
    activityId: string,
    currentUser: CurrentUserPayload,
  ): Promise<void> {
    if (currentUser.memberId === null) throw new BizException(BizCode.RBAC_FORBIDDEN);
    const assignment = await tx.activityResponsibilityAssignment.findFirst({
      where: {
        activityId,
        memberId: currentUser.memberId,
        status: 'active',
        canManageRegistrations: true,
      },
      select: { id: true },
    });
    if (assignment === null) throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  private async assertAllHistoricalBatchModes(
    tx: PrismaTx,
    activityId: string,
    modeCode: string,
  ): Promise<void> {
    const mismatch = await tx.activityAllocationBatch.findFirst({
      where: { activityId, modeCode: { not: modeCode } },
      select: { id: true },
    });
    if (mismatch !== null) throw new BizException(BizCode.ACTIVITY_ALLOCATION_MODE_INCONSISTENT);
  }

  private async assertNoUnvoidedTargetBatch(
    tx: PrismaTx,
    activityId: string,
    sessionId: string,
    positionId: string | null,
  ): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "ActivityAllocationBatch"
      WHERE "activityId" = ${activityId}
        AND "sessionId" = ${sessionId}
        AND "positionId" IS NOT DISTINCT FROM ${positionId}
        AND "statusCode" IN ('preparing', 'committed')
      FOR UPDATE
    `);
    if (rows.length !== 0) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
  }

  private async assertTargetShape(
    tx: PrismaTx,
    activityId: string,
    sessionId: string,
    positionId: string | null,
  ): Promise<void> {
    const sessions = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "ActivitySession"
      WHERE "id" = ${sessionId} AND "activityId" = ${activityId}
        AND "deletedAt" IS NULL AND "statusCode" = 'scheduled'
      FOR UPDATE
    `);
    if (sessions.length !== 1)
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    if (positionId !== null) {
      const positions = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "ActivitySessionPosition"
        WHERE "id" = ${positionId} AND "activityId" = ${activityId}
          AND "sessionId" = ${sessionId} AND "deletedAt" IS NULL
        FOR UPDATE
      `);
      if (positions.length !== 1)
        throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
      return;
    }
  }

  private async lockCandidateSources(
    tx: PrismaTx,
    activityId: string,
    sessionId: string,
    identityIds?: readonly string[],
  ): Promise<CandidateSource[]> {
    const identityPredicate =
      identityIds === undefined
        ? Prisma.empty
        : Prisma.sql`AND i."id" IN (${Prisma.join(identityIds)})`;
    return tx.$queryRaw<CandidateSource[]>(Prisma.sql`
      SELECT
        i."id", i."activityId", i."memberId", i."sessionId", i."registrationId",
        i."currentRevision" AS "identityRevision", i."currentStatusCode" AS "identityStatusCode",
        i."currentPositionId", i."capacityReservationId", i."populationIncluded",
        i."version" AS "identityVersion",
        r."currentRevision" AS "registrationCurrentRevision",
        rr."id" AS "registrationRevisionId", rr."submittedAt" AS "acceptedAt",
        pr."id" AS "participationRevisionId", pr."statusCode" AS "participationRevisionStatusCode",
        pr."positionId" AS "participationRevisionPositionId",
        pr."waitlistRank" AS "participationRevisionWaitlistRank",
        pr."allocationBatchId" AS "participationRevisionAllocationBatchId", pr."preferenceSnapshot"
      FROM "ActivityParticipationIdentity" i
      INNER JOIN "ActivityRegistration" r ON r."id" = i."registrationId" AND r."deletedAt" IS NULL
      INNER JOIN "ActivityRegistrationRevision" rr
        ON rr."registrationId" = r."id" AND rr."revision" = r."currentRevision"
      INNER JOIN "ActivityParticipationRevision" pr
        ON pr."identityId" = i."id" AND pr."revision" = i."currentRevision"
      WHERE i."activityId" = ${activityId} AND i."sessionId" = ${sessionId}
      ${identityPredicate}
      ORDER BY i."id" ASC
      FOR UPDATE OF i, r, rr, pr
    `);
  }

  private assertPendingSource(source: CandidateSource): void {
    if (
      source.identityRevision < 1 ||
      source.registrationCurrentRevision < 1 ||
      source.identityStatusCode !== 'pending' ||
      source.participationRevisionStatusCode !== 'pending' ||
      source.participationRevisionPositionId !== null ||
      source.participationRevisionWaitlistRank !== null ||
      source.participationRevisionAllocationBatchId !== null ||
      source.currentPositionId !== null ||
      source.capacityReservationId !== null ||
      source.populationIncluded
    ) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
  }

  private async freezeQualification(input: {
    tx: PrismaTx;
    activity: LockedActivity;
    memberId: string;
    sessionId: string;
    positionId: string | null;
    modeCode: QualificationModeCode;
  }): Promise<FrozenQualification> {
    const evaluation = await this.qualificationEvaluator.evaluate({
      activity: input.activity,
      memberId: input.memberId,
      targets: [{ sessionId: input.sessionId, positionId: input.positionId }],
      tx: input.tx,
    });
    const projection = this.targetProjection(evaluation, input.sessionId, input.positionId);
    const ruleSets = await this.freezeRuleSets(input.tx, evaluation);
    const seenRuleIds = new Set<string>();
    const warnings: number[] = [];
    for (const ruleSet of ruleSets) {
      for (const rule of ruleSet.rules) {
        if (seenRuleIds.has(rule.ruleId)) {
          throw new BizException(BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID);
        }
        seenRuleIds.add(rule.ruleId);
        if (rule.resultCode === 'warn') {
          if (
            rule.warnScore === null ||
            !Number.isInteger(rule.warnScore) ||
            rule.warnScore < 0 ||
            rule.warnScore > 100
          ) {
            throw new BizException(BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID);
          }
          warnings.push(rule.warnScore);
        }
      }
    }
    let penalty: number | null = null;
    let qualificationScore: string | null = null;
    if (input.modeCode === 'qualification_rank' && projection.resultCode !== 'fail') {
      penalty = warnings.reduce((sum, warning) => sum + warning, 0);
      qualificationScore = Math.max(0, 100 - penalty).toFixed(4);
    }
    const target = {
      activityId: input.activity.id,
      sessionId: input.sessionId,
      positionId: input.positionId,
    };
    const qualificationSnapshotHash = createQualificationSnapshotHash({
      algorithmVersionCode: ALLOCATION_ALGORITHM_VERSION,
      target,
      aggregateResultCode: projection.resultCode,
      penalty,
      qualificationScore,
      ruleSets,
    });
    return {
      aggregateResultCode: projection.resultCode,
      penalty,
      qualificationScore,
      qualificationSnapshotHash,
      explanation: {
        version: 'allocation_candidate_explanation/v1',
        target,
        aggregateResultCode: projection.resultCode,
        penalty,
        qualificationScore,
        ruleSets,
      },
    };
  }

  private targetProjection(
    evaluation: ActivityQualificationEvaluation,
    sessionId: string,
    positionId: string | null,
  ): QualificationProjection {
    const projection =
      positionId === null
        ? evaluation.sessions.get(sessionId)
        : evaluation.positions.get(positionId);
    if (!projection) throw new BizException(BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID);
    return projection;
  }

  private async freezeRuleSets(
    tx: PrismaTx,
    evaluation: ActivityQualificationEvaluation,
  ): Promise<AllocationQualificationRuleSetOutcome[]> {
    const ids = evaluation.snapshotCandidates.flatMap((ruleSet) =>
      ruleSet.rules.map((rule) => rule.id),
    );
    const rows =
      ids.length === 0
        ? []
        : await tx.activityQualificationRule.findMany({
            where: { id: { in: ids } },
            select: { id: true, warnScore: true },
          });
    if (rows.length !== ids.length) {
      throw new BizException(BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID);
    }
    const scoreById = new Map(rows.map((row) => [row.id, row.warnScore]));
    return [...evaluation.snapshotCandidates]
      .sort((left, right) => compareUtf8(left.ruleSetVersionId, right.ruleSetVersionId))
      .map((ruleSet) => ({
        ruleSetVersionId: ruleSet.ruleSetVersionId,
        scope: { sessionId: ruleSet.scope.sessionId, positionId: ruleSet.scope.positionId },
        inputFactsHash: ruleSet.inputFactsHash,
        resultCode: ruleSet.resultCode,
        rules: [...ruleSet.rules]
          .sort((left, right) => compareUtf8(left.id, right.id))
          .map((rule) => ({
            ruleId: rule.id,
            resultCode: rule.resultCode,
            warnScore: scoreById.get(rule.id) ?? null,
          })),
      }));
  }

  private deriveLotterySeed(input: {
    activityId: string;
    allocationBatchId: string;
    algorithmVersionCode: string;
  }): string {
    const jwt = this.config.get<JwtConfig>('jwt');
    if (!jwt?.secret) throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    return deriveLotterySeed(jwt.secret, input);
  }

  private async findReplay(
    tx: PrismaTx,
    activityId: string,
    commandCode: AllocationCommandCode,
    operationKey: string,
    requestHash: string,
  ): Promise<AppActivityAllocationCommandReceiptDto | null> {
    const receipt = await tx.activityAllocationCommandReceipt.findFirst({
      where: { activityId, commandCode, operationKey },
      select: {
        requestHash: true,
        responseSchemaVersion: true,
        responseHash: true,
        responseReceipt: true,
        allocationBatchId: true,
      },
    });
    if (receipt === null) return null;
    if (receipt.requestHash !== requestHash) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_OPERATION_KEY_CONFLICT);
    }
    const receiptBatchStatusCode = this.readReceiptBatchStatusCode({
      activityId,
      allocationBatchId: receipt.allocationBatchId,
      commandCode,
      responseHash: receipt.responseHash,
      responseSchemaVersion: receipt.responseSchemaVersion,
      responseReceipt: receipt.responseReceipt,
    });
    return {
      commandCode,
      responseHash: receipt.responseHash,
      batch: await this.loadBatchDto(
        tx,
        activityId,
        receipt.allocationBatchId,
        receiptBatchStatusCode,
      ),
    };
  }

  /**
   * D86 deliberately stores only a fixed safe receipt envelope.  The batch and candidate facts
   * are immutable enough to reconstruct that command's original safe view, but later commands
   * must not turn a prepare replay into a live committed/voided response.
   */
  private readReceiptBatchStatusCode(input: {
    activityId: string;
    allocationBatchId: string;
    commandCode: AllocationCommandCode;
    responseSchemaVersion: string;
    responseHash: string;
    responseReceipt: Prisma.JsonValue;
  }): ReceiptBatchStatusCode {
    const receipt = asObject(input.responseReceipt);
    const expectedStatusCode: ReceiptBatchStatusCode =
      input.commandCode === 'prepare'
        ? 'preparing'
        : input.commandCode === 'commit'
          ? 'committed'
          : 'voided';
    const expectedResponseHash = createAllocationResponseHash({
      activityId: input.activityId,
      allocationBatchId: input.allocationBatchId,
      commandCode: input.commandCode,
      batchStatusCode: expectedStatusCode,
    });
    if (
      receipt === null ||
      input.responseSchemaVersion !== RESPONSE_SCHEMA_VERSION ||
      input.responseHash !== expectedResponseHash ||
      Object.keys(receipt).length !== 6 ||
      receipt.activityId !== input.activityId ||
      receipt.allocationBatchId !== input.allocationBatchId ||
      receipt.commandCode !== input.commandCode ||
      receipt.batchStatusCode !== expectedStatusCode ||
      receipt.responseSchemaVersion !== RESPONSE_SCHEMA_VERSION ||
      receipt.responseHash !== input.responseHash
    ) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    return expectedStatusCode;
  }

  private async resolveReplayRace(
    activityId: string,
    commandCode: AllocationCommandCode,
    operationKey: string,
    requestHash: string,
  ): Promise<AppActivityAllocationCommandReceiptDto> {
    return this.prisma.$transaction(async (tx) => {
      const replay = await this.findReplay(tx, activityId, commandCode, operationKey, requestHash);
      if (replay) return replay;
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_OPERATION_KEY_CONFLICT);
    });
  }

  private async writeReceipt(
    tx: PrismaTx,
    input: {
      activityId: string;
      allocationBatchId: string;
      commandCode: AllocationCommandCode;
      operationKey: string;
      requestHash: string;
      actorUserId: string;
      batchStatusCode: 'preparing' | 'committed' | 'voided';
    },
  ): Promise<AppActivityAllocationCommandReceiptDto> {
    const responseHash = createAllocationResponseHash(input);
    await tx.activityAllocationCommandReceipt.create({
      data: {
        activityId: input.activityId,
        allocationBatchId: input.allocationBatchId,
        commandCode: input.commandCode,
        operationKey: input.operationKey,
        requestHash: input.requestHash,
        responseSchemaVersion: RESPONSE_SCHEMA_VERSION,
        responseHash,
        responseReceipt: {
          activityId: input.activityId,
          allocationBatchId: input.allocationBatchId,
          commandCode: input.commandCode,
          batchStatusCode: input.batchStatusCode,
          responseSchemaVersion: RESPONSE_SCHEMA_VERSION,
          responseHash,
        },
        actorUserId: input.actorUserId,
      },
    });
    return {
      commandCode: input.commandCode,
      responseHash,
      batch: await this.loadBatchDto(tx, input.activityId, input.allocationBatchId),
    };
  }

  private async loadBatchDto(
    tx: PrismaTx,
    activityId: string,
    batchId: string,
    receiptBatchStatusCode?: ReceiptBatchStatusCode,
  ): Promise<AppActivityAllocationBatchDto> {
    const batch = await tx.activityAllocationBatch.findFirst({
      where: { id: batchId, activityId },
      select: {
        id: true,
        activityId: true,
        sessionId: true,
        positionId: true,
        modeCode: true,
        statusCode: true,
        algorithmVersionCode: true,
        randomSeedReveal: true,
        committedAt: true,
        voidReason: true,
        voidedAt: true,
        candidates: {
          select: {
            participationIdentityId: true,
            registrationId: true,
            acceptedAt: true,
            qualificationScore: true,
            explanation: true,
            lotteryOrder: true,
            resultCode: true,
            waitlistRank: true,
            waitlistPositionId: true,
          },
          orderBy: { participationIdentityId: 'asc' },
        },
      },
    });
    if (batch === null) throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    const isPrepareReceipt = receiptBatchStatusCode === 'preparing';
    const statusCode = receiptBatchStatusCode ?? batch.statusCode;
    return {
      batchId: batch.id,
      activityId: batch.activityId,
      sessionId: batch.sessionId,
      positionId: batch.positionId,
      modeCode: batch.modeCode,
      statusCode,
      algorithmVersionCode: batch.algorithmVersionCode,
      randomSeedReveal: statusCode === 'committed' ? batch.randomSeedReveal : null,
      committedAt: isPrepareReceipt ? null : batch.committedAt,
      voidReason: statusCode === 'voided' ? batch.voidReason : null,
      voidedAt: statusCode === 'voided' ? batch.voidedAt : null,
      candidates: [...batch.candidates]
        .sort((left, right) =>
          compareUtf8(left.participationIdentityId, right.participationIdentityId),
        )
        .map((candidate) => ({
          participationIdentityId: candidate.participationIdentityId,
          registrationId: candidate.registrationId,
          acceptedAt: candidate.acceptedAt,
          qualificationScore: decimalString(candidate.qualificationScore),
          qualificationResultCode: candidateQualificationResult(candidate.explanation),
          lotteryOrder: isPrepareReceipt ? null : candidate.lotteryOrder,
          resultCode: isPrepareReceipt ? null : candidate.resultCode,
          waitlistRank: isPrepareReceipt ? null : candidate.waitlistRank,
          waitlistPositionId: isPrepareReceipt ? null : candidate.waitlistPositionId,
        })),
    };
  }
}
