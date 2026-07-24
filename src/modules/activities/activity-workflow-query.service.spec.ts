import type { PrismaService } from '../../database/prisma.service';
import type { AuthzService } from '../authz/authz.service';
import { ActivityClosurePolicy } from './activity-closure-policy';
import { ActivityWorkflowQueryService } from './activity-workflow-query.service';

describe('ActivityWorkflowQueryService', () => {
  it('aggregates one page with two bulk groupBy queries instead of per-row reads', async () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({
      id: `activity-${index}`,
      title: `Activity ${index}`,
      activityTypeCode: 'training',
      organizationId: 'org-1',
      startAt: new Date('2026-07-24T01:00:00.000Z'),
      endAt: new Date('2026-07-24T02:00:00.000Z'),
      location: '深圳',
      description: null,
      capacity: null,
      statusCode: 'completed',
      workflowRevision: 1,
      requiresInsurance: false,
      isPublicRegistration: true,
      attendanceDeclaredCompleteAt: new Date('2026-07-24T03:00:00.000Z'),
      createdAt: new Date('2026-07-20T00:00:00.000Z'),
      updatedAt: new Date('2026-07-24T03:00:00.000Z'),
      initiator: null,
      responsibilityAssignments: [
        {
          memberId: 'member-1',
          responsibilityType: 'owner',
          canManageRegistrations: true,
          canManageAttendance: true,
          member: {
            id: 'member-1',
            memberNo: 'M001',
            displayName: 'Owner',
            gradeCode: 'level-3',
          },
        },
      ],
      publishReviews: [],
      _count: { registrations: 0, attendanceSheets: 0 },
    }));
    const activityFindMany = jest.fn().mockResolvedValue(rows);
    const activityCount = jest.fn().mockResolvedValue(rows.length);
    const registrationGroupBy = jest.fn().mockResolvedValue([
      {
        activityId: 'activity-0',
        statusCode: 'pending',
        _count: { _all: 2 },
      },
    ]);
    const attendanceGroupBy = jest.fn().mockResolvedValue([
      {
        activityId: 'activity-0',
        statusCode: 'returned',
        _count: { _all: 1 },
      },
    ]);
    const prisma = {
      activity: { findMany: activityFindMany, count: activityCount },
      activityRegistration: { groupBy: registrationGroupBy },
      attendanceSheet: { groupBy: attendanceGroupBy },
      $transaction: jest.fn((queries: Promise<unknown>[]) => Promise.all(queries)),
    } as unknown as PrismaService;
    const authz = {} as AuthzService;
    const service = new ActivityWorkflowQueryService(prisma, authz, new ActivityClosurePolicy());

    const result = await service.list('member-1', { page: 1, pageSize: 25 });

    expect(result.items).toHaveLength(25);
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        pendingRegistrations: 2,
        unresolvedAttendanceSheets: 1,
        nextAction: '修改并重提退回考勤单',
      }),
    );
    expect(registrationGroupBy).toHaveBeenCalledTimes(1);
    expect(attendanceGroupBy).toHaveBeenCalledTimes(1);
    expect(activityFindMany).toHaveBeenCalledTimes(1);
    expect(activityCount).toHaveBeenCalledTimes(1);
  });
});
