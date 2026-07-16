import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 审计刀 5 F1–F4：三条核心口径锁 + admin/App scope 边界。
describe('participation metrics F1-F4', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let bareUserAuth: string;
  let memberUserAuth: string;
  let activityId: string;
  let draftActivityId: string;
  let memberAId: string;
  let memberBId: string;
  let memberDId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const superAdmin = await createTestUser(app, {
      username: 'pmx-super-admin',
      role: Role.SUPER_ADMIN,
    });
    await createTestUser(app, { username: 'pmx-bare-user', role: Role.USER });

    const org = await prisma.organization.create({
      data: { name: 'PMX Org', nodeTypeCode: 'team' },
      select: { id: true },
    });
    const members = await Promise.all(
      [
        ['pmx-a', 'Pending Evidence'],
        ['pmx-b', 'No Show'],
        ['pmx-c', 'Temporary'],
        ['pmx-d', 'Approved Participant'],
        ['pmx-e', 'Pending Registration'],
        ['pmx-f', 'Rejected Registration'],
        ['pmx-g', 'Cancelled Registration'],
        ['pmx-h', 'Waitlisted Registration'],
      ].map(([memberNo, displayName]) =>
        prisma.member.create({
          data: { memberNo, displayName },
          select: { id: true, memberNo: true },
        }),
      ),
    );
    [memberAId, memberBId, , memberDId] = members.map((member) => member.id);

    const memberUser = await createTestUser(app, {
      username: 'pmx-member-user',
      role: Role.USER,
    });
    await prisma.user.update({
      where: { id: memberUser.id },
      data: { memberId: memberDId },
    });

    const activity = await prisma.activity.create({
      data: {
        title: 'PMX Completed Activity',
        activityTypeCode: 'pmx-type',
        organizationId: org.id,
        startAt: new Date('2026-07-10T01:00:00.000Z'),
        endAt: new Date('2026-07-10T09:00:00.000Z'),
        location: 'PMX',
        statusCode: 'completed',
      },
      select: { id: true },
    });
    activityId = activity.id;
    draftActivityId = (
      await prisma.activity.create({
        data: {
          title: 'PMX Draft Activity',
          activityTypeCode: 'pmx-type',
          organizationId: org.id,
          startAt: new Date('2026-08-10T01:00:00.000Z'),
          endAt: new Date('2026-08-10T09:00:00.000Z'),
          location: 'PMX',
          statusCode: 'draft',
        },
        select: { id: true },
      })
    ).id;

    await prisma.activityRegistration.createMany({
      data: [
        { activityId, memberId: memberAId, statusCode: 'pass' },
        { activityId, memberId: memberBId, statusCode: 'pass' },
        { activityId, memberId: memberDId, statusCode: 'pass' },
        { activityId, memberId: members[4].id, statusCode: 'pending' },
        { activityId, memberId: members[5].id, statusCode: 'reject' },
        { activityId, memberId: members[6].id, statusCode: 'cancelled' },
        { activityId, memberId: members[7].id, statusCode: 'waitlisted' },
      ],
    });
    const [pendingSheet, approvedSheet] = await Promise.all([
      prisma.attendanceSheet.create({
        data: {
          activityId,
          submitterUserId: superAdmin.id,
          statusCode: 'pending',
        },
        select: { id: true },
      }),
      prisma.attendanceSheet.create({
        data: {
          activityId,
          submitterUserId: superAdmin.id,
          statusCode: 'approved',
        },
        select: { id: true },
      }),
    ]);

    await prisma.attendanceRecord.createMany({
      data: [
        // 仅 pending Sheet 的记录：算到场证据，但时长/贡献绝不计入。
        {
          sheetId: pendingSheet.id,
          memberId: memberAId,
          roleCode: 'member',
          checkInAt: new Date('2026-07-10T01:00:00.000Z'),
          checkOutAt: new Date('2026-07-10T07:00:00.000Z'),
          serviceHours: '6',
          attendanceStatusCode: 'present',
          contributionPoints: '9',
        },
        // 无任何报名的临时参加者。
        {
          sheetId: approvedSheet.id,
          memberId: members[2].id,
          roleCode: 'member',
          checkInAt: new Date('2026-07-10T01:00:00.000Z'),
          checkOutAt: new Date('2026-07-10T02:30:00.000Z'),
          serviceHours: '1.5',
          attendanceStatusCode: 'present',
          contributionPoints: '0.5',
        },
        // 同 member、同北京日两条 2 分：活动原始贡献=4，生涯封顶贡献=3。
        {
          sheetId: approvedSheet.id,
          memberId: memberDId,
          roleCode: 'member',
          checkInAt: new Date('2026-07-10T02:00:00.000Z'),
          checkOutAt: new Date('2026-07-10T04:30:00.000Z'),
          serviceHours: '2.5',
          attendanceStatusCode: 'present',
          contributionPoints: '2',
        },
        {
          sheetId: approvedSheet.id,
          memberId: memberDId,
          roleCode: 'member',
          checkInAt: new Date('2026-07-10T05:00:00.000Z'),
          checkOutAt: new Date('2026-07-10T08:00:00.000Z'),
          serviceHours: '3',
          attendanceStatusCode: 'present',
          contributionPoints: '2',
        },
        // 软删 approved record 不参与任何口径。
        {
          sheetId: approvedSheet.id,
          memberId: memberDId,
          roleCode: 'member',
          checkInAt: new Date('2026-07-11T01:00:00.000Z'),
          checkOutAt: new Date('2026-07-11T10:00:00.000Z'),
          serviceHours: '9',
          attendanceStatusCode: 'present',
          contributionPoints: '9',
          deletedAt: new Date('2026-07-12T00:00:00.000Z'),
        },
      ],
    });

    superAdminAuth = (await loginAs(app, 'pmx-super-admin')).authHeader;
    bareUserAuth = (await loginAs(app, 'pmx-bare-user')).authHeader;
    memberUserAuth = (await loginAs(app, 'pmx-member-user')).authHeader;
  });

  afterAll(async () => {
    await app.close();
  });

  it('F1: pending record 算 attended、不算 no-show；时长小计仍只计 approved', async () => {
    const res = await request(httpServer(app))
      .get(`/api/admin/v1/activities/${activityId}/reconciliation`)
      .set('Authorization', superAdminAuth);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      passRegistrationCount: 3,
      attendedCount: 2,
      noShowCount: 1,
    });
    const pendingEvidence = res.body.data.registeredParticipants.find(
      (item: { memberId: string }) => item.memberId === memberAId,
    );
    expect(pendingEvidence).toMatchObject({
      outcome: 'attended',
      recordCount: 1,
      approvedRecordCount: 0,
      totalServiceHours: '0',
    });
    const noShow = res.body.data.registeredParticipants.find(
      (item: { memberId: string }) => item.memberId === memberBId,
    );
    expect(noShow).toMatchObject({ outcome: 'no-show', recordCount: 0 });
    expect(res.body.data.temporaryParticipants).toHaveLength(1);
    expect(res.body.data.temporaryParticipants[0]).toMatchObject({
      outcome: 'temporary',
      recordCount: 1,
      totalServiceHours: '1.5',
    });
  });

  it('F1 boundary: 非 completed 复用 ACTIVITY_STATUS_INVALID(409)', async () => {
    const res = await request(httpServer(app))
      .get(`/api/admin/v1/activities/${draftActivityId}/reconciliation`)
      .set('Authorization', superAdminAuth);
    expectBizError(res, BizCode.ACTIVITY_STATUS_INVALID);
  });

  it('F1/F2 authz: 两项读权限任一缺失即 30100；未登录 40100', async () => {
    const denied = await request(httpServer(app))
      .get(`/api/admin/v1/activities/${activityId}/participation-summary`)
      .set('Authorization', bareUserAuth);
    expectBizError(denied, BizCode.RBAC_FORBIDDEN);

    const unauthenticated = await request(httpServer(app)).get(
      `/api/admin/v1/activities/${activityId}/reconciliation`,
    );
    expectBizError(unauthenticated, BizCode.UNAUTHORIZED);
  });

  it('F2: 报名/实到/到场率正确，时长贡献与直方图仅计 approved records', async () => {
    const res = await request(httpServer(app))
      .get(`/api/admin/v1/activities/${activityId}/participation-summary`)
      .set('Authorization', superAdminAuth);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      activityId,
      activityStatusCode: 'completed',
      registrationCounts: {
        total: 7,
        pending: 1,
        pass: 3,
        reject: 1,
        cancelled: 1,
        waitlisted: 1,
      },
      attendeeCount: 3,
      registeredAttendeeCount: 2,
      temporaryAttendeeCount: 1,
      noShowCount: 1,
      attendanceRate: 0.6667,
      totalServiceHours: '7',
      totalContributionPoints: '4.5',
      durationHistogram: {
        under2Hours: 1,
        from2To4Hours: 2,
        from4To8Hours: 0,
        atLeast8Hours: 0,
      },
      feedback: { count: 0, avgRating: null },
    });
    const counts = res.body.data.registrationCounts as Record<string, number>;
    expect(
      counts.pending + counts.pass + counts.reject + counts.cancelled + counts.waitlisted,
    ).toBe(counts.total);
  });

  it('F3: 个人累计 approved-only，贡献值与既有 contribution-summary 严格等值', async () => {
    const [participation, contribution] = await Promise.all([
      request(httpServer(app))
        .get(`/api/admin/v1/members/${memberDId}/participation-summary`)
        .set('Authorization', superAdminAuth),
      request(httpServer(app))
        .get(`/api/admin/v1/members/${memberDId}/contribution-summary`)
        .set('Authorization', superAdminAuth),
    ]);

    expect(participation.status).toBe(200);
    expect(participation.body.data).toEqual({
      memberId: memberDId,
      totalServiceHours: '5.5',
      activityCount: 1,
      recordCount: 2,
      contributionPoints: '3',
    });
    expect(contribution.status).toBe(200);
    expect(participation.body.data.contributionPoints).toBe(
      contribution.body.data.contributionPoints,
    );
  });

  it('F4: App participation-summary 恒本人且 DTO 只含正向四字段', async () => {
    const res = await request(httpServer(app))
      .get('/api/app/v1/my/participation-summary')
      .set('Authorization', memberUserAuth);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      totalServiceHours: '5.5',
      activityCount: 1,
      recordCount: 2,
      contributionPoints: '3',
    });
    expect(res.body.data).not.toHaveProperty('memberId');
    expect(res.body.data).not.toHaveProperty('noShowCount');
  });
});
