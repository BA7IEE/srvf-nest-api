import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { claimAtStatus } from '../../common/prisma/claim-at-status.util';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ActivityParticipationPolicy } from '../activities/activity-participation-policy';
import { hasActivityCapacity } from '../activities/activity-capacity';
import { promoteActivityWaitlistWithinCapacity } from '../activities/activity-waitlist-promotion';
import { InsuranceRequirementService } from '../insurances/insurance-requirement.service';
import { ActivityRegistrationAuditRecorder } from './activity-registration-audit-recorder';
import { ActivityAllocationService } from './activity-allocation.service';
import { ActivityRegistrationLifecycleService } from './activity-registration-lifecycle.service';
import {
  ActivityQualificationEvaluatorService,
  type ActivityQualificationEvaluation,
  type ActivityQualificationTarget,
} from './activity-qualification-evaluator.service';
import { ActivityRegistrationNotificationProducer } from './activity-registration-notification-producer';
import { ActivityRegistrationPresenter } from './activity-registration-presenter';
import { ActivityRegistrationStateMachine } from './activity-registration-state-machine';
import {
  ActivityRegistrationResponseDto,
  ApproveRegistrationDto,
  CancelRegistrationDto,
  RejectRegistrationDto,
} from './activity-registrations.dto';
import {
  ActivityRegistrationAccessService,
  PrismaTx,
  REGISTRATION_STATUS_PASS,
  RegistrationAuthorization,
  RegistrationFullRow,
  ReviewQualificationContext,
  registrationSafeSelect,
} from './activity-registration-access.service';

/*
 * 报名**审批族**(Phase 6-B 第三域第二刀 stage3,§3.2)。
 *
 * 四式:approve / reject / cancelAdmin / reopen,外加四个只服务于它们的助手
 * (容量解析、容量上限、资格评估、评审资格上下文构造)。
 *
 * ⚠️ 资格评估(evaluateQualificationForApproval / buildReviewQualificationContext)刻意随族迁来、
 * **未下放到共享层**:它们只被审批调用,放进共享层会让它们看起来像"多段都该过的前置",而它们不是。
 * ⚠️ 判权与锁序约束同建单族:判权在各自方法体内,聚合根锁先于 Registration 回读。
 */
@Injectable()
export class ActivityRegistrationReviewService {
  constructor(
    private readonly prisma: PrismaService,
    // 同建单族:判权与聚合根锁经共享层,但调用点在本类各方法体内。
    private readonly access: ActivityRegistrationAccessService,
    private readonly registrationAuditRecorder: ActivityRegistrationAuditRecorder,
    private readonly registrationStateMachine: ActivityRegistrationStateMachine,
    private readonly auditLogs: AuditLogsService,
    private readonly insuranceRequirement: InsuranceRequirementService,
    private readonly qualificationEvaluator: ActivityQualificationEvaluatorService,
    private readonly notificationProducer: ActivityRegistrationNotificationProducer,
    private readonly activityParticipationPolicy: ActivityParticipationPolicy,
    private readonly registrationLifecycle: ActivityRegistrationLifecycleService,
    private readonly allocations: ActivityAllocationService,
    private readonly presenter: ActivityRegistrationPresenter,
  ) {}

  private async resolveApproveCapacity(
    activityId: string,
    activityPositionId: string | null,
    activityCapacity: number | null,
    tx: PrismaTx,
  ): Promise<number | null> {
    if (activityPositionId !== null) {
      const activityPosition = await tx.activityPosition.findFirst({
        where: { id: activityPositionId, activityId, deletedAt: null },
        select: { capacity: true },
      });
      if (activityPosition === null) {
        throw new BizException(BizCode.ACTIVITY_POSITION_NOT_FOUND);
      }
      return activityPosition.capacity;
    }

    const liveActivityPosition = await tx.activityPosition.findFirst({
      where: { activityId, deletedAt: null },
      select: { id: true },
    });
    // P4：活动已存在岗位时，历史 null 岗位报名也不能再回退使用 Activity.capacity 判闸。
    return liveActivityPosition === null ? activityCapacity : null;
  }

