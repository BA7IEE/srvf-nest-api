import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PageResultDto, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AppActivityDetailDto } from './dto/app/app-activity-detail.dto';
import { AppAvailableActivityListItemDto } from './dto/app/app-available-activity-list-item.dto';
import {
  AppActivityDirectoryListItemDto,
  AppActivityDirectoryQueryDto,
} from './dto/app/app-activity-directory.dto';
import { AppActivityPositionDto } from './dto/app/app-activity-position.dto';
import { deriveEffectiveActivityCapacity } from './activity-capacity';
import { deriveActivityPhase } from './activity-phase';
import { ActivityParticipationPolicy } from './activity-participation-policy';
import { registrationFormDefinitionFromStoredFields } from './registration-form-definition';

// Phase 2 P2-4a/P2-4b App /api/app/v1/activities/* service。
// 沿 docs/app-api-p2-4-activities-review.md §8.2 决议 D-P2-4-4 = 方案 B:
// **新建** AppActivitiesService(不复用 ActivitiesService.list / findOne);
// 私有 mapper toListItemDto / toDetailDto(不新建独立 AppActivityPresenter class;
// 沿 Phase 0.7 §13.3 P0/P1 过渡)。
//
// 铁律(沿评审稿 §6.5 + §8.3 + §13 风险表):
// - where 固定 `notDeletedWhere({ statusCode: 'published' })`;**不**接收任何 role / status 入参短路
// - select 严格 appActivityListItemSelect(11 字段)/ appActivityDetailSelect(13 字段;
//   沿评审稿 §4.1 / §5.1 锁定);从 SQL 源头切断字段泄漏
// - canUseApp 校验由 Controller 完成(沿评审稿 §6.1);Service 入参 memberId 已通过准入
// - list/detail 不 import ActivitiesService / ActivityRegistrationsService；活动岗位 F3 新增的
//   listPositionsForMember 仅直读 ActivityRegistration 的 passCount / 当前本人 active 防重态，
//   不调用 sibling service、不返回报名人信息
// - 不可见活动统一 throw ACTIVITY_NOT_FOUND(D-P2-4-3 v0.1 锁定;避免存在性侧信道)

// 列表精简 select(沿评审稿 §8.3 + §4.1 v0.1 锁定 11 项)。
// **不** select:description / organizationId / genderRequirementCode / isPublicRegistration /
// registrationNotes / registrationSchema / galleryImageUrls / content /
// locationLongitude / locationLatitude / updatedAt / 任何 audit 字段。
const appActivityListItemSelect = {
  id: true,
  title: true,
  activityTypeCode: true,
  statusCode: true,
  startAt: true,
  endAt: true,
  location: true,
  capacity: true,
  registrationDeadline: true,
  coverImageUrl: true,
  createdAt: true,
  activityPositions: {
    where: { deletedAt: null },
    select: { capacity: true },
  },
} as const satisfies Prisma.ActivitySelect;

type AppActivityListRow = Prisma.ActivityGetPayload<{ select: typeof appActivityListItemSelect }>;

// 详情精简 select(沿评审稿 §8.3 + §5.1 v0.1 锁定 13 项)。
// 在 list 11 项基础上追加 description + registrationNotes。
// **不** select:registrationSchema / galleryImageUrls / content / locationLongitude /
// locationLatitude / updatedAt / organizationId / genderRequirementCode /
// isPublicRegistration / 任何 audit 字段(publishedBy / publishedAt / cancelledBy /
// cancelledAt / cancelReason / deletedAt)。
const appActivityDetailSelect = {
  id: true,
  title: true,
  description: true,
  activityTypeCode: true,
  statusCode: true,
  startAt: true,
  endAt: true,
  location: true,
  capacity: true,
  registrationDeadline: true,
  registrationNotes: true,
  genderRequirementCode: true,
  requiresInsurance: true,
  registrationModeCode: true,
  coverImageUrl: true,
  createdAt: true,
  activityPositions: {
    where: { deletedAt: null },
    select: { capacity: true },
  },
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
      capacity: true,
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
          description: true,
          equipmentNotes: true,
          sortOrder: true,
        },
      },
    },
  },
  registrationFormVersions: {
    where: { statusCode: 'active' },
    orderBy: [{ version: 'desc' }, { id: 'desc' }],
    take: 1,
    select: {
      version: true,
      fields: {
        orderBy: [{ sortOrder: 'asc' }, { fieldCode: 'asc' }],
        select: {
          fieldCode: true,
          typeCode: true,
          label: true,
          helpText: true,
          required: true,
          visibilityCode: true,
          exportable: true,
          sortOrder: true,
          minValue: true,
          maxValue: true,
          minLength: true,
          maxLength: true,
          maxSelections: true,
          optionsJson: true,
        },
      },
    },
  },
} as const satisfies Prisma.ActivitySelect;

