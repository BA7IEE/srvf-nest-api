import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import {
  ADMIN_ACTIVITY_CHECK_IN_LIST_SELECT,
  ADMIN_ACTIVITY_CHECK_IN_MEMBER_SELECT,
  ATTENDANCE_SHEET_DRAFT_CHECK_IN_SELECT,
  ATTENDANCE_SHEET_DRAFT_REGISTRATION_SELECT,
  type AdminActivityCheckInListRow,
  type AdminActivityCheckInMemberRow,
  type AttendanceSheetDraftCheckInRow,
} from './activity-check-in-field-policy';
import { ActivityCheckInPresenter } from './activity-check-in-presenter';
import {
  AdminActivityCheckInListItemDto,
  AttendanceSheetDraftDto,
  ListActivityCheckInsQueryDto,
} from './activity-check-ins.dto';

/** Current official segments that should surface on list/draft reads. */
const OFFICIAL_SEGMENT_STATUS_CODES = ['draft', 'committed'] as const;
const OFFICIAL_SEGMENT_RESULT_CODES = ['valid', 'early_departure_zero'] as const;

const OFFICIAL_SEGMENT_LIST_SELECT = {
  id: true,
  createdAt: true,
  updatedAt: true,
  checkInAt: true,
  checkOutAt: true,
  sourceCheckInEvent: {
    select: { distance: true, geoVerified: true, outOfRange: true },
  },
  sourceCloseEvent: {
    select: { distance: true, geoVerified: true, outOfRange: true },
  },
  identity: {
    select: { activityId: true, registrationId: true, memberId: true },
  },
} as const satisfies Prisma.ParticipantServiceSegmentRevisionSelect;

type OfficialSegmentListRow = Prisma.ParticipantServiceSegmentRevisionGetPayload<{
  select: typeof OFFICIAL_SEGMENT_LIST_SELECT;
}>;

