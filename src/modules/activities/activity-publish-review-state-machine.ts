import { Injectable } from '@nestjs/common';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';

export const ACTIVITY_PUBLISH_REVIEW_ACTIONS = [
  'submit',
  'direct-publish',
  'approve',
  'return',
  'withdraw',
  'activity-cancel',
] as const;

export type ActivityPublishReviewAction = (typeof ACTIVITY_PUBLISH_REVIEW_ACTIONS)[number];
export type ActivityPublishReviewDecision =
  | { allowed: true; nextStatus: 'pending' | 'approved' | 'returned' | 'withdrawn' | 'cancelled' }
  | { allowed: false; biz: BizCodeEntry };

@Injectable()
export class ActivityPublishReviewStateMachine {
  decide(
    action: ActivityPublishReviewAction,
    currentStatus?: string,
  ): ActivityPublishReviewDecision {
    if (action === 'submit') return { allowed: true, nextStatus: 'pending' };
    if (action === 'direct-publish') return { allowed: true, nextStatus: 'approved' };
    if (currentStatus !== 'pending') {
      return { allowed: false, biz: BizCode.ACTIVITY_PUBLISH_REVIEW_STATUS_INVALID };
    }
    switch (action) {
      case 'approve':
        return { allowed: true, nextStatus: 'approved' };
      case 'return':
        return { allowed: true, nextStatus: 'returned' };
      case 'withdraw':
        return { allowed: true, nextStatus: 'withdrawn' };
      case 'activity-cancel':
        return { allowed: true, nextStatus: 'cancelled' };
      default:
        return { allowed: false, biz: BizCode.ACTIVITY_PUBLISH_REVIEW_STATUS_INVALID };
    }
  }
}
