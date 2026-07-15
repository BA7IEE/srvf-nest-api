import { Prisma } from '@prisma/client';
import {
  ACTIVITY_CHECK_IN_RAW_RESPONSE_DENIED_FIELDS,
  ACTIVITY_CHECK_IN_RESPONSE_DENIED_FIELDS,
  ADMIN_ACTIVITY_CHECK_IN_LIST_RESPONSE_FIELDS,
  ADMIN_ACTIVITY_CHECK_IN_MEMBER_RESPONSE_FIELDS,
  APP_ACTIVITY_CHECK_IN_RESPONSE_FIELDS,
  ATTENDANCE_SHEET_DRAFT_ABSENT_RESPONSE_FIELDS,
  ATTENDANCE_SHEET_DRAFT_FLAG_RESPONSE_FIELDS,
  ATTENDANCE_SHEET_DRAFT_RECORD_RESPONSE_FIELDS,
  ATTENDANCE_SHEET_DRAFT_RESPONSE_FIELDS,
  ActivityCheckInFieldPolicy,
  type AdminActivityCheckInListRow,
  type AdminActivityCheckInMemberRow,
  type AppActivityCheckInRow,
  type AttendanceSheetDraftCheckInRow,
  type AttendanceSheetDraftRegistrationRow,
} from './activity-check-in-field-policy';
import { ActivityCheckInPresenter } from './activity-check-in-presenter';