// Admin 打卡只读查询边界。鉴权由 Admin application service 在调用本类前完成；本类只做
// activity 存在性、分页、固定次数批量查询与内存 join，不持有 Authz/RBAC，也不写任何表。
// v1.1 闸开启后，list / attendance-sheet-draft 改读当前官方服务段
// (ParticipantServiceSegmentRevision + AttendancePunchEvent)，不再查询已切断写入的
// ActivityCheckIn / activity_check_ins。
@Injectable()
export class ActivityCheckInQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presenter: ActivityCheckInPresenter,
    private readonly activityWorkflowGate: ActivityWorkflowGate,
  ) {}

  async list(
    activityId: string,
    query: ListActivityCheckInsQueryDto,
  ): Promise<PageResultDto<AdminActivityCheckInListItemDto>> {
    await this.findActivityOrThrow(activityId);
    if (this.activityWorkflowGate.isV11Enabled()) {
      return this.listOfficialSegments(activityId, query);
    }

    const where = {
      activityId,
      deletedAt: null,
    } satisfies Prisma.ActivityCheckInWhereInput;
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.activityCheckIn.findMany({
        where,
        select: ADMIN_ACTIVITY_CHECK_IN_LIST_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.activityCheckIn.count({ where }),
    ]);

    // 证据列表必须在队员软删后仍可复核，因此这里只按主键 IN 批量取摘要，不加 deletedAt 过滤。
    // 即使当前页为空也执行一次 IN []，锁定 activity / rows / count / members 共 4 次业务查询。
    const memberIds = [...new Set(rows.map((row) => row.memberId))];
    const members = await this.prisma.member.findMany({
      where: { id: { in: memberIds } },
      select: ADMIN_ACTIVITY_CHECK_IN_MEMBER_SELECT,
    });
    const memberById = new Map(members.map((member) => [member.id, member]));

    return {
      items: rows.map((row) =>
        this.presenter.toAdminListItemDto(
          row,
          this.requireEvidenceMember(memberById, row.memberId),
        ),
      ),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async attendanceSheetDraft(activityId: string): Promise<AttendanceSheetDraftDto> {
    const activity = await this.findActivityOrThrow(activityId);

    // 当前仍 pass 且 Member 未软删的报名是草稿唯一基集；旧 cancelled/reject/pending 或软删报名
    // 不会进入后续 registrationId IN 查询，历史打卡因此自然出局。
    const registrations = await this.prisma.activityRegistration.findMany({
      where: {
        activityId,
        statusCode: 'pass',
        deletedAt: null,
        member: { deletedAt: null },
      },
      select: ATTENDANCE_SHEET_DRAFT_REGISTRATION_SELECT,
      orderBy: [{ registeredAt: 'asc' }, { id: 'asc' }],
    });
    const registrationIds = registrations.map((registration) => registration.id);
    const memberIds = [...new Set(registrations.map((registration) => registration.memberId))];

    // 固定两次 IN 批量查询；空集合也不提前返回。连同 activity + registrations，成功路径恒 4 次
    // 业务查询，且不会随报名/打卡数量增长。
    const [checkIns, members] = await Promise.all([
      this.activityWorkflowGate.isV11Enabled()
        ? this.loadOfficialDraftCheckIns(registrationIds)
        : this.prisma.activityCheckIn.findMany({
            where: { registrationId: { in: registrationIds }, deletedAt: null },
            select: ATTENDANCE_SHEET_DRAFT_CHECK_IN_SELECT,
          }),
      this.prisma.member.findMany({
        where: { id: { in: memberIds }, deletedAt: null },
        select: ADMIN_ACTIVITY_CHECK_IN_MEMBER_SELECT,
      }),
    ]);
    const checkInByRegistrationId = new Map(
      checkIns.map((checkIn) => [checkIn.registrationId, checkIn]),
    );
    const memberById = new Map(members.map((member) => [member.id, member]));

    const mappedRecords = [];
    const absentRegistrations = [];
    for (const registration of registrations) {
      // Member 可能在 registrations 与 members 两次读之间被软删；草稿保持“只纳入未软删
      // Member”的收窄语义，缺失摘要时不输出 record/absent，也不伪造空摘要。
      const member = memberById.get(registration.memberId);
      if (!member) continue;

      const checkIn = checkInByRegistrationId.get(registration.id);
      if (checkIn) {
        mappedRecords.push(
          this.presenter.toAttendanceSheetDraftRecordDto(
            checkIn,
            registration.activityPosition?.endAt ?? activity.endAt,
            registration.activityPosition?.attendanceRoleCode ?? 'member',
          ),
        );
      } else {
        absentRegistrations.push(
          this.presenter.toAttendanceSheetDraftAbsentRegistrationDto(registration, member),
        );
      }
    }

    return this.presenter.toAttendanceSheetDraftDto(
      activity.id,
      mappedRecords,
      absentRegistrations,
    );
  }

  private async listOfficialSegments(
    activityId: string,
    query: ListActivityCheckInsQueryDto,
  ): Promise<PageResultDto<AdminActivityCheckInListItemDto>> {
    const where = {
      statusCode: { in: [...OFFICIAL_SEGMENT_STATUS_CODES] },
      resultCode: { in: [...OFFICIAL_SEGMENT_RESULT_CODES] },
      identity: { activityId },
    } satisfies Prisma.ParticipantServiceSegmentRevisionWhereInput;
    const [segments, total] = await this.prisma.$transaction([
      this.prisma.participantServiceSegmentRevision.findMany({
        where,
        select: OFFICIAL_SEGMENT_LIST_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.participantServiceSegmentRevision.count({ where }),
    ]);
    const rows = segments.map((segment) => this.toAdminListRow(segment));

    // 与旧轨相同：即使当前页为空也执行一次 members IN []，锁定 4 次业务查询。
    const memberIds = [...new Set(rows.map((row) => row.memberId))];
    const members = await this.prisma.member.findMany({
      where: { id: { in: memberIds } },
      select: ADMIN_ACTIVITY_CHECK_IN_MEMBER_SELECT,
    });
    const memberById = new Map(members.map((member) => [member.id, member]));

    return {
      items: rows.map((row) =>
        this.presenter.toAdminListItemDto(
          row,
          this.requireEvidenceMember(memberById, row.memberId),
        ),
      ),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private async loadOfficialDraftCheckIns(
    registrationIds: readonly string[],
  ): Promise<AttendanceSheetDraftCheckInRow[]> {
    const segments = await this.prisma.participantServiceSegmentRevision.findMany({
      where: {
        statusCode: { in: [...OFFICIAL_SEGMENT_STATUS_CODES] },
        resultCode: { in: [...OFFICIAL_SEGMENT_RESULT_CODES] },
        identity: { registrationId: { in: [...registrationIds] } },
      },
      select: OFFICIAL_SEGMENT_LIST_SELECT,
      orderBy: [{ checkInAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });

    // 草稿仍按报名一行；同一报名多段时取最早签到、若有开放段则视为未签退，
    // 否则取最晚签退，geo 告警沿用最早签到事件（与旧 GPS 行语义对齐）。
    const byRegistration = new Map<string, OfficialSegmentListRow[]>();
    for (const segment of segments) {
      const registrationId = segment.identity.registrationId;
      const rows = byRegistration.get(registrationId);
      if (rows) rows.push(segment);
      else byRegistration.set(registrationId, [segment]);
    }

    const checkIns: AttendanceSheetDraftCheckInRow[] = [];
    for (const registrationId of registrationIds) {
      const rows = byRegistration.get(registrationId);
      if (!rows || rows.length === 0) continue;
      const first = rows[0];
      const open = rows.some((row) => row.checkOutAt === null);
      const latestClose = rows.reduce<Date | null>((latest, row) => {
        if (row.checkOutAt === null) return latest;
        if (latest === null || row.checkOutAt.getTime() > latest.getTime()) return row.checkOutAt;
        return latest;
      }, null);
      checkIns.push({
        registrationId,
        memberId: first.identity.memberId,
        checkInAt: first.checkInAt,
        checkOutAt: open ? null : latestClose,
        geoVerified: first.sourceCheckInEvent.geoVerified,
        outOfRange: rows.some((row) => row.sourceCheckInEvent.outOfRange),
      });
    }
    return checkIns;
  }

  private toAdminListRow(segment: OfficialSegmentListRow): AdminActivityCheckInListRow {
    return {
      id: segment.id,
      activityId: segment.identity.activityId,
      registrationId: segment.identity.registrationId,
      memberId: segment.identity.memberId,
      checkInAt: segment.checkInAt,
      checkOutAt: segment.checkOutAt,
      checkInDistance: segment.sourceCheckInEvent.distance,
      checkOutDistance: segment.sourceCloseEvent?.distance ?? null,
      geoVerified: segment.sourceCheckInEvent.geoVerified,
      outOfRange: segment.sourceCheckInEvent.outOfRange,
      createdAt: segment.createdAt,
      updatedAt: segment.updatedAt,
    };
  }

  private async findActivityOrThrow(activityId: string): Promise<{ id: string; endAt: Date }> {
    const activity = await this.prisma.activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: { id: true, endAt: true },
    });
    if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return activity;
  }

  private requireEvidenceMember(
    memberById: ReadonlyMap<string, AdminActivityCheckInMemberRow>,
    memberId: string,
  ): AdminActivityCheckInMemberRow {
    const member = memberById.get(memberId);
    if (!member) {
      // ActivityCheckIn.memberId 是 Restrict FK；列表又刻意读取含软删 Member，缺行只可能是
      // 数据完整性被外部破坏，不能通过过滤 item 制造 total/items 漂移。官方段同样按
      // memberId 强制对齐。
      throw new Error(`Activity check-in evidence member not found:${memberId}`);
    }
    return member;
  }
}
