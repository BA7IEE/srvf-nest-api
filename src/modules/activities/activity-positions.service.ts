import { Injectable, Logger } from '@nestjs/common';
import { DictItemStatus, DictTypeStatus, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AuthzService } from '../authz/authz.service';
import type { ResourceRef } from '../authz/authz.types';
import {
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_TYPE_REGISTRATION_RESULT,
} from '../notifications/notification.constants';
import { NotificationDispatcher } from '../notifications/notification-dispatcher';
import { RbacService } from '../permissions/rbac.service';
import { ActivityPositionAuditRecorder } from './activity-position-audit-recorder';
import {
  ActivityPositionResponseDto,
  CreateActivityPositionDto,
  UpdateActivityPositionDto,
} from './activity-positions.dto';
import { promoteActivityWaitlist } from './activity-waitlist-promotion';

const DICT_TYPE_ATTENDANCE_ROLE = 'attendance_role';
const DICT_TYPE_GENDER_REQUIREMENT = 'gender_requirement';
const ACTIVE_REGISTRATION_STATUS_CODES = ['pending', 'pass', 'waitlisted'] as const;

const ACTIVITY_POSITION_SELECT = {
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
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} as const satisfies Prisma.ActivityPositionSelect;

type ActivityPositionRow = Prisma.ActivityPositionGetPayload<{
  select: typeof ACTIVITY_POSITION_SELECT;
}>;
type PrismaTx = Prisma.TransactionClient;

interface ActivityWindow {
  id: string;
  startAt: Date;
  endAt: Date;
}

@Injectable()
export class ActivityPositionsService {
  private readonly logger = new Logger(ActivityPositionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditRecorder: ActivityPositionAuditRecorder,
    private readonly auditLogs: AuditLogsService,
    private readonly rbac: RbacService,
    private readonly authz: AuthzService,
    private readonly notificationDispatcher: NotificationDispatcher,
  ) {}

