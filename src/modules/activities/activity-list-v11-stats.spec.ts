import { Role, UserStatus } from '@prisma/client';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { ActivityListItemDto } from './activities.dto';
import { ActivitiesService } from './activities.service';

const user: CurrentUserPayload = {
  id: 'user-1',
  username: 'test',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};
const items = [
  { id: 'a', organizationId: 'org-visible' },
  { id: 'b', organizationId: 'org-other' },
] as ActivityListItemDto[];
type StatsItem = ActivityListItemDto & {
  settlementStats?: { available: boolean; submittedVersionCount?: number };
};
function attach(service: ActivitiesService, rows: ActivityListItemDto[]): Promise<StatsItem[]> {
  return Reflect.apply(
    Reflect.get(service, 'attachStats') as (...args: unknown[]) => Promise<StatsItem[]>,
    service,
    [rows, user],
  );
}

function setup(options: { enabled: boolean; readonly?: boolean; authorized?: boolean }) {
  const tx = {
    activity: { findMany: jest.fn().mockResolvedValue([{ id: 'a' }]) },
    activityRegistration: {
      groupBy: jest.fn().mockResolvedValue([{ activityId: 'a', _count: { _all: 3 } }]),
    },
    attendanceSheet: { groupBy: jest.fn().mockRejectedValue(new Error('legacy sheet read')) },
    attendanceSettlementRun: {
      findMany: jest.fn().mockResolvedValue([{ activityId: 'a', _count: { versions: 2 } }]),
    },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const rbac = { can: jest.fn().mockResolvedValue(options.authorized ?? true) };
  const authz = {
    getVisibleOrganizationScope: jest.fn().mockResolvedValue({
      hasPermission: true,
      global: false,
      organizationIds: ['org-visible'],
    }),
  };
  const activityWorkflowGate = new ActivityWorkflowGate({
    activityV11Workflow: {
      enabled: options.enabled,
      readonlyMaintenance: options.readonly ?? false,
    },
  } as never);
  const service = Object.assign(Object.create(ActivitiesService.prototype) as ActivitiesService, {
    prisma,
    rbac,
    authz,
    activityWorkflowGate,
  });
  return { service, tx, prisma, rbac, authz };
}

describe('activity list v1.1 statistics', () => {
  it('counts live registration heads, omits settlement for an unauthorized caller, and never reads sheets', async () => {
    const { service, tx, prisma } = setup({ enabled: true, authorized: false });
    const result = await attach(service, items);
    expect(result).toEqual([
      { ...items[0], registrationCount: 3 },
      { ...items[1], registrationCount: 0 },
    ]);
    expect(tx.activityRegistration.groupBy).toHaveBeenCalledWith({
      by: ['activityId'],
      where: { activityId: { in: ['a', 'b'] }, deletedAt: null },
      _count: { _all: true },
    });
    expect(tx.attendanceSettlementRun.findMany).not.toHaveBeenCalled();
    expect(tx.activity.findMany).not.toHaveBeenCalled();
    expect(tx.attendanceSheet.groupBy).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });
  });

  it.each([false, true])(
    'uses only authorized organizations and version rows in readonly=%s',
    async (readonly) => {
      const { service, tx, rbac, authz } = setup({ enabled: true, readonly });
      const result = await attach(service, items);
      expect(result).toEqual([
        {
          ...items[0],
          registrationCount: 3,
          settlementStats: { available: true, submittedVersionCount: 2 },
        },
        { ...items[1], registrationCount: 0 },
      ]);
      expect(rbac.can).toHaveBeenCalledWith(user, 'attendance.read.sheet', undefined, tx);
      expect(authz.getVisibleOrganizationScope).toHaveBeenCalledWith(
        user,
        'attendance.read.sheet',
        tx,
      );
      expect(tx.activity.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['a', 'b'] }, deletedAt: null, organizationId: { in: ['org-visible'] } },
        select: { id: true },
      });
      expect(tx.attendanceSettlementRun.findMany).toHaveBeenCalledWith({
        where: {
          activityId: { in: ['a'] },
          activity: { deletedAt: null, organizationId: { in: ['org-visible'] } },
        },
        select: {
          activityId: true,
          _count: {
            select: {
              versions: { where: { statusCode: { not: 'draft' }, submittedAt: { not: null } } },
            },
          },
        },
      });
      expect(tx.attendanceSheet.groupBy).not.toHaveBeenCalled();
    },
  );

  it('distinguishes an unavailable gate from a legitimate zero and still returns registration counts', async () => {
    const { service, tx } = setup({ enabled: false });
    expect(await attach(service, items)).toEqual([
      { ...items[0], registrationCount: 3, settlementStats: { available: false } },
      { ...items[1], registrationCount: 0 },
    ]);
    expect(tx.attendanceSettlementRun.findMany).not.toHaveBeenCalled();
    expect(tx.attendanceSheet.groupBy).not.toHaveBeenCalled();
  });

  it('returns an explicit zero when an authorized activity has no settlement run', async () => {
    const { service, tx } = setup({ enabled: true });
    tx.attendanceSettlementRun.findMany.mockResolvedValue([]);
    const result = await attach(service, items);
    expect(result[0].settlementStats).toEqual({ available: true, submittedVersionCount: 0 });
  });

  it('keeps the existing global review-workbench admission and excludes never-submitted voided drafts', async () => {
    const { service, tx, authz } = setup({ enabled: true });
    authz.getVisibleOrganizationScope.mockResolvedValue({
      hasPermission: true,
      global: true,
      organizationIds: [],
    });
    tx.activity.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    tx.attendanceSettlementRun.findMany.mockResolvedValue([
      // Returned and approved submissions are counted; a voided draft with submittedAt=null
      // is excluded by the actual query predicate asserted below.
      { activityId: 'a', _count: { versions: 2 } },
      { activityId: 'b', _count: { versions: 1 } },
    ]);
    const result = await attach(service, items);
    expect(result[0].settlementStats).toEqual({ available: true, submittedVersionCount: 2 });
    expect(result[1].settlementStats).toEqual({ available: true, submittedVersionCount: 1 });
    expect(tx.activity.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['a', 'b'] }, deletedAt: null },
      select: { id: true },
    });
    expect(tx.attendanceSettlementRun.findMany).toHaveBeenCalledWith({
      where: { activityId: { in: ['a', 'b'] }, activity: { deletedAt: null } },
      select: {
        activityId: true,
        _count: {
          select: {
            versions: { where: { statusCode: { not: 'draft' }, submittedAt: { not: null } } },
          },
        },
      },
    });
  });

  it('fails closed if scope disappears after the global permission check', async () => {
    const { service, tx, authz } = setup({ enabled: true });
    authz.getVisibleOrganizationScope.mockResolvedValue({
      hasPermission: false,
      global: false,
      organizationIds: [],
    });
    const result = await attach(service, items);
    expect(result.every((row) => row.settlementStats === undefined)).toBe(true);
    expect(tx.activity.findMany).not.toHaveBeenCalled();
    expect(tx.attendanceSettlementRun.findMany).not.toHaveBeenCalled();
  });

  it('performs no stats or authorization queries for an empty page', async () => {
    const { service, prisma, rbac, authz } = setup({ enabled: true });
    await expect(attach(service, [])).resolves.toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(rbac.can).not.toHaveBeenCalled();
    expect(authz.getVisibleOrganizationScope).not.toHaveBeenCalled();
  });
});
