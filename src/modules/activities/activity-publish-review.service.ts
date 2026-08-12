import { createHash, randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { MemberStatus, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  ApproveActivityPublishReviewDto,
  ActivityPublishReviewResponseDto,
  ChangeReviewDto,
  ReturnActivityPublishReviewDto,
  SubmitActivityPublishReviewDto,
} from './activity-publish-review.dto';
import { ActivityPublishReviewAuditRecorder } from './activity-publish-review-audit-recorder';
import {
  ActivityPublishReviewPresenter,
  type ActivityPublishReviewViewRow,
  activityPublishReviewViewSelect,
} from './activity-publish-review-presenter';
import { ActivityPublishReviewStateMachine } from './activity-publish-review-state-machine';
import { ActivityResponsibilityService } from './activity-responsibility.service';
import { ActivityResponsibilityPolicy } from './activity-responsibility-policy';
import type { UpdateActivityDto } from './activities.dto';
import type { AppActivityChangePositionDto } from './dto/app/app-managed-activity.dto';
import { ActivityProposalValidator } from './activity-proposal-validator';
import { ActivityProposalApplier } from './activity-proposal-applier';
import { ActivityNotificationProducer } from './activity-notification-producer';
import { ActivityAllocationModeService } from './activity-allocation-mode.service';
import {
  ActivityPublishProposalV2Service,
  type ActivityTemplateResolution,
  type ActivityTemplateResolutionWithRegistrationForm,
} from './activity-publish-proposal-v2.service';
import {
  parseActivityProposalSnapshot,
  type ActivityProposalSnapshot,
} from './activity-proposal.types';

type PrismaTx = Prisma.TransactionClient;

const activityPublishReviewIdempotencySelect = {
  ...activityPublishReviewViewSelect,
  requestHash: true,
  reviewRequestHash: true,
} as const satisfies Prisma.ActivityPublishReviewSelect;

interface PublishedActivityEffect {
  activityId: string;
  activityTitle: string;
  startAt: Date;
  location: string;
  publishedAt: Date;
  requiresInsurance: boolean;
  isPublicRegistration: boolean;
  initiatorMemberId: string | null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

@Injectable()
export class ActivityPublishReviewService {
  private readonly logger = new Logger(ActivityPublishReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly stateMachine: ActivityPublishReviewStateMachine,
    private readonly presenter: ActivityPublishReviewPresenter,
    private readonly audit: ActivityPublishReviewAuditRecorder,
    private readonly notificationProducer: ActivityNotificationProducer,
    private readonly responsibilities: ActivityResponsibilityService,
    private readonly responsibilityPolicy: ActivityResponsibilityPolicy,
    private readonly proposalValidator: ActivityProposalValidator,
    private readonly proposalApplier: ActivityProposalApplier,
    private readonly proposalV2: ActivityPublishProposalV2Service,
    private readonly allocationModes: ActivityAllocationModeService,
  ) {}

  private async lockActivity(activityId: string, tx: PrismaTx): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Activity"
      WHERE id = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `;
    if (rows.length === 0) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
  }

  private async lockReview(reviewId: string, tx: PrismaTx): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM activity_publish_reviews WHERE id = ${reviewId} FOR UPDATE
    `;
    if (rows.length === 0) {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_NOT_FOUND);
    }
  }

  private async snapshot(activityId: string, tx: PrismaTx): Promise<Prisma.InputJsonValue> {
    const row = await tx.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: {
        title: true,
        activityTypeCode: true,
        organizationId: true,
        startAt: true,
        endAt: true,
        location: true,
        description: true,
        capacity: true,
        genderRequirementCode: true,
        registrationDeadline: true,
        registrationNotes: true,
        isPublicRegistration: true,
        requiresInsurance: true,
        registrationSchema: true,
        coverImageUrl: true,
        galleryImageUrls: true,
        content: true,
        locationLongitude: true,
        locationLatitude: true,
        activityPositions: {
          where: { deletedAt: null },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            name: true,
            attendanceRoleCode: true,
            capacity: true,
            startAt: true,
            endAt: true,
            genderRequirementCode: true,
            description: true,
            sortOrder: true,
          },
        },
      },
    });
    this.ensureProposalInvariants(row);
    const { activityPositions, ...activity } = row;
    return JSON.parse(
      JSON.stringify({
        schemaVersion: 1,
        activity,
        positions: activityPositions.map(({ id, ...position }) => ({
          activityPositionId: id,
          clientRef: null,
          ...position,
        })),
      }),
    ) as Prisma.InputJsonValue;
  }

  private async nextRequestVersion(activityId: string, tx: PrismaTx): Promise<number> {
    const latest = await tx.activityPublishReview.aggregate({
      where: { activityId },
      _max: { requestVersion: true },
    });
    return (latest._max.requestVersion ?? 0) + 1;
  }

  private ensureInitialPublishable(activity: {
    statusCode: string;
    startAt: Date;
    endAt: Date;
    registrationDeadline: Date | null;
  }): void {
    if (activity.statusCode !== 'draft') {
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    }
    if (activity.startAt.getTime() >= activity.endAt.getTime()) {
      throw new BizException(BizCode.ACTIVITY_START_END_INVALID);
    }
    if (
      activity.registrationDeadline &&
      activity.registrationDeadline.getTime() > activity.endAt.getTime()
    ) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_DEADLINE_INVALID);
    }
    const now = Date.now();
    if (activity.endAt.getTime() <= now) {
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    }
    if (activity.registrationDeadline && activity.registrationDeadline.getTime() < now) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_DEADLINE_PASSED);
    }
  }

  private ensureProposalInvariants(activity: {
    startAt: Date;
    endAt: Date;
    capacity: number | null;
    registrationDeadline: Date | null;
    activityPositions: Array<{
      startAt: Date | null;
      endAt: Date | null;
      capacity: number | null;
    }>;
  }): void {
    if (activity.startAt.getTime() >= activity.endAt.getTime()) {
      throw new BizException(BizCode.ACTIVITY_START_END_INVALID);
    }
    if (
      activity.registrationDeadline &&
      activity.registrationDeadline.getTime() > activity.endAt.getTime()
    ) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_DEADLINE_INVALID);
    }
    for (const position of activity.activityPositions) {
      if ((position.startAt === null) !== (position.endAt === null)) {
        throw new BizException(BizCode.ACTIVITY_POSITION_TIME_RANGE_INVALID);
      }
      if (
        position.startAt &&
        position.endAt &&
        (position.startAt.getTime() >= position.endAt.getTime() ||
          position.startAt.getTime() < activity.startAt.getTime() ||
          position.endAt.getTime() > activity.endAt.getTime())
      ) {
        throw new BizException(BizCode.ACTIVITY_POSITION_TIME_RANGE_INVALID);
      }
    }
    if (activity.capacity !== null && activity.activityPositions.length > 0) {
      if (activity.activityPositions.some((position) => position.capacity === null)) {
        throw new BizException(BizCode.ACTIVITY_POSITION_CAPACITY_INVALID);
      }
      const total = activity.activityPositions.reduce(
        (sum, position) => sum + (position.capacity ?? 0),
        0,
      );
      if (total > activity.capacity) {
        throw new BizException(BizCode.ACTIVITY_POSITION_CAPACITY_INVALID);
      }
    }
  }

  async submitInitial(
    activityId: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityPublishReviewResponseDto> {
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        await this.lockActivity(activityId, tx);
        const activity = await tx.activity.findUniqueOrThrow({
          where: { id: activityId },
          select: {
            statusCode: true,
            workflowRevision: true,
            allocationModeCode: true,
            initiatorMemberId: true,
            startAt: true,
            endAt: true,
            registrationDeadline: true,
          },
        });
        if (!user.memberId || activity.initiatorMemberId !== user.memberId) {
          throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
        }
        await this.allocationModes.assertLockedActivityConsistent(tx, {
          id: activityId,
          allocationModeCode: activity.allocationModeCode,
        });
        this.ensureInitialPublishable(activity);
        const decision = this.stateMachine.decide('submit');
        if (!decision.allowed) throw new BizException(decision.biz);
        const review = await tx.activityPublishReview.create({
          data: {
            activityId,
            requestType: 'initial',
            requestVersion: await this.nextRequestVersion(activityId, tx),
            baseRevision: activity.workflowRevision,
            status: decision.nextStatus,
            snapshot: await this.snapshot(activityId, tx),
            submittedByUserId: user.id,
          },
          select: activityPublishReviewViewSelect,
        });
        await this.audit.log({
          activityId,
          reviewId: review.id,
          operation: 'publish-review-submit',
          requestVersion: review.requestVersion,
          requestType: review.requestType,
          directPublish: false,
          actorUserId: user.id,
          actorRoleSnap: user.role,
          auditMeta,
          tx,
        });
        return review;
      });
      return this.presenter.toDto(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING);
      }
      throw error;
    }
  }

  async submitChange(
    activityId: string,
    activityPatch: UpdateActivityDto,
    positions: AppActivityChangePositionDto[] | undefined,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityPublishReviewResponseDto> {
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        await this.lockActivity(activityId, tx);
        const activity = await tx.activity.findUniqueOrThrow({
          where: { id: activityId },
          select: { statusCode: true, workflowRevision: true, allocationModeCode: true },
        });
        if (activity.statusCode !== 'published') {
          throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
        }
        await this.allocationModes.assertLockedActivityConsistent(tx, {
          id: activityId,
          allocationModeCode: activity.allocationModeCode,
        });
        await this.responsibilityPolicy.assertOwner(tx, activityId, user);
        const pendingCount = await tx.activityPublishReview.count({
          where: { activityId, status: 'pending' },
        });
        if (pendingCount > 0) {
          throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING);
        }
        const decision = this.stateMachine.decide('submit');
        if (!decision.allowed) throw new BizException(decision.biz);
        const snapshot = await this.proposalValidator.buildChangeSnapshot(
          tx,
          activityId,
          activityPatch,
          positions,
        );
        await this.allocationModes.assertLockedActivityConsistent(tx, {
          id: activityId,
          allocationModeCode: snapshot.activity.allocationModeCode ?? activity.allocationModeCode,
        });
        const review = await tx.activityPublishReview.create({
          data: {
            activityId,
            requestType: 'change',
            requestVersion: await this.nextRequestVersion(activityId, tx),
            baseRevision: activity.workflowRevision,
            status: decision.nextStatus,
            snapshot: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue,
            submittedByUserId: user.id,
          },
          select: activityPublishReviewViewSelect,
        });
        await this.audit.log({
          activityId,
          reviewId: review.id,
          operation: 'publish-review-submit',
          requestVersion: review.requestVersion,
          requestType: review.requestType,
          directPublish: false,
          actorUserId: user.id,
          actorRoleSnap: user.role,
          auditMeta,
          tx,
        });
        return review;
      });
      return this.presenter.toDto(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING);
      }
      throw error;
    }
  }

  /** V2 App endpoint: the initial proposal is a server-side snapshot under the Activity row lock. */
  async submitInitialProposal(
    activityId: string,
    dto: SubmitActivityPublishReviewDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityPublishReviewResponseDto> {
    const requestHash = this.submitRequestHash('initial', activityId, dto);
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        await this.lockActivity(activityId, tx);
        const activity = await tx.activity.findUniqueOrThrow({
          where: { id: activityId },
          select: {
            statusCode: true,
            workflowRevision: true,
            allocationModeCode: true,
            initiatorMemberId: true,
            startAt: true,
            endAt: true,
            registrationDeadline: true,
          },
        });
        if (!user.memberId || activity.initiatorMemberId !== user.memberId) {
          throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
        }
        await this.allocationModes.assertLockedActivityConsistent(tx, {
          id: activityId,
          allocationModeCode: activity.allocationModeCode,
        });
        const replay = await this.findSubmitReplay(tx, dto.operationKey, requestHash);
        if (replay) return replay;
        this.ensureInitialPublishable(activity);
        const pending = await tx.activityPublishReview.count({
          where: { activityId, status: 'pending' },
        });
        if (pending > 0) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING);
        const decision = this.stateMachine.decide('submit');
        if (!decision.allowed) throw new BizException(decision.biz);
        const snapshot = await this.proposalV2.buildInitial(tx, activityId);
        const review = await tx.activityPublishReview.create({
          data: {
            activityId,
            requestType: 'initial',
            requestVersion: await this.nextRequestVersion(activityId, tx),
            baseRevision: activity.workflowRevision,
            status: decision.nextStatus,
            snapshot: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue,
            submittedByUserId: user.id,
            operationKey: dto.operationKey,
            requestHash,
          },
          select: activityPublishReviewViewSelect,
        });
        await this.audit.log({
          activityId,
          reviewId: review.id,
          operation: 'publish-review-submit',
          requestVersion: review.requestVersion,
          requestType: review.requestType,
          directPublish: false,
          actorUserId: user.id,
          actorRoleSnap: user.role,
          auditMeta,
          tx,
        });
        return review;
      });
      return this.presenter.toDto(row);
    } catch (error) {
      return this.rethrowSubmitOperationKeyConflict(error, dto.operationKey, requestHash);
    }
  }

  /** V2 App endpoint: a single collection command covers session/position create, update and cancel. */
  async submitChangeProposal(
    activityId: string,
    dto: ChangeReviewDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityPublishReviewResponseDto> {
    const requestHash = this.submitRequestHash('change', activityId, dto);
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        await this.lockActivity(activityId, tx);
        const activity = await tx.activity.findUniqueOrThrow({
          where: { id: activityId },
          select: {
            statusCode: true,
            workflowRevision: true,
            organizationId: true,
            allocationModeCode: true,
          },
        });
        // Ownership precedes lifecycle disclosure on the App surface: callers outside the
        // responsibility graph must not distinguish a draft from a published activity.
        await this.assertOwnerHidden(tx, activityId, user);
        await this.allocationModes.assertLockedActivityConsistent(tx, {
          id: activityId,
          allocationModeCode: activity.allocationModeCode,
        });
        if (activity.statusCode !== 'published') {
          throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
        }
        const replay = await this.findSubmitReplay(tx, dto.operationKey, requestHash);
        if (replay) return replay;
        const pending = await tx.activityPublishReview.count({
          where: { activityId, status: 'pending' },
        });
        if (pending > 0) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING);
        const decision = this.stateMachine.decide('submit');
        if (!decision.allowed) throw new BizException(decision.biz);
        const snapshot = await this.proposalV2.buildChange(tx, activityId, dto);
        await this.allocationModes.assertLockedActivityConsistent(tx, {
          id: activityId,
          allocationModeCode: snapshot.activity.allocationModeCode,
        });
        this.proposalValidator.assertOrganizationUnchanged(
          activity.organizationId,
          snapshot.activity.organizationId,
        );
        const review = await tx.activityPublishReview.create({
          data: {
            activityId,
            requestType: 'change',
            requestVersion: await this.nextRequestVersion(activityId, tx),
            baseRevision: activity.workflowRevision,
            status: decision.nextStatus,
            snapshot: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue,
            submittedByUserId: user.id,
            operationKey: dto.operationKey,
            requestHash,
          },
          select: activityPublishReviewViewSelect,
        });
        await this.audit.log({
          activityId,
          reviewId: review.id,
          operation: 'publish-review-submit',
          requestVersion: review.requestVersion,
          requestType: review.requestType,
          directPublish: false,
          actorUserId: user.id,
          actorRoleSnap: user.role,
          auditMeta,
          tx,
        });
        return review;
      });
      return this.presenter.toDto(row);
    } catch (error) {
      return this.rethrowSubmitOperationKeyConflict(error, dto.operationKey, requestHash);
    }
  }

  async templateResolution(
    activityId: string,
    user: CurrentUserPayload,
  ): Promise<ActivityTemplateResolution> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockActivity(activityId, tx);
      const activity = await tx.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: { initiatorMemberId: true },
      });
      if (!user.memberId || activity.initiatorMemberId !== user.memberId) {
        const owner = await tx.activityResponsibilityAssignment.findFirst({
          where: {
            activityId,
            memberId: user.memberId ?? '__missing__',
            responsibilityType: 'owner',
            status: 'active',
          },
          select: { id: true },
        });
        if (!owner) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
      }
      return this.proposalV2.getTemplateResolution(tx, activityId);
    });
  }

  async compatibilityPublish(
    activityId: string,
    dto: { requiresInsuranceConfirmed: boolean },
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityPublishReviewResponseDto> {
    if (dto.requiresInsuranceConfirmed !== true) throw new BizException(BizCode.BAD_REQUEST);
    const pending = await this.prisma.activityPublishReview.findFirst({
      where: { activityId, requestType: 'initial', status: 'pending' },
      select: activityPublishReviewViewSelect,
    });
    if (pending) {
      // Compatibility routes may only guide the caller into the review workflow. They never approve.
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING);
    }
    const activity = await this.prisma.activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: { initiatorMemberId: true, statusCode: true },
    });
    if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    if (!user.memberId || activity.initiatorMemberId !== user.memberId) {
      throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    }
    if (activity.statusCode !== 'draft') throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    // Old direct-publish routes lack a client key, therefore this bridge makes a fresh submit attempt.
    // The locked submit path still rejects concurrent attempts once one pending review exists.
    return this.submitInitialProposal(
      activityId,
      { operationKey: `compat-publish:${randomUUID()}`, confirmation: true },
      user,
      auditMeta,
    );
  }

  async approve(
    reviewId: string,
    dto: ApproveActivityPublishReviewDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityPublishReviewResponseDto> {
    if (dto.requiresInsuranceConfirmed !== true) throw new BizException(BizCode.BAD_REQUEST);
    const reviewRequestHash =
      dto.operationKey === undefined ? null : this.reviewRequestHash('approve', reviewId, dto);
    const authz = await this.authz.explain(user, 'activity.publish.record', {
      type: 'activity_publish_review',
      id: reviewId,
    });
    if (!authz.allow) {
      throw new BizException(
        authz.reason === 'resource_not_found'
          ? BizCode.ACTIVITY_PUBLISH_REVIEW_NOT_FOUND
          : BizCode.RBAC_FORBIDDEN,
      );
    }
    const seed = await this.prisma.activityPublishReview.findUnique({
      where: { id: reviewId },
      select: { activityId: true },
    });
    if (!seed) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_NOT_FOUND);

    let result: { dto: ActivityPublishReviewResponseDto; missingChangeOwner: boolean };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        await this.lockActivity(seed.activityId, tx);
        await this.lockReview(reviewId, tx);
        const review = await tx.activityPublishReview.findUniqueOrThrow({
          where: { id: reviewId },
        });
        if (this.proposalV2.isSnapshot(review.snapshot) && dto.operationKey === undefined) {
          throw new BizException(BizCode.BAD_REQUEST);
        }
        if (review.submittedByUserId === user.id) {
          throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SELF_REVIEW_FORBIDDEN);
        }
        const activity = await tx.activity.findUniqueOrThrow({
          where: { id: review.activityId },
          select: {
            statusCode: true,
            workflowRevision: true,
            organizationId: true,
            startAt: true,
            endAt: true,
            registrationDeadline: true,
            initiatorMemberId: true,
            allocationModeCode: true,
          },
        });
        await this.allocationModes.assertLockedActivityConsistent(tx, {
          id: review.activityId,
          allocationModeCode: activity.allocationModeCode,
        });
        if (dto.operationKey !== undefined && reviewRequestHash !== null) {
          const replay = await this.findReviewReplay(tx, dto.operationKey, reviewRequestHash);
          if (replay) return { dto: replay, missingChangeOwner: false };
        }
        if (this.proposalV2.isSnapshot(review.snapshot)) {
          return this.approveV2Locked(
            tx,
            review,
            activity,
            dto,
            reviewRequestHash,
            user,
            auditMeta,
          );
        }
        const decision = this.stateMachine.decide('approve', review.status);
        if (!decision.allowed) throw new BizException(decision.biz);
        if (
          !['initial', 'change'].includes(review.requestType) ||
          review.baseRevision !== activity.workflowRevision
        ) {
          throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
        }
        let changeSnapshot: ActivityProposalSnapshot | null = null;
        if (review.requestType === 'initial') {
          const currentSnapshot = await this.snapshot(review.activityId, tx);
          if (canonicalJson(currentSnapshot) !== canonicalJson(review.snapshot)) {
            throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
          }
          this.ensureInitialPublishable(activity);
        } else {
          if (activity.statusCode !== 'published') {
            throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
          }
          try {
            changeSnapshot = parseActivityProposalSnapshot(review.snapshot);
          } catch {
            throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
          }
          this.proposalValidator.assertOrganizationUnchanged(
            activity.organizationId,
            changeSnapshot.activity.organizationId,
          );
          await this.proposalValidator.validate(tx, review.activityId, changeSnapshot);
          await this.allocationModes.assertLockedActivityConsistent(tx, {
            id: review.activityId,
            allocationModeCode:
              changeSnapshot.activity.allocationModeCode ?? activity.allocationModeCode,
          });
        }
        const liveSessionCount = await tx.activitySession.count({
          where: { activityId: review.activityId, deletedAt: null, statusCode: 'scheduled' },
        });
        if (liveSessionCount === 0) {
          throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_LIVE_SESSION_REQUIRED);
        }
        const now = new Date();
        const updatedReview = await tx.activityPublishReview.update({
          where: { id: review.id },
          data: {
            status: decision.nextStatus,
            reviewedByUserId: user.id,
            reviewedAt: now,
            reviewNote: dto.reviewNote ?? null,
            ...(dto.operationKey === undefined || reviewRequestHash === null
              ? {}
              : { reviewOperationKey: dto.operationKey, reviewRequestHash }),
          },
          select: activityPublishReviewViewSelect,
        });
        if (review.requestType === 'initial') {
          const initiator = await tx.activity.findUniqueOrThrow({
            where: { id: review.activityId },
            select: { initiatorMemberId: true },
          });
          await this.responsibilities.createOwnerForPublish(
            tx,
            review.activityId,
            initiator.initiatorMemberId,
            user.id,
            now,
            user.role,
            auditMeta,
          );
          await tx.activity.update({
            where: { id: review.activityId },
            data: {
              statusCode: 'published',
              publishedBy: user.id,
              publishedAt: now,
              workflowRevision: { increment: 1 },
            },
          });
        }
        const changeEffect =
          changeSnapshot === null
            ? null
            : await this.proposalApplier.apply(
                tx,
                review.activityId,
                changeSnapshot,
                user,
                auditMeta,
              );
        await this.writeRuleSnapshot(tx, review.activityId, review.id);
        await this.audit.log({
          activityId: review.activityId,
          reviewId: review.id,
          operation: 'publish-review-approve',
          requestVersion: review.requestVersion,
          requestType: review.requestType,
          directPublish: false,
          actorUserId: user.id,
          actorRoleSnap: user.role,
          auditMeta,
          tx,
        });
        const publishedEffect =
          review.requestType === 'initial'
            ? await this.loadPublishedEffect(review.activityId, tx)
            : null;
        const recipientMemberId = await this.resolveReviewOutcomeRecipient(tx, {
          activityId: review.activityId,
          requestType: review.requestType,
          initiatorMemberId: activity.initiatorMemberId,
          at: now,
        });
        const activityTitle = publishedEffect?.activityTitle ?? changeEffect?.activityTitle;
        if (!activityTitle) {
          throw new Error(`activity review effect disappeared: ${review.id}`);
        }
        await this.notificationProducer.enqueueReviewOutcome(tx, {
          reviewId: review.id,
          activityId: review.activityId,
          activityTitle,
          reviewedAt: now,
          recipientMemberId,
          approved: true,
        });
        if (publishedEffect) {
          await this.notificationProducer.enqueuePublished(tx, publishedEffect);
        }
        if (changeEffect) {
          await this.notificationProducer.enqueueScheduleChange(tx, {
            activityId: changeEffect.activityId,
            activityTitle: changeEffect.activityTitle,
            versionKey: `review:${review.id}`,
            before: null,
            after: null,
            requiresInsurance: false,
            memberIds: changeEffect.notificationMemberIds,
          });
          await this.notificationProducer.enqueueWaitlistPromotions(tx, {
            activityTitle: changeEffect.activityTitle,
            promoted: changeEffect.promoted,
          });
        }
        return {
          dto: this.presenter.toDto(updatedReview),
          missingChangeOwner: review.requestType === 'change' && recipientMemberId === null,
        };
      });
    } catch (error) {
      if (dto.operationKey === undefined || reviewRequestHash === null) throw error;
      result = {
        dto: await this.rethrowReviewOperationKeyConflict(
          error,
          dto.operationKey,
          reviewRequestHash,
        ),
        missingChangeOwner: false,
      };
    }
    if (result.missingChangeOwner) {
      this.logger.warn(
        `activity review outcome recipient missing (activity=${seed.activityId}, review=${reviewId})`,
      );
    }
    return result.dto;
  }

  private async approveV2Locked(
    tx: PrismaTx,
    review: {
      id: string;
      activityId: string;
      requestType: string;
      requestVersion: number;
      baseRevision: number;
      status: string;
      snapshot: Prisma.JsonValue;
      submittedByUserId: string;
    },
    activity: {
      statusCode: string;
      workflowRevision: number;
      organizationId: string;
      startAt: Date;
      endAt: Date;
      registrationDeadline: Date | null;
      initiatorMemberId: string | null;
      allocationModeCode: string;
    },
    dto: ApproveActivityPublishReviewDto,
    reviewRequestHash: string | null,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<{ dto: ActivityPublishReviewResponseDto; missingChangeOwner: boolean }> {
    const decision = this.stateMachine.decide('approve', review.status);
    if (!decision.allowed) throw new BizException(decision.biz);
    if (review.requestType !== 'initial' && review.requestType !== 'change') {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    }
    const snapshot = this.proposalV2.parseSnapshot(review.snapshot);
    this.proposalValidator.assertOrganizationUnchanged(
      activity.organizationId,
      snapshot.activity.organizationId,
    );
    const current = await this.proposalV2.rebuildCurrent(
      tx,
      review.activityId,
      snapshot.schemaVersion,
    );
    if (
      review.baseRevision !== activity.workflowRevision ||
      snapshot.baseWorkflowRevision !== review.baseRevision ||
      snapshot.baseSnapshotHash !== current.snapshotHash
    ) {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_EXPECTED_SNAPSHOT_MISMATCH);
    }
    await this.allocationModes.assertLockedActivityConsistent(tx, {
      id: review.activityId,
      allocationModeCode:
        snapshot.schemaVersion === 4
          ? snapshot.activity.allocationModeCode
          : activity.allocationModeCode,
    });
    if (review.requestType === 'initial') {
      this.ensureInitialPublishable(activity);
    } else if (activity.statusCode !== 'published') {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_EXPECTED_SNAPSHOT_MISMATCH);
    }
    if (!snapshot.sessions.some((session) => session.statusCode === 'scheduled')) {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_LIVE_SESSION_REQUIRED);
    }

    const now = new Date();
    const applied = await this.proposalV2.apply(tx, review.activityId, snapshot, {
      publish: review.requestType === 'initial',
      publishedByUserId: user.id,
      at: now,
    });
    if (review.requestType === 'initial') {
      await this.responsibilities.createOwnerForPublish(
        tx,
        review.activityId,
        activity.initiatorMemberId,
        user.id,
        now,
        user.role,
        auditMeta,
      );
    }
    // RuleSnapshot freezes the proposal's resolved template/activity/system values, not a later
    // template lookup. The Activity lock serializes the aggregate; this preserves the proposal's
    // templateVersionId even if template administration changes between submit and approval.
    await this.writeRuleSnapshot(tx, review.activityId, review.id, {
      expectedWorkflowRevision: applied.workflowRevision,
      resolvedConfig:
        snapshot.schemaVersion === 2 ? snapshot.resolvedConfig : applied.resolvedConfig,
      schemaVersion: snapshot.schemaVersion,
    });
    const updatedReview = await tx.activityPublishReview.update({
      where: { id: review.id },
      data: {
        status: decision.nextStatus,
        reviewedByUserId: user.id,
        reviewedAt: now,
        reviewNote: dto.reviewNote ?? null,
        ...(dto.operationKey === undefined || reviewRequestHash === null
          ? {}
          : { reviewOperationKey: dto.operationKey, reviewRequestHash }),
      },
      select: activityPublishReviewViewSelect,
    });
    await this.audit.log({
      activityId: review.activityId,
      reviewId: review.id,
      operation: 'publish-review-approve',
      requestVersion: review.requestVersion,
      requestType: review.requestType,
      directPublish: false,
      actorUserId: user.id,
      actorRoleSnap: user.role,
      auditMeta,
      tx,
    });
    const effect = await this.loadPublishedEffect(review.activityId, tx);
    const recipientMemberId = await this.resolveReviewOutcomeRecipient(tx, {
      activityId: review.activityId,
      requestType: review.requestType,
      initiatorMemberId: activity.initiatorMemberId,
      at: now,
    });
    await this.notificationProducer.enqueueReviewOutcome(tx, {
      reviewId: review.id,
      activityId: review.activityId,
      activityTitle: effect.activityTitle,
      reviewedAt: now,
      recipientMemberId,
      approved: true,
    });
    if (review.requestType === 'initial') {
      await this.notificationProducer.enqueuePublished(tx, effect);
    } else {
      const identities = await tx.activityParticipationIdentity.findMany({
        where: { activityId: review.activityId, populationIncluded: true },
        select: { memberId: true },
      });
      await this.notificationProducer.enqueueScheduleChange(tx, {
        activityId: review.activityId,
        activityTitle: effect.activityTitle,
        versionKey: `review:${review.id}`,
        before: null,
        after: null,
        requiresInsurance: effect.requiresInsurance,
        memberIds: [...new Set(identities.map((identity) => identity.memberId))],
      });
    }
    return {
      dto: this.presenter.toDto(updatedReview),
      missingChangeOwner: review.requestType === 'change' && recipientMemberId === null,
    };
  }

  async returnReview(
    reviewId: string,
    dto: ReturnActivityPublishReviewDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityPublishReviewResponseDto> {
    if (!dto.reviewNote.trim()) {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_NOTE_REQUIRED);
    }
    const reviewRequestHash =
      dto.operationKey === undefined ? null : this.reviewRequestHash('return', reviewId, dto);
    const authz = await this.authz.explain(user, 'activity-review.return.request', {
      type: 'activity_publish_review',
      id: reviewId,
    });
    if (!authz.allow) {
      throw new BizException(
        authz.reason === 'resource_not_found'
          ? BizCode.ACTIVITY_PUBLISH_REVIEW_NOT_FOUND
          : BizCode.RBAC_FORBIDDEN,
      );
    }
    const seed = await this.prisma.activityPublishReview.findUnique({
      where: { id: reviewId },
      select: { activityId: true },
    });
    if (!seed) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_NOT_FOUND);
    let result: { dto: ActivityPublishReviewResponseDto; missingChangeOwner: boolean };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        await this.lockActivity(seed.activityId, tx);
        await this.lockReview(reviewId, tx);
        const review = await tx.activityPublishReview.findUniqueOrThrow({
          where: { id: reviewId },
        });
        if (this.proposalV2.isSnapshot(review.snapshot) && dto.operationKey === undefined) {
          throw new BizException(BizCode.BAD_REQUEST);
        }
        if (dto.operationKey !== undefined && reviewRequestHash !== null) {
          const replay = await this.findReviewReplay(tx, dto.operationKey, reviewRequestHash);
          if (replay) return { dto: replay, missingChangeOwner: false };
        }
        if (review.submittedByUserId === user.id) {
          throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SELF_REVIEW_FORBIDDEN);
        }
        const decision = this.stateMachine.decide('return', review.status);
        if (!decision.allowed) throw new BizException(decision.biz);
        const reviewedAt = new Date();
        const updated = await tx.activityPublishReview.update({
          where: { id: review.id },
          data: {
            status: decision.nextStatus,
            reviewedByUserId: user.id,
            reviewedAt,
            reviewNote: dto.reviewNote.trim(),
            ...(dto.operationKey === undefined || reviewRequestHash === null
              ? {}
              : { reviewOperationKey: dto.operationKey, reviewRequestHash }),
          },
          select: activityPublishReviewViewSelect,
        });
        await this.audit.log({
          activityId: review.activityId,
          reviewId: review.id,
          operation: 'publish-review-return',
          requestVersion: review.requestVersion,
          requestType: review.requestType,
          directPublish: false,
          actorUserId: user.id,
          actorRoleSnap: user.role,
          auditMeta,
          tx,
        });
        const activity = await tx.activity.findUniqueOrThrow({
          where: { id: review.activityId },
          select: { title: true, initiatorMemberId: true },
        });
        const recipientMemberId = await this.resolveReviewOutcomeRecipient(tx, {
          activityId: review.activityId,
          requestType: review.requestType,
          initiatorMemberId: activity.initiatorMemberId,
          at: reviewedAt,
        });
        await this.notificationProducer.enqueueReviewOutcome(tx, {
          reviewId: review.id,
          activityId: review.activityId,
          activityTitle: activity.title,
          reviewedAt,
          recipientMemberId,
          approved: false,
          reviewNote: dto.reviewNote.trim(),
        });
        return {
          dto: this.presenter.toDto(updated),
          missingChangeOwner: review.requestType === 'change' && recipientMemberId === null,
        };
      });
    } catch (error) {
      if (dto.operationKey === undefined || reviewRequestHash === null) throw error;
      result = {
        dto: await this.rethrowReviewOperationKeyConflict(
          error,
          dto.operationKey,
          reviewRequestHash,
        ),
        missingChangeOwner: false,
      };
    }
    if (result.missingChangeOwner) {
      this.logger.warn(
        `activity review outcome recipient missing (activity=${seed.activityId}, review=${reviewId})`,
      );
    }
    return result.dto;
  }

  async withdraw(
    reviewId: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityPublishReviewResponseDto> {
    const seed = await this.prisma.activityPublishReview.findUnique({
      where: { id: reviewId },
      select: { activityId: true },
    });
    if (!seed) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_NOT_FOUND);
    const row = await this.prisma.$transaction(async (tx) => {
      await this.lockActivity(seed.activityId, tx);
      await this.lockReview(reviewId, tx);
      const review = await tx.activityPublishReview.findUniqueOrThrow({ where: { id: reviewId } });
      if (review.submittedByUserId !== user.id) throw new BizException(BizCode.RBAC_FORBIDDEN);
      const decision = this.stateMachine.decide('withdraw', review.status);
      if (!decision.allowed) throw new BizException(decision.biz);
      const updated = await tx.activityPublishReview.update({
        where: { id: review.id },
        data: { status: decision.nextStatus },
        select: activityPublishReviewViewSelect,
      });
      await this.audit.log({
        activityId: review.activityId,
        reviewId: review.id,
        operation: 'publish-review-withdraw',
        requestVersion: review.requestVersion,
        requestType: review.requestType,
        directPublish: false,
        actorUserId: user.id,
        actorRoleSnap: user.role,
        auditMeta,
        tx,
      });
      return updated;
    });
    return this.presenter.toDto(row);
  }

  async cancelPendingForActivity(activityId: string, tx: PrismaTx): Promise<void> {
    const pending = await tx.activityPublishReview.findFirst({
      where: { activityId, status: 'pending' },
      select: { id: true, status: true },
    });
    if (!pending) return;
    await this.lockReview(pending.id, tx);
    const decision = this.stateMachine.decide('activity-cancel', pending.status);
    if (!decision.allowed) throw new BizException(decision.biz);
    await tx.activityPublishReview.update({
      where: { id: pending.id },
      data: { status: decision.nextStatus },
    });
  }

  async assertNoPendingChangeReview(activityId: string, tx: PrismaTx): Promise<void> {
    const count = await tx.activityPublishReview.count({
      where: { activityId, requestType: 'change', status: 'pending' },
    });
    if (count > 0) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING);
  }

  private submitRequestHash(
    action: 'initial' | 'change',
    activityId: string,
    dto: SubmitActivityPublishReviewDto | ChangeReviewDto,
  ): string {
    return hashCanonical({
      action: `publish-review-submit:${action}`,
      activityId,
      payload: dto,
    });
  }

  private reviewRequestHash(
    action: 'approve' | 'return',
    reviewId: string,
    dto: ApproveActivityPublishReviewDto | ReturnActivityPublishReviewDto,
  ): string {
    return hashCanonical({
      action: `publish-review-${action}`,
      reviewId,
      payload: dto,
    });
  }

  /** App-owned proposal routes follow the draft surface's NOT_FOUND masking contract. */
  private async assertOwnerHidden(
    tx: PrismaTx,
    activityId: string,
    user: CurrentUserPayload,
  ): Promise<void> {
    if (!user.memberId) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    const owner = await tx.activityResponsibilityAssignment.findFirst({
      where: {
        activityId,
        memberId: user.memberId,
        responsibilityType: 'owner',
        status: 'active',
      },
      select: { id: true },
    });
    if (!owner) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
  }

  private async findSubmitReplay(
    tx: PrismaTx,
    operationKey: string,
    requestHash: string,
  ): Promise<ActivityPublishReviewViewRow | null> {
    const existing = await tx.activityPublishReview.findUnique({
      where: { operationKey },
      select: activityPublishReviewIdempotencySelect,
    });
    if (!existing) return null;
    if (existing.requestHash !== requestHash) {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_OPERATION_KEY_CONFLICT);
    }
    return existing;
  }

  private async findReviewReplay(
    tx: PrismaTx,
    operationKey: string,
    requestHash: string,
  ): Promise<ActivityPublishReviewResponseDto | null> {
    const existing = await tx.activityPublishReview.findUnique({
      where: { reviewOperationKey: operationKey },
      select: activityPublishReviewIdempotencySelect,
    });
    if (!existing) return null;
    if (existing.reviewRequestHash !== requestHash) {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_OPERATION_KEY_CONFLICT);
    }
    return this.presenter.toDto(existing);
  }

  private async rethrowSubmitOperationKeyConflict(
    error: unknown,
    operationKey: string,
    requestHash: string,
  ): Promise<ActivityPublishReviewResponseDto> {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error;
    }
    const existing = await this.prisma.activityPublishReview.findUnique({
      where: { operationKey },
      select: activityPublishReviewIdempotencySelect,
    });
    if (existing && existing.requestHash === requestHash) {
      return this.presenter.toDto(existing);
    }
    throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_OPERATION_KEY_CONFLICT);
  }

  private async rethrowReviewOperationKeyConflict(
    error: unknown,
    operationKey: string,
    requestHash: string,
  ): Promise<ActivityPublishReviewResponseDto> {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error;
    }
    const existing = await this.prisma.activityPublishReview.findUnique({
      where: { reviewOperationKey: operationKey },
      select: activityPublishReviewIdempotencySelect,
    });
    if (existing && existing.reviewRequestHash === requestHash) {
      return this.presenter.toDto(existing);
    }
    throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_OPERATION_KEY_CONFLICT);
  }

  private async writeRuleSnapshot(
    tx: PrismaTx,
    activityId: string,
    reviewId: string,
    options: {
      expectedWorkflowRevision?: number;
      resolvedConfig?: ActivityTemplateResolution | ActivityTemplateResolutionWithRegistrationForm;
      schemaVersion?: 2 | 3 | 4;
    } = {},
  ): Promise<void> {
    const activity = await tx.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: { workflowRevision: true },
    });
    if (
      options.expectedWorkflowRevision !== undefined &&
      activity.workflowRevision !== options.expectedWorkflowRevision
    ) {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_EXPECTED_SNAPSHOT_MISMATCH);
    }
    const resolvedConfig =
      options.resolvedConfig ?? (await this.proposalV2.getTemplateResolution(tx, activityId));
    await tx.activityRuleSnapshot.create({
      data: {
        activityId,
        workflowRevision: activity.workflowRevision,
        templateVersionId: resolvedConfig.templateVersionId,
        resolvedConfig: JSON.parse(JSON.stringify(resolvedConfig)) as Prisma.InputJsonValue,
        snapshotHash: hashCanonical({ schemaVersion: options.schemaVersion ?? 2, resolvedConfig }),
        createdByReviewId: reviewId,
      },
    });
  }

  private async loadPublishedEffect(
    activityId: string,
    tx?: PrismaTx,
  ): Promise<PublishedActivityEffect> {
    const client = tx ?? this.prisma;
    const activity = await client.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: {
        id: true,
        title: true,
        startAt: true,
        location: true,
        publishedAt: true,
        requiresInsurance: true,
        isPublicRegistration: true,
        initiatorMemberId: true,
      },
    });
    if (activity.publishedAt === null) {
      throw new Error(`published activity has no publishedAt: ${activityId}`);
    }
    return {
      activityId: activity.id,
      activityTitle: activity.title,
      startAt: activity.startAt,
      location: activity.location,
      publishedAt: activity.publishedAt,
      requiresInsurance: activity.requiresInsurance,
      isPublicRegistration: activity.isPublicRegistration,
      initiatorMemberId: activity.initiatorMemberId,
    };
  }

  private async resolveReviewOutcomeRecipient(
    tx: PrismaTx,
    input: {
      activityId: string;
      requestType: string;
      initiatorMemberId: string | null;
      at: Date;
    },
  ): Promise<string | null> {
    if (input.requestType === 'initial') return input.initiatorMemberId;
    const owner = await tx.activityResponsibilityAssignment.findFirst({
      where: {
        activityId: input.activityId,
        responsibilityType: 'owner',
        status: 'active',
        startedAt: { lte: input.at },
        endedAt: null,
        member: { status: MemberStatus.ACTIVE, deletedAt: null },
      },
      select: { memberId: true },
    });
    return owner?.memberId ?? null;
  }
}
