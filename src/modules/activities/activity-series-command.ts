import { createHash } from 'node:crypto';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { canonicalize, type CanonicalValue } from './settlement-content-hash';
import {
  ACTIVITY_SERIES_TIME_ZONE,
  assertActivitySeriesEffectiveRange,
  normalizeActivitySeriesDurationMinutes,
  normalizeActivitySeriesGenerationWindowDays,
  normalizeActivitySeriesLocalDate,
  normalizeActivitySeriesLocalStartMinute,
  normalizeActivitySeriesOccurrenceCount,
  normalizeActivitySeriesRegistrationDeadlineOffsetMinutes,
  normalizeActivitySeriesSchedule,
  type NormalizedActivitySeriesSchedule,
} from './activity-series-schedule';

export type ActivitySeriesStatusCode = 'active' | 'paused' | 'terminated';
export type ActivitySeriesCommandCode =
  | 'create_series'
  | 'revise_series'
  | 'set_series_status'
  | 'generate_instances';

export interface CreateActivitySeriesCommand {
  readonly code: string;
  readonly templateVersionId: string;
  readonly frequencyCode: 'daily' | 'weekly' | 'monthly';
  readonly interval: number;
  readonly weeklyWeekdays?: readonly number[];
  readonly monthlyDay?: number;
  readonly timeZone: typeof ACTIVITY_SERIES_TIME_ZONE;
  readonly localStartDate: string;
  readonly localStartMinute: number;
  readonly durationMinutes: number;
  readonly title: string;
  readonly organizationId: string;
  readonly location: string;
  readonly registrationDeadlineOffsetMinutes?: number | null;
  readonly effectiveFromLocalDate: string;
  readonly effectiveToLocalDate: string;
  readonly generationWindowDays: number;
  readonly operationKey: string;
}

export interface ReviseActivitySeriesCommand extends Omit<
  CreateActivitySeriesCommand,
  'code' | 'operationKey'
> {
  readonly seriesId: string;
  readonly operationKey: string;
}

export interface SetActivitySeriesStatusCommand {
  readonly seriesId: string;
  readonly statusCode: ActivitySeriesStatusCode;
  readonly operationKey: string;
}

export interface GenerateActivitySeriesInstancesCommand {
  readonly seriesId: string;
  readonly revision: number;
  readonly fromLocalDate: string;
  readonly count: number;
  readonly operationKey: string;
}

/** 不返回 Prisma row、请求 hash、operationKey 或 Revision 原文。 */
export interface ActivitySeriesCommandResult {
  readonly seriesId: string;
  readonly revision: number | null;
  readonly statusCode: ActivitySeriesStatusCode;
  readonly activityIds: readonly string[];
}

export type NormalizedActivitySeriesRevisionInput = {
  readonly templateVersionId: string;
  readonly schedule: NormalizedActivitySeriesSchedule;
  readonly timeZone: typeof ACTIVITY_SERIES_TIME_ZONE;
  readonly localStartDate: string;
  readonly localStartMinute: number;
  readonly durationMinutes: number;
  readonly title: string;
  readonly organizationId: string;
  readonly location: string;
  readonly registrationDeadlineOffsetMinutes: number | null;
  readonly effectiveFromLocalDate: string;
  readonly effectiveToLocalDate: string;
  readonly generationWindowDays: number;
};

export type NormalizedCreateActivitySeriesCommand = NormalizedActivitySeriesRevisionInput & {
  readonly code: string;
  readonly operationKey: string;
};

export type NormalizedReviseActivitySeriesCommand = NormalizedActivitySeriesRevisionInput & {
  readonly seriesId: string;
  readonly operationKey: string;
};

export type NormalizedSetActivitySeriesStatusCommand = {
  readonly seriesId: string;
  readonly statusCode: ActivitySeriesStatusCode;
  readonly operationKey: string;
};

export type NormalizedGenerateActivitySeriesInstancesCommand = {
  readonly seriesId: string;
  readonly revision: number;
  readonly fromLocalDate: string;
  readonly count: number;
  readonly operationKey: string;
};

function badRequest(): never {
  throw new BizException(BizCode.BAD_REQUEST);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) badRequest();
  return value as Record<string, unknown>;
}

function requireKnownKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) badRequest();
}

function requireString(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) badRequest();
  return value;
}

function requireLiteral(value: unknown, minimum: number, maximum: number): string {
  const literal = requireString(value, minimum, maximum);
  if (literal.trim().length === 0) badRequest();
  return literal;
}

function requireSeriesCode(value: unknown): string {
  const code = requireString(value, 3, 64);
  if (!/^[a-z][a-z0-9-]*$/.test(code)) badRequest();
  return code;
}

function requireOperationKey(value: unknown): string {
  return requireString(value, 8, 128);
}

function requireSeriesId(value: unknown): string {
  return requireString(value, 8, 64);
}

function requireRevision(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 1_000_000) {
    badRequest();
  }
  return value as number;
}

export function isActivitySeriesStatusCode(value: unknown): value is ActivitySeriesStatusCode {
  return value === 'active' || value === 'paused' || value === 'terminated';
}

export function toActivitySeriesRevisionHashPayload(
  input: NormalizedActivitySeriesRevisionInput,
): CanonicalValue {
  return {
    templateVersionId: input.templateVersionId,
    frequencyCode: input.schedule.frequencyCode,
    interval: input.schedule.interval,
    weeklyWeekdays: [...input.schedule.weeklyWeekdays],
    monthlyDay: input.schedule.monthlyDay,
    timeZone: input.timeZone,
    localStartDate: input.localStartDate,
    localStartMinute: input.localStartMinute,
    durationMinutes: input.durationMinutes,
    title: input.title,
    organizationId: input.organizationId,
    location: input.location,
    registrationDeadlineOffsetMinutes: input.registrationDeadlineOffsetMinutes,
    effectiveFromLocalDate: input.effectiveFromLocalDate,
    effectiveToLocalDate: input.effectiveToLocalDate,
    generationWindowDays: input.generationWindowDays,
  };
}