  // capacity 复核(create / approve 共用)。pass 占名额(决议表 Q-D17)。
  private async assertCapacityNotExceeded(
    activityId: string,
    activityPositionId: string | null,
    activityCapacity: number | null,
    activityPositionCapacity: number | null,
    tx: PrismaTx,
  ): Promise<void> {
    if (activityCapacity === null && activityPositionCapacity === null) return;
    const [activityPassCount, activityPositionPassCount] = await Promise.all([
      tx.activityRegistration.count({
        where: notDeletedWhere({ activityId, statusCode: REGISTRATION_STATUS_PASS }),
      }),
      tx.activityRegistration.count({
        where: notDeletedWhere({
          activityId,
          activityPositionId,
          statusCode: REGISTRATION_STATUS_PASS,
        }),
      }),
    ]);
    if (
      !hasActivityCapacity({
        activityCapacity,
        activityPassCount,
        activityPositionCapacity,
        activityPositionPassCount,
      })
    ) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_EXCEEDED);
    }
  }

  private async evaluateQualificationForApproval(
    tx: PrismaTx,
    activity: { id: string; startAt: Date; endAt: Date },
    registration: Pick<RegistrationFullRow, 'id' | 'memberId' | 'currentRevision'>,
    hasActiveScopedRuleSet: boolean,
  ): Promise<{ context: ReviewQualificationContext; evaluation: ActivityQualificationEvaluation }> {
    const context = await this.buildReviewQualificationContext(tx, activity.id, registration);
    // A pre-v1.1 legacy head has neither a permanent session identity nor a recorded preference.
    // Once a scoped RuleSet exists, inferring either target would silently weaken that RuleSet.
    // Activity-only rules remain evaluable for those historical heads.
    if (hasActiveScopedRuleSet && context.identityCount === 0 && context.preferenceCount === 0) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_V11_FLOW_REQUIRED);
    }
    const evaluation = await this.qualificationEvaluator.evaluate({
      activity,
      memberId: registration.memberId,
      targets: context.targets,
      tx,
    });
    this.qualificationEvaluator.assertNoBlock(evaluation);
    return { context, evaluation };
  }

  private async buildReviewQualificationContext(
    tx: PrismaTx,
    activityId: string,
    registration: Pick<RegistrationFullRow, 'id' | 'currentRevision'>,
  ): Promise<ReviewQualificationContext> {
    let registrationRevisionId: string | null = null;
    if (registration.currentRevision > 0) {
      const revisions = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "ActivityRegistrationRevision"
        WHERE "registrationId" = ${registration.id}
          AND "revision" = ${registration.currentRevision}
        FOR SHARE
      `);
      if (revisions.length !== 1 || !revisions[0]) {
        throw new BizException(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
      }
      registrationRevisionId = revisions[0].id;
    }
    const identities = await tx.$queryRaw<
      Array<{ id: string; sessionId: string; currentStatusCode: string }>
    >(Prisma.sql`
      SELECT "id", "sessionId", "currentStatusCode"
      FROM "ActivityParticipationIdentity"
      WHERE "activityId" = ${activityId}
        AND "registrationId" = ${registration.id}
      ORDER BY "id" ASC
      FOR UPDATE
    `);
    const identityIdBySession = new Map<string, string>();
    for (const identity of identities) {
      if (identityIdBySession.has(identity.sessionId)) {
        throw new BizException(BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID);
      }
      if (identity.currentStatusCode !== 'cancelled' && identity.currentStatusCode !== 'rejected') {
        identityIdBySession.set(identity.sessionId, identity.id);
      }
    }
    const preferenceRows =
      registrationRevisionId === null
        ? []
        : await tx.$queryRaw<Array<{ sessionId: string; positionId: string }>>(Prisma.sql`
            SELECT "sessionId", "positionId"
            FROM "ActivityPositionPreference"
            WHERE "registrationRevisionId" = ${registrationRevisionId}
            ORDER BY "sessionId" ASC, "preferenceOrder" ASC, "positionId" ASC
            FOR SHARE
          `);
    const targets: ActivityQualificationTarget[] = [...identityIdBySession.keys()]
      .sort()
      .map((sessionId) => ({ sessionId, positionId: null }));
    for (const preference of preferenceRows) {
      if (!identityIdBySession.has(preference.sessionId)) {
        throw new BizException(BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID);
      }
      targets.push({ sessionId: preference.sessionId, positionId: preference.positionId });
    }
    return {
      registrationRevisionId,
      targets,
      identityIdBySession,
      identityCount: identities.length,
      preferenceCount: preferenceRows.length,
    };
  }

  async approve(
    activityId: string,
    id: string,
    dto: ApproveRegistrationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
    authorization: RegistrationAuthorization = 'authz',
  ): Promise<ActivityRegistrationResponseDto> {
    await this.access.assertCanOrThrow(currentUser, 'activity-registration.approve.record', {
      type: 'activity_registration',
      id,
    });
    const result = await this.prisma.$transaction(async (tx) => {
      await this.access.lockActivityForRegistrationCreate(activityId, tx);
      if (authorization === 'managed') {
        await this.access.assertManagedRegistrationAccess(activityId, currentUser, tx);
      }
      const reg = await this.access.findRegistrationOrThrow(activityId, id, tx);
      const observedTransition = this.registrationStateMachine.decide('approve', reg.statusCode);
      if (!observedTransition.allowed) {
        throw new BizException(observedTransition.biz);
      }

      // capacity 复核(approve 转 pass 占名额)。F11(#399):READ COMMITTED 下普通 COUNT 复核无行锁,
      // 两并发 approve 互不可见对方未提交写 → 双双过闸 → pass 超 capacity(原注释「事务内重新计数避免
      // race」不成立)。对 activity 行加 FOR UPDATE 排他锁,令同一 activity 的并发 approve 串行化:后到者
      // 阻塞至前者提交,再 COUNT 即见已提交 pass → 正确拒。仅限名额活动需锁(capacity=null 不限名额免锁)。
      if (authorization === 'authz') {
        await tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${activityId} FOR UPDATE`;
      }
      const act = await this.access.findActivityOrThrow(activityId, tx);
      await claimAtStatus(tx, {
        target: 'activityRegistration',
        id: reg.id,
        expectedStatus: reg.statusCode,
        invalidStatusBiz: BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
      });
      const lockedReg = await this.access.findRegistrationOrThrow(activityId, reg.id, tx);
      const transition = this.registrationStateMachine.decide('approve', lockedReg.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }
      const participationDecision = this.activityParticipationPolicy.canApprove(act);
      if (!participationDecision.allowed) {
        throw new BizException(participationDecision.biz);
      }
      // The Registration claim/currentRevision snapshot is fixed before insurance revalidation.
      // The following pre-read preserves MEMBER_NOT_FOUND / MEMBER_INACTIVE precedence; the
      // insurance service then locks/rereads the Member and exact source/evidence before capacity
      // or any registration/audit/outbox write.
      await this.access.assertMemberActiveSnapshot(lockedReg.memberId, tx);
      const [activeQualificationRuleSet, activeScopedQualificationRuleSet] = await Promise.all([
        tx.activityQualificationRuleSet.findFirst({
          where: { activityId, statusCode: 'active' },
          select: { id: true },
        }),
        tx.activityQualificationRuleSet.findFirst({
          where: {
            activityId,
            statusCode: 'active',
            OR: [{ sessionId: { not: null } }, { positionId: { not: null } }],
          },
          select: { id: true },
        }),
      ]);
      const reviewQualification =
        activeQualificationRuleSet === null
          ? null
          : await this.evaluateQualificationForApproval(
              tx,
              act,
              lockedReg,
              activeScopedQualificationRuleSet !== null,
            );
      await this.insuranceRequirement.revalidateActivityRegistrationApproval(
        {
          id: lockedReg.id,
          memberId: lockedReg.memberId,
          currentRevision: lockedReg.currentRevision,
        },
        act,
        tx,
      );
      const effectiveCapacity = await this.resolveApproveCapacity(
        activityId,
        lockedReg.activityPositionId,
        act.capacity,
        tx,
      );
      await this.assertCapacityNotExceeded(
        activityId,
        lockedReg.activityPositionId,
        act.capacity,
        effectiveCapacity,
        tx,
      );
      const reviewedAt = new Date();
      const updated = await tx.activityRegistration.update({
        where: { id: lockedReg.id },
        data: {
          statusCode: transition.nextStatusCode,
          reviewedBy: currentUser.id,
          reviewedAt,
          reviewNote: dto.reviewNote ?? null,
        },
        select: registrationSafeSelect,
      });
      if (
        reviewQualification !== null &&
        reviewQualification.evaluation.snapshotCandidates.length > 0
      ) {
        if (reviewQualification.context.registrationRevisionId === null) {
          throw new BizException(BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID);
        }
        await this.qualificationEvaluator.appendSnapshots({
          evaluation: reviewQualification.evaluation,
          phase: 'review',
          registrationRevisionId: reviewQualification.context.registrationRevisionId,
          identityIdBySession: reviewQualification.context.identityIdBySession,
          tx,
        });
      }

      await this.registrationAuditRecorder.logReview({
        registrationId: lockedReg.id,
        before: lockedReg,
        after: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        action: 'approve',
        priorStatusCode: lockedReg.statusCode,
        nextStatusCode: transition.nextStatusCode,
        activityId,
        targetMemberId: lockedReg.memberId,
        auditMeta,
        tx,
      });

      await this.notificationProducer.enqueueReview(tx, {
        registrationId: updated.id,
        activityId,
        memberId: updated.memberId,
        reviewedAt,
        outcome: 'approved',
        reviewNote: dto.reviewNote ?? null,
      });
      return this.presenter.toResponseDto(updated);
    });

    return result;
  }

  async reject(
    activityId: string,
    id: string,
    dto: RejectRegistrationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
    authorization: RegistrationAuthorization = 'authz',
  ): Promise<ActivityRegistrationResponseDto> {
    await this.access.assertCanOrThrow(currentUser, 'activity-registration.reject.record', {
      type: 'activity_registration',
      id,
    });
    const result = await this.prisma.$transaction(async (tx) => {
      await this.access.lockActivityForRegistrationCreate(activityId, tx);
      if (authorization === 'managed') {
        await this.access.assertManagedRegistrationAccess(activityId, currentUser, tx);
      }
      const reg = await this.access.findRegistrationOrThrow(activityId, id, tx);

      const transition = this.registrationStateMachine.decide('reject', reg.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }

      await claimAtStatus(tx, {
        target: 'activityRegistration',
        id: reg.id,
        expectedStatus: reg.statusCode,
        invalidStatusBiz: BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
      });
      const lockedReg = await this.access.findRegistrationOrThrow(activityId, reg.id, tx);
      const reviewedAt = new Date();
      await this.registrationLifecycle.rejectInTransactionTrusted(tx, {
        activityId,
        registrationId: lockedReg.id,
        memberId: lockedReg.memberId,
        actorUserId: currentUser.id,
        reviewNote: dto.reviewNote,
        reviewedAt,
      });
      const updated = await tx.activityRegistration.update({
        where: { id: lockedReg.id },
        data: {
          statusCode: transition.nextStatusCode,
          statusSummaryCode: 'not_selected',
          reviewedBy: currentUser.id,
          reviewedAt,
          reviewNote: dto.reviewNote,
        },
        select: registrationSafeSelect,
      });

      await this.registrationAuditRecorder.logReview({
        registrationId: lockedReg.id,
        before: lockedReg,
        after: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        action: 'reject',
        priorStatusCode: lockedReg.statusCode,
        nextStatusCode: transition.nextStatusCode,
        activityId,
        targetMemberId: lockedReg.memberId,
        auditMeta,
        tx,
      });

      await this.notificationProducer.enqueueReview(tx, {
        registrationId: updated.id,
        activityId,
        memberId: updated.memberId,
        reviewedAt,
        outcome: 'rejected',
        reviewNote: dto.reviewNote,
      });
      return this.presenter.toResponseDto(updated);
    });

    return result;
  }

  async cancelAdmin(
    activityId: string,
    id: string,
    dto: CancelRegistrationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
    authorization: RegistrationAuthorization = 'authz',
  ): Promise<ActivityRegistrationResponseDto> {
    await this.access.assertCanOrThrow(currentUser, 'activity-registration.cancel.record', {
      type: 'activity_registration',
      id,
    });
    const result = await this.prisma.$transaction(async (tx) => {
      await this.access.lockActivityForRegistrationCreate(activityId, tx);
      if (authorization === 'managed') {
        await this.access.assertManagedRegistrationAccess(activityId, currentUser, tx);
      }
      const reg = await this.access.findRegistrationOrThrow(activityId, id, tx);

      const transition = this.registrationStateMachine.decide('cancel', reg.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }

      await claimAtStatus(tx, {
        target: 'activityRegistration',
        id: reg.id,
        expectedStatus: reg.statusCode,
        invalidStatusBiz: BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
      });
      const lockedReg = await this.access.findRegistrationOrThrow(activityId, reg.id, tx);
      // 参与域生命周期收口⑦:已有 live 考勤记录或签到证据的报名禁取消。
      await this.access.assertNoParticipationEvidence(lockedReg.id, tx);

      const cancelledAt = new Date();
      await this.registrationLifecycle.cancelInTransactionTrusted(tx, {
        activityId,
        registrationId: lockedReg.id,
        memberId: lockedReg.memberId,
        actorUserId: currentUser.id,
        sourceCode: 'admin',
        cancelReason: dto.cancelReason ?? null,
        cancelledAt,
      });
      const updated = await this.access.findRegistrationOrThrow(activityId, lockedReg.id, tx);

      await this.registrationAuditRecorder.logCancel({
        registrationId: lockedReg.id,
        before: lockedReg,
        after: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        priorStatusCode: lockedReg.statusCode,
        nextStatusCode: transition.nextStatusCode,
        cancelledByPath: 'admin',
        cancelReason: dto.cancelReason ?? null,
        activityId,
        targetMemberId: lockedReg.memberId,
        auditMeta,
        tx,
      });

      const allocationPromotion =
        lockedReg.statusCode === REGISTRATION_STATUS_PASS
          ? await this.allocations.promoteAfterCancellationInTransactionTrusted(tx, {
              activityId,
              registrationId: lockedReg.id,
              actorUser: currentUser,
              promotedAt: cancelledAt,
              auditMeta,
            })
          : { handled: false, activityTitle: '活动', promoted: [] };
      const promotion = allocationPromotion.handled
        ? allocationPromotion
        : lockedReg.statusCode === REGISTRATION_STATUS_PASS
          ? await promoteActivityWaitlistWithinCapacity({
              activityId,
              activityPositionId: lockedReg.activityPositionId,
              maxPromotions: 1,
              actorUserId: currentUser.id,
              actorRoleSnap: currentUser.role,
              auditMeta,
              tx,
              auditLogs: this.auditLogs,
            })
          : { activityTitle: '活动', promoted: [] };

      if (!allocationPromotion.handled) {
        await this.notificationProducer.enqueueWaitlistPromotions(tx, {
          activityTitle: promotion.activityTitle,
          promoted: promotion.promoted,
        });
      }
      return this.presenter.toResponseDto(updated);
    });

    return result;
  }

  // 参与域生命周期收口②(v0.40.0):撤销驳回、回待审。状态机新边 reject → pending;其余态
  // ACTIVITY_REGISTRATION_STATUS_INVALID。置 pending 同时清空 reviewedBy / reviewedAt / reviewNote
  // (回到"从未审过"形态);**刻意不开 reject → pass 直通**(改判必须重走审批)。audit 复用
  // registration.review 事件、extra.action='reopen'(不发通知——后续 approve/reject 才发结果);
  // reopen 不占 capacity(pending 不计数)。判权沿 approve 范式带 ref {type:'activity_registration', id}。
  async reopen(
    activityId: string,
    id: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
    authorization: RegistrationAuthorization = 'authz',
  ): Promise<ActivityRegistrationResponseDto> {
    await this.access.assertCanOrThrow(currentUser, 'activity-registration.reopen.record', {
      type: 'activity_registration',
      id,
    });
    return this.prisma.$transaction(async (tx) => {
      await this.access.lockActivityForRegistrationCreate(activityId, tx);
      if (authorization === 'managed') {
        await this.access.assertManagedRegistrationAccess(activityId, currentUser, tx);
      }
      const reg = await this.access.findRegistrationOrThrow(activityId, id, tx);

      const transition = this.registrationStateMachine.decide('reopen', reg.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }

      await claimAtStatus(tx, {
        target: 'activityRegistration',
        id: reg.id,
        expectedStatus: reg.statusCode,
        invalidStatusBiz: BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
      });
      const lockedReg = await this.access.findRegistrationOrThrow(activityId, reg.id, tx);
      await this.registrationLifecycle.reopenInTransactionTrusted(tx, {
        activityId,
        registrationId: lockedReg.id,
        memberId: lockedReg.memberId,
        actorUserId: currentUser.id,
        reopenedAt: new Date(),
      });
      const updated = await tx.activityRegistration.update({
        where: { id: lockedReg.id },
        data: {
          statusCode: transition.nextStatusCode,
          statusSummaryCode: 'active',
          reviewedBy: null,
          reviewedAt: null,
          reviewNote: null,
        },
        select: registrationSafeSelect,
      });

      await this.registrationAuditRecorder.logReview({
        registrationId: lockedReg.id,
        before: lockedReg,
        after: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        action: 'reopen',
        priorStatusCode: lockedReg.statusCode,
        nextStatusCode: transition.nextStatusCode,
        activityId,
        targetMemberId: lockedReg.memberId,
        auditMeta,
        tx,
      });

      return this.presenter.toResponseDto(updated);
    });
  }
}
