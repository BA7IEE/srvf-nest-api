import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { claimAtStatus } from '../../common/prisma/claim-at-status.util';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import appConfig from '../../config/app.config';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  ActivityResponseDto,
  CancelActivityDto,
  PublishActivityDto,
  PublishActivityWithAudienceTagsDto,
} from './activities.dto';
import { toResponseDto } from './activity-presenter';
import { ActivityImageSigningService } from './activity-image-signing.service';
import { ActivityAuditRecorder } from './activity-audit-recorder';
import { ACTIVITY_PHASE_ENDED, deriveActivityPhase } from './activity-phase';
import { ActivityStateMachine } from './activity-state-machine';
import { ActivityNotificationProducer } from './activity-notification-producer';
import {
  freezeAudienceTags,
  freezeRegistrationRoster,
  isFrozenCohort,
} from './activity-recipient-freeze';
import { ActivityPublishReviewService } from './activity-publish-review.service';
import { ActivityAllocationModeService } from './activity-allocation-mode.service';
import { cancelActivityRegistrationLifecycle } from '../activity-registrations/activity-cancellation-lifecycle';
import { resolveEffectiveFacts } from './settlement-segment-projector';
import {
  ActivityAccessService,
  ACTIVE_REGISTRATION_STATUS_CODES,
  ACTIVITY_STATUS_PUBLISHED,
  ActivityFullRow,
  PrismaTx,
  activitySafeSelect,
} from './activity-access.service';

/*
 * 活动的**状态流转命令族**(Phase 6-B 第三域第三刀,§3.2)。
 *
 * 五式:softDelete / publish / cancel / cancelLocked / complete。
 *
 * ⚠️ 与既有 activity-lifecycle.service.ts 是**两个不同的族**,刻意不合并:
 * 那一个承载 v1.1 的 terminate / clone / seal(带 replay 与时间闸);本族是基础状态位流转。
 * 两者都有 cancel,但语义与前置不同 —— 合并会让「哪个 cancel」变成读代码时的猜测。
 *
 * ⚠️ cancelLocked 是**被调用方**(调用方已持锁):它不自己取 Activity 聚合根锁,
 * 锁序由调用方保证。挪动它的调用位置会静默破坏锁序,且不会有任何编译错或单测失败。
 */
@Injectable()
export class ActivityStatusCommandService {
  constructor(
    private readonly prisma: PrismaService,
    // P2-14 刀 A:封面 / 图集对外是现签 URL,presenter 纯函数不取数,故在此解析后传入。
    private readonly images: ActivityImageSigningService,
    // 同建单族:判权与聚合根装载经共享层,调用点在本类各方法体内。
    private readonly access: ActivityAccessService,
    private readonly activityAuditRecorder: ActivityAuditRecorder,
    private readonly activityStateMachine: ActivityStateMachine,
    private readonly allocationModes: ActivityAllocationModeService,
    private readonly notificationProducer: ActivityNotificationProducer,
    private readonly publishReviewService: ActivityPublishReviewService,
    @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
  ) {}

  private assertAudienceTagsHttpEnabled(): void {
    if (!this.config.activityAudienceTags.httpEnabled) {
      throw new BizException(BizCode.SERVICE_UNAVAILABLE);
    }
  }

