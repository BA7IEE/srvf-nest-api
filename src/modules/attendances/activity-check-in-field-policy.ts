import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export const APP_ACTIVITY_CHECK_IN_RESPONSE_FIELDS = [
  'id',
  'activityId',
  'registrationId',
  'checkInAt',
  'checkOutAt',
  'checkInDistance',
  'checkOutDistance',
  'geoVerified',
  'outOfRange',
  'createdAt',
  'updatedAt',
] as const;

export const ACTIVITY_CHECK_IN_RAW_RESPONSE_DENIED_FIELDS = [
  'checkInLongitude',
  'checkInLatitude',
  'checkInAccuracy',
  'checkOutLongitude',
  'checkOutLatitude',
  'checkOutAccuracy',
  'deletedAt',
] as const;

// App 与 Admin 列表都不得把 ActivityCheckIn.memberId 作为顶层字段回显。Admin 只在
// member 摘要中返回 Member.id；draft 则按冻结契约显式返回 memberId。
export const ACTIVITY_CHECK_IN_RESPONSE_DENIED_FIELDS = [
  'memberId',
  ...ACTIVITY_CHECK_IN_RAW_RESPONSE_DENIED_FIELDS,
] as const;

export const ADMIN_ACTIVITY_CHECK_IN_LIST_RESPONSE_FIELDS = [
  'id',
  'activityId',
  'registrationId',
  'member',
  'checkInAt',
  'checkOutAt',
  'checkInDistance',
  'checkOutDistance',
  'geoVerified',
  'outOfRange',
  'createdAt',
  'updatedAt',
] as const;

export const ADMIN_ACTIVITY_CHECK_IN_MEMBER_RESPONSE_FIELDS = [
  'id',
  'memberNo',
  'displayName',
] as const;

export const ATTENDANCE_SHEET_DRAFT_RESPONSE_FIELDS = [
  'activityId',
  'records',
  'flags',
  'absentRegistrations',
] as const;

export const ATTENDANCE_SHEET_DRAFT_RECORD_RESPONSE_FIELDS = [
  'memberId',
  'roleCode',
  'checkInAt',
  'checkOutAt',
  'serviceHours',
  'attendanceStatusCode',
  'registrationId',
] as const;

export const ATTENDANCE_SHEET_DRAFT_FLAG_RESPONSE_FIELDS = [
  'registrationId',
  'memberId',
  'noCheckOut',
  'outOfRange',
  'unverified',
] as const;

export const ATTENDANCE_SHEET_DRAFT_ABSENT_RESPONSE_FIELDS = [
  'registrationId',
  'memberId',
  'memberNo',
  'displayName',
] as const;

export const APP_ACTIVITY_CHECK_IN_SELECT = {
  id: true,
  activityId: true,
  registrationId: true,
  checkInAt: true,
  checkOutAt: true,
  checkInDistance: true,
  checkOutDistance: true,
  geoVerified: true,
  outOfRange: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ActivityCheckInSelect;

export type AppActivityCheckInRow = Prisma.ActivityCheckInGetPayload<{
  select: typeof APP_ACTIVITY_CHECK_IN_SELECT;
}>;

// 列表按固定查询预算单独批量读取 Member，因此内部 select 只额外携带 memberId 作为
// join key；原始坐标与 accuracy 从 Prisma 结果层就不可达。
export const ADMIN_ACTIVITY_CHECK_IN_LIST_SELECT = {
  id: true,
  activityId: true,
  registrationId: true,
  memberId: true,
  checkInAt: true,
  checkOutAt: true,
  checkInDistance: true,
  checkOutDistance: true,
  geoVerified: true,
  outOfRange: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ActivityCheckInSelect;

export type AdminActivityCheckInListRow = Prisma.ActivityCheckInGetPayload<{
  select: typeof ADMIN_ACTIVITY_CHECK_IN_LIST_SELECT;
}>;

export const ADMIN_ACTIVITY_CHECK_IN_MEMBER_SELECT = {
  id: true,
  memberNo: true,
  displayName: true,
} as const satisfies Prisma.MemberSelect;

export type AdminActivityCheckInMemberRow = Prisma.MemberGetPayload<{
  select: typeof ADMIN_ACTIVITY_CHECK_IN_MEMBER_SELECT;
}>;

export const ATTENDANCE_SHEET_DRAFT_CHECK_IN_SELECT = {
  registrationId: true,
  memberId: true,
  checkInAt: true,
  checkOutAt: true,
  geoVerified: true,
  outOfRange: true,
} as const satisfies Prisma.ActivityCheckInSelect;

export type AttendanceSheetDraftCheckInRow = Prisma.ActivityCheckInGetPayload<{
  select: typeof ATTENDANCE_SHEET_DRAFT_CHECK_IN_SELECT;
}>;

export const ATTENDANCE_SHEET_DRAFT_REGISTRATION_SELECT = {
  id: true,
  memberId: true,
} as const satisfies Prisma.ActivityRegistrationSelect;

export type AttendanceSheetDraftRegistrationRow = Prisma.ActivityRegistrationGetPayload<{
  select: typeof ATTENDANCE_SHEET_DRAFT_REGISTRATION_SELECT;
}>;

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} field policy mismatch`);
  }
}

function assertExactFields(
  payload: Record<string, unknown>,
  expectedFields: readonly string[],
  label: string,
): void {
  const actual = Object.keys(payload).sort();
  const expected = [...expectedFields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} field policy mismatch`);
  }
}

