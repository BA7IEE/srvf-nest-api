import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  BEIJING_TIME_ZONE,
  beijingDayBoundsUtc,
  parseDateOnlyStrict,
} from '../../common/datetime/date-only.util';

export const ACTIVITY_SERIES_TIME_ZONE = BEIJING_TIME_ZONE;
export const ACTIVITY_SERIES_MAX_INTERVAL = 365;
export const ACTIVITY_SERIES_MAX_DURATION_MINUTES = 10_080;
export const ACTIVITY_SERIES_MAX_GENERATION_WINDOW_DAYS = 366;
export const ACTIVITY_SERIES_MAX_OCCURRENCES_PER_COMMAND = 366;
export const ACTIVITY_SERIES_MAX_EFFECTIVE_RANGE_DAYS = 3_660;
export const ACTIVITY_SERIES_MAX_REGISTRATION_DEADLINE_OFFSET_MINUTES = 43_200;

export type ActivitySeriesFrequencyCode = 'daily' | 'weekly' | 'monthly';

export interface NormalizedActivitySeriesSchedule {
  readonly frequencyCode: ActivitySeriesFrequencyCode;
  readonly interval: number;
  readonly weeklyWeekdays: readonly number[];
  readonly weeklyWeekdayMask: number;
  readonly monthlyDay: number | null;
}

export interface ActivitySeriesOccurrenceCandidate {
  /** 同一 Series 的同一本地日期只有一个 Occurrence，Revision 改时刻不会制造第二期。 */
  readonly occurrenceKey: string;
  readonly localStartDate: string;
  readonly startAt: Date;
  readonly endAt: Date;
}

type LocalDateParts = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
};

function badRequest(): never {
  throw new BizException(BizCode.BAD_REQUEST);
}

function requirePlainRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) badRequest();
  return value as Record<string, unknown>;
}

function requireKnownKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) badRequest();
}

function requireInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    badRequest();
  }
  return value as number;
}

