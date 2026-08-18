import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { claimAtStatus } from '../../common/prisma/claim-at-status.util';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import appConfig from '../../config/app.config';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { InsuranceRequirementService } from '../insurances/insurance-requirement.service';
import { ActivityResponseDto, CreateActivityDto, UpdateActivityDto } from './activities.dto';
import { toResponseDto } from './activity-presenter';
import { ActivityAuditRecorder } from './activity-audit-recorder';
import { ActivityStateMachine } from './activity-state-machine';
import { promoteActivityWaitlist } from './activity-waitlist-promotion';
import { ActivityInitiationPolicy } from './activity-initiation-policy';
import { ActivityNotificationProducer } from './activity-notification-producer';
import { ActivityAllocationModeService } from './activity-allocation-mode.service';
import {
  ActivityAccessService,
  ACTIVE_REGISTRATION_STATUS_CODES,
  ACTIVITY_STATUS_DRAFT,
  ACTIVITY_STATUS_PUBLISHED,
  DICT_TYPE_ACTIVITY_TYPE,
  DICT_TYPE_GENDER_REQUIREMENT,
  PUBLISHED_ACTIVITY_DISPLAY_FIELD_SET,
  TERMINAL_ACTIVITY_STATUS_CODES,
  TERMINAL_ACTIVITY_UPDATE_FIELDS,
  activitySafeSelect,
} from './activity-access.service';

function nullableDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

/*
 * 活动的**建单与改单族**(Phase 6-B 第三域第三刀,§3.2)。
 *
 * create / update 两个入口。update 单方法 337 物理行,是本域最大的单体 ——
 * 它同时承载草稿改单、已发布展示位改单与 v1.1 配置改单三条语义。
 * ⚠️ 本刀是**纯迁移**,不拆它的方法体:拆方法体是行为变更,应另立一刀,
 * 且需先有覆盖其三条语义分支的测试。
 *
 * ⚠️ 判权与域校验经 this.access,调用点仍在本类各方法体内 —— 不接受「上游已判过」的入参。
 */
@Injectable()
export class ActivityWriteService {
  constructor(
    private readonly prisma: PrismaService,
    // 多段共用的判权 / 聚合根装载 / 域校验:调用点仍在本类各方法体内。
    private readonly access: ActivityAccessService,
    private readonly activityAuditRecorder: ActivityAuditRecorder,
    private readonly activityStateMachine: ActivityStateMachine,
    private readonly allocationModes: ActivityAllocationModeService,
    private readonly auditLogs: AuditLogsService,
    private readonly initiationPolicy: ActivityInitiationPolicy,
    private readonly insuranceRequirement: InsuranceRequirementService,
    private readonly notificationProducer: ActivityNotificationProducer,
    @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
  ) {}

  async create(
    dto: CreateActivityDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
    authorization: 'rbac' | 'managed' = 'rbac',
  ): Promise<ActivityResponseDto> {
    if (authorization === 'rbac') {
      await this.access.assertCanOrThrow(currentUser, 'activity.create.record');
    } else if (!this.config.activityResponsibilityWorkflow.enabled) {
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    }
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);
    // Service callers may bypass Controller ValidationPipe; new runtime creates never rely on the
    // Prisma default as an implicit allocation policy.
    this.allocationModes.assertValidMode(dto.allocationModeCode);
    this.access.assertStartEndValid(startAt, endAt);
    this.access.assertRegistrationDeadlineValid(
      dto.registrationDeadline !== undefined ? nullableDate(dto.registrationDeadline) : null,
      endAt,
    );
    this.access.assertV11DraftConfiguration(dto);

