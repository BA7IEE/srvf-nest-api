import type { Prisma } from '@prisma/client';

/**
 * Call only under the existing Activity root lock in the caller's transaction.
 * Any append-only punch event (including void/replace) is evidence; a committed
 * result is also evidence even when there is no punch and its value is zero.
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
    where: { identity: { registrationId }, statusCode: 'committed' },
    select: { id: true },
  });
  return result !== null;
}
