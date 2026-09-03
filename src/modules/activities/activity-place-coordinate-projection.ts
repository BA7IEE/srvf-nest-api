/**
 * Activity OS R2 / B2 的纯坐标投影策略。
 *
 * 本文件不读取 Prisma、不查询数据库，也不接线任何 writer。B6 在活动根事务中取得
 * ActivityPlace 本地快照后，才可调用这里的选择函数；只有 projectable 结果才允许
 * 成对写入既有 WGS84 列。
 */

export const PLACE_COORDINATE_SYSTEM_CODES = ['wgs84', 'gcj02', 'bd09'] as const;

export type PlaceCoordinateSystemCode = (typeof PLACE_COORDINATE_SYSTEM_CODES)[number];

export type CoordinateScalar = number | string | null;

export interface PlaceCoordinateInput {
  readonly longitude: CoordinateScalar;
  readonly latitude: CoordinateScalar;
  readonly coordinateSystemCode: string | null;
}

export interface ActivityPlaceCoordinateCandidate extends PlaceCoordinateInput {
  readonly id: string;
  readonly activityId: string;
  readonly sessionId: string | null;
  readonly roleCode: string;
}

export interface ProjectableWgs84Coordinate {
  readonly kind: 'projectable';
  /**
   * 精确 7 位小数，可直接作为 Decimal(10,7) 的安全写入值。
   */
  readonly longitude: string;
  readonly latitude: string;
}

export type CoordinateProjectionFailureReason =
  | 'coordinate-pair-incomplete'
  | 'invalid-coordinate'
  | 'invalid-coordinate-system'
  | 'outside-transform-envelope'
  | 'inverse-not-converged';

export interface NotProjectableCoordinate {
  readonly kind: 'not_projectable';
  readonly reason: CoordinateProjectionFailureReason;
}

export type CoordinateProjectionDecision = ProjectableWgs84Coordinate | NotProjectableCoordinate;

export type LegacyCoordinateProjectionFailureReason =
  | CoordinateProjectionFailureReason
  | 'no-primary-place'
  | 'ambiguous-primary-place';

export interface ProjectableLegacyCoordinate extends ProjectableWgs84Coordinate {
  readonly sourcePlaceId: string;
}

export interface NotProjectableLegacyCoordinate {
  readonly kind: 'not_projectable';
  readonly reason: LegacyCoordinateProjectionFailureReason;
}

export type LegacyCoordinateProjectionDecision =
  | ProjectableLegacyCoordinate
  | NotProjectableLegacyCoordinate;

const GLOBAL_MIN_LONGITUDE = -180;
const GLOBAL_MAX_LONGITUDE = 180;
const GLOBAL_MIN_LATITUDE = -90;
const GLOBAL_MAX_LATITUDE = 90;

/**
 * 非 WGS84 变换的冻结包络。它只决定能否安全变换，不限制地点能否被保存。
 */
export const CHINA_TRANSFORM_ENVELOPE = {
  minLongitude: 72.004,
  maxLongitude: 137.8347,
  minLatitude: 0.8293,
  maxLatitude: 55.8271,
} as const;

const COORDINATE_SCALE = 10_000_000;
const PI = Math.PI;
const GCJ_AXIS = 6_378_245;
const GCJ_ECCENTRICITY_SQUARED = 0.006693421622965943;
const BD09_X_PI = (PI * 3000) / 180;
const INVERSE_MAX_ITERATIONS = 30;
const INVERSE_CONVERGENCE_DEGREES = 1e-10;

interface NumericCoordinate {
  readonly longitude: number;
  readonly latitude: number;
}

function notProjectable(reason: CoordinateProjectionFailureReason): NotProjectableCoordinate {
  return { kind: 'not_projectable', reason };
}

function parseCoordinate(value: CoordinateScalar): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim().length === 0) return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isGlobalCoordinate({ longitude, latitude }: NumericCoordinate): boolean {
  return (
    Number.isFinite(longitude) &&
    Number.isFinite(latitude) &&
    longitude >= GLOBAL_MIN_LONGITUDE &&
    longitude <= GLOBAL_MAX_LONGITUDE &&
    latitude >= GLOBAL_MIN_LATITUDE &&
    latitude <= GLOBAL_MAX_LATITUDE
  );
}

