import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { claimAtStatus } from '../../common/prisma/claim-at-status.util';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { canonicalize } from './settlement-content-hash';
import { ActivityAuditRecorder } from './activity-audit-recorder';
import { ActivityInitiationPolicy } from './activity-initiation-policy';
import { ActivityResponsibilityPolicy } from './activity-responsibility-policy';
import { ActivityStateMachine } from './activity-state-machine';
import { ActivitiesService, type ActivityFullRow } from './activities.service';
import { EvidenceSealService, type EvidenceSealResult } from './evidence-seal.service';
import { RegistrationFormVersionService } from './registration-form-version.service';
import { QualificationRuleSetVersionService } from './qualification-rule-set-version.service';

type PrismaTx = Prisma.TransactionClient;

export interface ActivityLifecycleResult {
  activityId: string;
  statusCode: 'cancelled' | 'terminated';
  occurredAt: Date;
  reason: string | null;
}

export interface ActivityCloneCommand {
  title?: string;
  organizationId?: string;
}

const cloneSourceSelect = {
  id: true,
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
  registrationModeCode: true,
  visibilityCode: true,
  defaultCheckInRadiusMeters: true,
  defaultLocationRequired: true,
  archiveWaitingDays: true,
  registrationSchema: true,
  coverImageUrl: true,
  galleryImageUrls: true,
  content: true,
  locationLongitude: true,
  locationLatitude: true,
  sessions: {
    where: { deletedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      code: true,
      name: true,
      startAt: true,
      endAt: true,
      locationText: true,
      meetingPoint: true,
      executionPoint: true,
      evacuationPoint: true,
      longitude: true,
      latitude: true,
      capacity: true,
      checkInOpenAt: true,
      checkInCloseAt: true,
      checkOutOpenAt: true,
      checkOutCloseAt: true,
      preparationStartAt: true,
      locationRequired: true,
      radiusMeters: true,
      locationPolicySourceCode: true,
      accuracyWarningMeters: true,
      lateGraceMinutes: true,
      earlyLeaveThresholdMinutes: true,
      sortOrder: true,
      positions: {
        where: { deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          code: true,
          name: true,
          attendanceRoleCode: true,
          capacity: true,
          startAt: true,
          endAt: true,
          genderRequirementCode: true,
          locationRequired: true,
          radiusMeters: true,
          description: true,
          equipmentNotes: true,
          sortOrder: true,
        },
      },
    },
  },
} as const satisfies Prisma.ActivitySelect;

const cloneCreatedAuditSelect = {
  id: true,
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
  statusCode: true,
  publishedBy: true,
  publishedAt: true,
  cancelledBy: true,
  cancelledAt: true,
  cancelReason: true,
  isPublicRegistration: true,
  registrationSchema: true,
  coverImageUrl: true,
  galleryImageUrls: true,
  content: true,
  locationLongitude: true,
  locationLatitude: true,
} as const satisfies Prisma.ActivitySelect;