function assertDeniedFields(
  payload: Record<string, unknown>,
  deniedFields: readonly string[],
  label: string,
): void {
  for (const denied of deniedFields) {
    if (Object.prototype.hasOwnProperty.call(payload, denied)) {
      throw new Error(`${label} contains denied field:${denied}`);
    }
  }
}

// Safe select 与响应 allowlist 的单一权威。Presenter 在返回前执行精确字段断言，避免未来
// mapper 扩展时把原始坐标、accuracy 或 memberId 悄悄带入 App/Admin surface。
@Injectable()
export class ActivityCheckInFieldPolicy {
  readonly appSelect = APP_ACTIVITY_CHECK_IN_SELECT;
  readonly adminListSelect = ADMIN_ACTIVITY_CHECK_IN_LIST_SELECT;
  readonly adminMemberSelect = ADMIN_ACTIVITY_CHECK_IN_MEMBER_SELECT;
  readonly draftCheckInSelect = ATTENDANCE_SHEET_DRAFT_CHECK_IN_SELECT;
  readonly draftRegistrationSelect = ATTENDANCE_SHEET_DRAFT_REGISTRATION_SELECT;

  assertAppResponse(payload: Record<string, unknown>): void {
    assertExactFields(
      payload,
      APP_ACTIVITY_CHECK_IN_RESPONSE_FIELDS,
      'App activity check-in response',
    );
    assertDeniedFields(
      payload,
      ACTIVITY_CHECK_IN_RESPONSE_DENIED_FIELDS,
      'App activity check-in response',
    );
  }

  assertAdminListItemResponse(payload: Record<string, unknown>): void {
    assertExactFields(
      payload,
      ADMIN_ACTIVITY_CHECK_IN_LIST_RESPONSE_FIELDS,
      'Admin activity check-in list item response',
    );
    assertDeniedFields(
      payload,
      ACTIVITY_CHECK_IN_RESPONSE_DENIED_FIELDS,
      'Admin activity check-in list item response',
    );
    assertRecord(payload.member, 'Admin activity check-in member response');
    assertExactFields(
      payload.member,
      ADMIN_ACTIVITY_CHECK_IN_MEMBER_RESPONSE_FIELDS,
      'Admin activity check-in member response',
    );
    assertDeniedFields(
      payload.member,
      ACTIVITY_CHECK_IN_RAW_RESPONSE_DENIED_FIELDS,
      'Admin activity check-in member response',
    );
  }

  assertAttendanceSheetDraftRecordResponse(payload: Record<string, unknown>): void {
    assertExactFields(
      payload,
      ATTENDANCE_SHEET_DRAFT_RECORD_RESPONSE_FIELDS,
      'Attendance sheet draft record response',
    );
    assertDeniedFields(
      payload,
      ACTIVITY_CHECK_IN_RAW_RESPONSE_DENIED_FIELDS,
      'Attendance sheet draft record response',
    );
  }

  assertAttendanceSheetDraftFlagResponse(payload: Record<string, unknown>): void {
    assertExactFields(
      payload,
      ATTENDANCE_SHEET_DRAFT_FLAG_RESPONSE_FIELDS,
      'Attendance sheet draft flag response',
    );
    assertDeniedFields(
      payload,
      ACTIVITY_CHECK_IN_RAW_RESPONSE_DENIED_FIELDS,
      'Attendance sheet draft flag response',
    );
  }

  assertAttendanceSheetDraftAbsentResponse(payload: Record<string, unknown>): void {
    assertExactFields(
      payload,
      ATTENDANCE_SHEET_DRAFT_ABSENT_RESPONSE_FIELDS,
      'Attendance sheet draft absent response',
    );
    assertDeniedFields(
      payload,
      ACTIVITY_CHECK_IN_RAW_RESPONSE_DENIED_FIELDS,
      'Attendance sheet draft absent response',
    );
  }

  assertAttendanceSheetDraftResponse(payload: Record<string, unknown>): void {
    assertExactFields(
      payload,
      ATTENDANCE_SHEET_DRAFT_RESPONSE_FIELDS,
      'Attendance sheet draft response',
    );
    if (
      !Array.isArray(payload.records) ||
      !Array.isArray(payload.flags) ||
      !Array.isArray(payload.absentRegistrations)
    ) {
      throw new Error('Attendance sheet draft response field policy mismatch');
    }
    for (const record of payload.records) {
      assertRecord(record, 'Attendance sheet draft record response');
      this.assertAttendanceSheetDraftRecordResponse(record);
    }
    for (const flag of payload.flags) {
      assertRecord(flag, 'Attendance sheet draft flag response');
      this.assertAttendanceSheetDraftFlagResponse(flag);
    }
    for (const absent of payload.absentRegistrations) {
      assertRecord(absent, 'Attendance sheet draft absent response');
      this.assertAttendanceSheetDraftAbsentResponse(absent);
    }
  }
}