type AppActivityDetailRow = Prisma.ActivityGetPayload<{ select: typeof appActivityDetailSelect }>;

type AppActivityDetailInvitationRow = {
  id: string;
  sessionId: string | null;
  positionId: string | null;
  statusCode: string;
  expiresAt: Date;
};

const appActivityDirectorySelect = {
  id: true,
  title: true,
  activityTypeCode: true,
  statusCode: true,
  startAt: true,
  endAt: true,
  location: true,
  registrationModeCode: true,
  createdAt: true,
} as const satisfies Prisma.ActivitySelect;

type AppActivityDirectoryRow = Prisma.ActivityGetPayload<{
  select: typeof appActivityDirectorySelect;
}>;

@Injectable()
export class AppActivitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityParticipationPolicy: ActivityParticipationPolicy,
  ) {}

  // 入参 memberId 在 v0.1 实际**未参与 where 过滤**(沿评审稿 §6.5 + §8.3):published
  // 活动池对全员相同。保留 memberId 入参为后续 P2-5+ 若引入"已报名活动从列表排除"留扩展槽,
  // 同时保留调用链显式语义(列表是 App self perspective)。
  async listAvailableForMember(
    _memberId: string,
    query: PaginationQueryDto,
  ): Promise<PageResultDto<AppAvailableActivityListItemDto>> {
    const { page, pageSize } = query;
    // 参与域生命周期收口③(v0.40.0):可报名池过滤已结束活动 —— 追加 endAt >= now,已结束
    // (endAt < now)的 published 活动退出 App 可报名列表。detail(findVisibleByIdForMember)
    // 口径**刻意不动**:published 即可见,已报名者回看已结束活动无碍。
    const where = notDeletedWhere({
      statusCode: 'published',
      isPublicRegistration: true,
      endAt: { gte: new Date() },
    });

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.activity.findMany({
        where,
        select: appActivityListItemSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.activity.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.toListItemDto(r)),
      total,
      page,
      pageSize,
    };
  }

  /**
   * 内部活动目录与旧 `/available` 刻意分面：它不要求公开报名、也不按活动结束时刻
   * 收缩，但仍只读 published，并在 SQL where 内完成 invitation 可见性过滤。
   */
  async listDirectoryForMember(
    memberId: string,
    query: AppActivityDirectoryQueryDto,
  ): Promise<PageResultDto<AppActivityDirectoryListItemDto>> {
    const now = new Date();
    const filters: Prisma.ActivityWhereInput[] = [this.memberVisibilityWhere(memberId, now)];
    if (query.q !== undefined) {
      filters.push({ title: { contains: query.q, mode: 'insensitive' } });
    }
    if (query.type !== undefined) filters.push({ activityTypeCode: query.type });
    if (query.organization !== undefined) filters.push({ organizationId: query.organization });
    if (query.date !== undefined) {
      const dayStart = new Date(`${query.date}T00:00:00.000Z`);
      const dayEnd = new Date(dayStart);
      dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
      // 与该 UTC 自然日有交集：活动在日末前开始、且在日初后结束。
      filters.push({ startAt: { lt: dayEnd }, endAt: { gt: dayStart } });
    }

    const where = notDeletedWhere({ statusCode: 'published', AND: filters });
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.activity.findMany({
        where,
        select: appActivityDirectorySelect,
        orderBy: [{ startAt: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.activity.count({ where }),
    ]);
    return {
      items: rows.map((row) => this.toDirectoryListItemDto(row)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  // 关键铁律(沿评审稿 §8.3 / D-P2-4-3 / 风险 13.9):
  // - statusCode='published' 直接在 where 子句过滤,**不**走"先查再判断"模式
  //   (避免存在性侧信道:draft / cancelled / completed / softDeleted / 不存在均走同一
  //   查询 → null → throw,SQL plan 一致)
  // - findFirst 命中 null 统一抛 ACTIVITY_NOT_FOUND(D-P2-4-3 v0.1 锁定 404,不返 403)
  async findVisibleByIdForMember(id: string, memberId: string): Promise<AppActivityDetailDto> {
    const now = new Date();
    const [row, passCount, invitations] = await this.prisma.$transaction([
      this.prisma.activity.findFirst({
        where: notDeletedWhere({
          id,
          statusCode: 'published',
          ...this.memberVisibilityWhere(memberId, now),
        }),
        select: appActivityDetailSelect,
      }),
      this.prisma.activityRegistration.count({
        where: notDeletedWhere({ activityId: id, statusCode: 'pass' }),
      }),
      this.prisma.activityInvitation.findMany({
        where: { activityId: id, memberId },
        select: {
          id: true,
          sessionId: true,
          positionId: true,
          statusCode: true,
          expiresAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);

    if (row === null) {
      throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    }

    return this.toDetailDto(row, passCount, invitations, now);
  }

  async listPositionsForMember(
    activityId: string,
    memberId: string,
  ): Promise<AppActivityPositionDto[]> {
    const [activity, memberProfile, activeRegistration] = await this.prisma.$transaction([
      this.prisma.activity.findFirst({
        where: notDeletedWhere({
          id: activityId,
          statusCode: 'published',
          isPublicRegistration: true,
        }),
        select: {
          statusCode: true,
          isPublicRegistration: true,
          registrationDeadline: true,
          endAt: true,
          genderRequirementCode: true,
          activityPositions: {
            where: { deletedAt: null },
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
              _count: {
                select: {
                  registrations: { where: { statusCode: 'pass', deletedAt: null } },
                },
              },
            },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
          },
        },
      }),
      this.prisma.memberProfile.findFirst({
        where: notDeletedWhere({ memberId }),
        select: { genderCode: true },
      }),
      this.prisma.activityRegistration.findFirst({
        where: {
          activityId,
          memberId,
          deletedAt: null,
          statusCode: { not: 'cancelled' },
        },
        select: { id: true },
      }),
    ]);
    if (activity === null) {
      throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    }

    const activityCanRegister = this.activityParticipationPolicy.canRegisterSelf(activity).allowed;
    const matchesGender = (genderRequirementCode: string | null): boolean =>
      genderRequirementCode === null ||
      genderRequirementCode === 'any' ||
      memberProfile?.genderCode === genderRequirementCode;
    const commonCanRegister =
      activityCanRegister &&
      activeRegistration === null &&
      matchesGender(activity.genderRequirementCode);

    return activity.activityPositions.map((activityPosition) => ({
      activityPositionId: activityPosition.id,
      name: activityPosition.name,
      attendanceRoleCode: activityPosition.attendanceRoleCode,
      capacity: activityPosition.capacity,
      remainingCapacity:
        activityPosition.capacity === null
          ? null
          : Math.max(activityPosition.capacity - activityPosition._count.registrations, 0),
      startAt: activityPosition.startAt,
      endAt: activityPosition.endAt,
      genderRequirementCode: activityPosition.genderRequirementCode,
      description: activityPosition.description,
      sortOrder: activityPosition.sortOrder,
      canRegister: commonCanRegister && matchesGender(activityPosition.genderRequirementCode),
    }));
  }

  private memberVisibilityWhere(memberId: string, now: Date): Prisma.ActivityWhereInput {
    // `visibilityCode=null` 是 expand 期间尚未解析的旧行，沿本刀“内部读面优先复用”
    // 收敛为 internal；只有显式 invitation 才要求本人有有效邀请记录。
    return {
      OR: [
        { visibilityCode: null },
        { visibilityCode: { not: 'invitation' } },
        {
          invitations: {
            some: {
              memberId,
              OR: [{ statusCode: 'accepted' }, { statusCode: 'pending', expiresAt: { gt: now } }],
            },
          },
        },
      ],
    };
  }

  // 私有 mapper(沿评审稿 §8.3.3;第一版不抽独立 Presenter class)。
  private toListItemDto(row: AppActivityListRow): AppAvailableActivityListItemDto {
    return {
      id: row.id,
      title: row.title,
      activityTypeCode: row.activityTypeCode,
      statusCode: row.statusCode,
      startAt: row.startAt,
      endAt: row.endAt,
      location: row.location,
      capacity: deriveEffectiveActivityCapacity(row.capacity, row.activityPositions),
      registrationDeadline: row.registrationDeadline,
      coverImageUrl: row.coverImageUrl,
      createdAt: row.createdAt,
    };
  }

  private toDetailDto(
    row: AppActivityDetailRow,
    passCount: number,
    invitations: AppActivityDetailInvitationRow[],
    now: Date,
  ): AppActivityDetailDto {
    const activeForm = row.registrationFormVersions[0] ?? null;
    const registrationForm = activeForm
      ? {
          version: activeForm.version,
          fields: registrationFormDefinitionFromStoredFields(activeForm.fields).definition.fields,
        }
      : null;
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      activityTypeCode: row.activityTypeCode,
      statusCode: row.statusCode,
      phase: deriveActivityPhase(row.startAt, row.endAt),
      startAt: row.startAt,
      endAt: row.endAt,
      location: row.location,
      capacity: deriveEffectiveActivityCapacity(row.capacity, row.activityPositions),
      registrationDeadline: row.registrationDeadline,
      registrationNotes: row.registrationNotes,
      genderRequirementCode: row.genderRequirementCode,
      requiresInsurance: row.requiresInsurance,
      passCount,
      coverImageUrl: row.coverImageUrl,
      createdAt: row.createdAt,
      registrationMode: row.registrationModeCode,
      formVersion: registrationForm?.version ?? null,
      registrationForm,
      myInvitations: invitations.map((invitation) => ({
        invitationId: invitation.id,
        scope:
          invitation.positionId !== null
            ? 'position'
            : invitation.sessionId !== null
              ? 'session'
              : 'activity',
        status:
          invitation.statusCode === 'pending' && invitation.expiresAt.getTime() <= now.getTime()
            ? 'expired'
            : invitation.statusCode,
        expiresAt: invitation.expiresAt,
      })),
      sessions: row.sessions.map((session) => ({
        id: session.id,
        code: session.code,
        name: session.name,
        startAt: session.startAt,
        endAt: session.endAt,
        locationText: session.locationText,
        capacity: session.capacity,
        positions: session.positions.map((position) => ({
          id: position.id,
          code: position.code,
          name: position.name,
          attendanceRoleCode: position.attendanceRoleCode,
          capacity: position.capacity,
          startAt: position.startAt,
          endAt: position.endAt,
          genderRequirementCode: position.genderRequirementCode,
          description: position.description,
          equipmentNotes: position.equipmentNotes,
          sortOrder: position.sortOrder,
        })),
      })),
    };
  }

  private toDirectoryListItemDto(row: AppActivityDirectoryRow): AppActivityDirectoryListItemDto {
    return {
      id: row.id,
      title: row.title,
      activityTypeCode: row.activityTypeCode,
      // where 已钉 published，DTO 用 literal 是为了不把未来状态意外露到 App。
      statusCode: 'published',
      startAt: row.startAt,
      endAt: row.endAt,
      location: row.location,
      registrationMode: row.registrationModeCode,
      createdAt: row.createdAt,
    };
  }
}
