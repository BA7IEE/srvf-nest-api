import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, PrincipalType, Role } from '@prisma/client';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

interface ActivitySummaryBody {
  attendeeCount: number;
  totalServiceHours: string;
}

describe('participation overview F5 + scoped reconciliation', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let scopedAuth: string;
  let onePermissionAuth: string;
  let rootOrgId: string;
  let visibleOrgId: string;
  let hiddenOrgId: string;
  let visibleActivity1Id: string;
  let visibleActivity2Id: string;
  let hiddenActivityId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const root = await prisma.organization.create({
      data: { name: 'POV Root', nodeTypeCode: 'root' },
      select: { id: true },
    });
    rootOrgId = root.id;
    const visible = await prisma.organization.create({
      data: { name: 'POV Visible', nodeTypeCode: 'team', parentId: rootOrgId },
      select: { id: true },
    });
    visibleOrgId = visible.id;
    const hidden = await prisma.organization.create({
      data: { name: 'POV Hidden', nodeTypeCode: 'team', parentId: rootOrgId },
      select: { id: true },
    });
    hiddenOrgId = hidden.id;
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: rootOrgId, descendantId: rootOrgId, depth: 0 },
        { ancestorId: visibleOrgId, descendantId: visibleOrgId, depth: 0 },
        { ancestorId: hiddenOrgId, descendantId: hiddenOrgId, depth: 0 },
        { ancestorId: rootOrgId, descendantId: visibleOrgId, depth: 1 },
        { ancestorId: rootOrgId, descendantId: hiddenOrgId, depth: 1 },
      ],
    });

    const permissions = await Promise.all(
      [
        {
          code: 'attendance.read.sheet',
          module: 'attendance',
          action: 'read',
          resourceType: 'sheet',
        },
        {
          code: 'activity-registration.read.record',
          module: 'activity-registration',
          action: 'read',
          resourceType: 'record',
        },
      ].map((data) => prisma.permission.create({ data, select: { id: true } })),
    );
    const scopedRole = await prisma.rbacRole.create({
      data: { code: 'pov-scoped-reader', displayName: 'POV scoped reader' },
      select: { id: true },
    });
    await prisma.rolePermission.createMany({
      data: permissions.map((permission) => ({
        roleId: scopedRole.id,
        permissionId: permission.id,
      })),
    });

    const scopedUser = await createTestUser(app, { username: 'pov-scoped', role: Role.USER });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: scopedUser.id,
        roleId: scopedRole.id,
        scopeType: BindingScopeType.ORGANIZATION_TREE,
        scopeOrgId: visibleOrgId,
      },
    });
    scopedAuth = (await loginAs(app, 'pov-scoped')).authHeader;

    const onePermissionRole = await prisma.rbacRole.create({
      data: { code: 'pov-one-code', displayName: 'POV one code' },
      select: { id: true },
    });
    await prisma.rolePermission.create({
      data: { roleId: onePermissionRole.id, permissionId: permissions[0].id },
    });
    const onePermissionUser = await createTestUser(app, {
      username: 'pov-one-code-user',
      role: Role.USER,
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: onePermissionUser.id,
        roleId: onePermissionRole.id,
        scopeType: BindingScopeType.ORGANIZATION_TREE,
        scopeOrgId: visibleOrgId,
      },
    });
    onePermissionAuth = (await loginAs(app, 'pov-one-code-user')).authHeader;

    const submitter = await createTestUser(app, {
      username: 'pov-submitter',
      role: Role.SUPER_ADMIN,
    });
    const createActivity = async (organizationId: string, title: string) =>
      prisma.activity.create({
        data: {
          title,
          activityTypeCode: 'pov-type',
          organizationId,
          startAt: new Date('2026-07-15T01:00:00.000Z'),
          endAt: new Date('2026-07-15T09:00:00.000Z'),
          location: 'POV',
          statusCode: 'completed',
        },
        select: { id: true },
      });
    visibleActivity1Id = (await createActivity(visibleOrgId, 'POV Visible 1')).id;
    visibleActivity2Id = (await createActivity(visibleOrgId, 'POV Visible 2')).id;
    hiddenActivityId = (await createActivity(hiddenOrgId, 'POV Hidden')).id;

    const members = await Promise.all(
      ['pov-m1', 'pov-m2', 'pov-m3', 'pov-hidden'].map((memberNo) =>
        prisma.member.create({
          data: { memberNo, displayName: memberNo },
          select: { id: true },
        }),
      ),
    );
    await prisma.activityRegistration.createMany({
      data: [
        { activityId: visibleActivity1Id, memberId: members[0].id, statusCode: 'pass' },
        { activityId: visibleActivity1Id, memberId: members[1].id, statusCode: 'pass' },
        { activityId: visibleActivity2Id, memberId: members[2].id, statusCode: 'pass' },
        { activityId: hiddenActivityId, memberId: members[3].id, statusCode: 'pass' },
      ],
    });
    const sheets = await Promise.all(
      [visibleActivity1Id, visibleActivity2Id, hiddenActivityId].map((activityId) =>
        prisma.attendanceSheet.create({
          data: { activityId, submitterUserId: submitter.id, statusCode: 'approved' },
          select: { id: true },
        }),
      ),
    );
    await prisma.attendanceRecord.createMany({
      data: [
        {
          sheetId: sheets[0].id,
          memberId: members[0].id,
          roleCode: 'member',
          checkInAt: new Date('2026-07-15T01:00:00.000Z'),
          checkOutAt: new Date('2026-07-15T02:30:00.000Z'),
          serviceHours: '1.5',
          attendanceStatusCode: 'present',
          contributionPoints: '0.5',
        },
        {
          sheetId: sheets[1].id,
          memberId: members[2].id,
          roleCode: 'member',
          checkInAt: new Date('2026-07-15T03:00:00.000Z'),
          checkOutAt: new Date('2026-07-15T05:30:00.000Z'),
          serviceHours: '2.5',
          attendanceStatusCode: 'present',
          contributionPoints: '1',
        },
        {
          sheetId: sheets[2].id,
          memberId: members[3].id,
          roleCode: 'member',
          checkInAt: new Date('2026-07-15T00:00:00.000Z'),
          checkOutAt: new Date('2026-07-15T08:00:00.000Z'),
          serviceHours: '8',
          attendanceStatusCode: 'present',
          contributionPoints: '3',
        },
      ],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const getActivitySummary = (activityId: string) =>
    request(httpServer(app))
      .get(`/api/admin/v1/activities/${activityId}/participation-summary`)
      .set('Authorization', scopedAuth);

  it('overview 与两个可见活动 F2 逐项求和自洽，树外活动完全裁剪', async () => {
    const [summary1, summary2, overview] = await Promise.all([
      getActivitySummary(visibleActivity1Id),
      getActivitySummary(visibleActivity2Id),
      request(httpServer(app))
        .get('/api/admin/v1/meta/participation-overview')
        .query({
          dateFrom: '2026-07-01T00:00:00.000Z',
          dateTo: '2026-07-31T23:59:59.999Z',
          organizationId: rootOrgId,
          includeDescendants: true,
          activityTypeCode: 'pov-type',
        })
        .set('Authorization', scopedAuth),
    ]);
    expect(summary1.status).toBe(200);
    expect(summary2.status).toBe(200);
    expect(overview.status).toBe(200);
    expect(overview.body.data.months).toHaveLength(1);

    const f2 = [
      summary1.body.data as ActivitySummaryBody,
      summary2.body.data as ActivitySummaryBody,
    ];
    const month = overview.body.data.months[0];
    expect(month.activityCount).toBe(2);
    expect(month.completedActivityCount).toBe(2);
    expect(month.participationCount).toBe(f2.reduce((sum, item) => sum + item.attendeeCount, 0));
    expect(month.totalServiceHours).toBe(
      f2
        .reduce(
          (sum, item) => sum.add(new Prisma.Decimal(item.totalServiceHours)),
          new Prisma.Decimal(0),
        )
        .toString(),
    );
    expect(month.durationHistogram).toEqual({
      under2Hours: 1,
      from2To4Hours: 1,
      from4To8Hours: 0,
      atLeast8Hours: 0,
    });
    expect(month.averageAttendanceRate).toBe(0.6667);
    expect(month.noShowRate).toBe(0.3333);
  });

  it('overview 显式筛选树外组织与授权 scope 求交后返回空集', async () => {
    const res = await request(httpServer(app))
      .get('/api/admin/v1/meta/participation-overview')
      .query({ organizationId: hiddenOrgId })
      .set('Authorization', scopedAuth);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ months: [] });
  });

  it('overview 必须同时持两项读权限，缺一项即 30100', async () => {
    const res = await request(httpServer(app))
      .get('/api/admin/v1/meta/participation-overview')
      .set('Authorization', onePermissionAuth);
    expectBizError(res, BizCode.RBAC_FORBIDDEN);
  });

  it('reconciliation activity ref scope：树内 200，树外 30100', async () => {
    const visible = await request(httpServer(app))
      .get(`/api/admin/v1/activities/${visibleActivity1Id}/reconciliation`)
      .set('Authorization', scopedAuth);
    expect(visible.status).toBe(200);

    const hidden = await request(httpServer(app))
      .get(`/api/admin/v1/activities/${hiddenActivityId}/reconciliation`)
      .set('Authorization', scopedAuth);
    expectBizError(hidden, BizCode.RBAC_FORBIDDEN);
  });
});
