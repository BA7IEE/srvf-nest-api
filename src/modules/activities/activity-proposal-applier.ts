import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { InsuranceRequirementService } from '../insurances/insurance-requirement.service';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { ActivityAuditRecorder } from './activity-audit-recorder';
import { ActivityPositionAuditRecorder } from './activity-position-audit-recorder';
import type { ActivityProposalSnapshot } from './activity-proposal.types';
import { ActivityProposalValidator } from './activity-proposal-validator';
import { promoteActivityWaitlistsWithinSharedCapacity } from './activity-waitlist-promotion';

type PrismaTx = Prisma.TransactionClient;

const activityApplySelect = {
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
  requiresInsurance: true,
  registrationSchema: true,
  coverImageUrl: true,
  galleryImageUrls: true,
  content: true,
  locationLongitude: true,
  locationLatitude: true,
} as const satisfies Prisma.ActivitySelect;

const positionApplySelect = {
  id: true,
  activityId: true,
  name: true,
  attendanceRoleCode: true,
  capacity: true,
  startAt: true,
  endAt: true,
  genderRequirementCode: true,
  description: true,
  sortOrder: true,
  deletedAt: true,
} as const satisfies Prisma.ActivityPositionSelect;

export interface ActivityProposalApplyResult {
  activityId: string;
  activityTitle: string;
  initiatorMemberId: string | null;
  notificationMemberIds: string[];
  promoted: Array<{ registrationId: string; memberId: string }>;
}

