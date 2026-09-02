/**
 * Activity OS R1 / A6：模板定义 V1 的唯一解释器。
 *
 * A3 只提供 canonical JSON 与 hash；本文件才定义「哪些 JSON 可以被物化成草稿」。
 * 它刻意是纯函数：不取数据库、不做字典查询、不知道调用方身份。数据库事实与权限由
 * `ActivityFromTemplateService` 在同一事务中补齐，避免把写路径拆成两套真相。
 *
 * ⚠️ V1 只承载不含敏感信息的活动 / 场次 / 岗位蓝图。报名表、资格、地点坐标、负责人、
 * 附件、content 等字段不在白名单里；未知键必须 fail-closed，不能悄悄丢掉。
 */

export type ActivityAllocationModeCode = 'first_come' | 'qualification_rank' | 'lottery';
export type ActivityRegistrationModeCode =
  | 'open_apply'
  | 'invitation_only'
  | 'admin_only'
  | 'paused';
export type ActivityVisibilityCode = 'internal' | 'invitation';

export interface ActivityTemplateSessionPositionDefinitionV1 {
  readonly code: string;
  readonly name: string;
  readonly attendanceRoleCode: string;
  readonly capacity?: number | null;
  /** 两个岗位时段偏移必须同空同有，基准均为 Activity.startAt。 */
  readonly startOffsetMinutes?: number | null;
  readonly endOffsetMinutes?: number | null;
  readonly genderRequirementCode?: string | null;
  /** V1 不携带坐标，故只能为 false / null；true 留待地点切片。 */
  readonly locationRequired?: boolean | null;
  readonly radiusMeters?: number | null;
  readonly description?: string | null;
  readonly equipmentNotes?: string | null;
  readonly sortOrder: number;
}

export interface ActivityTemplateSessionDefinitionV1 {
  readonly code: string;
  readonly name: string;
  /** 场次本身相对 Activity.startAt 的偏移。 */
  readonly startOffsetMinutes: number;
  readonly endOffsetMinutes: number;
  readonly locationText: string;
  readonly capacity?: number | null;
  /** 下列四个窗口偏移沿现有模板字段：签到相对 session.startAt，签退相对 session.endAt。 */
  readonly checkInOpenOffsetMinutes: number;
  readonly checkInCloseOffsetMinutes: number;
  readonly checkOutOpenOffsetMinutes: number;
  readonly checkOutCloseOffsetMinutes: number;
  /** 相对 session.startAt；null = 不单独设置准备时段。 */
  readonly preparationStartOffsetMinutes?: number | null;
  /** V1 不携带坐标，故只能为 false。 */
  readonly locationRequired: false;
  readonly radiusMeters?: number | null;
  readonly lateGraceMinutes: number;
  readonly earlyLeaveThresholdMinutes: number;
  readonly sortOrder: number;
  readonly positions: readonly ActivityTemplateSessionPositionDefinitionV1[];
}

export interface ActivityTemplateActivityDefinitionV1 {
  readonly allocationModeCode: ActivityAllocationModeCode;
  readonly description?: string | null;
  readonly capacity?: number | null;
  readonly genderRequirementCode?: string | null;
  readonly registrationNotes?: string | null;
  readonly isPublicRegistration?: boolean;
  readonly requiresInsurance?: boolean;
  readonly registrationModeCode?: ActivityRegistrationModeCode | null;
  readonly visibilityCode?: ActivityVisibilityCode | null;
  readonly defaultLocationRequired?: boolean | null;
  readonly defaultCheckInRadiusMeters?: number | null;
  readonly archiveWaitingDays?: number;
}

export interface ActivityTemplateDefinitionV1 {
  readonly activity: ActivityTemplateActivityDefinitionV1;
  /** 可以为空；草稿不完整由后续 Readiness 切片处理。 */
  readonly sessions: readonly ActivityTemplateSessionDefinitionV1[];
}

/** 让写服务能够把所有结构错误统一映射为「模板版本不可选择」，而不泄露内部细节。 */
export class ActivityTemplateDefinitionV1Error extends Error {
  constructor(path: string, reason: string) {
    super(`activity template definition v1: ${path} ${reason}`);
    this.name = 'ActivityTemplateDefinitionV1Error';
  }
}

type JsonRecord = Record<string, unknown>;

const ALLOCATION_MODES = new Set<ActivityAllocationModeCode>([
  'first_come',
  'qualification_rank',
  'lottery',
]);
const REGISTRATION_MODES = new Set<ActivityRegistrationModeCode>([
  'open_apply',
  'invitation_only',
  'admin_only',
  'paused',
]);
const VISIBILITY_CODES = new Set<ActivityVisibilityCode>(['internal', 'invitation']);

