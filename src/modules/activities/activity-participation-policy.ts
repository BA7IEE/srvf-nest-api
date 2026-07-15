import { Injectable } from '@nestjs/common';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';

export type ActivityParticipationDecision =
  | { allowed: true }
  | { allowed: false; biz: BizCodeEntry };

export interface ActivityParticipationSnapshot {
  statusCode: string;
  isPublicRegistration: boolean;
  registrationDeadline: Date | null;
  endAt: Date;
}

@Injectable()
export class ActivityParticipationPolicy {
  canRegisterSelf(
    activity: ActivityParticipationSnapshot,
    now: Date = new Date(),
  ): ActivityParticipationDecision {
    const statusDecision = this.canRegisterByStatus(activity.statusCode);
    if (!statusDecision.allowed) return statusDecision;
    if (!activity.isPublicRegistration) {
      return { allowed: false, biz: BizCode.ACTIVITY_NOT_PUBLIC_REGISTRATION };
    }
    return this.canRegisterByTime(activity, now);
  }

  canRegisterByAdmin(
    activity: ActivityParticipationSnapshot,
    now: Date = new Date(),
  ): ActivityParticipationDecision {
    const statusDecision = this.canRegisterByStatus(activity.statusCode);
    if (!statusDecision.allowed) return statusDecision;
    return this.canRegisterByTime(activity, now);
  }

  canApprove(
    activity: Pick<ActivityParticipationSnapshot, 'statusCode' | 'endAt'>,
    now: Date = new Date(),
  ): ActivityParticipationDecision {
    if (activity.statusCode !== 'published') {
      return {
        allowed: false,
        biz:
          activity.statusCode === 'cancelled' || activity.statusCode === 'completed'
            ? BizCode.ACTIVITY_ENDED_OR_CANCELLED_APPROVE_FORBIDDEN
            : BizCode.ACTIVITY_NOT_PUBLISHED_PARTICIPATION_FORBIDDEN,
      };
    }
    if (now.getTime() > activity.endAt.getTime()) {
      return { allowed: false, biz: BizCode.ACTIVITY_ENDED_OR_CANCELLED_APPROVE_FORBIDDEN };
    }
    return { allowed: true };
  }

  canSubmitAttendance(activity: { statusCode: string }): ActivityParticipationDecision {
    if (activity.statusCode === 'published' || activity.statusCode === 'completed') {
      return { allowed: true };
    }
    return {
      allowed: false,
      biz:
        activity.statusCode === 'cancelled'
          ? BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN
          : BizCode.ACTIVITY_NOT_PUBLISHED_PARTICIPATION_FORBIDDEN,
    };
  }

  private canRegisterByStatus(statusCode: string): ActivityParticipationDecision {
    if (statusCode === 'published') return { allowed: true };
    return {
      allowed: false,
      biz:
        statusCode === 'cancelled'
          ? BizCode.ACTIVITY_CANCELLED_REGISTRATION_FORBIDDEN
          : BizCode.ACTIVITY_NOT_PUBLISHED_PARTICIPATION_FORBIDDEN,
    };
  }

  private canRegisterByTime(
    activity: Pick<ActivityParticipationSnapshot, 'registrationDeadline' | 'endAt'>,
    now: Date,
  ): ActivityParticipationDecision {
    if (
      activity.registrationDeadline !== null &&
      now.getTime() > activity.registrationDeadline.getTime()
    ) {
      return { allowed: false, biz: BizCode.ACTIVITY_REGISTRATION_DEADLINE_PASSED };
    }
    if (now.getTime() > activity.endAt.getTime()) {
      return { allowed: false, biz: BizCode.ACTIVITY_ENDED_REGISTRATION_FORBIDDEN };
    }
    return { allowed: true };
  }
}
