import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

export type ParticipationRevisionDecision =
  | { kind: 'append'; statusCode: 'pending' | 'cancelled' }
  | { kind: 'noop' };

function invalid(): never {
  throw new BizException(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
}

/** The canonical command remains an approval-prelude only. */
export function assertRegistrationCommandHeaderStatus(statusCode: string): void {
  if (statusCode !== 'pending' && statusCode !== 'waitlisted') invalid();
}

/**
 * Existing participation identities are permanent; this function only decides whether this
 * command appends an immutable revision.  It never turns an approved/rejected/onsite identity
 * back into a mutable application.
 */
export function decideParticipationRevision(
  currentStatusCode: string,
  selected: boolean,
): ParticipationRevisionDecision {
  if (currentStatusCode === 'pending' || currentStatusCode === 'waitlisted') {
    return { kind: 'append', statusCode: selected ? 'pending' : 'cancelled' };
  }
  if (currentStatusCode === 'cancelled') {
    return selected ? { kind: 'append', statusCode: 'pending' } : { kind: 'noop' };
  }
  return invalid();
}
