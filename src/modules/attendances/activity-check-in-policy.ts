import { Injectable } from '@nestjs/common';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';

export type ActivityCheckInAction = 'check-in' | 'check-out';

export type ActivityCheckInDecision = { allowed: true } | { allowed: false; biz: BizCodeEntry };

export interface ActivityCheckInSchedule {
  startAt: Date;
  endAt: Date;
}

const CHECK_OUT_MIN_SPAN_MS = 36_000;

@Injectable()
export class ActivityCheckInPolicy {
  canWriteByStatus(action: ActivityCheckInAction, statusCode: string): ActivityCheckInDecision {
    if (statusCode === 'published') return { allowed: true };
    if (action === 'check-out' && statusCode === 'completed') return { allowed: true };
    if (statusCode === 'cancelled') {
      return { allowed: false, biz: BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN };
    }
    if (statusCode === 'draft') {
      return {
        allowed: false,
        biz: BizCode.ACTIVITY_NOT_PUBLISHED_PARTICIPATION_FORBIDDEN,
      };
    }
    return { allowed: false, biz: BizCode.ACTIVITY_STATUS_INVALID };
  }

  canWriteByTime(
    action: 'check-in',
    activity: ActivityCheckInSchedule,
    now: Date,
    toleranceHours: number,
  ): ActivityCheckInDecision;

  canWriteByTime(
    action: 'check-out',
    activity: ActivityCheckInSchedule,
    now: Date,
    toleranceHours: number,
    checkInAt: Date,
  ): ActivityCheckInDecision;

  canWriteByTime(
    action: ActivityCheckInAction,
    activity: ActivityCheckInSchedule,
    now: Date,
    toleranceHours: number,
    checkInAt?: Date,
  ): ActivityCheckInDecision {
    const toleranceMs = toleranceHours * 3_600_000;
    const earliest = activity.startAt.getTime() - toleranceMs;
    const latest =
      action === 'check-in'
        ? activity.endAt.getTime() - CHECK_OUT_MIN_SPAN_MS
        : activity.endAt.getTime() + toleranceMs;
    const nowMs = now.getTime();

    if (nowMs < earliest || nowMs > latest) {
      return { allowed: false, biz: BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW };
    }
    if (action === 'check-out') {
      // overload 令生产调用点编译期必须传签到时间；runtime 仍 fail closed，避免未来 JS/any
      // 调用在遗漏证据时绕过 36 秒 floor。
      if (checkInAt === undefined) {
        throw new Error('check-out time policy requires checkInAt');
      }
      if (nowMs < checkInAt.getTime() + CHECK_OUT_MIN_SPAN_MS) {
        return { allowed: false, biz: BizCode.ATTENDANCE_SERVICE_HOURS_INVALID };
      }
    }
    return { allowed: true };
  }
}

export { CHECK_OUT_MIN_SPAN_MS };