  async softDelete(
    id: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
    authorization: 'rbac' | 'managed' = 'rbac',
  ): Promise<ActivityResponseDto> {
    if (authorization === 'rbac') {
      await this.access.assertCanOrThrow(currentUser, 'activity.delete.record', {
        type: 'activity',
        id,
      });
    } else if (!this.config.activityResponsibilityWorkflow.enabled) {
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    }
    return this.prisma.$transaction(async (tx) => {
      const current =
        authorization === 'managed'
          ? await this.access.lockAndFindManagedActivityOrThrow(id, currentUser, tx)
          : await this.access.lockAndFindActivityOrThrow(id, tx);
      if (authorization === 'managed') {
        // 与 PATCH 同一正向白名单：published 必须给出 change-review-required，而不是
        // 用 RBAC 或通用 status 码掩盖“应走变更审核”的语义。
        if (current.statusCode !== 'draft') {
          throw new BizException(
            current.statusCode === ACTIVITY_STATUS_PUBLISHED
              ? BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED
              : BizCode.ACTIVITY_STATUS_INVALID,
          );
        }
        const [reviewCount, registrationCount, attendanceSheetCount, checkInCount, identityCount] =
          await Promise.all([
            tx.activityPublishReview.count({ where: { activityId: current.id } }),
            tx.activityRegistration.count({ where: { activityId: current.id } }),
            tx.attendanceSheet.count({ where: { activityId: current.id } }),
            tx.activityCheckIn.count({ where: { activityId: current.id } }),
            tx.activityParticipationIdentity.count({ where: { activityId: current.id } }),
          ]);
        if (reviewCount > 0) {
          throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
        }
        if (
          registrationCount > 0 ||
          attendanceSheetCount > 0 ||
          checkInCount > 0 ||
          identityCount > 0
        ) {
          throw new BizException(BizCode.ACTIVITY_PARTICIPATION_EXISTS_DELETE_FORBIDDEN);
        }
      } else {
        if (
          this.config.activityResponsibilityWorkflow.enabled &&
          (await tx.activityPublishReview.count({
            where: { activityId: id, status: 'pending' },
          })) > 0
        ) {
          throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING);
        }

        const [activeRegistrations, attendanceSheets] = await Promise.all([
          tx.activityRegistration.count({
            where: notDeletedWhere({
              activityId: current.id,
              statusCode: { in: [...ACTIVE_REGISTRATION_STATUS_CODES] },
            }),
          }),
          tx.attendanceSheet.count({
            where: notDeletedWhere({ activityId: current.id }),
          }),
        ]);
        if (activeRegistrations > 0 || attendanceSheets > 0) {
          throw new BizException(BizCode.ACTIVITY_PARTICIPATION_EXISTS_DELETE_FORBIDDEN);
        }
      }

      await claimAtStatus(tx, {
        target: 'activity',
        id: current.id,
        expectedStatus: current.statusCode,
        invalidStatusBiz: BizCode.ACTIVITY_STATUS_INVALID,
      });
      const removed = await tx.activity.update({
        where: { id: current.id },
        data: { deletedAt: new Date() },
        select: activitySafeSelect,
      });

      await this.activityAuditRecorder.logSoftDelete({
        activityId: current.id,
        before: current,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        priorStatusCode: current.statusCode,
        auditMeta,
        tx,
      });

      return toResponseDto(removed, await this.images.signImages(removed));
    });
  }

  // 状态机:draft → published;其他状态 → 20030(沿 ActivityStateMachine publish decision)。
  async publish(
    id: string,
    dto: PublishActivityDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityResponseDto> {
    if (this.config.activityResponsibilityWorkflow.enabled) {
      if (dto.requiresInsuranceConfirmed !== true) {
        throw new BizException(BizCode.BAD_REQUEST);
      }
      await this.publishReviewService.compatibilityPublish(id, dto, currentUser, auditMeta);
      return this.access.findOne(id, currentUser);
    }
    await this.access.assertCanOrThrow(currentUser, 'activity.publish.record', {
      type: 'activity',
      id,
    });
    if (dto.requiresInsuranceConfirmed !== true) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    return this.prisma.$transaction(async (tx) => {
      const current = await this.access.lockAndFindActivityOrThrow(id, tx);
      await this.allocationModes.assertLockedActivityConsistent(tx, current);

      const transition = this.activityStateMachine.decide('publish', current.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }
      const { nextStatusCode } = transition;

      const now = new Date();
      if (current.endAt.getTime() <= now.getTime()) {
        throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
      }
      if (
        current.registrationDeadline !== null &&
        current.registrationDeadline.getTime() < now.getTime()
      ) {
        throw new BizException(BizCode.ACTIVITY_REGISTRATION_DEADLINE_PASSED);
      }

      await claimAtStatus(tx, {
        target: 'activity',
        id: current.id,
        expectedStatus: current.statusCode,
        invalidStatusBiz: BizCode.ACTIVITY_STATUS_INVALID,
      });
      const updated = await tx.activity.update({
        where: { id: current.id },
        data: {
          statusCode: nextStatusCode,
          publishedBy: currentUser.id,
          publishedAt: now,
        },
        select: activitySafeSelect,
      });

      await this.activityAuditRecorder.logPublish({
        activityId: current.id,
        before: current,
        after: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        priorStatusCode: current.statusCode,
        nextStatusCode,
        auditMeta,
        tx,
      });

      const broadcastAudience = await freezeAudienceTags(tx, {
        activityId: updated.id,
        audienceTagCodes: null,
        at: now,
      });
      if (isFrozenCohort(broadcastAudience)) throw new BizException(BizCode.BAD_REQUEST);
      await this.notificationProducer.enqueuePublished(tx, {
        audience: broadcastAudience,
        activityId: updated.id,
        activityTitle: updated.title,
        publishedAt: now,
        startAt: updated.startAt,
        location: updated.location,
        requiresInsurance: updated.requiresInsurance,
        isPublicRegistration: updated.isPublicRegistration,
      });
      return toResponseDto(updated, await this.images.signImages(updated));
    });
  }

  async publishWithAudienceTags(
    id: string,
    dto: PublishActivityWithAudienceTagsDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityResponseDto> {
    await this.access.assertCanOrThrow(currentUser, 'activity.publish.record', {
      type: 'activity',
      id,
    });
    this.assertAudienceTagsHttpEnabled();
    if (dto.requiresInsuranceConfirmed !== true) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    const audienceTagCodes = [...dto.audienceTagCodes].sort();
    // 组织定向(维护者 2026-08-25 拍板):省略 / 空数组 = 不按组织收窄,落库与盖章都保持
    // 本刀之前的形状;非空才进交集。稳定序与标签码同处置,便于事后对账与幂等哈希。
    const audienceOrganizationIds = [...(dto.audienceOrganizationIds ?? [])].sort();
    if (this.config.activityResponsibilityWorkflow.enabled) {
      await this.publishReviewService.compatibilityPublishWithAudienceTags(
        id,
        { requiresInsuranceConfirmed: true, audienceTagCodes, audienceOrganizationIds },
        currentUser,
        auditMeta,
      );
      return this.access.findOne(id, currentUser);
    }

    return this.prisma.$transaction(async (tx) => {
      const current = await this.access.lockAndFindActivityOrThrow(id, tx);
      if (!current.isPublicRegistration) {
        throw new BizException(BizCode.BAD_REQUEST);
      }
      await this.allocationModes.assertLockedActivityConsistent(tx, current);

      const transition = this.activityStateMachine.decide('publish', current.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }
      const { nextStatusCode } = transition;

      const now = new Date();
      if (current.endAt.getTime() <= now.getTime()) {
        throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
      }
      if (
        current.registrationDeadline !== null &&
        current.registrationDeadline.getTime() < now.getTime()
      ) {
        throw new BizException(BizCode.ACTIVITY_REGISTRATION_DEADLINE_PASSED);
      }

      await claimAtStatus(tx, {
        target: 'activity',
        id: current.id,
        expectedStatus: current.statusCode,
        invalidStatusBiz: BizCode.ACTIVITY_STATUS_INVALID,
      });
      const updated = await tx.activity.update({
        where: { id: current.id },
        data: {
          statusCode: nextStatusCode,
          publishedBy: currentUser.id,
          publishedAt: now,
        },
        select: activitySafeSelect,
      });

      const audienceCohort = await freezeAudienceTags(tx, {
        activityId: updated.id,
        audienceTagCodes,
        audienceOrganizationIds,
        at: now,
      });
      if (!isFrozenCohort(audienceCohort)) throw new BizException(BizCode.BAD_REQUEST);
      const recipientMemberIds = audienceCohort.memberIds;
      await this.activityAuditRecorder.logPublishWithAudienceTags({
        activityId: current.id,
        before: current,
        after: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        priorStatusCode: current.statusCode,
        nextStatusCode,
        audienceTagCodes,
        audienceOrganizationIds,
        recipientCount: recipientMemberIds.length,
        auditMeta,
        tx,
      });
      await this.notificationProducer.enqueuePublishedWithAudienceTags(tx, {
        activityId: updated.id,
        activityTitle: updated.title,
        publishedAt: now,
        startAt: updated.startAt,
        location: updated.location,
        requiresInsurance: updated.requiresInsurance,
        cohort: audienceCohort,
      });
      return toResponseDto(updated, await this.images.signImages(updated));
    });
  }

  // 状态机:* → cancelled;已 cancelled 拒重复(20030;沿 ActivityStateMachine cancel decision)。
  async cancel(
    id: string,
    dto: CancelActivityDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityResponseDto> {
    await this.access.assertCanOrThrow(currentUser, 'activity.cancel.record', {
      type: 'activity',
      id,
    });
    return this.prisma.$transaction(async (tx) => {
      const current = await this.access.lockAndFindActivityOrThrow(id, tx);

      return this.cancelLocked({ current, dto, currentUser, auditMeta, tx });
    });
  }

  /**
   * Admin cancel 与 App 生命周期 cancel 共用的取消闭环。此处刻意保留旧闭环的
   * 状态机、pending review 撤回、报名联动取消、audit 与 durable notification；
   * 只有 App 调用方可在同一 Activity 锁事务里额外写入它的 operationKey/hash。
   */
  async cancelLocked(args: {
    current: ActivityFullRow;
    dto: CancelActivityDto;
    currentUser: CurrentUserPayload;
    auditMeta: AuditMeta;
    tx: PrismaTx;
    idempotency?: { operationKey: string; requestHash: string };
  }): Promise<ActivityResponseDto> {
    const { current, dto, currentUser, auditMeta, tx, idempotency } = args;

    const transition = this.activityStateMachine.decide('cancel', current.statusCode);
    if (!transition.allowed) {
      throw new BizException(transition.biz);
    }
    const { nextStatusCode } = transition;

    // Admin 与 App lifecycle 调用方都已先持有同一 Activity 根锁。现场打卡也先锁
    // Activity，故在这里读取完整事件链可以把「第一条事实提交」与取消线性化：
    // 已被有效 void/replace 顶掉的事实不阻断，仍有效的任一事实则整笔取消零写拒绝。
    const punchEvents = await tx.attendancePunchEvent.findMany({
      where: { activityId: current.id },
      select: {
        id: true,
        eventTypeCode: true,
        occurredAt: true,
        supersedesEventId: true,
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
    if (resolveEffectiveFacts(punchEvents).length > 0) {
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    }

    const cancelledAt = new Date();

    if (this.config.activityResponsibilityWorkflow.enabled) {
      await this.publishReviewService.cancelPendingForActivity(current.id, tx);
    }

    await claimAtStatus(tx, {
      target: 'activity',
      id: current.id,
      expectedStatus: current.statusCode,
      invalidStatusBiz: BizCode.ACTIVITY_STATUS_INVALID,
    });

    // registration create 同样先锁 Activity；claim 后再取 active 收件集，确保等待期间提交、
    // 且会被本事务联动取消的新报名者不会漏出 commit 后的取消通知。
    const registrations = await tx.activityRegistration.findMany({
      where: notDeletedWhere({
        activityId: current.id,
        statusCode: { in: [...ACTIVE_REGISTRATION_STATUS_CODES] },
      }),
      select: { memberId: true },
    });
    const notificationMemberIds = [...new Set(registrations.map((row) => row.memberId))];

    const updated = await tx.activity.update({
      where: { id: current.id },
      data: {
        statusCode: nextStatusCode,
        cancelledBy: currentUser.id,
        cancelledAt,
        cancelReason: dto.cancelReason ?? null,
        ...(idempotency === undefined
          ? {}
          : {
              cancelOperationKey: idempotency.operationKey,
              cancelRequestHash: idempotency.requestHash,
            }),
      },
      select: activitySafeSelect,
    });

    const cancelledPending = await cancelActivityRegistrationLifecycle({
      activityId: current.id,
      actorUserId: currentUser.id,
      cancelledAt,
      cancelReason: '活动已取消',
      tx,
    });

    await this.activityAuditRecorder.logCancel({
      activityId: current.id,
      before: current,
      after: updated,
      actorUserId: currentUser.id,
      actorRoleSnap: currentUser.role,
      priorStatusCode: current.statusCode,
      nextStatusCode,
      cancelReason: dto.cancelReason ?? null,
      pendingRegistrationsCancelled: cancelledPending.cancelledRegistrationCount,
      auditMeta,
      tx,
    });

    await this.notificationProducer.enqueueCancellation(tx, {
      activityId: current.id,
      activityTitle: updated.title,
      cancelledAt,
      cancelReason: dto.cancelReason ?? null,
      cohort: await freezeRegistrationRoster(tx, {
        cohortKey: `activity-cancel:${current.id}:${cancelledAt.toISOString()}`,
        aggregateType: 'activity',
        aggregateIds: [current.id],
        basisRef: [`cancel:${current.id}`],
        memberIds: notificationMemberIds,
        at: cancelledAt,
      }),
    });
    return toResponseDto(updated, await this.images.signImages(updated));
  }

  // 状态机:published → completed;其他态拒(20030;沿 ActivityStateMachine complete decision)。
  // D2-a 唯一完结通路；attendances.submit 不再跨 aggregate 写 Activity.completed。
  // audit 复用 activity-audit-recorder 既有伞事件 'activity.publish'(extra.operation='complete')。
  // **不发通知**(完结不是需要通知报名者的事件;沿 publish 无通知范式,区别于 cancel)。
  async complete(
    id: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityResponseDto> {
    await this.access.assertCanOrThrow(currentUser, 'activity.complete.record', {
      type: 'activity',
      id,
    });
    return this.prisma.$transaction(async (tx) => {
      const current = await this.access.lockAndFindActivityOrThrow(id, tx);
      if (this.config.activityResponsibilityWorkflow.enabled) {
        await this.publishReviewService.assertNoPendingChangeReview(id, tx);
      }

      const transition = this.activityStateMachine.decide('complete', current.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }
      const { nextStatusCode } = transition;
      if (deriveActivityPhase(current.startAt, current.endAt) !== ACTIVITY_PHASE_ENDED) {
        throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
      }

      await claimAtStatus(tx, {
        target: 'activity',
        id: current.id,
        expectedStatus: current.statusCode,
        invalidStatusBiz: BizCode.ACTIVITY_STATUS_INVALID,
      });
      const updated = await tx.activity.update({
        where: { id: current.id },
        data: { statusCode: nextStatusCode },
        select: activitySafeSelect,
      });

      await this.activityAuditRecorder.logComplete({
        activityId: current.id,
        before: current,
        after: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        priorStatusCode: current.statusCode,
        nextStatusCode,
        auditMeta,
        tx,
      });

      return toResponseDto(updated, await this.images.signImages(updated));
    });
  }
}