function isInsideChinaTransformEnvelope({ longitude, latitude }: NumericCoordinate): boolean {
  return (
    longitude >= CHINA_TRANSFORM_ENVELOPE.minLongitude &&
    longitude <= CHINA_TRANSFORM_ENVELOPE.maxLongitude &&
    latitude >= CHINA_TRANSFORM_ENVELOPE.minLatitude &&
    latitude <= CHINA_TRANSFORM_ENVELOPE.maxLatitude
  );
}

function isCoordinateSystemCode(value: string | null): value is PlaceCoordinateSystemCode {
  return value !== null && PLACE_COORDINATE_SYSTEM_CODES.some((code) => code === value);
}

/**
 * Decimal(10,7) 使用固定 7 位字符串。先转成整数刻度再格式化，避免 toFixed 对负数的
 * half-up 语义不明确；IEEE-754 容差只补偿刻度整数边界的表示误差。
 */
function formatDecimalHalfUp(value: number): string {
  const scaled = Math.abs(value) * COORDINATE_SCALE;
  const epsilon = Number.EPSILON * Math.max(1, scaled) * 4;
  const rounded = Math.floor(scaled + 0.5 + epsilon);
  const whole = Math.floor(rounded / COORDINATE_SCALE);
  const fraction = String(rounded % COORDINATE_SCALE).padStart(7, '0');
  return (value < 0 ? '-' : '') + String(whole) + '.' + fraction;
}

function projectable({ longitude, latitude }: NumericCoordinate): ProjectableWgs84Coordinate {
  return {
    kind: 'projectable',
    longitude: formatDecimalHalfUp(longitude),
    latitude: formatDecimalHalfUp(latitude),
  };
}

function transformLatitude(longitude: number, latitude: number): number {
  let result =
    -100 +
    2 * longitude +
    3 * latitude +
    0.2 * latitude * latitude +
    0.1 * longitude * latitude +
    0.2 * Math.sqrt(Math.abs(longitude));
  result += ((20 * Math.sin(6 * longitude * PI) + 20 * Math.sin(2 * longitude * PI)) * 2) / 3;
  result += ((20 * Math.sin(latitude * PI) + 40 * Math.sin((latitude / 3) * PI)) * 2) / 3;
  result += ((160 * Math.sin((latitude / 12) * PI) + 320 * Math.sin((latitude * PI) / 30)) * 2) / 3;
  return result;
}

function transformLongitude(longitude: number, latitude: number): number {
  let result =
    300 +
    longitude +
    2 * latitude +
    0.1 * longitude * longitude +
    0.1 * longitude * latitude +
    0.1 * Math.sqrt(Math.abs(longitude));
  result += ((20 * Math.sin(6 * longitude * PI) + 20 * Math.sin(2 * longitude * PI)) * 2) / 3;
  result += ((20 * Math.sin(longitude * PI) + 40 * Math.sin((longitude / 3) * PI)) * 2) / 3;
  result +=
    ((150 * Math.sin((longitude / 12) * PI) + 300 * Math.sin((longitude / 30) * PI)) * 2) / 3;
  return result;
}

/**
 * 标准 WGS84 → GCJ-02 前向模型。它只供逆算的闭环使用，不是 public writer。
 */
function wgs84ToGcj02({ longitude, latitude }: NumericCoordinate): NumericCoordinate {
  let latitudeDelta = transformLatitude(longitude - 105, latitude - 35);
  let longitudeDelta = transformLongitude(longitude - 105, latitude - 35);
  const latitudeRadians = (latitude / 180) * PI;
  const sinLatitude = Math.sin(latitudeRadians);
  const magic = 1 - GCJ_ECCENTRICITY_SQUARED * sinLatitude * sinLatitude;
  const sqrtMagic = Math.sqrt(magic);

  latitudeDelta =
    (latitudeDelta * 180) /
    (((GCJ_AXIS * (1 - GCJ_ECCENTRICITY_SQUARED)) / (magic * sqrtMagic)) * PI);
  longitudeDelta =
    (longitudeDelta * 180) / ((GCJ_AXIS / sqrtMagic) * Math.cos(latitudeRadians) * PI);

  return {
    longitude: longitude + longitudeDelta,
    latitude: latitude + latitudeDelta,
  };
}

/**
 * GCJ-02 → WGS84 使用固定上限的误差迭代。超过上限或落到无效全球范围即 fail-closed；
 * 不会把原始 GCJ 坐标伪装成 WGS84 返回。
 */
