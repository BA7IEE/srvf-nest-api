import { decideOnsiteParticipationPass } from './onsite-participation-state-machine';

describe('decideOnsiteParticipationPass', () => {
  it.each([
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
  ])('explicitly allows %s to pass', (statusCode) => {
    expect(decideOnsiteParticipationPass(statusCode)).toEqual({
      allowed: true,
      nextStatusCode: 'pass',
    });
  });

  it.each(['pass', 'attended', 'settled', 'cancellation_requested', 'unknown'])(
    'rejects final or unknown %s without an exact idempotent replay',
    (statusCode) => {
      expect(decideOnsiteParticipationPass(statusCode)).toEqual({ allowed: false });
    },
  );
});
