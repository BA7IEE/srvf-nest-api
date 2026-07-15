import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import {
  ADMIN_ACTIVITY_CHECK_IN_LIST_SELECT,
  ADMIN_ACTIVITY_CHECK_IN_MEMBER_SELECT,
  ATTENDANCE_SHEET_DRAFT_CHECK_IN_SELECT,
  ATTENDANCE_SHEET_DRAFT_REGISTRATION_SELECT,
  type AdminActivityCheckInMemberRow,
} from './activity-check-in-field-policy';
import { ActivityCheckInPresenter } from './activity-check-in-presenter';
import {
  AdminActivityCheckInListItemDto,
  AttendanceSheetDraftDto,
  ListActivityCheckInsQueryDto,
} from './activity-check-ins.dto';

// Admin GPS 打卡只读查询边界。鉴权由 Admin application service 在调用本类前完成；本类只做
// activity 存在性、分页、固定次数批量查询与内存 join，不持有 Authz/RBAC，也不写任何表。
@Injectable()
export class ActivityCheckInQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presenter: ActivityCheckInPresenter,
  ) {}

  async list(
    activityId: string,
    query: ListActivityCheckInsQueryDto,
  ): Promise<PageResultDto<AdminActivityCheckInListItemDto>> {
    await this.findActivityOrThrow(activityId);

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
      this.prisma.activityCheckIn.findMany({
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
        mappedRecords.push(this.presenter.toAttendanceSheetDraftRecordDto(checkIn, activity.endAt));
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
      // 数据完整性被外部破坏，不能通过过滤 item 制造 total/items 漂移。
      throw new Error(`Activity check-in evidence member not found:${memberId}`);
    }
    return member;
  }
}