function formatLocalDate({ year, month, day }: LocalDateParts): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseLocalDate(value: unknown): LocalDateParts {
  const date = parseDateOnlyStrict(value);
  if (!date) badRequest();
  const year = date.getUTCFullYear();
  if (year < 2000 || year > 9999) badRequest();
  return { year, month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function localDateDayNumber(value: string): number {
  const { year, month, day } = parseLocalDate(value);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

function addLocalDays(value: string, days: number): string {
  if (!Number.isInteger(days)) badRequest();
  const { year, month, day } = parseLocalDate(value);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return formatLocalDate({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  });
}

function weekdayMondayOneToSeven(value: string): number {
  const { year, month, day } = parseLocalDate(value);
  const sundayZero = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return sundayZero === 0 ? 7 : sundayZero;
}

function localSeriesDateTimeToUtc(localDate: string, localStartMinute: number): Date {
  const minute = requireInteger(localStartMinute, 0, 1_439);
  const ledgerDate = parseDateOnlyStrict(localDate);
  if (!ledgerDate) badRequest();
  // 本地日界转换只委托 common/datetime 的单一北京日界实现；A7 不保留第二套 +8 算法。
  const result = new Date(beijingDayBoundsUtc(ledgerDate).startAt.getTime() + minute * 60_000);
  if (Number.isNaN(result.getTime())) badRequest();
  return result;
}

function weekdayMaskFromDays(days: readonly number[]): number {
  return days.reduce((mask, weekday) => mask | (1 << (weekday - 1)), 0);
}

function weekdaysFromMask(mask: number): number[] {
  const result: number[] = [];
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    if ((mask & (1 << (weekday - 1))) !== 0) result.push(weekday);
  }
  return result;
}

function matchesScheduleDate(
  schedule: NormalizedActivitySeriesSchedule,
  anchorLocalDate: string,
  candidateLocalDate: string,
): boolean {
  const anchorDay = localDateDayNumber(anchorLocalDate);
  const candidateDay = localDateDayNumber(candidateLocalDate);
  if (candidateDay < anchorDay) return false;

  if (schedule.frequencyCode === 'daily') {
    return (candidateDay - anchorDay) % schedule.interval === 0;
  }

  if (schedule.frequencyCode === 'weekly') {
    const anchorWeekStart = anchorDay - (weekdayMondayOneToSeven(anchorLocalDate) - 1);
    const candidateWeekStart = candidateDay - (weekdayMondayOneToSeven(candidateLocalDate) - 1);
    return (
      ((candidateWeekStart - anchorWeekStart) / 7) % schedule.interval === 0 &&
      schedule.weeklyWeekdays.includes(weekdayMondayOneToSeven(candidateLocalDate))
    );
  }

  const anchor = parseLocalDate(anchorLocalDate);
  const candidate = parseLocalDate(candidateLocalDate);
  const monthsSinceAnchor = (candidate.year - anchor.year) * 12 + (candidate.month - anchor.month);
  return monthsSinceAnchor % schedule.interval === 0 && candidate.day === schedule.monthlyDay;
}

export function normalizeActivitySeriesSchedule(value: unknown): NormalizedActivitySeriesSchedule {
  const input = requirePlainRecord(value);
  requireKnownKeys(input, ['frequencyCode', 'interval', 'weeklyWeekdays', 'monthlyDay']);
  const frequencyCode = input.frequencyCode;
  if (frequencyCode !== 'daily' && frequencyCode !== 'weekly' && frequencyCode !== 'monthly') {
    badRequest();
  }
  const interval = requireInteger(input.interval, 1, ACTIVITY_SERIES_MAX_INTERVAL);

  if (frequencyCode === 'weekly') {
    if (!Array.isArray(input.weeklyWeekdays) || input.monthlyDay !== undefined) badRequest();
    const weekdays = input.weeklyWeekdays.map((weekday) => requireInteger(weekday, 1, 7));
    const normalizedWeekdays = [...new Set(weekdays)].sort((left, right) => left - right);
    if (normalizedWeekdays.length === 0 || normalizedWeekdays.length !== weekdays.length)
      badRequest();
    return {
      frequencyCode,
      interval,
      weeklyWeekdays: normalizedWeekdays,
      weeklyWeekdayMask: weekdayMaskFromDays(normalizedWeekdays),
      monthlyDay: null,
    };
  }

  if (frequencyCode === 'monthly') {
    if (input.weeklyWeekdays !== undefined) badRequest();
    const monthlyDay = requireInteger(input.monthlyDay, 1, 31);
    return {
      frequencyCode,
      interval,
      weeklyWeekdays: [],
      weeklyWeekdayMask: 0,
      monthlyDay,
    };
  }

  if (input.weeklyWeekdays !== undefined || input.monthlyDay !== undefined) badRequest();
  return {
    frequencyCode,
    interval,
    weeklyWeekdays: [],
    weeklyWeekdayMask: 0,
    monthlyDay: null,
  };
}

export function normalizeStoredActivitySeriesSchedule(value: {
  readonly frequencyCode: unknown;
  readonly interval: unknown;
  readonly weeklyWeekdayMask: unknown;
  readonly monthlyDay: unknown;
}): NormalizedActivitySeriesSchedule {
  const frequencyCode = value.frequencyCode;
  const interval = value.interval;
  const weeklyWeekdayMask = value.weeklyWeekdayMask;
  const monthlyDay = value.monthlyDay;
  if (typeof weeklyWeekdayMask !== 'number' || !Number.isInteger(weeklyWeekdayMask)) {
    badRequest();
  }
  const mask = weeklyWeekdayMask;
  if (mask < 0 || mask > 127) badRequest();
  if (
    (frequencyCode === 'daily' && (mask !== 0 || monthlyDay !== null)) ||
    (frequencyCode === 'weekly' && (mask === 0 || monthlyDay !== null)) ||
    (frequencyCode === 'monthly' && mask !== 0)
  ) {
    badRequest();
  }
  return normalizeActivitySeriesSchedule({
    frequencyCode,
    interval,
    ...(frequencyCode === 'weekly' ? { weeklyWeekdays: weekdaysFromMask(mask) } : {}),
    ...(frequencyCode === 'monthly' ? { monthlyDay } : {}),
  });
}

export function normalizeActivitySeriesLocalDate(value: unknown): string {
  return formatLocalDate(parseLocalDate(value));
}

export function normalizeActivitySeriesLocalStartMinute(value: unknown): number {
  return requireInteger(value, 0, 1_439);
}

export function normalizeActivitySeriesDurationMinutes(value: unknown): number {
  return requireInteger(value, 1, ACTIVITY_SERIES_MAX_DURATION_MINUTES);
}

export function normalizeActivitySeriesGenerationWindowDays(value: unknown): number {
  return requireInteger(value, 1, ACTIVITY_SERIES_MAX_GENERATION_WINDOW_DAYS);
}

export function normalizeActivitySeriesRegistrationDeadlineOffsetMinutes(
  value: unknown,
): number | null {
  if (value === undefined || value === null) return null;
  return requireInteger(value, 0, ACTIVITY_SERIES_MAX_REGISTRATION_DEADLINE_OFFSET_MINUTES);
}

export function normalizeActivitySeriesOccurrenceCount(value: unknown): number {
  return requireInteger(value, 1, ACTIVITY_SERIES_MAX_OCCURRENCES_PER_COMMAND);
}

export function assertActivitySeriesEffectiveRange(
  effectiveFromLocalDate: string,
  effectiveToLocalDate: string,
): void {
  const start = localDateDayNumber(effectiveFromLocalDate);
  const end = localDateDayNumber(effectiveToLocalDate);
  if (end < start || end - start > ACTIVITY_SERIES_MAX_EFFECTIVE_RANGE_DAYS) badRequest();
}

export function currentActivitySeriesLocalDate(now: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: ACTIVITY_SERIES_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const value = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  return normalizeActivitySeriesLocalDate(`${value.year}-${value.month}-${value.day}`);
}

export function generateActivitySeriesOccurrenceCandidates(args: {
  readonly schedule: NormalizedActivitySeriesSchedule;
  readonly localStartDate: string;
  readonly localStartMinute: number;
  readonly durationMinutes: number;
  readonly effectiveFromLocalDate: string;
  readonly effectiveToLocalDate: string;
  readonly windowStartLocalDate: string;
  readonly generationWindowDays: number;
}): readonly ActivitySeriesOccurrenceCandidate[] {
  const localStartDate = normalizeActivitySeriesLocalDate(args.localStartDate);
  const effectiveFromLocalDate = normalizeActivitySeriesLocalDate(args.effectiveFromLocalDate);
  const effectiveToLocalDate = normalizeActivitySeriesLocalDate(args.effectiveToLocalDate);
  const windowStartLocalDate = normalizeActivitySeriesLocalDate(args.windowStartLocalDate);
  const localStartMinute = normalizeActivitySeriesLocalStartMinute(args.localStartMinute);
  const durationMinutes = normalizeActivitySeriesDurationMinutes(args.durationMinutes);
  const generationWindowDays = normalizeActivitySeriesGenerationWindowDays(
    args.generationWindowDays,
  );
  assertActivitySeriesEffectiveRange(effectiveFromLocalDate, effectiveToLocalDate);

  const windowEndLocalDate = addLocalDays(windowStartLocalDate, generationWindowDays - 1);
  const effectiveStartDay = localDateDayNumber(effectiveFromLocalDate);
  const effectiveEndDay = localDateDayNumber(effectiveToLocalDate);
  const windowStartDay = localDateDayNumber(windowStartLocalDate);
  const windowEndDay = localDateDayNumber(windowEndLocalDate);
  const firstDay = Math.max(effectiveStartDay, windowStartDay);
  const lastDay = Math.min(effectiveEndDay, windowEndDay);
  if (firstDay > lastDay) return [];

  const candidates: ActivitySeriesOccurrenceCandidate[] = [];
  for (let dayNumber = firstDay; dayNumber <= lastDay; dayNumber += 1) {
    const date = new Date(dayNumber * 86_400_000);
    const candidateLocalDate = formatLocalDate({
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    });
    if (!matchesScheduleDate(args.schedule, localStartDate, candidateLocalDate)) continue;
    const startAt = localSeriesDateTimeToUtc(candidateLocalDate, localStartMinute);
    const endAt = new Date(startAt.getTime() + durationMinutes * 60_000);
    candidates.push({
      occurrenceKey: candidateLocalDate,
      localStartDate: candidateLocalDate,
      startAt,
      endAt,
    });
  }
  return candidates;
}
