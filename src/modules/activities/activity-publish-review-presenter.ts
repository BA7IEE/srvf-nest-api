import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ActivityPublishReviewResponseDto } from './activity-publish-review.dto';

export const activityPublishReviewViewSelect = {
  id: true,
  activityId: true,
  requestType: true,
  requestVersion: true,
  baseRevision: true,
  status: true,
  snapshot: true,
  directPublish: true,
  submittedByUserId: true,
  submittedAt: true,
  reviewedByUserId: true,
  reviewedAt: true,
  reviewNote: true,
  createdAt: true,
  updatedAt: true,
  activity: {
    select: { title: true, organizationId: true, initiatorMemberId: true },
  },
} as const satisfies Prisma.ActivityPublishReviewSelect;

export type ActivityPublishReviewViewRow = Prisma.ActivityPublishReviewGetPayload<{
  select: typeof activityPublishReviewViewSelect;
}>;

@Injectable()
export class ActivityPublishReviewPresenter {
  toDto(row: ActivityPublishReviewViewRow): ActivityPublishReviewResponseDto {
    return {
      id: row.id,
      activityId: row.activityId,
      requestType: row.requestType,
      requestVersion: row.requestVersion,
      baseRevision: row.baseRevision,
      status: row.status,
      snapshot: row.snapshot as Record<string, unknown>,
      directPublish: row.directPublish,
      submittedByUserId: row.submittedByUserId,
      submittedAt: row.submittedAt,
      reviewedByUserId: row.reviewedByUserId,
      reviewedAt: row.reviewedAt,
      reviewNote: row.reviewNote,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      activityTitle: row.activity.title,
      organizationId: row.activity.organizationId,
      initiatorMemberId: row.activity.initiatorMemberId,
    };
  }
}
