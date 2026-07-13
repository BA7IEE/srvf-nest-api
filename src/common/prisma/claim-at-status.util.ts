import { Prisma } from '@prisma/client';

import type { BizCodeEntry } from '../exceptions/biz-code.constant';
import { BizException } from '../exceptions/biz.exception';

export type StatusClaimTarget =
  | 'activity'
  | 'activityRegistration'
  | 'attendanceSheet'
  | 'certificate'
  | 'recruitmentApplication'
  | 'teamJoinApplication';

interface ClaimAtStatusOptions {
  target: StatusClaimTarget;
  id: string;
  expectedStatus: string;
  invalidStatusBiz: BizCodeEntry;
}

/**
 * Atomically claims a soft-deletable row while it is still at the status read by the caller.
 *
 * This deliberately performs a no-op status update: PostgreSQL locks the matched row until the
 * surrounding transaction completes, while a concurrent winner makes the losing claim match zero
 * rows. Transition legality remains the responsibility of each module's existing state machine.
 */
export async function claimAtStatus(
  tx: Prisma.TransactionClient,
  options: ClaimAtStatusOptions,
): Promise<void> {
  const { target, id, expectedStatus, invalidStatusBiz } = options;
  let claimed: { count: number };

  switch (target) {
    case 'activity':
      claimed = await tx.activity.updateMany({
        where: { id, statusCode: expectedStatus, deletedAt: null },
        data: { statusCode: expectedStatus },
      });
      break;
    case 'activityRegistration':
      claimed = await tx.activityRegistration.updateMany({
        where: { id, statusCode: expectedStatus, deletedAt: null },
        data: { statusCode: expectedStatus },
      });
      break;
    case 'attendanceSheet':
      claimed = await tx.attendanceSheet.updateMany({
        where: { id, statusCode: expectedStatus, deletedAt: null },
        data: { statusCode: expectedStatus },
      });
      break;
    case 'certificate':
      claimed = await tx.certificate.updateMany({
        where: { id, certStatusCode: expectedStatus, deletedAt: null },
        data: { certStatusCode: expectedStatus },
      });
      break;
    case 'recruitmentApplication':
      claimed = await tx.recruitmentApplication.updateMany({
        where: { id, statusCode: expectedStatus, deletedAt: null },
        data: { statusCode: expectedStatus },
      });
      break;
    case 'teamJoinApplication':
      claimed = await tx.teamJoinApplication.updateMany({
        where: { id, statusCode: expectedStatus, deletedAt: null },
        data: { statusCode: expectedStatus },
      });
      break;
  }

  if (claimed.count === 0) {
    throw new BizException(invalidStatusBiz);
  }
}
