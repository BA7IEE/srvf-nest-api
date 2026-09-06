import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

export type ActivityMetricStatus = 'draft' | 'active' | 'retired';
export type ActivityMetricAction = 'create' | 'update' | 'activate' | 'retire';

export function metricStatus(value: unknown): ActivityMetricStatus {
  if (value === 'draft' || value === 'active' || value === 'retired') return value;
  throw new BizException(BizCode.ACTIVITY_METRIC_STATUS_INVALID);
}

export function assertMetricTransition(
  current: string,
  action: Exclude<ActivityMetricAction, 'create'>,
  actualHash: string,
  expectedHash: string,
): ActivityMetricStatus {
  if (actualHash !== expectedHash) throw new BizException(BizCode.ACTIVITY_METRIC_VERSION_STALE);
  if (current === 'draft' && action === 'update') return 'draft';
  if (current === 'draft' && action === 'activate') return 'active';
  if (current === 'active' && action === 'retire') return 'retired';
  throw new BizException(BizCode.ACTIVITY_METRIC_STATUS_INVALID);
}
