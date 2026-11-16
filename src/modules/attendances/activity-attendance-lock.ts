import type { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

/** The caller owns authorization, the transaction and the surrounding lock order. */
export async function lockActivityForAttendanceWrite(
  activityId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "Activity"
    WHERE id = ${activityId} AND "deletedAt" IS NULL
    FOR UPDATE
  `;
  if (rows.length === 0) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
}
