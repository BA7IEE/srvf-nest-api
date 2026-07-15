import {
  HAVERSINE_EARTH_RADIUS_METERS,
  haversineDistanceMeters,
  isDistanceOutOfRange,
} from './haversine-distance';

describe('haversineDistanceMeters', () => {
  it('同点为 0，且一度纬差与冻结半径计算一致', () => {
    expect(
      haversineDistanceMeters({ longitude: 114, latitude: 22 }, { longitude: 114, latitude: 22 }),
    ).toBe(0);
    expect(
      haversineDistanceMeters({ longitude: 0, latitude: 0 }, { longitude: 0, latitude: 1 }),
    ).toBeCloseTo((Math.PI * HAVERSINE_EARTH_RADIUS_METERS) / 180, 8);
  });

  it('满足对称性，并正确处理国际日期变更线短弧', () => {
    const east = { longitude: 179.9, latitude: 10 };
    const west = { longitude: -179.9, latitude: 10 };
    const forward = haversineDistanceMeters(east, west);
    expect(forward).toBeCloseTo(haversineDistanceMeters(west, east), 10);
    expect(forward).toBeGreaterThan(21_000);
    expect(forward).toBeLessThan(23_000);
  });

  it('近极点仍返回有限非负值', () => {
    const distance = haversineDistanceMeters(
      { longitude: -135, latitude: 89.9999 },
      { longitude: 135, latitude: 89.9999 },
    );
    expect(Number.isFinite(distance)).toBe(true);
    expect(distance).toBeGreaterThanOrEqual(0);
    expect(distance).toBeLessThan(30);
  });

  it('geofence 使用未舍入值严格比较：等于半径不超，任意更大才超', () => {
    expect(isDistanceOutOfRange(500, 500)).toBe(false);
    expect(isDistanceOutOfRange(499.999_999, 500)).toBe(false);
    expect(isDistanceOutOfRange(500.000_001, 500)).toBe(true);
  });

  it('非法坐标或非有限距离明确拒绝', () => {
    expect(() =>
      haversineDistanceMeters({ longitude: 181, latitude: 0 }, { longitude: 0, latitude: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      haversineDistanceMeters(
        { longitude: Number.NaN, latitude: 0 },
        { longitude: 0, latitude: 0 },
      ),
    ).toThrow(RangeError);
    expect(() => isDistanceOutOfRange(Number.POSITIVE_INFINITY, 500)).toThrow(RangeError);
    expect(() => isDistanceOutOfRange(1, -1)).toThrow(RangeError);
  });
});
