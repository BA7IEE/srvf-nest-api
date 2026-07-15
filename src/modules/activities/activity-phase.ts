export const ACTIVITY_PHASE_UPCOMING = 'upcoming';
export const ACTIVITY_PHASE_ONGOING = 'ongoing';
export const ACTIVITY_PHASE_ENDED = 'ended';

export const ACTIVITY_PHASE_VALUES = [
  ACTIVITY_PHASE_UPCOMING,
  ACTIVITY_PHASE_ONGOING,
  ACTIVITY_PHASE_ENDED,
] as const;

export type ActivityPhase = (typeof ACTIVITY_PHASE_VALUES)[number];

// 纯读侧时间派生，不写回 Activity.statusCode。边界：startAt 命中即 ongoing，endAt 过去后才 ended。
export function deriveActivityPhase(
  startAt: Date,
  endAt: Date,
  now: Date = new Date(),
): ActivityPhase {
  if (now.getTime() < startAt.getTime()) return ACTIVITY_PHASE_UPCOMING;
  if (now.getTime() <= endAt.getTime()) return ACTIVITY_PHASE_ONGOING;
  return ACTIVITY_PHASE_ENDED;
}
