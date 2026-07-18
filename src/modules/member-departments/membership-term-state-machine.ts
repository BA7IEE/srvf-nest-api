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
  static assertValid(term: MembershipTerm): void {
    if (term.endedAt !== null && term.endedAt.getTime() < term.startedAt.getTime()) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    if (term.status === MembershipStatus.ENDED && term.endedAt === null) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
  }

  static end(current: MembershipTerm, now: Date): MembershipTerm {
    if (current.status !== MembershipStatus.ACTIVE) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    return {
      ...current,
      status: MembershipStatus.ENDED,
      endedAt: now.getTime() < current.startedAt.getTime() ? current.startedAt : now,
    };
  }

  static effectiveWhere(now: Date): Prisma.MemberOrganizationMembershipWhereInput {
    return {
      deletedAt: null,
      status: MembershipStatus.ACTIVE,
      startedAt: { lte: now },
      OR: [{ endedAt: null }, { endedAt: { gte: now } }],
    };
  }
}