function buildLifecycleRequestHash(
  action: 'cancel' | 'terminate',
  activityId: string,
  input: { reason: string; strongConfirmed?: boolean; operationKey: string },
): string {
  // `operationKey` 进 canonical payload 不是安全边界，但让 hash 自描述；action/activityId
  // 则保证取消与终止、不同活动不能把同一 key 误判为同一请求。
  const canonical = canonicalize({
    action,
    activityId,
    operationKey: input.operationKey,
    reason: input.reason,
    ...(input.strongConfirmed === undefined ? {} : { strongConfirmed: input.strongConfirmed }),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

@Injectable()
export class ActivityLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activities: ActivitiesService,
    private readonly stateMachine: ActivityStateMachine,
    private readonly responsibilityPolicy: ActivityResponsibilityPolicy,
    private readonly initiationPolicy: ActivityInitiationPolicy,
    private readonly auditRecorder: ActivityAuditRecorder,
    private readonly evidenceSeal: EvidenceSealService,
    private readonly registrationForms: RegistrationFormVersionService,
    private readonly qualificationRules: QualificationRuleSetVersionService,
  ) {}

  async cancel(
    activityId: string,
    command: { reason: string; strongConfirmed: boolean; operationKey: string },
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityLifecycleResult> {
    if (command.strongConfirmed !== true) throw new BizException(BizCode.BAD_REQUEST);
    const requestHash = buildLifecycleRequestHash('cancel', activityId, command);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const current = await this.activities.lockActivityForLifecycle(activityId, tx);
        await this.assertLifecycleAuthority(tx, current, user);

        const replay = await this.findCancelReplay(tx, command.operationKey, requestHash);
        if (replay) return replay;

        this.assertCancelTimeGate(
          await this.readAuthoritativeNow(tx),
          await this.firstSessionStart(tx, current),
        );
        const updated = await this.activities.cancelLocked({
          current,
          dto: { cancelReason: command.reason },
          currentUser: user,
          auditMeta,
          tx,
          idempotency: { operationKey: command.operationKey, requestHash },
        });
        if (updated.cancelledAt === null) throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
        return {
          activityId: updated.id,
          statusCode: 'cancelled',
          occurredAt: updated.cancelledAt,
          reason: updated.cancelReason,
        };
      });
    } catch (error) {
      this.rethrowOperationKeyConflict(error);
    }
  }

  async terminate(
    activityId: string,
    command: { reason: string; operationKey: string },
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityLifecycleResult> {
    const requestHash = buildLifecycleRequestHash('terminate', activityId, command);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const current = await this.activities.lockActivityForLifecycle(activityId, tx);
        await this.assertLifecycleAuthority(tx, current, user);

        const replay = await this.findTerminateReplay(tx, command.operationKey, requestHash);
        if (replay) return replay;

        const transition = this.stateMachine.decide('terminate', current.statusCode);
        if (!transition.allowed) throw new BizException(transition.biz);
        const terminatedAt = await this.readAuthoritativeNow(tx);
        this.assertTerminateTimeGate(terminatedAt, await this.firstSessionStart(tx, current));

        await claimAtStatus(tx, {
          target: 'activity',
          id: current.id,
          expectedStatus: current.statusCode,
          invalidStatusBiz: BizCode.ACTIVITY_STATUS_INVALID,
        });
        const updated = await tx.activity.update({
          where: { id: current.id },
          data: {
            statusCode: transition.nextStatusCode,
            terminatedAt,
            terminatedByUserId: user.id,
            terminationReason: command.reason,
            terminateOperationKey: command.operationKey,
            terminateRequestHash: requestHash,
          },
          select: {
            id: true,
            statusCode: true,
            terminatedAt: true,
            terminatedByUserId: true,
            terminationReason: true,
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
            publishedBy: true,
            publishedAt: true,
            cancelledBy: true,
            cancelledAt: true,
            cancelReason: true,
            isPublicRegistration: true,
            registrationSchema: true,
            coverImageUrl: true,
            galleryImageUrls: true,
            content: true,
            locationLongitude: true,
            locationLatitude: true,
          },
        });
        await this.auditRecorder.logTerminate({
          activityId: current.id,
          before: current,
          after: updated,
          actorUserId: user.id,
          actorRoleSnap: user.role,
          priorStatusCode: current.statusCode,
          nextStatusCode: transition.nextStatusCode,
          terminatedAt,
          terminationReason: command.reason,
          auditMeta,
          tx,
        });
        if (updated.terminatedAt === null) throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
        return {
          activityId: updated.id,
          statusCode: 'terminated',
          occurredAt: updated.terminatedAt,
          reason: updated.terminationReason,
        };
      });
    } catch (error) {
      this.rethrowOperationKeyConflict(error);
    }
  }

  async clone(
    activityId: string,
    command: ActivityCloneCommand,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<{ activityId: string }> {
    return await this.prisma.$transaction(async (tx) => {
      const current = await this.activities.lockActivityForLifecycle(activityId, tx);
      await this.assertLifecycleAuthority(tx, current, user);
      const source = await tx.activity.findFirst({
        where: { id: current.id, deletedAt: null },
        select: cloneSourceSelect,
      });
      if (!source) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);

      const targetOrganizationId = command.organizationId ?? source.organizationId;
      const initiatorMemberId = await this.initiationPolicy.resolveInitiator(
        user,
        targetOrganizationId,
        undefined,
        tx,
      );
      const created = await tx.activity.create({
        data: {
          title: command.title ?? source.title,
          activityTypeCode: source.activityTypeCode,
          organizationId: targetOrganizationId,
          startAt: source.startAt,
          endAt: source.endAt,
          location: source.location,
          description: source.description,
          capacity: source.capacity,
          genderRequirementCode: source.genderRequirementCode,
          registrationDeadline: source.registrationDeadline,
          registrationNotes: source.registrationNotes,
          statusCode: 'draft',
          initiatorMemberId,
          workflowRevision: 0,
          publishedBy: null,
          publishedAt: null,
          cancelledBy: null,
          cancelledAt: null,
          cancelReason: null,
          terminatedAt: null,
          terminatedByUserId: null,
          terminationReason: null,
          cancelOperationKey: null,
          cancelRequestHash: null,
          terminateOperationKey: null,
          terminateRequestHash: null,
          attendanceDeclaredCompleteAt: null,
          attendanceDeclaredCompleteByUserId: null,
          isPublicRegistration: source.isPublicRegistration,
          requiresInsurance: source.requiresInsurance,
          registrationModeCode: source.registrationModeCode,
          visibilityCode: source.visibilityCode,
          defaultCheckInRadiusMeters: source.defaultCheckInRadiusMeters,
          defaultLocationRequired: source.defaultLocationRequired,
          archiveWaitingDays: source.archiveWaitingDays,
          currentEvidenceRevision: 0,
          currentPopulationRevision: 0,
          currentClosureRevision: null,
          registrationSchema: source.registrationSchema ?? Prisma.JsonNull,
          coverImageUrl: source.coverImageUrl,
          galleryImageUrls: source.galleryImageUrls ?? Prisma.JsonNull,
          content: source.content ?? Prisma.JsonNull,
          locationLongitude: source.locationLongitude,
          locationLatitude: source.locationLatitude,
        },
        select: cloneCreatedAuditSelect,
      });

      const sessionIds = new Map<string, string>();
      const positionIds = new Map<string, string>();
      for (const sourceSession of source.sessions) {
        const createdSession = await tx.activitySession.create({
          data: {
            activityId: created.id,
            code: sourceSession.code,
            name: sourceSession.name,
            startAt: sourceSession.startAt,
            endAt: sourceSession.endAt,
            locationText: sourceSession.locationText,
            meetingPoint: sourceSession.meetingPoint,
            executionPoint: sourceSession.executionPoint,
            evacuationPoint: sourceSession.evacuationPoint,
            longitude: sourceSession.longitude,
            latitude: sourceSession.latitude,
            capacity: sourceSession.capacity,
            checkInOpenAt: sourceSession.checkInOpenAt,
            checkInCloseAt: sourceSession.checkInCloseAt,
            checkOutOpenAt: sourceSession.checkOutOpenAt,
            checkOutCloseAt: sourceSession.checkOutCloseAt,
            preparationStartAt: sourceSession.preparationStartAt,
            locationRequired: sourceSession.locationRequired,
            radiusMeters: sourceSession.radiusMeters,
            locationPolicySourceCode: sourceSession.locationPolicySourceCode,
            accuracyWarningMeters: sourceSession.accuracyWarningMeters,
            lateGraceMinutes: sourceSession.lateGraceMinutes,
            earlyLeaveThresholdMinutes: sourceSession.earlyLeaveThresholdMinutes,
            terminationCheckOutDeadline: null,
            statusCode: 'scheduled',
            workflowRevision: 0,
            sortOrder: sourceSession.sortOrder,
          },
          select: { id: true },
        });
        sessionIds.set(sourceSession.id, createdSession.id);
        for (const position of sourceSession.positions) {
          const createdPosition = await tx.activitySessionPosition.create({
            data: {
              activityId: created.id,
              sessionId: createdSession.id,
              code: position.code,
              name: position.name,
              attendanceRoleCode: position.attendanceRoleCode,
              capacity: position.capacity,
              startAt: position.startAt,
              endAt: position.endAt,
              genderRequirementCode: position.genderRequirementCode,
              qualificationRuleSetId: null,
              locationRequired: position.locationRequired,
              radiusMeters: position.radiusMeters,
              leaderMemberId: null,
              description: position.description,
              equipmentNotes: position.equipmentNotes,
              sortOrder: position.sortOrder,
            },
            select: { id: true },
          });
          positionIds.set(position.id, createdPosition.id);
        }
      }

      await this.registrationForms.cloneFromSource(tx, source.id, current.statusCode, created.id);
      await this.qualificationRules.cloneFromSource(tx, {
        sourceActivityId: source.id,
        sourceStatus: current.statusCode,
        targetActivityId: created.id,
        sessionIds,
        positionIds,
      });

      await this.auditRecorder.logClone({
        sourceActivityId: source.id,
        created,
        actorUserId: user.id,
        actorRoleSnap: user.role,
        auditMeta,
        tx,
      });
      return { activityId: created.id };
    });
  }

  async seal(
    activityId: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<EvidenceSealResult> {
    // EvidenceSealService 仍拥有它的 Activity 行锁、缺口检查和结果形状；这里唯一接入
    // 负责人锚，并把 service 的成功值/异常原样交给 HTTP 层。
    return await this.evidenceSeal.seal(activityId, user, auditMeta, async (tx) => {
      await this.responsibilityPolicy.assertOwnerOrOverride(tx, activityId, user);
    });
  }

  private async assertLifecycleAuthority(
    tx: PrismaTx,
    current: ActivityFullRow,
    user: CurrentUserPayload,
  ): Promise<void> {
    // 草稿没有责任行是既定模型，取消/clone 的草稿路径以 initiator 为锚；发布后及所有
    // 后续状态则只认 active owner（或既有 override），不能把协办人当负责人。
    if (current.statusCode === 'draft') {
      await this.responsibilityPolicy.assertInitiatorOrOverride(tx, current.id, user);
      return;
    }
    // 操作者在自己刚写成终态后重放同一 key 时，草稿已不再是 draft、也可能没有
    // responsibility row；只允许实际终态写入者穿过这一窄缝，随后仍须 hash 精确相同
    // 才会返回原结果，不能把它变成“任何人可凭终态重放”的旁路。
    if (
      (current.statusCode === 'cancelled' && current.cancelledBy === user.id) ||
      (current.statusCode === 'terminated' && current.terminatedByUserId === user.id)
    ) {
      return;
    }
    await this.responsibilityPolicy.assertOwnerOrOverride(tx, current.id, user);
  }

  private async readAuthoritativeNow(tx: PrismaTx): Promise<Date> {
    const rows = await tx.$queryRaw<Array<{ authoritativeNow: Date }>>`
      SELECT now() AS "authoritativeNow"
    `;
    const now = rows[0]?.authoritativeNow;
    if (!now) throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    return now;
  }

  private async firstSessionStart(tx: PrismaTx, current: ActivityFullRow): Promise<Date> {
    const firstSession = await tx.activitySession.findFirst({
      where: {
        activityId: current.id,
        deletedAt: null,
        statusCode: { not: 'cancelled' },
      },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
      select: { startAt: true },
    });
    return firstSession?.startAt ?? current.startAt;
  }

  private assertCancelTimeGate(authoritativeNow: Date, firstSessionStart: Date): void {
    if (authoritativeNow.getTime() >= firstSessionStart.getTime()) {
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    }
  }

  private assertTerminateTimeGate(authoritativeNow: Date, firstSessionStart: Date): void {
    if (authoritativeNow.getTime() < firstSessionStart.getTime()) {
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    }
  }

  private async findCancelReplay(
    tx: PrismaTx,
    operationKey: string,
    requestHash: string,
  ): Promise<ActivityLifecycleResult | null> {
    const existing = await tx.activity.findUnique({
      where: { cancelOperationKey: operationKey },
      select: {
        id: true,
        statusCode: true,
        cancelledAt: true,
        cancelReason: true,
        cancelRequestHash: true,
      },
    });
    if (!existing) return null;
    if (
      existing.cancelRequestHash !== requestHash ||
      existing.cancelledAt === null ||
      existing.statusCode !== 'cancelled'
    ) {
      throw new BizException(BizCode.ACTIVITY_LIFECYCLE_OPERATION_KEY_CONFLICT);
    }
    return {
      activityId: existing.id,
      statusCode: 'cancelled',
      occurredAt: existing.cancelledAt,
      reason: existing.cancelReason,
    };
  }

  private async findTerminateReplay(
    tx: PrismaTx,
    operationKey: string,
    requestHash: string,
  ): Promise<ActivityLifecycleResult | null> {
    const existing = await tx.activity.findUnique({
      where: { terminateOperationKey: operationKey },
      select: {
        id: true,
        statusCode: true,
        terminatedAt: true,
        terminationReason: true,
        terminateRequestHash: true,
      },
    });
    if (!existing) return null;
    if (
      existing.terminateRequestHash !== requestHash ||
      existing.terminatedAt === null ||
      existing.statusCode !== 'terminated'
    ) {
      throw new BizException(BizCode.ACTIVITY_LIFECYCLE_OPERATION_KEY_CONFLICT);
    }
    return {
      activityId: existing.id,
      statusCode: 'terminated',
      occurredAt: existing.terminatedAt,
      reason: existing.terminationReason,
    };
  }

  private rethrowOperationKeyConflict(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      this.isLifecycleOperationKeyTarget(error.meta?.target)
    ) {
      throw new BizException(BizCode.ACTIVITY_LIFECYCLE_OPERATION_KEY_CONFLICT);
    }
    throw error;
  }

  private isLifecycleOperationKeyTarget(target: unknown): boolean {
    const text = Array.isArray(target)
      ? target.filter((item): item is string => typeof item === 'string').join(',')
      : typeof target === 'string'
        ? target
        : '';
    return (
      text.includes('activity_cancel_operation_key_key') ||
      text.includes('activity_terminate_operation_key_key') ||
      text.includes('cancelOperationKey') ||
      text.includes('terminateOperationKey')
    );
  }
}