function gcj02ToWgs84(source: NumericCoordinate): NumericCoordinate | null {
  let estimate = source;

  for (let iteration = 0; iteration < INVERSE_MAX_ITERATIONS; iteration += 1) {
    const forward = wgs84ToGcj02(estimate);
    const longitudeError = forward.longitude - source.longitude;
    const latitudeError = forward.latitude - source.latitude;

    if (
      Math.abs(longitudeError) <= INVERSE_CONVERGENCE_DEGREES &&
      Math.abs(latitudeError) <= INVERSE_CONVERGENCE_DEGREES
    ) {
      return estimate;
    }

    estimate = {
      longitude: estimate.longitude - longitudeError,
      latitude: estimate.latitude - latitudeError,
    };
    if (!isGlobalCoordinate(estimate)) return null;
  }

  return null;
}

function bd09ToGcj02({ longitude, latitude }: NumericCoordinate): NumericCoordinate {
  const shiftedLongitude = longitude - 0.0065;
  const shiftedLatitude = latitude - 0.006;
  const distance =
    Math.sqrt(shiftedLongitude * shiftedLongitude + shiftedLatitude * shiftedLatitude) -
    0.00002 * Math.sin(shiftedLatitude * BD09_X_PI);
  const angle =
    Math.atan2(shiftedLatitude, shiftedLongitude) -
    0.000003 * Math.cos(shiftedLongitude * BD09_X_PI);
  return {
    longitude: distance * Math.cos(angle),
    latitude: distance * Math.sin(angle),
  };
}

/**
 * 将一个完整地点候选安全投影成旧列需要的 WGS84 Decimal(10,7) 值。
 */
export function projectPlaceCoordinate(input: PlaceCoordinateInput): CoordinateProjectionDecision {
  if (input.longitude === null || input.latitude === null) {
    return notProjectable('coordinate-pair-incomplete');
  }

  const longitude = parseCoordinate(input.longitude);
  const latitude = parseCoordinate(input.latitude);
  if (longitude === null || latitude === null) return notProjectable('invalid-coordinate');

  const source = { longitude, latitude };
  if (!isGlobalCoordinate(source)) return notProjectable('invalid-coordinate');
  if (!isCoordinateSystemCode(input.coordinateSystemCode)) {
    return notProjectable('invalid-coordinate-system');
  }

  if (input.coordinateSystemCode === 'wgs84') return projectable(source);
  if (!isInsideChinaTransformEnvelope(source)) {
    return notProjectable('outside-transform-envelope');
  }

  const gcj02 = input.coordinateSystemCode === 'gcj02' ? source : bd09ToGcj02(source);
  const wgs84 = gcj02ToWgs84(gcj02);
  return wgs84 === null ? notProjectable('inverse-not-converged') : projectable(wgs84);
}

function selectLegacyProjection(
  candidates: readonly ActivityPlaceCoordinateCandidate[],
  activityId: string,
  sessionId: string | null,
): LegacyCoordinateProjectionDecision {
  const primaryPlaces = candidates.filter(
    (candidate) =>
      candidate.activityId === activityId &&
      candidate.sessionId === sessionId &&
      candidate.roleCode === 'primary',
  );

  if (primaryPlaces.length === 0) {
    return { kind: 'not_projectable', reason: 'no-primary-place' };
  }
  if (primaryPlaces.length > 1) {
    return { kind: 'not_projectable', reason: 'ambiguous-primary-place' };
  }

  const sourcePlace = primaryPlaces[0];
  const coordinate = projectPlaceCoordinate(sourcePlace);
  if (coordinate.kind === 'not_projectable') return coordinate;
  return { ...coordinate, sourcePlaceId: sourcePlace.id };
}

/**
 * 只选择活动级（sessionId 为 NULL）唯一 primary 地点。它不清空旧值，也不做写入。
 */
export function selectActivityLegacyCoordinate(
  activityId: string,
  candidates: readonly ActivityPlaceCoordinateCandidate[],
): LegacyCoordinateProjectionDecision {
  return selectLegacyProjection(candidates, activityId, null);
}

/**
 * 只选择给定场次唯一 primary 地点。不同场次与活动级 primary 均不参与选择。
 */
export function selectSessionLegacyCoordinate(
  activityId: string,
  sessionId: string,
  candidates: readonly ActivityPlaceCoordinateCandidate[],
): LegacyCoordinateProjectionDecision {
  return selectLegacyProjection(candidates, activityId, sessionId);
}
