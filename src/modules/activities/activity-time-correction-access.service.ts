import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AuthzService } from '../authz/authz.service';
import { getActivityOrganizationEligibility } from '../organizations/organization-publish-readiness.primitive';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import { loadActiveUserIdentityInTx } from '../users/user-active-identity.query';
import { ActivityTimeSettlementAccessService } from './activity-time-settlement-access.service';
import { ActivityResponsibilityPolicy } from './activity-responsibility-policy';

/**
 * D7-2 Human access boundary.  It is intentionally separate from the legacy
 * internal correction entry: an HTTP caller never becomes trusted merely by
 * reaching a correction service method.
 */
@Injectable()
export class ActivityTimeCorrectionAccessService {
  constructor(
    private readonly settlementAccess: ActivityTimeSettlementAccessService,
    private readonly identities: AppIdentityResolver,
    private readonly authz: AuthzService,
    private readonly responsibility: ActivityResponsibilityPolicy,
  ) {}

  /** Submit/resubmit require an active App owner plus both existing write codes. */
  async authorizeSubmission(
    tx: Prisma.TransactionClient,
    user: CurrentUserPayload,
    activityId: string,
    schemaVersion: number,
  ): Promise<CurrentUserPayload> {
    // The Human surface accepts only the two fact-correction versions.  Do not
    // rely on an upstream parser alone: an unknown number must never fall into
    // the legacy branch and silently avoid V3's allocation-recognition grant.
    if (schemaVersion !== 2 && schemaVersion !== 3)
      throw new BizException(BizCode.CORRECTION_CHANGE_SET_INVALID);
    const granted = await this.settlementAccess.authorize(tx, user, activityId, 'submit');
    // A V3 request additionally writes a frozen allocation fact.  Keep this
    // explicit instead of treating settlement-submit as an implied allocation
    // privilege.
    if (schemaVersion === 3)
      await this.settlementAccess.authorize(tx, granted.actor, activityId, 'allocate');
    return granted.actor;
  }

  /** Review is a GLOBAL final-review action against the exact base version. */
  async authorizeReview(
    tx: Prisma.TransactionClient,
    user: CurrentUserPayload,
    activityId: string,
    baseSettlementVersionId: string,
  ): Promise<CurrentUserPayload> {
    return await this.authorizeFinalReview(tx, user, activityId, baseSettlementVersionId);
  }

  /** Prepare remains distinct from review but has the same final-review qualification. */
  async authorizePrepare(
    tx: Prisma.TransactionClient,
    user: CurrentUserPayload,
    activityId: string,
    baseSettlementVersionId: string,
  ): Promise<CurrentUserPayload> {
    return await this.authorizeFinalReview(tx, user, activityId, baseSettlementVersionId);
  }

  /** Commit and every replay re-run the same current qualification. */
  async authorizeCommit(
    tx: Prisma.TransactionClient,
    user: CurrentUserPayload,
    activityId: string,
    baseSettlementVersionId: string,
  ): Promise<CurrentUserPayload> {
    return await this.authorizeFinalReview(tx, user, activityId, baseSettlementVersionId);
  }

  /**
   * Read keeps the existing reviewed-version visibility contract.  Detail
   * masking is decided by the query service with the locked request row.
   */
  async authorizeRead(
    tx: Prisma.TransactionClient,
    user: CurrentUserPayload,
    activityId: string,
    baseSettlementVersionId: string,
  ): Promise<CurrentUserPayload> {
    return (
      await this.settlementAccess.authorize(tx, user, activityId, 'read', baseSettlementVersionId)
    ).actor;
  }

  /**
   * A list can be broad only for the current owner.  A reviewer supplies one
   * exact base version, so list filtering remains a single bounded query
   * rather than an unsafe per-row authorization loop.
   */
  async authorizeListRead(
    tx: Prisma.TransactionClient,
    user: CurrentUserPayload,
    activityId: string,
    baseSettlementVersionId?: string,
  ): Promise<{ actor: CurrentUserPayload; baseSettlementVersionId: string | null }> {
    const context = await this.settlementAccess.authorize(
      tx,
      user,
      activityId,
      'read',
      baseSettlementVersionId,
    );
    try {
      await this.responsibility.assertOwner(tx, activityId, context.actor);
      return { actor: context.actor, baseSettlementVersionId: baseSettlementVersionId ?? null };
    } catch (error) {
      if (!(error instanceof BizException)) throw error;
      if (!baseSettlementVersionId)
        throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE);
      return { actor: context.actor, baseSettlementVersionId };
    }
  }

  private async authorizeFinalReview(
    tx: Prisma.TransactionClient,
    user: CurrentUserPayload,
    activityId: string,
    baseSettlementVersionId: string,
  ): Promise<CurrentUserPayload> {
    const actor = await loadActiveUserIdentityInTx(tx, user.id);
    if (!actor) throw new BizException(BizCode.UNAUTHORIZED);
    if (!(await this.identities.resolve(actor, tx)).canUseApp)
      throw new BizException(BizCode.FORBIDDEN);

    const activity = await tx.activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: { organizationId: true },
    });
    if (
      !activity ||
      (await getActivityOrganizationEligibility(tx, activity.organizationId)) !== 'eligible'
    )
      throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE);

    const version = await tx.attendanceSettlementVersion.findFirst({
      where: { id: baseSettlementVersionId, settlementRun: { activityId } },
      select: { id: true },
    });
    if (!version) throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE);

    const permission = 'activity.settlement-final-review.record';
    const scope = await this.authz.getExplicitVisibleOrganizationScope(actor, permission, tx);
    if (!scope.hasPermission || !scope.global) throw new BizException(BizCode.RBAC_FORBIDDEN);
    if (
      !(await this.authz.can(
        actor,
        permission,
        { type: 'attendance_settlement_version', id: version.id },
        tx,
      ))
    )
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    return actor;
  }
}
