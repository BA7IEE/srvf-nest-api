import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  ACTIVITY_PUBLISH_REVIEW_ACTIONS,
  ActivityPublishReviewStateMachine,
} from './activity-publish-review-state-machine';

describe('ActivityPublishReviewStateMachine', () => {
  const machine = new ActivityPublishReviewStateMachine();

  it.each([
    ['submit', undefined, 'pending'],
    ['approve', 'pending', 'approved'],
    ['return', 'pending', 'returned'],
    ['withdraw', 'pending', 'withdrawn'],
    ['activity-cancel', 'pending', 'cancelled'],
  ] as const)('%s transitions to %s', (action, current, nextStatus) => {
    expect(machine.decide(action, current)).toEqual({ allowed: true, nextStatus });
  });

  it.each(['approved', 'returned', 'withdrawn', 'cancelled'])(
    'terminal review %s cannot be reviewed again',
    (status) => {
      expect(machine.decide('approve', status)).toEqual({
        allowed: false,
        biz: BizCode.ACTIVITY_PUBLISH_REVIEW_STATUS_INVALID,
      });
    },
  );

  it('does not expose a direct-publish transition', () => {
    expect(ACTIVITY_PUBLISH_REVIEW_ACTIONS).not.toContain('direct-publish');
  });
});