    return this.prisma.$transaction(async (tx) => {
      const initiatorMemberId = this.config.activityResponsibilityWorkflow.enabled
        ? await this.initiationPolicy.resolveInitiator(
            currentUser,
            dto.organizationId,
            dto.initiatorMemberId,
            tx,
          )
        : undefined;
      await this.access.assertDictItemValid(
        DICT_TYPE_ACTIVITY_TYPE,
        dto.activityTypeCode,
        BizCode.ACTIVITY_TYPE_CODE_INVALID,
        tx,
      );
      if (dto.genderRequirementCode !== undefined) {
        await this.access.assertDictItemValid(
          DICT_TYPE_GENDER_REQUIREMENT,
          dto.genderRequirementCode,
          BizCode.ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID,
          tx,
        );
      }
      await this.access.assertOrganizationValidAndNonRoot(dto.organizationId, tx);

      const data: Prisma.ActivityUncheckedCreateInput = {
        title: dto.title,
        activityTypeCode: dto.activityTypeCode,
        allocationModeCode: dto.allocationModeCode,
        organizationId: dto.organizationId,
        startAt,
        endAt,
        location: dto.location,
        statusCode: ACTIVITY_STATUS_DRAFT,
        ...(initiatorMemberId ? { initiatorMemberId } : {}),
      };
      if (dto.description !== undefined) data.description = dto.description;
      if (dto.capacity !== undefined) data.capacity = dto.capacity;
      if (dto.genderRequirementCode !== undefined) {
        data.genderRequirementCode = dto.genderRequirementCode;
      }
      if (dto.registrationDeadline !== undefined) {
        data.registrationDeadline = nullableDate(dto.registrationDeadline);
      }
      if (dto.registrationNotes !== undefined) data.registrationNotes = dto.registrationNotes;
      if (dto.isPublicRegistration !== undefined) {
        data.isPublicRegistration = dto.isPublicRegistration;
      }
      if (dto.requiresInsurance !== undefined) {
        data.requiresInsurance = dto.requiresInsurance;
      }
      if (dto.registrationModeCode !== undefined) {
        data.registrationModeCode = dto.registrationModeCode;
      }
      if (dto.visibilityCode !== undefined) data.visibilityCode = dto.visibilityCode;
      if (dto.defaultCheckInRadiusMeters !== undefined) {
        data.defaultCheckInRadiusMeters = dto.defaultCheckInRadiusMeters;
      }
      if (dto.defaultLocationRequired !== undefined) {
        data.defaultLocationRequired = dto.defaultLocationRequired;
      }
      if (dto.archiveWaitingDays !== undefined) {
        data.archiveWaitingDays = dto.archiveWaitingDays;
      }
      if (dto.registrationSchema !== undefined) {
        data.registrationSchema = dto.registrationSchema as Prisma.InputJsonValue;
      }
      if (dto.coverImageUrl !== undefined) data.coverImageUrl = dto.coverImageUrl;
      if (dto.galleryImageUrls !== undefined) {
        data.galleryImageUrls = dto.galleryImageUrls;
      }
      if (dto.content !== undefined) {
        data.content = dto.content as Prisma.InputJsonValue;
      }
      if (dto.locationLongitude !== undefined) data.locationLongitude = dto.locationLongitude;
      if (dto.locationLatitude !== undefined) data.locationLatitude = dto.locationLatitude;

      const created = await tx.activity.create({
        data,
        select: activitySafeSelect,
      });

      await this.activityAuditRecorder.logCreate({
        created,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        nextStatusCode: ACTIVITY_STATUS_DRAFT,
        auditMeta,
        tx,
      });

      return toResponseDto(created);
    });
  }

  async update(
    id: string,
    dto: UpdateActivityDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
    authorization: 'rbac' | 'managed' = 'rbac',
  ): Promise<ActivityResponseDto> {
    if (authorization === 'rbac') {
      await this.access.assertCanOrThrow(currentUser, 'activity.update.record', {
        type: 'activity',
        id,
      });
    } else if (!this.config.activityResponsibilityWorkflow.enabled) {
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    }
    if (dto.allocationModeCode !== undefined) {
      this.allocationModes.assertValidMode(dto.allocationModeCode);
    }
    return this.prisma.$transaction(async (tx) => {
      // 所有活动写入口统一先锁 Activity，再重读状态、时间窗、岗位与 passCount 基线。
      const current =
        authorization === 'managed'
          ? await this.access.lockAndFindManagedActivityOrThrow(id, currentUser, tx)
          : await this.access.lockAndFindActivityOrThrow(id, tx);

      // Caller holds Activity FOR UPDATE through lockAndFind* above. Draft writes can change the
      // parent mode, so every historical child batch must agree before any validation or write.
      if (current.statusCode === ACTIVITY_STATUS_DRAFT) {
        await this.allocationModes.assertLockedActivityConsistent(tx, {
          ...current,
          allocationModeCode: dto.allocationModeCode ?? current.allocationModeCode,
        });
      }

      // App 草稿写先裁定状态；已发布活动即使请求体恰有别的校验问题，也必须明确
      // 告知客户端走 change review，不能因参数校验掩掉阶段语义。
      if (authorization !== 'managed') this.access.assertV11DraftConfiguration(dto);

      if (this.config.activityResponsibilityWorkflow.enabled) {
        const publishedDisplayOnly =
          current.statusCode === ACTIVITY_STATUS_PUBLISHED && this.isPublishedDisplayOnly(dto);
        if (authorization === 'managed') {
          // Published 只有这一个显式展示白名单可走原 PATCH；其余字段仍必须走 change review。
          if (current.statusCode !== 'draft' && !publishedDisplayOnly) {
            throw new BizException(
              current.statusCode === ACTIVITY_STATUS_PUBLISHED
                ? BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED
                : BizCode.ACTIVITY_STATUS_INVALID,
            );
          }
          if (!publishedDisplayOnly) {
            const pendingReview = await tx.activityPublishReview.count({
              where: { activityId: id, status: 'pending' },
            });
            if (pendingReview > 0) {
              throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING);
            }
            this.access.assertV11DraftConfiguration(dto);
          }
        } else {
          if (!publishedDisplayOnly) {
            const pendingReview = await tx.activityPublishReview.count({
              where: { activityId: id, status: 'pending' },
            });
            if (pendingReview > 0) {
              throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING);
            }
          }
          if (current.statusCode === ACTIVITY_STATUS_PUBLISHED && !publishedDisplayOnly) {
            throw new BizException(BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED);
          }
        }
      }

      // Q-A12:cancelled 拒改(沿 ActivityStateMachine update decision)。
      const transition = this.activityStateMachine.decide('update', current.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }
      if (
        TERMINAL_ACTIVITY_STATUS_CODES.has(current.statusCode) &&
        Object.keys(dto).some(
          (field) => !TERMINAL_ACTIVITY_UPDATE_FIELDS.has(field as keyof UpdateActivityDto),
        )
      ) {
        throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
      }

      // 字典校验(传入时)
      if (dto.activityTypeCode !== undefined) {
        await this.access.assertDictItemValid(
          DICT_TYPE_ACTIVITY_TYPE,
          dto.activityTypeCode,
          BizCode.ACTIVITY_TYPE_CODE_INVALID,
          tx,
        );
      }
      if (dto.genderRequirementCode !== undefined) {
        await this.access.assertDictItemValid(
          DICT_TYPE_GENDER_REQUIREMENT,
          dto.genderRequirementCode,
          BizCode.ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID,
          tx,
        );
      }
      if (dto.organizationId !== undefined) {
        if (
          this.config.activityResponsibilityWorkflow.enabled &&
          dto.organizationId !== current.organizationId
        ) {
          await this.initiationPolicy.assertInitiatorEligible(
            currentUser,
            dto.organizationId,
            current.initiatorMemberId,
            tx,
          );
        } else {
          await this.access.assertOrganizationValidAndNonRoot(dto.organizationId, tx);
        }
      }

      // 起止时间 + 报名截止复校(任一字段变化时,用合并后值)
      const nextStart = dto.startAt !== undefined ? new Date(dto.startAt) : current.startAt;
      const nextEnd = dto.endAt !== undefined ? new Date(dto.endAt) : current.endAt;
      if (
        dto.startAt !== undefined ||
        dto.endAt !== undefined ||
        dto.registrationDeadline !== undefined
      ) {
        const nextDeadline =
          dto.registrationDeadline !== undefined
            ? nullableDate(dto.registrationDeadline)
            : current.registrationDeadline;
        this.access.assertStartEndValid(nextStart, nextEnd);
        this.access.assertRegistrationDeadlineValid(nextDeadline, nextEnd);
        if (dto.startAt !== undefined || dto.endAt !== undefined) {
          await this.access.assertLivePositionWindowsWithinActivity(
            current.id,
            nextStart,
            nextEnd,
            tx,
          );
          await this.access.assertLiveSessionWindowsWithinActivity(
            current.id,
            nextStart,
            nextEnd,
            tx,
          );
        }
      }

      await this.insuranceRequirement.assertActivityInsuranceLifecycleMutable(
        {
          id: current.id,
          requiresInsurance: current.requiresInsurance,
          startAt: current.startAt,
          endAt: current.endAt,
        },
        {
          requiresInsurance: dto.requiresInsurance ?? current.requiresInsurance,
          startAt: nextStart,
          endAt: nextEnd,
        },
        tx,
      );

      let waitlistPromotionLimit: number | null | undefined;
      if (dto.capacity !== undefined) {
        // delta / live 岗位 / passCount 基线都必须在 Activity 聚合锁后读取；否则并发 / 重试
        // 可能各自按陈旧 capacity 计算递补 delta，或在岗位形态已变化时仍沿 Activity.capacity 判闸。
        const locked = await tx.activity.findUniqueOrThrow({
          where: { id: current.id },
          select: {
            capacity: true,
            activityPositions: {
              where: { deletedAt: null },
              select: { id: true },
              take: 1,
            },
          },
        });
        const passCount = await tx.activityRegistration.count({
          where: notDeletedWhere({ activityId: current.id, statusCode: 'pass' }),
        });
        if (dto.capacity !== null && dto.capacity < passCount) {
          throw new BizException(BizCode.ACTIVITY_CAPACITY_INVALID);
        }
        const livePositionCapacities = await tx.activityPosition.findMany({
          where: { activityId: current.id, deletedAt: null },
          select: { capacity: true },
        });
        if (
          dto.capacity !== null &&
          (livePositionCapacities.some((position) => position.capacity === null) ||
            livePositionCapacities.reduce(
              (total, position) => total + (position.capacity ?? 0),
              0,
            ) > dto.capacity)
        ) {
          throw new BizException(BizCode.ACTIVITY_CAPACITY_INVALID);
        }
        // B-D1（维护者 2026-08-01 拍板）：名额语义在岗位上，`Activity.capacity` 只是总上限 ——
        // 有 live 岗位时编辑它**不触发递补**，放人走岗位名额那条路（岗位扩容只递补本岗候补）。
        // 无 live 岗位活动的扩容递补行为逐字保持：调大按 delta、改无限递补全部、缩容不递补。
        const hasLiveActivityPositions = locked.activityPositions.length > 0;
        if (!hasLiveActivityPositions && locked.capacity !== null) {
          if (dto.capacity === null) {
            waitlistPromotionLimit = null;
          } else if (dto.capacity > locked.capacity) {
            waitlistPromotionLimit = dto.capacity - locked.capacity;
          }
        }
      }

      const data: Prisma.ActivityUpdateInput = {};
      if (dto.title !== undefined) data.title = dto.title;
      if (dto.activityTypeCode !== undefined) data.activityTypeCode = dto.activityTypeCode;
      if (dto.allocationModeCode !== undefined) data.allocationModeCode = dto.allocationModeCode;
      if (dto.organizationId !== undefined) {
        data.organization = { connect: { id: dto.organizationId } };
      }
      if (dto.startAt !== undefined) data.startAt = new Date(dto.startAt);
      if (dto.endAt !== undefined) data.endAt = new Date(dto.endAt);
      if (dto.location !== undefined) data.location = dto.location;
      if (dto.description !== undefined) data.description = dto.description;
      if (dto.capacity !== undefined) data.capacity = dto.capacity;
      if (dto.genderRequirementCode !== undefined) {
        data.genderRequirementCode = dto.genderRequirementCode;
      }
      if (dto.registrationDeadline !== undefined) {
        data.registrationDeadline = nullableDate(dto.registrationDeadline);
      }
      if (dto.registrationNotes !== undefined) data.registrationNotes = dto.registrationNotes;
      if (dto.isPublicRegistration !== undefined) {
        data.isPublicRegistration = dto.isPublicRegistration;
      }
      if (dto.requiresInsurance !== undefined) {
        data.requiresInsurance = dto.requiresInsurance;
      }
      if (dto.registrationModeCode !== undefined) {
        data.registrationModeCode = dto.registrationModeCode;
      }
      if (dto.visibilityCode !== undefined) data.visibilityCode = dto.visibilityCode;
      if (dto.defaultCheckInRadiusMeters !== undefined) {
        data.defaultCheckInRadiusMeters = dto.defaultCheckInRadiusMeters;
      }
      if (dto.defaultLocationRequired !== undefined) {
        data.defaultLocationRequired = dto.defaultLocationRequired;
      }
      if (dto.archiveWaitingDays !== undefined) {
        data.archiveWaitingDays = dto.archiveWaitingDays;
      }
      if (dto.registrationSchema !== undefined) {
        data.registrationSchema = dto.registrationSchema as Prisma.InputJsonValue;
      }
      if (dto.coverImageUrl !== undefined) data.coverImageUrl = dto.coverImageUrl;
      if (dto.galleryImageUrls !== undefined) {
        data.galleryImageUrls = dto.galleryImageUrls;
      }
      if (dto.content !== undefined) {
        data.content = dto.content as Prisma.InputJsonValue;
      }
      if (dto.locationLongitude !== undefined) data.locationLongitude = dto.locationLongitude;
      if (dto.locationLatitude !== undefined) data.locationLatitude = dto.locationLatitude;

      await claimAtStatus(tx, {
        target: 'activity',
        id: current.id,
        expectedStatus: current.statusCode,
        invalidStatusBiz: BizCode.ACTIVITY_STATUS_INVALID,
      });
      const updated = await tx.activity.update({
        where: { id: current.id },
        data,
        select: activitySafeSelect,
      });

      await this.activityAuditRecorder.logUpdate({
        activityId: current.id,
        before: current,
        after: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        priorStatusCode: current.statusCode,
        changedFields: Object.keys(dto),
        auditMeta,
        tx,
      });

      const promotion =
        waitlistPromotionLimit !== undefined
          ? await promoteActivityWaitlist({
              activityId: current.id,
              activityPositionId: null,
              maxPromotions: waitlistPromotionLimit,
              actorUserId: currentUser.id,
              actorRoleSnap: currentUser.role,
              auditMeta,
              tx,
              auditLogs: this.auditLogs,
            })
          : { activityTitle: updated.title, promoted: [] };

      const scheduleChanged =
        current.startAt.getTime() !== updated.startAt.getTime() ||
        current.endAt.getTime() !== updated.endAt.getTime() ||
        current.location !== updated.location;
      const notificationMemberIds = scheduleChanged
        ? [
            ...new Set(
              (
                await tx.activityRegistration.findMany({
                  where: notDeletedWhere({
                    activityId: current.id,
                    statusCode: { in: [...ACTIVE_REGISTRATION_STATUS_CODES] },
                  }),
                  select: { memberId: true },
                })
              ).map((row) => row.memberId),
            ),
          ]
        : [];

      await this.notificationProducer.enqueueScheduleChange(tx, {
        activityId: current.id,
        activityTitle: updated.title,
        versionKey: updated.updatedAt.toISOString(),
        before: {
          startAt: current.startAt,
          endAt: current.endAt,
          location: current.location,
        },
        after: {
          startAt: updated.startAt,
          endAt: updated.endAt,
          location: updated.location,
        },
        requiresInsurance: updated.requiresInsurance,
        memberIds: notificationMemberIds,
      });
      await this.notificationProducer.enqueueWaitlistPromotions(tx, {
        activityTitle: promotion.activityTitle,
        promoted: promotion.promoted,
      });
      return toResponseDto(updated);
    });
  }

  private isPublishedDisplayOnly(dto: UpdateActivityDto): boolean {
    const fields = Object.keys(dto) as Array<keyof UpdateActivityDto>;
    return (
      fields.length > 0 && fields.every((field) => PUBLISHED_ACTIVITY_DISPLAY_FIELD_SET.has(field))
    );
  }
}
