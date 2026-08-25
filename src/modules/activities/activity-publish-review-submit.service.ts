import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  ActivityPublishReviewResponseDto,
  ChangeReviewDto,
  SubmitActivityPublishReviewDto,
} from './activity-publish-review.dto';
import { ActivityPublishReviewAuditRecorder } from './activity-publish-review-audit-recorder';
import {
  ActivityPublishReviewPresenter,
  type ActivityPublishReviewViewRow,
  activityPublishReviewViewSelect,
} from './activity-publish-review-presenter';
import { ActivityPublishReviewStateMachine } from './activity-publish-review-state-machine';
import { ActivityResponsibilityPolicy } from './activity-responsibility-policy';
import type { UpdateActivityDto } from './activities.dto';
import type { AppActivityChangePositionDto } from './dto/app/app-managed-activity.dto';
import { ActivityProposalValidator } from './activity-proposal-validator';
import { ActivityAllocationModeService } from './activity-allocation-mode.service';
import {
  ActivityPublishProposalV2Service,
  type ActivityTemplateResolution,
} from './activity-publish-proposal-v2.service';
import {
  assertActiveOrganizationIds,
  buildProposalSnapshot,
  ensureInitialPublishable,
  lockActivity,
  resolveActiveAudienceTagIds,
  type PrismaTx,
} from './activity-publish-review-access';
import {
  activityPublishReviewIdempotencySelect,
  hashCanonical,
} from './activity-publish-review-idempotency';

/**
 * 发布审核 —— **提交/直发命令族**。
 *
 * 边界:活动发起人侧的 initial submit / change submit / V2 proposal / 模板解析 /
 * 兼容直发(含受众标签)。审核侧(approve / return / withdraw / cancel)留在
 * ActivityPublishReviewService,两者共用 activity-publish-review-access 的事务原语
 * 与 activity-publish-review-idempotency 的哈希/重放投影。
 *
 * ⚠️ 本类**自持**提交路径的 `prisma.$transaction`(与拆分前逐字一致),
 * 这不是把事务所有权下放给 Query/Policy —— 它就是提交命令的 application service。
 * 锁序仍为 Activity → review,不得反转。
 */
@Injectable()
export class ActivityPublishReviewSubmitService {
  private readonly logger = new Logger(ActivityPublishReviewSubmitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stateMachine: ActivityPublishReviewStateMachine,
    private readonly presenter: ActivityPublishReviewPresenter,
    private readonly audit: ActivityPublishReviewAuditRecorder,
    private readonly responsibilityPolicy: ActivityResponsibilityPolicy,
    private readonly proposalValidator: ActivityProposalValidator,
    private readonly proposalV2: ActivityPublishProposalV2Service,
    private readonly allocationModes: ActivityAllocationModeService,
  ) {}

  async submitInitial(
    activityId: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityPublishReviewResponseDto> {
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        await lockActivity(activityId, tx);
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
        ensureInitialPublishable(activity);
        const decision = this.stateMachine.decide('submit');
        if (!decision.allowed) throw new BizException(decision.biz);
        const review = await tx.activityPublishReview.create({
          data: {
            activityId,
            requestType: 'initial',
            requestVersion: await this.nextRequestVersion(activityId, tx),
            baseRevision: activity.workflowRevision,
            status: decision.nextStatus,
            snapshot: await buildProposalSnapshot(activityId, tx),
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
        await lockActivity(activityId, tx);
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
    return this.submitInitialProposalInternal(activityId, dto, user, auditMeta, null);
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
        await lockActivity(activityId, tx);
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
      await lockActivity(activityId, tx);
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

  async compatibilityPublishWithAudienceTags(
    activityId: string,
    dto: {
      requiresInsuranceConfirmed: boolean;
      audienceTagCodes: string[];
      audienceOrganizationIds: string[];
    },
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityPublishReviewResponseDto> {
    if (dto.requiresInsuranceConfirmed !== true) throw new BizException(BizCode.BAD_REQUEST);
    const pending = await this.prisma.activityPublishReview.findFirst({
      where: { activityId, requestType: 'initial', status: 'pending' },
      select: activityPublishReviewViewSelect,
    });
    if (pending) {
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
    return this.submitInitialProposalInternal(
      activityId,
      { operationKey: `compat-publish-audience:${randomUUID()}`, confirmation: true },
      user,
      auditMeta,
      dto.audienceTagCodes,
      dto.audienceOrganizationIds,
    );
  }

  private async submitInitialProposalInternal(
    activityId: string,
    dto: SubmitActivityPublishReviewDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
    audienceTagCodes: string[] | null,
    audienceOrganizationIds: string[] = [],
  ): Promise<ActivityPublishReviewResponseDto> {
    // 幂等哈希:不按组织定向时 payload 逐字节沿用本刀之前的形状 —— 否则同一 operationKey 的
    // 存量 pending 提交会算出新哈希,replay 对不上,当场变成「幂等键冲突」而不是幂等命中。
    const requestHash =
      audienceTagCodes === null
        ? this.submitRequestHash('initial', activityId, dto)
        : audienceOrganizationIds.length === 0
          ? hashCanonical({ requestType: 'initial', activityId, dto, audienceTagCodes })
          : hashCanonical({
              requestType: 'initial',
              activityId,
              dto,
              audienceTagCodes,
              audienceOrganizationIds,
            });
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        await lockActivity(activityId, tx);
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
            isPublicRegistration: true,
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
        ensureInitialPublishable(activity);
        if (audienceTagCodes !== null) {
          if (!activity.isPublicRegistration) throw new BizException(BizCode.BAD_REQUEST);
          await resolveActiveAudienceTagIds(tx, audienceTagCodes);
          await assertActiveOrganizationIds(tx, audienceOrganizationIds);
        }
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
            ...(audienceTagCodes === null
              ? {}
              : {
                  audienceTagCodes: JSON.parse(
                    JSON.stringify(audienceTagCodes),
                  ) as Prisma.InputJsonValue,
                }),
            // 组织定向:不按组织收窄时**整列不写**,存量与新行一律留 NULL,读回即 legacy 语义。
            ...(audienceTagCodes === null || audienceOrganizationIds.length === 0
              ? {}
              : {
                  audienceOrganizationIds: JSON.parse(
                    JSON.stringify(audienceOrganizationIds),
                  ) as Prisma.InputJsonValue,
                }),
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

  private async nextRequestVersion(activityId: string, tx: PrismaTx): Promise<number> {
    const latest = await tx.activityPublishReview.aggregate({
      where: { activityId },
      _max: { requestVersion: true },
    });
    return (latest._max.requestVersion ?? 0) + 1;
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
}
