import { Prisma } from '@prisma/client';
import {
  ACTIVITY_CHECK_IN_RESPONSE_DENIED_FIELDS,
  APP_ACTIVITY_CHECK_IN_RESPONSE_FIELDS,
  ActivityCheckInFieldPolicy,
  type AppActivityCheckInRow,
} from './activity-check-in-field-policy';
import { ActivityCheckInPresenter } from './activity-check-in-presenter';

describe('ActivityCheckInFieldPolicy + Presenter', () => {
  const fieldPolicy = new ActivityCheckInFieldPolicy();
  const presenter = new ActivityCheckInPresenter(fieldPolicy);
  const t0 = new Date('2026-07-15T08:00:00.000Z');
  const t1 = new Date('2026-07-15T09:00:00.000Z');
  const row: AppActivityCheckInRow = {
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

  it('App 视图字段集精确为 11 项，Decimal 转字符串且时间保持 Date', () => {
    const dto = presenter.toAppDto(row);
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
        ...row,
        checkOutAt: null,
        checkInDistance: null,
        checkOutDistance: null,
      }),
    ).toMatchObject({ checkOutAt: null, checkInDistance: null, checkOutDistance: null });
  });

  it('FieldPolicy 对额外 raw/member 字段 fail closed', () => {
    expect(() =>
      fieldPolicy.assertAppResponse({
        ...presenter.toAppDto(row),
        checkInLongitude: '114.0000000',
      }),
    ).toThrow('App activity check-in response field policy mismatch');
  });
});
