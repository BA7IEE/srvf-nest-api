import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import type { ActivityDashboardQueryPort } from '../../common/dashboard/activity-dashboard-query.port';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { AuthzService, type VisibleOrganizationScope } from '../authz/authz.service';
import { RbacService } from '../permissions/rbac.service';

type DashboardScope = { global: boolean; organizationIds: string[] };

function intersectScopes(
  read: VisibleOrganizationScope | null,
  action: VisibleOrganizationScope | null,
): DashboardScope | null {
  if (!read?.hasPermission || !action?.hasPermission) return null;
  if (read.global) return { global: action.global, organizationIds: action.organizationIds };
  if (action.global) return { global: false, organizationIds: read.organizationIds };
  const allowed = new Set(action.organizationIds);
  return { global: false, organizationIds: read.organizationIds.filter((id) => allowed.has(id)) };
}

/** Owner query: authorization and all counts run in the caller's single read transaction. */
@Injectable()
export class ActivityDashboardQueryService implements ActivityDashboardQueryPort {
  constructor(
    private readonly authz: AuthzService,
    private readonly rbac: RbacService,
    private readonly activityWorkflowGate: ActivityWorkflowGate,
  ) {}

  async read(tx: Prisma.TransactionClient, user: CurrentUserPayload) {
    const [registrationScope, publishReviewScope, readAllowed, firstAllowed, finalAllowed] =
      await Promise.all([
        this.authz.getVisibleOrganizationScope(user, 'activity-registration.read.record', tx),
        this.authz.getVisibleOrganizationScope(user, 'activity-review.read.request', tx),
        this.rbac.can(user, 'attendance.read.sheet', undefined, tx),
        this.rbac.can(user, 'activity.settlement-first-review.record', undefined, tx),
        this.rbac.can(user, 'activity.settlement-final-review.record', undefined, tx),
      ]);
    const [readScope, firstActionScope, finalActionScope] = await Promise.all([
      readAllowed && (firstAllowed || finalAllowed)
        ? this.authz.getVisibleOrganizationScope(user, 'attendance.read.sheet', tx)
        : Promise.resolve(null),
      readAllowed && firstAllowed
        ? this.authz.getVisibleOrganizationScope(
            user,
            'activity.settlement-first-review.record',
            tx,
          )
        : Promise.resolve(null),
      readAllowed && finalAllowed
        ? this.authz.getVisibleOrganizationScope(
            user,
            'activity.settlement-final-review.record',
            tx,
          )
        : Promise.resolve(null),
    ]);
    const firstScope = intersectScopes(readScope, firstActionScope);
    const finalScope = intersectScopes(readScope, finalActionScope);
    const hasSettlementAccess = firstScope !== null || finalScope !== null;
    const settlementAvailable =
      hasSettlementAccess &&
      this.activityWorkflowGate.participationReadSource() === 'committed-ledger';
    const registrationActivityScope = registrationScope.global
      ? {}
      : { activity: { organizationId: { in: registrationScope.organizationIds } } };
    const publishReviewActivityWhere = publishReviewScope.global
      ? {}
      : { organizationId: { in: publishReviewScope.organizationIds } };

    const countSettlement = (scope: DashboardScope | null, statusCode: string): Promise<number> => {
      if (
        !settlementAvailable ||
        scope === null ||
        (!scope.global && scope.organizationIds.length === 0)
      ) {
        return Promise.resolve(0);
      }
      return tx.attendanceSettlementRun.count({
        where: {
          statusCode,
          activity: {
            deletedAt: null,
            ...(scope.global ? {} : { organizationId: { in: scope.organizationIds } }),
          },
        },
      });
    };

    const [
      registrationsPending,
      registrationsWaitlisted,
      settlementFirstReview,
      settlementFinalReview,
      activityPublishReviewsPending,
      activitiesPublished,
      activitiesPendingCompletion,
    ] = await Promise.all([
      registrationScope.hasPermission
        ? tx.activityRegistration.count({
            where: notDeletedWhere({ statusCode: 'pending', ...registrationActivityScope }),
          })
        : Promise.resolve(0),
      registrationScope.hasPermission
        ? tx.activityRegistration.count({
            where: notDeletedWhere({ statusCode: 'waitlisted', ...registrationActivityScope }),
          })
        : Promise.resolve(0),
      countSettlement(firstScope, 'pending_first_review'),
      countSettlement(finalScope, 'pending_final_review'),
      publishReviewScope.hasPermission
        ? tx.activityPublishReview.count({
            where: {
              status: 'pending',
              activity: { deletedAt: null, ...publishReviewActivityWhere },
            },
          })
        : Promise.resolve(0),
      tx.activity.count({ where: notDeletedWhere({ statusCode: 'published' }) }),
      tx.activity.count({
        where: notDeletedWhere({ statusCode: 'published', endAt: { lt: new Date() } }),
      }),
    ]);
    return {
      ...(registrationScope.hasPermission
        ? { registrations: { pending: registrationsPending, waitlisted: registrationsWaitlisted } }
        : {}),
      ...(hasSettlementAccess
        ? {
            settlementReviews: {
              available: settlementAvailable,
              ...(settlementAvailable && firstScope !== null
                ? { pendingFirstReview: settlementFirstReview }
                : {}),
              ...(settlementAvailable && finalScope !== null
                ? { pendingFinalReview: settlementFinalReview }
                : {}),
            },
          }
        : {}),
      ...(publishReviewScope.hasPermission
        ? { activityPublishReviews: { pending: activityPublishReviewsPending } }
        : {}),
      activities: {
        published: activitiesPublished,
        pendingCompletion: activitiesPendingCompletion,
      },
    };
  }
}