function fail(path: string, reason: string): never {
  throw new ActivityTemplateDefinitionV1Error(path, reason);
}

function has(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function object(value: unknown, path: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'must be an object');
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, 'must be a plain object');
  }
  return value as JsonRecord;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  return value;
}

function exactKeys(record: JsonRecord, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, 'is not allowed in definition V1');
  }
}

function string(value: unknown, path: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    fail(path, `must be a string of length ${min}..${max}`);
  }
  return value;
}

function requiredString(
  record: JsonRecord,
  key: string,
  path: string,
  min: number,
  max: number,
): string {
  if (!has(record, key)) fail(`${path}.${key}`, 'is required');
  return string(record[key], `${path}.${key}`, min, max);
}

function optionalStringOrNull(
  record: JsonRecord,
  key: string,
  path: string,
  min: number,
  max: number,
): string | null | undefined {
  if (!has(record, key)) return undefined;
  const value = record[key];
  return value === null ? null : string(value, `${path}.${key}`, min, max);
}

function integer(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    fail(path, 'must be a safe integer');
  }
  return value;
}

function requiredInteger(record: JsonRecord, key: string, path: string): number {
  if (!has(record, key)) fail(`${path}.${key}`, 'is required');
  return integer(record[key], `${path}.${key}`);
}

function optionalIntegerOrNull(
  record: JsonRecord,
  key: string,
  path: string,
): number | null | undefined {
  if (!has(record, key)) return undefined;
  const value = record[key];
  return value === null ? null : integer(value, `${path}.${key}`);
}

function positiveIntegerOrNull(
  record: JsonRecord,
  key: string,
  path: string,
): number | null | undefined {
  const value = optionalIntegerOrNull(record, key, path);
  if (value !== undefined && value !== null && value < 1) {
    fail(`${path}.${key}`, 'must be at least 1 when provided');
  }
  return value;
}

function optionalBooleanOrNull(
  record: JsonRecord,
  key: string,
  path: string,
): boolean | null | undefined {
  if (!has(record, key)) return undefined;
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'boolean') fail(`${path}.${key}`, 'must be a boolean or null');
  return value;
}

function optionalBoolean(record: JsonRecord, key: string, path: string): boolean | undefined {
  if (!has(record, key)) return undefined;
  const value = record[key];
  if (typeof value !== 'boolean') fail(`${path}.${key}`, 'must be a boolean');
  return value;
}

function requiredBoolean(record: JsonRecord, key: string, path: string): boolean {
  if (!has(record, key)) fail(`${path}.${key}`, 'is required');
  const value = record[key];
  if (typeof value !== 'boolean') fail(`${path}.${key}`, 'must be a boolean');
  return value;
}

function optionalEnumOrNull<T extends string>(
  record: JsonRecord,
  key: string,
  path: string,
  values: ReadonlySet<T>,
): T | null | undefined {
  if (!has(record, key)) return undefined;
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string' || !values.has(value as T)) {
    fail(`${path}.${key}`, 'is not an allowed value');
  }
  return value as T;
}

function requiredEnum<T extends string>(
  record: JsonRecord,
  key: string,
  path: string,
  values: ReadonlySet<T>,
): T {
  if (!has(record, key)) fail(`${path}.${key}`, 'is required');
  const value = record[key];
  if (typeof value !== 'string' || !values.has(value as T)) {
    fail(`${path}.${key}`, 'is not an allowed value');
  }
  return value as T;
}

function appendOptional<T>(
  target: Record<string, unknown>,
  key: string,
  value: T | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

function assertDistinct(items: readonly { code: string; name: string }[], path: string): void {
  const codes = new Set<string>();
  const names = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (codes.has(item.code)) fail(`${path}[${index}].code`, 'must be unique within its owner');
    if (names.has(item.name)) fail(`${path}[${index}].name`, 'must be unique within its owner');
    codes.add(item.code);
    names.add(item.name);
  }
}

