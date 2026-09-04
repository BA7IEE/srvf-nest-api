import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { MemberStatus, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import appConfig from '../../config/app.config';
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
  readActivityPublishReviewAudienceOrganizationIds,
  readActivityPublishReviewAudienceTagCodes,
  activityPublishReviewViewSelect,
} from './activity-publish-review-presenter';
import { ActivityPublishReviewStateMachine } from './activity-publish-review-state-machine';
import { ActivityResponsibilityService } from './activity-responsibility.service';
import { ActivityResponsibilityPolicy } from './activity-responsibility-policy';
import { ActivityProposalValidator } from './activity-proposal-validator';
import { ActivityProposalApplier } from './activity-proposal-applier';
import { ActivityNotificationProducer } from './activity-notification-producer';
import {
  freezeAudienceTags,
  freezeRegistrationRoster,
  freezeResponsibility,
  isFrozenCohort,
  type FrozenBroadcastAudience,
  type FrozenRecipientCohort,
} from './activity-recipient-freeze';
import { ActivityAllocationModeService } from './activity-allocation-mode.service';
import {
  ActivityPublishProposalV2Service,
  type ActivityTemplateResolution,
  type ActivityTemplateResolutionWithRegistrationForm,
  type ActivityTemplateResolutionWithQualificationRules,
  type ActivityTemplateResolutionWithSnapshotV6,
} from './activity-publish-proposal-v2.service';
import {
  buildProposalSnapshot,
  ensureInitialPublishable,
  lockActivity,
  type PrismaTx,
} from './activity-publish-review-access';
import {
  activityPublishReviewIdempotencySelect,
  canonicalJson,
  hashCanonical,
} from './activity-publish-review-idempotency';
import { ActivityPublishReviewSubmitService } from './activity-publish-review-submit.service';
import {
  parseActivityProposalSnapshot,
  type ActivityProposalSnapshot,
} from './activity-proposal.types';

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
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
    private readonly submit: ActivityPublishReviewSubmitService,
  ) {}

  async submitInitial(
    ...args: Parameters<ActivityPublishReviewSubmitService['submitInitial']>
  ): ReturnType<ActivityPublishReviewSubmitService['submitInitial']> {
    return this.submit.submitInitial(...args);
  }

  async submitChange(
    ...args: Parameters<ActivityPublishReviewSubmitService['submitChange']>
  ): ReturnType<ActivityPublishReviewSubmitService['submitChange']> {
    return this.submit.submitChange(...args);
  }

  async submitInitialProposal(
    ...args: Parameters<ActivityPublishReviewSubmitService['submitInitialProposal']>
  ): ReturnType<ActivityPublishReviewSubmitService['submitInitialProposal']> {
    return this.submit.submitInitialProposal(...args);
  }

  async submitChangeProposal(
    ...args: Parameters<ActivityPublishReviewSubmitService['submitChangeProposal']>
  ): ReturnType<ActivityPublishReviewSubmitService['submitChangeProposal']> {
    return this.submit.submitChangeProposal(...args);
  }

  async templateResolution(
    ...args: Parameters<ActivityPublishReviewSubmitService['templateResolution']>
  ): ReturnType<ActivityPublishReviewSubmitService['templateResolution']> {
    return this.submit.templateResolution(...args);
  }

  async compatibilityPublish(
    ...args: Parameters<ActivityPublishReviewSubmitService['compatibilityPublish']>
  ): ReturnType<ActivityPublishReviewSubmitService['compatibilityPublish']> {
    return this.submit.compatibilityPublish(...args);
  }

  async compatibilityPublishWithAudienceTags(
    ...args: Parameters<ActivityPublishReviewSubmitService['compatibilityPublishWithAudienceTags']>
  ): ReturnType<ActivityPublishReviewSubmitService['compatibilityPublishWithAudienceTags']> {
    return this.submit.compatibilityPublishWithAudienceTags(...args);
  }

  private async lockReview(reviewId: string, tx: PrismaTx): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM activity_publish_reviews WHERE id = ${reviewId} FOR UPDATE
    `;
    if (rows.length === 0) {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_NOT_FOUND);
    }
  }

  private assertAudienceTagsHttpEnabled(): void {
    if (!this.config.activityAudienceTags.httpEnabled) {
      throw new BizException(BizCode.SERVICE_UNAVAILABLE);
    }
  }

  /**
   * 审核结果通知的收件人(0 或 1 人)也要走冻结入口 —— 单人不是「不用冻结」的理由:
   * 重放时 owner 已经换人,不冻结就会发给新 owner,而当初通知的是老 owner。
   */
  private async freezeReviewOutcomeRecipient(
    tx: PrismaTx,
    reviewId: string,
    recipientMemberId: string | null,
    at: Date,
  ): Promise<FrozenRecipientCohort> {
    return freezeResponsibility(tx, {
      cohortKey: `activity-review-outcome:${reviewId}:${at.toISOString()}`,
      aggregateType: 'activity_publish_review',
      aggregateIds: [reviewId],
      basisRef: [`review:${reviewId}`],
      memberIds: [recipientMemberId],
      at,
    });
  }

  private async freezeBroadcastAudience(
    tx: PrismaTx,
    activityId: string,
    publishedAt: Date,
  ): Promise<FrozenBroadcastAudience> {
    const audience = await freezeAudienceTags(tx, {
      activityId,
      audienceTagCodes: null,
      at: publishedAt,
    });
    if (isFrozenCohort(audience)) throw new BizException(BizCode.BAD_REQUEST);
    return audience;
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
        await lockActivity(seed.activityId, tx);
        await this.lockReview(reviewId, tx);
        const review = await tx.activityPublishReview.findUniqueOrThrow({
          where: { id: reviewId },
        });
        const audienceTagCodes = readActivityPublishReviewAudienceTagCodes(review.audienceTagCodes);
        const audienceOrganizationIds =
          readActivityPublishReviewAudienceOrganizationIds(review.audienceOrganizationIds) ?? [];
        if (audienceTagCodes !== null) this.assertAudienceTagsHttpEnabled();
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
            audienceTagCodes,
            audienceOrganizationIds,
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
          const currentSnapshot = await buildProposalSnapshot(review.activityId, tx);
          if (canonicalJson(currentSnapshot) !== canonicalJson(review.snapshot)) {
            throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
          }
          ensureInitialPublishable(activity);
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
        const publishedEffect =
          review.requestType === 'initial'
            ? await this.loadPublishedEffect(review.activityId, tx)
            : null;
        let audienceRecipientMemberIds: string[] | null = null;
        let audienceCohort: FrozenRecipientCohort | null = null;
        if (audienceTagCodes !== null) {
          if (review.requestType !== 'initial') {
            throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
          }
          if (!publishedEffect?.isPublicRegistration) throw new BizException(BizCode.BAD_REQUEST);
          const cohort = await freezeAudienceTags(tx, {
            activityId: review.activityId,
            audienceTagCodes,
            audienceOrganizationIds,
            at: publishedEffect.publishedAt,
          });
          if (!isFrozenCohort(cohort)) throw new BizException(BizCode.BAD_REQUEST);
          audienceCohort = cohort;
          audienceRecipientMemberIds = [...cohort.memberIds];
          await this.audit.logAudienceTagsApproved({
            activityId: review.activityId,
            reviewId: review.id,
            requestVersion: review.requestVersion,
            actorUserId: user.id,
            actorRoleSnap: user.role,
            audienceTagCodes,
            audienceOrganizationIds,
            recipientCount: audienceRecipientMemberIds.length,
            auditMeta,
            tx,
          });
        } else {
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
        }
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
          cohort: await this.freezeReviewOutcomeRecipient(tx, review.id, recipientMemberId, now),
          approved: true,
        });
        if (publishedEffect) {
          if (audienceCohort === null) {
            await this.notificationProducer.enqueuePublished(tx, {
              ...publishedEffect,
              audience: await this.freezeBroadcastAudience(
                tx,
                review.activityId,
                publishedEffect.publishedAt,
              ),
            });
          } else {
            await this.notificationProducer.enqueuePublishedWithAudienceTags(tx, {
              ...publishedEffect,
              cohort: audienceCohort,
            });
          }
        }
        if (changeEffect) {
          const changeCohort = await freezeRegistrationRoster(tx, {
            cohortKey: `activity-change:${changeEffect.activityId}:review:${review.id}`,
            aggregateType: 'activity',
            aggregateIds: [changeEffect.activityId],
            basisRef: [`review:${review.id}`],
            memberIds: changeEffect.notificationMemberIds,
            at: now,
          });
          await this.notificationProducer.enqueueScheduleChange(tx, {
            activityId: changeEffect.activityId,
            activityTitle: changeEffect.activityTitle,
            versionKey: `review:${review.id}`,
            before: null,
            after: null,
            requiresInsurance: false,
            cohort: changeCohort,
          });
          await this.notificationProducer.enqueueWaitlistPromotions(tx, {
            activityTitle: changeEffect.activityTitle,
            promoted: changeEffect.promoted,
            cohort: await freezeRegistrationRoster(tx, {
              cohortKey: `waitlist-promote:review:${review.id}`,
              aggregateType: 'activity_registration',
              aggregateIds: changeEffect.promoted.map((item) => item.registrationId),
              basisRef: [`review:${review.id}`],
              memberIds: changeEffect.promoted.map((item) => item.memberId),
              at: now,
            }),
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
    audienceTagCodes: string[] | null,
    audienceOrganizationIds: string[],
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
        snapshot.schemaVersion === 4 || snapshot.schemaVersion === 5 || snapshot.schemaVersion === 6
          ? snapshot.activity.allocationModeCode
          : activity.allocationModeCode,
    });
    if (review.requestType === 'initial') {
      ensureInitialPublishable(activity);
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
      publishedByUserRole: user.role,
      at: now,
      // 审核 id 是这批联动效应的稳定批次键:同一次审批重放落在同一个 eventKey / cohortKey 上,
      // 不用墙钟(墙钟每次都是新批次,冻结与去重同时失效)。
      versionKey: `review:${review.id}`,
      auditMeta,
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
    const effect = await this.loadPublishedEffect(review.activityId, tx);
    let audienceRecipientMemberIds: string[] | null = null;
    let audienceCohort: FrozenRecipientCohort | null = null;
    if (audienceTagCodes !== null) {
      if (review.requestType !== 'initial') {
        throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      }
      if (!effect.isPublicRegistration) throw new BizException(BizCode.BAD_REQUEST);
      const cohort = await freezeAudienceTags(tx, {
        activityId: review.activityId,
        audienceTagCodes,
        audienceOrganizationIds,
        at: effect.publishedAt,
      });
      if (!isFrozenCohort(cohort)) throw new BizException(BizCode.BAD_REQUEST);
      audienceCohort = cohort;
      audienceRecipientMemberIds = [...cohort.memberIds];
      await this.audit.logAudienceTagsApproved({
        activityId: review.activityId,
        reviewId: review.id,
        requestVersion: review.requestVersion,
        actorUserId: user.id,
        actorRoleSnap: user.role,
        audienceTagCodes,
        audienceOrganizationIds,
        recipientCount: audienceRecipientMemberIds.length,
        auditMeta,
        tx,
      });
    } else {
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
    }
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
      cohort: await this.freezeReviewOutcomeRecipient(tx, review.id, recipientMemberId, now),
      approved: true,
    });
    if (review.requestType === 'initial') {
      if (audienceCohort === null) {
        await this.notificationProducer.enqueuePublished(tx, {
          ...effect,
          audience: await this.freezeBroadcastAudience(tx, review.activityId, effect.publishedAt),
        });
      } else {
        await this.notificationProducer.enqueuePublishedWithAudienceTags(tx, {
          ...effect,
          cohort: audienceCohort,
        });
      }
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
        cohort: await freezeRegistrationRoster(tx, {
          cohortKey: `activity-change:${review.activityId}:review:${review.id}`,
          aggregateType: 'activity',
          aggregateIds: [review.activityId],
          basisRef: [`review:${review.id}`],
          memberIds: [...new Set(identities.map((identity) => identity.memberId))],
          at: now,
        }),
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
        await lockActivity(seed.activityId, tx);
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
          cohort: await this.freezeReviewOutcomeRecipient(
            tx,
            review.id,
            recipientMemberId,
            reviewedAt,
          ),
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
      await lockActivity(seed.activityId, tx);
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
      resolvedConfig?:
        | ActivityTemplateResolution
        | ActivityTemplateResolutionWithRegistrationForm
        | ActivityTemplateResolutionWithQualificationRules
        | ActivityTemplateResolutionWithSnapshotV6;
      schemaVersion?: 2 | 3 | 4 | 5 | 6;
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
