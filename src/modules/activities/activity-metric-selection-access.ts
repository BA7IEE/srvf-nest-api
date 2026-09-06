import { Injectable } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import { loadActiveUserIdentityInTx } from '../users/user-active-identity.query';
import { getActivityOrganizationEligibility } from '../organizations/organization-publish-readiness.primitive';
import { ActivityAccessService, USER_VISIBLE_STATUS_CODES } from './activity-access.service';
import { ActivityInitiationPolicy } from './activity-initiation-policy';
import {
  assertMetricSelectionReference,
  type ActivityMetricSelection,
} from './activity-metric-selection';

export type MetricSelectionSurface = 'admin' | 'app';

@Injectable()
export class ActivityMetricSelectionAccess {
  constructor(
    private readonly identities: AppIdentityResolver,
    private readonly access: ActivityAccessService,
    private readonly initiation: ActivityInitiationPolicy,
  ) {}

  async current(
    tx: Prisma.TransactionClient,
    user: CurrentUserPayload,
    surface: MetricSelectionSurface,
  ) {
    const actor = await loadActiveUserIdentityInTx(tx, user.id);
    if (!actor) throw new BizException(BizCode.UNAUTHORIZED);
    if (surface === 'app' && !(await this.identities.resolve(actor, tx)).canUseApp)
      throw new BizException(BizCode.FORBIDDEN);
    return actor;
  }

  async authorizeWrite(
    tx: Prisma.TransactionClient,
    user: CurrentUserPayload,
    surface: MetricSelectionSurface,
    activityId: string,
  ) {
    const actor = await this.current(tx, user, surface);
    await this.access.assertCanOrThrow(
      actor,
      'activity.update.record',
      { type: 'activity', id: activityId },
      tx,
    );
    return actor;
  }

  /** Options expose initiation choices, not GLOBAL catalogue permission or a write grant. */
  async authorizeOptions(
    tx: Prisma.TransactionClient,
    user: CurrentUserPayload,
    organizationId: string,
  ): Promise<void> {
    const actor = await this.current(tx, user, 'app');
    await this.initiation.resolveInitiator(actor, organizationId, undefined, tx);
  }

  /** Current creation authority, without turning an initial selection into a draft PUT. */
  async authorizeCreation(
    tx: Prisma.TransactionClient,
    user: CurrentUserPayload,
    surface: MetricSelectionSurface,
    organizationId: string,
    requestedMemberId?: string,
    requireInitiator = true,
  ) {
    const actor = await this.current(tx, user, surface);
    await this.access.assertCanOrThrow(actor, 'activity.create.record', undefined, tx);
    let initiatorMemberId: string | undefined;
    if (requireInitiator) {
      initiatorMemberId = await this.initiation.resolveInitiator(
        actor,
        organizationId,
        requestedMemberId,
        tx,
      );
    } else {
      // A7 preserves its deliberately empty initiator, while rechecking the target organization.
      const eligibility = await getActivityOrganizationEligibility(tx, organizationId);
      if (eligibility !== 'eligible') {
        const errors = {
          missing: BizCode.ORGANIZATION_NOT_FOUND,
          inactive: BizCode.ORGANIZATION_INACTIVE,
          root: BizCode.ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN,
        };
        throw new BizException(errors[eligibility]);
      }
    }
    return { actor, initiatorMemberId };
  }

  /** Caller owns Activity lock. Draft writer uses the existing initiator rule and SA exception. */
  async writable(tx: Prisma.TransactionClient, actor: CurrentUserPayload, activityId: string) {
    const row = await tx.activity.findFirst({
      where: {
        id: activityId,
        deletedAt: null,
        ...(actor.role === Role.SUPER_ADMIN
          ? {}
          : { initiatorMemberId: actor.memberId ?? '__missing_member__' }),
      },
    });
    if (!row) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    if (row.statusCode !== 'draft')
      throw new BizException(
        row.statusCode === 'published'
          ? BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED
          : BizCode.ACTIVITY_STATUS_INVALID,
      );
    if (
      await tx.activityPublishReview.findFirst({
        where: { activityId, status: 'pending' },
        select: { id: true },
      })
    )
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING);
    return row;
  }

  async readable(
    tx: Prisma.TransactionClient,
    actor: CurrentUserPayload,
    surface: MetricSelectionSurface,
    activityId: string,
  ) {
    const where: Prisma.ActivityWhereInput = { id: activityId, deletedAt: null };
    if (surface === 'app' && actor.role !== Role.SUPER_ADMIN)
      where.OR = [
        { initiatorMemberId: actor.memberId ?? '__missing_member__' },
        {
          responsibilityAssignments: {
            some: { memberId: actor.memberId ?? '__missing_member__', status: 'active' },
          },
        },
      ];
    if (surface === 'admin' && actor.role === Role.USER)
      where.statusCode = { in: [...USER_VISIBLE_STATUS_CODES] };
    const row = await tx.activity.findFirst({ where });
    if (!row) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return row;
  }
}

/** Root lock precedes set then sorted definition locks. No transaction ownership or hidden root lock. */
export async function lockMetricSelectionReference(
  tx: Prisma.TransactionClient,
  selection: ActivityMetricSelection,
  revalidate: () => Promise<void>,
): Promise<void> {
  if (selection.metricRequirementCode === 'not_required') {
    await revalidate();
    return;
  }
  const id = selection.metricSetPointer.id;
  await tx.$queryRaw`SELECT "id" FROM "ActivityMetricSetVersion" WHERE "id" = ${id} FOR SHARE`;
  await revalidate();
  const items = await tx.activityMetricSetItem.findMany({
    where: { setVersionId: id },
    select: { metricDefinitionId: true },
    take: 101,
  });
  if (items.length < 1 || items.length > 100)
    throw new BizException(BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE);
  const ids = items.map((i) => i.metricDefinitionId).sort();
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "ActivityMetricDefinition" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR SHARE`,
  );
  await revalidate();
  const row = await tx.activityMetricSetVersion.findFirst({
    where: { id },
    include: {
      items: { include: { metricDefinition: true }, take: 101, orderBy: { sortOrder: 'asc' } },
    },
  });
  try {
    assertMetricSelectionReference(selection, row);
  } catch (error) {
    if (error instanceof TypeError)
      throw new BizException(BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE);
    throw error;
  }
}
