import { Injectable } from '@nestjs/common';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AdminActivityCheckInsService } from './admin-activity-check-ins.service';
import type {
  AttendanceSheetResponseDto,
  AttendanceSheetReviewDetailDto,
  CreateAttendanceSheetDto,
  UpdateAttendanceSheetDto,
} from './attendances.dto';
import { AttendancesService } from './attendances.service';
import {
  AppManagedActivityCheckInDto,
  AppManagedActivityCheckInsQueryDto,
  AppManagedAttendanceSheetDetailDto,
  AppManagedAttendanceSheetDraftDto,
  AppManagedAttendanceSheetDto,
  AppManagedAttendanceSheetListItemDto,
  AppManagedAttendanceSheetsQueryDto,
  CreateAppManagedAttendanceSheetDto,
  ResubmitAppManagedAttendanceSheetDto,
  UpdateAppManagedAttendanceSheetDto,
} from './dto/app/app-managed-attendance.dto';

@Injectable()
export class AppManagedActivityAttendancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly checkIns: AdminActivityCheckInsService,
    private readonly attendances: AttendancesService,
  ) {}

  private async assertAttendanceResponsibility(
    activityId: string,
    currentUser: CurrentUserPayload,
  ): Promise<void> {
    if (!currentUser.memberId) throw new BizException(BizCode.RBAC_FORBIDDEN);
    const assignment = await this.prisma.activityResponsibilityAssignment.findFirst({
      where: {
        activityId,
        memberId: currentUser.memberId,
        status: 'active',
        canManageAttendance: true,
      },
      select: { id: true },
    });
    if (!assignment) throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  async listCheckIns(
    activityId: string,
    query: AppManagedActivityCheckInsQueryDto,
    user: CurrentUserPayload,
  ): Promise<PageResultDto<AppManagedActivityCheckInDto>> {
    await this.assertAttendanceResponsibility(activityId, user);
    const page = await this.checkIns.list(activityId, query, user);
    return {
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
      items: page.items.map((item) => ({
        id: item.id,
        activityId: item.activityId,
        registrationId: item.registrationId,
        member: {
          id: item.member.id,
          memberNo: item.member.memberNo,
          displayName: item.member.displayName,
        },
        checkInAt: item.checkInAt,
        checkOutAt: item.checkOutAt,
        checkInDistance: item.checkInDistance,
        checkOutDistance: item.checkOutDistance,
        geoVerified: item.geoVerified,
        outOfRange: item.outOfRange,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
    };
  }

  async attendanceSheetDraft(
    activityId: string,
    user: CurrentUserPayload,
  ): Promise<AppManagedAttendanceSheetDraftDto> {
    await this.assertAttendanceResponsibility(activityId, user);
    const draft = await this.checkIns.attendanceSheetDraft(activityId, user);
    return {
      activityId: draft.activityId,
      records: draft.records.map((record) => ({
        memberId: record.memberId,
        roleCode: record.roleCode,
        checkInAt: record.checkInAt,
        checkOutAt: record.checkOutAt,
        serviceHours: record.serviceHours,
        attendanceStatusCode: record.attendanceStatusCode,
        registrationId: record.registrationId,
      })),
      flags: draft.flags.map((flag) => ({
        registrationId: flag.registrationId,
        memberId: flag.memberId,
        noCheckOut: flag.noCheckOut,
        outOfRange: flag.outOfRange,
        unverified: flag.unverified,
      })),
      absentRegistrations: draft.absentRegistrations.map((registration) => ({
        registrationId: registration.registrationId,
        memberId: registration.memberId,
        memberNo: registration.memberNo,
        displayName: registration.displayName,
      })),
    };
  }

  async listSheets(
    activityId: string,
    query: AppManagedAttendanceSheetsQueryDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<PageResultDto<AppManagedAttendanceSheetListItemDto>> {
    const page = await this.attendances.list(activityId, query, user, auditMeta, 'managed');
    return {
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
      items: page.items.map((item) => ({
        id: item.id,
        activityId: item.activityId,
        submitterUserId: item.submitterUserId,
        submittedAt: item.submittedAt,
        statusCode: item.statusCode,
        reviewedAt: item.reviewedAt,
        version: item.version,
        createdAt: item.createdAt,
      })),
    };
  }

  async submit(
    activityId: string,
    dto: CreateAppManagedAttendanceSheetDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedAttendanceSheetDto> {
    const input: CreateAttendanceSheetDto = {
      records: dto.records.map((record) => ({
        memberId: record.memberId,
        roleCode: record.roleCode,
        checkInAt: record.checkInAt,
        checkOutAt: record.checkOutAt,
        serviceHours: record.serviceHours,
        attendanceStatusCode: record.attendanceStatusCode,
        note: record.note,
        registrationId: record.registrationId,
      })),
    };
    return this.toSheet(
      await this.attendances.submit(activityId, input, user, auditMeta, 'managed'),
    );
  }

  async detail(
    activityId: string,
    sheetId: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedAttendanceSheetDetailDto> {
    const detail = await this.attendances.reviewDetail(sheetId, user, auditMeta, activityId);
    return this.toDetail(detail);
  }

  async edit(
    activityId: string,
    sheetId: string,
    dto: UpdateAppManagedAttendanceSheetDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedAttendanceSheetDto> {
    const input: UpdateAttendanceSheetDto = {
      records: dto.records?.map((record) => ({
        memberId: record.memberId,
        roleCode: record.roleCode,
        checkInAt: record.checkInAt,
        checkOutAt: record.checkOutAt,
        serviceHours: record.serviceHours,
        attendanceStatusCode: record.attendanceStatusCode,
        note: record.note,
        registrationId: record.registrationId,
      })),
    };
    return this.toSheet(await this.attendances.edit(sheetId, input, user, auditMeta, activityId));
  }

  async softDelete(
    activityId: string,
    sheetId: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedAttendanceSheetDto> {
    return this.toSheet(await this.attendances.softDelete(sheetId, user, auditMeta, activityId));
  }

  async resubmit(
    activityId: string,
    sheetId: string,
    dto: ResubmitAppManagedAttendanceSheetDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedAttendanceSheetDto> {
    return this.toSheet(await this.attendances.resubmit(sheetId, dto, user, auditMeta, activityId));
  }

  private toSheet(sheet: AttendanceSheetResponseDto): AppManagedAttendanceSheetDto {
    return {
      id: sheet.id,
      activityId: sheet.activityId,
      submitterUserId: sheet.submitterUserId,
      submittedAt: sheet.submittedAt,
      statusCode: sheet.statusCode,
      reviewerUserId: sheet.reviewerUserId,
      reviewedAt: sheet.reviewedAt,
      reviewNote: sheet.reviewNote,
      finalReviewerUserId: sheet.finalReviewerUserId,
      finalReviewedAt: sheet.finalReviewedAt,
      finalReviewNote: sheet.finalReviewNote,
      lastSubmittedByUserId: sheet.lastSubmittedByUserId,
      lastSubmittedAt: sheet.lastSubmittedAt,
      returnedByUserId: sheet.returnedByUserId,
      returnedAt: sheet.returnedAt,
      returnNote: sheet.returnNote,
      returnedFromStageCode: sheet.returnedFromStageCode,
      version: sheet.version,
      createdAt: sheet.createdAt,
      updatedAt: sheet.updatedAt,
    };
  }

  private toDetail(detail: AttendanceSheetReviewDetailDto): AppManagedAttendanceSheetDetailDto {
    return {
      sheet: this.toSheet(detail.sheet),
      records: detail.records.map((record) => ({
        id: record.id,
        sheetId: record.sheetId,
        memberId: record.memberId,
        member: record.member
          ? {
              id: record.member.id,
              memberNo: record.member.memberNo,
              displayName: record.member.displayName,
            }
          : null,
        roleCode: record.roleCode,
        checkInAt: record.checkInAt,
        checkOutAt: record.checkOutAt,
        serviceHours: record.serviceHours,
        attendanceStatusCode: record.attendanceStatusCode,
        note: record.note,
        registrationId: record.registrationId,
        contributionPoints: record.contributionPoints,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })),
    };
  }
}
