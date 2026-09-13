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

export type TimeSettlementAccess = 'read' | 'allocate' | 'prepare' | 'submit';

const PERMISSIONS = {
  read: ['activity.time-settlement.read'],
  allocate: ['activity.time-allocation.recognize'],
  prepare: ['activity.time-settlement.prepare'],
  submit: ['activity.time-settlement.prepare', 'activity.settlement-submit.record'],
} as const;
const REVIEW_PERMISSIONS = [
  'activity.settlement-first-review.record',
  'activity.settlement-final-review.record',
] as const;

function unavailable(): never {
  throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE);
}

@Injectable()
export class ActivityTimeSettlementAccessService {
  constructor(
    private readonly identities: AppIdentityResolver,
    private readonly authz: AuthzService,
    private readonly responsibility: ActivityResponsibilityPolicy,
  ) {}

  /** No role fallback, cached identity or permission implication. Repeat after each lock wait. */
  async authorize(
    tx: Prisma.TransactionClient,
    user: CurrentUserPayload,
    activityId: string,
    access: TimeSettlementAccess,
    settlementVersionId?: string,
  ) {
    const actor = await loadActiveUserIdentityInTx(tx, user.id);
    if (!actor) throw new BizException(BizCode.UNAUTHORIZED);
    if (!(await this.identities.resolve(actor, tx)).canUseApp)
      throw new BizException(BizCode.FORBIDDEN);
    const activity = await tx.activity.findFirst({ where: { id: activityId, deletedAt: null } });
    if (!activity) return unavailable();
    for (const permission of PERMISSIONS[access]) {
      const scope = await this.authz.getExplicitVisibleOrganizationScope(actor, permission, tx);
      if (
        !scope.hasPermission ||
        (!scope.global && !scope.organizationIds.includes(activity.organizationId)) ||
        !(await this.authz.can(actor, permission, { type: 'activity', id: activityId }, tx))
      )
        return unavailable();
    }
    if ((await getActivityOrganizationEligibility(tx, activity.organizationId)) !== 'eligible')
      return unavailable();
    try {
      await this.responsibility.assertOwner(tx, activityId, actor);
      return { actor, activity };
    } catch (error) {
      if (!(error instanceof BizException)) throw error;
      if (access !== 'read') return unavailable();
    }

    // A reviewer must qualify for this actual version, including existing separation rules.
    // A role title, a broad read grant or Admin identity by itself never creates this eligibility.
    const version = await tx.attendanceSettlementVersion.findFirst({
      where: {
        ...(settlementVersionId ? { id: settlementVersionId } : {}),
        settlementRun: { activityId },
      },
      orderBy: { version: 'desc' },
      select: { id: true },
    });
    if (!version) return unavailable();
    for (const permission of REVIEW_PERMISSIONS) {
      const scope = await this.authz.getExplicitVisibleOrganizationScope(actor, permission, tx);
      if (
        scope.hasPermission &&
        (scope.global || scope.organizationIds.includes(activity.organizationId)) &&
        (await this.authz.can(
          actor,
          permission,
          { type: 'attendance_settlement_version', id: version.id },
          tx,
        ))
      )
        return { actor, activity };
    }
    return unavailable();
  }
}