@Injectable()
export class ActivityProposalApplier {
  constructor(
    private readonly validator: ActivityProposalValidator,
    private readonly insuranceRequirement: InsuranceRequirementService,
    private readonly activityAudit: ActivityAuditRecorder,
    private readonly positionAudit: ActivityPositionAuditRecorder,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async apply(
    tx: PrismaTx,
    activityId: string,
    snapshot: ActivityProposalSnapshot,
    actor: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityProposalApplyResult> {
    await this.validator.validate(tx, activityId, snapshot);
    const before = await tx.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: activityApplySelect,
    });
    const nextStartAt = new Date(snapshot.activity.startAt);
    const nextEndAt = new Date(snapshot.activity.endAt);
    await this.insuranceRequirement.assertActivityInsuranceLifecycleMutable(
      {
        id: activityId,
        requiresInsurance: before.requiresInsurance,
        startAt: before.startAt,
        endAt: before.endAt,
      },
      {
        requiresInsurance: snapshot.activity.requiresInsurance,
        startAt: nextStartAt,
        endAt: nextEndAt,
      },
      tx,
    );

    const currentPositions = await tx.activityPosition.findMany({
      where: { activityId, deletedAt: null },
      select: positionApplySelect,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    const proposalIds = new Set(
      snapshot.positions
        .map((position) => position.activityPositionId)
        .filter((id): id is string => id !== null),
    );
    const deletedPositions = currentPositions.filter((position) => !proposalIds.has(position.id));
    if (deletedPositions.length > 0) {
      const activeCount = await tx.activityRegistration.count({
        where: {
          activityId,
          activityPositionId: { in: deletedPositions.map((position) => position.id) },
          statusCode: { in: ['pending', 'pass', 'waitlisted'] },
          deletedAt: null,
        },
      });
      if (activeCount > 0) {
        throw new BizException(BizCode.ACTIVITY_POSITION_HAS_ACTIVE_REGISTRATIONS);
      }
    }

    const changedFields = this.changedActivityFields(before, snapshot);
    const updated = await tx.activity.update({
      where: { id: activityId },
      data: {
        title: snapshot.activity.title,
        activityTypeCode: snapshot.activity.activityTypeCode,
        organizationId: snapshot.activity.organizationId,
        startAt: nextStartAt,
        endAt: nextEndAt,
        location: snapshot.activity.location,
        description: snapshot.activity.description,
        capacity: snapshot.activity.capacity,
        genderRequirementCode: snapshot.activity.genderRequirementCode,
        registrationDeadline:
          snapshot.activity.registrationDeadline === null
            ? null
            : new Date(snapshot.activity.registrationDeadline),
        registrationNotes: snapshot.activity.registrationNotes,
        isPublicRegistration: snapshot.activity.isPublicRegistration,
        requiresInsurance: snapshot.activity.requiresInsurance,
        registrationSchema:
          snapshot.activity.registrationSchema === null
            ? Prisma.DbNull
            : (snapshot.activity.registrationSchema as Prisma.InputJsonValue),
        coverImageUrl: snapshot.activity.coverImageUrl,
        galleryImageUrls:
          snapshot.activity.galleryImageUrls === null
            ? Prisma.DbNull
            : (snapshot.activity.galleryImageUrls as Prisma.InputJsonValue),
        content:
          snapshot.activity.content === null
            ? Prisma.DbNull
            : (snapshot.activity.content as Prisma.InputJsonValue),
        locationLongitude: snapshot.activity.locationLongitude,
        locationLatitude: snapshot.activity.locationLatitude,
        workflowRevision: { increment: 1 },
      },
      select: activityApplySelect,
    });
    if (changedFields.length > 0) {
      await this.activityAudit.logUpdate({
        activityId,
        before,
        after: updated,
        actorUserId: actor.id,
        actorRoleSnap: actor.role,
        priorStatusCode: before.statusCode,
        changedFields,
        auditMeta,
        tx,
      });
    }

    const currentById = new Map(currentPositions.map((position) => [position.id, position]));
    // B-D1 / B-D2（维护者 2026-08-01 拍板）：递补按「哪条队列的名额被放开」分别触发，不做全活动
    // 一把梭。父容量扩容只在**无 live 岗位**时递补历史无岗位队列（与 Admin `activities.update`
    // 同口径）；岗位扩容只递补本岗队列。新建岗位不递补 —— 它此刻不可能有候补指向它。
    const activityCapacityExpanded =
      before.capacity !== snapshot.activity.capacity &&
      (snapshot.activity.capacity === null ||
        (before.capacity !== null && snapshot.activity.capacity > before.capacity));
    const expandedActivityPositionIds = new Set<string>();
    for (const proposal of snapshot.positions) {
      const data = {
        name: proposal.name,
        attendanceRoleCode: proposal.attendanceRoleCode,
        capacity: proposal.capacity,
        startAt: proposal.startAt === null ? null : new Date(proposal.startAt),
        endAt: proposal.endAt === null ? null : new Date(proposal.endAt),
        genderRequirementCode: proposal.genderRequirementCode,
        description: proposal.description,
        sortOrder: proposal.sortOrder,
      };
      if (proposal.activityPositionId === null) {
        const created = await tx.activityPosition.create({
          data: { activityId, ...data },
          select: positionApplySelect,
        });
        await this.positionAudit.logCreate({
          activityPosition: created,
          actorUserId: actor.id,
          actorRoleSnap: actor.role,
          auditMeta,
          tx,
        });
        continue;
      }
      const current = currentById.get(proposal.activityPositionId);
      if (!current) {
        throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      }
      if (
        current.capacity !== proposal.capacity &&
        (proposal.capacity === null ||
          (current.capacity !== null && proposal.capacity > current.capacity))
      ) {
        expandedActivityPositionIds.add(current.id);
      }
      const changed = Object.entries(data)
        .filter(([field, value]) => {
          const currentValue = current[field as keyof typeof data];
          if (currentValue instanceof Date && value instanceof Date) {
            return currentValue.getTime() !== value.getTime();
          }
          return currentValue !== value;
        })
        .map(([field]) => field);
      if (changed.length === 0) continue;
      const after = await tx.activityPosition.update({
        where: { id: current.id },
        data,
        select: positionApplySelect,
      });
      await this.positionAudit.logUpdate({
        before: current,
        after,
        changedFields: changed,
        actorUserId: actor.id,
        actorRoleSnap: actor.role,
        auditMeta,
        tx,
      });
    }
    const deletedAt = new Date();
    for (const current of deletedPositions) {
      const after = await tx.activityPosition.update({
        where: { id: current.id },
        data: { deletedAt },
        select: positionApplySelect,
      });
      await this.positionAudit.logSoftDelete({
        before: current,
        after,
        actorUserId: actor.id,
        actorRoleSnap: actor.role,
        auditMeta,
        tx,
      });
    }

    // 无 live 岗位的活动，父容量扩容仍递补历史无岗位队列；有 live 岗位则父容量不再触发递补。
    const promotionTargets: Array<string | null> =
      activityCapacityExpanded && snapshot.positions.length === 0 ? [null] : [];
    // **稳定岗位序**:按活动自己的岗位排序(sortOrder → createdAt → id)发放预算，而不是按
    // proposal 数组的书写顺序。父预算不够分时顺序决定谁被递补，跟着请求体走会让同一份内容
    // 换个数组顺序递补到不同的人。
    promotionTargets.push(
      ...currentPositions
        .filter((position) => expandedActivityPositionIds.has(position.id))
        .map((position) => position.id),
    );
    // 一次提案可能同时扩容多个岗位，各岗 headroom 之和可以超过父活动 headroom。**必须**走
    // 共享父预算的批量入口:逐岗调单岗版会让每一岗都完整领走同一份父剩余量(递补写的是
    // pending 不是 pass，父 pass 基线在批次内不动)，合计递补数因此突破活动容量。
    // 这里刻意不自算容量 —— 预算算法只有 activity-waitlist-promotion.ts 一份。
    const { promoted } = await promoteActivityWaitlistsWithinSharedCapacity({
      activityId,
      orderedPositionIds: promotionTargets,
      actorUserId: actor.id,
      actorRoleSnap: actor.role,
      auditMeta,
      tx,
      auditLogs: this.auditLogs,
    });
    const scheduleChanged =
      before.startAt.getTime() !== updated.startAt.getTime() ||
      before.endAt.getTime() !== updated.endAt.getTime() ||
      before.location !== updated.location;
    const notificationMemberIds = scheduleChanged
      ? [
          ...new Set(
            (
              await tx.activityRegistration.findMany({
                where: {
                  activityId,
                  statusCode: { in: ['pending', 'pass', 'waitlisted'] },
                  deletedAt: null,
                },
                select: { memberId: true },
              })
            ).map((row) => row.memberId),
          ),
        ]
      : [];
    const identity = await tx.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: { initiatorMemberId: true },
    });
    return {
      activityId,
      activityTitle: updated.title,
      initiatorMemberId: identity.initiatorMemberId,
      notificationMemberIds,
      promoted,
    };
  }

