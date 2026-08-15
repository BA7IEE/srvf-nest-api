import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  assertRecordAgainstLockedRegistration,
  assertRecordWithinActivityWindow,
  canonicalizeRecordInputs,
  DICT_TYPE_ATTENDANCE_ROLE,
  DICT_TYPE_ATTENDANCE_STATUS,
  normalizeRecord,
  type RecordValidationContext,
  type RegistrationFacts,
  resolveScheduleWindow,
  spanHours,
  validateAndNormalizeRecord,
} from './attendance-record.policy';
import type { AttendanceRecordInputDto } from './attendances.dto';

// Phase 6-B 第二域第二刀的 characterization spec。
//
// 本 spec 的承重部分是 **`validateAndNormalizeRecord` 的判定顺序**:每条错误码都用
// 「同时踩两个雷,断言先报的那个」的方式钉住 —— 只断言「非法就报错」是钉不住顺序的,
// 而顺序一旦漂移,前端拿到的就是另一个错误码(对外契约变更)。

const ACTIVITY = {
  id: 'act-1',
  startAt: new Date('2026-03-01T00:00:00.000Z'),
  endAt: new Date('2026-03-01T12:00:00.000Z'),
  requiresInsurance: false,
};

function input(overrides: Partial<AttendanceRecordInputDto> = {}): AttendanceRecordInputDto {
  return {
    memberId: 'm-1',
    roleCode: 'member',
    checkInAt: '2026-03-01T01:00:00.000Z',
    checkOutAt: '2026-03-01T05:00:00.000Z',
    attendanceStatusCode: 'present',
    ...overrides,
  };
}

function ctx(overrides: Partial<RecordValidationContext> = {}): RecordValidationContext {
  return {
    activity: ACTIVITY,
    dictKeys: new Set([
      `${DICT_TYPE_ATTENDANCE_ROLE}:member`,
      `${DICT_TYPE_ATTENDANCE_STATUS}:present`,
    ]),
    existingMemberIds: new Set(['m-1']),
    registrationById: new Map(),
    now: new Date('2026-03-02T00:00:00.000Z'),
    windowToleranceHours: 2,
    ...overrides,
  };
}

function registration(overrides: Partial<RegistrationFacts> = {}): RegistrationFacts {
  return {
    id: 'reg-1',
    activityId: 'act-1',
    memberId: 'm-1',
    statusCode: 'pass',
    activityPosition: null,
    ...overrides,
  };
}

