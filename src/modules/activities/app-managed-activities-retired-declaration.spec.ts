import type { AppConfig } from '../../config/app.config';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { AppManagedActivitiesService } from './app-managed-activities.service';
import { ActivityWorkflowQueryService } from './activity-workflow-query.service';

describe('retired managed attendance declaration', () => {
  function setup(enabled: boolean, readonlyMaintenance: boolean, owner = true) {
    const findFirst = jest.fn().mockResolvedValue(owner ? { id: 'activity-1' } : null);
    const forbiddenWrite = jest.fn(() => {
      throw new Error('retired declaration must not start a transaction or write');
    });
    const prisma = {
      activity: { findFirst, update: forbiddenWrite },
      $transaction: forbiddenWrite,
    };
    const workflowQuery = new ActivityWorkflowQueryService(
      prisma as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    const gate = new ActivityWorkflowGate({
      activityV11Workflow: { enabled, readonlyMaintenance },
    } as AppConfig);
    const service = new AppManagedActivitiesService(
      prisma as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      workflowQuery,
      gate,
      undefined as never,
    );
    return { service, findFirst, forbiddenWrite };
  }

  it.each([
    [false, false, BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED],
    [true, false, BizCode.ACTIVITY_LEGACY_ATTENDANCE_WRITE_CLOSED],
    [false, true, BizCode.ACTIVITY_WORKFLOW_READONLY_MAINTENANCE],
    [true, true, BizCode.ACTIVITY_WORKFLOW_READONLY_MAINTENANCE],
  ])('rejects after the owner check (enabled=%s, readonly=%s)', async (enabled, readonly, biz) => {
    const { service, findFirst, forbiddenWrite } = setup(enabled, readonly);
    await expect(
      service.declareAttendanceComplete('activity-1', { memberId: 'member-1' } as never),
    ).rejects.toMatchObject({ biz });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'activity-1',
          deletedAt: null,
          responsibilityAssignments: {
            some: { memberId: 'member-1', responsibilityType: 'owner', status: 'active' },
          },
        },
      }),
    );
    expect(forbiddenWrite).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'does not reveal gate state to a non-owner (enabled=%s)',
    async (enabled) => {
      const { service, forbiddenWrite } = setup(enabled, false, false);
      await expect(
        service.declareAttendanceComplete('other-activity', { memberId: 'member-1' } as never),
      ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_NOT_FOUND });
      expect(forbiddenWrite).not.toHaveBeenCalled();
    },
  );

  it('rejects a user without a member before looking up the activity', async () => {
    const { service, findFirst, forbiddenWrite } = setup(true, false);
    await expect(
      service.declareAttendanceComplete('activity-1', {} as never),
    ).rejects.toMatchObject({ biz: BizCode.FORBIDDEN });
    expect(findFirst).not.toHaveBeenCalled();
    expect(forbiddenWrite).not.toHaveBeenCalled();
  });
});
