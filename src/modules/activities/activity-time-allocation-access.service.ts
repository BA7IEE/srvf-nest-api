import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AuthzService } from '../authz/authz.service';
import { getActivityOrganizationEligibility } from '../organizations/organization-publish-readiness.primitive';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import { loadActiveUserIdentityInTx } from '../users/user-active-identity.query';
import { ActivityResponsibilityPolicy } from './activity-responsibility-policy';

export type ActivityTimeAllocationPermission = 'activity.time-allocation.recognize';

@Injectable()
export class ActivityTimeAllocationAccessService {
  constructor(
    private readonly identities: AppIdentityResolver,
    private readonly authz: AuthzService,
    private readonly responsibility: ActivityResponsibilityPolicy,
  ) {}

  /** Call again after every lock wait; authorization from before a wait is never reusable proof. */
  async authorize(
    tx: Prisma.TransactionClient,
    user: CurrentUserPayload,
    activityId: string,
    permission: ActivityTimeAllocationPermission,
  ) {
    const actor = await loadActiveUserIdentityInTx(tx, user.id);
    if (!actor) throw new BizException(BizCode.UNAUTHORIZED);
    if (!(await this.identities.resolve(actor, tx)).canUseApp)
      throw new BizException(BizCode.FORBIDDEN);
    const activity = await tx.activity.findFirst({ where: { id: activityId, deletedAt: null } });
    if (!activity) throw new BizException(BizCode.ACTIVITY_TIME_ALLOCATION_REFERENCE_UNAVAILABLE);
    const scope = await this.authz.getExplicitVisibleOrganizationScope(actor, permission, tx);
    if (
      !scope.hasPermission ||
      (!scope.global && !scope.organizationIds.includes(activity.organizationId)) ||
      !(await this.authz.can(actor, permission, { type: 'activity', id: activityId }, tx)) ||
      (await getActivityOrganizationEligibility(tx, activity.organizationId)) !== 'eligible'
    ) {
      throw new BizException(BizCode.ACTIVITY_TIME_ALLOCATION_REFERENCE_UNAVAILABLE);
    }
    const responsibilityStatus =
      activity.statusCode === 'archived' ? activity.archivedFromStatusCode : activity.statusCode;
    if (responsibilityStatus === 'draft') {
      if (!actor.memberId || actor.memberId !== activity.initiatorMemberId)
        throw new BizException(BizCode.ACTIVITY_TIME_ALLOCATION_REFERENCE_UNAVAILABLE);
    } else {
      try {
        await this.responsibility.assertOwner(tx, activityId, actor);
      } catch (error) {
        if (error instanceof BizException)
          throw new BizException(BizCode.ACTIVITY_TIME_ALLOCATION_REFERENCE_UNAVAILABLE);
        throw error;
      }
    }
    return { actor, activity };
  }
}