function parsePosition(value: unknown, path: string): ActivityTemplateSessionPositionDefinitionV1 {
  const record = object(value, path);
  exactKeys(record, path, [
    'code',
    'name',
    'attendanceRoleCode',
    'capacity',
    'startOffsetMinutes',
    'endOffsetMinutes',
    'genderRequirementCode',
    'locationRequired',
    'radiusMeters',
    'description',
    'equipmentNotes',
    'sortOrder',
  ]);

  const startOffsetMinutes = optionalIntegerOrNull(record, 'startOffsetMinutes', path);
  const endOffsetMinutes = optionalIntegerOrNull(record, 'endOffsetMinutes', path);
  if (
    (startOffsetMinutes === undefined || startOffsetMinutes === null) !==
    (endOffsetMinutes === undefined || endOffsetMinutes === null)
  ) {
    fail(path, 'startOffsetMinutes and endOffsetMinutes must be both absent/null or both integers');
  }

  const locationRequired = optionalBooleanOrNull(record, 'locationRequired', path);
  const radiusMeters = optionalIntegerOrNull(record, 'radiusMeters', path);
  if (locationRequired === true) {
    fail(
      `${path}.locationRequired`,
      'cannot be true before a template location/coordinates slice exists',
    );
  }
  if (radiusMeters !== undefined && radiusMeters !== null) {
    fail(
      `${path}.radiusMeters`,
      'cannot be set before a template location/coordinates slice exists',
    );
  }

  const result: Record<string, unknown> = {
    code: requiredString(record, 'code', path, 1, 64),
    name: requiredString(record, 'name', path, 1, 200),
    attendanceRoleCode: requiredString(record, 'attendanceRoleCode', path, 1, 64),
    sortOrder: has(record, 'sortOrder') ? requiredInteger(record, 'sortOrder', path) : 0,
  };
  appendOptional(result, 'capacity', positiveIntegerOrNull(record, 'capacity', path));
  appendOptional(result, 'startOffsetMinutes', startOffsetMinutes);
  appendOptional(result, 'endOffsetMinutes', endOffsetMinutes);
  appendOptional(
    result,
    'genderRequirementCode',
    optionalStringOrNull(record, 'genderRequirementCode', path, 1, 64),
  );
  appendOptional(result, 'locationRequired', locationRequired);
  appendOptional(result, 'radiusMeters', radiusMeters);
  appendOptional(result, 'description', optionalStringOrNull(record, 'description', path, 1, 500));
  appendOptional(
    result,
    'equipmentNotes',
    optionalStringOrNull(record, 'equipmentNotes', path, 1, 500),
  );
  return result as unknown as ActivityTemplateSessionPositionDefinitionV1;
}

function parseSession(value: unknown, path: string): ActivityTemplateSessionDefinitionV1 {
  const record = object(value, path);
  exactKeys(record, path, [
    'code',
    'name',
    'startOffsetMinutes',
    'endOffsetMinutes',
    'locationText',
    'capacity',
    'checkInOpenOffsetMinutes',
    'checkInCloseOffsetMinutes',
    'checkOutOpenOffsetMinutes',
    'checkOutCloseOffsetMinutes',
    'preparationStartOffsetMinutes',
    'locationRequired',
    'radiusMeters',
    'lateGraceMinutes',
    'earlyLeaveThresholdMinutes',
    'sortOrder',
    'positions',
  ]);

  const locationRequired = has(record, 'locationRequired')
    ? requiredBoolean(record, 'locationRequired', path)
    : false;
  const radiusMeters = optionalIntegerOrNull(record, 'radiusMeters', path);
  if (locationRequired) {
    fail(
      `${path}.locationRequired`,
      'cannot be true before a template location/coordinates slice exists',
    );
  }
  if (radiusMeters !== undefined && radiusMeters !== null) {
    fail(
      `${path}.radiusMeters`,
      'cannot be set before a template location/coordinates slice exists',
    );
  }

  if (!has(record, 'positions')) fail(`${path}.positions`, 'is required');
  const positions = array(record.positions, `${path}.positions`).map((item, index) =>
    parsePosition(item, `${path}.positions[${index}]`),
  );
  assertDistinct(positions, `${path}.positions`);

  const result: Record<string, unknown> = {
    code: requiredString(record, 'code', path, 1, 64),
    name: requiredString(record, 'name', path, 1, 200),
    startOffsetMinutes: requiredInteger(record, 'startOffsetMinutes', path),
    endOffsetMinutes: requiredInteger(record, 'endOffsetMinutes', path),
    locationText: requiredString(record, 'locationText', path, 1, 200),
    checkInOpenOffsetMinutes: requiredInteger(record, 'checkInOpenOffsetMinutes', path),
    checkInCloseOffsetMinutes: requiredInteger(record, 'checkInCloseOffsetMinutes', path),
    checkOutOpenOffsetMinutes: requiredInteger(record, 'checkOutOpenOffsetMinutes', path),
    checkOutCloseOffsetMinutes: requiredInteger(record, 'checkOutCloseOffsetMinutes', path),
    locationRequired: false,
    lateGraceMinutes: has(record, 'lateGraceMinutes')
      ? requiredInteger(record, 'lateGraceMinutes', path)
      : 15,
    earlyLeaveThresholdMinutes: has(record, 'earlyLeaveThresholdMinutes')
      ? requiredInteger(record, 'earlyLeaveThresholdMinutes', path)
      : 15,
    sortOrder: has(record, 'sortOrder') ? requiredInteger(record, 'sortOrder', path) : 0,
    positions,
  };
  appendOptional(result, 'capacity', positiveIntegerOrNull(record, 'capacity', path));
  appendOptional(
    result,
    'preparationStartOffsetMinutes',
    optionalIntegerOrNull(record, 'preparationStartOffsetMinutes', path),
  );
  appendOptional(result, 'radiusMeters', radiusMeters);
  return result as unknown as ActivityTemplateSessionDefinitionV1;
}

