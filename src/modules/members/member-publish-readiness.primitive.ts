import { MemberStatus, Prisma, UserStatus } from '@prisma/client';

import { isFormalMemberGradeCode } from './member-grade';

type PrismaTx = Prisma.TransactionClient;

/**
 * Identity-org owner primitive for current Activity initiator eligibility.  It preserves the
 * persisted lifecycle facts used by activity initiation while intentionally omitting actor-specific
 * membership and cross-organization authorization, which belong to the original create command.
 */
export async function isActivityInitiatorResolvable(
  tx: PrismaTx,
  initiatorMemberId: string | null,
): Promise<boolean> {
  if (initiatorMemberId === null) return false;
  const member = await tx.member.findFirst({
    where: {
      id: initiatorMemberId,
      deletedAt: null,
      status: MemberStatus.ACTIVE,
    },
    select: {
      gradeCode: true,
      users: {
        where: { deletedAt: null, status: UserStatus.ACTIVE },
        select: { id: true },
        take: 1,
      },
    },
  });
  return member !== null && isFormalMemberGradeCode(member.gradeCode) && member.users.length > 0;
}