  private changedActivityFields(
    before: Prisma.ActivityGetPayload<{ select: typeof activityApplySelect }>,
    snapshot: ActivityProposalSnapshot,
  ): string[] {
    const comparable: Record<string, unknown> = {
      title: snapshot.activity.title,
      activityTypeCode: snapshot.activity.activityTypeCode,
      organizationId: snapshot.activity.organizationId,
      startAt: new Date(snapshot.activity.startAt),
      endAt: new Date(snapshot.activity.endAt),
      location: snapshot.activity.location,
      description: snapshot.activity.description,
      capacity: snapshot.activity.capacity,
      genderRequirementCode: snapshot.activity.genderRequirementCode,
      registrationDeadline:
        snapshot.activity.registrationDeadline === null
          ? null
          : new Date(snapshot.activity.registrationDeadline),
      registrationNotes: snapshot.activity.registrationNotes,
      isPublicRegistration: snapshot.activity.isPublicRegistration,
      requiresInsurance: snapshot.activity.requiresInsurance,
      registrationSchema: snapshot.activity.registrationSchema,
      coverImageUrl: snapshot.activity.coverImageUrl,
      galleryImageUrls: snapshot.activity.galleryImageUrls,
      content: snapshot.activity.content,
      locationLongitude: snapshot.activity.locationLongitude,
      locationLatitude: snapshot.activity.locationLatitude,
    };
    return Object.entries(comparable)
      .filter(([field, value]) => {
        const current = before[field as keyof typeof before];
        if (current instanceof Date && value instanceof Date) {
          return current.getTime() !== value.getTime();
        }
        if (current instanceof Prisma.Decimal) {
          return current.toString() !== String(value);
        }
        if (typeof current === 'object' || typeof value === 'object') {
          return JSON.stringify(current) !== JSON.stringify(value);
        }
        return current !== value;
      })
      .map(([field]) => field);
  }
}
