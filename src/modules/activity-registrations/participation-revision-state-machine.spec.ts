import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  assertRegistrationCommandHeaderStatus,
  decideActivityStartExpiry,
  decideParticipationRevision,
  deriveRegistrationStatusSummary,
} from './participation-revision-state-machine';

describe('participation revision state machine', () => {
  it.each([
    ['pending', true, { kind: 'append', statusCode: 'pending' }],
    ['pending', false, { kind: 'append', statusCode: 'cancelled' }],
    ['waitlisted', true, { kind: 'append', statusCode: 'pending' }],
    ['waitlisted', false, { kind: 'append', statusCode: 'cancelled' }],
    ['cancelled', true, { kind: 'append', statusCode: 'pending' }],
    ['cancelled', false, { kind: 'noop' }],
    ['rejected', true, { kind: 'append', statusCode: 'pending' }],
    ['rejected', false, { kind: 'noop' }],
  ])('%s selected=%s → %j', (statusCode, selected, expected) => {
    expect(decideParticipationRevision(statusCode, selected)).toEqual(expected);
  });

  it.each([
    ['pass', true],
    ['pass', false],
    ['attended', true],
    ['attended', false],
    ['settled', true],
    ['settled', false],
    ['cancellation_requested', true],
    ['cancellation_requested', false],
    ['onsite', true],
    ['onsite', false],
    ['reject', true],
    ['reject', false],
    ['unexpected', true],
    ['unexpected', false],
  ])('rejects immutable/final identity state %s selected=%s', (statusCode, selected) => {
    expect(() => decideParticipationRevision(statusCode, selected)).toThrow(BizException);
    try {
      decideParticipationRevision(statusCode, selected);
    } catch (error) {
      expect(error).toEqual(new BizException(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID));
    }
  });

  it.each(['pending', 'waitlisted', 'cancelled', 'reject'])(
    'allows resumable registration head %s',
    (statusCode) => {
      expect(() => assertRegistrationCommandHeaderStatus(statusCode)).not.toThrow();
    },
  );

  it.each(['pass', 'attended', 'settled', 'cancellation_requested', 'rejected', 'unexpected'])(
    'rejects immutable/final registration head %s',
    (statusCode) => {
      expect(() => assertRegistrationCommandHeaderStatus(statusCode)).toThrow(BizException);
      try {
        assertRegistrationCommandHeaderStatus(statusCode);
      } catch (error) {
        expect(error).toEqual(new BizException(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID));
      }
    },
  );

  it.each([
    ['pending', { kind: 'append', statusCode: 'review_expired' }],
    ['waitlisted', { kind: 'append', statusCode: 'waitlist_expired' }],
    ['pass', { kind: 'noop' }],
    ['review_expired', { kind: 'noop' }],
    ['waitlist_expired', { kind: 'noop' }],
  ])('decides activity-start expiry for %s', (statusCode, expected) => {
    expect(decideActivityStartExpiry(statusCode)).toEqual(expected);
  });

  it('fails closed for an unknown activity-start identity status', () => {
    expect(() => decideActivityStartExpiry('unexpected')).toThrow(BizException);
    try {
      decideActivityStartExpiry('unexpected');
    } catch (error) {
      expect(error).toEqual(new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED));
    }
  });

  it.each([
    [['pass', 'review_expired'], { statusCode: 'pass', statusSummaryCode: 'active' }],
    [['pending', 'waitlist_expired'], { statusCode: 'pending', statusSummaryCode: 'active' }],
    [['waitlisted', 'review_expired'], { statusCode: 'waitlisted', statusSummaryCode: 'active' }],
    [['settled', 'waitlist_expired'], { statusCode: 'pass', statusSummaryCode: 'completed' }],
    [['cancelled', 'review_expired'], { statusCode: 'cancelled', statusSummaryCode: 'cancelled' }],
    [['rejected', 'review_expired'], { statusCode: 'reject', statusSummaryCode: 'not_selected' }],
    [['review_expired', 'waitlist_expired'], { statusCode: 'reject', statusSummaryCode: 'expired' }],
  ])('projects registration statuses %j', (statuses, expected) => {
    expect(deriveRegistrationStatusSummary(statuses)).toEqual(expected);
  });
});
