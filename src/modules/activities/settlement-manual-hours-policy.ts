import { Prisma } from '@prisma/client';
import { roundServiceHours } from '../../common/datetime/service-hours';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { SegmentProjection } from './settlement-segment-projector';

/**
 * Applies only to legacy manual hours. Missing machine evidence is a separate
 * maintainer decision, not an inferred zero-hour limit or a new manual grant.
 */
export function assertManualHoursWithinEvidence(
  recognizedHours: Prisma.Decimal,
  projection: SegmentProjection,
): void {
  const open = projection.segments.some((segment) => segment.checkOutAt === null);
  const unresolved =
    projection.chainAnomalies.length > 0 ||
    projection.segments.some((segment) => segment.exceptionFlags.length > 0);
  if (open || unresolved) {
    // Zero must not disguise unresolved facts. Positive manual handling without
    // complete evidence remains subject to its existing submission gates.
    if (recognizedHours.isZero()) {
      throw new BizException(
        open ? BizCode.SETTLEMENT_SUBMIT_OPEN_SEGMENT : BizCode.SETTLEMENT_SUBMIT_PENDING_RESULT,
      );
    }
    return;
  }
  if (projection.segments.length === 0) return;

  // Reuse projected effective facts (void/replace resolved, overlaps reported).
  // Round each segment as the existing draft does, then sum exactly. The limit
  // is evidence duration, not the machine result (which may contain deductions).
  const limit = projection.segments.reduce((sum, segment) => {
    if (segment.resultCode !== 'valid') return sum;
    const milliseconds = segment.checkOutAt!.getTime() - segment.checkInAt.getTime();
    return sum.plus(roundServiceHours(new Prisma.Decimal(milliseconds).div(3_600_000)));
  }, new Prisma.Decimal(0));
  if (recognizedHours.gt(limit)) {
    throw new BizException(BizCode.ATTENDANCE_SERVICE_HOURS_EXCEEDS_SPAN);
  }
}
