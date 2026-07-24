import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_TYPE_ACTIVITY_CHANGED,
  NOTIFICATION_TYPE_ACTIVITY_PUBLISHED,
  NOTIFICATION_TYPE_REGISTRATION_RESULT,
} from '../notifications/notification.constants';
import { NotificationDispatcher } from '../notifications/notification-dispatcher';
import {
  ApproveActivityPublishReviewDto,
  ActivityPublishReviewResponseDto,
  ReturnActivityPublishReviewDto,
} from './activity-publish-review.dto';
import { ActivityPublishReviewAuditRecorder } from './activity-publish-review-audit-recorder';
import {
  ActivityPublishReviewPresenter,
  activityPublishReviewViewSelect,
} from './activity-publish-review-presenter';
import { ActivityPublishReviewStateMachine } from './activity-publish-review-state-machine';
import { ActivityResponsibilityService } from './activity-responsibility.service';
import { ActivityResponsibilityPolicy } from './activity-responsibility-policy';
import type { UpdateActivityDto } from './activities.dto';
import type { AppActivityChangePositionDto } from './dto/app/app-managed-activity.dto';
import { ActivityProposalValidator } from './activity-proposal-validator';
import {
  ActivityProposalApplier,
  type ActivityProposalApplyResult,
} from './activity-proposal-applier';
import {
  parseActivityProposalSnapshot,
  type ActivityProposalSnapshot,
} from './activity-proposal.types';

type PrismaTx = Prisma.TransactionClient;

