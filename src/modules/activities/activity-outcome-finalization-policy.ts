import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

export type OutcomeRevisionAnchor = {
  id: string;
  revision: number;
  statusCode: string;
};

/** New writes only: receipt replay must not re-evaluate historical write state. */
export function assertOutcomeFinalizationAnchors(
  activityStatus: string,
  expectedLatestRevision: number,
  expectedConfirmedRevision: number,
  latest: OutcomeRevisionAnchor | null,
  confirmed: OutcomeRevisionAnchor | null,
): void {
  if (activityStatus !== 'completed' && activityStatus !== 'terminated')
    throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
  if (
    !Number.isSafeInteger(expectedLatestRevision) ||
    expectedLatestRevision < 0 ||
    expectedLatestRevision > 2147483647 ||
    !Number.isSafeInteger(expectedConfirmedRevision) ||
    expectedConfirmedRevision < 0 ||
    expectedConfirmedRevision > expectedLatestRevision ||
    (latest?.revision ?? 0) !== expectedLatestRevision ||
    (confirmed?.revision ?? 0) !== expectedConfirmedRevision ||
    (confirmed !== null && confirmed.statusCode !== 'confirmed') ||
    (latest !== null && !['draft', 'confirmed', 'superseded'].includes(latest.statusCode))
  )
    throw new BizException(BizCode.ACTIVITY_OUTCOME_STALE);
}

/** Cancellation uses the existing head and therefore does not allocate a revision. */
export function nextFinalizedOutcomeRevision(latest: OutcomeRevisionAnchor | null) {
  const revision = latest?.revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= 2147483647)
    throw new BizException(BizCode.ACTIVITY_OUTCOME_STALE);
  return { revision: revision + 1, priorRevisionId: latest?.id ?? null };
}
