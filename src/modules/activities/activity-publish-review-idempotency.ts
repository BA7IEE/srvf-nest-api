import { createHash } from 'node:crypto';

import { Prisma } from '@prisma/client';

import { activityPublishReviewViewSelect } from './activity-publish-review-presenter';

/**
 * 发布审核幂等原语:规范化 JSON、内容哈希与重放查询投影。
 * 提交族(activity-publish-review-submit.service.ts)与审核族(activity-publish-review.service.ts)
 * 共用同一份实现 —— 两侧的 requestHash / reviewRequestHash 必须逐字节同源,
 * 否则同一请求在两条路径上会算出不同哈希、重放判定失效。
 */
export const activityPublishReviewIdempotencySelect = {
  ...activityPublishReviewViewSelect,
  requestHash: true,
  reviewRequestHash: true,
} as const satisfies Prisma.ActivityPublishReviewSelect;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
