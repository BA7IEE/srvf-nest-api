import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  selectOnsiteCanonicalHeader,
  type OnsiteLockedIdentity,
} from './onsite-participation-command.service';

const identity = (registrationId: string): OnsiteLockedIdentity => ({
  id: 'identity-1',
  activityId: 'activity-1',
  memberId: 'member-1',
  registrationId,
  sessionId: 'session-1',
  currentRevision: 1,
  currentStatusCode: 'pending',
  currentPositionId: null,
  capacityReservationId: null,
  populationIncluded: false,
  version: 1,
});

describe('OnsiteParticipationCommandService canonical-header boundary', () => {
  it('reuses the one cancelled live header when every permanent identity belongs to it', () => {
    expect(
      selectOnsiteCanonicalHeader(
        [{ id: 'cancelled-header', statusCode: 'cancelled', currentRevision: 4 }],
        [identity('cancelled-header')],
      ),
    ).toEqual({ id: 'cancelled-header', statusCode: 'cancelled', currentRevision: 4 });
  });

  it('fails closed rather than relinking an identity from a historical header', () => {
    expect(() =>
      selectOnsiteCanonicalHeader(
        [{ id: 'live-header', statusCode: 'pending', currentRevision: 2 }],
        [identity('historic-header')],
      ),
    ).toThrow(BizException);
    try {
      selectOnsiteCanonicalHeader(
        [{ id: 'live-header', statusCode: 'pending', currentRevision: 2 }],
        [identity('historic-header')],
      );
    } catch (error) {
      expect(error).toMatchObject({
        biz: BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
      });
    }
  });

  it('fails closed when multiple current heads make the aggregate irreconcilable', () => {
    expect(() =>
      selectOnsiteCanonicalHeader(
        [
          { id: 'live-header-a', statusCode: 'pending', currentRevision: 2 },
          { id: 'live-header-b', statusCode: 'waitlisted', currentRevision: 3 },
        ],
        [],
      ),
    ).toThrow(BizException);
  });
});
