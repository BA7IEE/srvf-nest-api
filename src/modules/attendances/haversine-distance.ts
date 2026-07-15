export const HAVERSINE_EARTH_RADIUS_METERS = 6_371_008.8;

export interface GeoPoint {
  longitude: number;
  latitude: number;
}

function assertGeoPoint(point: GeoPoint): void {
  if (
    !Number.isFinite(point.longitude) ||
    !Number.isFinite(point.latitude) ||
    point.longitude < -180 ||
    point.longitude > 180 ||
    point.latitude < -90 ||
    point.latitude > 90
  ) {
    throw new RangeError('经纬度必须是 WGS84 有限数值');
  }
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

// WGS84 十进制度数 → 球面距离。使用冻结稿指定的平均地球半径；中间 a clamp 到 [0,1]，
// 避免极近/对跖点的 IEEE-754 误差让 sqrt 产生 NaN。
export function haversineDistanceMeters(from: GeoPoint, to: GeoPoint): number {
  assertGeoPoint(from);
  assertGeoPoint(to);

  const fromLatitude = toRadians(from.latitude);
  const toLatitude = toRadians(to.latitude);
  const latitudeDelta = toLatitude - fromLatitude;
  const longitudeDelta = toRadians(to.longitude - from.longitude);

  const sinLatitude = Math.sin(latitudeDelta / 2);
  const sinLongitude = Math.sin(longitudeDelta / 2);
  const rawA =
    sinLatitude * sinLatitude +
    Math.cos(fromLatitude) * Math.cos(toLatitude) * sinLongitude * sinLongitude;
  const a = Math.min(1, Math.max(0, rawA));
  const centralAngle = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = HAVERSINE_EARTH_RADIUS_METERS * centralAngle;

  if (!Number.isFinite(distance) || distance < 0) {
    throw new RangeError('Haversine 距离计算结果无效');
  }
  return distance;
}

// geofence 判定必须使用未舍入 IEEE-754 结果并严格比较；展示用两位小数不得反写判定。
export function isDistanceOutOfRange(distanceMeters: number, radiusMeters: number): boolean {
  if (
    !Number.isFinite(distanceMeters) ||
    distanceMeters < 0 ||
    !Number.isFinite(radiusMeters) ||
    radiusMeters < 0
  ) {
    throw new RangeError('距离与半径必须是有限非负数');
  }
  return distanceMeters > radiusMeters;
}
