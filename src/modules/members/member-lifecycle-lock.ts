import { Prisma } from '@prisma/client';

type PrismaTx = Prisma.TransactionClient;

// Member lifecycle writes and every path that can (re)introduce an authorization source
// serialize on the same aggregate row. Callers must lock Member before User so offboard,
// account activation, assignment/supervision creation, and direct binding writes have one
// deterministic order across Nest instances.
export async function lockMemberLifecycle(tx: PrismaTx, memberId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "Member" WHERE "id" = ${memberId} FOR UPDATE`,
  );
  return rows.length > 0;
}

export async function lockLiveUserLifecycle(tx: PrismaTx, userId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${userId} AND "deletedAt" IS NULL FOR UPDATE`,
  );
  return rows.length > 0;
}

export async function lockLinkedUserLifecycle(
  tx: PrismaTx,
  memberId: string,
): Promise<readonly string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "User" WHERE "memberId" = ${memberId} AND "deletedAt" IS NULL ORDER BY "id" FOR UPDATE`,
  );
  return rows.map(({ id }) => id);
}
