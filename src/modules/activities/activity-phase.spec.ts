import {
  ACTIVITY_PHASE_ENDED,
  ACTIVITY_PHASE_ONGOING,
  ACTIVITY_PHASE_UPCOMING,
  deriveActivityPhase,
} from './activity-phase';

describe('deriveActivityPhase', () => {
  const startAt = new Date('2026-07-15T10:00:00.000Z');
  const endAt = new Date('2026-07-15T12:00:00.000Z');

  it.each([
    ['before start', new Date('2026-07-15T09:59:59.999Z'), ACTIVITY_PHASE_UPCOMING],
    ['at start', startAt, ACTIVITY_PHASE_ONGOING],
    ['at end', endAt, ACTIVITY_PHASE_ONGOING],
    ['after end', new Date('2026-07-15T12:00:00.001Z'), ACTIVITY_PHASE_ENDED],
  ])('%s → %s', (_label, now, expected) => {
    expect(deriveActivityPhase(startAt, endAt, now)).toBe(expected);
  });
});
