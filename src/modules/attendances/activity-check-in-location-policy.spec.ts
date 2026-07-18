import { BizCode } from '../../common/exceptions/biz-code.constant';
import { ActivityCheckInLocationPolicy } from './activity-check-in-location-policy';
import { haversineDistanceMeters } from './haversine-distance';

describe('ActivityCheckInLocationPolicy', () => {
  const policy = new ActivityCheckInLocationPolicy();
  const activity = { longitude: 114, latitude: 22 };
  const request = { longitude: 114.004, latitude: 22 };

  it('原始 Haversine 距离等于半径时允许，任意略超时拒绝', () => {
    const exactRadius = haversineDistanceMeters(request, activity);

    // 杀死 `distance > radius` 被误改为 `>=`：等于边界必须允许。
    expect(policy.evaluate(activity, request, exactRadius)).toEqual({
      allowed: true,
      distanceMeters: exactRadius,
      geoVerified: true,
      outOfRange: false,
    });
    // 杀死展示距离舍入后再判定：原始值只比半径大 0.001m 也必须拒绝。
    expect(policy.evaluate(activity, request, exactRadius - 0.001)).toEqual({
      allowed: false,
      biz: BizCode.ACTIVITY_CHECK_IN_LOCATION_VERIFICATION_FAILED,
    });
  });

  it.each([
    ['活动无经度', { longitude: null, latitude: 22 }, request],
    ['活动无纬度', { longitude: 114, latitude: null }, request],
    ['活动经度非法', { longitude: 181, latitude: 22 }, request],
    ['活动纬度非有限', { longitude: 114, latitude: Number.NaN }, request],
    ['请求无经度', activity, { longitude: undefined, latitude: 22 }],
    ['请求无纬度', activity, { longitude: 114, latitude: undefined }],
    ['请求经度非法', activity, { longitude: -181, latitude: 22 }],
    ['请求纬度非有限', activity, { longitude: 114, latitude: Number.POSITIVE_INFINITY }],
  ] as const)('%s 一律 fail closed', (_label, activityLocation, requestLocation) => {
    // 杀死任一坐标缺失/非法时回退为 unverified 成功的旧宽进分支。
    expect(policy.evaluate(activityLocation, requestLocation, 500)).toEqual({
      allowed: false,
      biz: BizCode.ACTIVITY_CHECK_IN_LOCATION_VERIFICATION_FAILED,
    });
  });

  it('accuracy 仅作证据：极差 accuracy 不扩半径，也不把范围内请求变成失败', () => {
    const terribleAccuracy = 99_999_999.99;

    // 杀死 `radius + accuracy`：远点即使 accuracy 极差仍必须拒绝。
    expect(
      policy.evaluate(activity, { longitude: 115, latitude: 22, accuracy: terribleAccuracy }, 500),
    ).toEqual({
      allowed: false,
      biz: BizCode.ACTIVITY_CHECK_IN_LOCATION_VERIFICATION_FAILED,
    });

    const samePoint = policy.evaluate(activity, { ...activity, accuracy: terribleAccuracy }, 500);
    expect(samePoint).toEqual({
      allowed: true,
      distanceMeters: 0,
      geoVerified: true,
      outOfRange: false,
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    '非法 radius=%s 时拒绝，不产生无界 geofence',
    (radiusMeters) => {
      expect(policy.evaluate(activity, activity, radiusMeters)).toEqual({
        allowed: false,
        biz: BizCode.ACTIVITY_CHECK_IN_LOCATION_VERIFICATION_FAILED,
      });
    },
  );
});