function parseActivity(value: unknown): ActivityTemplateActivityDefinitionV1 {
  const path = 'definition.activity';
  const record = object(value, path);
  exactKeys(record, path, [
    'allocationModeCode',
    'description',
    'capacity',
    'genderRequirementCode',
    'registrationNotes',
    'isPublicRegistration',
    'requiresInsurance',
    'registrationModeCode',
    'visibilityCode',
    'defaultLocationRequired',
    'defaultCheckInRadiusMeters',
    'archiveWaitingDays',
  ]);

  const result: Record<string, unknown> = {
    allocationModeCode: requiredEnum(record, 'allocationModeCode', path, ALLOCATION_MODES),
  };
  appendOptional(result, 'description', optionalStringOrNull(record, 'description', path, 0, 500));
  appendOptional(result, 'capacity', positiveIntegerOrNull(record, 'capacity', path));
  appendOptional(
    result,
    'genderRequirementCode',
    optionalStringOrNull(record, 'genderRequirementCode', path, 1, 64),
  );
  appendOptional(
    result,
    'registrationNotes',
    optionalStringOrNull(record, 'registrationNotes', path, 0, 500),
  );
  appendOptional(
    result,
    'isPublicRegistration',
    optionalBoolean(record, 'isPublicRegistration', path),
  );
  appendOptional(result, 'requiresInsurance', optionalBoolean(record, 'requiresInsurance', path));
  appendOptional(
    result,
    'registrationModeCode',
    optionalEnumOrNull(record, 'registrationModeCode', path, REGISTRATION_MODES),
  );
  appendOptional(
    result,
    'visibilityCode',
    optionalEnumOrNull(record, 'visibilityCode', path, VISIBILITY_CODES),
  );
  appendOptional(
    result,
    'defaultLocationRequired',
    optionalBooleanOrNull(record, 'defaultLocationRequired', path),
  );
  appendOptional(
    result,
    'defaultCheckInRadiusMeters',
    optionalIntegerOrNull(record, 'defaultCheckInRadiusMeters', path),
  );
  const archiveWaitingDays = optionalIntegerOrNull(record, 'archiveWaitingDays', path);
  if (archiveWaitingDays !== undefined && archiveWaitingDays !== null) {
    if (archiveWaitingDays < 0 || archiveWaitingDays > 365) {
      fail(`${path}.archiveWaitingDays`, 'must be between 0 and 365');
    }
    result.archiveWaitingDays = archiveWaitingDays;
  } else if (archiveWaitingDays === null) {
    fail(`${path}.archiveWaitingDays`, 'must not be null');
  }
  return result as unknown as ActivityTemplateActivityDefinitionV1;
}

/**
 * 解析已由 A3 canonicalizer 校验过的 JSON；仍自行校验 plain object / unknown keys，
 * 因为本函数也可能被独立调用，不能把上游调用顺序当安全边界。
 */
export function parseActivityTemplateDefinitionV1(value: unknown): ActivityTemplateDefinitionV1 {
  const record = object(value, 'definition');
  exactKeys(record, 'definition', ['activity', 'sessions']);
  if (!has(record, 'activity')) fail('definition.activity', 'is required');
  if (!has(record, 'sessions')) fail('definition.sessions', 'is required');

  const sessions = array(record.sessions, 'definition.sessions').map((item, index) =>
    parseSession(item, `definition.sessions[${index}]`),
  );
  assertDistinct(sessions, 'definition.sessions');
  return {
    activity: parseActivity(record.activity),
    sessions,
  };
}
