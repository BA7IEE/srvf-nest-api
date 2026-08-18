import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { ActivityPublishReviewResponseDto } from './activity-publish-review.dto';

// B7 的 nullable JSONB 只能在运行时作为 string[] 消费；任何其余 JSON 形状都是持久化合同损坏，
// 不能 filter 后悄悄继续，以免扩大受众或把损坏状态伪装成 legacy NULL。
export function readActivityPublishReviewAudienceTagCodes(
  value: Prisma.JsonValue | null,
): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((code) => typeof code !== 'string')) {
    throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
  }
  return value as string[];
}

export const activityPublishReviewViewSelect = {
  id: true,
  activityId: true,
  requestType: true,
  requestVersion: true,
  baseRevision: true,
  status: true,
  snapshot: true,
  directPublish: true,
  audienceTagCodes: true,
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
      audienceTagCodes: readActivityPublishReviewAudienceTagCodes(row.audienceTagCodes),
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
