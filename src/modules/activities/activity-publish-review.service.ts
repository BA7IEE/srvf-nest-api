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
import { ActivityProposalApplier } from './activity-proposal-applier';
import { ActivityNotificationProducer } from './activity-notification-producer';
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
    return this.directPublish(activityId, user, auditMeta);
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
        const effect = await this.loadPublishedEffect(activityId, tx);
        await this.notificationProducer.enqueueReviewOutcome(tx, {
          reviewId: review.id,
          activityId,
          activityTitle: effect.activityTitle,
          reviewedAt: now,
          recipientMemberId: activity.initiatorMemberId,
          approved: true,
        });
        await this.notificationProducer.enqueuePublished(tx, effect);
        return effect;
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
          initiatorMemberId: true,
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
    if (result.missingChangeOwner) {
      this.logger.warn(
        `activity review outcome recipient missing (activity=${seed.activityId}, review=${reviewId})`,
      );
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
      const reviewedAt = new Date();
      const updated = await tx.activityPublishReview.update({
        where: { id: review.id },
        data: {
          status: decision.nextStatus,
          reviewedByUserId: user.id,
          reviewedAt,
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
