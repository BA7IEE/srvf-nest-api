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
  ])('%s selected=%s → %j', (statusCode, selected, expected) => {
    expect(decideParticipationRevision(statusCode, selected)).toEqual(expected);
  });

  it.each(['pass', 'reject', 'onsite', 'unexpected'])(
    'rejects immutable/final identity state %s',
    (statusCode) => {
      expect(() => decideParticipationRevision(statusCode, true)).toThrow(BizException);
      try {
        decideParticipationRevision(statusCode, true);
      } catch (error) {
        expect(error).toEqual(new BizException(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID));
      }
    },
  );

  it('allows only pending/waitlisted registration heads', () => {
    expect(() => assertRegistrationCommandHeaderStatus('pending')).not.toThrow();
    expect(() => assertRegistrationCommandHeaderStatus('waitlisted')).not.toThrow();
    expect(() => assertRegistrationCommandHeaderStatus('pass')).toThrow(BizException);
  });
});
