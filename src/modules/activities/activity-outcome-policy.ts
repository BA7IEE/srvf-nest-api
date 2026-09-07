import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

const WRITABLE_ACTIVITY_STATES = new Set(['draft', 'published', 'completed', 'terminated']);

/** Pure decision only. Replay deliberately does not call this new-write gate. */
export function nextActivityOutcomeRevision(
  activityStatus: string,
  expectedRevision: number,
  latest: { id: string; revision: number; statusCode: string } | null,
): { revision: number; priorRevisionId: string | null; supersedeId: string | null } {
  if (!WRITABLE_ACTIVITY_STATES.has(activityStatus))
    throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    expectedRevision >= 2147483647 ||
    (latest?.revision ?? 0) !== expectedRevision
  )
    throw new BizException(BizCode.ACTIVITY_OUTCOME_STALE);
  // D2 cannot replace a confirmed result. C3 owns its subsequent transition.
  if (latest && latest.statusCode !== 'draft')
    throw new BizException(BizCode.ACTIVITY_OUTCOME_STALE);
  return {
    revision: expectedRevision + 1,
    priorRevisionId: latest?.id ?? null,
    supersedeId: latest?.id ?? null,
  };
}
