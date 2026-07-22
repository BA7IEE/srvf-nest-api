import { Prisma } from '@prisma/client';

type PrismaTx = Prisma.TransactionClient;

/**
 * The User row is the single cross-instance serialization point for every
 * refresh-token issuance, rotation, and revocation concerning that user.
 *
 * Callers that also own a higher-level aggregate lock must keep the repository
 * lock order (last-admin advisory / Member -> User -> refresh token rows).
 * Deleted users are deliberately included: delete/reopen flows must serialize
 * with an issuance that observed the user while it was still live.
 */
export async function lockAuthSessionUser(tx: PrismaTx, userId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`,
  );
  return rows.length > 0;
}
