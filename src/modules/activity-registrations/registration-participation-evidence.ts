import type { Prisma } from '@prisma/client';

/**
 * Call only under the existing Activity root lock in the caller's transaction.
 * Any append-only punch event (including void/replace) is evidence; a committed
 * result is also evidence even when there is no punch and its value is zero. A
 * superseded result still records a prior committed outcome after correction.
 */
export async function hasV11ParticipationEvidenceInTx(
  tx: Prisma.TransactionClient,
  registrationId: string,
): Promise<boolean> {
  const punch = await tx.attendancePunchEvent.findFirst({
    where: { participationIdentity: { registrationId } },
    select: { id: true },
  });
  if (punch !== null) return true;
  const result = await tx.participantSettlementResultRevision.findFirst({
    where: { identity: { registrationId }, statusCode: { in: ['committed', 'superseded'] } },
    select: { id: true },
  });
  return result !== null;
}

/** As above, scoped to the identities a caller is about to mutate under the Activity root lock. */
export async function hasV11ParticipationEvidenceForIdentitiesInTx(
  tx: Prisma.TransactionClient,
  identityIds: readonly string[],
): Promise<boolean> {
  if (identityIds.length === 0) return false;
  const ids = [...identityIds];
  const punch = await tx.attendancePunchEvent.findFirst({
    where: { participationIdentityId: { in: ids } },
    select: { id: true },
  });
  if (punch !== null) return true;
  const result = await tx.participantSettlementResultRevision.findFirst({
    where: {
      participationIdentityId: { in: ids },
      statusCode: { in: ['committed', 'superseded'] },
    },
    select: { id: true },
  });
  return result !== null;
}
