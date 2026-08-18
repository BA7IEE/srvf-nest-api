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
    ).toEqual(expect.objectContaining({ allowed: true, geoVerified: false, distanceMeters: null }));
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
    ).toEqual(
      expect.objectContaining({
        allowed: true,
        geoVerified: true,
        outOfRange: false,
        lowAccuracy: true,
      }),
    );
  });

  // AC-035 的否定半边:合同要求「低精度只提醒,**不自动扩大半径**」。既有两例是
  // 「范围内 + 低精度 ⇒ 放行」与「范围外 + 高精度 ⇒ 拒」,**唯独缺「范围外 + 低精度」**
  // —— 而按精度放宽半径的缺陷恰恰只在这一格翻面。主会话 2026-08-18 变异实测:
  // 把判定改成 `distance > radius + accuracy`,策略三例全绿,零执行位。
  it('AC-035 keeps an out-of-range point rejected even when accuracy is low (radius is never widened)', () => {
    // 距圆心约 855m(经度 +0.01°),远超 100m 半径;accuracy 900 足以在「按精度放宽」
    // 的缺陷实现下把它拉进范围 —— 正确实现必须仍然拒绝。
    expect(
      policy.evaluate({
        ...required,
        request: { longitude: 116.407128, latitude: 39.916527, accuracy: 900 },
      }),
    ).toEqual({ allowed: false, bizCode: BizCode.ATTENDANCE_PUNCH_LOCATION_OUT_OF_RANGE });
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
