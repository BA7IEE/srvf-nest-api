import { Prisma } from '@prisma/client';

const RESULT_COMMITTED = 'committed';
const RESULT_PRESENT = 'present';
const SERVICE_CREDIT = 'service_credit';

/** Both feedback submission and its v1.1 rate denominator use the same closure-bound predicate. */
export function feedbackEligibilityWhere(closure: {
  settlementVersionId: string;
  postingBatchId: string;
}): Prisma.ParticipantSettlementResultRevisionWhereInput {
  return {
    settlementVersionId: closure.settlementVersionId,
    statusCode: RESULT_COMMITTED,
    resultCode: RESULT_PRESENT,
    ledgerEntries: {
      some: {
        postingBatchId: closure.postingBatchId,
        entryTypeCode: SERVICE_CREDIT,
        serviceHoursDelta: { gt: 0 },
      },
    },
  };
}

/** Aggregate source for the same eligibility: only participation-owned tables are read. */
export function feedbackEligibleMemberIdsSql(
  activityId: string,
  closure: { settlementVersionId: string; postingBatchId: string },
): Prisma.Sql {
  return Prisma.sql`
    SELECT i."memberId"
    FROM "ActivityParticipationIdentity" i
    JOIN "ParticipantSettlementResultRevision" rr ON rr."participationIdentityId" = i.id
    WHERE i."activityId" = ${activityId}
      AND rr."settlementVersionId" = ${closure.settlementVersionId}
      AND rr."statusCode" = ${RESULT_COMMITTED}
      AND rr."resultCode" = ${RESULT_PRESENT}
      AND EXISTS (
        SELECT 1 FROM "ParticipationLedgerEntry" e
        WHERE e."resultRevisionId" = rr.id
          AND e."postingBatchId" = ${closure.postingBatchId}
          AND e."entryTypeCode" = ${SERVICE_CREDIT}
          AND e."serviceHoursDelta" > 0
      )
  `;
}
