/**
 * Onsite conversion is deliberately narrower than the global participation state graph.  It can
 * rescue only pre-settlement, non-final states.  Exact operation-key replay is handled before
 * this machine, so `pass` never becomes a permissive retry state here.
 */
const ONSITE_PASS_ELIGIBLE_STATUSES = new Set([
  'pending',
  'waitlisted',
  'rejected',
  'cancelled',
  'not_selected',
  'invitation_pending',
  'invitation_declined',
  'invitation_expired',
  'review_expired',
  'waitlist_expired',
]);

export type OnsiteParticipationTransition =
  | { allowed: true; nextStatusCode: 'pass' }
  | { allowed: false };

export function decideOnsiteParticipationPass(
  currentStatusCode: string,
): OnsiteParticipationTransition {
  if (ONSITE_PASS_ELIGIBLE_STATUSES.has(currentStatusCode)) {
    return { allowed: true, nextStatusCode: 'pass' };
  }
  return { allowed: false };
}
