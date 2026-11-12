import { Prisma, Role, UserStatus } from '@prisma/client';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AppConfig } from '../../config/app.config';
import type { PrismaService } from '../../database/prisma.service';
import type { LedgerQueryService } from '../activities/ledger-query.service';
import type { AuthzService } from '../authz/authz.service';
import type { OrganizationsService } from '../organizations/organizations.service';
import { ParticipationOverviewQueryService } from './participation-overview-query.service';

const user: CurrentUserPayload = {
  id: 'admin',
  username: 'admin',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};

function fixture(enabled: boolean, readonlyMaintenance: boolean) {
  const scope = jest
    .fn()
    .mockResolvedValue({ hasPermission: true, global: true, organizationIds: [] });
  const activities = jest.fn().mockRejectedValue(new Error('unexpected activity read'));
  const records = jest.fn().mockRejectedValue(new Error('unexpected old attendance read'));
  const registrations = jest.fn().mockRejectedValue(new Error('unexpected registration read'));
  const transaction = jest.fn().mockRejectedValue(new Error('unexpected official-time read'));
  const ledger = jest.fn().mockRejectedValue(new Error('unexpected ledger read'));
  const gate = new ActivityWorkflowGate({
    activityV11Workflow: { enabled, readonlyMaintenance },
  } as AppConfig);
  const service = new ParticipationOverviewQueryService(
    {
      activity: { findMany: activities },
      activityRegistration: { findMany: registrations },
      attendanceRecord: { findMany: records },
      $transaction: transaction,
    } as unknown as PrismaService,
    { getVisibleOrganizationScope: scope } as unknown as AuthzService,
    { queryDescendantOrgIds: jest.fn() } as unknown as OrganizationsService,
    { sumCommittedByMemberForActivities: ledger } as unknown as LedgerQueryService,
    gate,
  );
  return { service, scope, activities, records, registrations, transaction, ledger };
}

describe('monthly participation gate after legacy retirement', () => {
  it.each([false, true])(
    'rejects before data reads with gate off, readonly=%s',
    async (readonly) => {
      const f = fixture(false, readonly);
      await expect(f.service.getOverview({}, user)).rejects.toMatchObject({
        biz: BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED,
      });
      expect(f.scope).toHaveBeenCalledTimes(2);
      expect(f.activities).not.toHaveBeenCalled();
      expect(f.records).not.toHaveBeenCalled();
      expect(f.registrations).not.toHaveBeenCalled();
      expect(f.transaction).not.toHaveBeenCalled();
      expect(f.ledger).not.toHaveBeenCalled();
    },
  );

  it('preserves a permission denial before the gate', async () => {
    const f = fixture(false, false);
    f.scope.mockResolvedValue({ hasPermission: false, global: false, organizationIds: [] });
    await expect(f.service.getOverview({}, user)).rejects.toMatchObject({
      biz: BizCode.RBAC_FORBIDDEN,
    });
    expect(f.activities).not.toHaveBeenCalled();
  });

  it('preserves the empty-scope result without reading activities', async () => {
    const f = fixture(false, false);
    f.scope.mockResolvedValue({ hasPermission: true, global: false, organizationIds: [] });
    await expect(f.service.getOverview({}, user)).resolves.toEqual({ months: [] });
    expect(f.activities).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'allows the existing read path when enabled, readonly=%s',
    async (readonly) => {
      const f = fixture(true, readonly);
      f.activities.mockResolvedValue([]);
      await expect(f.service.getOverview({}, user)).resolves.toEqual({ months: [] });
      expect(f.activities).toHaveBeenCalledTimes(1);
    },
  );

  it('uses committed hours even when old records exist', async () => {
    const f = fixture(true, true);
    f.activities.mockResolvedValue([
      { id: 'a1', statusCode: 'completed', startAt: new Date('2026-07-01T00:00:00Z') },
    ]);
    f.registrations.mockResolvedValue([
      { id: 'r1', activityId: 'a1', memberId: 'm1', statusCode: 'pass' },
    ]);
    f.records.mockResolvedValue([
      {
        memberId: 'm1',
        serviceHours: new Prisma.Decimal(99),
        contributionPoints: new Prisma.Decimal(50),
        sheet: { activityId: 'a1', statusCode: 'approved' },
      },
    ]);
    f.transaction.mockResolvedValue(null);
    f.ledger.mockResolvedValue([
      { activityId: 'a1', memberId: 'm1', serviceHours: '3', creditedPoints: '2' },
    ]);
    const result = await f.service.getOverview({}, user);
    expect(result.months[0]).toMatchObject({
      month: '2026-07',
      totalServiceHours: '3',
      participationCount: 1,
    });
    expect(f.ledger).toHaveBeenCalledWith(['a1']);
  });
});
