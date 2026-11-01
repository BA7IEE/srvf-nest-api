/** Explicit trusted bootstrap candidate, never HTTP/Job configuration. */
export const HUMAN_CORRECTION_BACKGROUND_BUDGET = Symbol('HUMAN_CORRECTION_BACKGROUND_BUDGET');
export interface HumanCorrectionBackgroundBudget {
  readonly bulkCommit: boolean;
  readonly bulkPrepare: boolean;
}
export const HUMAN_CORRECTION_BACKGROUND_BUDGET_OFF: HumanCorrectionBackgroundBudget =
  Object.freeze({ bulkCommit: false, bulkPrepare: false });
/** First-launch test unit is delta1000; this is not an authorization/size limit. */
export const HUMAN_BACKGROUND_BULK_MIN_SEGMENTS = 1000;
export const HUMAN_BACKGROUND_PREPARE_CANDIDATE_MS = 240_000;
export function isHumanBackgroundBulk(schemaVersion: unknown, count: unknown) {
  return (
    schemaVersion === 3 &&
    typeof count === 'number' &&
    Number.isSafeInteger(count) &&
    count >= HUMAN_BACKGROUND_BULK_MIN_SEGMENTS
  );
}
