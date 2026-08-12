export const ACTIVITY_ALLOCATION_MODE_CODES = [
  'first_come',
  'qualification_rank',
  'lottery',
] as const;

export type ActivityAllocationModeCode = (typeof ACTIVITY_ALLOCATION_MODE_CODES)[number];

export function isActivityAllocationModeCode(value: unknown): value is ActivityAllocationModeCode {
  return (
    typeof value === 'string' &&
    (ACTIVITY_ALLOCATION_MODE_CODES as readonly string[]).includes(value)
  );
}
