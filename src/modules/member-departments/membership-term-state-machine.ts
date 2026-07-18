import { MembershipStatus, Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

export type MembershipTerm = {
  status: MembershipStatus;
  startedAt: Date;
  endedAt: Date | null;
};

/** Pure membership term decisions. Persistence and transaction ownership stay in application services. */
export class MembershipTermStateMachine {
  static assertValid(term: MembershipTerm, now: Date): void {
    const startedAtMs = term.startedAt.getTime();
    const endedAtMs = term.endedAt?.getTime() ?? null;
    const nowMs = now.getTime();

    const valid =
      (term.status === MembershipStatus.ACTIVE && startedAtMs <= nowMs && endedAtMs === null) ||
      (term.status === MembershipStatus.ENDED &&
        endedAtMs !== null &&
        startedAtMs <= endedAtMs &&
        endedAtMs <= nowMs) ||
      (term.status === MembershipStatus.SUSPENDED && endedAtMs === null);
    if (!valid) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
  }

  static end(current: MembershipTerm, now: Date): MembershipTerm {
    if (
      current.status !== MembershipStatus.ACTIVE ||
      current.endedAt !== null ||
      current.startedAt.getTime() > now.getTime()
    ) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    return { ...current, status: MembershipStatus.ENDED, endedAt: now };
  }

  static effectiveWhere(now: Date): Prisma.MemberOrganizationMembershipWhereInput {
    return {
      deletedAt: null,
      status: MembershipStatus.ACTIVE,
      startedAt: { lte: now },
      endedAt: null,
    };
  }
}
