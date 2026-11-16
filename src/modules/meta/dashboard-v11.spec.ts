import { Role, UserStatus } from '@prisma/client';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { MetaService } from './meta.service';
import { ActivityDashboardQueryService } from '../activities/activity-dashboard-query.service';
import type { VisibleOrganizationScope } from '../authz/authz.service';

const user: CurrentUserPayload = {
  id: 'user-1',
  username: 'test',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};
const none: VisibleOrganizationScope = { hasPermission: false, global: false, organizationIds: [] };
const limited = (ids: string[]): VisibleOrganizationScope => ({
  hasPermission: true,
  global: false,
  organizationIds: ids,
});
const global: VisibleOrganizationScope = { hasPermission: true, global: true, organizationIds: [] };

function setup(options: {
  enabled: boolean;
  readonly?: boolean;
  read?: boolean;
  first?: boolean;
  final?: boolean;
}) {
  const tx = {
    activityRegistration: { count: jest.fn().mockResolvedValue(1) },
    activityPublishReview: { count: jest.fn().mockResolvedValue(0) },
    activity: { count: jest.fn().mockResolvedValue(3) },
    attendanceSheet: { count: jest.fn().mockRejectedValue(new Error('legacy sheet read')) },
    attendanceSettlementRun: { count: jest.fn().mockResolvedValue(2) },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn((fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const rbac = {
    can: jest.fn((_user: unknown, action: string) =>
      Promise.resolve(
        (action === 'attendance.read.sheet' && options.read !== false) ||
          (action === 'activity.settlement-first-review.record' && options.first === true) ||
          (action === 'activity.settlement-final-review.record' && options.final === true),
      ),
    ),
  };
  const scopes: Record<string, VisibleOrganizationScope> = {
    'activity-registration.read.record': limited(['org-1']),
    'activity-review.read.request': none,
    'attendance.read.sheet': limited(['org-1', 'org-2']),
    'activity.settlement-first-review.record': limited(['org-2', 'org-3']),
    'activity.settlement-final-review.record': global,
  };
  const authz = {
    getVisibleOrganizationScope: jest.fn((_user: unknown, action: string) =>
      Promise.resolve(scopes[action] ?? none),
    ),
  };
  const gate = new ActivityWorkflowGate({
    activityV11Workflow: {
      enabled: options.enabled,
      readonlyMaintenance: options.readonly ?? false,
    },
  } as never);
  const service = Object.create(MetaService.prototype) as MetaService;
  Object.assign(service, {
    prisma,
    rbac,
    authz,
    activityWorkflowGate: gate,
    activityDashboard: new ActivityDashboardQueryService(authz as never, rbac as never, gate),
  });
  return { service, tx, prisma, rbac, authz, scopes };
}

describe('dashboard settlement status from v1.1', () => {
  it('omits the block and never reads sheets or runs without either review permission', async () => {
    const { service, tx } = setup({ enabled: true });
    const result = await service.dashboardSummary(user);
    expect(result).not.toHaveProperty('attendanceSheets');
    expect(result).not.toHaveProperty('settlementReviews');
    expect(result.registrations).toEqual({ pending: 1, waitlisted: 1 });
    expect(tx.attendanceSheet.count).not.toHaveBeenCalled();
    expect(tx.attendanceSettlementRun.count).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'counts authorized first-stage run statuses under readonly=%s',
    async (readonly) => {
      const { service, tx, prisma, rbac, authz } = setup({ enabled: true, readonly, first: true });
      const result = await service.dashboardSummary(user);
      expect(result).toHaveProperty('settlementReviews', {
        available: true,
        pendingFirstReview: 2,
      });
      expect(tx.attendanceSettlementRun.count).toHaveBeenCalledTimes(1);
      expect(tx.attendanceSettlementRun.count).toHaveBeenCalledWith({
        where: {
          statusCode: 'pending_first_review',
          activity: { deletedAt: null, organizationId: { in: ['org-2'] } },
        },
      });
      expect(rbac.can).toHaveBeenCalledWith(user, 'attendance.read.sheet', undefined, tx);
      expect(authz.getVisibleOrganizationScope).toHaveBeenCalledWith(
        user,
        'attendance.read.sheet',
        tx,
      );
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'RepeatableRead',
      });
      expect(tx.attendanceSheet.count).not.toHaveBeenCalled();
    },
  );

  it('reports an unavailable workflow without reading old or new settlement data', async () => {
    const { service, tx } = setup({ enabled: false, first: true, final: true });
    const result = await service.dashboardSummary(user);
    expect(result).toHaveProperty('settlementReviews', { available: false });
    expect(result.registrations).toEqual({ pending: 1, waitlisted: 1 });
    expect(tx.attendanceSettlementRun.count).not.toHaveBeenCalled();
    expect(tx.attendanceSheet.count).not.toHaveBeenCalled();
  });

  it('does not reveal settlement status when review permission exists but global read is absent', async () => {
    const { service, tx, authz } = setup({ enabled: true, read: false, first: true });
    const result = await service.dashboardSummary(user);
    expect(result).not.toHaveProperty('settlementReviews');
    expect(tx.attendanceSettlementRun.count).not.toHaveBeenCalled();
    expect(authz.getVisibleOrganizationScope).not.toHaveBeenCalledWith(
      user,
      'attendance.read.sheet',
      tx,
    );
  });

  it('checks final-stage permission separately and counts only its status', async () => {
    const { service, tx } = setup({ enabled: true, final: true });
    const result = await service.dashboardSummary(user);
    expect(result).toHaveProperty('settlementReviews', { available: true, pendingFinalReview: 2 });
    expect(tx.attendanceSettlementRun.count).toHaveBeenCalledTimes(1);
    expect(tx.attendanceSettlementRun.count).toHaveBeenCalledWith({
      where: {
        statusCode: 'pending_final_review',
        activity: { deletedAt: null, organizationId: { in: ['org-1', 'org-2'] } },
      },
    });
  });

  it('returns a legitimate zero without querying a disjoint organization range', async () => {
    const { service, tx, scopes } = setup({ enabled: true, first: true });
    scopes['activity.settlement-first-review.record'] = limited(['org-3']);
    const result = await service.dashboardSummary(user);
    expect(result).toHaveProperty('settlementReviews', { available: true, pendingFirstReview: 0 });
    expect(tx.attendanceSettlementRun.count).not.toHaveBeenCalled();
  });

  it('does not turn a failed status query into zero', async () => {
    const { service, tx } = setup({ enabled: true, first: true });
    tx.attendanceSettlementRun.count.mockRejectedValue(new Error('query failed'));
    await expect(service.dashboardSummary(user)).rejects.toThrow('query failed');
  });
});
