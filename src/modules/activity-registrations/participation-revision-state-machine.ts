import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

export type ParticipationRevisionDecision =
  | { kind: 'append'; statusCode: 'pending' | 'cancelled' }
  | { kind: 'noop' };

export type ActivityStartExpiryDecision =
  | { kind: 'append'; statusCode: 'review_expired' | 'waitlist_expired' }
  | { kind: 'noop' };

export interface RegistrationStatusSummaryProjection {
  statusCode: 'pass' | 'pending' | 'waitlisted' | 'cancelled' | 'reject';
  statusSummaryCode: 'active' | 'completed' | 'cancelled' | 'not_selected' | 'expired';
}

function invalid(): never {
  throw new BizException(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
}

/** The canonical command remains an approval-prelude only. */
export function assertRegistrationCommandHeaderStatus(statusCode: string): void {
  if (
    statusCode !== 'pending' &&
    statusCode !== 'waitlisted' &&
    statusCode !== 'cancelled' &&
    statusCode !== 'reject'
  ) {
    invalid();
  }
}

/**
 * Existing participation identities are permanent; this function only decides whether this
 * command appends an immutable revision.  A cancelled/rejected identity may start a new pending
 * revision; approved/attended/settled/onsite identities remain final.
 */
export function decideParticipationRevision(
  currentStatusCode: string,
  selected: boolean,
): ParticipationRevisionDecision {
  if (currentStatusCode === 'pending' || currentStatusCode === 'waitlisted') {
    return { kind: 'append', statusCode: selected ? 'pending' : 'cancelled' };
  }
  if (currentStatusCode === 'cancelled' || currentStatusCode === 'rejected') {
    return selected ? { kind: 'append', statusCode: 'pending' } : { kind: 'noop' };
  }
  return invalid();
}

/**
 * Activity start only closes states that are still unresolved. It intentionally does not turn a
 * pass into a terminal result or try to promote a waitlist: those are separate lifecycle paths.
 */
export function decideActivityStartExpiry(currentStatusCode: string): ActivityStartExpiryDecision {
  if (currentStatusCode === 'pending') return { kind: 'append', statusCode: 'review_expired' };
  if (currentStatusCode === 'waitlisted') {
    return { kind: 'append', statusCode: 'waitlist_expired' };
  }
  if (
    currentStatusCode === 'pass' ||
    currentStatusCode === 'attended' ||
    currentStatusCode === 'settled' ||
    currentStatusCode === 'not_selected' ||
    currentStatusCode === 'rejected' ||
    currentStatusCode === 'cancelled' ||
    currentStatusCode === 'cancellation_requested' ||
    currentStatusCode === 'invitation_pending' ||
    currentStatusCode === 'invitation_declined' ||
    currentStatusCode === 'invitation_expired' ||
    currentStatusCode === 'review_expired' ||
    currentStatusCode === 'waitlist_expired'
  ) {
    return { kind: 'noop' };
  }
  throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
}

/**
 * The permanent registration header remains a compatibility projection.  The immutable identity
 * statuses are authoritative; this function implements the §3.6 aggregation priority while using
 * the existing header vocabulary (`pass` / `pending` / `waitlisted` / `cancelled` / `reject`).
 */
export function deriveRegistrationStatusSummary(
  statusCodes: readonly string[],
): RegistrationStatusSummaryProjection {
  if (statusCodes.length === 0) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  if (statusCodes.some((statusCode) => statusCode === 'pass' || statusCode === 'attended')) {
    return { statusCode: 'pass', statusSummaryCode: 'active' };
  }
  if (
    statusCodes.some(
      (statusCode) =>
        statusCode === 'pending' ||
        statusCode === 'cancellation_requested' ||
        statusCode === 'invitation_pending',
    )
  ) {
    return { statusCode: 'pending', statusSummaryCode: 'active' };
  }
  if (statusCodes.some((statusCode) => statusCode === 'waitlisted')) {
    return { statusCode: 'waitlisted', statusSummaryCode: 'active' };
  }

  // `settled` is a terminal selection.  Header `statusCode` has no `completed` value, so retain
  // the established compatibility projection `pass` while exposing the canonical summary.
  if (statusCodes.some((statusCode) => statusCode === 'settled')) {
    return { statusCode: 'pass', statusSummaryCode: 'completed' };
  }
  if (statusCodes.some((statusCode) => statusCode === 'cancelled')) {
    return { statusCode: 'cancelled', statusSummaryCode: 'cancelled' };
  }
  if (
    statusCodes.some(
      (statusCode) =>
        statusCode === 'not_selected' ||
        statusCode === 'rejected' ||
        statusCode === 'invitation_declined',
    )
  ) {
    return { statusCode: 'reject', statusSummaryCode: 'not_selected' };
  }
  if (
    statusCodes.some(
      (statusCode) =>
        statusCode === 'review_expired' ||
        statusCode === 'waitlist_expired' ||
        statusCode === 'invitation_expired',
    )
  ) {
    return { statusCode: 'reject', statusSummaryCode: 'expired' };
  }
  throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
}