interface PublishedActivityEffect {
  activityId: string;
  activityTitle: string;
  startAt: Date;
  location: string;
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

@Injectable()
export class ActivityPublishReviewService {
  private readonly logger = new Logger(ActivityPublishReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly stateMachine: ActivityPublishReviewStateMachine,
    private readonly presenter: ActivityPublishReviewPresenter,
    private readonly audit: ActivityPublishReviewAuditRecorder,
    private readonly notifications: NotificationDispatcher,
    private readonly responsibilities: ActivityResponsibilityService,
    private readonly responsibilityPolicy: ActivityResponsibilityPolicy,
    private readonly proposalValidator: ActivityProposalValidator,
    private readonly proposalApplier: ActivityProposalApplier,
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
            initiatorMemberId: true,
            startAt: true,
            endAt: true,
            registrationDeadline: true,
          },
        });
        if (!user.memberId || activity.initiatorMemberId !== user.memberId) {
          throw new BizException(BizCode.RBAC_FORBIDDEN);
        }
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
          select: { statusCode: true, workflowRevision: true },
        });
        if (activity.statusCode !== 'published') {
          throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
        }
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

  async compatibilityPublish(
    activityId: string,
    dto: ApproveActivityPublishReviewDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<PublishedActivityEffect> {
    const pending = await this.prisma.activityPublishReview.findFirst({
      where: { activityId, requestType: 'initial', status: 'pending' },
      select: { id: true },
    });
    if (pending) {
      const result = await this.approve(pending.id, dto, user, auditMeta);
      return this.loadPublishedEffect(result.activityId);
    }
    const activity = await this.prisma.activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: { initiatorMemberId: true },
    });
    if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    if (!user.memberId || activity.initiatorMemberId !== user.memberId) {
      throw new BizException(BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED);
    }
    const decision = await this.authz.explain(user, 'activity.publish.record', {
      type: 'activity',
      id: activityId,
    });
    if (!decision.allow) throw new BizException(BizCode.RBAC_FORBIDDEN);
    const effect = await this.directPublish(activityId, user, auditMeta);
    await this.dispatchPublished(effect);
    return effect;
  }

  private async directPublish(
    activityId: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<PublishedActivityEffect> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockActivity(activityId, tx);
        const activity = await tx.activity.findUniqueOrThrow({
          where: { id: activityId },
          select: {
            statusCode: true,
            workflowRevision: true,
            initiatorMemberId: true,
            startAt: true,
            endAt: true,
            registrationDeadline: true,
          },
        });
        if (activity.initiatorMemberId !== user.memberId) {
          throw new BizException(BizCode.RBAC_FORBIDDEN);
        }
        this.ensureInitialPublishable(activity);
        const pendingCount = await tx.activityPublishReview.count({
          where: { activityId, status: 'pending' },
        });
        if (pendingCount > 0) {
          throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING);
        }
        const decision = this.stateMachine.decide('direct-publish');
        if (!decision.allowed) throw new BizException(decision.biz);
        const now = new Date();
        const review = await tx.activityPublishReview.create({
          data: {
            activityId,
            requestType: 'initial',
            requestVersion: await this.nextRequestVersion(activityId, tx),
            baseRevision: activity.workflowRevision,
            status: decision.nextStatus,
            snapshot: await this.snapshot(activityId, tx),
            directPublish: true,
            submittedByUserId: user.id,
            reviewedByUserId: user.id,
            reviewedAt: now,
          },
        });
        await this.responsibilities.createOwnerForPublish(
          tx,
          activityId,
          activity.initiatorMemberId,
          user.id,
          now,
          user.role,
          auditMeta,
        );
        await tx.activity.update({
          where: { id: activityId },
          data: {
            statusCode: 'published',
            publishedBy: user.id,
            publishedAt: now,
            workflowRevision: { increment: 1 },
          },
        });
        await this.audit.log({
          activityId,
          reviewId: review.id,
          operation: 'publish-review-direct',
          requestVersion: review.requestVersion,
          requestType: review.requestType,
          directPublish: true,
          actorUserId: user.id,
          actorRoleSnap: user.role,
          auditMeta,
          tx,
        });
        return this.loadPublishedEffect(activityId, tx);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING);
      }
      throw error;
    }
  }

  async approve(
    reviewId: string,
    dto: ApproveActivityPublishReviewDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityPublishReviewResponseDto> {
    if (dto.requiresInsuranceConfirmed !== true) throw new BizException(BizCode.BAD_REQUEST);
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

    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockActivity(seed.activityId, tx);
      await this.lockReview(reviewId, tx);
      const review = await tx.activityPublishReview.findUniqueOrThrow({ where: { id: reviewId } });
      const activity = await tx.activity.findUniqueOrThrow({
        where: { id: review.activityId },
        select: {
          statusCode: true,
          workflowRevision: true,
          organizationId: true,
          startAt: true,
          endAt: true,
          registrationDeadline: true,
        },
      });
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
      }
      const now = new Date();
      const updatedReview = await tx.activityPublishReview.update({
        where: { id: review.id },
        data: {
          status: decision.nextStatus,
          reviewedByUserId: user.id,
          reviewedAt: now,
          reviewNote: dto.reviewNote ?? null,
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
      return {
        dto: this.presenter.toDto(updatedReview),
        publishedEffect:
          review.requestType === 'initial'
            ? await this.loadPublishedEffect(review.activityId, tx)
            : null,
        changeEffect,
      };
    });
    if (result.publishedEffect) {
      await this.dispatchPublished(result.publishedEffect);
    }
    if (result.changeEffect) {
      await this.dispatchChangeApplied(result.changeEffect);
    }
    return result.dto;
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
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockActivity(seed.activityId, tx);
      await this.lockReview(reviewId, tx);
      const review = await tx.activityPublishReview.findUniqueOrThrow({ where: { id: reviewId } });
      const decision = this.stateMachine.decide('return', review.status);
      if (!decision.allowed) throw new BizException(decision.biz);
      const updated = await tx.activityPublishReview.update({
        where: { id: review.id },
        data: {
          status: decision.nextStatus,
          reviewedByUserId: user.id,
          reviewedAt: new Date(),
          reviewNote: dto.reviewNote.trim(),
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
      return { updated, activity };
    });
    await this.dispatchReviewOutcome({
      activityId: seed.activityId,
      activityTitle: result.activity.title,
      initiatorMemberId: result.activity.initiatorMemberId,
      approved: false,
      reviewNote: dto.reviewNote.trim(),
    });
    return this.presenter.toDto(result.updated);
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
        requiresInsurance: true,
        isPublicRegistration: true,
        initiatorMemberId: true,
      },
    });
    return {
      activityId: activity.id,
      activityTitle: activity.title,
      startAt: activity.startAt,
      location: activity.location,
      requiresInsurance: activity.requiresInsurance,
      isPublicRegistration: activity.isPublicRegistration,
      initiatorMemberId: activity.initiatorMemberId,
    };
  }

  private async dispatchPublished(effect: PublishedActivityEffect): Promise<void> {
    await this.dispatchReviewOutcome({
      activityId: effect.activityId,
      activityTitle: effect.activityTitle,
      initiatorMemberId: effect.initiatorMemberId,
      approved: true,
    });
    if (!effect.isPublicRegistration) return;
    try {
      const insurance = effect.requiresInsurance
        ? ' 本活动要求有效保险，请在报名前确认覆盖期。'
        : '';
      await this.notifications.dispatchSystemMemberBroadcast({
        notificationTypeCode: NOTIFICATION_TYPE_ACTIVITY_PUBLISHED,
        title: '新活动已发布',
        body: `「${effect.activityTitle}」已发布，开始时间 ${effect.startAt.toISOString()}，地点 ${effect.location}。${insurance}`,
      });
    } catch (error) {
      this.logger.error(
        `activity publish notification failed (activity=${effect.activityId}): ${(error as Error).message}`,
      );
    }
  }

  private async dispatchChangeApplied(effect: ActivityProposalApplyResult): Promise<void> {
    await this.dispatchReviewOutcome({
      activityId: effect.activityId,
      activityTitle: effect.activityTitle,
      initiatorMemberId: effect.initiatorMemberId,
      approved: true,
    });
    for (const memberId of effect.notificationMemberIds) {
      try {
        await this.notifications.dispatchTargeted({
          recipientMemberId: memberId,
          notificationTypeCode: NOTIFICATION_TYPE_ACTIVITY_CHANGED,
          title: '活动安排已变更',
          body: `您报名的「${effect.activityTitle}」已通过变更审核，请查看最新安排。`,
          channels: [NOTIFICATION_CHANNEL_IN_APP],
        });
      } catch (error) {
        this.logger.error(
          `activity change notification failed (activity=${effect.activityId}, member=${memberId}): ${(error as Error).message}`,
        );
      }
    }
    for (const memberId of effect.promotedMemberIds) {
      try {
        await this.notifications.dispatchTargeted({
          recipientMemberId: memberId,
          notificationTypeCode: NOTIFICATION_TYPE_REGISTRATION_RESULT,
          title: '候补已递补',
          body: `您报名的「${effect.activityTitle}」已从候补递补，现已进入待审核。`,
          channels: [NOTIFICATION_CHANNEL_IN_APP],
        });
      } catch (error) {
        this.logger.error(
          `waitlist promotion notification failed (activity=${effect.activityId}, member=${memberId}): ${(error as Error).message}`,
        );
      }
    }
  }

  private async dispatchReviewOutcome(input: {
    activityId: string;
    activityTitle: string;
    initiatorMemberId: string | null;
    approved: boolean;
    reviewNote?: string;
  }): Promise<void> {
    if (!input.initiatorMemberId) return;
    try {
      await this.notifications.dispatchTargeted({
        recipientMemberId: input.initiatorMemberId,
        notificationTypeCode: 'general',
        title: input.approved ? '活动发布审核已通过' : '活动发布审核已退回',
        body: input.approved
          ? `「${input.activityTitle}」已通过发布审核。`
          : `「${input.activityTitle}」发布审核已退回。原因：${input.reviewNote ?? '未填写'}`,
      });
    } catch (error) {
      this.logger.error(
        `activity review outcome notification failed (activity=${input.activityId}, member=${input.initiatorMemberId}): ${(error as Error).message}`,
      );
    }
  }
}
