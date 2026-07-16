import { Injectable } from '@nestjs/common';
import {
  ActivityCheckInFieldPolicy,
  type AdminActivityCheckInListRow,
  type AdminActivityCheckInMemberRow,
  type AppActivityCheckInRow,
  type AttendanceSheetDraftCheckInRow,
  type AttendanceSheetDraftRegistrationRow,
} from './activity-check-in-field-policy';
import {
  AdminActivityCheckInListItemDto,
  AttendanceSheetDraftAbsentRegistrationDto,
  AttendanceSheetDraftDto,
  AttendanceSheetDraftFlagDto,
  AttendanceSheetDraftRecordDto,
} from './activity-check-ins.dto';
import { AppActivityCheckInDto } from './dto/app/app-activity-check-in.dto';

export interface AttendanceSheetDraftMappedRecord {
  record: AttendanceSheetDraftRecordDto;
  flag: AttendanceSheetDraftFlagDto;
}

@Injectable()
export class ActivityCheckInPresenter {
  constructor(private readonly fields: ActivityCheckInFieldPolicy) {}

  toAppDto(row: AppActivityCheckInRow): AppActivityCheckInDto {
    const dto: AppActivityCheckInDto = {
      id: row.id,
      activityId: row.activityId,
      registrationId: row.registrationId,
      checkInAt: row.checkInAt,
      checkOutAt: row.checkOutAt,
      checkInDistance: row.checkInDistance?.toString() ?? null,
      checkOutDistance: row.checkOutDistance?.toString() ?? null,
      geoVerified: row.geoVerified,
      outOfRange: row.outOfRange,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    this.fields.assertAppResponse(dto as unknown as Record<string, unknown>);
    return dto;
  }

  toAdminListItemDto(
    row: AdminActivityCheckInListRow,
    member: AdminActivityCheckInMemberRow,
  ): AdminActivityCheckInListItemDto {
    this.assertMatchingMember(row.memberId, member.id);
    const dto: AdminActivityCheckInListItemDto = {
      id: row.id,
      activityId: row.activityId,
      registrationId: row.registrationId,
      member: {
        id: member.id,
        memberNo: member.memberNo,
        displayName: member.displayName,
      },
      checkInAt: row.checkInAt,
      checkOutAt: row.checkOutAt,
      checkInDistance: row.checkInDistance?.toString() ?? null,
      checkOutDistance: row.checkOutDistance?.toString() ?? null,
      geoVerified: row.geoVerified,
      outOfRange: row.outOfRange,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    this.fields.assertAdminListItemResponse(dto as unknown as Record<string, unknown>);
    return dto;
  }

  toAttendanceSheetDraftRecordDto(
    row: AttendanceSheetDraftCheckInRow,
    fallbackEndAt: Date,
    roleCode: string,
  ): AttendanceSheetDraftMappedRecord {
    const noCheckOut = row.checkOutAt === null;
    const checkOutAt = row.checkOutAt ?? fallbackEndAt;
    const record: AttendanceSheetDraftRecordDto = {
      memberId: row.memberId,
      roleCode,
      checkInAt: row.checkInAt,
      checkOutAt,
      serviceHours: this.spanHours(row.checkInAt, checkOutAt),
      attendanceStatusCode: 'present',
      registrationId: row.registrationId,
    };
    const flag: AttendanceSheetDraftFlagDto = {
      registrationId: row.registrationId,
      memberId: row.memberId,
      noCheckOut,
      outOfRange: row.outOfRange,
      unverified: !row.geoVerified,
    };
    this.fields.assertAttendanceSheetDraftRecordResponse(
      record as unknown as Record<string, unknown>,
    );
    this.fields.assertAttendanceSheetDraftFlagResponse(flag as unknown as Record<string, unknown>);
    return { record, flag };
  }

  toAttendanceSheetDraftAbsentRegistrationDto(
    registration: AttendanceSheetDraftRegistrationRow,
    member: AdminActivityCheckInMemberRow,
  ): AttendanceSheetDraftAbsentRegistrationDto {
    this.assertMatchingMember(registration.memberId, member.id);
    const dto: AttendanceSheetDraftAbsentRegistrationDto = {
      registrationId: registration.id,
      memberId: member.id,
      memberNo: member.memberNo,
      displayName: member.displayName,
    };
    this.fields.assertAttendanceSheetDraftAbsentResponse(dto as unknown as Record<string, unknown>);
    return dto;
  }

  toAttendanceSheetDraftDto(
    activityId: string,
    mappedRecords: readonly AttendanceSheetDraftMappedRecord[],
    absentRegistrations: readonly AttendanceSheetDraftAbsentRegistrationDto[],
  ): AttendanceSheetDraftDto {
    const dto: AttendanceSheetDraftDto = {
      activityId,
      records: mappedRecords.map(({ record }) => record),
      flags: mappedRecords.map(({ flag }) => flag),
      absentRegistrations: [...absentRegistrations],
    };
    this.fields.assertAttendanceSheetDraftResponse(dto as unknown as Record<string, unknown>);
    return dto;
  }

  private spanHours(checkInAt: Date, checkOutAt: Date): number {
    const milliseconds = checkOutAt.getTime() - checkInAt.getTime();
    return Math.round((milliseconds / 3_600_000) * 100) / 100;
  }

  private assertMatchingMember(expectedMemberId: string, actualMemberId: string): void {
    if (expectedMemberId !== actualMemberId) {
      throw new Error('Activity check-in member join mismatch');
    }
  }
}
