import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  assertRegistrationCommandHeaderStatus,
  decideParticipationRevision,
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
});
