import { MemberStatus, Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

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

export interface LockedLiveMemberLifecycle {
  id: string;
  status: MemberStatus;
}

/**
 * Serialize on the Member aggregate, then re-read its live lifecycle truth from the same tx.
 * A soft-deleted row is deliberately returned as null even though the physical row was locked.
 */
export async function lockAndReadLiveMemberLifecycle(
  tx: PrismaTx,
  memberId: string,
): Promise<LockedLiveMemberLifecycle | null> {
  if (!(await lockMemberLifecycle(tx, memberId))) return null;
  return tx.member.findFirst({
    where: { id: memberId, deletedAt: null },
    select: { id: true, status: true },
  });
}

export async function assertActiveMemberLifecycle(
  tx: PrismaTx,
  memberId: string,
): Promise<LockedLiveMemberLifecycle> {
  const member = await lockAndReadLiveMemberLifecycle(tx, memberId);
  if (!member) throw new BizException(BizCode.MEMBER_NOT_FOUND);
  if (member.status !== MemberStatus.ACTIVE) {
    throw new BizException(BizCode.MEMBER_INACTIVE);
  }
  return member;
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
