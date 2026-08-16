import { BizCode } from '../../common/exceptions/biz-code.constant';
import { AttendancePunchLocationPolicy } from './attendance-punch-location-policy';

describe('attendance punch location policy', () => {
  const policy = new AttendancePunchLocationPolicy();
  const required = {
    required: true,
    radiusMeters: 100,
    activityLongitude: 116.397128,
    activityLatitude: 39.916527,
    accuracyWarningMeters: 100,
  };

  it('allows absent coordinates only when the frozen session policy is optional', () => {
    expect(
      policy.evaluate({
        ...required,
        required: false,
        radiusMeters: null,
        request: { longitude: null, latitude: null, accuracy: null },
      }),
    ).toEqual(
      expect.objectContaining({ allowed: true, geoVerified: false, distanceMeters: null }),
    );
    expect(
      policy.evaluate({
        ...required,
        request: { longitude: null, latitude: null, accuracy: null },
      }),
    ).toEqual({
      allowed: false,
      bizCode: BizCode.ATTENDANCE_PUNCH_LOCATION_REQUIRED,
    });
  });

  it('accepts exact center and reports low accuracy without widening the radius', () => {
    expect(
      policy.evaluate({
        ...required,
        request: { longitude: 116.397128, latitude: 39.916527, accuracy: 101 },
      }),
    ).toEqual(expect.objectContaining({ allowed: true, geoVerified: true, outOfRange: false, lowAccuracy: true }));
  });

  it('mutation: rejects an out-of-range point rather than accepting a rounded or low-accuracy coordinate', () => {
    expect(
      policy.evaluate({
        ...required,
        request: { longitude: 116.407128, latitude: 39.916527, accuracy: 1 },
      }),
    ).toEqual({ allowed: false, bizCode: BizCode.ATTENDANCE_PUNCH_LOCATION_OUT_OF_RANGE });
  });
});
