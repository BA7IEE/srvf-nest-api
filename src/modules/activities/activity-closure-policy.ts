import { Injectable } from '@nestjs/common';
import type { AppManagedActivityClosureDto } from './dto/app/app-managed-activity.dto';

export type ActivityAttendanceWorkflowCounts = {
  total: number;
  pending: number;
  returned: number;
  pendingFinalReview: number;
  unresolved: number;
};

export type ActivityClosureInput = {
  statusCode: string;
  endAt: Date;
  attendanceDeclaredCompleteAt: Date | null;
  latestPublishReviewStatus: string | null;
  attendance: ActivityAttendanceWorkflowCounts;
};

export type ActivityClosureDecision = Pick<AppManagedActivityClosureDto, 'status' | 'nextAction'>;

@Injectable()
export class ActivityClosurePolicy {
  decide(input: ActivityClosureInput, now: Date = new Date()): ActivityClosureDecision {
    if (input.statusCode === 'draft') {
      return input.latestPublishReviewStatus === 'pending'
        ? { status: 'publish-review-pending', nextAction: '等待发布审核' }
        : { status: 'draft', nextAction: '提交发布审核' };
    }

    if (input.statusCode === 'cancelled') {
      return { status: 'published', nextAction: null };
    }

    if (input.attendanceDeclaredCompleteAt === null) {
      return input.endAt.getTime() < now.getTime()
        ? {
            status: 'waiting-attendance-declaration',
            nextAction: '声明考勤已全部提交',
          }
        : { status: 'published', nextAction: null };
    }

    if (input.attendance.returned > 0) {
      return { status: 'attendance-returned', nextAction: '修改并重提退回考勤单' };
    }
    if (input.attendance.pending > 0) {
      return { status: 'attendance-first-review', nextAction: '等待考勤一审' };
    }
    if (input.attendance.pendingFinalReview > 0) {
      return { status: 'attendance-final-review', nextAction: '等待考勤终审' };
    }
    if (input.attendance.unresolved > 0) {
      return { status: 'attendance-first-review', nextAction: '跟进未完成考勤单' };
    }
    if (input.statusCode === 'completed') {
      return { status: 'closed', nextAction: null };
    }
    return { status: 'published', nextAction: '等待活动完结' };
  }
}
