import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export const APP_ACTIVITY_CHECK_IN_RESPONSE_FIELDS = [
  'id',
  'activityId',
  'registrationId',
  'checkInAt',
  'checkOutAt',
  'checkInDistance',
  'checkOutDistance',
  'geoVerified',
  'outOfRange',
  'createdAt',
  'updatedAt',
] as const;

export const ACTIVITY_CHECK_IN_RESPONSE_DENIED_FIELDS = [
  'memberId',
  'checkInLongitude',
  'checkInLatitude',
  'checkInAccuracy',
  'checkOutLongitude',
  'checkOutLatitude',
  'checkOutAccuracy',
  'deletedAt',
] as const;

export const APP_ACTIVITY_CHECK_IN_SELECT = {
  id: true,
  activityId: true,
  registrationId: true,
  checkInAt: true,
  checkOutAt: true,
  checkInDistance: true,
  checkOutDistance: true,
  geoVerified: true,
  outOfRange: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ActivityCheckInSelect;

export type AppActivityCheckInRow = Prisma.ActivityCheckInGetPayload<{
  select: typeof APP_ACTIVITY_CHECK_IN_SELECT;
}>;

// Safe select 与响应 allowlist 的单一权威。Presenter 在返回前执行精确字段断言，避免未来
// mapper 扩展时把原始坐标、accuracy 或 memberId 悄悄带入 App/Admin surface。
@Injectable()
export class ActivityCheckInFieldPolicy {
  readonly appSelect = APP_ACTIVITY_CHECK_IN_SELECT;

  assertAppResponse(payload: Record<string, unknown>): void {
    const actual = Object.keys(payload).sort();
    const expected = [...APP_ACTIVITY_CHECK_IN_RESPONSE_FIELDS].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
      throw new Error('App activity check-in response field policy mismatch');
    }
    for (const denied of ACTIVITY_CHECK_IN_RESPONSE_DENIED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(payload, denied)) {
        throw new Error(`App activity check-in response contains denied field:${denied}`);
      }
    }
  }
}
