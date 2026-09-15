import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AuthzService } from '../authz/authz.service';
import { RbacService } from '../permissions/rbac.service';
import { getActivityOrganizationEligibility } from '../organizations/organization-publish-readiness.primitive';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import { loadActiveUserIdentityInTx } from '../users/user-active-identity.query';

const FINAL_REVIEW = 'activity.settlement-final-review.record';

@Injectable()
export class ParticipationTimeLedgerAccessService {
  constructor(
    private readonly identities: AppIdentityResolver,
    private readonly authz: AuthzService,
    private readonly rbac: RbacService,
  ) {}

  /** D7 follows the existing correction GLOBAL final-review eligibility, not an invented final decision. */
  async authorizeCorrection(tx: Prisma.TransactionClient, actorId: string) {
    const actor = await loadActiveUserIdentityInTx(tx, actorId);
    if (!actor) throw new BizException(BizCode.UNAUTHORIZED);
    if (actor.memberId !== null && !(await this.identities.resolve(actor, tx)).canUseApp)
      throw new BizException(BizCode.FORBIDDEN);
    if (!(await this.rbac.can(actor, FINAL_REVIEW, undefined, tx)))
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    return actor;
  }

  /** Exact historical version, current actor eligibility; no role fallback or actor replacement. */
  async authorize(
    tx: Prisma.TransactionClient,
    actorId: string,
    activityId: string,
    settlementVersionId: string,
  ) {
    const actor = await loadActiveUserIdentityInTx(tx, actorId);
    if (!actor) throw new BizException(BizCode.UNAUTHORIZED);
    if (!(await this.identities.resolve(actor, tx)).canUseApp)
      throw new BizException(BizCode.FORBIDDEN);
    const decision = await tx.settlementReviewAction.findMany({
      where: { settlementVersionId, stageCode: 'final' },
      select: { actorUserId: true, actionCode: true },
      take: 2,
    });
    if (
      decision.length !== 1 ||
      decision[0].actorUserId !== actorId ||
      decision[0].actionCode !== 'approve'
    ) {
      throw new BizException(BizCode.FORBIDDEN);
    }
    const activity = await tx.activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: { organizationId: true },
    });
    if (
      !activity ||
      (await getActivityOrganizationEligibility(tx, activity.organizationId)) !== 'eligible'
    ) {
      throw new BizException(BizCode.FORBIDDEN);
    }
    const scope = await this.authz.getExplicitVisibleOrganizationScope(actor, FINAL_REVIEW, tx);
    if (
      !scope.hasPermission ||
      (!scope.global && !scope.organizationIds.includes(activity.organizationId)) ||
      !(await this.authz.can(
        actor,
        FINAL_REVIEW,
        { type: 'attendance_settlement_version', id: settlementVersionId },
        tx,
      ))
    ) {
      throw new BizException(BizCode.FORBIDDEN);
    }
  }
}
