import type { Prisma } from '@prisma/client';

/**
 * Member-owner primitive for callers that have already enforced their own read permission.
 * Active status is intentionally not required: this mirrors the existing member-axis 404 rule.
 * The caller supplies the current client, and no membership data is returned.
 */
export async function nonDeletedMemberExists(
  client: Pick<Prisma.TransactionClient, 'member'>,
  memberId: string,
): Promise<boolean> {
  const member = await client.member.findFirst({
    where: { id: memberId, deletedAt: null },
    select: { id: true },
  });
  return member !== null;
}
