import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../decorators/current-user.decorator';

/** Activity-owned implementation authenticates the caller and reads within the supplied snapshot. */
export const ACTIVITY_DASHBOARD_QUERY = Symbol('ACTIVITY_DASHBOARD_QUERY');

export interface ActivityDashboardSummary {
  registrations?: { pending: number; waitlisted: number };
  settlementReviews?: {
    available: boolean;
    pendingFirstReview?: number;
    pendingFinalReview?: number;
  };
  activityPublishReviews?: { pending: number };
  activities: { published: number; pendingCompletion: number };
}

export interface ActivityDashboardQueryPort {
  read(tx: Prisma.TransactionClient, user: CurrentUserPayload): Promise<ActivityDashboardSummary>;
}