  async list(activityId: string): Promise<ActivityPositionResponseDto[]> {
    await this.findActivityOrThrow(this.prisma, activityId);
    const rows = await this.prisma.activityPosition.findMany({
      where: { activityId, deletedAt: null },
      select: ACTIVITY_POSITION_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((activityPosition) => this.toResponseDto(activityPosition));
  }

  async findOne(
    activityId: string,
    activityPositionId: string,
  ): Promise<ActivityPositionResponseDto> {
    await this.findActivityOrThrow(this.prisma, activityId);
    const activityPosition = await this.findActivityPositionOrThrow(
      this.prisma,
      activityId,
      activityPositionId,
    );
    return this.toResponseDto(activityPosition);
  }

  async create(
    activityId: string,
    dto: CreateActivityPositionDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityPositionResponseDto> {
    await this.assertCanOrThrow(currentUser, 'activity.update.record', {
      type: 'activity',
      id: activityId,
    });

    try {
      return await this.prisma.$transaction(async (tx) => {
        const activity = await this.lockActivityOrThrow(tx, activityId);
        await this.assertNameAvailable(tx, activityId, dto.name);
        await this.assertDictionaryItemValid(
          tx,
          DICT_TYPE_ATTENDANCE_ROLE,
          dto.attendanceRoleCode,
          BizCode.ATTENDANCE_ROLE_CODE_INVALID,
        );
        if (dto.genderRequirementCode !== undefined && dto.genderRequirementCode !== null) {
          await this.assertDictionaryItemValid(
            tx,
            DICT_TYPE_GENDER_REQUIREMENT,
            dto.genderRequirementCode,
            BizCode.ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID,
          );
        }

        const startAt = this.toNullableDate(dto.startAt);
        const endAt = this.toNullableDate(dto.endAt);
        this.assertTimeRangeValid(activity, startAt, endAt);
        this.assertCapacityValid(dto.capacity ?? null);

        const activityPosition = await tx.activityPosition.create({
          data: {
            activityId,
            name: dto.name,
            attendanceRoleCode: dto.attendanceRoleCode,
            capacity: dto.capacity ?? null,
            startAt,
            endAt,
            genderRequirementCode: dto.genderRequirementCode ?? null,
            description: dto.description ?? null,
            sortOrder: dto.sortOrder ?? 0,
          },
          select: ACTIVITY_POSITION_SELECT,
        });

        await this.auditRecorder.logCreate({
          activityPosition,
          actorUserId: currentUser.id,
          actorRoleSnap: currentUser.role,
          auditMeta,
          tx,
        });
        return this.toResponseDto(activityPosition);
      });
    } catch (error) {
      this.rethrowNameConflict(error);
    }
  }

  async update(
    activityId: string,
    activityPositionId: string,
    dto: UpdateActivityPositionDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityPositionResponseDto> {
    await this.assertCanOrThrow(currentUser, 'activity.update.record', {
      type: 'activity',
      id: activityId,
    });

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // 岗位 capacity 的 read-modify-write 基线必须在 Activity 锁后读取；锁对象不扩到岗位行。
        const activity = await this.lockActivityOrThrow(tx, activityId);
        const current = await this.findActivityPositionOrThrow(tx, activityId, activityPositionId);
        let waitlistPromotionLimit: number | null | undefined;

        if (dto.name !== undefined) {
          await this.assertNameAvailable(tx, activityId, dto.name, activityPositionId);
        }
        if (dto.attendanceRoleCode !== undefined) {
          await this.assertDictionaryItemValid(
            tx,
            DICT_TYPE_ATTENDANCE_ROLE,
            dto.attendanceRoleCode,
            BizCode.ATTENDANCE_ROLE_CODE_INVALID,
          );
        }
        if (dto.genderRequirementCode !== undefined && dto.genderRequirementCode !== null) {
          await this.assertDictionaryItemValid(
            tx,
            DICT_TYPE_GENDER_REQUIREMENT,
            dto.genderRequirementCode,
            BizCode.ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID,
          );
        }

        const nextStartAt =
          dto.startAt === undefined ? current.startAt : this.toNullableDate(dto.startAt);
        const nextEndAt = dto.endAt === undefined ? current.endAt : this.toNullableDate(dto.endAt);
        this.assertTimeRangeValid(activity, nextStartAt, nextEndAt);

        if (dto.capacity !== undefined) {
          this.assertCapacityValid(dto.capacity);
          const passCount = await tx.activityRegistration.count({
            where: {
              activityId,
              activityPositionId,
              statusCode: 'pass',
              deletedAt: null,
            },
          });
          if (dto.capacity !== null && dto.capacity < passCount) {
            throw new BizException(BizCode.ACTIVITY_POSITION_CAPACITY_INVALID);
          }
          if (current.capacity !== null) {
            if (dto.capacity === null) {
              waitlistPromotionLimit = null;
            } else if (dto.capacity > current.capacity) {
              waitlistPromotionLimit = dto.capacity - current.capacity;
            }
          }
        }

        const data: Prisma.ActivityPositionUncheckedUpdateInput = {};
        if (dto.name !== undefined) data.name = dto.name;
        if (dto.attendanceRoleCode !== undefined) {
          data.attendanceRoleCode = dto.attendanceRoleCode;
        }
        if (dto.capacity !== undefined) data.capacity = dto.capacity;
        if (dto.startAt !== undefined) data.startAt = nextStartAt;
        if (dto.endAt !== undefined) data.endAt = nextEndAt;
        if (dto.genderRequirementCode !== undefined) {
          data.genderRequirementCode = dto.genderRequirementCode;
        }
        if (dto.description !== undefined) data.description = dto.description;
        if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

        const updated = await tx.activityPosition.update({
          where: { id: activityPositionId },
          data,
          select: ACTIVITY_POSITION_SELECT,
        });
        await this.auditRecorder.logUpdate({
          before: current,
          after: updated,
          changedFields: Object.keys(dto),
          actorUserId: currentUser.id,
          actorRoleSnap: currentUser.role,
          auditMeta,
          tx,
        });
        const promotion =
          waitlistPromotionLimit !== undefined
            ? await promoteActivityWaitlist({
                activityId,
                activityPositionId,
                maxPromotions: waitlistPromotionLimit,
                actorUserId: currentUser.id,
                actorRoleSnap: currentUser.role,
                auditMeta,
                tx,
                auditLogs: this.auditLogs,
              })
            : { activityTitle: '活动', promoted: [] };
        return {
          dto: this.toResponseDto(updated),
          activityTitle: promotion.activityTitle,
          promotedMemberIds: promotion.promoted.map((item) => item.memberId),
        };
      });
      await this.dispatchWaitlistPromotionNotifications(
        activityId,
        result.activityTitle,
        result.promotedMemberIds,
      );
      return result.dto;
    } catch (error) {
      this.rethrowNameConflict(error);
    }
  }

  async softDelete(
    activityId: string,
    activityPositionId: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityPositionResponseDto> {
    await this.assertCanOrThrow(currentUser, 'activity.update.record', {
      type: 'activity',
      id: activityId,
    });

    return this.prisma.$transaction(async (tx) => {
      await this.lockActivityOrThrow(tx, activityId);
      const current = await this.findActivityPositionOrThrow(tx, activityId, activityPositionId);
      const activeRegistrationCount = await tx.activityRegistration.count({
        where: {
          activityId,
          activityPositionId,
          statusCode: { in: [...ACTIVE_REGISTRATION_STATUS_CODES] },
          deletedAt: null,
        },
      });
      if (activeRegistrationCount > 0) {
        throw new BizException(BizCode.ACTIVITY_POSITION_HAS_ACTIVE_REGISTRATIONS);
      }

      const deleted = await tx.activityPosition.update({
        where: { id: activityPositionId },
        data: { deletedAt: new Date() },
        select: ACTIVITY_POSITION_SELECT,
      });
      await this.auditRecorder.logSoftDelete({
        before: current,
        after: deleted,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        auditMeta,
        tx,
      });
      return this.toResponseDto(deleted);
    });
  }

  private async assertCanOrThrow(
    currentUser: CurrentUserPayload,
    action: string,
    ref?: ResourceRef,
  ): Promise<void> {
    const decision = await this.authz.explain(currentUser, action, ref);
    if (decision.allow) return;
    if (
      ref !== undefined &&
      decision.reason === 'resource_not_found' &&
      (await this.rbac.can(currentUser, action))
    ) {
      return;
    }
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  private async findActivityOrThrow(
    client: Pick<PrismaService, 'activity'>,
    activityId: string,
  ): Promise<ActivityWindow> {
    const activity = await client.activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: { id: true, startAt: true, endAt: true },
    });
    if (activity === null) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return activity;
  }

  private async lockActivityOrThrow(tx: PrismaTx, activityId: string): Promise<ActivityWindow> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Activity"
      WHERE id = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `;
    if (locked.length === 0) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    const activity = await tx.activity.findUnique({
      where: { id: activityId },
      select: { id: true, startAt: true, endAt: true },
    });
    if (activity === null) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return activity;
  }

  private async findActivityPositionOrThrow(
    client: Pick<PrismaService, 'activityPosition'>,
    activityId: string,
    activityPositionId: string,
  ): Promise<ActivityPositionRow> {
    const activityPosition = await client.activityPosition.findFirst({
      where: { id: activityPositionId, activityId, deletedAt: null },
      select: ACTIVITY_POSITION_SELECT,
    });
    if (activityPosition === null) {
      throw new BizException(BizCode.ACTIVITY_POSITION_NOT_FOUND);
    }
    return activityPosition;
  }

  private async assertNameAvailable(
    client: Pick<PrismaService, 'activityPosition'>,
    activityId: string,
    name: string,
    excludedActivityPositionId?: string,
  ): Promise<void> {
    const duplicate = await client.activityPosition.findFirst({
      where: {
        activityId,
        name,
        deletedAt: null,
        ...(excludedActivityPositionId === undefined
          ? {}
          : { id: { not: excludedActivityPositionId } }),
      },
      select: { id: true },
    });
    if (duplicate !== null) {
      throw new BizException(BizCode.ACTIVITY_POSITION_NAME_ALREADY_EXISTS);
    }
  }

  private async assertDictionaryItemValid(
    client: Pick<PrismaService, 'dictItem'>,
    typeCode: string,
    code: string,
    biz: BizCodeEntry,
  ): Promise<void> {
    const item = await client.dictItem.findFirst({
      where: {
        code,
        status: DictItemStatus.ACTIVE,
        deletedAt: null,
        type: {
          code: typeCode,
          status: DictTypeStatus.ACTIVE,
          deletedAt: null,
        },
      },
      select: { id: true },
    });
    if (item === null) throw new BizException(biz);
  }

  private assertTimeRangeValid(
    activity: ActivityWindow,
    startAt: Date | null,
    endAt: Date | null,
  ): void {
    if ((startAt === null) !== (endAt === null)) {
      throw new BizException(BizCode.ACTIVITY_POSITION_TIME_RANGE_INVALID);
    }
    if (
      startAt !== null &&
      endAt !== null &&
      (startAt.getTime() >= endAt.getTime() ||
        startAt.getTime() < activity.startAt.getTime() ||
        endAt.getTime() > activity.endAt.getTime())
    ) {
      throw new BizException(BizCode.ACTIVITY_POSITION_TIME_RANGE_INVALID);
    }
  }

  private assertCapacityValid(capacity: number | null): void {
    if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1)) {
      throw new BizException(BizCode.ACTIVITY_POSITION_CAPACITY_INVALID);
    }
  }

  private toNullableDate(value: string | null | undefined): Date | null {
    return value === undefined || value === null ? null : new Date(value);
  }

  private rethrowNameConflict(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new BizException(BizCode.ACTIVITY_POSITION_NAME_ALREADY_EXISTS);
    }
    throw error;
  }

  private async dispatchWaitlistPromotionNotifications(
    activityId: string,
    activityTitle: string,
    memberIds: string[],
  ): Promise<void> {
    for (const memberId of memberIds) {
      try {
        await this.notificationDispatcher.dispatchTargeted({
          recipientMemberId: memberId,
          notificationTypeCode: NOTIFICATION_TYPE_REGISTRATION_RESULT,
          title: '候补已递补',
          body: `您报名的「${activityTitle}」已从候补递补，现已进入待审核。`,
          channels: [NOTIFICATION_CHANNEL_IN_APP],
        });
      } catch (error) {
        this.logger.error(
          `waitlist promotion notification failed (activity=${activityId}, member=${memberId}): ${(error as Error).message}`,
        );
      }
    }
  }

  private toResponseDto(activityPosition: ActivityPositionRow): ActivityPositionResponseDto {
    return {
      activityPositionId: activityPosition.id,
      activityId: activityPosition.activityId,
      name: activityPosition.name,
      attendanceRoleCode: activityPosition.attendanceRoleCode,
      capacity: activityPosition.capacity,
      startAt: activityPosition.startAt,
      endAt: activityPosition.endAt,
      genderRequirementCode: activityPosition.genderRequirementCode,
      description: activityPosition.description,
      sortOrder: activityPosition.sortOrder,
      createdAt: activityPosition.createdAt,
      updatedAt: activityPosition.updatedAt,
    };
  }
}
