import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AuthzService } from '../authz/authz.service';
import { getActivityOrganizationEligibility } from '../organizations/organization-publish-readiness.primitive';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import { loadActiveUserIdentityInTx } from '../users/user-active-identity.query';
import { ActivityInitiationPolicy } from './activity-initiation-policy';
import { ActivityResponsibilityPolicy } from './activity-responsibility-policy';

export type ActivityContributionPolicySelectionSurface = 'admin' | 'app';
export type ActivityContributionPolicySelectionPermission =
  | 'activity.contribution-policy.read'
  | 'activity.contribution-policy.select';

@Injectable()
export class ActivityContributionPolicySelectionAccess {
  constructor(
    private readonly identities: AppIdentityResolver,
    private readonly authz: AuthzService,
    private readonly initiation: ActivityInitiationPolicy,
    private readonly responsibility: ActivityResponsibilityPolicy,
  ) {}

  async current(
    tx: Prisma.TransactionClient,
    user: CurrentUserPayload,
    surface: ActivityContributionPolicySelectionSurface,
  ): Promise<CurrentUserPayload> {
    const actor = await loadActiveUserIdentityInTx(tx, user.id);
    if (!actor) throw new BizException(BizCode.UNAUTHORIZED);
    if (surface === 'app' && !(await this.identities.resolve(actor, tx)).canUseApp) {
      throw new BizException(BizCode.FORBIDDEN);
    }
    return actor;
  }

  async authorize(
    tx: Prisma.TransactionClient,
    user: CurrentUserPayload,
    surface: ActivityContributionPolicySelectionSurface,
    activityId: string,
    permission: ActivityContributionPolicySelectionPermission,
  ) {
    const actor = await this.current(tx, user, surface);
    const activity = await tx.activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: {
        id: true,
        organizationId: true,
        statusCode: true,
        archivedFromStatusCode: true,
        initiatorMemberId: true,
      },
    });
    if (!activity) {
      throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
    }

    const scope = await this.authz.getExplicitVisibleOrganizationScope(actor, permission, tx);
    if (!scope.hasPermission) throw new BizException(BizCode.FORBIDDEN);
    if (
      (!scope.global && !scope.organizationIds.includes(activity.organizationId)) ||
      !(await this.authz.can(actor, permission, { type: 'activity', id: activityId }, tx)) ||
      (await getActivityOrganizationEligibility(tx, activity.organizationId)) !== 'eligible'
    ) {
      throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
    }

    if (surface === 'app') {
      const responsibilityStatus =
        activity.statusCode === 'archived' ? activity.archivedFromStatusCode : activity.statusCode;
      if (responsibilityStatus === 'draft') {
        if (!actor.memberId || actor.memberId !== activity.initiatorMemberId) {
          throw new BizException(
            BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
          );
        }
      } else {
        try {
          await this.responsibility.assertOwner(tx, activityId, actor);
        } catch (error) {
          if (error instanceof BizException) {
            throw new BizException(
              BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
            );
          }
          throw error;
        }
      }
    }
    return { actor, activity };
  }

  async assertStandaloneWritable(tx: Prisma.TransactionClient, activityId: string): Promise<void> {
    const activity = await tx.activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: { statusCode: true },
    });
    if (!activity || activity.statusCode !== 'draft') {
      throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
    }
    const pending = await tx.activityPublishReview.findFirst({
      where: { activityId, status: 'pending' },
      select: { id: true },
    });
    if (pending) {
      throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
    }
  }

  async authorizeOptions(
    tx: Prisma.TransactionClient,
    user: CurrentUserPayload,
    organizationId: string,
  ): Promise<CurrentUserPayload> {
    const actor = await this.current(tx, user, 'app');
    const permission: ActivityContributionPolicySelectionPermission =
      'activity.contribution-policy.read';
    const scope = await this.authz.getExplicitVisibleOrganizationScope(actor, permission, tx);
    if (!scope.hasPermission) throw new BizException(BizCode.FORBIDDEN);
    if (
      (!scope.global && !scope.organizationIds.includes(organizationId)) ||
      !(await this.authz.can(
        actor,
        permission,
        { type: 'organization', id: organizationId },
        tx,
      )) ||
      (await getActivityOrganizationEligibility(tx, organizationId)) !== 'eligible'
    ) {
      throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
    }
    try {
      await this.initiation.resolveInitiator(actor, organizationId, undefined, tx);
    } catch (error) {
      if (error instanceof BizException) {
        throw new BizException(
          BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
        );
      }
      throw error;
    }
    return actor;
  }

  async authorizeCreation(
    tx: Prisma.TransactionClient,
    user: CurrentUserPayload,
    surface: ActivityContributionPolicySelectionSurface,
    organizationId: string,
    requestedMemberId?: string,
    requireInitiator = true,
  ): Promise<CurrentUserPayload> {
    const actor = await this.current(tx, user, surface);
    const permission: ActivityContributionPolicySelectionPermission =
      'activity.contribution-policy.select';
    const scope = await this.authz.getExplicitVisibleOrganizationScope(actor, permission, tx);
    if (!scope.hasPermission) throw new BizException(BizCode.FORBIDDEN);
    if (
      (!scope.global && !scope.organizationIds.includes(organizationId)) ||
      !(await this.authz.can(
        actor,
        permission,
        { type: 'organization', id: organizationId },
        tx,
      )) ||
      (await getActivityOrganizationEligibility(tx, organizationId)) !== 'eligible'
    ) {
      throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
    }
    if (surface === 'app' && requireInitiator) {
      try {
        await this.initiation.resolveInitiator(actor, organizationId, requestedMemberId, tx);
      } catch (error) {
        if (error instanceof BizException) {
          throw new BizException(
            BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
          );
        }
        throw error;
      }
    }
    return actor;
  }
}
