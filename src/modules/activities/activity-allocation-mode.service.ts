import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  isActivityAllocationModeCode,
  type ActivityAllocationModeCode,
} from './activity-allocation-mode';

type PrismaTx = Prisma.TransactionClient;

/**
 * ActivityAllocationBatch has no production writer in this slice. This service only protects the
 * parent/child invariant and deliberately assumes its caller already holds Activity FOR UPDATE.
 */
@Injectable()
export class ActivityAllocationModeService {
  async assertLockedActivityConsistent(
    tx: PrismaTx,
    activity: { id: string; allocationModeCode: string },
  ): Promise<void> {
    if (!isActivityAllocationModeCode(activity.allocationModeCode)) {
      throw new BizException(BizCode.BAD_REQUEST);
    }

    // Do not filter status: preparing, committed and voided are all historical children whose
    // mode must remain consistent with the locked Activity parent.
    const batches = await tx.activityAllocationBatch.findMany({
      where: { activityId: activity.id },
      select: { id: true, modeCode: true, statusCode: true },
    });
    if (batches.some((batch) => batch.modeCode !== activity.allocationModeCode)) {
      throw new BizException(BizCode.ACTIVITY_ALLOCATION_MODE_INCONSISTENT);
    }
  }

  assertValidMode(value: unknown): asserts value is ActivityAllocationModeCode {
    if (!isActivityAllocationModeCode(value)) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
  }
}