export function buildActivitySeriesRequestHash(
  action: ActivitySeriesCommandCode,
  actorUserId: string,
  operationKey: string,
  payload: CanonicalValue,
): string {
  return createHash('sha256')
    .update(canonicalize({ action, actorUserId, operationKey, payload }), 'utf8')
    .digest('hex');
}

export function normalizeCreateActivitySeriesCommand(
  command: CreateActivitySeriesCommand,
): NormalizedCreateActivitySeriesCommand {
  const input = requireRecord(command);
  requireKnownKeys(input, [
    'code',
    'templateVersionId',
    'frequencyCode',
    'interval',
    'weeklyWeekdays',
    'monthlyDay',
    'timeZone',
    'localStartDate',
    'localStartMinute',
    'durationMinutes',
    'title',
    'organizationId',
    'location',
    'registrationDeadlineOffsetMinutes',
    'effectiveFromLocalDate',
    'effectiveToLocalDate',
    'generationWindowDays',
    'operationKey',
  ]);
  return {
    code: requireSeriesCode(input.code),
    operationKey: requireOperationKey(input.operationKey),
    ...normalizeActivitySeriesRevisionInput(input),
  };
}

export function normalizeReviseActivitySeriesCommand(
  command: ReviseActivitySeriesCommand,
): NormalizedReviseActivitySeriesCommand {
  const input = requireRecord(command);
  requireKnownKeys(input, [
    'seriesId',
    'templateVersionId',
    'frequencyCode',
    'interval',
    'weeklyWeekdays',
    'monthlyDay',
    'timeZone',
    'localStartDate',
    'localStartMinute',
    'durationMinutes',
    'title',
    'organizationId',
    'location',
    'registrationDeadlineOffsetMinutes',
    'effectiveFromLocalDate',
    'effectiveToLocalDate',
    'generationWindowDays',
    'operationKey',
  ]);
  return {
    seriesId: requireSeriesId(input.seriesId),
    operationKey: requireOperationKey(input.operationKey),
    ...normalizeActivitySeriesRevisionInput(input),
  };
}

export function normalizeSetActivitySeriesStatusCommand(
  command: SetActivitySeriesStatusCommand,
): NormalizedSetActivitySeriesStatusCommand {
  const input = requireRecord(command);
  requireKnownKeys(input, ['seriesId', 'statusCode', 'operationKey']);
  if (!isActivitySeriesStatusCode(input.statusCode)) badRequest();
  return {
    seriesId: requireSeriesId(input.seriesId),
    statusCode: input.statusCode,
    operationKey: requireOperationKey(input.operationKey),
  };
}

export function normalizeGenerateActivitySeriesInstancesCommand(
  command: GenerateActivitySeriesInstancesCommand,
): NormalizedGenerateActivitySeriesInstancesCommand {
  const input = requireRecord(command);
  requireKnownKeys(input, ['seriesId', 'revision', 'fromLocalDate', 'count', 'operationKey']);
  return {
    seriesId: requireSeriesId(input.seriesId),
    revision: requireRevision(input.revision),
    fromLocalDate: normalizeActivitySeriesLocalDate(input.fromLocalDate),
    count: normalizeActivitySeriesOccurrenceCount(input.count),
    operationKey: requireOperationKey(input.operationKey),
  };
}

function normalizeActivitySeriesRevisionInput(
  input: Record<string, unknown>,
): NormalizedActivitySeriesRevisionInput {
  const schedule = normalizeActivitySeriesSchedule({
    frequencyCode: input.frequencyCode,
    interval: input.interval,
    ...(Object.hasOwn(input, 'weeklyWeekdays') ? { weeklyWeekdays: input.weeklyWeekdays } : {}),
    ...(Object.hasOwn(input, 'monthlyDay') ? { monthlyDay: input.monthlyDay } : {}),
  });
  if (input.timeZone !== ACTIVITY_SERIES_TIME_ZONE) badRequest();
  const effectiveFromLocalDate = normalizeActivitySeriesLocalDate(input.effectiveFromLocalDate);
  const effectiveToLocalDate = normalizeActivitySeriesLocalDate(input.effectiveToLocalDate);
  assertActivitySeriesEffectiveRange(effectiveFromLocalDate, effectiveToLocalDate);
  const localStartDate = normalizeActivitySeriesLocalDate(input.localStartDate);
  if (localStartDate > effectiveToLocalDate) badRequest();
  return {
    templateVersionId: requireString(input.templateVersionId, 8, 64),
    schedule,
    timeZone: ACTIVITY_SERIES_TIME_ZONE,
    localStartDate,
    localStartMinute: normalizeActivitySeriesLocalStartMinute(input.localStartMinute),
    durationMinutes: normalizeActivitySeriesDurationMinutes(input.durationMinutes),
    title: requireLiteral(input.title, 1, 200),
    organizationId: requireString(input.organizationId, 8, 64),
    location: requireLiteral(input.location, 1, 200),
    registrationDeadlineOffsetMinutes: normalizeActivitySeriesRegistrationDeadlineOffsetMinutes(
      input.registrationDeadlineOffsetMinutes,
    ),
    effectiveFromLocalDate,
    effectiveToLocalDate,
    generationWindowDays: normalizeActivitySeriesGenerationWindowDays(input.generationWindowDays),
  };
}