describe('attendance-record.policy', () => {
  describe('spanHours', () => {
    it('保留 2 位小数', () => {
      expect(spanHours(new Date('2026-03-01T00:00:00Z'), new Date('2026-03-01T04:00:00Z'))).toBe(4);
      expect(spanHours(new Date('2026-03-01T00:00:00Z'), new Date('2026-03-01T00:10:00Z'))).toBe(
        0.17,
      );
    });
  });

  describe('normalizeRecord', () => {
    it('checkOut <= checkIn → CHECK_OUT_BEFORE_CHECK_IN(相等也拒)', () => {
      expect(() => normalizeRecord(input({ checkOutAt: '2026-03-01T01:00:00.000Z' }))).toThrow(
        new BizException(BizCode.CHECK_OUT_BEFORE_CHECK_IN),
      );
    });

    it('未传 serviceHours → 自动取跨度', () => {
      expect(normalizeRecord(input()).serviceHours).toBe(4);
    });

    it('serviceHours <= 0 → SERVICE_HOURS_INVALID', () => {
      expect(() => normalizeRecord(input({ serviceHours: 0 }))).toThrow(
        new BizException(BizCode.ATTENDANCE_SERVICE_HOURS_INVALID),
      );
    });

    it('serviceHours > 跨度 → SERVICE_HOURS_EXCEEDS_SPAN;恰等于跨度放行', () => {
      expect(() => normalizeRecord(input({ serviceHours: 4.01 }))).toThrow(
        new BizException(BizCode.ATTENDANCE_SERVICE_HOURS_EXCEEDS_SPAN),
      );
      expect(normalizeRecord(input({ serviceHours: 4 })).serviceHours).toBe(4);
    });

    it('note / registrationId 的 undefined 归一为 null', () => {
      const out = normalizeRecord(input());
      expect(out.note).toBeNull();
      expect(out.registrationId).toBeNull();
    });
  });

  describe('canonicalizeRecordInputs', () => {
    it('运行时 null 的 registrationId 归一为 undefined(不得进 Prisma in 查询)', () => {
      const [out] = canonicalizeRecordInputs([
        input({ registrationId: null as unknown as string }),
      ]);
      expect(out.registrationId).toBeUndefined();
    });
  });

  describe('resolveScheduleWindow', () => {
    it('岗位两端齐全 → 用岗位窗', () => {
      const position = {
        startAt: new Date('2026-03-01T02:00:00Z'),
        endAt: new Date('2026-03-01T06:00:00Z'),
      };
      expect(resolveScheduleWindow(position, ACTIVITY)).toEqual(position);
    });

    it('岗位为 null / undefined / 任一端为 null → 回落活动窗', () => {
      expect(resolveScheduleWindow(null, ACTIVITY)).toBe(ACTIVITY);
      expect(resolveScheduleWindow(undefined, ACTIVITY)).toBe(ACTIVITY);
      expect(
        resolveScheduleWindow({ startAt: new Date('2026-03-01T02:00:00Z'), endAt: null }, ACTIVITY),
      ).toBe(ACTIVITY);
      expect(
        resolveScheduleWindow({ startAt: null, endAt: new Date('2026-03-01T06:00:00Z') }, ACTIVITY),
      ).toBe(ACTIVITY);
    });
  });

  describe('assertRecordWithinActivityWindow', () => {
    const record = {
      checkInAt: new Date('2026-03-01T01:00:00Z'),
      checkOutAt: new Date('2026-03-01T05:00:00Z'),
    };

    it('容差按小时换算,边界恰好落在容差上放行', () => {
      // 活动 03:00-04:00 + 容差 2h ⇒ 允许 01:00-06:00
      expect(() =>
        assertRecordWithinActivityWindow(
          record,
          { startAt: new Date('2026-03-01T03:00:00Z'), endAt: new Date('2026-03-01T03:00:00Z') },
          2,
        ),
      ).not.toThrow();
    });

    it('超出容差一毫秒即 OUTSIDE_ACTIVITY_WINDOW(两端各测一次)', () => {
      expect(() =>
        assertRecordWithinActivityWindow(
          record,
          {
            startAt: new Date('2026-03-01T03:00:00.001Z'),
            endAt: new Date('2026-03-01T12:00:00Z'),
          },
          2,
        ),
      ).toThrow(new BizException(BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW));

      expect(() =>
        assertRecordWithinActivityWindow(
          record,
          {
            startAt: new Date('2026-03-01T00:00:00Z'),
            endAt: new Date('2026-03-01T02:59:59.999Z'),
          },
          2,
        ),
      ).toThrow(new BizException(BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW));
    });
  });

  // ⚠️ 承重:判定顺序即错误码契约
  describe('validateAndNormalizeRecord — 判定顺序', () => {
    it('角色码非法优先于状态码非法', () => {
      expect(() =>
        validateAndNormalizeRecord(
          input({ roleCode: 'bad', attendanceStatusCode: 'also-bad' }),
          ctx(),
        ),
      ).toThrow(new BizException(BizCode.ATTENDANCE_ROLE_CODE_INVALID));
    });

    it('状态码非法优先于队员不存在', () => {
      expect(() =>
        validateAndNormalizeRecord(
          input({ attendanceStatusCode: 'bad', memberId: 'ghost' }),
          ctx(),
        ),
      ).toThrow(new BizException(BizCode.ATTENDANCE_STATUS_CODE_INVALID));
    });

    it('队员不存在优先于保险缺报名', () => {
      expect(() =>
        validateAndNormalizeRecord(
          input({ memberId: 'ghost' }),
          ctx({ activity: { ...ACTIVITY, requiresInsurance: true } }),
        ),
      ).toThrow(new BizException(BizCode.MEMBER_NOT_FOUND));
    });

    it('保险活动缺 registrationId → REGISTRATION_INVALID(优先于时间窗)', () => {
      expect(() =>
        validateAndNormalizeRecord(
          input({ checkInAt: '2020-01-01T00:00:00.000Z', checkOutAt: '2020-01-01T04:00:00.000Z' }),
          ctx({ activity: { ...ACTIVITY, requiresInsurance: true } }),
        ),
      ).toThrow(new BizException(BizCode.ATTENDANCE_REGISTRATION_INVALID));
    });

    it('报名不存在 / 跨活动 → ACTIVITY_MISMATCH,且优先于归属队员判定', () => {
      expect(() => validateAndNormalizeRecord(input({ registrationId: 'reg-x' }), ctx())).toThrow(
        new BizException(BizCode.ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH),
      );

      expect(() =>
        validateAndNormalizeRecord(
          input({ registrationId: 'reg-1' }),
          ctx({
            registrationById: new Map([
              ['reg-1', registration({ activityId: 'other', memberId: 'someone-else' })],
            ]),
          }),
        ),
      ).toThrow(new BizException(BizCode.ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH));
    });

    it('报名归属别人 / 非 pass → REGISTRATION_INVALID', () => {
      for (const bad of [{ memberId: 'm-2' }, { statusCode: 'waitlisted' }]) {
        expect(() =>
          validateAndNormalizeRecord(
            input({ registrationId: 'reg-1' }),
            ctx({ registrationById: new Map([['reg-1', registration(bad)]]) }),
          ),
        ).toThrow(new BizException(BizCode.ATTENDANCE_REGISTRATION_INVALID));
      }
    });

    it('时间窗优先于未来签退', () => {
      // 既超活动窗、又晚于 now(日期用 2099,沿 INC-18「纯未来 fixture 平移到 2090 之后」)
      expect(() =>
        validateAndNormalizeRecord(
          input({ checkInAt: '2099-01-01T00:00:00.000Z', checkOutAt: '2099-01-01T04:00:00.000Z' }),
          ctx(),
        ),
      ).toThrow(new BizException(BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW));
    });

    it('落在窗内但晚于 now → CHECK_OUT_IN_FUTURE', () => {
      expect(() =>
        validateAndNormalizeRecord(input(), ctx({ now: new Date('2026-03-01T02:00:00.000Z') })),
      ).toThrow(new BizException(BizCode.ATTENDANCE_CHECK_OUT_IN_FUTURE));
    });

    it('全部合法 → 返回 normalize 结果', () => {
      expect(
        validateAndNormalizeRecord(input({ registrationId: 'reg-1' }), {
          ...ctx(),
          registrationById: new Map([['reg-1', registration()]]),
        }),
      ).toMatchObject({ memberId: 'm-1', serviceHours: 4, registrationId: 'reg-1' });
    });

    it('岗位独立时段生效:活动窗放得下、岗位窗放不下 ⇒ 按岗位窗拒', () => {
      expect(() =>
        validateAndNormalizeRecord(input({ registrationId: 'reg-1' }), {
          ...ctx(),
          registrationById: new Map([
            [
              'reg-1',
              registration({
                activityPosition: {
                  startAt: new Date('2026-03-01T08:00:00Z'),
                  endAt: new Date('2026-03-01T10:00:00Z'),
                },
              }),
            ],
          ]),
        }),
      ).toThrow(new BizException(BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW));
    });
  });

  describe('assertRecordAgainstLockedRegistration(claim 锁后复判)', () => {
    const record = normalizeRecord(input({ registrationId: 'reg-1' }));

    it('锁后报名消失 → ACTIVITY_MISMATCH', () => {
      expect(() => assertRecordAgainstLockedRegistration(record, undefined, ACTIVITY, 2)).toThrow(
        new BizException(BizCode.ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH),
      );
    });

    it('锁后状态已非 pass → REGISTRATION_INVALID', () => {
      expect(() =>
        assertRecordAgainstLockedRegistration(
          record,
          registration({ statusCode: 'cancelled' }),
          ACTIVITY,
          2,
        ),
      ).toThrow(new BizException(BizCode.ATTENDANCE_REGISTRATION_INVALID));
    });

    it('锁后岗位时段被改窄 ⇒ 按新岗位窗重判并拒', () => {
      expect(() =>
        assertRecordAgainstLockedRegistration(
          record,
          registration({
            activityPosition: {
              startAt: new Date('2026-03-01T08:00:00Z'),
              endAt: new Date('2026-03-01T10:00:00Z'),
            },
          }),
          ACTIVITY,
          2,
        ),
      ).toThrow(new BizException(BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW));
    });

    it('一致则放行', () => {
      expect(() =>
        assertRecordAgainstLockedRegistration(record, registration(), ACTIVITY, 2),
      ).not.toThrow();
    });
  });
});
