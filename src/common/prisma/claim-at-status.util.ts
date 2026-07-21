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
 * Atomically locks a soft-deletable row while it is still at the status read by the caller.
 *
 * A conditional FOR NO KEY UPDATE avoids creating a no-op tuple version. That matters when the
 * caller later updates the same row: a queued concurrent updater must not become a soft blocker for
 * the lock owner's real update. PostgreSQL rechecks the WHERE predicate after a lock wait, so a
 * concurrent winner makes the losing claim return zero rows. Transition legality remains the
 * responsibility of each module's existing state machine.
 */
export async function claimAtStatus(
  tx: Prisma.TransactionClient,
  options: ClaimAtStatusOptions,
): Promise<void> {
  const { target, id, expectedStatus, invalidStatusBiz } = options;
  let claimed: Array<{ id: string }>;

  switch (target) {
    case 'activity':
      claimed = await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "Activity"
        WHERE "id" = ${id} AND "statusCode" = ${expectedStatus} AND "deletedAt" IS NULL
        FOR NO KEY UPDATE
      `);
      break;
    case 'activityRegistration':
      claimed = await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "ActivityRegistration"
        WHERE "id" = ${id} AND "statusCode" = ${expectedStatus} AND "deletedAt" IS NULL
        FOR NO KEY UPDATE
      `);
      break;
    case 'attendanceSheet':
      claimed = await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "AttendanceSheet"
        WHERE "id" = ${id} AND "statusCode" = ${expectedStatus} AND "deletedAt" IS NULL
        FOR NO KEY UPDATE
      `);
      break;
    case 'certificate':
      claimed = await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "Certificate"
        WHERE "id" = ${id} AND "certStatusCode" = ${expectedStatus} AND "deletedAt" IS NULL
        FOR NO KEY UPDATE
      `);
      break;
    case 'recruitmentApplication':
      claimed = await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "recruitment_applications"
        WHERE "id" = ${id} AND "statusCode" = ${expectedStatus} AND "deletedAt" IS NULL
        FOR NO KEY UPDATE
      `);
      break;
    case 'teamJoinApplication':
      claimed = await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "team_join_applications"
        WHERE "id" = ${id} AND "statusCode" = ${expectedStatus} AND "deletedAt" IS NULL
        FOR NO KEY UPDATE
      `);
      break;
  }

  if (claimed.length === 0) {
    throw new BizException(invalidStatusBiz);
  }
}