describe('ActivityCheckInFieldPolicy + Presenter', () => {
  const fieldPolicy = new ActivityCheckInFieldPolicy();
  const presenter = new ActivityCheckInPresenter(fieldPolicy);
  const t0 = new Date('2026-07-15T08:00:00.000Z');
  const t1 = new Date('2026-07-15T09:00:00.000Z');
  const appRow: AppActivityCheckInRow = {
    id: 'checkin-1',
    activityId: 'activity-1',
    registrationId: 'registration-1',
    checkInAt: t0,
    checkOutAt: t1,
    checkInDistance: new Prisma.Decimal('12.30'),
    checkOutDistance: new Prisma.Decimal('45.67'),
    geoVerified: true,
    outOfRange: false,
    createdAt: t0,
    updatedAt: t1,
  };
  const member: AdminActivityCheckInMemberRow = {
    id: 'member-1',
    memberNo: 'M0001',
    displayName: '测试队员',
  };
  const adminRow: AdminActivityCheckInListRow = {
    ...appRow,
    memberId: member.id,
  };

  it('App 视图字段集精确为 11 项，Decimal 转字符串且时间保持 Date', () => {
    const dto = presenter.toAppDto(appRow);
    expect(Object.keys(dto).sort()).toEqual([...APP_ACTIVITY_CHECK_IN_RESPONSE_FIELDS].sort());
    expect(dto.checkInDistance).toBe('12.3');
    expect(dto.checkOutDistance).toBe('45.67');
    expect(dto.checkInAt).toBe(t0);
    expect(dto.checkOutAt).toBe(t1);
    for (const denied of ACTIVITY_CHECK_IN_RESPONSE_DENIED_FIELDS) {
      expect(dto).not.toHaveProperty(denied);
    }
  });

  it('nullable distance/checkOut 映射为 null', () => {
    expect(
      presenter.toAppDto({
        ...appRow,
        checkOutAt: null,
        checkInDistance: null,
        checkOutDistance: null,
      }),
    ).toMatchObject({ checkOutAt: null, checkInDistance: null, checkOutDistance: null });
  });

  it('FieldPolicy 对额外 raw/member 字段 fail closed', () => {
    expect(() =>
      fieldPolicy.assertAppResponse({
        ...presenter.toAppDto(appRow),
        checkInLongitude: '114.0000000',
      }),
    ).toThrow('App activity check-in response field policy mismatch');
  });

  it('Admin 列表项精确返回 member 摘要与 12 个顶层字段，distance 转 string', () => {
    const dto = presenter.toAdminListItemDto(adminRow, member);

    expect(Object.keys(dto).sort()).toEqual(
      [...ADMIN_ACTIVITY_CHECK_IN_LIST_RESPONSE_FIELDS].sort(),
    );
    expect(Object.keys(dto.member).sort()).toEqual(
      [...ADMIN_ACTIVITY_CHECK_IN_MEMBER_RESPONSE_FIELDS].sort(),
    );
    expect(dto.member).toEqual(member);
    expect(dto.checkInDistance).toBe('12.3');
    expect(dto.checkOutDistance).toBe('45.67');
    expect(dto.checkInAt).toBe(t0);
    expect(dto.checkOutAt).toBe(t1);
    for (const denied of ACTIVITY_CHECK_IN_RESPONSE_DENIED_FIELDS) {
      expect(dto).not.toHaveProperty(denied);
    }
  });

  it('Admin 列表 nullable distance/checkOut 映射为 null', () => {
    expect(
      presenter.toAdminListItemDto(
        {
          ...adminRow,
          checkOutAt: null,
          checkInDistance: null,
          checkOutDistance: null,
        },
        member,
      ),
    ).toMatchObject({ checkOutAt: null, checkInDistance: null, checkOutDistance: null });
  });

  it('Admin 列表 FieldPolicy 对顶层 raw/accuracy 与 member 摘要扩字段 fail closed', () => {
    const dto = presenter.toAdminListItemDto(adminRow, member);
    expect(() =>
      fieldPolicy.assertAdminListItemResponse({
        ...dto,
        checkInAccuracy: '3.00',
      }),
    ).toThrow('Admin activity check-in list item response field policy mismatch');
    expect(() =>
      fieldPolicy.assertAdminListItemResponse({
        ...dto,
        member: { ...dto.member, phone: '13800000000' },
      }),
    ).toThrow('Admin activity check-in member response field policy mismatch');
  });

  it('Admin 列表 member 批量 join 错配时 fail closed', () => {
    expect(() => presenter.toAdminListItemDto(adminRow, { ...member, id: 'member-2' })).toThrow(
      'Activity check-in member join mismatch',
    );
  });

  it('draft 忘签退按 Activity.endAt 回退，serviceHours 为两位 number 并生成 flags', () => {
    const fallbackEndAt = new Date('2026-07-15T09:30:00.000Z');
    const row: AttendanceSheetDraftCheckInRow = {
      registrationId: 'registration-1',
      memberId: member.id,
      checkInAt: t0,
      checkOutAt: null,
      geoVerified: false,
      outOfRange: true,
    };

    const mapped = presenter.toAttendanceSheetDraftRecordDto(row, fallbackEndAt);
    expect(Object.keys(mapped.record).sort()).toEqual(
      [...ATTENDANCE_SHEET_DRAFT_RECORD_RESPONSE_FIELDS].sort(),
    );
    expect(Object.keys(mapped.flag).sort()).toEqual(
      [...ATTENDANCE_SHEET_DRAFT_FLAG_RESPONSE_FIELDS].sort(),
    );
    expect(mapped.record).toEqual({
      memberId: member.id,
      roleCode: 'member',
      checkInAt: t0,
      checkOutAt: fallbackEndAt,
      serviceHours: 1.5,
      attendanceStatusCode: 'present',
      registrationId: 'registration-1',
    });
    expect(typeof mapped.record.serviceHours).toBe('number');
    expect(mapped.record).not.toHaveProperty('contributionPoints');
    expect(mapped.flag).toEqual({
      registrationId: 'registration-1',
      memberId: member.id,
      noCheckOut: true,
      outOfRange: true,
      unverified: true,
    });
    for (const denied of ACTIVITY_CHECK_IN_RAW_RESPONSE_DENIED_FIELDS) {
      expect(mapped.record).not.toHaveProperty(denied);
      expect(mapped.flag).not.toHaveProperty(denied);
    }
  });

  it('draft 完整签退使用首次 checkOutAt，36 秒按既有算法得到 0.01h', () => {
    const checkOutAt = new Date(t0.getTime() + 36_000);
    const mapped = presenter.toAttendanceSheetDraftRecordDto(
      {
        registrationId: 'registration-1',
        memberId: member.id,
        checkInAt: t0,
        checkOutAt,
        geoVerified: true,
        outOfRange: false,
      },
      t1,
    );

    expect(mapped.record.checkOutAt).toBe(checkOutAt);
    expect(mapped.record.serviceHours).toBe(0.01);
    expect(mapped.flag).toMatchObject({ noCheckOut: false, outOfRange: false, unverified: false });
  });

  it('draft absent 精确映射并组装 records/flags/absent 三段', () => {
    const registration: AttendanceSheetDraftRegistrationRow = {
      id: 'registration-2',
      memberId: member.id,
    };
    const absent = presenter.toAttendanceSheetDraftAbsentRegistrationDto(registration, member);
    expect(Object.keys(absent).sort()).toEqual(
      [...ATTENDANCE_SHEET_DRAFT_ABSENT_RESPONSE_FIELDS].sort(),
    );
    expect(absent).toEqual({
      registrationId: registration.id,
      memberId: member.id,
      memberNo: member.memberNo,
      displayName: member.displayName,
    });

    const mapped = presenter.toAttendanceSheetDraftRecordDto(
      {
        registrationId: 'registration-1',
        memberId: member.id,
        checkInAt: t0,
        checkOutAt: t1,
        geoVerified: true,
        outOfRange: false,
      },
      t1,
    );
    const dto = presenter.toAttendanceSheetDraftDto('activity-1', [mapped], [absent]);

    expect(Object.keys(dto).sort()).toEqual([...ATTENDANCE_SHEET_DRAFT_RESPONSE_FIELDS].sort());
    expect(dto.activityId).toBe('activity-1');
    expect(dto.records).toEqual([mapped.record]);
    expect(dto.flags).toEqual([mapped.flag]);
    expect(dto.absentRegistrations).toEqual([absent]);
  });

  it('draft FieldPolicy 对嵌套 raw/accuracy 扩字段 fail closed', () => {
    const mapped = presenter.toAttendanceSheetDraftRecordDto(
      {
        registrationId: 'registration-1',
        memberId: member.id,
        checkInAt: t0,
        checkOutAt: t1,
        geoVerified: true,
        outOfRange: false,
      },
      t1,
    );
    expect(() =>
      fieldPolicy.assertAttendanceSheetDraftResponse({
        activityId: 'activity-1',
        records: [{ ...mapped.record, checkOutAccuracy: '1.00' }],
        flags: [mapped.flag],
        absentRegistrations: [],
      }),
    ).toThrow('Attendance sheet draft record response field policy mismatch');
  });
});
